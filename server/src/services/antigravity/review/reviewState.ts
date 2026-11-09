/**
 * Port of the phone's CropReview.kt (geometry-only use): the review state between ChatGPT's first answer
 * and the export, the checks shown per crop, what still blocks the page, and applying a review reply.
 * Every current crop must come back kept, changed, split, merged or removed; a check counts as reviewed
 * only when ChatGPT names its token for a box it didn't move. Pure.
 */
import { boundsFromSliceCorners, normalizeReason, stripMarkdownFence, type IssueSink } from './analysisImport.js'
import { GAP_ARTWORK_INK } from './cropAudit.js'
import { describe, isBlank, javaDoubleToString, JsonArray, JsonNumber, JsonObject, ktTrim, parseJson, stringify, toPlain, wholeNumber, type JsonValue } from './json.js'
import {
  boxEquals, boxHeight, boxWidth,
  type AuditFinding, type AuditReport, type Blocker, type Box, type Handoff, type HandoffSlice, type ImportedAnalysis,
  type ImportIssue, type ReviewCrop, type ReviewItem, type ReviewReplyParse, type ReviewState,
} from './types.js'

export const REVIEW_REPLY_SCHEMA = 'chatgpt-review/1.0'
/** The geometry-only review reply: REVIEW_REPLY_SCHEMA without descriptions. */
export const GEOMETRY_REVIEW_SCHEMA = 'clipper-review-geometry/1.0'
export const REVIEW_STATE_SCHEMA = 'crop-studio-review/1.0'
const MAX_TEXT = 1000
const MAX_KEY = 120
const MAX_CROPS = 500

export function seed(analysis: ImportedAnalysis, now: string): ReviewState {
  return {
    jobId: analysis.jobId,
    sourceSha256: analysis.sourceSha256,
    sourceWidth: analysis.sourceWidth,
    sourceHeight: analysis.sourceHeight,
    pageStem: analysis.pageStem,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    basedOnResponseSha256: analysis.responseSha256,
    crops: analysis.candidates.map((c) => ({
      key: c.candidateId,
      origin: 'chatgpt',
      reason: c.reason,
      bounds: { ...c.bounds },
      description: c.description,
      descriptionStatus: c.description.length > 0 ? 'unreviewed' : 'missing',
      disposition: 'unreviewed',
      visualEvidence: c.visualEvidence,
      gptFlags: [...c.reviewFlags],
      unknownFlags: [...c.unknownFlags],
      acknowledged: [],
      note: '',
    })),
    page: { sweepDone: false, noEligibleArtworkConfirmed: false, note: '' },
    chatgptReviews: 0,
  }
}

/** The audit's crop list for [state]: (key, bounds) in crop order, plus each key's reason for FILLER_REASON. */
export function auditInput(state: ReviewState): { crops: [string, Box][]; reasons: Map<string, string> } {
  return {
    crops: state.crops.map((c) => [c.key, c.bounds] as [string, Box]),
    reasons: new Map(state.crops.map((c) => [c.key, c.reason])),
  }
}

/** Every check on every crop: audit findings first, then ChatGPT's own flags as `gpt:<flag>`. */
export function items(state: ReviewState, findings: AuditFinding[]): ReviewItem[] {
  return state.crops.flatMap((crop) => {
    const acked = new Set(crop.acknowledged)
    return [
      ...findings.filter((f) => f.key === crop.key).map((f) => ({ token: f.token, key: crop.key, code: f.code, message: f.message, acknowledged: acked.has(f.token) })),
      ...crop.gptFlags.map((flag) => {
        const token = `gpt:${flag}`
        return { token, key: crop.key, code: flag, message: `ChatGPT flagged: ${flag.replaceAll('_', ' ')}`, acknowledged: acked.has(token) }
      }),
    ]
  })
}

/** What still stands between the review and the export. Studio's Classic flow passes geometryOnly = true. */
export function blockers(state: ReviewState, reviewItems: ReviewItem[], geometryOnly = false, requireInspection = false): Blocker[] {
  const out: Blocker[] = []
  for (const crop of state.crops) {
    if (crop.disposition === 'unreviewed') out.push({ code: 'CROP_UNREVIEWED', message: `${crop.key}: not reviewed yet`, key: crop.key })
    else if (crop.disposition === 'unresolved') out.push({ code: 'CROP_UNRESOLVED', message: `${crop.key}: marked unresolved`, key: crop.key })
    const open = reviewItems.filter((it) => it.key === crop.key && !it.acknowledged)
    if (open.length > 0) {
      const count = open.length
      out.push({
        code: 'FINDING_UNACKNOWLEDGED',
        message: `${crop.key}: ${count} flag${count === 1 ? '' : 's'} not yet reviewed (${open.map((it) => it.code).join(', ')})`,
        key: crop.key,
      })
    }
    if (!geometryOnly && crop.descriptionStatus !== 'approved') {
      out.push({ code: 'DESCRIPTION_NOT_APPROVED', message: `${crop.key}: description is ${crop.descriptionStatus}`, key: crop.key })
    }
    if (requireInspection && crop.descriptionStatus !== 'inspected') {
      out.push({ code: 'CROP_NOT_INSPECTED', message: `${crop.key}: actual crop inspection pending`, key: crop.key })
    }
  }
  if (!state.page.sweepDone) out.push({ code: 'SWEEP_NOT_DONE', message: 'The top-to-bottom page sweep for missed artwork is not done', key: null })
  if (state.crops.length === 0 && !state.page.noEligibleArtworkConfirmed) {
    out.push({ code: 'EMPTY_NOT_CONFIRMED', message: 'No crops: confirm this page has no eligible artwork', key: null })
  }
  return out
}

// Slice-local <-> page

export interface SliceLocal {
  slice: HandoffSlice
  y: number
}

/** The slice a page y falls in, and y inside it. [end] picks the slice a bottom edge closes. */
export function toSliceLocal(y: number, slices: HandoffSlice[], end: boolean): SliceLocal {
  if (slices.length === 0) throw new Error('The handoff has no slices')
  const slice = slices.find((s) => (end ? y > s.y0 && y <= s.y1 : y >= s.y0 && y < s.y1))
    ?? (end ? slices[slices.length - 1]! : slices[0]!)
  return { slice, y: y - slice.y0 }
}

/** A slice-local corner as the prompts write it. */
export type SliceCorner = {
  slice_id: string
  x: number
  y: number
}

/** A page box's corners in slice grids: top-left in the slice its top starts, bottom-right in the slice its bottom closes. */
export function sliceCorners(bounds: Box, slices: HandoffSlice[]): [SliceCorner, SliceCorner] {
  const top = toSliceLocal(bounds.y0, slices, false)
  const bottom = toSliceLocal(bounds.y1, slices, true)
  return [
    { slice_id: top.slice.id, x: bounds.x0, y: top.y },
    { slice_id: bottom.slice.id, x: bounds.x1, y: bottom.y },
  ]
}

/** A slice-local corner back on the page (the inverse of [sliceCorners]; no range checks — see boundsFromSliceCorners). */
export function cornerToPage(corner: SliceCorner, slices: HandoffSlice[]): { x: number; y: number } | null {
  const slice = slices.find((s) => s.id === corner.slice_id)
  return slice ? { x: (slice.x0 ?? 0) + corner.x, y: slice.y0 + corner.y } : null
}

/** One entry of the review prompt's CURRENT CROPS list (key order as on the phone). */
export type CurrentCrop = {
  number: number
  key: string
  reason: string
  top_left: SliceCorner
  bottom_right: SliceCorner
  size_px: string
  description: string
  checks: { token: string; what: string }[]
}

/** The current crops as the review prompts list them, with their corners in slice grids and their checks. */
export function currentCrops(state: ReviewState, reviewItems: ReviewItem[], slices: HandoffSlice[]): CurrentCrop[] {
  return state.crops.map((crop, i) => {
    const [topLeft, bottomRight] = sliceCorners(crop.bounds, slices)
    return {
      number: i + 1,
      key: crop.key,
      reason: crop.reason,
      top_left: { ...topLeft },
      bottom_right: { ...bottomRight },
      size_px: `${boxWidth(crop.bounds)}×${boxHeight(crop.bounds)}`,
      description: crop.description,
      checks: reviewItems.filter((it) => it.key === crop.key).map((it) => ({ token: it.token, what: it.message })),
    }
  })
}

/**
 * The sweep's uncovered stretches. Only stretches inked like artwork are pointed at; the rest are counted,
 * so background, bubbles and lettering between shots aren't presented as misses.
 */
export function sweepLines(audit: AuditReport, slices: HandoffSlice[]): string[] {
  const quietGaps = audit.gaps.filter((g) => g.inkShare !== null && g.inkShare < GAP_ARTWORK_INK).length
  const gaps = audit.gaps.filter((g) => g.inkShare === null || g.inkShare >= GAP_ARTWORK_INK).map((gap) => {
    const from = toSliceLocal(gap.y0, slices, false)
    const to = toSliceLocal(gap.y1, slices, true)
    return `  ${from.slice.id} y ${from.y} → ${to.slice.id} y ${to.y}` +
      (gap.inkShare !== null ? ` (${Math.floor(gap.inkShare * 100 + 0.5)}% ink)` : '')
  })
  const quietLine = quietGaps === 0
    ? []
    : quietGaps === 1
      ? ['1 other uncovered stretch looks like plain background, bubbles or lettering — leave it uncovered unless you see a real subject there.']
      : [`${quietGaps} other uncovered stretches look like plain background, bubbles or lettering — leave them uncovered unless you see a real subject there.`]
  return [...(gaps.length > 0 ? gaps : ['  (none)']), ...quietLine]
}

// Applying a review reply

interface Draft {
  raw: JsonObject
  at: string
  key: string | null
  from: string[]
  bounds: Box | null
}

function stringItems(value: JsonValue | undefined): string[] {
  return value instanceof JsonArray ? value.items.filter((it): it is string => typeof it === 'string') : []
}

/**
 * Checks a review reply against [state] (and the checks it was shown, [reviewItems]) and returns the next
 * revision, or the reasons it was refused. [geometryOnly] reads a GEOMETRY_REVIEW_SCHEMA reply (Studio's
 * Classic flow): descriptions are kept for boxes that didn't move, and moved/merged ones go stale.
 */
export function applyReply(
  content: string,
  state: ReviewState,
  reviewItems: ReviewItem[],
  handoff: Handoff,
  now: string,
  geometryOnly = false,
): ReviewReplyParse {
  const errors: ImportIssue[] = []
  const warnings: ImportIssue[] = []
  const error: IssueSink = (code, field, message, id) => {
    errors.push({ code, field, message, candidateId: id })
  }
  const fail = (): ReviewReplyParse => ({ state: null, errors, warnings, changed: false })

  const [text, stripped] = stripMarkdownFence(content)
  if (stripped) warnings.push({ code: 'MARKDOWN_FENCE_STRIPPED', field: '', message: 'The reply was wrapped in a Markdown code fence; the fence was removed', candidateId: null })

  let root: JsonValue
  try {
    root = parseJson(text)
  } catch (e) {
    error('GPT_JSON_INVALID', '', `The reply is not valid JSON: ${(e as Error).message}`, null)
    return fail()
  }
  if (!(root instanceof JsonObject)) {
    error('GPT_JSON_INVALID', '', 'The reply must be one JSON object', null)
    return fail()
  }

  const schema = geometryOnly ? GEOMETRY_REVIEW_SCHEMA : REVIEW_REPLY_SCHEMA
  if (root.value('schema_version') !== schema) {
    error('GPT_JSON_INVALID', 'schema_version', `schema_version must be "${schema}" — is this the reply to the REVIEW prompt?`, null)
  }
  if (root.value('job_id') !== handoff.jobId) {
    error('GPT_PAGE_MISMATCH', 'job_id', `job_id is ${describe(root.value('job_id'))} but this page's is ${handoff.jobId}`, null)
  }
  const sha = root.value('source_sha256')
  if (typeof sha !== 'string' || sha.toLowerCase() !== handoff.source.sha256) {
    error('GPT_PAGE_MISMATCH', 'source_sha256', 'source_sha256 does not match this page', null)
  }
  const revision = root.value('review_revision')
  if (typeof revision === 'boolean' || wholeNumber(revision) !== BigInt(state.revision)) {
    error(
      'GPT_PAGE_MISMATCH', 'review_revision',
      `The reply answers revision ${describe(revision)} but the review is now at ${state.revision} — copy the fix prompt again`,
      null,
    )
  }
  if (root.value('coordinate_system') !== 'slice_local_pixels') {
    error('GPT_COORDINATES_INVALID', 'coordinate_system', 'coordinate_system must be "slice_local_pixels"', null)
  }
  const rawCrops = root.value('crops')
  if (!(rawCrops instanceof JsonArray)) {
    error('GPT_JSON_INVALID', 'crops', 'crops must be an array', null)
    return fail()
  }
  if (errors.length > 0) return fail()

  const current = new Map(state.crops.map((c) => [c.key, c]))
  const tokensByKey = new Map<string, Set<string>>()
  for (const it of reviewItems) {
    if (!tokensByKey.has(it.key)) tokensByKey.set(it.key, new Set())
    tokensByKey.get(it.key)!.add(it.token)
  }
  const sliceById = new Map(handoff.slices.map((s) => [s.id, s]))
  const accounted = new Map<string, string>() // key -> where
  const account = (key: string, where: string, field: string): boolean => {
    if (!current.has(key)) {
      error('GPT_JSON_INVALID', field, `"${key}" is not one of the current crops (${[...current.keys()].join(', ')})`, null)
      return false
    }
    const before = accounted.get(key)
    if (before !== undefined && before !== where) {
      error('GPT_JSON_INVALID', field, `"${key}" appears more than once (${before} and ${where})`, null)
      return false
    }
    accounted.set(key, where)
    return true
  }

  const drafts: Draft[] = []
  rawCrops.items.forEach((raw, index) => {
    const at = `crops[${index}]`
    if (!(raw instanceof JsonObject)) {
      error('GPT_JSON_INVALID', at, `${at} must be an object`, null)
      return
    }
    const rawKey = raw.value('key')
    const trimmedKey = typeof rawKey === 'string' ? ktTrim(rawKey) : ''
    const key = trimmedKey.length > 0 ? trimmedKey : null
    const from = stringItems(raw.value('from_keys'))
      .filter((it) => !isBlank(it) && !it.startsWith('<'))
      .map((it) => ktTrim(it))
    const label = key ?? `new crop #${index + 1}`
    if (key !== null) account(key, `crops[${index}].key`, `${at}.key`)
    const bounds = boundsFromSliceCorners(raw, at, label, handoff, sliceById, error)
    drafts.push({ raw, at, key, from, bounds })
  })

  // A split parent may feed several parts; a merge consumes its extra keys once.
  const splitParents = new Map<string, number>()
  for (const d of drafts) {
    if (d.key !== null) {
      for (const it of d.from.filter((f) => f !== d.key)) account(it, `merged into ${d.key}`, `${d.at}.from_keys`)
    } else if (d.from.length === 1) {
      const parent = d.from[0]!
      if (!current.has(parent)) error('GPT_JSON_INVALID', `${d.at}.from_keys`, `"${parent}" is not one of the current crops`, null)
      else splitParents.set(parent, (splitParents.get(parent) ?? 0) + 1)
    } else if (d.from.length > 1) {
      for (const it of d.from) account(it, 'merged into a new crop', `${d.at}.from_keys`)
    }
  }
  for (const parent of splitParents.keys()) account(parent, 'split', 'from_keys')

  const removed = stringItems(root.value('removed_keys'))
  for (const key of removed) account(key, 'removed_keys', 'removed_keys')

  const missing = [...current.keys()].filter((k) => !accounted.has(k))
  if (missing.length > 0) {
    error(
      'GPT_JSON_INVALID', 'crops',
      `Not accounted for: ${missing.join(', ')}. Every current crop must be kept, changed, merged, split or listed in "removed_keys".`,
      null,
    )
  }
  if (errors.length > 0) return fail()
  if (drafts.length > MAX_CROPS) {
    error('GPT_JSON_INVALID', 'crops', `At most ${MAX_CROPS} crops`, null)
    return fail()
  }

  const redescribe = new Set(stringItems(root.value('redescribe_keys')).map((it) => ktTrim(it)))
  if (geometryOnly) {
    for (const it of redescribe) {
      if (!current.has(it)) {
        warnings.push({ code: 'UNKNOWN_KEY', field: 'redescribe_keys', message: `redescribe_keys: "${it}" is not one of the current crops; ignored`, candidateId: null })
      }
    }
  }

  const taken = new Set(state.crops.map((c) => c.key))
  const crops: ReviewCrop[] = []
  for (const d of drafts) {
    const bounds = d.bounds!
    const rawReason = d.raw.value('reason')
    const reasonRaw = typeof rawReason === 'string' ? normalizeReason(rawReason.substring(0, MAX_KEY)) : ''
    const rawDescription = d.raw.value('description')
    const description = typeof rawDescription === 'string' ? ktTrim(rawDescription).substring(0, MAX_TEXT) : ''
    const reviewed = stringItems(d.raw.value('checks_reviewed'))
    const label = d.key ?? `new crop (${d.at})`
    if (description.length === 0 && !geometryOnly) {
      warnings.push({ code: 'DESCRIPTION_MISSING', field: `${d.at}.description`, message: `${label}: no description — it stays unapproved`, candidateId: null })
    }

    if (d.key !== null) {
      const base = current.get(d.key)!
      const merged = d.from.some((f) => f !== d.key)
      const moved = !boxEquals(base.bounds, bounds)
      // A moved box is a different box, so its checks start over, and an approved description that didn't
      // change with it goes stale.
      let status = description.length > 0 ? 'approved' : 'missing'
      if (moved && status === 'approved' && description === base.description) status = 'stale'
      if (geometryOnly) {
        if (base.descriptionStatus === 'inspected' && !moved && !merged && !redescribe.has(d.key)) status = 'inspected'
        else if (base.description.length === 0) status = 'missing'
        else if (moved || merged || redescribe.has(d.key)) status = 'stale'
        else status = base.descriptionStatus
      }
      const tokens = tokensByKey.get(d.key)
      crops.push({
        ...base,
        bounds,
        reason: reasonRaw.length > 0 ? reasonRaw : base.reason,
        description: geometryOnly ? base.description : description,
        descriptionStatus: status,
        disposition: merged ? 'merged' : moved ? 'adjusted' : 'kept',
        acknowledged: moved ? [] : [...new Set(reviewed.filter((it) => tokens?.has(it) === true))],
      })
    } else {
      const parent = d.from.length === 1 ? current.get(d.from[0]!) ?? null : null
      let key: string
      if (parent !== null) {
        const letter = String.fromCharCode('a'.charCodeAt(0) + crops.filter((c) => c.key.startsWith(`${parent.key}.`)).length)
        key = freeKey(`${parent.key}.${letter}`, taken)
      } else {
        key = nextOperatorKey(taken)
      }
      taken.add(key)
      crops.push({
        key,
        origin: 'operator',
        reason: reasonRaw.length > 0 ? reasonRaw : parent?.reason ?? 'chatgpt_crop',
        bounds,
        description: geometryOnly ? '' : description,
        descriptionStatus: description.length > 0 && !geometryOnly ? 'approved' : 'missing',
        disposition: parent !== null ? 'split' : d.from.length > 1 ? 'merged' : 'adjusted',
        visualEvidence: '',
        gptFlags: [],
        unknownFlags: [],
        acknowledged: [],
        note: parent !== null
          ? `Split by ChatGPT review from ${parent.key}`
          : d.from.length > 1 ? `Merged by ChatGPT review from ${d.from.join(', ')}` : 'Added by ChatGPT review',
      })
    }
  }

  const rawNotes = root.value('notes')
  const notes = typeof rawNotes === 'string' ? ktTrim(rawNotes).substring(0, 500) : ''
  const next: ReviewState = {
    ...state,
    revision: state.revision + 1,
    updatedAt: now,
    crops,
    page: {
      sweepDone: root.value('sweep_done') === true,
      noEligibleArtworkConfirmed: root.value('page_has_no_artwork') === true && crops.length === 0,
      note: [state.page.note, notes.length > 0 ? `ChatGPT: ${notes}` : ''].filter((n) => n.length > 0).join('\n').substring(0, 2000),
    },
    chatgptReviews: state.chatgptReviews + 1,
  }
  const changed = removed.length > 0 || crops.some((c) => c.disposition !== 'kept')
  return { state: next, errors, warnings, changed }
}

function freeKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

function nextOperatorKey(taken: Set<string>): string {
  let n = 1
  while (taken.has(`op-${String(n).padStart(2, '0')}`)) n++
  return `op-${String(n).padStart(2, '0')}`
}

// Storing

/** The phone's review-state.json (`crop-studio-review/1.0`), byte for byte, ending in a newline. */
export function toJson(state: ReviewState): string {
  return stringify({
    schema_version: REVIEW_STATE_SCHEMA,
    job_id: state.jobId,
    source_sha256: state.sourceSha256,
    source_width: state.sourceWidth,
    source_height: state.sourceHeight,
    page_stem: state.pageStem,
    review_revision: state.revision,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
    based_on: { kind: 'chatgpt_import', response_sha256: state.basedOnResponseSha256 },
    crops: state.crops.map((c) => ({
      key: c.key,
      origin: c.origin,
      reason: c.reason,
      bounds: { x0: c.bounds.x0, y0: c.bounds.y0, x1: c.bounds.x1, y1: c.bounds.y1 },
      description: c.description,
      description_status: c.descriptionStatus,
      disposition: c.disposition,
      visual_evidence: c.visualEvidence,
      gpt_flags: c.gptFlags,
      unknown_flags: c.unknownFlags,
      acknowledged: c.acknowledged,
      note: c.note,
    })),
    page: {
      sweep_done: state.page.sweepDone,
      no_eligible_artwork_confirmed: state.page.noEligibleArtworkConfirmed,
      note: state.page.note,
    },
    chatgpt_reviews: state.chatgptReviews,
  }, true) + '\n'
}

// Android JSONObject getters, as CropReview.parse uses them.

function need(o: JsonObject, name: string): JsonValue {
  const v = o.value(name)
  if (v === undefined) throw new Error(`No value for ${name}`)
  return v
}
function asString(v: JsonValue | undefined): string | null {
  if (v === undefined) return null
  if (typeof v === 'string') return v
  if (v instanceof JsonNumber) return v.kind === 'double' ? javaDoubleToString(v.value) : v.big?.toString() ?? String(v.value)
  return v instanceof JsonObject || v instanceof JsonArray ? stringify(toPlain(v)) : String(v)
}
function getString(o: JsonObject, name: string): string {
  const s = asString(need(o, name))
  if (s === null) throw new Error(`${name} is not a string`)
  return s
}
function optString(o: JsonObject, name: string): string {
  return asString(o.value(name)) ?? ''
}
function asInt(v: JsonValue | undefined): number | null {
  if (v instanceof JsonNumber) return v.kind === 'long' && v.big !== null ? Number(BigInt.asIntN(32, v.big)) : Math.trunc(v.value) | 0
  if (typeof v === 'string') {
    const d = Number(v.trim())
    return Number.isNaN(d) || v.trim() === '' ? null : Math.trunc(d) | 0
  }
  return null
}
function getInt(o: JsonObject, name: string): number {
  const n = asInt(need(o, name))
  if (n === null) throw new Error(`${name} is not an int`)
  return n
}
function getObject(o: JsonObject, name: string): JsonObject {
  const v = need(o, name)
  if (!(v instanceof JsonObject)) throw new Error(`${name} is not an object`)
  return v
}
function optBoolean(o: JsonObject, name: string): boolean {
  const v = o.value(name)
  return v === true || (typeof v === 'string' && v.toLowerCase() === 'true')
}

/** Reads a stored review state, or null if it isn't one (CropReview.parse). */
export function parseState(text: string): ReviewState | null {
  try {
    const root = parseJson(text)
    if (!(root instanceof JsonObject)) return null
    const page = getObject(root, 'page')
    const cropsValue = need(root, 'crops')
    if (!(cropsValue instanceof JsonArray)) return null
    return {
      jobId: getString(root, 'job_id'),
      sourceSha256: getString(root, 'source_sha256'),
      sourceWidth: getInt(root, 'source_width'),
      sourceHeight: getInt(root, 'source_height'),
      pageStem: getString(root, 'page_stem'),
      revision: getInt(root, 'review_revision'),
      createdAt: getString(root, 'created_at'),
      updatedAt: getString(root, 'updated_at'),
      basedOnResponseSha256: getString(getObject(root, 'based_on'), 'response_sha256'),
      crops: cropsValue.items.map((item) => {
        if (!(item instanceof JsonObject)) throw new Error('crop is not an object')
        const b = getObject(item, 'bounds')
        return {
          key: getString(item, 'key'),
          origin: getString(item, 'origin'),
          reason: getString(item, 'reason'),
          bounds: { x0: getInt(b, 'x0'), y0: getInt(b, 'y0'), x1: getInt(b, 'x1'), y1: getInt(b, 'y1') },
          description: getString(item, 'description'),
          descriptionStatus: getString(item, 'description_status'),
          disposition: getString(item, 'disposition'),
          visualEvidence: optString(item, 'visual_evidence'),
          gptFlags: stringItems(item.value('gpt_flags')),
          unknownFlags: stringItems(item.value('unknown_flags')),
          acknowledged: stringItems(item.value('acknowledged')),
          note: optString(item, 'note'),
        }
      }),
      page: { sweepDone: optBoolean(page, 'sweep_done'), noEligibleArtworkConfirmed: optBoolean(page, 'no_eligible_artwork_confirmed'), note: optString(page, 'note') },
      chatgptReviews: asInt(root.value('chatgpt_reviews')) ?? 0,
    }
  } catch {
    return null
  }
}
