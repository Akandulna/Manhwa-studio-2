import { describe, expect, it, vi, afterEach } from 'vitest'
import { toolByName } from '../agentTools.js'
import { ScriptWatcher, type Watch } from '../scriptWatcher.js'
import { systemPrompt, unbackedPromiseNote } from '../agent.js'
import { liveState } from '../liveState.js'

/**
 * "When Sandmancer finishes, start Northern Blade": the agent can't act later by itself, so mac_scripts_after queues
 * the start and the watcher does it. Fake Studio API by "METHOD path".
 */
type State = {
  running: any | null
  finished: Record<string, any>
  started: any[]
  blocker?: string
  calls: string[]
}
const stub = (state: State) => vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
  const key = `${init?.method ?? 'GET'} ${String(url).replace('http://x/api', '')}`
  state.calls.push(key)
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body })
  if (key === 'GET /antigravity/runs/current') return reply({ live: !!state.running, run: state.running })
  const runMatch = key.match(/^GET \/antigravity\/runs\/(\w+)$/)
  if (runMatch) {
    const run = state.running?.id === runMatch[1] ? state.running : state.finished[runMatch[1]]
    return run ? reply({ run, jobs: [] }) : reply({ error: 'no' }, 404)
  }
  if (key === 'GET /antigravity/connection') return reply({ settings: { engine: 'codex' } })
  if (key === 'GET /antigravity/codex/connection') return reply({
    installation: { path: '/x' }, account: { signedIn: true }, settings: { model: 'gpt-6.1-terra' }, proofValid: true,
    accounts: { accounts: state.blocker ? [] : [{ enabled: true, limited: false }] }
  })
  if (key === 'POST /antigravity/narration/status') return reply({ chapters: [{ id: 'n1', number: 1, hasScript: false, blocked: null, hinglish: { hasScript: false, blocked: null } }] })
  if (key === 'POST /antigravity/page-jobs') return reply([])
  if (key === 'POST /antigravity/runs') { state.started.push(JSON.parse(init.body)); return reply({ runId: 'next1', created: ['j1'], reused: [], skipped: [] }) }
  return reply({ error: `unexpected ${key}` }, 404)
}))

const SAND = { id: 'sand', title: 'Sandmancer of the Scorched Desert' }
const BLADE = { id: 'blade', title: 'Legend of the Northern Blade' }
/** Sandmancer part 1 chapters with these numbers lack the Hinglish script. */
const prisma = (missingHi: number[] = []): any => ({
  series: {
    findMany: async () => [SAND, BLADE].map(s => ({ ...s, rootFolder: s.title })),
    findUnique: async ({ where }: any) => [SAND, BLADE].find(s => s.id === where.id) ?? null
  },
  chapter: {
    findMany: async ({ where }: any) => where.seriesId === 'sand'
      ? Array.from({ length: 20 }, (_, i) => ({ number: i + 1, scripts: [{ language: 'en', status: 'edited' }, ...(missingHi.includes(i + 1) ? [] : [{ language: 'hi', status: 'edited' }])] }))
      : Array.from({ length: 20 }, (_, i) => ({ number: i + 1, scripts: [] }))
  }
})
const memStore = () => {
  let list: Watch[] = []
  return { watches: async () => list, saveWatches: async (l: Watch[]) => { list = l }, get list() { return list } } as any
}
const running = () => ({ id: 'r1', kind: 'narration', control: 'running', seriesId: 'sand', partNumber: 1, finishedAt: null })
const fresh = (): State => ({ running: running(), finished: {}, started: [], calls: [] })
const finish = (state: State, control = 'completed') => { state.finished.r1 = { ...state.running, control, finishedAt: new Date().toISOString() }; state.running = null }

async function queue(state: State, store: any, p = prisma(), args: any = { series: 'Northern Blade' }) {
  const watcher = new ScriptWatcher(store, p, () => 'http://x/api', async (_c, text) => { posted.push(text); return true })
  const posted: string[] = []
  const ctx: any = { prisma: p, store, api: 'http://x/api', chatId: 'chat', watch: (r: any) => watcher.add('chat', r) }
  const tool = toolByName('mac_scripts_after')!
  const result = await tool.run(await tool.prepare!(args, ctx), ctx)
  return { watcher, posted, result, ctx }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('mac_scripts_after (start the next series when this run ends)', () => {
  it('is listed, with the rule that the agent cannot act later by itself', () => {
    const p = systemPrompt('', '', 'K')
    expect(p).toContain('- mac_scripts_after')
    expect(p).toContain('- mac_run_watch')
    expect(p).toMatch(/LATER: .*mac_scripts_after/)
  })

  it('refuses when nothing is running, or when the series asked for is the one running', async () => {
    const state = fresh()
    stub(state)
    const tool = toolByName('mac_scripts_after')!
    const ctx: any = { prisma: prisma(), store: memStore(), api: 'http://x/api' }
    await expect(tool.prepare!({ series: 'Sandmancer' }, ctx)).rejects.toThrow(/Every chapter of "Sandmancer/)
    await expect(tool.prepare!({ series: 'Sandmancer', part: 1 }, ctx)).rejects.toThrow(/is the process running now/)
    state.running = null
    await expect(tool.prepare!({ series: 'Northern Blade' }, ctx)).rejects.toThrow(/Nothing is running.*mac_scripts_start/)
  })

  it('waits for the run, checks every chapter has both scripts, then starts the next part and watches it', async () => {
    const state = fresh()
    stub(state)
    const store = memStore()
    const { watcher, posted, result } = await queue(state, store)
    expect(result).toMatchObject({ queued: true, next: '"Legend of the Northern Blade" part 1' })
    expect(store.list[0]).toMatchObject({ kind: 'mac_next', runId: 'r1', seriesId: 'blade', part: 1, requireComplete: true })

    await watcher.tick()
    expect(posted).toEqual([])
    expect(state.started).toEqual([])

    finish(state)
    await watcher.tick()
    expect(state.started).toEqual([{ seriesId: 'blade', partNumber: 1, mode: 'next', kind: 'narration' }])
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatch(/^▶ "Sandmancer of the Scorched Desert" part 1 finished: all 20 chapters have English and Hinglish scripts\. Started "Legend of the Northern Blade" part 1/)
    // The queued start is done; the new run gets the usual finished/problem watch.
    expect(store.list).toHaveLength(1)
    expect(store.list[0]).toMatchObject({ kind: 'mac', runId: 'next1', seriesId: 'blade', chatId: 'chat' })
  })

  it('does not start when a chapter still lacks a script, or the run was stopped', async () => {
    let state = fresh()
    stub(state)
    let store = memStore()
    let q = await queue(state, store, prisma([7, 15]))
    finish(state, 'completed_with_errors')
    await q.watcher.tick()
    expect(state.started).toEqual([])
    expect(q.posted[0]).toMatch(/⚠ .*chapters 7, 15 still lack an English or Hinglish script, so I did not start "Legend of the Northern Blade" part 1/)
    expect(store.list).toEqual([])

    vi.unstubAllGlobals()
    state = fresh()
    stub(state)
    store = memStore()
    q = await queue(state, store)
    finish(state, 'stopped')
    await q.watcher.tick()
    expect(state.started).toEqual([])
    expect(q.posted[0]).toMatch(/was stopped before it finished, so I did not start/)
  })

  it('starts anyway with require_complete false', async () => {
    const state = fresh()
    stub(state)
    const q = await queue(state, memStore(), prisma([7]), { series: 'Northern Blade', require_complete: false })
    finish(state)
    await q.watcher.tick()
    expect(state.started).toHaveLength(1)
    expect(q.posted[0]).toMatch(/chapter 7 still without both scripts/)
  })

  it('waits (says so once) while another process runs, and retries a usage limit instead of giving up', async () => {
    const state = fresh()
    stub(state)
    const store = memStore()
    const q = await queue(state, store)
    finish(state)
    state.running = { id: 'other', kind: 'clipper', control: 'running', seriesId: 'x', partNumber: 3, finishedAt: null }
    await q.watcher.tick()
    await q.watcher.tick()
    expect(q.posted).toHaveLength(1)
    expect(q.posted[0]).toMatch(/⏸ .*Image Clipper process \(part 3\).*I will start "Legend of the Northern Blade" part 1 when it ends/)

    state.running = null
    state.blocker = 'limit'
    await q.watcher.tick()
    expect(state.started).toEqual([])
    expect(q.posted[1]).toMatch(/⏸ .*could not start .* yet: .*limit.*try again every 10 minutes/)
    expect(store.list[0]).toMatchObject({ kind: 'mac_next', ready: true })
    expect(Date.parse(store.list[0].retryAt)).toBeGreaterThan(Date.now())

    state.blocker = undefined
    store.list[0].retryAt = new Date(Date.now() - 1000).toISOString()
    await q.watcher.tick()
    expect(state.started).toHaveLength(1)
    expect(q.posted[2]).toMatch(/^▶ /)
  })

  it('keeps one queued start per Mac: a new one replaces the old', async () => {
    const state = fresh()
    stub(state)
    const store = memStore()
    await queue(state, store)
    const again = await queue(state, store)
    expect(again.result).toMatchObject({ replaced: 'the earlier queued start of "Legend of the Northern Blade" part 1' })
    expect(store.list.filter((w: Watch) => w.kind === 'mac_next')).toHaveLength(1)
  })
})

describe('mac_run_watch and honest promises', () => {
  it('watches a run the user started, and the live state shows what Studio is watching', async () => {
    const state = fresh()
    stub(state)
    const store = memStore()
    const ctx: any = { prisma: prisma(), store, api: 'http://x/api', chatId: 'chat', watch: async (r: any) => { store.list.push({ ...r, chatId: 'chat', id: 'w', startedAt: new Date().toISOString() }) } }
    expect(await liveState(ctx)).toMatch(/Studio is watching for this chat: nothing \(it will NOT post here/)
    const tool = toolByName('mac_run_watch')!
    await tool.run(await tool.prepare!({}, ctx), ctx)
    expect(store.list[0]).toMatchObject({ kind: 'mac', runId: 'r1', title: 'Sandmancer of the Scorched Desert' })
    expect(await liveState(ctx)).toMatch(/Studio is watching for this chat \(it will post here by itself\): report the Narration run of "Sandmancer/)
  })

  it('flags a promise to post or act later when nothing is watching', () => {
    const said = 'Northern Blade: when Sandmancer ends, Studio will post here and I\'ll start Northern Blade then.'
    expect(unbackedPromiseNote(said, false)).toMatch(/nothing is set up/)
    expect(unbackedPromiseNote(said, true)).toBeNull()
    expect(unbackedPromiseNote('I’ll let you know once it\'s done.', false)).not.toBeNull()
    for (const fine of ['Tell me when you want to start.', 'I\'ll queue those downloads now, then start Northern Blade.', 'The error message shows when the run fails.']) {
      expect(unbackedPromiseNote(fine, false)).toBeNull()
    }
  })
})
