/**
 * Tests for the Video Editor pure helpers (Editor 2.0 export):
 * - duration-normalization (images always sum to the part audio)
 * - no-FFmpeg fallback
 */

import { describe, it, expect } from 'vitest'
import {
  normalizePartDurations,
  splitRenderBatches,
  ensureFfmpegAvailable
} from '../videoMath.js'

const sum = (arr: { duration: number }[]) => arr.reduce((s, x) => s + x.duration, 0)

describe('normalizePartDurations', () => {
  it('scales proportionally so durations sum exactly to the audio duration', () => {
    const out = normalizePartDurations([{ duration: 1 }, { duration: 2 }, { duration: 1 }], 10)
    expect(sum(out)).toBeCloseTo(10, 6)
    // ratios preserved (1:2:1 → 2.5:5:2.5)
    expect(out[0].duration).toBeCloseTo(2.5, 4)
    expect(out[1].duration).toBeCloseTo(5, 4)
  })

  it('equal-splits when all durations are zero', () => {
    const out = normalizePartDurations([{ duration: 0 }, { duration: 0 }, { duration: 0 }], 9)
    expect(sum(out)).toBeCloseTo(9, 6)
    out.forEach(o => expect(o.duration).toBeCloseTo(3, 4))
  })

  it('handles a single image (takes the full audio)', () => {
    const out = normalizePartDurations([{ duration: 0 }], 7.3)
    expect(out).toHaveLength(1)
    expect(out[0].duration).toBeCloseTo(7.3, 6)
  })

  it('returns empty for no images', () => {
    expect(normalizePartDurations([], 5)).toEqual([])
  })

  it('preserves extra fields on each image', () => {
    const out = normalizePartDurations([{ duration: 1, cropId: 'a' }, { duration: 1, cropId: 'b' }], 4)
    expect(out[0].cropId).toBe('a')
    expect(sum(out)).toBeCloseTo(4, 6)
  })
})

describe('ensureFfmpegAvailable (no-FFmpeg fallback)', () => {
  it('throws a clear error when FFmpeg is unavailable', () => {
    expect(() => ensureFfmpegAvailable({ ffmpegAvailable: false })).toThrow(/FFmpeg/)
    expect(() => ensureFfmpegAvailable({ ffmpegAvailable: false, error: 'not on PATH' })).toThrow('not on PATH')
  })

  it('passes when FFmpeg is available', () => {
    expect(() => ensureFfmpegAvailable({ ffmpegAvailable: true })).not.toThrow()
  })
})


describe('splitRenderBatches', () => {
  it('preserves every image, duration and motion in order without splitting an image', () => {
    const images = Array.from({ length: 91 }, (_, i) => ({
      duration: i === 0 ? 45 : 3.25, motionEffect: 'pan-left', id: i
    }))
    const batches = splitRenderBatches(images)
    expect(batches.flat()).toEqual(images)
    batches.flat().forEach((image, i) => expect(image).toBe(images[i]))
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(12)
      if (batch.length > 1) expect(sum(batch)).toBeLessThanOrEqual(30)
    }
    expect(batches[0]).toEqual([images[0]])
  })

  it('bounds very short images by count and handles empty input', () => {
    expect(splitRenderBatches(Array.from({ length: 25 }, () => ({ duration: 0.1 }))).map(b => b.length)).toEqual([12, 12, 1])
    expect(splitRenderBatches([])).toEqual([])
  })
})


it('balances a short chapter across workers without changing its image timings', () => {
  const images = Array.from({ length: 6 }, () => ({ duration: 1.5 }))
  const batches = splitRenderBatches(images, 9 / 3)
  expect(batches.map(batch => batch.length)).toEqual([2, 2, 2])
  expect(batches.flat()).toEqual(images)
})
