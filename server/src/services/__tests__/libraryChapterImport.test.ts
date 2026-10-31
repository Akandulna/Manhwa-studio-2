import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const data = vi.hoisted(() => ({ root: '', completed: false, send: null as any, get: vi.fn() }))
vi.mock('../../index.js', () => ({ prisma: {
  chapter: {
    findUnique: async () => ({ id: 'c', folderPath: 'Demo/Chapter 001', completedAt: data.completed ? new Date() : null, phoneSend: data.send }),
    findMany: async () => [{ id: 'c', number: 1, folderPath: 'Demo/Chapter 001' }],
    update: vi.fn()
  },
  series: { findUnique: async () => ({ id: 's', rootFolder: 'Demo' }) },
  page: { deleteMany: vi.fn(), create: vi.fn() },
  phoneChapterSend: { upsert: async ({ update }: any) => { data.send = update } }
} }))
vi.mock('../r2Service.js', () => ({ getR2Config: () => ({ bucket: 'test' }), createClient: () => ({ send: data.get, destroy: vi.fn() }), invalidateStorage: vi.fn() }))
vi.mock('../phoneSend.js', () => ({
  chapterFingerprint: () => 'fingerprint',
  phoneZipFolder: vi.fn(),
  chapterPages: async (folder: string) => {
    const dir = path.join(data.root, folder)
    const names = (await fs.readdir(dir).catch(() => [])).filter(n => n.endsWith('.jpg'))
    return Promise.all(names.map(async name => ({ name, size: (await fs.stat(path.join(dir, name))).size })))
  }
}))
vi.mock('../../utils/zipReader.js', () => ({ readZip: () => [{ name: 'Demo/Chapter 001/page_001.jpg', data: Buffer.from('prepared pages') }] }))
vi.mock('../libraryControls.js', () => ({ isLibraryDeleted: async () => false }))
const { importLibraryChapter } = await import('../phonePull.js')
const remote = { name: 'Chapter 001', number: 1, key: 'manhwa/Demo/Chapter 001.zip', etag: 'new', sentAt: '2026-10-15T10:00:00.000Z' }
const series = { folder: 'Demo', title: 'Demo', chapters: [remote] }

beforeAll(async () => { data.root = await fs.mkdtemp(path.join(os.tmpdir(), 'library-import-')); process.env.DOWNLOAD_ROOT = data.root })
afterAll(async () => { await fs.rm(data.root, { recursive: true, force: true }) })
beforeEach(async () => {
  await fs.rm(path.join(data.root, 'Demo'), { recursive: true, force: true })
  const dir = path.join(data.root, 'Demo/Chapter 001')
  await fs.mkdir(path.join(dir, 'audio'), { recursive: true })
  await fs.writeFile(path.join(dir, 'old.jpg'), 'original pages')
  await fs.writeFile(path.join(dir, 'script.md'), 'keep script')
  await fs.writeFile(path.join(dir, 'audio/section.wav'), 'keep audio')
  data.completed = false; data.send = null
  data.get.mockReset().mockResolvedValue({ ContentLength: 10, Body: { transformToByteArray: async () => Buffer.alloc(10) } })
})

describe('automatic prepared chapter import', () => {
  it('replaces chapter pages while preserving local production work, and skips the same version on replay', async () => {
    await importLibraryChapter('s', series, remote)
    const dir = path.join(data.root, 'Demo/Chapter 001')
    expect(await fs.readFile(path.join(dir, 'page_001.jpg'), 'utf8')).toBe('prepared pages')
    expect(await fs.readFile(path.join(dir, 'script.md'), 'utf8')).toBe('keep script')
    expect(await fs.readFile(path.join(dir, 'audio/section.wav'), 'utf8')).toBe('keep audio')
    expect(await fs.stat(path.join(dir, 'old.jpg')).catch(() => null)).toBeNull()
    await importLibraryChapter('s', series, remote)
    expect(data.get).toHaveBeenCalledTimes(1)
  })

  it('restores the existing chapter if installing the staged pages fails', async () => {
    const rename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('.pull-tmp')) throw new Error('Install failed')
      return rename(from, to)
    })
    try {
      await expect(importLibraryChapter('s', series, remote)).rejects.toThrow('Install failed')
      expect(await fs.readFile(path.join(data.root, 'Demo/Chapter 001/old.jpg'), 'utf8')).toBe('original pages')
      expect(await fs.readFile(path.join(data.root, 'Demo/Chapter 001/script.md'), 'utf8')).toBe('keep script')
    } finally { spy.mockRestore() }
  })

  it('does not resurrect a chapter deliberately completed and removed on the Mac', async () => {
    data.completed = true
    await importLibraryChapter('s', series, remote)
    expect(data.get).not.toHaveBeenCalled()
  })
})
