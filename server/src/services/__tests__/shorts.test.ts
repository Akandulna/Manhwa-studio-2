import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ShortsService } from '../shorts.js'

let root: string, folder: string, service: ShortsService
const plan = (overrides: Record<string, unknown> = {}) => ({
  title: 'Test Short', language: 'en', duration_seconds: 1,
  sections: [{ section: 'Section 1', timelines: [
    { timeline: '00:00.00 - 00:00.50', selectedImages: ['one.png'], narration: 'An opening.', on_screen_text: 'THE HOOK', motion: { effect: 'pan-up' } },
    { timeline: '00:00.50 - 00:01.00', selectedImages: ['two.png'], on_screen_text: 'WHAT HAPPENS NEXT?' }
  ] }], ...overrides
})
const save = (value = plan()) => fs.writeFile(path.join(folder, 'test.timeline.json'), JSON.stringify(value))
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-shorts-'))
  folder = path.join(root, 'exports', 'test-short')
  await fs.mkdir(path.join(folder, 'crops3'), { recursive: true })
  for (const name of ['one', 'two']) await sharp({ create: { width: 120, height: 240, channels: 3, background: name === 'one' ? '#3b82f6' : '#ef4444' } }).png().toFile(path.join(folder, 'crops3', `${name}.png`))
  await save()
  service = new ShortsService(path.join(root, 'exports'), path.join(root, 'cache'))
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

it('discovers and loads a package without modifying it; reports silent previews', async () => {
  expect(await service.discover()).toEqual([{ name: 'test-short', folder }])
  const p = await service.load(folder)
  expect(p).toMatchObject({ title: 'Test Short', duration: 1, audioFile: null, missingImages: [], shots: [{ start: 0, end: 0.5 }, { start: 0.5, end: 1 }] })
  expect(p.warnings[0]).toContain('Silent preview')
  expect(await fs.readdir(folder)).toEqual(['crops3', 'test.timeline.json'])
  expect(await service.image(p.id, 'one.png')).toBe(await fs.realpath(path.join(folder, 'crops3/one.png')))
  await expect(service.image(p.id, '../../secret')).rejects.toThrow('not in this Short')
})

it('refuses gaps, overlaps, invalid timestamps, mismatched durations and unsafe filenames', async () => {
  for (const range of ['00:00.60 - 00:01.00', '00:00.40 - 00:01.00', '00:60.00 - 00:61.00']) {
    const p = plan(); p.sections[0].timelines[1].timeline = range; await save(p)
    await expect(service.load(folder)).rejects.toThrow(/timings|timestamp/)
  }
  await save(plan({ duration_seconds: 40 })); await expect(service.load(folder)).rejects.toThrow('declared duration')
  const p = plan(); p.sections[0].timelines[0].selectedImages = ['../secret.png']; await save(p)
  await expect(service.load(folder)).rejects.toThrow('filenames')
})

it('blocks missing images, symlink escapes and stale revisions before rendering', async () => {
  const original = await service.load(folder)
  await fs.unlink(path.join(folder, 'crops3/two.png'))
  const missing = await service.load(folder)
  expect(missing.missingImages).toEqual(['two.png'])
  await expect(service.start(missing.id, missing.revision)).rejects.toThrow('missing images')
  const outside = path.join(root, 'outside.png'); await fs.copyFile(path.join(folder, 'crops3/one.png'), outside)
  await fs.symlink(outside, path.join(folder, 'crops3/two.png'))
  await expect(service.load(folder)).rejects.toThrow('leaves its folder')
  await fs.unlink(path.join(folder, 'crops3/two.png')); await fs.copyFile(outside, path.join(folder, 'crops3/two.png'))
  await save(plan({ title: 'Changed' }))
  await expect(service.start(original.id, original.revision)).rejects.toThrow('changed')
})

it('renders a seekable portrait MP4 at the exact timeline length, with audio padding and reusable cache', async () => {
  // A shorter narration must not shorten the video or its final cliffhanger.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', path.join(folder, 'voiceover.en.wav')])
  const p = await service.load(folder)
  expect(p.audioFile).toBe('voiceover.en.wav')
  const job = await service.start(p.id, p.revision)
  expect((await service.start(p.id, p.revision)).id).toBe(job.id)
  const deadline = Date.now() + 30_000
  while (job.state === 'rendering' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  expect(job.state, job.message).toBe('complete')
  const meta = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', service.getJob(job.id).output], { encoding: 'utf8' }))
  expect(meta.streams.find((s: any) => s.codec_type === 'video')).toMatchObject({ width: 540, height: 960, nb_frames: '30' })
  expect(meta.streams.some((s: any) => s.codec_type === 'audio')).toBe(true)
  expect(Number(meta.format.duration)).toBeCloseTo(1, 1)
  const cached = await service.start(p.id, p.revision)
  expect(cached).toMatchObject({ state: 'complete', progress: 100 })
  expect(cached.id).not.toBe(job.id)
  expect(await fs.readdir(service.cacheRoot)).toEqual([`${p.revision}.mp4`])
}, 40_000)

it('cancels rendering without publishing a partial video', async () => {
  const p = await service.load(folder)
  const job = await service.start(p.id, p.revision)
  expect(service.cancel(job.id).state).toBe('cancelled')
  const deadline = Date.now() + 5000
  while ((await fs.readdir(service.cacheRoot)).some(f => f.startsWith('render-')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  expect(job.videoUrl).toBeUndefined()
  expect(await fs.readdir(service.cacheRoot)).toEqual([])
})
