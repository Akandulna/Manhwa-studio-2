import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
const { db, queue, capture } = vi.hoisted(() => ({
  db: { editor2Timeline: { findUnique: vi.fn(), upsert: vi.fn() }, setting: { upsert: vi.fn(), findUnique: vi.fn() }, $transaction: vi.fn() },
  queue: vi.fn(), capture: vi.fn()
}))
vi.mock('../../index.js', () => ({ prisma: db }))
vi.mock('../phoneEditor.js', () => ({ captureEditorTimelineSource: capture, fetchPhoneTimelines: vi.fn(), getEditorPrompt: vi.fn(), saveEditorPrompt: vi.fn(), sendEditorPackages: vi.fn() }))
vi.mock('../editorAutoPublish.js', () => ({ queueEditorPublish: queue }))
vi.mock('../managedChapterAssets.js', () => ({ managedChapterImage: vi.fn() }))
vi.mock('../diskReconcile.js', () => ({ reconcileQuietly: vi.fn() }))
vi.mock('../videoEditor2Service.js', () => ({ getChapterBlockers: vi.fn(), getChapterCropMetadataBundle: vi.fn(), getChapterTimelineBundle: vi.fn(), getEditableChapters2: vi.fn(), getSeriesCompletion2: vi.fn() }))
vi.mock('../editor2Timeline.js', () => ({ processTimelineJson: vi.fn() }))
vi.mock('../editor2CropRepair.js', () => ({ repairSeriesTimelineRefs: vi.fn() }))
vi.mock('../editor2Export.js', () => ({ cancelExport2Job: vi.fn(), getExport2Job: vi.fn(), getExportedChapterIds: vi.fn(), startBatchExport: vi.fn() }))
vi.mock('../editorWorkflowStore.js', () => ({ editorWorkflowSession: vi.fn() }))
const { initVideoEditor2Routes } = await import('../../routes/videoEditor2.js')
const handler = initVideoEditor2Routes({} as never).stack.find((l: any) => l.route?.path === '/chapters/:id/timeline' && l.route.methods.put)!.route!.stack[0].handle as unknown as (req: unknown, res: unknown) => Promise<void>
function row(json = 'old', time = 1000) { return { chapterId: 'c1', language: 'en', json, processedJson: null, model: null, updatedAt: new Date(time) } }
async function save(body: unknown) {
  const res = { json: vi.fn(), status: vi.fn() }
  res.status.mockReturnValue(res)
  await handler({ params: { id: 'c1' }, query: {}, body }, res)
  return res
}
beforeEach(() => {
  vi.clearAllMocks()
  db.editor2Timeline.findUnique.mockResolvedValue(row())
  db.editor2Timeline.upsert.mockImplementation(async ({ update }) => ({ ...row(), ...update }))
  db.$transaction.mockImplementation(async fn => fn(db))
  capture.mockResolvedValue('inputs-hash')
  db.setting.findUnique.mockResolvedValue(null)
})
describe('Studio timeline saves request device publication', () => {
  it('commits the edit and publication intent before queueing sync', async () => {
    const json = '{"sections":[{"section":"Section 1"}]}'
    const response = await save({ json, processedJson: null, updatedAt: 2000 })
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ json, updatedAt: 2000 }))
    const call = db.setting.upsert.mock.calls[0][0]
    expect(call.where.key).toBe('editor2-phone-timeline-edit:c1:en')
    expect(JSON.parse(call.create.value)).toEqual({ jsonSha256: createHash('sha256').update(json).digest('hex'), madeAt: new Date(2000).toISOString(), sourceSha256: 'inputs-hash' })
    expect(queue).toHaveBeenCalledWith('c1')
    expect(db.setting.upsert.mock.invocationCallOrder[0]).toBeLessThan(queue.mock.invocationCallOrder[0])
  })
  it('ignores stale browser writes', async () => {
    await save({ json: 'stale', processedJson: null, updatedAt: 500 })
    expect(capture).not.toHaveBeenCalled()
    expect(queue).not.toHaveBeenCalled()
  })
  it('does not turn processing-only updates into new timeline edits', async () => {
    await save({ json: 'old', processedJson: '{}', updatedAt: 2000 })
    expect(db.setting.upsert).not.toHaveBeenCalled()
    expect(queue).not.toHaveBeenCalled()
  })
  it('keeps cleared timelines eligible for automatic package publication', async () => {
    await save({ json: '', processedJson: null, updatedAt: 2000 })
    expect(capture).not.toHaveBeenCalled()
    const reset = db.setting.upsert.mock.calls.find(([call]) => call.where.key === 'editor2-phone-timeline-reset:c1:en')![0]
    expect(JSON.parse(reset.create.value).revision).toBe(new Date(2000).toISOString())
    expect(queue).toHaveBeenCalledWith('c1')
  })
  it('creates a fresh reset revision even when the stored timeline is already empty', async () => {
    db.editor2Timeline.findUnique.mockResolvedValue(row(''))
    await save({ json: '', processedJson: null, updatedAt: 3000, reset: true })
    expect(queue).toHaveBeenCalledWith('c1')
    const reset = db.setting.upsert.mock.calls.find(([call]) => call.where.key === 'editor2-phone-timeline-reset:c1:en')![0]
    expect(JSON.parse(reset.create.value).revision).toBe(new Date(3000).toISOString())
  })
  it('rejects a reset attached to a nonempty timeline', async () => {
    const response = await save({ json: 'still here', processedJson: null, updatedAt: 3000, reset: true })
    expect(response.status).toHaveBeenCalledWith(400)
    expect(queue).not.toHaveBeenCalled()
  })
  it('rechecks the stored version after source capture to preserve a concurrent newer save', async () => {
    db.editor2Timeline.findUnique.mockResolvedValueOnce(row()).mockResolvedValueOnce(row('newer', 3000))
    const response = await save({ json: 'outdated', processedJson: null, updatedAt: 2000 })
    expect(db.editor2Timeline.upsert).not.toHaveBeenCalled()
    expect(queue).not.toHaveBeenCalled()
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ json: 'newer', updatedAt: 3000 }))
  })
})
