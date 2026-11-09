import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// The phone's sync receipt (ManhwaSync.kt, version 2), served as if from the relay.
let receipt: object = {}
const libraryFlow = vi.hoisted(() => ({ origin: false, prepare: vi.fn() }))
vi.mock('../librarySync.js', () => ({ scheduleLibraryPublish: vi.fn(), isLibraryOrigin: async () => libraryFlow.origin }))
vi.mock('../libraryPreparation.js', () => ({ prepareLibrarySeries: libraryFlow.prepare }))

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
    chapter: { findMany: async () => chapters },
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
const uploadBodies: Buffer[] = []
let uploadError: Error | null = null
vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(private options: { params: { Key: string; Body: NodeJS.ReadableStream } }) {}
    on() {}
    async done() {
      if (uploadError) { this.options.params.Body.resume(); throw uploadError }
      const chunks: Buffer[] = []
      for await (const chunk of this.options.params.Body) chunks.push(chunk as Buffer)
      uploadBodies.push(Buffer.concat(chunks))
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
  phoneFolders: vi.fn(async () => ['']),
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
      // Published chapters can be explicitly selected for replacement, but aren't default picks.
      ['Chapter 005', 'new'],
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
    libraryFlow.origin = false
    libraryFlow.prepare.mockReset()
    config = { bucket: 'b', prefix: 'Manhwa/', concurrency: 2 }
    commands.length = 0
    uploads.length = 0
    uploadBodies.length = 0
    uploadError = null
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

  it('prepares only explicitly selected chapters before sending from the origin', async () => {
    libraryFlow.origin = true
    await startPhoneSend([{ seriesId: 's1', chapterIds: ['c2'] }], io)
    expect((await finished()).series[0]).toMatchObject({ state: 'done', chaptersSent: 1 })
    expect(libraryFlow.prepare).toHaveBeenCalledWith('s1', ['c2'])
  })

  it('does not publish raw pages when origin preparation fails', async () => {
    libraryFlow.origin = true
    libraryFlow.prepare.mockRejectedValueOnce(new Error('Preparation failed'))
    requestPhoneUpdate.mockClear()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await startPhoneSend([{ seriesId: 's1', chapterIds: ['c1'] }], io)
      const job = await finished()
      expect(job.series[0]).toMatchObject({ state: 'failed', error: 'Preparation failed' })
      expect(uploads).toHaveLength(0)
      expect(requestPhoneUpdate).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  })

  it('keeps shared-library ZIPs available when a local copy was cleared', async () => {
    settings.set('libraryOwner:s1', 'origin-phone')
    await startPhoneSend([{ seriesId: 's1', chapterIds: ['c1'] }], io)
    await finished()
    expect(commands.filter(c => c.name === 'DeleteObjectCommand')).toHaveLength(0)
  })

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

  it('keeps crops intact when replacement upload fails', async () => {
    uploadError = new Error('Upload failed')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await startPhoneSend([{ seriesId: 's1', chapterIds: ['c1'], resetClipping: true }], io)
      expect((await finished()).series[0]).toMatchObject({ state: 'failed', error: 'Upload failed' })
      expect(await fs.readFile(path.join(root, 'Demo/Chapter 001/crop_points3/page_001.json'), 'utf-8')).toBe('{}')
      await expect(fs.access(path.join(root, 'Demo/Chapter 001/.page-replacement.json'))).rejects.toThrow()
    } finally { log.mockRestore() }
  })

  it('replaces a completed chapter, resets clipping, versions the ZIP/index, and preserves scripts and audio', async () => {
    libraryFlow.origin = true
    bucket.push({ key: 'shared/crops/Demo/Chapter 001/page_001.page.json', size: 10 })
    const dir = path.join(root, 'Demo/Chapter 001')
    await fs.mkdir(path.join(dir, 'audio'), { recursive: true })
    await fs.writeFile(path.join(dir, 'audio/section.wav'), 'voiceover')
    await fs.writeFile(path.join(dir, 'script.hi.md'), 'Hinglish script')
    await startPhoneSend([{ seriesId: 's1', chapterIds: ['c1'], resetClipping: true }], io)
    expect((await finished()).series[0]).toMatchObject({ state: 'done', chaptersSent: 1 })
    expect(libraryFlow.prepare).not.toHaveBeenCalled()
    const { readZip } = await import('../../utils/zipReader.js')
    const entries = readZip(uploadBodies[0])
    const replacement = JSON.parse(entries.find(e => e.name.endsWith('/.page-replacement.json'))!.data.toString())
    expect(entries.filter(e => /page_\d+\.jpg$/.test(e.name))).toHaveLength(2)
    const index = JSON.parse(commands.find(c => c.name === 'PutObjectCommand' && c.Key === 'manhwa/Demo/index.json')!.Body!)
    expect(index.chapters[0]).toMatchObject({ pageRevision: replacement.revision, crops: false, script: true, done: false })
    expect(await fs.readFile(path.join(dir, 'script.md'), 'utf-8')).toBe('not a page')
    expect(await fs.readFile(path.join(dir, 'script.hi.md'), 'utf-8')).toBe('Hinglish script')
    expect(await fs.readFile(path.join(dir, 'audio/section.wav'), 'utf-8')).toBe('voiceover')
    expect(commands.filter(c => c.name === 'DeleteObjectCommand').map(c => c.Key)).toEqual(expect.arrayContaining([
      'crops/Demo/Chapter 001.zip', 'crops/Demo/Chapter 001.cropped.json', 'shared/crops/Demo/Chapter 001/page_001.page.json'
    ]))
    expect(await fs.readFile(path.join(dir, '.page-replacements', replacement.revision, 'points/page_001.json'), 'utf-8')).toBe('{}')
  })

  it('keeps a replaced published chapter out of the phone’s done list until its crops are regenerated', async () => {
    await startPhoneSend([{ seriesId: 's1', chapterIds: ['c5'], resetClipping: true }], io)
    expect((await finished()).series[0].state).toBe('done')
    const index = JSON.parse(commands.find(c => c.name === 'PutObjectCommand' && c.Key === 'manhwa/Demo/index.json')!.Body!)
    expect(index.chapters.find((c: { name: string }) => c.name === 'Chapter 005')).toMatchObject({ published: true, crops: false, done: false })
  })
})
