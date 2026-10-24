import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../seriesActivity.js', () => ({ recordPhoneActivity: vi.fn() }))
vi.mock('../seriesProcess.js', () => ({ receiveDeviceProcess: vi.fn(), notifySeriesProcessChanged: vi.fn() }))
vi.mock('../librarySync.js', () => ({ receiveLibraryManifest: vi.fn(), scheduleLibraryPublish: vi.fn() }))
vi.mock('../../utils/envFile.js', () => ({ writeEnvVars: vi.fn() }))

const state = vi.hoisted(() => ({ sockets: [] as any[], fail: false }))
vi.mock('ws', () => ({ default: class extends EventEmitter {
  static OPEN = 1
  readyState = 1
  send = vi.fn()
  terminate = vi.fn(() => this.emit('close'))
  constructor(public url: string, public options: any) {
    super()
    if (state.fail) throw new Error('Connection setup failed')
    state.sockets.push(this)
  }
} }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

async function setup() {
  vi.resetModules()
  vi.useFakeTimers()
  vi.spyOn(Math,'random').mockReturnValue(1)
  state.sockets = []
  state.fail = false
  vi.stubEnv('RELAY_URL', 'https://relay.example')
  vi.stubEnv('RELAY_TOKEN', 'test')
  const settings=new Map<string,string>()
  const {configureRelayTraffic}=await import('../relayTraffic.js')
  configureRelayTraffic({setting:{
    findUnique:async({where}:any)=>settings.has(where.key)?{value:settings.get(where.key)}:null,
    upsert:async({where,create,update}:any)=>{const value=settings.has(where.key)?update.value??settings.get(where.key):create.value;settings.set(where.key,value);return {key:where.key,value}}
  }} as never)
  const relay = await import('../phoneRelay.js')
  relay.startPhoneRelay({ emit: vi.fn() } as never)
  await vi.advanceTimersByTimeAsync(0)
  return relay
}

describe('relay connection recovery', () => {
  it('bounds the upgrade wait and retries after a handshake timeout', async () => {
    const relay = await setup()
    const stalled = state.sockets[0]
    expect(stalled.options.handshakeTimeout).toBe(15_000)
    stalled.emit('error', new Error('Opening handshake has timed out'))
    stalled.emit('close')
    expect(relay.relayStatus()).toMatchObject({ connected: false, lastError: 'Opening handshake has timed out' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(state.sockets).toHaveLength(2)
    state.sockets[1].emit('open')
    expect(relay.relayStatus()).toMatchObject({ connected: true, lastError: null })
  })

  it('retries when connection setup throws before a socket exists', async () => {
    await setup()
    state.sockets[0].emit('close')
    state.fail = true
    await vi.advanceTimersByTimeAsync(2_000)
    state.fail = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(state.sockets).toHaveLength(2)
  })
  it('persists an upgrade 429 before scheduling another handshake',async()=>{
    await setup()
    state.sockets[0].emit('unexpected-response',{destroy:vi.fn()},{statusCode:429,headers:{'retry-after':'600'},resume:vi.fn()})
    await vi.advanceTimersByTimeAsync(599_999)
    expect(state.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(state.sockets).toHaveLength(2)
  })
  it('blocks authentication failures until configuration changes',async()=>{
    await setup()
    state.sockets[0].emit('unexpected-response',{destroy:vi.fn()},{statusCode:401,headers:{},resume:vi.fn()})
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(state.sockets).toHaveLength(1)
  })
  it('blocks command fallbacks after a budget notification on an open socket',async()=>{
    const relay=await setup()
    state.sockets[0].emit('open')
    state.sockets[0].emit('message',Buffer.from(JSON.stringify({type:'relay:budget',retryAfter:600})))
    await vi.advanceTimersByTimeAsync(0)
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
    await expect(relay.sendPhoneRequest()).rejects.toThrow('paused')
    expect(fetch).not.toHaveBeenCalled()
  })

})
