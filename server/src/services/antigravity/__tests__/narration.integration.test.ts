/**
 * AntiGravity → Narration end to end: the real job runner and MCP bridge over loopback HTTP, a real SQLite database,
 * real piece cutting (sharp) and fake agy/Claude CLIs answering the narration tools, always giving
 * its notes in reverse order. The chapter inputs and the save are an in-memory stand-in (NarrationDeps).
 */
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { NarrationDeps, NarrationOutput } from '../narrationFlow.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(here, '../../../..')
const FAKE_CODEX = path.join(here, 'fixtures', 'fake-codex.mjs')
let concurrency = 2
const FAKE_CLAUDE = path.join(here, 'fixtures', 'fake-claude.mjs')
let engine: 'antigravity' | 'claude' | 'codex' = 'antigravity'
const FAKE_AGY = path.join(here, 'fixtures', 'fake-agy.mjs')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-narration-'))
const dbUrl = `file:${path.join(tmp, 'test.db')}`
process.env.DOWNLOAD_ROOT = path.join(tmp, 'library')
process.env.FAKE_AGY_PLAN = path.join(tmp, 'plan.json')
process.env.FAKE_AGY_LOG = path.join(tmp, 'agy.log')
process.env.CODEX_HOME = path.join(tmp, 'codex-home')
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude-home')

let prisma: PrismaClient
let jobs: import('../jobs.js').AntigravityJobs
let server: http.Server
let seriesId = ''
const chapters: { id: string; number: number; dir: string }[] = []
const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex')

/** In-memory Narration: each chapter's current script, and every save. */
const scripts = new Map<string, { script: string; summary: string; closing: string }>()
const saves: { chapterId: string; output: NarrationOutput; expected: string | null; model: string }[] = []
async function pagesOf(dir: string) {
  return (await fs.readdir(dir)).filter(f => f.endsWith('.png')).sort().map(f => ({ file: path.join(dir, f), source: f }))
}
const narration: NarrationDeps = {
  input: async chapterId => {
    const index = chapters.findIndex(c => c.id === chapterId)
    const chapter = chapters[index]
    const before = index > 0 ? scripts.get(chapters[index - 1].id) : null
    if (index > 0 && !before) return { reason: `Chapter ${chapters[index - 1].number} needs its English script first.`, wait: true }
    const current = scripts.get(chapterId)
    const pages = await pagesOf(chapter.dir)
    const input = {
      seriesTitle: 'Series N', chapterNumber: String(chapter.number), pages, requireAbout: index === 0, about: null,
      previous: before ? { summary: before.summary, closing: before.closing } : null, scriptSha256: current ? sha(current.script) : null,
      scriptWords: current ? current.script.split(/\s+/).filter(Boolean).length : undefined
    }
    return { ...input, revision: sha(JSON.stringify(input)) }
  },
  save: async (chapterId, output, expected, model) => {
    const current = scripts.get(chapterId)
    if ((current ? sha(current.script) : null) !== expected) throw new Error('The local script changed.')
    scripts.set(chapterId, { script: output.script, summary: output.summary, closing: output.closing })
    saves.push({ chapterId, output, expected, model })
    return { phoneSent: true }
  },
  checkCode: () => 'ACDE'
}

async function writePlan(plan: Record<string, unknown>) { await fs.writeFile(process.env.FAKE_AGY_PLAN!, JSON.stringify(plan)) }
async function agyLog(): Promise<any[]> {
  const text = await fs.readFile(process.env.FAKE_AGY_LOG!, 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l))
}
async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
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
}, 60_000)

/** A 600-px-wide page of busy stripes, with white gutters at [gutters] (rows). */
async function page(file: string, height: number, gutters: [number, number][] = []) {
  const width = 600
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    const white = gutters.some(([a, b]) => y >= a && y < b)
    for (let x = 0; x < width; x++) raw.fill(white ? 255 : ((x >> 3) + (y >> 3)) % 2 ? 30 : 200, (y * width + x) * 3, (y * width + x) * 3 + 3)
  }
  await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(file)
}

/** Chapter 1 pages 5..[last] as short pages (one piece each); beforeEach removes them again. */
async function morePages(last: number) {
  for (let n = 5; n <= last; n++) await page(path.join(chapters[0].dir, `page_${String(n).padStart(3, '0')}.png`), 120)
}

beforeAll(async () => {
  await fs.writeFile(path.join(tmp, 'test.db'), '')
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], { cwd: serverDir, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'ignore' })
  await fs.chmod(FAKE_CODEX, 0o755)
  await fs.chmod(FAKE_AGY, 0o755)
  await fs.chmod(FAKE_CLAUDE, 0o755)
  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
  const series = await prisma.series.create({ data: { title: 'Series N', sourceSite: 'test', rootFolder: 'Series N' } })
  seriesId = series.id
  for (const number of [1, 2]) {
    const folderPath = `Series N/Chapter 00${number}`
    const dir = path.join(process.env.DOWNLOAD_ROOT!, folderPath)
    await fs.mkdir(dir, { recursive: true })
    const row = await prisma.chapter.create({ data: { seriesId, number, folderPath, status: 'done' } })
    chapters.push({ id: row.id, number, dir })
  }
  // Chapter 1: a long page (cut at its two gutters into three pieces) and three short ones = six pieces, one notes batch.
  // Tests that need several batches of 10 add short pages with morePages().
  await page(path.join(chapters[0].dir, 'page_001.png'), 5000, [[1500, 1540], [3200, 3240]])
  for (const n of [2, 3, 4]) await page(path.join(chapters[0].dir, `page_00${n}.png`), 1000)
  // Chapter 2: one short page.
  await page(path.join(chapters[1].dir, 'page_001.png'), 1200)

  const { AntigravityJobs } = await import('../jobs.js')
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  jobs = new AntigravityJobs({
    prisma,
    drive: { requireActiveConnection: async () => { throw new Error('Drive must not be used for Narration') }, api: () => { throw new Error('Drive must not be used for Narration') } } as any,
    port: (server.address() as { port: number }).port,
    attemptRoot: path.join(tmp, 'attempts'),
    cliHome: path.join(tmp, 'agy-home'),
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    codexHome: process.env.CODEX_HOME,
    settings: async () => ({ engine, model: 'fake-model', modelLabel: 'Fake', effort: null, sandbox: false, concurrency, pageTimeoutMinutes: 2, executable: engine === 'claude' ? FAKE_CLAUDE : engine === 'codex' ? FAKE_CODEX : FAKE_AGY, cliVersion: 'fake-1' } as any),
    prompts: () => prompts.pack(),
    publisher: { publish: async () => { throw new Error('Narration must not publish through AntiGravity') } } as any,
    narration
  })
}, 60_000)

beforeEach(async () => {
  await until('previous fixture workers to settle', async () => (jobs as any).live.size === 0 && (jobs as any).scheduling.size === 0)
  concurrency = 2
  for (const file of await fs.readdir(chapters[0].dir)) if (/^page_\d+\.png$/.test(file) && Number(file.match(/\d+/)![0]) > 4) await fs.rm(path.join(chapters[0].dir, file))
  await prisma.antigravityEvent.deleteMany()
  await prisma.antigravityAttempt.deleteMany()
  await prisma.antigravityPageJob.deleteMany()
  await prisma.antigravityRun.deleteMany()
  await fs.rm(process.env.FAKE_AGY_LOG!, { force: true })
  scripts.clear()
  saves.length = 0
  for (const file of await fs.readdir(tmp)) if (file.startsWith('agy.log.')) await fs.rm(path.join(tmp, file), { force: true })
  await writePlan({})
})

afterAll(async () => {
  await jobs?.shutdown()
  server?.close()
  await prisma?.$disconnect()
  await fs.rm(tmp, { recursive: true, force: true })
})

// Narration is written with Antigravity (agy) or ChatGPT (Codex); Claude is refused (see 'Narration engines' below).
describe.each(['antigravity', 'codex'] as const)('%s Narration', selectedEngine => {
  beforeEach(() => { engine = selectedEngine })
  it('Start process writes chapter 1, then chapter 2 from chapter 1\'s summary; notes given in reverse order are matched by check code', async () => {
    const start = await jobs.startNext({ seriesId, partNumber: 1, kind: 'narration' })
    const run = await until('both chapters written', async () => (saves.length >= 2 ? runDone(start.runId!) : null), 90_000)
    expect(run.control).toBe('completed')
    expect(run.kind).toBe('narration')

    expect(saves.map(s => chapters.findIndex(c => c.id === s.chapterId) + 1)).toEqual([1, 2])
    const first = saves[0].output
    // Six pieces, one paragraph each, in page/part order; the first chapter also gets the series overview.
    expect(first.script.split('\n\n')).toHaveLength(6)
    expect(first.about).toBe('A story about a thief.')
    expect(saves[0].expected).toBeNull()
    expect(saves[0].model).toBe(`Studio AntiGravity (${engine === 'claude' ? 'Claude (Claude Code)' : engine === 'codex' ? 'ChatGPT (Codex)' : 'Antigravity'} · fake-model)`)
    const audit = JSON.parse(first.audit)
    expect(audit.images.map((i: { id: string }) => i.id)).toEqual(['P0001-T001', 'P0001-T002', 'P0001-T003', 'P0002-T001', 'P0003-T001', 'P0004-T001'])
    expect(audit.images.every((i: { check: string; text: string[] }) => i.check === 'ACDE' && i.text[0] === `WORDS PRINTED IN ${(i as any).id}`)).toBe(true)
    // The long page is cut at its gutters into pieces agy shows at full size; every row is kept, once.
    expect(audit.images.slice(0, 3).map((i: { rows: number[] }) => i.rows)).toEqual([[0, 1520], [1520, 3220], [3220, 5000]])
    expect(audit.images.map((i: { parts: number }) => i.parts)).toEqual([3, 3, 3, 1, 1, 1])
    expect(audit.inputMode).toBe('agy-pieces-2000/1')
    expect(audit).not.toHaveProperty('maxScriptWords')
    expect(audit.review.paragraphs.map((p: { images: string[] }) => p.images[0])).toEqual(audit.images.map((i: { id: string }) => i.id))

    const log = await agyLog()
    const ch1 = log.filter(e => e.stem === 'narration-ch1')
    // Every piece was fetched as an image; one notes conversation (six pieces), then one writing conversation for draft, review and check.
    expect(ch1.filter(e => e.event === 'fetch').every(e => e.image && !e.error)).toBe(true)
    expect(ch1.filter(e => e.event === 'fetch')).toHaveLength(6)
    expect(ch1.filter(e => e.event === 'start').map(e => e.stage)).toEqual(['notes', 'draft', 'review', 'check'])
    const convs = ch1.filter(e => e.event === 'start').map(e => e.conv)
    expect(new Set(convs.slice(1))).toEqual(new Set([convs[1]]))
    expect(convs[0]).not.toBe(convs[1])
    expect(ch1.filter(e => /^submit_/.test(e.event)).every(e => !e.error)).toBe(true)
    // Chapter 2's draft continued from chapter 1's summary.
    expect(log.find(e => e.stem === 'narration-ch2' && e.stage === 'draft')?.hasPrevious).toBe('Summary of chapter 1.')

    const jobsDone = await prisma.antigravityPageJob.findMany({ where: { runId: start.runId! } })
    expect(jobsDone.map(j => [j.filename, j.stage, j.kind])).toEqual([['narration-en', 'done', 'narration'], ['narration-en', 'done', 'narration']])
  }, 120_000)

  it('Start process leaves chapters that have a script; ticking one rewrites it, refusing a wrong check code and an invented name until corrected', async () => {
    for (const chapter of chapters) scripts.set(chapter.id, { script: Array(100).fill('word').join(' '), summary: 'Earlier story.', closing: 'An existing script.' })
    const again = await jobs.startNext({ seriesId, partNumber: 1, kind: 'narration' })
    await runDone(again.runId!)
    expect(await prisma.antigravityPageJob.count({ where: { runId: again.runId! } })).toBe(0)

    const before = scripts.get(chapters[0].id)!.script
    saves.length = 0
    await writePlan({ 'narration-ch1': { narration: { wrongCheckFirst: true, inventedName: true } } })
    const start = await jobs.start({ seriesId, partNumber: 1, kind: 'narration', prepareOnly: false, pages: [
      { chapterId: chapters[0].id, filename: 'narration-en' }, { chapterId: chapters[0].id, filename: 'page_001.png' }
    ] })
    expect(start.created).toHaveLength(1)
    expect(start.skipped.map(s => s.reason)).toEqual(['Not a narration of this chapter.'])
    await until('chapter 1 rewritten', async () => saves.length === 1)
    await runDone(start.runId!)
    expect(saves[0].expected).toBe(sha(before))
    expect(JSON.parse(saves[0].output.audit)).not.toHaveProperty('maxScriptWords')

    const log = await agyLog()
    const notes = log.filter(e => e.event === 'submit_notes')
    expect(notes[0].error).toMatch(/check code for P000\d-T00\d is wrong/)
    expect(notes.slice(1).every(e => !e.error)).toBe(true)
    const reviews = log.filter(e => e.event === 'submit_review')
    expect(reviews[0].error).toMatch(/These names are not printed .*: Alicia/)
    expect(reviews[1].error).toBeNull()
    expect(saves[0].output.script).not.toContain('Alicia')
    const job = await prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: start.created[0] } })
    expect(job.stage).toBe('done')
    expect(await jobs.reject(job.id, { rerun: false }).catch(e => e.message)).toMatch(/not rejected here/)
  }, 120_000)

  it('keeps every delivery when the model fetches a notes batch in parallel', async () => {
    await writePlan({ 'narration-ch1': { narration: { parallelFetch: true } } })
    const start = await jobs.start({ seriesId, partNumber: 1, kind: 'narration', prepareOnly: false,
      pages: [{ chapterId: chapters[0].id, filename: 'narration-en' }] })
    const run = await runDone(start.runId!)
    expect(run.control).toBe('completed')
    expect(saves).toHaveLength(1)
    const notes = (await agyLog()).filter(e => e.event === 'submit_notes')
    expect(notes).toHaveLength(1)
    expect(notes.every(e => !e.error)).toBe(true)
  }, 90_000)

  it.each([['notes', 'an object under another name'], ['submission', 'text under another name'], ['spread', 'the object itself as the arguments']])(
    'accepts notes submitted as %s (%s), not only under json', async notesArg => {
      await writePlan({ 'narration-ch1': { narration: { notesArg } } })
      const start = await jobs.start({ seriesId, partNumber: 1, kind: 'narration', prepareOnly: false,
        pages: [{ chapterId: chapters[0].id, filename: 'narration-en' }] })
      expect((await runDone(start.runId!)).control).toBe('completed')
      expect(saves).toHaveLength(1)
      expect((await agyLog()).filter(e => e.event === 'submit_notes').map(e => e.error)).toEqual([null])
    }, 90_000)

  it('refuses notes without delivered images, even when their check codes match', async () => {
    await writePlan({ 'narration-ch1': { narration: { skipFetch: true } } })
    const start = await jobs.start({ seriesId, partNumber: 1, kind: 'narration', prepareOnly: false,
      pages: [{ chapterId: chapters[0].id, filename: 'narration-en' }] })
    expect((await runDone(start.runId!)).control).toBe('completed_with_errors')
    const job = await prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: start.created[0] } })
    expect(job.stage).toBe('needs_attention')
    expect(job.lastError).toContain('Not fetched yet:')
    expect(saves).toHaveLength(0)
  }, 90_000)

  it('runs four page batches concurrently, merges out-of-order finishes and drafts only after all notes finish', async () => {
    concurrency = 4
    await morePages(37)
    await writePlan({ 'narration-ch1': { narration: { delays: { 1: 2500, 2: 1500, 3: 500, 4: 0 }, foreignFetch: true } } })
    const start = await jobs.start({ seriesId, partNumber: 1, kind: 'narration', prepareOnly: false,
      pages: [{ chapterId: chapters[0].id, filename: 'narration-en' }] })
    expect((await runDone(start.runId!)).control).toBe('completed')
    expect(saves).toHaveLength(1)
    const log = (await agyLog()).filter(e => e.stem === 'narration-ch1')
    const starts = log.filter(e => e.event === 'start' && e.stage === 'notes')
    const ends = log.filter(e => e.event === 'end' && e.stage === 'notes')
    expect(starts).toHaveLength(4)
    expect(new Set(starts.map(e => e.conv)).size).toBe(4)
    expect(new Set(starts.map(e => e.cwd)).size).toBe(4)
    expect(Math.max(...starts.map(e => e.at))).toBeLessThan(Math.min(...ends.map(e => e.at)))
    expect(ends[0].batch).toBe(4)
    const draft = log.find(e => e.event === 'start' && e.stage === 'draft')
    expect(draft.at).toBeGreaterThanOrEqual(Math.max(...ends.map(e => e.at)))
    expect(new Set(log.filter(e => e.event === 'start' && e.stage !== 'notes').map(e => e.conv)).size).toBe(1)
    expect(starts.map(e => e.conv)).not.toContain(draft.conv)
    expect(log.filter(e => e.event === 'foreign_fetch').every(e => /only read its assigned pages/.test(e.error))).toBe(true)
    expect(log.filter(e => e.event === 'foreign_tool').every(e => /only has get_job_context/.test(e.error))).toBe(true)
    const audit = JSON.parse(saves[0].output.audit)
    // 37 pages: the long first page as three pieces, then one piece each = 39 pieces in four batches (10, 10, 10, 9).
    expect(audit.images.map((i: { page: number }) => i.page)).toEqual([1, 1, 1, ...Array.from({ length: 36 }, (_, i) => i + 2)])
    expect(audit.review.paragraphs.flatMap((p: { images: string[] }) => p.images)).toEqual(audit.images.map((i: { id: string }) => i.id))
  }, 90_000)

  it('keeps one notes conversation at a time when the pinned concurrency is one', async () => {
    concurrency = 1
    await morePages(12)
    await writePlan({ 'narration-ch1': { narration: { delayMs: 250 } } })
    const start = await jobs.start({ seriesId, partNumber: 1, kind: 'narration', prepareOnly: false,
      pages: [{ chapterId: chapters[0].id, filename: 'narration-en' }] })
    // Editing settings after Start must not increase the running process's pinned limit.
    concurrency = 4
    expect((await runDone(start.runId!)).control).toBe('completed')
    const log = (await agyLog()).filter(e => e.stem === 'narration-ch1' && e.stage === 'notes')
    const starts = log.filter(e => e.event === 'start')
    const ends = log.filter(e => e.event === 'end')
    expect(starts).toHaveLength(2)
    expect(starts[1].at).toBeGreaterThanOrEqual(ends[0].at)
  }, 90_000)

  it('stops all active notes conversations and refuses late capability calls without saving a script', async () => {
    await morePages(12)
    await writePlan({ 'narration-ch1': { narration: { delayMs: 10_000 } } })
    const start = await jobs.start({ seriesId, partNumber: 1, kind: 'narration', prepareOnly: false,
      pages: [{ chapterId: chapters[0].id, filename: 'narration-en' }] })
    await until('two notes conversations', async () => (await agyLog()).filter(e => e.event === 'start' && e.stage === 'notes').length === 2)
    const children = await prisma.antigravityAttempt.findMany({ where: { jobId: start.created[0], flow: 'narration-notes' } })
    const tokens = await Promise.all(children.map(async child => engine === 'antigravity'
      ? JSON.parse(await fs.readFile(path.join(child.workspace, '.agents/mcp_config.json'), 'utf8')).mcpServers.studio.env.STUDIO_ATTEMPT_TOKEN
      : (await fs.readFile(path.join(path.dirname(child.workspace), 'capability.token'), 'utf8')).trim()))
    await jobs.control(start.runId!, 'stop-now')
    for (const token of tokens) {
      const result = await jobs.call(token, { tool: 'get_job_context', arguments: {}, conversationId: null })
      expect('isError' in result && result.isError).toBe(true)
    }
    await until('all notes workers stopped', async () => (jobs as any).live.size === 0)
    expect(await prisma.antigravityAttempt.count({ where: { jobId: start.created[0], status: 'active' } })).toBe(0)
    expect(saves).toHaveLength(0)
    expect((await agyLog()).some(e => e.event === 'start' && e.stage === 'draft')).toBe(false)
  }, 90_000)

  it('pauses on a provider limit and stops dispatching further notes batches', async () => {
    await morePages(30)
    await writePlan({ 'narration-ch1': { narration: { providerErrorBatch: 1, delays: { 1: 300, 2: 10_000 } } } })
    const start = await jobs.start({ seriesId, partNumber: 1, kind: 'narration', prepareOnly: false,
      pages: [{ chapterId: chapters[0].id, filename: 'narration-en' }] })
    expect((await runDone(start.runId!)).control).toBe('paused')
    await until('notes failure settled', async () => (jobs as any).live.size === 0)
    const starts = (await agyLog()).filter(e => e.event === 'start' && e.stage === 'notes')
    expect(starts.map(e => e.batch).sort()).toEqual([1, 2])
    expect(saves).toHaveLength(0)
  }, 90_000)

  it('rejects changed chapter inputs while batches are running and preserves the newer script', async () => {
    await writePlan({ 'narration-ch1': { narration: { delayMs: 500 } } })
    const start = await jobs.start({ seriesId, partNumber: 1, kind: 'narration', prepareOnly: false,
      pages: [{ chapterId: chapters[0].id, filename: 'narration-en' }] })
    await until('notes started', async () => (await agyLog()).some(e => e.event === 'start' && e.stage === 'notes'))
    scripts.set(chapters[0].id, { script: 'A newer phone script.', summary: 'New summary.', closing: 'New closing.' })
    expect((await runDone(start.runId!)).control).toBe('completed_with_errors')
    expect(saves).toHaveLength(0)
    expect(scripts.get(chapters[0].id)?.script).toBe('A newer phone script.')
  }, 90_000)

  it('continues an interrupted batch without refetching accepted batches or starting a new attempt', async () => {
    await morePages(12)
    await writePlan({ 'narration-ch1': { narration: { wrongCheckBatch: 2, delays: { 2: 500 } } } })
    const start = await jobs.start({ seriesId, partNumber: 1, kind: 'narration', prepareOnly: false,
      pages: [{ chapterId: chapters[0].id, filename: 'narration-en' }] })
    expect((await runDone(start.runId!)).control).toBe('completed_with_errors')
    const job = await prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: start.created[0] } })
    const attempt = await prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: job.currentAttemptId! } })
    expect(job.stage).toBe('needs_attention')
    expect(Object.keys(JSON.parse(attempt.stepsStateJson!).notes)).toHaveLength(10)
    expect(saves).toHaveLength(0)

    await prisma.antigravityAttempt.updateMany({ where: { jobId: job.id, status: { not: 'completed' } }, data: { status: 'active', finishedAt: null } })
    await prisma.antigravityPageJob.update({ where: { id: job.id }, data: { stage: 'analyzing' } })
    await prisma.antigravityRun.update({ where: { id: start.runId! }, data: { control: 'running' } })
    await jobs.recoverAfterRestart()
    expect(await prisma.antigravityAttempt.count({ where: { jobId: job.id, status: 'active' } })).toBe(0)
    const before = (await agyLog()).length
    await writePlan({})
    await jobs.reviewAgain(job.id)
    expect((await runDone(start.runId!)).control).toBe('completed')
    expect(saves).toHaveLength(1)
    expect(await prisma.antigravityAttempt.count({ where: { jobId: job.id, flow: 'narration' } })).toBe(1)
    const log = (await agyLog()).slice(before).filter(e => e.stem === 'narration-ch1')
    // Batch 2 = pieces 11-14 (pages 9-12).
    expect(log.filter(e => e.event === 'fetch').map(e => e.id)).toEqual(['P0009-T001', 'P0010-T001', 'P0011-T001', 'P0012-T001'])
    expect(log.filter(e => e.event === 'start').map(e => e.stage)).toEqual(['notes', 'draft', 'review', 'check'])
    expect(new Set(log.filter(e => e.event === 'start' && e.stage !== 'notes').map(e => e.conv)).size).toBe(1)
    // The unfinished batch continued in its own conversation: no new notes attempt.
    expect(await prisma.antigravityAttempt.count({ where: { jobId: job.id, flow: 'narration-notes' } })).toBe(2)
  }, 90_000)

  it('does not reuse a notes conversation made for other pieces (an older batch-of-5 task) on Continue', async () => {
    await morePages(12)
    await writePlan({ 'narration-ch1': { narration: { wrongCheckBatch: 2 } } })
    const start = await jobs.start({ seriesId, partNumber: 1, kind: 'narration', prepareOnly: false,
      pages: [{ chapterId: chapters[0].id, filename: 'narration-en' }] })
    expect((await runDone(start.runId!)).control).toBe('completed_with_errors')
    const job = await prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: start.created[0] } })
    // Make the failed batch-2 task look like one from before the change: a batch number and no piece ids.
    const failed = await prisma.antigravityAttempt.findFirstOrThrow({ where: { jobId: job.id, flow: 'narration-notes', status: { not: 'completed' } } })
    const { pieceIds: _, ...legacy } = JSON.parse(failed.stepsStateJson!)
    await prisma.antigravityAttempt.update({ where: { id: failed.id }, data: { stepsStateJson: JSON.stringify(legacy) } })

    await writePlan({})
    await jobs.reviewAgain(job.id)
    expect((await runDone(start.runId!)).control).toBe('completed')
    expect(saves).toHaveLength(1)
    // A new notes conversation read batch 2; the old one was left alone.
    expect(await prisma.antigravityAttempt.count({ where: { jobId: job.id, flow: 'narration-notes' } })).toBe(3)
    expect((await prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: failed.id } })).status).not.toBe('completed')
  }, 90_000)

})

describe('Narration engines', () => {
  afterEach(() => { engine = 'antigravity' })
  it('refuses claude for script writing, both Start process and ticked chapters', async () => {
    engine = 'claude'
    await expect(jobs.startNext({ seriesId, partNumber: 1, kind: 'narration' })).rejects.toThrow(/written with Antigravity or ChatGPT \(Codex\) only/)
    await expect(jobs.start({ seriesId, partNumber: 1, kind: 'narration', prepareOnly: false, pages: [{ chapterId: chapters[0].id, filename: 'narration-en' }] })).rejects.toThrow(/written with Antigravity or ChatGPT \(Codex\) only/)
    expect(await prisma.antigravityRun.count()).toBe(0)
  })
})

describe('Narration keeps finished work', () => {
  const startChapter1 = () => jobs.start({ seriesId, partNumber: 1, kind: 'narration', prepareOnly: false, pages: [{ chapterId: chapters[0].id, filename: 'narration-en' }] })
  const job1 = async (runId: string) => prisma.antigravityPageJob.findFirstOrThrow({ where: { runId } })
  const since = async (count: number) => (await agyLog()).slice(count).filter(e => e.stem === 'narration-ch1')
  /** Chapter 1 stopped in its review: every page read, the draft accepted. */
  async function failInReview() {
    await writePlan({ 'narration-ch1': { narration: { silentStage: 'review' } } })
    const start = await startChapter1()
    await runDone(start.runId!)
    const failed = await job1(start.runId!)
    expect(failed.stage).toBe('failed')
    const attempt = await prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: failed.currentAttemptId! } })
    expect(JSON.parse(attempt.stepsStateJson!).draft).not.toBeNull()
    await writePlan({})
    return { runId: start.runId!, job: failed, attempt }
  }

  it('Retry after a failed review takes over the accepted notes and draft instead of reading the pages again', async () => {
    const { runId, job, attempt } = await failInReview()
    const before = (await agyLog()).length
    await jobs.retry(job.id)
    await until('chapter 1 saved after Retry', async () => saves.length === 1)
    await runDone(runId)
    const retried = await since(before)
    // Nothing read or drafted again: only the review and the check, in a new conversation.
    expect(retried.filter(e => e.event === 'start').map(e => e.stage)).toEqual(['review', 'check'])
    expect(retried.filter(e => e.event === 'fetch')).toHaveLength(0)
    const attempts = await prisma.antigravityAttempt.findMany({ where: { jobId: job.id, flow: 'narration' }, orderBy: { startedAt: 'asc' } })
    expect(attempts).toHaveLength(2)
    const files = (a: { stepsStateJson: string | null }) => JSON.parse(a.stepsStateJson!).pieces.map((p: { file: string }) => p.file)
    expect(files(attempts[1])).toEqual(files(attempt))
    expect((await prisma.antigravityEvent.findMany({ where: { jobId: job.id, type: 'flow' } })).some(e => /kept notes for 6 of 6 pieces, the draft/.test(e.message))).toBe(true)
  }, 90_000)

  it('Start over reads every page again', async () => {
    const { runId, job } = await failInReview()
    const before = (await agyLog()).length
    await jobs.retry(job.id, { fresh: true })
    await until('chapter 1 saved after Start over', async () => saves.length === 1)
    await runDone(runId)
    expect((await since(before)).filter(e => e.event === 'start').map(e => e.stage)).toEqual(['notes', 'draft', 'review', 'check'])
  }, 90_000)

  it('Continue works after a failure, in the same writing conversation', async () => {
    const { job } = await failInReview()
    const writing = (await agyLog()).find(e => e.stem === 'narration-ch1' && e.stage === 'draft')!.conv
    const before = (await agyLog()).length
    await jobs.reviewAgain(job.id)
    await until('chapter 1 saved after Continue', async () => saves.length === 1)
    const resumed = (await since(before)).filter(e => e.event === 'start')
    expect(resumed.map(e => e.stage)).toEqual(['review', 'check'])
    expect(new Set(resumed.map(e => e.conv))).toEqual(new Set([writing]))
    expect(await prisma.antigravityAttempt.count({ where: { jobId: job.id, flow: 'narration' } })).toBe(1)
  }, 90_000)

  it('stops a turn that goes quiet and continues it once in the same conversation', async () => {
    const deps = (jobs as any).deps
    deps.stallMs = 4000
    try {
      await writePlan({ 'narration-ch1': { narration: { hangStage: 'review', hangOnce: true } } })
      const start = await startChapter1()
      await until('chapter 1 saved after one stall', async () => saves.length === 1, 60_000)
      await runDone(start.runId!)
      const job = await job1(start.runId!)
      expect(job.stage).toBe('done')
      const reviews = (await agyLog()).filter(e => e.stem === 'narration-ch1' && e.event === 'start' && e.stage === 'review')
      expect(reviews).toHaveLength(2)
      expect(reviews[1].conv).toBe(reviews[0].conv)
      expect(await prisma.antigravityEvent.count({ where: { jobId: job.id, type: 'stall' } })).toBe(1)
    } finally { deps.stallMs = undefined }
  }, 90_000)

  it('a turn that stays quiet after its one retry waits in Needs attention, and Continue finishes it', async () => {
    const deps = (jobs as any).deps
    deps.stallMs = 4000
    try {
      await writePlan({ 'narration-ch1': { narration: { hangStage: 'review' } } })
      const start = await startChapter1()
      await runDone(start.runId!)
      const stuck = await job1(start.runId!)
      expect(stuck.stage).toBe('needs_attention')
      expect(stuck.lastError).toMatch(/stopped responding/)
      await writePlan({})
      await jobs.reviewAgain(stuck.id)
      await until('chapter 1 saved after Continue', async () => saves.length === 1, 60_000)
    } finally { deps.stallMs = undefined }
  }, 90_000)
})

describe('Hinglish after English', () => {
  /** In-memory Hinglish: each chapter's script and the English it was written from; every save, in order with English. */
  const hindi = new Map<string, { text: string; madeFrom: string }>()
  const order: string[] = []
  const englishSave = narration.save
  const hinglish: NonNullable<NarrationDeps['hinglish']> = {
    input: async chapterId => {
      const chapter = chapters.find(c => c.id === chapterId)!
      const english = scripts.get(chapterId)
      if (!english) return { reason: 'Needs its English script first: the Hinglish is written from it.' }
      const current = hindi.get(chapterId)
      const sourceSha256 = sha(english.script.trim())
      return {
        revision: sha(JSON.stringify({ sourceSha256, summary: english.summary })), seriesTitle: 'Series N', chapterNumber: String(chapter.number),
        source: { script: english.script, summary: english.summary }, sourceSha256,
        scriptSha256: current ? sha(current.text) : null, madeFromSha256: current?.madeFrom ?? null
      }
    },
    save: async (chapterId, text, expected, sourceSha256) => {
      const { parseManualNarration } = await import('../../narrationManual.js')
      const english = scripts.get(chapterId)!
      if (sha(english.script.trim()) !== sourceSha256) throw new Error('The English source changed.')
      const current = hindi.get(chapterId)
      if ((current ? sha(current.text) : null) !== expected) throw new Error('The local script changed.')
      hindi.set(chapterId, { text: parseManualNarration(text, 'hi', english.script).script, madeFrom: sourceSha256 })
      order.push(`hi${chapters.find(c => c.id === chapterId)!.number}`)
      return { phoneSent: true }
    }
  }
  beforeEach(() => {
    engine = 'antigravity'
    hindi.clear()
    order.length = 0
    narration.hinglish = hinglish
    narration.save = async (...args) => {
      const out = await englishSave(...args)
      order.push(`en${chapters.find(c => c.id === args[0])!.number}`)
      return out
    }
  })
  afterEach(async () => {
    await until('workers to settle', async () => (jobs as any).live.size === 0 && (jobs as any).scheduling.size === 0)
    delete narration.hinglish
    narration.save = englishSave
  })

  it('Start process writes each chapter\'s Hinglish right after its English, from it, in one conversation', async () => {
    await writePlan({ 'hinglish-ch1': { hinglish: { latinFirst: true } } })
    const start = await jobs.startNext({ seriesId, partNumber: 1, kind: 'narration' })
    await until('both chapters in both languages', async () => order.length >= 4, 120_000)
    const run = await runDone(start.runId!)
    expect(run.control).toBe('completed')
    expect(order).toEqual(['en1', 'hi1', 'en2', 'hi2'])
    for (const chapter of chapters) {
      const saved = hindi.get(chapter.id)!
      expect(saved.madeFrom).toBe(sha(scripts.get(chapter.id)!.script.trim()))
      expect(saved.text).not.toMatch(/[A-Za-z]/)
      expect(saved.text.split('\n\n')).toHaveLength(scripts.get(chapter.id)!.script.split('\n\n').length)
    }
    const log = (await agyLog()).filter(e => e.stem === 'hinglish-ch1')
    expect(log.filter(e => e.event === 'start').map(e => e.stage)).toEqual(['hi_scenes', 'hi_script', 'hi_check'])
    expect(new Set(log.filter(e => e.event === 'start').map(e => e.conv)).size).toBe(1)
    expect(log.find(e => e.what === 'latin')?.error).toMatch(/Devanagari/)
    const done = await prisma.antigravityPageJob.findMany({ where: { runId: start.runId! }, orderBy: { createdAt: 'asc' } })
    expect(done.map(j => [j.filename, j.stage])).toEqual([['narration-en', 'done'], ['narration-hi', 'done'], ['narration-en', 'done'], ['narration-hi', 'done']])
  }, 180_000)

  it('Start process writes only the missing Hinglish; ticking a chapter rewrites its English, then its Hinglish over the old one', async () => {
    for (const chapter of chapters) scripts.set(chapter.id, { script: 'One thing happens.\n\nThen another thing happens.', summary: `Earlier story ${chapter.number}.`, closing: 'Then another thing happens.' })
    const ch1 = chapters[0].id
    hindi.set(ch1, { text: 'पुरानी कहानी।', madeFrom: sha(scripts.get(ch1)!.script.trim()) })
    const fill = await jobs.startNext({ seriesId, partNumber: 1, kind: 'narration' })
    await runDone(fill.runId!)
    expect(order).toEqual(['hi2'])
    expect(hindi.get(ch1)!.text).toBe('पुरानी कहानी।')

    order.length = 0
    const old = hindi.get(ch1)!
    const ticked = await jobs.start({ seriesId, partNumber: 1, kind: 'narration', prepareOnly: false, pages: [{ chapterId: ch1, filename: 'narration-en' }] })
    await until('chapter 1 rewritten in both languages', async () => order.length >= 2, 120_000)
    await runDone(ticked.runId!)
    expect(order).toEqual(['en1', 'hi1'])
    expect(hindi.get(ch1)!.text).not.toBe(old.text)
    expect(hindi.get(ch1)!.madeFrom).toBe(sha(scripts.get(ch1)!.script.trim()))
  }, 180_000)
})
