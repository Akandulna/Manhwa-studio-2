/**
 * Image Clipper 2.0 — Stage 1: four-pointer detection.
 *
 * Places FOUR CROP POINTERS (P1 top-left → P2 top-right → P3 bottom-right → P4
 * bottom-left) around every meaningful section of a chapter, then composes the
 * canonical `four-point-crop` artifact. Stage 2 (apply) is entirely deterministic
 * and reads only that artifact.
 *
 * Detection asks a Gemini vision model to read the Crop Detection Guidelines
 * (server/ml/CROP_POINT_GUIDELINES.md) and place pointers on page images —
 * geminiPointerDetector.ts owns the model call and prompt windowing. The model
 * sees discrete pages, never a stitched canvas, so it reports points in
 * PAGE-LOCAL fractions (P1/P2 against `startPage`, P3/P4 against `endPage`); this
 * file lifts those onto the combined canvas (`canvasRectFromPointers`), resolving
 * each point against its OWN page's width so a chapter with mixed page widths
 * doesn't have every crop widened to the widest page in the chapter. It then
 * de-duplicates in 2D, normalizes and validates.
 *
 * Normalization happens here and nowhere earlier, and it goes through
 * fourPointSchema — the module that already owns the `OUT-*` rules, the repair
 * pass and the canonical serializer.
 *
 * The Crop Detection Guidelines are handed to the model verbatim, same as v1's
 * guideline cropper (`services/ai/guidelineCropService.ts`) — its rule IDs
 * (`OUT-08`, `IX-01`, `ST-09`, `AN-02`, …) are cited throughout this file and its
 * sha is recorded in the sidecar for provenance.
 */

import crypto from 'crypto'
import type {
  CanvasRect,
  CropEntry,
  CropImageInfo,
  CropPointsSegment,
  CropPointsSidecar,
  DetectedPointerCrop,
  DetectionResult,
  FourPointCropFile,
  NormBounds,
  ValidationIssue
} from './fourPointTypes.js'
import {
  boundsOf,
  dedupeEntriesByRegion,
  emptyCropFile,
  entryFromCanvasRect,
  normalizeCropFile,
  rectIoU,
  validateCropFile
} from './fourPointSchema.js'
import { readPointerGuidelines } from './pointerGuidelines.js'
import {
  checkGeminiPointerDetector,
  getGeminiPointerModel,
  isGeminiPointerDetectorEnabled,
  runGeminiPointerDetection
} from './geminiPointerDetector.js'
import type { GeminiDetectorStatus } from './geminiPointerDetector.js'
import type { ImageManifest, ManifestImage } from '../clipperService.js'

// ============ Constants ============

/** Below this the crop is a sliver, not a section — discard rather than export. */
const MIN_CROP_PX = 4

/** Used when the detector omits a confidence, or a diagnostic can't be re-matched after normalization. */
const DEFAULT_CONFIDENCE = 0.5

/**
 * Overlap required to recognise a normalized crop as one of the pre-normalization
 * crops. Normalization re-sorts, renumbers, snaps near-equal edges and rounds to
 * `OUT-10` precision — none of which moves a crop — so a genuine match overlaps at
 * ~1.0 and anything lower is a different crop.
 */
const CONFIDENCE_MATCH_IOU = 0.9

/** Below this, the model's own confidence becomes a user-visible warning (§25). */
const LOW_CONFIDENCE = 0.55

/** Exact message the caller contracts on for an aborted run. */
const CANCELLED = 'cancelled'

// ============ Availability ============

export async function isDetectorAvailable(): Promise<boolean> {
  if (!isGeminiPointerDetectorEnabled()) return false
  const status = await checkGeminiPointerDetector()
  return status.available
}

/** Identifies the engine in the sidecar and the UI, in place of a model id. */
export function getDetectionModel(): string {
  return `gemini (${getGeminiPointerModel()})`
}

export { checkGeminiPointerDetector, isGeminiPointerDetectorEnabled }
export type { GeminiDetectorStatus }

// ============ Logical page identity ============

/**
 * The `image.filename` written into the artifact.
 *
 * §14.3 asks for the ORIGINAL image filename, and a single-image page has one. A
 * stitched logical page (`ST-01`) has none: its coordinates are normalized against a
 * combined canvas that exists nowhere on disk (`ST-09`). So a descriptive
 * `[stitched:N]` label stands in, and the real ordered segment list lives in the
 * sidecar (`ST-10`) where the apply stage can resolve it back to actual files.
 */
export function logicalPageName(folderPath: string, manifest: ImageManifest): string {
  const pages = manifest.images
  if (pages.length === 1) return pages[0].filename
  const base = folderPath.split(/[\\/]/).filter(Boolean).pop() || 'chapter'
  return `${base} [stitched:${pages.length}]`
}

// ============ Small helpers ============

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex')
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isCancellation(err: unknown): boolean {
  return err instanceof Error && err.message === CANCELLED
}

function warning(code: string, rule: string, message: string, cropId?: string): ValidationIssue {
  return { code, rule, message, severity: 'warning', ...(cropId ? { cropId } : {}) }
}

/** Provisional only — normalizeCropFile assigns the contiguous page-ordered ids (`OUT-08`). */
function provisionalCropId(n: number): string {
  return `crop-${String(n).padStart(2, '0')}`
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

// ============ Canvas rect from page-local pointers ============

function pageFor(pages: ManifestImage[], oneBasedIndex: number): ManifestImage {
  const idx = Math.max(0, Math.min(pages.length - 1, Math.round(oneBasedIndex) - 1))
  return pages[idx]
}

/**
 * Lift the model's page-local P1..P4 (§ file header) onto the combined canvas.
 *
 * Each point's `y` resolves against its OWN page's canvas extent — P1/P2 against
 * `startPage`, P3/P4 against `endPage` — since a crop may span a seam and the two
 * pages can have different scaled heights.
 *
 * Outer, not inner: the artifact must be a rectangle (`AN-02`), so a model that
 * reports slightly unequal edges (e.g. because startPage and endPage genuinely
 * differ in width) is resolved outwards rather than inwards into the container
 * (`CB-03`).
 */
function canvasRectFromPointers(crop: DetectedPointerCrop, manifest: ImageManifest): CanvasRect | null {
  const pages = manifest.images
  if (pages.length === 0) return null

  const startPage = pageFor(pages, crop.startPage)
  const endPage = pageFor(pages, crop.endPage)
  const byId = new Map(crop.points.map(p => [p.id, p]))
  const p1 = byId.get('P1')
  const p2 = byId.get('P2')
  const p3 = byId.get('P3')
  const p4 = byId.get('P4')
  if (!p1 || !p2 || !p3 || !p4) return null

  // Page-local ratios lift onto the canvas through each page's CANVAS extents, not
  // its source pixels: the canvas scales every slice to the reference width, so a
  // narrow page's own height is not the height it occupies. `x` resolves against the
  // full canvas width because a scaled page spans all of it — which is also why this
  // no longer needs the per-page width the raw-stacking layout required.
  const topLeftX = clamp01(p1.x) * manifest.canvasWidth
  const topRightX = clamp01(p2.x) * manifest.canvasWidth
  const bottomRightX = clamp01(p3.x) * manifest.canvasWidth
  const bottomLeftX = clamp01(p4.x) * manifest.canvasWidth
  const topY = startPage.canvasY + clamp01(p1.y) * startPage.canvasHeight
  const topRightY = startPage.canvasY + clamp01(p2.y) * startPage.canvasHeight
  const bottomY = endPage.canvasY + clamp01(p3.y) * endPage.canvasHeight
  const bottomLeftY = endPage.canvasY + clamp01(p4.y) * endPage.canvasHeight

  const left = Math.max(0, Math.min(topLeftX, bottomLeftX))
  const right = Math.min(manifest.canvasWidth, Math.max(left, Math.max(topRightX, bottomRightX)))
  const top = Math.max(0, Math.min(topY, topRightY))
  const bottom = Math.min(manifest.canvasHeight, Math.max(top, Math.max(bottomY, bottomLeftY)))

  const canvasW = right - left
  const canvasH = bottom - top
  if (!Number.isFinite(canvasW) || !Number.isFinite(canvasH)) return null
  if (canvasW < MIN_CROP_PX || canvasH < MIN_CROP_PX) return null

  return { canvasX: left, canvasY: top, canvasW, canvasH }
}

// ============ Artifact assembly ============

function buildFile(folderPath: string, manifest: ImageManifest, crops: CropEntry[]): FourPointCropFile {
  const image: CropImageInfo = {
    filename: logicalPageName(folderPath, manifest),
    // `OUT-14`: the dimensions actually measured. For a stitched chapter that is the
    // combined canvas, not any one segment (`ST-09`).
    width: manifest.canvasWidth,
    height: manifest.canvasHeight
  }
  // emptyCropFile owns the root shape (§14.2) and the `OUT-16` empty case, so the
  // root object is constructed in exactly one place.
  return { ...emptyCropFile(image), crops }
}

function buildSidecar(
  model: string,
  guidelinesSha: string | null,
  segments: CropPointsSegment[],
  warnings: ValidationIssue[]
): CropPointsSidecar {
  return {
    source: 'ai',
    model,
    guidelinesSha,
    detectedAt: new Date().toISOString(),
    segments,
    warnings
  }
}

/**
 * Re-attach per-crop diagnostics (confidence, notes) to the finished crops.
 *
 * normalizeCropFile owns renumbering (`OUT-08`), so provisional ids do not survive
 * into the canonical file — matching by geometry is therefore the only stable
 * link: normalization re-sorts, renumbers, snaps near-equal edges and rounds, all
 * of which leave a crop essentially where it was, so the true match overlaps at
 * ~1.0.
 */
function matchDiagnostics(
  finalEntries: CropEntry[],
  scored: Array<{ bounds: NormBounds; crop: DetectedPointerCrop }>
): { confidenceById: Record<string, number>; warnings: ValidationIssue[] } {
  const confidenceById: Record<string, number> = {}
  const issues: ValidationIssue[] = []

  for (const entry of finalEntries) {
    const bounds = boundsOf(entry)
    let bestIoU = 0
    let best: DetectedPointerCrop | null = null
    for (const candidate of scored) {
      const iou = rectIoU(bounds, candidate.bounds)
      if (iou > bestIoU) {
        bestIoU = iou
        best = candidate.crop
      }
    }
    if (best && bestIoU >= CONFIDENCE_MATCH_IOU) {
      const confidence = typeof best.confidence === 'number' ? best.confidence : DEFAULT_CONFIDENCE
      confidenceById[entry.id] = confidence
      if (confidence < LOW_CONFIDENCE) {
        issues.push(
          warning(
            'low_confidence',
            'ED-01',
            `${entry.id} confidence = ${confidence.toFixed(2)} — re-check this section before applying`,
            entry.id
          )
        )
      }
      if (best.notes) {
        issues.push(warning('detector_note', '', `${entry.id}: ${best.notes}`, entry.id))
      }
    } else {
      confidenceById[entry.id] = DEFAULT_CONFIDENCE
    }
  }
  return { confidenceById, warnings: issues }
}

// ============ Detection ============

/**
 * Run pointer detection over one chapter and compose the canonical artifact.
 *
 * An invalid artifact is never returned — the whole point of the two-stage design is
 * that Stage 2 can trust the file it reads.
 */
export async function detectCropPoints(
  imageDir: string,
  folderPath: string,
  manifest: ImageManifest,
  opts: {
    onProgress?: (p: { phase: string; percent: number; message?: string }) => void
    signal?: AbortSignal
  } = {}
): Promise<DetectionResult> {
  if (!isGeminiPointerDetectorEnabled()) {
    throw new Error(
      'GEMINI_API_KEY not configured — Image Clipper 2.0 pointer detection is unavailable'
    )
  }

  const model = getDetectionModel()
  const pages = manifest.images
  const segments: CropPointsSegment[] = pages.map(page => ({
    filename: page.filename,
    width: page.width,
    height: page.height,
    canvasY: page.canvasY
  }))
  const warnings: ValidationIssue[] = []

  let guidelinesSha: string | null = null
  const guidelines = await readPointerGuidelines()
  if (guidelines.trim()) {
    guidelinesSha = sha256(guidelines)
  } else {
    warnings.push(
      warning(
        'guidelines_missing',
        '',
        'The Crop Detection Guidelines document is missing, so the model ran on general ' +
        'cropping judgement rather than your written rules, and the artifact records no ' +
        'guidelines revision.'
      )
    )
  }

  // No pages means nothing to measure. `OUT-16` still wants a valid file, and
  // validation would reject a zero-sized logical page, so return directly.
  if (pages.length === 0) {
    console.warn('[clipper2] pointer detection skipped: the manifest has no pages')
    warnings.push(warning('no_pages', '', 'The chapter manifest contains no images, so no crops were detected'))
    return {
      file: buildFile(folderPath, manifest, []),
      sidecar: buildSidecar(model, guidelinesSha, segments, warnings),
      confidenceById: {},
      warnings
    }
  }

  console.log(
    `[clipper2] gemini pointer detection: ${pages.length} page(s), ` +
    `canvas ${manifest.canvasWidth}x${manifest.canvasHeight}, model ${model}`
  )

  let detection
  try {
    detection = await runGeminiPointerDetection(imageDir, manifest, guidelines, {
      onProgress: opts.onProgress,
      signal: opts.signal
    })
  } catch (err) {
    if (isCancellation(err)) throw err
    console.error('[clipper2] gemini detection failed:', err)
    throw new Error(`Gemini crop detection failed: ${errorText(err)}`)
  }

  for (const message of detection.warnings) {
    warnings.push(warning('detector_window_failed', '', message))
  }

  const entries: CropEntry[] = []
  const cropByProvisionalId = new Map<string, DetectedPointerCrop>()
  let provisional = 0

  for (const crop of detection.crops) {
    const rect = canvasRectFromPointers(crop, manifest)
    if (!rect) {
      warnings.push(
        warning(
          'crop_unresolvable',
          'ST-09',
          `Dropped a crop ("${crop.reason}"): its pointers do not resolve to a usable region of the logical page`
        )
      )
      continue
    }
    const id = provisionalCropId(++provisional)
    entries.push(entryFromCanvasRect(rect, manifest.canvasWidth, manifest.canvasHeight, id, crop.reason))
    cropByProvisionalId.set(id, crop)
  }

  // Reading order first (`OUT-07`). dedupeEntriesByRegion compares every pair, so
  // this is not needed to find duplicates — it makes the outcome deterministic.
  entries.sort((a, b) => {
    const ab = boundsOf(a)
    const bb = boundsOf(b)
    return ab.top - bb.top || ab.left - bb.left
  })

  // A 2D-aware de-duplication pass over normalized geometry — two sections
  // sharing a Y band at different X survive it (`CB-07`, `IX-04`).
  const { kept: deduped, dropped } = dedupeEntriesByRegion(entries, undefined, (entry: CropEntry) =>
    cropByProvisionalId.get(entry.id)?.confidence ?? DEFAULT_CONFIDENCE
  )
  if (dropped.length > 0) {
    console.log(`[clipper2] dropped ${dropped.length} duplicate region(s) after normalization`)
  }

  // Snapshot before normalizing: it returns fresh entries under new ids (`OUT-08`),
  // so an id-keyed lookup cannot survive the call.
  const scored = deduped
    .map(entry => {
      const crop = cropByProvisionalId.get(entry.id)
      return crop ? { bounds: boundsOf(entry), crop } : null
    })
    .filter((item): item is { bounds: NormBounds; crop: DetectedPointerCrop } => item !== null)

  const normalized = normalizeCropFile(buildFile(folderPath, manifest, deduped))
  warnings.push(...normalized.repairs)

  const report = validateCropFile(normalized.file)
  warnings.push(...report.warnings)
  if (!report.valid) {
    // Never hand Stage 2 — or the user's editor — an artifact that breaks §14.
    const detail = report.errors.map(e => `${e.rule || e.code}${e.cropId ? ` (${e.cropId})` : ''}: ${e.message}`).join('; ')
    throw new Error(`Pointer detection produced an invalid four-point-crop file and was not saved: ${detail}`)
  }

  const { confidenceById, warnings: diagnosticWarnings } = matchDiagnostics(normalized.file.crops, scored)
  warnings.push(...diagnosticWarnings)

  console.log(
    `[clipper2] detection complete: ${normalized.file.crops.length} crop(s), ${warnings.length} warning(s)`
  )

  return {
    file: normalized.file,
    sidecar: buildSidecar(model, guidelinesSha, segments, warnings),
    confidenceById,
    warnings
  }
}
