/**
 * What AntiGravity Narration reads and writes in Studio (narrationFlow.NarrationDeps): a chapter's pages and
 * continuity, and the save through Narration's script replacement. Kept apart from narrationFlow.ts so tests can
 * stand in for it without a Studio database.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { narrationWords } from '../narrationRules.js'
import { englishSourceIssues } from '../hinglishRules.js'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { NarrationDeps, NarrationInput, NarrationOutput } from './narrationFlow.js'
import type { HinglishDeps, HinglishInput } from './narrationHinglish.js'

export const IMAGE = /\.(?:jpe?g|png|webp|gif|avif)$/i
const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex')
const readText = (file: string) => fs.readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e })

const root = () => path.resolve(process.env.DOWNLOAD_ROOT || './downloads')

export function chapterDir(folderPath: string) {
  const dir = path.resolve(root(), folderPath)
  if (!dir.startsWith(root() + path.sep)) throw new Error('Invalid chapter folder.')
  return dir
}

/**
 * A downloaded chapter's pages in chapter order (its Page rows first; the folder's images when the rows have no
 * paths), or why it has none. Shared with Gemini MCP narration (services/geminiMcp).
 */
export type ChapterPages =
  | { reason: string }
  | {
    chapter: Prisma.ChapterGetPayload<{ include: { series: true; pages: { select: { localPath: true } } } }>
    dir: string
    pages: { file: string; source: string; size: number; mtime: number }[]
  }

export async function chapterPages(prisma: PrismaClient, chapterId: string): Promise<ChapterPages> {
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    include: { series: true, pages: { where: { status: 'done' }, orderBy: { index: 'asc' }, select: { localPath: true } } }
  })
  if (!chapter) return { reason: 'Chapter not found.' }
  if (chapter.completedAt || chapter.status !== 'done') return { reason: 'Only downloaded chapters of a Part that isn\'t completed can have their script written.' }
  const dir = chapterDir(chapter.folderPath)
  let names = chapter.pages.map(p => p.localPath && path.basename(p.localPath)).filter((p): p is string => !!p && IMAGE.test(p))
  if (!names.length) {
    const files = await fs.readdir(dir).catch(() => [] as string[])
    names = files.filter(f => IMAGE.test(f) && !f.startsWith('.')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  }
  if (!names.length) return { reason: 'This chapter has no downloaded pages.' }
  const pages: { file: string; source: string; size: number; mtime: number }[] = []
  for (const name of names) {
    const stat = await fs.stat(path.join(dir, name)).catch(() => null)
    if (!stat) return { reason: `${name} is missing from the chapter folder.` }
    pages.push({ file: path.join(dir, name), source: name, size: stat.size, mtime: Math.round(stat.mtimeMs) })
  }
  return { chapter, dir, pages }
}

export function narrationStudioDeps(prisma: PrismaClient): NarrationDeps {
  return {
    async input(chapterId): Promise<NarrationInput | { reason: string; wait?: boolean }> {
      const found = await chapterPages(prisma, chapterId)
      if ('reason' in found) return found
      const { chapter, dir, pages } = found
      const previousChapter = await prisma.chapter.findFirst({
        where: { seriesId: chapter.seriesId, number: { lt: chapter.number } },
        orderBy: { number: 'desc' }, include: { scripts: { where: { language: 'en' } } }
      })
      const previousScript = previousChapter?.scripts[0]
      const previous = previousScript?.rollingSummary?.trim() && previousScript.closingParagraph?.trim()
        ? { summary: previousScript.rollingSummary.trim(), closing: previousScript.closingParagraph.trim() } : null
      if (previousChapter && !previous) {
        return { reason: `Chapter ${previousChapter.number} needs its English script (with its summary) first: each chapter continues from the previous one.`, wait: true }
      }
      const about = chapter.series.aboutSummary?.trim() || null
      const script = await readText(path.join(dir, 'script.md'))
      const scriptSha256 = script === null ? null : sha256(script)
      const input = {
        seriesTitle: chapter.series.title, chapterNumber: String(chapter.number),
        requireAbout: !previousChapter && !about, about, previous, scriptSha256, scriptWords: script ? narrationWords(script) : undefined
      }
      const revision = sha256(JSON.stringify({ ...input, pages: pages.map(p => [p.source, p.size, p.mtime]) }))
      return { ...input, revision, pages: pages.map(p => ({ file: p.file, source: p.source })) }
    },

    save: (chapterId, output, expectedSha256, model) => saveEnglishScript(prisma, chapterId, output, expectedSha256, { provider: 'Studio AntiGravity', model }),

    hinglish: hinglishStudioDeps(prisma)
  }
}

/** A chapter's Hinglish inputs (its saved English script and summary) and the save through Narration's Replace. */
export function hinglishStudioDeps(prisma: PrismaClient): HinglishDeps {
  return {
    async input(chapterId): Promise<HinglishInput | { reason: string; wait?: boolean }> {
      const chapter = await prisma.chapter.findUnique({
        where: { id: chapterId },
        select: { number: true, folderPath: true, completedAt: true, status: true, series: { select: { title: true } }, scripts: { where: { language: 'en' }, select: { rollingSummary: true } } }
      })
      if (!chapter) return { reason: 'Chapter not found.' }
      if (chapter.completedAt || chapter.status !== 'done') return { reason: 'Only downloaded chapters of a Part that isn\'t completed can have their script written.' }
      const dir = chapterDir(chapter.folderPath)
      const english = await readText(path.join(dir, 'script.md'))
      if (!english?.trim()) return { reason: 'Needs its English script first: the Hinglish is written from it.' }
      // As the phone's runs: header/caption wording in the English would fail every Hinglish check, so don't start.
      const sourceIssues = englishSourceIssues(english)
      if (sourceIssues.length) return { reason: `The English script needs correcting before the Hinglish:\n${sourceIssues.join('\n')}` }
      const summary = chapter.scripts[0]?.rollingSummary?.trim() || null
      const hinglish = await readText(path.join(dir, 'script.hi.md'))
      const marker = await readText(path.join(dir, '.script-replacement.hi.json')).then(t => JSON.parse(t ?? 'null') as { sourceSha256?: string | null } | null).catch(() => null)
      const sourceSha256 = sha256(english.trim())
      return {
        revision: sha256(JSON.stringify({ language: 'hi', sourceSha256, summary })),
        seriesTitle: chapter.series.title, chapterNumber: String(chapter.number),
        source: { script: english, summary }, sourceSha256,
        scriptSha256: hinglish === null ? null : sha256(hinglish),
        madeFromSha256: typeof marker?.sourceSha256 === 'string' ? marker.sourceSha256 : null
      }
    },

    async save(chapterId, text, expectedSha256, sourceSha256, model) {
      const { replaceChapterScript } = await import('../scriptReplacement.js')
      const result = await replaceChapterScript(chapterId, 'hi', { text, expectedSha256, manualOutput: true, sourceSha256, sendToPhones: true })
      await prisma.chapterScript.update({ where: { chapterId_language: { chapterId, language: 'hi' } }, data: { provider: 'Studio AntiGravity', model } })
      return { phoneSent: result.phoneSent, ...(result.phoneError && { phoneError: result.phoneError }) }
    }
  }
}

/**
 * Saves an English script written by Studio (AntiGravity or the Gemini app) like Narration's Replace: backup, reset,
 * send to phones; the series overview from a first chapter; the image review beside it as script.review.json.
 */
export async function saveEnglishScript(prisma: PrismaClient, chapterId: string, output: NarrationOutput, expectedSha256: string | null, by: { provider: string; model: string }) {
  const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId }, select: { folderPath: true, series: { select: { aboutSummary: true } } } })
  const { replaceChapterScript } = await import('../scriptReplacement.js')
  const result = await replaceChapterScript(chapterId, 'en', {
    text: output.script, expectedSha256, sendToPhones: true,
    // The series overview is written once, by its first chapter.
    generated: { summary: output.summary, about: chapter.series.aboutSummary?.trim() ? null : output.about }
  })
  // The image review beside the script, as the phone keeps it (notes, printed text, paragraph → piece map).
  await fs.writeFile(path.join(chapterDir(chapter.folderPath), 'script.review.json'), output.audit + '\n', 'utf8')
  await prisma.chapterScript.update({ where: { chapterId_language: { chapterId, language: 'en' } }, data: { provider: by.provider, model: by.model } })
  return { phoneSent: result.phoneSent, ...(result.phoneError && { phoneError: result.phoneError }) }
}
