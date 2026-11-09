/**
 * Tests for cutting a chapter after Sync json:
 * - only chapters reviewed on the Master phone are queued, and only once
 *   every page is attached
 * - a chapter whose crops3/ already matches is not cut again
 * - the cut reports over clipper3:crop-* with `auto: true`
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import type { Server } from 'socket.io'
import { queueAutoCrop, queueReviewedCrop, isChapterCropping, readChapterCropState, type CropChapter } from '../chapterCrop.js'
import { setDesktopReview, writeChapterReview } from '../chapterReview.js'
import { listOutputs, writeImageMetadata, writeImagePoints } from '../perImageStore.js'

const FOLDER = 'Solo/Chapter 001'
const SLUG = 'solo'
const CHAPTER: CropChapter = { id: 'ch1', number: 1, folderPath: FOLDER, seriesId: 's1', series: { title: 'Solo' } }
const PAGES = ['page_001.png', 'page_002.png']

let root: string
let previousRoot: string | undefined

/** Collects every event, and resolves `done` on the first crop-complete. */
function fakeIo() {
  const events: { name: string; payload: any }[] = []
  let finish: (payload: any) => void = () => {}
  const done = new Promise<any>(resolve => { finish = resolve })
  const io = {
    emit: (name: string, payload: any) => {
      events.push({ name, payload })
      if (name === 'clipper3:crop-complete') finish(payload)
      return true
    }
  } as unknown as Server
  return { io, events, done }
}

async function attach(filename: string) {
  const stem = path.parse(filename).name
  await writeImagePoints(FOLDER, filename, {
    format: 'four-point-crop',
    version: '1.0',
    image: { filename, width: 100, height: 200 },
    coordinateSystem: 'normalized',
    crops: [{
      id: 'c1',
      reason: 'panel',
      crop: {
        mode: 'rectangle',
        points: [
          { id: 'tl', x: 0, y: 0 },
          { id: 'tr', x: 1, y: 0 },
          { id: 'br', x: 1, y: 0.5 },
          { id: 'bl', x: 0, y: 0.5 }
        ]
      }
    }]
  })
  await writeImageMetadata(FOLDER, filename, JSON.stringify({
    crops: [{ id: 'c1', exportedFilename: `${SLUG}_${stem}_01_panel.png`, description: 'A panel.' }]
  }))
}

const phoneReview = () => writeChapterReview(FOLDER, {
  reviewed: true,
  reviewedAt: '2026-10-11T10:00:00.000Z',
  by: 'phone',
  device: 'Master'
})

beforeEach(async () => {
  previousRoot = process.env.DOWNLOAD_ROOT
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'chapter-crop-'))
  process.env.DOWNLOAD_ROOT = root
  const dir = path.join(root, FOLDER)
  await fs.mkdir(dir, { recursive: true })
  for (const page of PAGES) {
    await sharp({ create: { width: 100, height: 200, channels: 3, background: '#336699' } }).png().toFile(path.join(dir, page))
  }
})

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = previousRoot
  await fs.rm(root, { recursive: true, force: true })
})

describe('queueAutoCrop', () => {
  it('cuts a chapter reviewed on the phone once every page is attached', async () => {
    await phoneReview()
    await attach('page_001.png')

    // One page still pending: not cut.
    const early = fakeIo()
    expect(await queueAutoCrop(early.io, [CHAPTER])).toEqual([])

    await attach('page_002.png')
    const { io, events, done } = fakeIo()
    expect(await queueAutoCrop(io, [CHAPTER])).toEqual([{ chapterId: 'ch1', chapterNumber: 1 }])

    const complete = await done
    expect(complete).toMatchObject({ chapterId: 'ch1', seriesId: 's1', auto: true, images: 2, exported: 2, failed: 0 })
    expect(events.filter(e => e.name === 'clipper3:crop-progress').map(e => e.payload.filename)).toEqual(PAGES)
    expect((await listOutputs(FOLDER)).map(f => f.filename)).toEqual([
      `${SLUG}_page_001_01_panel.png`,
      `${SLUG}_page_002_01_panel.png`
    ])
    expect((await readChapterCropState(CHAPTER)).outputs.complete).toBe(true)

    // Already matching: a second sync queues nothing.
    expect(await queueAutoCrop(fakeIo().io, [CHAPTER])).toEqual([])
  })

  async function attachEmpty(filename: string) {
    await writeImagePoints(FOLDER, filename, {
      format: 'four-point-crop', version: '1.0', image: { filename },
      coordinateSystem: 'normalized', crops: []
    })
    await writeImageMetadata(FOLDER, filename, '{"crops":[]}')
  }

  it('cuts a chapter with an explicitly empty crop list on one page', async () => {
    await phoneReview()
    await attach(PAGES[0])
    await attachEmpty(PAGES[1])
    expect((await readChapterCropState(CHAPTER)).fullyAttached).toBe(true)
    const { io, done } = fakeIo()
    expect(await queueAutoCrop(io, [CHAPTER])).toHaveLength(1)
    expect(await done).toMatchObject({ images: 2, exported: 1, failed: 0 })
    expect((await readChapterCropState(CHAPTER)).outputs.complete).toBe(true)
  })

  it('accepts a chapter with no crops on any page', async () => {
    for (const filename of PAGES) await attachEmpty(filename)
    expect((await readChapterCropState(CHAPTER)).outputs).toMatchObject({ complete: true, files: 0 })
  })

  it('keeps malformed nonempty crop lists pending', async () => {
    await attach(PAGES[0])
    await writeImagePoints(FOLDER, PAGES[1], {
      format: 'four-point-crop', version: '1.0', image: { filename: PAGES[1] },
      coordinateSystem: 'normalized',
      crops: [{ id: 'bad', reason: '', crop: { mode: 'rectangle', points: [] } }]
    })
    await writeImageMetadata(FOLDER, PAGES[1], '{"crops":[]}')
    expect((await readChapterCropState(CHAPTER)).fullyAttached).toBe(false)
  })

  it('leaves chapters reviewed on the desktop, or not at all, for Crop', async () => {
    for (const page of PAGES) await attach(page)
    expect(await queueAutoCrop(fakeIo().io, [CHAPTER])).toEqual([])

    await setDesktopReview(FOLDER, true)
    expect(await queueAutoCrop(fakeIo().io, [CHAPTER])).toEqual([])
    expect(await listOutputs(FOLDER)).toEqual([])
  })
})


describe('reviewed bulk cropping', () => {
  it('cuts desktop-reviewed chapters once, leaving current crops unchanged on retry', async () => {
    for (const page of PAGES) await attach(page)
    await setDesktopReview(FOLDER, true)
    const { io, done } = fakeIo()
    expect((await queueReviewedCrop(io, [CHAPTER])).queued).toEqual([{ chapterId: 'ch1', chapterNumber: 1 }])
    expect(await done).toMatchObject({ auto: false, images: 2, exported: 2, failed: 0 })
    expect((await readChapterCropState(CHAPTER)).outputs.complete).toBe(true)
    expect((await queueReviewedCrop(io, [CHAPTER])).queued).toEqual([])
  })

  it('skips unreviewed and partially attached chapters, including desktop reviews', async () => {
    await attach(PAGES[0])
    expect((await queueReviewedCrop(fakeIo().io, [CHAPTER])).queued).toEqual([])
    await setDesktopReview(FOLDER, true)
    const result = await queueReviewedCrop(fakeIo().io, [CHAPTER])
    expect(result.queued).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(isChapterCropping(CHAPTER.id)).toBe(false)
    expect(await listOutputs(FOLDER)).toEqual([])
  })

  it('reserves chapters before asynchronous admission checks and shares the automatic queue', async () => {
    for (const page of PAGES) await attach(page)
    await phoneReview()
    const { io, done } = fakeIo()
    const results = await Promise.all([
      queueReviewedCrop(io, [CHAPTER, CHAPTER]),
      queueReviewedCrop(io, [CHAPTER]),
      queueAutoCrop(io, [CHAPTER])
    ])
    expect(results[0]).toMatchObject({ queued: [{ chapterId: 'ch1' }], skipped: [{ chapterId: 'ch1' }] })
    expect(results[1]).toMatchObject({ queued: [], skipped: [{ reason: 'Already queued or cropping' }] })
    expect(results[2]).toEqual([])
    expect(await done).toMatchObject({ failed: 0, auto: false })
  })
})
