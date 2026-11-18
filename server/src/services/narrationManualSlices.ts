import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { AGY_MAX_SIDE, prepareChapterPages } from './antigravity/narrationPieces.js'

/**
 * The English manual prompts (Replace script → Create with prompts, and "Continue manually" after Prohibited content)
 * attach the chapter's pages cut into pieces of at most 2,000 px, like AntiGravity Narration and the phone, so a
 * chatbot reads a 12,000 px page at full size. The pieces go to a temporary folder when the first prompt is copied,
 * and the folder is deleted once the pasted script is saved. Source page files are never changed.
 */

export const MANUAL_SLICE_MAX_SIDE = AGY_MAX_SIDE

export interface ManualPiece {
  /** File name in the temporary folder, e.g. P0003-T002.jpg. */
  file: string
  page: number
  part: number
  parts: number
  /** The page's own file name in the chapter folder. */
  source: string
}

const ROOT = path.join(os.tmpdir(), 'manhwa-studio-manual-slices')
const MANIFEST = '.slices.json'
/** Folders left behind by a dialog that was never saved are removed after this long. */
const STALE_MS = 24 * 60 * 60 * 1000

export function manualSlicesDir(chapterId: string): string {
  if (!/^[\w-]+$/.test(chapterId)) throw new Error('Invalid chapter id')
  return path.join(ROOT, chapterId)
}

const sameSources = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i])

/** The pieces already cut for exactly these pages (in this order), or null when they need cutting. */
export async function readManualSlices(chapterId: string, sources: string[]): Promise<ManualPiece[] | null> {
  const dir = manualSlicesDir(chapterId)
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf-8')) as { sources?: string[]; pieces?: ManualPiece[] }
    if (!Array.isArray(manifest.sources) || !Array.isArray(manifest.pieces) || !sameSources(manifest.sources, sources)) return null
    await Promise.all(manifest.pieces.map(p => fs.access(path.join(dir, p.file))))
    return manifest.pieces
  } catch { return null }
}

async function pruneStale(keep: string) {
  const entries = await fs.readdir(ROOT, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries.filter(e => e.isDirectory() && e.name !== keep).map(async e => {
    const dir = path.join(ROOT, e.name)
    const stat = await fs.stat(dir).catch(() => null)
    if (stat && Date.now() - stat.mtimeMs > STALE_MS) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }))
}

const running = new Map<string, Promise<ManualPiece[]>>()

/** Cuts [pages] (absolute file + its name, in chapter order) into the chapter's temporary folder. */
export function sliceManualPages(chapterId: string, pages: { file: string; source: string }[]): Promise<ManualPiece[]> {
  const existing = running.get(chapterId)
  if (existing) return existing
  const job = (async () => {
    const dir = manualSlicesDir(chapterId)
    await pruneStale(chapterId)
    const cut = await prepareChapterPages(pages, dir, null, MANUAL_SLICE_MAX_SIDE)
    const pieces: ManualPiece[] = cut.map(p => ({ file: path.basename(p.file), page: p.page, part: p.part, parts: p.parts, source: p.source }))
    await fs.writeFile(path.join(dir, MANIFEST), JSON.stringify({ sources: pages.map(p => p.source), pieces }, null, 2))
    return pieces
  })().finally(() => running.delete(chapterId))
  running.set(chapterId, job)
  return job
}

/** Deletes the chapter's temporary folder (after its pasted script is saved). */
export async function removeManualSlices(chapterId: string): Promise<void> {
  await fs.rm(manualSlicesDir(chapterId), { recursive: true, force: true })
}
