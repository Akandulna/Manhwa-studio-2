import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ settings: new Map<string, string>(), series: [] as any[], send: vi.fn(), autoSend: vi.fn() }))
vi.mock('../../index.js', () => ({ prisma: {
  setting: {
    findUnique: async ({ where }: any) => state.settings.has(where.key) ? { key: where.key, value: state.settings.get(where.key) } : null,
    findMany: async ({ where }: any) => [...state.settings].filter(([key, value]) => key.startsWith(where.key.startsWith) && (where.value === undefined || value === where.value)).map(([key, value]) => ({ key, value })),
    upsert: async ({ where, create, update }: any) => {
      state.settings.set(where.key,state.settings.has(where.key)?update.value??state.settings.get(where.key):create.value)
      return { key: where.key, value: state.settings.get(where.key) }
    },
  },
  series: { findMany: async ({ where }: any) => state.series.filter(s => where.sourceSite ? !where.sourceSite.notIn.includes(s.sourceSite) : where.id.in.includes(s.id)) },
} }))
vi.mock('../r2Service.js', () => ({
  getR2Config: () => ({ bucket: 'test', prefix: 'Manhwa/' }),
  createClient: () => ({ send: state.send, destroy: vi.fn() }),
}))
vi.mock('../phoneSend.js', () => ({ setAutoSend: state.autoSend, phoneZipFolder: async () => 'manhwa/', updatePhoneIndexes: vi.fn() }))
vi.mock('../phonePull.js', () => ({ importLibraryChapter: vi.fn() }))
vi.mock('../seriesProcess.js', () => ({ notifySeriesProcessChanged: vi.fn() }))
vi.mock('../libraryControls.js', async importOriginal => ({ ...await importOriginal<any>(), purgeDeletedLibrarySeries: vi.fn(async () => {}) }))
const { publishLibrary } = await import('../librarySync.js')

beforeEach(() => {
  vi.stubEnv('RELAY_URL', '')
  state.settings.clear(); state.series.length = 0; state.send.mockReset().mockResolvedValue({}); state.autoSend.mockClear()
  state.settings.set('libraryDeviceId', 'mac-test')
})

describe('legacy library publication', () => {
  it('publishes deletion decisions even after the last series is gone', async () => {
    state.settings.set('libraryControl:Demo', JSON.stringify({ folder: 'Demo', deleted: { at: 1, deviceId: 'mac-test', done: true } }))
    await publishLibrary()
    const body = JSON.parse(state.send.mock.calls[0][0].input.Body)
    expect(body.series).toEqual([])
    expect(body.controls[0].folder).toBe('Demo')
  })
  it('publishes existing desktop series beside phone ZIPs and keeps phone-origin copies out', async () => {
    state.series.push(
      { id: 'old', rootFolder: 'Legacy', title: 'Legacy title', sourceSite: 'imported', chapters: [{ number: 1, folderPath: 'Legacy/Chapter 001', phoneSend: null }] },
      { id: 'phone', rootFolder: 'Phone', title: 'Phone', sourceSite: 'phone', chapters: [] },
    )
    await publishLibrary()
    const put = state.send.mock.calls[0][0].input
    expect(put.Key).toBe('library/mac-test.json')
    const body = JSON.parse(put.Body)
    expect(body.series).toHaveLength(1)
    expect(body.series[0]).toMatchObject({ folder: 'Legacy', title: 'Legacy title', chapters: [{ name: 'Chapter 001', number: 1 }] })
    expect(state.settings.get('libraryOwner:old')).toBe('mac-test')
    expect(state.settings.has('libraryOwner:phone')).toBe(false)
    // Publishing the catalog must not start preparation or change legacy upload preferences.
    expect(state.autoSend).not.toHaveBeenCalled()
  })
})
