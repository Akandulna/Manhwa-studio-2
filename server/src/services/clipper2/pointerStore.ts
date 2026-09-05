/**
 * Image Clipper 2.0 — the pointer artifact on disk.
 *
 * Stage 1 (detection) writes a `four-point-crop` JSON file and Stage 2 (apply)
 * reads it back, but the file is not a cache: the user can open it, hand-edit
 * the pointers, and re-apply without re-running the vision model. It is a
 * first-class artifact, so exactly one module is allowed to know where it lives
 * and how its bytes are produced — this one.
 *
 * Canonical-bytes contract:
 *  - writePointsFile() is the only path that serializes a FourPointCropFile,
 *    and it goes through serializeCropFile so the file on disk always matches
 *    §14.7 literally: key order, 2-space indent, expanded point objects
 *    (`OUT-15`).
 *  - writePointsText() is the deliberate exception. It carries the user's own
 *    keystrokes from the editor through untouched — reformatting a file someone
 *    is mid-edit on would fight them — so text is validated on read, not write.
 *  - The sidecar is explicitly non-canonical (§14 fixes the artifact's shape and
 *    has no room for provenance), so it is plain JSON and a corrupt one is never
 *    fatal.
 *
 * No Gemini and no express here: paths and bytes only.
 */

import fs from 'fs/promises'
import path from 'path'
import type {
  CropPointsSidecar,
  FourPointCropFile,
  ValidationReport
} from './fourPointTypes.js'
import { parseCropFile, serializeCropFile } from './fourPointSchema.js'

// ============ Paths ============

/**
 * Mirrors clipperService.getFullFolderPath. The two must resolve identically —
 * Stage 2 hands relative folder paths to executeCrop, which re-resolves them
 * with its own copy of this logic. DOWNLOAD_ROOT defaults to './downloads', so
 * these paths are relative by default; only writePointsFile promises absolute.
 */
function getFullFolderPath(relativePath: string): string {
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
  return path.join(downloadRoot, relativePath)
}

/** The chapter's source images. Stage 2 uses this to fail fast on a missing chapter. */
export function getSourceFolderPath(folderPath: string): string {
  return getFullFolderPath(folderPath)
}

export function getPointsDir(folderPath: string): string {
  return path.join(getFullFolderPath(folderPath), 'crop_points')
}

export function getPointsFilePath(folderPath: string): string {
  return path.join(getPointsDir(folderPath), 'crop_points.json')
}

export function getSidecarFilePath(folderPath: string): string {
  return path.join(getPointsDir(folderPath), 'crop_points.meta.json')
}

/**
 * Stage 2's export directory. Kept separate from v1's `crops/` so the two
 * cropping techniques can be run over the same chapter and compared without
 * either one overwriting the other's images.
 */
export function getOutputDir(folderPath: string): string {
  return path.join(getFullFolderPath(folderPath), 'crops2')
}

// ============ Filesystem helpers ============

/**
 * True only for "the path isn't there" errors. ENOTDIR matters as much as
 * ENOENT: when a path component is a file rather than a directory the artifact
 * is equally absent. Anything else (EACCES, EISDIR, EIO) is a real fault and is
 * rethrown rather than reported as "no pointers yet".
 */
function isMissing(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function ensurePointsDir(folderPath: string): Promise<void> {
  await fs.mkdir(getPointsDir(folderPath), { recursive: true })
}

// ============ Canonical file I/O ============

export async function pointsFileExists(folderPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(getPointsFilePath(folderPath))
    return stat.isFile()
  } catch (err) {
    if (isMissing(err)) return false
    throw err
  }
}

/** Raw bytes for the editor. null means "no point set for this chapter yet". */
export async function readPointsText(folderPath: string): Promise<string | null> {
  try {
    return await fs.readFile(getPointsFilePath(folderPath), 'utf-8')
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
}

/**
 * Read + parse + validate in one pass. Returns null only when there is no file.
 *
 * `file` is non-null ONLY for an artifact that passed validation, so any caller
 * holding a non-null `file` holds a checked one; a broken or non-compliant file
 * comes back as `text` plus a `report` for the editor to show and the user to
 * fix. `text` is always the bytes as they sit on disk, never a reserialization.
 */
export async function readPointsFile(
  folderPath: string
): Promise<{ text: string; file: FourPointCropFile | null; report: ValidationReport } | null> {
  const text = await readPointsText(folderPath)
  if (text === null) return null

  // parseCropFile owns both halves of "is this usable": a syntax error in a
  // hand-edited file comes back as a report rather than an exception, and it
  // returns `file` only when validation found zero errors. Duplicating either
  // behavior here would let the two paths drift apart.
  const { file, report } = parseCropFile(text)
  return { text, file, report }
}

/** Write user-supplied text verbatim. Only entry point that accepts unvalidated bytes. */
export async function writePointsText(folderPath: string, text: string): Promise<void> {
  await ensurePointsDir(folderPath)
  await fs.writeFile(getPointsFilePath(folderPath), text, 'utf-8')
}

/** Serialize canonically (`OUT-15`) and write. Returns the absolute path written. */
export async function writePointsFile(folderPath: string, file: FourPointCropFile): Promise<string> {
  await writePointsText(folderPath, serializeCropFile(file))
  // DOWNLOAD_ROOT is relative by default; resolve so callers can hand the path
  // to the UI or a log without depending on the server's cwd.
  return path.resolve(getPointsFilePath(folderPath))
}

// ============ Sidecar I/O ============

/**
 * Informational only, so a missing OR corrupt sidecar both read as null: the
 * apply stage can rebuild the segment map from the chapter folder, and refusing
 * to describe a perfectly good point set because its provenance note got
 * mangled would be the wrong trade.
 */
export async function readSidecar(folderPath: string): Promise<CropPointsSidecar | null> {
  let raw: string
  try {
    raw = await fs.readFile(getSidecarFilePath(folderPath), 'utf-8')
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
  try {
    return JSON.parse(raw) as CropPointsSidecar
  } catch (err) {
    console.warn('[clipper2] ignoring unreadable sidecar:', err)
    return null
  }
}

export async function writeSidecar(folderPath: string, sidecar: CropPointsSidecar): Promise<void> {
  await ensurePointsDir(folderPath)
  await fs.writeFile(getSidecarFilePath(folderPath), JSON.stringify(sidecar, null, 2), 'utf-8')
}

/**
 * Drop the point set. Deletes the canonical file and its sidecar and nothing
 * else — the exported images under crops2/ outlive their pointers on purpose,
 * because Module 4 may already be building a video from them.
 */
export async function deletePointSet(folderPath: string): Promise<void> {
  for (const target of [getPointsFilePath(folderPath), getSidecarFilePath(folderPath)]) {
    try {
      await fs.unlink(target)
    } catch (err) {
      if (!isMissing(err)) throw err
    }
  }
}

// ============ Exported images ============

/**
 * The images Stage 2 produced, natural-sorted so `_pts_002` precedes `_pts_010`
 * (plain lexicographic order would not). An absent directory means "not applied
 * yet", which is an empty list rather than an error.
 */
export async function listOutputs(folderPath: string): Promise<{ filename: string; bytes: number }[]> {
  const dir = getOutputDir(folderPath)

  let entries: string[]
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    entries = dirents
      .filter(d => d.isFile() && path.extname(d.name).toLowerCase() === '.png')
      .map(d => d.name)
  } catch (err) {
    if (isMissing(err)) return []
    throw err
  }

  entries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  const outputs: { filename: string; bytes: number }[] = []
  for (const filename of entries) {
    try {
      const stat = await fs.stat(path.join(dir, filename))
      outputs.push({ filename, bytes: stat.size })
    } catch (err) {
      // Raced with a delete between readdir and stat — just omit it.
      if (!isMissing(err)) throw err
    }
  }
  return outputs
}
