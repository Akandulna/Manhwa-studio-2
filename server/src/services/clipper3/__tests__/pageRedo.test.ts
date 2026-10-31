import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { rejectPage, readPageRedo } from '../pageRedo.js'
import { syncChapterProcessed, getProcessedDir, FETCH_MARKER } from '../processedSync.js'
import { writeImagePoints, writeImageMetadata, getPointsFilePathFor, getMetadataFilePathFor, getOutputDir } from '../perImageStore.js'
import { readEffectiveReview, setDesktopReview, writeChapterReview } from '../chapterReview.js'
import { sha256 } from '../studioCropAuthorityModel.js'

vi.mock('../../editorAutoPublish.js', () => ({ queueEditorPublish: vi.fn() }))
let root: string, previous: string | undefined
const folder = 'Series/Chapter 018', script = 'The hero reaches the gate.'
const image = { filename: 'page_017.jpg', width: 800, height: 9000 }
const other = { ...image, filename: 'page_018.jpg' }
const input = { chapterId: 'chapter18', chapterNumber: 18, folderPath: folder, seriesSlug: 'series', images: [image, other] }
const rejection = { folderPath: folder, filename: image.filename, chapterNumber: 18, seriesSlug: 'series', deviceId: 'phone', restartRevision: null, pageRevision: null }
const points = (y = 0.1) => ({ format: 'four-point-crop', version: '1.0', coordinateSystem: 'normalized', image,
  crops: [{ id: 'crop-01', reason: 'panel', crop: { mode: 'rectangle' as const,
    points: [{ id: 'a', x: 0, y }, { id: 'b', x: 1, y }, { id: 'c', x: 1, y: 0.3 }, { id: 'd', x: 0, y: 0.3 }] } }] })
const metadata = () => ({ storyLinking: { schema_version: 'crop-script-links/1', inputRevision: 'b'.repeat(64), sourceSha256: sha256('source'), scriptSha256: sha256(script), scriptSegments: [{ id: 'P0001', text: script }] },
  crops: [{ id: 'crop-01', exportedFilename: 'series_page_017_01_panel.png', description: 'A person stands at the gate.', storyContext: script, scriptRefs: ['P0001'], matchType: 'direct', evidence: 'The gate is behind him.', reviewReason: '' }] })
async function drop(p: object, m: object) {
  const dir = path.join(getProcessedDir(folder), 'page_017'); await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'crop-pointers-ch018-p017.json'), JSON.stringify(p))
  await fs.writeFile(path.join(dir, 'crop-metadata-ch018-p017.json'), JSON.stringify(m))
}
beforeEach(async () => {
  previous = process.env.DOWNLOAD_ROOT; root = await fs.mkdtemp(path.join(os.tmpdir(), 'page-redo-')); process.env.DOWNLOAD_ROOT = root
  await fs.mkdir(path.join(root, folder), { recursive: true })
  await fs.writeFile(path.join(root, folder, image.filename), 'source')
  await fs.writeFile(path.join(root, folder, other.filename), 'other source')
  await fs.writeFile(path.join(root, folder, 'script.md'), script)
  await writeImagePoints(folder, image.filename, points()); await writeImageMetadata(folder, image.filename, JSON.stringify(metadata()))
  await writeImagePoints(folder, other.filename, { ...points(), image: other }); await writeImageMetadata(folder, other.filename, '{"keep":"other reviewed page"}')
  await fs.mkdir(getOutputDir(folder), { recursive: true })
  await fs.writeFile(path.join(getOutputDir(folder), 'series_page_017_01_panel.png'), 'old page17 rendered crop')
  await fs.writeFile(path.join(getOutputDir(folder), 'series_page_018_01_panel.png'), 'reviewed page18 rendered crop')
  await setDesktopReview(folder, true)
})
afterEach(async () => { if (previous === undefined) delete process.env.DOWNLOAD_ROOT; else process.env.DOWNLOAD_ROOT = previous; await fs.rm(root, { recursive: true, force: true }) })

describe('explicit single-page redo', () => {
  it('backs up and detaches only the rejected page, revokes chapter completion, and retries delivery with the same revision', async () => {
    const otherBefore = await fs.readFile(getPointsFilePathFor(folder, other.filename), 'utf8')
    const publish = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const first = await rejectPage(rejection, publish)
    expect(first).toMatchObject({ status: 'pending', deliveryError: 'offline' })
    expect(await fs.readFile(getPointsFilePathFor(folder, other.filename), 'utf8')).toBe(otherBefore)
    expect(await fs.readFile(path.join(getOutputDir(folder), 'series_page_018_01_panel.png'), 'utf8')).toBe('reviewed page18 rendered crop')
    expect(await fs.stat(getPointsFilePathFor(folder, image.filename)).catch(() => null)).toBeNull()
    expect((await readEffectiveReview(folder)).reviewed).toBe(false)
    const backup = path.join(root, folder, '.studio-page-redo/backups', first.revision)
    expect(JSON.parse(await fs.readFile(path.join(backup, 'crop_points3/page_017.json'), 'utf8')).crops).toHaveLength(1)
    expect((await rejectPage(rejection, publish)).revision).toBe(first.revision)
    expect(publish).toHaveBeenCalledTimes(2)
  })
  it('ignores old files, previews a fresh replacement without mutation, imports changed geometry once, and ignores stale exports afterwards', async () => {
    await drop(points(), metadata())
    const request = await rejectPage(rejection, async () => {})
    expect(await syncChapterProcessed(input)).toMatchObject({ imported: 0, failed: 0, skipped: 1 })
    const p = { ...points(0.2), studioRedoRevision: request.revision }, m = { ...metadata(), studioRedoRevision: request.revision }
    await drop(p, m)
    expect(await syncChapterProcessed({ ...input, dryRun: true })).toMatchObject({ ready: 1, failed: 0 })
    expect((await readPageRedo(folder, image.filename))?.status).toBe('pending')
    expect(await syncChapterProcessed(input)).toMatchObject({ imported: 1, failed: 0 })
    expect(JSON.parse(await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')).crops[0].crop.points[0].y).toBe(0.2)
    expect((await readPageRedo(folder, image.filename))?.status).toBe('imported')
    await setDesktopReview(folder, true)
    const before = await fs.readFile(getMetadataFilePathFor(folder, image.filename), 'utf8')
    await drop(points(), metadata())
    expect(await syncChapterProcessed(input)).toMatchObject({ imported: 0, replaced: 0, failed: 0 })
    expect(await fs.readFile(getMetadataFilePathFor(folder, image.filename), 'utf8')).toBe(before)
  })
  it('finishes an interrupted import instead of protecting the half-written rejected state', async () => {
    const request = await rejectPage(rejection, async () => {})
    await writeImagePoints(folder, image.filename, points(0.2))
    await writeImageMetadata(folder, image.filename, JSON.stringify(metadata()))
    await drop({ ...points(0.25), studioRedoRevision: request.revision }, { ...metadata(), studioRedoRevision: request.revision })
    expect(await syncChapterProcessed({ ...input, storyLinksOnly: true })).toMatchObject({ replaced: 1, failed: 0 })
    expect((await readPageRedo(folder, image.filename))?.status).toBe('imported')
  })
  it('requires the redo revision in both JSON files and current source/script links', async () => {
    const request = await rejectPage(rejection, async () => {})
    await drop({ ...points(), studioRedoRevision: request.revision }, metadata())
    expect(await syncChapterProcessed(input)).toMatchObject({ skipped: 1, imported: 0 })
    const m = metadata(); m.storyLinking.scriptSha256 = '0'.repeat(64)
    await drop({ ...points(), studioRedoRevision: request.revision }, { ...m, studioRedoRevision: request.revision })
    expect(await syncChapterProcessed(input)).toMatchObject({ failed: 1, imported: 0 })
  })
  it('preserves the review of a replacement reviewed on Sleeper Cell, including corrected phone geometry after a restart', async () => {
    const request = await rejectPage(rejection, async () => {})
    await drop({ ...points(0.2), studioRedoRevision: request.revision }, { ...metadata(), studioRedoRevision: request.revision })
    await fs.writeFile(path.join(getProcessedDir(folder), FETCH_MARKER), JSON.stringify({ reviewed: true, restartRevision: 'restart-current' }))
    expect(await syncChapterProcessed(input)).toMatchObject({ imported: 1, failed: 0 })
    await drop({ ...points(0.25), studioRedoRevision: request.revision }, { ...metadata(), studioRedoRevision: request.revision })
    await fs.writeFile(path.join(getProcessedDir(folder), FETCH_MARKER), JSON.stringify({ reviewed: true, restartRevision: 'restart-current' }))
    // The phone's review is applicable; an old cut of another page does not turn it into a desktop review.
    await writeChapterReview(folder, { reviewed: true, reviewedAt: new Date().toISOString(), by: 'phone' })
    expect(await syncChapterProcessed(input)).toMatchObject({ replaced: 1, failed: 0 })
  })
})
