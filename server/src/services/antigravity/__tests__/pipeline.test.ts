import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPointerFile, cropIdFor, ratio, readingOrder } from '../delivery.js'
import { ANTIGRAVITY_SLICE_HEIGHT, buildHandoff, preparePage, PreparationError } from '../preparation.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-pipeline-'))
afterAll(() => fs.rm(root, { recursive: true, force: true }))

/** A page with a different random colour per row band, so any misplaced pixel row is detectable. */
async function page(width: number, height: number, name = `p-${width}x${height}.png`) {
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    const [r, g, b] = crypto.randomBytes(3)
    for (let x = 0; x < width; x++) raw.set([r, (g + x) % 256, b], (y * width + x) * 3)
  }
  const file = path.join(root, name)
  await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(file)
  return file
}

describe('AntiGravity preparation (AG-05)', () => {
  it('tiles a tall page into 2000 px slices with a short final slice and identical pixels', async () => {
    const file = await page(120, 4345)
    const prepared = await preparePage(file, path.basename(file))
    expect(prepared.slices.map(s => [s.id, s.y0, s.y1])).toEqual([['s01', 0, 2000], ['s02', 2000, 4000], ['s03', 4000, 4345]])
    expect(prepared.slices.every(s => s.width === 120 && s.x0 === 0 && s.x1 === 120)).toBe(true)
    // Re-assemble the decoded slices and compare with the decoded source.
    const parts = await Promise.all(prepared.slices.map(s => sharp(s.data).ensureAlpha().raw().toBuffer()))
    const source = await sharp(await fs.readFile(file)).ensureAlpha().raw().toBuffer()
    expect(Buffer.concat(parts).equals(source)).toBe(true)
    expect(prepared.sourceSha256).toBe(crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'))
  })

  it('handles a page shorter than one slice and an exact multiple', async () => {
    const short = await preparePage(await page(50, 700), 'short.png')
    expect(short.slices).toHaveLength(1)
    expect(short.slices[0]).toMatchObject({ y0: 0, y1: 700, height: 700 })
    const exact = await preparePage(await page(40, ANTIGRAVITY_SLICE_HEIGHT * 2), 'exact.png')
    expect(exact.slices.map(s => s.height)).toEqual([2000, 2000])
  })

  it('refuses pages wider than 2000 px instead of resizing them', async () => {
    await expect(preparePage(await page(2001, 30), 'wide.png')).rejects.toMatchObject({ code: 'too_wide' })
    await expect(preparePage(path.join(root, 'missing.png'), 'missing.png')).rejects.toBeInstanceOf(PreparationError)
  })

  it('builds a handoff without image bytes, local paths or secrets', async () => {
    const file = await page(30, 2100)
    const prepared = await preparePage(file, 'page_001.png')
    const handoff = buildHandoff({ jobId: 'j1', seriesId: 's', seriesTitle: 'S', chapterId: 'c', chapterNumber: 3, chapterFolder: 'Chapter 003', filename: 'page_001.png', pageIndex: 0 }, prepared)
    const text = JSON.stringify(handoff)
    expect(handoff.slicing.slices).toHaveLength(2)
    expect(text).not.toContain(root)
    expect(text).not.toContain('"data"')
    expect(handoff.source).toMatchObject({ filename: 'page_001.png', width: 30, height: 2100, chapterFolder: 'Chapter 003' })
  })
})

describe('final pointer file (AG-12)', () => {
  it('converts a seam-spanning crop to one original-page rectangle (PRD §11.1 example)', () => {
    // 1000×3000 page; slice 2 starts at y=2048 in the PRD example — here the crop is already in page pixels.
    const { file } = buildPointerFile([{ reason: 'illustrated_shot', bounds: { x0: 100, y0: 1900, x1: 900, y1: 2200 } }], { filename: 'page_001.webp', width: 1000, height: 3000, sourceSha256: 'abc' })
    expect(file.crops).toHaveLength(1)
    expect(file.crops[0].crop.points).toEqual([
      { id: 'P1', x: 0.1, y: ratio(1900 / 3000) },
      { id: 'P2', x: 0.9, y: ratio(1900 / 3000) },
      { id: 'P3', x: 0.9, y: ratio(2200 / 3000) },
      { id: 'P4', x: 0.1, y: ratio(2200 / 3000) }
    ])
    expect(file).toMatchObject({ format: 'four-point-crop', version: '1.0', workflow: 'clipper-geometry/1', sourceSha256: 'abc', coordinateSystem: 'normalized' })
  })

  it('orders crops like the phone (rows within 12 px, then left to right) and numbers them crop-01…', () => {
    const order = readingOrder([
      { k: 'right', b: { x0: 500, y0: 105, x1: 900, y1: 300 } },
      { k: 'bottom', b: { x0: 0, y0: 400, x1: 900, y1: 600 } },
      { k: 'left', b: { x0: 0, y0: 100, x1: 400, y1: 300 } }
    ], i => i.b).map(i => i.k)
    expect(order).toEqual(['left', 'right', 'bottom'])
    expect(cropIdFor(0)).toBe('crop-01')
    expect(cropIdFor(11)).toBe('crop-12')
  })

  it('rounds ratios to 9 decimals and rejects out-of-bounds or empty boxes', () => {
    expect(ratio(1 / 3)).toBe(0.333333333)
    expect(() => buildPointerFile([{ reason: 'x', bounds: { x0: 0, y0: 0, x1: 1001, y1: 10 } }], { filename: 'a', width: 1000, height: 100, sourceSha256: 'h' })).toThrow(/outside/)
    expect(() => buildPointerFile([{ reason: 'x', bounds: { x0: 5, y0: 5, x1: 5, y1: 10 } }], { filename: 'a', width: 1000, height: 100, sourceSha256: 'h' })).toThrow(/positive/)
    expect(() => buildPointerFile([{ reason: 'x', bounds: { x0: 0.5, y0: 0, x1: 10, y1: 10 } }], { filename: 'a', width: 1000, height: 100, sourceSha256: 'h' })).toThrow(/whole pixels/)
    // Exclusive right/bottom may equal the page size.
    expect(() => buildPointerFile([{ reason: 'x', bounds: { x0: 0, y0: 0, x1: 1000, y1: 100 } }], { filename: 'a', width: 1000, height: 100, sourceSha256: 'h' })).not.toThrow()
  })
})

describe('Clipper import protection (AG-13, AG-19)', () => {
  let delivery: typeof import('../delivery.js')
  let store: typeof import('../../clipper3/perImageStore.js')
  let review: typeof import('../../clipper3/chapterReview.js')
  const folder = 'Series/Chapter 001'
  let sourceSha = ''
  const previousRoot = process.env.DOWNLOAD_ROOT

  beforeAll(async () => {
    process.env.DOWNLOAD_ROOT = path.join(root, 'library')
    delivery = await import('../delivery.js')
    store = await import('../../clipper3/perImageStore.js')
    review = await import('../../clipper3/chapterReview.js')
    const dir = store.getSourceFolderPath(folder)
    await fs.mkdir(dir, { recursive: true })
    const bytes = await sharp({ create: { width: 100, height: 200, channels: 3, background: '#ffffff' } }).png().toBuffer()
    await fs.writeFile(path.join(dir, 'page_001.png'), bytes)
    sourceSha = crypto.createHash('sha256').update(bytes).digest('hex')
  })
  afterAll(() => { process.env.DOWNLOAD_ROOT = previousRoot })

  const pointer = () => delivery.buildPointerFile([{ reason: 'illustrated_shot', bounds: { x0: 0, y0: 10, x1: 100, y1: 150 } }], { filename: 'page_001.png', width: 100, height: 200, sourceSha256: sourceSha }).file

  it('imports a candidate, is idempotent, and never marks the chapter reviewed or cropped', async () => {
    const first = await delivery.importPointerFile({ folderPath: folder, filename: 'page_001.png', pointer: pointer(), preexisting: 'none' })
    expect(first).toMatchObject({ state: 'imported', crops: 1 })
    const saved = await store.readImagePoints(folder, 'page_001.png')
    expect(saved?.file?.workflow).toBe('clipper-geometry/1')
    expect(saved?.file?.sourceSha256).toBe(sourceSha)
    expect(await delivery.importPointerFile({ folderPath: folder, filename: 'page_001.png', pointer: pointer(), preexisting: 'none' })).toEqual({ state: 'already_imported' })
    const chapterReview = await review.readEffectiveReview(folder)
    expect(chapterReview.reviewed).toBe(false)
    expect(chapterReview.cropped).toBe(false)
    await expect(fs.readdir(store.getMetadataDir(folder))).rejects.toThrow()
  })

  it('preserves different saved pointers as a conflict', async () => {
    const other = { ...pointer(), crops: pointer().crops.map(c => ({ ...c, reason: 'edited' })) }
    const outcome = await delivery.importPointerFile({ folderPath: folder, filename: 'page_001.png', pointer: other, preexisting: 'none' })
    expect(outcome.state).toBe('conflict')
    expect((await store.readImagePoints(folder, 'page_001.png'))?.file?.crops[0].reason).toBe('illustrated_shot')
  })

  it('rejects results for a source page that changed (stale)', async () => {
    const outcome = await delivery.importPointerFile({ folderPath: folder, filename: 'page_001.png', pointer: { ...pointer(), sourceSha256: 'f'.repeat(64) }, preexisting: 'none' })
    expect(outcome.state).toBe('stale')
  })
})
