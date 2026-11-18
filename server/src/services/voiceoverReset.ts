/**
 * Reset voiceover (Narration) — one chapter loses its voiceover in one
 * language, here, in R2 and on the phones, so it can be voiced again from
 * scratch. The script stays.
 *
 * In order:
 *   1. R2 (first, so nothing removed here comes back by itself): the phone's
 *      chapter zip `voiceover/<Series>/<Chapter>[.hi].zip` and its completion
 *      sidecar `….zip.status.json` are deleted, and a reset marker
 *      `….zip.reset.json` is written beside them. Both under our prefix and at
 *      the bucket root, since the phones' prefix may differ (as for fetching).
 *   2. Studio: the language's AudioSection, AudioFile and AudioAnalysis rows,
 *      its audio folder (audio/ or audio_hi/, with the fetch marker) and its
 *      alignment document go; the Editor 2.0 timeline in that language is
 *      emptied, since it was timed to that audio. Everything is moved to
 *      `<Chapter>/.voiceover-resets/<ms>-<lang>/` first (state.json holds the
 *      rows), not deleted. The reset time is remembered: any phone zip uploaded
 *      before it is ignored by Fetch from phone and auto-sync.
 *   3. Phones: each Sleeper-Cell reads the marker the next time it refreshes
 *      voiceover state (before a voiceover run, on the Voiceover screens and on
 *      every sync, all one LIST it already does), and moves its own copy of the
 *      chapter's voiceover aside if it was split before the reset. Open phones
 *      are asked to sync at once.
 *
 * R2 cost: one DeleteObjects and one PUT per folder tried (at most two each),
 * plus the sync request without the relay. Nothing here runs on a timer.
 */
import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { DeleteObjectsCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { createClient, getR2Config, requestPhoneUpdate } from './r2Service.js'
import { VOICEOVER_FOLDER } from './phoneVoiceoverImport.js'
import { pendingAlignments } from './alignment/alignmentService.js'
import { alignmentFileName, audioFolderName, LANGUAGE_NAMES, type NarrationLanguage } from './narrationLanguage.js'
import { requireSeriesRestartReady } from './seriesRestartGuard.js'
import { withSeriesMutation } from './seriesActivity.js'
import { notifySeriesProcessChanged } from './seriesProcess.js'

/** Beside the zip; keep in step with RESET_SUFFIX in SharedVoiceover.kt. */
export const RESET_MARKER_SUFFIX = '.reset.json'
export const RESET_MARKER_SCHEMA = 'studio-voiceover-reset/1'

const resetKey = (chapterId: string, language: NarrationLanguage) => `voiceoverReset:${chapterId}:${language}`

export class VoiceoverResetError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

/** When each chapter's voiceover in `language` was last reset (ms), for those that ever were. */
export async function voiceoverResetAt(chapterIds: string[], language: NarrationLanguage): Promise<Map<string, number>> {
  if (chapterIds.length === 0) return new Map()
  const rows = await prisma.setting.findMany({ where: { key: { in: chapterIds.map(id => resetKey(id, language)) } } })
  const result = new Map<string, number>()
  for (const row of rows) {
    const at = Date.parse(row.value)
    if (!Number.isNaN(at)) result.set(row.key.slice('voiceoverReset:'.length, -`:${language}`.length), at)
  }
  return result
}

/** The chapter's zip key under `root` (the R2 prefix, or '' for the bucket root). */
export function voiceoverZipKey(root: string, seriesFolder: string, chapterFolder: string, language: NarrationLanguage): string {
  return `${root}${VOICEOVER_FOLDER}${seriesFolder}/${chapterFolder}${language === 'hi' ? '.hi' : ''}.zip`
}

export interface VoiceoverResetResult {
  chapterId: string
  number: number
  language: NarrationLanguage
  resetAt: string
  /** Where Studio's copy went; null when the chapter had nothing here. */
  backupPath: string | null
  /** R2 folders cleared and marked; null when R2 isn't set up (phones then keep their copies). */
  r2: { folders: string[] } | null
  /** Whether open phones were asked to sync now (the rest pick the reset up later by themselves). */
  phonesAsked: boolean
}

const exists = (file: string) => fs.stat(file).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e })

/** R2 first: the zip and sidecar go, the marker is written. Throws before anything here changes. */
async function resetInR2(seriesFolder: string, chapterFolder: string, language: NarrationLanguage, marker: object): Promise<{ folders: string[] } | null> {
  const config = getR2Config()
  if (!config) return null
  const client = createClient(config)
  const roots = [...new Set([config.prefix, ''])]
  const body = JSON.stringify(marker, null, 2) + '\n'
  for (const root of roots) {
    const zip = voiceoverZipKey(root, seriesFolder, chapterFolder, language)
    const result = await client.send(new DeleteObjectsCommand({
      Bucket: config.bucket,
      Delete: { Objects: [{ Key: zip }, { Key: `${zip}.status.json` }], Quiet: true }
    }))
    const failed = result.Errors?.find(e => e.Code !== 'NoSuchKey')
    if (failed) throw new VoiceoverResetError(`R2 refused to delete ${failed.Key}: ${failed.Message ?? failed.Code}`, 502)
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: `${zip}${RESET_MARKER_SUFFIX}`, Body: body, ContentType: 'application/json' }))
  }
  return { folders: roots.map(root => `${root}${VOICEOVER_FOLDER}${seriesFolder}/`) }
}

/**
 * Resets the chapter's voiceover in `language`. The caller keeps phone
 * fetches, alignment runs and script replacement off the chapter meanwhile.
 */
export async function resetChapterVoiceover(chapterId: string, language: NarrationLanguage): Promise<VoiceoverResetResult> {
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    select: { id: true, number: true, folderPath: true, completedAt: true, series: { select: { rootFolder: true } } }
  })
  if (!chapter) throw new VoiceoverResetError('Chapter not found', 404)
  if (chapter.completedAt) throw new VoiceoverResetError(`Chapter ${chapter.number} is completed; its files are already gone`, 409)
  if (pendingAlignments(chapterId, language) > 0) throw new VoiceoverResetError(`Wait for chapter ${chapter.number}'s alignment to finish`, 409)

  const root = path.resolve(process.env.DOWNLOAD_ROOT || './downloads')
  const dir = path.resolve(root, chapter.folderPath)
  if (!dir.startsWith(root + path.sep)) throw new VoiceoverResetError('Invalid chapter folder')
  const seriesFolder = path.basename(chapter.series.rootFolder)
  const chapterFolder = path.basename(chapter.folderPath)

  await requireSeriesRestartReady(seriesFolder)
  const result = await withSeriesMutation(seriesFolder, async (): Promise<Omit<VoiceoverResetResult, 'phonesAsked'>> => {
    const resetAt = new Date()
    const marker = {
      schema: RESET_MARKER_SCHEMA,
      id: randomUUID(),
      series: seriesFolder,
      chapter: chapterFolder,
      language,
      resetAt: resetAt.toISOString()
    }
    const r2 = await resetInR2(seriesFolder, chapterFolder, language, marker)

    const where = { chapterId, language }
    const [sections, audioFiles, analyses, timeline] = await Promise.all([
      prisma.audioSection.findMany({ where }),
      prisma.audioFile.findMany({ where }),
      prisma.audioAnalysis.findMany({ where }),
      prisma.editor2Timeline.findUnique({ where: { chapterId_language: { chapterId, language } } })
    ])
    const paths = [audioFolderName(language), alignmentFileName(language)].map(name => path.join(dir, name))
    const present = await Promise.all(paths.map(exists))
    const hasTimeline = !!timeline?.json.trim() || !!timeline?.processedJson
    const anything = sections.length > 0 || audioFiles.length > 0 || analyses.length > 0 || hasTimeline || present.some(Boolean)

    let backupPath: string | null = null
    if (anything) {
      backupPath = path.join(dir, '.voiceover-resets', `${resetAt.getTime()}-${language}`)
      await fs.mkdir(backupPath, { recursive: true })
      await fs.writeFile(path.join(backupPath, 'state.json'),
        JSON.stringify({ resetAt: marker.resetAt, language, sections, audioFiles, analyses, timeline }, null, 2))
    }

    const moved: [string, string][] = []
    try {
      await prisma.$transaction(async tx => {
        await tx.audioFile.deleteMany({ where })
        await tx.audioSection.deleteMany({ where })
        await tx.audioAnalysis.deleteMany({ where })
        if (timeline && hasTimeline) {
          // Emptied rather than deleted, newest write, so other browsers drop their copy too.
          const updatedAt = new Date(Math.max(Date.now(), timeline.updatedAt.getTime() + 1))
          await tx.editor2Timeline.update({ where: { chapterId_language: { chapterId, language } }, data: { json: '', processedJson: null, updatedAt } })
        }
        await tx.setting.upsert({ where: { key: resetKey(chapterId, language) },
          update: { value: marker.resetAt }, create: { key: resetKey(chapterId, language), value: marker.resetAt } })
        // Moved, not copied: a chapter's WAVs can be hundreds of MB.
        for (const [i, file] of paths.entries()) {
          if (!present[i] || !backupPath) continue
          const target = path.join(backupPath, path.basename(file))
          await fs.rename(file, target)
          moved.push([file, target])
        }
      }, { timeout: 30_000 })
    } catch (error) {
      for (const [file, target] of moved.reverse()) await fs.rename(target, file).catch(() => {})
      throw error
    }
    return { chapterId, number: chapter.number, language, resetAt: marker.resetAt, backupPath, r2 }
  })
  notifySeriesProcessChanged(true)

  // Phones with the app open apply it now; the others before their next voiceover run.
  let phonesAsked = false
  if (result.r2) {
    try {
      await requestPhoneUpdate('sync')
      phonesAsked = true
    } catch (error) {
      console.warn(`[voiceover-reset] asking the phones to sync failed (${LANGUAGE_NAMES[language]} ch ${chapter.number}):`, error)
    }
  }
  return { ...result, phonesAsked }
}
