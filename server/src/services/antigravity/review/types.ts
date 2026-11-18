/**
 * Types for the AntiGravity crop-pointer review, ported from the Sleeper-Cell phone app
 * (com.sleepercell.browser.clipper: Handoff.kt, AnalysisImport.kt, CropReview.kt, CropAudit.kt).
 * Names mirror the Kotlin so the two sides can be read side by side.
 */

/** A box in page pixels: left/top inclusive, right/bottom exclusive (Kotlin `Box`). */
export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

export function box(x0: number, y0: number, x1: number, y1: number): Box {
  return { x0, y0, x1, y1 }
}

export function boxWidth(b: Box): number {
  return b.x1 - b.x0
}

export function boxHeight(b: Box): number {
  return b.y1 - b.y0
}

/** Kotlin data-class equality for [Box]. */
export function boxEquals(a: Box, b: Box): boolean {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1
}

/**
 * One slice's place on the page (Kotlin `HandoffSlice`). Slices are full width, so [x0] defaults to 0
 * and [x1] to the slice width; only the fields the prompts and validators read are required.
 */
export interface HandoffSlice {
  id: string
  file: string
  width: number
  height: number
  y0: number
  y1: number
  x0?: number
  x1?: number
  sha256?: string
}

/** The page's identity (Kotlin `HandoffSource`), limited to what the review code reads. */
export interface HandoffSource {
  sha256: string
  pageStem: string
  width: number
  height: number
  seriesTitle: string
  chapterFolder: string
  seriesSlug?: string
  chapterNumber?: string
  originalFilename?: string
  format?: string
}

/**
 * The verified package for one page (Kotlin `Handoff`). [wholePage] records one original image whose
 * rectangle is the entire page, with no offsets.
 */
export interface Handoff {
  jobId: string
  wholePage: boolean
  source: HandoffSource
  slices: HandoffSlice[]
}

/** One problem with a pasted reply. Errors refuse it; warnings let it in (Kotlin `ImportIssue`). */
export interface ImportIssue {
  code: string
  field: string
  message: string
  candidateId: string | null
}

/** A crop ChatGPT proposed, converted to integer page pixels. [slices] are the ones it overlaps. */
export interface ImportedCandidate {
  candidateId: string
  reason: string
  bounds: Box
  description: string
  visualEvidence: string
  reviewFlags: string[]
  unknownFlags: string[]
  slices: string[]
  /** Sideways art: the quarter turn that stands the crop upright (90 clockwise, -90 counter-clockwise). Absent = upright. */
  rotate?: Rotation
}

/** The only turns a crop can carry. */
export type Rotation = 90 | -90

export interface ImportedAnalysis {
  jobId: string
  sourceSha256: string
  pageStem: string
  sourceWidth: number
  sourceHeight: number
  replyCoordinateSystem: string
  responseSha256: string
  pageInspectionComplete: boolean
  pageReviewFlags: string[]
  candidates: ImportedCandidate[]
  warnings: ImportIssue[]
}

export interface AnalysisParseResult {
  analysis: ImportedAnalysis | null
  errors: ImportIssue[]
  warnings: ImportIssue[]
}

/**
 * A crop as the review has decided it so far. [key] stays the same across rounds; final crop ids are
 * only given at export. [acknowledged] holds the tokens of checks ChatGPT looked at and accepted.
 */
export interface ReviewCrop {
  key: string
  origin: string
  reason: string
  bounds: Box
  description: string
  /** approved, unreviewed, stale, missing (or inspected on the phone's four-step flow) */
  descriptionStatus: string
  /** unreviewed, kept, adjusted, split, merged or unresolved */
  disposition: string
  visualEvidence: string
  gptFlags: string[]
  unknownFlags: string[]
  acknowledged: string[]
  note: string
  /** Absent = upright. Stored as "rotate" in review-state.json only when set. */
  rotate?: Rotation
}

export interface ReviewPage {
  sweepDone: boolean
  noEligibleArtworkConfirmed: boolean
  note: string
}

/** The working copy between ChatGPT's first answer and the export. Every accepted round bumps [revision]. */
export interface ReviewState {
  jobId: string
  sourceSha256: string
  sourceWidth: number
  sourceHeight: number
  pageStem: string
  revision: number
  createdAt: string
  updatedAt: string
  basedOnResponseSha256: string
  crops: ReviewCrop[]
  page: ReviewPage
  /** How many ChatGPT review rounds were applied. */
  chatgptReviews: number
}

/** One thing on a crop that needs a look: an audit finding or a flag ChatGPT set itself. */
export interface ReviewItem {
  token: string
  key: string
  code: string
  message: string
  acknowledged: boolean
}

/** What still stands between the review and the export. */
export interface Blocker {
  code: string
  message: string
  key: string | null
}

/** [changed] when the round moved, split, merged, added or removed any crop. */
export interface ReviewReplyParse {
  state: ReviewState | null
  errors: ImportIssue[]
  warnings: ImportIssue[]
  changed: boolean
}

/**
 * One audit check on a crop. [otherKey] is the other crop for overlaps; [edge] which side for
 * EDGE_ON_CONTENT. [token] is code, otherKey and edge joined by ":" (Kotlin's computed `token`).
 */
export interface AuditFinding {
  code: string
  key: string
  message: string
  otherKey: string | null
  edge: string | null
  token: string
}

export function auditFinding(code: string, key: string, message: string, otherKey: string | null = null, edge: string | null = null): AuditFinding {
  const token = [code, otherKey, edge].filter((part): part is string => part !== null).join(':')
  return { code, key, message, otherKey, edge, token }
}

/** A stretch of the page no crop touches. [inkShare] is its rows' mean ink share, 0–1, null when pixels weren't checked. */
export interface UncoveredGap {
  y0: number
  y1: number
  inkShare: number | null
}

export interface AuditReport {
  findings: AuditFinding[]
  gaps: UncoveredGap[]
}

/** One page as 8-bit luminance, row-major (Kotlin `LumaPage`). */
export interface LumaPage {
  width: number
  height: number
  data: Uint8Array
}
