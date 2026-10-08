/**
 * Editor 2.0 ⇄ the Sleeper-Cell phone app, through Cloudflare R2.
 *
 * Making a chapter's timeline JSON is a ChatGPT step: Copy All (the Editor 2.0
 * prompt, the script with timeline and the crop metadata), paste it into
 * ChatGPT, paste the JSON back. The phone automates it in ChatGPT's GPT-6
 * Astra (EditorRun.kt), so this sends it the Copy All text and takes back the
 * JSON:
 *
 *   <phone prefix>editor/<Series>/<Chapter>.package.json     this → phone
 *   <phone prefix>editor/<Series>/<Chapter>.timeline.json    phone → this
 *
 * Hinglish uses `<Chapter>.hi.package.json` and `<Chapter>.hi.timeline.json`.
 * Series and chapter are the folder names, as for the manhwa zips.
 *
 * A package is the exact text copyAll() in EditorChapterList2 puts on the
 * clipboard, plus what the phone checks the reply against: each voice
 * section's audio length, and the crop files in crops3/, which are what the
 * timeline processor resolves image names against. Keep the schemas in step
 * with EditorPackage / EditorLibrary.save in the phone's editor/ folder.
 *
 * Fetching stores each timeline as the chapter's Editor 2.0 paste (the
 * Editor2Timeline row), unprocessed, so the chapter asks for Start Processing
 * as after a paste by hand. A paste made here after the phone made its
 * timeline is kept.
 *
 * R2 cost: a send is one PUT per chapter (Class A) plus the phone's nudge; a
 * fetch is one LIST per folder tried, plus one GET (Class B) per timeline.
 * Nothing here runs on a timer.
 */

import fs from 'fs/promises'
import path from 'path'
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { createClient, getR2Config, phoneFolders, requestPhoneUpdate, type R2Config } from './r2Service.js'
import { getChapterCropMetadataBundle, getChapterTimelineBundle } from './videoEditor2Service.js'
import { getOutputDir } from './clipper3/perImageStore.js'
import type { NarrationLanguage } from './narrationLanguage.js'

/** Inside the phone's prefix. Keep in step with FOLDER in EditorSync.kt. */
export const EDITOR_FOLDER = 'editor/'
const PACKAGE_SUFFIX = '.package.json'
const TIMELINE_SUFFIX = '.timeline.json'
const PACKAGE_SCHEMA = 'manhwa-studio-editor-package/1'
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

// ============ Send ============

export interface EditorSendResult {
  sent: { chapterId: string; number: number }[]
  skipped: { chapterId: string; number: number; reason: string }[]
  /** Whether the phone was asked to check R2 straight away. */
  phoneNotified: boolean
}

/**
 * Sends each of `chapterIds` (in `language`) to the phone as a package,
 * replacing any sent before. `prompt` is the Editor 2.0 prompt, which lives in
 * the browser (Settings → Editor 2.0), so the client passes it. A chapter
 * without a script with timeline or crop metadata is skipped and reported.
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

  const client = createClient(config)
  const folders = await phoneFolders(client, config)
  const seriesFolder = path.basename(series.rootFolder)
  const result: EditorSendResult = { sent: [], skipped: [], phoneNotified: false }

  for (const chapter of series.chapters) {
    const skip = (reason: string) => result.skipped.push({ chapterId: chapter.id, number: chapter.number, reason })
    try {
      const [timeline, metadata] = await Promise.all([
        getChapterTimelineBundle(chapter.id, language),
        getChapterCropMetadataBundle(chapter.id)
      ])
      if (!timeline?.text) { skip('no script with timeline'); continue }
      if (!metadata?.text) { skip('no crop metadata'); continue }

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
      const body = JSON.stringify({
        schema: PACKAGE_SCHEMA,
        series: seriesFolder,
        chapter: chapterFolder,
        chapterId: chapter.id,
        number: chapter.number,
        title: chapter.title,
        language,
        sentAt: new Date().toISOString(),
        sections,
        images,
        text: copyAllText(prompt.trim(), timeline.text, metadata.text)
      })
      for (const folder of folders) {
        await client.send(new PutObjectCommand({
          Bucket: config.bucket,
          Key: `${folder}${EDITOR_FOLDER}${seriesFolder}/${chapterFolder}${languageSuffix(language)}${PACKAGE_SUFFIX}`,
          Body: body,
          ContentType: 'application/json'
        }))
      }
      result.sent.push({ chapterId: chapter.id, number: chapter.number })
    } catch (error) {
      skip(errorMessage(error))
    }
  }

  if (result.sent.length > 0) {
    try {
      await requestPhoneUpdate('sync')
      result.phoneNotified = true
    } catch (error) {
      console.warn('[phoneEditor] could not ask the phone to check R2:', errorMessage(error))
    }
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
