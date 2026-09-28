/**
 * Tests for exporting a reviewed page:
 * - finalize: reading order, contiguous ids, cutter-compatible filenames
 * - normalized points reproduce integer bounds through the cutter's rounding
 * - Processed naming (page numbers, chapter tokens, stems without numbers)
 * - the export gate (unfinished or stale review refused)
 * - a full export: files in Processed/ and Crops/, the Clipper 3.0 store,
 *   pixel-exact PNGs, the report, Sync json accepting the result, and a
 *   re-export moving the previous contents aside instead of deleting them
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import {
  buildMetadata,
  buildPointerFile,
  exportPage,
  finalizeCrops,
  getExportStatus,
  processedNames,
  roundTripErrors,
  ExportError,
  type FinalCrop
} from '../exportPage.js'
import { buildHandoff } from '../handoff.js'
import { importAnalysis } from '../analysisImport.js'
import { saveReview, startReview, type ReviewCrop } from '../reviewState.js'
import { syncChapterProcessed } from '../processedSync.js'

function reviewCrop(key: string, bounds: ReviewCrop['bounds'], reason = 'framed_reaction'): ReviewCrop {
  return {
    key, origin: 'chatgpt', reason, bounds,
    description: 'A sentence.', description_status: 'approved', disposition: 'kept',
    visual_evidence: '', gpt_flags: [], unknown_flags: [], acknowledged: [], note: ''
  }
}

describe('finalize', () => {
  it('orders top to bottom and left to right, numbers crop-01…, names like the cutter', () => {
    const final = finalizeCrops([
      reviewCrop('low', { x0: 0, y0: 3000, x1: 800, y1: 3500 }, 'Wide Landscape'),
      reviewCrop('right', { x0: 400, y0: 1005, x1: 800, y1: 1500 }, 'action_effects__review'),
      reviewCrop('left', { x0: 0, y0: 1000, x1: 400, y1: 1500 })
    ], 'bad_business', 'page_008.jpg')
    expect(final.map(c => [c.id, c.key, c.exportedFilename])).toEqual([
      ['crop-01', 'left', 'bad_business_page_008_01_framed_reaction.png'],
      ['crop-02', 'right', 'bad_business_page_008_02_action_effects_review.png'],
      ['crop-03', 'low', 'bad_business_page_008_03_wide_landscape.png']
    ])
  })

  it('writes metadata with exactly id, exportedFilename, description', () => {
    const final = finalizeCrops([reviewCrop('a', { x0: 0, y0: 0, x1: 10, y1: 10 })], 's', 'p_001.png')
    expect(Object.keys(buildMetadata(final).crops[0])).toEqual(['id', 'exportedFilename', 'description'])
  })
})

describe('normalized points', () => {
  it('reproduce every integer bound through the cutter\'s rounding, even on odd sizes', () => {
    let seed = 7
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
    for (const [W, H] of [[797, 13767], [720, 20011], [1080, 4400], [3, 7]]) {
      const final: FinalCrop[] = Array.from({ length: 60 }, (_, i) => {
        const x0 = rand(W - 1)
        const y0 = rand(H - 1)
        return { id: `crop-${i}`, key: `k${i}`, reason: 'r', description: 'd', exportedFilename: `f${i}.png`, bounds: { x0, y0, x1: x0 + 1 + rand(W - x0), y1: y0 + 1 + rand(H - y0) } }
      })
      expect(roundTripErrors(buildPointerFile(final, 'page.png', W, H), final, W, H)).toEqual([])
    }
  })

  it('writes rectangle points P1..P4 with at most nine decimals', () => {
    const final = finalizeCrops([reviewCrop('a', { x0: 1, y0: 3, x1: 7, y1: 9 })], 's', 'p_001.png')
    const [entry] = buildPointerFile(final, 'p_001.png', 7, 11).crops
    expect(entry.crop.points.map(p => p.id)).toEqual(['P1', 'P2', 'P3', 'P4'])
    expect(entry.crop.points[0]).toEqual({ id: 'P1', x: 0.142857143, y: 0.272727273 })
  })
})

describe('processedNames', () => {
  it('uses the page NUMBER and a 3-digit chapter', () => {
    expect(processedNames(6, 'page_008.jpg')).toEqual({ pageFolder: 'page_008', pointers: 'crop-pointers-ch006-p008.json', metadata: 'crop-metadata-ch006-p008.json' })
    expect(processedNames(12, 'ch12_3.png').pageFolder).toBe('page_003')
    expect(processedNames(10.5, '007.webp').pointers).toBe('crop-pointers-ch010.5-p007.json')
    expect(processedNames(1, 'cover.png')).toEqual({ pageFolder: 'cover', pointers: 'crop-pointers-ch001-pcover.json', metadata: 'crop-metadata-ch001-pcover.json' })
  })
})

// ============ Against real files ============

const SERIES = 'Bad Business'
const CHAPTER = 'Chapter 006'
const folderPath = `${SERIES}/${CHAPTER}`
const ctx = { folderPath, imageFilename: 'page_008.jpg', seriesSlug: 'bad_business', chapterNumber: 6 }
let root: string
let previousRoot: string | undefined

beforeEach(async () => {
  previousRoot = process.env.DOWNLOAD_ROOT
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crop-studio-export-'))
  process.env.DOWNLOAD_ROOT = root
})

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = previousRoot
  await fs.rm(root, { recursive: true, force: true })
})

/** A noisy 797×5000 JPEG page, packaged, imported, and reviewed to readiness. */
async function readyPage() {
  const W = 797
  const H = 5000
  const data = Buffer.alloc(W * H * 3)
  let seed = 3
  for (let i = 0; i < data.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; data[i] = seed & 0xff }
  const target = path.join(root, SERIES, CHAPTER, 'page_008.jpg')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await sharp(data, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 85 }).toFile(target)

  const { manifest } = await buildHandoff({ folderPath, imageFilename: 'page_008.jpg', seriesTitle: SERIES, seriesSlug: 'bad_business', chapterNumber: 6 })
  const candidate = (id: string, bounds: object, reason: string) => ({
    candidate_id: id, reason, bounds,
    description: 'A figure stands in a framed shot against a softly shaded and detailed background panel.',
    visual_evidence: 'framed', review_flags: []
  })
  const outcome = await importAnalysis(folderPath, 'page_008.jpg', JSON.stringify({
    schema_version: 'chatgpt-analysis/1.0', job_id: manifest.job_id, source_sha256: manifest.source.sha256,
    page_stem: 'page_008', source_width: W, source_height: H, coordinate_system: 'canonical_original_pixels',
    page_inspection_complete: true, page_review_flags: [],
    candidates: [
      candidate('b', { x0: 13, y0: 2201, x1: 790, y1: 2900 }, 'wide_scene'),
      candidate('a', { x0: 0, y0: 101, x1: 797, y1: 900 }, 'framed_reaction')
    ]
  }))
  expect(outcome.imported).toBe(true)

  const view = await startReview(folderPath, 'page_008.jpg', 'import', false)
  const tokens = new Map<string, string[]>()
  for (const item of view.items) tokens.set(item.key, [...(tokens.get(item.key) ?? []), item.token])
  const ready = await saveReview(folderPath, 'page_008.jpg', {
    ...view.state,
    crops: view.state!.crops.map(c => ({ ...c, disposition: 'kept', description_status: 'approved', acknowledged: tokens.get(c.key) ?? [] })),
    page: { sweep_done: true, no_eligible_artwork_confirmed: false, note: '' }
  }, 1)
  expect(ready.readiness).toEqual({ ready: true, blockers: [] })
  return { target, W, H }
}

describe('exportPage', () => {
  it('refuses an unfinished review, listing what is left', async () => {
    await readyPage()
    const view = await startReview(folderPath, 'page_008.jpg', 'import', true)
    const error = await exportPage(ctx).catch(e => e)
    expect(error).toBeInstanceOf(ExportError)
    expect((error as ExportError).blockers.length).toBeGreaterThan(0)
    expect(view.readiness.ready).toBe(false)
    await expect(fs.access(path.join(root, SERIES, 'Processed'))).rejects.toThrow()
  })

  it('exports pixel-exact PNGs, both JSONs and the store, and records it', async () => {
    const { target, W, H } = await readyPage()
    const report = await exportPage(ctx)

    expect(report.status).toBe('completed')
    expect(report.crops.map(c => [c.id, c.exportedFilename, c.width, c.height])).toEqual([
      ['crop-01', 'bad_business_page_008_01_framed_reaction.png', 797, 799],
      ['crop-02', 'bad_business_page_008_02_wide_scene.png', 777, 699]
    ])

    const processed = path.join(root, SERIES, 'Processed', CHAPTER, 'page_008')
    expect((await fs.readdir(processed)).sort()).toEqual(['crop-metadata-ch006-p008.json', 'crop-pointers-ch006-p008.json'])
    const pointers = JSON.parse(await fs.readFile(path.join(processed, 'crop-pointers-ch006-p008.json'), 'utf-8'))
    expect(Object.keys(pointers)).toEqual(['format', 'version', 'image', 'coordinateSystem', 'crops'])
    expect(pointers.image).toEqual({ filename: 'page_008.jpg', width: W, height: H })

    const crops = path.join(root, SERIES, 'Crops', CHAPTER, 'page_008')
    const png = path.join(crops, 'bad_business_page_008_02_wide_scene.png')
    const cut = await sharp(png).raw().toBuffer()
    const direct = await sharp(target).extract({ left: 13, top: 2201, width: 777, height: 699 }).raw().toBuffer()
    expect(cut.equals(direct)).toBe(true)

    const store = JSON.parse(await fs.readFile(path.join(root, SERIES, CHAPTER, 'crop_points3', 'page_008.json'), 'utf-8'))
    expect(store.crops).toEqual(pointers.crops)
    expect(await fs.readFile(path.join(root, SERIES, CHAPTER, 'crop_metadata3', 'page_008.txt'), 'utf-8'))
      .toBe(await fs.readFile(path.join(processed, 'crop-metadata-ch006-p008.json'), 'utf-8'))

    expect((await getExportStatus(folderPath, 'page_008.jpg')).upToDate).toBe(true)
  })

  it('produces a Processed folder that Sync json accepts as-is', async () => {
    const { W, H } = await readyPage()
    await exportPage(ctx)
    // Clear the store so Sync has a page to fill, then dry-run it.
    await fs.rm(path.join(root, SERIES, CHAPTER, 'crop_points3'), { recursive: true })
    await fs.rm(path.join(root, SERIES, CHAPTER, 'crop_metadata3'), { recursive: true })
    const result = await syncChapterProcessed({
      chapterId: 'c', chapterNumber: 6, folderPath, seriesSlug: 'bad_business',
      images: [{ filename: 'page_008.jpg', width: W, height: H }], dryRun: true
    })
    expect(result).toMatchObject({ ready: 1, failed: 0, skipped: 0 })
    expect(result.pages).toEqual([expect.objectContaining({ folder: 'page_008', status: 'ready', cropCount: 2 })])
  })

  it('moves previous contents aside on re-export instead of deleting them', async () => {
    await readyPage()
    const processed = path.join(root, SERIES, 'Processed', CHAPTER, 'page_008')
    await fs.mkdir(processed, { recursive: true })
    await fs.writeFile(path.join(processed, 'hand-made-notes.txt'), 'mine')

    const first = await exportPage(ctx)
    expect(first.replaced).toContain('replaced/processed')
    expect(await fs.readdir(processed)).not.toContain('hand-made-notes.txt')

    const exportsDir = path.join(root, SERIES, '.crop-studio', CHAPTER, 'page_008', 'exports')
    const [firstDir] = (await fs.readdir(exportsDir)).filter(n => n.startsWith('rev-'))
    expect(await fs.readFile(path.join(exportsDir, firstDir, 'replaced', 'processed', 'hand-made-notes.txt'), 'utf-8')).toBe('mine')

    await new Promise(r => setTimeout(r, 5))
    const second = await exportPage(ctx)
    expect(second.replaced).toEqual(expect.arrayContaining(['replaced/processed', 'replaced/crops', 'replaced/store']))
    expect(await fs.readFile(path.join(exportsDir, 'CURRENT'), 'utf-8')).toMatch(/^rev-0002-/)
  })

  it('is no longer up to date after the review changes, and refuses a changed page', async () => {
    const { target } = await readyPage()
    await exportPage(ctx)
    const view = await startReview(folderPath, 'page_008.jpg', 'import', true)
    expect(view.state?.review_revision).toBe(1)
    expect((await getExportStatus(folderPath, 'page_008.jpg')).upToDate).toBe(false)

    await fs.appendFile(target, Buffer.from([0]))
    await expect(exportPage(ctx)).rejects.toBeInstanceOf(ExportError)
  })
})
