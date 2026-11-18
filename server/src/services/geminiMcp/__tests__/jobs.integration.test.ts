import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { PrismaClient } from '@prisma/client'
import { memoryDriveStore } from '../../googleDrive/store.js'
import type { DriveApi, DriveFile } from '../../googleDrive/driveApi.js'
import { GEMINI_FOLDER, GeminiJobs, LOOKAHEAD, chapterTag, nextRunAt, type StoredPiece } from '../jobs.js'
import { masterPrompt, processPrompt } from '../prompts.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(here, '../../../..')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-jobs-'))
const dbUrl = `file:${path.join(tmp, 'test.db')}`
process.env.DOWNLOAD_ROOT = path.join(tmp, 'library')

/** Google Drive in memory: just what ensureFolder and the preparation worker use. */
class FakeDrive {
  files = new Map<string, DriveFile & { parentId: string; appProperties?: Record<string, string> }>()
  deleted: string[] = []
  private n = 0
  private id = () => `f${++this.n}`
  async generateIds(count: number) { return Array.from({ length: count }, () => this.id()) }
  async findFile(id: string) { return this.files.get(id) ?? null }
  async list(q: string) {
    const parent = /'([^']+)' in parents/.exec(q)?.[1]
    const kind = /key='studioKind' and value='([^']+)'/.exec(q)?.[1]
    return [...this.files.values()].filter(f => f.parentId === parent && (!kind || f.appProperties?.studioKind === kind))
  }
  async createFolder(meta: { id?: string; name: string; parentId: string; appProperties?: Record<string, string> }) {
    const file = { id: meta.id ?? this.id(), name: meta.name, mimeType: 'application/vnd.google-apps.folder', parents: [meta.parentId], parentId: meta.parentId, appProperties: meta.appProperties }
    this.files.set(file.id, file)
    return file
  }
  async upload(meta: { name: string; parentId: string; mimeType: string; appProperties?: Record<string, string> }, bytes: Buffer) {
    const file = { id: this.id(), name: meta.name, mimeType: meta.mimeType, size: String(bytes.length), parents: [meta.parentId], parentId: meta.parentId, appProperties: meta.appProperties }
    this.files.set(file.id, file)
    return file
  }
  async delete(id: string) {
    this.deleted.push(id)
    for (const f of [...this.files.values()]) if (f.parentId === id) this.files.delete(f.id)
    this.files.delete(id)
  }
  children(id: string) { return [...this.files.values()].filter(f => f.parentId === id) }
  byName(name: string) { return [...this.files.values()].find(f => f.name === name) }
}

let prisma: PrismaClient
let jobs: GeminiJobs
const drive = new FakeDrive()
const store = memoryDriveStore()
let seriesId = ''
const chapterIds: string[] = []

async function chapterFolder(number: number) {
  const folderPath = `Series A/Chapter ${String(number).padStart(3, '0')}`
  const dir = path.join(process.env.DOWNLOAD_ROOT!, folderPath)
  await fs.mkdir(dir, { recursive: true })
  // Taller than one piece, so each page becomes two.
  const block = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#000000' } }).png().toBuffer()
  await sharp({ create: { width: 400, height: 2500, channels: 3, background: '#ffffff' } }).composite([{ input: block, left: 100, top: 100 * number }]).png().toFile(path.join(dir, 'page_001.png'))
  return { folderPath, dir }
}

async function writeEnglish(chapterId: string, dir: string) {
  await fs.writeFile(path.join(dir, 'script.md'), 'He walked into the hall.\n')
  await prisma.chapterScript.upsert({
    where: { chapterId_language: { chapterId, language: 'en' } },
    create: { chapterId, language: 'en', status: 'done', rollingSummary: 'Summary.', closingParagraph: 'He walked into the hall.' },
    update: { status: 'done' }
  })
}

beforeAll(async () => {
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], { cwd: serverDir, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'ignore' })
  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
  const series = await prisma.series.create({ data: { title: 'Series A', sourceSite: 'test', rootFolder: 'Series A' } })
  seriesId = series.id
  for (const number of [1, 2, 3, 4, 5, 6]) {
    const { folderPath } = await chapterFolder(number)
    chapterIds.push((await prisma.chapter.create({ data: { seriesId, number, folderPath, status: 'done' } })).id)
  }
  jobs = new GeminiJobs({
    prisma,
    drive: () => ({ connection: async () => ({ id: 'conn', email: null }), api: () => drive as unknown as DriveApi, store }),
    workDir: path.join(tmp, 'work'),
    log: () => undefined
  })
}, 60_000)

afterAll(async () => {
  await prisma?.$disconnect()
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('Gemini MCP jobs', () => {
  let firstRef = ''
  let firstFolderId = ''

  it('lists chapters: each English chapter waits for the one before it; Hinglish waits for English', async () => {
    const { chapters } = await jobs.chapters(seriesId)
    expect(chapters.map(c => c.number)).toEqual([1, 2, 3, 4, 5, 6])
    expect(chapters[0].en).toMatchObject({ hasScript: false, job: null, blocked: null })
    expect(chapters[1].en.blocked).toBe('Chapter 1 needs its English script first.')
    expect(chapters[0].hi.blocked).toBe('Needs its English script first.')
    expect(chapters[0].pages).toBe(1) // counted on disk, not from Page rows
    await expect(jobs.process(chapterIds[1], 'en')).rejects.toThrow(/Chapter 1 needs its English script first/)
  })

  it('Process prepares a chapter: pieces with fresh codes in its own Drive folder, unique file names', async () => {
    const queued = await jobs.process(chapterIds[0], 'en')
    expect(queued.ref).toMatch(/^C001-EN-[A-Z0-9]{4}$/)
    expect(queued.driveFolderName).toBe(`Series A · Ch 1 · ${queued.ref.slice(-4)}`)
    await jobs.idle()
    const job = await jobs.job(queued.id)
    expect(job).toMatchObject({ state: 'ready', stage: 'notes', uploaded: 2, total: 2 })
    const pieces = JSON.parse(job.piecesJson) as StoredPiece[]
    expect(pieces.map(p => p.file)).toEqual(['C001-P0001-T001.jpg', 'C001-P0001-T002.jpg'])
    expect(pieces.every(p => /^[A-Z0-9]{4}$/.test(p.check))).toBe(true)

    const folder = drive.files.get(job.driveFolderId!)!
    expect(folder.name).toBe(job.driveFolderName)
    const parent = drive.files.get(folder.parentId)!
    expect(parent.name).toBe(GEMINI_FOLDER)
    expect(drive.files.get(parent.parentId)!.name).toBe('Manhwa Studio')
    expect(drive.children(folder.id).map(f => f.name).sort()).toEqual(['C001-P0001-T001.jpg', 'C001-P0001-T002.jpg'])
    firstRef = job.ref
    firstFolderId = job.driveFolderId!

    // The next chapter can now be processed: it will continue from this one.
    expect((await jobs.chapters(seriesId)).chapters[1].en.blocked).toBeNull()
  })

  it('get_job describes the job as data and Gemini starts working it', async () => {
    const reply = await jobs.bridge('get_job', { job_id: firstRef.toLowerCase() })
    expect(reply).toMatchObject({ status: 'working', job: firstRef, language: 'English', series: 'Series A', chapter: 1, stage: 'notes', batch: 1 })
    expect(reply.drive).toMatchObject({ folder: `Series A · Ch 1 · ${firstRef.slice(-4)}`, path: `My Drive/Manhwa Studio/${GEMINI_FOLDER}/Series A · Ch 1 · ${firstRef.slice(-4)}`, files: 2 })
    expect(await jobs.bridge('get_job', {})).toEqual({ status: 'none', note: 'No chapters are queued for Gemini.' })
    expect(await jobs.bridge('submit', { job: firstRef, stage: 'notes', content: '{}' })).toMatchObject({ status: 'rejected', job: firstRef, attempts_left: 3 })
    expect(await jobs.bridge('get_job', { job: 'C999-EN-AAAA' })).toMatchObject({ status: 'error' })
    expect((await jobs.job((await jobs.chapters(seriesId)).chapters[0].en.job!.id)).lastActivityAt).not.toBeNull()
  })

  it('Process again gives the same job; restart replaces it and deletes the old Drive folder', async () => {
    const again = await jobs.process(chapterIds[0], 'en')
    expect(again.ref).toBe(firstRef)
    const fresh = await jobs.process(chapterIds[0], 'en', { restart: true })
    expect(fresh.ref).not.toBe(firstRef)
    expect(drive.deleted).toContain(firstFolderId)
    expect(drive.files.has(firstFolderId)).toBe(false)
    expect(await jobs.bridge('get_job', { job: firstRef })).toMatchObject({ status: 'cancelled' })
    await jobs.idle()
    expect((await jobs.job(fresh.id)).state).toBe('ready')
  })

  it(`Master queues the remaining chapters in order and keeps ${LOOKAHEAD} uploaded ahead`, async () => {
    const { queued, skipped } = await jobs.master(seriesId, 'en')
    expect(skipped).toEqual([])
    // Chapter 1's own job (prepared with Process, not started) joins the queue first; 2–6 follow in chapter order.
    expect(queued.map(j => j.ref.slice(0, 4))).toEqual(['C001', 'C002', 'C003', 'C004', 'C005', 'C006'])
    expect(queued.map(j => j.queueOrder)).toEqual([1, 2, 3, 4, 5, 6])
    await prisma.geminiAppJob.update({ where: { id: queued[0].id }, data: { queueOrder: null } })
    queued.shift()
    await jobs.idle()
    const states = await Promise.all(queued.map(async j => (await jobs.job(j.id)).state))
    expect(states).toEqual(['ready', 'ready', 'ready', 'queued', 'queued'])
    // Without a job, get_job gives the first in the queue.
    expect(await jobs.bridge('get_job', {})).toMatchObject({ status: 'working', job: queued[0].ref, chapter: 2 })
    await jobs.idle() // claiming chapter 2 let chapter 5 upload

    // Process on a queued chapter takes it out of the queue and prepares it at once.
    const solo = await jobs.process(chapterIds[5], 'en')
    expect(solo.id).toBe(queued[4].id)
    expect(solo.queueOrder).toBeNull()
    await jobs.idle()
    expect((await jobs.job(solo.id)).state).toBe('ready')

    expect((await jobs.job(queued[3].id)).state).toBe('ready')
    await prisma.geminiAppJob.updateMany({ where: { id: { in: queued.slice(0, 3).map(j => j.id) } }, data: { state: 'saved' } })
  })

  it('Stop Master cancels the queued jobs Gemini has not started and deletes their folders', async () => {
    await jobs.idle()
    const before = (await jobs.chapters(seriesId)).chapters[4].en.job!
    expect(before.queueOrder).not.toBeNull()
    expect(await jobs.stopMaster(seriesId)).toBe(1)
    const after = await jobs.job(before.id)
    expect(after.state).toBe('cancelled')
    if (after.driveFolderId) expect(drive.files.has(after.driveFolderId)).toBe(false)
    expect(await jobs.bridge('get_job', {})).toMatchObject({ status: 'none' })
  })

  it('Hinglish is its own job: needs the English script, nothing uploaded, refuses to overwrite without Rewrite', async () => {
    await expect(jobs.process(chapterIds[0], 'hi')).rejects.toThrow(/needs its English script before the Hinglish/)
    const dir = path.join(process.env.DOWNLOAD_ROOT!, 'Series A/Chapter 001')
    await writeEnglish(chapterIds[0], dir)
    const hi = await jobs.process(chapterIds[0], 'hi')
    expect(hi).toMatchObject({ state: 'ready', stage: 'hi_scenes', driveFolderName: null, language: 'hi' })
    expect(hi.ref).toMatch(/^C001-HI-/)
    expect(hi.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
    const reply = await jobs.bridge('get_job', { job: hi.ref })
    expect(reply).toMatchObject({ status: 'working', language: 'Hinglish', stage: 'hi_scenes' })
    expect(reply.drive).toBeUndefined()

    await fs.writeFile(path.join(dir, 'script.hi.md'), 'वह हॉल में गया।\n')
    await expect(jobs.process(chapterIds[0], 'hi', { restart: true })).rejects.toThrow(/already has a Hinglish script/)
    const rewrite = await jobs.process(chapterIds[0], 'hi', { restart: true, rewrite: true })
    expect(rewrite.rewrite).toBe(true)
    expect(rewrite.scriptSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('after a restart, a cut-off upload starts over with fresh codes and its half-made folder is deleted', async () => {
    const job = (await jobs.chapters(seriesId)).chapters[1].en.job!
    const before = await jobs.job(job.id)
    await prisma.geminiAppJob.update({ where: { id: job.id }, data: { state: 'preparing', uploaded: 1 } })
    await jobs.init()
    await jobs.idle()
    const after = await jobs.job(job.id)
    expect(after.state).toBe('ready')
    expect(drive.files.has(before.driveFolderId!)).toBe(false)
    expect(after.driveFolderId).not.toBe(before.driveFolderId)
  })

  it('Gemini\'s preparation failure is shown on the job, not thrown', async () => {
    const failing = new GeminiJobs({
      prisma,
      drive: () => ({ connection: async () => { throw new Error('Connect Google Drive first.') }, api: () => drive as unknown as DriveApi, store }),
      workDir: path.join(tmp, 'work2'), log: () => undefined
    })
    const job = await failing.process(chapterIds[0], 'en', { restart: true, rewrite: true })
    await failing.idle()
    expect(await failing.job(job.id)).toMatchObject({ state: 'failed', lastError: 'Connect Google Drive first.' })
    expect(await failing.bridge('get_job', { job: job.ref })).toMatchObject({ status: 'needs_attention', problems: ['Connect Google Drive first.'] })
  })
})

describe('a chapter whose page images were deleted by hand', () => {
  it('is not offered for English (the database still says done), but Hinglish works from its English script', async () => {
    const series = await prisma.series.create({ data: { title: 'Series B', sourceSite: 'test', rootFolder: 'Series B' } })
    const dir = path.join(process.env.DOWNLOAD_ROOT!, 'Series B/Chapter 001')
    await fs.mkdir(dir, { recursive: true })
    const chapter = await prisma.chapter.create({ data: { seriesId: series.id, number: 1, folderPath: 'Series B/Chapter 001', status: 'done' } })
    await prisma.page.create({ data: { chapterId: chapter.id, index: 0, status: 'done' } })
    const row = (await jobs.chapters(series.id)).chapters[0]
    expect(row.pages).toBe(0)
    expect(row.en.blocked).toMatch(/Not downloaded/)
    await expect(jobs.process(chapter.id, 'en')).rejects.toThrow(/no downloaded pages/)
    expect((await jobs.seriesList()).some(s => s.id === series.id)).toBe(false)

    await writeEnglish(chapter.id, dir)
    expect((await jobs.chapters(series.id)).chapters[0].hi.blocked).toBeNull()
    expect((await jobs.seriesList()).find(s => s.id === series.id)).toMatchObject({ chapters: 1, english: 1, hinglish: 0 })
    expect(await jobs.process(chapter.id, 'hi')).toMatchObject({ state: 'ready', language: 'hi' })
  })
})

describe('English stages through the bridge', () => {
  const saved: { chapterId: string; script: string; audit: string; expected: string | null }[] = []
  let continuity: { reason: string } | null = null
  let english: GeminiJobs
  let chapterId = ''

  const reviewJson = (extra: Record<string, unknown> = {}) => JSON.stringify({
    passed: true, issues: [], corrections: [],
    paragraphs: [{ text: 'The boy walks into the hall.', images: ['P0001-T001'] }, { text: 'He sits down at the table.', images: ['P0001-T002'] }],
    nonStoryImages: [], summary: 'A boy walks in and sits down.', closing: 'He sits down at the table.', ...extra
  })

  beforeAll(async () => {
    english = new GeminiJobs({
      prisma,
      drive: () => ({ connection: async () => ({ id: 'conn', email: null }), api: () => drive as unknown as DriveApi, store }),
      workDir: path.join(tmp, 'work-en'), log: () => undefined,
      narration: {
        input: async () => continuity ?? { revision: 'r', seriesTitle: 'Series C', chapterNumber: '1', pages: [], requireAbout: false, about: 'A tale of a boy.', previous: null, scriptSha256: null },
        save: async (id, out, expected) => { saved.push({ chapterId: id, script: out.script, audit: out.audit, expected }); return { phoneSent: true } },
        english: async () => null,
        saveHinglish: async () => { throw new Error('not in this test') }
      }
    })
    const series = await prisma.series.create({ data: { title: 'Series C', sourceSite: 'test', rootFolder: 'Series C' } })
    const dir = path.join(process.env.DOWNLOAD_ROOT!, 'Series C/Chapter 001')
    await fs.mkdir(dir, { recursive: true })
    await fs.copyFile(path.join(process.env.DOWNLOAD_ROOT!, 'Series A/Chapter 001/page_001.png'), path.join(dir, 'page_001.png'))
    chapterId = (await prisma.chapter.create({ data: { seriesId: series.id, number: 1, folderPath: 'Series C/Chapter 001', status: 'done' } })).id
  })

  it('works a job from notes to a saved script, checking every stage', async () => {
    const job = await english.process(chapterId, 'en')
    await english.idle()
    const pieces = JSON.parse((await english.job(job.id)).piecesJson) as StoredPiece[]
    expect(pieces[0]).toMatchObject({ parts: 2, top: 0 })
    const folderId = (await english.job(job.id)).driveFolderId!

    const first = await english.bridge('get_job', { job: job.ref })
    expect(first).toMatchObject({ status: 'working', stage: 'notes', batch: 1, batches: 1, pieces_total: 2 })
    expect((first.files as { file: string }[]).map(f => f.file)).toEqual(['C001-P0001-T001.jpg', 'C001-P0001-T002.jpg'])
    expect(first.rules).toContain('CHECK')
    expect(first.nextRunAt).toBeUndefined() // a Process job schedules nothing
    expect((await english.job(job.id)).state).toBe('working')

    const note = (p: StoredPiece, code = p.check) => ({ id: p.id, checkCode: code, opening: 'A boy appears.', events: ['A boy walks.'], printed_text: ['Hello'], closing: 'He stops.' })
    const wrong = await english.bridge('submit', { job: job.ref, stage: 'Notes batch 1', content: { pieces: [note(pieces[0], 'ZZZZ'), note(pieces[1])] } })
    expect(wrong).toMatchObject({ status: 'rejected', stage: 'notes', attempts_left: 3 })
    expect(String((wrong.problems as string[])[0])).toMatch(/check code for P0001-T001 is wrong/)
    expect((await english.bridge('get_job', { job: job.ref })).last_problems).toBeDefined()

    // Gemini's own names (checkCode, printed_text, no nonStory/uncertainties) are mapped; content may be an object.
    expect(await english.bridge('submit', { job: job.ref, stage: 'notes', content: { pieces: pieces.map(p => note(p)) } }))
      .toMatchObject({ status: 'accepted', accepted: 'notes for P0001-T001–P0001-T002', next_stage: 'draft', pieces_noted: 2 })

    const draftJob = await english.bridge('get_job', { job: job.ref })
    expect(draftJob).toMatchObject({ status: 'working', stage: 'draft', references: ['notes'] })
    expect(draftJob.rules).toContain('"Series C" Chapter 1')
    expect(draftJob.content_format).toContain('===SCRIPT===')
    expect(await english.bridge('get_reference', { job: job.ref, name: 'notes' })).toMatchObject({ name: 'notes', pieces_noted: 2 })
    expect(await english.bridge('get_reference', { job: job.ref, name: 'draft' })).toMatchObject({ status: 'error' })

    expect(await english.bridge('submit', { job: job.ref, stage: 'draft', content: { script: 'The boy walks into the hall.\n\nHe sits down at the table.', summary: 'A boy walks in.', closing: 'He sits down at the table.' } }))
      .toMatchObject({ status: 'accepted', next_stage: 'review' })
    expect(await english.bridge('submit', { job: job.ref, stage: 'notes', content: '{}' })).toMatchObject({ status: 'rejected', problems: ['The notes stage is already accepted. The current stage is review.'] })

    // A name that is printed nowhere is refused.
    const named = await english.bridge('submit', { job: job.ref, stage: 'review', content: reviewJson({ paragraphs: [{ text: 'The boy Kaito walks into the hall.', images: ['P0001-T001'] }, { text: 'He sits down at the table.', images: ['P0001-T002'] }] }) })
    expect(named).toMatchObject({ status: 'rejected' })
    expect(String((named.problems as string[])[0])).toMatch(/Kaito/)
    expect(await english.bridge('submit', { job: job.ref, stage: 'review', content: reviewJson() })).toMatchObject({ status: 'accepted', next_stage: 'check' })
    expect((await english.bridge('get_job', { job: job.ref })).references).toEqual(['review'])

    // Narrator commentary like the first pilot's "his name is revealed" is refused at the final check.
    const meta = await english.bridge('submit', { job: job.ref, stage: 'check', content: reviewJson({ corrections: ['x'], paragraphs: [{ text: 'The boy walks into the hall, and his name is revealed.', images: ['P0001-T001'] }, { text: 'He sits down at the table.', images: ['P0001-T002'] }] }) })
    expect(String((meta.problems as string[])[0])).toMatch(/his name is revealed/)
    const done = await english.bridge('submit', { job: job.ref, stage: 'final check', content: JSON.parse(reviewJson()) })
    expect(done).toMatchObject({ status: 'saved', sent_to_phones: true })
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ chapterId, script: 'The boy walks into the hall.\n\nHe sits down at the table.', expected: null })
    expect(JSON.parse(saved[0].audit)).toMatchObject({ inputMode: 'gemini-app-drive-pieces-2000/1', attach: expect.stringContaining('Gemini Mac app') })
    expect(await english.job(job.id)).toMatchObject({ state: 'saved', stage: 'done' })
    const view = (await english.chapters((await english.job(job.id)).seriesId)).chapters[0].en.job!
    expect(view.timing).toMatchObject({ startedAt: expect.any(String), seconds: expect.any(Number), rejected: 3, steps: 4 })
    expect(drive.files.has(folderId)).toBe(false)
    expect(await english.bridge('get_job', { job: job.ref })).toMatchObject({ status: 'saved' })
  })

  it('stops for the user after 4 rejected submissions at one stage', async () => {
    const job = await english.process(chapterId, 'en', { restart: true, rewrite: true })
    await english.idle()
    for (let i = 1; i <= 3; i++) expect(await english.bridge('submit', { job: job.ref, stage: 'notes', content: '{"pieces":[]}' })).toMatchObject({ status: 'rejected', attempts_left: 4 - i })
    expect(await english.bridge('submit', { job: job.ref, stage: 'notes', content: '{"pieces":[]}' })).toMatchObject({ status: 'needs_attention' })
    expect(await english.job(job.id)).toMatchObject({ state: 'attention', lastError: expect.stringContaining('Stopped after 4 rejected notes submissions') })

    // A stopped chapter of the Master queue pauses it instead of letting the chain skip ahead.
    await prisma.geminiAppJob.update({ where: { id: job.id }, data: { queueOrder: 0 } })
    expect(await english.bridge('get_job', {})).toMatchObject({ status: 'none', paused_at: job.ref })

    // The log keeps every refusal; Retry keeps the job and gives the step fresh attempts.
    const log = await english.history(job.id)
    expect(log.rejections).toHaveLength(4)
    expect(log.rejections[0]).toMatchObject({ key: 'notes:1', problems: [expect.stringContaining('exactly one entry')] })
    const retried = await english.retry(job.id)
    expect(retried).toMatchObject({ id: job.id, state: 'working', lastError: null })
    expect(await english.bridge('submit', { job: job.ref, stage: 'notes', content: '{"pieces":[]}' })).toMatchObject({ status: 'rejected', attempts_left: 3 })
    expect((await english.history(job.id)).rejections).toHaveLength(5)
    await prisma.geminiAppJob.update({ where: { id: job.id }, data: { queueOrder: null } })
    await expect(english.retry(job.id)).rejects.toThrow(/Only a job that needs attention/)
  })

  it('Drive cleanup deletes folders no current job uses and keeps the rest', async () => {
    const parent = drive.byName(GEMINI_FOLDER)!
    const orphan = await drive.createFolder({ name: 'Leftover · Ch 9 · ZZZZ', parentId: parent.id })
    const live = (await prisma.geminiAppJob.findMany({ where: { state: { in: ['ready', 'working', 'attention'] }, driveFolderId: { not: null }, driveDeletedAt: null } })).map(j => j.driveFolderId!)
    const before = drive.children(parent.id).length
    const result = await english.cleanupDrive()
    expect(result.deleted).toContain('Leftover · Ch 9 · ZZZZ')
    expect(drive.files.has(orphan.id)).toBe(false)
    for (const id of live) expect(drive.files.has(id)).toBe(true)
    expect(result.kept).toBe(before - result.deleted.length)
  })

  it('waits when the previous chapter has no summary yet', async () => {
    const job = await english.process(chapterId, 'en', { restart: true, rewrite: true })
    await english.idle()
    const pieces = JSON.parse((await english.job(job.id)).piecesJson) as StoredPiece[]
    await english.bridge('submit', { job: job.ref, stage: 'notes', content: { pieces: pieces.map(p => ({ id: p.id, check: p.check, opening: 'a', events: ['b'], text: [], closing: 'c', nonStory: false, uncertainties: [] })) } })
    continuity = { reason: 'Chapter 0 needs its English script (with its summary) first.' }
    expect(await english.bridge('get_job', { job: job.ref })).toMatchObject({ status: 'waiting', stage: 'draft', reason: expect.stringContaining('Chapter 0') })
    continuity = null
    expect(await english.bridge('get_job', { job: job.ref })).toMatchObject({ status: 'working', stage: 'draft' })
  })
})

describe('Hinglish stages through the bridge', () => {
  const ENGLISH = 'The boy walks into the old hall today.\n\nHe sits down at the long wooden table.\n'
  const SCENES = '===SCENES===\n[SCENE 1: P1-P2]\n- लड़का हॉल में आता है और टेबल पर बैठता है।'
  const HINGLISH = '===SCRIPT===\n[SCENE 1: P1-P2]\nलड़का आज पुराने हॉल में अंदर आता है और चारों तरफ देखता है।\n\nफिर वो लंबी लकड़ी की टेबल पर आराम से बैठ जाता है।\n\n===SUMMARY===\nएक लड़का हॉल में आकर टेबल पर बैठता है।'
  const savedHi: { text: string; expected: string | null; source: string | null }[] = []
  let hindi: GeminiJobs
  let chapterId = ''
  let dir = ''

  beforeAll(async () => {
    const series = await prisma.series.create({ data: { title: 'Series D', sourceSite: 'test', rootFolder: 'Series D' } })
    dir = path.join(process.env.DOWNLOAD_ROOT!, 'Series D/Chapter 001')
    await fs.mkdir(dir, { recursive: true })
    chapterId = (await prisma.chapter.create({ data: { seriesId: series.id, number: 1, folderPath: 'Series D/Chapter 001', status: 'done' } })).id
    await fs.writeFile(path.join(dir, 'script.md'), ENGLISH)
    await prisma.chapterScript.create({ data: { chapterId, language: 'en', status: 'done', rollingSummary: 'A boy sits down.', closingParagraph: 'He sits down at the long wooden table.' } })
    hindi = new GeminiJobs({
      prisma,
      drive: () => ({ connection: async () => ({ id: 'conn', email: null }), api: () => drive as unknown as DriveApi, store }),
      workDir: path.join(tmp, 'work-hi'), log: () => undefined,
      narration: {
        input: async () => ({ reason: 'not in this test' }),
        save: async () => { throw new Error('not in this test') },
        english: async () => ({ script: await fs.readFile(path.join(dir, 'script.md'), 'utf8'), summary: 'A boy sits down.' }),
        saveHinglish: async (_id, text, expected, source) => { savedHi.push({ text, expected, source }); return { phoneSent: true } }
      }
    })
  })

  it('works scene notes → Hinglish → final check, checked as the save checks it, then saves', async () => {
    const job = await hindi.process(chapterId, 'hi')
    expect(job.sourceSha256).toBe(crypto.createHash('sha256').update(ENGLISH.trim()).digest('hex'))
    const first = await hindi.bridge('get_job', { job: job.ref })
    expect(first).toMatchObject({ status: 'working', language: 'Hinglish', stage: 'hi_scenes', references: ['english'], english_paragraphs: 2, english_words: 16, hinglish_words_min: 14, hinglish_words_max: 40 })
    expect(first.rules).toContain('HINGLISH')
    expect(first.drive).toBeUndefined()
    expect(await hindi.bridge('get_reference', { job: job.ref, name: 'english' })).toMatchObject({ paragraphs: 2, story_script: expect.stringContaining('[P2] He sits down'), story_summary: 'A boy sits down.' })

    const gap = await hindi.bridge('submit', { job: job.ref, stage: 'scenes', content: '===SCENES===\n[SCENE 1: P1-P1]\n- नोट' })
    expect(gap).toMatchObject({ status: 'rejected', attempts_left: 3 })
    expect(String((gap.problems as string[])[0])).toMatch(/up to P2/)
    expect(await hindi.bridge('submit', { job: job.ref, stage: 'scene notes', content: SCENES })).toMatchObject({ status: 'accepted', next_stage: 'hi_script' })
    expect(await hindi.bridge('get_reference', { job: job.ref, name: 'scenes' })).toMatchObject({ scenes: SCENES })

    const latin = await hindi.bridge('submit', { job: job.ref, stage: 'hinglish script', content: HINGLISH.replace('टेबल', 'table') })
    expect(String((latin.problems as string[])[0])).toMatch(/Devanagari/)
    const short = await hindi.bridge('submit', { job: job.ref, stage: 'hi_script', content: '===SCRIPT===\n[SCENE 1: P1-P2]\nलड़का बैठता है।\n\n===SUMMARY===\nलड़का।' })
    // The phone's checks, all at once: the scene cut short, then the chapter length.
    expect(short.problems).toEqual([expect.stringMatching(/^Too short: P1-P2 \(3 words, the English has \d+\)$/), expect.stringMatching(/has 3 words; it must be between 14 and 40/)])
    expect(await hindi.bridge('submit', { job: job.ref, stage: 'hi_script', content: HINGLISH })).toMatchObject({ status: 'accepted', next_stage: 'hi_check' })
    expect(await hindi.bridge('get_job', { job: job.ref })).toMatchObject({ stage: 'hi_check', references: ['english', 'hinglish'] })

    expect(await hindi.bridge('submit', { job: job.ref, stage: 'final check', content: HINGLISH })).toMatchObject({ status: 'saved', sent_to_phones: true })
    expect(savedHi).toEqual([{ text: HINGLISH, expected: null, source: job.sourceSha256 }])
    const view = (await hindi.chapters((await hindi.job(job.id)).seriesId)).chapters[0].hi.job!
    expect(view).toMatchObject({ state: 'saved', timing: { rejected: 3, steps: 3 } })
  })

  it('stops when the English script changes after the job started', async () => {
    await fs.rm(path.join(dir, 'script.hi.md'), { force: true })
    const job = await hindi.process(chapterId, 'hi', { restart: true })
    await fs.writeFile(path.join(dir, 'script.md'), ENGLISH + '\nA new line.\n')
    expect(await hindi.bridge('get_job', { job: job.ref })).toMatchObject({ status: 'needs_attention', problems: [expect.stringContaining('English script changed')] })
    expect((await hindi.job(job.id)).state).toBe('attention')
  })
})

describe('the Master queue and scripts written another way', () => {
  const made: Record<string, { seriesId: string; chapters: { id: string; dir: string }[] }> = {}

  async function seriesWithEnglish(title: string, numbers: number[]) {
    const series = made[title] ?? (made[title] = { seriesId: (await prisma.series.create({ data: { title, sourceSite: 'test', rootFolder: title } })).id, chapters: [] })
    for (const number of numbers) {
      const folderPath = `${title}/Chapter ${String(number).padStart(3, '0')}`
      const dir = path.join(process.env.DOWNLOAD_ROOT!, folderPath)
      await fs.mkdir(dir, { recursive: true })
      const id = (await prisma.chapter.create({ data: { seriesId: series.seriesId, number, folderPath, status: 'done' } })).id
      await writeEnglish(id, dir)
      series.chapters.push({ id, dir })
    }
    return series
  }
  /** The phones (or AntiGravity) wrote the chapter's Hinglish while its Gemini job was waiting. */
  async function hinglishFromElsewhere(chapter: { id: string; dir: string }) {
    await fs.writeFile(path.join(chapter.dir, 'script.hi.md'), 'वह हॉल में गया।\n')
    await prisma.chapterScript.create({ data: { chapterId: chapter.id, language: 'hi', status: 'done' } })
  }

  beforeAll(async () => {
    // Whatever the earlier tests left in the queue.
    await prisma.geminiAppJob.updateMany({ where: { state: { notIn: ['saved', 'cancelled'] } }, data: { state: 'cancelled' } })
  })

  it('get_job never hands out a chapter that already has its script: the next one without a script is next', async () => {
    const e = await seriesWithEnglish('Series E', [1, 2, 3])
    const { queued } = await jobs.master(e.seriesId, 'hi')
    expect(queued.map(j => j.queueOrder)).toEqual([1, 2, 3])

    await hinglishFromElsewhere(e.chapters[0])
    expect(await jobs.bridge('get_job', {})).toMatchObject({ status: 'working', job: queued[1].ref, chapter: 2 })
    expect(await jobs.job(queued[0].id)).toMatchObject({ state: 'cancelled', lastError: 'Chapter 1 got its Hinglish script another way after this job was made.' })
    // Asked for by name, it says so instead of starting.
    expect(await jobs.bridge('get_job', { job: queued[0].ref })).toMatchObject({ status: 'cancelled', note: expect.stringContaining('got its Hinglish script another way') })

    // Also while Gemini is in the middle of a chapter: the submission is not checked, and the queue moves on.
    await hinglishFromElsewhere(e.chapters[1])
    expect(await jobs.bridge('submit', { job: queued[1].ref, stage: 'hi_scenes', content: 'x' })).toMatchObject({ status: 'cancelled', nextRunAt: expect.any(String) })
    expect(await jobs.bridge('get_job', {})).toMatchObject({ status: 'working', job: queued[2].ref, chapter: 3 })

    // The lists no longer show the dropped jobs.
    const rows = (await jobs.chapters(e.seriesId)).chapters
    expect(rows.map(r => [r.hi.hasScript, r.hi.job?.state ?? null])).toEqual([[true, null], [true, null], [false, 'working']])
  })

  it('a job waiting in the lists is dropped when its chapter gets a script, before anything is uploaded or queued again', async () => {
    const g = await seriesWithEnglish('Series G', [1, 2])
    const { queued } = await jobs.master(g.seriesId, 'hi')
    await hinglishFromElsewhere(g.chapters[0])
    await jobs.seriesList()
    expect((await jobs.job(queued[0].id)).state).toBe('cancelled')
    // Master again queues nothing new for it and leaves chapter 2 where it was.
    const again = await jobs.master(g.seriesId, 'hi')
    expect(again.queued).toEqual([])

    // A stopped chapter pauses the queue only while it still lacks its script.
    await prisma.geminiAppJob.update({ where: { id: queued[1].id }, data: { state: 'failed', lastError: 'Stopped.' } })
    expect(await jobs.bridge('get_job', {})).toMatchObject({ status: 'none', paused_at: queued[1].ref })
    await hinglishFromElsewhere(g.chapters[1])
    expect(await jobs.bridge('get_job', {})).not.toHaveProperty('paused_at')
    expect((await jobs.job(queued[1].id)).state).toBe('cancelled')
  })

  it('Master puts the series just asked for at the front of the queue, in chapter order', async () => {
    const e = made['Series E']
    const f = await seriesWithEnglish('Series F', [1, 2])
    const first = await jobs.master(f.seriesId, 'hi')
    expect(first.queued.map(j => j.queueOrder)).toEqual([1, 2])
    const waiting = (await jobs.chapters(e.seriesId)).chapters[2].hi.job!
    expect(waiting.queueOrder).toBe(3) // Series E's chapter 3 now comes after Series F
    expect(await jobs.bridge('get_job', {})).toMatchObject({ job: first.queued[0].ref, series: 'Series F', chapter: 1 })

    // "Queue the rest": a later chapter joins behind its own series' queued chapters, still ahead of other series.
    await seriesWithEnglish('Series F', [3])
    const rest = await jobs.master(f.seriesId, 'hi')
    expect(rest.queued.map(j => [j.ref.slice(0, 4), j.queueOrder])).toEqual([['C003', 3]])
    expect((await jobs.chapters(f.seriesId)).chapters.map(c => c.hi.job!.queueOrder)).toEqual([1, 2, 3])
    expect((await jobs.chapters(e.seriesId)).chapters[2].hi.job!.queueOrder).toBe(4)
  })
})

describe('helpers and prompts', () => {
  it('chapter tags and next run time', () => {
    expect(chapterTag(12)).toBe('C012')
    expect(chapterTag(12.5)).toBe('C012.5')
    expect(chapterTag(1234)).toBe('C1234')
    const at = nextRunAt(new Date(2026, 10, 12, 14, 0, 31))
    expect(at).toMatch(/^2026-11-12 14:04 \(/)
    expect(nextRunAt(new Date(2026, 10, 12, 14, 0, 0))).toMatch(/^2026-11-12 14:03 \(/)
  })

  it('the prompts carry the procedure; tool replies never do', () => {
    const en = processPrompt({ ref: 'C012-EN-K7QM', language: 'en', seriesTitle: 'Series A', chapterNumber: 12, driveFolderName: 'Series A · Ch 12 · K7QM' })
    expect(en).toMatch(/^@Manhwa Studio Job C012-EN-K7QM: write the English narration script for Series A, chapter 12\./)
    expect(en).toContain('Call get_job with job "C012-EN-K7QM"')
    expect(en).toContain('"Series A · Ch 12 · K7QM"')
    const hi = processPrompt({ ref: 'C012-HI-K7QM', language: 'hi', seriesTitle: 'Series A', chapterNumber: 12, driveFolderName: null })
    expect(hi).toContain('Hinglish')
    expect(hi).not.toContain('Google Drive')
    const master = masterPrompt()
    expect(master).toContain('Call get_job without a job.')
    expect(master).toContain('"none"')
    expect(master).toContain('word for word')
    expect(master).toContain('destructiveHint false')
  })
})
