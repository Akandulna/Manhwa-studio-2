/**
 * Image Clipper 2.0 — `four-point-crop` schema: validation, repair, geometry.
 *
 * The JSON pointer file is the contract between the two Clipper 2.0 stages and a
 * hand-editable user artifact, so it is read back from disk with no guarantee at
 * all about its contents: a vision model wrote the first version, a human may
 * have edited it since. Everything that decides whether such a file is usable —
 * and everything that turns its normalized ratios into pixels — lives here.
 *
 * This module is deliberately pure: no filesystem, no network, no imports beyond
 * ./fourPointTypes.js. That keeps the correctness backbone of the feature fully
 * unit-testable, and lets the detect stage, the apply stage and the API routes
 * share one definition of "valid".
 *
 * Two responsibilities are kept strictly apart:
 *  - validateCropFile REPORTS. It never mutates and never forgives: §13.1's
 *    rectangularity is checked with exact equality, so a file that only *nearly*
 *    complies is reported, not silently accepted.
 *  - normalizeCropFile REPAIRS, deterministically, and says what it changed.
 *    It is the only place allowed to tolerate real-world model drift.
 *
 * Rule IDs (`OUT-10`, `IX-04`, …) and section refs (`§13.1`) cite
 * server/ml/CROP_POINT_GUIDELINES.md.
 */

import {
  COORDINATE_SYSTEM,
  CROP_MODE,
  FOUR_POINT_FORMAT,
  FOUR_POINT_VERSION,
  POINT_IDS,
  RATIO_PRECISION
} from './fourPointTypes.js'
import type {
  CanvasRect,
  CropEntry,
  CropImageInfo,
  CropPoint,
  FourPointCropFile,
  NormBounds,
  PointId,
  ValidationIssue,
  ValidationReport
} from './fourPointTypes.js'

// ============ Tuning constants ============

/** `OUT-09` fallback when a reason contains nothing usable (e.g. "…" or "!!!"). */
const FALLBACK_REASON = 'visual_section'

/** normalizeCropFile defaults. A band thinner than this is measurement noise. */
const DEFAULT_MIN_NORM_HEIGHT = 0.002
const DEFAULT_MIN_NORM_WIDTH = 0.01
/** Model output routinely disagrees in the 4th decimal about one shared edge. */
const DEFAULT_SNAP_TOLERANCE = 0.002

/** Below this share of the page a crop is almost certainly a mis-measured edge. */
const MIN_SANE_AREA = 0.0005

// ============ Small type guards ============

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Short, quoted rendering of a bad value for an error message. */
function describe(value: unknown): string {
  if (value === undefined) return 'undefined'
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}

function issue(
  severity: 'error' | 'warning',
  code: string,
  rule: string,
  message: string,
  cropId?: string
): ValidationIssue {
  return cropId ? { code, rule, message, cropId, severity } : { code, rule, message, severity }
}

const asError = (code: string, rule: string, message: string, cropId?: string) =>
  issue('error', code, rule, message, cropId)

const asWarning = (code: string, rule: string, message: string, cropId?: string) =>
  issue('warning', code, rule, message, cropId)

// ============ Ratio formatting ============

/**
 * `OUT-10`: the exact normalized ratio, at most 9 decimal places, trailing zeros
 * stripped. Rounding to a coarser grid is a defect, not tidying — 0.244140625
 * (= 500 / 2048) has to survive unchanged, so 9 dp is a ceiling and never a
 * target precision.
 */
export function formatRatio(n: number): number {
  if (!Number.isFinite(n)) return 0
  const rounded = Number(n.toFixed(RATIO_PRECISION))
  // Collapse -0 so `OUT-11` rendering can never produce "-0.0".
  return rounded === 0 ? 0 : rounded
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function numOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// ============ Bounds ↔ points ============

/**
 * Edges of one crop, taken as min/max over every finite coordinate present. Using
 * extremes rather than fixed slots makes this usable on raw model output, where
 * the point order or the ids can be wrong.
 */
export function boundsOf(entry: CropEntry): NormBounds {
  const points = Array.isArray(entry?.crop?.points) ? entry.crop.points : []
  const xs: number[] = []
  const ys: number[] = []
  for (const point of points) {
    const x = Number((point as CropPoint | undefined)?.x)
    const y = Number((point as CropPoint | undefined)?.y)
    if (Number.isFinite(x)) xs.push(x)
    if (Number.isFinite(y)) ys.push(y)
  }
  if (xs.length === 0 || ys.length === 0) return { left: 0, top: 0, right: 0, bottom: 0 }
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys)
  }
}

/** §14.5 winding: P1 top-left → P2 top-right → P3 bottom-right → P4 bottom-left. */
export function pointsFromBounds(b: NormBounds): CropPoint[] {
  return [
    { id: 'P1', x: b.left, y: b.top },
    { id: 'P2', x: b.right, y: b.top },
    { id: 'P3', x: b.right, y: b.bottom },
    { id: 'P4', x: b.left, y: b.bottom }
  ]
}

/** `OUT-08`: zero-padded to at least two digits, 1-based. */
export function cropIdFor(index: number): string {
  const ordinal = Number.isFinite(index) ? Math.max(0, Math.floor(index)) + 1 : 1
  return `crop-${String(ordinal).padStart(2, '0')}`
}

/** `OUT-09`: lowercase snake_case, alphanumerics and single underscores only. */
export function toSnakeCaseReason(text: string): string {
  const slug = String(text ?? '')
    .toLowerCase()
    // One pass collapses runs too: '_' is itself outside [a-z0-9].
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return slug || FALLBACK_REASON
}

/** `OUT-16`: a page with no qualifying section still emits a complete, valid file. */
export function emptyCropFile(image: CropImageInfo): FourPointCropFile {
  return {
    format: FOUR_POINT_FORMAT,
    version: FOUR_POINT_VERSION,
    image: { filename: image.filename, width: image.width, height: image.height },
    coordinateSystem: COORDINATE_SYSTEM,
    crops: []
  }
}

// ============ Normalized ↔ canvas pixels ============

/**
 * Resolve an entry against the measured logical page (`ST-09` for a stitched
 * chapter). Pixels are left fractional on purpose: clipperService rounds when it
 * cuts, and rounding here as well would compound the error.
 */
export function rectFromEntry(entry: CropEntry, canvasWidth: number, canvasHeight: number): CanvasRect {
  const b = boundsOf(entry)
  const width = Number.isFinite(canvasWidth) ? canvasWidth : 0
  const height = Number.isFinite(canvasHeight) ? canvasHeight : 0
  return {
    canvasX: b.left * width,
    canvasY: b.top * height,
    canvasW: Math.max(0, b.right - b.left) * width,
    canvasH: Math.max(0, b.bottom - b.top) * height
  }
}

/**
 * Inverse of rectFromEntry, for crops drawn or nudged in the UI. A degenerate
 * canvas dimension yields 0 rather than Infinity, so a bad manifest surfaces as
 * a zero-area validation error instead of NaN reaching sharp.
 */
export function entryFromCanvasRect(
  rect: CanvasRect,
  canvasWidth: number,
  canvasHeight: number,
  id: string,
  reason: string
): CropEntry {
  const norm = (value: number, span: number) => (span > 0 ? clamp01(value / span) : 0)
  const width = isPositiveFinite(canvasWidth) ? canvasWidth : 0
  const height = isPositiveFinite(canvasHeight) ? canvasHeight : 0
  const x1 = norm(rect.canvasX, width)
  const x2 = norm(rect.canvasX + rect.canvasW, width)
  const y1 = norm(rect.canvasY, height)
  const y2 = norm(rect.canvasY + rect.canvasH, height)
  const bounds: NormBounds = {
    left: formatRatio(Math.min(x1, x2)),
    right: formatRatio(Math.max(x1, x2)),
    top: formatRatio(Math.min(y1, y2)),
    bottom: formatRatio(Math.max(y1, y2))
  }
  return {
    id,
    reason: toSnakeCaseReason(reason),
    crop: { mode: CROP_MODE, points: pointsFromBounds(bounds) }
  }
}

// ============ Overlap / de-duplication ============

/**
 * Vertical-span IoU.
 *
 * Kept because it is a meaningful measurement of two bands, but it is NO LONGER the
 * duplicate criterion: on its own it cannot tell a genuine inset apart from a second
 * measurement of the same section, and treating it as sufficient is what collapsed
 * distinct `CB-07` / `IX-04` sections. dedupeEntriesByRegion is the criterion.
 */
export function verticalIoU(a: NormBounds, b: NormBounds): number {
  const inter = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  const union = (a.bottom - a.top) + (b.bottom - b.top) - inter
  return union <= 0 ? 0 : inter / union
}

/** Horizontal-span IoU — the axis the old duplicate test ignored entirely. */
export function horizontalIoU(a: NormBounds, b: NormBounds): number {
  const inter = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
  const union = (a.right - a.left) + (b.right - b.left) - inter
  return union <= 0 ? 0 : inter / union
}

function areaOf(b: NormBounds): number {
  return Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top)
}

function intersectionArea(a: NormBounds, b: NormBounds): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return w > 0 && h > 0 ? w * h : 0
}

/** True 2D IoU over the whole rectangle. */
export function rectIoU(a: NormBounds, b: NormBounds): number {
  const inter = intersectionArea(a, b)
  if (inter <= 0) return 0
  const union = areaOf(a) + areaOf(b) - inter
  return union <= 0 ? 0 : inter / union
}

/** Share of the smaller rect that lies inside the larger one. */
export function containment(a: NormBounds, b: NormBounds): number {
  const inter = intersectionArea(a, b)
  if (inter <= 0) return 0
  const smaller = Math.min(areaOf(a), areaOf(b))
  return smaller <= 0 ? 0 : inter / smaller
}

/** Thresholds for {@link regionsAreDuplicates}. Exposed so callers can tune one axis. */
export interface RegionDuplicateOptions {
  /** Below this horizontal IoU, two crops are never duplicates, whatever their Y overlap. */
  minHorizontalIoU?: number
  /** 2D IoU at or above which two crops are the same region outright. */
  iou2d?: number
  /** Containment at or above which the smaller crop is a re-measurement of the larger. */
  containment?: number
  /** …but only when it is at least this share of the larger crop's area (`CB-07`). */
  minAreaRatio?: number
  /** Vertical overlap required before containment is even considered. */
  minVerticalIoU?: number
}

const DEFAULT_REGION_DUPLICATE: Required<RegionDuplicateOptions> = {
  minHorizontalIoU: 0.34,
  iou2d: 0.72,
  containment: 0.9,
  minAreaRatio: 0.5,
  minVerticalIoU: 0.5
}

/**
 * Whether two crops describe the SAME visual region.
 *
 * Evidence: horizontal IoU, vertical IoU, 2D IoU, containment and relative area. The
 * governing rule is a VETO rather than a sum — below `minHorizontalIoU` the two
 * occupy different columns and are different sections however completely their Y
 * bands coincide. That veto is the fix for the defect where
 *
 *     A: x 0.0 → 1.0,  y 0.40 → 0.55
 *     B: x 0.0 → 0.4,  y 0.40 → 0.55   (h-IoU 0.4)
 *
 * collapsed into one crop. A genuinely nested pair (B wholly inside A at a
 * comparable size) still resolves, because that is one section measured twice; a
 * much smaller nested crop is a distinct inset and survives (`CB-07`, `IX-04`).
 */
export function regionsAreDuplicates(
  a: NormBounds,
  b: NormBounds,
  opts: RegionDuplicateOptions = {}
): boolean {
  const o = { ...DEFAULT_REGION_DUPLICATE, ...opts }
  if (horizontalIoU(a, b) < o.minHorizontalIoU) return false
  if (rectIoU(a, b) >= o.iou2d) return true

  const areaA = areaOf(a)
  const areaB = areaOf(b)
  const areaRatio = Math.min(areaA, areaB) / Math.max(1e-12, Math.max(areaA, areaB))
  return (
    containment(a, b) >= o.containment &&
    verticalIoU(a, b) >= o.minVerticalIoU &&
    areaRatio >= o.minAreaRatio
  )
}

/**
 * Drop crops that describe a region another crop already describes.
 *
 * The survivor is the higher-scoring one (detector confidence, when the caller has
 * it); ties keep the earlier entry, so the result is order-stable.
 */
export function dedupeEntriesByRegion(
  entries: CropEntry[],
  opts?: RegionDuplicateOptions,
  scoreOf?: (e: CropEntry) => number
): { kept: CropEntry[]; dropped: CropEntry[] } {
  const list = Array.isArray(entries) ? entries : []
  const score = (e: CropEntry) => {
    const value = scoreOf ? scoreOf(e) : 0
    return Number.isFinite(value) ? value : 0
  }
  const bounds = list.map(boundsOf)
  const isDropped = new Array<boolean>(list.length).fill(false)

  for (let i = 0; i < list.length; i++) {
    if (isDropped[i]) continue
    for (let j = i + 1; j < list.length; j++) {
      if (isDropped[j]) continue
      if (!regionsAreDuplicates(bounds[i], bounds[j], opts)) continue
      if (score(list[j]) > score(list[i])) {
        isDropped[i] = true
        break
      }
      isDropped[j] = true
    }
  }

  const kept: CropEntry[] = []
  const dropped: CropEntry[] = []
  list.forEach((entry, index) => (isDropped[index] ? dropped : kept).push(entry))
  return { kept, dropped }
}

/**
 * Drop near-duplicate bands. Detection runs over overlapping page windows, so the
 * same section is genuinely emitted twice at every window seam; the survivor is
 * the higher-scoring one (model confidence, when the caller has it).
 *
 * Entries with no vertical overlap at all are never duplicates, whatever the
 * threshold — that also keeps a caller-supplied threshold of 0 from collapsing an
 * entire page into one crop.
 */
export function dedupeEntries(
  entries: CropEntry[],
  iouThreshold: number,
  scoreOf?: (e: CropEntry) => number
): { kept: CropEntry[]; dropped: CropEntry[] } {
  const list = Array.isArray(entries) ? entries : []
  const threshold = Number.isFinite(iouThreshold) ? iouThreshold : 1
  const score = (e: CropEntry) => {
    const value = scoreOf ? scoreOf(e) : 0
    return Number.isFinite(value) ? value : 0
  }
  const bounds = list.map(boundsOf)
  const isDropped = new Array<boolean>(list.length).fill(false)

  for (let i = 0; i < list.length; i++) {
    if (isDropped[i]) continue
    for (let j = i + 1; j < list.length; j++) {
      if (isDropped[j]) continue
      const iou = verticalIoU(bounds[i], bounds[j])
      if (iou <= 0 || iou < threshold) continue
      // Ties keep the earlier entry, so the result is order-stable.
      if (score(list[j]) > score(list[i])) {
        isDropped[i] = true
        break
      }
      isDropped[j] = true
    }
  }

  const kept: CropEntry[] = []
  const dropped: CropEntry[] = []
  list.forEach((entry, index) => (isDropped[index] ? dropped : kept).push(entry))
  return { kept, dropped }
}

// ============ Validation ============

/**
 * Structural + semantic validation of already-parsed JSON. Errors mean the file
 * cannot be applied; warnings mean it can, but it violates a convention that
 * usually indicates a detection mistake (`OUT-13` above all).
 *
 * `file` is the input cast to FourPointCropFile only when there are zero errors —
 * the cast is what the rest of the module relies on for its types.
 */
export function validateCropFile(value: unknown): ValidationReport & { file: FourPointCropFile | null } {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  if (!isPlainObject(value)) {
    errors.push(asError('not_an_object', '', `Crop file must be a JSON object (got ${describe(value)})`))
    return { valid: false, errors, warnings, file: null }
  }
  const root = value

  if (root.format !== FOUR_POINT_FORMAT) {
    errors.push(asError('bad_format', '§14.2', `format must be "${FOUR_POINT_FORMAT}" (got ${describe(root.format)})`))
  }
  if (!isNonEmptyString(root.version)) {
    errors.push(asError('missing_version', '§14.2', `version must be a non-empty string (got ${describe(root.version)})`))
  }
  if (root.coordinateSystem !== COORDINATE_SYSTEM) {
    errors.push(asError(
      'bad_coordinate_system',
      'OUT-01',
      `coordinateSystem must be "${COORDINATE_SYSTEM}" (got ${describe(root.coordinateSystem)})`
    ))
  }

  // `OUT-14`: the dimensions must be those of the page actually measured — the
  // ratios are meaningless without them, and the apply stage divides by them.
  if (!isPlainObject(root.image)) {
    errors.push(asError('missing_image', 'OUT-14', `image must be an object with filename, width and height (got ${describe(root.image)})`))
  } else {
    const image = root.image
    if (!isNonEmptyString(image.filename)) {
      errors.push(asError('bad_image_filename', 'OUT-14', `image.filename must be a non-empty string (got ${describe(image.filename)})`))
    }
    if (!isPositiveFinite(image.width) || !isPositiveFinite(image.height)) {
      errors.push(asError(
        'bad_image_dimensions',
        'OUT-14',
        `image.width and image.height must be finite numbers > 0 (got ${describe(image.width)} × ${describe(image.height)})`
      ))
    }
  }

  if (!Array.isArray(root.crops)) {
    errors.push(asError('crops_not_array', '§14.2', `crops must be an array — an empty array is the valid "nothing qualified" file (OUT-16) (got ${describe(root.crops)})`))
    return { valid: false, errors, warnings, file: null }
  }

  const seenIds = new Set<string>()
  // Convention warnings run only over crops whose geometry parsed. Warning about
  // ordering or width on coordinates we already rejected is noise on top of a
  // hard error.
  const sound: Array<{ id: string; bounds: NormBounds }> = []

  root.crops.forEach((rawCrop, index) => {
    const label = `crops[${index}]`
    if (!isPlainObject(rawCrop)) {
      errors.push(asError('crop_not_an_object', '§14.4', `${label} must be an object (got ${describe(rawCrop)})`))
      return
    }

    const id = isNonEmptyString(rawCrop.id) ? rawCrop.id : null
    if (!id) {
      errors.push(asError('missing_crop_id', '§14.4', `${label}.id must be a non-empty string (got ${describe(rawCrop.id)})`))
    } else if (seenIds.has(id)) {
      errors.push(asError('duplicate_crop_id', 'OUT-08', `Duplicate crop id "${id}" — ids must be unique and contiguous`, id))
    } else {
      seenIds.add(id)
    }

    const hasReason = isNonEmptyString(rawCrop.reason)
    if (!hasReason) {
      errors.push(asError('missing_crop_reason', '§14.4', `${label}.reason must be a non-empty string (got ${describe(rawCrop.reason)})`, id ?? undefined))
    }

    if (!isPlainObject(rawCrop.crop)) {
      errors.push(asError('missing_crop_geometry', '§14.4', `${label}.crop must be an object with mode and points (got ${describe(rawCrop.crop)})`, id ?? undefined))
      return
    }
    const geometry = rawCrop.crop

    if (geometry.mode !== CROP_MODE) {
      errors.push(asError(
        'bad_crop_mode',
        'OUT-06',
        `${label}.crop.mode must be "${CROP_MODE}" — AN-02 allows no diagonal or irregular geometry (got ${describe(geometry.mode)})`,
        id ?? undefined
      ))
    }

    if (!Array.isArray(geometry.points) || geometry.points.length !== POINT_IDS.length) {
      const got = Array.isArray(geometry.points) ? `${geometry.points.length}` : describe(geometry.points)
      errors.push(asError(
        'points_not_four',
        '§15-H',
        `${label}.crop.points must be an array of exactly ${POINT_IDS.length} points (got ${got})`,
        id ?? undefined
      ))
      return
    }
    const points = geometry.points

    if (!points.every((point, i) => isPlainObject(point) && point.id === POINT_IDS[i])) {
      errors.push(asError(
        'point_ids_out_of_order',
        '§14.5',
        `${label} point ids must be exactly ${POINT_IDS.join(' → ')} in that order`,
        id ?? undefined
      ))
    }

    let coordsUsable = true
    points.forEach((point, i) => {
      const pointId = POINT_IDS[i]
      const source = isPlainObject(point) ? point : {}
      for (const axis of ['x', 'y'] as const) {
        // `OUT-02` governs x, `OUT-03` governs y.
        const rule = axis === 'x' ? 'OUT-02' : 'OUT-03'
        const coord = source[axis]
        if (typeof coord !== 'number' || !Number.isFinite(coord)) {
          coordsUsable = false
          errors.push(asError(
            'coordinate_not_finite',
            rule,
            `${label} ${pointId}.${axis} must be a finite number (got ${describe(coord)})`,
            id ?? undefined
          ))
          continue
        }
        if (coord < 0 || coord > 1) {
          coordsUsable = false
          // A value above 1 is almost always a raw pixel — the single most common
          // way a model breaks OUT-04, so say so instead of just "out of range".
          const hint = coord > 1
            ? ' — this looks like a pixel coordinate, which OUT-04 forbids; divide by the image width/height'
            : ''
          errors.push(asError(
            'coordinate_out_of_range',
            rule,
            `${label} ${pointId}.${axis} = ${coord} is outside 0..1 inclusive${hint}`,
            id ?? undefined
          ))
        }
      }
    })
    if (!coordsUsable) return

    const quad = points as CropPoint[]
    // §13.1 is checked with EXACT equality on purpose. normalizeCropFile is the
    // one place allowed to forgive near-misses; if validation forgave them too,
    // a file could be "valid" while the applied cut differs from the file.
    if (
      quad[0].x !== quad[3].x ||
      quad[1].x !== quad[2].x ||
      quad[0].y !== quad[1].y ||
      quad[2].y !== quad[3].y
    ) {
      errors.push(asError(
        'points_not_rectangular',
        '§13.1',
        `${label} is not an axis-aligned rectangle: §13.1 requires P1.x == P4.x, P2.x == P3.x, P1.y == P2.y and P3.y == P4.y`,
        id ?? undefined
      ))
      return
    }

    const bounds = boundsOf({ id: id ?? '', reason: '', crop: { mode: CROP_MODE, points: quad } })
    if (bounds.left >= bounds.right || bounds.top >= bounds.bottom) {
      errors.push(asError(
        'degenerate_area',
        '§15-H',
        `${label} has zero or negative area (x ${bounds.left} → ${bounds.right}, y ${bounds.top} → ${bounds.bottom})`,
        id ?? undefined
      ))
      return
    }

    if (id) sound.push({ id, bounds })
  })

  // ---- Conventions: never fatal, but each one flags a likely detection fault ----

  for (let i = 1; i < sound.length; i++) {
    if (sound[i].bounds.top < sound[i - 1].bounds.top) {
      warnings.push(asWarning(
        'crops_not_sorted',
        'OUT-07',
        `Crops are not in top-to-bottom page order: "${sound[i].id}" starts above "${sound[i - 1].id}"`,
        sound[i].id
      ))
      break
    }
  }

  if (root.crops.length > 0) {
    const idsInOrder = root.crops.map(crop => (isPlainObject(crop) && isNonEmptyString(crop.id) ? crop.id : null))
    if (!idsInOrder.every((id, i) => id === cropIdFor(i))) {
      warnings.push(asWarning(
        'ids_not_contiguous',
        'OUT-08',
        `Crop ids are not the contiguous page-order sequence ${cropIdFor(0)}, ${cropIdFor(1)}, … (got ${describe(idsInOrder)})`
      ))
    }
  }

  root.crops.forEach(crop => {
    if (!isPlainObject(crop) || !isNonEmptyString(crop.reason)) return
    if (toSnakeCaseReason(crop.reason) !== crop.reason) {
      warnings.push(asWarning(
        'reason_not_snake_case',
        'OUT-09',
        `reason "${crop.reason}" is not lowercase snake_case (expected "${toSnakeCaseReason(crop.reason)}")`,
        isNonEmptyString(crop.id) ? crop.id : undefined
      ))
    }
  })

  // `OUT-13`: a real page mixes full-width and inset crops. One shared x pair
  // across every crop is the signature of the `IX-01` failure — a single
  // horizontal inset guessed once and copied down the page.
  if (sound.length >= 2) {
    const first = sound[0].bounds
    if (sound.every(s => s.bounds.left === first.left && s.bounds.right === first.right)) {
      warnings.push(asWarning(
        'identical_x_across_crops',
        'OUT-13',
        `Every crop shares the same horizontal span (${first.left} → ${first.right}) — probable IX-01 failure (edges copied between crops); re-inspect before applying`
      ))
    }
  }

  for (const s of sound) {
    const area = (s.bounds.right - s.bounds.left) * (s.bounds.bottom - s.bounds.top)
    if (area < MIN_SANE_AREA) {
      warnings.push(asWarning(
        'crop_area_tiny',
        '§15-H',
        `"${s.id}" covers only ${(area * 100).toFixed(4)}% of the page — check for a mis-measured edge`,
        s.id
      ))
    }
  }

  const valid = errors.length === 0
  return { valid, errors, warnings, file: valid ? (value as unknown as FourPointCropFile) : null }
}

// ============ Normalization / repair ============

interface NormalizeOptions {
  minNormHeight?: number
  minNormWidth?: number
  snapTolerance?: number
}

/**
 * Mean of the emitted values clustered within `tolerance` of `edge`. Two points
 * describe every edge (P1/P4 for left, P1/P2 for top, …) and models routinely
 * disagree in the 4th decimal about them; averaging the cluster keeps the
 * measurement instead of arbitrarily preferring one of the two points.
 *
 * The mean is taken over values the file ACTUALLY CONTAINS, which is what makes
 * this safe: `IX-04` and the §14.9 note are explicit that a container stopping
 * just short of the page edge (x = 0.991453) keeps its own value. 0.0 and 1.0 are
 * never snap targets here — nothing may be pulled to a page edge it did not
 * already reach.
 */
function clusterMean(values: number[], edge: number, tolerance: number): number {
  const cluster = values.filter(v => Math.abs(v - edge) <= tolerance)
  if (cluster.length < 2) return edge
  return cluster.reduce((sum, v) => sum + v, 0) / cluster.length
}

function snapEdges(entry: CropEntry, bounds: NormBounds, tolerance: number): NormBounds {
  const points = Array.isArray(entry?.crop?.points) ? entry.crop.points : []
  const xs = points.map(p => Number((p as CropPoint | undefined)?.x)).filter(v => Number.isFinite(v))
  const ys = points.map(p => Number((p as CropPoint | undefined)?.y)).filter(v => Number.isFinite(v))
  const out: NormBounds = { ...bounds }
  // Skip an axis whose whole span is within the tolerance: there the two edge
  // clusters would merge and collapse the crop. Step 4 drops such slivers.
  if (bounds.right - bounds.left > tolerance) {
    out.left = clusterMean(xs, bounds.left, tolerance)
    out.right = clusterMean(xs, bounds.right, tolerance)
  }
  if (bounds.bottom - bounds.top > tolerance) {
    out.top = clusterMean(ys, bounds.top, tolerance)
    out.bottom = clusterMean(ys, bounds.bottom, tolerance)
  }
  return out
}

/**
 * Deterministically rewrite a file into canonical form, returning a NEW object
 * plus one warning-severity issue per repair actually performed. The repair list
 * is user-facing: it is how the UI explains why the file on disk differs from
 * what the model returned, so it must not report work that did not happen.
 *
 * Ordering matters. Edges are settled (snap → clamp → swap) before slivers are
 * dropped, because a crop can only be judged degenerate once its edges are final;
 * ids are assigned last, after sorting, because `OUT-08` numbers page order.
 */
export function normalizeCropFile(
  file: FourPointCropFile,
  opts: NormalizeOptions = {}
): { file: FourPointCropFile; repairs: ValidationIssue[] } {
  const minNormHeight = numOr(opts.minNormHeight, DEFAULT_MIN_NORM_HEIGHT)
  const minNormWidth = numOr(opts.minNormWidth, DEFAULT_MIN_NORM_WIDTH)
  const snapTolerance = Math.max(0, numOr(opts.snapTolerance, DEFAULT_SNAP_TOLERANCE))
  const repairs: ValidationIssue[] = []

  interface Draft {
    originalId: string
    originalIndex: number
    reason: string
    bounds: NormBounds
  }
  const drafts: Draft[] = []
  const source = Array.isArray(file?.crops) ? file.crops : []

  source.forEach((entry, index) => {
    const originalId = isNonEmptyString(entry?.id) ? entry.id : cropIdFor(index)
    const reason = typeof entry?.reason === 'string' ? entry.reason : ''

    // 1. Bounds from whatever points exist — wrong order and wrong ids tolerated.
    const raw = boundsOf(entry)

    // 2. Snap near-equal edges to their mean.
    const snapped = snapEdges(entry, raw, snapTolerance)
    const snappedEdges = (['left', 'right', 'top', 'bottom'] as const).filter(k => snapped[k] !== raw[k])
    if (snappedEdges.length > 0) {
      repairs.push(asWarning(
        'edges_snapped',
        '§13.1',
        `"${originalId}": ${snappedEdges.join(', ')} snapped to the mean of near-equal points (tolerance ${snapTolerance})`,
        originalId
      ))
    }

    // 3. Clamp into 0..1, then un-invert.
    const clamped: NormBounds = {
      left: clamp01(snapped.left),
      right: clamp01(snapped.right),
      top: clamp01(snapped.top),
      bottom: clamp01(snapped.bottom)
    }
    if ((['left', 'right', 'top', 'bottom'] as const).some(k => clamped[k] !== snapped[k])) {
      repairs.push(asWarning(
        'coordinates_clamped',
        'OUT-02',
        `"${originalId}": coordinates outside 0..1 were clamped (OUT-02 / OUT-03)`,
        originalId
      ))
    }
    let { left, right, top, bottom } = clamped
    if (left > right) {
      [left, right] = [right, left]
      repairs.push(asWarning('edges_swapped', '§13.1', `"${originalId}": inverted left/right edges swapped`, originalId))
    }
    if (top > bottom) {
      [top, bottom] = [bottom, top]
      repairs.push(asWarning('edges_swapped', '§13.1', `"${originalId}": inverted top/bottom edges swapped`, originalId))
    }

    // 4. Drop degenerate slivers — no meaningful section is this thin.
    const width = right - left
    const height = bottom - top
    if (height < minNormHeight || width < minNormWidth) {
      repairs.push(asWarning(
        'crop_dropped_sliver',
        '§15-H',
        `"${originalId}" dropped: ${width.toFixed(6)} × ${height.toFixed(6)} normalized is below the ${minNormWidth} × ${minNormHeight} floor`,
        originalId
      ))
      return
    }

    drafts.push({ originalId, originalIndex: index, reason, bounds: { left, top, right, bottom } })
  })

  // 5. `OUT-07`: top-to-bottom page order. originalIndex is the final tiebreak so
  // the result is a total order and the function stays deterministic.
  const sorted = drafts.slice().sort((a, b) =>
    a.bounds.top - b.bounds.top ||
    a.bounds.left - b.bounds.left ||
    a.originalIndex - b.originalIndex
  )
  if (sorted.some((draft, i) => draft !== drafts[i])) {
    repairs.push(asWarning('crops_reordered', 'OUT-07', 'Crops were re-sorted into top-to-bottom page order'))
  }

  const crops: CropEntry[] = sorted.map((draft, i) => {
    // 6. `OUT-08`: contiguous ids follow the sorted order, so they are assigned
    // here rather than carried over from the input.
    const id = cropIdFor(i)
    if (id !== draft.originalId) {
      repairs.push(asWarning('id_renumbered', 'OUT-08', `"${draft.originalId}" renumbered to "${id}"`, id))
    }
    // 7. `OUT-09`.
    const reason = toSnakeCaseReason(draft.reason)
    if (reason !== draft.reason) {
      repairs.push(asWarning('reason_normalized', 'OUT-09', `"${draft.originalId}": reason normalized to "${reason}"`, id))
    }
    // 8. Canonical winding and `OUT-10` precision.
    const bounds: NormBounds = {
      left: formatRatio(draft.bounds.left),
      top: formatRatio(draft.bounds.top),
      right: formatRatio(draft.bounds.right),
      bottom: formatRatio(draft.bounds.bottom)
    }
    return { id, reason, crop: { mode: CROP_MODE, points: pointsFromBounds(bounds) } }
  })

  // The root is rebuilt from the constants: a hand-edited file may carry anything
  // here, and every repair below is reported rather than applied silently.
  if (file?.format !== FOUR_POINT_FORMAT) {
    repairs.push(asWarning('format_corrected', '§14.2', `format set to "${FOUR_POINT_FORMAT}" (was ${describe(file?.format)})`))
  }
  if (!isNonEmptyString(file?.version)) {
    repairs.push(asWarning('version_defaulted', '§14.2', `version set to "${FOUR_POINT_VERSION}" (was ${describe(file?.version)})`))
  }
  if (file?.coordinateSystem !== COORDINATE_SYSTEM) {
    repairs.push(asWarning('coordinate_system_corrected', 'OUT-01', `coordinateSystem set to "${COORDINATE_SYSTEM}" (was ${describe(file?.coordinateSystem)})`))
  }
  const filenameOk = isNonEmptyString(file?.image?.filename)
  const dimensionsOk = isPositiveFinite(file?.image?.width) && isPositiveFinite(file?.image?.height)
  if (!filenameOk || !dimensionsOk) {
    // OUT-14 cannot be repaired from the file alone — the caller must re-measure
    // the page. Placeholders keep the artifact well-formed and the loss visible.
    repairs.push(asWarning('image_metadata_missing', 'OUT-14', 'image filename/width/height were missing or invalid and need re-measuring'))
  }

  return {
    file: {
      format: FOUR_POINT_FORMAT,
      version: isNonEmptyString(file?.version) ? file.version : FOUR_POINT_VERSION,
      image: {
        filename: filenameOk ? file.image.filename : '',
        width: isPositiveFinite(file?.image?.width) ? file.image.width : 0,
        height: isPositiveFinite(file?.image?.height) ? file.image.height : 0
      },
      coordinateSystem: COORDINATE_SYSTEM,
      crops
    },
    repairs
  }
}

// ============ Parse / serialize ============

/** Read a crop file's text. A syntax error is reported, never thrown. */
export function parseCropFile(text: string): { file: FourPointCropFile | null; report: ValidationReport } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      file: null,
      report: {
        valid: false,
        errors: [asError('invalid_json', '', `Crop file is not valid JSON: ${detail}`)],
        warnings: []
      }
    }
  }
  const { file, valid, errors, warnings } = validateCropFile(parsed)
  return { file, report: { valid, errors, warnings } }
}

function quote(value: unknown): string {
  return JSON.stringify(String(value ?? ''))
}

/** Pixel dimensions render as plain numbers; `OUT-11` applies to ratios only. */
function renderInt(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) ? String(n) : '0'
}

/**
 * `OUT-11` is why this exists: an exact bound must read as "0.0"/"1.0", never as
 * bare "0"/"1", which is exactly what JSON.stringify emits. Non-integers render
 * at their `OUT-10` value with trailing zeros stripped — via toFixed, so a very
 * small ratio can never come out in JS exponential notation.
 */
function renderRatio(value: number): string {
  const n = formatRatio(value)
  if (Number.isInteger(n)) return n.toFixed(1)
  return n.toFixed(RATIO_PRECISION).replace(/0+$/, '')
}

/**
 * Hand-rolled writer for §14.7's canonical shape. JSON.stringify cannot produce
 * it: `OUT-11` needs "0.0"/"1.0" and `OUT-15` fixes the key order and the
 * expanded point form. The file is user-editable, so a stable byte-for-byte
 * layout also keeps its diffs readable.
 */
export function serializeCropFile(file: FourPointCropFile): string {
  const lines: string[] = ['{']
  lines.push(`  "format": ${quote(file?.format ?? FOUR_POINT_FORMAT)},`)
  lines.push(`  "version": ${quote(isNonEmptyString(file?.version) ? file.version : FOUR_POINT_VERSION)},`)
  lines.push('  "image": {')
  lines.push(`    "filename": ${quote(file?.image?.filename ?? '')},`)
  lines.push(`    "width": ${renderInt(file?.image?.width)},`)
  lines.push(`    "height": ${renderInt(file?.image?.height)}`)
  lines.push('  },')
  lines.push(`  "coordinateSystem": ${quote(file?.coordinateSystem ?? COORDINATE_SYSTEM)},`)

  const crops = Array.isArray(file?.crops) ? file.crops : []
  if (crops.length === 0) {
    // `OUT-16`: the empty array is the meaningful "nothing qualified" result.
    lines.push('  "crops": []')
  } else {
    lines.push('  "crops": [')
    crops.forEach((entry, cropIndex) => {
      const cropComma = cropIndex === crops.length - 1 ? '' : ','
      lines.push('    {')
      lines.push(`      "id": ${quote(entry?.id ?? cropIdFor(cropIndex))},`)
      lines.push(`      "reason": ${quote(entry?.reason ?? FALLBACK_REASON)},`)
      lines.push('      "crop": {')
      lines.push(`        "mode": ${quote(entry?.crop?.mode ?? CROP_MODE)},`)
      const points = Array.isArray(entry?.crop?.points) ? entry.crop.points : []
      if (points.length === 0) {
        lines.push('        "points": []')
      } else {
        lines.push('        "points": [')
        points.forEach((point, pointIndex) => {
          const pointComma = pointIndex === points.length - 1 ? '' : ','
          const fallbackId: PointId | '' = POINT_IDS[pointIndex] ?? ''
          lines.push('          {')
          lines.push(`            "id": ${quote(point?.id ?? fallbackId)},`)
          lines.push(`            "x": ${renderRatio(Number(point?.x))},`)
          lines.push(`            "y": ${renderRatio(Number(point?.y))}`)
          lines.push(`          }${pointComma}`)
        })
        lines.push('        ]')
      }
      lines.push('      }')
      lines.push(`    }${cropComma}`)
    })
    lines.push('  ]')
  }

  lines.push('}')
  return `${lines.join('\n')}\n`
}
