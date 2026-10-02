/**
 * Disk reconcile — bring the database back in line with files deleted by hand.
 *
 * Every chapter list in the app (Library, Series, Clipper 3, Editor 2.0) is
 * built from `Chapter.status`, which only changes when the app itself writes
 * or deletes something. A chapter folder removed in Finder therefore stays
 * "done" forever, still offering pages and audio that are gone.
 *
 * This pass reads the disk and applies the same database changes the Storage
 * page's own delete makes (see storageService.deleteChapterData):
 *
 *  - A "done" chapter with none of its page images left goes back to
 *    "pending" — page rows keep their source URLs for a re-download, but no
 *    longer claim a local file — and carries an error saying why, so the row is
 *    flagged rather than silently changing state.
 *  - A chapter that still has some pages is left alone in the database; the
 *    gap is only reported (`missingPages`). Trimming credit/ad pages by hand is
 *    deliberate, and marking those rows pending would make the downloader fetch
 *    them straight back.
 *  - Audio rows whose file is gone are dropped and their section reset, so the
 *    voiceover editor stops offering playback of nothing.
 *
 * It is a readdir per chapter folder plus a stat per audio row, cheap enough to
 * run in front of every listing. Concurrent callers share one in-flight pass.
 */

import fs from 'fs/promises'
import path from 'path'
import { prisma } from '../index.js'

export const FILES_DELETED_ERROR = 'Files were deleted from disk — download again to restore'

export interface ReconcileResult {
  /** Chapters reset to pending because every page image was gone. */
  resetChapters: string[]
  /** chapterId → page files the database lists that are missing on disk. */
  missingPages: Record<string, number>
  /** Audio rows removed because their file was gone. */
  removedAudio: number
}

function downloadRoot(): string {
  return process.env.DOWNLOAD_ROOT || './downloads'
}

/** File names in a directory, or null when the directory itself is gone. */
async function listNames(dir: string): Promise<Set<string> | null> {
  try {
    return new Set(await fs.readdir(dir))
  } catch {
    return null
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function runReconcile(): Promise<ReconcileResult> {
  const result: ReconcileResult = { resetChapters: [], missingPages: {}, removedAudio: 0 }
  const root = downloadRoot()

  const chapters = await prisma.chapter.findMany({
    where: { status: 'done' },
    select: {
      id: true,
      number: true,
      folderPath: true,
      series: { select: { title: true } },
      pages: { where: { status: 'done' }, select: { localPath: true } }
    }
  })

  for (const chapter of chapters) {
    const stored = chapter.pages.map(p => p.localPath).filter((p): p is string => !!p)
    if (stored.length === 0) continue

    // Pages normally all sit in the chapter folder, but each row's own path is
    // what was written, so read every directory the rows point into.
    const dirs = new Map<string, Set<string> | null>()
    let present = 0
    for (const localPath of stored) {
      const dir = path.dirname(path.join(root, localPath))
      if (!dirs.has(dir)) dirs.set(dir, await listNames(dir))
      if (dirs.get(dir)?.has(path.basename(localPath))) present++
    }

    // An unreadable download root (an unmounted drive) looks identical to
    // every chapter being deleted, so nothing is reset in that case.
    if (present === 0) {
      if (!(await exists(root))) continue
      await prisma.$transaction([
        prisma.page.updateMany({
          where: { chapterId: chapter.id },
          data: { localPath: null, status: 'pending', bytes: null }
        }),
        prisma.chapter.update({
          where: { id: chapter.id },
          data: { status: 'pending', downloadedCount: 0, error: FILES_DELETED_ERROR }
        })
      ])
      result.resetChapters.push(chapter.id)
      console.log(`[diskReconcile] ${chapter.series.title} ch${chapter.number}: page files deleted, reset to pending`)
    } else if (present < stored.length) {
      result.missingPages[chapter.id] = stored.length - present
    }
  }

  const audio = await prisma.audioFile.findMany({
    where: { status: 'done' },
    select: { id: true, filePath: true, sectionId: true }
  })
  for (const file of audio) {
    if (await exists(file.filePath)) continue
    await prisma.audioFile.delete({ where: { id: file.id } })
    if (file.sectionId) {
      await prisma.audioSection.updateMany({ where: { id: file.sectionId }, data: { status: 'none' } })
    }
    result.removedAudio++
  }
  if (result.removedAudio > 0) {
    console.log(`[diskReconcile] removed ${result.removedAudio} audio rows whose files were deleted`)
  }

  return result
}

let inFlight: Promise<ReconcileResult> | null = null

/** Reconcile the database with the disk; callers arriving mid-pass share it. */
export function reconcileWithDisk(): Promise<ReconcileResult> {
  if (!inFlight) {
    inFlight = runReconcile().finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

/** Run the reconcile but never let it fail the request in front of it. */
export async function reconcileQuietly(): Promise<ReconcileResult | null> {
  try {
    return await reconcileWithDisk()
  } catch (error) {
    console.error('[diskReconcile] failed:', error)
    return null
  }
}
