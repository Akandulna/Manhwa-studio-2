/**
 * Tests for the chapter review that gates cropping:
 * - parsing the Master phone's `review` object out of chapter.json
 * - the review record on disk (missing, hand-edited, desktop mark/unmark)
 * - Sync json replacing attached pages once after a phone review, and only
 *   where the review actually changed them
 * - crops3/ reported out of date when a page's pointers change after its cut
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  CHAPTER_REVIEW_FILE,
  parseManifestReview,
  readChapterReview,
  setDesktopReview,
  writeChapterReview
} from '../chapterReview.js'
import { FETCH_MARKER, getProcessedDir, readFetchMarker, syncChapterProcessed } from '../processedSync.js'
import { chapterCropOutputs, getOutputDir, getPointsFilePathFor, readImagePoints, readImageMetadata } from '../perImageStore.js'

const FOLDER = 'Solo/Chapter 001'
const SLUG = 'solo'
const IMAGES = [
  { filename: 'page_001.png', width: 100, height: 200 },
  { filename: 'page_002.png', width: 100, height: 200 }
]

let root: string
let previousRoot: string | undefined

beforeEach(async () => {
  previousRoot = process.env.DOWNLOAD_ROOT
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'chapter-review-'))
  process.env.DOWNLOAD_ROOT = root
})

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = previousRoot
  await fs.rm(root, { recursive: true, force: true })
})

describe('parseManifestReview', () => {
  it('reads a Master phone review', () => {
    expect(parseManifestReview({
      chapter: 'Chapter 001',
      review: {
        reviewed: true,
        reviewed_at: '2026-10-11T10:00:00.000Z',
        device: 'Redmi Note 10 Pro',
        by: 'master',
        edited_pages: ['page_003', 'page_007'],
        moved_crops: 5,
        deleted_crops: 2
      }
    })).toEqual({
      reviewedAt: '2026-10-11T10:00:00.000Z',
      device: 'Redmi Note 10 Pro',
      editedPages: ['page_003', 'page_007'],
      movedCrops: 5,
      deletedCrops: 2
    })
  })

  it('treats anything short of reviewed: true as not reviewed', () => {
    expect(parseManifestReview({ chapter: 'x' })).toBeNull()
    expect(parseManifestReview({ review: { reviewed: false } })).toBeNull()
    expect(parseManifestReview({ review: { reviewed: 'true' } })).toBeNull()
    expect(parseManifestReview({ review: null })).toBeNull()
    expect(parseManifestReview(null)).toBeNull()
  })

  it('drops bad display fields rather than the review', () => {
    expect(parseManifestReview({
      review: { reviewed: true, reviewed_at: 'yesterday', device: 7, edited_pages: ['page_001', 3], moved_crops: -1, deleted_crops: 1.5 }
    })).toEqual({ reviewedAt: null, editedPages: ['page_001'], movedCrops: 0, deletedCrops: 0 })
  })
})

describe('review record', () => {
  it('reads as not reviewed when missing or not explicitly reviewed', async () => {
    expect(await readChapterReview(FOLDER)).toEqual({ reviewed: false, reviewedAt: null, by: null })
    const file = path.join(root, FOLDER, CHAPTER_REVIEW_FILE)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{"reviewed":"yes","by":"phone"}')
    expect((await readChapterReview(FOLDER)).reviewed).toBe(false)
    await fs.writeFile(file, 'not json')
    expect((await readChapterReview(FOLDER)).reviewed).toBe(false)
  })

  it('round-trips a phone review and is replaced by the desktop mark / unmark', async () => {
    await writeChapterReview(FOLDER, {
      reviewed: true, reviewedAt: '2026-10-11T10:00:00.000Z', by: 'phone', device: 'Redmi', etag: 'e1',
      editedPages: ['page_002'], movedCrops: 1, deletedCrops: 0
    })
    expect(await readChapterReview(FOLDER)).toMatchObject({ reviewed: true, by: 'phone', device: 'Redmi', etag: 'e1' })

    const marked = await setDesktopReview(FOLDER, true)
    expect(marked).toMatchObject({ reviewed: true, by: 'desktop' })
    expect(await readChapterReview(FOLDER)).toEqual(marked)

    await setDesktopReview(FOLDER, false)
    expect(await readChapterReview(FOLDER)).toEqual({ reviewed: false, reviewedAt: null, by: null })
  })
})

// ============ Sync json after a phone review ============

const crop = (id: string, y1: number, reason = 'panel') => ({
  id,
  reason,
  crop: {
    mode: 'rectangle',
    points: [
      { id: 'tl', x: 0, y: 0 },
      { id: 'tr', x: 1, y: 0 },
      { id: 'br', x: 1, y: y1 },
      { id: 'bl', x: 0, y: y1 }
    ]
  }
})

const metadata = (page: string, ids: string[], description = 'A panel.') => ({
  crops: ids.map((id, i) => ({ id, exportedFilename: `${SLUG}_${page}_${String(i + 1).padStart(2, '0')}_panel.png`, description }))
})

/** Writes one Processed/page_### folder, the way the phone zip unpacks. */
async function dropOff(page: string, pointersText: string, metadataText: string) {
  const dir = path.join(getProcessedDir(FOLDER), page)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `crop-pointers-ch001-${page}.json`), pointersText)
  await fs.writeFile(path.join(dir, `crop-metadata-ch001-${page}.json`), metadataText)
}

async function writeMarker(marker: object) {
  await fs.writeFile(path.join(getProcessedDir(FOLDER), FETCH_MARKER), JSON.stringify(marker))
}

const sync = (dryRun = false) => syncChapterProcessed({
  chapterId: 'c1', chapterNumber: 1, folderPath: FOLDER, seriesSlug: SLUG, images: IMAGES, dryRun
})

describe('syncChapterProcessed after a phone review', () => {
  beforeEach(async () => {
    // The clipping phone's draft, attached by an earlier Sync json.
    await dropOff('page_001', JSON.stringify({ crops: [crop('c1', 0.5)] }), JSON.stringify(metadata('page_001', ['c1'])))
    await dropOff('page_002', JSON.stringify({ crops: [crop('c1', 0.5), crop('c2', 0.9)] }), JSON.stringify(metadata('page_002', ['c1', 'c2'])))
    await writeMarker({ etag: 'draft', reviewed: false })
    expect((await sync()).imported).toBe(2)
  })

  it('leaves attached pages alone when the zip was not reviewed', async () => {
    await dropOff('page_002', JSON.stringify({ crops: [crop('c1', 0.3)] }), JSON.stringify(metadata('page_002', ['c1'])))
    const result = await sync()
    expect(result.pages.map(p => p.status)).toEqual(['skipped', 'skipped'])
    expect((await readImagePoints(FOLDER, 'page_002.png'))!.file!.crops).toHaveLength(2)
  })

  it('replaces only the pages the review changed, once', async () => {
    // page_001 untouched, but re-serialized by the phone (key order, spacing).
    const p1 = crop('c1', 0.5)
    await dropOff(
      'page_001',
      JSON.stringify({ crops: [{ crop: { points: p1.crop.points, mode: 'rectangle' }, reason: 'panel', id: 'c1' }] }, null, 4),
      JSON.stringify({ crops: [{ description: 'A panel.', exportedFilename: `${SLUG}_page_001_01_panel.png`, id: 'c1' }] })
    )
    // page_002: c1 moved, c2 deleted (metadata entry removed, names renumbered).
    await dropOff('page_002', JSON.stringify({ crops: [crop('c1', 0.3)] }), JSON.stringify(metadata('page_002', ['c1'])))
    await writeMarker({ etag: 'reviewed', reviewed: true, applied: false })

    // The preview names the replacement and writes nothing.
    const preview = await sync(true)
    expect(preview.pages.map(p => [p.folder, p.status])).toEqual([['page_001', 'skipped'], ['page_002', 'replaced']])
    expect(preview.replaced).toBe(1)
    expect((await readImagePoints(FOLDER, 'page_002.png'))!.file!.crops).toHaveLength(2)
    expect((await readFetchMarker(FOLDER))!.applied).toBe(false)

    const result = await sync()
    expect(result.pages.map(p => [p.folder, p.status, p.reason])).toEqual([
      ['page_001', 'skipped', 'Already attached.'],
      ['page_002', 'replaced', 'Reviewed on the phone.']
    ])
    expect(result).toMatchObject({ replaced: 1, imported: 0, skipped: 1, failed: 0 })
    const stored = (await readImagePoints(FOLDER, 'page_002.png'))!.file!
    expect(stored.crops.map(c => c.crop.points[2].y)).toEqual([0.3])
    expect(JSON.parse((await readImageMetadata(FOLDER, 'page_002.png'))!).crops.map((c: { id: string }) => c.id)).toEqual(['c1'])
    expect(await readFetchMarker(FOLDER)).toMatchObject({ etag: 'reviewed', reviewed: true, applied: true })

    // Applied: a desktop edit made afterwards is protected by the skip rule again.
    await fs.writeFile(getPointsFilePathFor(FOLDER, 'page_002.png'), JSON.stringify({ ...stored, crops: [crop('c1', 0.25)] }))
    const later = await sync()
    expect(later.pages.map(p => p.status)).toEqual(['skipped', 'skipped'])
    expect((await readImagePoints(FOLDER, 'page_002.png'))!.file!.crops[0].crop.points[2].y).toBe(0.25)
  })

  it('keeps the attached page when the review fails a check, and says why', async () => {
    await dropOff('page_002', JSON.stringify({ crops: [crop('c1', 0.3)] }), JSON.stringify(metadata('page_002', ['c1', 'c9'])))
    await writeMarker({ etag: 'reviewed', reviewed: true, applied: false })
    const result = await sync()
    expect(result.pages[1]).toMatchObject({ status: 'failed' })
    expect(result.pages[1].reason).toMatch(/^Reviewed on the phone, but not applied: /)
    expect((await readImagePoints(FOLDER, 'page_002.png'))!.file!.crops).toHaveLength(2)
  })
})

describe('chapterCropOutputs', () => {
  it('reports a page whose pointers changed after its cut, even with the same file names', async () => {
    await dropOff('page_001', JSON.stringify({ crops: [crop('c1', 0.5)] }), JSON.stringify(metadata('page_001', ['c1'])))
    await sync()
    const name = `${SLUG}_page_001_01_panel.png`
    await fs.mkdir(getOutputDir(FOLDER), { recursive: true })
    await fs.writeFile(path.join(getOutputDir(FOLDER), name), 'png')
    const pages = { slug: SLUG, filenames: ['page_001.png'] }

    // Cut before the pointers were last written.
    const past = new Date(Date.now() - 60_000)
    await fs.utimes(path.join(getOutputDir(FOLDER), name), past, past)
    expect(await chapterCropOutputs(FOLDER, [name], true, pages)).toMatchObject({ complete: false, changed: 1, missing: 0, extra: 0 })

    // Cut after.
    const future = new Date(Date.now() + 60_000)
    await fs.utimes(path.join(getOutputDir(FOLDER), name), future, future)
    expect(await chapterCropOutputs(FOLDER, [name], true, pages)).toMatchObject({ complete: true, changed: 0 })
  })
})
