import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseLibraryManifest } from '../libraryManifest.js'

const state = vi.hoisted(() => ({ settings: new Map<string, string>(), series: [] as any[], chapters: [] as any[], events: [] as string[], pull: vi.fn() }))
vi.mock('../../index.js', () => ({ prisma: {
  setting: {
    findMany: async ({ where }: any) => [...state.settings].filter(([key]) => key.startsWith(where.key.startsWith)).map(([key, value]) => ({ key, value })),
    findUnique: async ({ where }: any) => state.settings.has(where.key) ? { key: where.key, value: state.settings.get(where.key) } : null,
    upsert: async ({ where, create, update }: any) => {
      const value = state.settings.has(where.key) ? update.value ?? state.settings.get(where.key) : create.value
      state.settings.set(where.key, value)
      return { key: where.key, value }
    }
  },
  series: {
    findMany: async ({ where }: any) => state.series.filter(s => !where?.sourceSite?.notIn?.includes(s.sourceSite)),
    findFirst: async ({ where }: any) => state.series.find(s => s.rootFolder === where.rootFolder) ?? null,
    create: async ({ data }: any) => { const row = { id: `s${state.series.length}`, ...data }; state.series.push(row); return row }
  },
  chapter: { upsert: async ({ where, create }: any) => {
    const match = state.chapters.find(c => c.seriesId === where.seriesId_number.seriesId && c.number === where.seriesId_number.number)
    if (match) return match
    state.chapters.push(create); return create
  } }
} }))
vi.mock('../r2Service.js', () => ({ getR2Config: () => null, createClient: vi.fn() }))
vi.mock('../phoneSend.js', () => ({ setAutoSend: vi.fn(), noteChapterDownloaded: vi.fn(), flushAutoSend: vi.fn() }))
vi.mock('../phonePull.js', () => ({ importLibraryChapter: state.pull }))
vi.mock('../libraryControls.js', async importOriginal => ({ ...await importOriginal<any>(), purgeDeletedLibrarySeries: vi.fn(async () => {}) }))
const { receiveLibraryManifest, startLibrarySync, registerExistingLibrarySeries } = await import('../librarySync.js')
const catalog = (at = '2026-10-15T10:00:00Z') => ({ schema: 'manhwa-library/1', deviceId: 'nord', device: 'Nord', updatedAt: at, series: [{
  folder: 'Demo', title: 'Demo', chapters: [{ name: 'Chapter 001', number: 1, key: 'manhwa/Demo/Chapter 001.zip', sentAt: at }, { name: 'Chapter 002', number: 2 }]
}] })

beforeEach(() => {
  state.settings.clear(); state.series.length = 0; state.chapters.length = 0; state.events.length = 0; state.pull.mockReset()
  state.settings.set('libraryDeviceId', 'mac-test')
  startLibrarySync({ emit: (event: string) => state.events.push(event) } as never)
})

describe('shared library catalog', () => {
  it('does not resurrect a globally deleted series from an old offline catalog', async () => {
    state.settings.set('libraryControl:Demo', JSON.stringify({ folder: 'Demo', deleted: { at: 1, deviceId: 'nord', done: true } }))
    receiveLibraryManifest(catalog())
    await vi.waitFor(() => expect(state.settings.has('libraryReceived:nord')).toBe(true))
    expect(state.series).toHaveLength(0)
    expect(state.pull).not.toHaveBeenCalled()
  })
  it('registers legacy desktop series but leaves phone imports and existing owners alone', async () => {
    state.series.push(
      { id: 'old-download', sourceSite: 'demonicscans.org' },
      { id: 'old-import', sourceSite: 'imported' },
      { id: 'phone-copy', sourceSite: 'phone' },
      { id: 'shared-copy', sourceSite: 'shared' },
      { id: 'already-owned', sourceSite: 'demonicscans.org' },
    )
    state.settings.set('libraryOwner:already-owned', 'nord')
    await registerExistingLibrarySeries()
    await registerExistingLibrarySeries()
    expect(state.settings.get('libraryOwner:old-download')).toBe('mac-test')
    expect(state.settings.get('libraryOwner:old-import')).toBe('mac-test')
    expect(state.settings.has('libraryOwner:phone-copy')).toBe(false)
    expect(state.settings.has('libraryOwner:shared-copy')).toBe(false)
    expect(state.settings.get('libraryOwner:already-owned')).toBe('nord')
  })

  it('registers legacy local ownership before accepting a conflicting remote catalog', async () => {
    state.series.push({ id: 'legacy', rootFolder: 'Demo', sourceSite: 'demonicscans.org' })
    receiveLibraryManifest(catalog())
    await vi.waitFor(() => expect(state.settings.has('libraryReceived:nord')).toBe(true))
    expect(state.settings.get('libraryOwner:legacy')).toBe('mac-test')
    expect(state.pull).not.toHaveBeenCalled()
  })

  it('shows the complete listing before importing ready chapters, without giving replicas source URLs', async () => {
    state.pull.mockImplementation(async () => {
      expect(state.chapters).toHaveLength(2)
      expect(state.events).toContain('library:updated')
      expect(state.chapters.every(c => !c.sourceUrl)).toBe(true)
    })
    receiveLibraryManifest(catalog())
    await vi.waitFor(() => expect(state.settings.get('libraryReceived:nord')).toBe('2026-10-15T10:00:00Z'))
    expect(state.pull).toHaveBeenCalledTimes(1)
    expect(state.settings.get('libraryOwner:s0')).toBe('nord')
  })

  it('ignores duplicates and older reconnect snapshots', async () => {
    receiveLibraryManifest(catalog())
    await vi.waitFor(() => expect(state.pull).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(state.settings.has('libraryReceived:nord')).toBe(true))
    receiveLibraryManifest(catalog('2026-10-14T00:00:00Z'))
    receiveLibraryManifest(catalog())
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(state.pull).toHaveBeenCalledTimes(1)
    expect(state.chapters).toHaveLength(2)
  })

  it('preserves the local origin when another catalog names its series folder', async () => {
    state.series.push({ id: 'local', rootFolder: 'Demo' })
    state.settings.set('libraryOwner:local', 'mac-test')
    receiveLibraryManifest(catalog())
    await vi.waitFor(() => expect(state.settings.has('libraryReceived:nord')).toBe(true))
    expect(state.pull).not.toHaveBeenCalled()
    expect(state.chapters).toHaveLength(0)
  })

  it('rejects unsafe folders, foreign chapter keys, null entries and incomplete versions', () => {
    for (const bad of [null, {}, { ...catalog(), series: [null] }, { ...catalog(), series: [{ ...catalog().series[0], folder: '../Demo' }] },
      { ...catalog(), series: [{ ...catalog().series[0], chapters: [{ name: 'Chapter 001', number: 1, key: 'scripts/private.zip' }] }] }]) {
      expect(parseLibraryManifest(bad)).toBeNull()
    }
    expect(parseLibraryManifest(catalog())).not.toBeNull()
  })
})
