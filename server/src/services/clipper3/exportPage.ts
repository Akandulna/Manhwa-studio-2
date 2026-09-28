/**
 * Crop Studio (hybrid ChatGPT loop) — exporting ONE reviewed page (PRD §6.6, §11.3).
 *
 * Only a review whose readiness says `ready` exports. From it:
 *
 *  1. FINALIZE — crops in reading order get contiguous ids (`crop-01`…),
 *     their reasons and filenames (`{slug}_{stem}_{NN}{_reason}.png`, the exact
 *     composition the Clipper 3.0 cutter and metadata checks use), and one set
 *     of normalized points computed once from the integer bounds.
 *  2. STAGE — into `.crop-studio/<Chapter>/<stem>/exports/rev-NNNN-<time>/`:
 *     every PNG cut from the fingerprinted original, plus the pointer and
 *     metadata JSON.
 *  3. VERIFY THE STAGE — each PNG decodes to exactly its box's size and to the
 *     very pixels of the original there; both JSONs parse and pass the same
 *     checks Clipper 3.0 applies on paste/sync; filenames line up 1:1; and the
 *     normalized points reproduce the integer bounds through the cutter's own
 *     rounding. Any failure stops here with nothing published.
 *  4. PUBLISH — each destination folder is swapped whole, never edited in
 *     place: `<Series>/Processed/<Chapter>/page_###/` (the Sync json layout)
 *     and `<Series>/Crops/<Chapter>/page_###/`. What was there before is moved
 *     into the export folder, not deleted. The page's Clipper 3.0 store entry
 *     (crop_points3 / crop_metadata3) is rewritten too, its previous files kept
 *     alongside, so the page shows Done and the existing Cut still works.
 *  5. VERIFY THE PUBLISH — the published files are re-read and hashed against
 *     the staged ones, then the report is written.
 *
 * The two destination folders and the store cannot be swapped as one atomic
 * unit; the export folder with its report is the record of what one export
 * produced, and a failure part-way is reported as such, with what was moved
 * aside still in that folder.
 */

import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import {
  expectedExportedFilenames,
  extractCrops,
  getSourceFolderPath,
  readImageMetadata,
  readImagePoints,
  validateMetadata,
  writeImageMetadata,
  writeImagePoints,
  type Clipper3ImageCropFile
} from './perImageStore.js'
import { getProcessedDir, pageNumberOf } from './processedSync.js'
import { getStudioDir } from './handoff.js'
import { loadOriginal, sha256OfFile, type DecodedPixels } from './pageIdentity.js'
import { getReview, type ReviewCrop, type ReviewState, type Blocker } from './reviewState.js'
import { cropIdFor, formatRatio } from '../clipper2/fourPointSchema.js'
import type { Box } from './auditRules.js'

export const EXPORT_SCHEMA = 'crop-studio-export/1.0'
export const EXPORTS_DIR = 'exports'
export const EXPORT_REPORT_FILE = 'export-report.json'

/** Tops within this many px count as one row (matches the client's readingOrder). */
export const ROW_TOLERANCE_PX = 12

export interface FinalCrop {
  id: string
  reason: string
  bounds: Box
  description: string
  exportedFilename: string
  /** The review key it came from. */
  key: string
}

export interface ExportFile {
  path: string
  sha256: string
  bytes: number
}

export interface ExportReport {
  schema_version: typeof EXPORT_SCHEMA
  status: 'completed' | 'failed'
  exported_at: string
  page_stem: string
  original_filename: string
  source_sha256: string
  source_width: number
  source_height: number
  job_id: string | null
  review_revision: number
  based_on: ReviewState['based_on']
  crop_count: number
  crops: { id: string; key: string; reason: string; bounds: Box; exportedFilename: string; width: number; height: number; sha256: string }[]
  /** Destination folders, relative to the series folder. */
  destinations: { processed: string; crops: string; store: string[] }
  /** Where the previous contents of each destination were moved (relative to the export folder). */
  replaced: string[]
  files: ExportFile[]
  /** Honest limits of what this export proves. */
  notes: string[]
  error?: string
}

export class ExportError extends Error {
  constructor(public readonly status: 404 | 409 | 422 | 500, message: string, public readonly details: string[] = [], public readonly blockers: Blocker[] = []) {
    super(message)
    this.name = 'ExportError'
  }
}

// ============ Finalize (pure) ============

export function readingOrder<T extends { bounds: Box }>(crops: T[], rowTolerance = ROW_TOLERANCE_PX): T[] {
  return [...crops].sort((a, b) => {
    const dy = a.bounds.y0 - b.bounds.y0
    if (Math.abs(dy) > rowTolerance) return dy
    return a.bounds.x0 - b.bounds.x0 || dy
  })
}

/** Final ids, order and filenames, frozen from the approved review. */
export function finalizeCrops(crops: ReviewCrop[], seriesSlug: string, imageFilename: string): FinalCrop[] {
  const ordered = readingOrder(crops)
  const names = expectedExportedFilenames(seriesSlug, imageFilename, ordered)
  return ordered.map((crop, i) => ({
    id: cropIdFor(i),
    reason: crop.reason,
    bounds: { ...crop.bounds },
    description: crop.description.trim(),
    exportedFilename: names[i],
    key: crop.key
  }))
}

/** The `four-point-crop` 1.0 document, normalized once from the integer bounds. */
export function buildPointerFile(final: FinalCrop[], imageFilename: string, W: number, H: number): Clipper3ImageCropFile {
  return {
    format: 'four-point-crop',
    version: '1.0',
    image: { filename: path.basename(imageFilename), width: W, height: H },
    coordinateSystem: 'normalized',
    crops: final.map(c => {
      const x0 = formatRatio(c.bounds.x0 / W)
      const x1 = formatRatio(c.bounds.x1 / W)
      const y0 = formatRatio(c.bounds.y0 / H)
      const y1 = formatRatio(c.bounds.y1 / H)
      return {
        id: c.id,
        reason: c.reason,
        crop: {
          mode: 'rectangle' as const,
          points: [
            { id: 'P1', x: x0, y: y0 },
            { id: 'P2', x: x1, y: y0 },
            { id: 'P3', x: x1, y: y1 },
            { id: 'P4', x: x0, y: y1 }
          ]
        }
      }
    })
  }
}

/** The metadata document: exactly `{crops: [{id, exportedFilename, description}]}`, keys in that order. */
export function buildMetadata(final: FinalCrop[]): { crops: { id: string; exportedFilename: string; description: string }[] } {
  return { crops: final.map(c => ({ id: c.id, exportedFilename: c.exportedFilename, description: c.description })) }
}

/**
 * Checks the normalized points land back on the integer bounds through the
 * Clipper 3.0 cutter's own rounding (clamp to 0–1, × size, Math.round), so a
 * later Cut from the store produces exactly these PNGs.
 */
export function roundTripErrors(file: Clipper3ImageCropFile, final: FinalCrop[], W: number, H: number): string[] {
  const errors: string[] = []
  file.crops.forEach((entry, i) => {
    const xs = entry.crop.points.map(p => p.x)
    const ys = entry.crop.points.map(p => p.y)
    const px = (v: number, size: number) => Math.round(Math.min(1, Math.max(0, v)) * size)
    const got = { x0: px(Math.min(...xs), W), y0: px(Math.min(...ys), H), x1: px(Math.max(...xs), W), y1: px(Math.max(...ys), H) }
    const want = final[i].bounds
    if (got.x0 !== want.x0 || got.y0 !== want.y0 || got.x1 !== want.x1 || got.y1 !== want.y1) {
      errors.push(`${entry.id}: normalized points reproduce (${got.x0},${got.y0})–(${got.x1},${got.y1}), not (${want.x0},${want.y0})–(${want.x1},${want.y1})`)
    }
  })
  return errors
}

/** `page_###` and the `-ch###-p###` suffix of the Processed file names. */
export function processedNames(chapterNumber: number, imageFilename: string): { pageFolder: string; pointers: string; metadata: string } {
  const stem = path.basename(imageFilename).replace(/\.[^/.]+$/, '')
  const page = pageNumberOf(stem)
  const pageToken = page === null ? stem : String(page).padStart(3, '0')
  const [whole, fraction] = String(chapterNumber).split('.')
  const chapterToken = `${whole.padStart(3, '0')}${fraction ? `.${fraction}` : ''}`
  const suffix = `ch${chapterToken}-p${pageToken}`
  return {
    pageFolder: page === null ? stem : `page_${pageToken}`,
    pointers: `crop-pointers-${suffix}.json`,
    metadata: `crop-metadata-${suffix}.json`
  }
}

// ============ Files ============

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function hashTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const name of (await fs.readdir(dir)).sort()) {
    out.set(name, await sha256OfFile(path.join(dir, name)))
  }
  return out
}

/**
 * Replaces `dest` with a copy of `src` by swapping whole folders: the copy is
 * built beside `dest`, the old folder is moved to `setAside`, then the copy is
 * renamed into place. If the final rename fails, the old folder is moved back.
 */
async function swapFolder(src: string, dest: string, setAside: string): Promise<boolean> {
  const incoming = `${dest}.incoming-${process.pid}-${Date.now()}`
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.cp(src, incoming, { recursive: true })
  const hadPrevious = await exists(dest)
  if (hadPrevious) {
    await fs.mkdir(path.dirname(setAside), { recursive: true })
    await fs.rename(dest, setAside)
  }
  try {
    await fs.rename(incoming, dest)
  } catch (err) {
    if (hadPrevious) await fs.rename(setAside, dest).catch(() => {})
    await fs.rm(incoming, { recursive: true, force: true })
    throw err
  }
  return hadPrevious
}

/** Compares a decoded PNG with the same box of the decoded original, row by row. */
function pixelsMatch(png: { data: Buffer; info: sharp.OutputInfo }, original: DecodedPixels, b: Box): string | null {
  const w = b.x1 - b.x0
  const h = b.y1 - b.y0
  if (png.info.width !== w || png.info.height !== h) return `decoded to ${png.info.width}×${png.info.height}, expected ${w}×${h}`
  if (png.info.channels !== original.channels) return `has ${png.info.channels} channels, the original ${original.channels}`
  const c = original.channels
  const rowBytes = w * c
  for (let y = 0; y < h; y++) {
    const srcStart = ((b.y0 + y) * original.width + b.x0) * c
    const a = original.data.subarray(srcStart, srcStart + rowBytes)
    const bRow = png.data.subarray(y * rowBytes, (y + 1) * rowBytes)
    if (!a.equals(bRow)) return `pixels differ from the original at row ${b.y0 + y}`
  }
  return null
}

// ============ Export ============

export interface ExportContext {
  folderPath: string
  imageFilename: string
  seriesSlug: string
  chapterNumber: number
}

export async function exportPage(ctx: ExportContext): Promise<ExportReport> {
  const imageFilename = path.basename(ctx.imageFilename)
  const view = await getReview(ctx.folderPath, imageFilename)
  const state = view.state
  if (!state) throw new ExportError(404, 'This page has no review to export')
  if (!view.readiness.ready) {
    throw new ExportError(422, `The review is not finished: ${view.readiness.blockers.length} thing(s) left`, [], view.readiness.blockers)
  }

  // The pixels exported are the pixels reviewed, or nothing is exported.
  const sourcePath = path.join(getSourceFolderPath(ctx.folderPath), imageFilename)
  const { pixels, ...inspection } = await loadOriginal(sourcePath)
  if (!inspection.ready || !pixels || !inspection.page) {
    throw new ExportError(422, 'The original page is blocked', inspection.issues.map(i => i.message))
  }
  if (inspection.page.sha256 !== state.source_sha256 || pixels.width !== state.source_width || pixels.height !== state.source_height) {
    throw new ExportError(409, 'The original page changed since it was reviewed — restart the review')
  }
  const W = pixels.width
  const H = pixels.height

  // 1. Finalize.
  const final = finalizeCrops(state.crops, ctx.seriesSlug, imageFilename)
  const pointerFile = buildPointerFile(final, imageFilename, W, H)
  const metadata = buildMetadata(final)
  const names = processedNames(ctx.chapterNumber, imageFilename)
  const pointerText = JSON.stringify(pointerFile, null, 2) + '\n'
  const metadataText = JSON.stringify(metadata, null, 2) + '\n'

  const precheck = roundTripErrors(pointerFile, final, W, H)
  if (precheck.length > 0) throw new ExportError(500, 'Normalized points do not reproduce the reviewed boxes', precheck)

  // 2. Stage.
  const now = new Date().toISOString()
  const studio = getStudioDir(ctx.folderPath, imageFilename)
  const exportName = `rev-${String(state.review_revision).padStart(4, '0')}-${now.replace(/[:.]/g, '-')}`
  const exportDir = path.join(studio, EXPORTS_DIR, exportName)
  const stagedCrops = path.join(exportDir, 'crops')
  const stagedProcessed = path.join(exportDir, 'processed')
  await fs.mkdir(stagedCrops, { recursive: true })
  await fs.mkdir(stagedProcessed, { recursive: true })

  const chapterDir = getSourceFolderPath(ctx.folderPath)
  const seriesDir = path.dirname(chapterDir)
  const chapterFolder = path.basename(chapterDir)
  const processedDest = path.join(getProcessedDir(ctx.folderPath), names.pageFolder)
  const cropsDest = path.join(seriesDir, 'Crops', chapterFolder, names.pageFolder)
  const rel = (p: string) => path.relative(seriesDir, p)

  const report: ExportReport = {
    schema_version: EXPORT_SCHEMA,
    status: 'failed',
    exported_at: now,
    page_stem: state.page_stem,
    original_filename: imageFilename,
    source_sha256: state.source_sha256,
    source_width: W,
    source_height: H,
    job_id: state.job_id,
    review_revision: state.review_revision,
    based_on: state.based_on,
    crop_count: final.length,
    crops: [],
    destinations: {
      processed: rel(processedDest),
      crops: rel(cropsDest),
      store: [`${chapterFolder}/crop_points3`, `${chapterFolder}/crop_metadata3`]
    },
    replaced: [],
    files: [],
    notes: [
      'Geometry, files and naming were verified by the app. Whether the crops capture the right artwork was judged in review, not proven by the app.',
      ...((state.chatgpt_reviews?.length ?? 0) > 0
        ? [`${state.chatgpt_reviews!.length} review round(s) were done by ChatGPT (revisions ${state.chatgpt_reviews!.map(r => `${r.from_revision}→${r.to_revision}`).join(', ')}): its decisions, description approvals and sweep were accepted without an operator check.`]
        : [])
    ]
  }
  const writeReport = async () => {
    const text = JSON.stringify(report, null, 2) + '\n'
    await fs.writeFile(path.join(exportDir, EXPORT_REPORT_FILE), text, 'utf-8')
    if (report.status === 'completed') await fs.writeFile(path.join(studio, EXPORT_REPORT_FILE), text, 'utf-8')
  }

  try {
    for (const crop of final) {
      const { x0, y0, x1, y1 } = crop.bounds
      await sharp(sourcePath)
        .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
        .png()
        .toFile(path.join(stagedCrops, crop.exportedFilename))
    }
    await fs.writeFile(path.join(stagedProcessed, names.pointers), pointerText, 'utf-8')
    await fs.writeFile(path.join(stagedProcessed, names.metadata), metadataText, 'utf-8')

    // 3. Verify the stage.
    const problems: string[] = []
    for (const crop of final) {
      const file = path.join(stagedCrops, crop.exportedFilename)
      const decoded = await sharp(file).raw().toBuffer({ resolveWithObject: true })
      const mismatch = pixelsMatch(decoded, pixels, crop.bounds)
      if (mismatch) problems.push(`${crop.exportedFilename} ${mismatch}`)
      report.crops.push({
        id: crop.id,
        key: crop.key,
        reason: crop.reason,
        bounds: crop.bounds,
        exportedFilename: crop.exportedFilename,
        width: decoded.info.width,
        height: decoded.info.height,
        sha256: await sha256OfFile(file)
      })
    }

    const reread = JSON.parse(await fs.readFile(path.join(stagedProcessed, names.pointers), 'utf-8')) as Clipper3ImageCropFile
    const usable = extractCrops(reread)
    if (usable.length !== final.length) problems.push(`Pointer file reads back with ${usable.length} usable crops, expected ${final.length}`)
    problems.push(...roundTripErrors(reread, final, W, H))
    const rereadMeta = await fs.readFile(path.join(stagedProcessed, names.metadata), 'utf-8')
    const metaCheck = validateMetadata(rereadMeta, final.map(c => c.id), final.map(c => c.exportedFilename), ctx.seriesSlug)
    if (!metaCheck.isValid) problems.push(...metaCheck.errors)
    const parsedMeta = JSON.parse(rereadMeta) as ReturnType<typeof buildMetadata>
    parsedMeta.crops.forEach((entry, i) => {
      if (Object.keys(entry).join(',') !== 'id,exportedFilename,description') problems.push(`Metadata entry ${i + 1} has keys ${Object.keys(entry).join(', ')}`)
      if (entry.id !== usable[i]?.id) problems.push(`Metadata entry ${i + 1} is ${entry.id}, pointer entry is ${usable[i]?.id}`)
      if (!entry.description) problems.push(`${entry.id} has no description`)
    })
    const pngs = (await fs.readdir(stagedCrops)).sort()
    const expected = final.map(c => c.exportedFilename).sort()
    if (pngs.join('\n') !== expected.join('\n')) problems.push('The staged PNG set does not match the metadata filenames')
    if (new Set(expected).size !== expected.length) problems.push('Two crops would export under the same filename')

    if (problems.length > 0) {
      report.error = 'Staged export failed verification; nothing was published'
      await writeReport()
      throw new ExportError(500, report.error, problems)
    }

    // 4. Publish — Processed and Crops swapped whole, previous contents kept.
    const stagedHashes = { processed: await hashTree(stagedProcessed), crops: await hashTree(stagedCrops) }
    if (await swapFolder(stagedProcessed, processedDest, path.join(exportDir, 'replaced', 'processed'))) report.replaced.push('replaced/processed')
    if (await swapFolder(stagedCrops, cropsDest, path.join(exportDir, 'replaced', 'crops'))) report.replaced.push('replaced/crops')

    // The Clipper 3.0 store: previous files kept, then rewritten.
    const previousPoints = await readImagePoints(ctx.folderPath, imageFilename)
    const previousMeta = await readImageMetadata(ctx.folderPath, imageFilename)
    if (previousPoints || previousMeta) {
      const aside = path.join(exportDir, 'replaced', 'store')
      await fs.mkdir(aside, { recursive: true })
      if (previousPoints) await fs.writeFile(path.join(aside, 'crop_points3.json'), previousPoints.text, 'utf-8')
      if (previousMeta !== null) await fs.writeFile(path.join(aside, 'crop_metadata3.txt'), previousMeta, 'utf-8')
      report.replaced.push('replaced/store')
    }
    if (final.length > 0) {
      await writeImagePoints(ctx.folderPath, imageFilename, { ...pointerFile, receivedAt: now })
      await writeImageMetadata(ctx.folderPath, imageFilename, metadataText)
    } else {
      report.notes.push('No crops: Clipper 3.0 cannot mark a page without crops as Done, so its crop_points3 / crop_metadata3 entry was left as it was.')
    }

    // 5. Verify the publish.
    const published = { processed: await hashTree(processedDest), crops: await hashTree(cropsDest) }
    for (const key of ['processed', 'crops'] as const) {
      const want = stagedHashes[key]
      const got = published[key]
      if (want.size !== got.size || [...want].some(([name, hash]) => got.get(name) !== hash)) {
        throw new ExportError(500, `The published ${key} folder does not match what was staged`)
      }
    }
    for (const [name, hash] of published.processed) report.files.push({ path: path.join(report.destinations.processed, name), sha256: hash, bytes: (await fs.stat(path.join(processedDest, name))).size })
    for (const [name, hash] of published.crops) report.files.push({ path: path.join(report.destinations.crops, name), sha256: hash, bytes: (await fs.stat(path.join(cropsDest, name))).size })

    report.status = 'completed'
    await writeReport()
    await fs.writeFile(path.join(studio, EXPORTS_DIR, 'CURRENT'), exportName + '\n', 'utf-8')
    return report
  } catch (err) {
    if (report.status !== 'completed' && !report.error) {
      report.error = err instanceof Error ? err.message : String(err)
      await writeReport().catch(() => {})
    }
    if (err instanceof ExportError) throw err
    throw new ExportError(500, `Export failed: ${err instanceof Error ? err.message : String(err)}`, report.replaced.length > 0 ? [`Previous contents were moved to ${path.relative(seriesDir, exportDir)}/replaced`] : [])
  }
}

export interface ExportStatus {
  report: ExportReport | null
  /** The last export still matches the current review revision and the page on disk. */
  upToDate: boolean
}

export async function getExportStatus(folderPath: string, imageFilename: string): Promise<ExportStatus> {
  let report: ExportReport
  try {
    report = JSON.parse(await fs.readFile(path.join(getStudioDir(folderPath, imageFilename), EXPORT_REPORT_FILE), 'utf-8')) as ExportReport
  } catch {
    return { report: null, upToDate: false }
  }
  const view = await getReview(folderPath, imageFilename)
  const upToDate = !!view.state && !view.stale &&
    view.state.review_revision === report.review_revision &&
    view.state.source_sha256 === report.source_sha256
  return { report, upToDate }
}
