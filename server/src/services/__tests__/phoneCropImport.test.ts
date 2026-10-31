import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { PassThrough } from 'stream'
import archiver from 'archiver'
import sharp from 'sharp'

// Chapter zips as Sleeper-Cell's ChapterUpload.kt uploads them, at the bucket root (the phone's prefix differs).
const zips = new Map<string, Buffer>()
const etags = new Map<string, string>()
/** Objects the desktop wrote (cropped markers), by key. */
const puts = new Map<string, string>()
/** Keys the desktop deleted (reviewed markers no longer true). */
const deletes: string[] = []
const send = vi.fn(async (command: { constructor: { name: string }; input: { Key?: string; Prefix?: string; Body?: unknown } }) => {
  if (command.constructor.name === 'ListObjectsV2Command') {
    const prefix = command.input.Prefix!
    const contents = [...zips].filter(([key]) => key.startsWith(prefix))
      .map(([key, body]) => ({ Key: key, ETag: `"${etags.get(key)}"`, Size: body.length }))
    return { Contents: contents, IsTruncated: false }
  }
  if (command.constructor.name === 'GetObjectCommand') {
    const body = zips.get(command.input.Key!)!
    return { ETag: `"${etags.get(command.input.Key!)}"`, Body: { transformToByteArray: async () => new Uint8Array(body) } }
  }
  if (command.constructor.name === 'PutObjectCommand') {
    puts.set(command.input.Key!, String(command.input.Body))
    return { ETag: '"put"' }
  }
  if (command.constructor.name === 'DeleteObjectCommand') {
    deletes.push(command.input.Key!)
    return {}
  }
  throw new Error(`unexpected ${command.constructor.name}`)
})

vi.mock('@aws-sdk/client-s3', async importOriginal => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>()
  return { ...actual, S3Client: class { send = send } }
})
vi.mock('../r2Usage.js', () => ({ FREE_PLAN: {}, attachUsageCounter: () => {}, getMonthUsage: () => ({}), monthKey: () => '' }))
vi.mock('../../index.js', () => ({
  prisma: {
    setting: { findUnique: async () => null },
    series: {
      findUnique: async () => ({
        rootFolder: 'Solo Hero',
        title: 'Solo Hero',
        chapters: [
          { id: 'c9', number: 9, folderPath: 'Solo Hero/Chapter 009' },
          { id: 'c10', number: 10, folderPath: 'Solo Hero/Chapter 010' }
        ]
      })
    }
  }
}))

Object.assign(process.env, { R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b', R2_PREFIX: 'Manhwa' })
const queuedEditor = vi.hoisted(() => vi.fn())
vi.mock('../editorAutoPublish.js', () => ({ queueEditorPublish: queuedEditor }))
const { fetchPhoneCrops, unpackChapterZip, FETCH_MARKER } = await import('../phoneCropImport.js')
const { readZip } = await import('../../utils/zipReader.js')

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const archive = archiver('zip')
  const out = new PassThrough()
  const chunks: Buffer[] = []
  out.on('data', c => chunks.push(c))
  const done = new Promise(resolve => out.on('end', resolve))
  archive.pipe(out)
  for (const [name, text] of Object.entries(files)) archive.append(text, { name })
  await archive.finalize()
  await done
  return Buffer.concat(chunks)
}

const chapterZip = (chapter: string, pages: number[], tag = 'v1', review?: object) => zipOf({
  [`Solo Hero/${chapter}/chapter.json`]: JSON.stringify({ chapter, tag, ...(review ? { review } : {}) }),
  ...Object.fromEntries(pages.flatMap(p => {
    const n = String(p).padStart(3, '0')
    return [
      [`Solo Hero/${chapter}/page_${n}/crop-pointers-ch009-p${n}.json`, `{"tag":"${tag}"}`],
      [`Solo Hero/${chapter}/page_${n}/crop-metadata-ch009-p${n}.json`, `{"tag":"${tag}"}`]
    ]
  }))
})

let root: string
let previousRoot: string | undefined
const processed = (chapter: string) => path.join(root, 'Solo Hero', 'Processed', chapter)

beforeEach(async () => {
  previousRoot = process.env.DOWNLOAD_ROOT
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-crops-'))
  process.env.DOWNLOAD_ROOT = root
  zips.clear()
  etags.clear()
  puts.clear()
  deletes.length = 0
  send.mockClear()
})

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = previousRoot
  await fs.rm(root, { recursive: true, force: true })
})

describe('unpackChapterZip', () => {
  it('writes page folders and chapter.json, skipping other files and unsafe paths', async () => {
    const zip = await zipOf({
      'Solo Hero/Chapter 009/chapter.json': '{}',
      'Solo Hero/Chapter 009/page_001/crop-pointers-ch009-p001.json': 'p',
      'Solo Hero/Chapter 009/page_001/crop-metadata-ch009-p001.json': 'm',
      'Solo Hero/Chapter 009/page_001/notes.txt': 'x',
      'Solo Hero/Chapter 009/../../escape/crop-pointers-x.json': 'bad'
    })
    const dir = processed('Chapter 009')
    expect(await unpackChapterZip(readZip(zip), dir)).toBe(1)
    expect((await fs.readdir(dir)).sort()).toEqual(['chapter.json', 'page_001'])
    expect((await fs.readdir(path.join(dir, 'page_001'))).sort())
      .toEqual(['crop-metadata-ch009-p001.json', 'crop-pointers-ch009-p001.json'])
    await expect(fs.access(path.join(root, 'escape'))).rejects.toThrow()
  })

  it('replaces a page folder\'s old crop files so only the new pair is found', async () => {
    const dir = processed('Chapter 009')
    await fs.mkdir(path.join(dir, 'page_001'), { recursive: true })
    await fs.writeFile(path.join(dir, 'page_001', 'crop-pointers-ch008-p001.json'), 'stale')
    await fs.writeFile(path.join(dir, 'page_001', 'mine.txt'), 'kept')
    await unpackChapterZip(readZip(await chapterZip('Chapter 009', [1])), dir)
    expect((await fs.readdir(path.join(dir, 'page_001'))).sort())
      .toEqual(['crop-metadata-ch009-p001.json', 'crop-pointers-ch009-p001.json', 'mine.txt'])
  })

  it('refuses a zip with no crop JSON', async () => {
    await expect(unpackChapterZip(readZip(await zipOf({ 'a/b/c.txt': 'x' })), processed('Chapter 009')))
      .rejects.toThrow(/no crop JSON/)
  })
})

describe('fetchPhoneCrops', () => {
  it('rejects stale crops after page replacement and accepts only crops for the new revision', async () => {
    const { newPageReplacement, resetChapterClipping } = await import('../chapterPageReplacement.js')
    const replacement = newPageReplacement()
    await resetChapterClipping('Solo Hero/Chapter 009', replacement)
    const key = 'crops/Solo Hero/Chapter 009.zip'
    zips.set(key, await chapterZip('Chapter 009', [1]))
    etags.set(key, 'old')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const stale = await fetchPhoneCrops('s1')
      expect(stale.fetched).toEqual([])
      expect(stale.failed[0].reason).toContain('older page revision')
      await expect(fs.access(processed('Chapter 009'))).rejects.toThrow()
    } finally { log.mockRestore() }
    zips.set(key, await zipOf({
      'Solo Hero/Chapter 009/chapter.json': JSON.stringify({ page_revision: replacement.revision }),
      'Solo Hero/Chapter 009/page_001/crop-pointers-ch009-p001.json': '{}',
      'Solo Hero/Chapter 009/page_001/crop-metadata-ch009-p001.json': '{}'
    }))
    etags.set(key, 'new')
    expect((await fetchPhoneCrops('s1')).fetched).toHaveLength(1)
  })

  it('unpacks each finished chapter into Processed/, then downloads only what changed', async () => {
    zips.set('crops/Solo Hero/Chapter 009.zip', await chapterZip('Chapter 009', [1, 2]))
    etags.set('crops/Solo Hero/Chapter 009.zip', 'e9')
    zips.set('crops/Solo Hero/Chapter 404.zip', await chapterZip('Chapter 404', [1]))
    etags.set('crops/Solo Hero/Chapter 404.zip', 'e404')

    const first = await fetchPhoneCrops('s1')
    expect(first).toMatchObject({ configured: true, found: 2, upToDate: 0, unmatched: ['Chapter 404'], failed: [] })
    expect(first.fetched).toEqual([{ chapterId: 'c9', chapterNumber: 9, folder: 'Chapter 009', pages: 2, reviewed: false }])
    expect((await fs.readdir(processed('Chapter 009'))).sort()).toEqual([FETCH_MARKER, 'chapter.json', 'page_001', 'page_002'])
    // The zip itself is never written to disk.
    expect(await fs.readdir(path.join(root, 'Solo Hero', 'Processed'))).toEqual(['Chapter 009'])

    // Same ETag: nothing downloaded, and the folder is remembered (one LIST).
    send.mockClear()
    const second = await fetchPhoneCrops('s1')
    expect(second).toMatchObject({ fetched: [], upToDate: 1 })
    expect(send.mock.calls.map(([c]) => c.constructor.name)).toEqual(['ListObjectsV2Command'])

    // The phone re-uploads the chapter: it is fetched again, over the old files.
    zips.set('crops/Solo Hero/Chapter 009.zip', await chapterZip('Chapter 009', [1, 2], 'v2'))
    etags.set('crops/Solo Hero/Chapter 009.zip', 'e9b')
    const third = await fetchPhoneCrops('s1')
    expect(third.fetched.map(c => c.folder)).toEqual(['Chapter 009'])
    expect(await fs.readFile(path.join(processed('Chapter 009'), 'page_002', 'crop-pointers-ch009-p002.json'), 'utf-8'))
      .toBe('{"tag":"v2"}')
  })

  it('records a Master phone review from chapter.json, and drops it when unreviewed crops replace it', async () => {
    const key = 'crops/Solo Hero/Chapter 009.zip'
    const reviewFile = path.join(root, 'Solo Hero', 'Chapter 009', '.clipper3-review.json')
    const marker = async () => JSON.parse(await fs.readFile(path.join(processed('Chapter 009'), FETCH_MARKER), 'utf-8'))

    zips.set(key, await chapterZip('Chapter 009', [1, 2], 'v2', {
      reviewed: true,
      reviewed_at: '2026-10-11T10:00:00.000Z',
      device: 'Redmi Note 10 Pro',
      by: 'master',
      edited_pages: ['page_002'],
      moved_crops: 3,
      deleted_crops: 1
    }))
    etags.set(key, 'r1')
    const reviewed = await fetchPhoneCrops('s1')
    expect(reviewed.fetched).toEqual([{ chapterId: 'c9', chapterNumber: 9, folder: 'Chapter 009', pages: 2, reviewed: true }])
    expect(JSON.parse(await fs.readFile(reviewFile, 'utf-8'))).toMatchObject({
      reviewed: true,
      reviewedAt: '2026-10-11T10:00:00.000Z',
      by: 'phone',
      device: 'Redmi Note 10 Pro',
      etag: 'r1',
      editedPages: ['page_002'],
      movedCrops: 3,
      deletedCrops: 1
    })
    // Sync json is told to put the review over pages already attached.
    expect(await marker()).toMatchObject({ etag: 'r1', reviewed: true, applied: false })

    // A clipping phone re-clips the chapter: new content, so it needs review again.
    zips.set(key, await chapterZip('Chapter 009', [1, 2], 'v3', { reviewed: false }))
    etags.set(key, 'r2')
    const redone = await fetchPhoneCrops('s1')
    expect(redone.fetched[0].reviewed).toBe(false)
    expect(JSON.parse(await fs.readFile(reviewFile, 'utf-8'))).toMatchObject({ reviewed: false, reviewedAt: null, by: null })
    const after = await marker()
    expect(after).toMatchObject({ etag: 'r2', reviewed: false })
    expect(after.applied).toBeUndefined()
  })

  it.each([false, true])('keeps desktop review byte-identical when fetching phone reviewed=%s', async reviewed => {
    const { setDesktopReview } = await import('../clipper3/chapterReview.js')
    const key = 'crops/Solo Hero/Chapter 009.zip'
    const reviewFile = path.join(root, 'Solo Hero', 'Chapter 009', '.clipper3-review.json')
    await setDesktopReview('Solo Hero/Chapter 009', true)
    const before = await fs.readFile(reviewFile, 'utf8')
    zips.set(key, await chapterZip('Chapter 009', [1], 'v2', { reviewed, reviewed_at: '2026-10-28T10:00:00Z' }))
    etags.set(key, 'new-phone-zip')
    expect((await fetchPhoneCrops('s1')).failed).toEqual([])
    expect(await fs.readFile(reviewFile, 'utf8')).toBe(before)
    expect(await fs.readFile(path.join(processed('Chapter 009'), 'page_001', 'crop-pointers-ch009-p001.json'), 'utf8')).toBe('{"tag":"v2"}')
  })

  it('keeps an existing cut reviewed when an unreviewed ZIP is fetched', async () => {
    const { readEffectiveReview } = await import('../clipper3/chapterReview.js')
    const dir = path.join(root, 'Solo Hero', 'Chapter 009', 'crops3')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'solo_hero_page_001_01.png'), 'approved cut')
    const key = 'crops/Solo Hero/Chapter 009.zip'
    zips.set(key, await chapterZip('Chapter 009', [1]))
    etags.set(key, 'old-geometry')
    expect((await fetchPhoneCrops('s1')).failed).toEqual([])
    expect(await readEffectiveReview('Solo Hero/Chapter 009')).toMatchObject({ reviewed: true, cropped: true })
  })

  it('backfills a cropped marker beside the zips for each cut chapter R2 has none for', async () => {
    zips.set('crops/Solo Hero/Chapter 009.zip', await chapterZip('Chapter 009', [1]))
    etags.set('crops/Solo Hero/Chapter 009.zip', 'e9')
    // Chapter 009 already has its marker; Chapter 010 was cut before markers existed.
    zips.set('crops/Solo Hero/Chapter 009.cropped.json', Buffer.from('{}'))
    etags.set('crops/Solo Hero/Chapter 009.cropped.json', 'm9')

    for (const chapter of ['Chapter 009', 'Chapter 010']) {
      const dir = path.join(root, 'Solo Hero', chapter)
      await fs.mkdir(path.join(dir, 'crops3'), { recursive: true })
      for (const page of ['page_001.png', 'page_002.png']) {
        await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toFile(path.join(dir, page))
      }
      await fs.writeFile(path.join(dir, 'crops3', 'solo_hero_page_001_01_panel.png'), 'png')
      await fs.writeFile(path.join(dir, 'crops3', 'solo_hero_page_001_02.png'), 'png')
    }
    const cutAt = new Date('2026-10-01T12:00:00.000Z')
    await fs.utimes(path.join(root, 'Solo Hero', 'Chapter 010', 'crops3', 'solo_hero_page_001_02.png'), cutAt, cutAt)
    await fs.utimes(path.join(root, 'Solo Hero', 'Chapter 010', 'crops3', 'solo_hero_page_001_01_panel.png'), cutAt, cutAt)

    const result = await fetchPhoneCrops('s1')
    expect(result.cropped).toEqual({ published: ['Chapter 010'], failed: [] })
    expect([...puts.keys()]).toEqual(['crops/Solo Hero/Chapter 010.cropped.json'])
    const body = puts.get('crops/Solo Hero/Chapter 010.cropped.json')!
    expect(body.endsWith('\n')).toBe(true)
    expect(JSON.parse(body)).toEqual({
      schema: 'manhwa-studio-cropped/1',
      series: 'Solo Hero',
      chapter: 'Chapter 010',
      cropped_at: '2026-10-01T12:00:00.000Z',
      pages: 1,
      crops: 2
    })
  })

  it('puts reviewed markers in step with the desktop\'s own reviews', async () => {
    const { writeChapterReview } = await import('../clipper3/chapterReview.js')
    zips.set('crops/Solo Hero/Chapter 009.zip', await chapterZip('Chapter 009', [1]))
    etags.set('crops/Solo Hero/Chapter 009.zip', 'e9')
    zips.set('crops/Solo Hero/Chapter 010.zip', await chapterZip('Chapter 010', [1]))
    etags.set('crops/Solo Hero/Chapter 010.zip', 'e10')
    // Chapter 009 was unmarked on the desktop after its marker went up; Chapter 010 is reviewed here.
    zips.set('crops/Solo Hero/Chapter 009.reviewed.json', Buffer.from('{}'))
    etags.set('crops/Solo Hero/Chapter 009.reviewed.json', 'r9')
    await writeChapterReview('Solo Hero/Chapter 010', { reviewed: true, reviewedAt: '2026-10-28T01:50:26.864Z', by: 'desktop' })

    const result = await fetchPhoneCrops('s1')
    expect(result.reviewedMarkers).toEqual({ published: ['Chapter 010'], removed: ['Chapter 009'], failed: [] })
    expect(deletes).toEqual(['crops/Solo Hero/Chapter 009.reviewed.json'])
    expect([...puts.keys()]).toEqual(['crops/Solo Hero/Chapter 010.reviewed.json'])
    expect(JSON.parse(puts.get('crops/Solo Hero/Chapter 010.reviewed.json')!)).toEqual({
      schema: 'manhwa-studio-reviewed/1',
      series: 'Solo Hero',
      chapter: 'Chapter 010',
      reviewed: true,
      reviewed_at: '2026-10-28T01:50:26.864Z',
      by: 'desktop'
    })
    // The fetched clipping-phone zip did not reset the desktop's review.
    const { readChapterReview } = await import('../clipper3/chapterReview.js')
    expect(await readChapterReview('Solo Hero/Chapter 010')).toMatchObject({ reviewed: true, by: 'desktop' })

    // Once in step, a second Sync json writes and removes nothing.
    puts.clear()
    deletes.length = 0
    zips.delete('crops/Solo Hero/Chapter 009.reviewed.json')
    zips.set('crops/Solo Hero/Chapter 010.reviewed.json', Buffer.from('{}'))
    etags.set('crops/Solo Hero/Chapter 010.reviewed.json', 'r10')
    expect((await fetchPhoneCrops('s1')).reviewedMarkers).toEqual({ published: [], removed: [], failed: [] })
    expect(puts.size + deletes.length).toBe(0)
  })

  it('finds zips under our prefix as well, and narrows to the chosen chapters', async () => {
    zips.set('Manhwa/crops/Solo Hero/Chapter 009.zip', await chapterZip('Chapter 009', [1]))
    etags.set('Manhwa/crops/Solo Hero/Chapter 009.zip', 'a')
    zips.set('Manhwa/crops/Solo Hero/Chapter 010.zip', await chapterZip('Chapter 010', [1]))
    etags.set('Manhwa/crops/Solo Hero/Chapter 010.zip', 'b')
    const result = await fetchPhoneCrops('s2', ['c10'])
    expect(result.found).toBe(2)
    expect(result.fetched.map(c => c.chapterId)).toEqual(['c10'])
  })
})


describe('verified story-link returns', () => {
  async function fixture(change: 'none' | 'geometry' | 'description' | 'script' = 'none', reviewed = false) {
    const { writeImagePoints, writeImageMetadata } = await import('../clipper3/perImageStore.js')
    const { setDesktopReview } = await import('../clipper3/chapterReview.js')
    const { sha256 } = await import('../clipper3/studioCropAuthorityModel.js')
    const folder = 'Solo Hero/Chapter 009', dir = path.join(root, folder), script = 'The hero arrives.'
    await fs.mkdir(dir, { recursive: true })
    const source = await sharp({ create: { width: 10, height: 20, channels: 3, background: '#fff' } }).png().toBuffer()
    await fs.writeFile(path.join(dir, 'page_001.png'), source)
    await fs.writeFile(path.join(dir, 'script.md'), script)
    const points = { format: 'four-point-crop', version: '1.0', coordinateSystem: 'normalized', image: { filename: 'page_001.png', width: 10, height: 20 },
      crops: [{ id: 'crop-01', reason: 'panel', crop: { mode: 'rectangle' as const, points: [{ id: 'P1', x: 0, y: 0 }, { id: 'P2', x: 1, y: 0 }, { id: 'P3', x: 1, y: 1 }, { id: 'P4', x: 0, y: 1 }] } }] }
    const crop = { id: 'crop-01', exportedFilename: 'solo_hero_page_001_01_panel.png', description: 'The hero at a gate.' }
    await writeImagePoints(folder, 'page_001.png', points)
    await writeImageMetadata(folder, 'page_001.png', JSON.stringify({ crops: [crop] }))
    await setDesktopReview(folder, true)
    const linked = { storyLinking: { schema_version: 'crop-script-links/1', scriptSha256: sha256(change === 'script' ? 'old' : script), sourceSha256: sha256(source), inputRevision: 'b'.repeat(64), scriptSegments: [{ id: 'P0001', text: script }] },
      crops: [{ ...crop, description: change === 'description' ? 'Different visuals' : crop.description, scriptRefs: ['P0001'], matchType: 'direct', storyContext: 'He arrives.', evidence: 'He is visible.', reviewReason: '' }] }
    if (change === 'geometry') points.crops[0].crop.points[0].y = 0.1
    const key = 'crops/Solo Hero/Chapter 009.zip'
    zips.set(key, await zipOf({ 'Solo Hero/Chapter 009/chapter.json': JSON.stringify(reviewed ? { review: { reviewed: true } } : {}),
      'Solo Hero/Chapter 009/page_001/crop-pointers-ch009-p001.json': JSON.stringify(points),
      'Solo Hero/Chapter 009/page_001/crop-metadata-ch009-p001.json': JSON.stringify(linked) }))
    etags.set(key, 'linked')
    queuedEditor.mockClear()
    return { folder, dir }
  }
  it('attaches exact current links on fetch, preserves approval and publishes without another cut', async () => {
    const { folder, dir } = await fixture()
    const before = await fs.readFile(path.join(dir, '.clipper3-review.json'), 'utf8')
    expect((await fetchPhoneCrops('s1')).failed).toEqual([])
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'crop_metadata3/page_001.txt'), 'utf8'))
    expect(meta.storyLinking.schema_version).toBe('crop-script-links/1')
    expect(await fs.readFile(path.join(dir, '.clipper3-review.json'), 'utf8')).toBe(before)
    expect(queuedEditor).toHaveBeenCalledWith('c9')
    queuedEditor.mockClear()
    expect((await fetchPhoneCrops('s1')).upToDate).toBe(1)
    expect(queuedEditor).not.toHaveBeenCalled()
  })
  it('also attaches exact returns carrying an explicit phone review', async () => {
    const { dir } = await fixture('none', true)
    expect((await fetchPhoneCrops('s1')).failed).toEqual([])
    expect(JSON.parse(await fs.readFile(path.join(dir, 'crop_metadata3/page_001.txt'), 'utf8')).storyLinking).toBeDefined()
    expect(queuedEditor).toHaveBeenCalledWith('c9')
  })
  it.each(['geometry', 'description', 'script'] as const)('leaves a %s mismatch staged without attaching or publishing', async change => {
    const { dir } = await fixture(change)
    expect((await fetchPhoneCrops('s1')).failed).toEqual([])
    expect(JSON.parse(await fs.readFile(path.join(dir, 'crop_metadata3/page_001.txt'), 'utf8')).storyLinking).toBeUndefined()
    expect(queuedEditor).not.toHaveBeenCalled()
  })
  it('catches up staged links even when the cloud ETag was already remembered', async () => {
    const { dir } = await fixture()
    // First fetch leaves stale-script metadata staged; a later local script correction makes the same upload valid.
    const scriptFile = path.join(dir, 'script.md')
    await fs.writeFile(scriptFile, 'temporary script')
    await fetchPhoneCrops('s1')
    await fs.writeFile(scriptFile, 'The hero arrives.')
    queuedEditor.mockClear()
    expect((await fetchPhoneCrops('s1')).upToDate).toBe(1)
    expect(JSON.parse(await fs.readFile(path.join(dir, 'crop_metadata3/page_001.txt'), 'utf8')).storyLinking).toBeDefined()
    expect(queuedEditor).toHaveBeenCalledWith('c9')
  })
})
