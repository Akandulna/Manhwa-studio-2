/**
 * Tests for the Crop Studio ChatGPT handoff package:
 * - pure pieces (job id, chapter token, slice ids, tiling checks)
 * - original-page inspection and the issue codes that block a page
 * - an end-to-end build against real files: slices verified pixel-exact
 *   against the original for PNG, JPEG, grayscale and alpha sources
 * - stale detection when the source or a slice changes afterwards
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import {
  buildHandoff,
  chapterToken,
  getHandoffStatus,
  getStudioDir,
  HandoffError,
  jobIdFor,
  manifestChecksum,
  sliceIdFor,
  verifyTiling,
  HANDOFF_FILE,
  PROMPT_FILE
} from '../handoff.js'
import { inspectOriginal } from '../pageIdentity.js'

const SERIES = 'Bad Business'
const CHAPTER = 'Chapter 006'
const folderPath = `${SERIES}/${CHAPTER}`

let root: string
let previousRoot: string | undefined

/** Noise, so compression cannot hide a pixel difference behind flat colour. */
function noise(width: number, height: number, channels: 1 | 3 | 4): Buffer {
  const data = Buffer.alloc(width * height * channels)
  let seed = 12345
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    data[i] = seed & 0xff
  }
  return data
}

async function writePage(filename: string, width: number, height: number, encode: (s: sharp.Sharp) => sharp.Sharp, channels: 1 | 3 | 4 = 3) {
  const target = path.join(root, SERIES, CHAPTER, filename)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await encode(sharp(noise(width, height, channels), { raw: { width, height, channels } })).toFile(target)
  return target
}

const ctx = (imageFilename: string) => ({
  folderPath,
  imageFilename,
  seriesTitle: SERIES,
  seriesSlug: 'bad_business',
  chapterNumber: 6
})

beforeEach(async () => {
  previousRoot = process.env.DOWNLOAD_ROOT
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crop-studio-'))
  process.env.DOWNLOAD_ROOT = root
})

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = previousRoot
  await fs.rm(root, { recursive: true, force: true })
})

describe('pure pieces', () => {
  it('pads chapter tokens and keeps fractional chapters', () => {
    expect(chapterToken(6)).toBe('006')
    expect(chapterToken(123)).toBe('123')
    expect(chapterToken(10.5)).toBe('010.5')
  })

  it('builds a deterministic, filesystem-safe job id from the hash', () => {
    const sha = 'ab'.repeat(32)
    expect(jobIdFor('bad_business', 6, 'page_008', sha)).toBe('bad_business-ch006-page_008-abababababab')
    expect(jobIdFor('s', 1, 'Page 8 (final)', sha)).toBe('s-ch001-page-8-final-abababababab')
  })

  it('pads slice ids to at least two digits', () => {
    expect(sliceIdFor(1, 3)).toBe('slice-01')
    expect(sliceIdFor(7, 120)).toBe('slice-007')
  })

  it('accepts an exact tiling', () => {
    expect(verifyTiling(800, 5000, [
      { id: 'a', x0: 0, y0: 0, x1: 800, y1: 2048 },
      { id: 'b', x0: 0, y0: 2048, x1: 800, y1: 4096 },
      { id: 'c', x0: 0, y0: 4096, x1: 800, y1: 5000 }
    ])).toEqual([])
  })

  it('reports gaps, overlaps, narrow slices and short coverage', () => {
    const issues = verifyTiling(800, 5000, [
      { id: 'a', x0: 0, y0: 0, x1: 800, y1: 2048 },
      { id: 'b', x0: 0, y0: 2050, x1: 700, y1: 4096 },
      { id: 'c', x0: 0, y0: 4000, x1: 800, y1: 4900 }
    ])
    const text = issues.map(i => i.message).join('\n')
    expect(issues.every(i => i.code === 'SLICE_MAPPING_UNVERIFIED')).toBe(true)
    expect(text).toMatch(/b starts at y 2050/)
    expect(text).toMatch(/b spans x 0–700/)
    expect(text).toMatch(/c starts at y 4000/)
    expect(text).toMatch(/end at y 4900 but the page is 5000/)
  })
})

describe('inspectOriginal', () => {
  it('measures and fingerprints a valid page', async () => {
    const file = await writePage('page_001.png', 64, 300, s => s.png())
    const result = await inspectOriginal(file)
    expect(result.ready).toBe(true)
    expect(result.page).toMatchObject({ format: 'png', width: 64, height: 300, frames: 1, orientation: null })
    expect(result.page?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('blocks a truncated file as ORIGINAL_DECODE_FAILED', async () => {
    const file = await writePage('page_002.png', 64, 300, s => s.png())
    const bytes = await fs.readFile(file)
    await fs.writeFile(file, bytes.subarray(0, Math.floor(bytes.length / 2)))
    const result = await inspectOriginal(file)
    expect(result.ready).toBe(false)
    expect(result.issues.map(i => i.code)).toContain('ORIGINAL_DECODE_FAILED')
  })

  it('blocks a non-identity EXIF orientation instead of rotating silently', async () => {
    const file = await writePage('page_003.jpg', 64, 300, s => s.jpeg().withMetadata({ orientation: 6 }))
    const result = await inspectOriginal(file)
    expect(result.ready).toBe(false)
    expect(result.issues.map(i => i.code)).toContain('ORIENTATION_UNRESOLVED')
  })

  it('warns, but does not block, when the extension lies about the format', async () => {
    const file = await writePage('page_004.jpg', 64, 300, s => s.png())
    const result = await inspectOriginal(file)
    expect(result.ready).toBe(true)
    expect(result.issues).toEqual([expect.objectContaining({ code: 'EXTENSION_MISMATCH', severity: 'warning' })])
  })

  it('reports a missing file', async () => {
    const result = await inspectOriginal(path.join(root, 'nope.png'))
    expect(result.issues.map(i => i.code)).toEqual(['ORIGINAL_NOT_FOUND'])
  })
})

describe('buildHandoff', () => {
  it('writes a verified package whose slices tile the page exactly', async () => {
    await writePage('page_008.png', 320, 5000, s => s.png())
    const result = await buildHandoff(ctx('page_008.png'))
    const { manifest } = result

    expect(manifest.source).toMatchObject({
      series_slug: 'bad_business',
      chapter_folder: CHAPTER,
      page_stem: 'page_008',
      original_filename: 'page_008.png',
      width: 320,
      height: 5000
    })
    expect(manifest.job_id).toBe(`bad_business-ch006-page_008-${manifest.source.sha256.slice(0, 12)}`)
    expect(manifest.slices.map(s => [s.id, s.y0, s.y1])).toEqual([
      ['slice-01', 0, 2048],
      ['slice-02', 2048, 4096],
      ['slice-03', 4096, 5000]
    ])
    const { manifest_sha256, ...unsigned } = manifest
    expect(manifestChecksum(unsigned)).toBe(manifest_sha256)

    const studio = getStudioDir(folderPath, 'page_008.png')
    expect(studio).toBe(path.join(root, SERIES, '.crop-studio', CHAPTER, 'page_008'))
    expect(JSON.parse(await fs.readFile(path.join(studio, HANDOFF_FILE), 'utf-8'))).toEqual(manifest)
    expect(await fs.readFile(path.join(studio, PROMPT_FILE), 'utf-8')).toBe(result.prompt + '\n')
  })

  it('keeps filesystem paths out of everything handed to ChatGPT', async () => {
    await writePage('page_008.png', 64, 2500, s => s.png())
    const { manifest, prompt } = await buildHandoff(ctx('page_008.png'))
    expect(prompt).toContain(manifest.job_id)
    expect(prompt).toContain(manifest.source.sha256)
    expect(prompt).not.toContain(root)
    expect(JSON.stringify(manifest)).not.toContain(root)
  })

  it.each([
    ['JPEG', 'page_010.jpg', (s: sharp.Sharp) => s.jpeg({ quality: 80 }), 3],
    ['grayscale JPEG', 'page_011.jpg', (s: sharp.Sharp) => s.jpeg(), 1],
    ['PNG with alpha', 'page_012.png', (s: sharp.Sharp) => s.png(), 4],
    ['WebP', 'page_013.webp', (s: sharp.Sharp) => s.webp({ quality: 70 }), 3]
  ] as const)('verifies slices pixel-exact from a %s source', async (_label, filename, encode, channels) => {
    await writePage(filename, 97, 4200, encode, channels)
    const { manifest } = await buildHandoff(ctx(filename))
    expect(manifest.slices).toHaveLength(3)
    expect(manifest.verification).toMatchObject({ tiling: 'exact', pixels: 'identical' })
  })

  it('refuses to package a blocked page and writes nothing', async () => {
    await writePage('page_020.jpg', 64, 300, s => s.jpeg().withMetadata({ orientation: 8 }))
    const error = await buildHandoff(ctx('page_020.jpg')).catch(e => e)
    expect(error).toBeInstanceOf(HandoffError)
    expect((error as HandoffError).issues.map(i => i.code)).toEqual(['ORIENTATION_UNRESOLVED'])
    await expect(fs.access(getStudioDir(folderPath, 'page_020.jpg'))).rejects.toThrow()
  })
})

describe('getHandoffStatus', () => {
  it('goes none -> ready -> stale as the files change', async () => {
    const source = await writePage('page_030.png', 64, 4500, s => s.png())
    expect((await getHandoffStatus(folderPath, 'page_030.png')).status).toBe('none')

    const { manifest, sliceDirectory, prompt } = await buildHandoff(ctx('page_030.png'))
    const ready = await getHandoffStatus(folderPath, 'page_030.png')
    expect(ready).toMatchObject({ status: 'ready', staleReasons: [], prompt })

    await fs.appendFile(path.join(sliceDirectory, manifest.slices[1].file), Buffer.from([0]))
    const sliceStale = await getHandoffStatus(folderPath, 'page_030.png')
    expect(sliceStale.status).toBe('stale')
    expect(sliceStale.staleReasons.map(r => r.code)).toEqual(['SLICES_CHANGED'])

    await fs.appendFile(source, Buffer.from([0]))
    const sourceStale = await getHandoffStatus(folderPath, 'page_030.png')
    expect(sourceStale.staleReasons.map(r => r.code)).toEqual(['SOURCE_CHANGED', 'SLICES_CHANGED'])
  })

  it('flags a hand-edited manifest', async () => {
    await writePage('page_031.png', 64, 300, s => s.png())
    await buildHandoff(ctx('page_031.png'))
    const file = path.join(getStudioDir(folderPath, 'page_031.png'), HANDOFF_FILE)
    const edited = JSON.parse(await fs.readFile(file, 'utf-8'))
    edited.source.height = 999
    await fs.writeFile(file, JSON.stringify(edited))
    const status = await getHandoffStatus(folderPath, 'page_031.png')
    expect(status.staleReasons.map(r => r.code)).toContain('MANIFEST_CORRUPT')
  })
})
