/**
 * Reference-width canvas scaling.
 *
 * Webtoon chapters arrive as slices of the same logical page encoded at different
 * widths (713 / 800 / 968 in one real chapter here). The canvas scales every slice up
 * to the widest, so canvas pixels and source pixels are different units for any page
 * with `scale !== 1` — and `computeCropFromCanvas` is the boundary where a crop
 * measured in the former has to be read out of the latter.
 *
 * These cases pin that boundary. The uniform-width cases matter as much as the mixed
 * ones: `scale === 1` has to stay the exact identity, or every existing chapter moves.
 */

import { describe, it, expect } from 'vitest'
import { computeCropFromCanvas, type ImageManifest, type ManifestImage } from '../clipperService.js'

/** Build a manifest the way getChapterManifest does, from source dimensions alone. */
function manifestOf(pages: Array<{ filename: string; width: number; height: number }>): ImageManifest {
  const canvasWidth = Math.max(...pages.map(p => p.width))
  const images: ManifestImage[] = []
  let canvasY = 0
  for (const p of pages) {
    const scale = canvasWidth / p.width
    const canvasHeight = p.height * scale
    images.push({ ...p, canvasY, canvasHeight, scale })
    canvasY += canvasHeight
  }
  return { canvasWidth, canvasHeight: canvasY, images }
}

const UNIFORM = manifestOf([
  { filename: 'a.jpg', width: 800, height: 1000 },
  { filename: 'b.jpg', width: 800, height: 1000 }
])

// The real shape of "This Country is Finished…" Chapter 001.
const MIXED = manifestOf([
  { filename: 'p1.jpg', width: 968, height: 2000 }, // scale 1
  { filename: 'p2.jpg', width: 713, height: 2000 }, // scale ~1.3576
  { filename: 'p3.jpg', width: 800, height: 2000 } //  scale 1.21
])

describe('manifest geometry', () => {
  it('leaves a uniform-width chapter exactly as raw stacking did', () => {
    expect(UNIFORM.canvasWidth).toBe(800)
    expect(UNIFORM.canvasHeight).toBe(2000)
    expect(UNIFORM.images.map(i => i.scale)).toEqual([1, 1])
    expect(UNIFORM.images.map(i => i.canvasY)).toEqual([0, 1000])
    // canvasHeight must equal the source height when unscaled.
    expect(UNIFORM.images.map(i => i.canvasHeight)).toEqual([1000, 1000])
  })

  it('scales every slice up to the widest and stacks the scaled heights', () => {
    expect(MIXED.canvasWidth).toBe(968)
    expect(MIXED.images[0].scale).toBe(1)
    expect(MIXED.images[1].scale).toBeCloseTo(968 / 713, 10)
    expect(MIXED.images[2].scale).toBeCloseTo(1.21, 10)

    // A narrow page occupies MORE canvas height than its own pixels.
    expect(MIXED.images[1].canvasHeight).toBeCloseTo(2000 * (968 / 713), 6)
    expect(MIXED.images[1].canvasHeight).toBeGreaterThan(MIXED.images[1].height)

    // Offsets accumulate scaled heights, so page 3 starts below both scaled pages.
    expect(MIXED.images[2].canvasY).toBeCloseTo(2000 + 2000 * (968 / 713), 6)
    expect(MIXED.canvasHeight).toBeCloseTo(
      2000 + 2000 * (968 / 713) + 2000 * 1.21,
      6
    )
  })

  it('is 21% taller than raw stacking would be — the drift that broke imports', () => {
    const raw = 2000 * 3
    expect(MIXED.canvasHeight / raw).toBeCloseTo(1.19, 2)
  })
})

describe('computeCropFromCanvas — canvas pixels in, source pixels out', () => {
  it('is the identity on an unscaled page', () => {
    const regions = computeCropFromCanvas(
      { canvasX: 100, canvasY: 200, canvasW: 300, canvasH: 400 },
      UNIFORM
    )
    expect(regions).toEqual([{ filename: 'a.jpg', x: 100, y: 200, width: 300, height: 400 }])
  })

  it('divides by scale when reading a narrower slice', () => {
    const scale = 968 / 713
    // A full-width band wholly inside page 2 (which starts at canvasY 2000).
    const regions = computeCropFromCanvas(
      { canvasX: 0, canvasY: 2000 + 500, canvasW: 968, canvasH: 1000 },
      MIXED
    )
    expect(regions).toHaveLength(1)
    expect(regions[0].filename).toBe('p2.jpg')
    // 500 canvas px down a 1.3576x page is only ~368 source px down.
    expect(regions[0].y).toBe(Math.round(500 / scale))
    expect(regions[0].height).toBe(Math.round(1000 / scale))
    // Full canvas width maps to the page's full source width, not 968.
    expect(regions[0].x).toBe(0)
    expect(regions[0].width).toBe(713)
  })

  it('never asks sharp for a region outside the source file', () => {
    // Deliberately over-wide and over-tall against the narrow page.
    const regions = computeCropFromCanvas(
      { canvasX: 0, canvasY: 2000, canvasW: 5000, canvasH: 99999 },
      MIXED
    )
    for (const r of regions) {
      const page = MIXED.images.find(i => i.filename === r.filename)!
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.width).toBeLessThanOrEqual(page.width)
      expect(r.y + r.height).toBeLessThanOrEqual(page.height)
      expect(r.width).toBeGreaterThan(0)
      expect(r.height).toBeGreaterThan(0)
    }
  })

  it('splits a seam-crossing crop and keeps each side in its own scale', () => {
    const scale2 = 968 / 713
    const page2Top = 2000
    // Straddle the page1/page2 seam: 200 canvas px above it, 400 below.
    const regions = computeCropFromCanvas(
      { canvasX: 0, canvasY: page2Top - 200, canvasW: 968, canvasH: 600 },
      MIXED
    )
    expect(regions.map(r => r.filename)).toEqual(['p1.jpg', 'p2.jpg'])

    // Page 1 is unscaled: 200 canvas px == 200 source px.
    expect(regions[0].height).toBe(200)
    // Page 2 is scaled: 400 canvas px is fewer source px.
    expect(regions[1].y).toBe(0)
    expect(regions[1].height).toBe(Math.round(400 / scale2))
    expect(regions[1].height).toBeLessThan(400)
  })

  it('keeps a crop’s canvas aspect ratio after each side is rescaled', () => {
    // This is what makes the multi-file stitch correct: every region, once resized
    // back up by its own scale, has to reassemble into the requested canvas rect.
    const crop = { canvasX: 0, canvasY: 1800, canvasW: 968, canvasH: 900 }
    const regions = computeCropFromCanvas(crop, MIXED)
    const rebuiltHeight = regions.reduce((sum, r) => {
      const page = MIXED.images.find(i => i.filename === r.filename)!
      return sum + r.height * page.scale
    }, 0)
    // Within rounding of one pixel per region.
    expect(Math.abs(rebuiltHeight - crop.canvasH)).toBeLessThanOrEqual(regions.length)
  })

  it('throws rather than guessing when a crop lies off the canvas', () => {
    expect(() =>
      computeCropFromCanvas({ canvasX: 0, canvasY: 10_000_000, canvasW: 10, canvasH: 10 }, MIXED)
    ).toThrow(/does not overlap/i)
  })
})
