/**
 * Phase 6 evidence (PRD §13.3, §13.4, §20 Phase 6): the real job runner, a real
 * SQLite database, the real MCP bridge over loopback HTTP, Drive through
 * FakeGoogle, and a fake `agy` (fixtures/fake-agy.mjs) that talks to the bridge
 * exactly like the model does.
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DriveApi } from '../../googleDrive/driveApi.js'
import { FakeGoogle } from '../../googleDrive/__tests__/fakeGoogle.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(here, '../../../..')
const FAKE_AGY = path.join(here, 'fixtures', 'fake-agy.mjs')
const FAKE_CODEX = path.join(here, 'fixtures', 'fake-codex.mjs')
const FAKE_CLAUDE = path.join(here, 'fixtures', 'fake-claude.mjs')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-jobs-'))
const dbUrl = `file:${path.join(tmp, 'test.db')}`
process.env.DOWNLOAD_ROOT = path.join(tmp, 'library')
process.env.FAKE_AGY_PLAN = path.join(tmp, 'plan.json')
process.env.FAKE_AGY_LOG = path.join(tmp, 'agy.log')
process.env.CODEX_HOME = path.join(tmp, 'codex-home')
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude-home')
const claudeUsage: unknown[][] = []

type Jobs = import('../jobs.js').AntigravityJobs
let accounts: import('../codexAccounts.js').CodexAccountStore
let prisma: PrismaClient
let jobs: Jobs
let server: http.Server
let seriesId = ''
const chapterIds: string[] = []
const published: string[] = []
const redoRequests: { revision: string; deviceId: string | null; page: string }[] = []
let publishFailures = 0
let settingsOver: Record<string, unknown> = {}
let google: FakeGoogle

/** One block of ink per page, at a different place on each page, so results can't be confused. */
const BLOCKS: Record<string, { x0: number; y0: number; x1: number; y1: number }> = {
  page_001: { x0: 40, y0: 200, x1: 360, y1: 700 },
  page_002: { x0: 60, y0: 1200, x1: 340, y1: 2300 }, // crosses the 2000 px slice seam
  page_003: { x0: 20, y0: 400, x1: 380, y1: 900 },
  page_004: { x0: 80, y0: 100, x1: 320, y1: 500 },
  page_005: { x0: 50, y0: 600, x1: 350, y1: 1100 },
  page_006: { x0: 30, y0: 300, x1: 370, y1: 800 },
  page_007: { x0: 50, y0: 1700, x1: 350, y1: 2300 } // four-step flow; crosses the 2000 px slice seam
}
const MARGIN = 10
const cropBox = (stem: string) => { const b = BLOCKS[stem]; return { x0: b.x0 - MARGIN, y0: b.y0 - MARGIN, x1: b.x1 + MARGIN, y1: b.y1 + MARGIN } }

async function makePage(folder: string, stem: string) {
  const b = BLOCKS[stem]
  const dir = path.join(process.env.DOWNLOAD_ROOT!, folder)
  await fs.mkdir(dir, { recursive: true })
  const block = await sharp({ create: { width: b.x1 - b.x0, height: b.y1 - b.y0, channels: 3, background: '#000000' } }).png().toBuffer()
  await sharp({ create: { width: 400, height: 2500, channels: 3, background: '#ffffff' } }).composite([{ input: block, left: b.x0, top: b.y0 }]).png().toFile(path.join(dir, `${stem}.png`))
}

async function writePlan(plan: Record<string, Record<string, unknown>>) {
  const full: Record<string, unknown> = {}
  for (const stem of Object.keys(BLOCKS)) full[stem] = { box: cropBox(stem), ...(plan[stem] ?? {}) }
  await fs.writeFile(process.env.FAKE_AGY_PLAN!, JSON.stringify(full))
}

async function agyLog(): Promise<any[]> {
  const text = await fs.readFile(process.env.FAKE_AGY_LOG!, 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l))
}

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 100))
  }
}

const runDone = (runId: string) => until(`run ${runId} to finish`, async () => {
  const run = await prisma.antigravityRun.findUnique({ where: { id: runId } })
  return run && ['completed', 'completed_with_errors', 'paused', 'stopped'].includes(run.control) ? run : null
}, 30_000)

beforeAll(async () => {
  await fs.writeFile(path.join(tmp, 'test.db'), '')
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], { cwd: serverDir, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'ignore' })
  await fs.chmod(FAKE_AGY, 0o755)
  await fs.chmod(FAKE_CODEX, 0o755)
  await fs.chmod(FAKE_CLAUDE, 0o755)
  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

  const series = await prisma.series.create({ data: { title: 'Series A', sourceSite: 'test', rootFolder: 'Series A' } })
  seriesId = series.id
  for (const [number, stems] of [[1, ['page_001', 'page_002', 'page_003', 'page_005', 'page_006']], [2, ['page_004']]] as const) {
    const folderPath = `Series A/Chapter 00${number}`
    for (const stem of stems) await makePage(folderPath, stem)
    chapterIds.push((await prisma.chapter.create({ data: { seriesId, number, folderPath, status: 'done' } })).id)
  }

  google = new FakeGoogle()
  google.accessTokens.set('ya29.test', 'alice')
  const api = new DriveApi({ fetch: google.fetch as typeof fetch, token: async () => 'ya29.test', sleep: async () => undefined })
  const connection = await prisma.driveConnection.create({ data: { clientId: 'c', googleSubject: '1111', email: 'alice@example.com', scopes: 'drive.file', secretRef: 'ref', active: true, status: 'connected' } })

  const { AntigravityJobs } = await import('../jobs.js')
  const { CodexAccountStore } = await import('../codexAccounts.js')
  accounts = new CodexAccountStore({ prisma, root: path.join(tmp, 'codex-accounts'), defaultHome: process.env.CODEX_HOME })
  const { PromptStore } = await import('../prompts.js')
  const prompts = new PromptStore(prisma)
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', async () => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      const input = body ? JSON.parse(body) : {}
      const out = req.url?.endsWith('/tools') ? { tools: await jobs.tools(token) } : await jobs.call(token, { tool: String(input.tool), arguments: input.arguments ?? {}, conversationId: input.conversationId ?? null })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(out))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port

  jobs = new AntigravityJobs({
    prisma,
    drive: { requireActiveConnection: async () => connection, api: () => api } as any,
    port,
    attemptRoot: path.join(tmp, 'attempts'),
    codexHome: process.env.CODEX_HOME,
    codexAccounts: accounts,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    claudeUsage: { record: async limits => void claudeUsage.push(limits) },
    settings: async () => ({ model: 'fake-model', modelLabel: 'Fake', effort: null, sandbox: false, concurrency: 2, pageTimeoutMinutes: 2, executable: FAKE_AGY, cliVersion: 'fake-1', ...settingsOver } as any),
    prompts: () => prompts.pack(),
    pinnedPrompts: async ids => {
      const texts: Record<string, string> = {}
      const hashes: Record<string, string> = {}
      for (const kind of ['crop_rules', 'analysis', 'review']) {
        const row = await prompts.version(ids[kind])
        if (!row) return null
        texts[kind] = row.content
        hashes[kind] = row.sha256
      }
      return { ids, hashes, texts } as any
    },
    // The real Clipper rejection; only its R2 delivery is recorded instead of sent.
    rejectSource: async page => {
      const { rejectPage } = await import('../../clipper3/pageRedo.js')
      return rejectPage({ folderPath: page.folderPath, filename: page.filename, chapterNumber: 1, seriesSlug: 'series-a', deviceId: null, restartRevision: null, pageRevision: null },
        async request => { redoRequests.push({ revision: request.revision, deviceId: request.deviceId, page: request.page }) })
    },
    publisher: {
      publish: async (jobId: string) => {
        if (publishFailures > 0) { publishFailures--; throw new Error('R2 unavailable (test)') }
        published.push(jobId)
        return { state: 'published', key: `k/${jobId}`, destination: 'r2:test/' }
      }
    } as any
  })
}, 60_000)

beforeEach(async () => {
  settingsOver = {}
  publishFailures = 0
  await fs.rm(process.env.FAKE_AGY_LOG!, { force: true })
})

afterAll(async () => {
  await jobs?.shutdown()
  server?.close()
  await prisma?.$disconnect()
  await fs.rm(tmp, { recursive: true, force: true })
})

const pages = (chapter: number, ...stems: string[]) => stems.map(stem => ({ chapterId: chapterIds[chapter - 1], filename: `${stem}.png` }))
const jobFor = (runId: string, stem: string) => prisma.antigravityPageJob.findFirstOrThrow({ where: { runId, filename: `${stem}.png` } })
async function savedTop(chapter: number, stem: string) {
  const text = await fs.readFile(path.join(process.env.DOWNLOAD_ROOT!, `Series A/Chapter 00${chapter}`, 'crop_points3', `${stem}.json`), 'utf8').catch(() => null)
  if (!text) return null
  const file = JSON.parse(text)
  return Math.round(file.crops[0].crop.points[0].y * file.image.height)
}

describe('AntiGravity jobs end to end (Phase 6)', () => {
  it('runs two pages in parallel across two chapters, out of order, with isolated conversations and results', async () => {
    await writePlan({ page_001: { delayMs: 4000 }, page_002: { delayMs: 50 }, page_004: { delayMs: 300 } })
    const start = await jobs.start({ seriesId, partNumber: 1, pages: [...pages(1, 'page_001', 'page_002'), ...pages(2, 'page_004')], prepareOnly: false })
    const run = await runDone(start.runId!)
    const all = await prisma.antigravityPageJob.findMany({ where: { runId: start.runId! } })
    expect(all.map(j => [j.filename, j.stage, j.lastError])).toEqual(expect.arrayContaining([
      ['page_001.png', 'ready_for_human_review', null], ['page_002.png', 'ready_for_human_review', null], ['page_004.png', 'ready_for_human_review', null]
    ]))
    expect(run.control).toBe('completed')

    // Each page got its own geometry back (the seam-crossing page included).
    expect(await savedTop(1, 'page_001')).toBe(cropBox('page_001').y0)
    expect(await savedTop(1, 'page_002')).toBe(cropBox('page_002').y0)
    expect(await savedTop(2, 'page_004')).toBe(cropBox('page_004').y0)

    // Isolation: one conversation, workspace and capability per page; review stayed in the page's own conversation.
    const attempts = await prisma.antigravityAttempt.findMany({ where: { jobId: { in: all.map(j => j.id) } } })
    expect(new Set(attempts.map(a => a.conversationId)).size).toBe(3)
    expect(new Set(attempts.map(a => a.workspace)).size).toBe(3)
    expect(new Set(attempts.map(a => a.capabilityHash)).size).toBe(3)
    const log = await agyLog()
    for (const a of attempts) {
      const stem = all.find(j => j.id === a.jobId)!.filename.replace('.png', '')
      expect(new Set(log.filter(e => e.stem === stem).map(e => e.conv))).toEqual(new Set([a.conversationId]))
    }

    // Parallel, bounded at 2, and out of order: page_002 finished while page_001 was still analyzing.
    const starts = log.filter(e => e.event === 'start' && e.turn === 'analysis')
    const ends = log.filter(e => e.event === 'end')
    let peak = 0
    for (const t of log.map(e => e.at)) peak = Math.max(peak, new Set(log.filter(e => e.event === 'start' && e.at <= t && !ends.some(x => x.pid === e.pid && x.at < t)).map(e => e.pid)).size)
    expect(peak).toBe(2)
    expect(starts.length).toBe(3)
    // Out of order: whichever of the two concurrent pages was fast submitted its analysis while the slow one was still working.
    const concurrent = starts.slice(0, 2).map(e => e.stem)
    const submitted = (stem: string) => log.find(e => e.stem === stem && e.event === 'submit_analysis')!.at
    expect(concurrent).toContain('page_001') // page_001 is first in chapter order, whichever chapter sorts first
    const fast = concurrent.find(s => s !== 'page_001')!
    expect(submitted(fast)).toBeLessThan(submitted('page_001'))
    expect(published).toEqual(expect.arrayContaining(all.map(j => j.id)))
  }, 40_000)

  it('Stop revokes the attempt: no import, no publication, and a late tool call cannot commit', async () => {
    await writePlan({ page_003: { hang: true } })
    const start = await jobs.start({ seriesId, partNumber: 1, pages: pages(1, 'page_003'), prepareOnly: false })
    const job = await until('page_003 to be analyzing', async () => (await (await jobFor(start.runId!, 'page_003'))).stage === 'analyzing' && (await agyLog()).some(e => e.stem === 'page_003') ? jobFor(start.runId!, 'page_003') : null)
    await jobs.control(start.runId!, 'stop-now')
    const after = await until('page_003 cancelled', async () => { const j = await jobFor(start.runId!, 'page_003'); return j.stage === 'cancelled' ? j : null })
    const attempt = await prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: after.currentAttemptId! } })
    expect(attempt.status).toBe('cancelled')
    expect(await savedTop(1, 'page_003')).toBeNull()
    expect(published).not.toContain(job.id)
    // A late submission with the old capability is refused.
    const token = JSON.parse(await fs.readFile(path.join(attempt.workspace, '.agents', 'mcp_config.json'), 'utf8')).mcpServers.studio.env.STUDIO_ATTEMPT_TOKEN
    const late = await jobs.call(token, { tool: 'submit_analysis', arguments: { json: '{}' }, conversationId: attempt.conversationId })
    expect(late).toMatchObject({ isError: true })
    expect((await jobFor(start.runId!, 'page_003')).stage).toBe('cancelled')
  }, 30_000)

  it('Stop lets the page in progress finish and save, starts nothing new, then stops the run', async () => {
    const all = [[1, 'page_001'], [2, 'page_004']] as const
    for (const [chapter, stem] of all) await fs.rm(path.join(process.env.DOWNLOAD_ROOT!, `Series A/Chapter 00${chapter}/crop_points3/${stem}.json`), { force: true })
    await writePlan({ page_001: { delayMs: 1500 }, page_004: { delayMs: 1500 } })
    settingsOver = { concurrency: 1 }
    const start = await jobs.start({ seriesId, partNumber: 1, pages: [...pages(1, 'page_001'), ...pages(2, 'page_004')], prepareOnly: false })
    const [chapter, stem] = await until('a page to be analyzing', async () => {
      for (const entry of all) if ((await jobFor(start.runId!, entry[1])).stage === 'analyzing') return entry
      return null
    })
    const other = all.find(e => e[1] !== stem)!
    expect((await jobs.control(start.runId!, 'stop')).control).toBe('stop_requested')
    const run = await runDone(start.runId!)
    expect(run.control).toBe('stopped')
    expect((await jobFor(start.runId!, stem)).stage).toBe('ready_for_human_review')
    expect(await savedTop(chapter, stem)).toBe(cropBox(stem).y0)
    expect(['prepared', 'cancelled']).toContain((await jobFor(start.runId!, other[1])).stage)
    expect((await agyLog()).filter(e => e.stem === other[1])).toEqual([])
    expect(await savedTop(other[0], other[1])).toBeNull()
  }, 30_000)

  it('retries R2 delivery without another AI request', async () => {
    await writePlan({})
    publishFailures = 1
    const start = await jobs.start({ seriesId, partNumber: 1, pages: pages(1, 'page_005'), prepareOnly: false })
    await runDone(start.runId!)
    const failed = await jobFor(start.runId!, 'page_005')
    expect(failed).toMatchObject({ stage: 'publish_failed', importState: 'imported' })
    expect(await savedTop(1, 'page_005')).toBe(cropBox('page_005').y0) // the local import survived the R2 failure
    const turnsBefore = (await agyLog()).filter(e => e.event === 'start').length
    const retried = await jobs.retry(failed.id)
    expect(retried.stage).toBe('ready_for_human_review')
    expect((await agyLog()).filter(e => e.event === 'start').length).toBe(turnsBefore)
    expect(published).toContain(failed.id)
  }, 30_000)

  it('pauses the run on a quota error instead of burning the remaining pages', async () => {
    await fs.rm(path.join(process.env.DOWNLOAD_ROOT!, 'Series A/Chapter 001/crop_points3/page_001.json'), { force: true })
    await writePlan({ page_001: { providerError: 'RESOURCE_EXHAUSTED: You have exhausted your quota for this model.' } })
    settingsOver = { concurrency: 1 }
    const start = await jobs.start({ seriesId, partNumber: 1, pages: pages(1, 'page_001', 'page_006'), prepareOnly: false })
    expect(start.skipped).toEqual([])
    const run = await runDone(start.runId!)
    expect(run.control).toBe('paused')
    // The run is paused first; the page is marked a moment later.
    await until('page_001 interrupted', async () => (await jobFor(start.runId!, 'page_001')).stage === 'interrupted')
    expect((await jobFor(start.runId!, 'page_006')).stage).toMatch(/^(prepared|queued)$/) // never dispatched
    expect((await agyLog()).filter(e => e.stem === 'page_006')).toEqual([])
    const events = await prisma.antigravityEvent.findMany({ where: { runId: start.runId! } })
    expect(events.some(e => /quota is used up/.test(e.message))).toBe(true)
    await jobs.control(start.runId!, 'stop-now')
    expect((await jobFor(start.runId!, 'page_006')).stage).toBe('cancelled')
  }, 30_000)

  it('reviews again in the same conversation without a new analysis', async () => {
    await writePlan({})
    await fs.writeFile(`${process.env.FAKE_AGY_PLAN}.no-review-page_006`, '')
    const start = await jobs.start({ seriesId, partNumber: 1, pages: pages(1, 'page_006'), prepareOnly: false })
    await runDone(start.runId!)
    const stuck = await jobFor(start.runId!, 'page_006')
    expect(stuck.stage).toBe('needs_attention')
    const conversation = (await prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: stuck.currentAttemptId! } })).conversationId
    await fs.rm(`${process.env.FAKE_AGY_PLAN}.no-review-page_006`)
    await fs.rm(process.env.FAKE_AGY_LOG!, { force: true })
    await jobs.reviewAgain(stuck.id)
    const done = await until('review again to finish', async () => { const j = await jobFor(start.runId!, 'page_006'); return ['ready_for_human_review', 'needs_attention', 'failed'].includes(j.stage) && j.stage !== 'needs_attention' ? j : null })
    expect(done.stage).toBe('ready_for_human_review')
    expect(done.currentAttemptId).toBe(stuck.currentAttemptId)
    const log = await agyLog()
    expect(log.every(e => e.resumed && e.conv === conversation)).toBe(true)
    expect(log.some(e => e.event === 'submit_analysis')).toBe(false)
    expect(await savedTop(1, 'page_006')).toBe(cropBox('page_006').y0)
  }, 40_000)

  it('shows the job already working on a page instead of starting a second agent', async () => {
    await fs.rm(path.join(process.env.DOWNLOAD_ROOT!, 'Series A/Chapter 001/crop_points3/page_003.json'), { force: true })
    await writePlan({ page_003: { delayMs: 1500 } })
    const first = await jobs.start({ seriesId, partNumber: 1, pages: pages(1, 'page_003'), prepareOnly: false })
    expect(first).toMatchObject({ skipped: [], reused: [] })
    await until('page_003 analyzing', async () => (await jobFor(first.runId!, 'page_003')).stage === 'analyzing')
    settingsOver = { model: 'other-model' } // a different profile → a different idempotency key
    const second = await jobs.start({ seriesId, partNumber: 1, pages: pages(1, 'page_003'), prepareOnly: false })
    const owner = await jobFor(first.runId!, 'page_003')
    expect(second.reused).toEqual([owner.id])
    expect(second.created).toEqual([])
    await runDone(first.runId!)
    expect((await agyLog()).filter(e => e.stem === 'page_003' && e.turn === 'analysis').length).toBe(1)
  }, 30_000)

  it('Start under another model takes over a page prepared earlier: no second slicing or upload', async () => {
    await writePlan({})
    await fs.rm(path.join(process.env.DOWNLOAD_ROOT!, 'Series A/Chapter 001/crop_points3/page_002.json'), { force: true })
    settingsOver = { model: 'model-low' }
    const prep = await jobs.start({ seriesId, partNumber: 1, pages: pages(1, 'page_002'), prepareOnly: true })
    await runDone(prep.runId!)
    const prepared = await jobFor(prep.runId!, 'page_002')
    expect(prepared.stage).toBe('prepared')
    const before = google.files.size
    settingsOver = { model: 'model-medium' }
    const run = await jobs.start({ seriesId, partNumber: 1, pages: pages(1, 'page_002'), prepareOnly: false })
    expect(run.created).toEqual([])
    expect(run.reused).toEqual([prepared.id])
    await runDone(run.runId!)
    const processed = await jobFor(run.runId!, 'page_002')
    expect(processed.id).toBe(prepared.id)
    expect(processed.stage).toBe('ready_for_human_review')
    expect(google.files.size).toBe(before)
    const stages = (await prisma.antigravityEvent.findMany({ where: { jobId: prepared.id, runId: run.runId! } })).map(e => e.message)
    expect(stages.some(m => /: (preparing|uploading)$/.test(m))).toBe(false)
  }, 40_000)

  it('a page left pending by an interrupted run is picked up by the next Start', async () => {
    await writePlan({})
    await fs.rm(path.join(process.env.DOWNLOAD_ROOT!, 'Series A/Chapter 001/crop_points3/page_001.json'), { force: true })
    settingsOver = { model: 'model-restart' }
    const prep = await jobs.start({ seriesId, partNumber: 1, pages: pages(1, 'page_001'), prepareOnly: true })
    await runDone(prep.runId!)
    const stuck = await jobFor(prep.runId!, 'page_001')
    // What a restart leaves behind: the run interrupted, the page still waiting.
    await prisma.antigravityPageJob.update({ where: { id: stuck.id }, data: { stage: 'pending' } })
    await prisma.antigravityRun.update({ where: { id: prep.runId! }, data: { control: 'interrupted' } })
    const run = await jobs.start({ seriesId, partNumber: 1, pages: pages(1, 'page_001'), prepareOnly: false })
    expect(run.reused).toEqual([stuck.id])
    await runDone(run.runId!)
    expect((await jobFor(run.runId!, 'page_001')).stage).toBe('ready_for_human_review')
  }, 40_000)

  it('processing the same page again under another model reuses the verified Drive slices instead of uploading duplicates (AG-04)', async () => {
    await writePlan({})
    const pointer = path.join(process.env.DOWNLOAD_ROOT!, 'Series A/Chapter 001/crop_points3/page_005.json')
    await fs.rm(pointer, { force: true })
    settingsOver = { model: 'model-a' }
    const prep = await jobs.start({ seriesId, partNumber: 1, pages: pages(1, 'page_005'), prepareOnly: false })
    await runDone(prep.runId!)
    const prepared = await jobFor(prep.runId!, 'page_005')
    expect(prepared.stage).toBe('ready_for_human_review')
    await fs.rm(pointer, { force: true })
    const before = google.files.size
    settingsOver = { model: 'model-b' }
    const run = await jobs.start({ seriesId, partNumber: 1, pages: pages(1, 'page_005'), prepareOnly: false })
    await runDone(run.runId!)
    const processed = await jobFor(run.runId!, 'page_005')
    expect(processed.id).not.toBe(prepared.id) // a different profile is a different job…
    expect(processed.stage).toBe('ready_for_human_review')
    const slices = async (jobId: string) => (await prisma.driveInputFile.findMany({ where: { jobId, sliceId: { startsWith: 's' } } })).map(r => [r.sliceId, r.fileId]).sort()
    expect(await slices(processed.id)).toEqual(await slices(prepared.id)) // …but the same Drive slices
    // Only the files whose bytes name the job (handoff.json, crop-prompt.txt) are new.
    expect(google.files.size - before).toBe(2)
  }, 40_000)

  let rejectedJobId = ''
  it('Reject voids a finished result through Clipper\'s page rejection, then runs the page again in a new conversation', async () => {
    await writePlan({})
    await fs.rm(path.join(process.env.DOWNLOAD_ROOT!, 'Series A/Chapter 001/crop_points3/page_006.json'), { force: true })
    const first = await jobs.start({ seriesId, partNumber: 1, pages: pages(1, 'page_006'), prepareOnly: false })
    expect(first.skipped).toEqual([])
    await runDone(first.runId!)
    const done = await jobFor(first.runId!, 'page_006')
    rejectedJobId = done.id
    expect(done).toMatchObject({ stage: 'ready_for_human_review', importState: 'imported' })
    expect(await savedTop(1, 'page_006')).toBe(cropBox('page_006').y0)
    const attemptsBefore = await prisma.antigravityAttempt.count({ where: { jobId: done.id } })
    const publishedBefore = published.filter(id => id === done.id).length

    const rejected = await jobs.reject(done.id, { rerun: false, note: '  boxes   too loose ' })
    expect(rejected).toMatchObject({ stage: 'rejected', importState: 'rejected', lastError: 'Rejected by the operator: boxes too loose.' })
    expect(await savedTop(1, 'page_006')).toBeNull() // pointers backed up and removed
    const { readPageRedo } = await import('../../clipper3/pageRedo.js')
    const redo = await readPageRedo('Series A/Chapter 001', 'page_006.png')
    expect(redo).toMatchObject({ status: 'pending', deviceId: null })
    expect(redoRequests.at(-1)).toEqual({ revision: redo!.revision, deviceId: null, page: 'page_006.png' })
    await expect(jobs.reject(done.id, { rerun: false })).rejects.toThrow(/imported into Clipper/)

    // Run again: a new attempt and conversation, different geometry this time.
    const better = { x0: 25, y0: 295, x1: 375, y1: 805 }
    await writePlan({ page_006: { box: better } })
    await jobs.retry(done.id)
    await runDone(first.runId!)
    const again = await prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: done.id } })
    expect(again).toMatchObject({ stage: 'ready_for_human_review', importState: 'imported', lastError: null })
    expect(await savedTop(1, 'page_006')).toBe(better.y0)
    const attempts = await prisma.antigravityAttempt.findMany({ where: { jobId: done.id }, orderBy: { number: 'asc' } })
    expect(attempts.length).toBe(attemptsBefore + 1)
    expect(attempts.at(-1)!.conversationId).not.toBe(attempts.at(-2)!.conversationId)
    expect(again.currentAttemptId).toBe(attempts.at(-1)!.id)
    // The replacement names the rejection it answers, like a phone's redo export, and finishes it.
    const saved = JSON.parse(await fs.readFile(path.join(process.env.DOWNLOAD_ROOT!, 'Series A/Chapter 001/crop_points3/page_006.json'), 'utf8'))
    expect(saved.studioRedoRevision).toBe(redo!.revision)
    expect(JSON.parse(again.resultJson!).studioRedoRevision).toBe(redo!.revision)
    expect((await readPageRedo('Series A/Chapter 001', 'page_006.png'))?.status).toBe('imported')
    expect(published.filter(id => id === done.id).length).toBe(publishedBefore + 1)
  }, 40_000)

  it('Reject refuses a result whose pointers were edited afterwards', async () => {
    const job = await prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: rejectedJobId } })
    expect(job.stage).toBe('ready_for_human_review')
    const file = path.join(process.env.DOWNLOAD_ROOT!, 'Series A/Chapter 001/crop_points3/page_006.json')
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    saved.crops[0].crop.points[0].y = 0.01
    await fs.writeFile(file, JSON.stringify(saved, null, 2))
    await expect(jobs.reject(job.id, { rerun: true })).rejects.toThrow(/changed after this result/)
    expect((await prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: job.id } })).stage).toBe('ready_for_human_review')
  })

  it('a result rejected from Clipper shows as Rejected in AntiGravity and can be processed again', async () => {
    await writePlan({})
    await fs.rm(path.join(process.env.DOWNLOAD_ROOT!, 'Series A/Chapter 001/crop_points3/page_003.json'), { force: true })
    await fs.rm(path.join(process.env.DOWNLOAD_ROOT!, 'Series A/Chapter 001/.studio-page-redo/page_003.png.json'), { force: true })
    const start = await jobs.start({ seriesId, partNumber: 1, pages: pages(1, 'page_003'), prepareOnly: false })
    expect(start.skipped).toEqual([])
    await runDone(start.runId!)
    const done = await jobFor(start.runId!, 'page_003')
    expect(done.stage).toBe('ready_for_human_review')

    // Clipper's own Reject (a phone chosen), not AntiGravity's.
    const { rejectPage } = await import('../../clipper3/pageRedo.js')
    await rejectPage({ folderPath: 'Series A/Chapter 001', filename: 'page_003.png', chapterNumber: 1, seriesSlug: 'series-a', deviceId: 'phone-1', restartRevision: null, pageRevision: null }, async () => undefined)
    const listed = (await jobs.pageJobs([chapterIds[0]])).find(j => j.filename === 'page_003.png')!
    expect(listed).toMatchObject({ stage: 'rejected', importState: 'rejected', lastError: 'Rejected in Clipper.' })
    // Other finished pages are untouched.
    expect((await jobs.pageJobs([chapterIds[0]])).filter(j => j.stage === 'rejected').map(j => j.filename)).toEqual(['page_003.png'])

    await jobs.retry(done.id)
    await runDone(start.runId!)
    expect((await prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: done.id } })).stage).toBe('ready_for_human_review')
    expect(await savedTop(1, 'page_003')).toBe(cropBox('page_003').y0)
  }, 40_000)

  it('runs a page through the ChatGPT (Codex) engine: same bridge and checks, review resumes the same thread, evidence recorded', async () => {
    const folderPath = 'Series A/Chapter 003'
    await makePage(folderPath, 'page_005')
    const chapter = await prisma.chapter.create({ data: { seriesId, number: 3, folderPath, status: 'done' } })
    await writePlan({})
    settingsOver = { engine: 'codex', executable: FAKE_CODEX, model: 'gpt-fake-codex', effort: 'high', sandbox: true }
    const start = await jobs.start({ seriesId, partNumber: 1, pages: [{ chapterId: chapter.id, filename: 'page_005.png' }], prepareOnly: false })
    const run = await runDone(start.runId!)
    expect(run.engine).toBe('codex')
    expect(run.control).toBe('completed')
    const job = await jobFor(start.runId!, 'page_005')
    expect([job.stage, job.lastError]).toEqual(['ready_for_human_review', null])
    expect(await savedTop(3, 'page_005')).toBe(cropBox('page_005').y0)
    expect(published).toContain(job.id)

    const attempt = await prisma.antigravityAttempt.findFirstOrThrow({ where: { jobId: job.id } })
    expect(attempt.engine).toBe('codex')
    expect(attempt.requestedModel).toBe('gpt-fake-codex')
    expect(attempt.observedModel).toBe('gpt-fake-codex') // from Codex's session record
    expect(attempt.reviewRounds).toBeGreaterThan(0)

    // Analysis, then the review as `codex exec resume <same thread>`.
    const log = (await agyLog()).filter(e => e.engine === 'codex' && e.event === 'start')
    expect(log.map(e => [e.turn, e.conv])).toEqual([['analysis', attempt.conversationId], ['review', attempt.conversationId]])
    // Locked-down turns; the capability token never appears on the command line, only its 0600 file's path.
    const token = await fs.readFile(path.join(path.dirname(attempt.workspace), 'capability.token'), 'utf8')
    const mode = (await fs.stat(path.join(path.dirname(attempt.workspace), 'capability.token'))).mode & 0o777
    expect(mode).toBe(0o600)
    for (const entry of log) {
      expect(entry.argv).not.toContain(token)
      expect(entry.argv).toContain('--ignore-user-config')
      expect(entry.argv).toContain('sandbox_mode="read-only"')
      expect(entry.argv).toContain('features.shell_tool=false')
      expect(entry.argv).toContain('model_reasoning_effort="high"')
    }
    await expect(fs.access(path.join(attempt.workspace, '.agents', 'mcp_config.json'))).rejects.toThrow()

    const tools = await prisma.antigravityEvent.findMany({ where: { attemptId: attempt.id, type: { in: ['tools', 'tools_unexpected'] } } })
    expect(tools.at(-1)?.type).toBe('tools')
    expect(tools.at(-1)?.message).toMatch(/fetch_slice×\d.*submit_analysis×1.*submit_review×1.*nothing unexpected.*model gpt-fake-codex.*Codex plus limits: 5 h 12% used, weekly 79% used/)
  }, 30_000)

  it('pauses a Codex run when the ChatGPT plan\'s usage limit is reached', async () => {
    const folderPath = 'Series A/Chapter 004'
    await makePage(folderPath, 'page_006')
    const chapter = await prisma.chapter.create({ data: { seriesId, number: 4, folderPath, status: 'done' } })
    await writePlan({ page_006: { providerError: "You've hit your usage limit. Try again at 6:12 PM." } })
    settingsOver = { engine: 'codex', executable: FAKE_CODEX, model: 'gpt-fake-codex', concurrency: 1 }
    const start = await jobs.start({ seriesId, partNumber: 1, pages: [{ chapterId: chapter.id, filename: 'page_006.png' }], prepareOnly: false })
    const run = await runDone(start.runId!)
    expect(run.control).toBe('paused')
    // The run is paused first; the page is marked a moment later.
    await until('page_006 interrupted', async () => (await jobFor(start.runId!, 'page_006')).stage === 'interrupted')
    const events = await prisma.antigravityEvent.findMany({ where: { runId: start.runId!, type: 'run' } })
    expect(events.map(e => e.message).join(' ')).toMatch(/Every ChatGPT account Studio can use has reached its Codex limit/)
    const state = await accounts.read()
    expect(state.accounts[0].limitedUntil).not.toBeNull() // kept off until its window resets
  }, 30_000)

  it('moves a page to the next ChatGPT account when one reaches its Codex limit, and finishes there', async () => {
    // The previous test leaves its run paused on this part; a new Start would join it (one process at a time).
    for (const r of await prisma.antigravityRun.findMany({ where: { control: { in: ['running', 'preparing', 'pause_requested', 'paused', 'stop_requested'] } } })) await jobs.control(r.id, 'stop-now')
    await accounts.update('default', { clearLimit: true })
    const second = await accounts.add('Second account')
    const folderPath = 'Series A/Chapter 005'
    await makePage(folderPath, 'page_001')
    const chapter = await prisma.chapter.create({ data: { seriesId, number: 5, folderPath, status: 'done' } })
    // Only the Mac's own account (CODEX_HOME …/codex-home) is out of usage.
    await writePlan({ page_001: { providerError: "You've hit your usage limit. Try again at 6:12 PM.", providerErrorOnHome: 'codex-home' } })
    settingsOver = { engine: 'codex', executable: FAKE_CODEX, model: 'gpt-fake-codex', concurrency: 1 }
    const start = await jobs.start({ seriesId, partNumber: 1, pages: [{ chapterId: chapter.id, filename: 'page_001.png' }], prepareOnly: false })
    const run = await runDone(start.runId!)
    expect(run.control).toBe('completed')
    const job = await jobFor(start.runId!, 'page_001')
    expect([job.stage, job.lastError]).toEqual(['ready_for_human_review', null])
    expect(await savedTop(5, 'page_001')).toBe(cropBox('page_001').y0)

    const attempts = await prisma.antigravityAttempt.findMany({ where: { jobId: job.id }, orderBy: { number: 'asc' } })
    expect(attempts.map(a => [a.codexAccount, a.status])).toEqual([['default', 'interrupted'], [second.id, 'completed']])
    expect(attempts[0].conversationId).not.toBe(attempts[1].conversationId) // a thread can't move between accounts
    const state = await accounts.read()
    const limited = state.accounts.find(a => a.id === 'default')!
    expect(Date.parse(limited.limitedUntil!)).toBeGreaterThan(Date.now() + 3600_000) // the window's own reset (≈2 h), not the 1 h fallback
    expect(state.accounts.find(a => a.id === second.id)?.lastLimits?.planType).toBe('plus')
    const events = await prisma.antigravityEvent.findMany({ where: { runId: start.runId! } })
    expect(events.map(e => e.message).join('\n')).toMatch(/"ChatGPT app \(this Mac\)" reached its Codex limit[\s\S]*Continuing on ChatGPT account "Second account"/)
  }, 40_000)

  it('runs a page through the Claude (Claude Code) engine: locked-down turns, review resumes the same session, evidence recorded', async () => {
    for (const r of await prisma.antigravityRun.findMany({ where: { control: { in: ['running', 'preparing', 'pause_requested', 'paused', 'stop_requested'] } } })) await jobs.control(r.id, 'stop-now')
    const folderPath = 'Series A/Chapter 006'
    await makePage(folderPath, 'page_005')
    const chapter = await prisma.chapter.create({ data: { seriesId, number: 6, folderPath, status: 'done' } })
    await writePlan({})
    settingsOver = { engine: 'claude', executable: FAKE_CLAUDE, model: 'claude-fake-5', effort: 'high', sandbox: true }
    const start = await jobs.start({ seriesId, partNumber: 1, pages: [{ chapterId: chapter.id, filename: 'page_005.png' }], prepareOnly: false })
    const run = await runDone(start.runId!)
    expect(run.engine).toBe('claude')
    expect(run.control).toBe('completed')
    const job = await jobFor(start.runId!, 'page_005')
    expect([job.stage, job.lastError]).toEqual(['ready_for_human_review', null])
    expect(await savedTop(6, 'page_005')).toBe(cropBox('page_005').y0)
    expect(published).toContain(job.id)

    const attempt = await prisma.antigravityAttempt.findFirstOrThrow({ where: { jobId: job.id } })
    expect(attempt.engine).toBe('claude')
    expect(attempt.codexAccount).toBeNull()
    expect(attempt.requestedModel).toBe('claude-fake-5')
    expect(attempt.observedModel).toBe('claude-fake-5') // named in Claude Code's stream
    expect(attempt.reviewRounds).toBeGreaterThan(0)

    // Analysis, then the review as `claude --resume <same session>` from the same workspace.
    const log = (await agyLog()).filter(e => e.engine === 'claude' && e.event === 'start')
    expect(log.map(e => [e.turn, e.conv])).toEqual([['analysis', attempt.conversationId], ['review', attempt.conversationId]])
    const token = await fs.readFile(path.join(path.dirname(attempt.workspace), 'capability.token'), 'utf8')
    for (const name of ['capability.token', 'claude-mcp.json']) expect((await fs.stat(path.join(path.dirname(attempt.workspace), name))).mode & 0o777).toBe(0o600)
    expect(await fs.readFile(path.join(path.dirname(attempt.workspace), 'claude-mcp.json'), 'utf8')).not.toContain(token)
    for (const entry of log) {
      expect(entry.argv).not.toContain(token)
      for (const needle of ['--setting-sources  --tools  --strict-mcp-config', '--allowedTools mcp__studio', '--permission-mode dontAsk', '--disable-slash-commands', '--effort high']) expect(entry.argv).toContain(needle)
    }
    await expect(fs.access(path.join(attempt.workspace, '.agents', 'mcp_config.json'))).rejects.toThrow()

    const tools = await prisma.antigravityEvent.findMany({ where: { attemptId: attempt.id, type: { in: ['tools', 'tools_unexpected'] } } })
    expect(tools.at(-1)?.type).toBe('tools')
    expect(tools.at(-1)?.message).toMatch(/fetch_slice×\d.*submit_analysis×1.*submit_review×1.*nothing unexpected.*model claude-fake-5.*Claude limits: five hour allowed/)
    expect(claudeUsage.flat()).toContainEqual(expect.objectContaining({ type: 'five_hour', status: 'allowed' }))
  }, 30_000)

  it('pauses a Claude run when the Claude plan\'s usage limit is reached', async () => {
    for (const r of await prisma.antigravityRun.findMany({ where: { control: { in: ['running', 'preparing', 'pause_requested', 'paused', 'stop_requested'] } } })) await jobs.control(r.id, 'stop-now')
    const folderPath = 'Series A/Chapter 007'
    await makePage(folderPath, 'page_006')
    const chapter = await prisma.chapter.create({ data: { seriesId, number: 7, folderPath, status: 'done' } })
    await writePlan({ page_006: { providerError: "You've hit your limit · resets 6pm" } })
    settingsOver = { engine: 'claude', executable: FAKE_CLAUDE, model: 'claude-fake-5', concurrency: 1 }
    const start = await jobs.start({ seriesId, partNumber: 1, pages: [{ chapterId: chapter.id, filename: 'page_006.png' }], prepareOnly: false })
    const run = await runDone(start.runId!)
    expect(run.control).toBe('paused')
    await until('page_006 interrupted', async () => (await jobFor(start.runId!, 'page_006')).stage === 'interrupted')
    const events = await prisma.antigravityEvent.findMany({ where: { runId: start.runId!, type: 'run' } })
    expect(events.map(e => e.message).join(' ')).toMatch(/Claude Code reports the Claude plan's usage limit is reached \(resets /)
    expect(claudeUsage.flat()).toContainEqual(expect.objectContaining({ type: 'five_hour', status: 'rejected' }))
    await jobs.control(start.runId!, 'stop-now')
  }, 30_000)

  it('Start process takes the part\'s next pending pages in chapter order, the parallel limit at a time, one process at a time', async () => {
    // Earlier tests may leave a paused run holding the single process slot.
    for (const r of await prisma.antigravityRun.findMany({ where: { control: { in: ['running', 'preparing', 'pause_requested', 'paused', 'stop_requested'] } } })) await jobs.control(r.id, 'stop-now')
    await writePlan({ page_001: { delayMs: 1500 } })
    const series = await prisma.series.create({ data: { title: 'Series B', sourceSite: 'test', rootFolder: 'Series B' } })
    const make = async (number: number, stems: string[]) => {
      const folderPath = `Series B/Chapter ${String(number).padStart(3, '0')}`
      for (const stem of stems) await makePage(folderPath, stem)
      return prisma.chapter.create({ data: { seriesId: series.id, number, folderPath, status: 'done' } })
    }
    // Created out of order: the order comes from chapter numbers, not ids.
    const ch2 = await make(2, ['page_004'])
    const ch1 = await make(1, ['page_001', 'page_002', 'page_003'])
    const ch21 = await make(21, ['page_005']) // Part 2: outside this process

    const started = await jobs.startNext({ seriesId: series.id, partNumber: 1 })
    expect(started.runId).toBeTruthy()
    // Start on the same part shows the same process; another part waits for it.
    expect((await jobs.startNext({ seriesId: series.id, partNumber: 1 })).runId).toBe(started.runId)
    await expect(jobs.startNext({ seriesId: series.id, partNumber: 2 })).rejects.toThrow(/One process at a time/)
    expect((await jobs.current())).toMatchObject({ live: true, run: { id: started.runId, mode: 'next' } })

    const run = await runDone(started.runId!)
    expect(run.control).toBe('completed')
    const all = await prisma.antigravityPageJob.findMany({ where: { runId: started.runId! } })
    expect(all.map(j => `${j.chapterId === ch1.id ? 1 : j.chapterId === ch2.id ? 2 : '?'}/${j.filename}/${j.stage}`).sort()).toEqual([
      '1/page_001.png/ready_for_human_review', '1/page_002.png/ready_for_human_review', '1/page_003.png/ready_for_human_review', '2/page_004.png/ready_for_human_review'
    ])
    expect(all.some(j => j.chapterId === ch21.id)).toBe(false)
    const picked = (await prisma.antigravityEvent.findMany({ where: { runId: started.runId! }, orderBy: { seq: 'asc' } })).map(e => e.message).filter(m => m.startsWith('Next page:'))
    expect(picked).toEqual(['Next page: Chapter 1 · page_001.png', 'Next page: Chapter 1 · page_002.png', 'Next page: Chapter 1 · page_003.png', 'Next page: Chapter 2 · page_004.png'])
    // Never more than the parallel limit (2) at once.
    const log = (await agyLog()).filter(e => ['page_001', 'page_002', 'page_003', 'page_004'].includes(e.stem))
    const ends = log.filter(e => e.event === 'end')
    let peak = 0
    for (const t of log.map(e => e.at)) peak = Math.max(peak, new Set(log.filter(e => e.event === 'start' && e.at <= t && !ends.some(x => x.pid === e.pid && x.at < t)).map(e => e.pid)).size)
    expect(peak).toBe(2)

    // Nothing left in the part: the next Start finishes at once without new jobs.
    const again = await jobs.startNext({ seriesId: series.id, partNumber: 1 })
    expect((await runDone(again.runId!)).control).toBe('completed')
    expect(await prisma.antigravityPageJob.count({ where: { runId: again.runId! } })).toBe(0)
    expect(await jobs.current()).toMatchObject({ live: false, run: { id: again.runId } })
  }, 40_000)

  it('ticked pages keep the one-process rule: they join this part\'s live process, and wait for another part\'s', async () => {
    for (const r of await prisma.antigravityRun.findMany({ where: { control: { in: ['running', 'preparing', 'pause_requested', 'paused', 'stop_requested'] } } })) await jobs.control(r.id, 'stop-now')
    await writePlan({ page_001: { delayMs: 1500 } })
    const series = await prisma.series.create({ data: { title: 'Series D', sourceSite: 'test', rootFolder: 'Series D' } })
    const make = async (number: number, stems: string[]) => {
      const folderPath = `Series D/Chapter ${String(number).padStart(3, '0')}`
      for (const stem of stems) await makePage(folderPath, stem)
      return prisma.chapter.create({ data: { seriesId: series.id, number, folderPath, status: 'done' } })
    }
    const ch1 = await make(1, ['page_001', 'page_002', 'page_003'])
    const ch21 = await make(21, ['page_004'])

    const first = await jobs.start({ seriesId: series.id, partNumber: 1, pages: [{ chapterId: ch1.id, filename: 'page_001.png' }], prepareOnly: false })
    expect(first.created).toHaveLength(1)
    await expect(jobs.start({ seriesId: series.id, partNumber: 2, pages: [{ chapterId: ch21.id, filename: 'page_004.png' }], prepareOnly: false })).rejects.toThrow(/One process at a time/)
    await expect(jobs.start({ seriesId: series.id, partNumber: 1, pages: [{ chapterId: ch1.id, filename: 'page_003.png' }], prepareOnly: true })).rejects.toThrow(/Upload to Drive when it has finished/)
    const added = await jobs.start({ seriesId: series.id, partNumber: 1, pages: [{ chapterId: ch1.id, filename: 'page_003.png' }], prepareOnly: false })
    expect(added.runId).toBe(first.runId)
    expect(added.created).toHaveLength(1)

    expect((await runDone(first.runId!)).control).toBe('completed')
    const all = await prisma.antigravityPageJob.findMany({ where: { runId: first.runId! } })
    // Only the ticked pages ran: a page-list process does not go on through the part.
    expect(all.map(j => `${j.filename}/${j.stage}`).sort()).toEqual(['page_001.png/ready_for_human_review', 'page_003.png/ready_for_human_review'])
  }, 40_000)

  it('runs a Gemini 3.8 Flash page through the four-step prompts (find, corners, inspect, review) in one conversation, then delivers', async () => {
    for (const r of await prisma.antigravityRun.findMany({ where: { control: { in: ['running', 'preparing', 'pause_requested', 'paused', 'stop_requested'] } } })) await jobs.control(r.id, 'stop-now')
    settingsOver = { engine: 'antigravity', model: 'gemini-3.8-flash-high', modelLabel: 'Gemini 3.8 Flash (High)' }
    await writePlan({})
    const series = await prisma.series.create({ data: { title: 'Series C', sourceSite: 'test', rootFolder: 'Series C' } })
    await makePage('Series C/Chapter 001', 'page_007')
    const chapter = await prisma.chapter.create({ data: { seriesId: series.id, number: 1, folderPath: 'Series C/Chapter 001', status: 'done' } })
    const start = await jobs.start({ seriesId: series.id, partNumber: 1, pages: [{ chapterId: chapter.id, filename: 'page_007.png' }], prepareOnly: false })
    await runDone(start.runId!)
    const job = await jobFor(start.runId!, 'page_007')
    expect([job.stage, job.lastError]).toEqual(['ready_for_human_review', null])
    const attempt = await prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: job.currentAttemptId! } })
    expect([attempt.flow, attempt.reviewRounds, attempt.requestedModel]).toEqual(['steps', 1, 'gemini-3.8-flash-high'])
    expect(JSON.parse(attempt.analysisJson!).candidates).toHaveLength(1)

    const log = (await agyLog()).filter(e => e.stem === 'page_007')
    const submits = log.filter(e => e.event === 'submit_step')
    expect(submits.map(e => [e.step, e.error])).toEqual([[1, null], [2, null], [3, null], [4, null]])
    // Only the four-step tools are offered; one conversation throughout.
    expect(submits[0].tools).toEqual(['get_job_context', 'fetch_slice', 'fetch_step_image', 'submit_step'])
    expect(new Set(log.map(e => e.conv)).size).toBe(1)
    expect(log.filter(e => e.event === 'start').map(e => e.resumed)).toEqual([false, true, true, true])
    // Step 3 fetched the cut-out crop, step 4 every drawn-on slice.
    expect(log.filter(e => e.event === 'fetched').map(e => [e.id, e.error])).toEqual([['candidate-01', null], ['review-s01', null], ['review-s02', null]])

    const saved = JSON.parse(await fs.readFile(path.join(process.env.DOWNLOAD_ROOT!, 'Series C/Chapter 001/crop_points3/page_007.json'), 'utf8'))
    expect(Math.round(saved.crops[0].crop.points[0].y * saved.image.height)).toBe(cropBox('page_007').y0)
    expect(Math.round(saved.crops[0].crop.points[2].y * saved.image.height)).toBe(cropBox('page_007').y1)
    const events = (await prisma.antigravityEvent.findMany({ where: { jobId: job.id }, orderBy: { seq: 'asc' } })).map(e => e.message)
    expect(events.some(m => m.includes('uses the 4-step prompts'))).toBe(true)
    expect(events.some(m => m.includes('step 4 review round accepted'))).toBe(true)
  }, 40_000)
})
