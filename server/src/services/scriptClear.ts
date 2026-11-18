/**
 * Clear scripts (Narration) — Studio's side of Sleeper-Cell's "Clear scripts
 * only": chosen chapters lose their English and Hinglish scripts and what was
 * made from them, so the phones' regenerated scripts come in as new.
 *
 * Per chapter, both languages:
 *   - removed: script.md / script.hi.md, script.review.json, audio/ and
 *     audio_hi/, script-timeline(.hi).md, the replacement markers, the
 *     ChapterScript, AudioSection, AudioFile and AudioAnalysis rows; the Editor
 *     2.0 timeline is emptied (as after a replaced script);
 *   - kept: pages, crops and Metadata, and everything removed, copied first to
 *     .script-replacements/<ms>-clear-<id>/ (state.json holds the rows);
 *   - remembered: the time of the clear. Any phone script or voiceover saved
 *     before it is ignored from then on (a phone that still has the old copy in
 *     R2, an old series zip), so nothing cleared comes back by itself; anything
 *     a phone saves afterwards imports as usual.
 *
 * R2 is not touched: the phones clear their own copies with "Clear scripts only".
 */
import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { prisma } from '../index.js'
import { alignmentFileName, audioFolderName, NARRATION_LANGUAGES, scriptFileName } from './narrationLanguage.js'
import { pendingAlignments } from './alignment/alignmentService.js'
import { requireSeriesRestartReady } from './seriesRestartGuard.js'
import { withSeriesMutation } from './seriesActivity.js'
import { claimScriptChapters, ScriptReplacementError } from './scriptReplacement.js'
import { notifySeriesProcessChanged } from './seriesProcess.js'

const clearedKey = (chapterId: string) => `narrationScriptsCleared:${chapterId}`
const keepKeys = (chapterId: string) => NARRATION_LANGUAGES.map(language => `phoneScriptKeep:${chapterId}:${language}`)

/** When each of these chapters' scripts were last cleared in Studio (ms), for the ones that ever were. */
export async function scriptsClearedAt(chapterIds: string[]): Promise<Map<string, number>> {
  if (chapterIds.length === 0) return new Map()
  const rows = await prisma.setting.findMany({ where: { key: { in: chapterIds.map(clearedKey) } } })
  const result = new Map<string, number>()
  for (const row of rows) {
    const at = Date.parse(row.value)
    if (!Number.isNaN(at)) result.set(row.key.slice(clearedKey('').length), at)
  }
  return result
}

/** Whether a phone file saved at `savedAt` predates the chapter's clear (an unknown time counts as before). */
export function savedBeforeClear(clearedAt: number | undefined, savedAt: string | null | undefined): boolean {
  if (clearedAt === undefined) return false
  const at = savedAt ? Date.parse(savedAt) : NaN
  return Number.isNaN(at) || at <= clearedAt
}

export interface ScriptClearResult {
  cleared: { chapterId: string; number: number; backupPath: string }[]
}

const exists = (file: string) => fs.stat(file).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e })

/**
 * Clears `chapterIds` (all of this series, downloaded and not in a completed
 * Part). Chapters are done one by one; one that fails stops the rest, and is
 * put back as it was.
 */
export async function clearChapterScripts(seriesId: string, chapterIds: string[]): Promise<ScriptClearResult> {
  const ids = [...new Set(chapterIds.filter((id): id is string => typeof id === 'string'))]
  if (ids.length === 0) throw new ScriptReplacementError('Tick at least one chapter')
  const series = await prisma.series.findUnique({ where: { id: seriesId }, select: { rootFolder: true } })
  if (!series) throw new ScriptReplacementError('Series not found', 404)
  const chapters = await prisma.chapter.findMany({ where: { id: { in: ids }, seriesId }, orderBy: { number: 'asc' } })
  if (chapters.length !== ids.length) throw new ScriptReplacementError('A chapter is not in this series', 404)
  const done = chapters.find(c => c.completedAt || c.status !== 'done')
  if (done) throw new ScriptReplacementError(`Chapter ${done.number} is not a downloaded, unarchived chapter`, 409)
  const aligning = chapters.find(c => NARRATION_LANGUAGES.some(language => pendingAlignments(c.id, language) > 0))
  if (aligning) throw new ScriptReplacementError(`Wait for chapter ${aligning.number}'s alignment to finish`, 409)

  const folder = path.basename(series.rootFolder)
  await requireSeriesRestartReady(folder)
  const root = path.resolve(process.env.DOWNLOAD_ROOT || './downloads')
  const release = claimScriptChapters(ids)
  try {
    return await withSeriesMutation(folder, async () => {
      const result: ScriptClearResult = { cleared: [] }
      for (const chapter of chapters) {
        const dir = path.resolve(root, chapter.folderPath)
        if (!dir.startsWith(root + path.sep)) throw new ScriptReplacementError('Invalid chapter folder')
        const clearedAt = new Date()
        const backupPath = path.join(dir, '.script-replacements', `${clearedAt.getTime()}-clear-${randomUUID()}`)
        await fs.mkdir(backupPath, { recursive: true })

        const [scripts, sections, audioFiles, analyses, timelines] = await Promise.all([
          prisma.chapterScript.findMany({ where: { chapterId: chapter.id } }),
          prisma.audioSection.findMany({ where: { chapterId: chapter.id } }),
          prisma.audioFile.findMany({ where: { chapterId: chapter.id } }),
          prisma.audioAnalysis.findMany({ where: { chapterId: chapter.id } }),
          prisma.editor2Timeline.findMany({ where: { chapterId: chapter.id } })
        ])
        await fs.writeFile(path.join(backupPath, 'state.json'),
          JSON.stringify({ clearedAt: clearedAt.toISOString(), scripts, sections, audioFiles, analyses, timelines }, null, 2))

        const paths = [
          ...NARRATION_LANGUAGES.flatMap(language => [scriptFileName(language), audioFolderName(language), alignmentFileName(language),
            `.script-replacement${language === 'hi' ? '.hi' : ''}.json`]),
          'script.review.json'
        ].map(name => path.join(dir, name))
        const present = await Promise.all(paths.map(exists))
        for (const [i, file] of paths.entries()) if (present[i]) await fs.cp(file, path.join(backupPath, path.basename(file)), { recursive: true })

        try {
          await prisma.$transaction(async tx => {
            await tx.audioFile.deleteMany({ where: { chapterId: chapter.id } })
            await tx.audioSection.deleteMany({ where: { chapterId: chapter.id } })
            await tx.audioAnalysis.deleteMany({ where: { chapterId: chapter.id } })
            await tx.chapterScript.deleteMany({ where: { chapterId: chapter.id } })
            for (const timeline of timelines) {
              // Emptied rather than deleted, newest write, so other browsers drop their copy too.
              const updatedAt = new Date(Math.max(Date.now(), timeline.updatedAt.getTime() + 1))
              await tx.editor2Timeline.update({ where: { chapterId_language: { chapterId: chapter.id, language: timeline.language } },
                data: { json: '', processedJson: null, updatedAt } })
            }
            await tx.setting.deleteMany({ where: { key: { in: keepKeys(chapter.id) } } })
            await tx.setting.upsert({ where: { key: clearedKey(chapter.id) },
              update: { value: clearedAt.toISOString() }, create: { key: clearedKey(chapter.id), value: clearedAt.toISOString() } })
            for (const [i, file] of paths.entries()) if (present[i]) await fs.rm(file, { recursive: true, force: true })
          }, { timeout: 30_000 })
        } catch (error) {
          for (const [i, file] of paths.entries()) {
            if (!present[i]) continue
            await fs.rm(file, { recursive: true, force: true })
            await fs.cp(path.join(backupPath, path.basename(file)), file, { recursive: true })
          }
          throw error
        }
        result.cleared.push({ chapterId: chapter.id, number: chapter.number, backupPath })
      }
      if (result.cleared.length > 0) notifySeriesProcessChanged(true)
      return result
    })
  } finally {
    release()
  }
}
