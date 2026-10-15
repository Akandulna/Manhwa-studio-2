import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

vi.mock('../../index.js', () => ({ prisma: { series: {
  findUnique: async ({ where }: { where: { id: string } }) =>
    where.id === 'missing' ? null : { rootFolder: 'Demo' }
} } }))

const { getSeriesCompletion2 } = await import('../videoEditor2Service.js')
let root: string
const previousRoot = process.env.DOWNLOAD_ROOT
const write = async (file: string, data = 'video') => {
  const target = path.join(root, 'Demo', file)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, data)
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'editor2-completion-'))
  process.env.DOWNLOAD_ROOT = root
})
beforeEach(async () => {
  await fs.rm(path.join(root, 'Demo'), { recursive: true, force: true })
})
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
  if (previousRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = previousRoot
})

describe('Editor 2.0 series completion', () => {
  it.each(['compressed', 'Compressed', 'Compress'])('marks a saved video in %s Done after original renders are deleted', async folder => {
    await write('_video2/ch001_demo.mp4')
    await write(`_video2/${folder}/Finished cut.MP4`)
    const expected = { done: true, compressedVideos: [`_video2/${folder}/Finished cut.MP4`] }
    expect(await getSeriesCompletion2('s', 'en')).toEqual(expected)
    await fs.unlink(path.join(root, 'Demo/_video2/ch001_demo.mp4'))
    expect(await getSeriesCompletion2('s', 'en')).toEqual(expected)
    await fs.unlink(path.join(root, 'Demo', expected.compressedVideos[0]))
    expect((await getSeriesCompletion2('s', 'en')).done).toBe(false)
  })

  it('checks each narration language independently and accepts legacy English video folders', async () => {
    await write('_video2_hi/compressed/hindi.mkv')
    expect(await getSeriesCompletion2('s', 'en')).toEqual({ done: false, compressedVideos: [] })
    expect(await getSeriesCompletion2('s', 'hi')).toEqual({
      done: true, compressedVideos: ['_video2_hi/compressed/hindi.mkv']
    })
    await write('_video/Compress/english.webm')
    expect(await getSeriesCompletion2('s', 'en')).toEqual({
      done: true, compressedVideos: ['_video/Compress/english.webm']
    })
  })

  it('requires a nonempty video, rather than just renders, folders or placeholders', async () => {
    expect(await getSeriesCompletion2('missing')).toEqual({ done: false, compressedVideos: [] })
    expect((await getSeriesCompletion2('s')).done).toBe(false)
    await write('_video2/ch001_demo.mp4')
    await write('_video2/compressed/.DS_Store')
    await write('_video2/compressed/final.mp4.partial')
    await write('_video2/compressed/empty.mp4', '')
    await fs.mkdir(path.join(root, 'Demo/_video2/compressed/folder.mp4'))
    expect(await getSeriesCompletion2('s')).toEqual({ done: false, compressedVideos: [] })
  })

  it('does not count linked video files or compressed folders', async () => {
    await write('saved/final.mp4')
    await fs.mkdir(path.join(root, 'Demo/_video2'))
    await fs.symlink(path.join(root, 'Demo/saved'), path.join(root, 'Demo/_video2/compressed'))
    expect((await getSeriesCompletion2('s')).done).toBe(false)
    await fs.unlink(path.join(root, 'Demo/_video2/compressed'))
    await fs.mkdir(path.join(root, 'Demo/_video2/compressed'))
    await fs.symlink(path.join(root, 'Demo/saved/final.mp4'), path.join(root, 'Demo/_video2/compressed/final.mp4'))
    expect((await getSeriesCompletion2('s')).done).toBe(false)
  })
})
