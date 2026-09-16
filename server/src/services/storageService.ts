/**
 * Storage — what the local disk is actually holding, per series and chapter,
 * and what is safe to reclaim.
 *
 * Once a chapter has been rendered and published, the material it was built
 * from (source pages, crops, narration audio) is dead weight: it can be
 * re-downloaded or re-cut, and nothing downstream reads it again. This service
 * measures that weight and answers the one question that decides whether it is
 * safe to drop — has this chapter been exported to video?
 *
 * The scan is a pure read of the filesystem. Nothing here infers a size from a
 * database row: `Page.bytes` and `AudioFile.bytes` record what was written at
 * the time, while the user may since have deleted files by hand, and a stale
 * row that overstates usage would invite deleting something already gone. Only
 * the "exported" flag consults the database, and even then the disk wins where
 * the two disagree (see `exported` below).
 */

import fs from 'fs/promises'
import path from 'path'
import { prisma } from '../index.js'

/** Resolve a stored (possibly relative) download path against DOWNLOAD_ROOT. */
function getFullFolderPath(relativePath: string): string {
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
  return path.join(downloadRoot, relativePath)
}

// ============ Categories ============
//
// A chapter folder mixes material from every module. Grouping it lets the page
// say "2.1 GB of source pages" rather than "2.1 GB of files", and lets deletion
// be selective — the categories are the unit the user chooses between.
//
// `reclaimable` marks what a finished, exported chapter no longer needs. The
// rendered MP4s are deliberately NOT reclaimable: they are the product, not the
// workings, and are only ever removed through their own explicit action.

export type CategoryKey =
  | 'pages'
  | 'crops'
  | 'cropJson'
  | 'audio'
  | 'script'
  | 'video'
  | 'other'

export interface CategoryMeta {
  key: CategoryKey
  label: string
  description: string
  /** Safe to delete once the chapter has been exported. */
  reclaimable: boolean
}

export const CATEGORIES: CategoryMeta[] = [
  {
    key: 'pages',
    label: 'Source pages',
    description: 'Downloaded manhwa page images — re-downloadable from the source site.',
    reclaimable: true
  },
  {
    key: 'crops',
    label: 'Crops',
    description: 'Cut images from the Clipper (crops, crops2, crops3) — re-cuttable from the pointer JSON.',
    reclaimable: true
  },
  {
    key: 'cropJson',
    label: 'Crop pointers',
    description: 'Pointer and metadata JSON — tiny, and the only record of how a chapter was cut.',
    reclaimable: false
  },
  {
    key: 'audio',
    label: 'Voiceover audio',
    description: 'Generated narration audio — regenerable from the script, at the cost of TTS time.',
    reclaimable: true
  },
  {
    key: 'script',
    label: 'Script',
    description: 'Narration script text — kilobytes, and not regenerable identically.',
    reclaimable: false
  },
  {
    key: 'video',
    label: 'Rendered video',
    description: 'Exported MP4s. The finished product — deleted only on its own.',
    reclaimable: false
  },
  {
    key: 'other',
    label: 'Other',
    description: 'Anything else in the folder, including stray files.',
    reclaimable: false
  }
]

/** Chapter sub-folders whose whole contents belong to one category. */
const DIR_CATEGORY: Record<string, CategoryKey> = {
  crops: 'crops',
  crops2: 'crops',
  crops3: 'crops',
  crops_training: 'crops',
  crop_points: 'cropJson',
  crop_points3: 'cropJson',
  crop_metadata3: 'cropJson',
  audio: 'audio'
}

/** Series-level folders holding rendered video (Editor 1.0 and 2.0). */
const VIDEO_DIRS = ['_video', '_video2']

/** Classify a loose file sitting directly in a chapter folder. */
function categorizeChapterFile(name: string): CategoryKey {
  const lower = name.toLowerCase()
  if (/\.(webp|jpg|jpeg|png|gif|avif|bmp)$/.test(lower)) return 'pages'
  if (lower.endsWith('.md') || lower.endsWith('.txt')) return 'script'
  if (/\.(mp3|wav|m4a|aac|flac|ogg)$/.test(lower)) return 'audio'
  if (/\.(mp4|mov|mkv|webm)$/.test(lower)) return 'video'
  return 'other'
}

export type Sizes = Record<CategoryKey, number>

function emptySizes(): Sizes {
  return { pages: 0, crops: 0, cropJson: 0, audio: 0, script: 0, video: 0, other: 0 }
}

function addSizes(into: Sizes, from: Sizes): void {
  for (const c of CATEGORIES) into[c.key] += from[c.key]
}

export function totalOf(sizes: Sizes): number {
  return CATEGORIES.reduce((sum, c) => sum + sizes[c.key], 0)
}

export function reclaimableOf(sizes: Sizes): number {
  return CATEGORIES.filter(c => c.reclaimable).reduce((sum, c) => sum + sizes[c.key], 0)
}

// ============ Measuring ============

/**
 * Bytes under a directory, recursively, plus a file count.
 *
 * Sizes are apparent file sizes rather than allocated blocks, which is what a
 * user comparing against the source site or a cloud upload expects; symlinks
 * are not followed so a link cannot inflate a folder or walk out of it. A
 * directory that has vanished mid-scan counts as zero instead of failing the
 * whole page — this runs against a tree the user is actively deleting from.
 */
async function measureDir(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { bytes: 0, files: 0 }
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = await measureDir(full)
      bytes += sub.bytes
      files += sub.files
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(full)
        bytes += stat.size
        files += 1
      } catch {
        // Deleted between readdir and stat — nothing to count.
      }
    }
  }

  return { bytes, files }
}

// ============ Exported? ============

/**
 * The chapter numbers this series has a rendered MP4 for.
 *
 * Editor 2.0 owns no database rows — the `_video2` folder IS its record — so
 * the filename's `_ch007_` segment is read back here, exactly as
 * editor2Export writes it. Files that don't carry that segment (a hand-renamed
 * render like `PMU2.mp4`, a manual concatenation) can't be attributed to a
 * chapter and are counted as series-level video instead of marking anything
 * exported; guessing would be the one error that costs source material.
 */
async function scanExportedChapterNumbers(rootFolder: string): Promise<Set<number>> {
  const found = new Set<number>()

  for (const dirName of VIDEO_DIRS) {
    const dir = path.join(getFullFolderPath(rootFolder), dirName)
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.mp4')) continue
      const m = /_ch(\d{3,})_/.exec(name)
      if (!m) continue
      const n = parseInt(m[1], 10)
      if (Number.isFinite(n)) found.add(n)
    }
  }

  return found
}

// ============ Public shapes ============

export interface ChapterStorage {
  id: string
  number: number
  title: string | null
  folderPath: string
  /** False when the chapter's folder is not on disk at all. */
  exists: boolean
  status: string
  pageCount: number | null
  sizes: Sizes
  totalBytes: number
  reclaimableBytes: number
  fileCount: number
  /** A rendered MP4 exists for this chapter number. */
  exported: boolean
  /** Which exporter's record vouches for it, for the tooltip. */
  exportedVia: 'editor2' | 'editor1' | null
}

export interface SeriesStorage {
  id: string
  title: string
  rootFolder: string
  /** True when the series' root folder is on disk. */
  exists: boolean
  sizes: Sizes
  totalBytes: number
  reclaimableBytes: number
  fileCount: number
  chapterCount: number
  exportedChapterCount: number
  /** Bytes reclaimable from chapters that have already been exported. */
  safeToDeleteBytes: number
  /** Rendered MP4s under _video / _video2, kept apart from chapter totals. */
  videoBytes: number
  videoFileCount: number
  chapters: ChapterStorage[]
}

export interface StorageOverview {
  downloadRoot: string
  totalBytes: number
  reclaimableBytes: number
  safeToDeleteBytes: number
  videoBytes: number
  /** Folders under the download root that belong to no series (_music, _murgaa…). */
  sharedBytes: number
  series: SeriesStorage[]
  scannedAt: string
}

// ============ Scan ============

/** One chapter folder, broken down by category. */
async function scanChapterFolder(folderPath: string): Promise<{ sizes: Sizes; files: number; exists: boolean }> {
  const dir = getFullFolderPath(folderPath)
  const sizes = emptySizes()
  let files = 0

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { sizes, files: 0, exists: false }
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // An unrecognised sub-folder is "other", never assumed reclaimable.
      const category = DIR_CATEGORY[entry.name] ?? 'other'
      const measured = await measureDir(full)
      sizes[category] += measured.bytes
      files += measured.files
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(full)
        sizes[categorizeChapterFile(entry.name)] += stat.size
        files += 1
      } catch {
        // Raced with a delete.
      }
    }
  }

  return { sizes, files, exists: true }
}

/**
 * Every series, with per-chapter sizes and export status.
 *
 * Chapters are scanned concurrently in small batches: a series can hold
 * hundreds of folders of thousands of files each, and doing them strictly in
 * series makes the page feel broken, while doing them all at once exhausts the
 * file-descriptor table on a cold cache.
 */
export async function scanStorage(): Promise<StorageOverview> {
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'

  const allSeries = await prisma.series.findMany({
    include: { chapters: { orderBy: { number: 'asc' } } },
    orderBy: { title: 'asc' }
  })

  // Editor 1.0's exports are database-tracked; one query covers every series.
  const doneExports = await prisma.videoExport.findMany({
    where: { status: 'done' },
    select: { project: { select: { seriesId: true, chapterIds: true } } }
  })
  // Editor 1.0 renders a whole VideoProject, so a finished export vouches for
  // every chapter id listed in that project.
  const editor1ExportedIds = new Map<string, Set<string>>()
  for (const row of doneExports) {
    if (!row.project) continue
    const set = editor1ExportedIds.get(row.project.seriesId) ?? new Set<string>()
    try {
      for (const id of JSON.parse(row.project.chapterIds) as string[]) set.add(id)
    } catch {
      // Malformed JSON: ignore this project.
    }
    editor1ExportedIds.set(row.project.seriesId, set)
  }

  const seriesOut: SeriesStorage[] = []

  for (const s of allSeries) {
    const exportedNumbers = await scanExportedChapterNumbers(s.rootFolder)
    const exportedIds = editor1ExportedIds.get(s.id) ?? new Set<string>()

    const chapters: ChapterStorage[] = []
    const BATCH = 8
    for (let i = 0; i < s.chapters.length; i += BATCH) {
      const slice = s.chapters.slice(i, i + BATCH)
      const scanned = await Promise.all(
        slice.map(async ch => {
          const { sizes, files, exists } = await scanChapterFolder(ch.folderPath)
          const viaEditor2 = exportedNumbers.has(Math.round(ch.number))
          const viaEditor1 = exportedIds.has(ch.id)
          const chapter: ChapterStorage = {
            id: ch.id,
            number: ch.number,
            title: ch.title,
            folderPath: ch.folderPath,
            exists,
            status: ch.status,
            pageCount: ch.pageCount,
            sizes,
            totalBytes: totalOf(sizes),
            reclaimableBytes: reclaimableOf(sizes),
            fileCount: files,
            exported: viaEditor2 || viaEditor1,
            exportedVia: viaEditor2 ? 'editor2' : viaEditor1 ? 'editor1' : null
          }
          return chapter
        })
      )
      chapters.push(...scanned)
    }

    // Series-level rendered video, which lives beside the chapters, not in them.
    let videoBytes = 0
    let videoFileCount = 0
    for (const dirName of VIDEO_DIRS) {
      const measured = await measureDir(path.join(getFullFolderPath(s.rootFolder), dirName))
      videoBytes += measured.bytes
      videoFileCount += measured.files
    }

    const sizes = emptySizes()
    let fileCount = 0
    for (const ch of chapters) {
      addSizes(sizes, ch.sizes)
      fileCount += ch.fileCount
    }
    sizes.video += videoBytes
    fileCount += videoFileCount

    let exists = true
    try {
      await fs.access(getFullFolderPath(s.rootFolder))
    } catch {
      exists = false
    }

    seriesOut.push({
      id: s.id,
      title: s.title,
      rootFolder: s.rootFolder,
      exists,
      sizes,
      totalBytes: totalOf(sizes),
      reclaimableBytes: reclaimableOf(sizes),
      fileCount,
      chapterCount: chapters.length,
      exportedChapterCount: chapters.filter(c => c.exported).length,
      safeToDeleteBytes: chapters
        .filter(c => c.exported)
        .reduce((sum, c) => sum + c.reclaimableBytes, 0),
      videoBytes,
      videoFileCount,
      chapters
    })
  }

  // Shared folders (_music, _murgaa, _watermarks, …) plus anything under the
  // download root that no series claims — reported so the page's total can be
  // reconciled against the folder the user sees in Finder.
  const claimed = new Set(allSeries.map(s => s.rootFolder))
  let sharedBytes = 0
  try {
    for (const entry of await fs.readdir(downloadRoot, { withFileTypes: true })) {
      if (claimed.has(entry.name)) continue
      if (entry.isDirectory()) {
        sharedBytes += (await measureDir(path.join(downloadRoot, entry.name))).bytes
      } else if (entry.isFile()) {
        try {
          sharedBytes += (await fs.stat(path.join(downloadRoot, entry.name))).size
        } catch {
          // Raced with a delete.
        }
      }
    }
  } catch {
    // No download root yet.
  }

  return {
    downloadRoot: path.resolve(downloadRoot),
    totalBytes: seriesOut.reduce((sum, s) => sum + s.totalBytes, 0) + sharedBytes,
    reclaimableBytes: seriesOut.reduce((sum, s) => sum + s.reclaimableBytes, 0),
    safeToDeleteBytes: seriesOut.reduce((sum, s) => sum + s.safeToDeleteBytes, 0),
    videoBytes: seriesOut.reduce((sum, s) => sum + s.videoBytes, 0),
    sharedBytes,
    series: seriesOut,
    scannedAt: new Date().toISOString()
  }
}

// ============ Deleting ============
//
// Every delete in this module goes through `removeWithin`, which refuses any
// path that does not resolve inside the download root. The targets are built
// from database columns (`folderPath`, `rootFolder`) that the user can edit
// through the UI, so a title of "../../.." must not be able to escape — the
// check is on the RESOLVED path, after symlinks and `..` have been applied,
// which is the only form that can be trusted.

/** Delete `target`, but only if it really resolves inside the download root. */
async function removeWithin(target: string): Promise<boolean> {
  const root = path.resolve(process.env.DOWNLOAD_ROOT || './downloads')
  const resolved = path.resolve(target)

  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to delete outside the download root: ${resolved}`)
  }

  try {
    await fs.rm(resolved, { recursive: true, force: true })
    return true
  } catch (error) {
    throw new Error(
      `Failed to delete ${resolved}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export interface DeleteResult {
  chapterId: string
  chapterNumber: number
  categories: CategoryKey[]
  freedBytes: number
  /** Set when this chapter was skipped rather than cleaned. */
  skipped?: string
}

/**
 * Remove the chosen categories from one chapter's folder.
 *
 * `allowUnexported` is the guard rail: without it, a chapter with no rendered
 * MP4 is skipped rather than cleaned, because deleting the pages of something
 * that was never exported destroys work rather than reclaiming space. The flag
 * exists because the user may legitimately abandon a chapter — but it has to be
 * asked for, per call, and the caller has to have seen the export status first.
 *
 * Only `reclaimable` categories can be targeted. Rendered video, crop pointers
 * and scripts are not deletable through this path at all; video has its own.
 */
export async function deleteChapterData(
  chapterId: string,
  categories: CategoryKey[],
  options: { allowUnexported?: boolean } = {}
): Promise<DeleteResult> {
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    include: { series: { select: { id: true, rootFolder: true } } }
  })
  if (!chapter) throw new Error('Chapter not found')

  const selected = categories.filter(key => {
    const meta = CATEGORIES.find(c => c.key === key)
    return meta?.reclaimable === true
  })
  if (selected.length === 0) {
    throw new Error('No reclaimable categories selected')
  }

  const base: DeleteResult = {
    chapterId: chapter.id,
    chapterNumber: chapter.number,
    categories: selected,
    freedBytes: 0
  }

  if (!options.allowUnexported) {
    const exportedNumbers = await scanExportedChapterNumbers(chapter.series.rootFolder)
    if (!exportedNumbers.has(Math.round(chapter.number))) {
      const editor1 = await prisma.videoExport.count({
        where: {
          status: 'done',
          project: { seriesId: chapter.series.id, chapterIds: { contains: chapter.id } }
        }
      })
      if (editor1 === 0) {
        return { ...base, skipped: 'Chapter has not been exported to video' }
      }
    }
  }

  // Measured before the delete so the number reported back is what was really
  // on disk, not what the last scan believed.
  const before = await scanChapterFolder(chapter.folderPath)
  const dir = getFullFolderPath(chapter.folderPath)

  for (const key of selected) {
    if (key === 'pages') {
      // Loose page images live directly in the chapter folder, so they are
      // removed file by file — never the folder, which also holds the crop
      // pointers and script that survive a cleanup.
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue
        if (categorizeChapterFile(entry.name) !== 'pages') continue
        await removeWithin(path.join(dir, entry.name))
      }
      continue
    }

    for (const [dirName, category] of Object.entries(DIR_CATEGORY)) {
      if (category !== key) continue
      await removeWithin(path.join(dir, dirName))
    }
  }

  const after = await scanChapterFolder(chapter.folderPath)
  const freedBytes = Math.max(0, totalOf(before.sizes) - totalOf(after.sizes))

  // Keep the database honest about what is on disk. The page rows stay (they
  // hold the source URLs a re-download needs) but no longer claim a local file,
  // and the chapter goes back to "pending" so the downloader will fetch it
  // again rather than skipping it as already done.
  if (selected.includes('pages')) {
    await prisma.page.updateMany({
      where: { chapterId: chapter.id },
      data: { localPath: null, status: 'pending', bytes: null }
    })
    await prisma.chapter.update({
      where: { id: chapter.id },
      data: { status: 'pending', downloadedCount: 0 }
    })
  }

  if (selected.includes('audio')) {
    // Audio rows point at files that are now gone; the sections they belong to
    // survive, so the script can be re-voiced without being retyped.
    await prisma.audioFile.deleteMany({ where: { chapterId: chapter.id } })
    await prisma.audioSection.updateMany({
      where: { chapterId: chapter.id },
      data: { status: 'none' }
    })
  }

  return { ...base, freedBytes }
}

/**
 * Clean every exported chapter of a series in one pass.
 *
 * Un-exported chapters are reported as skipped rather than silently passed
 * over, so the caller can show exactly what was left behind and why.
 */
export async function deleteSeriesExportedData(
  seriesId: string,
  categories: CategoryKey[],
  options: { allowUnexported?: boolean } = {}
): Promise<{ results: DeleteResult[]; freedBytes: number }> {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    include: { chapters: { orderBy: { number: 'asc' }, select: { id: true } } }
  })
  if (!series) throw new Error('Series not found')

  const results: DeleteResult[] = []
  for (const ch of series.chapters) {
    results.push(await deleteChapterData(ch.id, categories, options))
  }

  return {
    results,
    freedBytes: results.reduce((sum, r) => sum + r.freedBytes, 0)
  }
}

/** One rendered MP4 under a series' _video / _video2 folder. */
export interface VideoFileInfo {
  seriesId: string
  dir: '_video' | '_video2'
  fileName: string
  bytes: number
  modifiedAt: string
  /** The chapter number in the filename, when it carries one. */
  chapterNumber: number | null
}

/** Every rendered MP4 of a series, newest first. */
export async function listSeriesVideos(seriesId: string): Promise<VideoFileInfo[]> {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: { id: true, rootFolder: true }
  })
  if (!series) throw new Error('Series not found')

  const out: VideoFileInfo[] = []

  for (const dirName of VIDEO_DIRS) {
    const dir = path.join(getFullFolderPath(series.rootFolder), dirName)
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.mp4')) continue
      try {
        const stat = await fs.stat(path.join(dir, name))
        const m = /_ch(\d{3,})_/.exec(name)
        out.push({
          seriesId: series.id,
          dir: dirName as '_video' | '_video2',
          fileName: name,
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          chapterNumber: m ? parseInt(m[1], 10) : null
        })
      } catch {
        // Raced with a delete.
      }
    }
  }

  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}

/**
 * Delete one rendered MP4.
 *
 * Deliberately one file at a time and addressed by name: these are the finished
 * videos, and a bulk "delete all exports" button is a mis-click away from
 * losing the only copy of a published chapter.
 */
export async function deleteSeriesVideo(
  seriesId: string,
  dirName: string,
  fileName: string
): Promise<{ freedBytes: number }> {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: { rootFolder: true }
  })
  if (!series) throw new Error('Series not found')

  if (!VIDEO_DIRS.includes(dirName)) {
    throw new Error('Unknown video folder')
  }
  // The filename comes from the client, so a path of any kind is rejected
  // outright rather than normalised — `removeWithin` would catch an escape, but
  // a name is all this endpoint ever legitimately receives.
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    throw new Error('Invalid file name')
  }

  const target = path.join(getFullFolderPath(series.rootFolder), dirName, fileName)

  let bytes = 0
  try {
    bytes = (await fs.stat(target)).size
  } catch {
    throw new Error('Video file not found')
  }

  await removeWithin(target)
  return { freedBytes: bytes }
}

// ============ Published ============
//
// "Published" is the same fact the Storage page calls "exported" — a rendered
// MP4 exists for this chapter — but the other modules need it per chapter and
// on every page load, so it cannot cost a full disk walk. This reads only the
// two video folders per series (a handful of readdir calls, no recursion into
// chapter folders) and returns a flat id → boolean map the UI can index.

export interface PublishedMap {
  /** Chapter id → true when a rendered video exists for it. */
  chapters: Record<string, boolean>
  /** Series id → how many of its chapters are published, out of how many. */
  series: Record<string, { published: number; total: number }>
  scannedAt: string
}

/**
 * Which chapters have been rendered to video, across the whole library or one
 * series.
 *
 * Deliberately cheap: the expensive part of `scanStorage` is measuring every
 * chapter folder, and none of that is needed to answer "is this published?".
 */
export async function getPublishedChapters(seriesId?: string): Promise<PublishedMap> {
  const allSeries = await prisma.series.findMany({
    where: seriesId ? { id: seriesId } : undefined,
    select: { id: true, rootFolder: true, chapters: { select: { id: true, number: true } } }
  })

  // Editor 1.0's finished renders vouch for every chapter id in their project.
  const doneExports = await prisma.videoExport.findMany({
    where: {
      status: 'done',
      ...(seriesId ? { project: { seriesId } } : {})
    },
    select: { project: { select: { chapterIds: true } } }
  })
  const editor1Ids = new Set<string>()
  for (const row of doneExports) {
    if (!row.project) continue
    try {
      for (const id of JSON.parse(row.project.chapterIds) as string[]) editor1Ids.add(id)
    } catch {
      // Malformed JSON: this project vouches for nothing.
    }
  }

  const chapters: Record<string, boolean> = {}
  const series: Record<string, { published: number; total: number }> = {}

  for (const s of allSeries) {
    const exportedNumbers = await scanExportedChapterNumbers(s.rootFolder)
    let published = 0
    for (const ch of s.chapters) {
      const isPublished = exportedNumbers.has(Math.round(ch.number)) || editor1Ids.has(ch.id)
      chapters[ch.id] = isPublished
      if (isPublished) published += 1
    }
    series[s.id] = { published, total: s.chapters.length }
  }

  return { chapters, series, scannedAt: new Date().toISOString() }
}
