import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import sharp from 'sharp'

const db = vi.hoisted(() => ({
  page: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  chapter: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
  $transaction: vi.fn()
}))
vi.mock('../../index.js', () => ({ prisma: db }))
vi.mock('../managedCropProjection.js', () => ({
  withUnmanagedCropChapter: (_folder: string, run: () => Promise<unknown>) => run()
}))

const { stitchChapter, discardBackup, undoStitch, getStitchState, readRecord } = await import('../pageStitch.js')
const { readStitchCompletion, saveStitchCompletion, STITCH_COMPLETION_FILE } = await import('../stitchCompletion.js')
const chapter = { id: 'c', folderPath: 'Demo/Chapter 001', status: 'done' }
const oldRoot = process.env.DOWNLOAD_ROOT
let root: string
let dir: string
let original: Buffer

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'stitch-completion-'))
  process.env.DOWNLOAD_ROOT = root
  dir = path.join(root, chapter.folderPath)
  original = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#ff0000' } }).png().toBuffer()
})
afterAll(async () => {
  if (oldRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = oldRoot
  await fs.rm(root, { recursive: true, force: true })
})
beforeEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'page_001.png'), original)
  await fs.writeFile(path.join(dir, 'page_002.png'), original)
  db.page.findMany.mockResolvedValue([0, 1].map(index => ({
    index, sourceUrl: `https://example.test/${index}`, localPath: `${chapter.folderPath}/page_00${index + 1}.png`, status: 'done', bytes: original.length
  })))
  db.chapter.findUniqueOrThrow.mockResolvedValue({ pageCount: 2, downloadedCount: 2 })
  db.$transaction.mockResolvedValue([])
})

async function stitch() {
  return stitchChapter(chapter, [['page_001.png', 'page_002.png']])
}

describe('persistent stitching completion', () => {
  async function restitch() {
    const state = await getStitchState(chapter)
    return stitchChapter(chapter, [
      [{ file: state.pages[0].filename, top: 0, bottom: 30 }],
      [{ file: state.pages[0].filename, top: 30, bottom: 60 }]
    ], true)
  }

  it('stitches current pages again after originals have been deleted, and undoes to their exact bytes and status', async () => {
    const first = await stitch()
    await discardBackup(chapter)
    const before = await getStitchState(chapter)
    const image = await fs.readFile(path.join(dir, first.outputs[0].filename))
    const second = await restitch()
    expect(second.outputs.map(p => p.height)).toEqual([30, 30])
    expect(second.previousStitch).toEqual({ completion: before.stitched, hasBackup: false })
    expect(await fs.readFile(path.join(dir, '.stitch-originals', first.outputs[0].filename))).toEqual(image)
    await undoStitch(chapter)
    expect(await readStitchCompletion(chapter.folderPath)).toEqual(before.stitched)
    expect(await readRecord(chapter.folderPath)).toBeNull()
    expect(await fs.readFile(path.join(dir, first.outputs[0].filename))).toEqual(image)
  })

  it('preserves earlier originals through repeated stitches and successive undo', async () => {
    const first = await stitch()
    const firstState = await getStitchState(chapter)
    const image = await fs.readFile(path.join(dir, first.outputs[0].filename))
    const second = await restitch()
    expect(second.previousStitch?.hasBackup).toBe(true)
    const secondCompletion = await readStitchCompletion(chapter.folderPath)
    await stitchChapter(chapter, [second.outputs.map(p => p.filename)], true)
    await undoStitch(chapter)
    expect(await readRecord(chapter.folderPath)).toEqual(second)
    expect(await readStitchCompletion(chapter.folderPath)).toEqual(secondCompletion)
    await undoStitch(chapter)
    expect(await readRecord(chapter.folderPath)).toEqual(first)
    expect(await readStitchCompletion(chapter.folderPath)).toEqual(firstState.stitched)
    expect(await fs.readFile(path.join(dir, first.outputs[0].filename))).toEqual(image)
    await undoStitch(chapter)
    expect(await readStitchCompletion(chapter.folderPath)).toBeNull()
    expect(await fs.readFile(path.join(dir, 'page_001.png'))).toEqual(original)
    expect(await fs.readFile(path.join(dir, 'page_002.png'))).toEqual(original)
  })

  it.each([true, false])('restores the prior chapter when a restitch database write fails (backup: %s)', async hasBackup => {
    const first = await stitch()
    if (!hasBackup) await discardBackup(chapter)
    const before = await getStitchState(chapter)
    const image = await fs.readFile(path.join(dir, first.outputs[0].filename))
    db.$transaction.mockRejectedValueOnce(new Error('restitch failed'))
    await expect(restitch()).rejects.toThrow('restitch failed')
    expect(await getStitchState(chapter)).toEqual(before)
    expect(await fs.readFile(path.join(dir, first.outputs[0].filename))).toEqual(image)
    if (hasBackup) expect(await fs.readFile(path.join(dir, '.stitch-originals/page_001.png'))).toEqual(original)
  })

  it('rolls back partially moved restitch outputs without losing the old backup', async () => {
    const first = await stitch()
    const before = await getStitchState(chapter)
    const image = await fs.readFile(path.join(dir, first.outputs[0].filename))
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === path.join(dir, '.stitch-tmp/page_002.webp')) throw new Error('swap failed')
      return rename(from, to)
    })
    await expect(restitch()).rejects.toThrow('swap failed')
    expect(await getStitchState(chapter)).toEqual(before)
    expect(await fs.readFile(path.join(dir, first.outputs[0].filename))).toEqual(image)
    expect(await fs.readFile(path.join(dir, '.stitch-originals/page_001.png'))).toEqual(original)
  })

  it('retains all restitch history when undo fails', async () => {
    await stitch()
    const second = await restitch()
    const before = await getStitchState(chapter)
    const images = await Promise.all(second.outputs.map(p => fs.readFile(path.join(dir, p.filename))))
    db.$transaction.mockRejectedValueOnce(new Error('undo failed'))
    await expect(undoStitch(chapter)).rejects.toThrow('undo failed')
    expect(await getStitchState(chapter)).toEqual(before)
    expect(await Promise.all(second.outputs.map(p => fs.readFile(path.join(dir, p.filename))))).toEqual(images)
    expect(await fs.readFile(path.join(dir, '.stitch-originals/.previous/page_001.png'))).toEqual(original)
  })

  it('keeps parked backups from an interrupted restitch instead of deleting them on a later attempt', async () => {
    await stitch()
    const state = await getStitchState(chapter)
    await fs.rename(path.join(dir, '.stitch-originals'), path.join(dir, '.stitch-previous'))
    expect((await getStitchState(chapter)).blockers[0]).toContain('interrupted')
    await expect(restitch()).rejects.toThrow('interrupted')
    await expect(discardBackup(chapter)).rejects.toThrow('interrupted')
    expect(await fs.readFile(path.join(dir, '.stitch-previous/page_001.png'))).toEqual(original)
    expect(await readStitchCompletion(chapter.folderPath)).toEqual(state.stitched)
  })

  it('keeps preceding backups parked by an interrupted undo', async () => {
    await stitch()
    await restitch()
    await fs.mkdir(path.join(dir, '.stitch-undo'))
    await fs.rename(path.join(dir, '.stitch-originals/.previous'), path.join(dir, '.stitch-undo/.previous'))
    await expect(undoStitch(chapter)).rejects.toThrow('interrupted')
    await expect(discardBackup(chapter)).rejects.toThrow('interrupted')
    expect(await fs.readFile(path.join(dir, '.stitch-undo/.previous/page_001.png'))).toEqual(original)
  })

  it('deletes all retained backups only on explicit discard, keeping completion', async () => {
    await stitch()
    const second = await restitch()
    await discardBackup(chapter)
    expect(await readRecord(chapter.folderPath)).toBeNull()
    expect((await readStitchCompletion(chapter.folderPath))?.stitchedAt).toEqual(second.stitchedAt)
    expect(await fs.readdir(dir)).not.toContain('.stitch-originals')
  })

  it('rejects stale restitch requests, invalid plans and existing crop data without changing the chapter', async () => {
    await expect(stitchChapter(chapter, [['page_001.png']], true)).rejects.toThrow('status changed')
    const first = await stitch()
    const before = await getStitchState(chapter)
    await expect(stitchChapter(chapter, [['missing.png']], true)).rejects.toThrow('not a page')
    expect(await getStitchState(chapter)).toEqual(before)
    const { getPointsDir } = await import('../clipper3/perImageStore.js')
    const points = getPointsDir(chapter.folderPath)
    await fs.mkdir(points, { recursive: true })
    await fs.writeFile(path.join(points, 'page_001.json'), '{}')
    await expect(stitchChapter(chapter, [[first.outputs[0].filename]], true)).rejects.toThrow('crop points')
    expect(await readRecord(chapter.folderPath)).toEqual(first)
    expect(await readStitchCompletion(chapter.folderPath)).toEqual(before.stitched)
  })

  it('retains completion and exact stitched bytes after deleting originals', async () => {
    const record = await stitch()
    const image = await fs.readFile(path.join(dir, record.outputs[0].filename))
    await discardBackup(chapter)
    expect(await readRecord(chapter.folderPath)).toBeNull()
    expect(await fs.readdir(dir)).not.toContain('.stitch-originals')
    expect(await readStitchCompletion(chapter.folderPath)).toEqual({
      version: 1, originalPages: 2, stitchedPages: 1, stitchedAt: record.stitchedAt
    })
    const state = await getStitchState(chapter)
    expect(state.record).toBeNull()
    expect(state.stitched?.stitchedPages).toBe(1)
    expect(state.backupBytes).toBe(0)
    expect(await fs.readFile(path.join(dir, record.outputs[0].filename))).toEqual(image)
    await expect(undoStitch(chapter)).rejects.toThrow('no stitch to undo')
    await expect(stitchChapter(chapter, [[record.outputs[0].filename]])).rejects.toThrow('originals have been deleted')
  })

  it('reads legacy backup records and preserves their completion when discarded', async () => {
    const record = await stitch()
    await fs.rm(path.join(dir, STITCH_COMPLETION_FILE))
    expect((await readStitchCompletion(chapter.folderPath))?.originalPages).toBe(2)
    await discardBackup(chapter)
    expect((await readStitchCompletion(chapter.folderPath))?.stitchedAt).toBe(record.stitchedAt)
  })

  it('keeps completion when originals are removed outside Studio', async () => {
    await stitch()
    await fs.rm(path.join(dir, '.stitch-originals'), { recursive: true })
    expect((await getStitchState(chapter)).stitched?.originalPages).toBe(2)
  })

  it('restores originals and clears completion on undo, permitting a new stitch', async () => {
    await stitch()
    await undoStitch(chapter)
    expect(await readStitchCompletion(chapter.folderPath)).toBeNull()
    expect(await readRecord(chapter.folderPath)).toBeNull()
    expect(await fs.readFile(path.join(dir, 'page_001.png'))).toEqual(original)
    expect(await fs.readFile(path.join(dir, 'page_002.png'))).toEqual(original)
    await expect(stitch()).resolves.toMatchObject({ originals: ['page_001.png', 'page_002.png'] })
  })

  it('rolls back images and completion if the database transaction fails', async () => {
    db.$transaction.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(stitch()).rejects.toThrow('database unavailable')
    expect(await readStitchCompletion(chapter.folderPath)).toBeNull()
    expect(await readRecord(chapter.folderPath)).toBeNull()
    expect(await fs.readFile(path.join(dir, 'page_001.png'))).toEqual(original)
    expect(await fs.readFile(path.join(dir, 'page_002.png'))).toEqual(original)
  })

  it('retains backup, completion and stitched pages if undo fails', async () => {
    const record = await stitch()
    db.$transaction.mockRejectedValueOnce(new Error('undo failed'))
    await expect(undoStitch(chapter)).rejects.toThrow('undo failed')
    expect(await readRecord(chapter.folderPath)).toEqual(record)
    expect((await readStitchCompletion(chapter.folderPath))?.stitchedPages).toBe(1)
    expect(await fs.readFile(path.join(dir, '.stitch-originals/page_001.png'))).toEqual(original)
    expect(await fs.stat(path.join(dir, record.outputs[0].filename))).toBeDefined()
  })

  it('does not delete legacy originals if saving persistent status fails', async () => {
    await stitch()
    await fs.rm(path.join(dir, STITCH_COMPLETION_FILE))
    // A filesystem failure at the atomic rename must happen before backup removal.
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(STITCH_COMPLETION_FILE)) throw new Error('status write failed')
      return rename(from, to)
    })
    await expect(discardBackup(chapter)).rejects.toThrow('status write failed')
    expect(await fs.readFile(path.join(dir, '.stitch-originals/page_001.png'))).toEqual(original)
    expect(await readRecord(chapter.folderPath)).not.toBeNull()
  })

  it('can restore confirmed legacy completion without inventing counts or dates', async () => {
    const completion = {
      version: 1 as const, originalPages: null, stitchedPages: 2, stitchedAt: null,
      recoveredAt: new Date().toISOString()
    }
    await saveStitchCompletion(chapter.folderPath, completion)
    expect((await getStitchState(chapter)).stitched).toEqual(completion)
    expect(await readRecord(chapter.folderPath)).toBeNull()
  })

  it('does not infer completion from a normal chapter with a small page count', async () => {
    expect(await readStitchCompletion(chapter.folderPath)).toBeNull()
    expect((await getStitchState(chapter)).stitched).toBeNull()
  })

  it('ignores malformed completion markers', async () => {
    for (const value of ['broken json', '{"version":1,"stitchedPages":0}', '{"version":1,"stitchedPages":2,"originalPages":-1,"stitchedAt":null}']) {
      await fs.writeFile(path.join(dir, STITCH_COMPLETION_FILE), value)
      expect(await readStitchCompletion(chapter.folderPath)).toBeNull()
    }
  })
})
