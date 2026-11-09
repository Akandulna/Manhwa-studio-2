import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import sharp from 'sharp'
import { readMetadataChapter } from '../metadataChapterStatus.js'
import { readImagePoints, readImageMetadata, writeImagePoints, writeImageMetadata } from '../clipper3/perImageStore.js'
import { cutImageCrops } from '../clipper3/perImageCrop.js'
import { setDesktopReview } from '../clipper3/chapterReview.js'
import { captureMetadataGeometry, recordMetadataCut, currentMetadataJobs, importMetadataResult, fetchMetadataResults } from '../clipper3/metadataSplit.js'
import { sha256 } from '../clipper3/studioCropAuthorityModel.js'

vi.mock('../seriesRestartGuard.js', () => ({ requireSeriesRestartReady: async () => null }))
vi.mock('../chapterPageReplacement.js', () => ({ readPageReplacement: async () => null, pageReplacementActive: () => false }))
vi.mock('../editorAutoPublish.js', () => ({ queueEditorPublish: vi.fn() }))
const cloud = vi.hoisted(() => ({ objects: new Map<string, string>() }))
vi.mock('../r2Service.js', () => ({
  getR2Config: () => ({ prefix: '', bucket: 'test' }), phoneFolders: async () => [],
  createClient: () => ({ destroy() {}, async send(command: any) {
    if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [...cloud.objects.keys()].filter(key => key.startsWith(command.input.Prefix)).map(Key => ({ Key })) }
    if (command.constructor.name === 'GetObjectCommand') return { Body: { transformToString: async () => cloud.objects.get(command.input.Key) } }
    throw new Error(`Unexpected cloud command ${command.constructor.name}`)
  } })
}))

const folder = 'Series/Chapter 021'
const pages = ['page_001.png', 'page_002.png']
const chapter = { id: 'c21', number: 21, title: null, folderPath: folder, seriesId: 's1', series: { title: 'Series' } }
const crop = { id: 'crop-01', reason: 'panel', crop: { mode: 'rectangle' as const, points: [
  { id: 'P1', x: 0, y: 0 }, { id: 'P2', x: 1, y: 0 }, { id: 'P3', x: 1, y: 0.5 }, { id: 'P4', x: 0, y: 0.5 }
] } }
let root: string, previous: string | undefined
beforeEach(async () => {
  cloud.objects.clear()
  previous = process.env.DOWNLOAD_ROOT
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-status-'))
  process.env.DOWNLOAD_ROOT = root
  await fs.mkdir(path.join(root, folder), { recursive: true })
  for (const page of pages) await sharp({ create: { width: 100, height: 200, channels: 3, background: '#336699' } }).png().toFile(path.join(root, folder, page))
  await fs.writeFile(path.join(root, folder, 'script.md'), 'The traveller finds a sword.')
})
afterEach(async () => {
  if (previous === undefined) delete process.env.DOWNLOAD_ROOT; else process.env.DOWNLOAD_ROOT = previous
  await fs.rm(root, { recursive: true, force: true })
})

async function prepare(empty = false) {
  for (const page of pages) await writeImagePoints(folder, page, {
    format: 'four-point-crop', version: '1.0', coordinateSystem: 'normalized', image: { filename: page, width: 100, height: 200 },
    crops: empty ? [] : [crop], workflow: 'clipper-geometry/1', sourceSha256: sha256(await fs.readFile(path.join(root, folder, page)))
  })
  await setDesktopReview(folder, true)
  const baseline = await captureMetadataGeometry(chapter)
  for (const page of pages) await cutImageCrops({ folderPath: folder, imageFilename: page, crops: empty ? [] : [crop], slug: 'series' })
  await recordMetadataCut(chapter, baseline)
  return (await currentMetadataJobs(chapter, { restartRevision: null, pageRevision: null })).jobs
}
function metadata(job: { revision: string; payloadText: string }) {
  const p = JSON.parse(job.payloadText)
  return JSON.stringify({ metadataJob: { schema: 'sleeper-cell-metadata/1', revision: job.revision, cutRevision: p.cutRevision },
    storyLinking: { schema_version: 'crop-script-links/1', inputRevision: job.revision, sourceSha256: p.sourceSha256, scriptSha256: p.scriptSha256,
      scriptSegments: [{ id: 'P0001', text: 'The traveller finds a sword.' }] },
    crops: p.crops.map((c: any) => ({ id: c.id, exportedFilename: c.exportedFilename, description: 'A traveller holds a sword.', storyContext: 'Finding a sword.',
      scriptRefs: ['P0001'], matchType: 'direct', evidence: 'The sword is visible.', reviewReason: '' })) })
}

describe('Metadata chapter completion', () => {
  it('never counts pointer-only or empty-source chapters as metadata complete', async () => {
    expect(await readMetadataChapter(chapter)).toMatchObject({ state: 'pending', done: 0, total: 2, ready: false })
    const jobs = await prepare()
    expect(jobs).toHaveLength(2)
    expect(await readMetadataChapter(chapter)).toMatchObject({ state: 'pending', done: 0, total: 2, ready: true })
    for (const page of pages) await fs.rm(path.join(root, folder, page))
    expect(await readMetadataChapter(chapter)).toMatchObject({ state: 'blocked', done: 0, total: 0 })
  })
  it('updates partial and complete counts from individual validated imports without changing pointers', async () => {
    const jobs = await prepare(), before = await readImagePoints(folder, pages[0])
    await importMetadataResult(chapter, pages[0], metadata(jobs[0]))
    const partial = await readMetadataChapter(chapter)
    expect(partial).toMatchObject({ state: 'partial', done: 1, total: 2 })
    expect(partial.pages.map(p => p.state)).toEqual(['complete', 'pending'])
    await importMetadataResult(chapter, pages[1], metadata(jobs[1]))
    expect(await readMetadataChapter(chapter)).toMatchObject({ state: 'complete', done: 2, total: 2 })
    expect(await readImagePoints(folder, pages[0])).toEqual(before)
  })
  it('marks stale script links invalid and revoked review or changed crop bytes blocked', async () => {
    const jobs = await prepare()
    for (let i = 0; i < pages.length; i++) await importMetadataResult(chapter, pages[i], metadata(jobs[i]))
    await fs.writeFile(path.join(root, folder, 'script.md'), 'A different story.')
    const stale = await readMetadataChapter(chapter)
    expect(stale.done).toBe(0); expect(stale.pages.every(p => p.state === 'invalid')).toBe(true)
    expect(stale.reason).toMatch(/Stale/)
    await fs.writeFile(path.join(root, folder, 'script.md'), 'The traveller finds a sword.')
    const name = JSON.parse(jobs[0].payloadText).crops[0].exportedFilename
    await fs.appendFile(path.join(root, folder, 'crops3', name), 'changed')
    expect(await readMetadataChapter(chapter)).toMatchObject({ state: 'blocked', done: 0, ready: false })
    await setDesktopReview(folder, false)
    expect((await readMetadataChapter(chapter)).reason).toMatch(/review/)
  })
  it('requires an explicit valid result even for approved pages with zero crops', async () => {
    const jobs = await prepare(true)
    expect((await readMetadataChapter(chapter)).state).toBe('pending')
    for (let i = 0; i < pages.length; i++) await importMetadataResult(chapter, pages[i], metadata(jobs[i]))
    expect(await readMetadataChapter(chapter)).toMatchObject({ state: 'complete', done: 2 })
  })
  it('does not count malformed metadata or missing descriptions as complete', async () => {
    const jobs = await prepare()
    await writeImageMetadata(folder, pages[0], '{bad-json')
    const value = JSON.parse(metadata(jobs[1])); value.crops[0].description = ''
    await writeImageMetadata(folder, pages[1], JSON.stringify(value))
    const status = await readMetadataChapter(chapter)
    expect(status.done).toBe(0); expect(status.pages.every(p => p.state === 'invalid')).toBe(true)
    expect(await readImageMetadata(folder, pages[0])).toBe('{bad-json')
  })
  it('fetches individual phone results as they arrive and rejects stale uploads without overwriting saved files', async () => {
    const jobs = await prepare()
    const upload = (i: number) => cloud.objects.set(`metadata/${folder}/${path.parse(pages[i]).name}.page.json`, JSON.stringify({
      schema: 'sleeper-cell-metadata-result/1', series: 'Series', chapter: 'Chapter 021', page: pages[i], metadataText: metadata(jobs[i])
    }))
    upload(0)
    expect(await fetchMetadataResults(chapter)).toEqual({ imported: 1, errors: [] })
    expect(await readMetadataChapter(chapter)).toMatchObject({ state: 'partial', done: 1 })
    upload(1)
    expect(await fetchMetadataResults(chapter)).toEqual({ imported: 1, errors: [] })
    expect(await readMetadataChapter(chapter)).toMatchObject({ state: 'complete', done: 2 })
    expect(await fetchMetadataResults(chapter)).toEqual({ imported: 0, errors: [] })
    const saved = await readImageMetadata(folder, pages[0])
    await fs.writeFile(path.join(root, folder, 'script.md'), 'A changed script.')
    const stale = await fetchMetadataResults(chapter)
    expect(stale.imported).toBe(0); expect(stale.errors).toHaveLength(2)
    expect(await readImageMetadata(folder, pages[0])).toBe(saved)
  })
})
