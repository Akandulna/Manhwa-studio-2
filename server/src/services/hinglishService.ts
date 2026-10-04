/**
 * Hinglish convert step — the side with Gemini, the database and the queue.
 * The prompt, the check and the saved shape are in hinglishConvert.ts.
 *
 * Every Hindi script comes from its chapter's English script: an English
 * script generated in API mode is queued for conversion as soon as it is
 * saved, and the series' "Convert to Hinglish" action queues every chapter
 * whose English is done but whose Hinglish is missing, failed or stale (the
 * English changed since). Conversions run one at a time beside English
 * generation, so a long batch never waits on them.
 *
 * One conversion is one conversation with the English script model: the
 * convert prompt; if the reply fails the check, one follow-up listing the
 * issues; if that still fails but has paragraphs, it is saved with `review`
 * set to the issues. A reply with no usable paragraphs at all is a failed
 * attempt and leaves any earlier Hindi script as it was.
 *
 * Progress goes out on `narration:hinglish` (see HinglishEvent), not on
 * `narration:progress`, so it never hides the English chapter's progress.
 */

import fs from 'fs/promises'
import path from 'path'
import PQueue from 'p-queue'
import type { Server } from 'socket.io'
import { prisma } from '../index.js'
import { aiProviderFactory } from './ai/index.js'
import { scriptFileName } from './narrationLanguage.js'
import { getPublishedChapters } from './storageService.js'
import {
  DEFAULT_HINGLISH_RULES,
  HINGLISH_RULES_SETTING,
  HinglishState,
  assembleConversion,
  buildConvertPrompt,
  buildFollowUp,
  checkConversion,
  decodeReview,
  encodeReview,
  englishParagraphs,
  hasUsableScript,
  hinglishState,
  needsConversion,
  parseConversionReply,
  sourceSha256,
  type ConvertedScript
} from './hinglishConvert.js'

/**
 * Output budget for one convert call. Devanagari costs several times the
 * tokens of the same English, and Gemini 3 counts its thinking against this
 * too, so the 8192 the image calls use would cut long chapters short.
 */
const CONVERT_MAX_OUTPUT_TOKENS = 32768

function getFullFolderPath(relativePath: string): string {
  return path.join(process.env.DOWNLOAD_ROOT || './downloads', relativePath)
}

/** English rows count as written once they have text, whatever the continuity says. */
const ENGLISH_WRITTEN = ['done', 'edited', 'stale']

/** Hindi rows that hold a script (a failed first attempt or a bare part-end toggle doesn't). */
const HINDI_WRITTEN = ['done', 'edited', 'stale']

export async function getHinglishRules(): Promise<string> {
  const setting = await prisma.setting.findUnique({ where: { key: HINGLISH_RULES_SETTING } })
  return setting?.value?.trim() ? setting.value : DEFAULT_HINGLISH_RULES
}

async function readText(scriptPath: string | null | undefined): Promise<string | null> {
  if (!scriptPath) return null
  try {
    return await fs.readFile(scriptPath, 'utf-8')
  } catch {
    return null
  }
}

interface ScriptRowLike {
  status: string
  scriptPath: string | null
  rollingSummary?: string | null
}

export interface EnglishSource {
  text: string
  sha256: string
  summary: string
}

/** A chapter's English script as the conversion reads it; null while there is none. */
export async function readEnglishSource(english: ScriptRowLike | null | undefined): Promise<EnglishSource | null> {
  if (!english || !ENGLISH_WRITTEN.includes(english.status)) return null
  const text = await readText(english.scriptPath)
  if (!text?.trim()) return null
  return { text, sha256: sourceSha256(text), summary: (english.rollingSummary ?? '').trim() }
}

/** The SHA-256 the current English script would be recorded with; null while there is none. */
export async function englishSha256(english: ScriptRowLike | null | undefined): Promise<string | null> {
  return (await readEnglishSource(english))?.sha256 ?? null
}

export interface HinglishInfo {
  state: HinglishState
  /** The check's issues when the script was saved despite failing it. */
  review: string[] | null
  /** Why the last conversion failed, if it did. */
  error: string | null
}

interface HindiRowLike extends ScriptRowLike {
  sourceSha256: string | null
  review: string | null
  error: string | null
}

export function hinglishInfo(englishSha: string | null, hindi: HindiRowLike | null | undefined): HinglishInfo {
  const state = hinglishState({
    englishSha256: englishSha,
    hindi: hindi
      ? {
          status: hindi.status,
          hasScript: !!hindi.scriptPath && HINDI_WRITTEN.includes(hindi.status),
          sourceSha256: hindi.sourceSha256,
          review: hindi.review
        }
      : null
  })
  return { state, review: state === 'review' ? decodeReview(hindi?.review) : null, error: hindi?.error ?? null }
}

/** Every downloaded chapter's Hinglish status, by chapter id. */
export async function getSeriesHinglish(seriesId: string): Promise<Map<string, HinglishInfo & { number: number }>> {
  const chapters = await prisma.chapter.findMany({
    where: { seriesId, status: 'done' },
    select: { id: true, number: true, scripts: true },
    orderBy: { number: 'asc' }
  })
  const result = new Map<string, HinglishInfo & { number: number }>()
  for (const chapter of chapters) {
    const english = chapter.scripts.find(s => s.language === 'en')
    const hindi = chapter.scripts.find(s => s.language === 'hi')
    result.set(chapter.id, { number: chapter.number, ...hinglishInfo(await englishSha256(english), hindi) })
  }
  return result
}

/**
 * Chapters the "Convert to Hinglish" action picks up, in reading order: English
 * written, Hinglish missing, failed or stale. Chapters already published in
 * Hindi are left alone — converting again would invalidate the video.
 */
export async function getConvertibleChapters(
  seriesId: string,
  known?: Map<string, HinglishInfo & { number: number }>
): Promise<string[]> {
  const [states, published] = await Promise.all([known ?? getSeriesHinglish(seriesId), getPublishedChapters(seriesId, 'hi')])
  return [...states]
    .filter(([id, info]) => needsConversion(info.state) && !published.chapters[id])
    .sort((a, b) => a[1].number - b[1].number)
    .map(([id]) => id)
}

// ============ Saving ============

export interface SaveHinglishOptions {
  sourceSha256: string
  /** The check's issues; empty or null when it passed. */
  issues: string[] | null
  mode: 'api' | 'manual'
  provider?: string | null
  model?: string | null
  tokensUsed?: number | null
}

/**
 * Writes script.hi.md and the chapter's Hindi row: closing = last paragraph,
 * rolling summary = the Hinglish SUMMARY. A new Hindi row takes the English
 * row's part end, so both languages start with the same parts.
 */
export async function saveHinglishScript(chapterId: string, converted: ConvertedScript, options: SaveHinglishOptions): Promise<void> {
  const chapter = await prisma.chapter.findUniqueOrThrow({
    where: { id: chapterId },
    include: { scripts: { where: { language: 'en' } } }
  })
  const scriptPath = path.join(getFullFolderPath(chapter.folderPath), scriptFileName('hi'))
  await fs.writeFile(scriptPath, converted.script, 'utf-8')

  const data = {
    mode: options.mode,
    provider: options.provider ?? null,
    model: options.model ?? null,
    scriptPath,
    status: 'done',
    rollingSummary: converted.summary || null,
    closingParagraph: converted.closing || null,
    sourceSha256: options.sourceSha256,
    review: encodeReview(options.issues),
    tokensUsed: options.tokensUsed ?? null,
    error: null
  }
  await prisma.chapterScript.upsert({
    where: { chapterId_language: { chapterId, language: 'hi' } },
    update: data,
    create: { chapterId, language: 'hi', isPartEnd: chapter.scripts[0]?.isPartEnd ?? false, ...data }
  })
}

/** Records a failed attempt; a Hindi script already there keeps its status and stays usable. */
async function recordFailure(chapterId: string, message: string): Promise<void> {
  const existing = await prisma.chapterScript.findUnique({
    where: { chapterId_language: { chapterId, language: 'hi' } }
  })
  const hasScript = !!existing?.scriptPath && HINDI_WRITTEN.includes(existing.status)
  await prisma.chapterScript.upsert({
    where: { chapterId_language: { chapterId, language: 'hi' } },
    update: hasScript ? { error: message } : { status: 'failed', error: message },
    create: { chapterId, language: 'hi', mode: 'api', status: 'failed', error: message }
  })
}

// ============ The queue ============

export type HinglishStage = 'queued' | 'converting' | 'retrying' | 'done' | 'review' | 'failed'

/** Emitted on `narration:hinglish` for every step of a chapter's conversion. */
export interface HinglishEvent {
  seriesId: string
  chapterId: string
  chapterNumber: number
  stage: HinglishStage
  error?: string
  issues?: string[]
  /** Chapters of this series still queued or converting after this event (this one counts until it finishes). */
  remaining: number
}

export interface HinglishQueueStatus {
  /** The chapter converting now, if it is in this series. */
  running: string | null
  /** Chapters waiting, in order. */
  queued: string[]
}

export type ConvertResult =
  | { success: true; state: 'done' | 'review'; issues: string[] }
  | { success: false; error: string }

interface QueueEntry {
  seriesId: string
  chapterNumber: number
}

export class HinglishConversionService {
  private queue = new PQueue({ concurrency: 1 })
  /** Queued or running, in the order queued. */
  private entries = new Map<string, QueueEntry>()
  private running: string | null = null

  constructor(private io: Server) {}

  status(seriesId: string): HinglishQueueStatus {
    const ofSeries = [...this.entries].filter(([, e]) => e.seriesId === seriesId).map(([id]) => id)
    const running = this.running && ofSeries.includes(this.running) ? this.running : null
    return { running, queued: ofSeries.filter(id => id !== running) }
  }

  isQueued(chapterId: string): boolean {
    return this.entries.has(chapterId)
  }

  /** Queues chapters for conversion (skipping ones already queued); returns how many were added. */
  async enqueue(chapterIds: string[]): Promise<number> {
    const fresh = chapterIds.filter(id => !this.entries.has(id))
    if (fresh.length === 0) return 0
    const chapters = await prisma.chapter.findMany({
      where: { id: { in: fresh } },
      select: { id: true, seriesId: true, number: true }
    })
    const byId = new Map(chapters.map(c => [c.id, c]))
    let added = 0
    for (const id of fresh) {
      const chapter = byId.get(id)
      if (!chapter || this.entries.has(id)) continue
      this.entries.set(id, { seriesId: chapter.seriesId, chapterNumber: chapter.number })
      this.emit(id, 'queued')
      added++
      this.queue.add(async () => {
        this.running = id
        try {
          await this.convertChapter(id)
        } finally {
          this.running = null
          this.entries.delete(id)
        }
      }).catch(error => {
        // convertChapter reports its own failures; this is only a backstop.
        console.error(`[hinglish] queue task for ${id} failed:`, error)
      })
    }
    return added
  }

  /**
   * Converts one chapter now. Never throws: a failure is recorded on the Hindi
   * row, emitted, and returned, so it can't stop whatever triggered it.
   */
  async convertChapter(chapterId: string): Promise<ConvertResult> {
    try {
      const provider = aiProviderFactory.getDefaultProvider()
      if (!provider) throw new Error('No AI provider configured. Set GEMINI_API_KEY in .env, or use Copy Hinglish prompt on the English tab.')

      const chapter = await prisma.chapter.findUniqueOrThrow({
        where: { id: chapterId },
        include: { scripts: { where: { language: 'en' } } }
      })
      const source = await readEnglishSource(chapter.scripts[0])
      if (!source) throw new Error(`Chapter ${chapter.number} has no English script to convert yet`)
      const english = englishParagraphs(source.text)

      const prompt = buildConvertPrompt(await getHinglishRules(), source.text, source.summary)
      this.emit(chapterId, 'converting')
      const first = await provider.chat({
        turns: [{ role: 'user', text: prompt }],
        maxOutputTokens: CONVERT_MAX_OUTPUT_TOKENS
      })
      let tokensUsed = first.tokensUsed ?? 0
      let parsed = parseConversionReply(first.text)
      let issues = checkConversion(english, source.summary, parsed)

      if (issues.length > 0) {
        this.emit(chapterId, 'retrying', { issues })
        // An empty first reply leaves nothing to answer, so the prompt is simply asked again.
        const turns = first.text.trim()
          ? [
              { role: 'user' as const, text: prompt },
              { role: 'model' as const, text: first.text },
              { role: 'user' as const, text: buildFollowUp(issues, english.length) }
            ]
          : [{ role: 'user' as const, text: prompt }]
        const second = await provider.chat({ turns, maxOutputTokens: CONVERT_MAX_OUTPUT_TOKENS })
        tokensUsed += second.tokensUsed ?? 0
        parsed = parseConversionReply(second.text)
        issues = checkConversion(english, source.summary, parsed)
        if (issues.length > 0 && !hasUsableScript(parsed)) {
          throw new Error(`The Hinglish reply had no [P1]..[P${english.length}] paragraphs to save`)
        }
      }

      await saveHinglishScript(chapterId, assembleConversion(parsed, english.length), {
        sourceSha256: source.sha256,
        issues,
        mode: 'api',
        provider: provider.name,
        model: provider.model,
        tokensUsed
      })
      const state = issues.length > 0 ? 'review' : 'done'
      if (state === 'review') console.warn(`[hinglish] chapter ${chapter.number} saved for review: ${issues.join(' | ')}`)
      this.emit(chapterId, state, issues.length > 0 ? { issues } : {})
      return { success: true, state, issues }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[hinglish] converting chapter ${chapterId} failed:`, message)
      await recordFailure(chapterId, message).catch(() => {})
      this.emit(chapterId, 'failed', { error: message })
      return { success: false, error: message }
    }
  }

  private emit(chapterId: string, stage: HinglishStage, extra: { error?: string; issues?: string[] } = {}): void {
    const entry = this.entries.get(chapterId)
    if (!entry) return
    const finished = stage === 'done' || stage === 'review' || stage === 'failed'
    const remaining = [...this.entries.values()].filter(e => e.seriesId === entry.seriesId).length - (finished ? 1 : 0)
    const event: HinglishEvent = {
      seriesId: entry.seriesId,
      chapterId,
      chapterNumber: entry.chapterNumber,
      stage,
      remaining,
      ...extra
    }
    this.io.emit('narration:hinglish', event)
  }
}
