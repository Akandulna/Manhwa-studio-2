/**
 * Port of the phone's AnalysisImport.kt: checks ChatGPT's `chatgpt-analysis/1.0` reply against the page's
 * package and turns it into page-pixel candidates. Anything that could put a crop on the wrong page or in
 * the wrong place is an error; boxes are never clamped. Every string in the reply is data. Pure.
 */
import { describe, isBlank, isNumber, JNULL, JsonArray, JsonObject, ktTrim, parseJson, sha256Hex, trimChar, wholeNumber, type JsonValue } from './json.js'
import type { AnalysisParseResult, Box, Handoff, HandoffSlice, ImportedCandidate, ImportIssue, Rotation } from './types.js'

export const ANALYSIS_SCHEMA = 'chatgpt-analysis/1.0'
export const CANONICAL_COORDINATES = 'canonical_original_pixels'
/** Corners measured inside the slice they fall in; the app adds the offsets. */
export const SLICE_COORDINATES = 'slice_local_pixels'

/** The review flags ChatGPT may attach. Anything else is a warning, never an instruction. */
export const REVIEW_FLAGS = [
  'seam_crossing',
  'boundary_uncertain',
  'possible_multiple_shots',
  'tall_continuous_scene',
  'small_detail_unreadable',
  'clipped_subject',
  'possible_duplicate',
  'needs_closer_view',
]

const MAX_TEXT = 1000
const MAX_REASON = 120
const MAX_CANDIDATES = 500

const REASON_PATTERN = /^[a-z0-9]+(?:_{1,2}[a-z0-9]+)*$/
/**
 * Kotlin: ^\s*```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?\s*```\s*$ — Java's \s is [ \t\n\x0B\f\r], and its $ also
 * matches before one final line terminator.
 */
const FENCE = /^[ \t\n\x0B\f\r]*```[a-zA-Z0-9_-]*[ \t\n\x0B\f\r]*\n([\s\S]*?)\n?[ \t\n\x0B\f\r]*```[ \t\n\x0B\f\r]*(?:\r\n|[\n\r\u0085\u2028\u2029])?$/

const TOP_LEVEL_KEYS = new Set([
  'schema_version', 'job_id', 'source_sha256', 'page_stem', 'source_width', 'source_height',
  'coordinate_system', 'page_inspection_complete', 'candidates', 'page_review_flags',
])
const CANDIDATE_KEYS = new Set([
  'candidate_id', 'reason', 'top_left', 'bottom_right', 'bounds', 'description', 'visual_evidence', 'review_flags', 'rotate',
])

/**
 * A crop's "rotate" field: 90 or -90 turn it upright; absent, null or 0 mean upright. Anything else is
 * refused (returns undefined) so the model is asked again rather than a crop turned the wrong way.
 */
export function parseRotation(value: JsonValue | undefined): Rotation | null | undefined {
  if (value === undefined || value === JNULL) return null
  const n = wholeNumber(value)
  if (n === 0n) return null
  if (n === 90n) return 90
  if (n === -90n) return -90
  return undefined
}

/** The text every crop prompt carries about "rotate" (the same line is in the phone's HandoffFormat). */
export const ROTATE_RULE =
  'SIDEWAYS ART: a few panels are drawn turned on their side, so a reader must tilt their head to view them. For such a crop add "rotate": 90 when the art\'s top points LEFT (turn it clockwise to stand it upright) or "rotate": -90 when the art\'s top points RIGHT (turn it counter-clockwise). Judge by the figures, faces and lettering inside the crop, not by the page. Leave "rotate" out for every upright crop; no other value is allowed. The crop\'s corners stay measured on the page as it is.'

/** The review rounds' addition to [ROTATE_RULE]: how a reply keeps, sets or clears a crop's turn. */
export const REVIEW_ROTATE_RULE =
  'In the reply, a crop without "rotate" keeps the value listed under CURRENT CROPS (a split part keeps its parent\'s). Give "rotate": 90 or -90 to turn a crop that is drawn sideways, or "rotate": 0 when a listed crop is actually upright.'

/** Where an error is reported: code, field, message and the candidate it's about. */
export type IssueSink = (code: string, field: string, message: string, candidateId: string | null) => void

/** ChatGPT often wraps JSON in a ```json fence despite being asked not to; the fence carries no data. */
export function stripMarkdownFence(text: string): [string, boolean] {
  const match = FENCE.exec(text)
  return match ? [match[1]!, true] : [text, false]
}

/** Lowercase snake_case, keeping the `__suffix` convention review reasons use. */
export function normalizeReason(reason: string): string {
  return trimChar(reason.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_{3,}/g, '__'), '_')
}

/** The slices a page-pixel box overlaps, top to bottom. */
export function slicesSpanned(bounds: Box, slices: HandoffSlice[]): string[] {
  return slices.filter((s) => bounds.y0 < s.y1 && bounds.y1 > s.y0).map((s) => s.id)
}

function wordCount(text: string): number {
  return ktTrim(text).split(/[ \t\n\x0B\f\r]+/).filter((w) => w.length > 0).length
}

/** JavaScript's `===` for the values an identity field can hold: 800 and 800.0 are the same number. */
function sameValue(got: JsonValue | undefined, want: string | number): boolean {
  if (typeof want === 'number') return wholeNumber(got) === BigInt(want) && typeof got !== 'boolean'
  return got === want
}

/**
 * Validates a pasted reply against the page's manifest and converts it to page-pixel candidates.
 * Studio's geometry-only Classic flow passes [geometryOnly] = true, as the phone does for geometry pages.
 */
export function parseAnalysis(content: string, handoff: Handoff, geometryOnly = false): AnalysisParseResult {
  const errors: ImportIssue[] = []
  const warnings: ImportIssue[] = []
  const error: IssueSink = (code, field, message, id) => {
    errors.push({ code, field, message, candidateId: id })
  }
  const warn = (code: string, field: string, message: string, id: string | null = null) => {
    warnings.push({ code, field, message, candidateId: id })
  }
  const refuse = (): AnalysisParseResult => ({ analysis: null, errors, warnings })

  const [text, stripped] = stripMarkdownFence(content)
  if (stripped) warn('MARKDOWN_FENCE_STRIPPED', '', 'The reply was wrapped in a Markdown code fence; the fence was removed')

  let root: JsonValue
  try {
    root = parseJson(text)
  } catch (e) {
    error('GPT_JSON_INVALID', '', `The reply is not valid JSON: ${(e as Error).message}`, null)
    return refuse()
  }
  if (!(root instanceof JsonObject)) {
    error('GPT_JSON_INVALID', '', `The reply must be one JSON object (got ${describe(root)})`, null)
    return refuse()
  }

  for (const key of root.keyList()) {
    if (!TOP_LEVEL_KEYS.has(key)) warn('UNKNOWN_FIELD', key, `Unknown field "${key}" was ignored`)
  }

  // Identity: the reply must be about exactly this version of this page.
  const source = handoff.source
  if (root.value('schema_version') !== ANALYSIS_SCHEMA) {
    error('GPT_JSON_INVALID', 'schema_version', `schema_version must be "${ANALYSIS_SCHEMA}" (got ${describe(root.value('schema_version'))})`, null)
  }
  const rawSha = root.value('source_sha256')
  const sha = typeof rawSha === 'string' ? rawSha.toLowerCase() : rawSha
  const identity: [string, JsonValue | undefined, string | number][] = [
    ['job_id', root.value('job_id'), handoff.jobId],
    ['source_sha256', sha, source.sha256],
    ['page_stem', root.value('page_stem'), source.pageStem],
    ['source_width', root.value('source_width'), source.width],
    ['source_height', root.value('source_height'), source.height],
  ]
  for (const [field, got, want] of identity) {
    if (!sameValue(got, want)) {
      error(
        'GPT_PAGE_MISMATCH', field,
        `${field} is ${describe(got)} but this page's package says ${describe(want)} — the reply is for a different page or an older version of it`,
        null,
      )
    }
  }

  const coordinateSystem = root.value('coordinate_system')
  if (coordinateSystem !== SLICE_COORDINATES && coordinateSystem !== CANONICAL_COORDINATES) {
    error(
      'GPT_COORDINATES_INVALID', 'coordinate_system',
      `coordinate_system must be "${SLICE_COORDINATES}" or "${CANONICAL_COORDINATES}" (got ${describe(coordinateSystem)})`,
      null,
    )
  }

  const inspectionComplete = root.value('page_inspection_complete')
  if (typeof inspectionComplete !== 'boolean') {
    error('GPT_JSON_INVALID', 'page_inspection_complete', `page_inspection_complete must be true or false (got ${describe(inspectionComplete)})`, null)
  }

  const pageFlags: string[] = []
  const flags = root.value('page_review_flags')
  if (flags === undefined) {
    // absent means no page flags: they carry no geometry
  } else if (!(flags instanceof JsonArray) || flags.items.some((it) => typeof it !== 'string')) {
    error('GPT_JSON_INVALID', 'page_review_flags', 'page_review_flags must be an array of strings', null)
  } else {
    for (const flag of flags.items) pageFlags.push((flag as string).substring(0, MAX_TEXT))
  }

  const rawCandidates = root.value('candidates')
  if (!(rawCandidates instanceof JsonArray)) {
    error('GPT_JSON_INVALID', 'candidates', `candidates must be an array (got ${describe(rawCandidates)})`, null)
    return refuse()
  }
  if (rawCandidates.items.length > MAX_CANDIDATES) {
    error('GPT_JSON_INVALID', 'candidates', `${rawCandidates.items.length} candidates is more than the ${MAX_CANDIDATES} one page can hold`, null)
    return refuse()
  }

  const sliceById = new Map(handoff.slices.map((s) => [s.id, s]))
  const seenIds = new Set<string>()
  const candidates: ImportedCandidate[] = []

  rawCandidates.items.forEach((raw, index) => {
    const at = `candidates[${index}]`
    if (!(raw instanceof JsonObject)) {
      error('GPT_JSON_INVALID', at, `${at} must be an object (got ${describe(raw)})`, null)
      return
    }

    const rawId = raw.value('candidate_id')
    let id = typeof rawId === 'string' ? ktTrim(rawId) : ''
    if (id.length === 0) {
      error('GPT_JSON_INVALID', `${at}.candidate_id`, `${at}.candidate_id must be a non-empty string (got ${describe(rawId)})`, null)
      id = `#${index + 1}`
    } else if (id.length > MAX_REASON) {
      error('GPT_JSON_INVALID', `${at}.candidate_id`, `${at}.candidate_id is longer than ${MAX_REASON} characters`, null)
    } else if (seenIds.has(id)) {
      error('GPT_JSON_INVALID', `${at}.candidate_id`, `Duplicate candidate_id "${id}"`, id)
    }
    seenIds.add(id)

    for (const key of raw.keyList()) {
      if (!CANDIDATE_KEYS.has(key)) warn('UNKNOWN_FIELD', `${at}.${key}`, `Unknown field "${key}" on ${id} was ignored`, id)
    }

    const bounds = coordinateSystem === SLICE_COORDINATES
      ? boundsFromSliceCorners(raw, at, id, handoff, sliceById, error)
      : coordinateSystem === CANONICAL_COORDINATES
        ? boundsFromCanonical(raw, at, id, handoff, error)
        : null

    let reason = ''
    const rawReason = raw.value('reason')
    if (typeof rawReason !== 'string' || isBlank(rawReason)) {
      error('GPT_JSON_INVALID', `${at}.reason`, `${id}: reason must be a non-empty string (got ${describe(rawReason)})`, id)
    } else if (rawReason.length > MAX_REASON) {
      error('GPT_JSON_INVALID', `${at}.reason`, `${id}: reason is longer than ${MAX_REASON} characters`, id)
    } else if (REASON_PATTERN.test(rawReason)) {
      reason = rawReason
    } else {
      reason = normalizeReason(rawReason)
      if (reason.length === 0) {
        error('GPT_JSON_INVALID', `${at}.reason`, `${id}: reason ${describe(rawReason)} has no usable characters`, id)
      } else {
        warn('REASON_NORMALIZED', `${at}.reason`, `${id}: reason ${describe(rawReason)} normalized to "${reason}"`, id)
      }
    }

    // Needed before export, but the review round is where it gets fixed.
    let description = ''
    const rawDescription = raw.value('description')
    if (rawDescription === undefined || rawDescription === JNULL || (typeof rawDescription === 'string' && isBlank(rawDescription))) {
      if (!geometryOnly) warn('DESCRIPTION_MISSING', `${at}.description`, `${id}: no description — one must be written before export`, id)
    } else if (typeof rawDescription !== 'string') {
      error('GPT_JSON_INVALID', `${at}.description`, `${id}: description must be a string (got ${describe(rawDescription)})`, id)
    } else {
      description = ktTrim(rawDescription)
      if (description.length > MAX_TEXT) {
        description = description.substring(0, MAX_TEXT)
        warn('TEXT_TRUNCATED', `${at}.description`, `${id}: description cut to ${MAX_TEXT} characters`, id)
      }
      const words = wordCount(description)
      if (!geometryOnly && (words < 12 || words > 35 || !description.endsWith('.'))) {
        const detail = `has ${words} word${words === 1 ? '' : 's'}${description.endsWith('.') ? '' : ', no final period'}`
        warn('DESCRIPTION_OFF_SPEC', `${at}.description`, `${id}: description should be one sentence of 12–35 words ending in a period (${detail})`, id)
      }
    }

    let evidence = ''
    const rawEvidence = raw.value('visual_evidence')
    if (typeof rawEvidence === 'string' && !isBlank(rawEvidence)) {
      evidence = ktTrim(rawEvidence).substring(0, MAX_TEXT)
    } else if (rawEvidence !== undefined && rawEvidence !== JNULL && typeof rawEvidence !== 'string') {
      error('GPT_JSON_INVALID', `${at}.visual_evidence`, `${id}: visual_evidence must be a string (got ${describe(rawEvidence)})`, id)
    } else {
      warn('EVIDENCE_MISSING', `${at}.visual_evidence`, `${id}: no visual_evidence given`, id)
    }

    const reviewFlags: string[] = []
    const unknownFlags: string[] = []
    const rawFlags = raw.value('review_flags')
    if (rawFlags === undefined) {
      // absent means none
    } else if (!(rawFlags instanceof JsonArray) || rawFlags.items.some((it) => typeof it !== 'string')) {
      error('GPT_JSON_INVALID', `${at}.review_flags`, `${id}: review_flags must be an array of strings`, id)
    } else {
      for (const flag of rawFlags.items) {
        const clean = ktTrim(flag as string).substring(0, MAX_REASON)
        if (REVIEW_FLAGS.includes(clean)) {
          if (!reviewFlags.includes(clean)) reviewFlags.push(clean)
        } else if (clean.length > 0) {
          unknownFlags.push(clean)
          warn('UNKNOWN_REVIEW_FLAG', `${at}.review_flags`, `${id}: review flag ${describe(clean)} is not in the vocabulary; kept as a note only`, id)
        }
      }
    }

    const rotate = parseRotation(raw.value('rotate'))
    if (rotate === undefined) {
      error('GPT_JSON_INVALID', `${at}.rotate`, `${id}: rotate must be 90, -90 or left out (got ${describe(raw.value('rotate'))})`, id)
    }

    if (bounds !== null) {
      candidates.push({
        candidateId: id,
        reason,
        bounds,
        description,
        visualEvidence: evidence,
        reviewFlags,
        unknownFlags,
        slices: slicesSpanned(bounds, handoff.slices),
        ...(rotate ? { rotate } : {}),
      })
    }
  })

  if (errors.length > 0) return refuse()

  if (candidates.length === 0) {
    warn('EMPTY_CANDIDATES', 'candidates', 'ChatGPT proposed no crops. Export will need an explicit confirmation that this page has no eligible artwork.')
  }
  if (inspectionComplete === false) {
    warn('GPT_VISUAL_UNCERTAINTY', 'page_inspection_complete', 'ChatGPT says it could not fully inspect the page — check its page flags and sweep the page yourself')
  }

  // Reading order: top to bottom, then left to right (a stable sort, like Kotlin's sortWith).
  candidates.sort((a, b) => a.bounds.y0 - b.bounds.y0 || a.bounds.x0 - b.bounds.x0)

  return {
    analysis: {
      jobId: handoff.jobId,
      sourceSha256: source.sha256,
      pageStem: source.pageStem,
      sourceWidth: source.width,
      sourceHeight: source.height,
      replyCoordinateSystem: coordinateSystem as string,
      responseSha256: sha256Hex(content),
      pageInspectionComplete: inspectionComplete as boolean,
      pageReviewFlags: pageFlags,
      candidates,
      warnings: [...warnings],
    },
    errors,
    warnings,
  }
}

// Geometry

function readInteger(value: JsonValue | undefined, field: string, id: string, error: IssueSink): number | null {
  const name = field.split('.').slice(-2).join('.')
  if (!isNumber(value)) {
    error('GPT_COORDINATES_INVALID', field, `${id}: ${name} must be a number (got ${describe(value)})`, id)
    return null
  }
  const whole = wholeNumber(value)
  if (whole === null) {
    error('GPT_COORDINATES_INVALID', field, `${id}: ${name} must be a whole pixel (got ${describe(value)})`, id)
    return null
  }
  if (whole < -(2n ** 31n) || whole > 2n ** 31n - 1n) {
    error('GPT_COORDINATES_INVALID', field, `${id}: ${name} ${whole} is far outside the page`, id)
    return null
  }
  return Number(whole)
}

/** Rejects an inverted or out-of-page box. Never clamps. */
function checkBounds(bounds: Box, at: string, id: string, handoff: Handoff, sink: IssueSink): Box | null {
  const width = handoff.source.width
  const height = handoff.source.height
  let ok = true
  const error: IssueSink = (code, field, message, candidate) => {
    ok = false
    sink(code, field, message, candidate)
  }
  if (bounds.x0 < 0 || bounds.x1 > width) {
    error('GPT_COORDINATES_INVALID', at, `${id}: x ${bounds.x0}–${bounds.x1} runs outside the page width 0–${width}`, id)
  }
  if (bounds.y0 < 0 || bounds.y1 > height) {
    error('GPT_COORDINATES_INVALID', at, `${id}: y ${bounds.y0}–${bounds.y1} runs outside the page height 0–${height}`, id)
  }
  if (bounds.x1 <= bounds.x0 || bounds.y1 <= bounds.y0) {
    error(
      'GPT_COORDINATES_INVALID', at,
      `${id}: box (${bounds.x0},${bounds.y0})–(${bounds.x1},${bounds.y1}) has no area — the bottom-right corner must be below and right of the top-left`,
      id,
    )
  }
  return ok ? bounds : null
}

function boundsFromCanonical(raw: JsonObject, at: string, id: string, handoff: Handoff, error: IssueSink): Box | null {
  const b = raw.value('bounds')
  if (!(b instanceof JsonObject)) {
    error('GPT_COORDINATES_INVALID', `${at}.bounds`, `${id}: bounds must be an object {x0, y0, x1, y1} (got ${describe(b)})`, id)
    return null
  }
  const x0 = readInteger(b.value('x0'), `${at}.bounds.x0`, id, error)
  const y0 = readInteger(b.value('y0'), `${at}.bounds.y0`, id, error)
  const x1 = readInteger(b.value('x1'), `${at}.bounds.x1`, id, error)
  const y1 = readInteger(b.value('y1'), `${at}.bounds.y1`, id, error)
  if (x0 === null || y0 === null || x1 === null || y1 === null) return null
  return checkBounds({ x0, y0, x1, y1 }, `${at}.bounds`, id, handoff, error)
}

/** Converts `top_left` / `bottom_right` slice-local corners to a page box, checking each in its own slice. */
export function boundsFromSliceCorners(
  raw: JsonObject,
  at: string,
  id: string,
  handoff: Handoff,
  sliceById: Map<string, HandoffSlice>,
  error: IssueSink,
): Box | null {
  const corner = (name: string): [number, number] | null => {
    const value = raw.value(name)
    const field = `${at}.${name}`
    if (!(value instanceof JsonObject)) {
      error('GPT_COORDINATES_INVALID', field, `${id}: ${name} must be an object {slice_id, x, y} (got ${describe(value)})`, id)
      return null
    }
    const sliceId = value.value('slice_id')
    const slice = typeof sliceId === 'string' ? sliceById.get(sliceId) : undefined
    if (slice === undefined) {
      error(
        'GPT_COORDINATES_INVALID', `${field}.slice_id`,
        `${id}: ${name}.slice_id ${describe(sliceId)} is not one of this page's slices (${[...sliceById.keys()].join(', ')})`,
        id,
      )
      return null
    }
    const x = readInteger(value.value('x'), `${field}.x`, id, error)
    const y = readInteger(value.value('y'), `${field}.y`, id, error)
    if (x === null || y === null) return null
    // Checked in the slice's own grid first, so the message points at the number ChatGPT wrote.
    if (x < 0 || x > slice.width) {
      error('GPT_COORDINATES_INVALID', `${field}.x`, `${id}: ${name}.x ${x} is outside ${slice.id}'s width 0–${slice.width}`, id)
      return null
    }
    if (y < 0 || y > slice.height) {
      error('GPT_COORDINATES_INVALID', `${field}.y`, `${id}: ${name}.y ${y} is outside ${slice.id}'s height 0–${slice.height}`, id)
      return null
    }
    return [(slice.x0 ?? 0) + x, slice.y0 + y]
  }

  const topLeft = corner('top_left')
  const bottomRight = corner('bottom_right')
  if (topLeft === null || bottomRight === null) return null
  return checkBounds({ x0: topLeft[0], y0: topLeft[1], x1: bottomRight[0], y1: bottomRight[1] }, at, id, handoff, error)
}

