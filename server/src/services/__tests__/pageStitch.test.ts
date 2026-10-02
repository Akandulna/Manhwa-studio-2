import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

vi.mock('../../index.js', () => ({ prisma: {} }))

const { planOutputs, renderOutput, measurePages, STITCH_MAX_HEIGHT } = await import('../pageStitch.js')

type Page = { filename: string; width: number; height: number; format: string; bytes: number }
const page = (n: number, width = 800, height = 1500, format = 'jpeg'): Page => ({
  filename: `page_${String(n).padStart(3, '0')}.jpg`,
  width,
  height,
  format,
  bytes: 1
})

describe('planOutputs', () => {
  const pages = [page(1), page(2, 800, 500), page(3), page(4, 400, 500)]

  it('stacks heights, scales narrow pages to the widest, and names outputs in order', () => {
    const plan = planOutputs(pages, [
      ['page_001.jpg', 'page_002.jpg'],
      ['page_003.jpg', 'page_004.jpg']
    ])
    expect(plan.map(o => [o.filename, o.width, o.height, o.copied])).toEqual([
      ['page_001', 800, 2000, false],
      ['page_002', 800, 2500, false] // 400x500 scaled x2 -> 1000
    ])
  })

  it('stacks pages in the order given, even out of reading order', () => {
    const plan = planOutputs(pages, [['page_003.jpg', 'page_001.jpg'], ['page_002.jpg']])
    expect(plan[0].sources.map(s => s.filename)).toEqual(['page_003.jpg', 'page_001.jpg'])
    expect(plan.map(o => o.filename)).toEqual(['page_001', 'page_002'])
  })

  it('drops pages in no group and copies single-page groups', () => {
    const plan = planOutputs(pages, [['page_002.jpg'], ['page_004.jpg']])
    expect(plan.map(o => [o.filename, o.sources[0].filename, o.copied])).toEqual([
      ['page_001', 'page_002.jpg', true],
      ['page_002', 'page_004.jpg', true]
    ])
  })

  it('rejects unknown and repeated pages', () => {
    expect(() => planOutputs(pages, [['page_009.jpg']])).toThrow(/not a page/)
    expect(() => planOutputs(pages, [['page_001.jpg'], ['page_001.jpg']])).toThrow(/used twice/)
    expect(() => planOutputs(pages, [[]])).toThrow(/at least one/)
    expect(() => planOutputs(pages, 'nope')).toThrow(/non-empty/)
  })

  it('caps multi-page outputs at the WebP limit but lets one tall page through as-is', () => {
    const tall = [page(1, 800, 9000), page(2, 800, 9000), page(3, 800, 20000)]
    expect(() => planOutputs(tall, [['page_001.jpg', 'page_002.jpg']])).toThrow(String(STITCH_MAX_HEIGHT))
    expect(planOutputs(tall, [['page_003.jpg']])[0].copied).toBe(true)
  })
})

describe('renderOutput', () => {
  let dir: string
  let out: string

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stitch-test-'))
    out = path.join(dir, 'out')
    await fs.mkdir(out)
    const solid = (w: number, h: number, r: number) =>
      sharp({ create: { width: w, height: h, channels: 3, background: { r, g: 0, b: 0 } } })
    await solid(100, 60, 255).png().toFile(path.join(dir, 'page_001.png'))
    await solid(50, 20, 0).png().toFile(path.join(dir, 'page_002.png'))
    await solid(100, 40, 128).jpeg().toFile(path.join(dir, 'page_003.jpg'))
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('stacks lossless sources into lossless WebP at the widest width', async () => {
    const pages = await measurePages(dir, ['page_001.png', 'page_002.png'])
    const [plan] = planOutputs(pages, [['page_001.png', 'page_002.png']])
    const name = await renderOutput(dir, plan, out)
    expect(name).toBe('page_001.webp')

    const { data, info } = await sharp(path.join(out, name)).raw().toBuffer({ resolveWithObject: true })
    expect([info.width, info.height]).toEqual([100, 100]) // 60 + 20 scaled x2
    const red = (x: number, y: number) => data[(y * info.width + x) * info.channels]
    expect(red(10, 10)).toBe(255) // first page, pixel exact
    expect(red(90, 80)).toBe(0) // second page, scaled up
  })

  it('writes JPEG when any source is JPEG, and copies a single page byte-for-byte', async () => {
    const pages = await measurePages(dir, ['page_001.png', 'page_002.png', 'page_003.jpg'])
    const plan = planOutputs(pages, [['page_001.png'], ['page_002.png', 'page_003.jpg']])
    expect(await renderOutput(dir, plan[1], out)).toBe('page_002.jpg')
    expect((await sharp(path.join(out, 'page_002.jpg')).metadata()).height).toBe(80) // 20 x2 + 40

    expect(await renderOutput(dir, plan[0], out)).toBe('page_001.png')
    const [a, b] = await Promise.all([
      fs.readFile(path.join(dir, 'page_001.png')),
      fs.readFile(path.join(out, 'page_001.png'))
    ])
    expect(b.equals(a)).toBe(true)
  })
})
