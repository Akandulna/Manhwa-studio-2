/**
 * AntiGravity → Timeline end to end: the real job runner and MCP bridge over loopback HTTP, a real SQLite
 * database, Studio's real small-batches engine (editorWorkflow.ts) and one-shot checks, and the fake `agy`
 * (fixtures/fake-agy.mjs) answering the timeline tools. Editor 2.0's inputs, processor and save are an
 * in-memory stand-in (EditorDeps), so what the job saves is inspected directly.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { acceptWorkflowReply, buildEditorWorkflow, digest, nextWorkflowTask, validateWorkflowTimeline, type WorkflowState } from '../../editorWorkflow.js'
import type { BatchView, EditorDeps, OneShotInput } from '../editorFlow.js'
import type { NarrationLanguage } from '../../narrationLanguage.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(here, '../../../..')
const FAKE_AGY = path.join(here, 'fixtures', 'fake-agy.mjs')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-editor-'))
const dbUrl = `file:${path.join(tmp, 'test.db')}`
process.env.DOWNLOAD_ROOT = path.join(tmp, 'library')
process.env.FAKE_AGY_PLAN = path.join(tmp, 'plan.json')
process.env.FAKE_AGY_LOG = path.join(tmp, 'agy.log')

let prisma: PrismaClient
let jobs: import('../jobs.js').AntigravityJobs
let server: http.Server
let seriesId = ''
const chapters: { id: string; number: number }[] = []

// Two voice sections; four crops in one visual group.
const TIMELINE = [
  '## Section 1', '00:00.00 - 00:04.00: "The traveller finds a sword."', '00:04.00 - 00:08.00: "He lifts it high."',
  '## Section 2', '00:00.00 - 00:05.00: "A storm gathers over the hills."'
].join('\n')
const IMAGES = ['series_t_ch1_page_001_crop_01.png', 'series_t_ch1_page_001_crop_02.png', 'series_t_ch1_page_002_crop_01.png', 'series_t_ch1_page_002_crop_02.png']
const METADATA = `## page_001\n\n${JSON.stringify({ crops: IMAGES.slice(0, 2).map((f, i) => ({ exportedFilename: f, description: i ? 'A man raises a glowing sword.' : 'A traveller kneels by a sword.' })) })}\n\n## page_002\n\n${JSON.stringify({ crops: IMAGES.slice(2).map((f, i) => ({ exportedFilename: f, description: i ? 'Lightning over hills.' : 'Dark clouds roll in.' })) })}`
const SECTIONS = [{ number: 1, durationSec: 8 }, { number: 2, durationSec: 5 }]

/** In-memory Editor 2.0: saved timelines, readiness, the one-shot package and Studio's real small-batches checkpoint. */
const saved = new Map<string, { json: string; model: string }>()
const checkpoints = new Map<string, WorkflowState>()
const visual = new Map<string, WorkflowState>()
const notReady = new Map<string, string[]>()
const k = (chapterId: string, language: NarrationLanguage) => `${chapterId}|${language}`
const workflow = () => buildEditorWorkflow(TIMELINE, METADATA, IMAGES, null, SECTIONS)
const view = (state: WorkflowState): BatchView => {
  const w = workflow()
  const counts = { beats: w.beats.length, crops: w.crops.length, visualGroups: w.scenes.length }
  try { return { ...nextWorkflowTask(w, state), error: null, revision: digest(state), sourceHash: w.sourceHash, counts } }
  catch (e) { return { task: null, completed: 0, warnings: [], json: null, error: (e as Error).message, revision: digest(state), sourceHash: w.sourceHash, counts } }
}
const editor: EditorDeps = {
  savedTimeline: async (chapterId, language) => saved.get(k(chapterId, language))?.json ?? null,
  blockers: async (chapterId, language) => notReady.get(k(chapterId, language)) ?? [],
  oneShot: async (): Promise<OneShotInput> => ({ revision: 'a'.repeat(64), prompt: 'Make the timeline JSON for this chapter.', timeline: TIMELINE, metadata: METADATA, sections: SECTIONS, images: IMAGES, retainedStoryLinks: false }),
  batches: async (chapterId, language, reply) => {
    // As editorWorkflowStore: both languages share the visual index (V… replies) of a chapter.
    const state = { replies: { ...visual.get(chapterId)?.replies, ...checkpoints.get(k(chapterId, language))?.replies } }
    if (!reply) return view(state)
    const next = acceptWorkflowReply(workflow(), state, reply.taskId, reply.fingerprint, reply.reply)
    checkpoints.set(k(chapterId, language), next)
    visual.set(chapterId, { replies: Object.fromEntries(Object.entries(next.replies).filter(([id]) => id.startsWith('V'))) })
    return view(next)
  },
  process: async (_chapterId, json) => {
    const refs = (JSON.parse(json).sections as { timelines: { selectedImages: string[] }[] }[]).flatMap(s => s.timelines.flatMap(t => t.selectedImages))
    return { missingRefs: refs.filter(r => !IMAGES.includes(r)), warnings: [] }
  },
  save: async (chapterId, language, json, model) => { saved.set(k(chapterId, language), { json, model }) }
}

async function writePlan(plan: Record<string, unknown>) { await fs.writeFile(process.env.FAKE_AGY_PLAN!, JSON.stringify(plan)) }
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
}, 40_000)

beforeAll(async () => {
  await fs.writeFile(path.join(tmp, 'test.db'), '')
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], { cwd: serverDir, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'ignore' })
  await fs.chmod(FAKE_AGY, 0o755)
  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
  const series = await prisma.series.create({ data: { title: 'Series T', sourceSite: 'test', rootFolder: 'Series T' } })
  seriesId = series.id
  for (const number of [1, 2, 3]) {
    const row = await prisma.chapter.create({ data: { seriesId, number, folderPath: `Series T/Chapter 00${number}`, status: 'done' } })
    chapters.push({ id: row.id, number })
  }
  // Chapter 2 has no Hindi voiceover yet; chapter 3 isn't cut in either language.
  notReady.set(k(chapters[1].id, 'hi'), ['Voiceover audio', 'Alignment'])
  notReady.set(k(chapters[2].id, 'en'), ['Cropped images'])
  notReady.set(k(chapters[2].id, 'hi'), ['Cropped images'])

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
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  jobs = new AntigravityJobs({
    prisma,
    drive: { requireActiveConnection: async () => { throw new Error('Drive must not be used for Timeline') }, api: () => { throw new Error('Drive must not be used for Timeline') } } as any,
    port: (server.address() as { port: number }).port,
    attemptRoot: path.join(tmp, 'attempts'),
    cliHome: path.join(tmp, 'agy-home'),
    settings: async () => ({ engine: 'antigravity', model: 'fake-model', modelLabel: 'Fake', effort: null, sandbox: false, concurrency: 2, pageTimeoutMinutes: 2, executable: FAKE_AGY, cliVersion: 'fake-1' } as any),
    prompts: () => prompts.pack(),
    publisher: { publish: async () => { throw new Error('Timeline must not publish through AntiGravity') } } as any,
    editor
  })
}, 60_000)

beforeEach(async () => {
  await fs.rm(process.env.FAKE_AGY_LOG!, { force: true })
  await writePlan({})
})

afterAll(async () => {
  await jobs?.shutdown()
  server?.close()
  await prisma?.$disconnect()
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('AntiGravity Timeline', () => {
  it('Start process (small batches, both languages) makes every ready chapter\'s timeline, one conversation per chapter and language', async () => {
    // ch1 English stops after 2 batches in its first turn: Studio continues the same conversation.
    await writePlan({ 'ch1-en': { timeline: { stopAfter: 2 } } })
    const start = await jobs.startNext({ seriesId, partNumber: 1, kind: 'editor', editor: { method: 'batches', languages: ['en', 'hi'] } })
    const run = await runDone(start.runId!)
    expect(run.control).toBe('completed')
    expect(run.kind).toBe('editor')
    expect(JSON.parse(run.promptJson).editor).toEqual({ method: 'batches', languages: ['en', 'hi'] })

    const all = await prisma.antigravityPageJob.findMany({ where: { runId: start.runId! } })
    // Chapter 2 Hindi and chapter 3 are not ready in Editor 2.0: never taken.
    expect(all.map(j => [chapters.findIndex(c => c.id === j.chapterId) + 1, j.filename, j.stage, j.kind]).sort()).toEqual([
      [1, 'timeline-en', 'done', 'editor'], [1, 'timeline-hi', 'done', 'editor'], [2, 'timeline-en', 'done', 'editor']
    ])
    // Every saved timeline is the small-batches result: every beat once, real crop files, exact timestamps.
    for (const [chapter, language] of [[chapters[0], 'en'], [chapters[0], 'hi'], [chapters[1], 'en']] as const) {
      const got = saved.get(k(chapter.id, language))!
      expect(() => validateWorkflowTimeline(workflow(), got.json)).not.toThrow()
      expect(got.model).toBe('Studio AntiGravity (Antigravity · fake-model, Small batches)')
    }
    const attempts = await prisma.antigravityAttempt.findMany({ where: { jobId: { in: all.map(j => j.id) } } })
    expect(attempts.every(a => a.flow === 'editor-batches' && a.status === 'completed')).toBe(true)
    expect(new Set(attempts.map(a => a.conversationId)).size).toBe(3)
    const log = await agyLog()
    const ch1 = log.filter(e => e.stem === 'ch1-en')
    expect(new Set(ch1.map(e => e.conv)).size).toBe(1)
    expect(ch1.filter(e => e.event === 'start').map(e => e.resumed)).toEqual([false, true])
    // The only refusals: a batch both languages share (the visual index) that the other conversation answered first.
    expect(log.filter(e => e.event === 'submit_task' && e.error).every(e => /is not the current batch/.test(e.error))).toBe(true)

    expect(await jobs.pageJobs([chapters[0].id])).toEqual([])
    expect((await jobs.pageJobs([chapters[0].id], 'editor')).map(j => j.stage)).toEqual(['done', 'done'])
  }, 60_000)

  it('skips chapters with a saved timeline and chapters Editor 2.0 is not ready for, with the reason', async () => {
    const out = await jobs.start({ seriesId, partNumber: 1, kind: 'editor', prepareOnly: false, editor: { method: 'batches', languages: ['en'] }, pages: [
      { chapterId: chapters[0].id, filename: 'timeline-en' }, { chapterId: chapters[2].id, filename: 'timeline-en' }, { chapterId: chapters[0].id, filename: 'page_001.png' }
    ] })
    expect(out.created).toEqual([])
    expect(out.skipped.map(s => s.reason)).toEqual(['Timeline already saved.', 'Not ready in Editor 2.0: Cropped images', 'Not a timeline of this chapter.'])
    await expect(jobs.start({ seriesId, partNumber: 1, kind: 'editor', prepareOnly: true, pages: [{ chapterId: chapters[0].id, filename: 'timeline-en' }] })).rejects.toThrow(/no Upload to Drive/)
  })

  it('one-shot: refuses an image that is not a crop file with the list of problems, then saves the corrected timeline', async () => {
    saved.delete(k(chapters[0].id, 'en'))
    await writePlan({ 'ch1-en': { timeline: { badFirst: true } } })
    const start = await jobs.start({ seriesId, partNumber: 1, kind: 'editor', prepareOnly: false, editor: { method: 'oneshot', languages: ['en'] }, pages: [{ chapterId: chapters[0].id, filename: 'timeline-en' }] })
    expect(start.created).toHaveLength(1)
    await runDone(start.runId!)
    const job = await prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: start.created[0] } })
    expect(job.stage).toBe('done')
    const submits = (await agyLog()).filter(e => e.event === 'submit_timeline')
    expect(submits[0].error).toMatch(/"no_such_crop\.png" isn't one of the crop files in the metadata/)
    expect(submits[1].error).toBeNull()
    const got = saved.get(k(chapters[0].id, 'en'))!
    expect(JSON.parse(got.json).sections.map((s: { section: string }) => s.section)).toEqual(['Section 1', 'Section 2'])
    expect(got.model).toBe('Studio AntiGravity (Antigravity · fake-model, One-shot)')
    const attempt = await prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: job.currentAttemptId! } })
    expect(attempt.flow).toBe('editor-oneshot')
  }, 40_000)

  it('Continue resumes small batches in the same conversation from the accepted batches, and keeps one process at a time', async () => {
    saved.delete(k(chapters[1].id, 'en'))
    checkpoints.delete(k(chapters[1].id, 'en'))
    // One batch, then nothing: the chapter is left in Needs attention with its accepted batch kept.
    await writePlan({ 'ch2-en': { timeline: { stopAfter: 1, delayMs: 300 } } })
    const start = await jobs.start({ seriesId, partNumber: 1, kind: 'editor', prepareOnly: false, editor: { method: 'batches', languages: ['en'] }, pages: [{ chapterId: chapters[1].id, filename: 'timeline-en' }] })
    // The fake reads its plan before it logs its start: only then is it safe to change the plan for later turns.
    await until('ch2 first turn started', async () => (await agyLog()).some(e => e.stem === 'ch2-en' && e.event === 'start'))
    await expect(jobs.startNext({ seriesId, partNumber: 1, kind: 'metadata' })).rejects.toThrow(/A Timeline process is already running.*One process at a time/)
    await writePlan({ 'ch2-en': { timeline: { silent: true } } })
    await runDone(start.runId!)
    const stuck = await prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: start.created[0] } })
    expect(stuck.stage).toBe('needs_attention')
    expect(Object.keys(checkpoints.get(k(chapters[1].id, 'en'))!.replies).length).toBeGreaterThan(0)
    const before = await prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: stuck.currentAttemptId! } })
    expect(await jobs.reject(stuck.id, { rerun: false }).catch(e => e.message)).toMatch(/not rejected here/)

    await writePlan({})
    await fs.rm(process.env.FAKE_AGY_LOG!, { force: true })
    await jobs.reviewAgain(stuck.id)
    await until('ch2 done after Continue', async () => (await prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: stuck.id } })).stage === 'done')
    const log = await agyLog()
    expect(new Set(log.map(e => e.conv))).toEqual(new Set([before.conversationId]))
    // The batch accepted before was not asked again.
    expect(log.filter(e => e.event === 'submit_task').map(e => e.id)).not.toContain('V001')
    expect(() => validateWorkflowTimeline(workflow(), saved.get(k(chapters[1].id, 'en'))!.json)).not.toThrow()
    await runDone(stuck.runId)
  }, 60_000)
})
