import { retainedMetadataApproval } from './retainedMetadata.js'
import { editorTimelineResetRevision } from './editorTimelineReset.js'
import { editorFinalCrops } from './editorFinalCrops.js'
import {readManagedChapterAssets,assertManagedChapterRevision} from './managedChapterAssets.js'
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
 *   <phone prefix>editor/<Series>/<Chapter>.timeline.json    phone ⇄ this
 *
 * A chapter goes up by itself once it's ready for its timeline JSON
 * (voiceover, alignment, reviewed crops cut), including refreshed packages
 * for chapters with saved timelines: see
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
 * editorAutoPublish.ts queues saved Studio edits, retries failed uploads and
 * recovers unsent edits at startup. Phones receive changes through their
 * existing sync request handling; offline phones catch up when reconnected.
 */

import { createHash } from 'crypto'
import { chapterStoryLinksCurrent } from './seriesRestartFiles.js'
import { requireSeriesRestartReady } from './seriesRestartGuard.js'
import fs from 'fs/promises'
import path from 'path'
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { createClient, getR2Config, phoneFolders, requestPhoneUpdate, type R2Config } from './r2Service.js'
import { getChapterBlockers, getChapterCropMetadataBundle, getChapterTimelineBundle } from './videoEditor2Service.js'
import { getOutputDir, getSourceFolderPath } from './clipper3/perImageStore.js'
import { readEffectiveReview } from './clipper3/chapterReview.js'
import { audioFolderName, NARRATION_LANGUAGES, type NarrationLanguage } from './narrationLanguage.js'
import { getPublishedChapters } from './storageService.js'
import { buildEditorWorkflow } from './editorWorkflow.js'
import { validateDeliveredWorkflowTimeline } from './editorTimelineImport.js'

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
export function languageSuffix(language: NarrationLanguage): string {
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

/** The existing desktop setting is retained when a browser has no local prompt cache. */
export async function getEditorPrompt(): Promise<{ content: string }> {
  const setting = await prisma.setting.findUnique({ where: { key: 'editor2Prompt' } })
  return { content: setting?.value.trim() ?? '' }
}

/**
 * Puts the Editor 2.0 prompt where the phone fetches it, replacing the last
 * one. With `notify`, the phone is asked to check R2 straight away, so it has
 * the prompt before its next run. Returns whether it was asked.
 */
export async function saveEditorPrompt(content: string, notify = true): Promise<{ phoneNotified: boolean }> {
  if (!content.trim()) throw new Error('The prompt is empty')
  // Saving on this Mac does not depend on the phone or R2 being available.
  await prisma.setting.upsert({ where: { key: 'editor2Prompt' },
    create: { key: 'editor2Prompt', value: content.trim() }, update: { value: content.trim() } })
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

/** `sha256` binds timeline inputs; `deliverySha256` also tracks final crop provenance, excluding send time. */
interface BuiltPackage { name: string; body: string; sha256: string; deliverySha256: string }

/** Matches EditorPackage.sha256 on the phone. */
function timelinePackageSha256(timeline: string, metadata: string, scriptSha256: string | null, workflowHash?: string, resetRevision?: string | null): string {
  return createHash('sha256').update(`${timeline}\u0000${metadata}${scriptSha256 ? `\u0000${scriptSha256}` : ''}${workflowHash ? `\u0000${workflowHash}` : ''}${resetRevision ? `\u0000editor-reset:${resetRevision}` : ''}`).digest('hex')
}

async function voicedScriptSha256(folderPath: string, language: NarrationLanguage): Promise<string | null> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(getSourceFolderPath(folderPath), audioFolderName(language), '.r2-voiceover.json'), 'utf-8'))
    return typeof marker.scriptSha256 === 'string' && /^[a-f0-9]{64}$/.test(marker.scriptSha256) ? marker.scriptSha256 : null
  } catch { return null }
}

/**
 * Builds `chapter`'s package in `language`, or says why it can't: a chapter
 * without a script with timeline or crop metadata has nothing to make one from.
 */
async function buildPackage(
  seriesFolder: string,
  chapter: PackageChapter,
  language: NarrationLanguage,
  workflowMode: 'legacy' | 'staged' = 'legacy'
): Promise<BuiltPackage | { skip: string }> {
  const restartRevision = await requireSeriesRestartReady(seriesFolder)
  const managed=await readManagedChapterAssets(chapter.folderPath)
  const [timeline, metadata] = await Promise.all([
    getChapterTimelineBundle(chapter.id, language),
    getChapterCropMetadataBundle(chapter.id)
  ])
  if (!timeline?.text) return { skip: 'no script with timeline' }
  if (!metadata?.text) return { skip: 'no crop metadata' }
  const retained = await retainedMetadataApproval(chapter, restartRevision, metadata.text)
  if (restartRevision && !retained && !await chapterStoryLinksCurrent(process.env.DOWNLOAD_ROOT || './downloads', chapter.folderPath))
    return { skip: 'link crop metadata to the current English script first' }

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
    images = managed ? managed.assets.map(file=>file.filename) : (await fs.readdir(getOutputDir(chapter.folderPath))).filter(n => IMAGE_EXT.test(n)).sort()
  } catch {
    // No crops3 folder: the phone then can't check image names, only the rest.
  }

  await assertManagedChapterRevision(chapter.folderPath,managed?.revision??null)
  const chapterFolder = path.basename(chapter.folderPath)
  // This hash belongs to the script the fetched audio was actually voiced from,
  // rather than a Markdown file that may have been edited since that recording.
  const scriptSha256 = await voicedScriptSha256(chapter.folderPath, language)
  const resetRevision = await editorTimelineResetRevision(prisma.setting, chapter.id, language)
  const content = {
    ...(resetRevision ? { timelineResetRevision: resetRevision } : {}),
    schema: workflowMode === 'staged' ? 'manhwa-studio-editor-package/3' : PACKAGE_SCHEMA,
    series: seriesFolder,
    ...(restartRevision ? { restartRevision } : {}),
    chapter: chapterFolder,
    chapterId: chapter.id,
    number: chapter.number,
    title: chapter.title,
    language,
    scriptSha256,
    sections,
    images,
    timeline: timeline.text,
    metadata: metadata.text,
    ...(workflowMode === 'staged' ? { workflow: buildEditorWorkflow(timeline.text, metadata.text, images, scriptSha256, sections) } : {})
  }
  const finalCropAuthority = await editorFinalCrops(chapter, language, metadata.text, images)
  const delivery = { ...content, finalCropAuthority: { ...finalCropAuthority, ...(retained ? {retainedStoryLinks: retained} : {}) } }
  return {
    name: `${seriesFolder}/${chapterFolder}${languageSuffix(language)}${PACKAGE_SUFFIX}`,
    body: JSON.stringify({ ...delivery, sentAt: new Date().toISOString() }),
    sha256: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
    deliverySha256: createHash('sha256').update(JSON.stringify(delivery)).digest('hex')
  }
}

/**
 * The chapter's Editor package as the phone would get it (AntiGravity → Timeline makes its one-shot
 * prompt and checks from it), or why there is none yet. Nothing is sent.
 */
export async function buildEditorPackage(chapterId: string, language: NarrationLanguage, workflowMode: 'legacy' | 'staged' = 'legacy') {
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    select: { id: true, number: true, title: true, folderPath: true, series: { select: { rootFolder: true } } }
  })
  if (!chapter) throw new Error('Chapter not found')
  const built = await buildPackage(path.basename(chapter.series.rootFolder), chapter, language, workflowMode)
  return 'skip' in built ? built : { sha256: built.sha256, content: JSON.parse(built.body) as Record<string, unknown> }
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
type SentRecord = Partial<Record<NarrationLanguage, { sha256: string; deliverySha256?: string; sentAt: string; workflow?: 'legacy' | 'staged' }>>

async function readSentRecord(folderPath: string): Promise<SentRecord> {
  try {
    return JSON.parse(await fs.readFile(path.join(getSourceFolderPath(folderPath), SENT_RECORD), 'utf-8')) ?? {}
  } catch {
    return {}
  }
}

async function recordSent(folderPath: string, language: NarrationLanguage, pkg: BuiltPackage, workflow: 'legacy' | 'staged' = 'legacy'): Promise<void> {
  try {
    const record = await readSentRecord(folderPath)
    record[language] = { sha256: pkg.sha256, deliverySha256: pkg.deliverySha256, sentAt: new Date().toISOString(), workflow }
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
  prompt: string,
  workflowMode: 'legacy' | 'staged' = 'legacy'
): Promise<EditorSendResult> {
  if (!prompt.trim() && workflowMode === 'legacy') throw new Error('Save the Editor 2.0 prompt in Settings → Editor 2.0 first: the phone pastes it with each chapter.')
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

  if (workflowMode === 'legacy') await saveEditorPrompt(prompt, false)
  const client = createClient(config)
  const folders = await phoneFolders(client, config)
  const seriesFolder = path.basename(series.rootFolder)
  const result: EditorSendResult = { sent: [], skipped: [], phoneNotified: false }
  const pending: { folderPath: string; pkg: BuiltPackage }[] = []

  for (const chapter of series.chapters) {
    const skip = (reason: string) => result.skipped.push({ chapterId: chapter.id, number: chapter.number, reason })
    try {
      const pkg = await buildPackage(seriesFolder, chapter, language, workflowMode)
      if ('skip' in pkg) { skip(pkg.skip); continue }
      await putPackage(client, config, folders, pkg)
      pending.push({ folderPath: chapter.folderPath, pkg })
      result.sent.push({ chapterId: chapter.id, number: chapter.number })
    } catch (error) {
      skip(errorMessage(error))
    }
  }

  if (result.sent.length > 0) {
    result.phoneNotified = await nudgePhone()
    if (result.phoneNotified) for (const item of pending) await recordSent(item.folderPath, language, item.pkg, workflowMode)
  }
  return result
}

// ============ Automatic send ============

export interface EditorPublishResult {
  sent: { chapterId: string; number: number; language: NarrationLanguage }[]
  failed: { chapterId: string; language: NarrationLanguage; error: string; retryable?: boolean }[]
}

/**
 * Sends every ready, reviewed chapter's current package straight to the
 * phone: voiceover audio, alignment and reviewed crops cut to crops3/.
 * Saved timelines remain intact; a provenance-only refresh keeps their input
 * hashes unchanged. Changed inputs still invalidate old phone timelines.
 * Each language goes on its own, as Send to phone does from its tab. A
 * package already up with the same content is left alone, unless it's no
 * longer in R2. `chapterIds` narrows it to those chapters; null checks all.
 *
 * Run from editorAutoPublish.ts after review, alignment or a cut, and at startup.
 * R2 cost: one LIST per phone folder when there's something to check, one PUT
 * per changed package, and one nudge when anything went up.
 */
export async function publishReadyEditorPackages(chapterIds: string[] | null): Promise<EditorPublishResult> {
  const result: EditorPublishResult = { sent: [], failed: [] }
  const config = getR2Config()
  if (!config) return result
  let r2: { client: S3Client; folders: string[]; keys: Set<string> } | null = null
  const pending: { chapter: { id: string; number: number; folderPath: string }; language: NarrationLanguage; pkg: BuiltPackage; workflow: 'legacy' | 'staged' }[] = []

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
    for (const chapter of chapters) {
      try {
        const blockers = await getChapterBlockers(chapter.id, language)
        if (blockers === null || blockers.length > 0) continue
        if (!(await readEffectiveReview(chapter.folderPath)).reviewed) continue
        const previous = (await readSentRecord(chapter.folderPath))[language]
        const workflow = previous?.workflow === 'staged' ? 'staged' : 'legacy'
        const pkg = await buildPackage(path.basename(chapter.series.rootFolder), chapter, language, workflow)
        if ('skip' in pkg) {
          result.failed.push({ chapterId: chapter.id, language, error: pkg.skip })
          continue
        }

        if (!r2) {
          const client = createClient(config)
          const folders = await phoneFolders(client, config)
          r2 = { client, folders, keys: await listEditorKeys(client, config, folders) }
        }
        const { client, folders, keys } = r2
        const upEverywhere = folders.every(folder => keys.has(`${folder}${EDITOR_FOLDER}${pkg.name}`))
        if (upEverywhere && previous?.deliverySha256 === pkg.deliverySha256) continue

        await putPackage(client, config, folders, pkg)
        pending.push({ chapter, language, pkg, workflow })
      } catch (error) {
        result.failed.push({ chapterId: chapter.id, language, error: errorMessage(error) })
      }
    }
  }

  if (pending.length > 0) {
    const notified = await nudgePhone()
    for (const { chapter, language, pkg, workflow } of pending) {
      if (!notified) {
        // No delivery receipt: the publication queue retries even though the PUT succeeded.
        result.failed.push({ chapterId: chapter.id, language, error: 'Could not request device sync' })
        continue
      }
      await recordSent(chapter.folderPath, language, pkg, workflow)
      result.sent.push({ chapterId: chapter.id, number: chapter.number, language })
    }
  }
  return result
}

/** Every key under the phone folders' editor/, to tell a package that's gone from one that's up. */
export async function listEditorKeys(client: S3Client, config: R2Config, folders: string[]): Promise<Set<string>> {
  const keys = new Set<string>()
  for (const folder of folders) {
    let token: string | undefined
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: `${folder}${EDITOR_FOLDER}`, ContinuationToken: token }))
      for (const object of page.Contents ?? []) if (object.Key && object.Size !== 0) keys.add(object.Key)
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
        if (object.Size === 0) continue
        const name = object.Key?.slice(base.length) ?? ''
        if (name && !name.includes('/')) names.add(name)
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
  }
  const stored = await prisma.editor2Timeline.findMany({
      where: { chapterId: { in: series.chapters.map(c => c.id) }, language },
      select: { chapterId: true, json: true }
    })
  const withJson = new Set(stored.filter(r => r.json.trim()).map(r => r.chapterId))
  const cleared = new Set(stored.filter(r => !r.json.trim()).map(r => r.chapterId))

  const waiting: string[] = []
  let sent = 0
  for (const chapter of series.chapters) {
    const folder = path.basename(chapter.folderPath)
    if (!names.has(`${folder}${suffix}${PACKAGE_SUFFIX}`)) continue
    sent++
    if (withJson.has(chapter.id) || (!cleared.has(chapter.id) && names.has(`${folder}${suffix}${TIMELINE_SUFFIX}`))) continue
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
  staged?: boolean
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
  const cleared = new Set(timelines.filter(r => !r.json.trim()).map(r => r.chapterId))

  const result: EditorReadiness = { prompt: everywhere(PROMPT_NAME), made: 0, up: [], toSend: [], notReady: [] }
  for (const chapter of series.chapters) {
    if (published.chapters[chapter.id] && !cleared.has(chapter.id)) continue
    const ref = { chapterId: chapter.id, number: chapter.number }
    const name = `${seriesFolder}/${path.basename(chapter.folderPath)}${suffix}`
    if (withJson.has(chapter.id) || (!cleared.has(chapter.id) && anywhere(`${name}${TIMELINE_SUFFIX}`))) { result.made++; continue }
    if (everywhere(`${name}${PACKAGE_SUFFIX}`)) { result.up.push(ref); continue }
    // No voiceover yet: the checklist would only say the same, at a cost.
    if (chapter._count.audioSections === 0) { result.notReady.push({ ...ref, missing: ['voiceover'] }); continue }
    const missing = [...((await getChapterBlockers(chapter.id, language)) ?? [])]
    if (!(await readEffectiveReview(chapter.folderPath)).reviewed) missing.push('crop review')
    try {
      const revision = await requireSeriesRestartReady(seriesFolder)
      const metadata = await getChapterCropMetadataBundle(chapter.id)
      const retained = metadata?.text ? await retainedMetadataApproval(chapter, revision, metadata.text) : null
      if (revision && !retained && !await chapterStoryLinksCurrent(process.env.DOWNLOAD_ROOT || './downloads', chapter.folderPath))
        missing.push('current English script-to-crop links (Sync json)')
    } catch (error) { missing.push(errorMessage(error)) }
    if (missing.length) result.notReady.push({ ...ref, missing })
    else result.toSend.push(ref)
  }
  const pending = new Set([...result.up, ...result.toSend].map(c => c.chapterId))
  const modes = await Promise.all(series.chapters.filter(c => pending.has(c.id)).map(async c => (await readSentRecord(c.folderPath))[language]?.workflow))
  if (modes.length && modes.every(mode => mode === 'staged')) { result.prompt = true; result.staged = true }
  return result
}

// ============ Fetch ============

export interface EditorFetchResult {
  configured: boolean
  /** Timelines found for this series in this language. */
  found: number
  imported: { chapterId: string; number: number; review: number; model: string | null }[]
  upToDate: number
  /** Chapters whose timeline here was kept: newer than the phone's, or made in Studio (a paste, an edit or AntiGravity). */
  kept: { chapterId: string; number: number }[]
  /** Chapters a Studio AntiGravity Timeline job is making right now; the phone's timeline is not taken. */
  inProgress: { chapterId: string; number: number }[]
  unmatched: string[]
  failed: { key: string; error: string }[]
}

interface ListedTimeline { key: string; chapterFolder: string; modifiedAt: number }

/** The phone writes under its own prefix, which may not match ours, so every place it may be is tried. */
async function listTimelines(
  client: S3Client,
  config: R2Config,
  seriesFolder: string,
  language: NarrationLanguage
): Promise<ListedTimeline[]> {
  const folders = [...new Set([...(await phoneFolders(client, config)), config.prefix, ''])]
  const suffix = `${languageSuffix(language)}${TIMELINE_SUFFIX}`
  const byChapter = new Map<string, ListedTimeline>()
  for (const folder of folders) {
    const base = `${folder}${EDITOR_FOLDER}${seriesFolder}/`
    let token: string | undefined
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: base, ContinuationToken: token }))
      for (const object of page.Contents ?? []) {
        if (object.Size === 0) continue
        const name = object.Key?.slice(base.length) ?? ''
        if (!object.Key || name.includes('/') || !name.endsWith(suffix)) continue
        const chapterFolder = name.slice(0, -suffix.length)
        // An English listing must not take a Hinglish file for a chapter named "… .hi".
        if (language === 'en' && chapterFolder.endsWith('.hi')) continue
        if (chapterFolder) {
          const candidate = { key: object.Key, chapterFolder, modifiedAt: object.LastModified?.getTime() ?? 0 }
          const previous = byChapter.get(chapterFolder)
          // A phone can change prefixes; an old copy must not hide its latest upload.
          if (!previous || candidate.modifiedAt > previous.modifiedAt) byChapter.set(chapterFolder, candidate)
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
  }
  return [...byChapter.values()]
}

/**
 * Stores every timeline the phone made for this series in `language` as its
 * chapter's Editor 2.0 paste, unprocessed. A chapter already holding the same
 * JSON is left as it is, and one whose paste changed after the phone made its
 * timeline keeps its paste.
 */
export async function fetchPhoneTimelines(seriesId: string, language: NarrationLanguage): Promise<EditorFetchResult> {
  const result: EditorFetchResult = { configured: false, found: 0, imported: [], upToDate: 0, kept: [], inProgress: [], unmatched: [], failed: [] }
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
  // Chapters a Timeline job is making now (dynamic import: editorClaims imports this module).
  const claims = listed.length ? await (await import('./editorClaims.js')).activeEditorClaims() : []

  for (const { key, chapterFolder } of listed) {
    const chapter = byFolder.get(chapterFolder)
    if (!chapter) {
      result.unmatched.push(chapterFolder)
      continue
    }
    try {
      const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
      const body = JSON.parse(await object.Body!.transformToString('utf-8'))
      await requireSeriesRestartReady(path.basename(series.rootFolder), body.restartRevision, true)
      if (typeof body?.schema !== 'string' || !TIMELINE_SCHEMA.test(body.schema)) throw new Error('not a Sleeper-Cell timeline')
      if ((body.language ?? 'en') !== language) throw new Error(`made for language "${body.language}"`)
      const json = typeof body.timeline === 'string' ? body.timeline.trim() : ''
      if (!json) throw new Error('the timeline is empty')
      const madeAt = Date.parse(body.madeAt) || 0
      const model = typeof body.model === 'string' ? body.model.trim() || null : null

      const where = { chapterId_language: { chapterId: chapter.id, language } }
      const existing = await prisma.editor2Timeline.findUnique({ where })
      // Already holding this exact JSON: nothing to import, so the staged/reset
      // checks below (meant for new timelines) must not report it as a failure.
      // An invalidated row is empty, so it never matches here.
      if (existing && existing.json.trim() && existing.json.trim() === json) {
        // Backfill attribution for timelines imported before it was retained.
        if (model && !existing.model) {
          await prisma.editor2Timeline.upsert({
            where,
            create: { chapterId: chapter.id, language, json, model, processedJson: null, updatedAt: new Date() },
            update: { model }
          })
        }
        result.upToDate++
        continue
      }
      // Studio's own work wins: never take a phone timeline while AntiGravity is making the chapter, nor over a
      // timeline made here (a paste, an edit or AntiGravity). Clearing the chapter here lets a phone's in again.
      if (claims.some(c => c.chapterId === chapter.id && c.language === language)) {
        result.inProgress.push({ chapterId: chapter.id, number: chapter.number })
        continue
      }
      if (existing?.json.trim() && await madeInStudio(chapter.id, language, existing.json)) {
        result.kept.push({ chapterId: chapter.id, number: chapter.number })
        continue
      }
      const resetRevision = await editorTimelineResetRevision(prisma.setting, chapter.id, language)
      if (resetRevision && body.timelineResetRevision !== resetRevision) throw new Error('timeline is from before the Studio reset; make it again from the refreshed Editor package')
      const mode = (await readSentRecord(chapter.folderPath))[language]?.workflow
      let currentWorkflowHash: string | undefined
      if (mode === 'staged' || typeof body.workflowHash === 'string') {
        const current = await buildPackage(path.basename(series.rootFolder), { ...chapter, title: null }, language, 'staged')
        if ('skip' in current) throw new Error(current.skip)
        const pkg = JSON.parse(current.body)
        currentWorkflowHash = pkg.workflow.sourceHash
        if (body.workflowHash !== currentWorkflowHash || body.packageSha256 !== timelinePackageSha256(pkg.timeline, pkg.metadata, pkg.scriptSha256, currentWorkflowHash, resetRevision)) throw new Error('staged timeline inputs or prompts changed; make it again from the current Editor package')
        validateDeliveredWorkflowTimeline(pkg.workflow, json, pkg.sections)
      }
      // A newer empty row is the invalidation left by replacement audio.
      // Never restore an old phone timeline over it, even if R2 still holds one.
      if (resetRevision || (existing && !existing.json.trim())) {
        const [timeline, metadata, scriptSha256] = await Promise.all([
          getChapterTimelineBundle(chapter.id, language), getChapterCropMetadataBundle(chapter.id),
          voicedScriptSha256(chapter.folderPath, language)
        ])
        if (!timeline?.text || !metadata?.text || body.packageSha256 !== timelinePackageSha256(timeline.text, metadata.text, scriptSha256, currentWorkflowHash, resetRevision) || (existing && !existing.json.trim() && madeAt < existing.updatedAt.getTime())) {
          throw new Error(resetRevision ? 'timeline is from before the Studio reset; make it again from the refreshed Editor package' : 'timeline is from before the voiceover replacement; make it again from the new Editor package')
        }
      }
      if (existing && existing.json.trim() && existing.updatedAt.getTime() > madeAt) {
        result.kept.push({ chapterId: chapter.id, number: chapter.number })
        continue
      }
      // Newer than the row, so every browser's cache takes it on its next sync (newest wins).
      const updatedAt = new Date(Math.max(Date.now(), (existing?.updatedAt.getTime() ?? 0) + 1))
      await prisma.editor2Timeline.upsert({
        where,
        create: { chapterId: chapter.id, language, json, model, processedJson: null, updatedAt },
        update: { json, model, processedJson: null, updatedAt }
      })
      result.imported.push({
        chapterId: chapter.id,
        number: chapter.number,
        review: Array.isArray(body.review) ? body.review.length : 0,
        model
      })
    } catch (error) {
      result.failed.push({ key, error: errorMessage(error) })
    }
  }
  return result
}


/** True when this exact timeline was saved in Studio (paste, edit or AntiGravity), not imported from a phone. */
async function madeInStudio(chapterId: string, language: NarrationLanguage, json: string): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: `editor2-phone-timeline-edit:${chapterId}:${language}` } })
  if (!row) return false
  try {
    return (JSON.parse(row.value) as { jsonSha256?: string }).jsonSha256 === createHash('sha256').update(json).digest('hex')
  } catch { return false }
}

class TimelinePublicationConflict extends Error {}

/** Capture the inputs at edit time, so retries cannot rebind an old edit to new audio/crops. */
export async function captureEditorTimelineSource(chapterId: string, language: NarrationLanguage): Promise<string | null> {
  try {
    const chapter = await prisma.chapter.findUnique({ where: { id: chapterId },
      select: { id: true, number: true, title: true, folderPath: true, series: { select: { rootFolder: true } } } })
    if (!chapter) return null
    const mode = (await readSentRecord(chapter.folderPath))[language]?.workflow === 'staged' ? 'staged' : 'legacy'
    const pkg = await buildPackage(path.basename(chapter.series.rootFolder), chapter, language, mode)
    return 'skip' in pkg ? null : pkg.sha256
  } catch { return null }
}

/** Publish saved Studio edits using the existing phone timeline envelope.
 * The durable receipt is written only after the sync request succeeds, so startup
 * and failed-upload retries recover without turning every check into an upload.
 */
export async function publishSavedEditorTimelines(chapterIds: string[] | null): Promise<EditorPublishResult> {
  const result: EditorPublishResult = { sent: [], failed: [] }
  const config = getR2Config()
  if (!config) return result
  const client = createClient(config)
  const folders = [...new Set(await phoneFolders(client, config))].sort()
  const chapters = await prisma.chapter.findMany({
    where: chapterIds ? { id: { in: chapterIds } } : {},
    select: { id: true, number: true, title: true, folderPath: true, series: { select: { rootFolder: true } } }
  })
  const pending: { key: string; value: string; chapterId: string; number: number; language: NarrationLanguage }[] = []
  for (const chapter of chapters) for (const language of NARRATION_LANGUAGES) {
    try {
      const row = await prisma.editor2Timeline.findUnique({ where: { chapterId_language: { chapterId: chapter.id, language } } })
      if (!row?.json.trim()) continue
      const intentRow = await prisma.setting.findUnique({ where: { key: `editor2-phone-timeline-edit:${chapter.id}:${language}` } })
      if (!intentRow) continue // Phone imports and old unsent work are never relabelled as Studio edits.
      const intent = JSON.parse(intentRow.value) as { jsonSha256: string; madeAt: string; sourceSha256: string | null }
      if (intent.jsonSha256 !== createHash('sha256').update(row.json).digest('hex')) continue
      // Invalid drafts must never become completed timelines on devices.
      const parsed = JSON.parse(row.json)
      if (!Array.isArray(parsed?.sections) || parsed.sections.length === 0) throw new TimelinePublicationConflict('timeline must contain sections')
      const workflow = (await readSentRecord(chapter.folderPath))[language]?.workflow === 'staged' ? 'staged' : 'legacy'
      const pkg = await buildPackage(path.basename(chapter.series.rootFolder), chapter, language, workflow)
      if ('skip' in pkg) throw new TimelinePublicationConflict(pkg.skip)
      if (!intent.sourceSha256 || intent.sourceSha256 !== pkg.sha256) throw new TimelinePublicationConflict('Editor inputs changed or were unavailable when saved; review and save the timeline again')
      const content = JSON.parse(pkg.body)
      if (content.workflow) {
        try { validateDeliveredWorkflowTimeline(content.workflow, row.json, content.sections) }
        catch (error) { throw new TimelinePublicationConflict(errorMessage(error)) }
      }
      const body = JSON.stringify({
        schema: 'sleeper-cell-editor-timeline/1',
        series: content.series, chapter: content.chapter, chapterId: chapter.id, language,
        ...(content.restartRevision ? { restartRevision: content.restartRevision } : {}),
        packageSentAt: content.sentAt,
        packageSha256: timelinePackageSha256(content.timeline, content.metadata, content.scriptSha256, content.workflow?.sourceHash, content.timelineResetRevision),
        ...(content.timelineResetRevision ? { timelineResetRevision: content.timelineResetRevision } : {}),
        matchingPolicy: language === 'hi' ? 'hinglish-direct-crops/1' : 'english-script-links/1',
        ...(content.workflow ? { workflowHash: content.workflow.sourceHash } : {}),
        madeAt: intent.madeAt, model: row.model ?? null, profile: null,
        deviceId: 'manhwa-studio', review: [], timeline: row.json
      })
      const key = `editor2-phone-timeline:${chapter.id}:${language}`
      const value = createHash('sha256').update(JSON.stringify({
        intent, package: pkg.sha256,
        bucket: config.bucket, accountId: config.accountId, folders
      })).digest('hex')
      if ((await prisma.setting.findUnique({ where: { key } }))?.value === value) continue
      // Do not overwrite newer work uploaded by a phone while Studio was offline.
      for (const folder of folders) {
        const timelineKey = `${folder}${EDITOR_FOLDER}${content.series}/${content.chapter}${languageSuffix(language)}${TIMELINE_SUFFIX}`
        let remoteText: string | undefined
        try {
          const remote = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: timelineKey }))
          remoteText = await remote.Body?.transformToString('utf-8')
        } catch (error) {
          const missing = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } }
          if (missing.name !== 'NoSuchKey' && missing.message !== 'NoSuchKey' && missing.$metadata?.httpStatusCode !== 404) throw error
        }
        if (remoteText) {
          const remote = JSON.parse(remoteText)
          if ((Date.parse(remote.madeAt) || 0) > Date.parse(intent.madeAt)) throw new TimelinePublicationConflict('A newer device timeline is already published; fetch it before editing again')
        }
      }
      // Send the matching package first; phones validate the timeline against it.
      await putPackage(client, config, folders, pkg)
      for (const folder of folders) await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: `${folder}${EDITOR_FOLDER}${content.series}/${content.chapter}${languageSuffix(language)}${TIMELINE_SUFFIX}`,
        Body: body, ContentType: 'application/json'
      }))
      await recordSent(chapter.folderPath, language, pkg, workflow)
      pending.push({ key, value, chapterId: chapter.id, number: chapter.number, language })
    } catch (error) {
      result.failed.push({ chapterId: chapter.id, language, error: errorMessage(error), retryable: !(error instanceof TimelinePublicationConflict || error instanceof SyntaxError) })
    }
  }
  if (pending.length === 0) return result
  const notified = await nudgePhone()
  for (const item of pending) {
    try {
      if (!notified) throw new Error('Could not request device sync')
      await prisma.setting.upsert({ where: { key: item.key }, create: { key: item.key, value: item.value }, update: { value: item.value } })
      result.sent.push({ chapterId: item.chapterId, number: item.number, language: item.language })
    } catch (error) {
      result.failed.push({ chapterId: item.chapterId, language: item.language, error: errorMessage(error) })
    }
  }
  return result
}

/** A reset is independent of audio/crop readiness. Publish its durable revision
 * even while a replacement package is blocked, and retain it after new results. */
export async function publishEditorTimelineResets(chapterIds: string[] | null): Promise<EditorPublishResult> {
  const result: EditorPublishResult = { sent: [], failed: [] }
  const config = getR2Config()
  if (!config) return result
  const chapters = await prisma.chapter.findMany({
    where: chapterIds ? { id: { in: chapterIds } } : {},
    select: { id: true, number: true, folderPath: true, series: { select: { rootFolder: true } } }
  })
  let r2: { client: S3Client; folders: string[] } | undefined
  const pending: { chapterId: string; number: number; language: NarrationLanguage; key: string; value: string }[] = []
  for (const chapter of chapters) for (const language of NARRATION_LANGUAGES) {
    try {
      const revision = await editorTimelineResetRevision(prisma.setting, chapter.id, language)
      if (!revision) continue
      if (!r2) {
        const client = createClient(config)
        r2 = { client, folders: [...new Set(await phoneFolders(client, config))].sort() }
      }
      const series = path.basename(chapter.series.rootFolder), name = path.basename(chapter.folderPath)
      const restartRevision = await requireSeriesRestartReady(series)
      const key = `editor2-phone-timeline-reset-delivered:${chapter.id}:${language}`
      const value = createHash('sha256').update(JSON.stringify({ revision, restartRevision, bucket: config.bucket, accountId: config.accountId, folders: r2.folders })).digest('hex')
      if ((await prisma.setting.findUnique({ where: { key } }))?.value === value) continue
      const body = JSON.stringify({ schema: 'manhwa-studio-editor-reset/1', series, chapter: name, chapterId: chapter.id, language, revision, ...(restartRevision ? { restartRevision } : {}) })
      for (const folder of r2.folders) await r2.client.send(new PutObjectCommand({
        Bucket: config.bucket, Key: `${folder}${EDITOR_FOLDER}${series}/${name}${languageSuffix(language)}.reset.json`,
        Body: body, ContentType: 'application/json'
      }))
      pending.push({ chapterId: chapter.id, number: chapter.number, language, key, value })
    } catch (error) {
      result.failed.push({ chapterId: chapter.id, language, error: errorMessage(error) })
    }
  }
  if (!pending.length) return result
  const notified = await nudgePhone()
  for (const { chapterId, number, language, key, value } of pending) {
    try {
      if (!notified) throw new Error('Could not request device sync')
      await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
      result.sent.push({ chapterId, number, language })
    } catch (error) { result.failed.push({ chapterId, language, error: errorMessage(error) }) }
  }
  return result
}
