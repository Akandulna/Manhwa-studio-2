import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { PROFILE_WIDTH, profilePages } from '../stitchAnalysis.js'

describe('profilePages', () => {
  let dir: string

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stitch-profile-'))
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('scores flat rows of any colour 0 and rows with artwork above 0', async () => {
    // 640 x 400: white 0–99, black 100–199, a dark box on white 200–299, a horizontal gradient 300–399.
    const width = 640
    const height = 400
    const pixels = Buffer.alloc(width * height, 255)
    for (let y = 100; y < 200; y++) pixels.fill(0, y * width, (y + 1) * width)
    for (let y = 200; y < 300; y++) pixels.fill(40, y * width + 200, y * width + 400)
    for (let y = 300; y < 400; y++) for (let x = 0; x < width; x++) pixels[y * width + x] = Math.round((x / width) * 255)
    await sharp(pixels, { raw: { width, height, channels: 1 } }).png().toFile(path.join(dir, 'page_001.png'))

    const [profile] = await profilePages(dir, [
      { filename: 'page_001.png', width, height, format: 'png', bytes: 0 }
    ])
    expect(profile.rows).toBe((height * PROFILE_WIDTH) / width)
    const ink = Buffer.from(profile.ink, 'base64')
    const at = (y: number) => ink[Math.floor((y * profile.rows) / height)]
    expect(at(50)).toBe(0)
    expect(at(150)).toBe(0)
    expect(at(250)).toBeGreaterThan(50) // ~31% of the row is the box
    expect(at(350)).toBeGreaterThan(200) // a left-to-right gradient is not flat
  })
})
