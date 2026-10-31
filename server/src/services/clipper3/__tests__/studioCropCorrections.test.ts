import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { sendStudioCropCorrections, type CorrectionTransport } from '../studioCropCorrections.js'
import { syncChapterProcessed, getProcessedDir, FETCH_MARKER, type SyncChapterInput } from '../processedSync.js'
import { setDesktopReview } from '../chapterReview.js'
import { sha256, storyLinksCurrent } from '../studioCropAuthorityModel.js'
import { writeImagePoints, writeImageMetadata, readImageMetadata, getPointsFilePathFor, getMetadataFilePathFor } from '../perImageStore.js'

vi.mock('../../editorAutoPublish.js', () => ({ queueEditorPublish: vi.fn() }))
let root: string, previous: string | undefined
const folder = 'Series/Chapter 002', script = 'The hero reaches the gate.'
const image = { filename: 'page_001.jpg', width: 709, height: 11387 }
const input: SyncChapterInput = { chapterId: 'c2', chapterNumber: 2, folderPath: folder, seriesSlug: 'series', images: [image], storyLinksOnly: true }
const generation = { restartRevision: '123-phone', pageRevision: null }
const points = (top = 0.03578640330335775) => ({ format: 'four-point-crop', version: '1.0', image, coordinateSystem: 'normalized', crops: [{ id: 'crop-01', reason: 'panel', crop: { mode: 'rectangle' as const, points: [
  { id: 'P1', x: 0, y: top }, { id: 'P2', x: 1, y: top }, { id: 'P3', x: 1, y: 0.13502237923197943 }, { id: 'P4', x: 0, y: 0.13502237923197943 },
] } }] })
const cutterFilename = 'series_page_001_01_panel.png'
const approvedFilename = 'series_page_001_01_approved_editor_name.png'
const legacyPhoneFilename = 'series_2e1a99a4_9c1a_47dc_b2f8_4e43392001cc_page_001_01_panel.png'
const metadata = (filename = cutterFilename) => ({ crops: [{ id: 'crop-01', exportedFilename: filename, description: 'A person stands at the gate.' }] })
function linked(filename = cutterFilename) {
  return { storyLinking: { schema_version: 'crop-script-links/1', inputRevision: 'b'.repeat(64), sourceSha256: sha256('source'), scriptSha256: sha256(script), scriptSegments: [{ id: 'P0001', text: script }] },
    crops: [{ ...metadata(filename).crops[0], storyContext: 'He reaches the gate.', scriptRefs: ['P0001'], matchType: 'direct', evidence: 'The gate is behind him.', reviewReason: '' }] }
}
async function drop(pointer = points(), meta: object = linked()) {
  const dir = path.join(getProcessedDir(folder), 'page_001'); await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'crop-pointers-ch002-p001.json'), JSON.stringify(pointer))
  await fs.writeFile(path.join(dir, 'crop-metadata-ch002-p001.json'), JSON.stringify(meta))
}
function capture(applied = 0) {
  const sent: { key: string; body: Record<string, any> }[] = []
  const transport: CorrectionTransport = { async publish(key, body) { sent.push({ key, body }); return { applied } } }
  return { sent, transport }
}
beforeEach(async () => {
  previous = process.env.DOWNLOAD_ROOT; root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-corrections-')); process.env.DOWNLOAD_ROOT = root
  await fs.mkdir(path.join(root, folder), { recursive: true })
  await fs.writeFile(path.join(root, folder, 'script.md'), script)
  await fs.writeFile(path.join(root, folder, image.filename), 'source')
  await writeImagePoints(folder, image.filename, points())
  await writeImageMetadata(folder, image.filename, JSON.stringify(metadata()))
})
afterEach(async () => { if (previous === undefined) delete process.env.DOWNLOAD_ROOT; else process.env.DOWNLOAD_ROOT = previous; await fs.rm(root, { recursive: true, force: true }) })

describe('Sync json authoritative retry flow', () => {
  it('rejects different geometry without altering approved files, then sends exact approved pointers and resets only on the device', async () => {
    await drop(points(0.046983402))
    const beforePoints = await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')
    const beforeMeta = await fs.readFile(getMetadataFilePathFor(folder, image.filename), 'utf8')
    const result = await syncChapterProcessed(input); expect(result.failed).toBe(1)
    const { sent, transport } = capture()
    const report = await sendStudioCropCorrections(input, result, transport, generation)
    expect(report).toMatchObject({ queued: 1, pending: 1, deviceApplied: 0, failed: [] })
    expect(JSON.parse(sent[0].body.pointersText).crops).toEqual(points().crops)
    expect(JSON.parse(sent[0].body.metadataText)).toEqual(metadata())
    expect(sent[0].body.sourceSha256).toBe(sha256('source'))
    expect(sent[0].body.visualSha256).toBe(sha256(sent[0].body.pointersText + '\n' + sent[0].body.metadataText))
    expect(await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')).toBe(beforePoints)
    expect(await fs.readFile(getMetadataFilePathFor(folder, image.filename), 'utf8')).toBe(beforeMeta)
    await sendStudioCropCorrections(input, result, transport, generation)
    expect(sent[1].body.revision).toBe(sent[0].body.revision)
  })
  it('applies valid current links without rewriting geometry and does not queue accepted pages', async () => {
    await drop(); const original = await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')
    const result = await syncChapterProcessed(input); expect(result.replaced).toBe(1)
    expect(storyLinksCurrent((await readImageMetadata(folder, image.filename))!, script)).toBe(true)
    const { sent, transport } = capture(); expect((await sendStudioCropCorrections(input, result, transport, generation)).queued).toBe(0)
    expect(sent).toHaveLength(0); expect(await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')).toBe(original)
  })
  it('accepts an exact round trip of Studio-approved filenames and skips it on the next sync', async () => {
    await writeImageMetadata(folder, image.filename, JSON.stringify(metadata(approvedFilename)))
    await drop(points(), linked(approvedFilename))
    const originalPoints = await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')
    const result = await syncChapterProcessed(input)
    expect(result).toMatchObject({ replaced: 1, failed: 0 })
    expect(JSON.parse((await readImageMetadata(folder, image.filename))!).crops[0].exportedFilename).toBe(approvedFilename)
    expect(await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')).toBe(originalPoints)
    const next = await syncChapterProcessed(input)
    expect(next).toMatchObject({ replaced: 0, skipped: 1, failed: 0 })
    expect(next.pages[0].reason).toBe('Story links already current.')
    const { sent, transport } = capture()
    expect((await sendStudioCropCorrections(input, next, transport, generation)).queued).toBe(0)
    expect(sent).toHaveLength(0)
  })
  it('previews links for approved filenames without changing either Studio file', async () => {
    await writeImageMetadata(folder, image.filename, JSON.stringify(metadata(approvedFilename)))
    await drop(points(), linked(approvedFilename))
    const beforePoints = await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')
    const beforeMeta = await readImageMetadata(folder, image.filename)
    expect(await syncChapterProcessed({ ...input, dryRun: true })).toMatchObject({ replaced: 1, failed: 0 })
    expect(await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')).toBe(beforePoints)
    expect(await readImageMetadata(folder, image.filename)).toBe(beforeMeta)
  })
  it('still accepts legacy phone filename normalization when it exactly matches approved visual metadata', async () => {
    await drop(points(), linked(legacyPhoneFilename))
    const beforePoints = await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')
    const result = await syncChapterProcessed(input)
    expect(result).toMatchObject({ replaced: 1, failed: 0 })
    const accepted = JSON.parse((await readImageMetadata(folder, image.filename))!)
    expect(accepted.crops[0]).toMatchObject(metadata().crops[0])
    expect(storyLinksCurrent(JSON.stringify(accepted), script, sha256('source'))).toBe(true)
    expect(await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')).toBe(beforePoints)
    expect(await syncChapterProcessed(input)).toMatchObject({ skipped: 1, failed: 0 })
  })
  it.each([
    { label: 'exact approved names', approved: approvedFilename, phone: approvedFilename },
    { label: 'legacy normalized names', approved: cutterFilename, phone: legacyPhoneFilename }
  ])('rejects geometry and description edits with $label', async ({ approved, phone }) => {
    await writeImageMetadata(folder, image.filename, JSON.stringify(metadata(approved)))
    const beforePoints = await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')
    const beforeMeta = await readImageMetadata(folder, image.filename)
    await drop(points(0.046983402), linked(phone))
    expect(await syncChapterProcessed(input)).toMatchObject({ replaced: 0, failed: 1 })
    const phoneMetadata = linked(phone)
    phoneMetadata.crops[0].description = 'A different person leaves the gate.'
    await drop(points(), phoneMetadata)
    expect(await syncChapterProcessed(input)).toMatchObject({ replaced: 0, failed: 1 })
    expect(await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')).toBe(beforePoints)
    expect(await readImageMetadata(folder, image.filename)).toBe(beforeMeta)
  })
  it('preserves approved filenames for restart story linking as well', async () => {
    await writeImageMetadata(folder, image.filename, JSON.stringify(metadata(approvedFilename)))
    await drop(points(), linked(approvedFilename))
    await fs.writeFile(path.join(getProcessedDir(folder), FETCH_MARKER), JSON.stringify({ restartRevision: generation.restartRevision }))
    expect(await syncChapterProcessed({ ...input, storyLinksOnly: false })).toMatchObject({ replaced: 1, failed: 0 })
    expect(JSON.parse((await readImageMetadata(folder, image.filename))!).crops[0].exportedFilename).toBe(approvedFilename)
  })
  it('continues canonicalizing filenames when importing new visual crops', async () => {
    await fs.unlink(getPointsFilePathFor(folder, image.filename))
    await fs.unlink(getMetadataFilePathFor(folder, image.filename))
    await drop(points(), metadata(approvedFilename))
    expect(await syncChapterProcessed({ ...input, storyLinksOnly: false })).toMatchObject({ imported: 1, failed: 0 })
    expect(JSON.parse((await readImageMetadata(folder, image.filename))!).crops[0].exportedFilename).toBe(cutterFilename)
  })
  it('includes approved pages with no Processed output and reports acknowledgements accurately', async () => {
    const result = await syncChapterProcessed(input), { transport } = capture(2)
    const report = await sendStudioCropCorrections(input, result, transport, generation)
    expect(report).toMatchObject({ queued: 1, pending: 0, deviceApplied: 2, failed: [] })
  })
  it('keeps corrections pending when one device applied them and another has not', async () => {
    const result = await syncChapterProcessed(input)
    const report = await sendStudioCropCorrections(input, result, { async publish() { return { applied: 1, pending: true } } }, generation)
    expect(report).toMatchObject({ queued: 1, pending: 1, deviceApplied: 1 })
  })
  it('does not accept an old script or fabricated references and does not mutate files in preview', async () => {
    const bad = linked(); bad.crops[0].scriptRefs = ['P9999']; await drop(points(), bad)
    const before = await readImageMetadata(folder, image.filename)
    expect((await syncChapterProcessed({ ...input, dryRun: true })).failed).toBe(1)
    expect(await readImageMetadata(folder, image.filename)).toBe(before)
    expect(storyLinksCurrent(JSON.stringify(linked()), 'A different script')).toBe(false)
  })
  it('preserves Studio files if sending a correction fails', async () => {
    await drop(points(0.05)); const before = await readImageMetadata(folder, image.filename)
    const result = await syncChapterProcessed(input)
    const report = await sendStudioCropCorrections(input, result, { async publish() { throw new Error('offline') } }, generation)
    expect(report.queued).toBe(0); expect(report.failed[0].reason).toBe('offline')
    expect(await readImageMetadata(folder, image.filename)).toBe(before)
  })
})


describe('Final Studio review wins over incoming phone files', () => {
  it.each(['geometry', 'descriptions', 'old script', 'malformed pointers'])('preserves completed reviewed work when incoming %s differs', async kind => {
    await writeImageMetadata(folder, image.filename, JSON.stringify(linked(approvedFilename)))
    await setDesktopReview(folder, true)
    const incoming = linked()
    if (kind === 'descriptions') incoming.crops[0].description = 'An obsolete phone description.'
    if (kind === 'old script') incoming.storyLinking.scriptSha256 = 'c'.repeat(64)
    await drop(kind === 'geometry' ? points(0.05) : points(), incoming)
    if (kind === 'malformed pointers') await fs.writeFile(path.join(getProcessedDir(folder), 'page_001', 'crop-pointers-ch002-p001.json'), '{')
    const beforePoints = await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')
    const beforeMeta = await readImageMetadata(folder, image.filename)
    const { sent, transport } = capture()
    for (const dryRun of [true, false, false]) {
      const result = await syncChapterProcessed({ ...input, dryRun })
      expect(result).toMatchObject({ skipped: 1, replaced: 0, failed: 0 })
      expect(result.pages[0].linkingRequired).toBeUndefined()
      if (!dryRun) expect(await sendStudioCropCorrections(input, result, transport, generation)).toMatchObject({ queued: 0, failed: [] })
    }
    expect(sent).toHaveLength(0)
    expect(await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')).toBe(beforePoints)
    expect(await readImageMetadata(folder, image.filename)).toBe(beforeMeta)
  })
  it('ignores obsolete geometry without an attachment failure, then accepts links for the approved crops', async () => {
    await setDesktopReview(folder, true)
    await drop(points(0.05))
    const beforePoints = await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')
    const beforeMeta = await readImageMetadata(folder, image.filename)
    const { sent, transport } = capture()
    const result = await syncChapterProcessed(input)
    expect(result).toMatchObject({ skipped: 1, replaced: 0, failed: 0 })
    expect(result.pages[0].linkingRequired).toBe(true)
    expect(await sendStudioCropCorrections(input, result, transport, generation)).toMatchObject({ queued: 1, pending: 1, failed: [] })
    await sendStudioCropCorrections(input, result, transport, generation)
    expect(sent[1].body.revision).toBe(sent[0].body.revision)
    expect(JSON.parse(sent[0].body.pointersText).crops).toEqual(points().crops)
    expect(await readImageMetadata(folder, image.filename)).toBe(beforeMeta)
    await drop(points(0.06))
    const retry = await syncChapterProcessed(input)
    await sendStudioCropCorrections(input, retry, transport, generation)
    expect(sent[2].body.revision).not.toBe(sent[0].body.revision)
    await drop()
    expect(await syncChapterProcessed(input)).toMatchObject({ replaced: 1, failed: 0 })
    const done = await syncChapterProcessed(input)
    expect(await sendStudioCropCorrections(input, done, transport, generation)).toMatchObject({ queued: 0, failed: [] })
    expect(await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')).toBe(beforePoints)
  })
  it('protects cropped chapters even without an explicit desktop review record', async () => {
    const output = path.join(root, folder, 'crops3', cutterFilename)
    await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, 'approved rendered pixels')
    await writeImageMetadata(folder, image.filename, JSON.stringify(linked()))
    await drop(points(0.05))
    expect(await syncChapterProcessed(input)).toMatchObject({ skipped: 1, failed: 0 })
    expect(await fs.readFile(output, 'utf8')).toBe('approved rendered pixels')
  })
  it('does not let a newly fetched phone review replace Studio review through a legacy sync caller', async () => {
    await setDesktopReview(folder, true)
    await writeImageMetadata(folder, image.filename, JSON.stringify(linked()))
    await drop(points(0.05))
    await fs.writeFile(path.join(getProcessedDir(folder), FETCH_MARKER), JSON.stringify({ reviewed: true, applied: false }))
    const before = await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')
    expect(await syncChapterProcessed({ ...input, storyLinksOnly: false })).toMatchObject({ skipped: 1, replaced: 0, failed: 0 })
    expect(await fs.readFile(getPointsFilePathFor(folder, image.filename), 'utf8')).toBe(before)
  })
  it('still requests new links after the English script changes', async () => {
    await setDesktopReview(folder, true)
    await writeImageMetadata(folder, image.filename, JSON.stringify(linked()))
    await fs.writeFile(path.join(root, folder, 'script.md'), 'The hero returns to the gate.')
    await drop()
    const result = await syncChapterProcessed(input)
    expect(result).toMatchObject({ skipped: 1, failed: 0 })
    expect(result.pages[0].linkingRequired).toBe(true)
    const { sent, transport } = capture()
    expect(await sendStudioCropCorrections(input, result, transport, generation)).toMatchObject({ queued: 1, failed: [] })
    expect(sent[0].body.scriptSha256).toBe(sha256('The hero returns to the gate.'))
  })
})
