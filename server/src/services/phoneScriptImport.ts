/**
 * Import narration scripts written on the Sleeper-Cell phone.
 *
 * Once every chapter of a series is done on the phone, its "Zip and upload to
 * R2" button uploads `<phone prefix>scripts/<Series>/<Series>.zip` (see
 * ScriptUpload.kt). The zip holds one `<Series>/` folder:
 *
 *     about.md                      the phone's first chapter's ===ABOUT===
 *     <Chapter>/script.md           ===SCRIPT===
 *     <Chapter>/continuity.json     {"summary", "closing", "savedAt"}
 *
 * Chapter folders carry the desktop's chapter folder names (the phone got them
 * from our series zip), so chapters are matched by folder name.
 *
 * Importing is two steps: `previewPhoneScripts` downloads and parses the zip and
 * says what each chapter would get; `importPhoneScripts` applies it for the
 * chapters the user kept, but only if the zip in R2 is still the one previewed.
 * Each imported chapter gets script.md in its folder and a ChapterScript row
 * (status done, rolling summary + closing paragraph from continuity.json), the
 * same shape a manual-mode submit leaves, so voiceover works as usual after.
 */

import fs from 'fs/promises'
import path from 'path'
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { readZip } from '../utils/zipReader.js'
import { createClient, getR2Config, isNotFound } from './r2Service.js'
import { getPublishedChapters } from './storageService.js'

/** Folder the phone uploads script zips to, inside its R2 prefix. Keep in step with FOLDER in ScriptUpload.kt. */
const SCRIPTS_FOLDER = 'scripts/'

/** Script zips are text only; anything bigger is not one of ours. */
const MAX_ZIP_BYTES = 64 * 1024 * 1024

function getFullFolderPath(relativePath: string): string {
  return path.join(process.env.DOWNLOAD_ROOT || './downloads', relativePath)
}

// ============ Parsing ============

export interface PhoneChapterFiles {
  /** Chapter folder name, as on the desktop. */
  folder: string
  script: string | null
  summary: string | null
  closing: string | null
  savedAt: string | null
}

export interface ParsedScriptsZip {
  about: string | null
  chapters: PhoneChapterFiles[]
}

const nonBlank = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null

/**
 * Reads the zip's files. Entries are `<Series>/about.md` and
 * `<Series>/<Chapter>/{script.md,continuity.json}`; the leading series folder
 * is not checked, so a renamed series still imports.
 */
export function parseScriptsZip(zip: Buffer): ParsedScriptsZip {
  let about: string | null = null
  const byFolder = new Map<string, PhoneChapterFiles>()
  const chapter = (folder: string) => {
    let entry = byFolder.get(folder)
    if (!entry) {
      entry = { folder, script: null, summary: null, closing: null, savedAt: null }
      byFolder.set(folder, entry)
    }
    return entry
  }

  for (const { name, data } of readZip(zip)) {
    const parts = name.split('/').filter(Boolean)
    const file = parts[parts.length - 1]
    // Drop the series folder; what's left is about.md or <Chapter>/<file>.
    const rel = parts.length > 1 ? parts.slice(1) : parts
    const text = data.toString('utf8')

    if (rel.length === 1 && file === 'about.md') {
      about = nonBlank(text)
    } else if (rel.length === 2 && file === 'script.md') {
      chapter(rel[0]).script = nonBlank(text)
    } else if (rel.length === 2 && file === 'continuity.json') {
      const entry = chapter(rel[0])
      try {
        const json = JSON.parse(text)
        entry.summary = nonBlank(json?.summary)
        entry.closing = nonBlank(json?.closing)
        entry.savedAt = nonBlank(json?.savedAt)
      } catch {
        // A broken continuity file leaves the script importable without its summary.
      }
    }
  }

  const chapters = [...byFolder.values()]
    .filter(c => c.script)
    .sort((a, b) => a.folder.localeCompare(b.folder, undefined, { numeric: true }))
  return { about, chapters }
}

// ============ Finding the zip ============

export interface PhoneScriptsZip {
  key: string
  etag: string
  size: number
  uploadedAt: string | null
}

export interface PhoneScriptsZipStatus {
  configured: boolean
  /** The phone's script zip for this series; null if it hasn't uploaded one. */
  zip: PhoneScriptsZip | null
  /** The zip last imported into this series, if any. */
  lastImport: { etag: string; at: string; chapters: number } | null
}

const importSettingKey = (seriesId: string) => `phoneScriptsImport:${seriesId}`

/** Where each series' zip was found last time, so a steady poll is one HEAD. */
const foundKeys = new Map<string, string>()

/**
 * The phone uploads under its own prefix setting, which may not match ours
 * (see readScriptsReceipt), so the bucket root is tried too.
 */
async function findZip(seriesId: string): Promise<PhoneScriptsZip | null> {
  const config = getR2Config()
  if (!config) return null
  const series = await prisma.series.findUnique({ where: { id: seriesId }, select: { rootFolder: true } })
  if (!series) throw new Error('Series not found')

  const name = path.basename(series.rootFolder)
  const rel = `${SCRIPTS_FOLDER}${name}/${name}.zip`
  const candidates = [...new Set([`${config.prefix}${rel}`, rel])]
  const last = foundKeys.get(seriesId)
  if (last) candidates.sort((a, b) => Number(b === last) - Number(a === last))

  const client = createClient(config)
  for (const key of candidates) {
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
      foundKeys.set(seriesId, key)
      return {
        key,
        etag: (head.ETag ?? '').replace(/"/g, ''),
        size: head.ContentLength ?? 0,
        uploadedAt: head.LastModified?.toISOString() ?? null
      }
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
  foundKeys.delete(seriesId)
  return null
}

async function readLastImport(seriesId: string): Promise<PhoneScriptsZipStatus['lastImport']> {
  const row = await prisma.setting.findUnique({ where: { key: importSettingKey(seriesId) } })
  if (!row) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}

export async function getPhoneScriptsZip(seriesId: string): Promise<PhoneScriptsZipStatus> {
  if (!getR2Config()) return { configured: false, zip: null, lastImport: null }
  const [zip, lastImport] = await Promise.all([findZip(seriesId), readLastImport(seriesId)])
  return { configured: true, zip, lastImport }
}

/** Parsed zips by series, so the import right after a preview doesn't download again. */
const parsedCache = new Map<string, { etag: string; parsed: ParsedScriptsZip }>()

async function downloadZip(seriesId: string): Promise<{ zip: PhoneScriptsZip; parsed: ParsedScriptsZip }> {
  const config = getR2Config()
  if (!config) throw new Error('Cloudflare R2 is not configured')
  const zip = await findZip(seriesId)
  if (!zip) throw new Error('The phone has not uploaded a script zip for this series yet')

  const cached = parsedCache.get(seriesId)
  if (cached?.etag === zip.etag) return { zip, parsed: cached.parsed }
  if (zip.size > MAX_ZIP_BYTES) throw new Error(`The script zip is unexpectedly large (${zip.size} bytes)`)

  const res = await createClient(config).send(new GetObjectCommand({ Bucket: config.bucket, Key: zip.key }))
  const body = Buffer.from(await res.Body!.transformToByteArray())
  const etag = (res.ETag ?? zip.etag).replace(/"/g, '')
  const parsed = parseScriptsZip(body)
  parsedCache.set(seriesId, { etag, parsed })
  return { zip: { ...zip, etag, size: body.length }, parsed }
}

// ============ Preview ============

/**
 * new:     the desktop has no script for this chapter
 * replace: the desktop has a different script
 * same:    the desktop already has this exact script, summary and closing
 */
export type PhoneImportAction = 'new' | 'replace' | 'same'

export interface PhoneImportChapter {
  chapterId: string
  number: number
  folder: string
  action: PhoneImportAction
  /** The desktop script's status, if it has one (done, edited, …). */
  desktopStatus: string | null
  hasSummary: boolean
  hasClosing: boolean
  savedAt: string | null
  /** Voiceover sections exist, split from the desktop's current script. */
  hasVoiceover: boolean
  published: boolean
}

export interface PhoneImportPreview {
  zip: PhoneScriptsZip
  chapters: PhoneImportChapter[]
  /** Chapter folders in the zip with no matching desktop chapter. */
  unmatched: string[]
  /** What happens to the series' about text. */
  about: 'set' | 'replace' | 'keep' | 'same' | 'none'
}

async function readScript(scriptPath: string | null | undefined): Promise<string | null> {
  if (!scriptPath) return null
  try {
    return (await fs.readFile(scriptPath, 'utf-8')).trim()
  } catch {
    return null
  }
}

async function buildPreview(seriesId: string, zip: PhoneScriptsZip, parsed: ParsedScriptsZip): Promise<PhoneImportPreview> {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    include: {
      chapters: {
        where: { status: 'done' },
        include: { script: true, _count: { select: { audioSections: true } } },
        orderBy: { number: 'asc' }
      }
    }
  })
  if (!series) throw new Error('Series not found')
  const published = (await getPublishedChapters(seriesId)).chapters
  const byFolder = new Map(series.chapters.map(c => [path.basename(c.folderPath), c]))

  const chapters: PhoneImportChapter[] = []
  const unmatched: string[] = []
  for (const phone of parsed.chapters) {
    const chapter = byFolder.get(phone.folder)
    if (!chapter) {
      unmatched.push(phone.folder)
      continue
    }
    const current = await readScript(chapter.script?.scriptPath)
    const same =
      current === phone.script &&
      (chapter.script?.rollingSummary ?? null) === phone.summary &&
      (chapter.script?.closingParagraph ?? null) === phone.closing
    chapters.push({
      chapterId: chapter.id,
      number: chapter.number,
      folder: phone.folder,
      action: current === null ? 'new' : same ? 'same' : 'replace',
      desktopStatus: chapter.script && chapter.script.status !== 'none' ? chapter.script.status : null,
      hasSummary: !!phone.summary,
      hasClosing: !!phone.closing,
      savedAt: phone.savedAt,
      hasVoiceover: chapter._count.audioSections > 0,
      published: !!published[chapter.id]
    })
  }
  chapters.sort((a, b) => a.number - b.number)

  // The phone only gets unpublished chapters, so its "first chapter" is often
  // not the series' first; its about text then only fills a gap.
  const phoneHasFirst = chapters.length > 0 && chapters[0].chapterId === series.chapters[0]?.id
  const about: PhoneImportPreview['about'] = !parsed.about
    ? 'none'
    : parsed.about === series.aboutSummary?.trim()
      ? 'same'
      : !series.aboutSummary?.trim()
        ? 'set'
        : phoneHasFirst
          ? 'replace'
          : 'keep'

  return { zip, chapters, unmatched, about }
}

export async function previewPhoneScripts(seriesId: string): Promise<PhoneImportPreview> {
  const { zip, parsed } = await downloadZip(seriesId)
  return buildPreview(seriesId, zip, parsed)
}

// ============ Import ============

export interface PhoneImportResult {
  imported: number
  aboutUpdated: boolean
}

/**
 * Applies the zip previewed as `etag` to `chapterIds` (chapters of this series
 * that are in the zip). Refuses if the phone has uploaded a newer zip since.
 */
export async function importPhoneScripts(seriesId: string, etag: string, chapterIds: string[]): Promise<PhoneImportResult> {
  const { zip, parsed } = await downloadZip(seriesId)
  if (zip.etag !== etag) throw new Error('The phone uploaded a newer zip since the preview — review it again')

  const preview = await buildPreview(seriesId, zip, parsed)
  const wanted = new Set(chapterIds)
  const byFolder = new Map(parsed.chapters.map(c => [c.folder, c]))
  const series = await prisma.series.findUniqueOrThrow({ where: { id: seriesId } })
  const chapters = await prisma.chapter.findMany({
    where: { id: { in: preview.chapters.filter(c => wanted.has(c.chapterId)).map(c => c.chapterId) } },
    include: { script: true }
  })

  let imported = 0
  for (const chapter of chapters) {
    const phone = byFolder.get(path.basename(chapter.folderPath))
    if (!phone?.script) continue
    const scriptPath = path.join(getFullFolderPath(chapter.folderPath), 'script.md')
    await fs.writeFile(scriptPath, phone.script + '\n', 'utf-8')
    const data = {
      mode: 'manual',
      provider: 'sleeper-cell',
      model: null,
      scriptPath,
      status: 'done',
      rollingSummary: phone.summary,
      closingParagraph: phone.closing,
      error: null
    }
    await prisma.chapterScript.upsert({
      where: { chapterId: chapter.id },
      update: data,
      create: { chapterId: chapter.id, ...data }
    })
    imported++
  }

  const aboutUpdated = (preview.about === 'set' || preview.about === 'replace') && !!parsed.about
  if (aboutUpdated) {
    await prisma.series.update({ where: { id: seriesId }, data: { aboutSummary: parsed.about } })
    await fs.writeFile(path.join(getFullFolderPath(series.rootFolder), 'about.md'), parsed.about!, 'utf-8')
  }

  const record = JSON.stringify({ etag: zip.etag, at: new Date().toISOString(), chapters: imported })
  await prisma.setting.upsert({
    where: { key: importSettingKey(seriesId) },
    update: { value: record },
    create: { key: importSettingKey(seriesId), value: record }
  })
  return { imported, aboutUpdated }
}
