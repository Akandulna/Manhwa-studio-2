/**
 * Completed Parts — closing a finished narration Part for good.
 *
 * A manhwa is narrated in Parts of ~20 chapters. A Part ends at the chapter
 * whose English script has `isPartEnd`, or, unmarked, at the last chapter with
 * an exported video (see getSeriesParts). Once every chapter of a Part has its
 * English AND Hindi video exported, the user cuts the final video in another
 * editor and keeps only that. Everything the app made on the way is dead
 * weight, so "Complete Part" deletes it all, locally and in R2:
 *
 *   - each chapter folder (source pages, crops, crop JSON, scripts, audio, …)
 *   - the series-level per-chapter folders (Processed/, Crops/, .crop-studio/,
 *     <Series>/<Series>/<Chapter>/ slices)
 *   - the app's own exports, `chNNN_…` in _video/_video2/_video2_hi — any
 *     other file there (the user's final render) is left alone
 *   - the Part's "Part NN - full script*.md"
 *   - R2: the chapters' phone zips (manhwa/, crops/, voiceover/), editor
 *     packages and timelines, and the phone's script zips once every chapter
 *     in them is completed
 *
 * The one thing kept is each chapter's continuity (rolling summary + closing
 * paragraph, per language), which Part N+1 continues from. It is written to
 * R2 first (`<prefix>archive/<Series>/continuity.json`) — nothing is deleted
 * unless that upload succeeds — and also stays on the ChapterScript rows,
 * which the script generators read. The R2 copy is the fallback when a row
 * has lost it (see readArchivedContinuity).
 *
 * The chapters keep status "done" and get `completedAt`/`completedPart`, so
 * Part numbering still counts them and every module shows them as Completed.
 *
 * Order matters for a crash halfway: backup → database → R2 → disk. Once the
 * database marks the Part completed, running it again only cleans what's left
 * (the export check is not repeated, since the videos are gone by then).
 */

import { workingFiles } from './workingFiles.js'
import fs from 'fs/promises'
import path from 'path'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { readZip } from '../utils/zipReader.js'
import {
  createClient,
  getR2Config,
  invalidateStorage,
  isNotFound,
  isUploadBusy,
  measureBucket,
  missingR2Env,
  type R2Config
} from './r2Service.js'
import {
  VIDEO_DIRS,
  measureDir,
  removeWithin,
  scanExportedChapterNumbers,
  videoChapterNumber,
  videoDirsFor,
  scanSeriesVideoCleanup
} from './storageService.js'
import { NARRATION_LANGUAGES, partExportSuffix, type NarrationLanguage } from './narrationLanguage.js'
import { updatePhoneIndexes } from './phoneSend.js'

/** Desktop-owned folder in R2 for what outlives a completed Part. */
export const ARCHIVE_FOLDER = 'archive/'
const CONTINUITY_NAME = 'continuity.json'
const CONTINUITY_SCHEMA = 'manhwa-studio-continuity/1'

/** Series-level folders that hold one sub-folder per chapter. */
const SERIES_CHAPTER_DIRS = ['Processed', 'Crops', '.crop-studio']

function downloadRoot(): string {
  return process.env.DOWNLOAD_ROOT || './downloads'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ============ Parts ============

export interface PartChapter {
  id: string
  number: number
  title: string | null
  folderPath: string
  exportedEn: boolean
  exportedHi: boolean
  completed: boolean
}

export interface SeriesPart {
  number: number
  firstChapter: number
  lastChapter: number
  /**
   * The Part has an end: its last chapter is marked "Part end" in Narration,
   * or (unmarked) it runs up to the last chapter with an exported video. An
   * open Part is the chapters after that, still in progress.
   */
  closed: boolean
  /** The end is marked in Narration rather than taken from the exports. */
  endMarked: boolean
  completed: boolean
  completedAt: string | null
  chapters: PartChapter[]
  exportedEn: number
  exportedHi: number
  /** Every chapter has both videos and the Part is closed — "Complete" can run. */
  ready: boolean
  /** Why it can't be completed yet; null when ready or completed. */
  blocker: string | null
  /** What deleting would free on this disk (or what's left over, once completed). */
  localBytes: number
  workingBytes: number
}

export interface SeriesParts {
  seriesId: string
  title: string
  r2Configured: boolean
  /** Compressed videos on disk now. */
  compressedVideos: string[]
  /** When a compressed video was last seen in any video folder; outlives the video. */
  checkpointAt: string | null
  checkpointVideos: string[]
  parts: SeriesPart[]
}

/** Chapter folders a chapter's work is spread over, outside its own folder. */
function seriesLevelChapterDirs(rootFolder: string, folderPath: string): string[] {
  const seriesDir = path.join(downloadRoot(), rootFolder)
  const chapterFolder = path.basename(folderPath)
  return [
    ...SERIES_CHAPTER_DIRS.map(dir => path.join(seriesDir, dir, chapterFolder)),
    // Clipper 3 slices: <Series>/<Series>/<Chapter>/slices3/
    path.join(seriesDir, path.basename(seriesDir), chapterFolder)
  ]
}

/** The app's own exports for these chapter numbers: `chNNN_…` directly in a video folder. */
async function appExportFiles(rootFolder: string, numbers: Set<number>): Promise<{ file: string; bytes: number }[]> {
  const out: { file: string; bytes: number }[] = []
  for (const dirName of VIDEO_DIRS) {
    const dir = path.join(downloadRoot(), rootFolder, dirName)
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const n = videoChapterNumber(entry.name)
      if (n === null || !numbers.has(n)) continue
      const file = path.join(dir, entry.name)
      try {
        out.push({ file, bytes: (await fs.stat(file)).size })
      } catch {
        // Raced with a delete.
      }
    }
  }
  return out
}

function partScriptFiles(rootFolder: string, partNumber: number): string[] {
  const padded = String(partNumber).padStart(2, '0')
  return NARRATION_LANGUAGES.map(language =>
    path.join(downloadRoot(), rootFolder, `Part ${padded} - full script${partExportSuffix(language)}.md`)
  )
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size
  } catch {
    return 0
  }
}

async function partLocalBytes(rootFolder: string, partNumber: number, chapters: PartChapter[]): Promise<number> {
  let bytes = 0
  for (const ch of chapters) {
    bytes += (await measureDir(path.join(downloadRoot(), ch.folderPath))).bytes
    for (const dir of seriesLevelChapterDirs(rootFolder, ch.folderPath)) bytes += (await measureDir(dir)).bytes
  }
  const numbers = new Set(chapters.map(ch => Math.round(ch.number)))
  for (const f of await appExportFiles(rootFolder, numbers)) bytes += f.bytes
  for (const file of partScriptFiles(rootFolder, partNumber)) bytes += await fileSize(file)
  return bytes
}

/**
 * The series' Parts, in order, with each chapter's export state.
 *
 * Boundaries come from the English scripts' `isPartEnd` (Hindi rows copy it),
 * counted over downloaded chapters — the same way Narration numbers Parts, so
 * "Part 2" here is "Part 2" there. After the last marked end, the user
 * usually marks nothing: the Part is "up to the last chapter with an exported
 * video", and whatever follows is the next Part, in progress. Completing a
 * Part marks its last chapter as the Part end, so Narration agrees from then
 * on. Completed chapters keep status "done", so completing Part 1 doesn't
 * renumber Part 2.
 */
export async function getSeriesParts(seriesId: string, measure = true): Promise<SeriesParts> {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: {
      id: true,
      title: true,
      rootFolder: true,
      chapters: {
        where: { status: 'done' },
        orderBy: { number: 'asc' },
        select: {
          id: true,
          number: true,
          title: true,
          folderPath: true,
          completedAt: true,
          scripts: { where: { language: 'en' }, select: { isPartEnd: true } }
        }
      }
    }
  })
  if (!series) throw new Error('Series not found')

  const [exportedEn, exportedHi] = await Promise.all([
    scanExportedChapterNumbers(series.rootFolder, videoDirsFor('en'), true),
    scanExportedChapterNumbers(series.rootFolder, videoDirsFor('hi'), true)
  ])

  type Row = (typeof series.chapters)[number]
  const groups: { chapters: Row[]; closed: boolean; endMarked: boolean }[] = []
  let current: Row[] = []
  for (const ch of series.chapters) {
    current.push(ch)
    if (ch.scripts[0]?.isPartEnd) {
      groups.push({ chapters: current, closed: true, endMarked: true })
      current = []
    }
  }
  if (current.length > 0) {
    const hasVideo = (ch: Row) => exportedEn.has(Math.round(ch.number)) || exportedHi.has(Math.round(ch.number))
    let end = -1
    current.forEach((ch, i) => { if (hasVideo(ch)) end = i })
    if (end >= 0) groups.push({ chapters: current.slice(0, end + 1), closed: true, endMarked: false })
    const rest = current.slice(end + 1)
    if (rest.length > 0) groups.push({ chapters: rest, closed: false, endMarked: false })
  }

  const parts: SeriesPart[] = []
  for (const [i, group] of groups.entries()) {
    const number = i + 1
    const chapters: PartChapter[] = group.chapters.map(ch => {
      const n = Math.round(ch.number)
      return {
        id: ch.id,
        number: ch.number,
        title: ch.title,
        folderPath: ch.folderPath,
        exportedEn: exportedEn.has(n),
        exportedHi: exportedHi.has(n),
        completed: ch.completedAt !== null
      }
    })
    const completedDates = group.chapters.map(ch => ch.completedAt).filter((d): d is Date => d !== null)
    const completed = completedDates.length > 0
    const en = chapters.filter(ch => ch.exportedEn).length
    const hi = chapters.filter(ch => ch.exportedHi).length

    let blocker: string | null = null
    if (!completed) {
      if (!group.closed) {
        blocker = 'In progress — no video exported yet'
      } else if (en < chapters.length || hi < chapters.length) {
        const missing: string[] = []
        if (en < chapters.length) missing.push(`${chapters.length - en} English`)
        if (hi < chapters.length) missing.push(`${chapters.length - hi} Hindi`)
        blocker = `Videos not exported yet: ${missing.join(', ')}`
      }
    }

    parts.push({
      number,
      firstChapter: chapters[0].number,
      lastChapter: chapters[chapters.length - 1].number,
      closed: group.closed,
      endMarked: group.endMarked,
      completed,
      completedAt: completed ? new Date(Math.max(...completedDates.map(d => d.getTime()))).toISOString() : null,
      chapters,
      exportedEn: en,
      exportedHi: hi,
      ready: !completed && blocker === null,
      blocker,
      workingBytes: measure ? (await Promise.all(chapters.flatMap(ch => [path.join(downloadRoot(), ch.folderPath), ...seriesLevelChapterDirs(series.rootFolder, ch.folderPath)]).map(dir => workingFiles(dir)))).reduce((a, b) => a + b, 0) : 0,
      localBytes: measure ? await partLocalBytes(series.rootFolder, number, chapters) : 0
    })
  }

  const folders = await scanSeriesVideoCleanup(series.id, series.rootFolder)
  const compressedVideos = folders.flatMap(folder => folder.compressedVideos.map(file => `${folder.dir}/${file}`))
  const checkpointVideos = folders.flatMap(folder => folder.checkpointVideos.map(file => `${folder.dir}/${file}`))
  const checkpointAt = folders.map(folder => folder.checkpointAt).filter((at): at is string => at !== null).sort().at(-1) ?? null
  return { seriesId: series.id, title: series.title, r2Configured: getR2Config() !== null, compressedVideos, checkpointAt, checkpointVideos, parts }
}

// ============ Continuity backup ============

export interface ArchivedScript {
  summary: string | null
  closing: string | null
  isPartEnd: boolean
  outro: string | null
}

export interface ArchivedChapter {
  number: number
  part: number
  en: ArchivedScript | null
  hi: ArchivedScript | null
}

export interface ContinuityArchive {
  schema: string
  series: string
  updatedAt: string
  parts: { number: number; firstChapter: number; lastChapter: number; completedAt: string }[]
  /** By chapter folder name. */
  chapters: Record<string, ArchivedChapter>
}

function continuityKey(config: R2Config, rootFolder: string): string {
  return `${config.prefix}${ARCHIVE_FOLDER}${path.basename(rootFolder)}/${CONTINUITY_NAME}`
}

async function readArchive(client: S3Client, config: R2Config, key: string): Promise<ContinuityArchive | null> {
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
    const text = await res.Body!.transformToString('utf-8')
    const parsed = JSON.parse(text) as ContinuityArchive
    return parsed && typeof parsed.chapters === 'object' ? parsed : null
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

/** Writes the Part's continuity into the series' archive in R2 (read, merge, PUT). */
async function backUpContinuity(
  client: S3Client,
  config: R2Config,
  series: { title: string; rootFolder: string },
  part: SeriesPart
): Promise<string> {
  const key = continuityKey(config, series.rootFolder)
  const archive: ContinuityArchive = (await readArchive(client, config, key)) ?? {
    schema: CONTINUITY_SCHEMA,
    series: series.title,
    updatedAt: '',
    parts: [],
    chapters: {}
  }

  const rows = await prisma.chapterScript.findMany({
    where: { chapterId: { in: part.chapters.map(ch => ch.id) } },
    select: { chapterId: true, language: true, rollingSummary: true, closingParagraph: true, isPartEnd: true, outroText: true }
  })
  const missing: number[] = []
  for (const ch of part.chapters) {
    const entry: ArchivedChapter = { number: ch.number, part: part.number, en: null, hi: null }
    for (const language of NARRATION_LANGUAGES) {
      const row = rows.find(r => r.chapterId === ch.id && r.language === language)
      if (!row) continue
      entry[language] = {
        summary: row.rollingSummary,
        closing: row.closingParagraph,
        // Completing marks the last chapter as the Part end (markCompleted).
        isPartEnd: row.isPartEnd || ch.id === part.chapters[part.chapters.length - 1].id,
        outro: row.outroText
      }
    }
    if (!entry.en?.summary || !entry.en?.closing) missing.push(ch.number)
    archive.chapters[path.basename(ch.folderPath)] = entry
  }
  // Part N+1 starts from the last chapter's summary and closing; without them
  // there is nothing to continue from, so nothing is deleted.
  const last = part.chapters[part.chapters.length - 1]
  if (missing.includes(last.number)) {
    throw new Error(`Chapter ${last.number} has no English rolling summary or closing paragraph — Part ${part.number + 1} couldn't continue from it`)
  }

  const completedAt = new Date().toISOString()
  archive.parts = archive.parts.filter(p => p.number !== part.number)
  archive.parts.push({ number: part.number, firstChapter: part.firstChapter, lastChapter: part.lastChapter, completedAt })
  archive.parts.sort((a, b) => a.number - b.number)
  archive.updatedAt = completedAt

  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: JSON.stringify(archive, null, 2),
    ContentType: 'application/json'
  }))
  invalidateStorage()
  return key
}

const archiveCache = new Map<string, { archive: ContinuityArchive | null; at: number }>()
const ARCHIVE_CACHE_MS = 10 * 60_000

/**
 * A completed chapter's continuity from the R2 archive — the fallback when its
 * ChapterScript row has lost the summary or closing. One GET per series,
 * cached; any failure is null (the caller then has no context, as before).
 */
export async function readArchivedContinuity(
  chapterId: string,
  language: NarrationLanguage
): Promise<{ rollingSummary: string | null; closingParagraph: string | null } | null> {
  try {
    const chapter = await prisma.chapter.findUnique({
      where: { id: chapterId },
      select: { folderPath: true, completedAt: true, series: { select: { rootFolder: true } } }
    })
    if (!chapter?.completedAt) return null
    const config = getR2Config()
    if (!config) return null
    const key = continuityKey(config, chapter.series.rootFolder)
    let cached = archiveCache.get(key)
    if (!cached || Date.now() - cached.at > ARCHIVE_CACHE_MS) {
      cached = { archive: await readArchive(createClient(config), config, key), at: Date.now() }
      archiveCache.set(key, cached)
    }
    const script = cached.archive?.chapters[path.basename(chapter.folderPath)]?.[language]
    if (!script) return null
    return { rollingSummary: script.summary, closingParagraph: script.closing }
  } catch (error) {
    console.warn('[partArchive] could not read archived continuity:', errorMessage(error))
    return null
  }
}

// ============ R2 clean-up ============

/**
 * The series' R2 objects that belong to these chapters, under any prefix
 * (the phone writes under its own, which may differ from ours).
 */
export function chapterObjectKeys(keys: string[], seriesFolder: string, chapterFolders: Set<string>): string[] {
  const s = escapeRegExp(seriesFolder)
  const zip = new RegExp(`^(?:.*/)?(?:manhwa|crops|voiceover)/${s}/([^/]+)\\.zip$`)
  const editor = new RegExp(`^(?:.*/)?editor/${s}/([^/]+)\\.(?:package|timeline)\\.json$`)
  const belongs = (name: string) =>
    chapterFolders.has(name) || (name.endsWith('.hi') && chapterFolders.has(name.slice(0, -'.hi'.length)))
  return keys.filter(key => {
    const m = zip.exec(key) ?? editor.exec(key)
    return m !== null && belongs(m[1])
  })
}

/** The phone's whole-series script zips: `scripts/<Series>/<Series>[.hi].zip`. */
export function scriptZipKeys(keys: string[], seriesFolder: string): string[] {
  const s = escapeRegExp(seriesFolder)
  const re = new RegExp(`^(?:.*/)?scripts/${s}/${s}(?:\\.hi)?\\.zip$`)
  return keys.filter(key => re.test(key))
}

/** Chapter folders inside a script zip (`<Series>/<Chapter>/script.md`). */
async function scriptZipChapters(client: S3Client, config: R2Config, key: string): Promise<Set<string>> {
  const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  const zip = Buffer.from(await res.Body!.transformToByteArray())
  const folders = new Set<string>()
  for (const entry of readZip(zip)) {
    const parts = entry.name.split('/').filter(Boolean)
    if (parts.length >= 3) folders.add(parts[parts.length - 2])
  }
  return folders
}

interface R2CleanUp {
  deleted: string[]
  freedBytes: number
  /** Script zips left because they still hold chapters of an open Part. */
  kept: string[]
}

async function cleanR2(
  client: S3Client,
  config: R2Config,
  seriesId: string,
  rootFolder: string,
  chapterFolders: Set<string>
): Promise<R2CleanUp> {
  const result: R2CleanUp = { deleted: [], freedBytes: 0, kept: [] }
  const seriesFolder = path.basename(rootFolder)
  const storage = await measureBucket(client, config.bucket, true)
  const sizes = new Map(storage.objects.map(o => [o.key, o.size]))
  const keys = storage.objects.map(o => o.key)

  const targets = chapterObjectKeys(keys, seriesFolder, chapterFolders)

  // A script zip covers the whole series as the phone has it; it goes only
  // once every chapter in it is completed, or Part N+1's unimported scripts
  // would go with it.
  const zips = scriptZipKeys(keys, seriesFolder)
  if (zips.length > 0) {
    const completed = await prisma.chapter.findMany({
      where: { seriesId, completedAt: { not: null } },
      select: { folderPath: true }
    })
    const done = new Set([...completed.map(ch => path.basename(ch.folderPath)), ...chapterFolders])
    for (const key of zips) {
      try {
        const inZip = await scriptZipChapters(client, config, key)
        if ([...inZip].every(folder => done.has(folder))) targets.push(key)
        else result.kept.push(key)
      } catch (error) {
        console.warn(`[partArchive] kept ${key}: ${errorMessage(error)}`)
        result.kept.push(key)
      }
    }
  }

  for (const key of targets) {
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
    result.deleted.push(key)
    result.freedBytes += sizes.get(key) ?? 0
  }
  invalidateStorage()
  return result
}

// ============ Disk clean-up ============

async function removeIfPresent(target: string): Promise<number> {
  let bytes = 0
  try {
    const stat = await fs.stat(target)
    bytes = stat.isDirectory() ? (await measureDir(target)).bytes : stat.size
  } catch {
    return 0
  }
  await removeWithin(target)
  return bytes
}

/** Removes a directory only if nothing is left in it. */
async function removeIfEmpty(dir: string): Promise<void> {
  try {
    if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir)
  } catch {
    // Gone already, or not empty.
  }
}

async function cleanDisk(rootFolder: string, part: SeriesPart): Promise<{ freedBytes: number; files: number }> {
  let freedBytes = 0
  let files = 0
  for (const ch of part.chapters) {
    freedBytes += await removeIfPresent(path.join(downloadRoot(), ch.folderPath))
    for (const dir of seriesLevelChapterDirs(rootFolder, ch.folderPath)) freedBytes += await removeIfPresent(dir)
  }
  const numbers = new Set(part.chapters.map(ch => Math.round(ch.number)))
  for (const f of await appExportFiles(rootFolder, numbers)) {
    await removeWithin(f.file)
    freedBytes += f.bytes
    files++
  }
  for (const file of partScriptFiles(rootFolder, part.number)) freedBytes += await removeIfPresent(file)

  // Parent folders a whole series left behind once Part 1 was its only Part.
  const seriesDir = path.join(downloadRoot(), rootFolder)
  for (const dir of SERIES_CHAPTER_DIRS) await removeIfEmpty(path.join(seriesDir, dir))
  await removeIfEmpty(path.join(seriesDir, path.basename(seriesDir)))
  return { freedBytes, files }
}

// ============ Database ============

async function markCompleted(part: SeriesPart): Promise<void> {
  const ids = part.chapters.map(ch => ch.id)
  const chapterId = { in: ids }
  const now = new Date()
  await prisma.$transaction([
    // Page rows keep their source URLs; they no longer claim a local file.
    prisma.page.updateMany({ where: { chapterId }, data: { localPath: null, bytes: null } }),
    prisma.audioFile.deleteMany({ where: { chapterId } }),
    prisma.audioAnalysis.deleteMany({ where: { chapterId } }),
    prisma.audioSection.deleteMany({ where: { chapterId } }),
    prisma.editor2Timeline.deleteMany({ where: { chapterId } }),
    prisma.cropSession.deleteMany({ where: { chapterId } }),
    prisma.cropPointSet.deleteMany({ where: { chapterId } }),
    prisma.aISuggestion.deleteMany({ where: { chapterId } }),
    // Script text is gone; summary, closing, part end and outro stay.
    prisma.chapterScript.updateMany({ where: { chapterId }, data: { scriptPath: null } }),
    // The Part may have ended at its last export rather than a marked end;
    // marking it keeps Narration's Part numbers in step with this one.
    prisma.chapterScript.updateMany({
      where: { chapterId: part.chapters[part.chapters.length - 1].id },
      data: { isPartEnd: true }
    }),
    // The phone sees them as cleared and drops them from its index.
    prisma.phoneChapterSend.updateMany({ where: { chapterId }, data: { clearedAt: now, key: null, etag: null } }),
    prisma.chapter.updateMany({
      where: { id: { in: ids }, completedAt: null },
      data: { completedAt: now, completedPart: part.number, downloadedCount: 0, error: null }
    })
  ])
}

// ============ Complete ============

export interface CompletePartResult {
  partNumber: number
  chapters: number
  continuityKey: string | null
  r2Deleted: string[]
  r2FreedBytes: number
  r2Kept: string[]
  localFreedBytes: number
  videosDeleted: number
  /** Things that didn't stop the Part from completing but need a look. */
  warnings: string[]
}

const running = new Set<string>()

/**
 * Completes one Part: backs up its continuity to R2, marks it completed, then
 * deletes its R2 objects and local files. `confirm` must be the series title.
 *
 * Re-running on a completed Part skips the backup and the export check and
 * only cleans what's left (e.g. after a crash or an R2 error).
 */
export async function completePart(seriesId: string, partNumber: number, confirm: string): Promise<CompletePartResult> {
  const series = await prisma.series.findUnique({ where: { id: seriesId }, select: { title: true, rootFolder: true } })
  if (!series) throw new Error('Series not found')
  if (confirm.trim() !== series.title.trim()) throw new Error('Type the series title exactly to confirm')
  if (running.has(seriesId)) throw new Error('This series is already being cleaned')

  const config = getR2Config()
  if (!config) throw new Error(`R2 is not configured, so the continuity can't be backed up. Missing: ${missingR2Env().join(', ')}`)
  if (isUploadBusy()) throw new Error('Wait for the running phone upload to finish')

  running.add(seriesId)
  try {
    const { parts } = await getSeriesParts(seriesId, false)
    const part = parts.find(p => p.number === partNumber)
    if (!part) throw new Error(`Part ${partNumber} not found`)
    if (!part.completed && !part.ready) throw new Error(part.blocker ?? `Part ${partNumber} can't be completed yet`)

    const client = createClient(config)
    const result: CompletePartResult = {
      partNumber,
      chapters: part.chapters.length,
      continuityKey: null,
      r2Deleted: [],
      r2FreedBytes: 0,
      r2Kept: [],
      localFreedBytes: 0,
      videosDeleted: 0,
      warnings: []
    }

    if (!part.completed) {
      result.continuityKey = await backUpContinuity(client, config, series, part)
      await markCompleted(part)
      console.log(`[partArchive] ${series.title} Part ${partNumber}: continuity saved to ${result.continuityKey}, marked completed`)
    }

    const chapterFolders = new Set(part.chapters.map(ch => path.basename(ch.folderPath)))
    try {
      const r2 = await cleanR2(client, config, seriesId, series.rootFolder, chapterFolders)
      result.r2Deleted = r2.deleted
      result.r2FreedBytes = r2.freedBytes
      result.r2Kept = r2.kept
      if (r2.kept.length > 0) {
        result.warnings.push('The phone\'s script zip still holds chapters of an open Part, so it was kept in R2')
      }
    } catch (error) {
      result.warnings.push(`R2 clean-up stopped: ${errorMessage(error)} — run Complete again to retry`)
    }

    const disk = await cleanDisk(series.rootFolder, part)
    result.localFreedBytes = disk.freedBytes
    result.videosDeleted = disk.files

    // Tell the phone those chapters are cleared (one PUT); not worth failing over.
    try {
      await updatePhoneIndexes(seriesId)
    } catch (error) {
      result.warnings.push(`Phone index not updated: ${errorMessage(error)}`)
    }

    console.log(
      `[partArchive] ${series.title} Part ${partNumber}: freed ${result.localFreedBytes} B on disk, ` +
      `${result.r2Deleted.length} R2 objects (${result.r2FreedBytes} B)`
    )
    return result
  } finally {
    running.delete(seriesId)
  }
}

/**
 * Local-only cleanup of the explicitly selected Part. Scripts and database script rows survive.
 * Needs the compressed-video checkpoint, not the video itself, which the user may have deleted.
 */
export async function cleanPartWorkingFiles(seriesId: string, partNumber: number, confirm: string) {
  const data = await getSeriesParts(seriesId, false)
  if (confirm.trim() !== data.title.trim()) throw new Error('Type the series title to confirm')
  if (!data.checkpointAt) throw new Error('A nonempty compressed video is required')
  const part = data.parts.find(p => p.number === partNumber)
  if (!part) throw new Error('Part not found')
  const series = await prisma.series.findUnique({ where: { id: seriesId }, select: { rootFolder: true } })
  if (!series) throw new Error('Series not found')
  const dirs = part.chapters.flatMap(ch => [path.join(downloadRoot(), ch.folderPath), ...seriesLevelChapterDirs(series.rootFolder, ch.folderPath)])
  // Validate all targets before any mutation.
  for (const dir of dirs) await workingFiles(dir)
  let freedBytes = 0
  for (const dir of dirs) freedBytes += await workingFiles(dir, true)
  const ids = part.chapters.map(ch => ch.id)
  await prisma.page.updateMany({ where: { chapterId: { in: ids } }, data: { localPath: null, bytes: null } })
  await prisma.audioFile.deleteMany({ where: { chapterId: { in: ids } } })
  await prisma.audioSection.updateMany({ where: { chapterId: { in: ids } }, data: { status: 'none' } })
  return { freedBytes, chapters: ids.length }
}
