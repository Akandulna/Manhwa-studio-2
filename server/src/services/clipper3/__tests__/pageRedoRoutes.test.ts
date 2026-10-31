import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(), findMany: vi.fn(), sync: vi.fn(), reject: vi.fn(), publish: vi.fn(), autoCrop: vi.fn(),
  legacyPublish: vi.fn(), fetch: vi.fn(), manifest: vi.fn(), setReview: vi.fn(), readReview: vi.fn(), queueEditor: vi.fn(),
}))
vi.mock('../../../index.js', () => ({ prisma: { chapter: { findUnique: mocks.findUnique, findMany: mocks.findMany } } }))
vi.mock('../../editorAutoPublish.js', () => ({ queueEditorPublish: mocks.queueEditor }))
vi.mock('../chapterReview.js', () => ({ setDesktopReview: mocks.setReview, readEffectiveReview: mocks.readReview }))
vi.mock('../processedSync.js', () => ({ syncChapterProcessed: mocks.sync, unsyncChapterProcessed: vi.fn() }))
vi.mock('../pageRedo.js', () => ({ rejectPage: mocks.reject, publishPageRedo: mocks.publish, readPageRedo: vi.fn().mockResolvedValue(null) }))
vi.mock('../studioCropCorrections.js', () => ({ createCorrectionTransport: mocks.legacyPublish, sendStudioCropCorrections: mocks.legacyPublish }))
vi.mock('../chapterCrop.js', () => ({ onChapterCropped: vi.fn(), isChapterCropping: () => false,
  queueAutoCrop: mocks.autoCrop, readChapterCropState: vi.fn(), runChapterCrop: vi.fn(), seriesSlug: () => 'series' }))
vi.mock('../../chapterManifest.js', () => ({ getChapterManifest: mocks.manifest }))
vi.mock('../../phoneRelay.js', () => ({ relayPhones: () => [{ id: 'test-phone', connected: true }], sendPhoneRequest: vi.fn() }))
vi.mock('../../phoneCropImport.js', () => ({ fetchPhoneCrops: mocks.fetch, publishAllCroppedMarkers: vi.fn(), publishChapterCropped: vi.fn(), publishChapterReviewed: vi.fn() }))
vi.mock('../../libraryControls.js', () => ({ libraryControl: vi.fn().mockResolvedValue({}), hiddenLibraryFolders: vi.fn().mockResolvedValue([]) }))
vi.mock('../../chapterPageReplacement.js', () => ({ readPageReplacement: vi.fn().mockResolvedValue(null) }))

import { initClipper3Routes } from '../../../routes/clipper3.js'
const chapter = { id: 'chapter18', seriesId: 'series', number: 18, folderPath: 'Series/Chapter 018', series: { title: 'Series' } }
const result = { chapterId: chapter.id, chapterNumber: 18, imported: 0, replaced: 1, skipped: 0, failed: 0, pages: [{ folder: 'page_017', filename: 'page_017.jpg', status: 'replaced', reason: 'Phone-reviewed replacement', cropCount: 5 }] }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.findUnique.mockResolvedValue(chapter); mocks.findMany.mockResolvedValue([chapter])
  mocks.manifest.mockResolvedValue({ images: [{ filename: 'page_017.jpg', width: 800, height: 9000 }] })
  mocks.fetch.mockResolvedValue({ configured: true }); mocks.sync.mockResolvedValue(result); mocks.autoCrop.mockResolvedValue([])
  mocks.reject.mockResolvedValue({ revision: 'request-id', status: 'pending' })
  mocks.setReview.mockResolvedValue({ reviewed: true }); mocks.readReview.mockResolvedValue({ reviewed: true })
})
function response() {
  const res: any = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res); return res
}
function handler(router: any, path: string, method = 'post') { return router.stack.find((layer: any) => layer.route?.path === path && layer.route?.methods[method]).route.stack[0].handle }

describe('page redo API and ordinary Sync', () => {
  it('rejects the named page only, with its source generation and a single automatic target phone', async () => {
    const router = initClipper3Routes({ emit: vi.fn() } as any), res = response()
    await handler(router, '/chapters/:id/images/:filename/reject')({ params: { id: chapter.id, filename: 'page_017.jpg' } }, res)
    expect(mocks.reject).toHaveBeenCalledWith(expect.objectContaining({ filename: 'page_017.jpg', folderPath: chapter.folderPath,
      deviceId: 'test-phone', restartRevision: null, pageRevision: null }), mocks.publish)
    expect(res.json).toHaveBeenCalledWith({ revision: 'request-id', status: 'pending' })
  })
  it('rejects a page absent from the chapter without queuing any work', async () => {
    const router = initClipper3Routes({ emit: vi.fn() } as any), res = response()
    await handler(router, '/chapters/:id/images/:filename/reject')({ params: { id: chapter.id, filename: 'page_099.jpg' } }, res)
    expect(res.status).toHaveBeenCalledWith(404); expect(mocks.reject).not.toHaveBeenCalled()
  })
  it('normal Sync imports and queues phone-reviewed replacements for cutting, without preparing or publishing retries', async () => {
    let done!: () => void
    const completion = new Promise<void>(resolve => { done = resolve })
    const emit = vi.fn((event: string) => { if (event === 'clipper3:sync-complete') done() })
    const router = initClipper3Routes({ emit } as any), res = response()
    await handler(router, '/series/:seriesId/sync-processed')({ params: { seriesId: chapter.seriesId }, body: { chapterIds: [chapter.id] } }, res)
    await completion
    expect(mocks.sync).toHaveBeenCalledWith(expect.not.objectContaining({ storyLinksOnly: true }))
    expect(mocks.autoCrop).toHaveBeenCalledWith(expect.anything(), [chapter])
    expect(mocks.reject).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.legacyPublish).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('clipper3:sync-complete', expect.not.objectContaining({ corrections: expect.anything() }))
  })
})


describe('review approval publishes Editor packages', () => {
  it('queues an Editor refresh after persisting a desktop approval', async () => {
    mocks.setReview.mockImplementationOnce(async () => expect(mocks.queueEditor).not.toHaveBeenCalled())
    const router = initClipper3Routes({ emit: vi.fn() } as any), res = response()
    await handler(router, '/chapters/:id/review', 'put')({ params: { id: chapter.id }, body: { reviewed: true } }, res)
    expect(mocks.setReview).toHaveBeenCalledWith(chapter.folderPath, true)
    expect(mocks.queueEditor).toHaveBeenCalledWith(chapter.id)
    expect(res.status).not.toHaveBeenCalled()
  })
  it('does not publish when review is revoked or fails to persist', async () => {
    const router = initClipper3Routes({ emit: vi.fn() } as any)
    await handler(router, '/chapters/:id/review', 'put')({ params: { id: chapter.id }, body: { reviewed: false } }, response())
    expect(mocks.queueEditor).not.toHaveBeenCalled()
    mocks.setReview.mockRejectedValueOnce(new Error('disk full'))
    const res = response()
    await handler(router, '/chapters/:id/review', 'put')({ params: { id: chapter.id }, body: { reviewed: true } }, res)
    expect(res.status).toHaveBeenCalledWith(500)
    expect(mocks.queueEditor).not.toHaveBeenCalled()
  })
})
