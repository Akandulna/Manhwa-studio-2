import { beforeEach, describe, expect, it, vi } from 'vitest'

// The receipt Sleeper-Cell's ClipperReceipt.kt writes, at the bucket root (the phone's prefix differs).
let receipt: object = {}
const send = vi.fn(async (command: { constructor: { name: string }; input: { Key: string } }) => {
  if (command.input.Key !== '_sleeper-cell-crops.json') throw Object.assign(new Error('NotFound'), { name: 'NotFound' })
  if (command.constructor.name === 'HeadObjectCommand') return { ETag: `"${JSON.stringify(receipt).length}-${Math.random()}"` }
  return { Body: { transformToString: async () => JSON.stringify(receipt) } }
})

vi.mock('@aws-sdk/client-s3', async importOriginal => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>()
  return { ...actual, S3Client: class { send = send } }
})
vi.mock('../r2Usage.js', () => ({ FREE_PLAN: {}, attachUsageCounter: () => {}, getMonthUsage: () => ({}), monthKey: () => '' }))
vi.mock('../../index.js', () => ({
  prisma: {
    series: { findMany: async () => [{ id: 's1', rootFolder: '/lib/Solo Hero' }, { id: 's2', rootFolder: '/lib/Other' }] },
    chapter: {
      findMany: async () => [
        { id: 'c9', folderPath: 'Solo Hero/Chapter 009' },
        { id: 'c10', folderPath: 'Solo Hero/Chapter 010' }
      ]
    }
  }
}))

Object.assign(process.env, { R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b', R2_PREFIX: 'Manhwa' })
const { getPhoneCrops } = await import('../r2Service.js')

/** Past the 2 s HEAD cache, so each call re-reads the receipt. */
async function read(seriesId?: string, chapterId?: string) {
  vi.setSystemTime(Date.now() + 3_000)
  return getPhoneCrops(seriesId, chapterId)
}

describe('getPhoneCrops', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))

  it('maps series, chapters, pages and the working page by folder and file name', async () => {
    receipt = {
      device: 'Pixel 8',
      updatedAt: '2026-09-30T10:00:00Z',
      series: {
        'Solo Hero': {
          total: 40,
          done: 12,
          working: { chapter: 'Chapter 010', page: '007.jpg', since: new Date().toISOString(), paused: false },
          chapters: {
            'Chapter 009': { total: 20, done: 10, pages: { '001.jpg': 'done', '011.jpg': 'changed' } },
            'Chapter 010': { total: 20, done: 2, pages: { '001.jpg': 'done', '002.jpg': 'done', '007.jpg': 'in_progress', 'x.jpg': 'weird' } },
            'Chapter 099': { total: 5, done: 5, pages: {} }
          }
        }
      }
    }
    const status = await read('s1', 'c10')
    expect(status.device).toBe('Pixel 8')
    expect(status.series).toEqual({ s1: { done: 12, total: 40 } })
    expect(status.chapters).toEqual({ c9: { done: 10, total: 20 }, c10: { done: 2, total: 20 } })
    expect(status.pages).toEqual({ '001.jpg': 'done', '002.jpg': 'done', '007.jpg': 'in_progress' })
    expect(status.working).toMatchObject({ chapterId: 'c10', page: '007.jpg', paused: false })

    // Without a series only the per-series totals come back.
    const summary = await read()
    expect(summary.chapters).toEqual({})
    expect(summary.working).toBeNull()
  })

  it('drops a working page the phone never cleared', async () => {
    const since = new Date(Date.now() - 60 * 60_000).toISOString()
    receipt = { series: { 'Solo Hero': { total: 1, done: 0, working: { chapter: 'Chapter 009', page: '001.jpg', since }, chapters: {} } } }
    expect((await read('s1')).working).toBeNull()
  })

  it('is empty when the phone has not written a receipt', async () => {
    send.mockImplementationOnce(async () => { throw Object.assign(new Error('NotFound'), { name: 'NotFound' }) })
    receipt = {}
    const status = await read('s1', 'c9')
    expect(status).toMatchObject({ configured: true, series: {}, chapters: {}, pages: {}, working: null })
  })
})
