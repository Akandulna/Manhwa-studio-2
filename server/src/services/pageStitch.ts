import {withUnmanagedCropChapter} from './managedCropProjection.js'
/**
 * Page stitching — join a chapter's many short pages into a few tall ones.
 *
 * A normal chapter is 14–20 pages of roughly 10–15k px each. A few sources
 * split the same chapter into 200–300 short images instead, and everything
 * downstream (Clipper 3 handoffs, phone zips, ChatGPT upload limits) is sized
 * for the normal shape. Stitching rewrites such a chapter into that shape:
 *
 *  - The client sends the grouping it previewed: `groups`, each an ordered
 *    list of pieces. A piece is a page filename (the whole page) or
 *    `{ file, top, bottom }`, a band of source rows — Auto stitch cuts pages
 *    at blank rows, so one page can feed two outputs. Pages left out of every
 *    group are dropped from the chapter (credit/ad pages).
 *  - Each group becomes one `page_NNN` file. A group of one whole page is
 *    copied byte-for-byte; a multi-page group is stacked top to bottom at the
 *    group's widest width (narrower pages scaled up, as the chapter canvas
 *    does — see chapterManifest).
 *  - The originals move to `<chapter>/.stitch-originals/` with a record of
 *    the Page rows they replaced, so a stitch can be undone exactly. The dot
 *    keeps that folder out of the manifest (root files only) and out of R2
 *    zips (the walk skips dotfiles).
 *
 * Output format follows the sources: any JPEG in the group means JPEG at q92
 * (visually lossless; lossless WebP of JPEG pixels is 4–5x the size),
 * otherwise lossless WebP. Webtoon JPEGs are 4:2:0 already, so 4:4:4 would
 * only add bytes, and mozjpeg was ~10x slower for a 15% saving. Multi-page
 * groups are capped at the WebP dimension limit so both formats always work.
 */

import { withStitchActivity } from './stitchActivity.js'
import sharp from 'sharp'
import fs from 'fs/promises'
import path from 'path'
import { prisma } from '../index.js'
import { getImageFiles } from './chapterManifest.js'
import { WEBP_MAX_DIMENSION } from './pageImageStore.js'
import { getMetadataDir, getOutputDir, getPointsDir } from './clipper3/perImageStore.js'
import { getSliceDir } from './clipper3/perImageSlice.js'
import { zeroPad } from '../utils/urlPattern.js'
import { clearStitchCompletion, completionFromRecord, readStitchCompletion, saveStitchCompletion, type StitchCompletion } from './stitchCompletion.js'

/** Tallest stitched page allowed — libwebp's limit, so either format can encode it. */
export const STITCH_MAX_HEIGHT = WEBP_MAX_DIMENSION

const BACKUP_DIR = '.stitch-originals'
const TEMP_DIR = '.stitch-tmp'
const TRASH_DIR = '.stitch-undo'
const PREVIOUS_DIR = '.stitch-previous'
const RECORD_FILE = 'stitch.json'

const JPEG_QUALITY = 92

// ============ Types ============

export interface StitchPage {
  filename: string
  width: number
  height: number
  /** sharp's format name: jpeg, png, webp, gif… */
  format: string
  bytes: number
}

/** A band of one page's source rows, [top, bottom). A whole page is 0..height. */
export interface StitchSource extends StitchPage {
  top: number
  bottom: number
}

export interface StitchPiece {
  file: string
  top: number
  bottom: number
}

export interface PlannedOutput {
  filename: string
  sources: StitchSource[]
  width: number
  height: number
  /** True when the single source is a whole page, kept byte-for-byte. */
  copied: boolean
}

function isWhole(source: StitchSource): boolean {
  return source.top === 0 && source.bottom === source.height
}

interface OriginalPageRow {
  index: number
  sourceUrl: string | null
  localPath: string | null
  status: string
  bytes: number | null
}

export interface StitchRecord {
  version: 1
  stitchedAt: string
  /** Every image file that was in the chapter folder, now in the backup. */
  originals: string[]
  excluded: string[]
  outputs: {
    filename: string
    sources: string[]
    /** Set when a page was cut: the source rows of each piece, in stacking order. */
    pieces?: StitchPiece[]
    width: number
    height: number
    bytes: number
  }[]
  chapter: { pageCount: number | null; downloadedCount: number }
  pages: OriginalPageRow[]
  /** Restitching keeps the preceding completion and, when present, its undo backup. */
  previousStitch?: { completion: StitchCompletion; hasBackup: boolean }
}

export interface StitchState {
  pages: StitchPage[]
  stitched: StitchCompletion | null
  /** The undo record is absent once the originals have been deleted. */
  record: StitchRecord | null
  backupBytes: number
  /** Reasons the chapter cannot be stitched (or un-stitched) right now. */
  blockers: string[]
}

export class StitchError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

interface ChapterRef {
  id: string
  folderPath: string
  status: string
}

// ============ Paths ============

export function chapterDir(folderPath: string): string {
  return path.join(process.env.DOWNLOAD_ROOT || './downloads', folderPath)
}

export function backupDir(folderPath: string): string {
  return path.join(chapterDir(folderPath), BACKUP_DIR)
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function hasEntries(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).some(name => !name.startsWith('.'))
  } catch {
    return false
  }
}

// ============ Reading ============

export async function measurePages(dir: string, filenames: string[]): Promise<StitchPage[]> {
  const pages: StitchPage[] = []
  for (const filename of filenames) {
    const file = path.join(dir, filename)
    const [meta, stat] = await Promise.all([sharp(file).metadata(), fs.stat(file)])
    if (!meta.width || !meta.height) throw new Error(`Could not read dimensions for ${filename}`)
    pages.push({
      filename,
      width: meta.width,
      height: meta.pageHeight ?? meta.height,
      format: meta.format ?? '',
      bytes: stat.size
    })
  }
  return pages
}

export async function readRecord(folderPath: string): Promise<StitchRecord | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(backupDir(folderPath), RECORD_FILE), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Clipper 3 keys its crop points, metadata, exports and slices by page file
 * stem. Stitching reuses the `page_NNN` names for different pixels, so any of
 * those left behind would silently describe the wrong image.
 */
async function clipperBlockers(folderPath: string): Promise<string[]> {
  const found: string[] = []
  if (await hasEntries(getPointsDir(folderPath))) found.push('crop points')
  if (await hasEntries(getMetadataDir(folderPath))) found.push('crop metadata')
  if (await hasEntries(getOutputDir(folderPath))) found.push('exported crops')
  if (await hasEntries(path.dirname(getSliceDir(folderPath, 'page')))) found.push('page slices')
  return found.length > 0
    ? [`Image Clipper 3.0 already has ${found.join(', ')} for this chapter's pages. Remove them first — they would point at the wrong images afterwards.`]
    : []
}

async function interruptedStitchBlockers(folderPath: string): Promise<string[]> {
  const dir = chapterDir(folderPath)
  return await exists(path.join(dir, PREVIOUS_DIR)) || await exists(path.join(dir, TRASH_DIR, '.previous'))
    ? ['An earlier stitch was interrupted while moving its backup. Restore that backup before changing this chapter.']
    : []
}

export interface ChapterNeighbour {
  id: string
  number: number
}

/** The downloaded chapters either side of this one in its series, for prev/next buttons. */
export async function doneNeighbours(
  seriesId: string,
  number: number
): Promise<{ prev: ChapterNeighbour | null; next: ChapterNeighbour | null }> {
  const select = { id: true, number: true }
  const [prev, next] = await Promise.all([
    prisma.chapter.findFirst({
      where: { seriesId, status: 'done', number: { lt: number } },
      orderBy: { number: 'desc' },
      select
    }),
    prisma.chapter.findFirst({
      where: { seriesId, status: 'done', number: { gt: number } },
      orderBy: { number: 'asc' },
      select
    })
  ])
  return { prev, next }
}

export async function getStitchState(chapter: ChapterRef): Promise<StitchState> {
  const dir = chapterDir(chapter.folderPath)
  const pages = await measurePages(dir, await getImageFiles(dir))
  const record = await readRecord(chapter.folderPath)

  let backupBytes = 0
  if (record) {
    for (const name of record.originals) {
      backupBytes += await fs.stat(path.join(backupDir(chapter.folderPath), name)).then(s => s.size, () => 0)
    }
  }

  const blockers = [...await clipperBlockers(chapter.folderPath), ...await interruptedStitchBlockers(chapter.folderPath)]
  if (chapter.status !== 'done') blockers.unshift('The chapter is not fully downloaded.')
  const stitched = await readStitchCompletion(chapter.folderPath)
  return { pages, stitched, record, backupBytes, blockers }
}

// ============ Planning ============

/**
 * Check the client's grouping against the folder and lay out each output.
 * Groups list pieces of existing pages in the order they are stacked —
 * usually reading order, but the user may rearrange them by hand. No two
 * pieces may share a source row. Pages in no group are dropped.
 */
export function planOutputs(pages: StitchPage[], groups: unknown): PlannedOutput[] {
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new StitchError('groups must be a non-empty array of filename arrays')
  }

  const position = new Map(pages.map((p, i) => [p.filename, i]))
  const used = new Map<number, [number, number][]>()
  const outputs: PlannedOutput[] = []

  for (const group of groups) {
    if (!Array.isArray(group) || group.length === 0) {
      throw new StitchError('Every group needs at least one page')
    }
    const sources: StitchSource[] = []
    for (const item of group) {
      const piece = parsePiece(item)
      const at = piece ? position.get(piece.file) : undefined
      if (!piece || at === undefined) {
        throw new StitchError(`${JSON.stringify(item)} is not a page of this chapter — reload and try again`)
      }
      const page = pages[at]
      const top = piece.top ?? 0
      const bottom = piece.bottom ?? page.height
      if (!Number.isInteger(top) || !Number.isInteger(bottom) || top < 0 || bottom > page.height || top >= bottom) {
        throw new StitchError(`${page.filename}: rows ${top}–${bottom} are outside the page (0–${page.height})`)
      }
      const ranges = used.get(at) ?? []
      if (ranges.some(([a, b]) => top < b && bottom > a)) {
        throw new StitchError(`${page.filename} rows ${top}–${bottom} are used twice`)
      }
      used.set(at, [...ranges, [top, bottom]])
      sources.push({ ...page, top, bottom })
    }

    const width = Math.max(...sources.map(s => s.width))
    const height = sources.reduce((sum, s) => sum + scaledHeight(s, width), 0)
    const filename = `page_${zeroPad(outputs.length + 1)}`
    const copied = sources.length === 1 && isWhole(sources[0])

    if (!copied && height > STITCH_MAX_HEIGHT) {
      throw new StitchError(
        `Output page ${outputs.length + 1} would be ${height}px tall; the limit is ${STITCH_MAX_HEIGHT}px. Split it.`
      )
    }
    outputs.push({ filename, sources, width, height, copied })
  }
  return outputs
}

function parsePiece(item: unknown): { file: string; top?: number; bottom?: number } | null {
  if (typeof item === 'string') return { file: item }
  if (item && typeof item === 'object' && typeof (item as StitchPiece).file === 'string') {
    const { file, top, bottom } = item as StitchPiece
    return { file, top, bottom }
  }
  return null
}

/** Height of a source's rows once scaled to `width`. */
function scaledHeight(source: StitchSource, width: number): number {
  return Math.round(((source.bottom - source.top) * width) / source.width)
}

function outputExtension(output: PlannedOutput): string {
  if (output.copied) return path.extname(output.sources[0].filename).toLowerCase()
  return output.sources.some(s => s.format === 'jpeg') ? '.jpg' : '.webp'
}

// ============ Rendering ============

/** Write one planned output into `destDir`; returns the file name written. */
export async function renderOutput(srcDir: string, output: PlannedOutput, destDir: string): Promise<string> {
  const name = `${output.filename}${outputExtension(output)}`
  const dest = path.join(destDir, name)

  if (output.copied) {
    await fs.copyFile(path.join(srcDir, output.sources[0].filename), dest)
    return name
  }

  const layers: sharp.OverlayOptions[] = []
  let top = 0
  for (const source of output.sources) {
    const height = scaledHeight(source, output.width)
    // Read into memory: libvips caches by filename, and these names get reused.
    let image = sharp(await fs.readFile(path.join(srcDir, source.filename)))
    if (!isWhole(source)) {
      image = image.extract({ left: 0, top: source.top, width: source.width, height: source.bottom - source.top })
    }
    if (source.width !== output.width || height !== source.bottom - source.top) {
      image = image.resize(output.width, height, { fit: 'fill', kernel: 'lanczos3' })
    }
    layers.push({ input: await image.png().toBuffer(), top, left: 0 })
    top += height
  }

  const canvas = sharp({
    create: { width: output.width, height: output.height, channels: 3, background: '#ffffff' }
  }).composite(layers)

  const encoded = name.endsWith('.jpg')
    ? canvas.jpeg({ quality: JPEG_QUALITY })
    : canvas.webp({ lossless: true })
  await encoded.toFile(dest)
  return name
}

// ============ Stitch / undo ============

const busy = new Set<string>()

async function withLock<T>(chapterId: string, run: () => Promise<T>): Promise<T> {
  if (busy.has(chapterId)) throw new StitchError('This chapter is already being stitched', 409)
  busy.add(chapterId)
  try {
    return await run()
  } finally {
    busy.delete(chapterId)
  }
}

/** Move every name from one folder to another; returns what moved, for rollback. */
async function moveAll(names: string[], from: string, to: string, moved: string[] = []): Promise<string[]> {
  for (const name of names) {
    await fs.rename(path.join(from, name), path.join(to, name))
    moved.push(name)
  }
  return moved
}

async function moveBack(names: string[], from: string, to: string): Promise<void> {
  const failures: unknown[] = []
  for (const name of names) {
    await fs.rename(path.join(from, name), path.join(to, name)).catch(err => {
      console.error(`[stitch] rollback could not move ${name} back:`, err)
      failures.push(err)
    })
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Could not restore all pages; their backups have been retained.')
}

async function stitchChapterLegacy(chapter: ChapterRef, groups: unknown, restitch: boolean): Promise<StitchRecord> {
  return withLock(chapter.id, async () => {
    const state = await getStitchState(chapter)
    if (state.stitched && !restitch) throw new StitchError(state.record
      ? 'This chapter is already stitched. Undo it first.'
      : 'This chapter is already stitched and its originals have been deleted.', 409)
    if (restitch && !state.stitched) throw new StitchError('The stitch status changed. Reload the chapter before stitching again.', 409)
    if (state.blockers.length > 0) throw new StitchError(state.blockers[0], 409)

    const outputs = planOutputs(state.pages, groups)
    const dir = chapterDir(chapter.folderPath)
    const temp = path.join(dir, TEMP_DIR)
    const backup = backupDir(chapter.folderPath)
    const originals = state.pages.map(p => p.filename)
    const used = new Set(outputs.flatMap(o => o.sources.map(s => s.filename)))

    // 1. Render everything aside. Nothing in the chapter has changed yet.
    await fs.rm(temp, { recursive: true, force: true })
    await fs.mkdir(temp)
    const written: string[] = []
    try {
      for (const output of outputs) written.push(await renderOutput(dir, output, temp))
    } catch (error) {
      await fs.rm(temp, { recursive: true, force: true })
      throw error
    }

    const pageRows = await prisma.page.findMany({
      where: { chapterId: chapter.id },
      select: { index: true, sourceUrl: true, localPath: true, status: true, bytes: true },
      orderBy: { index: 'asc' }
    })
    const chapterRow = await prisma.chapter.findUniqueOrThrow({
      where: { id: chapter.id },
      select: { pageCount: true, downloadedCount: true }
    })

    const sizes = await Promise.all(written.map(name => fs.stat(path.join(temp, name)).then(s => s.size)))
    const record: StitchRecord = {
      version: 1,
      stitchedAt: new Date().toISOString(),
      originals,
      excluded: originals.filter(name => !used.has(name)),
      outputs: outputs.map((o, i) => ({
        filename: written[i],
        sources: [...new Set(o.sources.map(s => s.filename))],
        ...(o.sources.every(isWhole)
          ? {}
          : { pieces: o.sources.map(s => ({ file: s.filename, top: s.top, bottom: s.bottom })) }),
        width: o.width,
        height: o.height,
        bytes: sizes[i]
      })),
      chapter: chapterRow,
      pages: pageRows,
      ...(state.stitched ? { previousStitch: { completion: state.stitched, hasBackup: !!state.record } } : {})
    }

    // 2. Swap: originals into the backup, stitched pages into the chapter.
    const movedOut: string[] = []
    const movedIn: string[] = []
    // Keep the old backup outside render scratch space, including after a process crash.
    const parkedBackup = path.join(dir, PREVIOUS_DIR)
    const previousBackup = path.join(backup, '.previous')
    let previousParked = false
    let previousNested = false
    let backupCreated = false
    try {
      if (state.record) {
        await fs.rename(backup, parkedBackup)
        previousParked = true
      }
      await fs.mkdir(backup)
      backupCreated = true
      await moveAll(originals, dir, backup, movedOut)
      await moveAll(written, temp, dir, movedIn)
      if (previousParked) {
        await fs.rename(parkedBackup, previousBackup)
        previousNested = true
      }
      await fs.writeFile(path.join(backup, RECORD_FILE), JSON.stringify(record, null, 2))
      await saveStitchCompletion(chapter.folderPath, completionFromRecord(record))

      await prisma.$transaction([
        prisma.page.deleteMany({ where: { chapterId: chapter.id } }),
        prisma.page.createMany({
          data: written.map((name, index) => ({
            chapterId: chapter.id,
            index,
            localPath: path.join(chapter.folderPath, name),
            status: 'done',
            bytes: sizes[index]
          }))
        }),
        prisma.chapter.update({
          where: { id: chapter.id },
          data: { pageCount: written.length, downloadedCount: written.length }
        })
      ])
    } catch (error) {
      for (const name of movedIn) await fs.unlink(path.join(dir, name)).catch(() => {})
      await moveBack(movedOut, backup, dir)
      if (previousNested) {
        await fs.rename(previousBackup, parkedBackup)
        previousNested = false
      }
      if (backupCreated) await fs.rm(backup, { recursive: true, force: true })
      if (previousParked) {
        await fs.rename(parkedBackup, backup)
        previousParked = false
      }
      if (state.stitched) await saveStitchCompletion(chapter.folderPath, state.stitched)
      else await clearStitchCompletion(chapter.folderPath)
      throw error
    } finally {
      await fs.rm(temp, { recursive: true, force: true })
    }

    console.log(`[stitch] ${chapter.folderPath}: ${originals.length} pages -> ${written.length}`)
    return record
  })
}

async function undoStitchLegacy(chapter: ChapterRef): Promise<void> {
  return withLock(chapter.id, async () => {
    const record = await readRecord(chapter.folderPath)
    if (!record) throw new StitchError('This chapter has no stitch to undo', 404)
    const blockers = [...await clipperBlockers(chapter.folderPath), ...await interruptedStitchBlockers(chapter.folderPath)]
    if (blockers.length > 0) throw new StitchError(blockers[0], 409)

    const dir = chapterDir(chapter.folderPath)
    const backup = backupDir(chapter.folderPath)
    const completion = await readStitchCompletion(chapter.folderPath)
    const previousBackup = path.join(backup, '.previous')
    if (record.previousStitch?.hasBackup && !(await exists(path.join(previousBackup, RECORD_FILE)))) {
      throw new StitchError('The preceding stitch backup is missing; the stitch cannot be undone', 409)
    }
    for (const name of record.originals) {
      if (!(await exists(path.join(backup, name)))) {
        throw new StitchError(`The backup is missing ${name}; the stitch cannot be undone`, 409)
      }
    }

    // Park the stitched pages instead of deleting them, so a failure can put them back.
    const trash = path.join(dir, TRASH_DIR)
    await fs.rm(trash, { recursive: true, force: true })
    await fs.mkdir(trash)
    const present = (await getImageFiles(dir)).filter(name => record.outputs.some(o => o.filename === name))
    const parked: string[] = []
    const restored: string[] = []
    const parkedBackup = path.join(trash, '.previous')
    let previousParked = false
    try {
      await moveAll(present, dir, trash, parked)
      const clash = (await getImageFiles(dir)).find(name => record.originals.includes(name))
      if (clash) throw new StitchError(`${clash} is already in the chapter folder; move it out and retry`, 409)
      await moveAll(record.originals, backup, dir, restored)
      if (record.previousStitch?.hasBackup) {
        await fs.rename(previousBackup, parkedBackup)
        previousParked = true
      }
      if (record.previousStitch) await saveStitchCompletion(chapter.folderPath, record.previousStitch.completion)
      else await clearStitchCompletion(chapter.folderPath)

      await prisma.$transaction([
        prisma.page.deleteMany({ where: { chapterId: chapter.id } }),
        prisma.page.createMany({ data: record.pages.map(p => ({ ...p, chapterId: chapter.id })) }),
        prisma.chapter.update({ where: { id: chapter.id }, data: record.chapter })
      ])
    } catch (error) {
      if (previousParked) {
        await fs.rename(parkedBackup, previousBackup)
        previousParked = false
      }
      await moveBack(restored, dir, backup)
      await moveBack(parked, trash, dir)
      if (completion) await saveStitchCompletion(chapter.folderPath, completion)
      await fs.rm(trash, { recursive: true, force: true })
      throw error
    }

    await fs.rm(backup, { recursive: true, force: true })
    if (previousParked) await fs.rename(parkedBackup, backup)
    await fs.rm(trash, { recursive: true, force: true })
    console.log(`[stitch] ${chapter.folderPath}: undone, ${record.originals.length} pages restored`)
  })
}

/** Keep the stitch for good: drop the undo backup, retain completion. */
async function discardBackupLegacy(chapter: ChapterRef): Promise<void> {
  return withLock(chapter.id, async () => {
    const blockers = await interruptedStitchBlockers(chapter.folderPath)
    if (blockers.length > 0) throw new StitchError(blockers[0], 409)
    const record = await readRecord(chapter.folderPath)
    if (!record) throw new StitchError('This chapter has no stitch backup', 404)
    await saveStitchCompletion(chapter.folderPath, completionFromRecord(record))
    await fs.rm(backupDir(chapter.folderPath), { recursive: true, force: true })
  })
}

export async function stitchChapter(chapter: ChapterRef, groups: unknown, restitch = false):Promise<StitchRecord> {
 return withStitchActivity(chapter.folderPath,()=>withUnmanagedCropChapter(chapter.folderPath,()=>stitchChapterLegacy(chapter,groups,restitch)))
}

export async function undoStitch(chapter: ChapterRef):Promise<void> {
 return withUnmanagedCropChapter(chapter.folderPath,()=>undoStitchLegacy(chapter))
}

export async function discardBackup(chapter: ChapterRef):Promise<void> {
 return withUnmanagedCropChapter(chapter.folderPath,()=>discardBackupLegacy(chapter))
}
