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
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

async function setup() {
  vi.resetModules()
  vi.useFakeTimers()
  state.sockets = []
  state.fail = false
  vi.stubEnv('RELAY_URL', 'https://relay.example')
  vi.stubEnv('RELAY_TOKEN', 'test')
  const relay = await import('../phoneRelay.js')
  relay.startPhoneRelay({ emit: vi.fn() } as never)
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
})
