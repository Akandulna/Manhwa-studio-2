/**
 * Image Clipper 2.0 — the `four-point-crop` contract.
 *
 * Module 3 v1 asks a model for crop *rectangles* and stores them straight into
 * the database. Clipper 2.0 uses a different technique: a vision model reads the
 * written Crop Detection Guidelines and emits **four crop pointers** (P1..P4) per
 * section into a JSON file on disk; a second, entirely deterministic stage reads
 * that file and cuts the images. The JSON file is the contract between the two
 * stages, and it is a user-visible, hand-editable artifact.
 *
 * This file is the single source of truth for that artifact's shape. Everything
 * in server/src/services/clipper2/ and the /api/clipper2 routes derives from it.
 * Rule IDs in comments (`OUT-07`, `IX-01`, …) cite the guidelines document at
 * server/ml/CROP_POINT_GUIDELINES.md.
 */

// ============ Format identity ============

export const FOUR_POINT_FORMAT = 'four-point-crop' as const
/** JSON format version — independent of the guidelines document version. */
export const FOUR_POINT_VERSION = '1.0' as const
export const COORDINATE_SYSTEM = 'normalized' as const
export const CROP_MODE = 'rectangle' as const

/** Max decimal places emitted for a normalized ratio (`OUT-10`). */
export const RATIO_PRECISION = 9

/** Point order is fixed: top-left, top-right, bottom-right, bottom-left (§14.5). */
export const POINT_IDS = ['P1', 'P2', 'P3', 'P4'] as const
export type PointId = (typeof POINT_IDS)[number]

// ============ The artifact ============

export interface CropPoint {
  id: PointId
  /** Normalized 0..1 across the logical page width (`OUT-01`, `OUT-02`). */
  x: number
  /** Normalized 0..1 down the logical page height (`OUT-01`, `OUT-03`). */
  y: number
}

export interface CropGeometry {
  /** Always "rectangle" — never diagonal or irregular (`AN-02`, `OUT-06`). */
  mode: typeof CROP_MODE
  /** Exactly four points, in P1 → P2 → P3 → P4 order. */
  points: CropPoint[]
}

export interface CropEntry {
  /** `crop-NN`, zero-padded, sequential, contiguous, page order (`OUT-08`). */
  id: string
  /** Lowercase snake_case description of the section (`OUT-09`). */
  reason: string
  crop: CropGeometry
}

/**
 * The measured logical page. For a single-image page this is that image; for a
 * stitched chapter it is the combined top-to-bottom canvas (`ST-09`), and
 * `filename` carries a `[stitched:N]` label instead of a real file name.
 */
export interface CropImageInfo {
  filename: string
  width: number
  height: number
}

/** The complete on-disk artifact. Serialized exactly as §14.7 (`OUT-15`). */
export interface FourPointCropFile {
  format: typeof FOUR_POINT_FORMAT
  version: string
  image: CropImageInfo
  coordinateSystem: typeof COORDINATE_SYSTEM
  crops: CropEntry[]
}

// ============ Sidecar (non-canonical) ============

/**
 * Written next to the canonical JSON as `crop_points.meta.json`. Deliberately
 * NOT part of `FourPointCropFile`: §14 fixes that shape, so provenance and the
 * stitched-segment map live outside it. The apply stage can rebuild the segment
 * list from the chapter folder, so this file is informational — it makes the
 * artifact self-describing and lets the UI explain what was measured.
 */
export interface CropPointsSidecar {
  /**
   * How the pointers were produced. `cv` is the offline classical detector —
   * neither a vision model nor a person, and worth telling apart from both: it
   * measures geometry rather than reading the page, so its reasons describe
   * shape rather than content and it reports no per-crop confidence.
   */
  source: 'ai' | 'manual' | 'cv'
  /** Vision model id when source === 'ai', engine id when source === 'cv'. */
  model: string | null
  /** sha256 of the guidelines text the detection ran against. */
  guidelinesSha: string | null
  detectedAt: string
  /** The stitched segments, in top-to-bottom order (`ST-10`). */
  segments: CropPointsSegment[]
  /** Non-fatal findings from detection/validation, surfaced in the UI. */
  warnings: ValidationIssue[]
}

export interface CropPointsSegment {
  filename: string
  width: number
  height: number
  /** Y offset of this segment's top within the combined logical page. */
  canvasY: number
}

// ============ Geometry helpers (shared vocabulary) ============

/** Normalized edges of one crop entry. */
export interface NormBounds {
  left: number
  top: number
  right: number
  bottom: number
}

/** Canvas-space (source pixel) rect — matches clipperService.CropRect. */
export interface CanvasRect {
  canvasX: number
  canvasY: number
  canvasW: number
  canvasH: number
}

// ============ Validation ============

export type IssueSeverity = 'error' | 'warning'

export interface ValidationIssue {
  /** Stable machine code, e.g. `points_not_rectangular`, `ids_not_contiguous`. */
  code: string
  /** The guidelines rule this enforces, e.g. `OUT-08`. Empty for structural JSON errors. */
  rule: string
  message: string
  /** Which crop it applies to, when the issue is crop-scoped. */
  cropId?: string
  severity: IssueSeverity
}

export interface ValidationReport {
  /** True when there are no `error`-severity issues. */
  valid: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

// ============ Detector intermediate representation ============

/**
 * What the vision model returns, before the system composes the canonical file.
 *
 * The model is shown discrete page images, so it points at crops in *page-local*
 * normalized coordinates: P1/P2's y are fractions down `startPage`, P3/P4's y are
 * fractions down `endPage`, and x is a fraction across the page width. A crop
 * whose `startPage !== endPage` spans a stitch boundary, which is expected and
 * valid (`ST-04`, `ST-05`).
 *
 * The system then converts these to the combined logical page (`ST-09`) — that
 * conversion is what makes the emitted file's coordinates canonical.
 */
export interface DetectedPointerCrop {
  reason: string
  /** 1-based page index within the chapter, as labeled in the prompt. */
  startPage: number
  endPage: number
  /** Page-local normalized points, P1..P4. */
  points: CropPoint[]
  /** Model's own 0..1 confidence that this crop is guideline-compliant. */
  confidence?: number
  /** Free-form model note (e.g. which edge was inferred behind an overlay). */
  notes?: string
}

/** One detection run's result. */
export interface DetectionResult {
  file: FourPointCropFile
  sidecar: CropPointsSidecar
  /** Per-crop confidence, keyed by crop id — kept out of the canonical file. */
  confidenceById: Record<string, number>
  warnings: ValidationIssue[]
}

// ============ Apply ============

export interface AppliedCropFile {
  cropId: string
  filename: string
  path: string
  width: number
  height: number
  bytes: number
}

export interface ApplyResult {
  exportDir: string
  exported: number
  failed: number
  files: AppliedCropFile[]
  /** Whether the crops were also written into the chapter's CropSession. */
  registered: boolean
  sessionId: string | null
  warnings: string[]
}
