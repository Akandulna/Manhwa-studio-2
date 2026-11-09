import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const settings = vi.hoisted(() => new Map<string, string>())
vi.mock('../../index.js', () => ({ prisma: {
  series: { findUnique: async ({ where }: { where: { id: string } }) => where.id === 'missing' ? null : { rootFolder: 'Demo' } },
  setting: {
    findUnique: async ({ where }: any) => settings.has(where.key) ? { value: settings.get(where.key) } : null,
    upsert: async ({ where, create }: any) => { settings.set(where.key, create.value) }
  }
} }))

const { getSeriesCompletion2 } = await import('../videoEditor2Service.js')
const { saveLibraryControls } = await import('../libraryControls.js')
const mark = (at: number, done = true) => ({ at, done, deviceId: 'mac' })

beforeEach(() => settings.clear())

describe('Editor 2.0 series completion', () => {
  it('is Done only when the user marks the series, separately per language', async () => {
    expect(await getSeriesCompletion2('s', 'en')).toEqual({ done: false, doneAt: null })
    await saveLibraryControls([{ folder: 'Demo', seriesDone: { hi: mark(1000) } }])
    expect(await getSeriesCompletion2('s', 'en')).toEqual({ done: false, doneAt: null })
    expect(await getSeriesCompletion2('s', 'hi')).toEqual({ done: true, doneAt: new Date(1000).toISOString() })
    await saveLibraryControls([{ folder: 'Demo', seriesDone: { hi: mark(2000, false) } }])
    expect((await getSeriesCompletion2('s', 'hi')).done).toBe(false)
    expect(await getSeriesCompletion2('missing')).toEqual({ done: false, doneAt: null })
  })

  it('does not treat a saved compressed video as Done', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'editor2-completion-'))
    const previous = process.env.DOWNLOAD_ROOT
    process.env.DOWNLOAD_ROOT = root
    try {
      await fs.mkdir(path.join(root, 'Demo/_video2/compressed'), { recursive: true })
      await fs.writeFile(path.join(root, 'Demo/_video2/compressed/final.mp4'), 'video')
      expect((await getSeriesCompletion2('s', 'en')).done).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.DOWNLOAD_ROOT
      else process.env.DOWNLOAD_ROOT = previous
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
