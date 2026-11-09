import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const mocks = vi.hoisted(() => ({
  chapters: vi.fn(), state: vi.fn(), stitch: vi.fn(), profiles: vi.fn(), edges: vi.fn()
}))
vi.mock('../../index.js', () => ({ prisma: { chapter: { findMany: mocks.chapters } } }))
vi.mock('../pageStitch.js', () => ({
  chapterDir: (folder: string) => path.join(process.env.DOWNLOAD_ROOT!, folder),
  getStitchState: mocks.state, stitchChapter: mocks.stitch, STITCH_MAX_HEIGHT: 16383
}))
vi.mock('../stitchAnalysis.js', () => ({ profilePages: mocks.profiles }))
vi.mock('../stitchIntroOutro.js', () => ({ detectIntroOutro: mocks.edges }))
const { prepareLibrarySeries } = await import('../libraryPreparation.js')
const oldRoot = process.env.DOWNLOAD_ROOT
let root: string
const chapter = { id: 'c21', number: 21, folderPath: 'Demo/Chapter 021', status: 'done' }

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'library-preparation-'))
  process.env.DOWNLOAD_ROOT = root
})
afterAll(async () => {
  if (oldRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = oldRoot
  await fs.rm(root, { recursive: true, force: true })
})
beforeEach(async () => {
  vi.clearAllMocks()
  await fs.rm(path.join(root, 'Demo'), { recursive: true, force: true })
  await fs.mkdir(path.join(root, chapter.folderPath), { recursive: true })
  await fs.writeFile(path.join(root, chapter.folderPath, 'page_001.jpg'), 'manually stitched pixels')
  mocks.chapters.mockResolvedValue([chapter])
  mocks.state.mockResolvedValue({
    stitched: { version: 1, originalPages: null, stitchedPages: 1, stitchedAt: null },
    record: null, pages: [{ filename: 'page_001.jpg' }], blockers: ['Existing crop work']
  })
})

describe('library preparation for delivery', () => {
  it('keeps a completed manual stitch when its originals and undo record were deleted', async () => {
    await prepareLibrarySeries('s1', ['c21'])
    expect(mocks.profiles).not.toHaveBeenCalled()
    expect(mocks.edges).not.toHaveBeenCalled()
    expect(mocks.stitch).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(root, chapter.folderPath, 'page_001.jpg'), 'utf8')).toBe('manually stitched pixels')
    expect(JSON.parse(await fs.readFile(path.join(root, chapter.folderPath, '.library-prepared.json'), 'utf8')).version).toBe(1)
  })

  it('limits preparation to selected chapter IDs, leaving an earlier part alone', async () => {
    await fs.mkdir(path.join(root, 'Demo/Chapter 001'), { recursive: true })
    await fs.writeFile(path.join(root, 'Demo/Chapter 001/script.md'), 'finished Part 1')
    await prepareLibrarySeries('s1', ['c21'])
    expect(mocks.chapters).toHaveBeenCalledWith({
      where: { seriesId: 's1', status: 'done', completedAt: null, id: { in: ['c21'] } }, orderBy: { number: 'asc' }
    })
    expect(await fs.readdir(path.join(root, 'Demo/Chapter 001'))).toEqual(['script.md'])
  })

  it('still refuses to rewrite an unprepared chapter with crop work', async () => {
    mocks.state.mockResolvedValueOnce({ stitched: null, record: null, pages: [], blockers: ['Existing crop work'] })
    await expect(prepareLibrarySeries('s1')).rejects.toThrow('Existing crop work')
    expect(mocks.stitch).not.toHaveBeenCalled()
    await expect(fs.access(path.join(root, chapter.folderPath, '.library-prepared.json'))).rejects.toThrow()
  })

  it('skips chapters that already have the preparation marker', async () => {
    await fs.writeFile(path.join(root, chapter.folderPath, '.library-prepared.json'), '{}')
    await prepareLibrarySeries('s1')
    expect(mocks.state).not.toHaveBeenCalled()
  })
})
