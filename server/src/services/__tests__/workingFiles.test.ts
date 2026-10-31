import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { workingFiles } from '../workingFiles.js'
vi.mock('../../index.js', () => ({ prisma: {
  series: { findUnique: async () => ({ id: 's', title: 'Demo', rootFolder: 'Demo', chapters: [
    { id: 'one', number: 1, title: null, folderPath: 'Demo/Chapter 001', completedAt: null, scripts: [{ isPartEnd: true }] },
    { id: 'two', number: 2, title: null, folderPath: 'Demo/Chapter 002', completedAt: null, scripts: [] }
  ] }) },
  page: { updateMany: vi.fn() }, audioFile: { deleteMany: vi.fn() }, audioSection: { updateMany: vi.fn() }
} }))
const { cleanPartWorkingFiles } = await import('../partArchive.js')
let root: string
const previous = process.env.DOWNLOAD_ROOT
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'working-files-'))
  process.env.DOWNLOAD_ROOT = root
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  if (previous === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = previous
})
it('previews and removes working assets while preserving scripts, timelines and videos', async () => {
  const dir = path.join(root, 'Demo/Chapter 001')
  const keep = ['script.md', 'script.hi.md', 'script-timeline.md', 'script.txt', 'final.mp4']
  const remove = ['page.jpg', 'crops3/cut.png', 'crop_points3/page.json', 'crop_metadata3/page.txt', 'audio/section.wav', 'audio_hi/section.wav', 'state.json', '.deleted-pages/page.webp']
  for (const file of [...keep, ...remove]) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
    await fs.writeFile(path.join(dir, file), 'data')
  }
  expect(await workingFiles(dir)).toBe(remove.length * 4)
  expect(await fs.readFile(path.join(dir, 'state.json'), 'utf8')).toBe('data')
  expect(await workingFiles(dir, true)).toBe(remove.length * 4)
  for (const file of keep) expect(await fs.readFile(path.join(dir, file), 'utf8')).toBe('data')
  for (const file of remove) await expect(fs.access(path.join(dir, file))).rejects.toThrow()
  expect(await workingFiles(dir, true)).toBe(0)
})
it('rejects outside paths and symlinked parents without touching their contents', async () => {
  await fs.mkdir(path.join(root, 'real'))
  await fs.writeFile(path.join(root, 'real/state.json'), 'keep')
  await fs.symlink(path.join(root, 'real'), path.join(root, 'linked'))
  await expect(workingFiles(path.join(root, 'linked'), true)).rejects.toThrow('real directory')
  await expect(workingFiles(path.dirname(root), true)).rejects.toThrow('outside')
  expect(await fs.readFile(path.join(root, 'real/state.json'), 'utf8')).toBe('keep')
})

it('requires a fresh compressed copy and title, and cleans only the chosen Part', async () => {
  const series = path.join(root, 'Demo')
  for (const file of ['Chapter 001/page.jpg', 'Chapter 001/script.md', 'Chapter 002/page.jpg']) {
    await fs.mkdir(path.dirname(path.join(series, file)), { recursive: true })
    await fs.writeFile(path.join(series, file), 'data')
  }
  await expect(cleanPartWorkingFiles('s', 1, 'Demo')).rejects.toThrow('compressed video')
  await fs.mkdir(path.join(series, '_video2/Compressed'), { recursive: true })
  await fs.writeFile(path.join(series, '_video2/Compressed/final.mp4'), 'video')
  await expect(cleanPartWorkingFiles('s', 1, 'wrong')).rejects.toThrow('series title')
  expect(await cleanPartWorkingFiles('s', 1, 'Demo')).toEqual({ freedBytes: 4, chapters: 1 })
  expect(await fs.readFile(path.join(series, 'Chapter 001/script.md'), 'utf8')).toBe('data')
  expect(await fs.readFile(path.join(series, 'Chapter 002/page.jpg'), 'utf8')).toBe('data')
  expect(await fs.readFile(path.join(series, '_video2/Compressed/final.mp4'), 'utf8')).toBe('video')
  await fs.unlink(path.join(series, '_video2/Compressed/final.mp4'))
  await expect(cleanPartWorkingFiles('s', 1, 'Demo')).rejects.toThrow('compressed video')
})
