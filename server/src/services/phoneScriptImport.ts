/**
 * Import narration scripts written on the Sleeper-Cell phone.
 *
 * Phones send each finished chapter to R2 on its own, as it is saved:
 *
 *     <phone prefix>shared/scripts/<Series>/<Chapter>.script.json
 *       {"schema": "sleeper-cell-shared-script/1", "series", "chapter", "restartRevision",
 *        "device", "deviceId", "sharedAt",
 *        "files": {"script.md", "continuity.json", "script.review.json",
 *                  "script.hi.md", "continuity.hi.json"}}
 *     <phone prefix>shared/scripts/<Series>/_series.json   {"schema", "series", "about", …}
 *
 * (see SharedScripts.kt). Those chapter files are what this module reads. A
 * chapter counts once the phone would call it done: English with its summary
 * and closing, not saved before an earlier chapter (stale); Hinglish with the
 * English it was converted from and no failed check. When several phones (or
 * prefixes) hold a chapter, the one saved last wins. Nothing here deletes them.
 *
 * Phones used to upload one zip per series and language instead; those zips
 * stay in R2 and still fill chapters the shared files lack. The old zip held
 * one `<Series>/` folder:
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
 * phone's review issues). Both steps run from Narration's "Fetch from phone",
 * together with the voiceover fetch (see routes/narration.ts).
 */

import { withSeriesMutation } from './seriesActivity.js'
import { requireSeriesRestartReady } from './seriesRestartGuard.js'
import { createHash } from 'crypto'
import { recordManagerTransfer } from './managerReporting.js'
import fs from 'fs/promises'
import path from 'path'
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { readZip } from '../utils/zipReader.js'
import { createClient, getR2Config, isNotFound, phoneFolders } from './r2Service.js'
import { sameRestart } from './seriesRestartModel.js'
import { getPublishedChapters } from './storageService.js'
import { savedBeforeClear, scriptsClearedAt } from './scriptClear.js'
import { scriptFileName, type NarrationLanguage } from './narrationLanguage.js'

/** Folder the phone uploads script zips to, inside its R2 prefix. Keep in step with FOLDER in ScriptUpload.kt. */
const SCRIPTS_FOLDER = 'scripts/'

/** Where phones send each chapter's scripts, inside their prefix. Keep in step with SharedScripts.kt. */
export const SHARED_SCRIPTS_FOLDER = 'shared/scripts/'
const SHARED_CHAPTER_SUFFIX = '.script.json'
const SHARED_SERIES_FILE = '_series.json'
const SHARED_CHAPTER_SCHEMA = 'sleeper-cell-shared-script/1'
const SHARED_SERIES_SCHEMA = 'sleeper-cell-shared-series/1'
/** The image review of an English script; it travels with that script. */
export const SCRIPT_REVIEW_FILE = 'script.review.json'

/** Script zips are text only; anything bigger is not one of ours. */
const MAX_ZIP_BYTES = 64 * 1024 * 1024

function getFullFolderPath(relativePath: string): string {
  return path.join(process.env.DOWNLOAD_ROOT || './downloads', relativePath)
}

/** A Hinglish script's review issues as stored on its ChapterScript row: a JSON array, or null when it passed. */
function encodeReview(issues: string[] | null | undefined): string | null {
  return issues && issues.length > 0 ? JSON.stringify(issues) : null
}

/**
 * SHA-256 of the chapter's trimmed English script, the way the phone records
 * the English a Hinglish script was converted from; null while there is none.
 */
async function englishSha256(english: { status: string; scriptPath: string | null } | null | undefined): Promise<string | null> {
  if (!english || !['done', 'edited', 'stale'].includes(english.status)) return null
  const text = await readScript(english.scriptPath)
  return text ? createHash('sha256').update(text, 'utf8').digest('hex') : null
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
  /** English only: the phone's script.review.json for this script, if it sent one. */
  reviewJson?: string | null
  /** The phone that saved it, when known. */
  device?: string | null
}

export interface ParsedScriptsZip {
  restartRevision?: string
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
  let restartRevision: string | null = null
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

    if (rel.length === 1 && file === 'restart.json') {
      restartRevision = nonBlank(JSON.parse(text)?.restartRevision)
    } else if (rel.length === 1 && file === 'about.md' && language === 'en') {
      about = nonBlank(text)
    } else if (rel.length === 2 && file === names.script) {
      chapter(rel[0]).script = nonBlank(text)
    } else if (rel.length === 2 && file === names.continuity) {
      readContinuity(chapter(rel[0]), text, language)
    } else if (rel.length === 2 && file === SCRIPT_REVIEW_FILE && language === 'en') {
      chapter(rel[0]).reviewJson = nonBlank(text)
    }
  }

  const chapters = [...byFolder.values()]
    .filter(c => c.script)
    .sort((a, b) => a.folder.localeCompare(b.folder, undefined, { numeric: true }))
  return { about, chapters, ...(restartRevision ? { restartRevision } : {}) }
}

/** Fills a chapter's summary, closing, savedAt (and Hinglish source and review) from its continuity file. */
function readContinuity(entry: PhoneChapterFiles, text: string, language: NarrationLanguage): void {
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

// ============ Shared chapter files ============

/** One object read from `shared/scripts/<Series>/`. */
export interface SharedScriptObject {
  key: string
  etag: string
  lastModified: string | null
  text: string
}

const savedTime = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? 0 : t
}

/**
 * The chapters of `language` the phones have finished, from their shared chapter
 * files, and the newest about text. Pure: `objects` are what R2 listed under
 * every phone prefix for this series; `restartRevision` is the series' current
 * restart, and files from another restart are ignored.
 */
export function parseSharedScripts(
  objects: SharedScriptObject[],
  seriesFolder: string,
  language: NarrationLanguage,
  restartRevision: string | null
): { about: string | null; chapters: PhoneChapterFiles[] } {
  const names = zipFiles(language)
  let about: { text: string; at: number } | null = null
  const best = new Map<string, { entry: PhoneChapterFiles; saved: number; modified: number }>()

  for (const object of objects) {
    const name = object.key.slice(object.key.lastIndexOf('/') + 1)
    let json: any
    try { json = JSON.parse(object.text) } catch { continue }
    if (json?.series !== seriesFolder || !sameRestart(restartRevision, json?.restartRevision)) continue

    if (name === SHARED_SERIES_FILE) {
      const text = json.schema === SHARED_SERIES_SCHEMA ? nonBlank(json.about) : null
      const at = savedTime(json.sharedAt) || savedTime(object.lastModified)
      if (language === 'en' && text && (!about || at > about.at)) about = { text, at }
      continue
    }
    if (!name.endsWith(SHARED_CHAPTER_SUFFIX)) continue
    const folder = name.slice(0, -SHARED_CHAPTER_SUFFIX.length)
    if (json.schema !== SHARED_CHAPTER_SCHEMA || json.chapter !== folder || !json.files || typeof json.files !== 'object') continue
    const files = json.files as Record<string, unknown>
    const script = nonBlank(files[names.script])
    if (!script) continue
    const entry: PhoneChapterFiles = {
      folder, script, summary: null, closing: null, savedAt: null, sourceSha256: null, review: null,
      ...(language === 'en' ? { reviewJson: nonBlank(files[SCRIPT_REVIEW_FILE]) } : {}),
      device: nonBlank(json.device)
    }
    if (typeof files[names.continuity] === 'string') readContinuity(entry, files[names.continuity] as string, language)
    // Only what the phone itself counts as finished: never a draft.
    const finished = language === 'en'
      ? !!entry.summary && !!entry.closing
      : !!entry.sourceSha256 && !entry.review
    if (!finished) continue
    const saved = savedTime(entry.savedAt), modified = savedTime(object.lastModified)
    const current = best.get(folder)
    if (!current || saved > current.saved || (saved === current.saved && modified > current.modified)) best.set(folder, { entry, saved, modified })
  }

  const ordered = [...best.values()].sort((a, b) => a.entry.folder.localeCompare(b.entry.folder, undefined, { numeric: true }))
  const chapters: PhoneChapterFiles[] = []
  // As on the phone: an English chapter saved before an earlier one is stale (its
  // continuity no longer follows), so it is not offered until it is saved again.
  let latestEarlier = 0
  for (const { entry, saved } of ordered) {
    if (language === 'en' && saved < latestEarlier) continue
    latestEarlier = Math.max(latestEarlier, saved)
    chapters.push(entry)
  }
  return { about: about?.text ?? null, chapters }
}

/** Shared chapter files already read, by key, so an unchanged one is not downloaded again. */
const sharedCache = new Map<string, { etag: string; text: string }>()

/** Every shared script object of the series under each phone prefix (a LIST per prefix, GETs only for changed ones). */
async function listSharedScripts(seriesFolder: string): Promise<SharedScriptObject[]> {
  const config = getR2Config()
  if (!config) throw new Error('Cloudflare R2 is not configured')
  const client = createClient(config)
  try {
    const roots = [...new Set([config.prefix, '', ...await phoneFolders(client, config)])]
    const objects: SharedScriptObject[] = []
    const seen = new Set<string>()
    for (const root of roots) {
      let token: string | undefined
      do {
        const list = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: `${root}${SHARED_SCRIPTS_FOLDER}${seriesFolder}/`, ContinuationToken: token }))
        for (const item of list.Contents ?? []) {
          const key = item.Key
          if (!key || seen.has(key) || key.slice(`${root}${SHARED_SCRIPTS_FOLDER}${seriesFolder}/`.length).includes('/')) continue
          if (!key.endsWith(SHARED_CHAPTER_SUFFIX) && !key.endsWith('/' + SHARED_SERIES_FILE)) continue
          seen.add(key)
          const etag = (item.ETag ?? '').replace(/"/g, '')
          let cached = sharedCache.get(key)
          if (!cached || cached.etag !== etag) {
            const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
            cached = { etag, text: await res.Body!.transformToString() }
            sharedCache.set(key, cached)
          }
          objects.push({ key, etag, lastModified: item.LastModified?.toISOString() ?? null, text: cached.text })
        }
        token = list.NextContinuationToken
      } while (token)
    }
    return objects
  } finally {
    client.destroy()
  }
}

/**
 * What the phones have for this series in `language`: their shared chapter
 * files, with the old series zip (if any) filling chapters they lack. The
 * returned "zip" describes that whole source; its etag changes whenever any
 * part of it does, so an import can refuse what wasn't previewed.
 */
async function loadPhoneScripts(seriesId: string, language: NarrationLanguage): Promise<{ zip: PhoneScriptsZip; parsed: ParsedScriptsZip } | null> {
  if (!getR2Config()) throw new Error('Cloudflare R2 is not configured')
  const series = await prisma.series.findUnique({ where: { id: seriesId }, select: { rootFolder: true } })
  if (!series) throw new Error('Series not found')
  const folder = path.basename(series.rootFolder)
  const restart = await requireSeriesRestartReady(folder)

  const objects = await listSharedScripts(folder)
  const shared = parseSharedScripts(objects, folder, language, restart)
  // Old zips stay readable; one from another restart, or unreadable, is left out.
  const legacy = await downloadZip(seriesId, language).catch(error => {
    console.warn(`[narration] old script zip for ${folder} (${language}) unreadable:`, error instanceof Error ? error.message : error)
    return null
  })
  const legacyUsable = legacy && sameRestart(restart, legacy.parsed.restartRevision ?? null) ? legacy : null
  const sharedFolders = new Set(shared.chapters.map(c => c.folder))
  const chapters = [...shared.chapters, ...(legacyUsable?.parsed.chapters.filter(c => !sharedFolders.has(c.folder)) ?? [])]
    .sort((a, b) => a.folder.localeCompare(b.folder, undefined, { numeric: true }))
  const about = shared.about ?? legacyUsable?.parsed.about ?? null
  if (chapters.length === 0 && !about) return null

  const parts = objects.map(o => [o.key, o.etag]).sort((a, b) => a[0].localeCompare(b[0]))
  const etag = createHash('sha256').update(JSON.stringify([parts, legacyUsable?.zip.etag ?? null])).digest('hex')
  const modified = [...objects.map(o => o.lastModified), legacyUsable?.zip.uploadedAt ?? null].filter((t): t is string => !!t).sort()
  return {
    zip: {
      key: `${SHARED_SCRIPTS_FOLDER}${folder}/`,
      etag,
      size: objects.reduce((n, o) => n + o.text.length, 0) + (legacyUsable?.zip.size ?? 0),
      uploadedAt: modified[modified.length - 1] ?? null
    },
    parsed: { about, chapters, ...(restart ? { restartRevision: restart } : {}) }
  }
}

// ============ Finding the old zip ============

export interface PhoneScriptsZip {
  key: string
  etag: string
  size: number
  uploadedAt: string | null
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
      if (head.ContentLength === 0) continue // A restart tombstone is not an uploaded ZIP.
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

/** Parsed zips by series and language, so the import right after a preview doesn't download again. */
const parsedCache = new Map<string, { etag: string; parsed: ParsedScriptsZip }>()

/** The phone's zip, downloaded and parsed (or from the cache); null when it hasn't uploaded one. */
async function downloadZip(seriesId: string, language: NarrationLanguage): Promise<{ zip: PhoneScriptsZip; parsed: ParsedScriptsZip } | null> {
  const config = getR2Config()
  if (!config) throw new Error('Cloudflare R2 is not configured')
  const zip = await findZip(seriesId, language)
  if (!zip) return null

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
  /** SHA-256 of the phone's trimmed script, to recognise this exact version later. */
  phoneSha256: string
  /** The phone that saved it, when known. */
  device: string | null
  /** English only: the script is the same but the phone's image review differs from the desktop's. */
  reviewChanged: boolean
  /** The desktop has a script and the phone's text differs from it (not just its summary or other details). */
  textDiffers: boolean
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
  await requireSeriesRestartReady(path.basename(series.rootFolder), parsed.restartRevision, true)
  const published = (await getPublishedChapters(seriesId, language)).chapters
  const byFolder = new Map(series.chapters.map(c => [path.basename(c.folderPath), c]))
  const cleared = await scriptsClearedAt(series.chapters.map(c => c.id))

  const chapters: PhoneImportChapter[] = []
  const unmatched: string[] = []
  for (const phone of parsed.chapters) {
    const chapter = byFolder.get(phone.folder)
    if (!chapter) {
      unmatched.push(phone.folder)
      continue
    }
    // Cleared in Studio after a phone saved this: it is the old script, not on offer.
    if (savedBeforeClear(cleared.get(chapter.id), phone.savedAt)) continue
    const script = chapter.scripts.find(s => s.language === language)
    const current = await readScript(script?.scriptPath)
    const same =
      current === phone.script &&
      (script?.rollingSummary ?? null) === phone.summary &&
      (script?.closingParagraph ?? null) === phone.closing &&
      (language === 'en' || ((script?.sourceSha256 ?? null) === phone.sourceSha256 && script?.review === encodeReview(phone.review)))
    const englishNow = language === 'en' ? null : await englishSha256(chapter.scripts.find(s => s.language === 'en'))
    const reviewNow = language === 'en' && same
      ? await fs.readFile(path.join(getFullFolderPath(chapter.folderPath), SCRIPT_REVIEW_FILE), 'utf-8').then(t => t.trim(), () => null)
      : null
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
      sourceMatches: language === 'en' || !englishNow || !phone.sourceSha256 ? null : englishNow === phone.sourceSha256,
      phoneSha256: createHash('sha256').update(phone.script ?? '', 'utf8').digest('hex'),
      device: phone.device ?? null,
      reviewChanged: language === 'en' && same && !!phone.reviewJson && reviewNow !== phone.reviewJson,
      textDiffers: current !== null && current !== phone.script
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

/** What importing the phones' scripts would do per chapter; null when no phone has sent any. */
export async function previewPhoneScripts(seriesId: string, language: NarrationLanguage = 'en'): Promise<PhoneImportPreview | null> {
  const loaded = await loadPhoneScripts(seriesId, language)
  return loaded && buildPreview(seriesId, loaded.zip, loaded.parsed, language)
}

/** Every finished chapter the phones have in `language`, and the source's etag; null when none. */
export async function phoneScriptFiles(seriesId: string, language: NarrationLanguage): Promise<{ etag: string; chapters: PhoneChapterFiles[] } | null> {
  const loaded = await loadPhoneScripts(seriesId, language)
  return loaded && { etag: loaded.zip.etag, chapters: loaded.parsed.chapters }
}

/** The phones' current files for one chapter in `language` (null when none is finished), with the source's etag. */
export async function phoneChapterScript(seriesId: string, chapterId: string, language: NarrationLanguage): Promise<{ etag: string; files: PhoneChapterFiles } | null> {
  const chapter = await prisma.chapter.findUnique({ where: { id: chapterId }, select: { seriesId: true, folderPath: true } })
  if (!chapter || chapter.seriesId !== seriesId) throw new Error('Chapter not found')
  const loaded = await loadPhoneScripts(seriesId, language)
  const files = loaded?.parsed.chapters.find(c => c.folder === path.basename(chapter.folderPath))
  return loaded && files ? { etag: loaded.zip.etag, files } : null
}

/**
 * Brings the phones' image review (script.review.json) to chapters whose English
 * script here is exactly the phone's. Review notes don't feed anything else, so
 * this needs no confirmation. Returns how many changed.
 */
export async function updatePhoneScriptReviews(seriesId: string, chapterIds: string[]): Promise<number> {
  if (chapterIds.length === 0) return 0
  const loaded = await loadPhoneScripts(seriesId, 'en')
  if (!loaded) return 0
  const preview = await buildPreview(seriesId, loaded.zip, loaded.parsed, 'en')
  const wanted = new Set(chapterIds)
  const byFolder = new Map(loaded.parsed.chapters.map(c => [c.folder, c]))
  let updated = 0
  for (const row of preview.chapters) {
    if (!wanted.has(row.chapterId) || row.action !== 'same' || !row.reviewChanged) continue
    const chapter = await prisma.chapter.findUnique({ where: { id: row.chapterId }, select: { folderPath: true } })
    const review = byFolder.get(row.folder)?.reviewJson
    if (!chapter || !review) continue
    await fs.writeFile(path.join(getFullFolderPath(chapter.folderPath), SCRIPT_REVIEW_FILE), review + '\n', 'utf-8')
    updated++
  }
  return updated
}

// ============ Import ============

export interface PhoneImportResult {
  imported: number
  aboutUpdated: boolean
}

export interface PhoneImportOptions {
  /**
   * replace (default, the user's own fetch): the about text follows the preview.
   * fill (automatic imports): only set when the series has none.
   */
  about?: 'replace' | 'fill'
  /**
   * You compared both texts and chose the phone's (Narration's "Use phone's
   * version"): a script Studio replaced earlier no longer blocks it; its
   * replacement marker is dropped (its backup folder stays).
   */
  overStudioReplacement?: boolean
}

/**
 * Applies the zip previewed as `etag` to `chapterIds` (chapters of this series
 * that are in the zip). Refuses if the phone has uploaded a newer zip since.
 */
export async function importPhoneScripts(
  seriesId: string,
  etag: string,
  chapterIds: string[],
  language: NarrationLanguage = 'en',
  options: PhoneImportOptions = {}
): Promise<PhoneImportResult> {
  const loaded = await loadPhoneScripts(seriesId, language)
  if (!loaded) throw new Error('The phones\' scripts are no longer in R2')
  const { zip, parsed } = loaded
  if (zip.etag !== etag) throw new Error('A phone sent newer scripts since the preview — review them again')

  const preview = await buildPreview(seriesId, zip, parsed, language)
  const wanted = new Set(chapterIds)
  const byFolder = new Map(parsed.chapters.map(c => [c.folder, c]))
  const series = await prisma.series.findUniqueOrThrow({ where: { id: seriesId } })
  return withSeriesMutation(path.basename(series.rootFolder), async () => {
  const chapters = await prisma.chapter.findMany({
    where: { id: { in: preview.chapters.filter(c => wanted.has(c.chapterId)).map(c => c.chapterId) } },
  })

  let imported = 0
  for (const chapter of chapters) {
    await requireSeriesRestartReady(path.basename(series.rootFolder), parsed.restartRevision, true)
    const phone = byFolder.get(path.basename(chapter.folderPath))
    if (!phone?.script) continue
    recordManagerTransfer({ seriesId,chapterId:chapter.id,stage:`script_${language}`,phase:'cloud',objectVersion:zip.etag })
    try {
      const scriptPath = path.join(getFullFolderPath(chapter.folderPath), scriptFileName(language))
      const markerPath = path.join(path.dirname(scriptPath), `.script-replacement${language === 'hi' ? '.hi' : ''}.json`)
      const replacement = await fs.readFile(markerPath, 'utf-8')
        .then(text => JSON.parse(text)).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e })
      let dropMarker = false
      if (replacement) {
        const current = await fs.readFile(scriptPath, 'utf-8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e })
        if (current !== null && current.trim() === phone.script.trim()) {
          // Preserve the exact replacement bytes: its audio and revision hashes use them.
          continue
        }
        if (!options.overStudioReplacement) throw new Error(`Chapter ${chapter.number}: the phone still has a different script. Sync the replacement to Sleeper-Cell first.`)
        dropMarker = true
      }
      await fs.writeFile(scriptPath, phone.script + '\n', 'utf-8')
      if (language === 'en') {
        // The image review describes this exact script: keep it with it, or drop the old one.
        const reviewPath = path.join(path.dirname(scriptPath), SCRIPT_REVIEW_FILE)
        if (phone.reviewJson) await fs.writeFile(reviewPath, phone.reviewJson + '\n', 'utf-8')
        else await fs.unlink(reviewPath).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e })
      }
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
      // The phone's script is this chapter's now; a stale marker would also refuse its voiceover.
      if (dropMarker) await fs.rm(markerPath, { force: true })
      imported++
      recordManagerTransfer({ seriesId,chapterId:chapter.id,stage:`script_${language}`,phase:'imported',objectVersion:zip.etag })
    } catch (error) {
      recordManagerTransfer({ seriesId,chapterId:chapter.id,stage:`script_${language}`,phase:'failed',objectVersion:zip.etag })
      throw error
    }
  }

  const aboutUpdated = language === 'en' && (preview.about === 'set' || (preview.about === 'replace' && options.about !== 'fill')) && !!parsed.about
  if (aboutUpdated) {
    await prisma.series.update({ where: { id: seriesId }, data: { aboutSummary: parsed.about } })
    await fs.writeFile(path.join(getFullFolderPath(series.rootFolder), 'about.md'), parsed.about!, 'utf-8')
  }

  // Remembered for reference: which zip each series last imported.
  const record = JSON.stringify({ etag: zip.etag, at: new Date().toISOString(), chapters: imported })
  await prisma.setting.upsert({
    where: { key: importSettingKey(seriesId, language) },
    update: { value: record },
    create: { key: importSettingKey(seriesId, language), value: record }
  })
  return { imported, aboutUpdated }
  })
}
