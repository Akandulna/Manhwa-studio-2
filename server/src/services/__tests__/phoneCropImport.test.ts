import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { PassThrough } from 'stream'
import archiver from 'archiver'

// Chapter zips as Sleeper-Cell's ChapterUpload.kt uploads them, at the bucket root (the phone's prefix differs).
const zips = new Map<string, Buffer>()
const etags = new Map<string, string>()
const send = vi.fn(async (command: { constructor: { name: string }; input: { Key?: string; Prefix?: string } }) => {
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
  throw new Error(`unexpected ${command.constructor.name}`)
})

vi.mock('@aws-sdk/client-s3', async importOriginal => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>()
  return { ...actual, S3Client: class { send = send } }
})
vi.mock('../r2Usage.js', () => ({ FREE_PLAN: {}, attachUsageCounter: () => {}, getMonthUsage: () => ({}), monthKey: () => '' }))
vi.mock('../../index.js', () => ({
  prisma: {
    series: {
      findUnique: async () => ({
        rootFolder: 'Solo Hero',
        chapters: [
          { id: 'c9', number: 9, folderPath: 'Solo Hero/Chapter 009' },
          { id: 'c10', number: 10, folderPath: 'Solo Hero/Chapter 010' }
        ]
      })
    }
  }
}))

Object.assign(process.env, { R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b', R2_PREFIX: 'Manhwa' })
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

const chapterZip = (chapter: string, pages: number[], tag = 'v1') => zipOf({
  [`Solo Hero/${chapter}/chapter.json`]: JSON.stringify({ chapter, tag }),
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
  it('unpacks each finished chapter into Processed/, then downloads only what changed', async () => {
    zips.set('crops/Solo Hero/Chapter 009.zip', await chapterZip('Chapter 009', [1, 2]))
    etags.set('crops/Solo Hero/Chapter 009.zip', 'e9')
    zips.set('crops/Solo Hero/Chapter 404.zip', await chapterZip('Chapter 404', [1]))
    etags.set('crops/Solo Hero/Chapter 404.zip', 'e404')

    const first = await fetchPhoneCrops('s1')
    expect(first).toMatchObject({ configured: true, found: 2, upToDate: 0, unmatched: ['Chapter 404'], failed: [] })
    expect(first.fetched).toEqual([{ chapterId: 'c9', chapterNumber: 9, folder: 'Chapter 009', pages: 2 }])
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
