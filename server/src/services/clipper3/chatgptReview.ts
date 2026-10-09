/**
 * Crop Studio — letting ChatGPT do the review round instead of the operator.
 *
 * Two halves:
 *
 *  - buildReviewPrompt: a prompt for the SAME ChatGPT conversation that already
 *    holds the page's slices. It lists every current crop (in slice-local
 *    corners, the way ChatGPT measured them), each crop's open checks by token,
 *    and the stretches no crop covers, and asks for the complete FINAL crop
 *    list back as `chatgpt-review/1.0`.
 *  - applyChatGptReview: validates that reply against the page's package and
 *    the review revision the prompt was built from, turns it into a review
 *    save (kept / adjusted / split / merged / new / removed, descriptions
 *    approved, checks acknowledged, sweep done) and stores it through the same
 *    save rules as a manual edit.
 *
 * What stays honest:
 *  - every current crop must be accounted for — kept, changed, merged, split
 *    or explicitly listed in `removed_keys`; nothing disappears by omission;
 *  - a check is acknowledged only when ChatGPT names its token, and only for a
 *    crop whose box did not change. A box ChatGPT moves gets fresh checks,
 *    which show up in the next review prompt (a second round usually settles);
 *  - the review records that ChatGPT gave these approvals, and the export
 *    report says so.
 */

import { createHash } from 'crypto'
import { getHandoffStatus, type HandoffManifest, type HandoffSlice } from './handoff.js'
import {
  boundsFromSliceCorners,
  normalizeReason,
  type ImportIssue,
  type ImportIssueCode,
  type PixelBounds
} from './analysisImport.js'
import {
  applyReviewSave,
  getReview,
  writeReviewState,
  ReviewError,
  type ReviewCrop,
  type ReviewState,
  type ReviewView
} from './reviewState.js'

export const REVIEW_REPLY_SCHEMA = 'chatgpt-review/1.0'

const MAX_TEXT = 1000

// ============ Prompt ============

/** The slice a page-y falls in, and y inside it. `end` picks the slice a bottom edge closes. */
function toSliceLocal(y: number, slices: HandoffSlice[], end: boolean): { slice: HandoffSlice; y: number } {
  const slice = slices.find(s => (end ? y > s.y0 && y <= s.y1 : y >= s.y0 && y < s.y1)) ?? (end ? slices[slices.length - 1] : slices[0])
  return { slice, y: y - slice.y0 }
}

export function cornersFor(bounds: PixelBounds, slices: HandoffSlice[]) {
  const top = toSliceLocal(bounds.y0, slices, false)
  const bottom = toSliceLocal(bounds.y1, slices, true)
  return {
    top_left: { slice_id: top.slice.id, x: bounds.x0, y: top.y },
    bottom_right: { slice_id: bottom.slice.id, x: bounds.x1, y: bottom.y }
  }
}

/** The review prompt for the current revision. Pure. */
export function buildReviewPrompt(view: ReviewView & { state: ReviewState }, manifest: HandoffManifest): string {
  const { state, items, audit } = view
  const slices = manifest.slices

  const crops = state.crops.map((crop, i) => ({
    number: i + 1,
    key: crop.key,
    reason: crop.reason,
    ...cornersFor(crop.bounds, slices),
    size_px: `${crop.bounds.x1 - crop.bounds.x0}×${crop.bounds.y1 - crop.bounds.y0}`,
    description: crop.description,
    checks: items.filter(i => i.key === crop.key).map(i => ({ token: i.token, what: i.message }))
  }))

  const gaps = (audit?.gaps ?? []).map(g => {
    const from = toSliceLocal(g.y0, slices, false)
    const to = toSliceLocal(g.y1, slices, true)
    return `  ${from.slice.id} y ${from.y} → ${to.slice.id} y ${to.y}` +
      (g.nonBlankShare === null ? '' : ` (${Math.round(g.nonBlankShare * 100)}% non-blank rows)`)
  })

  const example = {
    schema_version: REVIEW_REPLY_SCHEMA,
    job_id: manifest.job_id,
    source_sha256: manifest.source.sha256,
    review_revision: state.review_revision,
    coordinate_system: 'slice_local_pixels',
    crops: [
      {
        key: crops[0]?.key ?? 'candidate-01',
        reason: crops[0]?.reason ?? 'framed_reaction',
        top_left: crops[0]?.top_left ?? { slice_id: slices[0].id, x: 0, y: 0 },
        bottom_right: crops[0]?.bottom_right ?? { slice_id: slices[0].id, x: manifest.source.width, y: Math.min(500, slices[0].height) },
        description: 'One plain sentence of 12–35 words describing only what is visible in this crop.',
        checks_reviewed: crops[0]?.checks.map(c => c.token) ?? []
      },
      {
        key: null,
        from_keys: ['<key of the crop this was split from, or the keys merged into it; omit for a brand-new crop>'],
        reason: 'new_or_split_part',
        top_left: { slice_id: slices[0].id, x: 0, y: 0 },
        bottom_right: { slice_id: slices[0].id, x: 100, y: 100 },
        description: '…',
        checks_reviewed: []
      }
    ],
    removed_keys: [],
    sweep_done: true,
    page_has_no_artwork: false,
    notes: ''
  }

  return [
    `REVIEW ROUND for "${manifest.source.page_stem}" — use the ${slices.length} slices of this page already attached earlier in this conversation (${slices.map(s => s.id).join(', ')}, ${manifest.source.width}×${manifest.source.height} px in total).`,
    '',
    'Below are the crops currently proposed for this page. Act as the reviewer. Look at every crop again in the slices and decide its FINAL form:',
    '- keep it exactly (same corners),',
    '- adjust its corners so it holds the complete shot — whole faces, hands, weapons, effects — and nothing from the neighbouring shot,',
    '- split it when it actually contains separate shots (return each part as a new crop with "from_keys": [its key]),',
    '- merge crops that are really one continuous shot (return one crop with "key" = one of them and "from_keys" = the others),',
    '- remove it (list its key in "removed_keys") when it is not an independently readable illustrated moment.',
    'A tall continuous scene may stay one crop. Speech bubbles, narration and SFX never justify a crop or a split.',
    'ALWAYS remove a crop whose content is only speech/thought/narration bubbles, caption boxes or SFX over a plain, gradient, sky, sparkle, particle, glow or speed-line background — even if it already has a description or its checks pass. If the description you would write is mainly about bubbles or lettering, remove it.',
    '',
    'CHECKS: each crop lists automatic checks with a token. Look at what each one points to. If the crop is fine despite it (or after your fix), put its token in "checks_reviewed". Leave a token out if you could not verify it.',
    '',
    'SWEEP: go through the whole page top to bottom for artwork no crop holds — small inserts, grayscale panels, objects, landscapes, effects shots. These stretches have no crop at all:',
    ...(gaps.length > 0 ? gaps : ['  (none)']),
    'Add a crop (key null, no from_keys) for any real artwork there. "Non-blank" includes bubbles and lettering: a stretch holding only bubbles, narration or SFX over background stays uncovered. Set "sweep_done": true only after you have actually swept the page.',
    '',
    'DESCRIPTIONS: every crop in your reply needs its final description — one plain sentence, 12–35 words, ending in a period, only what is visible, no names, no plot, no dialogue. Keep a current one only if it still fits the final box.',
    '',
    'MEASURING: corners are in the pixel grid of the slice each corner falls in — { "slice_id", "x", "y" } — exactly as in your first answer. bottom_right is exclusive. Whole pixels only.',
    '',
    'RULES FOR THE REPLY:',
    '- "crops" is the COMPLETE final list for the page.',
    '- Every current key must appear exactly once: as a crop\'s "key", inside a "from_keys", or in "removed_keys".',
    `- Copy job_id, source_sha256 and review_revision exactly: ${manifest.job_id} / ${manifest.source.sha256} / ${state.review_revision}.`,
    `- Return ONE JSON object (${REVIEW_REPLY_SCHEMA}), no prose, no Markdown fences. Shape (example values):`,
    JSON.stringify(example, null, 2),
    '',
    'CURRENT CROPS:',
    JSON.stringify(crops, null, 2)
  ].join('\n')
}

export async function getReviewPrompt(folderPath: string, imageFilename: string): Promise<{ prompt: string; review_revision: number }> {
  const view = await getReview(folderPath, imageFilename)
  if (!view.state) throw new ReviewError(404, 'Start a review first')
  if (view.stale) throw new ReviewError(422, 'The review is out of date — restart it first', view.staleReasons)
  const handoff = await getHandoffStatus(folderPath, imageFilename)
  if (!handoff.manifest || handoff.staleReasons.some(r => r.code !== 'SLICES_CHANGED')) {
    throw new ReviewError(422, 'This page needs a current ChatGPT package — ChatGPT reviews against the slices it was sent')
  }
  if (handoff.manifest.source.sha256 !== view.state.source_sha256) {
    throw new ReviewError(422, 'The ChatGPT package is for a different version of the page')
  }
  return { prompt: buildReviewPrompt(view as ReviewView & { state: ReviewState }, handoff.manifest), review_revision: view.state.review_revision }
}

// ============ Applying the reply ============

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameBounds(a: PixelBounds, b: PixelBounds) {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1
}

function freeKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

function nextOperatorKey(taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const key = `op-${String(n).padStart(2, '0')}`
    if (!taken.has(key)) return key
  }
}

export interface ReviewReplyParse {
  /** The incoming review state to save, when the reply is valid. */
  incoming: { crops: ReviewCrop[]; page: ReviewState['page'] } | null
  errors: ImportIssue[]
  warnings: ImportIssue[]
  summary: { kept: number; adjusted: number; split: number; merged: number; added: number; removed: number }
}

/**
 * Checks a `chatgpt-review/1.0` reply against the stored review and the page's
 * package and builds the review save it describes. Pure.
 */
export function parseReviewReply(content: string, view: ReviewView & { state: ReviewState }, manifest: HandoffManifest): ReviewReplyParse {
  const errors: ImportIssue[] = []
  const warnings: ImportIssue[] = []
  const summary = { kept: 0, adjusted: 0, split: 0, merged: 0, added: 0, removed: 0 }
  const error = (code: ImportIssueCode, field: string, message: string, candidateId?: string) =>
    errors.push({ code, field, message, ...(candidateId ? { candidateId } : {}) })
  const fail = () => ({ incoming: null, errors, warnings, summary })

  const fence = /^\s*```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(content)
  if (fence) warnings.push({ code: 'MARKDOWN_FENCE_STRIPPED', field: '', message: 'The reply was wrapped in a Markdown code fence; the fence was removed' })

  let root: unknown
  try {
    root = JSON.parse(fence ? fence[1] : content)
  } catch (err) {
    error('GPT_JSON_INVALID', '', `The reply is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    return fail()
  }
  if (!isRecord(root)) {
    error('GPT_JSON_INVALID', '', 'The reply must be one JSON object')
    return fail()
  }

  const { state, items } = view
  if (root.schema_version !== REVIEW_REPLY_SCHEMA) error('GPT_JSON_INVALID', 'schema_version', `schema_version must be "${REVIEW_REPLY_SCHEMA}" — is this the reply to the REVIEW prompt?`)
  if (root.job_id !== manifest.job_id) error('GPT_PAGE_MISMATCH', 'job_id', `job_id is ${JSON.stringify(root.job_id)} but this page's is ${manifest.job_id}`)
  if (typeof root.source_sha256 !== 'string' || root.source_sha256.toLowerCase() !== manifest.source.sha256) error('GPT_PAGE_MISMATCH', 'source_sha256', 'source_sha256 does not match this page')
  if (root.review_revision !== state.review_revision) {
    error('GPT_PAGE_MISMATCH', 'review_revision', `The reply answers revision ${JSON.stringify(root.review_revision)} but the review is now at ${state.review_revision} — copy the review prompt again`)
  }
  if (root.coordinate_system !== 'slice_local_pixels') error('GPT_COORDINATES_INVALID', 'coordinate_system', 'coordinate_system must be "slice_local_pixels"')
  if (!Array.isArray(root.crops)) {
    error('GPT_JSON_INVALID', 'crops', 'crops must be an array')
    return fail()
  }
  if (errors.length > 0) return fail()

  const current = new Map(state.crops.map(c => [c.key, c]))
  const tokensByKey = new Map<string, Set<string>>()
  for (const item of items) {
    if (!tokensByKey.has(item.key)) tokensByKey.set(item.key, new Set())
    tokensByKey.get(item.key)!.add(item.token)
  }
  const sliceById = new Map(manifest.slices.map(s => [s.id, s]))
  const accounted = new Map<string, string>() // key -> where
  const account = (key: string, where: string, field: string) => {
    if (!current.has(key)) {
      error('GPT_JSON_INVALID', field, `"${key}" is not one of the current crops (${[...current.keys()].join(', ')})`)
      return false
    }
    if (accounted.has(key) && accounted.get(key) !== where) {
      error('GPT_JSON_INVALID', field, `"${key}" appears more than once (${accounted.get(key)} and ${where})`)
      return false
    }
    accounted.set(key, where)
    return true
  }

  type Draft = { raw: Record<string, unknown>; at: string; key: string | null; from: string[]; bounds: PixelBounds | null }
  const drafts: Draft[] = []
  root.crops.forEach((raw, index) => {
    const at = `crops[${index}]`
    if (!isRecord(raw)) {
      error('GPT_JSON_INVALID', at, `${at} must be an object`)
      return
    }
    const key = typeof raw.key === 'string' && raw.key.trim() ? raw.key.trim() : null
    const from = Array.isArray(raw.from_keys) ? raw.from_keys.filter((k): k is string => typeof k === 'string' && k.trim() !== '' && !k.startsWith('<')).map(k => k.trim()) : []
    const label = key ?? `new crop #${index + 1}`
    if (key) account(key, `crops[${index}].key`, `${at}.key`)
    const bounds = boundsFromSliceCorners(raw, at, label, manifest, sliceById, error)
    drafts.push({ raw, at, key, from, bounds })
  })

  // A split parent may feed several parts; a merge consumes its extra keys once.
  const splitParents = new Map<string, number>()
  for (const d of drafts) {
    if (d.key) {
      for (const k of d.from) if (k !== d.key) account(k, `merged into ${d.key}`, `${d.at}.from_keys`)
    } else if (d.from.length === 1) {
      if (!current.has(d.from[0])) error('GPT_JSON_INVALID', `${d.at}.from_keys`, `"${d.from[0]}" is not one of the current crops`)
      else splitParents.set(d.from[0], (splitParents.get(d.from[0]) ?? 0) + 1)
    } else if (d.from.length > 1) {
      for (const k of d.from) account(k, `merged into a new crop`, `${d.at}.from_keys`)
    }
  }
  for (const parent of splitParents.keys()) account(parent, 'split', 'from_keys')

  const removed = Array.isArray(root.removed_keys) ? root.removed_keys.filter((k): k is string => typeof k === 'string') : []
  for (const k of removed) if (account(k, 'removed_keys', 'removed_keys')) summary.removed++

  const missing = [...current.keys()].filter(k => !accounted.has(k))
  if (missing.length > 0) {
    error('GPT_JSON_INVALID', 'crops', `Not accounted for: ${missing.join(', ')}. Every current crop must be kept, changed, merged, split or listed in "removed_keys".`)
  }
  if (errors.length > 0) return fail()

  const taken = new Set<string>(state.crops.map(c => c.key))
  const crops: ReviewCrop[] = []
  for (const d of drafts) {
    const bounds = d.bounds!
    const reasonRaw = typeof d.raw.reason === 'string' ? normalizeReason(d.raw.reason.slice(0, 120)) : ''
    const description = typeof d.raw.description === 'string' ? d.raw.description.trim().slice(0, MAX_TEXT) : ''
    const reviewed = Array.isArray(d.raw.checks_reviewed) ? d.raw.checks_reviewed.filter((t): t is string => typeof t === 'string') : []
    const label = d.key ?? `new crop (${d.at})`
    if (!description) warnings.push({ code: 'DESCRIPTION_MISSING', field: `${d.at}.description`, message: `${label}: no description — it stays unapproved` })

    let crop: ReviewCrop
    if (d.key) {
      const base = current.get(d.key)!
      const merged = d.from.some(k => k !== d.key)
      const moved = !sameBounds(base.bounds, bounds)
      crop = {
        ...base,
        bounds,
        reason: reasonRaw || base.reason,
        description,
        description_status: description ? 'approved' : 'missing',
        disposition: merged ? 'merged' : moved ? 'adjusted' : 'kept',
        // Only tokens that exist on this crop now; the save clears them anyway if the box moved.
        acknowledged: reviewed.filter(t => tokensByKey.get(d.key!)?.has(t))
      }
      if (merged) summary.merged++
      else if (moved) summary.adjusted++
      else summary.kept++
    } else {
      const parent = d.from.length === 1 ? current.get(d.from[0]) : undefined
      const key = parent ? freeKey(`${parent.key}.${String.fromCharCode(97 + crops.filter(c => c.key.startsWith(`${parent.key}.`)).length)}`, taken) : nextOperatorKey(taken)
      taken.add(key)
      crop = {
        key,
        origin: 'operator',
        reason: reasonRaw || parent?.reason || 'chatgpt_crop',
        bounds,
        description,
        description_status: description ? 'approved' : 'missing',
        disposition: parent ? 'split' : d.from.length > 1 ? 'merged' : 'adjusted',
        visual_evidence: '',
        gpt_flags: [],
        unknown_flags: [],
        acknowledged: [],
        note: parent ? `Split by ChatGPT review from ${parent.key}` : d.from.length > 1 ? `Merged by ChatGPT review from ${d.from.join(', ')}` : 'Added by ChatGPT review'
      }
      if (parent) summary.split++
      else if (d.from.length > 1) summary.merged++
      else summary.added++
    }
    crops.push(crop)
  }

  const noArtwork = root.page_has_no_artwork === true && crops.length === 0
  return {
    incoming: {
      crops,
      page: {
        sweep_done: root.sweep_done === true,
        no_eligible_artwork_confirmed: noArtwork,
        note: [state.page.note, typeof root.notes === 'string' && root.notes.trim() ? `ChatGPT: ${root.notes.trim().slice(0, 500)}` : '']
          .filter(Boolean).join('\n').slice(0, 2000)
      }
    },
    errors,
    warnings,
    summary
  }
}

export interface ChatGptReviewOutcome {
  applied: boolean
  view: ReviewView | null
  errors: ImportIssue[]
  warnings: ImportIssue[]
  summary: ReviewReplyParse['summary'] | null
}

/** Validates and applies a pasted review reply as one review save. */
export async function applyChatGptReview(folderPath: string, imageFilename: string, content: string): Promise<ChatGptReviewOutcome> {
  const view = await getReview(folderPath, imageFilename)
  if (!view.state) throw new ReviewError(404, 'Start a review first')
  if (view.stale) throw new ReviewError(422, 'The review is out of date — restart it first', view.staleReasons)
  const handoff = await getHandoffStatus(folderPath, imageFilename)
  if (!handoff.manifest || handoff.manifest.source.sha256 !== view.state.source_sha256) {
    throw new ReviewError(422, 'This page needs a current ChatGPT package')
  }

  const parsed = parseReviewReply(content, view as ReviewView & { state: ReviewState }, handoff.manifest)
  if (!parsed.incoming) return { applied: false, view: null, errors: parsed.errors, warnings: parsed.warnings, summary: null }

  const now = new Date().toISOString()
  const { state: next, errors } = applyReviewSave(view.state, parsed.incoming, now)
  if (!next) {
    return { applied: false, view: null, errors: errors.map(message => ({ code: 'GPT_JSON_INVALID' as const, field: '', message })), warnings: parsed.warnings, summary: null }
  }
  next.chatgpt_reviews = [
    ...(view.state.chatgpt_reviews ?? []),
    { applied_at: now, from_revision: view.state.review_revision, to_revision: next.review_revision, response_sha256: createHash('sha256').update(content).digest('hex') }
  ]
  await writeReviewState(folderPath, imageFilename, next)
  return { applied: true, view: await getReview(folderPath, imageFilename), errors: [], warnings: parsed.warnings, summary: parsed.summary }
}
