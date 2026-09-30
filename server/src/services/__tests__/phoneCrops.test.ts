import { beforeEach, describe, expect, it, vi } from 'vitest'

// The receipt Sleeper-Cell's ClipperReceipt.kt writes, at the bucket root (the phone's prefix differs).
let receipt: object = {}
const puts: { Key: string; Body: string }[] = []
const send = vi.fn(async (command: { constructor: { name: string }; input: { Key: string; Body?: string } }) => {
  if (command.constructor.name === 'PutObjectCommand') return void puts.push({ Key: command.input.Key, Body: command.input.Body! })
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
const { getPhoneCrops, requestPhoneUpdate } = await import('../r2Service.js')

/** A "Refresh from phone" read, which goes to R2. */
const read = (seriesId?: string, chapterId?: string) => getPhoneCrops(seriesId, chapterId, true)

describe('getPhoneCrops', () => {
  beforeEach(() => { send.mockClear() })

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

  it('answers from the cached copy without touching R2 unless fresh', async () => {
    receipt = { answers: 'req-1', series: { 'Solo Hero': { total: 3, done: 1, chapters: {} } } }
    expect((await read('s1')).answers).toBe('req-1')
    send.mockClear()
    receipt = { answers: 'req-2', series: {} }
    const cached = await getPhoneCrops('s1')
    expect(send).not.toHaveBeenCalled()
    expect(cached.answers).toBe('req-1')
    expect((await read('s1')).answers).toBe('req-2')
  })

  it('puts the update request in the folder the phone writes its receipts to', async () => {
    receipt = { series: {} }
    await read()
    puts.length = 0
    const request = await requestPhoneUpdate()
    // The receipt was found at the bucket root, not under R2_PREFIX, so only the root gets the request.
    expect(puts.map(p => p.Key)).toEqual(['_sleeper-cell-request.json'])
    expect(request.via).toBe('r2')
    expect(JSON.parse(puts[0].Body)).toEqual({ id: request.id, requestedAt: request.requestedAt })
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
