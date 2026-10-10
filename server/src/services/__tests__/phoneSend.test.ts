import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// The phone's sync receipt (ManhwaSync.kt, version 2), served as if from the relay.
let receipt: object = {}

interface Row {
  chapterId: string
  seriesId: string
  key: string | null
  etag: string | null
  fingerprint: string | null
  files: number
  bytes: number
  sentAt: Date | null
  clearedAt: Date | null
}
let ledger: Row[] = []
const settings = new Map<string, string>()

const chapters = [1, 2, 3, 4, 5, 6].map(n => ({ id: `c${n}`, number: n, folderPath: `Demo/Chapter 00${n}` }))

vi.mock('../../index.js', () => ({
  prisma: {
    series: { findMany: async () => [{ id: 's1', title: 'Demo', rootFolder: '/library/Demo', chapters }] },
    phoneChapterSend: {
      findMany: async ({ where }: { where?: { seriesId?: string } } = {}) =>
        ledger.filter(r => !where?.seriesId || r.seriesId === where.seriesId).map(r => ({ ...r })),
      update: async ({ where, data }: { where: { chapterId: string }; data: Partial<Row> }) => {
        const row = ledger.find(r => r.chapterId === where.chapterId)!
        Object.assign(row, data)
        return { ...row }
      },
      create: async ({ data }: { data: Partial<Row> & { chapterId: string; seriesId: string } }) => {
        const row: Row = { key: null, etag: null, fingerprint: null, files: 0, bytes: 0, sentAt: null, clearedAt: null, ...data }
        ledger.push(row)
        return { ...row }
      },
      upsert: async ({ where, create, update }: { where: { chapterId: string }; create: Row; update: Partial<Row> }) => {
        const row = ledger.find(r => r.chapterId === where.chapterId)
        if (row) Object.assign(row, update)
        else ledger.push({ ...create })
        return { ...ledger.find(r => r.chapterId === where.chapterId)! }
      }
    },
    setting: {
      findMany: async () => [...settings].map(([key, value]) => ({ key, value })),
      findUnique: async ({ where }: { where: { key: string } }) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null),
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        settings.set(where.key, create.value)
        return { key: where.key, value: create.value }
      }
    },
    chapterScript: {
      findMany: async ({ where }: { where: { language: string } }) =>
        where.language === 'hi' ? [{ chapterId: 'c3' }] : [{ chapterId: 'c1' }]
    }
  }
}))
vi.mock('../storageService.js', () => ({
  getPublishedChapters: async () => ({ chapters: { c5: true }, series: {}, scannedAt: '' })
}))
vi.mock('../phoneRelay.js', () => ({
  relayReceipts: () => [{ device: '', at: 0, body: receipt }],
  relayConfigured: () => true,
  phoneName: () => 'Phone'
}))

// R2: what was sent, and what is in the bucket before the send.
let config: object | null = null
const commands: { name: string; Key: string; Body?: string }[] = []
let bucket: { key: string; size: number }[] = []
const uploads: { Key: string; entries: number }[] = []
vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(private options: { params: { Key: string; Body: NodeJS.ReadableStream } }) {}
    on() {}
    async done() {
      const chunks: Buffer[] = []
      for await (const chunk of this.options.params.Body) chunks.push(chunk as Buffer)
      uploads.push({ Key: this.options.params.Key, entries: Buffer.concat(chunks).toString('latin1').split('PK\x03\x04').length - 1 })
      return { ETag: `"etag-${uploads.length}"` }
    }
    async abort() {}
  }
}))
const requestPhoneUpdate = vi.fn(async () => ({ id: 'r1', requestedAt: '', via: 'relay', phones: 1 }))
vi.mock('../r2Service.js', () => ({
  PART_SIZE: 16 * 1024 * 1024,
  getR2Config: () => config,
  missingR2Env: () => [],
  createClient: () => ({
    send: async (command: { constructor: { name: string }; input: { Key: string; Body?: string } }) => {
      commands.push({ name: command.constructor.name, Key: command.input.Key, Body: command.input.Body })
      return {}
    }
  }),
  readPolledReceipt: vi.fn(),
  phoneFolders: vi.fn(),
  requestPhoneUpdate,
  setUploadBusy: vi.fn(),
  assertWithinFreePlan: async () => ({ bytes: 0, objects: bucket, measuredAt: '' }),
  measureBucket: async () => ({ bytes: 0, objects: bucket, measuredAt: '' }),
  invalidateStorage: vi.fn()
}))

let root: string
const { chapterFingerprint, chapterPages, chapterKey, getSendPlan, getPhoneSync, startPhoneSend, getSendJob } = await import('../phoneSend.js')

async function writePages(chapter: string, sizes: number[]) {
  const dir = path.join(root, 'Demo', chapter)
  await fs.mkdir(dir, { recursive: true })
  for (const [i, size] of sizes.entries()) {
    await fs.writeFile(path.join(dir, `page_${String(i + 1).padStart(3, '0')}.jpg`), Buffer.alloc(size))
  }
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-send-'))
  process.env.DOWNLOAD_ROOT = root
  for (const n of [1, 2, 3, 4, 5]) await writePages(`Chapter 00${n}`, [100, 200])
  // Chapter 001 is cropped on the desktop: pointers and metadata for both pages.
  for (const dir of ['crop_points3', 'crop_metadata3']) {
    await fs.mkdir(path.join(root, 'Demo/Chapter 001', dir), { recursive: true })
    for (const stem of ['page_001', 'page_002']) {
      await fs.writeFile(path.join(root, 'Demo/Chapter 001', dir, `${stem}.${dir === 'crop_points3' ? 'json' : 'txt'}`), '{}')
    }
  }
  // Chapter 006 has no pages on disk any more.
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('chapterFingerprint', () => {
  it('matches the vector the phone checks (SeriesIndexTest.kt)', () => {
    const pages = [{ name: 'page_002.webp', size: 200 }, { name: 'page_001.jpg', size: 100 }, { name: 'Page_10.jpg', size: 300 }]
    expect(chapterFingerprint(pages)).toBe('3aafab94a47b9f3705f2e89782b4d75c1d159c2ee0ee6daffac71c3ad2ab886f')
  })

  it('is null without pages', () => {
    expect(chapterFingerprint([])).toBeNull()
  })
})

describe('chapterPages', () => {
  it('lists only the images directly in the chapter folder', async () => {
    await fs.writeFile(path.join(root, 'Demo/Chapter 001/script.md'), 'not a page')
    const pages = await chapterPages('Demo/Chapter 001')
    expect(pages.map(p => [p.name, p.size])).toEqual([['page_001.jpg', 100], ['page_002.jpg', 200]])
  })

  it('is empty for a folder that is gone', async () => {
    expect(await chapterPages('Demo/Chapter 404')).toEqual([])
  })
})

describe('chapterKey', () => {
  it('puts each chapter under its series in the phone folder', () => {
    expect(chapterKey('manhwa/', 'Demo', 'Chapter 001')).toBe('manhwa/Demo/Chapter 001.zip')
  })
})

describe('getSendPlan', () => {
  const sentAt = new Date('2026-10-01T10:00:00.000Z')

  beforeEach(async () => {
    settings.clear()
    const fingerprint = chapterFingerprint((await chapterPages('Demo/Chapter 001')).map(({ name, size }) => ({ name, size })))
    const sent = (chapterId: string, extra: Partial<Row> = {}): Row => ({
      chapterId, seriesId: 's1', key: `manhwa/Demo/${chapterId}.zip`, etag: 'e', fingerprint, files: 2, bytes: 300, sentAt, clearedAt: null, ...extra
    })
    ledger = [
      sent('c1'),
      sent('c2', { fingerprint: 'pages-before-stitching' }),
      sent('c4')
    ]
    receipt = {
      version: 2,
      prefix: '',
      series: {
        Demo: {
          chapters: { 'Chapter 001': { state: 'downloaded', etag: 'e', sentAt: sentAt.toISOString(), at: '2026-10-01T10:05:00.000Z' } },
          cleared: {
            'Chapter 004': { at: '2026-10-01T12:00:00.000Z', sentAt: sentAt.toISOString() },
            // Cleared from a whole-series copy before chapters were sent one by one.
            'Chapter 006': { at: '2026-09-30T12:00:00.000Z', sentAt: '' }
          }
        }
      }
    }
  })

  it('tells new, changed, on-phone and cleared chapters apart', async () => {
    const plan = await getSendPlan()
    const series = plan.series[0]
    expect(series.chapters.map(c => [c.folder, c.state])).toEqual([
      ['Chapter 001', 'on_phone'],
      ['Chapter 002', 'changed'],
      ['Chapter 003', 'new'],
      ['Chapter 004', 'cleared'],
      // Chapter 005 is published and was never sent, so it isn't offered.
      ['Chapter 006', 'cleared']
    ])
    expect([series.toSend, series.onPhone, series.waiting, series.cleared]).toEqual([2, 1, 0, 2])
    expect(series.chapters[0].phoneAt).toBe('2026-10-01T10:05:00.000Z')
  })

  it('leaves out of the default pick what is done here already', async () => {
    ledger = ledger.filter(r => r.chapterId !== 'c1')
    const series = (await getSendPlan()).series[0]
    expect(series.chapters.find(c => c.folder === 'Chapter 001')).toMatchObject({ state: 'new', desktop: { done: true } })
    expect(series.toSend).toBe(2) // Chapter 002 (changed) and 003 (new), not 001
  })

  it('records clears so they are never sent as new', async () => {
    await getSendPlan()
    expect(ledger.find(r => r.chapterId === 'c4')?.clearedAt?.toISOString()).toBe('2026-10-01T12:00:00.000Z')
    expect(ledger.find(r => r.chapterId === 'c6')).toMatchObject({ sentAt: null, key: null })
  })

  it('ignores a clear from before the chapter was sent again', async () => {
    ledger.find(r => r.chapterId === 'c4')!.sentAt = new Date('2026-10-01T13:00:00.000Z')
    const plan = await getSendPlan()
    expect(plan.series[0].chapters.find(c => c.folder === 'Chapter 004')?.state).toBe('sent')
  })

  it('marks done what is published or has crops and script', async () => {
    const plan = await getSendPlan()
    const done = Object.fromEntries(plan.series[0].chapters.map(c => [c.folder, c.desktop.done]))
    expect(done).toMatchObject({ 'Chapter 001': true, 'Chapter 002': false, 'Chapter 003': false })
  })

  it('says the phone index is behind until it is written', async () => {
    const plan = await getSendPlan()
    expect(plan.series[0].indexStale).toBe(true)
  })
})

describe('getPhoneSync', () => {
  it('counts what the phone has of the chapters sent', async () => {
    const status = await getPhoneSync()
    expect(status.series.s1).toMatchObject({ sent: 2, onPhone: 1, cleared: 2, state: 'outdated' })
  })
})

describe('startPhoneSend', () => {
  const io = { emit: vi.fn() } as unknown as import('socket.io').Server

  beforeEach(() => {
    config = { bucket: 'b', prefix: 'Manhwa/', concurrency: 2 }
    commands.length = 0
    uploads.length = 0
    settings.clear()
    ledger = [{
      chapterId: 'c4', seriesId: 's1', key: 'manhwa/Demo/Chapter 004.zip', etag: 'e', fingerprint: 'f', files: 2, bytes: 300,
      sentAt: new Date('2026-10-01T10:00:00.000Z'), clearedAt: null
    }]
    // The phone reports its own prefix (the bucket root here) and that it cleared Chapter 004.
    receipt = { version: 2, prefix: '', series: { Demo: { chapters: {}, cleared: { 'Chapter 004': { at: '2026-10-01T12:00:00.000Z' } } } } }
    bucket = [
      { key: 'Demo.zip', size: 1000 }, // whole-series zip from before
      { key: 'manhwa/Demo/Chapter 004.zip', size: 300 }
    ]
  })

  async function finished() {
    for (let i = 0; i < 200 && getSendJob()?.state === 'running'; i++) await new Promise(r => setTimeout(r, 10))
    return getSendJob()!
  }

  it('sends each picked chapter as its own zip where the phone looks, then the index, and wakes the phone', async () => {
    await startPhoneSend([{ seriesId: 's1', chapterIds: ['c1', 'c3'] }], io)
    const job = await finished()

    expect(job.series[0]).toMatchObject({ state: 'done', chaptersTotal: 2, chaptersSent: 2, folder: 'manhwa/Demo/' })
    // Two pages per chapter, nothing else from the folder.
    expect(uploads).toEqual([
      { Key: 'manhwa/Demo/Chapter 001.zip', entries: 2 },
      { Key: 'manhwa/Demo/Chapter 003.zip', entries: 2 }
    ])
    expect(ledger.find(r => r.chapterId === 'c1')).toMatchObject({ key: 'manhwa/Demo/Chapter 001.zip', etag: 'etag-1', files: 2, bytes: 300 })

    // The cleared chapter's zip and the old whole-series zip are deleted.
    const deleted = commands.filter(c => c.name === 'DeleteObjectCommand').map(c => c.Key)
    expect(deleted).toEqual(expect.arrayContaining(['manhwa/Demo/Chapter 004.zip', 'Demo.zip']))
    expect(ledger.find(r => r.chapterId === 'c4')).toMatchObject({ key: null })

    const index = commands.find(c => c.name === 'PutObjectCommand' && c.Key === 'manhwa/Demo/index.json')
    const body = JSON.parse(index!.Body!)
    // Every chapter, so the phone can tell what's done of chapters it got some other way; only sent ones have a key.
    expect(body.chapters.map((c: { name: string; key: string | null; cleared: boolean; done: boolean }) => [c.name, c.key, c.cleared, c.done])).toEqual([
      ['Chapter 001', 'manhwa/Demo/Chapter 001.zip', false, true],
      ['Chapter 002', null, false, false],
      ['Chapter 003', 'manhwa/Demo/Chapter 003.zip', false, false],
      ['Chapter 004', null, true, false],
      ['Chapter 005', null, false, true],
      ['Chapter 006', null, false, false]
    ])
    // Each entry says which scripts the desktop has; done still needs only the English one.
    expect(body.chapters.slice(0, 3).map((c: { script: boolean; scriptHi: boolean }) => [c.script, c.scriptHi])).toEqual([
      [true, false],
      [false, false],
      [false, true]
    ])
    expect(body.schema).toBe('manhwa-studio-phone-index/1')
    expect(requestPhoneUpdate).toHaveBeenCalledWith('sync')
    expect(job.phone).toMatchObject({ via: 'relay' })
  })

  it('sends nothing for a series without new chapters, but still updates the index', async () => {
    ledger.push(...['c1', 'c2', 'c3'].map(chapterId => ({
      chapterId, seriesId: 's1', key: `manhwa/Demo/${chapterId}.zip`, etag: 'e', files: 2, bytes: 300, clearedAt: null,
      fingerprint: 'stale', sentAt: new Date('2026-10-01T10:00:00.000Z')
    })))
    for (const row of ledger) if (row.chapterId !== 'c4') row.fingerprint = chapterFingerprint([{ name: 'page_001.jpg', size: 100 }, { name: 'page_002.jpg', size: 200 }])
    requestPhoneUpdate.mockClear()
    await startPhoneSend([{ seriesId: 's1' }], io)
    const job = await finished()
    expect(job.series[0]).toMatchObject({ state: 'skipped', chaptersTotal: 0 })
    expect(uploads).toEqual([])
    expect(commands.some(c => c.Key === 'manhwa/Demo/index.json')).toBe(true)
    expect(requestPhoneUpdate).not.toHaveBeenCalled()
  })
})
