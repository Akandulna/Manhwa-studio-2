/**
 * Editor 2.0 ⇄ the Sleeper-Cell phone app, through Cloudflare R2.
 *
 * Making a chapter's timeline JSON is a ChatGPT step: Copy All (the Editor 2.0
 * prompt, the script with timeline and the crop metadata), paste it into
 * ChatGPT, paste the JSON back. The phone automates it in ChatGPT's GPT-6
 * Astra (EditorRun.kt), so this sends it the Copy All text and takes back the
 * JSON:
 *
 *   <phone prefix>editor/_prompt.json                         this → phone
 *   <phone prefix>editor/<Series>/<Chapter>.package.json     this → phone
 *   <phone prefix>editor/<Series>/<Chapter>.timeline.json    phone → this
 *
 * A chapter goes up by itself once it's ready for its timeline JSON
 * (voiceover, alignment, reviewed crops cut, no JSON yet): see
 * publishReadyEditorPackages and editorAutoPublish.ts. Send to phone still
 * sends a series' chapters at once, whether or not they changed.
 *
 * The Editor 2.0 prompt goes up on its own whenever it's saved in Settings
 * (and again with each send), so the phone always pastes the latest one; a
 * package holds only the chapter's script with timeline and crop metadata.
 *
 * Hinglish uses `<Chapter>.hi.package.json` and `<Chapter>.hi.timeline.json`.
 * Series and chapter are the folder names, as for the manhwa zips.
 *
 * With the prompt, a package makes the exact text copyAll() in
 * EditorChapterList2 puts on the clipboard (copyAllText; the phone's
 * EditorPackage.copyAllText builds the same), plus what the phone checks the
 * reply against: each voice section's audio length, and the crop files in
 * crops3/, which are what the timeline processor resolves image names against.
 * Keep the schemas in step with EditorPackage / EditorLibrary.save / EditorSync
 * in the phone's editor/ folder.
 *
 * Fetching stores each timeline as the chapter's Editor 2.0 paste (the
 * Editor2Timeline row), unprocessed, so the chapter asks for Start Processing
 * as after a paste by hand. A paste made here after the phone made its
 * timeline is kept.
 *
 * R2 cost: saving the prompt is one PUT (Class A) plus the phone's nudge; a
 * send is one PUT per chapter plus the prompt's and the nudge; a
 * fetch is one LIST per folder tried, plus one GET (Class B) per timeline.
 * Nothing here runs on a timer.
 */

import { createHash } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { createClient, getR2Config, phoneFolders, requestPhoneUpdate, type R2Config } from './r2Service.js'
import { getChapterBlockers, getChapterCropMetadataBundle, getChapterTimelineBundle } from './videoEditor2Service.js'
import { getOutputDir, getSourceFolderPath } from './clipper3/perImageStore.js'
import { readEffectiveReview } from './clipper3/chapterReview.js'
import { NARRATION_LANGUAGES, type NarrationLanguage } from './narrationLanguage.js'
import { getPublishedChapters } from './storageService.js'

/** Inside the phone's prefix. Keep in step with FOLDER in EditorSync.kt. */
export const EDITOR_FOLDER = 'editor/'
const PACKAGE_SUFFIX = '.package.json'
const TIMELINE_SUFFIX = '.timeline.json'
const PACKAGE_SCHEMA = 'manhwa-studio-editor-package/2'
/** At the top of the editor folder. Keep in step with PROMPT_FILE in EditorLibrary.kt. */
const PROMPT_NAME = '_prompt.json'
const PROMPT_SCHEMA = 'manhwa-studio-editor-prompt/1'
const TIMELINE_SCHEMA = /^sleeper-cell-editor-timeline\/1/
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i

/** English keeps the plain names; Hinglish adds ".hi", as the phone's Language.suffix does. */
function languageSuffix(language: NarrationLanguage): string {
  return language === 'en' ? '' : `.${language}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The Copy All text: what EditorChapterList2's copyAll() writes to the
 * clipboard, section for section. Keep the two the same.
 */
export function copyAllText(prompt: string, timeline: string, metadata: string): string {
  const sections: string[] = []
  if (prompt) sections.push(`# Prompt\n\n${prompt}`)
  if (timeline) sections.push(`# Script with Timeline\n\n${timeline}`)
  if (metadata) sections.push(`# Crop Metadata\n\n${metadata}`)
  return sections.join('\n\n')
}

/** The last "MM:SS.ss" in a script with timeline, in seconds: the end of its last beat. */
function lastTimestamp(timelineScript: string): number | null {
  let last: number | null = null
  for (const match of timelineScript.matchAll(/(\d{1,2}):(\d{2}(?:\.\d+)?)/g)) {
    const seconds = Number(match[1]) * 60 + Number(match[2])
    if (Number.isFinite(seconds) && (last === null || seconds > last)) last = seconds
  }
  return last
}

// ============ The prompt ============

/**
 * Puts the Editor 2.0 prompt where the phone fetches it, replacing the last
 * one. With `notify`, the phone is asked to check R2 straight away, so it has
 * the prompt before its next run. Returns whether it was asked.
 */
export async function saveEditorPrompt(content: string, notify = true): Promise<{ phoneNotified: boolean }> {
  if (!content.trim()) throw new Error('The prompt is empty')
  const config = getR2Config()
  if (!config) throw new Error('Cloudflare R2 is not set up')
  const client = createClient(config)
  const body = JSON.stringify({ schema: PROMPT_SCHEMA, content: content.trim(), savedAt: new Date().toISOString() })
  for (const folder of await phoneFolders(client, config)) {
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: `${folder}${EDITOR_FOLDER}${PROMPT_NAME}`,
      Body: body,
      ContentType: 'application/json'
    }))
  }
  if (!notify) return { phoneNotified: false }
  try {
    await requestPhoneUpdate('sync')
    return { phoneNotified: true }
  } catch (error) {
    console.warn('[phoneEditor] could not ask the phone to check R2:', errorMessage(error))
    return { phoneNotified: false }
  }
}

// ============ Send ============

export interface EditorSendResult {
  sent: { chapterId: string; number: number }[]
  skipped: { chapterId: string; number: number; reason: string }[]
  /** Whether the phone was asked to check R2 straight away. */
  phoneNotified: boolean
}

interface PackageChapter { id: string; number: number; title: string | null; folderPath: string }

/** One chapter's package, ready to PUT; `sha256` covers everything but `sentAt`, so an unchanged chapter reads the same. */
interface BuiltPackage { name: string; body: string; sha256: string }

/**
 * Builds `chapter`'s package in `language`, or says why it can't: a chapter
 * without a script with timeline or crop metadata has nothing to make one from.
 */
async function buildPackage(
  seriesFolder: string,
  chapter: PackageChapter,
  language: NarrationLanguage
): Promise<BuiltPackage | { skip: string }> {
  const [timeline, metadata] = await Promise.all([
    getChapterTimelineBundle(chapter.id, language),
    getChapterCropMetadataBundle(chapter.id)
  ])
  if (!timeline?.text) return { skip: 'no script with timeline' }
  if (!metadata?.text) return { skip: 'no crop metadata' }

  const audioSections = await prisma.audioSection.findMany({
    where: { chapterId: chapter.id, language },
    orderBy: { index: 'asc' },
    include: { audioFile: true }
  })
  // The sections the bundle includes, numbered as its "## Section N" headings are.
  const sections = audioSections
    .filter(s => !!s.timelineScript?.trim())
    .map(s => ({
      number: s.index + 1,
      durationSec: s.audioFile?.durationMs && s.audioFile.durationMs > 0
        ? s.audioFile.durationMs / 1000
        : lastTimestamp(s.timelineScript ?? '')
    }))

  let images: string[] = []
  try {
    images = (await fs.readdir(getOutputDir(chapter.folderPath))).filter(n => IMAGE_EXT.test(n)).sort()
  } catch {
    // No crops3 folder: the phone then can't check image names, only the rest.
  }

  const chapterFolder = path.basename(chapter.folderPath)
  const content = {
    schema: PACKAGE_SCHEMA,
    series: seriesFolder,
    chapter: chapterFolder,
    chapterId: chapter.id,
    number: chapter.number,
    title: chapter.title,
    language,
    sections,
    images,
    timeline: timeline.text,
    metadata: metadata.text
  }
  return {
    name: `${seriesFolder}/${chapterFolder}${languageSuffix(language)}${PACKAGE_SUFFIX}`,
    body: JSON.stringify({ ...content, sentAt: new Date().toISOString() }),
    sha256: createHash('sha256').update(JSON.stringify(content)).digest('hex')
  }
}

async function putPackage(client: S3Client, config: R2Config, folders: string[], pkg: BuiltPackage): Promise<void> {
  for (const folder of folders) {
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: `${folder}${EDITOR_FOLDER}${pkg.name}`,
      Body: pkg.body,
      ContentType: 'application/json'
    }))
  }
}

/**
 * What was last sent of a chapter, per language, kept in its folder: so the
 * automatic send ([publishReadyEditorPackages]) puts a package up only when it
 * changed. Only ever a hint: a missing or unreadable record means a resend.
 */
const SENT_RECORD = '.editor2-phone.json'
type SentRecord = Partial<Record<NarrationLanguage, { sha256: string; sentAt: string }>>

async function readSentRecord(folderPath: string): Promise<SentRecord> {
  try {
    return JSON.parse(await fs.readFile(path.join(getSourceFolderPath(folderPath), SENT_RECORD), 'utf-8')) ?? {}
  } catch {
    return {}
  }
}

async function recordSent(folderPath: string, language: NarrationLanguage, sha256: string): Promise<void> {
  try {
    const record = await readSentRecord(folderPath)
    record[language] = { sha256, sentAt: new Date().toISOString() }
    await fs.writeFile(path.join(getSourceFolderPath(folderPath), SENT_RECORD), JSON.stringify(record, null, 2), 'utf-8')
  } catch {
    // The chapter folder is gone; the next automatic send just sends it again.
  }
}

async function nudgePhone(): Promise<boolean> {
  try {
    await requestPhoneUpdate('sync')
    return true
  } catch (error) {
    console.warn('[phoneEditor] could not ask the phone to check R2:', errorMessage(error))
    return false
  }
}

/**
 * Sends each of `chapterIds` (in `language`) to the phone as a package,
 * replacing any sent before. `prompt` is the Editor 2.0 prompt, which lives in
 * the browser (Settings → Editor 2.0), so the client passes it; it goes up
 * first, so the phone has the one this browser holds. A chapter without a
 * script with timeline or crop metadata is skipped and reported.
 */
export async function sendEditorPackages(
  seriesId: string,
  language: NarrationLanguage,
  chapterIds: string[],
  prompt: string
): Promise<EditorSendResult> {
  if (!prompt.trim()) throw new Error('Save the Editor 2.0 prompt in Settings → Editor 2.0 first: the phone pastes it with each chapter.')
  const config = getR2Config()
  if (!config) throw new Error('Cloudflare R2 is not set up')
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: {
      title: true,
      rootFolder: true,
      chapters: { where: { id: { in: chapterIds } }, orderBy: { number: 'asc' }, select: { id: true, number: true, title: true, folderPath: true } }
    }
  })
  if (!series) throw new Error('Series not found')

  await saveEditorPrompt(prompt, false)
  const client = createClient(config)
  const folders = await phoneFolders(client, config)
  const seriesFolder = path.basename(series.rootFolder)
  const result: EditorSendResult = { sent: [], skipped: [], phoneNotified: false }

  for (const chapter of series.chapters) {
    const skip = (reason: string) => result.skipped.push({ chapterId: chapter.id, number: chapter.number, reason })
    try {
      const pkg = await buildPackage(seriesFolder, chapter, language)
      if ('skip' in pkg) { skip(pkg.skip); continue }
      await putPackage(client, config, folders, pkg)
      await recordSent(chapter.folderPath, language, pkg.sha256)
      result.sent.push({ chapterId: chapter.id, number: chapter.number })
    } catch (error) {
      skip(errorMessage(error))
    }
  }

  if (result.sent.length > 0) result.phoneNotified = await nudgePhone()
  return result
}

// ============ Automatic send ============

export interface EditorPublishResult {
  sent: { chapterId: string; number: number; language: NarrationLanguage }[]
  failed: { chapterId: string; language: NarrationLanguage; error: string }[]
}

/**
 * Sends every chapter that's ready for its timeline JSON straight to the
 * phone, without a Send to phone: voiceover audio, alignment, reviewed crops
 * cut to crops3/ (the checklist's inputsReady) and no timeline JSON here yet.
 * Each language goes on its own, as Send to phone does from its tab. A
 * package already up with the same content is left alone, unless it's no
 * longer in R2. `chapterIds` narrows it to those chapters; null checks all.
 *
 * Run from editorAutoPublish.ts after an alignment or a cut, and at startup.
 * R2 cost: one LIST per phone folder when there's something to check, one PUT
 * per changed package, and one nudge when anything went up.
 */
export async function publishReadyEditorPackages(chapterIds: string[] | null): Promise<EditorPublishResult> {
  const result: EditorPublishResult = { sent: [], failed: [] }
  const config = getR2Config()
  if (!config) return result
  let r2: { client: S3Client; folders: string[]; keys: Set<string> } | null = null

  for (const language of NARRATION_LANGUAGES) {
    const chapters = await prisma.chapter.findMany({
      where: {
        ...(chapterIds ? { id: { in: chapterIds } } : {}),
        completedAt: null,
        audioSections: { some: { language } }
      },
      orderBy: [{ seriesId: 'asc' }, { number: 'asc' }],
      select: { id: true, number: true, title: true, folderPath: true, series: { select: { rootFolder: true } } }
    })
    const withJson = new Set(
      (await prisma.editor2Timeline.findMany({
        where: { chapterId: { in: chapters.map(c => c.id) }, language },
        select: { chapterId: true, json: true }
      })).filter(r => r.json.trim()).map(r => r.chapterId)
    )

    for (const chapter of chapters) {
      if (withJson.has(chapter.id)) continue
      try {
        const blockers = await getChapterBlockers(chapter.id, language)
        if (blockers === null || blockers.length > 0) continue
        if (!(await readEffectiveReview(chapter.folderPath)).reviewed) continue
        const pkg = await buildPackage(path.basename(chapter.series.rootFolder), chapter, language)
        if ('skip' in pkg) continue

        if (!r2) {
          const client = createClient(config)
          const folders = await phoneFolders(client, config)
          r2 = { client, folders, keys: await listEditorKeys(client, config, folders) }
        }
        const { client, folders, keys } = r2
        const upEverywhere = folders.every(folder => keys.has(`${folder}${EDITOR_FOLDER}${pkg.name}`))
        if (upEverywhere && (await readSentRecord(chapter.folderPath))[language]?.sha256 === pkg.sha256) continue

        await putPackage(client, config, folders, pkg)
        await recordSent(chapter.folderPath, language, pkg.sha256)
        result.sent.push({ chapterId: chapter.id, number: chapter.number, language })
      } catch (error) {
        result.failed.push({ chapterId: chapter.id, language, error: errorMessage(error) })
      }
    }
  }

  if (result.sent.length > 0) await nudgePhone()
  return result
}

/** Every key under the phone folders' editor/, to tell a package that's gone from one that's up. */
export async function listEditorKeys(client: S3Client, config: R2Config, folders: string[]): Promise<Set<string>> {
  const keys = new Set<string>()
  for (const folder of folders) {
    let token: string | undefined
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: `${folder}${EDITOR_FOLDER}`, ContinuationToken: token }))
      for (const object of page.Contents ?? []) if (object.Key) keys.add(object.Key)
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
  }
  return keys
}

// ============ Split between phones ============

/**
 * A series' chapters still waiting for their timeline in `language`, in
 * reading order, for Editor 2.0's run split between phones (phoneSplit.ts
 * shares them out). Waiting means its package is up for the phones, and
 * neither its timeline is up nor a timeline JSON pasted here. R2 cost: one
 * LIST per phone folder, once the plan is asked for.
 */
export async function editorWaitingChapters(seriesId: string, language: NarrationLanguage): Promise<string[]> {
  const config = getR2Config()
  if (!config) throw new Error('Cloudflare R2 is not set up')
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: { rootFolder: true, chapters: { orderBy: { number: 'asc' }, select: { id: true, folderPath: true } } }
  })
  if (!series) throw new Error('Series not found')
  const seriesFolder = path.basename(series.rootFolder)
  const suffix = languageSuffix(language)

  const client = createClient(config)
  const names = new Set<string>()
  for (const folder of await phoneFolders(client, config)) {
    const base = `${folder}${EDITOR_FOLDER}${seriesFolder}/`
    let token: string | undefined
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: base, ContinuationToken: token }))
      for (const object of page.Contents ?? []) {
        const name = object.Key?.slice(base.length) ?? ''
        if (name && !name.includes('/')) names.add(name)
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
  }
  const withJson = new Set(
    (await prisma.editor2Timeline.findMany({
      where: { chapterId: { in: series.chapters.map(c => c.id) }, language },
      select: { chapterId: true, json: true }
    })).filter(r => r.json.trim()).map(r => r.chapterId)
  )

  const waiting: string[] = []
  let sent = 0
  for (const chapter of series.chapters) {
    const folder = path.basename(chapter.folderPath)
    if (!names.has(`${folder}${suffix}${PACKAGE_SUFFIX}`)) continue
    sent++
    if (withJson.has(chapter.id) || names.has(`${folder}${suffix}${TIMELINE_SUFFIX}`)) continue
    waiting.push(folder)
  }
  if (sent === 0) throw new Error('No Editor 2.0 package of this series is up for the phones: send its chapters to the phone from Editor 2.0 first')
  return waiting
}

// ============ Ready for a run ============

export interface EditorChapterRef { chapterId: string; number: number }

/** What a series' Editor 2.0 run on the phone has to work with, in `language` (Run automation's checklist). */
export interface EditorReadiness {
  /** The Editor 2.0 prompt is up for the phones. */
  prompt: boolean
  /** Chapters with their timeline made already: a JSON pasted here, or the phone's timeline up. */
  made: number
  /** Waiting for their timeline, package up: the run fetches these as it starts. */
  up: EditorChapterRef[]
  /** Ready here, package not up yet: what publishReadyEditorPackages would send. */
  toSend: EditorChapterRef[]
  /** Not ready here: what each still lacks (voiceover, alignment, crops, review…). */
  notReady: (EditorChapterRef & { missing: string[] })[]
}

/**
 * Every unpublished, uncompleted chapter of the series sorted into the groups
 * above. R2 cost: one LIST per phone folder, so it's asked for on demand only.
 */
export async function getEditorReadiness(seriesId: string, language: NarrationLanguage): Promise<EditorReadiness> {
  const config = getR2Config()
  if (!config) throw new Error('Cloudflare R2 is not set up')
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: {
      rootFolder: true,
      chapters: {
        where: { completedAt: null },
        orderBy: { number: 'asc' },
        select: { id: true, number: true, folderPath: true, _count: { select: { audioSections: { where: { language } } } } }
      }
    }
  })
  if (!series) throw new Error('Series not found')
  const seriesFolder = path.basename(series.rootFolder)
  const suffix = languageSuffix(language)

  const client = createClient(config)
  const folders = await phoneFolders(client, config)
  const keys = await listEditorKeys(client, config, folders)
  const everywhere = (name: string) => folders.every(folder => keys.has(`${folder}${EDITOR_FOLDER}${name}`))
  const anywhere = (name: string) => folders.some(folder => keys.has(`${folder}${EDITOR_FOLDER}${name}`))

  const [published, timelines] = await Promise.all([
    getPublishedChapters(seriesId, language),
    prisma.editor2Timeline.findMany({ where: { chapterId: { in: series.chapters.map(c => c.id) }, language }, select: { chapterId: true, json: true } })
  ])
  const withJson = new Set(timelines.filter(r => r.json.trim()).map(r => r.chapterId))

  const result: EditorReadiness = { prompt: everywhere(PROMPT_NAME), made: 0, up: [], toSend: [], notReady: [] }
  for (const chapter of series.chapters) {
    if (published.chapters[chapter.id]) continue
    const ref = { chapterId: chapter.id, number: chapter.number }
    const name = `${seriesFolder}/${path.basename(chapter.folderPath)}${suffix}`
    if (withJson.has(chapter.id) || anywhere(`${name}${TIMELINE_SUFFIX}`)) { result.made++; continue }
    if (everywhere(`${name}${PACKAGE_SUFFIX}`)) { result.up.push(ref); continue }
    // No voiceover yet: the checklist would only say the same, at a cost.
    if (chapter._count.audioSections === 0) { result.notReady.push({ ...ref, missing: ['voiceover'] }); continue }
    const missing = [...((await getChapterBlockers(chapter.id, language)) ?? [])]
    if (!(await readEffectiveReview(chapter.folderPath)).reviewed) missing.push('crop review')
    if (missing.length) result.notReady.push({ ...ref, missing })
    else result.toSend.push(ref)
  }
  return result
}

// ============ Fetch ============

export interface EditorFetchResult {
  configured: boolean
  /** Timelines found for this series in this language. */
  found: number
  imported: { chapterId: string; number: number; review: number; model: string | null }[]
  upToDate: number
  /** Chapters whose paste here is newer than the phone's timeline, so it was kept. */
  kept: { chapterId: string; number: number }[]
  unmatched: string[]
  failed: { key: string; error: string }[]
}

interface ListedTimeline { key: string; chapterFolder: string }

/** The phone writes under its own prefix, which may not match ours, so every place it may be is tried. */
async function listTimelines(
  client: S3Client,
  config: R2Config,
  seriesFolder: string,
  language: NarrationLanguage
): Promise<ListedTimeline[]> {
  const folders = [...new Set([...(await phoneFolders(client, config)), config.prefix, ''])]
  const suffix = `${languageSuffix(language)}${TIMELINE_SUFFIX}`
  for (const folder of folders) {
    const base = `${folder}${EDITOR_FOLDER}${seriesFolder}/`
    const found: ListedTimeline[] = []
    let token: string | undefined
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: base, ContinuationToken: token }))
      for (const object of page.Contents ?? []) {
        const name = object.Key?.slice(base.length) ?? ''
        if (!object.Key || name.includes('/') || !name.endsWith(suffix)) continue
        const chapterFolder = name.slice(0, -suffix.length)
        // An English listing must not take a Hinglish file for a chapter named "… .hi".
        if (language === 'en' && chapterFolder.endsWith('.hi')) continue
        if (chapterFolder) found.push({ key: object.Key, chapterFolder })
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    if (found.length > 0) return found
  }
  return []
}

/**
 * Stores every timeline the phone made for this series in `language` as its
 * chapter's Editor 2.0 paste, unprocessed. A chapter already holding the same
 * JSON is left as it is, and one whose paste changed after the phone made its
 * timeline keeps its paste.
 */
export async function fetchPhoneTimelines(seriesId: string, language: NarrationLanguage): Promise<EditorFetchResult> {
  const result: EditorFetchResult = { configured: false, found: 0, imported: [], upToDate: 0, kept: [], unmatched: [], failed: [] }
  const config = getR2Config()
  if (!config) return result
  result.configured = true
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: { rootFolder: true, chapters: { select: { id: true, number: true, folderPath: true } } }
  })
  if (!series) throw new Error('Series not found')

  const client = createClient(config)
  const byFolder = new Map(series.chapters.map(c => [path.basename(c.folderPath), c]))
  const listed = await listTimelines(client, config, path.basename(series.rootFolder), language)
  result.found = listed.length

  for (const { key, chapterFolder } of listed) {
    const chapter = byFolder.get(chapterFolder)
    if (!chapter) {
      result.unmatched.push(chapterFolder)
      continue
    }
    try {
      const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
      const body = JSON.parse(await object.Body!.transformToString('utf-8'))
      if (typeof body?.schema !== 'string' || !TIMELINE_SCHEMA.test(body.schema)) throw new Error('not a Sleeper-Cell timeline')
      if ((body.language ?? 'en') !== language) throw new Error(`made for language "${body.language}"`)
      const json = typeof body.timeline === 'string' ? body.timeline.trim() : ''
      if (!json) throw new Error('the timeline is empty')
      const madeAt = Date.parse(body.madeAt) || 0

      const where = { chapterId_language: { chapterId: chapter.id, language } }
      const existing = await prisma.editor2Timeline.findUnique({ where })
      if (existing && existing.json.trim() === json) {
        result.upToDate++
        continue
      }
      if (existing && existing.json.trim() && existing.updatedAt.getTime() > madeAt) {
        result.kept.push({ chapterId: chapter.id, number: chapter.number })
        continue
      }
      // Newer than the row, so every browser's cache takes it on its next sync (newest wins).
      const updatedAt = new Date(Math.max(Date.now(), (existing?.updatedAt.getTime() ?? 0) + 1))
      await prisma.editor2Timeline.upsert({
        where,
        create: { chapterId: chapter.id, language, json, processedJson: null, updatedAt },
        update: { json, processedJson: null, updatedAt }
      })
      result.imported.push({
        chapterId: chapter.id,
        number: chapter.number,
        review: Array.isArray(body.review) ? body.review.length : 0,
        model: typeof body.model === 'string' ? body.model : null
      })
    } catch (error) {
      result.failed.push({ key, error: errorMessage(error) })
    }
  }
  return result
}
