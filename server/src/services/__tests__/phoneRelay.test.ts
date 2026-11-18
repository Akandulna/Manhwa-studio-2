import { afterAll, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { createServer } from 'node:http'
import type { AddressInfo } from 'net'

const local=vi.hoisted(()=>({hub:null as any, controls: [] as any[], scopeChapters: null as any[] | null}))
vi.mock('../libraryControls.js',()=>({libraryControls:async()=>local.controls}))
vi.mock('../wifiStatus.js',()=>({wifiHub:()=>local.hub}))

// R2 must not be touched while the relay is set up.
const send = vi.fn(async () => { throw new Error('R2 should not be called') })
vi.mock('../librarySync.js', () => ({ receiveLibraryManifest: vi.fn(), scheduleLibraryPublish: vi.fn(), isLibraryOrigin: async () => false }))
vi.mock('@aws-sdk/client-s3', async importOriginal => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>()
  return { ...actual, S3Client: class { send = send } }
})
vi.mock('../r2Usage.js', () => ({ FREE_PLAN: {}, attachUsageCounter: () => {}, getMonthUsage: () => ({}), monthKey: () => '' }))
vi.mock('../../index.js', () => ({
  prisma: {
    series: {
      findMany: async () => [{ id: 's1', title: 'Solo Hero', rootFolder: '/lib/Solo Hero', chapters: [{ id: 'c1', folderPath: 'Solo Hero/Chapter 001', number: 1 }] }],
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === 's1'
        ? {
            rootFolder: '/lib/Solo Hero',
            chapters: [
              { folderPath: 'Solo Hero/Chapter 003', number: 3, pageCount: 4 },
              { folderPath: 'Solo Hero/Chapter 001', number: 1, pageCount: 2 },
              { folderPath: 'Solo Hero/Chapter 002', number: 2, pageCount: 10 },
              { folderPath: 'Solo Hero/Chapter 004', number: 4, pageCount: 5 }
            ]
          }
        : null)
    },
    chapter: { findMany: async () => local.scopeChapters ?? [{ id: 'c1', folderPath: 'Solo Hero/Chapter 001' }] }
  }
}))
vi.mock('../../utils/envFile.js', () => ({ writeEnvVars: async () => {} }))

// A stand-in for the relay Worker: checks the token, sends hello + a stored receipt, records what it's sent.
const received: string[] = []
let desktop: WebSocket | null = null
const httpRequests: string[] = []
let rejectBrowserControl = false
const httpRelay = createServer(async (req, res) => {
  expect(req.url).toBe('/request')
  expect(req.headers.authorization).toBe('Bearer t0ken')
  let raw = ''; for await (const chunk of req) raw += chunk
  httpRequests.push(raw)
  if (rejectBrowserControl) { res.writeHead(409).end(JSON.stringify({ error: 'Managed enrollment' })); return }
  received.push(JSON.stringify({ type: 'request', ...JSON.parse(raw) }))
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ phones: 1 }))
})
const relay = new WebSocketServer({ server: httpRelay })
httpRelay.listen(0)
relay.on('connection', (ws, req) => {
  expect(req.headers.authorization).toBe('Bearer t0ken')
  expect(req.url).toBe('/ws?role=desktop')
  desktop = ws
  ws.on('message', data => received.push(data.toString()))
  ws.send(JSON.stringify({ type: 'hello', phones: 1, request: null }))
  ws.send(JSON.stringify({ type: 'receipt', kind: 'scripts', at: 1, body: { device: 'Pixel', answers: 'a1', series: { 'Solo Hero': {
    total: 3, done: 1, chapters: { 'Chapter 001': { status: 'done' } },
    hi: { total: 3, done: 1, uploadedAt: '2026-10-04T10:00:00Z', chapters: { 'Chapter 001': { status: 'review', savedAt: '2026-10-04T09:00:00Z' }, 'Chapter 404': { status: 'done' } } }
  } } } }))
})
await new Promise(resolve => relay.once('listening', resolve))

Object.assign(process.env, {
  R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b',
  RELAY_URL: `http://localhost:${(relay.address() as AddressInfo).port}/`, RELAY_TOKEN: 't0ken'
})
const {configureRelayTraffic}=await import('../relayTraffic.js')
const trafficSettings=new Map<string,string>()
configureRelayTraffic({setting:{
  findUnique:async({where}:any)=>trafficSettings.has(where.key)?{value:trafficSettings.get(where.key)}:null,
  upsert:async({where,create,update}:any)=>{const value=trafficSettings.has(where.key)?update.value??trafficSettings.get(where.key):create.value;trafficSettings.set(where.key,value);return {key:where.key,value}}
}} as never)
const { startPhoneRelay, relayStatus, relayReceipts } = await import('../phoneRelay.js')
const { getPhoneScripts, getPhoneCrops, getPhoneOverview, requestPhoneUpdate, sendAutomationCommand } = await import('../r2Service.js')

const emitted: { event: string; payload: unknown }[] = []
startPhoneRelay({ emit: (event: string, payload: unknown) => emitted.push({ event, payload }) } as never)

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 20))
  expect(check()).toBe(true)
}

afterAll(() => { relay.close(); httpRelay.close() })

describe('phone relay', () => {
  it('routes only Refresh through Wi-Fi with an exact issue-time deadline and same-ID cloud fallback',async()=>{
    await until(()=>relayStatus().connected)
    const {sendPhoneRequest}=await import('../phoneRelay.js')
    const refresh=vi.fn(async(_message:any)=>true)
    local.hub={status:()=>({devices:['local-phone'],snapshots:[]}),refresh}
    try {
      const cloudBefore=received.length
      const localResult=await sendPhoneRequest(undefined,{device:'local-phone'})
      const message=refresh.mock.calls[0][0] as any
      expect(message.id).toBe(localResult.id)
      expect(message.deadline-Date.parse(message.requestedAt)).toBe(60_000)
      expect(received).toHaveLength(cloudBefore)
      await sendPhoneRequest('sync',{device:'local-phone'})
      await until(()=>received.some(text=>JSON.parse(text).action==='sync'))
      expect(refresh).toHaveBeenCalledTimes(1)
      refresh.mockResolvedValue(false)
      const fallback=await sendPhoneRequest(undefined,{device:'remote-phone'})
      await until(()=>received.some(text=>JSON.parse(text).id===fallback.id))
      const failed=refresh.mock.calls[1][0] as any
      expect(failed.id).toBe(fallback.id)
    } finally {local.hub=null}
  })

  it('surfaces managed admission rejection without falling back to socket dispatch', async () => {
    await until(() => relayStatus().connected)
    rejectBrowserControl = true
    const before = received.length
    try {
      await expect(sendAutomationCommand('start', { seriesId: 's1' })).rejects.toThrow('enrolled for managed work')
      expect(httpRequests).toHaveLength(1)
      expect(received).toHaveLength(before)
    } finally { rejectBrowserControl = false }
  })
  it('serves receipts the relay pushed, without R2', async () => {
    await until(() => emitted.some(e => e.event === 'phone:receipt'))
    expect(relayStatus()).toMatchObject({ configured: true, connected: true, phones: 1 })

    const scripts = await getPhoneScripts('s1', true)
    expect(scripts).toMatchObject({ configured: true, device: 'Pixel', answers: 'a1', series: { s1: { done: 1, total: 3 } } })
    expect(scripts.chapters).toEqual({ c1: { status: 'done', savedAt: null } })
    // The optional Hinglish block, matched to chapters the same way.
    expect(scripts.hi).toEqual({
      series: { s1: { done: 1, total: 3, uploadedAt: '2026-10-04T10:00:00Z' } },
      chapters: { c1: { status: 'review', savedAt: '2026-10-04T09:00:00Z' } }
    })
    // Nothing from the phone yet for crops: empty, still not R2.
    expect((await getPhoneCrops('s1', undefined, true)).series).toEqual({})
    expect(send).not.toHaveBeenCalled()
  })

  it('does not report pre-restart script completion through the public status API', async () => {
    local.controls = [{ folder: 'Solo Hero', restart: { at: 123, deviceId: 'note', done: true } }]
    try {
      const scripts = await getPhoneScripts('s1', true)
      expect(scripts.series).toEqual({})
      expect(scripts.chapters).toEqual({})
      expect(scripts.hi).toEqual({ series: {}, chapters: {} })
    } finally { local.controls = [] }
  })

  it('pushes a new receipt to the browser and answers from it', async () => {
    emitted.length = 0
    desktop!.send(JSON.stringify({ type: 'receipt', kind: 'crops', at: 2, body: { answers: 'a2', series: { 'Solo Hero': { total: 9, done: 4, chapters: {} } } } }))
    await until(() => emitted.some(e => e.event === 'phone:receipt'))
    expect(emitted.find(e => e.event === 'phone:receipt')!.payload).toEqual({ kind: 'crops' })
    expect((await getPhoneCrops('s1')).series).toEqual({ s1: { done: 4, total: 9 } })
  })

  it('maps a prohibited-content handoff to the Narration chapter without claiming script completion', async () => {
    emitted.length = 0
    desktop!.send(JSON.stringify({ type: 'receipt', kind: 'scripts', at: 99, body: { device: 'Pixel', series: { 'Solo Hero': {
      total: 3, done: 0, chapters: {}, blocked: [{ id: 'blocked-c1', chapter: 'Chapter 001', language: 'hi',
        failedAt: '2026-11-11T00:00:00Z', stage: 'Final narration review', reason: 'Prohibited content',
        sourceSha256: 'a'.repeat(64), conversationUrl: 'https://aistudio.google.com/prompts/example' }]
    } } } }))
    await until(() => emitted.some(e => e.event === 'phone:receipt'))
    const result = await getPhoneScripts('s1', true)
    expect(result.blocked).toMatchObject([{ id: 'blocked-c1', chapterId: 'c1', seriesId: 's1', language: 'hi' }])
    expect(result.hi.chapters).toEqual({})
    expect(result.series.s1.done).toBe(0)
    local.controls = [{ folder: 'Solo Hero', restart: { at: 123, deviceId: 'note', done: true } }]
    try { expect((await getPhoneScripts('s1', true)).blocked).toBeUndefined() } finally { local.controls = [] }
  })

  it('sends "Refresh from phone" over the socket', async () => {
    const request = await requestPhoneUpdate()
    expect(request).toMatchObject({ via: 'relay', phones: 1 })
    await until(() => received.some(m => m.includes(request.id)))
    expect(JSON.parse(received.find(m => m.includes(request.id))!)).toEqual({ type: 'request', id: request.id, requestedAt: request.requestedAt })
    expect(send).not.toHaveBeenCalled()
  })

  it('starts Image Clipper on the phone with the series folder and tabs, and stops it', async () => {
    const start = await sendAutomationCommand('start', { seriesId: 's1', tabs: 3 })
    expect(start).toMatchObject({ via: 'relay', phones: 1 })
    await until(() => received.some(m => m.includes(start.id)))
    expect(JSON.parse(received.find(m => m.includes(start.id))!)).toEqual({
      type: 'request', id: start.id, requestedAt: start.requestedAt, action: 'clipper_start', series: 'Solo Hero', tabs: 3
    })

    const stop = await sendAutomationCommand('stop')
    await until(() => received.some(m => m.includes(stop.id)))
    expect(JSON.parse(received.find(m => m.includes(stop.id))!)).toEqual({
      type: 'request', id: stop.id, requestedAt: stop.requestedAt, action: 'clipper_stop'
    })

    await expect(sendAutomationCommand('start', { seriesId: 'nope' })).rejects.toThrow('Series not found')
    await expect(sendAutomationCommand('start', { tabs: 9 })).rejects.toThrow('tabs must be 1 to 4')
    expect(send).not.toHaveBeenCalled()
  })

  it('reads the phone\'s automation from the crops receipt', async () => {
    emitted.length = 0
    desktop!.send(JSON.stringify({
      type: 'receipt', kind: 'crops', at: 3, body: {
        series: {},
        automation: { wakeMode: 'dedicated', resumeAfterLimit: true, remoteStart: true, resume: { series: 'Solo Hero', tabs: 2, at: '2026-10-02T15:40:00.000Z' } }
      }
    }))
    await until(() => emitted.some(e => e.event === 'phone:receipt'))
    expect((await getPhoneOverview(null)).automation).toEqual({
      wakeMode: 'dedicated', resumeAfterLimit: true, remoteStart: true,
      resume: { seriesId: 's1', series: 'Solo Hero', tabs: 2, at: '2026-10-02T15:40:00.000Z' },
      runs: ['clipper'], clipper: null, editor: null, chapterRuns: [], rescope: false, stopAfter: false, clipperStopping: false,
      lastStart: null, reportMs: null
    })
    await expect(sendAutomationCommand('start', { kind: 'editor', seriesId: 's1' })).rejects.toThrow('this build can only start Image Clipper')
    await expect(sendAutomationCommand('stop', { after: true })).rejects.toThrow('this build can only stop it now')
  })

  it('reads what became of the last start and how long the receipt took', async () => {
    emitted.length = 0
    desktop!.send(JSON.stringify({
      type: 'receipt', kind: 'crops', at: 5, body: {
        series: {},
        buildMs: { series: 900, metadata: 40, total: 1000 },
        automation: {
          wakeMode: 'personal', remoteStart: true,
          lastStart: { request: 'r1', kind: 'voiceover', series: 'Solo Hero', state: 'refused', reason: 'The other phones did not answer in time', at: '2026-11-14T11:00:00.000Z' }
        }
      }
    }))
    await until(() => emitted.some(e => e.event === 'phone:receipt'))
    const automation = (await getPhoneOverview(null)).automation
    expect(automation?.lastStart).toEqual({
      request: 'r1', kind: 'voiceover', seriesId: 's1', series: 'Solo Hero', state: 'refused',
      reason: 'The other phones did not answer in time', at: '2026-11-14T11:00:00.000Z'
    })
    expect(automation?.reportMs).toBe(1000)

    emitted.length = 0
    desktop!.send(JSON.stringify({
      type: 'receipt', kind: 'crops', at: 6, body: { series: {}, automation: { lastStart: { kind: 'voiceover', state: 'lost', at: '2026-11-14T11:00:00.000Z' } } }
    }))
    await until(() => emitted.some(e => e.event === 'phone:receipt'))
    expect((await getPhoneOverview(null)).automation?.lastStart).toBeNull()
  })

  it('rejects explicit Editor choices on old receipts instead of silently using ChatGPT', async () => {
    emitted.length = 0
    desktop!.send(JSON.stringify({ type: 'receipt', kind: 'crops', at: 4, body: { series: {}, automation: { runs: ['clipper', 'editor'], editor: { tabs: 1 } } } }))
    await until(() => emitted.some(e => e.event === 'phone:receipt'))
    await expect(sendAutomationCommand('start', { kind: 'editor', seriesId: 's1', ai: 'aistudio', smallBatches: true })).rejects.toThrow('Update Sleeper-Cell')
    await expect(sendAutomationCommand('start', { kind: 'editor', seriesId: 's1', ai: 'gemini' })).rejects.toThrow('Editor supports ChatGPT or AI Studio')
  })

  it('starts the other runs on a build that has them, and stops whichever is going', async () => {
    emitted.length = 0
    desktop!.send(JSON.stringify({
      type: 'receipt', kind: 'crops', at: 4, body: {
        series: {},
        automation: {
          wakeMode: 'personal', resumeAfterLimit: false, remoteStart: true, resume: null,
          runs: ['clipper', 'narration', 'editor', 'voiceover'], clipper: { ai: 'aistudio', flow: 'steps', tabs: 3 },
          editor: { tabs: 2, staged: true, chatGpt: { mode: 'Chat', model: 'Selected model', effort: 'High' } },
          stopAfter: true, clipperStopping: true
        }
      }
    }))
    await until(() => emitted.some(e => e.event === 'phone:receipt'))
    expect((await getPhoneOverview(null)).automation).toMatchObject({
      runs: ['clipper', 'narration', 'editor', 'voiceover'], clipper: { ai: 'aistudio', flow: 'steps', tabs: 3 },
      editor: { tabs: 2, staged: true, chatGpt: { mode: 'Chat', model: 'Selected model', effort: 'High' } }
    })

    const clip = await sendAutomationCommand('start', { seriesId: 's1', tabs: 2, ai: 'aistudio', flow: 'classic', language: 'hi' })
    await until(() => received.some(m => m.includes(clip.id)))
    expect(JSON.parse(received.find(m => m.includes(clip.id))!)).toEqual({
      type: 'request', id: clip.id, requestedAt: clip.requestedAt, action: 'clipper_start', series: 'Solo Hero', tabs: 2, ai: 'aistudio', flow: 'steps'
    })

    await expect(sendAutomationCommand('start', { seriesId: 's1', ai: 'gemini', flow: 'steps' })).rejects.toThrow('Image Clipper supports ChatGPT or AI Studio')

    const editorChoices = { mode: 'Chat' as const, model: 'Selected model', effort: 'High' }
    const editor = await sendAutomationCommand('start', { kind: 'editor', seriesId: 's1', tabs: 2, language: 'hi', chatGpt: editorChoices })
    await until(() => received.some(m => m.includes(editor.id)))
    expect(JSON.parse(received.find(m => m.includes(editor.id))!)).toEqual({
      type: 'request', id: editor.id, requestedAt: editor.requestedAt, action: 'editor_start', series: 'Solo Hero', tabs: 2, language: 'hi', chatGpt: editorChoices
    })

    emitted.length = 0
    desktop!.send(JSON.stringify({ type: 'receipt', kind: 'crops', at: 5, body: {
      series: {}, automation: { runs: ['clipper', 'narration', 'editor', 'voiceover'], stopAfter: true, clipperStopping: true,
        editor: { tabs: 3, staged: true, ai: 'aistudio', providers: ['chatgpt', 'aistudio'], smallBatches: true }
      }
    } }))
    await until(() => emitted.some(e => e.event === 'phone:receipt'))
    expect((await getPhoneOverview(null)).automation?.editor).toMatchObject({ ai: 'aistudio', providers: ['chatgpt', 'aistudio'], smallBatches: true, tabs: 3 })
    for (const ai of ['chatgpt', 'aistudio'] as const) for (const smallBatches of [true, false]) {
      const sent = await sendAutomationCommand('start', { kind: 'editor', seriesId: 's1', ai, smallBatches, tabs: 3, language: 'hi' })
      await until(() => received.some(m => m.includes(sent.id)))
      expect(JSON.parse(received.find(m => m.includes(sent.id))!)).toMatchObject({ action: 'editor_start', ai, smallBatches, tabs: 3, language: 'hi' })
    }

    const voice = await sendAutomationCommand('start', { kind: 'voiceover', seriesId: 's1', tabs: 4 })
    await until(() => received.some(m => m.includes(voice.id)))
    expect(JSON.parse(received.find(m => m.includes(voice.id))!)).toMatchObject({ action: 'voiceover_start', tabs: 4, language: 'en' })

    await expect(sendAutomationCommand('start', { kind: 'narration' })).rejects.toThrow('Pick a series for Narration scripts')
    // Narration scripts are never split: each chapter goes on from the one before's summary.
    await expect(sendAutomationCommand('start', { kind: 'narration', seriesId: 's1', split: true }))
      .rejects.toThrow('Narration scripts run on one phone at a time: start it on one phone')
    await expect(sendAutomationCommand('start', { kind: 'voiceover', seriesId: 's1', split: true })).rejects.toThrow('Splitting needs two phones')

    const stop = await sendAutomationCommand('stop')
    await until(() => received.some(m => m.includes(stop.id)))
    expect(JSON.parse(received.find(m => m.includes(stop.id))!)).toMatchObject({ action: 'run_stop' })
    expect((await getPhoneOverview(null)).automation).toMatchObject({ stopAfter: true, clipperStopping: true })

    const finish = await sendAutomationCommand('stop', { after: true })
    await until(() => received.some(m => m.includes(finish.id)))
    expect(JSON.parse(received.find(m => m.includes(finish.id))!)).toMatchObject({ action: 'run_finish' })
  })

  it('tracks the phone coming and going', async () => {
    desktop!.send(JSON.stringify({ type: 'presence', phones: 0 }))
    await until(() => relayStatus().phones === 0)
  })
})

describe('two phones', () => {
  const now = new Date().toISOString()
  const crops = (device: string, series: object, automation: object = {}) => ({
    type: 'receipt', kind: 'crops', device, at: 10, body: {
      device: 'Honor', updatedAt: now, series,
      automation: { wakeMode: 'dedicated', resumeAfterLimit: true, remoteStart: true, resume: null, ...automation }
    }
  })
  const aaaaSeries = { 'Solo Hero': {
    total: 21, done: 2, workingPages: [{ chapter: 'Chapter 002', page: 'p1.webp', since: now }],
    chapters: { 'Chapter 001': { total: 2, done: 2, pages: { 'a.webp': 'done', 'b.webp': 'done' } } }
  } }

  it('merges their receipts and lists each phone', async () => {
    emitted.length = 0
    desktop!.send(JSON.stringify({ type: 'presence', phones: 2, devices: [{ id: 'aaaa1111', name: 'Honor' }, { id: 'bbbb2222', name: 'Honor' }] }))
    desktop!.send(JSON.stringify(crops('aaaa1111', aaaaSeries)))
    desktop!.send(JSON.stringify(crops('bbbb2222', { 'Solo Hero': {
      total: 21, done: 2,
      chapters: {
        'Chapter 001': { total: 2, done: 1, pages: { 'a.webp': 'done', 'b.webp': 'in_progress' } },
        'Chapter 003': { total: 4, done: 1, pages: { 'a.webp': 'done' } }
      }
    } })))
    await until(() => (relayReceipts('crops') ?? []).length === 3)

    // Chapter 001's pages count once, Chapter 003's add on: 3, not 4 (summed) or 2 (either phone).
    expect((await getPhoneCrops('s1')).series).toEqual({ s1: { done: 3, total: 21 } })
    const overview = await getPhoneOverview(null)
    const byId = Object.fromEntries(overview.phones.map(p => [p.id, p]))
    // Same model: told apart by the start of their ids. The old app's copy from the tests above is still kept.
    expect(byId.aaaa1111).toMatchObject({ name: 'Honor · aaaa', connected: true, working: 1, automation: { remoteStart: true } })
    expect(byId.bbbb2222).toMatchObject({ name: 'Honor · bbbb', connected: true, working: 0 })
    expect(byId['']).toMatchObject({ name: 'Pixel (old app)', connected: false })
    // No "process" (builds before Metadata): Image Clipper's page.
    expect(overview.working).toEqual([expect.objectContaining({ page: 'p1.webp', process: 'clipper', device: 'aaaa1111', phone: 'Honor · aaaa' })])
  })

  it('splits a series between the phones, unfinished chapters only, balanced by pages left', async () => {
    const { planSplit } = await import('../phoneSplit.js')
    // aaaa is clipping Chapter 002 of it already, on a build that would start over.
    await expect(planSplit('clipper', 's1')).rejects.toThrow('Honor · aaaa is already running this with an older Sleeper-Cell')
    emitted.length = 0
    desktop!.send(JSON.stringify(crops('aaaa1111', aaaaSeries, { rescope: true })))
    await until(() => emitted.some(e => e.event === 'phone:receipt'))

    // aaaa keeps Chapter 002 (10 pages); in reading order the rest go to the phone with the fewest pages so far:
    // 003 (3 left) and 004 (5) to bbbb. Nothing is sent yet.
    received.length = 0
    const plan = await planSplit('clipper', 's1')
    expect(plan).toEqual({
      kind: 'clipper', seriesId: 's1', series: 'Solo Hero', language: 'en',
      targets: [
        { device: 'aaaa1111', name: 'Honor · aaaa', chapters: ['Chapter 002'], inProgress: ['Chapter 002'], action: 'rescope' },
        { device: 'bbbb2222', name: 'Honor · bbbb', chapters: ['Chapter 003', 'Chapter 004'], inProgress: [], action: 'start' }
      ],
      numbers: { 'Chapter 002': 2, 'Chapter 003': 3, 'Chapter 004': 4 }
    })
    expect(received).toEqual([])

    const sent = await sendAutomationCommand('start', { seriesId: 's1', tabs: 2, split: true })
    expect(sent.targets).toEqual([
      { device: 'aaaa1111', name: 'Honor · aaaa', chapters: ['Chapter 002'], reached: true, action: 'rescope' },
      { device: 'bbbb2222', name: 'Honor · bbbb', chapters: ['Chapter 003', 'Chapter 004'], reached: true, action: 'start' }
    ])
    expect(sent.phones).toBe(2)
    await until(() => received.length === 2)
    expect(received.map(m => JSON.parse(m))).toEqual([
      expect.objectContaining({ action: 'clipper_start', device: 'aaaa1111', series: 'Solo Hero', tabs: 2, chapters: ['Chapter 002'] }),
      expect.objectContaining({ action: 'clipper_start', device: 'bbbb2222', series: 'Solo Hero', tabs: 2, chapters: ['Chapter 003', 'Chapter 004'] })
    ])
  })

  it('sends a confirmed split exactly as confirmed', async () => {
    received.length = 0
    const sent = await sendAutomationCommand('start', {
      seriesId: 's1', split: true, assignments: { aaaa1111: ['Chapter 004'], bbbb2222: [] }
    })
    expect(sent.targets).toEqual([
      { device: 'aaaa1111', name: 'Honor · aaaa', chapters: ['Chapter 004'], reached: true, action: 'rescope' },
      { device: 'bbbb2222', name: 'Honor · bbbb', chapters: [], reached: true, action: 'finish' }
    ])
    await until(() => received.length === 2)
    expect(received.map(m => JSON.parse(m))).toEqual([
      expect.objectContaining({ action: 'clipper_start', device: 'aaaa1111', series: 'Solo Hero', chapters: ['Chapter 004'] }),
      expect.objectContaining({ action: 'run_finish', device: 'bbbb2222' })
    ])
    await expect(sendAutomationCommand('start', { seriesId: 's1', split: true, assignments: { aaaa1111: ['Chapter 003'], bbbb2222: ['Chapter 003'] } }))
      .rejects.toThrow('Chapter 003 is in two phones’ shares')
    await expect(sendAutomationCommand('start', { seriesId: 's1', split: true, assignments: { nobody: ['Chapter 003'] } }))
      .rejects.toThrow('not known to the relay')
  })

  it('writes a series\' narration scripts on one phone at a time', async () => {
    emitted.length = 0
    const runs = { runs: ['clipper', 'narration', 'editor', 'voiceover'], rescope: true }
    desktop!.send(JSON.stringify(crops('aaaa1111', aaaaSeries, runs)))
    desktop!.send(JSON.stringify(crops('bbbb2222', {}, runs)))
    const scripts = (runs: object[]) => ({ type: 'receipt', kind: 'scripts', device: 'bbbb2222', at: 11, body: { device: 'Honor', updatedAt: now, series: {}, runs } })
    // bbbb is writing Solo Hero's scripts (paused counts).
    desktop!.send(JSON.stringify(scripts([{ kind: 'narration', series: 'Solo Hero', paused: true, at: now, tabs: [{ chapter: 'Chapter 002', language: 'en' }] }])))
    await until(() => (relayReceipts<{ runs?: unknown[] }>('scripts') ?? []).some(r => r.device === 'bbbb2222' && r.body.runs?.length))

    const busy = 'Honor · bbbb is already writing Solo Hero\'s scripts. Stop it there first.'
    await expect(sendAutomationCommand('start', { kind: 'narration', seriesId: 's1', device: 'aaaa1111' })).rejects.toThrow(busy)
    // To every phone (two connected): one of them would start a second run.
    await expect(sendAutomationCommand('start', { kind: 'narration', seriesId: 's1' })).rejects.toThrow(busy)
    received.length = 0
    // The phone running it may be started again: it resumes.
    const again = await sendAutomationCommand('start', { kind: 'narration', seriesId: 's1', device: 'bbbb2222' })
    await until(() => received.some(m => m.includes(again.id)))
    expect(JSON.parse(received.find(m => m.includes(again.id))!)).toMatchObject({ action: 'narration_start', device: 'bbbb2222', series: 'Solo Hero' })
    // Other runs aren't held back by it.
    await expect(sendAutomationCommand('start', { kind: 'voiceover', seriesId: 's1', device: 'aaaa1111' })).resolves.toMatchObject({ via: 'relay' })

    // A run gone quiet past WORKING_STALE_MS is dead.
    emitted.length = 0
    desktop!.send(JSON.stringify(scripts([{ kind: 'narration', series: 'Solo Hero', at: '2026-01-01T00:00:00Z', tabs: [] }])))
    await until(() => emitted.some(e => e.event === 'phone:receipt'))
    await expect(sendAutomationCommand('start', { kind: 'narration', seriesId: 's1', device: 'aaaa1111' })).resolves.toMatchObject({ via: 'relay' })

    // Back to builds that start only Image Clipper, for the tests below.
    emitted.length = 0
    desktop!.send(JSON.stringify(crops('aaaa1111', aaaaSeries, { rescope: true })))
    desktop!.send(JSON.stringify(crops('bbbb2222', {})))
    await until(() => (relayReceipts<{ automation?: { runs?: unknown } }>('crops') ?? []).every(r => !r.device || !r.body.automation?.runs))
  })

  it('splits Editor 2.0 only between builds that take a share', async () => {
    // Neither phone's receipt says `automation.editor`: each would make every chapter.
    await expect(sendAutomationCommand('start', { kind: 'editor', seriesId: 's1', language: 'en', split: true }))
      .rejects.toThrow('Update Sleeper-Cell on Honor · aaaa and Honor · bbbb to split Editor 2.0')
  })

  it('stops one phone only', async () => {
    received.length = 0
    const sent = await sendAutomationCommand('stop', { device: 'bbbb2222' })
    expect(sent.targets).toEqual([{ device: 'bbbb2222', name: 'Honor · bbbb', chapters: null, reached: true }])
    await until(() => received.length === 1)
    expect(JSON.parse(received[0])).toMatchObject({ action: 'clipper_stop', device: 'bbbb2222' })
    await expect(sendAutomationCommand('stop', { device: 'nobody' })).rejects.toThrow('not known')
  })

  it('needs two phones that can be started to split', async () => {
    desktop!.send(JSON.stringify({ type: 'presence', phones: 1, devices: [{ id: 'aaaa1111', name: 'Honor' }] }))
    await until(() => relayStatus().phones === 1)
    await expect(sendAutomationCommand('start', { seriesId: 's1', split: true })).rejects.toThrow('two phones')
  })

  it('says when each phone was last seen, how it went, and its battery', async () => {
    const { getPhoneScreens } = await import('../phoneScreen.js')
    desktop!.send(JSON.stringify({
      type: 'presence', phones: 1, devices: [{ id: 'aaaa1111', name: 'Honor' }],
      seen: [
        { id: 'aaaa1111', name: 'Honor', at: Date.parse('2026-10-11T10:00:00Z'), left: null },
        { id: 'bbbb2222', name: 'Honor', at: Date.parse('2026-10-11T09:30:00Z'), left: 'shutdown' },
        { id: 'cccc3333', name: 'Gone', at: 'never', left: 'lost' }
      ]
    }))
    await until(() => relayStatus().devices.some(d => d.left === 'shutdown'))
    const byId = new Map(relayStatus().devices.map(d => [d.id, d]))
    expect(byId.get('aaaa1111')).toMatchObject({ connected: true, seenAt: '2026-10-11T10:00:00.000Z', left: null })
    expect(byId.get('bbbb2222')).toMatchObject({ connected: false, seenAt: '2026-10-11T09:30:00.000Z', left: 'shutdown' })

    // A presence without `seen` keeps the last copy; a phone gone with no word of how counts as lost.
    desktop!.send(JSON.stringify({ type: 'presence', phones: 0, devices: [] }))
    await until(() => relayStatus().phones === 0)
    expect(relayStatus().devices.find(d => d.id === 'aaaa1111')).toMatchObject({ connected: false, seenAt: '2026-10-11T10:00:00.000Z', left: 'lost' })

    desktop!.send(JSON.stringify({ type: 'receipt', kind: 'screen', device: 'bbbb2222', at: 9, body: { on: false, battery: { level: 4.4, charging: false, plugged: null } } }))
    desktop!.send(JSON.stringify({ type: 'receipt', kind: 'screen', device: 'aaaa1111', at: 9, body: { on: true, battery: { level: 80, charging: true, plugged: 'usb' } } }))
    await until(() => getPhoneScreens().filter(p => p.screen).length === 2)
    const battery = new Map(getPhoneScreens().map(p => [p.device, p.screen?.battery]))
    expect(battery.get('bbbb2222')).toEqual({ level: 4, charging: false, plugged: null })
    expect(battery.get('aaaa1111')).toEqual({ level: 80, charging: true, plugged: 'usb' })
  })

  it('scopes a production run to validated unfinished chapters on one capable phone', async () => {
    desktop!.send(JSON.stringify(crops('aaaa1111', aaaaSeries, { chapterRuns: ['clipper'] })))
    await until(() => (relayReceipts<{ automation?: { chapterRuns?: string[] } }>('crops') ?? []).some(r => r.device === 'aaaa1111' && r.body.automation?.chapterRuns?.includes('clipper')))
    const sent = await sendAutomationCommand('start', { seriesId: 's1', device: 'aaaa1111', chapters: ['Chapter 001'] })
    await until(() => received.some(m => m.includes(sent.id)))
    expect(JSON.parse(received.find(m => m.includes(sent.id))!)).toMatchObject({ action: 'clipper_start', device: 'aaaa1111', chapters: ['Chapter 001'] })
    expect(sent.targets[0].chapters).toEqual(['Chapter 001'])
    await expect(sendAutomationCommand('start', { seriesId: 's1', device: 'aaaa1111', chapters: ['Another series chapter'] })).rejects.toThrow('not in this series')
    await expect(sendAutomationCommand('start', { seriesId: 's1', chapters: ['Chapter 001'] })).rejects.toThrow('needs one device and series')
    await expect(sendAutomationCommand('start', { seriesId: 's1', device: 'bbbb2222', chapters: ['Chapter 001'] })).rejects.toThrow('Update Sleeper-Cell')
  })

  it('starts Part 2 voiceover with Chapters 21–40 and refuses a stale completed-part selection', async () => {
    desktop!.send(JSON.stringify(crops('aaaa1111', {}, { runs: ['voiceover'], chapterRuns: ['voiceover'] })))
    await until(() => relayReceipts<any>('crops')?.some(r => r.device === 'aaaa1111' && r.body.automation?.chapterRuns?.includes('voiceover')) === true)
    local.controls = [{ folder: 'Solo Hero', parts: { '1': { at: 100, deviceId: 'mac', done: true } } }]
    local.scopeChapters = Array.from({ length: 40 }, (_, i) => ({ id: `c${i + 1}`, number: i + 1,
      completedAt: null, folderPath: `Solo Hero/Chapter ${String(i + 1).padStart(3, '0')}` }))
    try {
      for (const language of ['en', 'hi'] as const) {
        const sent = await sendAutomationCommand('start', { kind: 'voiceover', seriesId: 's1', device: 'aaaa1111', language, tabs: 2 })
        await until(() => received.some(m => m.includes(sent.id)))
        const request = JSON.parse(received.find(m => m.includes(sent.id))!)
        expect(request).toMatchObject({ action: 'voiceover_start', device: 'aaaa1111', language, tabs: 2 })
        expect(request.chapters).toEqual(local.scopeChapters.slice(20).map(c => c.folderPath.split('/').at(-1)))
        expect(sent.targets[0].chapters).toEqual(request.chapters)
      }
      const before = received.length
      await expect(sendAutomationCommand('start', { kind: 'voiceover', seriesId: 's1', device: 'aaaa1111', chapters: ['Chapter 001'] })).rejects.toThrow('completed chapters')
      await expect(sendAutomationCommand('start', { kind: 'voiceover', seriesId: 's1', split: true, assignments: { aaaa1111: ['Chapter 001'] } })).rejects.toThrow('completed chapters')
      local.controls[0].parts['2'] = { at: 100, deviceId: 'mac', done: true }
      await expect(sendAutomationCommand('start', { kind: 'voiceover', seriesId: 's1', device: 'aaaa1111' })).rejects.toThrow('No unfinished chapters')
      expect(received).toHaveLength(before)
    } finally { local.controls = []; local.scopeChapters = null }
  })

  it('dispatches exactly Narration Part 2 to one phone and rejects empty/old-phone scopes', async () => {
    desktop!.send(JSON.stringify(crops('aaaa1111', {}, { runs: ['narration'], chapterRuns: ['narration'] })))
    desktop!.send(JSON.stringify(crops('bbbb2222', {}, { runs: ['narration'], chapterRuns: [] })))
    await until(() => relayReceipts<any>('crops')?.some(r => r.device === 'aaaa1111' && r.body.automation?.chapterRuns?.includes('narration')) === true)
    local.scopeChapters = Array.from({ length: 60 }, (_, i) => ({ id: `c${i + 1}`, number: i + 1,
      folderPath: `Solo Hero/Chapter ${String(i + 1).padStart(3, '0')}` }))
    try {
      const chapters = local.scopeChapters.slice(20, 40).map(c => c.folderPath.split('/').at(-1))
      const sent = await sendAutomationCommand('start', { kind: 'narration', seriesId: 's1', device: 'aaaa1111', chapters })
      await until(() => received.some(m => m.includes(sent.id)))
      expect(JSON.parse(received.find(m => m.includes(sent.id))!)).toMatchObject({ action: 'narration_start', device: 'aaaa1111', chapters })
      expect(sent.targets[0].chapters).toEqual(chapters)
      const before = received.length
      await expect(sendAutomationCommand('start', { kind: 'narration', seriesId: 's1', device: 'aaaa1111', chapters: [] })).rejects.toThrow('Pick chapters')
      await expect(sendAutomationCommand('start', { kind: 'narration', seriesId: 's1', device: 'bbbb2222', chapters })).rejects.toThrow('Update Sleeper-Cell')
      expect(received).toHaveLength(before)
      const paused = (runs: object[]) => ({ type: 'receipt', kind: 'scripts', device: 'aaaa1111', at: 99,
        body: { updatedAt: new Date().toISOString(), series: {}, runs } })
      desktop!.send(JSON.stringify(paused([{ kind: 'narration', series: 'Solo Hero', paused: true,
        at: new Date().toISOString(), tabs: [{ chapter: 'Chapter 015', language: 'hi' }] }])))
      await until(() => relayReceipts<any>('scripts')?.some(r => r.device === 'aaaa1111' && r.body.runs?.length) === true)
      await expect(sendAutomationCommand('start', { kind: 'narration', seriesId: 's1', device: 'aaaa1111', chapters })).rejects.toThrow('Stop the current narration run')
      expect(received).toHaveLength(before)
      desktop!.send(JSON.stringify(paused([])))
      await until(() => relayReceipts<any>('scripts')?.some(r => r.device === 'aaaa1111' && r.body.runs?.length === 0) === true)
    } finally { local.scopeChapters = null }
  })

  it('drops a phone the relay forgot', async () => {
    emitted.length = 0
    desktop!.send(JSON.stringify({ type: 'forgotten', device: '' }))
    await until(() => emitted.some(e => e.event === 'phone:receipt'))
    expect(relayStatus().devices.map(d => d.id).sort()).toEqual(['aaaa1111', 'bbbb2222'])
  })

  it('preserves Gemini web as the phone’s saved clipper provider', async () => {
    desktop!.send(JSON.stringify({ type: 'receipt', kind: 'crops', device: 'aaaa1111', at: Date.now(), body: {
      series: {}, automation: { remoteStart: true, clipper: { ai: 'gemini', flow: 'steps', tabs: 2 } }
    } }))
    await until(() => relayReceipts<any>('crops')?.some(r => r.device === 'aaaa1111' && r.body.automation?.clipper?.ai === 'gemini') === true)
    expect((await getPhoneOverview(null)).phones.find(p => p.id === 'aaaa1111')?.automation?.clipper?.ai).toBe('gemini')
  })
})
