import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  rows: vi.fn(), hidden: vi.fn(), config: vi.fn(), status: vi.fn(), fetch: vi.fn(), changed: vi.fn(), receipt: vi.fn(), emit: vi.fn()
}))
vi.mock('../../index.js', () => ({ prisma: { series: { findMany: mock.rows } } }))
vi.mock('../libraryControls.js', () => ({ hiddenLibraryFolders: mock.hidden }))
vi.mock('../seriesActivity.js', () => ({ withSeriesActivity: async (rows: any[]) => rows }))
vi.mock('../r2Service.js', () => ({ getR2Config: mock.config }))
vi.mock('../phoneRelay.js', () => ({ onPhoneReceipt: mock.receipt }))
vi.mock('../metadataChapterStatus.js', () => ({ readMetadataChapter: mock.status }))
vi.mock('../clipper3/metadataSplit.js', () => ({ fetchMetadataResults: mock.fetch }))
vi.mock('../seriesProcess.js', () => ({ notifySeriesProcessChanged: mock.changed }))

import { getMetadataLibrary, metadataReceiptChanged, startMetadataAutoSync, stopMetadataAutoSync, syncMetadataLibrary } from '../metadataLibrary.js'
const chapters = ['c1', 'c2', 'c3'].map((id, i) => ({ id, number: i + 1, title: null, folderPath: `Series/Chapter ${i + 1}`, seriesId: 's1' }))
beforeEach(() => {
  vi.clearAllMocks()
  mock.hidden.mockResolvedValue(['Hidden'])
  mock.config.mockReturnValue({ bucket: 'test' })
  mock.rows.mockResolvedValue([{ id: 's1', title: 'Series', rootFolder: 'Series', sourceSite: 'manual', chapters }])
  mock.status.mockImplementation(async (c: any) => ({ ...c, name: `Chapter ${c.number}`, state: c.id === 'c1' ? 'complete' : 'pending',
    ready: c.id !== 'c3', done: c.id === 'c1' ? 2 : 0, total: 2, pages: [] }))
  mock.fetch.mockResolvedValue({ imported: 1, errors: [] })
})
afterEach(() => { stopMetadataAutoSync(); vi.useRealTimers() })

describe('Metadata automatic fetch', () => {
  it('fetches only ready unfinished chapters and refreshes progress after validated imports', async () => {
    const result = await syncMetadataLibrary()
    expect(mock.fetch).toHaveBeenCalledTimes(1)
    expect(mock.fetch.mock.calls[0][0].id).toBe('c2')
    expect(result.imported).toBe(1); expect(mock.changed).toHaveBeenCalledWith(true)
    expect(mock.rows.mock.calls[0][0]).toMatchObject({ where: { rootFolder: { notIn: ['Hidden'] } }, select: { chapters: { where: { status: 'done', completedAt: null } } } })
  })
  it('coalesces concurrent manual and automatic refreshes into one cloud fetch', async () => {
    let finish!: (value: any) => void
    mock.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const first = syncMetadataLibrary(), second = syncMetadataLibrary()
    expect(first).toBe(second)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    finish({ imported: 1, errors: [] })
    await first
    expect(mock.fetch).toHaveBeenCalledTimes(1)
  })
  it('shows rejected results and keeps checking later chapters', async () => {
    mock.status.mockImplementation(async () => ({ ready: true, state: 'pending' }))
    mock.fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ imported: 0, errors: ['Stale Metadata job result'] }).mockResolvedValueOnce({ imported: 1, errors: [] })
    const result = await syncMetadataLibrary()
    expect(result).toMatchObject({ imported: 1, errors: [{ chapterId: 'c1', reason: 'offline' }, { chapterId: 'c2', reason: 'Stale Metadata job result' }] })
    expect(mock.fetch).toHaveBeenCalledTimes(3)
  })
  it('serves local statuses with R2 unconfigured and makes no cloud requests', async () => {
    mock.config.mockReturnValue(null)
    expect((await syncMetadataLibrary()).imported).toBe(0)
    expect(mock.fetch).not.toHaveBeenCalled()
    const view = await getMetadataLibrary()
    expect(view.configured).toBe(false); expect(view.series[0].chapters).toHaveLength(3)
  })
  it('ignores unchanged metadata receipts and retries after a missed upload notification', async () => {
    vi.useFakeTimers()
    startMetadataAutoSync({ emit: mock.emit } as any)
    const receive = mock.receipt.mock.calls[0][0]
    const body = { metadata: { Series: { 'Chapter 1': { done: 1, total: 2 } } } }
    receive('crops', 'phone-retry', body)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mock.fetch).toHaveBeenCalledTimes(1)
    receive('crops', 'phone-retry', body)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mock.fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(55_000)
    expect(mock.fetch).toHaveBeenCalledTimes(2)
    expect(mock.emit).toHaveBeenCalledWith('metadata:updated', expect.objectContaining({ imported: 1 }))
  })
  it('tracks receipt changes per phone without reacting to clipping-only receipts', () => {
    expect(metadataReceiptChanged('phone-shape', { series: {} })).toBe(false)
    expect(metadataReceiptChanged('phone-shape', { metadata: [] })).toBe(false)
    expect(metadataReceiptChanged('phone-shape', { metadata: { Series: { C: { done: 1 } } } })).toBe(true)
    expect(metadataReceiptChanged('phone-shape', { metadata: { Series: { C: { done: 1 } } }, workingPages: [] })).toBe(false)
    expect(metadataReceiptChanged('phone-shape', { metadata: { Series: { C: { done: 2 } } } })).toBe(true)
    expect(metadataReceiptChanged('another-phone', { metadata: { Series: { C: { done: 2 } } } })).toBe(true)
  })
})
