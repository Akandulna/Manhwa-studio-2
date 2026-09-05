/**
 * AI Auto-Crop — shared types (Module 3 AI)
 *
 * Types shared between the dataset exporter, the Node↔Python sidecar bridge,
 * and the API routes. The client mirrors the DTO shapes in client/src/lib/api.ts.
 */

// ============ Geometry ============

export interface CanvasRect {
  canvasX: number
  canvasY: number
  canvasW: number
  canvasH: number
}

export interface NormRect {
  normX: number
  normY: number
  normW: number
  normH: number
}

/** A source-file region a crop maps to (mirrors clipperService.SourceFileRegion). */
export interface SampleSourceRegion {
  filename: string
  x: number
  y: number
  width: number
  height: number
}

// ============ Dataset ============

/**
 * One training sample = one finalized user crop.
 * This is the on-disk schema consumed by server/ml/train.py.
 */
export interface CropSample {
  /** Stable id of the source crop (used for dedup / incremental export). */
  cropId: string
  sessionId: string
  chapterId: string
  seriesId: string

  /** Sequence features. */
  sequence: number // 1-based crop index within the chapter
  cropCountInChapter: number
  distanceFromPrev: number | null // canvas px gap from previous crop's bottom (null for first)
  gapToNext: number | null

  /** Label: the aspect preset the user chose. */
  aspectPreset: string

  /** Full virtual-canvas dimensions for this chapter. */
  canvasWidth: number
  canvasHeight: number

  /** The crop rectangle (canvas-space + normalized). */
  rect: CanvasRect
  normRect: NormRect

  /** Canvas→source mapping (which page files this crop spans). */
  sourceFiles: SampleSourceRegion[]

  /** Padding/adjustment habit signal, derived from CropEvent history. */
  adjustment: {
    firstDraftRect: CanvasRect | null
    resizeCount: number
    moveCount: number
    deltaFromFirstDraft: { dx: number; dy: number; dw: number; dh: number } | null
  }

  /** Relative paths (from dataset root) of the downscaled WebP images. */
  images: {
    crop: string
    context: string
  }

  /** Provenance: a directly-drawn crop, or an accepted AI suggestion. */
  source: 'crop' | 'suggestion-accepted'
}

export interface DatasetManifest {
  version: 1
  updatedAt: string
  sampleCount: number
  /** Crop ids already exported (dedup for incremental re-runs). */
  exportedCropIds: string[]
  /** Max crop createdAt exported so far (ISO), used as an incremental cursor. */
  cursor: string | null
}

export interface DatasetExportResult {
  exported: number
  skipped: number
  total: number
  sampleCount: number
  datasetDir: string
}

// ============ Suggestions (sidecar I/O + DTOs) ============

export interface SuggestionRect extends CanvasRect {
  aspectPreset: string
  confidence: number
}

export interface SuggestResult {
  /**
   * "guidelines" (the default Gemini guideline cropper), "trained" (Stage A + B),
   * or "rule-based" (Stage A only, cold start).
   */
  mode: 'guidelines' | 'trained' | 'rule-based'
  modelVersion: number | null
  suggestions: SuggestionRect[]
}

/** Which engine produces crop suggestions. */
export type CropEngine = 'guidelines' | 'trained'

// ============ Status / models ============

export interface AiCropStatus {
  sidecarAvailable: boolean
  sidecarError?: string
  sampleCount: number
  minSamples: number
  canTrain: boolean
  activeModelVersion: number | null
  modelCount: number
  // Phase 1 visual embeddings: whether the local vision backbone is installed.
  // When false, training/inference run without embeddings (rule-based heads only).
  backboneAvailable: boolean
  /** Active crop engine: the default guideline cropper, or a trained model. */
  engine: CropEngine
  /** Whether the Gemini vision LLM (the guideline cropper's backend) is configured. */
  geminiAvailable: boolean
  /** Whether the immutable guidelines file is present. */
  guidelinesPresent: boolean
  /** ISO timestamp the guidelines were last edited (null if never via Settings). */
  guidelinesUpdatedAt: string | null
}
