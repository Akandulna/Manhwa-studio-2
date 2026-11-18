/**
 * The four-step flow, ported from the phone (Sleeper-Cell, branch v2: clipper/ClipperSteps.kt with the
 * geometry-only step 3 of clipper/GeometryWorkflow.kt, and step 4 = CropReview.geometryReviewPrompt with
 * annotatedImages = true, fresh = false). The one long prompt broken into parts answered in the same
 * conversation, each checked before the next is asked, so lighter models have less to hold at once.
 *
 * 1. Find the shots: every independently readable moment, with the slices it's in. No pixels.
 * 2. Place the corners: one rectangle per shot, measured on the slices. Step 1's list is provisional.
 * 3. Inspect: Studio cuts each rectangle out of the page and the model checks the ACTUAL crop images,
 *    a batch at a time (geometry only: no descriptions). Studio then builds the `chatgpt-analysis/1.0`
 *    answer itself from steps 2 and 3, so no corner is ever copied by the model.
 * 4. Review: the slices with every crop drawn on, geometry-only review rounds. Crops it adds or changes go
 *    back to step 3, then to another review.
 *
 * Studio pages are always sliced (never whole-page), so only the sliced wording is ported. Pure.
 */
import { ANALYSIS_SCHEMA, boundsFromSliceCorners, normalizeReason, parseRotation, REVIEW_FLAGS, REVIEW_ROTATE_RULE, ROTATE_RULE, SLICE_COORDINATES, stripMarkdownFence } from './analysisImport.js'
import { describe, JNULL, JsonArray, JsonObject, ktTrim, parseJson, stringify, trimIndent, wholeNumber, type JsonValue, type WritableJson } from './json.js'
import { correctionPrompt } from './prompts.js'
import { currentCrops, GEOMETRY_REVIEW_SCHEMA, sweepLines } from './reviewState.js'
import { CONTINUITY_RULES, REVIEW_RULES } from './templates.js'
import type { AuditReport, Box, Handoff, HandoffSlice, ImportIssue, ReviewItem, ReviewState, Rotation } from './types.js'

export const STEPS_STATE_SCHEMA = 'clipper-steps/1.0'
export const INVENTORY_SCHEMA = 'clipper-inventory/1.0'
export const GEOMETRY_SCHEMA = 'clipper-geometry/1.0'
export const INSPECTION_SCHEMA = 'clipper-crop-inspection/1'

export type StepStage = 'inventory' | 'geometry' | 'describe' | 'review'

/** Crops attached to one step 3 message. */
export const DESCRIBE_BATCH = 8
/** Review rounds before the page is left for a person. */
export const MAX_REVIEW_ROUNDS = 4
/** Messages (turns) for one page in one conversation, all steps together. */
export const MAX_MESSAGES = 20

export const PARTS = ['top', 'middle', 'bottom'] as const

const MAX_TEXT = 1000
/** The prompts' example values: a reply carrying them was copied from the prompt, not read off the page. */
const EXAMPLE_SUBJECTS = 'man on rooftop, wide'
const EXAMPLE_EVIDENCE = 'Distinct framed shot with one main reaction'
/** Said in steps 1, 2 and 4: Studio's crop work is geometry only; metadata is a separate process. */
const GEOMETRY_ONLY = 'GEOMETRY ONLY: write no descriptions, story context, character names or script links. Metadata is made later by a separate process; this chat only finds and measures crops.'
const COPIED = 'That is the example from the prompt, not this page. Open the slice images (read_file on each offloaded path) and use what this page actually shows.'
const MAX_ID = 120
const MAX_ITEMS = 500

export interface SliceSpot { sliceId: string; part: string }
export interface Shot { id: string; subjects: string; from: SliceSpot; to: SliceSpot; notes: string }
export interface StepCorner { slice_id: string; x: number; y: number }
export interface Placed {
  id: string
  shotIds: string[]
  reason: string
  topLeft: StepCorner
  bottomRight: StepCorner
  bounds: Box
  evidence: string
  flags: string[]
  /** Sideways art (see ROTATE_RULE); absent = upright. */
  rotate?: Rotation
}
export interface DroppedShot { shotId: string; why: string }

/**
 * Where a page is in the four-step flow. Until step 3's last batch the crops live here; from then on in the
 * review state, which steps 3 and 4 keep working on. [queue] holds the ids still to inspect: step 2's
 * candidate ids at first, review keys once [redescribe] (crops the review added or changed). [reviewDue]
 * asks for another review round even with nothing open: the last one changed the crops. [accepted] counts
 * accepted replies, so the runner can tell a turn that moved the page on from one that didn't.
 */
export interface StepsState {
  schema_version: typeof STEPS_STATE_SCHEMA
  jobId: string
  sourceSha256: string
  stage: StepStage
  shots: Shot[]
  noArtwork: boolean
  placed: Placed[]
  dropped: DroppedShot[]
  /** candidate id → box_problem (null when the crop looked right). */
  inspected: Record<string, string | null>
  queue: string[]
  queueTotal: number
  redescribe: boolean
  reviewDue: boolean
  reviewRounds: number
  messages: number
  accepted: number
  createdAt: string
  updatedAt: string
}

/** What to ask next: which step and, for step 3, its batch. */
export interface StepPlan {
  stage: StepStage
  part: 1 | 2 | 3 | 4
  batch: string[]
  batchIndex: number
  batchCount: number
}

export interface StepParse<T> { value: T | null; errors: ImportIssue[]; warnings: ImportIssue[] }

export function start(handoff: Handoff, now: string): StepsState {
  return {
    schema_version: STEPS_STATE_SCHEMA,
    jobId: handoff.jobId,
    sourceSha256: handoff.source.sha256,
    stage: 'inventory',
    shots: [],
    noArtwork: false,
    placed: [],
    dropped: [],
    inspected: {},
    queue: [],
    queueTotal: 0,
    redescribe: false,
    reviewDue: false,
    reviewRounds: 0,
    messages: 0,
    accepted: 0,
    createdAt: now,
    updatedAt: now,
  }
}

export function partOf(stage: StepStage): 1 | 2 | 3 | 4 {
  return stage === 'inventory' ? 1 : stage === 'geometry' ? 2 : stage === 'describe' ? 3 : 4
}

/** True once the last review changed nothing and nothing is open: the page can be delivered. */
export function finished(state: StepsState, reviewOpen: boolean): boolean {
  return state.stage === 'review' && !state.reviewDue && !reviewOpen
}

/** What to ask next, or null when there's nothing to ask. [reviewOpen] is whether the review has blockers. */
export function plan(state: StepsState, reviewOpen: boolean): StepPlan | null {
  if (state.stage === 'review' && finished(state, reviewOpen)) return null
  if (state.stage !== 'describe') return { stage: state.stage, part: partOf(state.stage), batch: [], batchIndex: 0, batchCount: 0 }
  const batch = state.queue.slice(0, DESCRIBE_BATCH)
  if (batch.length === 0) return null
  const total = Math.max(state.queueTotal, state.queue.length)
  const count = Math.ceil(total / DESCRIBE_BATCH)
  const index = Math.min(Math.max(Math.floor((total - state.queue.length) / DESCRIBE_BATCH) + 1, 1), Math.max(1, count))
  return { stage: 'describe', part: 3, batch, batchIndex: index, batchCount: count }
}

/** Why the page should be left for a person now, or null while it's within its budgets. */
export function overBudget(state: StepsState, next: StepPlan): string | null {
  if (next.stage === 'review' && state.reviewRounds >= MAX_REVIEW_ROUNDS) return `Still open after ${MAX_REVIEW_ROUNDS} review rounds (4-step flow)`
  if (state.messages >= MAX_MESSAGES) return `${MAX_MESSAGES} messages without finishing the page (4-step flow)`
  return null
}

/** A fresh budget for Review again; the progress stays. */
export function resetBudget(state: StepsState, now: string): StepsState {
  return { ...state, reviewRounds: 0, messages: 0, updatedAt: now }
}

export function label(next: StepPlan): string {
  const name = { 1: 'find the shots', 2: 'place the corners', 3: 'inspect the crops', 4: 'review' }[next.part]
  return next.batchCount > 1 ? `step ${next.part} of 4 (${name}, batch ${next.batchIndex} of ${next.batchCount})` : `step ${next.part} of 4 (${name})`
}

// ─── Prompts ───

const sliceLines = (h: Handoff) => h.slices.map((s) => `  ${s.id} = ${s.file} — ${s.width}×${s.height} px, page y ${s.y0}–${s.y1}`).join('\n')
const pageLine = (h: Handoff) => `"${h.source.pageStem}" from ${h.source.seriesTitle}, ${h.source.chapterFolder}`
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** HandoffFormat.pageImages for a sliced page. */
function slicesAttached(h: Handoff, here: boolean): string {
  const size = `${h.source.width}×${h.source.height} px`
  const count = h.slices.length
  return here
    ? `The ${count} image${plural(count, ' attached to this message is', 's attached to this message are')} losslessly cut, ordered, full-width vertical slices of that single page (${size}). Attach order and file names:`
    : `Use the ${count} slice${plural(count, '', 's')} of this page attached earlier in this conversation (${size}):`
}

function exampleCorner(h: Handoff, x: number, y: number): WritableJson {
  const first = h.slices[0]!
  return { slice_id: first.id, x: Math.min(x, h.source.width), y: Math.min(y, first.height) }
}

export function inventoryPrompt(h: Handoff): string {
  const first = h.slices[0]!.id
  const example: WritableJson = {
    schema_version: INVENTORY_SCHEMA,
    job_id: h.jobId,
    shots: [{
      shot_id: 'shot-01',
      subjects: EXAMPLE_SUBJECTS,
      from: { slice_id: first, part: 'top' },
      to: { slice_id: first, part: 'middle' },
      notes: '',
    }],
    page_has_no_artwork: false,
  }
  return [
    'STEP 1 OF 4 · FIND THE SHOTS',
    '',
    `You are analyzing ONE manhwa page: ${pageLine(h)}. This chat works through it in four steps; this message is step 1.`,
    GEOMETRY_ONLY,
    '',
    slicesAttached(h, true),
    sliceLines(h),
    '',
    'In this step only find and list the shots. Do NOT give pixel coordinates or crop corners in this reply.',
    '',
    'WHAT IS A SHOT',
    '- An independently readable illustrated moment: a framed panel, a distinct shot inside continuous artwork, a small insert, a grayscale scene, an object, a landscape or an effects shot.',
    '- Inspect the whole page top to bottom, including both sides of every slice seam. A seam is NOT a panel boundary: a shot may run across it.',
    '- Do not split continuous action just because it is tall. Do not merge different shots just because their backgrounds match.',
    '- Speech bubbles, narration boxes, caption/system text windows and SFX are not shots. A stretch holding only those over a plain, gradient, sky, sparkle, particle, glow or speed-line background is not a shot either.',
    '- If crop rules were shared above, use them to decide what counts as a shot.',
    '',
    CONTINUITY_RULES,
    '',
    'FOR EACH SHOT',
    '- shot_id: "shot-01", "shot-02", … in reading order (top to bottom, then left to right).',
    '- subjects: 2–6 words that tell this shot apart from the others in step 2 (e.g. "man on rooftop, wide", "sword close-up"). A working label only: not a description, never saved. No character names, no plot, no dialogue.',
    '- from / to: where the shot\'s artwork starts and ends, as { "slice_id", "part" } with part "top", "middle" or "bottom" (the rough third of that slice).',
    '- notes: optional short phrase, e.g. "crosses the seam into the next slice" or "small inset inside shot-04".',
    '',
    'If the page has no artwork at all, return an empty "shots" list and set "page_has_no_artwork" to true.',
    '',
    `Return ONE JSON object in exactly this shape (${INVENTORY_SCHEMA}), with no prose and no Markdown fences. job_id is real; the shot is only an example:`,
    stringify(example, true),
  ].join('\n')
}

export function geometryPrompt(state: StepsState, h: Handoff): string {
  const example: WritableJson = {
    schema_version: GEOMETRY_SCHEMA,
    job_id: h.jobId,
    coordinate_system: SLICE_COORDINATES,
    candidates: [{
      candidate_id: 'candidate-01',
      shot_ids: ['shot-01'],
      reason: 'framed_reaction',
      top_left: exampleCorner(h, 35, 110),
      bottom_right: exampleCorner(h, 1045, 810),
      visual_evidence: EXAMPLE_EVIDENCE,
      review_flags: [],
    }],
    dropped_shots: [{ shot_id: 'shot-07', why: 'only a narration box over a plain background' }],
  }
  const shots = state.shots.length === 0
    ? '(none: step 1 found no artwork. Return no candidates unless you see artwork it missed.)'
    : stringify(state.shots.map((s) => ({
      shot_id: s.id,
      subjects: s.subjects,
      from: { slice_id: s.from.sliceId, part: s.from.part },
      to: { slice_id: s.to.sliceId, part: s.to.part },
      notes: s.notes,
    })), true)
  return [
    `STEP 2 OF 4 · PLACE THE CORNERS for ${pageLine(h)}`,
    '',
    slicesAttached(h, false),
    sliceLines(h),
    '',
    'Below is the shot list from step 1. Measure each shot\'s rectangle on the slices themselves.',
    GEOMETRY_ONLY,
    '',
    'THE SHOT LIST IS PROVISIONAL',
    CONTINUITY_RULES,
    '- Account for every shot_id: list it in the "shot_ids" of the candidate(s) that hold it, or in "dropped_shots" with why.',
    '- If a listed shot is really two shots, return two candidates that both list its shot_id. If several listed shots are one continuous shot, return one candidate listing all of them.',
    '- If you find artwork the list missed, add a candidate with "shot_ids": [] and say what it is in visual_evidence.',
    '- A shot\'s from/to slices are a hint, not a limit: follow the artwork.',
    '',
    'WHERE THE EDGES GO',
    '- Edges follow the artwork: a crop starts where its artwork starts and ends where it ends. A bubble, narration box or caption/system text window above or below the art stays outside the crop; keep only what overlaps the art.',
    '- Between two unframed shots, end each crop at its own artwork. The plain, dark or textured background between them belongs to neither crop.',
    '- Keep people, faces, hands, clothing, weapons and important effects whole.',
    '- A shot whose crop would hold mainly bubbles, narration or lettering over a background (not a person, creature, object, place or action) goes in "dropped_shots".',
    '- If crop rules were shared above, apply them to decide where each edge goes. The JSON contract below overrides any output format they describe.',
    '',
    'HOW TO MEASURE (important)',
    '- Give each crop\'s top-left and bottom-right corner in the pixel grid of the SLICE that corner falls in: { "slice_id", "x", "y" }, with x from 0 to the slice width and y from 0 to that slice\'s height. Do NOT add slice offsets yourself.',
    '- bottom_right is exclusive (the first pixel row/column outside the crop). A crop crossing a seam simply has its two corners in different slices.',
    '- Use integers. If a boundary is uncertain, give your best estimate AND add the flag "boundary_uncertain"; never invent precision.',
    '',
    'PER CANDIDATE',
    '- candidate_id: "candidate-01", "candidate-02", … in reading order.',
    '- reason: a short factual snake_case label (e.g. framed_reaction, action_effects, wide_landscape).',
    '- visual_evidence: a short phrase saying why this is its own crop.',
    `- review_flags: zero or more of ${REVIEW_FLAGS.map((f) => `"${f}"`).join(', ')}.`,
    `- rotate: only on sideways art. ${ROTATE_RULE}`,
    '',
    `Return ONE JSON object (${GEOMETRY_SCHEMA}), with no prose and no Markdown fences. job_id is real; the rest only shows the shape:`,
    stringify(example, true),
    '',
    'SHOTS FROM STEP 1:',
    shots,
  ].join('\n')
}

/** GeometryWorkflow.inspectionPrompt: [crops] are the batch's ids with their page boxes, in fetch order. */
export function inspectionPrompt(h: Handoff, crops: [string, Box][]): string {
  return trimIndent(`
        STEP 3 OF 4: visually inspect these ACTUAL crop images, in the listed order. The grey ID label is app-added.
        Check whole faces, hair, bodies, hands/objects, continuity, multiple distinct panels and unreadable details. Do not write descriptions, story context or script links.
        ${CONTINUITY_RULES}
        Crops: ${crops.map(([id, b]) => `${id} (${b.x1 - b.x0}x${b.y1 - b.y0})`).join(', ')}
        Return JSON only: {"schema_version":"${INSPECTION_SCHEMA}","job_id":"${h.jobId}","inspections":[{"candidate_id":"${crops[0]?.[0] ?? 'crop-id'}","box_problem":null}]}
        Return exactly one inspection for every requested crop. box_problem is null when correct, otherwise one of clipped_subject, possible_multiple_shots, boundary_uncertain, possible_duplicate, small_detail_unreadable. Problems are passed to the next geometry review; never change pointers in this reply.
    `)
}

/** CropReview.geometryReviewPrompt(state, items, audit, handoff, fresh = false, annotatedImages = true). */
export function reviewStepPrompt(state: ReviewState, reviewItems: ReviewItem[], audit: AuditReport, h: Handoff): string {
  const slices = h.slices
  const source = h.source
  const crops = currentCrops(state, reviewItems, slices)
  const firstCrop = crops[0]
  const example: WritableJson = {
    schema_version: GEOMETRY_REVIEW_SCHEMA,
    job_id: h.jobId,
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
    sweep_done: true,
    page_has_no_artwork: false,
    notes: '',
  }
  const count = slices.length
  const images = `The ${count} image${plural(count, ' attached to this message is', 's attached to this message are')} this page's slices (${slices.map((s) => s.id).join(', ')}) with every current crop drawn on them as a coloured box labelled with its key. Use them to see each crop's extent, and check its edges against the clean slices attached earlier in this conversation (${source.width}×${source.height} px in total).`
  return [
    `STEP 4 OF 4 · REVIEW ROUND for "${source.pageStem}"`,
    '',
    images,
    '',
    'Below are the crops currently proposed for this page. Act as the reviewer. Compare every crop with the page and decide its FINAL form:',
    '- keep it exactly (same corners),',
    '- adjust its corners so it holds the complete shot — whole faces, hands, weapons, effects — and nothing from the neighbouring shot; trim any top or bottom stretch that is only bubbles, narration, a caption/system text window or empty background (the edge goes where the artwork starts and ends),',
    '- split it when it actually contains separate shots (return each part as a new crop with "from_keys": [its key]),',
    '- merge crops that are really one continuous shot (return one crop with "key" = one of them and "from_keys" = the others),',
    '- remove it (list its key in "removed_keys") when it is not an independently readable illustrated moment.',
    CONTINUITY_RULES,
    REVIEW_RULES,
    'ALWAYS remove a crop whose content is only speech/thought/narration bubbles, caption boxes or SFX over a plain, gradient, sky, sparkle, particle, glow or speed-line background, even if its checks pass.',
    '',
    'CHECKS: each crop lists automatic checks with a token. Look at what each one points to. If the crop is fine despite it (or after your fix), put its token in "checks_reviewed". Leave a token out if you could not verify it.',
    '',
    'SWEEP: go through the whole page top to bottom, independently of the crops below, for artwork no crop holds — small inserts, grayscale panels, objects, landscapes, effects shots. These uncovered stretches are inked enough to hold artwork:',
    ...sweepLines(audit, slices),
    'Add a crop (key null, no from_keys) for any real artwork there. Ink includes bubbles and lettering: a stretch holding only bubbles, narration or SFX over background stays uncovered. Set "sweep_done": true only after you have actually swept the page.',
    '',
    GEOMETRY_ONLY,
    '',
    'MEASURING: corners are in the pixel grid of the slice each corner falls in — { "slice_id", "x", "y" } — exactly as in step 2. bottom_right is exclusive. Whole pixels only.',
    '',
    'RULES FOR THE REPLY:',
    '- "crops" is the COMPLETE final list for the page.',
    '- Every current key must appear exactly once: as a crop\'s "key", inside a "from_keys", or in "removed_keys".',
    `- Copy job_id, source_sha256 and review_revision exactly: ${h.jobId} / ${source.sha256} / ${state.revision}.`,
    `- Return ONE JSON object (${GEOMETRY_REVIEW_SCHEMA}), no prose, no Markdown fences. Shape (example values):`,
    stringify(example, true),
    '',
    'CURRENT CROPS:',
    // Geometry only: the crops are listed without their (empty) description field.
    stringify(crops.map(({ description: _description, ...rest }) => rest) as unknown as WritableJson, true),
    '',
    `${ROTATE_RULE} ${REVIEW_ROTATE_RULE}`,
  ].join('\n')
}

/** What the submit tool answers when it refuses a reply to [part]. */
export function stepCorrection(part: number, errors: ImportIssue[]): string {
  return `STEP ${part} OF 4 · CORRECTION\n\n${correctionPrompt(errors)}`
}

// ─── Replies ───

const issue = (code: string, field: string, message: string, candidateId: string | null = null): ImportIssue => ({ code, field, message, candidateId })

/** The reply's object once its schema and page check out; errors otherwise. */
function read(content: string, schema: string, step: number, h: Handoff): { root: JsonObject | null; errors: ImportIssue[]; warnings: ImportIssue[] } {
  const errors: ImportIssue[] = []
  const warnings: ImportIssue[] = []
  const [text, stripped] = stripMarkdownFence(content)
  if (stripped) warnings.push(issue('MARKDOWN_FENCE_STRIPPED', '', 'The reply was wrapped in a Markdown code fence; the fence was removed'))
  let root: JsonValue
  try {
    root = parseJson(text)
  } catch (e) {
    errors.push(issue('GPT_JSON_INVALID', '', `The reply is not valid JSON: ${(e as Error).message}`))
    return { root: null, errors, warnings }
  }
  if (!(root instanceof JsonObject)) {
    errors.push(issue('GPT_JSON_INVALID', '', `The reply must be one JSON object (got ${describe(root)})`))
    return { root: null, errors, warnings }
  }
  if (root.value('schema_version') !== schema) {
    errors.push(issue('GPT_JSON_INVALID', 'schema_version', `schema_version must be "${schema}" (got ${describe(root.value('schema_version'))}) — is this the reply to the step ${step} prompt?`))
  }
  if (root.value('job_id') !== h.jobId) {
    errors.push(issue('GPT_PAGE_MISMATCH', 'job_id', `job_id is ${describe(root.value('job_id'))} but this page's is ${h.jobId}`))
  }
  return { root, errors, warnings }
}

function text(value: JsonValue | undefined): string | null {
  if (typeof value !== 'string') return null
  const t = ktTrim(value)
  return t.length > 0 ? t.substring(0, MAX_TEXT) : null
}

/** Checks step 1's shot list; on success the page moves on to step 2. */
export function applyInventory(content: string, state: StepsState, h: Handoff, now: string): StepParse<StepsState> {
  const { root, errors, warnings } = read(content, INVENTORY_SCHEMA, 1, h)
  if (!root) return { value: null, errors, warnings }
  const sliceIndex = new Map(h.slices.map((s, i) => [s.id, i]))
  const raw = root.value('shots')
  if (!(raw instanceof JsonArray)) {
    errors.push(issue('GPT_JSON_INVALID', 'shots', `shots must be an array (got ${describe(raw)})`))
    return { value: null, errors, warnings }
  }
  if (raw.items.length > MAX_ITEMS) errors.push(issue('GPT_JSON_INVALID', 'shots', `At most ${MAX_ITEMS} shots`))

  const spot = (value: JsonValue | undefined, field: string, id: string): SliceSpot | null => {
    if (!(value instanceof JsonObject)) {
      errors.push(issue('GPT_JSON_INVALID', field, `${id}: ${field} must be an object {slice_id, part} (got ${describe(value)})`, id))
      return null
    }
    const sliceId = value.value('slice_id')
    const part = value.value('part')
    let ok = true
    if (typeof sliceId !== 'string' || !sliceIndex.has(sliceId)) {
      errors.push(issue('GPT_JSON_INVALID', `${field}.slice_id`, `${id}: ${describe(sliceId)} is not one of this page's slices (${[...sliceIndex.keys()].join(', ')})`, id))
      ok = false
    }
    if (typeof part !== 'string' || !(PARTS as readonly string[]).includes(part)) {
      errors.push(issue('GPT_JSON_INVALID', `${field}.part`, `${id}: part must be "top", "middle" or "bottom" (got ${describe(part)})`, id))
      ok = false
    }
    return ok ? { sliceId: sliceId as string, part: part as string } : null
  }
  const order = (s: SliceSpot) => sliceIndex.get(s.sliceId)! * PARTS.length + PARTS.indexOf(s.part as (typeof PARTS)[number])

  const seen = new Set<string>()
  const shots: Shot[] = []
  raw.items.forEach((item, index) => {
    const at = `shots[${index}]`
    if (!(item instanceof JsonObject)) {
      errors.push(issue('GPT_JSON_INVALID', at, `${at} must be an object (got ${describe(item)})`))
      return
    }
    const rawId = item.value('shot_id')
    const id = typeof rawId === 'string' ? ktTrim(rawId) : ''
    if (id.length === 0) errors.push(issue('GPT_JSON_INVALID', `${at}.shot_id`, `${at}.shot_id must be a non-empty string`))
    else if (id.length > MAX_ID) errors.push(issue('GPT_JSON_INVALID', `${at}.shot_id`, `${at}.shot_id is longer than ${MAX_ID} characters`))
    else if (seen.has(id)) errors.push(issue('GPT_JSON_INVALID', `${at}.shot_id`, `Duplicate shot_id "${id}"`, id))
    else seen.add(id)
    const name = id.length > 0 ? id : `#${index + 1}`
    const subjects = text(item.value('subjects'))
    if (subjects === null) errors.push(issue('GPT_JSON_INVALID', `${at}.subjects`, `${name}: subjects must say what the shot shows`, name))
    else if (subjects.toLowerCase() === EXAMPLE_SUBJECTS) errors.push(issue('GPT_EXAMPLE_COPIED', `${at}.subjects`, `${name}: ${COPIED}`, name))
    const from = spot(item.value('from'), `${at}.from`, name)
    const to = spot(item.value('to'), `${at}.to`, name)
    if (from && to && order(to) < order(from)) {
      errors.push(issue('GPT_JSON_INVALID', `${at}.to`, `${name}: it ends (${to.sliceId} ${to.part}) before it starts (${from.sliceId} ${from.part})`, name))
    }
    if (id.length > 0 && subjects !== null && from && to) shots.push({ id, subjects, from, to, notes: text(item.value('notes')) ?? '' })
  })
  const noArtwork = root.value('page_has_no_artwork') === true
  if (raw.items.length === 0 && !noArtwork) {
    errors.push(issue('GPT_JSON_INVALID', 'shots', 'No shots listed. List every shot, or set "page_has_no_artwork" to true if the page really has none.'))
  }
  if (errors.length > 0) return { value: null, errors, warnings }
  const ordered = [...shots].sort((a, b) => order(a.from) - order(b.from))
  return { value: { ...state, stage: 'geometry', shots: ordered, noArtwork: noArtwork && ordered.length === 0, accepted: state.accepted + 1, updatedAt: now }, errors, warnings }
}

/** Checks step 2's rectangles against the slices and step 1's list; on success the page moves on to step 3. */
export function applyGeometry(content: string, state: StepsState, h: Handoff, now: string): StepParse<StepsState> {
  const { root, errors, warnings } = read(content, GEOMETRY_SCHEMA, 2, h)
  if (!root) return { value: null, errors, warnings }
  const sink = (code: string, field: string, message: string, id: string | null) => { errors.push(issue(code, field, message, id)) }
  if (root.value('coordinate_system') !== SLICE_COORDINATES) {
    errors.push(issue('GPT_COORDINATES_INVALID', 'coordinate_system', `coordinate_system must be "${SLICE_COORDINATES}"`))
  }
  const raw = root.value('candidates')
  if (!(raw instanceof JsonArray)) {
    errors.push(issue('GPT_JSON_INVALID', 'candidates', `candidates must be an array (got ${describe(raw)})`))
    return { value: null, errors, warnings }
  }
  if (raw.items.length > MAX_ITEMS) {
    errors.push(issue('GPT_JSON_INVALID', 'candidates', `At most ${MAX_ITEMS} candidates`))
    return { value: null, errors, warnings }
  }

  const shotsById = new Map(state.shots.map((s) => [s.id, s]))
  const sliceById = new Map<string, HandoffSlice>(h.slices.map((s) => [s.id, s]))
  const sliceIndex = new Map(h.slices.map((s, i) => [s.id, i]))
  const seen = new Set<string>()
  const used = new Set<string>()
  const placed: Placed[] = []

  raw.items.forEach((item, index) => {
    const at = `candidates[${index}]`
    if (!(item instanceof JsonObject)) {
      errors.push(issue('GPT_JSON_INVALID', at, `${at} must be an object (got ${describe(item)})`))
      return
    }
    const rawId = item.value('candidate_id')
    let id = typeof rawId === 'string' ? ktTrim(rawId) : ''
    if (id.length === 0) {
      errors.push(issue('GPT_JSON_INVALID', `${at}.candidate_id`, `${at}.candidate_id must be a non-empty string`))
      id = `#${index + 1}`
    } else if (id.length > MAX_ID) errors.push(issue('GPT_JSON_INVALID', `${at}.candidate_id`, `${at}.candidate_id is longer than ${MAX_ID} characters`))
    else if (seen.has(id)) errors.push(issue('GPT_JSON_INVALID', `${at}.candidate_id`, `Duplicate candidate_id "${id}"`, id))
    else seen.add(id)

    const rawShots = item.value('shot_ids')
    const shotIds: string[] = []
    if (!(rawShots instanceof JsonArray) || rawShots.items.some((it) => typeof it !== 'string')) {
      errors.push(issue('GPT_JSON_INVALID', `${at}.shot_ids`, `${id}: shot_ids must be an array of step-1 shot ids; use [] for artwork step 1 missed`, id))
    } else {
      for (const shot of [...new Set(rawShots.items.map((it) => ktTrim(it as string)))]) {
        if (shotsById.has(shot)) shotIds.push(shot)
        else errors.push(issue('GPT_JSON_INVALID', `${at}.shot_ids`, `${id}: "${shot}" is not a shot from step 1 (${[...shotsById.keys()].join(', ') || 'there were none'})`, id))
      }
    }
    shotIds.forEach((s) => used.add(s))

    const bounds = boundsFromSliceCorners(item, at, id, h, sliceById, sink)

    let reason = ''
    const rawReason = item.value('reason')
    if (typeof rawReason !== 'string' || ktTrim(rawReason).length === 0) {
      errors.push(issue('GPT_JSON_INVALID', `${at}.reason`, `${id}: reason must be a non-empty string (got ${describe(rawReason)})`, id))
    } else if (rawReason.length > MAX_ID) {
      errors.push(issue('GPT_JSON_INVALID', `${at}.reason`, `${id}: reason is longer than ${MAX_ID} characters`, id))
    } else {
      reason = normalizeReason(rawReason)
      if (reason.length === 0) errors.push(issue('GPT_JSON_INVALID', `${at}.reason`, `${id}: reason ${describe(rawReason)} has no usable characters`, id))
      else if (reason !== rawReason) warnings.push(issue('REASON_NORMALIZED', `${at}.reason`, `${id}: reason ${describe(rawReason)} normalized to "${reason}"`, id))
    }

    const rawEvidence = item.value('visual_evidence')
    if (rawEvidence !== undefined && rawEvidence !== JNULL && typeof rawEvidence !== 'string') {
      errors.push(issue('GPT_JSON_INVALID', `${at}.visual_evidence`, `${id}: visual_evidence must be a string`, id))
    }
    const evidence = text(rawEvidence) ?? ''

    const flags: string[] = []
    const rawFlags = item.value('review_flags')
    if (rawFlags !== undefined && rawFlags !== JNULL) {
      if (!(rawFlags instanceof JsonArray) || rawFlags.items.some((it) => typeof it !== 'string')) {
        errors.push(issue('GPT_JSON_INVALID', `${at}.review_flags`, `${id}: review_flags must be an array of strings`, id))
      } else {
        for (const f of rawFlags.items as string[]) {
          const flag = ktTrim(f).substring(0, MAX_ID)
          if (flag.length > 0 && !flags.includes(flag)) flags.push(flag)
        }
      }
    }

    const rotate = parseRotation(item.value('rotate'))
    if (rotate === undefined) {
      errors.push(issue('GPT_JSON_INVALID', `${at}.rotate`, `${id}: rotate must be 90, -90 or left out (got ${describe(item.value('rotate'))})`, id))
    }

    const exampleTopLeft = exampleCorner(h, 35, 110) as { slice_id: string; x: number; y: number }
    const exampleBottomRight = exampleCorner(h, 1045, 810) as { slice_id: string; x: number; y: number }
    const sameCorner = (c: JsonValue | undefined, e: { slice_id: string; x: number; y: number }) =>
      c instanceof JsonObject && c.value('slice_id') === e.slice_id && Number(wholeNumber(c.value('x'))) === e.x && Number(wholeNumber(c.value('y'))) === e.y
    if (evidence === EXAMPLE_EVIDENCE || (sameCorner(item.value('top_left'), exampleTopLeft) && sameCorner(item.value('bottom_right'), exampleBottomRight))) {
      errors.push(issue('GPT_EXAMPLE_COPIED', at, `${id}: ${COPIED}`, id))
      return
    }
    if (bounds === null || reason.length === 0) return
    if (shotIds.length === 0) {
      warnings.push(issue('NEW_ARTWORK', `${at}.shot_ids`, `${id}: artwork step 1 didn't list${evidence.length > 0 ? ` (${evidence})` : ''}`, id))
    } else {
      // Step 1's slices are a hint: running past them is worth a look, not a refusal.
      const spots = shotIds.map((s) => shotsById.get(s)!)
      const first = h.slices[Math.min(...spots.map((s) => sliceIndex.get(s.from.sliceId)!))]!
      const last = h.slices[Math.max(...spots.map((s) => sliceIndex.get(s.to.sliceId)!))]!
      if (bounds.y0 < first.y0 || bounds.y1 > last.y1) {
        const span = first.id === last.id ? first.id : `${first.id}–${last.id}`
        warnings.push(issue('OUTSIDE_SHOT_SPAN', at, `${id} runs outside ${span}, where step 1 put ${shotIds.join(', ')}`, id))
      }
    }
    const corner = (name: string): StepCorner => {
      const c = item.value(name) as JsonObject
      return { slice_id: c.value('slice_id') as string, x: Number(wholeNumber(c.value('x'))), y: Number(wholeNumber(c.value('y'))) }
    }
    placed.push({ id, shotIds, reason, topLeft: corner('top_left'), bottomRight: corner('bottom_right'), bounds, evidence, flags, ...(rotate ? { rotate } : {}) })
  })

  const dropped: DroppedShot[] = []
  const rawDropped = root.value('dropped_shots')
  if (rawDropped !== undefined && rawDropped !== JNULL) {
    if (!(rawDropped instanceof JsonArray)) {
      errors.push(issue('GPT_JSON_INVALID', 'dropped_shots', 'dropped_shots must be an array of {shot_id, why}'))
    } else {
      rawDropped.items.forEach((item, index) => {
        const at = `dropped_shots[${index}]`
        const rawShot = item instanceof JsonObject ? item.value('shot_id') : undefined
        const shot = typeof rawShot === 'string' ? ktTrim(rawShot) : null
        if (shot === null) errors.push(issue('GPT_JSON_INVALID', at, `${at} must be an object with a shot_id`))
        else if (!shotsById.has(shot)) errors.push(issue('GPT_JSON_INVALID', `${at}.shot_id`, `"${shot}" is not a shot from step 1`))
        else if (used.has(shot)) errors.push(issue('GPT_JSON_INVALID', `${at}.shot_id`, `"${shot}" is both in a candidate's shot_ids and dropped`))
        else {
          const why = text((item as JsonObject).value('why')) ?? ''
          if (why.length === 0) warnings.push(issue('DROP_REASON_MISSING', `${at}.why`, `${shot} was dropped without saying why`))
          if (!dropped.some((d) => d.shotId === shot)) dropped.push({ shotId: shot, why })
        }
      })
    }
  }
  const missing = state.shots.map((s) => s.id).filter((id) => !used.has(id) && !dropped.some((d) => d.shotId === id))
  if (missing.length > 0) {
    errors.push(issue('GPT_JSON_INVALID', 'candidates', `Not accounted for: ${missing.join(', ')}. Every step-1 shot must be in a candidate's shot_ids or in dropped_shots with why.`))
  }
  if (errors.length > 0) return { value: null, errors, warnings }

  const ordered = [...placed].sort((a, b) => a.bounds.y0 - b.bounds.y0 || a.bounds.x0 - b.bounds.x0)
  return {
    value: {
      ...state,
      stage: 'describe',
      placed: ordered,
      dropped,
      inspected: {},
      queue: ordered.map((p) => p.id),
      queueTotal: ordered.length,
      redescribe: false,
      accepted: state.accepted + 1,
      updatedAt: now,
    },
    errors,
    warnings,
  }
}

/** GeometryWorkflow.inspections: exactly one inspection per id of [batch]; box_problem null or a known flag. */
export function parseInspections(content: string, h: Handoff, batch: string[]): StepParse<Record<string, string | null>> {
  const fail = (message: string): StepParse<Record<string, string | null>> => ({ value: null, errors: [issue('INSPECTION_INVALID', '', message)], warnings: [] })
  let root: JsonValue
  try {
    root = parseJson(stripMarkdownFence(content)[0])
  } catch (e) {
    return fail(`The reply is not valid JSON: ${(e as Error).message}`)
  }
  if (!(root instanceof JsonObject)) return fail('The reply must be one JSON object')
  if (root.value('schema_version') !== INSPECTION_SCHEMA) return fail(`schema_version must be "${INSPECTION_SCHEMA}"`)
  if (root.value('job_id') !== h.jobId) return fail(`job_id must be "${h.jobId}"`)
  const list = root.value('inspections')
  if (!(list instanceof JsonArray)) return fail('inspections must be an array')
  const out: Record<string, string | null> = {}
  for (const item of list.items) {
    if (!(item instanceof JsonObject)) return fail('Each inspection must be an object')
    const id = item.value('candidate_id')
    if (typeof id !== 'string' || !batch.includes(id)) return fail(`${describe(id)} is not one of the requested crops (${batch.join(', ')})`)
    if (id in out) return fail(`"${id}" is inspected twice`)
    const problem = item.value('box_problem')
    if (problem === undefined || problem === JNULL) out[id] = null
    else if (typeof problem === 'string' && REVIEW_FLAGS.includes(problem)) out[id] = problem
    else return fail(`${id}: box_problem must be null or one of clipped_subject, possible_multiple_shots, boundary_uncertain, possible_duplicate, small_detail_unreadable`)
  }
  const missing = batch.filter((id) => !(id in out))
  if (missing.length > 0) return fail(`Inspect every requested crop exactly once. Missing: ${missing.join(', ')}`)
  return { value: out, errors: [], warnings: [] }
}

/** `chatgpt-analysis/1.0` built from step 2's corners (as written) and step 3's inspections. */
export function assemble(state: StepsState, h: Handoff): string {
  const s = h.source
  return stringify({
    schema_version: ANALYSIS_SCHEMA,
    job_id: h.jobId,
    source_sha256: s.sha256,
    page_stem: s.pageStem,
    source_width: s.width,
    source_height: s.height,
    coordinate_system: SLICE_COORDINATES,
    page_inspection_complete: true,
    candidates: state.placed.map((p) => {
      const problem = state.inspected[p.id] ?? null
      return {
        candidate_id: p.id,
        reason: p.reason,
        top_left: { ...p.topLeft },
        bottom_right: { ...p.bottomRight },
        description: '',
        visual_evidence: p.evidence,
        review_flags: [...new Set([...p.flags, ...(problem ? [problem] : [])])],
        ...(p.rotate ? { rotate: p.rotate } : {}),
      }
    }),
    page_review_flags: [],
  }, true) + '\n'
}

// ─── Storing ───

export const toJson = (state: StepsState) => JSON.stringify(state)

export function parseSteps(text: string | null | undefined): StepsState | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as StepsState
    return value?.schema_version === STEPS_STATE_SCHEMA ? value : null
  } catch {
    return null
  }
}
