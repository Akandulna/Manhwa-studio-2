import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { isSeriesObject, mergeControl, validControls } from '../libraryControlModel.js'
const state = vi.hoisted(() => ({ settings: new Map<string, string>(), rows: [] as any[], send: vi.fn(), cancel: vi.fn() }))
vi.mock('../../index.js', () => ({ downloadManager: { cancelSeries: state.cancel }, prisma: {
  setting: {
    findMany: async ({ where }: any) => [...state.settings].filter(([key]) => key.startsWith(where.key.startsWith)).map(([key, value]) => ({ key, value })),
    findUnique: async ({ where }: any) => state.settings.has(where.key) ? { value: state.settings.get(where.key) } : null,
    upsert: async ({ where, create, update }: any) => { state.settings.set(where.key, state.settings.has(where.key) ? update.value : create.value) },
    deleteMany: vi.fn(),
  },
  series: { findMany: async () => state.rows, delete: async () => { state.rows = [] } },
  watermarkTemplate: { findMany: async () => [] },
} }))
vi.mock('../r2Service.js', () => ({ getR2Config: () => ({ bucket: 'test' }), createClient: () => ({ send: state.send, destroy: vi.fn() }), invalidateStorage: vi.fn() }))
const { saveLibraryControls, libraryControl, purgeDeletedLibrarySeries } = await import('../libraryControls.js')
let root: string
beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'library-delete-')); process.env.DOWNLOAD_ROOT = root })
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }) })
beforeEach(() => { state.settings.clear(); state.rows = []; state.send.mockReset(); state.cancel.mockReset() })
const d = (at: number, done = true) => ({ at, done, deviceId: 'nord' })

describe('shared library actions', () => {
  it('merges independent part marks, preserves deletion, and ignores stale completion after undo', async () => {
    await saveLibraryControls([{ folder: 'Demo', parts: { 1: d(2) } }])
    await saveLibraryControls([{ folder: 'Demo', parts: { 1: d(3, false), 2: d(1) }, deleted: d(4) }])
    await saveLibraryControls([{ folder: 'Demo', parts: { 1: d(1) } }])
    expect(await libraryControl('Demo')).toMatchObject({ deleted: d(4), parts: { 1: d(3, false), 2: d(1) } })
    expect(mergeControl({ folder: 'Demo', parts: { 1: d(2) } }, { folder: 'Demo', parts: { 1: d(2, false) } }).parts?.[1].done).toBe(false)
  })
  it('merges per-language series Done marks and rejects unknown languages', async () => {
    await saveLibraryControls([{ folder: 'Demo', seriesDone: { en: d(2) } }])
    await saveLibraryControls([{ folder: 'Demo', seriesDone: { en: d(1, false), hi: d(3) } }])
    expect((await libraryControl('Demo')).seriesDone).toEqual({ en: d(2), hi: d(3) })
    expect(validControls([{ folder: 'Demo', seriesDone: { fr: d(1) } }])).toBe(false)
  })
  it('rejects malformed and unsafe actions before storing them', async () => {
    for (const c of [{ folder: '../Demo', deleted: d(1) }, { folder: 'Demo', parts: { '-1': d(1) } }, { folder: 'Demo', deleted: d(1, false) }]) {
      expect(validControls([c])).toBe(false)
      await expect(saveLibraryControls([c] as any)).rejects.toThrow()
    }
    expect(state.settings.size).toBe(0)
  })
  it('archives without deleting files or cloud evidence, survives stale sync and supports restore', async () => {
    await fs.mkdir(path.join(root,'Archived'),{recursive:true});await fs.writeFile(path.join(root,'Archived/evidence'),'retain')
    await saveLibraryControls([{folder:'Archived',archived:d(10)}])
    await saveLibraryControls([{folder:'Archived'}])
    expect((await libraryControl('Archived')).archived?.done).toBe(true)
    await purgeDeletedLibrarySeries()
    expect(await fs.readFile(path.join(root,'Archived/evidence'),'utf8')).toBe('retain')
    expect(state.send).not.toHaveBeenCalled();expect(state.cancel).not.toHaveBeenCalled()
    await saveLibraryControls([{folder:'Archived',archived:d(11,false)}])
    await saveLibraryControls([{folder:'Archived',archived:d(10)}])
    expect((await libraryControl('Archived')).archived?.done).toBe(false)
  })
  it('retains a durable deletion decision when cloud deletion fails, then retries it', async () => {
    await saveLibraryControls([{ folder: 'Demo', deleted: d(1) }])
    state.send.mockResolvedValueOnce({ Contents: [{ Key: 'manhwa/Demo/ch.zip' }] }).mockResolvedValueOnce({ Errors: [{ Key: 'manhwa/Demo/ch.zip' }] })
    await expect(purgeDeletedLibrarySeries()).rejects.toThrow('cleanup will retry')
    expect(state.settings.has('libraryDeletedCloud:Demo')).toBe(false)
    expect((await libraryControl('Demo')).deleted).toEqual(d(1))
    state.send.mockResolvedValueOnce({ Contents: [{ Key: 'manhwa/Demo/ch.zip' }] }).mockResolvedValueOnce({})
    await purgeDeletedLibrarySeries()
    expect(state.settings.has('libraryDeletedCloud:Demo')).toBe(true)
  })
  it('deletes the series files and cloud objects while preserving similarly named series; replay is safe', async () => {
    await fs.mkdir(path.join(root, 'Demo/Chapter 001'), { recursive: true })
    await fs.writeFile(path.join(root, 'Demo/Chapter 001/script.md'), 'work')
    await fs.mkdir(path.join(root, 'Demo 2'), { recursive: true })
    state.rows = [{ id: 's', rootFolder: 'Demo' }]
    await saveLibraryControls([{ folder: 'Demo', deleted: d(1) }])
    state.send.mockResolvedValueOnce({ Contents: [{ Key: 'manhwa/Demo/Chapter 001.zip' }, { Key: 'shared/scripts/Demo/Chapter 001.json' }, { Key: 'editor/Demo 2/file.json' }, { Key: 'shared/metadata-jobs/Demo/Chapter 001/page_001.page.json' }, { Key: 'metadata/Demo/Chapter 001/page_001.page.json' }, { Key: 'metadata/Demo 2/Chapter 001/page_001.page.json' }] }).mockResolvedValue({})
    await purgeDeletedLibrarySeries()
    expect(state.cancel).toHaveBeenCalledWith('s')
    expect(await fs.stat(path.join(root, 'Demo')).catch(() => null)).toBeNull()
    expect((await fs.stat(path.join(root, 'Demo 2'))).isDirectory()).toBe(true)
    expect(state.send.mock.calls[1][0].input.Delete.Objects).toEqual([{ Key: 'manhwa/Demo/Chapter 001.zip' }, { Key: 'shared/scripts/Demo/Chapter 001.json' }, { Key: 'shared/metadata-jobs/Demo/Chapter 001/page_001.page.json' }, { Key: 'metadata/Demo/Chapter 001/page_001.page.json' }])
    await purgeDeletedLibrarySeries()
    expect(state.send).toHaveBeenCalledTimes(2)
    expect(isSeriesObject('diagnostics/Demo/file.txt', 'Demo')).toBe(false)
    expect(isSeriesObject('manhwa/Other/crops/Demo/file.txt', 'Demo')).toBe(false)
    expect(isSeriesObject('editor/Demo', 'Demo')).toBe(false)
  })
})
