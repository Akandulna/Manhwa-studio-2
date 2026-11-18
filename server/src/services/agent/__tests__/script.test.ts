import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { toolByName, TOOLS } from '../agentTools.js'
import { partOf, shortReason } from '../scriptTools.js'
import { ScriptWatcher, type Watch } from '../scriptWatcher.js'
import { systemPrompt } from '../agent.js'

describe('script tools', () => {
  it('are listed for the agent, with the rules about engines and pasted scripts', () => {
    const p = systemPrompt('', '', 'Kuro')
    for (const name of ['scripts_status', 'scripts_where', 'mac_scripts_start', 'script_replace', 'phone_scripts_start', 'phone_scripts_fetch', 'scripts_clear']) {
      expect(p).toContain(`- ${name}`)
      expect(toolByName(name)).toBeTruthy()
    }
    expect(p).toMatch(/Antigravity or ChatGPT \(Codex\); never Claude/)
    expect(p).toContain('ai.codex.model gpt-6.1-terra + ai.codex.effort high')
    expect(p).toContain('settings_change')
    expect(p).toContain('source "last_message"')
  })

  it('has no tool for Gemini MCP, the copy-paste prompts or voiceover (left out on purpose)', () => {
    expect(TOOLS.map(t => t.name).filter(n => /gemini|prompt|voiceover|align/.test(n))).toEqual([])
  })

  it('works out the part of a chapter', () => {
    expect([1, 20, 21, 40, 41].map(partOf)).toEqual([1, 1, 2, 2, 3])
  })

  it('shortens the long waiting reasons', () => {
    expect(shortReason('Chapter 4 needs its English script (with its summary) first: each chapter continues from the previous one.')).toBe("waiting for the previous chapter's script")
    expect(shortReason('Needs its English script first: the Hinglish is written from it.')).toBe('needs its English script first')
    expect(shortReason('No pages')).toBe('No pages')
  })

  it('asks approval only where work is replaced or thrown away', async () => {
    const ctx: any = {}
    const start = toolByName('mac_scripts_start')!
    expect(await start.approval!({ title: 'T', rewrites: [] }, ctx)).toBeNull()
    expect(await start.approval!({ title: 'T', rewrites: [3, 4] }, ctx)).toMatch(/Rewrite the script of "T" chapter 3-4/)
    const control = toolByName('mac_scripts_control')!
    expect(await control.approval!({ action: 'stop' }, ctx)).toBeNull()
    expect(await control.approval!({ action: 'stop_now' }, ctx)).toMatch(/Stop the Narration process now/)
    const job = toolByName('mac_script_job')!
    expect(await job.approval!({ action: 'retry', language: 'en', title: 'T', number: 2 }, ctx)).toBeNull()
    expect(await job.approval!({ action: 'start_over', language: 'hi', title: 'T', number: 2 }, ctx)).toMatch(/Hinglish script of "T" chapter 2 over/)
    const stop = toolByName('phone_run_stop')!
    expect(await stop.approval!({ finish: true, phoneName: 'Nord' }, ctx)).toBeNull()
    expect(await stop.approval!({ finish: false, phoneName: 'Nord' }, ctx)).toMatch(/Stop the Narration scripts run on Nord right now/)
    const choose = toolByName('phone_script_choose')!
    expect(await choose.approval!({ choice: 'studio' }, ctx)).toBeNull()
    expect(await choose.approval!({ choice: 'phone', language: 'en', title: 'T', number: 1 }, ctx)).toMatch(/Use the phone's English script/)
    const fetchTool = toolByName('phone_scripts_fetch')!
    expect(await fetchTool.approval!({ replaces: [], language: 'en', title: 'T' }, ctx)).toBeNull()
    expect(await fetchTool.approval!({ replaces: [2], language: 'en', title: 'T' }, ctx)).toMatch(/Replace Studio's English script/)
    expect(await toolByName('script_replace')!.approval!({ language: 'en', title: 'T', number: 1, wordCount: 500, hadScript: true, sendToPhones: true }, ctx)).toMatch(/backed up/)
    expect(await toolByName('scripts_clear')!.approval!({ title: 'T', numbers: [1, 2] }, ctx)).toMatch(/Clear the English and Hinglish scripts/)
  })

  it('script_replace takes the user\'s latest message as the script, and refuses an instruction', async () => {
    const replace = toolByName('script_replace')!
    const ctx: any = { prisma: { series: { findMany: async () => [{ id: 's1', title: 'Show', rootFolder: 'Show' }] }, chapter: { findFirst: async () => ({ id: 'c1', number: 1, status: 'done' }) } }, api: 'http://x/api', lastUserText: 'replace chapter 1 please' }
    await expect(replace.prepare!({ series: 'Show', chapter: 1, source: 'last_message' }, ctx)).rejects.toThrow(/too short to be a script/)
    await expect(replace.prepare!({ series: 'Show', chapter: 1, source: 'text' }, ctx)).rejects.toThrow(/text is empty/)
  })
})

describe('script watcher', () => {
  const memory = () => {
    let list: Watch[] = []
    return { store: { watches: async () => list, saveWatches: async (l: Watch[]) => { list = l } } as any, get: () => list }
  }
  const respond = (routes: Record<string, () => unknown>) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const key = Object.keys(routes).find(k => String(url).endsWith(k))
    if (!key) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => routes[key]() }
  }))
  const prisma: any = { chapter: { findMany: async () => [{ id: 'c1', number: 3 }, { id: 'c2', number: 4 }] } }

  it('reports a Mac job problem once, then the end, and stops watching', async () => {
    const { store, get } = memory()
    const posted: string[] = []
    const w = new ScriptWatcher(store, prisma, () => 'http://x/api', async (_c, text) => { posted.push(text); return true })
    await w.add('chat', { kind: 'mac', runId: 'r1', seriesId: 's1', title: 'Show', part: 1 })
    let run: any = { control: 'running', finishedAt: null }
    let jobs: any[] = [{ id: 'j1', chapterId: 'c1', filename: 'narration-en', stage: 'needs_attention', lastError: 'check failed' }, { id: 'j2', chapterId: 'c2', filename: 'narration-en', stage: 'queued' }]
    respond({ '/antigravity/runs/r1': () => ({ run, jobs, events: [] }) })
    await w.tick(); await w.tick()
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatch(/Chapter 3 English: needs attention — check failed/)
    expect(get()).toHaveLength(1)
    run = { control: 'running', finishedAt: '2026-11-16T10:00:00Z' }
    jobs = [{ id: 'j1', chapterId: 'c1', filename: 'narration-en', stage: 'done' }, { id: 'j3', chapterId: 'c1', filename: 'narration-hi', stage: 'done' }, { id: 'j2', chapterId: 'c2', filename: 'narration-en', stage: 'done' }]
    await w.tick()
    expect(posted).toHaveLength(2)
    expect(posted[1]).toMatch(/✓ The script run for "Show" part 1 on this Mac finished: English saved for 2 of 2 chapters, Hinglish for 1/)
    expect(get()).toEqual([])
    vi.unstubAllGlobals()
  })

  it('reports a phone run that ends, with what it saved', async () => {
    const { store, get } = memory()
    const posted: string[] = []
    const w = new ScriptWatcher(store, prisma, () => 'http://x/api', async (_c, text) => { posted.push(text); return true })
    await w.add('chat', { kind: 'phone', device: 'd1', phoneName: 'Nord', seriesId: 's1', title: 'Show', part: 1, before: { done: 0, total: 20 } })
    let runs: any[] = [{ kind: 'narration', device: 'd1', seriesId: 's1', done: 1, total: 20, paused: false }]
    let scripts: any = { done: 1, total: 20 }
    respond({ '/r2/phone/overview': () => ({ phones: [{ id: 'd1', name: 'Nord', automation: {} }], runs, series: [{ id: 's1', scripts }] }) })
    await w.tick()
    expect(posted).toEqual([])
    runs = []; scripts = { done: 7, total: 20 }
    await w.tick()
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatch(/⚠ Nord stopped writing scripts for "Show" part 1\. Chapters scripted on the phone: 7\/20 \(\+7 since I started it\)\. It stopped before finishing/)
    expect(get()).toEqual([])
    vi.unstubAllGlobals()
  })

  it('says so when a phone never starts, and forgets a deleted chat', async () => {
    const { store, get } = memory()
    const posted: string[] = []
    const w = new ScriptWatcher(store, prisma, () => 'http://x/api', async (_c, text) => { posted.push(text); return true })
    await w.add('chat', { kind: 'phone', device: 'd1', phoneName: 'Nord', seriesId: 's1', title: 'Show', part: null, before: null })
    respond({ '/r2/phone/overview': () => ({ phones: [{ id: 'd1', name: 'Nord', connected: false, left: 'lost', automation: {} }], runs: [], series: [] }) })
    await w.tick()
    expect(posted).toEqual([])
    const list = get()
    list[0].startedAt = new Date(Date.now() - 20 * 60_000).toISOString()
    await w.tick()
    expect(posted[0]).toMatch(/Nord did not start writing scripts for "Show" within 12 minutes\. It is offline \(lost\)/)
    expect(get()).toEqual([])
    vi.unstubAllGlobals()
  })

  it('persists watches in the agent\'s own file', async () => {
    const { AgentStore } = await import('../agentStore.js')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-watch-'))
    const store = new AgentStore({} as any, dir)
    await store.saveWatches([{ kind: 'mac', runId: 'r', seriesId: 's', title: 'T', part: 1, id: 'w', chatId: 'c', startedAt: 'x' }])
    expect(((await new AgentStore({} as any, dir).watches())[0] as any).runId).toBe('r')
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('mac_scripts_switch (stop, change setting, continue)', () => {
  /** A fake Studio API: routes by "METHOD path", JSON in and out (agentTools.call reads text()). */
  const fakeApi = (state: { settings: any; codex?: any; run: any; connection: () => any; calls: string[] }) => vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const path = String(url).replace('http://x/api', '')
    const key = `${init?.method ?? 'GET'} ${path}`
    state.calls.push(key)
    const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body })
    switch (key) {
      case 'GET /antigravity/settings': return reply(state.settings)
      case 'GET /antigravity/models': return reply({ models: [{ id: 'gemini-4-hydrogen-medium', label: 'M' }, { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' }] })
      case 'PUT /antigravity/settings': state.settings = { ...state.settings, ...JSON.parse(init.body) }; return reply(state.settings)
      case 'GET /antigravity/runs/current': return reply({ live: !state.run.finishedAt, run: state.run })
      case 'POST /antigravity/runs/r1/stop': state.run = { ...state.run, control: 'stop_requested' }; return reply({})
      case 'GET /antigravity/runs/r1': return reply({ run: state.run, jobs: [] })
      case 'GET /antigravity/connection': return reply(state.connection())
      case 'POST /antigravity/check': state.settings = { ...state.settings, tested: true }; return reply({ ok: true })
      case 'GET /antigravity/codex/connection': return reply({ settings: state.codex, proofValid: !!state.codex.tested, proofNote: 'run the test again', models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', image: true }, { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', image: true }, { id: 'gpt-text', label: 'Text', image: false }] })
      case 'PUT /antigravity/codex/settings': state.codex = { ...state.codex, ...JSON.parse(init.body), tested: false }; return reply(state.codex)
      case 'POST /antigravity/codex/check': state.codex = { ...state.codex, tested: true }; return reply({ ok: true })
      case 'POST /antigravity/runs': return reply({ runId: 'r2', created: ['j9'], reused: [], skipped: [] })
      default: return reply({ error: `unexpected ${key}` }, 404)
    }
  }))
  const prisma: any = { series: { findUnique: async () => ({ title: 'Show' }) }, chapter: { findMany: async () => [] } }
  const base = () => ({ settings: { model: 'gemini-4-hydrogen-medium', modelLabel: 'M', effort: null } as Record<string, any>, codex: { model: 'gpt-6.1-sol', modelLabel: 'GPT-6.1-Sol', effort: 'max', tested: true } as Record<string, any>, run: { id: 'r1', kind: 'narration', control: 'running', seriesId: 's1', partNumber: 2, finishedAt: null as string | null }, calls: [] as string[], connection: () => ({}) })

  it('is listed for the agent with the sequence rule', () => {
    const p = systemPrompt('', '', 'Kuro')
    expect(p).toContain('- mac_scripts_switch')
    expect(p).toMatch(/SEQUENCES/)
    expect(p).toContain('gemini-4-hydrogen-high')
  })

  it('refuses when nothing is running, the setting is not an AntiGravity one, or nothing would change', async () => {
    const state = base()
    const tool = toolByName('mac_scripts_switch')!
    const ctx: any = { prisma, api: 'http://x/api' }
    state.run = { ...state.run, finishedAt: '2026-11-16T10:00:00Z', control: 'stopped' }
    fakeApi(state)
    await expect(tool.prepare!({ setting: 'ai.antigravity.model', value: 'gemini-4-hydrogen-high' }, ctx)).rejects.toThrow(/No AntiGravity process is running/)
    state.run = { ...state.run, finishedAt: null, control: 'running' }
    await expect(tool.prepare!({ setting: 'downloads.concurrency', value: 3 }, ctx)).rejects.toThrow(/not one I change in this sequence/)
    await expect(tool.prepare!({ setting: 'ai.engine', value: 'claude' }, ctx)).rejects.toThrow(/antigravity or codex only/)
    await expect(tool.prepare!({ setting: 'ai.antigravity.sandbox', value: false }, ctx)).rejects.toThrow(/not one I change in this sequence/)
    await expect(tool.prepare!({ setting: 'ai.codex.model', value: 'gpt-text' }, ctx)).rejects.toThrow(/no image model "gpt-text"/)
    await expect(tool.prepare!({ setting: 'ai.antigravity.model', value: 'gemini-4-hydrogen-medium' }, ctx)).rejects.toThrow(/already set/)
    await expect(tool.prepare!({ setting: 'ai.antigravity.model', value: 'not-a-model' }, ctx)).rejects.toThrow(/does not offer "not-a-model"/)
    vi.unstubAllGlobals()
  })

  it('stops gracefully now, then after the run ends changes the model, runs the test and starts the part again', async () => {
    const state = base()
    let proofValid = true
    state.connection = () => ({ settings: { engine: 'antigravity' }, proofValid })
    const tool = toolByName('mac_scripts_switch')!
    const watches: any[] = []
    const ctx: any = { prisma, api: 'http://x/api', watch: async (r: any) => { watches.push(r) } }
    fakeApi(state)
    const prepared = await tool.prepare!({ setting: 'ai.antigravity.model', value: 'gemini-4-hydrogen-high' }, ctx)
    expect(prepared).toMatchObject({ runId: 'r1', part: 2, title: 'Show', resume: true, changes: [{ setting: 'ai.antigravity.model', value: 'gemini-4-hydrogen-high', from: 'gemini-4-hydrogen-medium' }] })
    expect(await tool.approval!(prepared, ctx)).toBeNull()
    await tool.run(prepared, ctx)
    expect(state.calls).toContain('POST /antigravity/runs/r1/stop')
    expect(state.settings.model).toBe('gemini-4-hydrogen-medium') // nothing changed until the run has ended
    expect(watches[0]).toMatchObject({ kind: 'mac_switch', runId: 'r1', resume: true })

    let list: any[] = []
    const store: any = { watches: async () => list, saveWatches: async (l: any[]) => { list = l } }
    const posted: string[] = []
    const watcher = new ScriptWatcher(store, prisma, () => 'http://x/api', async (_c, text) => { posted.push(text); return true })
    await watcher.add('chat', watches[0])
    await watcher.tick() // still finishing the chapter
    expect(posted).toEqual([])
    expect(state.settings.model).toBe('gemini-4-hydrogen-medium')

    state.run = { ...state.run, control: 'stopped', finishedAt: '2026-11-16T10:00:00Z' }
    // The model change makes the old compatibility proof invalid until the test has run.
    const baseConnection = state.connection
    state.connection = () => ({ ...baseConnection(), proofValid: !!state.settings.tested })
    proofValid = false
    await watcher.tick()
    expect(state.settings.model).toBe('gemini-4-hydrogen-high')
    expect(state.calls.indexOf('POST /antigravity/check')).toBeGreaterThan(-1)
    expect(state.calls.indexOf('POST /antigravity/check')).toBeLessThan(state.calls.indexOf('POST /antigravity/runs'))
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatch(/▶ "Show" part 2 is writing again with the new settings \(.*gemini-4-hydrogen-medium → gemini-4-hydrogen-high\)/)
    // The new run is watched by the usual "finished / problem" watcher.
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ kind: 'mac', runId: 'r2', part: 2, chatId: 'chat' })
    vi.unstubAllGlobals()
  })

  it('moves a running process to ChatGPT (Codex) 6.1 Terra High: approval, then Codex\'s own test, then the part starts again', async () => {
    const state = base()
    state.settings.engine = 'antigravity'
    state.connection = () => ({ settings: { engine: state.settings.engine }, proofValid: true })
    const tool = toolByName('mac_scripts_switch')!
    const watches: any[] = []
    const ctx: any = { prisma, api: 'http://x/api', watch: async (r: any) => { watches.push(r) } }
    fakeApi(state)
    const prepared = await tool.prepare!({ changes: [{ setting: 'ai.engine', value: 'codex' }, { setting: 'ai.codex.model', value: 'gpt-6.1-terra' }, { setting: 'ai.codex.effort', value: 'high' }] }, ctx)
    expect(prepared.changes.map((c: any) => `${c.setting}=${c.value}`)).toEqual(['ai.engine=codex', 'ai.codex.model=gpt-6.1-terra', 'ai.codex.effort=high'])
    expect(await tool.approval!(prepared, ctx)).toMatch(/switch the engine .* from antigravity to codex/)
    await tool.run(prepared, ctx)
    expect(state.settings.engine).toBe('antigravity')

    let list: any[] = []
    const store: any = { watches: async () => list, saveWatches: async (l: any[]) => { list = l } }
    const posted: string[] = []
    const watcher = new ScriptWatcher(store, prisma, () => 'http://x/api', async (_c, text) => { posted.push(text); return true })
    await watcher.add('chat', watches[0])
    state.run = { ...state.run, control: 'stopped', finishedAt: '2026-11-16T10:00:00Z' }
    await watcher.tick()
    expect(state.settings.engine).toBe('codex')
    expect(state.codex).toMatchObject({ model: 'gpt-6.1-terra', modelLabel: 'GPT-6.1 Terra', effort: 'high', tested: true })
    expect(state.calls).not.toContain('POST /antigravity/check')
    expect(state.calls.indexOf('POST /antigravity/codex/check')).toBeLessThan(state.calls.indexOf('POST /antigravity/runs'))
    expect(posted[0]).toMatch(/▶ "Show" part 2 is writing again .* ChatGPT \(Codex\)'s compatibility test/)
    vi.unstubAllGlobals()
  })

  it('drops the plan when the process is resumed, and does not start again when told to stay stopped', async () => {
    const state = base()
    state.run = { ...state.run, control: 'stop_requested' }
    let list: any[] = []
    const store: any = { watches: async () => list, saveWatches: async (l: any[]) => { list = l } }
    const posted: string[] = []
    const watcher = new ScriptWatcher(store, prisma, () => 'http://x/api', async (_c, text) => { posted.push(text); return true })
    fakeApi(state)
    await watcher.add('chat', { kind: 'mac_switch', runId: 'r1', seriesId: 's1', title: 'Show', part: 2, changes: [{ setting: 'ai.antigravity.model', value: 'gemini-4-hydrogen-high', label: 'Antigravity model' }], resume: true })
    state.run = { ...state.run, control: 'running' }
    await watcher.tick()
    expect(posted[0]).toMatch(/dropped the plan/)
    expect(state.settings.model).toBe('gemini-4-hydrogen-medium')
    expect(list).toEqual([])

    state.run = { ...state.run, control: 'stopped', finishedAt: '2026-11-16T10:00:00Z' }
    await watcher.add('chat', { kind: 'mac_switch', runId: 'r1', seriesId: 's1', title: 'Show', part: 2, changes: [{ setting: 'ai.antigravity.model', value: 'gemini-4-hydrogen-high', label: 'Antigravity model' }], resume: false })
    await watcher.tick()
    expect(state.settings.model).toBe('gemini-4-hydrogen-high')
    expect(posted[1]).toMatch(/stays stopped/)
    expect(state.calls).not.toContain('POST /antigravity/runs')
    vi.unstubAllGlobals()
  })
})

describe('compatibility test run by the agent', () => {
  const api = (state: { proofValid: boolean; checkOk: boolean; calls: string[] }) => vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const key = `${init?.method ?? 'GET'} ${String(url).replace('http://x/api', '')}`
    state.calls.push(key)
    const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body) })
    switch (key) {
      case 'GET /antigravity/connection': return reply({ settings: { engine: 'antigravity', model: 'gemini-4-hydrogen-high' }, installation: { path: '/agy' }, proofValid: state.proofValid, proofNote: 'The selected model differs from the tested one; run the test again.' })
      case 'POST /antigravity/check': state.proofValid = state.checkOk; return reply({ ok: state.checkOk, model: 'gemini-4-hydrogen-high', error: state.checkOk ? null : 'resume lost' })
      case 'GET /antigravity/runs/current': return reply({ live: false, run: null })
      case 'POST /antigravity/narration/status': return reply({ chapters: [{ id: 'c1', number: 1, hasScript: false, blocked: null, hinglish: { hasScript: false, blocked: 'x' } }] })
      case 'POST /antigravity/page-jobs': return reply([])
      default: return reply({ error: `unexpected ${key}` }, 404)
    }
  }))
  const ctx = (): any => ({ prisma: { series: { findMany: async () => [{ id: 's1', title: 'Show', rootFolder: 'Show' }] } }, api: 'http://x/api' })

  it('mac_scripts_start runs the test itself when it is the only thing missing, then carries on', async () => {
    const state = { proofValid: false, checkOk: true, calls: [] as string[] }
    api(state)
    const prepared = await toolByName('mac_scripts_start')!.prepare!({ series: 'Show', part: 1 }, ctx())
    expect(state.calls).toContain('POST /antigravity/check')
    expect(prepared).toMatchObject({ seriesId: 's1', part: 1 })
    vi.unstubAllGlobals()
  })

  it('mac_scripts_start stops and says why when the test fails', async () => {
    const state = { proofValid: false, checkOk: false, calls: [] as string[] }
    api(state)
    await expect(toolByName('mac_scripts_start')!.prepare!({ series: 'Show', part: 1 }, ctx())).rejects.toThrow(/compatibility test .* failed: resume lost/)
    vi.unstubAllGlobals()
  })

  it('antigravity_compat_test runs on request and says whether scripts can start', async () => {
    const state = { proofValid: false, checkOk: true, calls: [] as string[] }
    api(state)
    expect(await toolByName('antigravity_compat_test')!.run({}, ctx())).toMatchObject({ passed: true, readyForScripts: true })
    expect(systemPrompt('', '', 'K')).toContain('- antigravity_compat_test')
    vi.unstubAllGlobals()
  })
})

describe('ChatGPT (Codex) writes scripts on this Mac too', () => {
  const api = (state: { proofValid: boolean; signedIn: boolean; calls: string[] }) => vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const key = `${init?.method ?? 'GET'} ${String(url).replace('http://x/api', '')}`
    state.calls.push(key)
    const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body) })
    switch (key) {
      case 'GET /antigravity/connection': return reply({ settings: { engine: 'codex', model: 'gemini-4-argon-medium' }, installation: { path: '/agy' }, proofValid: true })
      case 'GET /antigravity/codex/connection': return reply({ settings: { model: 'gpt-6.1-terra', modelLabel: 'GPT-6.1 Terra', effort: 'high' }, installation: { path: '/codex' }, account: { signedIn: state.signedIn, detail: 'Not signed in.' }, accounts: { accounts: [{ enabled: true, limited: false }] }, proofValid: state.proofValid, proofNote: 'The selected Codex model differs from the tested one; run the test again.' })
      case 'POST /antigravity/codex/check': state.proofValid = true; return reply({ ok: true, model: 'gpt-6.1-terra' })
      case 'GET /antigravity/runs/current': return reply({ live: false, run: null })
      case 'POST /antigravity/narration/status': return reply({ chapters: [{ id: 'c1', number: 1, hasScript: false, blocked: null, hinglish: { hasScript: false, blocked: 'x' } }] })
      case 'POST /antigravity/page-jobs': return reply([])
      default: return reply({ error: `unexpected ${key}` }, 404)
    }
  }))
  const ctx = (): any => ({ prisma: { series: { findMany: async () => [{ id: 's1', title: 'Show', rootFolder: 'Show' }] } }, api: 'http://x/api' })

  it('antigravity_compat_test runs Codex\'s test when Codex is the engine', async () => {
    const state = { proofValid: false, signedIn: true, calls: [] as string[] }
    api(state)
    expect(await toolByName('antigravity_compat_test')!.run({}, ctx())).toMatchObject({ engine: 'ChatGPT (Codex)', passed: true, model: 'gpt-6.1-terra', effort: 'high', readyForScripts: true })
    expect(state.calls).not.toContain('POST /antigravity/check')
    vi.unstubAllGlobals()
  })

  it('mac_scripts_start tests Codex by itself, then starts; a signed-out Codex is a blocker, not a test', async () => {
    const state = { proofValid: false, signedIn: true, calls: [] as string[] }
    api(state)
    expect(await toolByName('mac_scripts_start')!.prepare!({ series: 'Show', part: 1 }, ctx())).toMatchObject({ seriesId: 's1', part: 1 })
    expect(state.calls).toContain('POST /antigravity/codex/check')
    state.signedIn = false
    state.calls = []
    await expect(toolByName('mac_scripts_start')!.prepare!({ series: 'Show', part: 1 }, ctx())).rejects.toThrow(/Not signed in/)
    expect(state.calls).not.toContain('POST /antigravity/codex/check')
    vi.unstubAllGlobals()
  })
})

describe('a process that is already running', () => {
  const run = { id: 'r9', kind: 'narration', control: 'running', seriesId: 's1', partNumber: 1, finishedAt: null }
  const stub = () => vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const key = `${init?.method ?? 'GET'} ${String(url).replace('http://x/api', '')}`
    const reply = (body: unknown) => ({ ok: true, status: 200, statusText: '', text: async () => JSON.stringify(body) })
    if (key === 'GET /antigravity/runs/current') return reply({ live: true, run })
    if (key === 'GET /antigravity/runs/r9') return reply({ run, jobs: [{ stage: 'queued' }, { stage: 'done' }] })
    if (key === 'GET /antigravity/settings') return reply({ modelLabel: 'Gemini 4 Hydrogen (High)' })
    if (key === 'GET /r2/phone/overview') return reply({ runs: [] })
    return { ok: false, status: 404, statusText: '', text: async () => JSON.stringify({ error: `unexpected ${key}` }) }
  }))
  const ctx = (watch?: any): any => ({ prisma: { series: { findMany: async () => [{ id: 's1', title: 'Show', rootFolder: 'Show' }], findUnique: async () => ({ title: 'Show' }) } }, api: 'http://x/api', watch })

  it('mac_scripts_start joins it instead of failing, and does not run the compatibility test', async () => {
    stub()
    const watches: any[] = []
    const start = toolByName('mac_scripts_start')!
    const prepared = await start.prepare!({ series: 'Show', part: 1 }, ctx(async (r: any) => { watches.push(r) }))
    expect(prepared).toMatchObject({ alreadyRunning: true, runId: 'r9' })
    expect(await start.run(prepared, ctx(async (r: any) => { watches.push(r) }))).toMatchObject({ alreadyRunning: true })
    expect(watches[0]).toMatchObject({ kind: 'mac', runId: 'r9', part: 1 })
    vi.unstubAllGlobals()
  })

  it('antigravity_compat_test refuses while a process runs', async () => {
    stub()
    await expect(toolByName('antigravity_compat_test')!.run({}, ctx())).rejects.toThrow(/Do not run the test while a process is running/)
    vi.unstubAllGlobals()
  })

  it('the agent sees the live state in its prompt', async () => {
    stub()
    const { liveState } = await import('../liveState.js')
    const { conversationPrompt } = await import('../agent.js')
    const live = await liveState(ctx())
    expect(live).toMatch(/Narration scripts, "Show" part 1, state running\. Jobs: 1 queued, 1 done/)
    expect(live).toContain('Gemini 4 Hydrogen (High)')
    expect(conversationPrompt('SYS', [], [], live)).toContain('LIVE STATE')
    vi.unstubAllGlobals()
  })
})
