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
 * The phone also converts each English script to Hinglish (the Hindi tab
 * here) and uploads those as `<phone prefix>scripts/<Series>/<Series>.hi.zip`
 * once every chapter on the phone is converted:
 *
 *     <Chapter>/script.hi.md        the Hinglish script
 *     <Chapter>/continuity.hi.json  {"summary", "closing", "savedAt", "sourceSha256", "review"?}
 *
 * with no about.md. Everything below takes the language and keeps the two zips,
 * their imports and the scripts they land in apart.
 *
 * Importing is two steps: `previewPhoneScripts` downloads and parses the zip and
 * says what each chapter would get; `importPhoneScripts` applies it for the
 * chapters the user kept, but only if the zip in R2 is still the one previewed.
 * Each imported chapter gets its script file in its folder and a ChapterScript
 * row of that language (status done, rolling summary + closing paragraph from
 * the continuity file; for Hinglish also the English source hash and the
 * phone's review issues), the same shape a submit leaves, so voiceover works as
 * usual after.
 */

import fs from 'fs/promises'
import path from 'path'
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { readZip } from '../utils/zipReader.js'
import { createClient, getR2Config, isNotFound } from './r2Service.js'
import { getPublishedChapters } from './storageService.js'
import { scriptFileName, type NarrationLanguage } from './narrationLanguage.js'
import { encodeReview } from './hinglishConvert.js'
import { englishSha256 } from './hinglishService.js'

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
  /** Hinglish only: SHA-256 of the English script it was converted from. */
  sourceSha256: string | null
  /** Hinglish only: the check's issues when the phone saved it anyway. */
  review: string[] | null
}

export interface ParsedScriptsZip {
  about: string | null
  chapters: PhoneChapterFiles[]
}

const nonBlank = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null

/** The chapter files of each language's zip. */
function zipFiles(language: NarrationLanguage): { script: string; continuity: string } {
  return language === 'en'
    ? { script: 'script.md', continuity: 'continuity.json' }
    : { script: scriptFileName('hi'), continuity: 'continuity.hi.json' }
}

/**
 * Reads the zip's files. Entries are `<Series>/about.md` (English only) and
 * `<Series>/<Chapter>/{script.md,continuity.json}`, or for Hinglish
 * `<Series>/<Chapter>/{script.hi.md,continuity.hi.json}`; the leading series
 * folder is not checked, so a renamed series still imports.
 */
export function parseScriptsZip(zip: Buffer, language: NarrationLanguage = 'en'): ParsedScriptsZip {
  const names = zipFiles(language)
  let about: string | null = null
  const byFolder = new Map<string, PhoneChapterFiles>()
  const chapter = (folder: string) => {
    let entry = byFolder.get(folder)
    if (!entry) {
      entry = { folder, script: null, summary: null, closing: null, savedAt: null, sourceSha256: null, review: null }
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

    if (rel.length === 1 && file === 'about.md' && language === 'en') {
      about = nonBlank(text)
    } else if (rel.length === 2 && file === names.script) {
      chapter(rel[0]).script = nonBlank(text)
    } else if (rel.length === 2 && file === names.continuity) {
      const entry = chapter(rel[0])
      try {
        const json = JSON.parse(text)
        entry.summary = nonBlank(json?.summary)
        entry.closing = nonBlank(json?.closing)
        entry.savedAt = nonBlank(json?.savedAt)
        if (language === 'hi') {
          entry.sourceSha256 = nonBlank(json?.sourceSha256)
          const review = Array.isArray(json?.review) ? json.review.map(nonBlank).filter(Boolean) as string[] : []
          entry.review = review.length > 0 ? review : null
        }
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

const importSettingKey = (seriesId: string, language: NarrationLanguage) =>
  language === 'en' ? `phoneScriptsImport:${seriesId}` : `phoneScriptsImport:${language}:${seriesId}`

/** Caches below are per series and language. */
const cacheKey = (seriesId: string, language: NarrationLanguage) => `${seriesId}:${language}`

/** Where each series' zip was found last time, so a steady poll is one HEAD. */
const foundKeys = new Map<string, string>()

/** The zip's key under the phone's prefix: `scripts/<Series>/<Series>.zip`, or `<Series>.hi.zip` for Hinglish. */
export function scriptsZipKey(seriesName: string, language: NarrationLanguage): string {
  return `${SCRIPTS_FOLDER}${seriesName}/${seriesName}${language === 'en' ? '' : `.${language}`}.zip`
}

/**
 * The phone uploads under its own prefix setting, which may not match ours
 * (see readScriptsReceipt), so the bucket root is tried too.
 */
async function findZip(seriesId: string, language: NarrationLanguage): Promise<PhoneScriptsZip | null> {
  const config = getR2Config()
  if (!config) return null
  const series = await prisma.series.findUnique({ where: { id: seriesId }, select: { rootFolder: true } })
  if (!series) throw new Error('Series not found')

  const rel = scriptsZipKey(path.basename(series.rootFolder), language)
  const candidates = [...new Set([`${config.prefix}${rel}`, rel])]
  const found = cacheKey(seriesId, language)
  const last = foundKeys.get(found)
  if (last) candidates.sort((a, b) => Number(b === last) - Number(a === last))

  const client = createClient(config)
  for (const key of candidates) {
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
      foundKeys.set(found, key)
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
  foundKeys.delete(found)
  return null
}

async function readLastImport(seriesId: string, language: NarrationLanguage): Promise<PhoneScriptsZipStatus['lastImport']> {
  const row = await prisma.setting.findUnique({ where: { key: importSettingKey(seriesId, language) } })
  if (!row) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}

export async function getPhoneScriptsZip(seriesId: string, language: NarrationLanguage = 'en'): Promise<PhoneScriptsZipStatus> {
  if (!getR2Config()) return { configured: false, zip: null, lastImport: null }
  const [zip, lastImport] = await Promise.all([findZip(seriesId, language), readLastImport(seriesId, language)])
  return { configured: true, zip, lastImport }
}

/** Parsed zips by series and language, so the import right after a preview doesn't download again. */
const parsedCache = new Map<string, { etag: string; parsed: ParsedScriptsZip }>()

async function downloadZip(seriesId: string, language: NarrationLanguage): Promise<{ zip: PhoneScriptsZip; parsed: ParsedScriptsZip }> {
  const config = getR2Config()
  if (!config) throw new Error('Cloudflare R2 is not configured')
  const zip = await findZip(seriesId, language)
  if (!zip) {
    throw new Error(`The phone has not uploaded a ${language === 'en' ? '' : 'Hinglish '}script zip for this series yet`)
  }

  const cached = parsedCache.get(cacheKey(seriesId, language))
  if (cached?.etag === zip.etag) return { zip, parsed: cached.parsed }
  if (zip.size > MAX_ZIP_BYTES) throw new Error(`The script zip is unexpectedly large (${zip.size} bytes)`)

  const res = await createClient(config).send(new GetObjectCommand({ Bucket: config.bucket, Key: zip.key }))
  const body = Buffer.from(await res.Body!.transformToByteArray())
  const etag = (res.ETag ?? zip.etag).replace(/"/g, '')
  const parsed = parseScriptsZip(body, language)
  parsedCache.set(cacheKey(seriesId, language), { etag, parsed })
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
  /** Hinglish only: the phone saved it despite failing the check, with these issues. */
  review: string[] | null
  /**
   * Hinglish only: whether the phone converted the English script the desktop
   * has now; null when either side has none. False means it imports as stale.
   */
  sourceMatches: boolean | null
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

async function buildPreview(
  seriesId: string,
  zip: PhoneScriptsZip,
  parsed: ParsedScriptsZip,
  language: NarrationLanguage
): Promise<PhoneImportPreview> {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    include: {
      chapters: {
        where: { status: 'done' },
        // Each zip is compared with — and imported into — its own language's
        // script only; the other language is never touched. Hinglish also
        // looks at the English script, to tell whether it was converted from it.
        include: {
          scripts: { where: { language: { in: [language, 'en'] } } },
          _count: { select: { audioSections: { where: { language } } } }
        },
        orderBy: { number: 'asc' }
      }
    }
  })
  if (!series) throw new Error('Series not found')
  const published = (await getPublishedChapters(seriesId, language)).chapters
  const byFolder = new Map(series.chapters.map(c => [path.basename(c.folderPath), c]))

  const chapters: PhoneImportChapter[] = []
  const unmatched: string[] = []
  for (const phone of parsed.chapters) {
    const chapter = byFolder.get(phone.folder)
    if (!chapter) {
      unmatched.push(phone.folder)
      continue
    }
    const script = chapter.scripts.find(s => s.language === language)
    const current = await readScript(script?.scriptPath)
    const same =
      current === phone.script &&
      (script?.rollingSummary ?? null) === phone.summary &&
      (script?.closingParagraph ?? null) === phone.closing &&
      (language === 'en' || ((script?.sourceSha256 ?? null) === phone.sourceSha256 && script?.review === encodeReview(phone.review)))
    const englishNow = language === 'en' ? null : await englishSha256(chapter.scripts.find(s => s.language === 'en'))
    chapters.push({
      chapterId: chapter.id,
      number: chapter.number,
      folder: phone.folder,
      action: current === null ? 'new' : same ? 'same' : 'replace',
      desktopStatus: script && script.status !== 'none' ? script.status : null,
      hasSummary: !!phone.summary,
      hasClosing: !!phone.closing,
      savedAt: phone.savedAt,
      hasVoiceover: chapter._count.audioSections > 0,
      published: !!published[chapter.id],
      review: phone.review,
      sourceMatches: language === 'en' || !englishNow || !phone.sourceSha256 ? null : englishNow === phone.sourceSha256
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

export async function previewPhoneScripts(seriesId: string, language: NarrationLanguage = 'en'): Promise<PhoneImportPreview> {
  const { zip, parsed } = await downloadZip(seriesId, language)
  return buildPreview(seriesId, zip, parsed, language)
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
export async function importPhoneScripts(
  seriesId: string,
  etag: string,
  chapterIds: string[],
  language: NarrationLanguage = 'en'
): Promise<PhoneImportResult> {
  const { zip, parsed } = await downloadZip(seriesId, language)
  if (zip.etag !== etag) throw new Error('The phone uploaded a newer zip since the preview — review it again')

  const preview = await buildPreview(seriesId, zip, parsed, language)
  const wanted = new Set(chapterIds)
  const byFolder = new Map(parsed.chapters.map(c => [c.folder, c]))
  const series = await prisma.series.findUniqueOrThrow({ where: { id: seriesId } })
  const chapters = await prisma.chapter.findMany({
    where: { id: { in: preview.chapters.filter(c => wanted.has(c.chapterId)).map(c => c.chapterId) } },
  })

  let imported = 0
  for (const chapter of chapters) {
    const phone = byFolder.get(path.basename(chapter.folderPath))
    if (!phone?.script) continue
    const scriptPath = path.join(getFullFolderPath(chapter.folderPath), scriptFileName(language))
    await fs.writeFile(scriptPath, phone.script + '\n', 'utf-8')
    const data = {
      mode: 'manual',
      provider: 'sleeper-cell',
      model: null,
      scriptPath,
      status: 'done',
      rollingSummary: phone.summary,
      closingParagraph: phone.closing,
      error: null,
      // A Hinglish script carries the English it came from (stale when that
      // differs from the desktop's) and the phone's review issues, if any.
      ...(language === 'hi' ? { sourceSha256: phone.sourceSha256, review: encodeReview(phone.review) } : {})
    }
    await prisma.chapterScript.upsert({
      where: { chapterId_language: { chapterId: chapter.id, language } },
      update: data,
      create: { chapterId: chapter.id, language, ...data }
    })
    imported++
  }

  const aboutUpdated = language === 'en' && (preview.about === 'set' || preview.about === 'replace') && !!parsed.about
  if (aboutUpdated) {
    await prisma.series.update({ where: { id: seriesId }, data: { aboutSummary: parsed.about } })
    await fs.writeFile(path.join(getFullFolderPath(series.rootFolder), 'about.md'), parsed.about!, 'utf-8')
  }

  const record = JSON.stringify({ etag: zip.etag, at: new Date().toISOString(), chapters: imported })
  await prisma.setting.upsert({
    where: { key: importSettingKey(seriesId, language) },
    update: { value: record },
    create: { key: importSettingKey(seriesId, language), value: record }
  })
  return { imported, aboutUpdated }
}
