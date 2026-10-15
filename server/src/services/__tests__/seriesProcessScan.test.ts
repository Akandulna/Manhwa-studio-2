import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const data = vi.hoisted(() => ({ chapters: [] as any[], timelines: [] as any[], scripts: [] as any[] }))
vi.mock('../../index.js', () => ({ prisma: {
  series: { findMany: async () => [{ id: 's', title: 'Demo', rootFolder: 'Demo', chapters: data.chapters }] },
  editor2Timeline: { findMany: async () => data.timelines }
} }))
vi.mock('../librarySync.js', () => ({ libraryDeviceId: async () => 'mac-test' }))
vi.mock('../libraryControls.js', () => ({ libraryControl: async (folder: string) => ({ folder }) }))
vi.mock('../phoneRelay.js', () => ({ relayReceipts: (kind: string) => kind === 'scripts' ? data.scripts : [] }))
vi.mock('../r2Service.js', () => ({ createClient: vi.fn(), getR2Config: () => null }))
vi.mock('../clipper3/chapterCrop.js', () => ({ readChapterCropState: vi.fn(), isChapterCropping: () => false }))
vi.mock('../clipper3/chapterReview.js', () => ({ readEffectiveReview: async () => ({ reviewed: false }) }))
const { getSeriesProcess, notifySeriesProcessChanged, receiveDeviceProcess } = await import('../seriesProcess.js')
let root = ''
beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'series-process-')); process.env.DOWNLOAD_ROOT = root })
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }) })
beforeEach(async () => {
  await fs.rm(path.join(root, 'Demo'), { recursive: true, force: true })
  await fs.mkdir(path.join(root, 'Demo/Chapter 001'), { recursive: true })
  await fs.writeFile(path.join(root, 'Demo/Chapter 001/page_001.jpg'), 'page')
  data.chapters = [{ id: 'c', number: 1, folderPath: 'Demo/Chapter 001', status: 'done', pageCount: 1, scripts: [], audioSections: [], completedAt: null }]
  data.timelines = []; data.scripts = []
  notifySeriesProcessChanged(true)
})
const states = async () => (await getSeriesProcess()).series[0].parts[0].chapters[0].stages

describe('series progress evidence', () => {
  it('recognizes only nonempty Editor 2.0 exports in their own language folder', async () => {
    await fs.mkdir(path.join(root, 'Demo/_video2'), { recursive: true })
    await fs.mkdir(path.join(root, 'Demo/_video2_hi'), { recursive: true })
    await fs.writeFile(path.join(root, 'Demo/_video2/ch001_demo.mp4'), 'rendered')
    await fs.writeFile(path.join(root, 'Demo/_video2_hi/ch001_demo.mp4'), '')
    await fs.writeFile(path.join(root, 'Demo/_video2_hi/ch001_in_progress.mp4.partial'), 'rendering')
    const result = await states()
    expect(result.export_en.state).toBe('done')
    expect(result.export_hi.state).toBe('pending')
    expect((await getSeriesProcess()).series[0].completedThrough).toBe(0)
  })

  it('keeps an unfinished download active even when its first pages are already present', async () => {
    data.chapters[0].status = 'downloading'
    expect((await states()).download.state).toBe('active')
  })

  it('requires the processed marker to match the current timeline JSON', async () => {
    data.timelines = [{ chapterId: 'c', language: 'en', json: 'new JSON', processedJson: 'old JSON' }]
    expect((await states()).processed_en.state).toBe('pending')
    data.timelines[0].processedJson = 'new JSON'; notifySeriesProcessChanged()
    expect((await states()).processed_en.state).toBe('done')
  })

  it('tracks every voiceover split and alignment section separately', async () => {
    const audio = path.join(root, 'Demo/Chapter 001/s1.wav')
    await fs.writeFile(audio, 'audio')
    data.chapters[0].audioSections = [
      { language: 'en', text: 'a', timelineScript: 'aligned', status: 'done', audioFile: { status: 'done', filePath: audio } },
      { language: 'en', text: 'b', timelineScript: null, status: 'none', audioFile: null }
    ]
    const result = await states()
    expect(result.split_en.state).toBe('done')
    expect(result.voice_en).toMatchObject({ state: 'partial', done: 1, total: 2 })
    expect(result.align_en).toMatchObject({ state: 'partial', done: 1, total: 2 })
  })

  it('shows saved phone voiceover and timeline work before a file fetch, but never guesses a phone export', async () => {
    receiveDeviceProcess({ schema: 'device-process/1', deviceId: 'nord-test', updatedAt: new Date().toISOString(), series: [{ folder: 'Demo', chapters: { 'Chapter 001': { stages: {
      voice_hi: { state: 'done', done: 3, total: 3 }, timeline_hi: { state: 'done' }, export_hi: { state: 'done' }
    } } } }] })
    const result = await states()
    expect(result.voice_hi.state).toBe('done')
    expect(result.timeline_hi.state).toBe('done')
    expect(result.export_hi.state).toBe('pending')
  })
})
