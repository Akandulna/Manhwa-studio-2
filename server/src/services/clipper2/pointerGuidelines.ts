/**
 * Pointer Guidelines — Image Clipper 2.0's copy of the Crop Detection Guidelines.
 *
 * This document is the PROMPT Stage 1 is handed verbatim, by both routes that can
 * produce pointers:
 *  - the in-app Gemini detector (pointerDetector.ts → geminiPointerDetector.ts), and
 *  - the manual loop, where the user copies `buildPointerPrompt()` into an external
 *    chat (ChatGPT, Claude, …) and brings the JSON back through `POST …/points/import`.
 *
 * Both paths send the SAME bytes, which is the point: a pointer set produced by hand
 * is judged against the same rules as one produced in-app, and its sha256 is recorded
 * in the sidecar either way — so a point set can always be traced back to the revision
 * of the rules it was produced under.
 *
 * The document's rule IDs — `OUT-08`, `IX-01`, `ST-09`, `AN-02`, … — are also cited
 * throughout the validator and the normalizer, which enforce in code the parts of the
 * contract no model's prose can be trusted to hold exactly (point order,
 * rectangularity, id contiguity).
 *
 * Immutability contract (identical to the v1 engine's, see
 * services/ai/guidelineCropService.ts):
 *  - server/ml/CROP_POINT_GUIDELINES.md is stored read-only (0444).
 *  - Every inference path only ever calls readPointerGuidelines() — nothing on
 *    the detect/apply/import path writes the file, so a run can never mutate the
 *    rules it is being judged against.
 *  - The single writer is writePointerGuidelines(), reached exclusively from the
 *    user-triggered Settings route. It briefly unlocks the file (0644), writes,
 *    updates the meta sidecar, and re-locks it (0444).
 *  - server/ml/CROP_POINT_GUIDELINES.default.md is the shipped default. It is
 *    read-only to this module in the strong sense: it is never written, only
 *    copied out of, so a reset always lands back on the version that shipped.
 *
 * Pure file management: deliberately free of prisma / express imports so both the
 * detector and the Settings route can depend on it.
 */

import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'

// ============ Paths ============

/** process.cwd() is the server/ dir at runtime (mirrors guidelineCropService). */
function getMlDir(): string {
  return path.join(process.cwd(), 'ml')
}

/** The ACTIVE document — the only text detection is allowed to read. */
export function getPointerGuidelinesPath(): string {
  return path.join(getMlDir(), 'CROP_POINT_GUIDELINES.md')
}

/** The shipped default, used to seed a missing active document and to reset. */
export function getPointerGuidelinesDefaultPath(): string {
  return path.join(getMlDir(), 'CROP_POINT_GUIDELINES.default.md')
}

function getPointerGuidelinesMetaPath(): string {
  return path.join(getMlDir(), 'crop_point_guidelines.meta.json')
}

const READ_ONLY_MODE = 0o444
const WRITABLE_MODE = 0o644

// ============ Guidelines file I/O ============

export interface PointerGuidelinesMeta {
  updatedAt: string | null
  sha256: string | null
  present: boolean
  readOnly: boolean
  /** True when the active document is byte-identical to the shipped default. */
  isDefault: boolean
}

/** Best-effort: lock the active file to 0444 if it exists and is writable. */
async function lockFile(): Promise<void> {
  try {
    await fs.chmod(getPointerGuidelinesPath(), READ_ONLY_MODE)
  } catch {
    /* file missing or chmod unsupported — non-fatal */
  }
}

/** Read the active guidelines text. Returns '' if the file is missing. */
export async function readPointerGuidelines(): Promise<string> {
  try {
    return await fs.readFile(getPointerGuidelinesPath(), 'utf-8')
  } catch {
    return ''
  }
}

// ============ The external-AI prompt ============

/**
 * The one line that precedes the guidelines in the manual loop.
 *
 * It says "the same above chapter" because the user pastes this into a chat that
 * ALREADY holds the chapter's page images — in practice the narration script
 * conversation, where the pages were attached at Step 1. That context is what lets
 * the prompt stay this short: it names the task and defers everything else to the
 * document, which already specifies the output format down to the byte (§14.7).
 */
export const POINTER_PROMPT_PREAMBLE =
  'Now for the same above chapter Detect Pointers as per below guidelines'

/**
 * The exact text the user copies into an external AI.
 *
 * Composed here rather than in the client so that the Narration Studio's Step 3 and
 * the Clipper 2.0 workspace copy byte-identical prompts — two surfaces that drift
 * would produce pointer sets that cannot be compared.
 */
export async function buildPointerPrompt(): Promise<string> {
  const guidelines = await readPointerGuidelines()
  if (!guidelines.trim()) return POINTER_PROMPT_PREAMBLE
  return `${POINTER_PROMPT_PREAMBLE}\n\n${guidelines.trim()}\n`
}

/**
 * Read the shipped default. Returns '' if it is missing — callers that cannot
 * proceed without it (resetPointerGuidelines) turn that into a hard error.
 */
export async function readDefaultPointerGuidelines(): Promise<string> {
  try {
    return await fs.readFile(getPointerGuidelinesDefaultPath(), 'utf-8')
  } catch {
    return ''
  }
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex')
}

/** Sidecar write. Shared by the bootstrap seed and the Settings writer so the
 *  recorded sha can never drift from the bytes actually on disk. */
async function writeMetaSidecar(content: string, updatedAtIso: string): Promise<void> {
  await fs.writeFile(
    getPointerGuidelinesMetaPath(),
    JSON.stringify({ updatedAt: updatedAtIso, sha256: sha256(content) }, null, 2)
  )
}

/** Current file metadata for status polls / the Settings editor. */
export async function getPointerGuidelinesMeta(): Promise<PointerGuidelinesMeta> {
  const content = await readPointerGuidelines()
  const present = content.length > 0
  let updatedAt: string | null = null
  try {
    const raw = await fs.readFile(getPointerGuidelinesMetaPath(), 'utf-8')
    updatedAt = JSON.parse(raw).updatedAt ?? null
  } catch {
    // Fall back to the file's mtime when no meta sidecar exists yet.
    try {
      const stat = await fs.stat(getPointerGuidelinesPath())
      updatedAt = stat.mtime.toISOString()
    } catch { /* missing */ }
  }
  let readOnly = false
  try {
    const stat = await fs.stat(getPointerGuidelinesPath())
    // No owner-write bit set → read-only.
    readOnly = (stat.mode & 0o200) === 0
  } catch { /* missing */ }
  // Compared on content, not on the sidecar: a hand-edited file (which bypasses
  // writePointerGuidelines entirely) must still report isDefault: false.
  const defaultContent = await readDefaultPointerGuidelines()
  const isDefault = present && defaultContent.length > 0 && sha256(content) === sha256(defaultContent)
  return { updatedAt, sha256: present ? sha256(content) : null, present, readOnly, isDefault }
}

/**
 * Idempotent bootstrap, safe to call on every status poll.
 *
 * Seeds the active document from the shipped default when it is missing or
 * empty, then enforces 0444. This is the one write that is not user-initiated,
 * and it is restricted to the missing/empty case precisely so it can never
 * clobber a user's edits: an existing non-empty document is only permission-
 * corrected, never rewritten. A missing default is not fatal here — the file
 * simply stays absent and readPointerGuidelines() returns '', which the
 * detector surfaces as "no guidelines".
 */
export async function ensurePointerGuidelines(): Promise<void> {
  const filePath = getPointerGuidelinesPath()
  let existing = ''
  try {
    existing = await fs.readFile(filePath, 'utf-8')
  } catch { /* missing — seed below */ }

  if (existing.trim().length === 0) {
    const defaultContent = await readDefaultPointerGuidelines()
    if (defaultContent.length > 0) {
      await fs.mkdir(getMlDir(), { recursive: true })
      // A zero-byte file left behind by an interrupted write is already 0444,
      // so unlock before overwriting it.
      try { await fs.chmod(filePath, WRITABLE_MODE) } catch { /* may not exist yet */ }
      await fs.writeFile(filePath, defaultContent, 'utf-8')
      // Refresh the sidecar: one left over from an earlier edit would otherwise
      // report an updatedAt/sha that no longer describes this file.
      await writeMetaSidecar(defaultContent, new Date().toISOString())
    }
  }

  await lockFile()
}

/**
 * The ONLY writer. Intentionally unlocks (0644), writes, and re-locks (0444).
 * Must be reached only from the user-initiated Settings route.
 */
export async function writePointerGuidelines(content: string, updatedAtIso: string): Promise<PointerGuidelinesMeta> {
  const filePath = getPointerGuidelinesPath()
  await fs.mkdir(getMlDir(), { recursive: true })
  // Unlock if it already exists (chmod fails harmlessly if it doesn't).
  try { await fs.chmod(filePath, WRITABLE_MODE) } catch { /* may not exist yet */ }
  await fs.writeFile(filePath, content, 'utf-8')
  await writeMetaSidecar(content, updatedAtIso)
  await lockFile()
  const defaultContent = await readDefaultPointerGuidelines()
  return {
    updatedAt: updatedAtIso,
    sha256: sha256(content),
    present: content.length > 0,
    readOnly: true,
    isDefault: content.length > 0 && defaultContent.length > 0 && sha256(content) === sha256(defaultContent)
  }
}

/**
 * Restore the shipped default. Routed through writePointerGuidelines so the
 * unlock/write/sidecar/re-lock cycle stays in exactly one place.
 */
export async function resetPointerGuidelines(): Promise<PointerGuidelinesMeta> {
  const defaultContent = await readDefaultPointerGuidelines()
  if (defaultContent.length === 0) {
    throw new Error(
      `Cannot reset crop point guidelines: default document missing or empty at ${getPointerGuidelinesDefaultPath()}`
    )
  }
  return writePointerGuidelines(defaultContent, new Date().toISOString())
}
