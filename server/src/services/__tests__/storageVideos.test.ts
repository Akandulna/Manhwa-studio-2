import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

vi.mock('../../index.js', () => ({ prisma: { series: {
  findUnique: async () => ({ id: 's', rootFolder: 'Demo' }),
  findMany: async () => [{ id: 's', title: 'Demo', rootFolder: 'Demo', chapters: [] }]
} } }))

const { deleteCompressedSeriesVideos, scanStorage, removeWithin } = await import('../storageService.js')
let root: string
const previousRoot = process.env.DOWNLOAD_ROOT
const write = async (file: string, data = 'video') => {
  const target = path.join(root, 'Demo', file)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, data)
}
const read = (file: string) => fs.readFile(path.join(root, 'Demo', file), 'utf8')

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-videos-'))
  process.env.DOWNLOAD_ROOT = root
})
beforeEach(async () => {
  await fs.rm(path.join(root, 'Demo'), { recursive: true, force: true })
  await write('_video2/ch001_demo.mp4', 'original')
})
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
  if (previousRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = previousRoot
})

describe('render cleanup after compression', () => {
  it.each(['compressed', 'Compressed', 'Compress'])('detects %s and keeps its video when deleting direct renders', async name => {
    await write(`_video2/${name}/Finished cut.MP4`, 'compressed')
    await write('_video2/ch002_demo.MP4', 'render two')
    await write('_video2/ch003_demo.mp4.partial', 'rendering')
    await write('_video2/notes.txt', 'notes')
    await write('_video2/nested/ch004_demo.mp4', 'nested')
    await write('_video2_hi/ch001_demo.mp4', 'hindi')
    const overview = await scanStorage()
    expect(overview.series[0].videoCleanupFolders.find(f => f.dir === '_video2')).toEqual({
      dir: '_video2', compressedVideos: [`${name}/Finished cut.MP4`], renderedFileCount: 2, renderedBytes: 18
    })
    expect(await deleteCompressedSeriesVideos('s', '_video2')).toEqual({ freedBytes: 18, deletedFiles: 2 })
    await expect(read('_video2/ch001_demo.mp4')).rejects.toThrow()
    await expect(read('_video2/ch002_demo.MP4')).rejects.toThrow()
    expect(await read(`_video2/${name}/Finished cut.MP4`)).toBe('compressed')
    expect(await read('_video2/ch003_demo.mp4.partial')).toBe('rendering')
    expect(await read('_video2/notes.txt')).toBe('notes')
    expect(await read('_video2/nested/ch004_demo.mp4')).toBe('nested')
    expect(await read('_video2_hi/ch001_demo.mp4')).toBe('hindi')
  })

  it('rejects missing, empty and placeholder compressed folders, and another language’s compressed video', async () => {
    await write('_video2_hi/compressed/hindi.mp4')
    for (const file of [null, 'compressed/.DS_Store', 'compressed/render.mp4.partial', 'compressed/empty.mp4']) {
      if (file) await write(`_video2/${file}`, file.endsWith('empty.mp4') ? '' : 'placeholder')
      await expect(deleteCompressedSeriesVideos('s', '_video2')).rejects.toThrow('nonempty video')
      expect(await read('_video2/ch001_demo.mp4')).toBe('original')
    }
  })

  it('rechecks disk at deletion time when the compressed copy was removed after scanning', async () => {
    await write('_video2/compressed/final.mkv')
    expect((await scanStorage()).series[0].videoCleanupFolders[1].compressedVideos).toHaveLength(1)
    await fs.unlink(path.join(root, 'Demo/_video2/compressed/final.mkv'))
    await expect(deleteCompressedSeriesVideos('s', '_video2')).rejects.toThrow('nonempty video')
    expect(await read('_video2/ch001_demo.mp4')).toBe('original')
  })

  it.each(['_video', '_video2_hi'])('supports cleanup in %s independently', async dir => {
    await write(`${dir}/ch001_demo.mp4`)
    await write(`${dir}/compressed/final.webm`)
    expect(await deleteCompressedSeriesVideos('s', dir)).toEqual({ freedBytes: 5, deletedFiles: 1 })
    expect(await read(`${dir}/compressed/final.webm`)).toBe('video')
    expect(await read('_video2/ch001_demo.mp4')).toBe('original')
  })

  it('does not accept symlinked compressed files or folders as a saved copy', async () => {
    await write('saved/final.mp4')
    await fs.symlink(path.join(root, 'Demo/saved'), path.join(root, 'Demo/_video2/compressed'))
    await expect(deleteCompressedSeriesVideos('s', '_video2')).rejects.toThrow('nonempty video')
    await fs.unlink(path.join(root, 'Demo/_video2/compressed'))
    await fs.mkdir(path.join(root, 'Demo/_video2/compressed'))
    await fs.symlink(path.join(root, 'Demo/saved/final.mp4'), path.join(root, 'Demo/_video2/compressed/final.mp4'))
    await expect(deleteCompressedSeriesVideos('s', '_video2')).rejects.toThrow('nonempty video')
  })

  it('rejects unknown folders and paths', async () => {
    for (const dir of ['compressed', '../_video2', '_video2/compressed']) {
      await expect(deleteCompressedSeriesVideos('s', dir)).rejects.toThrow('Unknown video folder')
    }
    expect(await read('_video2/ch001_demo.mp4')).toBe('original')
  })
  it('refuses recursive deletion above or inside a managed chapter before touching files', async () => {
    await write('Chapter 001/.managed-crops/page.json', '{}')
    await write('Chapter 001/page.png', 'protected')
    for (const target of ['Demo', 'Demo/Chapter 001', 'Demo/Chapter 001/page.png']) {
      await expect(removeWithin(path.join(root, target))).rejects.toThrow('Managed crop tasks')
    }
    expect(await read('Chapter 001/page.png')).toBe('protected')
    expect(await removeWithin(path.join(root, 'Demo/_video2/ch001_demo.mp4'))).toBe(true)
  })

})
