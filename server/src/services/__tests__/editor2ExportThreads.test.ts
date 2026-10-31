import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ commands: [] as string[][] }))
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
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn()
    })
    queueMicrotask(() => proc.emit('close', 0))
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
import { getExport2Job, startBatchExport } from '../editor2Export.js'

it('bounds filter, decoder and encoder pools for a 91-image section and still publishes a finished export', async () => {
  const id = await startBatchExport('series', [{ chapterId: 'chapter', json: '{}' }], {
    resolution: '1920x1080', preset: 'medium', language: 'en', force: true
  })
  await vi.waitFor(() => expect(getExport2Job(id)?.status).toBe('done'))
  expect(state.commands).toHaveLength(2)
  const args = state.commands[0]
  for (const option of ['-filter_threads', '-filter_complex_threads', '-threads:v', '-threads:a']) {
    expect(args[args.indexOf(option) + 1]).toBe('1')
  }
  const inputs = args.flatMap((value, i) => value === '-i' ? [i] : [])
  expect(inputs).toHaveLength(92)
  for (const i of inputs) expect(args.slice(i - 2, i)).toEqual(['-threads', '1'])
  expect(args[args.indexOf('-filter_complex') + 1]).toContain('concat=n=91:v=1:a=0[vout]')
  expect(state.commands[1]).toContain('copy')
  expect(getExport2Job(id)?.chapters[0].status).toBe('done')
})
