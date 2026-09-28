/**
 * Crop Studio (hybrid ChatGPT loop) — importing ChatGPT's `chatgpt-analysis/1.0`
 * reply for ONE page.
 *
 * The reply is untrusted proposed data. It is checked against the page's
 * verified handoff manifest and only then turned into candidates measured in
 * integer pixels of the original page. Two tiers of problem:
 *
 *  - ERRORS block the import. Anything that could put a crop on the wrong page
 *    or in the wrong place: a different job / hash / page / size, an unknown
 *    coordinate system, a missing or unknown slice, non-integer, inverted or
 *    out-of-bounds corners, duplicate candidate ids, a malformed document.
 *    Bounds are NEVER clamped — a box past the edge is a measuring mistake, and
 *    quietly trimming it would hide that.
 *  - WARNINGS import and are carried into review. Content that review must look
 *    at anyway: a missing or off-spec description, a reason that needed
 *    normalizing, review flags outside the controlled vocabulary, an empty
 *    candidate list, a page ChatGPT itself says it could not fully inspect.
 *
 * Every string in the reply is data. Nothing here follows a path, a URL or an
 * instruction found inside it; strings are only length-capped and stored.
 *
 * Two coordinate forms are accepted:
 *  - `slice_local_pixels` (what the handoff prompt asks for): each corner is
 *    `{slice_id, x, y}` in the slice it falls in; the offset is added here.
 *  - `canonical_original_pixels` (the PRD's form): `bounds: {x0,y0,x1,y1}` on
 *    the whole page.
 */

import fs from 'fs/promises'
import path from 'path'
import {
  ANALYSIS_SCHEMA,
  CANONICAL_COORDINATES,
  REVIEW_FLAGS,
  SLICE_COORDINATES,
  getHandoffStatus,
  getStudioDir,
  type HandoffManifest,
  type HandoffSlice
} from './handoff.js'
import { sha256Hex } from './pageIdentity.js'

export const IMPORT_SCHEMA = 'crop-studio-import/1.0'
export const IMPORTED_ANALYSIS_FILE = 'imported-analysis.json'
export const RESPONSE_FILE = 'chatgpt-response.json'
export const IMPORTS_DIR = 'imports'

const MAX_TEXT = 1000
const MAX_REASON = 120
const MAX_CANDIDATES = 500

const REASON_PATTERN = /^[a-z0-9]+(?:_{1,2}[a-z0-9]+)*$/
const KNOWN_FLAGS = new Set<string>(REVIEW_FLAGS)

const TOP_LEVEL_KEYS = new Set([
  'schema_version', 'job_id', 'source_sha256', 'page_stem', 'source_width', 'source_height',
  'coordinate_system', 'page_inspection_complete', 'candidates', 'page_review_flags'
])
const CANDIDATE_KEYS = new Set([
  'candidate_id', 'reason', 'top_left', 'bottom_right', 'bounds', 'description',
  'visual_evidence', 'review_flags'
])

export type ImportIssueCode =
  | 'GPT_JSON_INVALID'
  | 'GPT_PAGE_MISMATCH'
  | 'GPT_COORDINATES_INVALID'
  | 'HANDOFF_MISSING'
  | 'HANDOFF_STALE'
  // Warnings
  | 'MARKDOWN_FENCE_STRIPPED'
  | 'UNKNOWN_FIELD'
  | 'REASON_NORMALIZED'
  | 'DESCRIPTION_MISSING'
  | 'DESCRIPTION_OFF_SPEC'
  | 'EVIDENCE_MISSING'
  | 'UNKNOWN_REVIEW_FLAG'
  | 'TEXT_TRUNCATED'
  | 'EMPTY_CANDIDATES'
  | 'GPT_VISUAL_UNCERTAINTY'

export interface ImportIssue {
  code: ImportIssueCode
  /** Where in the reply, e.g. `candidates[2].bottom_right.y`, or '' for the whole document. */
  field: string
  message: string
  candidateId?: string
}

export interface PixelBounds {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface ImportedCandidate {
  candidate_id: string
  reason: string
  /** Integer pixels on the original page; x1/y1 exclusive. */
  bounds: PixelBounds
  description: string
  visual_evidence: string
  /** Flags from the controlled vocabulary. */
  review_flags: string[]
  /** Flags ChatGPT sent that are outside the vocabulary — kept, never acted on. */
  unknown_flags: string[]
  /** The slices the box overlaps, top to bottom. More than one means it crosses a seam. */
  slices: string[]
}

export interface ImportedAnalysis {
  schema_version: typeof IMPORT_SCHEMA
  job_id: string
  source_sha256: string
  page_stem: string
  source_width: number
  source_height: number
  imported_at: string
  /** The reply's own coordinate form, before conversion. */
  reply_coordinate_system: string
  /** sha256 of the reply text exactly as pasted. */
  response_sha256: string
  /** The preserved copy of that text, relative to the page's studio folder. */
  response_file: string
  page_inspection_complete: boolean
  page_review_flags: string[]
  candidates: ImportedCandidate[]
  warnings: ImportIssue[]
}

export interface AnalysisParseResult {
  analysis: Omit<ImportedAnalysis, 'imported_at' | 'response_file'> | null
  errors: ImportIssue[]
  warnings: ImportIssue[]
}

// ============ Small helpers ============

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === undefined) return 'missing'
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  return String(value)
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/**
 * ChatGPT often wraps JSON in a ```json fence despite being asked not to. The
 * fence carries no data, so it is removed (and reported); anything else around
 * the object is left in place and fails the parse.
 */
export function stripMarkdownFence(text: string): { text: string; stripped: boolean } {
  const match = /^\s*```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text)
  return match ? { text: match[1], stripped: true } : { text, stripped: false }
}

/** Lowercase snake_case, keeping the `__suffix` convention review reasons use. */
export function normalizeReason(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_{3,}/g, '__')
    .replace(/^_+|_+$/g, '')
}

/** The slices a page-pixel box overlaps, top to bottom. */
export function slicesSpanned(bounds: PixelBounds, slices: HandoffSlice[]): string[] {
  return slices.filter(s => bounds.y0 < s.y1 && bounds.y1 > s.y0).map(s => s.id)
}

// ============ Parsing ============

/**
 * Validates a pasted reply against the page's manifest and converts it to
 * page-pixel candidates. Pure: no filesystem access, so the whole contract is
 * testable from strings.
 */
export function parseAnalysis(content: string, manifest: HandoffManifest): AnalysisParseResult {
  const errors: ImportIssue[] = []
  const warnings: ImportIssue[] = []
  const error = (code: ImportIssueCode, field: string, message: string, candidateId?: string) =>
    errors.push({ code, field, message, ...(candidateId ? { candidateId } : {}) })
  const warn = (code: ImportIssueCode, field: string, message: string, candidateId?: string) =>
    warnings.push({ code, field, message, ...(candidateId ? { candidateId } : {}) })

  const fence = stripMarkdownFence(content)
  if (fence.stripped) warn('MARKDOWN_FENCE_STRIPPED', '', 'The reply was wrapped in a Markdown code fence; the fence was removed')

  let root: unknown
  try {
    root = JSON.parse(fence.text)
  } catch (err) {
    error('GPT_JSON_INVALID', '', `The reply is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    return { analysis: null, errors, warnings }
  }
  if (!isRecord(root)) {
    error('GPT_JSON_INVALID', '', `The reply must be one JSON object (got ${describe(root)})`)
    return { analysis: null, errors, warnings }
  }

  for (const key of Object.keys(root)) {
    if (!TOP_LEVEL_KEYS.has(key)) warn('UNKNOWN_FIELD', key, `Unknown field "${key}" was ignored`)
  }

  // ---- Identity: the reply must be about exactly this version of this page.
  const { source } = manifest
  if (root.schema_version !== ANALYSIS_SCHEMA) {
    error('GPT_JSON_INVALID', 'schema_version', `schema_version must be "${ANALYSIS_SCHEMA}" (got ${describe(root.schema_version)})`)
  }
  const identity: [string, unknown, unknown][] = [
    ['job_id', root.job_id, manifest.job_id],
    ['source_sha256', typeof root.source_sha256 === 'string' ? root.source_sha256.toLowerCase() : root.source_sha256, source.sha256],
    ['page_stem', root.page_stem, source.page_stem],
    ['source_width', root.source_width, source.width],
    ['source_height', root.source_height, source.height]
  ]
  for (const [field, got, want] of identity) {
    if (got !== want) {
      error('GPT_PAGE_MISMATCH', field, `${field} is ${describe(got)} but this page's package says ${describe(want)} — the reply is for a different page or an older version of it`)
    }
  }

  const coordinateSystem = root.coordinate_system
  if (coordinateSystem !== SLICE_COORDINATES && coordinateSystem !== CANONICAL_COORDINATES) {
    error('GPT_COORDINATES_INVALID', 'coordinate_system', `coordinate_system must be "${SLICE_COORDINATES}" or "${CANONICAL_COORDINATES}" (got ${describe(coordinateSystem)})`)
  }

  if (typeof root.page_inspection_complete !== 'boolean') {
    error('GPT_JSON_INVALID', 'page_inspection_complete', `page_inspection_complete must be true or false (got ${describe(root.page_inspection_complete)})`)
  }

  const pageFlags: string[] = []
  if (root.page_review_flags === undefined) {
    // Absent is read as "no page flags": it carries no geometry.
  } else if (!Array.isArray(root.page_review_flags) || root.page_review_flags.some(f => typeof f !== 'string')) {
    error('GPT_JSON_INVALID', 'page_review_flags', 'page_review_flags must be an array of strings')
  } else {
    for (const flag of root.page_review_flags as string[]) {
      pageFlags.push(flag.length > MAX_TEXT ? flag.slice(0, MAX_TEXT) : flag)
    }
  }

  if (!Array.isArray(root.candidates)) {
    error('GPT_JSON_INVALID', 'candidates', `candidates must be an array (got ${describe(root.candidates)})`)
    return { analysis: null, errors, warnings }
  }
  if (root.candidates.length > MAX_CANDIDATES) {
    error('GPT_JSON_INVALID', 'candidates', `${root.candidates.length} candidates is more than the ${MAX_CANDIDATES} one page can hold`)
    return { analysis: null, errors, warnings }
  }

  // ---- Candidates
  const sliceById = new Map(manifest.slices.map(s => [s.id, s]))
  const seenIds = new Set<string>()
  const candidates: ImportedCandidate[] = []

  root.candidates.forEach((raw, index) => {
    const at = `candidates[${index}]`
    if (!isRecord(raw)) {
      error('GPT_JSON_INVALID', at, `${at} must be an object (got ${describe(raw)})`)
      return
    }

    let id = typeof raw.candidate_id === 'string' ? raw.candidate_id.trim() : ''
    if (!id) {
      error('GPT_JSON_INVALID', `${at}.candidate_id`, `${at}.candidate_id must be a non-empty string (got ${describe(raw.candidate_id)})`)
      id = `#${index + 1}`
    } else if (id.length > MAX_REASON) {
      error('GPT_JSON_INVALID', `${at}.candidate_id`, `${at}.candidate_id is longer than ${MAX_REASON} characters`)
    } else if (seenIds.has(id)) {
      error('GPT_JSON_INVALID', `${at}.candidate_id`, `Duplicate candidate_id "${id}"`, id)
    }
    seenIds.add(id)

    for (const key of Object.keys(raw)) {
      if (!CANDIDATE_KEYS.has(key)) warn('UNKNOWN_FIELD', `${at}.${key}`, `Unknown field "${key}" on ${id} was ignored`, id)
    }

    // Geometry.
    const bounds = coordinateSystem === SLICE_COORDINATES
      ? boundsFromSliceCorners(raw, at, id, manifest, sliceById, error)
      : coordinateSystem === CANONICAL_COORDINATES
        ? boundsFromCanonical(raw, at, id, manifest, error)
        : null

    // Reason.
    let reason = ''
    if (typeof raw.reason !== 'string' || !raw.reason.trim()) {
      error('GPT_JSON_INVALID', `${at}.reason`, `${id}: reason must be a non-empty string (got ${describe(raw.reason)})`, id)
    } else if (raw.reason.length > MAX_REASON) {
      error('GPT_JSON_INVALID', `${at}.reason`, `${id}: reason is longer than ${MAX_REASON} characters`, id)
    } else if (REASON_PATTERN.test(raw.reason)) {
      reason = raw.reason
    } else {
      reason = normalizeReason(raw.reason)
      if (!reason) {
        error('GPT_JSON_INVALID', `${at}.reason`, `${id}: reason ${describe(raw.reason)} has no usable characters`, id)
      } else {
        warn('REASON_NORMALIZED', `${at}.reason`, `${id}: reason ${describe(raw.reason)} normalized to "${reason}"`, id)
      }
    }

    // Description: needed before export, but review is where it gets fixed.
    let description = ''
    if (raw.description === undefined || raw.description === null || (typeof raw.description === 'string' && !raw.description.trim())) {
      warn('DESCRIPTION_MISSING', `${at}.description`, `${id}: no description — one must be written before export`, id)
    } else if (typeof raw.description !== 'string') {
      error('GPT_JSON_INVALID', `${at}.description`, `${id}: description must be a string (got ${describe(raw.description)})`, id)
    } else {
      description = raw.description.trim()
      if (description.length > MAX_TEXT) {
        description = description.slice(0, MAX_TEXT)
        warn('TEXT_TRUNCATED', `${at}.description`, `${id}: description cut to ${MAX_TEXT} characters`, id)
      }
      const words = wordCount(description)
      if (words < 12 || words > 35 || !description.endsWith('.')) {
        warn('DESCRIPTION_OFF_SPEC', `${at}.description`, `${id}: description should be one sentence of 12–35 words ending in a period (has ${words} word${words === 1 ? '' : 's'}${description.endsWith('.') ? '' : ', no final period'})`, id)
      }
    }

    let evidence = ''
    if (typeof raw.visual_evidence === 'string' && raw.visual_evidence.trim()) {
      evidence = raw.visual_evidence.trim().slice(0, MAX_TEXT)
    } else if (raw.visual_evidence !== undefined && raw.visual_evidence !== null && typeof raw.visual_evidence !== 'string') {
      error('GPT_JSON_INVALID', `${at}.visual_evidence`, `${id}: visual_evidence must be a string (got ${describe(raw.visual_evidence)})`, id)
    } else {
      warn('EVIDENCE_MISSING', `${at}.visual_evidence`, `${id}: no visual_evidence given`, id)
    }

    const reviewFlags: string[] = []
    const unknownFlags: string[] = []
    if (raw.review_flags === undefined) {
      // Absent means none.
    } else if (!Array.isArray(raw.review_flags) || raw.review_flags.some(f => typeof f !== 'string')) {
      error('GPT_JSON_INVALID', `${at}.review_flags`, `${id}: review_flags must be an array of strings`, id)
    } else {
      for (const flag of raw.review_flags as string[]) {
        const clean = flag.trim().slice(0, MAX_REASON)
        if (KNOWN_FLAGS.has(clean)) {
          if (!reviewFlags.includes(clean)) reviewFlags.push(clean)
        } else if (clean) {
          unknownFlags.push(clean)
          warn('UNKNOWN_REVIEW_FLAG', `${at}.review_flags`, `${id}: review flag ${describe(clean)} is not in the vocabulary; kept as a note only`, id)
        }
      }
    }

    if (bounds) {
      candidates.push({
        candidate_id: id,
        reason,
        bounds,
        description,
        visual_evidence: evidence,
        review_flags: reviewFlags,
        unknown_flags: unknownFlags,
        slices: slicesSpanned(bounds, manifest.slices)
      })
    }
  })

  if (errors.length > 0) return { analysis: null, errors, warnings }

  if (candidates.length === 0) {
    warn('EMPTY_CANDIDATES', 'candidates', 'ChatGPT proposed no crops. Export will need an explicit confirmation that this page has no eligible artwork.')
  }
  if (root.page_inspection_complete === false) {
    warn('GPT_VISUAL_UNCERTAINTY', 'page_inspection_complete', 'ChatGPT says it could not fully inspect the page — check its page flags and sweep the page yourself')
  }

  // Reading order: top to bottom, then left to right. Ids stay ChatGPT's own;
  // final crop ids are assigned only at export, after review.
  candidates.sort((a, b) => a.bounds.y0 - b.bounds.y0 || a.bounds.x0 - b.bounds.x0)

  return {
    analysis: {
      schema_version: IMPORT_SCHEMA,
      job_id: manifest.job_id,
      source_sha256: source.sha256,
      page_stem: source.page_stem,
      source_width: source.width,
      source_height: source.height,
      reply_coordinate_system: coordinateSystem as string,
      response_sha256: sha256Hex(content),
      page_inspection_complete: root.page_inspection_complete as boolean,
      page_review_flags: pageFlags,
      candidates,
      warnings
    },
    errors,
    warnings
  }
}

export type ErrorSink = (code: ImportIssueCode, field: string, message: string, candidateId?: string) => void

function readInteger(value: unknown, field: string, id: string, error: ErrorSink): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    error('GPT_COORDINATES_INVALID', field, `${id}: ${field.split('.').slice(-2).join('.')} must be a number (got ${describe(value)})`, id)
    return null
  }
  if (!Number.isInteger(value)) {
    error('GPT_COORDINATES_INVALID', field, `${id}: ${field.split('.').slice(-2).join('.')} must be a whole pixel (got ${value})`, id)
    return null
  }
  return value
}

/** Rejects an inverted or out-of-page box. Never clamps. */
function checkBounds(bounds: PixelBounds, at: string, id: string, manifest: HandoffManifest, sink: ErrorSink): PixelBounds | null {
  const { width, height } = manifest.source
  let ok = true
  const error: ErrorSink = (...args) => { ok = false; sink(...args) }
  if (bounds.x0 < 0 || bounds.x1 > width) {
    error('GPT_COORDINATES_INVALID', at, `${id}: x ${bounds.x0}–${bounds.x1} runs outside the page width 0–${width}`, id)
  }
  if (bounds.y0 < 0 || bounds.y1 > height) {
    error('GPT_COORDINATES_INVALID', at, `${id}: y ${bounds.y0}–${bounds.y1} runs outside the page height 0–${height}`, id)
  }
  if (bounds.x1 <= bounds.x0 || bounds.y1 <= bounds.y0) {
    error('GPT_COORDINATES_INVALID', at, `${id}: box (${bounds.x0},${bounds.y0})–(${bounds.x1},${bounds.y1}) has no area — the bottom-right corner must be below and right of the top-left`, id)
  }
  return ok ? bounds : null
}

function boundsFromCanonical(
  raw: Record<string, unknown>,
  at: string,
  id: string,
  manifest: HandoffManifest,
  error: ErrorSink
): PixelBounds | null {
  if (!isRecord(raw.bounds)) {
    error('GPT_COORDINATES_INVALID', `${at}.bounds`, `${id}: bounds must be an object {x0, y0, x1, y1} (got ${describe(raw.bounds)})`, id)
    return null
  }
  const b = raw.bounds
  const x0 = readInteger(b.x0, `${at}.bounds.x0`, id, error)
  const y0 = readInteger(b.y0, `${at}.bounds.y0`, id, error)
  const x1 = readInteger(b.x1, `${at}.bounds.x1`, id, error)
  const y1 = readInteger(b.y1, `${at}.bounds.y1`, id, error)
  if (x0 === null || y0 === null || x1 === null || y1 === null) return null
  return checkBounds({ x0, y0, x1, y1 }, `${at}.bounds`, id, manifest, error)
}

export function boundsFromSliceCorners(
  raw: Record<string, unknown>,
  at: string,
  id: string,
  manifest: HandoffManifest,
  sliceById: Map<string, HandoffSlice>,
  error: ErrorSink
): PixelBounds | null {
  const corner = (name: 'top_left' | 'bottom_right'): { x: number; y: number } | null => {
    const value = raw[name]
    const field = `${at}.${name}`
    if (!isRecord(value)) {
      error('GPT_COORDINATES_INVALID', field, `${id}: ${name} must be an object {slice_id, x, y} (got ${describe(value)})`, id)
      return null
    }
    const slice = typeof value.slice_id === 'string' ? sliceById.get(value.slice_id) : undefined
    if (!slice) {
      error('GPT_COORDINATES_INVALID', `${field}.slice_id`, `${id}: ${name}.slice_id ${describe(value.slice_id)} is not one of this page's slices (${[...sliceById.keys()].join(', ')})`, id)
      return null
    }
    const x = readInteger(value.x, `${field}.x`, id, error)
    const y = readInteger(value.y, `${field}.y`, id, error)
    if (x === null || y === null) return null
    // Checked in the slice's own grid first: the message then points at the
    // number ChatGPT actually wrote, not at a derived page coordinate.
    if (x < 0 || x > slice.width) {
      error('GPT_COORDINATES_INVALID', `${field}.x`, `${id}: ${name}.x ${x} is outside ${slice.id}'s width 0–${slice.width}`, id)
      return null
    }
    if (y < 0 || y > slice.height) {
      error('GPT_COORDINATES_INVALID', `${field}.y`, `${id}: ${name}.y ${y} is outside ${slice.id}'s height 0–${slice.height}`, id)
      return null
    }
    return { x: slice.x0 + x, y: slice.y0 + y }
  }

  const topLeft = corner('top_left')
  const bottomRight = corner('bottom_right')
  if (!topLeft || !bottomRight) return null
  return checkBounds({ x0: topLeft.x, y0: topLeft.y, x1: bottomRight.x, y1: bottomRight.y }, at, id, manifest, error)
}

// ============ Storing ============

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, content, 'utf-8')
  await fs.rename(temp, filePath)
}

export interface ImportOutcome {
  imported: boolean
  analysis: ImportedAnalysis | null
  errors: ImportIssue[]
  warnings: ImportIssue[]
}

/**
 * Validates a reply against the page's CURRENT package and, only if it passes,
 * stores it: the text exactly as pasted (provenance, never rewritten) plus the
 * converted candidates. A rejected reply writes nothing, so a bad paste can
 * never overwrite the last good import.
 *
 * A package whose slice FILES changed is still importable — the geometry comes
 * from the source's size, which the hash pins — but one whose SOURCE changed is
 * not: the reply describes pixels that no longer exist.
 */
export async function importAnalysis(folderPath: string, imageFilename: string, content: string): Promise<ImportOutcome> {
  const handoff = await getHandoffStatus(folderPath, imageFilename)
  if (handoff.status === 'none' || !handoff.manifest) {
    return {
      imported: false,
      analysis: null,
      errors: [{ code: 'HANDOFF_MISSING', field: '', message: 'This page has no ChatGPT package. Build the package, send it, then import the reply.' }],
      warnings: []
    }
  }
  const blocking = handoff.staleReasons.filter(r => r.code !== 'SLICES_CHANGED')
  if (blocking.length > 0) {
    return {
      imported: false,
      analysis: null,
      errors: blocking.map(r => ({ code: 'HANDOFF_STALE' as const, field: '', message: `${r.message}. Rebuild the package and ask ChatGPT again.` })),
      warnings: []
    }
  }

  const parsed = parseAnalysis(content, handoff.manifest)
  if (!parsed.analysis) {
    return { imported: false, analysis: null, errors: parsed.errors, warnings: parsed.warnings }
  }

  const studioDirectory = getStudioDir(folderPath, imageFilename)
  const importsDir = path.join(studioDirectory, IMPORTS_DIR)
  await fs.mkdir(importsDir, { recursive: true })

  const importedAt = new Date().toISOString()
  const responseFile = path.join(IMPORTS_DIR, `${importedAt.replace(/[:.]/g, '-')}-${RESPONSE_FILE}`)
  const analysis: ImportedAnalysis = { ...parsed.analysis, imported_at: importedAt, response_file: responseFile }

  await writeFileAtomic(path.join(studioDirectory, responseFile), content)
  await writeFileAtomic(path.join(studioDirectory, RESPONSE_FILE), content)
  await writeFileAtomic(path.join(studioDirectory, IMPORTED_ANALYSIS_FILE), JSON.stringify(analysis, null, 2) + '\n')

  return { imported: true, analysis, errors: [], warnings: parsed.warnings }
}

export interface AnalysisStatus {
  analysis: ImportedAnalysis | null
  /** True when the page or its package no longer matches what the import was checked against. */
  stale: boolean
  staleReasons: string[]
}

/** The page's last accepted import, and whether it still applies to the page on disk. */
export async function getAnalysisStatus(folderPath: string, imageFilename: string): Promise<AnalysisStatus> {
  let analysis: ImportedAnalysis
  try {
    analysis = JSON.parse(
      await fs.readFile(path.join(getStudioDir(folderPath, imageFilename), IMPORTED_ANALYSIS_FILE), 'utf-8')
    ) as ImportedAnalysis
  } catch {
    return { analysis: null, stale: false, staleReasons: [] }
  }

  const handoff = await getHandoffStatus(folderPath, imageFilename)
  const staleReasons: string[] = []
  if (!handoff.manifest) {
    staleReasons.push('The ChatGPT package it was checked against is gone')
  } else {
    if (handoff.manifest.job_id !== analysis.job_id) staleReasons.push('The page was re-packaged under a different job id')
    for (const reason of handoff.staleReasons) {
      if (reason.code !== 'SLICES_CHANGED') staleReasons.push(reason.message)
    }
  }
  return { analysis, stale: staleReasons.length > 0, staleReasons }
}
