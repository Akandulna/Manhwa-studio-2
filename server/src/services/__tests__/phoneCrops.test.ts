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
const { getPhoneCrops, parseGeminiUsage, requestPhoneUpdate } = await import('../r2Service.js')

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
            'Chapter 010': {
              total: 20,
              done: 2,
              pages: { '001.jpg': 'done', '002.jpg': 'done', '007.jpg': 'in_progress', 'x.jpg': 'weird' },
              finished: {
                '001.jpg': { at: '2026-09-30T09:58:00Z', took: 192, run: 'auto', profile: 'chatgpt-2', account: 'Alt', models: ['gpt-5-thinking', 7] },
                '002.jpg': { at: '2026-09-30T09:59:00Z', took: -1, profile: null },
                '007.jpg': { at: '2026-09-30T10:00:00Z', took: 30 }
              }
            },
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
    // Only done pages; a bad time or a missing account reads as null.
    expect(status.finished).toEqual({
      '001.jpg': { at: '2026-09-30T09:58:00Z', took: 192, run: 'auto', profile: 'chatgpt-2', account: 'Alt', models: ['gpt-5-thinking'], phone: 'Pixel 8' },
      '002.jpg': { at: '2026-09-30T09:59:00Z', took: null, run: null, profile: null, account: null, models: [], phone: 'Pixel 8' }
    })
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

  it('lists every page Auto-run is on, across chapters, dropping stale ones', async () => {
    const now = new Date().toISOString()
    const stale = new Date(Date.now() - 60 * 60_000).toISOString()
    receipt = {
      series: {
        'Solo Hero': {
          total: 40,
          done: 3,
          working: { chapter: 'Chapter 009', page: '004.jpg', since: now, paused: true },
          workingPages: [
            { chapter: 'Chapter 009', page: '004.jpg', since: now, paused: true },
            { chapter: 'Chapter 010', page: '001.jpg', since: now, paused: true },
            { chapter: 'Chapter 010', page: '002.jpg', since: stale, paused: true },
            { chapter: 'Chapter 099', page: '001.jpg', since: now, paused: true }
          ],
          chapters: {}
        }
      }
    }
    const status = await read('s1')
    expect(status.workingPages).toEqual([
      { chapterId: 'c9', page: '004.jpg', since: now, paused: true, device: '', phone: 'Phone' },
      { chapterId: 'c10', page: '001.jpg', since: now, paused: true, device: '', phone: 'Phone' }
    ])
    expect(status.working).toMatchObject({ chapterId: 'c9', page: '004.jpg' })
    expect((await read()).workingPages).toEqual([])
  })

  it('falls back to the single working page from older phone builds', async () => {
    const since = new Date().toISOString()
    receipt = { series: { 'Solo Hero': { total: 1, done: 0, working: { chapter: 'Chapter 010', page: '007.jpg', since }, chapters: {} } } }
    expect((await read('s1')).workingPages).toEqual([{ chapterId: 'c10', page: '007.jpg', since, paused: false, device: '', phone: 'Phone' }])
    receipt = { series: { 'Solo Hero': { total: 1, done: 0, chapters: {} } } }
    expect((await read('s1')).workingPages).toEqual([])
  })

  it('drops a working page the phone never cleared', async () => {
    const since = new Date(Date.now() - 60 * 60_000).toISOString()
    receipt = { series: { 'Solo Hero': { total: 1, done: 0, working: { chapter: 'Chapter 009', page: '001.jpg', since }, chapters: {} } } }
    const status = await read('s1')
    expect(status.working).toBeNull()
    expect(status.workingPages).toEqual([])
  })

  it('is empty when the phone has not written a receipt', async () => {
    send.mockImplementationOnce(async () => { throw Object.assign(new Error('NotFound'), { name: 'NotFound' }) })
    receipt = {}
    const status = await read('s1', 'c9')
    expect(status).toMatchObject({ configured: true, series: {}, chapters: {}, pages: {}, working: null })
  })

  it('reads each phone profile\'s ChatGPT uploads and limits, dropping malformed parts', async () => {
    receipt = {
      series: {},
      profiles: [
        {
          id: 'Default', name: 'Main', selected: true, limitedUntil: null, trackingSince: '2026-10-01T08:00:00Z',
          counting: { since: '2026-10-01T09:00:00Z', images: 14 },
          uploads: [['2026-10-01T09:10:00Z', 6], ['2026-10-01T09:05:00Z', 8], ['nope', 3], ['2026-10-01T09:15:00Z', 0]],
          limits: [
            { at: '2026-10-01T09:00:00Z', until: '2026-10-01T12:00:00Z', used: 60, countedSince: '2026-10-01T08:00:00Z', complete: false, flagged: false, reason: 'You\'ve hit the upload limit' },
            { at: 'bad', until: '2026-10-01T12:00:00Z', used: 1 }
          ]
        },
        { id: 'profile-1', name: '', limitedUntil: '2026-10-01T13:00:00Z', counting: { images: 3 } },
        { name: 'no id' }
      ]
    }
    const { profiles } = await read()
    expect(profiles).toEqual([
      {
        id: 'Default', name: 'Main', selected: true, limitedUntil: null, trackingSince: '2026-10-01T08:00:00Z',
        counting: { since: '2026-10-01T09:00:00Z', images: 14 },
        uploads: [{ at: '2026-10-01T09:05:00Z', images: 8 }, { at: '2026-10-01T09:10:00Z', images: 6 }],
        limits: [{ at: '2026-10-01T09:00:00Z', until: '2026-10-01T12:00:00Z', used: 60, countedSince: '2026-10-01T08:00:00Z', complete: false, flagged: false, reason: 'You\'ve hit the upload limit' }],
        device: '', phone: 'Phone'
      },
      { id: 'profile-1', name: 'profile-1', selected: false, limitedUntil: '2026-10-01T13:00:00Z', trackingSince: null, counting: null, uploads: [], limits: [], device: '', phone: 'Phone' }
    ])

    // Older phone builds send no profiles.
    receipt = { series: {} }
    expect((await read()).profiles).toEqual([])
  })
})

describe('parseGeminiUsage', () => {
  it('reads each profile\'s Gemini requests and limit, dropping malformed parts', () => {
    expect(parseGeminiUsage({
      resetsAt: '2026-10-10T07:00:00Z',
      profiles: [
        { id: 'Default', name: 'Main', selected: true, today: 12, limit: 15, limitedUntil: null },
        { id: 'profile-1', name: '', today: 4.7, limit: null, limitedUntil: '2026-10-10T07:00:00Z' },
        { id: 'profile-2', today: -3, limit: 0, limitedUntil: 'soon' },
        { name: 'no id', today: 9 }
      ]
    })).toEqual({
      resetsAt: '2026-10-10T07:00:00Z',
      profiles: [
        { id: 'Default', name: 'Main', selected: true, today: 12, limit: 15, limitedUntil: null, device: null, phone: null },
        { id: 'profile-1', name: 'profile-1', selected: false, today: 4, limit: null, limitedUntil: '2026-10-10T07:00:00Z', device: null, phone: null },
        { id: 'profile-2', name: 'profile-2', selected: false, today: 0, limit: null, limitedUntil: null, device: null, phone: null }
      ]
    })
  })

  it('is null from phone builds before it was sent', () => {
    expect(parseGeminiUsage(undefined)).toBeNull()
    expect(parseGeminiUsage({ profiles: [] })).toBeNull()
  })
})
