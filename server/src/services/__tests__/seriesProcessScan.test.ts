import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const data = vi.hoisted(() => ({ chapters: [] as any[], timelines: [] as any[], scripts: [] as any[], restarted: false, restarting: false, splitMetadata: false, staleSplitMetadata: false }))
vi.mock('../../index.js', () => ({ prisma: {
  series: { findMany: async () => [{ id: 's', title: 'Demo', rootFolder: 'Demo', chapters: data.chapters }] },
  editor2Timeline: { findMany: async () => data.timelines }
} }))
vi.mock('../librarySync.js', () => ({ libraryDeviceId: async () => 'mac-test' }))
vi.mock('../libraryControls.js', () => ({ libraryControl: async (folder: string) => ({ folder, ...(data.restarted ? {restart:{at:1,deviceId:'test'}} : {}) }) }))
vi.mock('../phoneRelay.js', () => ({ relayReceipts: (kind: string) => kind === 'scripts' ? data.scripts : [] }))
vi.mock('../r2Service.js', () => ({ createClient: vi.fn(), getR2Config: () => null }))
vi.mock('../clipper3/chapterCrop.js', () => ({ readChapterCropState: vi.fn(), isChapterCropping: () => false }))
vi.mock('../clipper3/chapterReview.js', () => ({ readEffectiveReview: async () => ({ reviewed: false }) }))
vi.mock('../seriesRestartGuard.js', () => ({ seriesRestartPending: async () => data.restarting }))
vi.mock('../clipper3/metadataSplit.js', () => ({ requireCurrentSplitMetadata: async () => {
  if (data.staleSplitMetadata) throw new Error('Stale Metadata job result')
  return data.splitMetadata
} }))
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
  data.restarted = false; data.restarting = false; data.splitMetadata = false; data.staleSplitMetadata = false
  vi.mocked((await import('../clipper3/chapterCrop.js')).readChapterCropState).mockReset()
  notifySeriesProcessChanged(true)
})
const states = async () => (await getSeriesProcess()).series[0].parts[0].chapters[0].stages

describe('series progress evidence', () => {

  it('keeps preparation done after stitch originals and undo record have been deleted', async () => {
    await fs.writeFile(path.join(root, 'Demo/Chapter 001/.stitch-complete.json'), JSON.stringify({
      version: 1, originalPages: 200, stitchedPages: 1, stitchedAt: '2026-11-03T10:00:00.000Z'
    }))
    const result = await states()
    expect(result.stitch.state).toBe('done')
    expect(result.cleanup.state).toBe('done')
  })

  async function cropEvidence(done: number, total: number) {
    const { readChapterCropState } = await import('../clipper3/chapterCrop.js')
    await fs.mkdir(path.join(root, 'Demo/Chapter 001/crop_points3'), { recursive: true })
    vi.mocked(readChapterCropState).mockResolvedValue({
      totalImages: total, targets: Array.from({length: done}, (_, i) => ({filename: `page_${i + 1}.jpg`, crops: []})),
      fullyAttached: done === total, chopped: true,
      outputs: {complete: done === total, files: done, missing: total - done, extra: 0, changed: 0}
    })
  }

  it('counts restored legacy metadata after a script restart without completing a new timeline', async () => {
    data.restarted = true
    await cropEvidence(2, 2)
    const result = await states()
    expect(result.metadata).toEqual({state: 'done', done: 2, total: 2})
    expect(result.timeline_en.state).toBe('pending')
    const exported = (await getSeriesProcess()).series[0]
    expect(exported.stages.metadata).toMatchObject({done: 1, unitsDone: 2, unitsTotal: 2})
  })

  it('counts only crop-validated legacy pages and preserves partial progress', async () => {
    await cropEvidence(1, 2)
    expect((await states()).metadata).toEqual({state: 'partial', done: 1, total: 2})
  })

  it('does not count stale split results by falling back to legacy crop targets', async () => {
    data.staleSplitMetadata = true
    await cropEvidence(2, 2)
    expect((await states()).metadata).toEqual({state: 'pending', total: 2})
  })

  it('still waits for a pending series restart to finish', async () => {
    data.restarted = true; data.restarting = true
    await cropEvidence(2, 2)
    expect((await states()).metadata.state).toBe('pending')
  })

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
  it('does not let legacy phone crop progress complete a managed chapter', async () => {
    const { readChapterCropState } = await import('../clipper3/chapterCrop.js')
    vi.mocked(readChapterCropState).mockResolvedValueOnce({ totalImages: 1, targets: [], fullyAttached: false, chopped: false, outputs: { complete: false, files: 0, missing: 0, extra: 0, changed: 1 } })
    await fs.mkdir(path.join(root, 'Demo/Chapter 001/.managed-crops'), { recursive: true })
    await fs.writeFile(path.join(root, 'Demo/Chapter 001/.managed-crops/page_001.json'), '{}')
    receiveDeviceProcess({ schema: 'device-process/1', deviceId: 'legacy-crop-test', updatedAt: new Date().toISOString(), series: [{ folder: 'Demo', chapters: { 'Chapter 001': { stages: {
      crop_json: { state: 'done', done: 1, total: 1 }, crop: { state: 'done' }, review:{state:'done'}
    } } } }] })
    const result = await states()
    expect(result.crop_json.state).toBe('pending')
    expect(result.crop.state).toBe('pending')
    expect(result.review.state).toBe('pending')
  })

  it('invalidates the process snapshot when a private managed projection changes', async () => {
    const { managedCropProjectionChanged } = await import('../managedCropEvents.js')
    expect((await states()).download.state).toBe('done')
    data.chapters[0].status = 'downloading'
    managedCropProjectionChanged()
    expect((await states()).download.state).toBe('active')
  })

  it('does not let an archive flag or an old MP4 complete managed crop and export stages',async()=>{
    const {readChapterCropState}=await import('../clipper3/chapterCrop.js')
    vi.mocked(readChapterCropState).mockResolvedValueOnce({totalImages:1,targets:[],fullyAttached:false,chopped:false,outputs:{complete:false,files:0,missing:0,extra:0,changed:1}})
    data.chapters[0].completedAt=new Date().toISOString()
    await fs.mkdir(path.join(root,'Demo/Chapter 001/.managed-crops'),{recursive:true})
    await fs.writeFile(path.join(root,'Demo/Chapter 001/.managed-crops/page_001.json'),'{}')
    await fs.mkdir(path.join(root,'Demo/_video2'),{recursive:true})
    await fs.writeFile(path.join(root,'Demo/_video2/ch001_old.mp4'),'old render')
    const result=await states()
    expect(result.crop.state).not.toBe('done');expect(result.review.state).not.toBe('done');expect(result.export_en.state).toBe('pending')
  })

})
