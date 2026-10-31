import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { startSeriesActivity, seriesActivityMiddleware, withSeriesActivity, flushSeriesActivity } from '../seriesActivity.js'

const db = {
  setting: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
  series: { findMany: vi.fn(async ({ where }: any) => where.id.in.includes('old') ? [{ rootFolder: 'Old' }] : []) },
  chapter: { findMany: vi.fn(async () => [{ series: { rootFolder: 'Old' } }]) }
}
const rows = [{ rootFolder: 'New', createdAt: '2025-02-01' }, { rootFolder: 'Old', createdAt: '2025-01-01' }]
let root: string
let previousRoot: string | undefined

beforeEach(async () => {
  vi.clearAllMocks()
  previousRoot = process.env.DOWNLOAD_ROOT
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'series-activity-request-'))
  process.env.DOWNLOAD_ROOT = root
  startSeriesActivity(db as never, { emit: vi.fn(), on: vi.fn() } as never)
})
afterEach(async () => {
  await flushSeriesActivity()
  if (previousRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = previousRoot
  await fs.rm(root, { recursive: true, force: true })
})

async function request(url: string, body = {}, status = 200, method = 'POST') {
  const response = Object.assign(new EventEmitter(), { statusCode: status })
  const next = vi.fn()
  seriesActivityMiddleware(db as never)({ method, path: url, body } as never, response as never, next)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(next).toHaveBeenCalledOnce()
  response.emit('finish')
  await new Promise<void>(resolve => setImmediate(resolve))
  return (await withSeriesActivity(rows)).map(s => s.rootFolder)
}

describe('processing activity requests', () => {
  it('promotes successful chapter processing, including Editor 2.0 work that writes no files', async () => {
    expect(await request('/api/video2/chapters/chapter-1/process-timeline')).toEqual(['Old', 'New'])
  })

  it('promotes the series selected for a Sleeper-Cell run or chapter send', async () => {
    expect(await request('/api/r2/phone/automation', { seriesId: 'old' })).toEqual(['Old', 'New'])
    expect(db.series.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['old'] } } }))
    db.series.findMany.mockClear()
    await request('/api/r2/phone-send', { series: [{ seriesId: 'old', chapterIds: ['c'] }] })
    expect(db.series.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['old'] } } }))
  })

  it('keeps failed processing, read-only previews and GET requests from changing the order', async () => {
    expect(await request('/api/clipper3/chapters/crop/crop', {}, 500)).toEqual(['New', 'Old'])
    db.series.findMany.mockClear()
    db.chapter.findMany.mockClear()
    expect(await request('/api/narration/series/old/phone/preview')).toEqual(['New', 'Old'])
    expect(await request('/api/r2/phone/automation/plan', { seriesId: 'old' })).toEqual(['New', 'Old'])
    expect(await request('/api/series/old', {}, 200, 'GET')).toEqual(['New', 'Old'])
    expect(db.series.findMany).not.toHaveBeenCalled()
    expect(db.chapter.findMany).not.toHaveBeenCalled()
  })
})
