import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { SeriesActivityStore } from '../seriesActivity.js'

let root: string
let value: string | null
let stores: SeriesActivityStore[]
const db = {
  setting: {
    findUnique: async () => value === null ? null : { value },
    upsert: vi.fn(async (args: any) => { value = args.update.value })
  }
} as unknown as PrismaClient
const makeStore = () => {
  const store = new SeriesActivityStore(db, () => root, vi.fn())
  stores.push(store)
  return store
}
const rows = [
  { id: 'new', rootFolder: 'New series', createdAt: '2025-02-01T00:00:00Z' },
  { id: 'old', rootFolder: 'Old series', createdAt: '2025-01-01T00:00:00Z' }
]
const ids = async (store: SeriesActivityStore) => (await store.order(rows)).map(s => s.id)

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'series-activity-'))
  value = null
  stores = []
  vi.clearAllMocks()
})
afterEach(async () => {
  for (const store of stores) await store.flush()
  await fs.rm(root, { recursive: true, force: true })
})

describe('shared series activity order', () => {
  it('moves an older series above a newly added series when any module processes it', async () => {
    const store = makeStore()
    expect(await ids(store)).toEqual(['new', 'old'])
    await store.touch('Old series', Date.parse('2025-03-01T00:00:00Z'))
    expect(await ids(store)).toEqual(['old', 'new'])
    await store.touch('New series', Date.parse('2025-04-01T00:00:00Z'))
    expect(await ids(store)).toEqual(['new', 'old'])
  })

  it('retains activity and phone baselines after a server restart', async () => {
    const store = makeStore()
    await store.phone('scripts', 'phone-1', { updatedAt: '2025-03-02T00:00:00Z', series: {
      'Old series': { chapters: { 'Chapter 001': { status: 'done', savedAt: '2025-03-01T00:00:00Z' } } }
    } })
    await store.flush()
    const restarted = makeStore()
    expect(await ids(restarted)).toEqual(['old', 'new'])
    await restarted.phone('scripts', 'phone-1', { updatedAt: '2025-05-01T00:00:00Z', answers: 'refresh', series: {
      'Old series': { chapters: { 'Chapter 001': { savedAt: '2025-03-01T00:00:00Z', status: 'done' } } }
    } })
    expect((await restarted.times())['Old series']).toBe('2025-03-01T00:00:00.000Z')
  })

  it('seeds existing processing artifacts and catches files changed while the server was closed', async () => {
    const dir = path.join(root, 'Old series', 'Chapter 001')
    await fs.mkdir(dir, { recursive: true })
    const script = path.join(dir, 'script.hi.md')
    await fs.writeFile(script, 'processed script')
    await fs.utimes(script, new Date('2025-03-01'), new Date('2025-03-01'))
    const store = makeStore()
    expect(await ids(store)).toEqual(['old', 'new'])
    await store.flush()
    await fs.utimes(script, new Date('2025-04-01'), new Date('2025-04-01'))
    const restarted = makeStore()
    await restarted.order(rows)
    expect((await restarted.times())['Old series']).toBe('2025-04-01T00:00:00.000Z')
  })

  it('tracks background crop/render file writes without promoting a directory or Finder metadata', async () => {
    const store = makeStore()
    const dir = path.join(root, 'Old series', '_video2_hi')
    await fs.mkdir(dir, { recursive: true })
    await store.file('Old series/_video2_hi')
    await fs.writeFile(path.join(root, 'Old series/.DS_Store'), 'metadata')
    await store.file('Old series/.DS_Store')
    expect(await ids(store)).toEqual(['new', 'old'])
    const video = path.join(dir, 'chapter.mp4')
    await fs.writeFile(video, 'rendered')
    await store.file('Old series/_video2_hi/chapter.mp4')
    expect(await ids(store)).toEqual(['old', 'new'])
  })

  it('promotes only the phone series whose work changes, across scripts, crops and process receipts', async () => {
    const store = makeStore()
    const initial = { updatedAt: '2025-03-01T00:00:00Z', series: {
      'Old series': { done: 0, total: 2 }, 'New series': { done: 0, total: 2 }
    } }
    await store.phone('crops', 'phone-1', initial)
    expect(await ids(store)).toEqual(['new', 'old'])
    await store.phone('crops', 'phone-1', { ...initial, updatedAt: '2025-03-02T00:00:00Z', series: {
      ...initial.series, 'Old series': { done: 1, total: 2 }
    } })
    expect(await ids(store)).toEqual(['old', 'new'])
    const process = { schema: 'device-process/1', updatedAt: '2025-03-03T00:00:00Z', series: [{ folder: 'New series', chapters: {} }] }
    await store.phone('process', 'phone-2', process)
    expect(await ids(store)).toEqual(['old', 'new'])
    await store.phone('process', 'phone-2', { ...process, updatedAt: '2025-03-04T00:00:00Z', series: [{ folder: 'New series', chapters: { 'Chapter 001': { stages: { voice_hi: { state: 'done' } } } } }] })
    expect(await ids(store)).toEqual(['new', 'old'])
  })

  it('ignores refreshed and out-of-order receipts without losing the newest watermark', async () => {
    const store = makeStore()
    const receipt = (at: string, done: number) => ({ updatedAt: at, series: { 'Old series': { done } } })
    await store.phone('crops', 'phone', receipt('2025-03-01T00:00:00Z', 0))
    await store.phone('crops', 'phone', receipt('2025-03-02T00:00:00Z', 1))
    await store.touch('New series', Date.parse('2025-03-03T00:00:00Z'))
    await store.phone('crops', 'phone', receipt('2025-03-05T00:00:00Z', 1))
    await store.phone('crops', 'phone', receipt('2025-03-04T00:00:00Z', 0))
    expect(await ids(store)).toEqual(['new', 'old'])
    expect((await store.times())['Old series']).toBe('2025-03-02T00:00:00.000Z')
  })

  it('uses a phone run timestamp immediately, even before its first script is saved', async () => {
    const store = makeStore()
    await store.phone('scripts', 'phone', { updatedAt: '2025-04-02T00:00:00Z', series: { 'Old series': { done: 0 } },
      runs: [{ kind: 'narration', series: 'Old series', since: '2025-04-01T00:00:00Z' }] })
    expect(await ids(store)).toEqual(['old', 'new'])
  })
})
