import { afterEach, describe, expect, it, vi } from 'vitest'
import { toolByName } from '../agentTools.js'
import { startSkip, tickBlock } from '../clipperTools.js'
import { ScriptWatcher } from '../scriptWatcher.js'
import { systemPrompt } from '../agent.js'

/** A fake Studio API for one series "Show" with chapters 1–3 (part 1) and 21 (part 2). */
function fakeStudio() {
  const state = {
    calls: [] as string[],
    bodies: {} as Record<string, any>,
    engine: 'claude' as 'antigravity' | 'codex' | 'claude',
    proofValid: false,
    checkOk: true,
    drive: 'connected',
    r2: true,
    current: { live: false, run: null as any },
    reviews: { c1: { reviewed: false, by: null }, c2: { reviewed: true, by: 'desktop' }, c3: { reviewed: false, by: null } } as Record<string, any>,
    summary: [
      { chapterId: 'c1', totalImages: 3, attachedImages: 1, fullyAttached: false, chopped: false, cropComplete: false, cropping: false, review: { reviewed: false } },
      { chapterId: 'c2', totalImages: 2, attachedImages: 2, fullyAttached: true, chopped: true, cropComplete: true, cropping: false, review: { reviewed: true, cropped: true } },
      { chapterId: 'c3', totalImages: 1, attachedImages: 0, fullyAttached: false, chopped: false, cropComplete: false, cropping: false, review: { reviewed: false } },
      { chapterId: 'c21', totalImages: 1, attachedImages: 0, fullyAttached: false, chopped: false, cropComplete: false, cropping: false, review: { reviewed: false } }
    ] as any[],
    images: {
      c1: [
        { filename: 'p1.webp', width: 800, height: 9000, status: 'done', cropCount: 4 },
        { filename: 'p2.webp', width: 800, height: 9000, status: 'pending', cropCount: 0 },
        { filename: 'p3.webp', width: 2400, height: 9000, status: 'pending', cropCount: 0 }
      ],
      c2: [], c3: [{ filename: 'q1.webp', width: 700, height: 5000, status: 'pending', cropCount: 0 }], c21: []
    } as Record<string, any[]>,
    jobs: [
      { id: 'j1', runId: 'r0', chapterId: 'c1', filename: 'p1.webp', stage: 'ready_for_human_review', importState: 'imported' },
      { id: 'j2', runId: 'r0', chapterId: 'c1', filename: 'p2.webp', stage: 'failed', lastError: 'model gave up' }
    ] as any[]
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const path = String(url).replace('http://x/api', '')
    const key = `${init?.method ?? 'GET'} ${path}`
    state.calls.push(key)
    if (init?.body) state.bodies[key] = JSON.parse(init.body)
    const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body })
    const conn = (extra: object) => ({ installation: { path: '/bin/x' }, account: { signedIn: true }, settings: { model: 'm1', modelLabel: 'Model One', effort: 'high' }, proofValid: state.proofValid, proofNote: 'Run the test again.', ...extra })
    let m: RegExpMatchArray | null
    switch (key) {
      case 'GET /antigravity/connection': return reply(state.engine === 'antigravity' ? conn({ settings: { engine: 'antigravity', model: 'g', concurrency: 2 } }) : { settings: { engine: state.engine, concurrency: 2 }, installation: { path: '/agy' }, proofValid: true })
      case 'GET /antigravity/claude/connection': return reply(conn({}))
      case 'GET /antigravity/codex/connection': return reply(conn({ accounts: { accounts: [{ enabled: true, limited: false }] } }))
      case 'POST /antigravity/claude/check': state.proofValid = state.checkOk; return reply({ ok: state.checkOk, model: 'm1', error: state.checkOk ? null : 'no image' })
      case 'GET /google-drive/status': return reply({ state: state.drive, account: { email: 'me@example.com' }, root: { state: 'ok' } })
      case 'GET /antigravity/r2-status': return reply({ configured: state.r2 })
      case 'GET /antigravity/runs/current': return reply(state.current)
      case 'GET /clipper3/series/s1/summary': return reply({ chapters: state.summary })
      case 'POST /antigravity/page-jobs': return reply(state.jobs.filter(j => state.bodies[key].chapterIds.includes(j.chapterId)))
      case 'POST /antigravity/runs': return reply({ runId: 'r1', created: (state.bodies[key].pages ?? [{}]).map((_: unknown, i: number) => `n${i}`), reused: [], skipped: [] })
      case 'POST /clipper3/series/s1/crop-reviewed': return reply({ queued: [{ chapterId: 'c2', chapterNumber: 2 }], skipped: [{ chapterId: 'c1', chapterNumber: 1, reason: 'Needs review, has pending pages, is already cropped, or pages are being replaced' }] })
    }
    if ((m = key.match(/^GET \/clipper3\/chapters\/(\w+)\/images$/))) return reply({ images: state.images[m[1]] })
    if ((m = key.match(/^GET \/clipper3\/chapters\/(\w+)\/review$/))) return reply(state.reviews[m[1]])
    if ((m = key.match(/^PUT \/clipper3\/chapters\/(\w+)\/review$/))) { state.reviews[m[1]] = { reviewed: state.bodies[key].reviewed, by: 'desktop' }; return reply(state.reviews[m[1]]) }
    if ((m = key.match(/^POST \/clipper3\/chapters\/(\w+)\/crop$/))) return reply({ started: true, images: 2 })
    if ((m = key.match(/^POST \/antigravity\/jobs\/(\w+)\/(retry|reject|review|publish)$/))) return reply({ ...state.jobs.find(j => j.id === m![1]), stage: m[2] === 'reject' ? 'rejected' : 'queued' })
    if ((m = key.match(/^POST \/antigravity\/runs\/(\w+)\/(pause|resume|stop|stop-now)$/))) return reply({})
    return reply({ error: `unexpected ${key}` }, 404)
  }))
  const chapters = [{ id: 'c1', number: 1, status: 'done' }, { id: 'c2', number: 2, status: 'done' }, { id: 'c3', number: 3, status: 'done' }, { id: 'c21', number: 21, status: 'done' }]
  const prisma: any = {
    series: { findMany: async () => [{ id: 's1', title: 'Show', rootFolder: 'Show' }], findUnique: async () => ({ title: 'Show' }) },
    chapter: {
      findMany: async () => chapters,
      findFirst: async ({ where }: any) => chapters.find(c => c.number === where.number) ?? null,
      findUnique: async ({ where }: any) => chapters.find(c => c.id === where.id) ?? null
    }
  }
  const watches: any[] = []
  const ctx: any = { prisma, api: 'http://x/api', watch: async (r: any) => { watches.push(r) } }
  return { state, ctx, watches }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Image Clipper tools', () => {
  it('are listed for the agent with the review rule', () => {
    const p = systemPrompt('', '', 'Kuro')
    for (const name of ['clipper_status', 'clipper_start', 'clipper_control', 'clipper_page', 'clipper_fetch_finished', 'clipper_review', 'clipper_crop']) {
      expect(p).toContain(`- ${name}`)
      expect(toolByName(name)).toBeTruthy()
    }
    expect(p).toMatch(/never mark a chapter reviewed unless the user says they checked it/)
  })

  it('page rules match the Image Clipper page', () => {
    const page = { filename: 'a', width: 800, height: 9000, status: 'pending' as const, cropCount: 0 }
    expect(tickBlock(page)).toBeNull()
    expect(tickBlock({ ...page, status: 'done' })).toMatch(/pointers already saved/)
    expect(tickBlock({ ...page, width: 2001 })).toMatch(/wider than 2000/)
    expect(tickBlock({ ...page, managed: { taskId: 't' } })).toMatch(/managed/)
    expect(tickBlock(page, { stage: 'analyzing' })).toMatch(/processing now/)
    expect(tickBlock(page, { stage: 'failed' })).toBeNull()
    expect(startSkip(page, { stage: 'failed' })).toMatch(/waits for Retry/)
  })

  it('status of a part: chapters, problems, review and crop, and why this Mac cannot start', async () => {
    const { state, ctx } = fakeStudio()
    state.drive = 'reconnect_required'
    const out: any = await toolByName('clipper_status')!.run({ series: 'Show', part: 1 }, ctx)
    expect(out.chapters.map((c: any) => c.chapter)).toEqual([1, 2, 3])
    expect(out.chapters[0]).toMatchObject({ pages: '1/3 done', needYou: 1, pending: 1, review: 'not reviewed', crop: 'not cropped' })
    expect(out.chapters[0].problems[0]).toMatch(/p2.webp: failed — model gave up/)
    expect(out.chapters[1]).toMatchObject({ review: 'reviewed', crop: 'cropped' })
    expect(out.thisMac).toMatchObject({ engine: 'Claude (Claude Code)', model: 'Model One', parallelPages: 2 })
    expect(out.thisMac.blockers.join(' ')).toMatch(/Reconnect Google Drive.*Run the test again/)
    const page: any = await toolByName('clipper_status')!.run({ series: 'Show', chapter: 1 }, ctx)
    expect(page.pageList).toEqual([
      '#1 p1.webp: pointers saved (4 crops) · job ready for human review',
      '#2 p2.webp: no pointers · job failed — model gave up · waits for Retry (or tick it)',
      '#3 p3.webp: no pointers · wider than 2000 px'
    ])
  })

  it('Start process runs the engine\'s compatibility test first when only that is missing, then starts and watches', async () => {
    const { state, ctx, watches } = fakeStudio()
    const tool = toolByName('clipper_start')!
    const prepared = await tool.prepare!({ series: 'Show', part: 1 }, ctx)
    expect(state.calls).toContain('POST /antigravity/claude/check')
    expect(await tool.approval?.(prepared, ctx) ?? null).toBeNull()
    const out: any = await tool.run(prepared, ctx)
    expect(state.bodies['POST /antigravity/runs']).toEqual({ seriesId: 's1', partNumber: 1, mode: 'next', kind: 'clipper' })
    expect(out).toMatchObject({ started: true, compatibilityTest: expect.stringMatching(/passed/) })
    expect(watches[0]).toMatchObject({ kind: 'clipper', runId: 'r1', part: 1 })
  })

  it('a failed test, a missing Drive or another process stop the start', async () => {
    const { state, ctx } = fakeStudio()
    const tool = toolByName('clipper_start')!
    state.checkOk = false
    await expect(tool.prepare!({ series: 'Show', part: 1 }, ctx)).rejects.toThrow(/compatibility test .* failed: no image/)
    state.drive = 'disconnected'
    state.calls = []
    await expect(tool.prepare!({ series: 'Show', part: 1 }, ctx)).rejects.toThrow(/Connect Google Drive/)
    expect(state.calls).not.toContain('POST /antigravity/claude/check')
    state.current = { live: true, run: { id: 'rx', kind: 'narration', seriesId: 's1', partNumber: 1, control: 'running' } }
    await expect(tool.prepare!({ series: 'Show', part: 1 }, ctx)).rejects.toThrow(/A Narration process is running/)
  })

  it('chosen pages: only tickable ones are sent; pages need exactly one chapter; upload_only skips the engine', async () => {
    const { state, ctx } = fakeStudio()
    state.proofValid = true
    const tool = toolByName('clipper_start')!
    const prepared = await tool.prepare!({ series: 'Show', chapters: [1, 3] }, ctx)
    expect(prepared.pages).toEqual([{ chapterId: 'c1', filename: 'p2.webp' }, { chapterId: 'c3', filename: 'q1.webp' }])
    expect(prepared.skipped).toEqual(['ch 1 #3: wider than 2000 px'])
    await tool.run(prepared, ctx)
    expect(state.bodies['POST /antigravity/runs']).toMatchObject({ partNumber: 1, prepareOnly: false, kind: 'clipper', pages: prepared.pages })
    await expect(tool.prepare!({ series: 'Show', chapters: [1, 3], pages: [2] }, ctx)).rejects.toThrow(/exactly one chapter/)
    await expect(tool.prepare!({ series: 'Show', chapters: [1], pages: ['p1.webp'] }, ctx)).rejects.toThrow(/pointers already saved/)
    await expect(tool.prepare!({ series: 'Show', chapters: [3, 21] }, ctx)).rejects.toThrow(/several parts/)

    state.proofValid = false
    state.calls = []
    const upload = await tool.prepare!({ series: 'Show', chapters: [1], pages: [2], upload_only: true }, ctx)
    expect(state.calls).not.toContain('POST /antigravity/claude/check')
    await tool.run(upload, ctx)
    expect(state.bodies['POST /antigravity/runs']).toMatchObject({ prepareOnly: true, pages: [{ chapterId: 'c1', filename: 'p2.webp' }] })
  })

  it('joins the process already running on that part', async () => {
    const { state, ctx, watches } = fakeStudio()
    state.current = { live: true, run: { id: 'r7', kind: 'clipper', seriesId: 's1', partNumber: 1, control: 'running' } }
    const tool = toolByName('clipper_start')!
    const prepared = await tool.prepare!({ series: 'Show', part: 1 }, ctx)
    expect(prepared).toMatchObject({ join: true, runId: 'r7' })
    expect(state.calls.some(c => c.endsWith('/check'))).toBe(false)
    expect(await tool.run(prepared, ctx)).toMatchObject({ alreadyRunning: true })
    expect(watches[0]).toMatchObject({ kind: 'clipper', runId: 'r7' })
    await expect(tool.prepare!({ series: 'Show', chapters: [1], upload_only: true }, ctx)).rejects.toThrow(/A process is running on this part/)
  })

  it('control: stop now only after stop, and it needs approval', async () => {
    const { state, ctx } = fakeStudio()
    const tool = toolByName('clipper_control')!
    await expect(tool.prepare!({ action: 'pause' }, ctx)).rejects.toThrow(/No AntiGravity process/)
    state.current = { live: true, run: { id: 'r7', kind: 'clipper', seriesId: 's1', partNumber: 1, control: 'running' } }
    await expect(tool.prepare!({ action: 'stop_now' }, ctx)).rejects.toThrow(/use action stop first/)
    const stop = await tool.prepare!({ action: 'stop' }, ctx)
    expect(await tool.approval!(stop, ctx)).toBeNull()
    await tool.run(stop, ctx)
    expect(state.calls).toContain('POST /antigravity/runs/r7/stop')
    state.current.run.control = 'stop_requested'
    const now = await tool.prepare!({ action: 'stop-now' }, ctx)
    expect(await tool.approval!(now, ctx)).toMatch(/pages in progress are cancelled/)
    state.current.run.kind = 'metadata'
    await expect(tool.prepare!({ action: 'pause' }, ctx)).rejects.toThrow(/not Image Clipper/)
  })

  it('page actions follow the job stage; reject needs approval and carries the note', async () => {
    const { state, ctx, watches } = fakeStudio()
    const tool = toolByName('clipper_page')!
    await expect(tool.prepare!({ series: 'Show', chapter: 1, page: 1, action: 'retry' }, ctx)).rejects.toThrow(/Retry is for failed/)
    await expect(tool.prepare!({ series: 'Show', chapter: 1, page: 2, action: 'reject' }, ctx)).rejects.toThrow(/only a result imported/)
    await expect(tool.prepare!({ series: 'Show', chapter: 3, page: 1, action: 'retry' }, ctx)).rejects.toThrow(/has no AntiGravity job/)
    const retry = await tool.prepare!({ series: 'Show', chapter: 1, page: 'p2.webp', action: 'retry' }, ctx)
    expect(await tool.approval!(retry, ctx)).toBeNull()
    expect(await tool.run(retry, ctx)).toMatchObject({ done: 'retry', page: '#2 p2.webp', now: 'queued' })
    expect(watches[0]).toMatchObject({ kind: 'clipper', runId: 'r0' })
    const reject = await tool.prepare!({ series: 'Show', chapter: 1, page: 1, action: 'reject and process again', note: 'merged two panels' }, ctx)
    expect(await tool.approval!(reject, ctx)).toMatch(/Reject "Show" chapter 1 page #1.*processed again.*merged two panels/)
    await tool.run(reject, ctx)
    expect(state.bodies['POST /antigravity/jobs/j1/reject']).toEqual({ rerun: true, note: 'merged two panels' })
    const share = await tool.prepare!({ series: 'Show', chapter: 1, page: 1, action: 'share_with_phones' }, ctx)
    await tool.run(share, ctx)
    expect(state.calls).toContain('POST /antigravity/jobs/j1/publish')
  })

  it('marking reviewed needs approval, unmarking does not; crop again needs approval, several chapters are queued', async () => {
    const { state, ctx, watches } = fakeStudio()
    const review = toolByName('clipper_review')!
    const mark = await review.prepare!({ series: 'Show', chapters: [1, 2], reviewed: true }, ctx)
    expect(mark.numbers).toEqual([1]) // chapter 2 is already reviewed
    expect(await review.approval!(mark, ctx)).toMatch(/you confirm you checked every page's crops/)
    expect(await review.run(mark, ctx)).toEqual({ markedReviewed: '1' })
    expect(state.bodies['PUT /clipper3/chapters/c1/review']).toEqual({ reviewed: true })
    const unmark = await review.prepare!({ series: 'Show', chapters: [2], reviewed: false }, ctx)
    expect(await review.approval!(unmark, ctx)).toBeNull()

    const crop = toolByName('clipper_crop')!
    await expect(crop.prepare!({ series: 'Show', chapters: [3] }, ctx)).rejects.toThrow(/not reviewed yet/)
    const again = await crop.prepare!({ series: 'Show', chapters: [2] }, ctx)
    expect(await crop.approval!(again, ctx)).toMatch(/Cut "Show" chapter 2 again/)
    await crop.run(again, ctx)
    expect(state.calls).toContain('POST /clipper3/chapters/c2/crop')
    const many = await crop.prepare!({ series: 'Show', chapters: [1, 2] }, ctx)
    expect(await crop.approval!(many, ctx)).toBeNull()
    expect(await crop.run(many, ctx)).toMatchObject({ cutting: '2', skipped: [expect.stringMatching(/chapter 1: Needs review/)] })
    expect(watches.at(-1)).toMatchObject({ kind: 'crop', chapterIds: ['c2'], numbers: [2] })
  })
})

describe('Image Clipper watcher', () => {
  const watcherWith = (routes: Record<string, () => unknown>) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = String(url).replace('http://x/api', '')
      const body = routes[path]?.()
      return { ok: !!body, status: body ? 200 : 404, json: async () => body, text: async () => JSON.stringify(body) }
    }))
    let list: any[] = []
    const store: any = { watches: async () => list, saveWatches: async (l: any[]) => { list = l } }
    const posted: string[] = []
    const prisma: any = { chapter: { findMany: async () => [{ id: 'c1', number: 1 }, { id: 'c2', number: 2 }] } }
    const watcher = new ScriptWatcher(store, prisma, () => 'http://x/api', async (_c, text) => { posted.push(text); return true })
    return { watcher, posted, list: () => list }
  }

  it('reports a page that needs the user once, then the end with what came back', async () => {
    const run = { id: 'r1', control: 'running', finishedAt: null as string | null }
    const jobs = [
      { id: 'a', chapterId: 'c1', filename: 'p1.webp', stage: 'analyzing' },
      { id: 'b', chapterId: 'c1', filename: 'p2.webp', stage: 'needs_attention', lastError: 'boxes overlap' }
    ]
    const { watcher, posted, list } = watcherWith({ '/antigravity/runs/r1': () => ({ run, jobs }) })
    await watcher.add('chat', { kind: 'clipper', runId: 'r1', seriesId: 's1', title: 'Show', part: 1 })
    await watcher.tick()
    await watcher.tick()
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatch(/⚠ The Image Clipper run for "Show" part 1 hit a problem on 1 page:\n• Chapter 1 p2.webp: needs attention — boxes overlap/)
    jobs[0].stage = 'ready_for_human_review'
    run.control = 'completed_with_errors'; run.finishedAt = new Date().toISOString()
    await watcher.tick()
    expect(posted[1]).toMatch(/⚠ The Image Clipper run for "Show" part 1 finished: 1 of 2 pages got crop pointers \(chapter 1\)\. 1 page still needs you/)
    expect(list()).toEqual([])
  })

  it('reports a crop when its chapters have been cut', async () => {
    const summary = [{ chapterId: 'c2', cropping: true, cropComplete: false, review: { croppedAt: null as string | null } }]
    const { watcher, posted } = watcherWith({ '/clipper3/series/s1/summary': () => ({ chapters: summary }) })
    await watcher.add('chat', { kind: 'crop', seriesId: 's1', title: 'Show', chapterIds: ['c2'], numbers: [2] })
    await watcher.tick()
    expect(posted).toEqual([])
    summary[0] = { chapterId: 'c2', cropping: false, cropComplete: true, review: { croppedAt: new Date(Date.now() + 1000).toISOString() } }
    await watcher.tick()
    expect(posted).toEqual(['✓ Crop Sections for "Show" chapter 2: cut 2.'])
  })
})
