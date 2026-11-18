/**
 * AntiGravity Metadata end to end: the real job runner and MCP bridge over loopback HTTP, a real SQLite
 * database, real reviewed + cut chapters (Clipper's own pointer, review, cut and receipt code), and the
 * fake `agy` (fixtures/fake-agy.mjs) answering STUDIO METADATA prompts through fetch_crop / submit_metadata.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../seriesRestartGuard.js', () => ({ requireSeriesRestartReady: async () => null, seriesRestartPending: async () => false }))
vi.mock('../../chapterPageReplacement.js', () => ({ readPageReplacement: async () => null, pageReplacementActive: () => false }))
vi.mock('../../editorAutoPublish.js', () => ({ queueEditorPublish: vi.fn() }))

const here = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(here, '../../../..')
const FAKE_AGY = path.join(here, 'fixtures', 'fake-agy.mjs')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-metadata-'))
const dbUrl = `file:${path.join(tmp, 'test.db')}`
process.env.DOWNLOAD_ROOT = path.join(tmp, 'library')
process.env.FAKE_AGY_PLAN = path.join(tmp, 'plan.json')
process.env.FAKE_AGY_LOG = path.join(tmp, 'agy.log')

let prisma: PrismaClient
let jobs: import('../jobs.js').AntigravityJobs
let server: http.Server
let seriesId = ''
const chapters: { id: string; number: number; folderPath: string; seriesId: string; series: { title: string } }[] = []
const SCRIPT = 'The traveller finds a sword.\n\nHe walks into the storm.'

/** n horizontal strips on a 400×(n·100) page; n = 0 makes a page with no crops. */
async function makeCutPage(chapter: (typeof chapters)[number], filename: string, n: number) {
  const { writeImagePoints } = await import('../../clipper3/perImageStore.js')
  const { sha256 } = await import('../../clipper3/studioCropAuthorityModel.js')
  const dir = path.join(process.env.DOWNLOAD_ROOT!, chapter.folderPath)
  await fs.mkdir(dir, { recursive: true })
  const height = Math.max(1, n) * 100
  await sharp({ create: { width: 400, height, channels: 3, background: '#4477aa' } }).png().toFile(path.join(dir, filename))
  const crops = Array.from({ length: n }, (_, i) => ({
    id: `crop-${String(i + 1).padStart(2, '0')}`, reason: 'panel',
    crop: { mode: 'rectangle' as const, points: [{ id: 'P1', x: 0, y: i / n }, { id: 'P2', x: 1, y: i / n }, { id: 'P3', x: 1, y: (i + 1) / n }, { id: 'P4', x: 0, y: (i + 1) / n }] }
  }))
  await writeImagePoints(chapter.folderPath, filename, {
    format: 'four-point-crop', version: '1.0', coordinateSystem: 'normalized', image: { filename, width: 400, height }, crops,
    workflow: 'clipper-geometry/1', sourceSha256: sha256(await fs.readFile(path.join(dir, filename)))
  } as any)
  return crops
}

/** Review + Crop Sections exactly as Clipper does them, then the cut receipt Metadata jobs are bound to. */
async function reviewAndCut(chapter: (typeof chapters)[number], pages: Record<string, number>) {
  const { setDesktopReview } = await import('../../clipper3/chapterReview.js')
  const { cutImageCrops } = await import('../../clipper3/perImageCrop.js')
  const { captureMetadataGeometry, recordMetadataCut } = await import('../../clipper3/metadataSplit.js')
  const made: Record<string, Awaited<ReturnType<typeof makeCutPage>>> = {}
  for (const [filename, n] of Object.entries(pages)) made[filename] = await makeCutPage(chapter, filename, n)
  await fs.writeFile(path.join(process.env.DOWNLOAD_ROOT!, chapter.folderPath, 'script.md'), SCRIPT)
  await setDesktopReview(chapter.folderPath, true)
  const baseline = await captureMetadataGeometry(chapter)
  for (const [filename, crops] of Object.entries(made)) await cutImageCrops({ folderPath: chapter.folderPath, imageFilename: filename, crops, slug: 'series_m' })
  await recordMetadataCut(chapter, baseline)
}

async function writePlan(plan: Record<string, unknown>) {
  await fs.writeFile(process.env.FAKE_AGY_PLAN!, JSON.stringify(plan))
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
const jobFor = (runId: string, filename: string) => prisma.antigravityPageJob.findFirstOrThrow({ where: { runId, filename } })
const metadataOf = async (chapter: (typeof chapters)[number], filename: string) => {
  const { readImageMetadata } = await import('../../clipper3/perImageStore.js')
  return readImageMetadata(chapter.folderPath, filename)
}

beforeAll(async () => {
  await fs.writeFile(path.join(tmp, 'test.db'), '')
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], { cwd: serverDir, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'ignore' })
  await fs.chmod(FAKE_AGY, 0o755)
  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
  const series = await prisma.series.create({ data: { title: 'Series M', sourceSite: 'test', rootFolder: 'Series M' } })
  seriesId = series.id
  for (const number of [1, 2]) {
    const folderPath = `Series M/Chapter 00${number}`
    const row = await prisma.chapter.create({ data: { seriesId, number, folderPath, status: 'done' } })
    chapters.push({ id: row.id, number, folderPath, seriesId, series: { title: 'Series M' } })
  }
  // Chapter 1: reviewed and cut — 10 crops (two batches), a page without crops, and 3 crops.
  await reviewAndCut(chapters[0], { 'page_001.png': 10, 'page_002.png': 0, 'page_003.png': 3 })
  // Chapter 2: pointers saved but never reviewed, so it can't have Metadata yet.
  await makeCutPage(chapters[1], 'page_001.png', 2)

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
    // Metadata never touches Drive: any call fails the test.
    drive: { requireActiveConnection: async () => { throw new Error('Drive must not be used for Metadata') }, api: () => { throw new Error('Drive must not be used for Metadata') } } as any,
    port: (server.address() as { port: number }).port,
    attemptRoot: path.join(tmp, 'attempts'),
    cliHome: path.join(tmp, 'agy-home'),
    settings: async () => ({ engine: 'antigravity', model: 'fake-model', modelLabel: 'Fake', effort: null, sandbox: false, concurrency: 2, pageTimeoutMinutes: 2, executable: FAKE_AGY, cliVersion: 'fake-1' } as any),
    prompts: () => prompts.pack(),
    publisher: { publish: async () => { throw new Error('Metadata must not publish to R2') } } as any,
    // Recreate only: the result + new job go to R2 and phones are asked to sync.
    publishMetadata: async chapter => {
      published.push(chapter.id)
      if (publishFails) throw new Error('R2 is down')
      return { queued: 3, results: 1 }
    }
  })
}, 60_000)

const published: string[] = []
let publishFails = false

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

describe('AntiGravity Metadata', () => {
  it('Start process describes every eligible page of the part, one conversation per page, and saves valid Metadata', async () => {
    await writePlan({ page_003: { metadata: { badFirst: true } } })
    const start = await jobs.startNext({ seriesId, partNumber: 1, kind: 'metadata' })
    const run = await runDone(start.runId!)
    expect(run.control).toBe('completed')
    expect(run.kind).toBe('metadata')
    expect(run.connectionId).toBeNull()

    const all = await prisma.antigravityPageJob.findMany({ where: { runId: start.runId! } })
    // Chapter 2 is not reviewed: none of its pages were taken.
    expect(all.map(j => [j.chapterId, j.filename, j.stage, j.kind]).sort()).toEqual([
      [chapters[0].id, 'page_001.png', 'done', 'metadata'], [chapters[0].id, 'page_002.png', 'done', 'metadata'], [chapters[0].id, 'page_003.png', 'done', 'metadata']
    ].sort())

    // Every page's Metadata passes Clipper's own validation and the Editor's chapter check.
    const { requireCurrentSplitMetadata } = await import('../../clipper3/metadataSplit.js')
    await expect(requireCurrentSplitMetadata(chapters[0])).resolves.toBe(true)
    const page1 = JSON.parse((await metadataOf(chapters[0], 'page_001.png'))!)
    expect(page1.crops).toHaveLength(10)
    expect(page1.crops.map((c: { id: string }) => c.id)).toEqual(Array.from({ length: 10 }, (_, i) => `crop-${String(i + 1).padStart(2, '0')}`))
    expect(page1.storyLinking.scriptSegments).toEqual([{ id: 'P0001', text: 'The traveller finds a sword.' }])
    expect(JSON.parse((await metadataOf(chapters[0], 'page_002.png'))!).crops).toEqual([])

    const attempts = await prisma.antigravityAttempt.findMany({ where: { jobId: { in: all.map(j => j.id) } } })
    // The page without crops needed no AI.
    expect(attempts.map(a => all.find(j => j.id === a.jobId)!.filename).sort()).toEqual(['page_001.png', 'page_003.png'])
    expect(attempts.every(a => a.flow === 'metadata' && a.status === 'completed')).toBe(true)
    expect(new Set(attempts.map(a => a.conversationId)).size).toBe(2)
    const log = await agyLog()
    // Ten crops = two batches (8 + 2) in page_001's one conversation; the second batch resumed it.
    const p1 = log.filter(e => e.stem === 'page_001' && e.event === 'submit_metadata')
    expect(p1.map(e => e.batch.length)).toEqual([8, 2])
    expect(new Set(log.filter(e => e.stem === 'page_001').map(e => e.conv)).size).toBe(1)
    expect(log.filter(e => e.stem === 'page_001' && e.event === 'start').map(e => e.resumed)).toEqual([false, true])
    // A record missing a field was refused with a correction, then the fixed batch was accepted in the same turn.
    const p3 = log.filter(e => e.stem === 'page_003' && e.event === 'submit_metadata')
    expect(p3[0].error).toMatch(/missing required fields: reviewReason/)
    expect(p3[1].error).toBeNull()
    // Every crop was fetched through Studio's tool, not read from disk by the model.
    expect(log.filter(e => e.stem === 'page_001' && e.event === 'fetched' && !e.error)).toHaveLength(10)

    // Image Clipper's page list never shows Metadata jobs.
    expect(await jobs.pageJobs([chapters[0].id])).toEqual([])
    expect((await jobs.pageJobs([chapters[0].id], 'metadata')).map(j => j.stage)).toEqual(['done', 'done', 'done'])
  }, 40_000)

  it('skips pages that already have Metadata and pages of chapters that are not reviewed, with the reason', async () => {
    const out = await jobs.start({ seriesId, partNumber: 1, kind: 'metadata', prepareOnly: false, pages: [
      { chapterId: chapters[0].id, filename: 'page_001.png' }, { chapterId: chapters[1].id, filename: 'page_001.png' }
    ] })
    expect(out.created).toEqual([])
    expect(out.skipped.map(s => s.reason)).toEqual(['Metadata already saved.', expect.stringMatching(/review/i)])
  })

  it('Recreate makes a saved page again under a new job revision, keeps the old file, and sends it to R2/phones (Retry after a failed send)', async () => {
    const { currentMetadataJobs, metadataGenerations, requireCurrentSplitMetadata } = await import('../../clipper3/metadataSplit.js')
    const revisions = async () => new Map((await currentMetadataJobs(chapters[0], await metadataGenerations(chapters[0]))).jobs.map(j => [JSON.parse(j.payloadText).page as string, j.revision]))
    const before = await revisions()
    const old = (await metadataOf(chapters[0], 'page_003.png'))!
    published.length = 0
    publishFails = true
    const start = await jobs.start({ seriesId, partNumber: 1, kind: 'metadata', prepareOnly: false, recreate: true, pages: [{ chapterId: chapters[0].id, filename: 'page_003.png' }] })
    expect(start.created).toHaveLength(1)
    await runDone(start.runId!)
    let job = await jobFor(start.runId!, 'page_003.png')
    // Saved in Studio; the R2 send failed and waits for Retry.
    expect(job.stage).toBe('publish_failed')
    expect(job.lastError).toMatch(/saved in Studio.*R2 is down/)
    const after = await revisions()
    expect(after.get('page_003.png')).not.toBe(before.get('page_003.png'))
    // Only the recreated page's job changed.
    expect(after.get('page_001.png')).toBe(before.get('page_001.png'))
    expect(after.get('page_002.png')).toBe(before.get('page_002.png'))
    const saved = JSON.parse((await metadataOf(chapters[0], 'page_003.png'))!)
    expect(saved.metadataJob.revision).toBe(after.get('page_003.png'))
    expect(saved.storyLinking.inputRevision).toBe(after.get('page_003.png'))
    await expect(requireCurrentSplitMetadata(chapters[0])).resolves.toBe(true)
    const resets = path.join(process.env.DOWNLOAD_ROOT!, chapters[0].folderPath, '.metadata-resets')
    const [backup] = await fs.readdir(resets)
    const kept = await fs.readdir(path.join(resets, backup))
    expect(await fs.readFile(path.join(resets, backup, kept[0]), 'utf8')).toBe(old)

    publishFails = false
    await jobs.retry(job.id)
    job = await jobFor(start.runId!, 'page_003.png')
    expect(job.stage).toBe('done')
    expect(published).toEqual([chapters[0].id, chapters[0].id])
  }, 30_000)

  it('a changed English script makes the saved Metadata stale; the next run describes those pages again', async () => {
    await fs.writeFile(path.join(process.env.DOWNLOAD_ROOT!, chapters[0].folderPath, 'script.md'), `${SCRIPT}\n\nThe sword glows.`)
    const { readMetadataChapter } = await import('../../metadataChapterStatus.js')
    expect((await readMetadataChapter(chapters[0])).state).not.toBe('complete')
    const start = await jobs.start({ seriesId, partNumber: 1, kind: 'metadata', prepareOnly: false, pages: [{ chapterId: chapters[0].id, filename: 'page_003.png' }] })
    expect(start.created).toHaveLength(1)
    await runDone(start.runId!)
    expect((await jobFor(start.runId!, 'page_003.png')).stage).toBe('done')
    const saved = JSON.parse((await metadataOf(chapters[0], 'page_003.png'))!)
    expect(saved.storyLinking.scriptSha256).not.toBe(JSON.parse((await metadataOf(chapters[0], 'page_001.png'))!).storyLinking.scriptSha256)
  }, 30_000)

  it('refuses a submission before the crops were fetched, and keeps one process at a time across kinds', async () => {
    await writePlan({ page_001: { metadata: { skipFetch: true } } })
    // page_001's Metadata is stale since the script changed: it is eligible again.
    const start = await jobs.start({ seriesId, partNumber: 1, kind: 'metadata', prepareOnly: false, pages: [{ chapterId: chapters[0].id, filename: 'page_001.png' }] })
    // While it runs, an Image Clipper start on the same part is refused.
    await until('page_001 describing', async () => (await jobFor(start.runId!, 'page_001.png')).stage === 'describing')
    await expect(jobs.startNext({ seriesId, partNumber: 1 })).rejects.toThrow(/Metadata process is already running.*One process at a time/)
    await runDone(start.runId!)
    const job = await jobFor(start.runId!, 'page_001.png')
    expect(job.stage).toBe('failed')
    expect(job.lastError).toMatch(/No valid Metadata/)
    const refused = (await agyLog()).filter(e => e.event === 'submit_metadata')
    expect(refused.length).toBeGreaterThan(0)
    expect(refused.every(e => /Fetch and inspect every requested crop first/.test(e.error))).toBe(true)
    // Retry: a new conversation, this time with the crops fetched.
    await writePlan({})
    await jobs.retry(job.id)
    await until('page_001 done after retry', async () => (await prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: job.id } })).stage === 'done')
    await runDone(job.runId)
  }, 40_000)

  it('Continue resumes a page left in Needs attention in its own conversation, from the batches already accepted', async () => {
    await fs.writeFile(path.join(process.env.DOWNLOAD_ROOT!, chapters[0].folderPath, 'script.md'), `${SCRIPT}\n\nThe storm ends.`)
    await writePlan({ page_001: { metadata: { skipFetchResumed: true } } })
    const start = await jobs.start({ seriesId, partNumber: 1, kind: 'metadata', prepareOnly: false, pages: [{ chapterId: chapters[0].id, filename: 'page_001.png' }] })
    expect(start.created).toHaveLength(1)
    await runDone(start.runId!)
    const stuck = await prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: start.created[0] } })
    // The first batch (8 crops) was accepted; the second never was.
    expect(stuck.stage).toBe('needs_attention')
    const before = await prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: stuck.currentAttemptId! } })
    expect(Object.keys(JSON.parse(before.stepsStateJson!).records)).toHaveLength(8)
    expect(await jobs.reject(stuck.id, { rerun: false }).catch(e => e.message)).toMatch(/not rejected here/)

    await writePlan({})
    await fs.rm(process.env.FAKE_AGY_LOG!, { force: true })
    await jobs.reviewAgain(stuck.id)
    await until('page_001 done after Continue', async () => (await prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: stuck.id } })).stage === 'done')
    const after = await prisma.antigravityAttempt.findMany({ where: { jobId: stuck.id } })
    expect(after.find(a => a.id === before.id)!.status).toBe('completed')
    const log = await agyLog()
    // Same conversation, and only the two crops left were asked for.
    expect(new Set(log.map(e => e.conv))).toEqual(new Set([before.conversationId]))
    expect(log.filter(e => e.event === 'submit_metadata').map(e => e.batch.length)).toEqual([2])
    expect(JSON.parse((await metadataOf(chapters[0], 'page_001.png'))!).crops).toHaveLength(10)
  }, 40_000)
})
