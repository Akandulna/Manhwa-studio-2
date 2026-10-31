import {withUnmanagedCropChapter} from './managedCropProjection.js'
/**
 * Page bin — remove unwanted pages (credits, ads, recruitment banners) from a
 * downloaded chapter, with a way back.
 *
 *  - A deleted page's file moves to `<chapter>/.deleted-pages/` next to a
 *    record of the Page row it had. The dot keeps the folder out of the
 *    manifest (root files only) and out of R2 zips (the walk skips dotfiles).
 *  - Its Page row is removed and the chapter's pageCount/downloadedCount drop
 *    with it, the same way the stitcher replaces rows. Leaving the row would
 *    make disk reconcile report the page as missing.
 *  - Restore moves the file back and recreates the row; emptying the bin
 *    deletes the files for good.
 *
 * File names are never renumbered: Clipper 3 keys its work by page stem, so
 * renaming later pages would detach their crops. A page Clipper 3 has already
 * worked on cannot be deleted for the same reason.
 */

import fs from 'fs/promises'
import path from 'path'
import { prisma } from '../index.js'
import { getImageFiles } from './chapterManifest.js'
import { StitchPage, measurePages, readRecord } from './pageStitch.js'
import { getMetadataDir, getOutputDir, getPointsFilePathFor } from './clipper3/perImageStore.js'
import { getSliceDir } from './clipper3/perImageSlice.js'

const BIN_DIR = '.deleted-pages'
const RECORD_FILE = 'deleted.json'

export interface BinEntry {
  filename: string
  deletedAt: string
  width: number
  height: number
  bytes: number
  /** The Page row the file had, recreated on restore. Null when it had none. */
  row: { index: number; sourceUrl: string | null; status: string; bytes: number | null } | null
}

export interface ChapterPagesState {
  pages: StitchPage[]
  deleted: BinEntry[]
  /** Reasons pages cannot be deleted or restored right now. */
  blockers: string[]
}

export class PageBinError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

interface ChapterRef {
  id: string
  folderPath: string
  status: string
}

function chapterDir(folderPath: string): string {
  return path.join(process.env.DOWNLOAD_ROOT || './downloads', folderPath)
}

function binDir(folderPath: string): string {
  return path.join(chapterDir(folderPath), BIN_DIR)
}

export function binFile(folderPath: string, filename: string): string {
  return path.join(binDir(folderPath), path.basename(filename))
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readBin(folderPath: string): Promise<BinEntry[]> {
  try {
    return JSON.parse(await fs.readFile(path.join(binDir(folderPath), RECORD_FILE), 'utf8'))
  } catch {
    return []
  }
}

async function writeBin(folderPath: string, entries: BinEntry[]): Promise<void> {
  if (entries.length === 0) {
    await fs.rm(binDir(folderPath), { recursive: true, force: true })
    return
  }
  await fs.mkdir(binDir(folderPath), { recursive: true })
  await fs.writeFile(path.join(binDir(folderPath), RECORD_FILE), JSON.stringify(entries, null, 2))
}

async function chapterBlockers(chapter: ChapterRef): Promise<string[]> {
  const blockers: string[] = []
  if (chapter.status !== 'done') blockers.push('The chapter is not fully downloaded.')
  // Undoing a stitch restores the original Page rows wholesale, which would
  // bring back rows for pages deleted in between.
  if (await readRecord(chapter.folderPath)) {
    blockers.push('This chapter has a stitch backup. Undo the stitch or delete its originals in the Page Stitcher first.')
  }
  return blockers
}

/** Why Clipper 3 work exists for this page, or null when it has none. */
async function clipperWorkFor(folderPath: string, filename: string): Promise<string | null> {
  const stem = path.basename(filename).replace(/\.[^/.]+$/, '')
  if (await exists(getPointsFilePathFor(folderPath, filename))) return 'crop points'
  if (await exists(path.join(getMetadataDir(folderPath), `${stem}.json`))) return 'crop metadata'
  if (await exists(getSliceDir(folderPath, filename))) return 'slices'
  const exported = await fs.readdir(getOutputDir(folderPath)).catch(() => [] as string[])
  if (exported.some(name => name.includes(`_${stem}_`))) return 'exported crops'
  return null
}

export async function getChapterPages(chapter: ChapterRef): Promise<ChapterPagesState> {
  const dir = chapterDir(chapter.folderPath)
  const pages = await measurePages(dir, await getImageFiles(dir))
  const deleted = await readBin(chapter.folderPath)
  return { pages, deleted, blockers: await chapterBlockers(chapter) }
}

const busy = new Set<string>()

async function withLock<T>(chapterId: string, run: () => Promise<T>): Promise<T> {
  if (busy.has(chapterId)) throw new PageBinError('This chapter is already being changed', 409)
  busy.add(chapterId)
  try {
    return await run()
  } finally {
    busy.delete(chapterId)
  }
}

function asNames(filenames: unknown): string[] {
  if (!Array.isArray(filenames) || filenames.length === 0 || filenames.some(f => typeof f !== 'string')) {
    throw new PageBinError('filenames must be a non-empty array of page file names')
  }
  return [...new Set(filenames.map(f => path.basename(f)))]
}

async function syncCounts(chapterId: string, delta: number): Promise<void> {
  const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId }, select: { pageCount: true } })
  const downloaded = await prisma.page.count({ where: { chapterId, status: 'done' } })
  await prisma.chapter.update({
    where: { id: chapterId },
    data: {
      pageCount: chapter.pageCount === null ? null : Math.max(0, chapter.pageCount + delta),
      downloadedCount: downloaded
    }
  })
}

async function deletePagesLegacy(chapter: ChapterRef, filenames: unknown): Promise<number> {
  const names = asNames(filenames)
  return withLock(chapter.id, async () => {
    const blockers = await chapterBlockers(chapter)
    if (blockers.length > 0) throw new PageBinError(blockers[0], 409)

    const dir = chapterDir(chapter.folderPath)
    const files = await getImageFiles(dir)
    const missing = names.find(name => !files.includes(name))
    if (missing) throw new PageBinError(`${missing} is not a page of this chapter — reload and try again`)
    if (names.length >= files.length) throw new PageBinError('Keep at least one page in the chapter')

    for (const name of names) {
      const work = await clipperWorkFor(chapter.folderPath, name)
      if (work) {
        throw new PageBinError(`Image Clipper 3.0 already has ${work} for ${name}. Remove them before deleting the page.`, 409)
      }
    }

    const measured = await measurePages(dir, names)
    const rows = await prisma.page.findMany({
      where: { chapterId: chapter.id, localPath: { in: names.map(n => path.join(chapter.folderPath, n)) } },
      select: { id: true, index: true, sourceUrl: true, status: true, bytes: true, localPath: true }
    })
    const rowFor = new Map(rows.map(r => [path.basename(r.localPath ?? ''), r]))

    const before = await readBin(chapter.folderPath)
    const entries = [...before]
    const deletedAt = new Date().toISOString()
    await fs.mkdir(binDir(chapter.folderPath), { recursive: true })

    const moved: string[] = []
    try {
      for (const page of measured) {
        if (await exists(binFile(chapter.folderPath, page.filename))) {
          throw new PageBinError(`An older ${page.filename} is already in the bin; empty the bin first`, 409)
        }
        await fs.rename(path.join(dir, page.filename), binFile(chapter.folderPath, page.filename))
        moved.push(page.filename)
        const row = rowFor.get(page.filename)
        entries.push({
          filename: page.filename,
          deletedAt,
          width: page.width,
          height: page.height,
          bytes: page.bytes,
          row: row ? { index: row.index, sourceUrl: row.sourceUrl, status: row.status, bytes: row.bytes } : null
        })
      }
      await writeBin(chapter.folderPath, entries)
      await prisma.page.deleteMany({ where: { id: { in: rows.map(r => r.id) } } })
      await syncCounts(chapter.id, -rows.length)
    } catch (error) {
      for (const name of moved) {
        await fs.rename(binFile(chapter.folderPath, name), path.join(dir, name)).catch(err => {
          console.error(`[pageBin] rollback could not move ${name} back:`, err)
        })
      }
      await writeBin(chapter.folderPath, before)
      throw error
    }

    console.log(`[pageBin] ${chapter.folderPath}: deleted ${names.join(', ')}`)
    return names.length
  })
}

async function restorePagesLegacy(chapter: ChapterRef, filenames: unknown): Promise<number> {
  const names = asNames(filenames)
  return withLock(chapter.id, async () => {
    const blockers = await chapterBlockers(chapter)
    if (blockers.length > 0) throw new PageBinError(blockers[0], 409)

    const dir = chapterDir(chapter.folderPath)
    let entries = await readBin(chapter.folderPath)
    const restoring = entries.filter(e => names.includes(e.filename))
    if (restoring.length !== names.length) throw new PageBinError('Some of those pages are not in the bin — reload')

    const present = new Set(await getImageFiles(dir))
    const clash = restoring.find(e => present.has(e.filename))
    if (clash) throw new PageBinError(`${clash.filename} is already in the chapter folder`, 409)

    let restoredRows = 0
    for (const entry of restoring) {
      await fs.rename(binFile(chapter.folderPath, entry.filename), path.join(dir, entry.filename))
      if (entry.row) {
        // The index may have been taken since (a re-download); append instead.
        const taken = await prisma.page.findUnique({
          where: { chapterId_index: { chapterId: chapter.id, index: entry.row.index } },
          select: { id: true }
        })
        const last = await prisma.page.findFirst({
          where: { chapterId: chapter.id },
          orderBy: { index: 'desc' },
          select: { index: true }
        })
        await prisma.page.create({
          data: {
            chapterId: chapter.id,
            index: taken ? (last?.index ?? -1) + 1 : entry.row.index,
            sourceUrl: entry.row.sourceUrl,
            localPath: path.join(chapter.folderPath, entry.filename),
            status: entry.row.status,
            bytes: entry.row.bytes
          }
        })
        restoredRows++
      }
      entries = entries.filter(e => e !== entry)
      await writeBin(chapter.folderPath, entries)
    }
    await syncCounts(chapter.id, restoredRows)

    console.log(`[pageBin] ${chapter.folderPath}: restored ${names.join(', ')}`)
    return restoring.length
  })
}

/** Delete everything in the bin for good. */
async function emptyBinLegacy(chapter: ChapterRef): Promise<number> {
  return withLock(chapter.id, async () => {
    const count = (await readBin(chapter.folderPath)).length
    await fs.rm(binDir(chapter.folderPath), { recursive: true, force: true })
    return count
  })
}

export async function deletePages(chapter: ChapterRef, filenames: unknown):Promise<number> {
 return withUnmanagedCropChapter(chapter.folderPath,()=>deletePagesLegacy(chapter,filenames))
}

export async function restorePages(chapter: ChapterRef, filenames: unknown):Promise<number> {
 return withUnmanagedCropChapter(chapter.folderPath,()=>restorePagesLegacy(chapter,filenames))
}

export async function emptyBin(chapter: ChapterRef):Promise<number> {
 return withUnmanagedCropChapter(chapter.folderPath,()=>emptyBinLegacy(chapter))
}
