/**
 * Crop Studio (hybrid ChatGPT loop) — the review state of ONE page.
 *
 * `review-state.json` is the working copy between ChatGPT's proposal and the
 * export: the crops as the operator has decided them, each with its own review
 * disposition, description status and the findings the operator has looked at
 * and accepted. It is seeded from either
 *
 *  - the page's latest imported ChatGPT reply, or
 *  - the page's existing Clipper 3.0 pointers + metadata (the legacy path),
 *
 * and every save bumps `review_revision` (the export will cite the revision it
 * was made from). Each revision is also kept in `review-history/`.
 *
 * Rules the server enforces, whatever the client sends:
 *  - bounds are integer page pixels inside the page, x1/y1 exclusive;
 *  - provenance (origin, ChatGPT's flags and evidence) cannot be rewritten —
 *    it is carried over from the stored crop with the same key;
 *  - moving/resizing a crop clears its acknowledged findings, and an approved
 *    description whose text did not change with it becomes `stale` (FR-036);
 *  - an empty description is `missing`, never `approved`;
 *  - a save against an older revision is refused (two tabs can't clobber).
 *
 * Audit findings and readiness are derived on every read, never stored.
 */

import fs from 'fs/promises'
import path from 'path'
import { getSourceFolderPath, readImageMetadata, readImagePoints } from './perImageStore.js'
import { getHandoffStatus, getStudioDir } from './handoff.js'
import { getAnalysisStatus, normalizeReason, type ImportedAnalysis } from './analysisImport.js'
import { inspectOriginal, sha256Hex, sha256OfFile } from './pageIdentity.js'
import { auditPage, loadLuma, type AuditFinding, type AuditReport, type Box } from './auditRules.js'

export const REVIEW_SCHEMA = 'crop-studio-review/1.0'
export const REVIEW_FILE = 'review-state.json'
export const REVIEW_HISTORY_DIR = 'review-history'

export const DISPOSITIONS = ['unreviewed', 'kept', 'adjusted', 'split', 'merged', 'unresolved'] as const
export const DESCRIPTION_STATUSES = ['approved', 'unreviewed', 'stale', 'missing'] as const

export type Disposition = typeof DISPOSITIONS[number]
export type DescriptionStatus = typeof DESCRIPTION_STATUSES[number]
export type CropOrigin = 'chatgpt' | 'existing_pointers' | 'operator'

const MAX_CROPS = 500
const MAX_KEY = 120
const MAX_TEXT = 1000
const MAX_NOTE = 2000
const MAX_ACKS = 64

export interface ReviewCrop {
  /** Stable across revisions; never shown as the final crop id (ids are assigned at export). */
  key: string
  origin: CropOrigin
  reason: string
  bounds: Box
  description: string
  description_status: DescriptionStatus
  disposition: Disposition
  visual_evidence: string
  gpt_flags: string[]
  unknown_flags: string[]
  /** Finding tokens (see findingToken) the operator has reviewed and accepted. */
  acknowledged: string[]
  note: string
}

/** What the server, not the client, says about where a crop came from. */
export interface CropProvenance {
  origin: CropOrigin
  visual_evidence: string
  gpt_flags: string[]
  unknown_flags: string[]
}

/**
 * What was accepted about a crop at one exact box: the findings ticked off and
 * the description approved there. Lets undo (or dragging a box back) restore
 * them instead of treating the return as a brand-new box.
 */
export interface GeometryMemory {
  bounds: Box
  acknowledged: string[]
  approved_description: string | null
}

const MEMORY_PER_KEY = 20

export interface ReviewState {
  schema_version: typeof REVIEW_SCHEMA
  job_id: string | null
  source_sha256: string
  source_width: number
  source_height: number
  page_stem: string
  review_revision: number
  created_at: string
  updated_at: string
  based_on:
    | { kind: 'chatgpt_import'; response_sha256: string; imported_at: string }
    | { kind: 'existing_pointers'; points_sha256: string }
  crops: ReviewCrop[]
  /**
   * Provenance of every key this review has ever held, so a crop deleted and
   * later restored (undo) comes back as what it was, flags and all. Server-
   * maintained: whatever a client sends here is ignored.
   */
  provenance: Record<string, CropProvenance>
  /** Server-maintained, per key, most recent last (see GeometryMemory). */
  geometry_memory?: Record<string, GeometryMemory[]>
  /**
   * Review rounds done by ChatGPT instead of the operator (chatgptReview.ts).
   * Server-maintained and carried across saves; the export report cites it.
   */
  chatgpt_reviews?: { applied_at: string; from_revision: number; to_revision: number; response_sha256: string }[]
  page: {
    /** The operator has swept the whole page top to bottom for missed artwork. */
    sweep_done: boolean
    /** Required for a page with no crops: an explicit "nothing here to crop". */
    no_eligible_artwork_confirmed: boolean
    note: string
  }
}

export type BlockerCode =
  | 'REVIEW_STALE'
  | 'CROP_UNREVIEWED'
  | 'CROP_UNRESOLVED'
  | 'FINDING_UNACKNOWLEDGED'
  | 'DESCRIPTION_NOT_APPROVED'
  | 'SWEEP_NOT_DONE'
  | 'EMPTY_NOT_CONFIRMED'

export interface Blocker {
  code: BlockerCode
  key?: string
  message: string
}

/** One thing on a crop that needs an explicit look: a system finding or a ChatGPT flag. */
export interface ReviewItem {
  token: string
  key: string
  source: 'system' | 'chatgpt'
  code: string
  message: string
  acknowledged: boolean
}

export interface ReviewView {
  state: ReviewState | null
  audit: AuditReport | null
  items: ReviewItem[]
  readiness: { ready: boolean; blockers: Blocker[] }
  stale: boolean
  staleReasons: string[]
  /** A ChatGPT reply newer than the one this review was seeded from. */
  newerImportAvailable: boolean
}

export class ReviewError extends Error {
  constructor(public readonly status: 400 | 404 | 409 | 422, message: string, public readonly details: string[] = [], public readonly current?: ReviewView) {
    super(message)
    this.name = 'ReviewError'
  }
}

// ============ Tokens, items, readiness (pure) ============

/** Identifies one finding stably enough to be acknowledged: code, plus the other crop or edge. */
export function findingToken(finding: Pick<AuditFinding, 'code' | 'otherKey' | 'edge'>): string {
  return [finding.code, finding.otherKey, finding.edge].filter(Boolean).join(':')
}

export function reviewItems(state: ReviewState, findings: AuditFinding[]): ReviewItem[] {
  const items: ReviewItem[] = []
  for (const crop of state.crops) {
    const acked = new Set(crop.acknowledged)
    for (const finding of findings.filter(f => f.key === crop.key)) {
      const token = findingToken(finding)
      items.push({ token, key: crop.key, source: 'system', code: finding.code, message: finding.message, acknowledged: acked.has(token) })
    }
    for (const flag of crop.gpt_flags) {
      const token = `gpt:${flag}`
      items.push({ token, key: crop.key, source: 'chatgpt', code: flag, message: `ChatGPT flagged: ${flag.replace(/_/g, ' ')}`, acknowledged: acked.has(token) })
    }
  }
  return items
}

export function readiness(state: ReviewState, items: ReviewItem[], stale: boolean): { ready: boolean; blockers: Blocker[] } {
  const blockers: Blocker[] = []
  if (stale) blockers.push({ code: 'REVIEW_STALE', message: 'The original page changed since this review started — restart the review' })

  for (const crop of state.crops) {
    if (crop.disposition === 'unreviewed') {
      blockers.push({ code: 'CROP_UNREVIEWED', key: crop.key, message: `${crop.key}: not reviewed yet` })
    } else if (crop.disposition === 'unresolved') {
      blockers.push({ code: 'CROP_UNRESOLVED', key: crop.key, message: `${crop.key}: marked unresolved` })
    }
    const open = items.filter(i => i.key === crop.key && !i.acknowledged)
    if (open.length > 0) {
      blockers.push({ code: 'FINDING_UNACKNOWLEDGED', key: crop.key, message: `${crop.key}: ${open.length} flag${open.length === 1 ? '' : 's'} not yet reviewed (${open.map(i => i.code).join(', ')})` })
    }
    if (crop.description_status !== 'approved') {
      blockers.push({ code: 'DESCRIPTION_NOT_APPROVED', key: crop.key, message: `${crop.key}: description is ${crop.description_status}` })
    }
  }

  if (!state.page.sweep_done) {
    blockers.push({ code: 'SWEEP_NOT_DONE', message: 'The top-to-bottom page sweep for missed artwork is not done' })
  }
  if (state.crops.length === 0 && !state.page.no_eligible_artwork_confirmed) {
    blockers.push({ code: 'EMPTY_NOT_CONFIRMED', message: 'No crops: confirm this page has no eligible artwork' })
  }
  return { ready: blockers.length === 0, blockers }
}

// ============ Seeding ============

/** Records each crop's current box with what is accepted about it there. */
function remember(memory: Record<string, GeometryMemory[]>, crops: ReviewCrop[]): Record<string, GeometryMemory[]> {
  const next = { ...memory }
  for (const crop of crops) {
    const entry: GeometryMemory = {
      bounds: { ...crop.bounds },
      acknowledged: [...crop.acknowledged],
      approved_description: crop.description_status === 'approved' ? crop.description : null
    }
    const others = (next[crop.key] ?? []).filter(m => !sameBounds(m.bounds, crop.bounds))
    next[crop.key] = [...others, entry].slice(-MEMORY_PER_KEY)
  }
  return next
}

function provenanceOf(crops: ReviewCrop[]): Record<string, CropProvenance> {
  return Object.fromEntries(crops.map(c => [c.key, {
    origin: c.origin,
    visual_evidence: c.visual_evidence,
    gpt_flags: [...c.gpt_flags],
    unknown_flags: [...c.unknown_flags]
  }]))
}

function seedFromImport(analysis: ImportedAnalysis, jobId: string, now: string): ReviewState {
  const state: Omit<ReviewState, 'provenance'> = {
    schema_version: REVIEW_SCHEMA,
    job_id: jobId,
    source_sha256: analysis.source_sha256,
    source_width: analysis.source_width,
    source_height: analysis.source_height,
    page_stem: analysis.page_stem,
    review_revision: 1,
    created_at: now,
    updated_at: now,
    based_on: { kind: 'chatgpt_import', response_sha256: analysis.response_sha256, imported_at: analysis.imported_at },
    crops: analysis.candidates.map(c => ({
      key: c.candidate_id,
      origin: 'chatgpt',
      reason: c.reason,
      bounds: { ...c.bounds },
      description: c.description,
      description_status: c.description ? 'unreviewed' : 'missing',
      disposition: 'unreviewed',
      visual_evidence: c.visual_evidence,
      gpt_flags: [...c.review_flags],
      unknown_flags: [...c.unknown_flags],
      acknowledged: [],
      note: ''
    })),
    page: { sweep_done: false, no_eligible_artwork_confirmed: false, note: '' }
  }
  return { ...state, provenance: provenanceOf(state.crops), geometry_memory: remember({}, state.crops) }
}

/** Descriptions by crop id from a metadata document, tolerating anything unparseable. */
function descriptionsById(metadataText: string | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!metadataText) return map
  try {
    const parsed = JSON.parse(metadataText) as { crops?: { id?: unknown; description?: unknown }[] }
    for (const entry of parsed.crops ?? []) {
      if (typeof entry?.id === 'string' && typeof entry.description === 'string') map.set(entry.id, entry.description.trim())
    }
  } catch {
    // No descriptions then; each crop starts `missing`.
  }
  return map
}

async function seedFromPointers(folderPath: string, imageFilename: string, now: string): Promise<ReviewState> {
  const sourcePath = path.join(getSourceFolderPath(folderPath), path.basename(imageFilename))
  const inspection = await inspectOriginal(sourcePath)
  if (!inspection.ready || !inspection.page) {
    throw new ReviewError(422, 'The original page is blocked', inspection.issues.map(i => i.message))
  }
  const { width: W, height: H, sha256 } = inspection.page

  const stored = await readImagePoints(folderPath, imageFilename)
  if (!stored?.file || !Array.isArray(stored.file.crops)) {
    throw new ReviewError(422, 'This page has no readable crop pointers to review')
  }
  const descriptions = descriptionsById(await readImageMetadata(folderPath, imageFilename))

  const problems: string[] = []
  const crops: ReviewCrop[] = []
  stored.file.crops.forEach((entry, index) => {
    const points = (entry?.crop?.points ?? []).filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y))
    const key = typeof entry?.id === 'string' && entry.id ? entry.id : `crop-${String(index + 1).padStart(2, '0')}`
    if (points.length === 0) {
      problems.push(`${key}: no usable points`)
      return
    }
    const xs = points.map(p => p.x)
    const ys = points.map(p => p.y)
    // The same rectangle the 3.0 cutter cuts: the bounding box of the points,
    // de-normalized against this page and rounded to whole pixels.
    const bounds = {
      x0: Math.round(Math.min(...xs) * W),
      y0: Math.round(Math.min(...ys) * H),
      x1: Math.round(Math.max(...xs) * W),
      y1: Math.round(Math.max(...ys) * H)
    }
    if (bounds.x0 < 0 || bounds.y0 < 0 || bounds.x1 > W || bounds.y1 > H || bounds.x1 <= bounds.x0 || bounds.y1 <= bounds.y0) {
      problems.push(`${key}: points map outside the page or to no area`)
      return
    }
    const description = descriptions.get(key) ?? ''
    crops.push({
      key,
      origin: 'existing_pointers',
      reason: normalizeReason(entry.reason ?? '') || 'crop',
      bounds,
      description,
      // These descriptions already went through the existing metadata flow.
      description_status: description ? 'approved' : 'missing',
      disposition: 'unreviewed',
      visual_evidence: '',
      gpt_flags: [],
      unknown_flags: [],
      acknowledged: [],
      note: ''
    })
  })
  if (problems.length > 0) throw new ReviewError(422, 'Some stored pointers could not be converted', problems)

  const handoff = await getHandoffStatus(folderPath, imageFilename)
  const jobId = handoff.manifest && handoff.manifest.source.sha256 === sha256 ? handoff.manifest.job_id : null

  return {
    schema_version: REVIEW_SCHEMA,
    job_id: jobId,
    source_sha256: sha256,
    source_width: W,
    source_height: H,
    page_stem: path.basename(imageFilename).replace(/\.[^/.]+$/, ''),
    review_revision: 1,
    created_at: now,
    updated_at: now,
    based_on: { kind: 'existing_pointers', points_sha256: sha256Hex(stored.text) },
    crops,
    provenance: provenanceOf(crops),
    geometry_memory: remember({}, crops),
    page: { sweep_done: false, no_eligible_artwork_confirmed: false, note: '' }
  }
}

// ============ Validating a save ============

function sameBounds(a: Box, b: Box): boolean {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1
}

function stringList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) return null
  return [...new Set((value as string[]).map(v => v.slice(0, MAX_KEY)))].slice(0, max)
}

/**
 * Checks an incoming state against the stored one and returns the state to
 * write (revision bumped, provenance carried over, description and
 * acknowledgement rules applied). Pure.
 */
export function applyReviewSave(previous: ReviewState, incoming: unknown, now: string): { state: ReviewState | null; errors: string[] } {
  const errors: string[] = []
  if (typeof incoming !== 'object' || incoming === null) return { state: null, errors: ['The review state must be an object'] }
  const input = incoming as Record<string, unknown>
  if (!Array.isArray(input.crops)) return { state: null, errors: ['crops must be an array'] }
  if (input.crops.length > MAX_CROPS) return { state: null, errors: [`At most ${MAX_CROPS} crops`] }

  const W = previous.source_width
  const H = previous.source_height
  const prevByKey = new Map(previous.crops.map(c => [c.key, c]))
  const memory = previous.geometry_memory ?? remember({}, previous.crops)
  // Keys ever held, plus the current crops (covers reviews written before the
  // map existed, and any crop the map somehow lacks).
  const provenance: Record<string, CropProvenance> = { ...provenanceOf(previous.crops), ...(previous.provenance ?? {}) }
  const seen = new Set<string>()
  const crops: ReviewCrop[] = []

  input.crops.forEach((raw, index) => {
    const at = `crops[${index}]`
    if (typeof raw !== 'object' || raw === null) {
      errors.push(`${at} must be an object`)
      return
    }
    const c = raw as Record<string, unknown>
    const key = typeof c.key === 'string' ? c.key.trim() : ''
    if (!key || key.length > MAX_KEY) {
      errors.push(`${at}.key must be a non-empty string up to ${MAX_KEY} characters`)
      return
    }
    if (seen.has(key)) {
      errors.push(`Duplicate crop key "${key}"`)
      return
    }
    seen.add(key)

    const b = c.bounds as Record<string, unknown> | undefined
    const nums = b && typeof b === 'object' ? [b.x0, b.y0, b.x1, b.y1] : []
    if (nums.length !== 4 || nums.some(n => typeof n !== 'number' || !Number.isInteger(n))) {
      errors.push(`${key}: bounds must be four whole pixels {x0, y0, x1, y1}`)
      return
    }
    const bounds: Box = { x0: nums[0] as number, y0: nums[1] as number, x1: nums[2] as number, y1: nums[3] as number }
    if (bounds.x0 < 0 || bounds.y0 < 0 || bounds.x1 > W || bounds.y1 > H) {
      errors.push(`${key}: (${bounds.x0},${bounds.y0})–(${bounds.x1},${bounds.y1}) is outside the ${W}×${H} page`)
      return
    }
    if (bounds.x1 <= bounds.x0 || bounds.y1 <= bounds.y0) {
      errors.push(`${key}: box has no area`)
      return
    }

    const reason = typeof c.reason === 'string' ? normalizeReason(c.reason.slice(0, MAX_KEY)) : ''
    if (!reason) {
      errors.push(`${key}: reason must be a non-empty snake_case label`)
      return
    }
    if (typeof c.description !== 'string') {
      errors.push(`${key}: description must be a string`)
      return
    }
    const description = c.description.trim().slice(0, MAX_TEXT)
    if (!DISPOSITIONS.includes(c.disposition as Disposition)) {
      errors.push(`${key}: disposition must be one of ${DISPOSITIONS.join(', ')}`)
      return
    }
    if (!DESCRIPTION_STATUSES.includes(c.description_status as DescriptionStatus)) {
      errors.push(`${key}: description_status must be one of ${DESCRIPTION_STATUSES.join(', ')}`)
      return
    }
    const acknowledged = c.acknowledged === undefined ? [] : stringList(c.acknowledged, MAX_ACKS)
    if (!acknowledged) {
      errors.push(`${key}: acknowledged must be an array of strings`)
      return
    }
    const note = typeof c.note === 'string' ? c.note.slice(0, MAX_NOTE) : ''

    const prev = prevByKey.get(key)
    const moved = !!prev && !sameBounds(prev.bounds, bounds)
    // A box returning to a position it held before (undo, or dragged back)
    // gets back what was accepted there; any other move starts over.
    const remembered = moved ? memory[key]?.find(m => sameBounds(m.bounds, bounds)) : undefined
    let status = c.description_status as DescriptionStatus
    if (!description) status = 'missing'
    else if (moved && status === 'approved' && description === prev!.description && remembered?.approved_description !== description) status = 'stale'

    // Provenance is the server's, not the client's: looked up across every
    // key this review has held, so an undone delete restores it intact.
    const known = provenance[key] ?? { origin: 'operator' as const, visual_evidence: '', gpt_flags: [], unknown_flags: [] }
    provenance[key] = known
    crops.push({
      key,
      origin: known.origin,
      reason,
      bounds,
      description,
      description_status: status,
      disposition: c.disposition as Disposition,
      visual_evidence: known.visual_evidence,
      gpt_flags: [...known.gpt_flags],
      unknown_flags: [...known.unknown_flags],
      // A moved box is a different box: what was accepted about the old one
      // has to be looked at again — unless it was accepted at this very box.
      acknowledged: moved ? acknowledged.filter(t => remembered?.acknowledged.includes(t)) : acknowledged,
      note
    })
  })

  const page = (input.page ?? {}) as Record<string, unknown>
  if (errors.length > 0) return { state: null, errors }

  return {
    state: {
      ...previous,
      review_revision: previous.review_revision + 1,
      updated_at: now,
      crops,
      provenance,
      geometry_memory: remember(memory, crops),
      page: {
        sweep_done: page.sweep_done === true,
        no_eligible_artwork_confirmed: page.no_eligible_artwork_confirmed === true,
        note: typeof page.note === 'string' ? page.note.slice(0, MAX_NOTE) : ''
      }
    },
    errors
  }
}

// ============ Disk ============

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, content, 'utf-8')
  await fs.rename(temp, filePath)
}

async function readState(folderPath: string, imageFilename: string): Promise<ReviewState | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(getStudioDir(folderPath, imageFilename), REVIEW_FILE), 'utf-8')) as ReviewState
  } catch {
    return null
  }
}

export async function writeReviewState(folderPath: string, imageFilename: string, state: ReviewState): Promise<void> {
  const studio = getStudioDir(folderPath, imageFilename)
  const history = path.join(studio, REVIEW_HISTORY_DIR)
  await fs.mkdir(history, { recursive: true })
  const text = JSON.stringify(state, null, 2) + '\n'
  await writeFileAtomic(path.join(history, `${state.created_at.replace(/[:.]/g, '-')}-rev-${String(state.review_revision).padStart(4, '0')}.json`), text)
  await writeFileAtomic(path.join(studio, REVIEW_FILE), text)
}

/** The stored review with its audit, readiness and staleness worked out. */
export async function getReview(folderPath: string, imageFilename: string): Promise<ReviewView> {
  const state = await readState(folderPath, imageFilename)
  if (!state) {
    return { state: null, audit: null, items: [], readiness: { ready: false, blockers: [] }, stale: false, staleReasons: [], newerImportAvailable: false }
  }

  const sourcePath = path.join(getSourceFolderPath(folderPath), path.basename(imageFilename))
  const staleReasons: string[] = []
  try {
    if ((await sha256OfFile(sourcePath)) !== state.source_sha256) staleReasons.push('The original page changed after this review started')
  } catch {
    staleReasons.push('The original page can no longer be read')
  }
  const stale = staleReasons.length > 0

  const crops = state.crops.map(c => ({ key: c.key, bounds: c.bounds }))
  // Pixel rules only against the very pixels the review is about.
  const audit = stale
    ? auditPage(state.source_width, state.source_height, crops)
    : auditPage(state.source_width, state.source_height, crops, await loadLuma(sourcePath, state.source_sha256))
  const items = reviewItems(state, audit.findings)

  let newerImportAvailable = false
  if (state.based_on.kind === 'chatgpt_import') {
    const latest = await getAnalysisStatus(folderPath, imageFilename)
    newerImportAvailable = !!latest.analysis && latest.analysis.response_sha256 !== state.based_on.response_sha256
  }

  return { state, audit, items, readiness: readiness(state, items, stale), stale, staleReasons, newerImportAvailable }
}

/**
 * Starts a review from the latest ChatGPT import or from the page's existing
 * pointers. Refuses to replace an existing review unless `replace` is set; a
 * replaced review stays in review-history/.
 */
export async function startReview(
  folderPath: string,
  imageFilename: string,
  from: 'import' | 'pointers',
  replace: boolean
): Promise<ReviewView> {
  if (!replace && (await readState(folderPath, imageFilename))) {
    throw new ReviewError(409, 'This page already has a review. Pass replace to start over (the current one is kept in review-history).')
  }
  const now = new Date().toISOString()

  let state: ReviewState
  if (from === 'import') {
    const status = await getAnalysisStatus(folderPath, imageFilename)
    if (!status.analysis) throw new ReviewError(422, 'This page has no imported ChatGPT reply to review')
    if (status.stale) throw new ReviewError(422, 'The imported reply is out of date', status.staleReasons)
    state = seedFromImport(status.analysis, status.analysis.job_id, now)
  } else {
    state = await seedFromPointers(folderPath, imageFilename, now)
  }

  await writeReviewState(folderPath, imageFilename, state)
  return getReview(folderPath, imageFilename)
}

/** Saves an edited review against the revision the client last saw. */
export async function saveReview(folderPath: string, imageFilename: string, incoming: unknown, expectedRevision: unknown): Promise<ReviewView> {
  const previous = await readState(folderPath, imageFilename)
  if (!previous) throw new ReviewError(404, 'This page has no review to save — start one first')
  if (expectedRevision !== previous.review_revision) {
    throw new ReviewError(409, `The review changed elsewhere (now revision ${previous.review_revision}, this edit was based on ${String(expectedRevision)}). Reload and redo the change.`, [], await getReview(folderPath, imageFilename))
  }

  const current = await getReview(folderPath, imageFilename)
  if (current.stale) throw new ReviewError(422, 'The original page changed — restart the review before editing it', current.staleReasons)

  const { state, errors } = applyReviewSave(previous, incoming, new Date().toISOString())
  if (!state) throw new ReviewError(400, 'The review was not saved', errors)

  await writeReviewState(folderPath, imageFilename, state)
  return getReview(folderPath, imageFilename)
}
