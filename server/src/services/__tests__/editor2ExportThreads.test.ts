import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ commands: [] as string[][], active: 0, maxActive: 0, kills: 0, failNextRender: false }))
vi.mock('../../index.js', () => ({ prisma: {
  series: { findUnique: async () => ({ title: 'Test', rootFolder: '/tmp/export-thread-test' }) },
  chapter: { findMany: async () => [{ id: 'chapter', number: 1, title: null, folderPath: '/tmp/export-thread-test' }] }
} }))
vi.mock('node:fs/promises', () => ({ default: {
  mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}), rename: vi.fn(async () => {}), rm: vi.fn(async () => {})
} }))
vi.mock('fs/promises', () => ({ default: {
  mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}), rename: vi.fn(async () => {}), rm: vi.fn(async () => {})
} }))
vi.mock('sharp', () => ({ default: () => ({ metadata: async () => ({ width: 600, height: 800 }) }) }))
vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawn: (_binary: string, args: string[]) => {
    state.commands.push(args)
    state.active++
    state.maxActive = Math.max(state.maxActive, state.active)
    const fail = state.failNextRender && args.includes('-filter_complex')
    if (fail) state.failNextRender = false
    let closed = false
    const finish = (code: number | null) => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      state.active--
      proc.emit('close', code)
    }
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(),
      kill: vi.fn(() => { state.kills++; finish(null); return true })
    })
    const timer = setTimeout(() => finish(fail ? 1 : 0), 20)
    return proc
  }
}))
vi.mock('../videoRender.js', async importOriginal => ({
  ...await importOriginal<typeof import('../videoRender.js')>(),
  getVideoCapabilities: () => ({ ffmpegAvailable: true, hasVideoToolbox: true, hasZoompan: true, blurFilter: 'gblur' })
}))
vi.mock('../seriesProcess.js', () => ({ notifySeriesProcessChanged: () => {} }))
vi.mock('../editor2Timeline.js', () => ({ processTimelineJson: async () => ({
  chapterId: 'chapter', chapterNumber: 1, chapterTitle: null,
  sections: [{ label: 'Section 1', audioDuration: 299.44, audioPath: '/audio.wav', slots: [{
    images: Array.from({ length: 91 }, (_, i) => ({
      imagePath: `/crop-${i}.png`, duration: 3, motionEffect: 'zoom-in', motionIntensity: 0.04
    }))
  }] }]
}) }))
import { cancelExport2Job, getExport2Job, startBatchExport } from '../editor2Export.js'

beforeEach(() => {
  Object.assign(state, { commands: [], active: 0, maxActive: 0, kills: 0, failNextRender: false })
})

it('shares three bounded workers across image batches and muxes section audio only once', async () => {
  const id = await startBatchExport('series', [{ chapterId: 'chapter', json: '{}' }], {
    resolution: '1920x1080', preset: 'medium', language: 'en', force: true
  })
  await vi.waitFor(() => expect(getExport2Job(id)?.status).toBe('done'))
  const videoCommands = state.commands.filter(args => args.includes('-filter_complex'))
  expect(videoCommands.length).toBeGreaterThan(3)
  expect(state.maxActive).toBe(3)
  let imageCount = 0
  for (const args of videoCommands) {
    for (const option of ['-filter_threads', '-filter_complex_threads', '-threads:v']) {
      expect(args[args.indexOf(option) + 1]).toBe('1')
    }
    const inputs = args.flatMap((value, i) => value === '-i' ? [i] : [])
    expect(inputs.length).toBeLessThanOrEqual(12)
    imageCount += inputs.length
    for (const i of inputs) expect(args.slice(i - 2, i)).toEqual(['-threads', '1'])
    expect(args).toContain('-an')
    expect(args[args.indexOf('-c:v') + 1]).toBe('h264_videotoolbox')
    expect(args[args.indexOf('-q:v') + 1]).toBe('75')
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('s=1216x1620:fps=30')
  }
  expect(imageCount).toBe(91)
  const audioCommands = state.commands.filter(args => args.includes('/audio.wav'))
  expect(audioCommands).toHaveLength(1)
  expect(audioCommands[0][audioCommands[0].indexOf('-c:v') + 1]).toBe('copy')
  expect(state.commands.at(-1)).toContain('copy')
  expect(getExport2Job(id)?.chapters[0].status).toBe('done')
})


it('stops sibling batches on failure and does not mux or publish incomplete output', async () => {
  state.failNextRender = true
  const id = await startBatchExport('series', [{ chapterId: 'chapter', json: '{}' }], {
    resolution: '1920x1080', preset: 'medium', force: true
  })
  await vi.waitFor(() => expect(getExport2Job(id)?.status).toBe('failed'))
  expect(state.kills).toBeGreaterThanOrEqual(2)
  expect(state.active).toBe(0)
  expect(state.commands).toHaveLength(3)
  expect(state.commands.every(args => args.includes('-an'))).toBe(true)
  expect(getExport2Job(id)?.chapters[0].outputPath).toBeNull()
})

it('cancels all active batches without publishing the chapter', async () => {
  const id = await startBatchExport('series', [{ chapterId: 'chapter', json: '{}' }], {
    resolution: '1920x1080', preset: 'medium', force: true
  })
  // Wait through metadata reads, but cancel before the mock encoders finish.
  await vi.waitFor(() => expect(state.active).toBe(3), { interval: 1 })
  expect(cancelExport2Job(id)).toBe(true)
  await vi.waitFor(() => expect(getExport2Job(id)?.status).toBe('cancelled'))
  expect(state.kills).toBe(3)
  expect(state.active).toBe(0)
  expect(getExport2Job(id)?.chapters[0].outputPath).toBeNull()
})
