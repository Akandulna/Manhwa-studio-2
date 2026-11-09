import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  buildSharedPage, chapterToken, ConditionFailed, phoneHandoff, phoneStem, pointerFromSharedPage, processedNames, sharedPageKey,
  type ExchangeTransport, type SharedPageInput, type WriteCondition
} from '../publication.js'
import { stringify } from '../review/json.js'

const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex')

/** In-memory bucket with If-Match / If-None-Match semantics and an operation log. */
function memoryBucket(root = 'Manhwa/') {
  const objects = new Map<string, { body: Buffer; etag: string }>()
  const log: string[] = []
  const t: ExchangeTransport & { objects: typeof objects; log: string[]; seed(key: string, value: unknown): void } = {
    bucket: 'b', root, objects, log,
    seed(key, value) { const body = Buffer.from(JSON.stringify(value)); objects.set(key, { body, etag: sha(body).slice(0, 16) }) },
    async get(key) { log.push(`GET ${key}`); const o = objects.get(key); return o ? { body: Buffer.from(o.body), etag: o.etag } : null },
    async put(key: string, body: Buffer, condition: WriteCondition) {
      log.push(`PUT ${key} ${'ifMatch' in condition ? 'if-match' : 'if-none-match'}`)
      const existing = objects.get(key)
      if ('ifNoneMatch' in condition && existing) throw new ConditionFailed(key)
      if ('ifMatch' in condition && existing?.etag !== condition.ifMatch) throw new ConditionFailed(key)
      const etag = sha(body).slice(0, 16)
      objects.set(key, { body: Buffer.from(body), etag })
      return etag
    },
    async list(prefix) { log.push(`LIST ${prefix}`); return [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, etag: o.etag })) },
    close() {}
  }
  return t
}

describe('phone naming (PageExport / HandoffFormat / PhoneShare)', () => {
  it('matches the phone names for page folders, pointer files and keys', () => {
    expect(processedNames('21', 'page_004')).toEqual({ pageFolder: 'page_004', pointers: 'crop-pointers-ch021-p004.json' })
    expect(processedNames('10.5', 'ch10_12')).toEqual({ pageFolder: 'page_012', pointers: 'crop-pointers-ch010.5-p012.json' })
    expect(processedNames('3', 'cover')).toEqual({ pageFolder: 'cover', pointers: 'crop-pointers-ch003-pcover.json' })
    expect(chapterToken('7')).toBe('007')
    expect(phoneStem('page.004.jpg')).toBe('page.004')
    expect(sharedPageKey('Manhwa/', 'SSS Class', 'Chapter 021', 'page_004.jpg')).toBe('Manhwa/shared/crops/SSS Class/Chapter 021/page_004.page.json')
    expect(() => sharedPageKey('', '.hidden', 'c', 'p.jpg')).toThrow(/safe/)
  })

  it('signs the handoff the way HandoffFormat.checksum verifies it', () => {
    const { text, manifestSha256 } = phoneHandoff({
      jobId: 'j', createdAt: '2026-11-07T00:00:00.000Z', seriesTitle: 'Série «X»', chapterFolder: 'Chapter 001', chapterNumber: 1, stem: 'page_001',
      filename: 'page_001.jpg', sha256: 'a'.repeat(64), width: 800, height: 2100, format: 'jpeg', sliceHeight: 2000,
      slices: [{ id: 's01', file: 's01.webp', x0: 0, y0: 0, x1: 800, y1: 2000, width: 800, height: 2000, sha256: 'b'.repeat(64) }, { id: 's02', file: 's02.webp', x0: 0, y0: 2000, x1: 800, y1: 2100, width: 800, height: 100, sha256: 'c'.repeat(64) }]
    })
    const parsed = JSON.parse(text)
    expect(parsed.manifest_sha256).toBe(manifestSha256)
    const { manifest_sha256: _drop, ...unsigned } = parsed
    expect(sha(stringify(unsigned))).toBe(manifestSha256)
    expect(Object.keys(parsed)).toEqual(['schema_version', 'job_id', 'created_at', 'source', 'coordinate_system', 'slicing', 'slices', 'verification', 'manifest_sha256'])
    expect(parsed.source.series_slug).toBe('s_rie_x')
  })
})

const pageInput = (over: Partial<SharedPageInput> = {}): SharedPageInput => ({
  seriesFolder: 'Series A', seriesTitle: 'Series A', chapterFolder: 'Chapter 001', chapterNumber: 1, filename: 'page_001.png',
  sourceSha256: 'a'.repeat(64), sourceBytes: 1234, width: 100, height: 200, format: 'png', restartRevision: null, pageRevision: null,
  exportedAt: '2026-11-07T01:00:00.000Z', studioDeviceId: 'mac-test', handoffCreatedAt: '2026-11-07T00:00:00.000Z', sliceHeight: 2000,
  slices: [{ id: 's01', file: 's01.webp', x0: 0, y0: 0, x1: 100, y1: 200, width: 100, height: 200, sha256: 'b'.repeat(64) }],
  pointerText: '{"format":"four-point-crop"}\n', reviewStateJson: '{"revision":1}', reviewRevision: 1, cropCount: 1, requestedModel: 'claude-sonnet-5-5-medium',
  promptText: 'prompt', provenance: { approval: 'candidate_only' }, ...over
})

describe('shared page bundle (SharedCrops.bundle / PageSections.status)', () => {
  it('carries everything that makes the page done on a phone', () => {
    const { text, pointerSha256 } = buildSharedPage(pageInput())
    const bundle = JSON.parse(text)
    expect(bundle).toMatchObject({ schema: 'sleeper-cell-shared-page/1', series: 'Series A', chapter: 'Chapter 001', page: 'page_001.png', stem: 'page_001', sourceBytes: 1234, deviceId: 'mac-test' })
    expect(Object.keys(bundle.working)).toEqual([...Object.keys(bundle.working)].sort())
    const report = JSON.parse(bundle.working['export-report.json'])
    expect(report).toMatchObject({ stage: 'geometry', origin: 'antigravity', destination: 'Series A/Chapter 001/page_001', files: ['crop-pointers-ch001-p001.json'], pointer_sha256: pointerSha256, source_sha256: 'a'.repeat(64) })
    expect(bundle.output).toEqual({ folder: 'page_001', files: { 'crop-pointers-ch001-p001.json': '{"format":"four-point-crop"}\n' } })
    expect(JSON.parse(bundle.working['source-manifest.json'])).toEqual({ page: { bytes: 1234, sha256: 'a'.repeat(64) } })
    expect(JSON.parse(bundle.working['chatgpt-handoff.json']).source.sha256).toBe('a'.repeat(64))
    expect(text).not.toMatch(/\/Users\/|token|secret/i)
  })

  it('reads the pointer back out of a phone page and refuses mismatches', () => {
    const bundle = JSON.parse(buildSharedPage(pageInput()).text)
    expect(pointerFromSharedPage(bundle, { series: 'Series A', chapter: 'Chapter 001', filename: 'page_001.png' })).toMatchObject({ ok: true, deviceId: 'mac-test' })
    expect(pointerFromSharedPage(bundle, { series: 'Series A', chapter: 'Chapter 002', filename: 'page_001.png' })).toMatchObject({ ok: false })
    const tampered = { ...bundle, output: { ...bundle.output, files: { 'crop-pointers-ch001-p001.json': '{}' } } }
    expect(pointerFromSharedPage(tampered, { series: 'Series A', chapter: 'Chapter 001', filename: 'page_001.png' })).toMatchObject({ ok: false, reason: 'pointer hash mismatch' })
  })
})

// ─── Publisher and collector against a temp library ───

describe('publish to and fetch from the phones\' shared folder (AG-14, AG-15 Studio side)', () => {
  const tmp = { dir: '' }
  const previousRoot = process.env.DOWNLOAD_ROOT
  let publication: typeof import('../publication.js')
  let delivery: typeof import('../delivery.js')
  let store: typeof import('../../clipper3/perImageStore.js')
  let review: typeof import('../../clipper3/chapterReview.js')
  const folder = 'Series A/Chapter 001'
  const key = 'Manhwa/shared/crops/Series A/Chapter 001/page_001.page.json'
  let sourceSha = ''
  let sourceBytes = 0
  let pointerText = ''
  let revisions = { restart: null as string | null, pending: false, page: null as string | null }
  let seen: Record<string, Record<string, string>> = {}

  function fakePrisma(result = pointerText) {
    const deliveries: any[] = []
    const job = () => ({
      id: 'job-1', runId: 'run-1', seriesId: 'ser-1', chapterId: 'chap-1', filename: 'page_001.png', pageIndex: 0, sourceSha256: sourceSha,
      width: 100, height: 200, resultJson: result, resultSha256: sha(result), importState: 'imported', currentAttemptId: 'att-1', createdAt: new Date('2026-11-07T01:00:00Z'),
      manifestJson: JSON.stringify({ createdAt: '2026-11-07T00:59:00.000Z', source: { format: 'png' }, slicing: { sliceHeight: 2000, slices: [{ id: 's01', file: 's01.webp', x0: 0, y0: 0, x1: 100, y1: 200, width: 100, height: 200, sha256: 'b'.repeat(64) }] } })
    })
    return {
      deliveries,
      antigravityPageJob: { findUniqueOrThrow: async () => job() },
      antigravityAttempt: { findUniqueOrThrow: async () => ({ id: 'att-1', conversationId: 'conv', cliVersion: '1.5.2', requestedModel: 'claude-sonnet-5-5-medium', observedModel: 'unknown', analysisSha256: 'f'.repeat(64), reviewStateJson: '{"revision":1}', reviewRounds: 1 }) },
      antigravityRun: { findUniqueOrThrow: async () => ({ id: 'run-1', effort: null, promptJson: '{"ids":{},"hashes":{}}' }) },
      series: { findUniqueOrThrow: async () => ({ id: 'ser-1', rootFolder: 'Series A' }) },
      chapter: {
        findUniqueOrThrow: async () => ({ id: 'chap-1', number: 1, folderPath: folder, series: { id: 'ser-1', title: 'Series A', rootFolder: 'Series A' } }),
        findMany: async () => [{ id: 'chap-1', folderPath: folder }]
      },
      antigravityDelivery: {
        upsert: async ({ where, create }: any) => {
          const k = where.resultSha256_destination
          let row = deliveries.find(d => d.resultSha256 === k.resultSha256 && d.destination === k.destination)
          if (row) { row.tries += 1; return { ...row } }
          row = { id: `del-${deliveries.length + 1}`, publishedAt: null, error: null, createdAt: new Date('2026-11-07T01:03:00Z'), ...create }
          deliveries.push(row)
          return { ...row }
        },
        update: async ({ where, data }: any) => { const row = deliveries.find(d => d.id === where.id); Object.assign(row, data); return { ...row } }
      }
    } as any
  }

  const publisherFor = (t: ExchangeTransport, prisma = fakePrisma()) => ({
    prisma,
    publisher: new publication.AntigravityPublisher({
      prisma, open: async () => t, installationId: async () => 'mac-test',
      revisions: { restart: async () => ({ revision: revisions.restart, pending: revisions.pending }), pageRevision: async () => revisions.page },
      seen: { read: async id => ({ ...(seen[id] ?? {}) }), write: async (id, map) => { seen[id] = map } }
    })
  })

  beforeAll(async () => {
    tmp.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-publish-'))
    process.env.DOWNLOAD_ROOT = path.join(tmp.dir, 'library')
    publication = await import('../publication.js')
    delivery = await import('../delivery.js')
    store = await import('../../clipper3/perImageStore.js')
    review = await import('../../clipper3/chapterReview.js')
    const dir = store.getSourceFolderPath(folder)
    await fs.mkdir(dir, { recursive: true })
    const bytes = await sharp({ create: { width: 100, height: 200, channels: 3, background: '#ffffff' } }).png().toBuffer()
    await fs.writeFile(path.join(dir, 'page_001.png'), bytes)
    sourceSha = sha(bytes)
    sourceBytes = bytes.length
    pointerText = delivery.buildPointerFile([{ reason: 'illustrated_shot', bounds: { x0: 0, y0: 10, x1: 100, y1: 150 } }], { filename: 'page_001.png', width: 100, height: 200, sourceSha256: sourceSha }).text
  })
  beforeEach(async () => {
    revisions = { restart: null, pending: false, page: null }
    seen = {}
    await fs.rm(path.join(store.getSourceFolderPath(folder), 'crop_points3'), { recursive: true, force: true })
    await fs.rm(path.join(store.getSourceFolderPath(folder), '.studio-page-redo'), { recursive: true, force: true })
    await delivery.importPointerFile({ folderPath: folder, filename: 'page_001.png', pointer: JSON.parse(pointerText), preexisting: 'none' })
  })
  afterAll(async () => { process.env.DOWNLOAD_ROOT = previousRoot; await fs.rm(tmp.dir, { recursive: true, force: true }) })

  it('publishes one shared page with If-None-Match, reads it back, and a repeat is a no-op', async () => {
    const t = memoryBucket()
    const { publisher, prisma } = publisherFor(t)
    expect(await publisher.publish('job-1')).toMatchObject({ state: 'published', key })
    expect(t.log.filter(l => l.startsWith('PUT'))).toEqual([`PUT ${key} if-none-match`])
    const bundle = JSON.parse(t.objects.get(key)!.body.toString())
    expect(bundle.sourceBytes).toBe(sourceBytes)
    expect(bundle.output.files['crop-pointers-ch001-p001.json']).toBe(pointerText)
    expect(prisma.deliveries[0]).toMatchObject({ state: 'published', pointerKey: key })
    t.log.length = 0
    await publisher.publish('job-1')
    expect(t.log.some(l => l.startsWith('PUT'))).toBe(false)
    expect(prisma.deliveries[0].tries).toBe(2)
  })

  it('never overwrites a page a phone already shared', async () => {
    const t = memoryBucket()
    t.seed(key, { schema: 'sleeper-cell-shared-page/1', device: 'Honor 7X', deviceId: 'phone-1' })
    const { publisher, prisma } = publisherFor(t)
    expect(await publisher.publish('job-1')).toMatchObject({ state: 'phone_has_page', device: 'Honor 7X' })
    expect(JSON.parse(t.objects.get(key)!.body.toString()).deviceId).toBe('phone-1')
    expect(prisma.deliveries[0].state).toBe('phone_has_page')
  })

  it('refuses while a series restart is synchronizing and carries the desktop revisions', async () => {
    const t = memoryBucket()
    revisions = { restart: '2026-11-01T00:00:00Z-mac', pending: true, page: null }
    await expect(publisherFor(t).publisher.publish('job-1')).rejects.toThrow(/restart/)
    revisions = { restart: '2026-11-01T00:00:00Z-mac', pending: false, page: '0f0f0f0f-0000-4000-8000-000000000000' }
    await publisherFor(t).publisher.publish('job-1')
    expect(JSON.parse(t.objects.get(key)!.body.toString())).toMatchObject({ restartRevision: '2026-11-01T00:00:00Z-mac', pageRevision: '0f0f0f0f-0000-4000-8000-000000000000' })
  })

  it('fetch imports a phone-finished geometry page into Clipper, once, and never marks review', async () => {
    const t = memoryBucket()
    const phonePage = JSON.parse(buildSharedPage({ ...pageInput(), sourceSha256: sourceSha, sourceBytes, pointerText, studioDeviceId: 'phone-1' }).text)
    t.seed(key, phonePage)
    await fs.rm(path.join(store.getSourceFolderPath(folder), 'crop_points3'), { recursive: true, force: true })
    const { publisher } = publisherFor(t)
    expect(await publisher.fetch({ seriesId: 'ser-1' })).toMatchObject({ listed: 1, read: 1, imported: 1, errors: [] })
    expect(await delivery.compareWithSaved(folder, 'page_001.png', JSON.parse(pointerText))).toBe('same')
    t.log.length = 0
    expect(await publisher.fetch({ seriesId: 'ser-1' })).toMatchObject({ listed: 1, read: 0, imported: 0 })
    expect(t.log.filter(l => l.startsWith('GET'))).toEqual([])
    const chapterReview = await review.readEffectiveReview(folder)
    expect([chapterReview.reviewed, chapterReview.cropped]).toEqual([false, false])
  })

  it('fetch keeps local work and skips other generations and legacy pages', async () => {
    const t = memoryBucket()
    const other = delivery.buildPointerFile([{ reason: 'other', bounds: { x0: 0, y0: 0, x1: 100, y1: 100 } }], { filename: 'page_001.png', width: 100, height: 200, sourceSha256: sourceSha }).text
    t.seed(key, JSON.parse(buildSharedPage({ ...pageInput(), sourceSha256: sourceSha, sourceBytes, pointerText: other, studioDeviceId: 'phone-1' }).text))
    expect(await publisherFor(t).publisher.fetch({ seriesId: 'ser-1' })).toMatchObject({ conflicts: 1, imported: 0 })
    seen = {}
    revisions.restart = 'newer-restart'
    expect(await publisherFor(t).publisher.fetch({ seriesId: 'ser-1' })).toMatchObject({ stale: 1, conflicts: 0 })
    seen = {}
    revisions.restart = null
    const legacy = JSON.parse(buildSharedPage({ ...pageInput(), sourceSha256: sourceSha, sourceBytes, pointerText, studioDeviceId: 'phone-1' }).text)
    legacy.working['export-report.json'] = JSON.stringify({ stage: 'metadata' })
    t.seed(key, legacy)
    expect(await publisherFor(t).publisher.fetch({ seriesId: 'ser-1' })).toMatchObject({ skipped: 1 })
  })

  it('after a Studio rejection: fetch never brings the rejected result back, and a result made for that rejection replaces a voided phone page', async () => {
    const { rejectPage, readPageRedo } = await import('../../clipper3/pageRedo.js')
    const redo = await rejectPage({ folderPath: folder, filename: 'page_001.png', chapterNumber: 1, seriesSlug: 'series-a', deviceId: null, restartRevision: null, pageRevision: null }, async () => undefined)
    expect(await delivery.compareWithSaved(folder, 'page_001.png', JSON.parse(pointerText))).toBe('missing')
    const stamped = JSON.stringify({ ...JSON.parse(pointerText), studioRedoRevision: redo.revision }, null, 2) + '\n'

    // The rejected result is still on R2 (here shared by a phone before the rejection): not imported again.
    const t = memoryBucket()
    t.seed(key, JSON.parse(buildSharedPage({ ...pageInput(), sourceSha256: sourceSha, sourceBytes, pointerText, studioDeviceId: 'phone-1' }).text))
    expect(await publisherFor(t).publisher.fetch({ seriesId: 'ser-1' })).toMatchObject({ rejected: 1, imported: 0 })
    expect(await delivery.compareWithSaved(folder, 'page_001.png', JSON.parse(pointerText))).toBe('missing')

    // Studio's replacement overwrites that voided phone page (If-Match) and names the rejection, as phones require.
    const { publisher } = publisherFor(t, fakePrisma(stamped))
    expect(await publisher.publish('job-1')).toMatchObject({ state: 'published' })
    expect(t.log.filter(l => l.startsWith('PUT'))).toEqual([`PUT ${key} if-match`])
    const bundle = JSON.parse(t.objects.get(key)!.body.toString())
    expect(bundle).toMatchObject({ deviceId: 'mac-test', studioRedoRevision: redo.revision })
    expect(JSON.parse(bundle.output.files['crop-pointers-ch001-p001.json']).studioRedoRevision).toBe(redo.revision)

    // A phone result made for the same rejection wins over Studio's.
    t.seed(key, JSON.parse(buildSharedPage({ ...pageInput(), sourceSha256: sourceSha, sourceBytes, pointerText: stamped, studioRedoRevision: redo.revision, studioDeviceId: 'phone-2' }).text))
    expect(await publisherFor(t, fakePrisma(stamped)).publisher.publish('job-1')).toMatchObject({ state: 'phone_has_page' })

    // …and Fetch takes it, finishing the rejection.
    seen = {}
    expect(await publisherFor(t).publisher.fetch({ seriesId: 'ser-1' })).toMatchObject({ imported: 1, rejected: 0 })
    expect((await readPageRedo(folder, 'page_001.png'))?.status).toBe('imported')
  })
})
