/**
 * Gemini MCP narration jobs (docs/PRD-gemini-app-narration.md §4–§5, Phase 2).
 *
 * One GeminiAppJob per chapter and language. English and Hinglish are separate jobs, worked in separate Gemini chats.
 *  - English: the chapter's pages are cut into the usual ≤2,000 px pieces with "P0003-T002 · CHECK K7QM" bands
 *    (fresh codes per preparation) and uploaded to My Drive / Manhwa Studio / gemini-narration /
 *    "<Series> · Ch <N> · <code>", files named "C012-P0003-T002.jpg", so Gemini can't mix chapters up.
 *  - Hinglish: nothing to upload; it is written from the saved English script.
 *
 * Process makes (or reuses) one chapter's job. Master queues a series' remaining chapters in order; the
 * preparation worker keeps at most LOOKAHEAD queued English chapters uploaded ahead of Gemini, one at a time.
 * Gemini asks for a job with get_job (by its ref, or the next in the Master queue without one).
 *
 * Tool replies are plain data, never orders (PRD §3 rule 2). The writing stages arrive in Phase 3/4: until then
 * get_job describes the job and submit answers "rejected".
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GeminiAppJob, PrismaClient } from '@prisma/client'
import { checkCode, prepareChapterPages } from '../antigravity/narrationPieces.js'
import { chapterDir, chapterPages, IMAGE, narrationStudioDeps, saveEnglishScript } from '../antigravity/narrationStudio.js'
import type { NarrationInput, NarrationOutput } from '../antigravity/narrationFlow.js'
import {
  InvalidReply, MAX_REJECTIONS, REFERENCE_NAMES, accept, asPieces, contentText, currentStage, output, parseProgress, reference,
  HISTORY_LIMIT, rejectionKey, stageArg, stageData, timing, type RejectionRecord, type StoredPiece
} from './english.js'
export type { StoredPiece } from './english.js'
import { HINGLISH_REFERENCES, acceptHinglish, hinglishReference, hinglishStage, hinglishStageArg, hinglishStageData, parseHinglish, type EnglishSource } from './hinglish.js'
import { scriptFileName, type NarrationLanguage } from '../narrationLanguage.js'
import { englishSourceIssues } from '../hinglishRules.js'
import { folderUrl, type DriveApi } from '../googleDrive/driveApi.js'
import { ensureFolder, ensureRootFolder, ROOT_FOLDER_NAME, STUDIO_APP } from '../googleDrive/files.js'
import type { DriveStore } from '../googleDrive/store.js'
import type { BridgeData } from './connector.js'
import type { GeminiChapterRow, GeminiJobView, GeminiSeriesRow, JobState } from './model.js'
export type { GeminiChapterRow, GeminiJobView, GeminiLanguageStatus, GeminiSeriesRow, JobState } from './model.js'

/** The Drive folder (under Manhwa Studio) that holds one folder per prepared chapter. */
export const GEMINI_FOLDER = 'gemini-narration'
/** Master: English chapters kept uploaded ahead of Gemini. */
export const LOOKAHEAD = 3
const UPLOAD_CONCURRENCY = 4
/** Same as Narration's "has a script" (routes/narration.ts). */
const SCRIPT_WRITTEN = ['done', 'edited', 'stale']
/** Same as AntiGravity's parts (antigravity/jobs.ts CLIPPER_PART_SIZE). */
const PART_SIZE = 20

/** Gemini is (or will be) on it. */
const ACTIVE: JobState[] = ['queued', 'preparing', 'ready', 'working']
/** Still the chapter's current job (shown, and replaced only by Process). */
const CURRENT: JobState[] = [...ACTIVE, 'attention', 'failed']

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex')
const readText = (file: string) => fs.readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e })
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Page images actually in a chapter's folder (the database can say "done" for a folder emptied by hand). */
async function imagesOnDisk(folderPath: string): Promise<number> {
  try {
    return (await fs.readdir(chapterDir(folderPath))).filter(f => IMAGE.test(f) && !f.startsWith('.')).length
  } catch { return 0 }
}

/** "C012", "C012.5": the chapter in job refs and file names. */
export function chapterTag(number: number): string {
  const [whole, fraction] = String(number).split('.')
  return `C${whole.padStart(3, '0')}${fraction ? `.${fraction}` : ''}`
}
export const partOf = (chapterNumber: number) => Math.max(1, Math.ceil(chapterNumber / PART_SIZE))
export const folderName = (seriesTitle: string, chapterNumber: number, code: string) => `${seriesTitle} · Ch ${chapterNumber} · ${code}`
export const pieceFileName = (chapterNumber: number, pieceId: string) => `${chapterTag(chapterNumber)}-${pieceId}.jpg`

/** When a Master chain's next scheduled run should start: whole minutes, a few minutes ahead (Phase 0c). */
export function nextRunAt(now: Date, minutes = 3) {
  const at = new Date(now.getTime() + minutes * 60_000)
  if (at.getSeconds() || at.getMilliseconds()) at.setMinutes(at.getMinutes() + 1, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())} (${zone})`
}

export interface DriveAccess {
  connection(): Promise<{ id: string; email: string | null }>
  api(connectionId: string): DriveApi
  store: DriveStore
}

export interface GeminiJobsDeps {
  prisma: PrismaClient
  drive: () => DriveAccess
  /** Where pieces are cut before upload (deleted after). */
  workDir?: string
  now?: () => Date
  log?: (line: string) => void
  /** The chapter's continuity and the save (tests stand in for Studio's). */
  narration?: GeminiNarration
}

export interface GeminiNarration {
  input(chapterId: string): Promise<NarrationInput | { reason: string; wait?: boolean }>
  save(chapterId: string, output: NarrationOutput, expectedSha256: string | null): Promise<{ phoneSent: boolean; phoneError?: string }>
  /** The chapter's English script (as on disk) and its summary, for Hinglish; null without one. */
  english(chapterId: string): Promise<EnglishSource | null>
  /** Saves the Hinglish like Narration's Replace with the manual prompts' output (it runs the same checks again). */
  saveHinglish(chapterId: string, text: string, expectedSha256: string | null, sourceSha256: string | null): Promise<{ phoneSent: boolean; phoneError?: string }>
}

export const GEMINI_PROVIDER = { provider: 'Gemini app', model: 'Gemini (Mac app)' }

export function studioNarration(prisma: PrismaClient): GeminiNarration {
  const deps = narrationStudioDeps(prisma)
  return {
    input: id => deps.input(id),
    save: (id, out, sha) => saveEnglishScript(prisma, id, out, sha, GEMINI_PROVIDER),
    async english(id) {
      const chapter = await prisma.chapter.findUnique({ where: { id }, select: { folderPath: true, scripts: { where: { language: 'en' }, select: { rollingSummary: true } } } })
      if (!chapter) return null
      const script = await readText(path.join(chapterDir(chapter.folderPath), scriptFileName('en')))
      return script?.trim() ? { script, summary: chapter.scripts[0]?.rollingSummary?.trim() || null } : null
    },
    async saveHinglish(id, text, expectedSha256, sourceSha256) {
      const { replaceChapterScript } = await import('../scriptReplacement.js')
      const result = await replaceChapterScript(id, 'hi', { text, expectedSha256, manualOutput: true, sourceSha256, sendToPhones: true })
      await prisma.chapterScript.update({ where: { chapterId_language: { chapterId: id, language: 'hi' } }, data: GEMINI_PROVIDER })
      return { phoneSent: result.phoneSent, ...(result.phoneError && { phoneError: result.phoneError }) }
    }
  }
}

export class GeminiJobError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export function jobView(job: GeminiAppJob): GeminiJobView {
  const progress = parseProgress(job.stateJson)
  const raw = rawState(job.stateJson)
  return {
    id: job.id, ref: job.ref, chapterId: job.chapterId, language: job.language as NarrationLanguage,
    state: job.state as JobState, stage: job.stage, rewrite: job.rewrite, queueOrder: job.queueOrder,
    uploaded: job.uploaded, total: job.total, noted: Object.keys(progress.notes).length, timing: timing(raw, job.finishedAt),
    driveFolderName: job.driveFolderName, driveFolderUrl: job.driveFolderId && !job.driveDeletedAt ? folderUrl(job.driveFolderId) : null,
    lastError: job.lastError, lastActivityAt: job.lastActivityAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(), finishedAt: job.finishedAt?.toISOString() ?? null
  }
}

/** A job's stateJson as a plain object (English and Hinglish keep different fields; both have startedAt/steps). */
function rawState(json: string | null): Record<string, unknown> & { startedAt?: string; steps?: { key: string; at: string; rejected: number }[] } {
  try { const v = JSON.parse(json ?? '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} }
}

/** Gemini sends the job under its own field names (PRD §3 rule 5). */
export function jobArg(args: Record<string, unknown>): string | null {
  for (const key of ['job', 'job_id', 'jobId', 'id', 'ref']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 60)
  }
  return null
}

export class GeminiJobs {
  private readonly prisma: PrismaClient
  private readonly workDir: string
  private readonly now: () => Date
  private readonly log: (line: string) => void
  private worker: Promise<void> | null = null
  private again = false
  /** Jobs cancelled while their pieces were uploading: the upload stops at the next file. */
  private readonly stopped = new Set<string>()
  private readonly narration: GeminiNarration

  constructor(private readonly deps: GeminiJobsDeps) {
    this.prisma = deps.prisma
    this.workDir = deps.workDir ?? path.join(os.tmpdir(), 'manhwa-studio-gemini')
    this.now = deps.now ?? (() => new Date())
    this.log = deps.log ?? (line => console.log(`[gemini-mcp] ${line}`))
    this.narration = deps.narration ?? studioNarration(deps.prisma)
  }

  /** After a restart: uploads that were cut off start over (with fresh codes), then the worker resumes. */
  async init() {
    for (const job of await this.prisma.geminiAppJob.findMany({ where: { state: 'preparing' } })) {
      await this.deleteDriveFolder(job)
      await this.prisma.geminiAppJob.update({ where: { id: job.id }, data: { state: 'queued', uploaded: 0, total: 0, piecesJson: '[]', driveFolderId: null, driveDeletedAt: null } })
    }
    this.kick()
  }

  /** Resolves when the preparation worker has nothing left to do (tests). */
  async idle() {
    while (this.worker) await this.worker
  }

  // ─── Studio side: lists ───

  async seriesList(): Promise<GeminiSeriesRow[]> {
    await this.dropSuperseded()
    const series = await this.prisma.series.findMany({
      orderBy: { title: 'asc' },
      select: { id: true, title: true, rootFolder: true, createdAt: true, chapters: { where: { status: 'done', completedAt: null }, select: { id: true, folderPath: true, scripts: { select: { language: true, status: true } } } } }
    })
    for (const s of series) {
      const onDisk = await Promise.all(s.chapters.map(c => imagesOnDisk(c.folderPath)))
      // Pages for English, or an English script for Hinglish.
      s.chapters = s.chapters.filter((c, i) => onDisk[i] > 0 || c.scripts.some(x => x.language === 'en' && SCRIPT_WRITTEN.includes(x.status)))
    }
    const active = await this.prisma.geminiAppJob.groupBy({ by: ['seriesId'], where: { state: { in: ACTIVE } }, _count: true })
    const activeBy = new Map(active.map(a => [a.seriesId, a._count]))
    return series.filter(s => s.chapters.length).map(s => ({
      id: s.id, title: s.title, rootFolder: s.rootFolder, createdAt: s.createdAt.toISOString(), chapters: s.chapters.length,
      english: s.chapters.filter(c => c.scripts.some(x => x.language === 'en' && SCRIPT_WRITTEN.includes(x.status))).length,
      hinglish: s.chapters.filter(c => c.scripts.some(x => x.language === 'hi' && SCRIPT_WRITTEN.includes(x.status))).length,
      activeJobs: activeBy.get(s.id) ?? 0
    }))
  }

  async chapters(seriesId: string): Promise<{ series: { id: string; title: string }; chapters: GeminiChapterRow[] }> {
    const series = await this.prisma.series.findUnique({ where: { id: seriesId }, select: { id: true, title: true } })
    if (!series) throw new GeminiJobError('Series not found.', 404)
    await this.dropSuperseded(seriesId)
    const rows = await this.prisma.chapter.findMany({
      where: { seriesId }, orderBy: { number: 'asc' },
      select: {
        id: true, number: true, title: true, status: true, completedAt: true, folderPath: true,
        scripts: { select: { language: true, status: true } }
      }
    })
    const onDisk = await Promise.all(rows.map(r => imagesOnDisk(r.folderPath)))
    const jobs = await this.currentJobs(rows.map(r => r.id))
    const chapters: GeminiChapterRow[] = []
    let previousEnglish: { number: number; ok: boolean } | null = null
    for (const [index, row] of rows.entries()) {
      const pages = onDisk[index]
      const script = (lang: NarrationLanguage) => row.scripts.find(s => s.language === lang)?.status ?? null
      const has = (lang: NarrationLanguage) => SCRIPT_WRITTEN.includes(script(lang) ?? '')
      const en = jobs.get(`${row.id}|en`) ?? null
      const hi = jobs.get(`${row.id}|hi`) ?? null
      const completed = row.completedAt ? 'Its Part is completed.' : null
      const common = completed ?? (row.status !== 'done' || !pages ? 'Not downloaded (no page images in its folder).' : null)
      chapters.push({
        id: row.id, number: row.number, title: row.title, part: partOf(row.number), pages,
        en: {
          hasScript: has('en'), scriptStatus: script('en'), job: en && jobView(en),
          blocked: common ?? (previousEnglish && !previousEnglish.ok ? `Chapter ${previousEnglish.number} needs its English script first.` : null)
        },
        hi: { hasScript: has('hi'), scriptStatus: script('hi'), job: hi && jobView(hi), blocked: completed ?? (has('en') ? null : 'Needs its English script first.') }
      })
      // A chapter continues from the previous one's summary: fine once that one has a script or a job on the way.
      previousEnglish = { number: row.number, ok: has('en') || (!!en && ACTIVE.includes(en.state as JobState)) }
    }
    return { series, chapters }
  }

  private async currentJobs(chapterIds: string[]) {
    const list = await this.prisma.geminiAppJob.findMany({ where: { chapterId: { in: chapterIds }, state: { not: 'cancelled' } }, orderBy: { createdAt: 'asc' } })
    const map = new Map<string, GeminiAppJob>()
    for (const job of list) map.set(`${job.chapterId}|${job.language}`, job)
    return map
  }

  async job(id: string) {
    const job = await this.prisma.geminiAppJob.findUnique({ where: { id } })
    if (!job) throw new GeminiJobError('Job not found.', 404)
    return job
  }

  // ─── Studio side: Process, Master, Cancel ───

  /**
   * Process: one chapter, one language. Returns the chapter's job that is still going, or makes a new one
   * (restart: replaces it; a job that needs attention or failed is always replaced).
   */
  async process(chapterId: string, language: NarrationLanguage, opts: { rewrite?: boolean; restart?: boolean } = {}) {
    const current = (await this.currentJobs([chapterId])).get(`${chapterId}|${language}`)
    if (current && ACTIVE.includes(current.state as JobState) && !opts.restart) {
      // Process = this chapter on its own: it leaves the Master queue and is prepared next.
      if (current.queueOrder !== null && ['queued', 'ready'].includes(current.state)) {
        const job = await this.prisma.geminiAppJob.update({ where: { id: current.id }, data: { queueOrder: null } })
        this.kick()
        return job
      }
      return current
    }
    const plan = await this.plan(chapterId, language, !!opts.rewrite)
    if (current && current.state !== 'saved') await this.cancelJob(current)
    const job = await this.create(plan, null)
    this.kick()
    return job
  }

  /**
   * Master: queues every remaining chapter of the series for one language, in chapter order. The series and language
   * just asked for run first: their chapters go to the front of the queue, ahead of what other series (or the other
   * language) still have queued, so the Master prompt starts on the chapter the user is looking at.
   */
  async master(seriesId: string, language: NarrationLanguage) {
    const { chapters } = await this.chapters(seriesId)
    const last = await this.prisma.geminiAppJob.aggregate({ where: { queueOrder: { not: null } }, _max: { queueOrder: true } })
    let order = (last._max.queueOrder ?? 0) + 1
    /** This series and language's queue, in chapter order: chapters already queued keep their place among the new ones. */
    const block: string[] = []
    const queued: GeminiAppJob[] = []
    const skipped: { number: number; reason: string }[] = []
    // English chapters continue from each other, so a chapter is fine when the one before it is queued too.
    let englishChain = true
    for (const c of chapters) {
      const status = c[language]
      // A chapter Process already prepared but Gemini hasn't started joins the queue in its place, so the chapters
      // after it don't wait forever for its summary.
      if (!status.hasScript && status.job && status.job.queueOrder === null && ['queued', 'preparing', 'ready'].includes(status.job.state)) {
        queued.push(await this.prisma.geminiAppJob.update({ where: { id: status.job.id }, data: { queueOrder: order++ } }))
        block.push(status.job.id)
        continue
      }
      if (status.hasScript || (status.job && CURRENT.includes(status.job.state))) {
        englishChain = status.hasScript || ACTIVE.includes(status.job!.state)
        if (status.job && status.job.queueOrder !== null && CURRENT.includes(status.job.state)) block.push(status.job.id)
        continue
      }
      if (language === 'en' && !englishChain) { skipped.push({ number: c.number, reason: 'an earlier chapter has no English script' }); continue }
      try {
        const job = await this.create(await this.plan(c.id, language, false, language === 'en'), order++)
        queued.push(job)
        block.push(job.id)
      } catch (error) {
        skipped.push({ number: c.number, reason: message(error) })
        if (language === 'en') englishChain = false
      }
    }
    await this.moveToFront(block)
    this.kick()
    const ids = queued.map(j => j.id)
    return { queued: await this.prisma.geminiAppJob.findMany({ where: { id: { in: ids } }, orderBy: { queueOrder: 'asc' } }), skipped }
  }

  /** Renumbers the unfinished Master queue from 1: the given jobs first, in the order given, then the rest as they were. */
  private async moveToFront(ids: string[]) {
    if (!ids.length) return
    const rest = await this.prisma.geminiAppJob.findMany({
      where: { queueOrder: { not: null }, state: { in: CURRENT }, id: { notIn: ids } },
      orderBy: [{ queueOrder: 'asc' }, { createdAt: 'asc' }], select: { id: true }
    })
    await this.prisma.$transaction([...ids, ...rest.map(r => r.id)].map((id, index) => this.prisma.geminiAppJob.update({ where: { id }, data: { queueOrder: index + 1 } })))
  }

  /** Stops the series' Master queue: jobs Gemini hasn't started are cancelled (their Drive folders deleted). */
  async stopMaster(seriesId: string) {
    const jobs = await this.prisma.geminiAppJob.findMany({ where: { seriesId, queueOrder: { not: null }, state: { in: ['queued', 'preparing', 'ready'] } } })
    for (const job of jobs) await this.cancelJob(job)
    return jobs.length
  }

  async cancel(id: string) {
    const job = await this.job(id)
    if (['saved', 'cancelled'].includes(job.state)) return job
    return this.cancelJob(job)
  }

  private async cancelJob(job: GeminiAppJob, reason?: string) {
    this.stopped.add(job.id)
    const updated = await this.prisma.geminiAppJob.update({ where: { id: job.id }, data: { state: 'cancelled', finishedAt: this.now(), ...(reason && { lastError: reason }) } })
    // The worker deletes the folder of a job it is uploading once it notices; everything else goes now.
    if (job.state !== 'preparing') await this.deleteDriveFolder(updated)
    return updated
  }

  // ─── Jobs overtaken by a script written another way ───

  /**
   * Why an unfinished job has nothing left to do, or null. A job starts from the chapter's script as it was when the
   * job was made (none, or the one a Rewrite replaces). When the phones, AntiGravity or the user write or change that
   * script meanwhile, the save would be refused (scriptReplacement compares the same hash), so the job must not be
   * handed to Gemini at all: the chapter already has its script.
   */
  private async supersededBy(job: GeminiAppJob): Promise<string | null> {
    const chapter = await this.prisma.chapter.findUnique({ where: { id: job.chapterId }, select: { number: true, folderPath: true, completedAt: true } })
    if (!chapter) return 'The chapter is no longer in Studio.'
    if (chapter.completedAt) return `Chapter ${chapter.number}'s Part was completed.`
    const own = await readText(path.join(chapterDir(chapter.folderPath), scriptFileName(job.language as NarrationLanguage)))
    if ((own === null ? null : sha256(own)) === job.scriptSha256) return null
    const name = job.language === 'en' ? 'English' : 'Hinglish'
    if (!own?.trim()) return `Chapter ${chapter.number}'s ${name} script was removed after this job was made.`
    return job.rewrite
      ? `Chapter ${chapter.number}'s ${name} script was changed another way after this job was made.`
      : `Chapter ${chapter.number} got its ${name} script another way after this job was made.`
  }

  /**
   * Cancels the job when it was overtaken (call under the job's lock: a save in progress writes the script too).
   * A stopped job (Needs attention / failed) goes as well: with the script there, nothing is left to look at, and it
   * must not pause the Master queue.
   */
  private async dropIfSuperseded(job: GeminiAppJob): Promise<GeminiAppJob> {
    if (!CURRENT.includes(job.state as JobState)) return job
    const reason = await this.supersededBy(job)
    if (!reason) return job
    this.log(`${job.ref}: dropped. ${reason}`)
    return this.cancelJob(job, reason)
  }

  /** The job as it stands now: cancelled when the chapter got its script another way. */
  private settle(job: GeminiAppJob): Promise<GeminiAppJob> {
    if (!CURRENT.includes(job.state as JobState)) return Promise.resolve(job)
    return this.serialized(job.id, async () => this.dropIfSuperseded(await this.job(job.id)))
  }

  /** Clears overtaken jobs out of the lists and the queue (one series, or all). */
  private async dropSuperseded(seriesId?: string) {
    const jobs = await this.prisma.geminiAppJob.findMany({ where: { ...(seriesId && { seriesId }), state: { in: CURRENT } } })
    for (const job of jobs) await this.settle(job)
  }

  /** Whether a chapter can be written now, and what its job starts from. Throws why not. */
  private async plan(chapterId: string, language: NarrationLanguage, rewrite: boolean, chained = false) {
    const chapter = await this.prisma.chapter.findUnique({ where: { id: chapterId }, include: { series: true } })
    if (!chapter) throw new GeminiJobError('Chapter not found.', 404)
    if (chapter.completedAt) throw new GeminiJobError(`Chapter ${chapter.number}'s Part is completed.`, 409)
    // English reads the pages; Hinglish only the English script.
    if (language === 'en') {
      const found = await chapterPages(this.prisma, chapterId)
      if ('reason' in found) throw new GeminiJobError(found.reason, 409)
    }
    const dir = chapterDir(chapter.folderPath)
    const own = await readText(path.join(dir, scriptFileName(language)))
    const hasScript = own !== null && !!own.trim()
    if (hasScript && !rewrite) throw new GeminiJobError(`Chapter ${chapter.number} already has a${language === 'en' ? 'n English' : ' Hinglish'} script. Choose Rewrite to replace it.`, 409)
    let sourceSha256: string | null = null
    if (language === 'hi') {
      const english = await readText(path.join(dir, 'script.md'))
      if (!english?.trim()) throw new GeminiJobError(`Chapter ${chapter.number} needs its English script before the Hinglish.`, 409)
      const sourceIssues = englishSourceIssues(english) // as the phone's runs: these would fail every Hinglish check
      if (sourceIssues.length) throw new GeminiJobError(`Chapter ${chapter.number}'s English script needs correcting before the Hinglish:\n${sourceIssues.join('\n')}`, 409)
      sourceSha256 = sha256(english.trim()) // as Narration's Replace compares it
    } else if (!chained) {
      const previous = await this.prisma.chapter.findFirst({
        where: { seriesId: chapter.seriesId, number: { lt: chapter.number } }, orderBy: { number: 'desc' },
        select: { id: true, number: true, scripts: { where: { language: 'en' }, select: { status: true } } }
      })
      if (previous && !SCRIPT_WRITTEN.includes(previous.scripts[0]?.status ?? '')) {
        const job = (await this.currentJobs([previous.id])).get(`${previous.id}|en`)
        if (!job || !ACTIVE.includes(job.state as JobState)) {
          throw new GeminiJobError(`Chapter ${previous.number} needs its English script first: each chapter continues from the previous one's summary.`, 409)
        }
      }
    }
    return { chapter, language, rewrite: hasScript && rewrite, scriptSha256: own === null ? null : sha256(own), sourceSha256 }
  }

  private async create(plan: Awaited<ReturnType<GeminiJobs['plan']>>, queueOrder: number | null) {
    const { chapter, language } = plan
    for (let tries = 0; ; tries++) {
      const code = checkCode()
      const ref = `${chapterTag(chapter.number)}-${language.toUpperCase()}-${code}`
      try {
        return await this.prisma.geminiAppJob.create({
          data: {
            ref, seriesId: chapter.seriesId, chapterId: chapter.id, language,
            state: language === 'en' ? 'queued' : 'ready', stage: language === 'en' ? 'notes' : 'hi_scenes',
            rewrite: plan.rewrite, queueOrder, scriptSha256: plan.scriptSha256, sourceSha256: plan.sourceSha256,
            driveFolderName: language === 'en' ? folderName(chapter.series.title, chapter.number, code) : null
          }
        })
      } catch (error) {
        // A ref that already exists (1 in ~330,000): draw another code.
        if (tries < 5 && /Unique constraint/i.test(message(error))) continue
        throw error
      }
    }
  }

  // ─── Preparation worker ───

  private kick() {
    if (this.worker) { this.again = true; return }
    this.worker = (async () => {
      do {
        this.again = false
        for (let job = await this.nextToPrepare(); job; job = await this.nextToPrepare()) await this.prepare(job)
      } while (this.again)
    })().catch(error => this.log(`worker stopped: ${message(error)}`)).finally(() => { this.worker = null })
  }

  /** Process jobs first, then the Master queue while fewer than LOOKAHEAD are uploaded and not started. */
  private async nextToPrepare() {
    for (;;) {
      const job = await this.pickToPrepare()
      // Nothing is uploaded for a chapter that got its script another way since it was queued.
      if (!job || (await this.settle(job)).state === 'queued') return job
    }
  }

  private async pickToPrepare() {
    const solo = await this.prisma.geminiAppJob.findFirst({ where: { state: 'queued', queueOrder: null }, orderBy: { createdAt: 'asc' } })
    if (solo) return solo
    const ahead = await this.prisma.geminiAppJob.count({ where: { language: 'en', state: { in: ['preparing', 'ready'] }, queueOrder: { not: null } } })
    if (ahead >= LOOKAHEAD) return null
    return this.prisma.geminiAppJob.findFirst({ where: { state: 'queued', queueOrder: { not: null } }, orderBy: { queueOrder: 'asc' } })
  }

  private async prepare(queued: GeminiAppJob) {
    // Only a job that is still queued (it may have been cancelled a moment ago).
    const claimed = await this.prisma.geminiAppJob.updateMany({ where: { id: queued.id, state: 'queued' }, data: { state: 'preparing', uploaded: 0, lastError: null } })
    if (!claimed.count) return
    let job = await this.job(queued.id)
    const local = path.join(this.workDir, job.ref)
    try {
      const found = await chapterPages(this.prisma, job.chapterId)
      if ('reason' in found) throw new GeminiJobError(found.reason)
      const pieces = await prepareChapterPages(found.pages.map(p => ({ file: p.file, source: p.source })), local)
      const drive = this.deps.drive()
      const connection = await drive.connection()
      const api = drive.api(connection.id)
      const root = await ensureRootFolder(api, drive.store, connection.id)
      const parent = await ensureFolder(api, drive.store, { connectionId: connection.id, kind: 'gemini', entityKey: 'narration', name: GEMINI_FOLDER, parentId: root.folderId })
      // The folder's ID is saved before it is made, so a restart can find and delete a half-made folder.
      const [folderId] = await api.generateIds(1)
      job = await this.prisma.geminiAppJob.update({ where: { id: job.id }, data: { connectionId: connection.id, driveFolderId: folderId, total: pieces.length } })
      await api.createFolder({ id: folderId, name: job.driveFolderName ?? job.ref, parentId: parent.folderId, appProperties: { studioApp: STUDIO_APP, studioKind: 'gemini-chapter' } })

      const chapter = await this.prisma.chapter.findUniqueOrThrow({ where: { id: job.chapterId }, select: { number: true } })
      const stored: StoredPiece[] = new Array(pieces.length)
      let next = 0, uploaded = 0
      const upload = async () => {
        for (let i = next++; i < pieces.length; i = next++) {
          if (this.stopped.has(job.id)) return
          const piece = pieces[i]
          const file = await api.upload({ name: pieceFileName(chapter.number, piece.id), parentId: folderId, mimeType: 'image/jpeg', appProperties: { studioApp: STUDIO_APP, studioKind: 'gemini-piece' } }, await fs.readFile(piece.file))
          stored[i] = { id: piece.id, page: piece.page, part: piece.part, parts: piece.parts, top: piece.top, bottom: piece.bottom, source: piece.source, check: piece.check, file: file.name || pieceFileName(chapter.number, piece.id), driveId: file.id }
          await this.prisma.geminiAppJob.update({ where: { id: job.id }, data: { uploaded: ++uploaded } })
        }
      }
      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, pieces.length) }, upload))
      if (this.stopped.has(job.id)) throw new GeminiJobError('cancelled')
      await this.prisma.geminiAppJob.update({ where: { id: job.id }, data: { state: 'ready', piecesJson: JSON.stringify(stored), uploaded: pieces.length } })
      this.log(`${job.ref}: ${pieces.length} pieces in Drive "${job.driveFolderName}"`)
    } catch (error) {
      const latest = await this.prisma.geminiAppJob.findUnique({ where: { id: job.id } })
      if (latest) await this.deleteDriveFolder(latest)
      if (latest && latest.state !== 'cancelled') {
        await this.prisma.geminiAppJob.update({ where: { id: job.id }, data: { state: 'failed', lastError: message(error), finishedAt: this.now() } })
        this.log(`${job.ref}: preparation failed: ${message(error)}`)
      }
    } finally {
      this.stopped.delete(job.id)
      await fs.rm(local, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async deleteDriveFolder(job: GeminiAppJob) {
    if (!job.driveFolderId || job.driveDeletedAt || !job.connectionId) return
    try {
      const drive = this.deps.drive()
      await drive.api(job.connectionId).delete(job.driveFolderId).catch(error => {
        // Never made (cut off before the create) or already gone.
        if (!/no longer exists|not found/i.test(message(error))) throw error
      })
      await this.prisma.geminiAppJob.update({ where: { id: job.id }, data: { driveDeletedAt: this.now() } })
    } catch (error) {
      this.log(`${job.ref}: could not delete its Drive folder: ${message(error)}`)
    }
  }

  /**
   * Retry a stopped job and keep its accepted work: the stuck step gets a fresh set of attempts (a save that failed is
   * tried again by the next get_job). A job whose upload failed is uploaded again.
   */
  async retry(id: string) {
    const job = await this.job(id)
    if (job.state === 'failed') {
      const updated = await this.prisma.geminiAppJob.update({ where: { id }, data: { state: 'queued', uploaded: 0, total: 0, piecesJson: '[]', driveFolderId: null, driveDeletedAt: null, lastError: null, finishedAt: null } })
      this.kick()
      return updated
    }
    if (job.state !== 'attention') throw new GeminiJobError('Only a job that needs attention or failed can be retried.', 409)
    if (job.language === 'en' && (job.driveDeletedAt || !job.driveFolderId) && currentStage(asPieces(this.stored(job)), parseProgress(job.stateJson)) === 'notes') {
      throw new GeminiJobError('Its pages are no longer in Google Drive. Start the chapter over instead.', 409)
    }
    const state = rawState(job.stateJson)
    return this.prisma.geminiAppJob.update({ where: { id }, data: { state: 'working', lastError: null, finishedAt: null, stateJson: JSON.stringify({ ...state, rejections: {} }) } })
  }

  /** A job's accepted steps and refused submissions, for the Studio log. */
  async history(id: string) {
    const job = await this.job(id)
    const state = rawState(job.stateJson) as { steps?: { key: string; at: string; rejected: number }[]; history?: RejectionRecord[]; startedAt?: string }
    return { startedAt: state.startedAt ?? null, finishedAt: job.finishedAt?.toISOString() ?? null, steps: state.steps ?? [], rejections: state.history ?? [] }
  }

  /**
   * Google Drive cleanup: deletes the chapter folders under gemini-narration that no current job uses (saved,
   * cancelled or unknown), so nothing is left behind after a crash. Folders of jobs still going are kept.
   */
  async cleanupDrive() {
    const drive = this.deps.drive()
    const connection = await drive.connection()
    const api = drive.api(connection.id)
    const root = await ensureRootFolder(api, drive.store, connection.id)
    const parent = await ensureFolder(api, drive.store, { connectionId: connection.id, kind: 'gemini', entityKey: 'narration', name: GEMINI_FOLDER, parentId: root.folderId })
    const folders = await api.list(`'${parent.folderId}' in parents and trashed = false`, 1000)
    const keep = new Set((await this.prisma.geminiAppJob.findMany({ where: { state: { in: CURRENT }, driveFolderId: { not: null } }, select: { driveFolderId: true } })).map(j => j.driveFolderId))
    const deleted: string[] = []
    for (const folder of folders) {
      if (keep.has(folder.id)) continue
      await api.delete(folder.id)
      deleted.push(folder.name)
      await this.prisma.geminiAppJob.updateMany({ where: { driveFolderId: folder.id, driveDeletedAt: null }, data: { driveDeletedAt: this.now() } })
    }
    if (deleted.length) this.log(`Drive cleanup deleted ${deleted.length} folder(s)`)
    return { kept: folders.length - deleted.length, deleted }
  }

  // ─── Gemini side (the connector's bridge) ───

  async bridge(tool: string, args: Record<string, unknown>): Promise<BridgeData> {
    const ref = jobArg(args)
    if (tool === 'get_job') return ref ? this.describe(ref) : this.nextInQueue()
    if (!['get_reference', 'submit'].includes(tool)) return { status: 'error', reason: `Unknown tool ${tool}.` }
    if (!ref) return { status: 'error', reason: 'No job given.' }
    const job = await this.findRef(ref)
    if (!job) return { status: 'error', job: ref, reason: `Manhwa Studio has no job ${ref}.` }
    await this.touch(job)
    return this.serialized(job.id, () => tool === 'get_reference' ? this.reference(job.id, args) : this.submit(job.id, args))
  }

  private readonly locks = new Map<string, Promise<unknown>>()
  /** One call at a time per job (Gemini can send several in one turn). */
  private async serialized<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(task)
    this.locks.set(id, run)
    try { return await run } finally { if (this.locks.get(id) === run) this.locks.delete(id) }
  }

  private findRef(ref: string) {
    return this.prisma.geminiAppJob.findUnique({ where: { ref: ref.toUpperCase().replace(/\s+/g, '') } })
  }

  private touch(job: GeminiAppJob) {
    return this.prisma.geminiAppJob.update({ where: { id: job.id }, data: { lastActivityAt: this.now() } })
  }

  /**
   * The first unfinished job of the Master queue. A queued chapter that stopped (Needs attention / failed) pauses the
   * queue: the chapters after it would only wait for its summary, and the chain must not keep scheduling itself.
   */
  private async nextInQueue(): Promise<BridgeData> {
    for (;;) {
      const head = await this.prisma.geminiAppJob.findFirst({ where: { queueOrder: { not: null }, state: { in: CURRENT } }, orderBy: { queueOrder: 'asc' } })
      if (!head) return { status: 'none', note: 'No chapters are queued for Gemini.' }
      // A queued chapter that already has its script is skipped: the next one without a script is the next job.
      const job = await this.settle(head)
      if (job.state === 'cancelled') continue
      if (job.state === 'attention' || job.state === 'failed') {
        return { status: 'none', note: `The queue is paused: job ${job.ref} needs attention in Manhwa Studio.`, paused_at: job.ref }
      }
      return this.describe(job.ref)
    }
  }

  /** nextRunAt only for Master jobs: a chat started with Process has nothing to schedule. */
  private next(job: GeminiAppJob) {
    return job.queueOrder !== null ? { nextRunAt: nextRunAt(this.now()) } : {}
  }

  private async head(job: GeminiAppJob) {
    const chapter = await this.prisma.chapter.findUnique({ where: { id: job.chapterId }, select: { number: true, series: { select: { title: true } } } })
    return { job: job.ref, language: job.language === 'en' ? 'English' : 'Hinglish', series: chapter?.series.title ?? null, chapter: chapter?.number ?? null }
  }

  /** The chapter's continuity (from the draft on), or why it has to wait. */
  private async input(job: GeminiAppJob) {
    const input = await this.narration.input(job.chapterId)
    return 'reason' in input ? { reason: input.reason } : { input }
  }

  private stored(job: GeminiAppJob) { return JSON.parse(job.piecesJson) as StoredPiece[] }

  private async describe(ref: string): Promise<BridgeData> {
    let job = await this.findRef(ref)
    if (!job) return { status: 'error', job: ref, reason: `Manhwa Studio has no job ${ref}.` }
    job = await this.touch(await this.settle(job))
    const head = await this.head(job)
    switch (job.state as JobState) {
      case 'queued':
      case 'preparing':
        return { status: 'preparing', ...head, uploaded: job.uploaded, total: job.total, note: 'Studio is still uploading this chapter\'s pages to Google Drive.', ...this.next(job) }
      case 'saved':
        return { status: 'saved', ...head, ...this.next(job) }
      case 'cancelled':
        return { status: 'cancelled', ...head, note: job.lastError ?? 'This job was replaced or stopped in Studio.', ...this.next(job) }
      case 'failed':
      case 'attention':
        return { status: 'needs_attention', ...head, problems: job.lastError ? job.lastError.split('\n') : [], ...this.next(job) }
    }
    if (job.state === 'ready') {
      const started = { ...rawState(job.stateJson), startedAt: this.now().toISOString() }
      job = await this.prisma.geminiAppJob.update({ where: { id: job.id }, data: { state: 'working', stateJson: JSON.stringify(started) } })
      this.kick() // Master: the next chapter can upload meanwhile
    }
    if (job.language === 'hi') return this.describeHinglish(job, head)
    const stored = this.stored(job)
    const progress = parseProgress(job.stateJson)
    const stage = currentStage(asPieces(stored), progress)
    if (stage === 'done') return this.serialized(job.id, () => this.finish(job!.id))
    let input: NarrationInput | null = null
    if (stage !== 'notes') {
      const found = await this.input(job)
      if ('reason' in found) return { status: 'waiting', ...head, stage, reason: found.reason, ...this.next(job) }
      input = found.input
    }
    return {
      status: 'working', ...head,
      drive: { folder: job.driveFolderName, path: `My Drive/${ROOT_FOLDER_NAME}/${GEMINI_FOLDER}/${job.driveFolderName}`, link: job.driveFolderId ? folderUrl(job.driveFolderId) : null, files: job.total },
      ...stageData(stored, progress, input),
      ...(job.lastError && { last_problems: job.lastError.split('\n') })
    }
  }

  private async reference(id: string, args: Record<string, unknown>): Promise<BridgeData> {
    const job = await this.job(id)
    const name = ['name', 'reference', 'ref_name', 'what', 'type'].map(k => args[k]).find((v): v is string => typeof v === 'string' && !!v.trim()) ?? ''
    if (!name) return { status: 'error', job: job.ref, reason: `No reference name given. Available: ${(job.language === 'hi' ? HINGLISH_REFERENCES : REFERENCE_NAMES).join(', ')}.` }
    if (job.language === 'hi') {
      const source = await this.source(job)
      if ('problem' in source) return { status: 'error', job: job.ref, reason: source.problem }
      return { job: job.ref, ...hinglishReference(name, parseHinglish(job.stateJson), source.source) }
    }
    const stored = this.stored(job)
    const progress = parseProgress(job.stateJson)
    let input: NarrationInput | null = null
    if (currentStage(asPieces(stored), progress) !== 'notes' || /context|continuity/i.test(name)) {
      const found = await this.input(job)
      if ('input' in found && found.input) input = found.input
    }
    return { job: job.ref, ...reference(name, stored, progress, input) }
  }

  private async submit(id: string, args: Record<string, unknown>): Promise<BridgeData> {
    // Checked at every submission, so a chapter the phones finish meanwhile stops here, not at the save.
    const job = await this.dropIfSuperseded(await this.job(id))
    const head = await this.head(job)
    const refuse = (problem: string) => ({ status: 'rejected', ...head, problems: [problem] })
    if (job.state === 'queued' || job.state === 'preparing') return refuse('Studio is still uploading this chapter\'s pages to Google Drive.')
    if (job.state === 'saved') return { status: 'saved', ...head, note: 'This job is already saved.', ...this.next(job) }
    if (job.state === 'cancelled') return { status: 'cancelled', ...head, note: job.lastError ?? 'This job was replaced or stopped in Studio.', ...this.next(job) }
    if (job.state === 'failed' || job.state === 'attention') return { status: 'needs_attention', ...head, problems: job.lastError ? job.lastError.split('\n') : [], ...this.next(job) }
    if (job.language === 'hi') return this.submitHinglish(job, head, args)

    const stored = this.stored(job)
    const progress = parseProgress(job.stateJson)
    const pieces = asPieces(stored)
    const expected = currentStage(pieces, progress)
    if (expected === 'done') return this.finish(job.id)
    const stage = stageArg(args.stage) ?? expected
    let input: NarrationInput | null = null
    if (stage !== 'notes') {
      const found = await this.input(job)
      if ('reason' in found) return { status: 'waiting', ...head, stage, reason: found.reason, ...this.next(job) }
      input = found.input
    }
    const key = rejectionKey(stage, stored, progress)
    try {
      const result = accept(stage, contentText(args), stored, progress, input)
      const after = {
        ...result.progress, rejections: { ...result.progress.rejections, [key]: 0 },
        steps: [...(result.progress.steps ?? []), { key, at: this.now().toISOString(), rejected: progress.rejections[key] ?? 0 }]
      }
      const nextStage = currentStage(pieces, after)
      await this.prisma.geminiAppJob.update({ where: { id: job.id }, data: { state: 'working', stage: nextStage, stateJson: JSON.stringify(after), lastError: null } })
      if (nextStage === 'done') return this.finish(job.id)
      return {
        status: 'accepted', ...head, accepted: result.accepted, next_stage: nextStage,
        pieces_noted: Object.keys(after.notes).length, pieces_total: pieces.length
      }
    } catch (error) {
      if (!(error instanceof InvalidReply)) throw error
      return this.rejected(job, head, progress, key, stage, error)
    }
  }

  /** A refused submission: counted per stage key; the job stops for the user after MAX_REJECTIONS in a row. */
  private async rejected(job: GeminiAppJob, head: Record<string, unknown>, progress: { rejections: Record<string, number>; history?: RejectionRecord[] }, key: string, stage: string, error: Error): Promise<BridgeData> {
    const count = (progress.rejections[key] ?? 0) + 1
    const problems = error.message.split('\n').filter(Boolean)
    const stop = count >= MAX_REJECTIONS
    const history = [...(progress.history ?? []), { key, at: this.now().toISOString(), problems }].slice(-HISTORY_LIMIT)
    await this.prisma.geminiAppJob.update({
      where: { id: job.id },
      data: {
        stateJson: JSON.stringify({ ...progress, history, rejections: { ...progress.rejections, [key]: count } }),
        lastError: stop ? `Stopped after ${count} rejected ${stage} submissions. Last problems:\n${error.message}` : error.message,
        ...(stop && { state: 'attention', finishedAt: this.now() })
      }
    })
    if (stop) {
      this.log(`${job.ref}: needs attention at ${key}`)
      return { status: 'needs_attention', ...head, stage, problems, ...this.next(job) }
    }
    return { status: 'rejected', ...head, stage, problems, attempts_left: MAX_REJECTIONS - count }
  }

  // ─── Hinglish ───

  /** The English script the job is written from; a job whose source changed or went away stops for the user. */
  private async source(job: GeminiAppJob): Promise<{ source: EnglishSource } | { problem: string }> {
    const source = await this.narration.english(job.chapterId)
    if (!source) return { problem: 'The chapter has no English script any more. Start the chapter over in Studio.' }
    if (job.sourceSha256 && sha256(source.script.trim()) !== job.sourceSha256) return { problem: 'The English script changed after this Hinglish job started. Start the chapter over in Studio.' }
    return { source }
  }

  private async stopFor(job: GeminiAppJob, head: Record<string, unknown>, problem: string): Promise<BridgeData> {
    await this.prisma.geminiAppJob.update({ where: { id: job.id }, data: { state: 'attention', lastError: problem, finishedAt: this.now() } })
    return { status: 'needs_attention', ...head, problems: [problem], ...this.next(job) }
  }

  private async describeHinglish(job: GeminiAppJob, head: Record<string, unknown>): Promise<BridgeData> {
    const found = await this.source(job)
    if ('problem' in found) return this.stopFor(job, head, found.problem)
    const progress = parseHinglish(job.stateJson)
    if (hinglishStage(progress) === 'done') return this.serialized(job.id, () => this.finish(job.id))
    return { status: 'working', ...head, ...hinglishStageData(progress, found.source), ...(job.lastError && { last_problems: job.lastError.split('\n') }) }
  }

  private async submitHinglish(job: GeminiAppJob, head: Record<string, unknown>, args: Record<string, unknown>): Promise<BridgeData> {
    const found = await this.source(job)
    if ('problem' in found) return this.stopFor(job, head, found.problem)
    const progress = parseHinglish(job.stateJson)
    const expected = hinglishStage(progress)
    if (expected === 'done') return this.finish(job.id)
    const stage = hinglishStageArg(args.stage) ?? expected
    try {
      const accepted = acceptHinglish(stage, contentText(args), progress, found.source)
      const after = {
        ...accepted, rejections: { ...accepted.rejections, [stage]: 0 },
        steps: [...(accepted.steps ?? []), { key: stage, at: this.now().toISOString(), rejected: progress.rejections[stage] ?? 0 }]
      }
      const nextStage = hinglishStage(after)
      await this.prisma.geminiAppJob.update({ where: { id: job.id }, data: { state: 'working', stage: nextStage, stateJson: JSON.stringify(after), lastError: null } })
      if (nextStage === 'done') return this.finish(job.id)
      return { status: 'accepted', ...head, accepted: stage, next_stage: nextStage }
    } catch (error) {
      if (!(error instanceof InvalidReply)) throw error
      return this.rejected(job, head, progress, stage, stage, error)
    }
  }

  /** Saves the accepted script like Narration's Replace, then deletes the chapter's Drive folder. */
  private async finish(id: string): Promise<BridgeData> {
    const job = await this.job(id)
    const head = await this.head(job)
    if (job.state === 'saved') return { status: 'saved', ...head, ...this.next(job) }
    try {
      const result = job.language === 'hi'
        ? await this.narration.saveHinglish(job.chapterId, parseHinglish(job.stateJson).final!, job.scriptSha256, job.sourceSha256)
        : await this.narration.save(job.chapterId, output(this.stored(job), parseProgress(job.stateJson)), job.scriptSha256)
      const saved = await this.prisma.geminiAppJob.update({ where: { id: job.id }, data: { state: 'saved', stage: 'done', lastError: null, finishedAt: this.now() } })
      this.log(`${job.ref}: ${job.language === 'hi' ? 'Hinglish' : 'English'} script saved${result.phoneSent ? ' and sent to the phones' : ''}`)
      await this.deleteDriveFolder(saved)
      this.kick()
      return { status: 'saved', ...head, sent_to_phones: result.phoneSent, ...this.next(job) }
    } catch (error) {
      const problem = `Saving the script failed: ${message(error)}`
      await this.prisma.geminiAppJob.update({ where: { id: job.id }, data: { state: 'attention', lastError: problem, finishedAt: this.now() } })
      this.log(`${job.ref}: ${problem}`)
      return { status: 'needs_attention', ...head, problems: [problem], ...this.next(job) }
    }
  }
}
