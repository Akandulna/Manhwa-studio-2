/**
 * Image Clipper 2.0 — Stage 2: pointers → cropped images.
 *
 * Deterministic by construction. There is no model call anywhere in this file:
 * it reads the pointer placements Stage 1 (or the user's own edit) left in the
 * JSON artifact, resolves them against the LIVE chapter manifest, and cuts with
 * the same sharp pipeline Module 3 v1 uses. clipperService.executeCrop already
 * handles single-file extraction, cross-page stitching (`ST-04`, `ST-05`) and
 * watermark white-fill, so none of that is reimplemented here.
 *
 * The artifact is hand-editable, which means every input is treated as
 * untrusted: the file is validated before a single pixel is read, degenerate
 * geometry is refused per entry, and a crop that fails can never abort the
 * batch — a chapter with one bad rectangle still exports the other forty.
 *
 * Registration into the chapter's CropSession is what makes these crops visible
 * to Module 4, which builds video parts from Crop rows carrying an exportPath.
 */

import fs from 'fs/promises'
import path from 'path'
import { prisma } from '../../index.js'
import type {
  AppliedCropFile,
  ApplyResult,
  CanvasRect,
  CropEntry,
  FourPointCropFile,
  ValidationIssue
} from './fourPointTypes.js'
import { rectFromEntry, validateCropFile } from './fourPointSchema.js'
import { getOutputDir, getSourceFolderPath } from './pointerStore.js'
import type { CropRect, ImageManifest, SourceFileRegion } from '../clipperService.js'
import {
  computeCropFromCanvas,
  executeCrop,
  generateCropPreview,
  normalizeCoordinates
} from '../clipperService.js'
import { detectChapterWatermarkRects } from '../watermarkService.js'

// ============ Geometry ============

/**
 * The single call site for the schema's pointer → rect resolution. Pointers are
 * normalized (`OUT-01`), so they are always resolved against the manifest that
 * describes the pages as they exist right now, never against the dimensions
 * recorded in the artifact (`OUT-14`).
 */
function entryRect(entry: CropEntry, manifest: ImageManifest): CanvasRect {
  return rectFromEntry(entry, manifest.canvasWidth, manifest.canvasHeight)
}

/**
 * Refuse geometry that cannot describe an image region. toPixelRect below clamps
 * to a minimum of one pixel, which would quietly turn a collapsed pointer set
 * into a 1px sliver and export a "successful" garbage crop; a hand-edited file
 * that says nothing must produce nothing.
 */
function assertUsableRect(entry: CropEntry, rect: CanvasRect): void {
  const values = [rect.canvasX, rect.canvasY, rect.canvasW, rect.canvasH]
  if (!values.every(v => Number.isFinite(v))) {
    throw new Error(`${entry.id}: pointers resolve to non-finite geometry`)
  }
  if (rect.canvasW < 1 || rect.canvasH < 1) {
    throw new Error(
      `${entry.id}: degenerate crop (${rect.canvasW.toFixed(2)}x${rect.canvasH.toFixed(2)} px) — ` +
      'the four pointers collapse to a line or a point'
    )
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Snap to whole pixels by rounding the EDGES rather than position and size
 * independently. Rounding a top and a height separately can move a crop's
 * bottom edge off the next crop's top edge, which leaves a one-pixel seam
 * between two sections the guidelines treat as adjacent; rounding both edges
 * keeps them flush. Clamping to the canvas guards against a pointer at exactly
 * 1.0 producing an extract area one pixel past the last page.
 */
function toPixelRect(rect: CanvasRect, manifest: ImageManifest): CropRect {
  const maxX = Math.max(1, Math.floor(manifest.canvasWidth))
  const maxY = Math.max(1, Math.floor(manifest.canvasHeight))

  const left = clampInt(Math.round(rect.canvasX), 0, maxX - 1)
  const top = clampInt(Math.round(rect.canvasY), 0, maxY - 1)
  const right = clampInt(Math.round(rect.canvasX + rect.canvasW), left + 1, maxX)
  const bottom = clampInt(Math.round(rect.canvasY + rect.canvasH), top + 1, maxY)

  return { canvasX: left, canvasY: top, canvasW: right - left, canvasH: bottom - top }
}

// ============ Naming ============

/** Derived exactly as clipperService.finalizeSession derives it, for consistent output names. */
function seriesSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function formatIssue(issue: ValidationIssue): string {
  const scope = issue.cropId ? `${issue.cropId}: ` : ''
  const rule = issue.rule ? ` (${issue.rule})` : ''
  return `${scope}${issue.message}${rule}`
}

// ============ Apply ============

interface PreparedCrop {
  entry: CropEntry
  rect: CropRect
  regions: SourceFileRegion[]
  applied: AppliedCropFile
}

/**
 * Cut every crop in a validated pointer file, then optionally mirror the results
 * into the chapter's CropSession.
 *
 * Throws only for conditions that make the whole run meaningless: an invalid
 * artifact, a missing chapter folder, or an unusable manifest. Everything else —
 * a crop that will not extract, a resolution change, a pre-existing session —
 * is reported through ApplyResult.
 */
export async function applyCropPoints(opts: {
  chapterId: string
  folderPath: string
  seriesTitle: string
  file: FourPointCropFile
  manifest: ImageManifest
  register?: boolean
  replaceExisting?: boolean
  onProgress?: (p: { current: number; total: number }) => void
}): Promise<ApplyResult> {
  const { chapterId, folderPath, seriesTitle, file, manifest, onProgress } = opts
  const register = opts.register !== false
  const replaceExisting = opts.replaceExisting === true
  const warnings: string[] = []

  // Stage 2 must never cut from an unvalidated artifact: the file is a
  // user-editable document, so its shape is re-established here even when
  // detection produced it minutes ago.
  const report = validateCropFile(file)
  if (!report.valid) {
    throw new Error(`Crop points file is invalid: ${report.errors.map(e => formatIssue(e)).join('; ')}`)
  }
  for (const issue of report.warnings) warnings.push(formatIssue(issue))

  if (manifest.images.length === 0 || manifest.canvasWidth <= 0 || manifest.canvasHeight <= 0) {
    throw new Error(
      `Chapter manifest for ${folderPath} is unusable ` +
      `(${manifest.images.length} page(s), ${manifest.canvasWidth}x${manifest.canvasHeight})`
    )
  }

  const sourceDir = getSourceFolderPath(folderPath)
  try {
    const stat = await fs.stat(sourceDir)
    if (!stat.isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error(`Chapter image folder is missing: ${sourceDir}`)
  }

  // Normalized coordinates survive a resolution change, which is the whole point
  // of storing ratios (`OUT-14`) — so this is a note, not a failure.
  if (file.image.width !== manifest.canvasWidth || file.image.height !== manifest.canvasHeight) {
    warnings.push(
      `Pointers were measured on ${file.image.width}x${file.image.height} but the chapter now measures ` +
      `${manifest.canvasWidth}x${manifest.canvasHeight}. Coordinates are normalized, so the crop stays ` +
      'valid if the page is served at a different resolution (OUT-14); resolving against the live manifest.'
    )
  }

  // Detected once for the chapter; executeCrop white-fills only the rects that
  // fall inside each crop. Best-effort exactly as finalizeSession does it: no
  // watermark sidecar and no templates simply means no white-fill.
  let watermarkRects: CropRect[] = []
  try {
    const chapter = await prisma.chapter.findUnique({ where: { id: chapterId }, select: { seriesId: true } })
    if (chapter) {
      watermarkRects = await detectChapterWatermarkRects(folderPath, chapter.seriesId, manifest)
    }
  } catch (err) {
    console.error('[clipper2] watermark detection failed (continuing without white-fill):', err)
  }

  const exportDir = getOutputDir(folderPath)
  await fs.mkdir(exportDir, { recursive: true })

  const slug = seriesSlug(seriesTitle)
  const total = file.crops.length
  const prepared: PreparedCrop[] = []
  const files: AppliedCropFile[] = []
  let failed = 0

  for (let i = 0; i < total; i++) {
    const entry = file.crops[i]
    // Sequence-numbered, not id-numbered: ids are contiguous by rule (`OUT-08`)
    // but a hand-edited file may break that, and the export order is what the
    // video editor consumes.
    const filename = `${slug}_pts_${String(i + 1).padStart(3, '0')}.png`
    const outputPath = path.join(exportDir, filename)

    try {
      const resolved = entryRect(entry, manifest)
      assertUsableRect(entry, resolved)
      const rect = toPixelRect(resolved, manifest)

      // Resolved here rather than during registration so a rect that overlaps no
      // page fails inside this try/catch, instead of halfway through the DB writes.
      const regions = computeCropFromCanvas(rect, manifest)

      const result = await executeCrop(rect, manifest, folderPath, outputPath, watermarkRects)
      const applied: AppliedCropFile = {
        cropId: entry.id,
        filename,
        path: path.resolve(outputPath),
        width: result.width,
        height: result.height,
        bytes: result.bytes
      }
      prepared.push({ entry, rect, regions, applied })
      files.push(applied)
    } catch (err) {
      failed++
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[clipper2] crop ${entry.id} failed:`, message)
      warnings.push(`Crop ${entry.id} failed: ${message}`)
    }

    onProgress?.({ current: i + 1, total })
  }

  let registered = false
  let sessionId: string | null = null

  if (register && prepared.length > 0) {
    const session = await prisma.cropSession.upsert({
      where: { chapterId },
      update: {},
      create: { chapterId }
    })
    sessionId = session.id

    const existing = await prisma.crop.count({ where: { sessionId: session.id } })
    if (existing > 0 && !replaceExisting) {
      // The chapter's manual or v1 crops are somebody's work; clobbering them
      // has to be an explicit choice. The images are already on disk either way.
      warnings.push(
        `This chapter's crop session already holds ${existing} crop(s), so the ${prepared.length} ` +
        'pointer crop(s) were exported but NOT registered. Re-apply with replaceExisting: true to ' +
        'replace the existing crops with these.'
      )
    } else {
      // Full replace rather than a merge: sequence is unique per session, and
      // pointer crops are only meaningful as a complete ordered set.
      await prisma.crop.deleteMany({ where: { sessionId: session.id } })

      for (let i = 0; i < prepared.length; i++) {
        const { entry, rect, regions, applied } = prepared[i]
        const norm = normalizeCoordinates(rect, manifest)

        const crop = await prisma.crop.create({
          data: {
            sessionId: session.id,
            sequence: i + 1,
            canvasX: rect.canvasX,
            canvasY: rect.canvasY,
            canvasW: rect.canvasW,
            canvasH: rect.canvasH,
            normX: norm.normX,
            normY: norm.normY,
            normW: norm.normW,
            normH: norm.normH,
            sourceFiles: JSON.stringify(regions),
            // Pointer crops are measured from the artwork, never fitted to a
            // preset ratio (`AN-02`).
            aspectRatio: 'free',
            exportPath: applied.path
          }
        })

        await prisma.cropEvent.create({
          data: {
            sessionId: session.id,
            cropId: crop.id,
            action: 'finalized',
            payload: JSON.stringify({
              source: 'clipper2-pointers',
              pointerCropId: entry.id,
              reason: entry.reason,
              exportPath: applied.path
            })
          }
        })
      }

      // 'finalized' is the status Module 4 expects on a session whose crops have
      // exportPaths, so the Video Editor can pick these up with no extra step.
      await prisma.cropSession.update({
        where: { id: session.id },
        data: { cropCount: prepared.length, status: 'finalized' }
      })
      registered = true
    }
  } else if (register) {
    warnings.push('No crops were exported, so nothing was registered into the chapter\'s crop session.')
  }

  return {
    exportDir: path.resolve(exportDir),
    exported: files.length,
    failed,
    files,
    registered,
    sessionId,
    warnings
  }
}

// ============ Preview ============

/**
 * Base64 data-URI thumbnail for one pointer set, for the artifact inspector.
 * Uses the same resolution path as apply, so what the user previews is exactly
 * what apply would cut.
 */
export async function previewCropEntry(
  entry: CropEntry,
  manifest: ImageManifest,
  folderPath: string
): Promise<string> {
  const resolved = entryRect(entry, manifest)
  assertUsableRect(entry, resolved)
  return generateCropPreview(toPixelRect(resolved, manifest), manifest, folderPath)
}
