import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ input: vi.fn(), read: vi.fn(), review: vi.fn(), cut: vi.fn(), queue: vi.fn() }))
vi.mock('../../index.js', () => ({ prisma: {} }))
vi.mock('../managedPilotInput.js', () => ({ managedPilotInput: mocks.input }))
vi.mock('../editorAutoPublish.js', () => ({ queueEditorPublish: mocks.queue }))
vi.mock('../managedCropReview.js', () => ({
  readManagedCropReview: mocks.read, setManagedCropReview: mocks.review, cutReviewedManagedCrop: mocks.cut,
  reviewedManagedCropFile: vi.fn(), readManagedBoundaryFeedback: vi.fn(), saveManagedBoundaryFeedback: vi.fn(), applyManagedBoundaryFeedback: vi.fn()
}))
import { initManagedPilotRoutes } from '../../routes/managedPilot.js'

const taskId = `task:sha256:${'a'.repeat(64)}`
const revision = 'b'.repeat(64)
const db: any = { page: { findUnique: vi.fn(async () => ({ chapterId: 'chapter' })) } }
function response() {
  const res: any = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res); return res
}
function handler(path: string) {
  const router: any = initManagedPilotRoutes(db)
  return router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods.post).route.stack[0].handle
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.input.mockResolvedValue({ folder: 'Demo/Chapter 001', filename: 'page.png' })
  mocks.read.mockResolvedValue({ taskId })
  mocks.review.mockResolvedValue({ reviewed: true, revision })
  mocks.cut.mockResolvedValue({ reviewed: true, cut: { complete: true }, revision })
})
describe('managed review Editor publication', () => {
  it('queues only after a successful exact-revision approval', async () => {
    mocks.review.mockImplementationOnce(async () => { expect(mocks.queue).not.toHaveBeenCalled(); return { reviewed: true } })
    const res = response()
    await handler('/pages/:pageId/review')({ params: { pageId: 'page' }, body: { taskId, expectedRevision: revision, reviewed: true } }, res)
    expect(mocks.review).toHaveBeenCalledWith('Demo/Chapter 001', 'page.png', revision, true)
    expect(mocks.queue).toHaveBeenCalledWith('chapter')
    expect(res.status).not.toHaveBeenCalled()
  })
  it('does not queue revoked or failed reviews', async () => {
    const review = handler('/pages/:pageId/review')
    await review({ params: { pageId: 'page' }, body: { taskId, expectedRevision: revision, reviewed: false } }, response())
    mocks.review.mockRejectedValueOnce(new Error('revision changed'))
    const res = response()
    await review({ params: { pageId: 'page' }, body: { taskId, expectedRevision: revision, reviewed: true } }, res)
    expect(res.status).toHaveBeenCalledWith(409)
    expect(mocks.queue).not.toHaveBeenCalled()
  })
  it('queues when the reviewed cut finishes, and retains the gate on failed cuts', async () => {
    const cut = handler('/pages/:pageId/cut')
    await cut({ params: { pageId: 'page' }, body: { taskId, expectedRevision: revision } }, response())
    expect(mocks.queue).toHaveBeenCalledWith('chapter')
    mocks.queue.mockClear(); mocks.cut.mockRejectedValueOnce(new Error('review changed'))
    const res = response()
    await cut({ params: { pageId: 'page' }, body: { taskId, expectedRevision: revision } }, res)
    expect(res.status).toHaveBeenCalledWith(409)
    expect(mocks.queue).not.toHaveBeenCalled()
  })
})
