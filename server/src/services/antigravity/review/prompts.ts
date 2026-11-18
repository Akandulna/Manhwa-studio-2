/**
 * The geometry-only Classic prompts, rendered from templates.ts:
 *
 * 1. Analysis: HandoffFormat.withRules(GeometryWorkflow.prompt(handoff), cropRules, null) — ClipperPage.prompt().
 * 2. Review (same conversation): CropReview.geometryReviewPrompt(state, items, audit, handoff, fresh = false,
 *    annotatedImages = false) — ClipperPage.fixPrompt(), which the phone sends WITHOUT crop rules.
 * 3. Correction after a refused reply: CropReview.correctionPrompt(errors) — also ClipperPage.fixPrompt().
 */
import { ANALYSIS_SCHEMA, REVIEW_ROTATE_RULE, ROTATE_RULE, SLICE_COORDINATES, stripMarkdownFence } from './analysisImport.js'
import { isBlank, ktTrim, stringify, type WritableJson } from './json.js'
import { currentCrops, GEOMETRY_REVIEW_SCHEMA, sweepLines } from './reviewState.js'
import {
  CONTINUITY_RULES, DEFAULT_ANALYSIS_TEMPLATE, DEFAULT_CROP_RULES, DEFAULT_REVIEW_TEMPLATE, renderTemplate,
  REVIEW_IMAGES_SLICES, REVIEW_IMAGES_WHOLE_PAGE, REVIEW_MEASURING_SLICES, REVIEW_RULES, WHOLE_PAGE_COORDINATES,
} from './templates.js'
import type { AuditReport, Handoff, ImportIssue, ReviewItem, ReviewState } from './types.js'

export { stripMarkdownFence }

/**
 * HandoffFormat.withRules: the crop rules (and description rules) ahead of [prompt], so one message carries
 * everything. Blank or missing rules are left out.
 */
export function withRules(prompt: string, cropRules: string | null | undefined, descriptionRules: string | null | undefined): string {
  const parts: string[] = []
  if (cropRules != null && !isBlank(cropRules)) {
    parts.push(
      'CROP RULES — use these to decide WHAT to crop and where each edge goes.',
      'Ignore any output format, file naming or normalized-coordinate instructions inside them:',
      'the JSON contract further down always wins.',
      '',
      '=== BEGIN CROP RULES ===',
      ktTrim(cropRules),
      '=== END CROP RULES ===',
      '',
    )
  }
  if (descriptionRules != null && !isBlank(descriptionRules)) {
    parts.push(
      'DESCRIPTION RULES — use these to write each crop\'s "description".',
      'Ignore what they say about when to begin, export context, ids, file names and output shape:',
      'descriptions go inside the JSON further down, and the app writes the metadata file itself.',
      '',
      '=== BEGIN DESCRIPTION RULES ===',
      ktTrim(descriptionRules),
      '=== END DESCRIPTION RULES ===',
      '',
    )
  }
  return [...parts, prompt].join('\n')
}

export interface AnalysisPromptInput {
  /** Defaults to DEFAULT_ANALYSIS_TEMPLATE. */
  template?: string
  /** The "Crop Rules" text. undefined = DEFAULT_CROP_RULES (the phone's fixed prompt); null or blank = none. */
  cropRules?: string | null
  /** Overrides the {{CONTINUITY_RULES}} block; defaults to CONTINUITY_RULES. */
  continuityRules?: string
  handoff: Handoff
}

/** The Crop Pointer (analysis) prompt: withRules(GeometryWorkflow.prompt(handoff), cropRules, null). */
export function renderAnalysisPrompt(input: AnalysisPromptInput): string {
  const h = input.handoff
  const s = h.source
  const first = h.slices[0]
  if (first === undefined) throw new Error('The handoff has no slices')
  const prompt = renderTemplate(input.template ?? DEFAULT_ANALYSIS_TEMPLATE, {
    CONTINUITY_RULES: input.continuityRules ?? CONTINUITY_RULES,
    SLICE_LINES: h.slices.map((it) => `${it.id}: ${it.width}x${it.height}, original page y=${it.y0}..${it.y1}`).join('\n'),
    ANALYSIS_SCHEMA,
    JOB_ID: h.jobId,
    SOURCE_SHA256: s.sha256,
    PAGE_STEM: s.pageStem,
    SOURCE_WIDTH: s.width,
    SOURCE_HEIGHT: s.height,
    COORDINATE_SYSTEM: SLICE_COORDINATES,
    FIRST_SLICE_ID: first.id,
    FIRST_SLICE_HEIGHT: first.height,
  })
  // Fixed text, not part of the editable template, so every saved prompt pack gets it.
  return withRules(`${prompt}\n${ROTATE_RULE}`, input.cropRules === undefined ? DEFAULT_CROP_RULES : input.cropRules, null)
}

/** HandoffFormat.wholePageCoordinates (the handoff must have exactly one slice, as Kotlin's single()). */
export function wholePageCoordinates(handoff: Handoff): string {
  if (handoff.slices.length !== 1) throw new Error('A whole-page handoff has exactly one slice')
  return renderTemplate(WHOLE_PAGE_COORDINATES, {
    SLICE_ID: handoff.slices[0]!.id,
    SOURCE_WIDTH: handoff.source.width,
    SOURCE_HEIGHT: handoff.source.height,
    COORDINATE_SYSTEM: SLICE_COORDINATES,
  })
}

export interface ReviewPromptInput {
  /** Defaults to DEFAULT_REVIEW_TEMPLATE. */
  template?: string
  /**
   * Crop rules to put ahead of the review prompt with withRules. The phone's Classic flow sends the review
   * WITHOUT them (ClipperPage.fixPrompt), so the default (undefined/null/blank) adds none.
   */
  cropRules?: string | null
  continuityRules?: string
  reviewRules?: string
  state: ReviewState
  items: ReviewItem[]
  audit: AuditReport
  handoff: Handoff
}

/** The geometry-only review round for the same conversation (geometryReviewPrompt, fresh = false, annotatedImages = false). */
export function renderReviewPrompt(input: ReviewPromptInput): string {
  const { state, items, audit, handoff } = input
  const slices = handoff.slices
  const source = handoff.source
  if (slices.length === 0) throw new Error('The handoff has no slices')
  const crops = currentCrops(state, items, slices)
  const firstCrop = crops[0]
  const example: WritableJson = {
    schema_version: GEOMETRY_REVIEW_SCHEMA,
    job_id: handoff.jobId,
    source_sha256: source.sha256,
    review_revision: state.revision,
    coordinate_system: 'slice_local_pixels',
    crops: [
      {
        key: firstCrop?.key ?? 'candidate-01',
        reason: firstCrop?.reason ?? 'framed_reaction',
        top_left: firstCrop?.top_left ?? { slice_id: slices[0]!.id, x: 0, y: 0 },
        bottom_right: firstCrop?.bottom_right ?? { slice_id: slices[0]!.id, x: source.width, y: Math.min(500, slices[0]!.height) },
        checks_reviewed: firstCrop?.checks.map((c) => c.token) ?? [],
      },
      {
        key: null,
        from_keys: ['<key of the crop this was split from, or the keys merged into it; omit for a brand-new crop>'],
        reason: 'new_or_split_part',
        top_left: { slice_id: slices[0]!.id, x: 0, y: 0 },
        bottom_right: { slice_id: slices[0]!.id, x: 100, y: 100 },
        checks_reviewed: [],
      },
    ],
    removed_keys: [],
    // "redescribe_keys" is removed on the phone when annotatedImages = false.
    sweep_done: true,
    page_has_no_artwork: false,
    notes: '',
  }
  const size = { SOURCE_WIDTH: source.width, SOURCE_HEIGHT: source.height }
  const images = handoff.wholePage
    ? renderTemplate(REVIEW_IMAGES_WHOLE_PAGE, size)
    : renderTemplate(REVIEW_IMAGES_SLICES, { ...size, SLICE_COUNT: slices.length, SLICE_IDS: slices.map((s) => s.id).join(', ') })
  const body = renderTemplate(input.template ?? DEFAULT_REVIEW_TEMPLATE, {
    PAGE_STEM: source.pageStem,
    IMAGES: images,
    CONTINUITY_RULES: input.continuityRules ?? CONTINUITY_RULES,
    REVIEW_RULES: input.reviewRules ?? REVIEW_RULES,
    SWEEP_LINES: sweepLines(audit, slices).join('\n'),
    MEASURING: handoff.wholePage ? `MEASURING: ${wholePageCoordinates(handoff)}` : REVIEW_MEASURING_SLICES,
    JOB_ID: handoff.jobId,
    SOURCE_SHA256: source.sha256,
    REVIEW_REVISION: state.revision,
    REVIEW_SCHEMA: GEOMETRY_REVIEW_SCHEMA,
    EXAMPLE_JSON: stringify(example, true),
    CURRENT_CROPS_JSON: stringify(crops, true),
  })
  // Fixed text after CURRENT CROPS, not part of the editable template, so every saved prompt pack gets it.
  const prompt = `${body}\n\n${ROTATE_RULE} ${REVIEW_ROTATE_RULE}`
  return input.cropRules != null && !isBlank(input.cropRules) ? withRules(prompt, input.cropRules, null) : prompt
}

/** What the app sends back when the validator refuses a reply (CropReview.correctionPrompt). */
export function correctionPrompt(issues: ImportIssue[], limit = 25): string {
  const lines = issues.slice(0, limit).map((it) => `- ${it.field.length > 0 ? `${it.field}: ` : ''}${it.message}`)
  if (issues.length > limit) lines.push(`- …and ${issues.length - limit} more`)
  return [
    "The app's validator REJECTED that reply. Problems:",
    lines.join('\n'),
    '',
    'Fix every problem and return the COMPLETE corrected JSON object (not a diff), with no prose.',
  ].join('\n')
}

/**
 * ChatGpt.extractJson: what the phone's auto-run does to a ChatGPT reply before validating it — the reply
 * itself when it is one {…} block, else the first fenced block, else the outermost {…} span.
 */
export function extractJson(reply: string): string {
  const text = ktTrim(reply)
  if (text.startsWith('{') && text.endsWith('}')) return text
  const fenced = /```[a-zA-Z0-9_-]*[ \t\n\x0B\f\r]*\n([\s\S]*?)\n?[ \t\n\x0B\f\r]*```/.exec(text)
  if (fenced) return ktTrim(fenced[1]!)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.substring(start, end + 1) : text
}
