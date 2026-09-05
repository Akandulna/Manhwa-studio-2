/**
 * Tests for the Video Editor pure helpers (Module 4):
 * - duration-normalization (images always sum to the part audio)
 * - crop-order / slotIndex derivation
 * - monotonic AI suggestion range constraint
 * - no-music / no-FFmpeg fallbacks
 */

import { describe, it, expect } from 'vitest'
import {
  normalizePartDurations,
  deriveSlotOrder,
  clampSuggestionRange,
  chooseMixMode,
  ensureFfmpegAvailable,
  clampVolume
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

describe('deriveSlotOrder', () => {
  const seq = new Map([['a', 1], ['b', 3], ['c', 7]])

  it('orders crop-backed images by crop sequence regardless of input order', () => {
    const out = deriveSlotOrder([{ cropId: 'c' }, { cropId: 'a' }, { cropId: 'b' }], seq)
    expect(out.map(o => o.item.cropId)).toEqual(['a', 'b', 'c'])
    expect(out.map(o => o.slotIndex)).toEqual([0, 1, 2])
  })

  it('keeps a filler in the place it was dropped between crops', () => {
    const out = deriveSlotOrder([{ cropId: 'a' }, { cropId: null }, { cropId: 'c' }], seq)
    expect(out.map(o => o.item.cropId ?? 'filler')).toEqual(['a', 'filler', 'c'])
  })

  it('assigns a contiguous 0-based slotIndex', () => {
    const out = deriveSlotOrder([{ cropId: 'b' }, { cropId: null }, { cropId: 'a' }], seq)
    expect(out.map(o => o.slotIndex)).toEqual([0, 1, 2])
  })
})

describe('clampSuggestionRange', () => {
  it('clamps within [first, last] and rounds', () => {
    expect(clampSuggestionRange(2.4, 5.6, 1, 10)).toEqual({ start: 2, end: 6 })
    expect(clampSuggestionRange(-3, 99, 1, 10)).toEqual({ start: 1, end: 10 })
  })

  it('keeps start <= end', () => {
    expect(clampSuggestionRange(8, 3, 1, 10)).toEqual({ start: 8, end: 8 })
  })

  it('enforces forward-only via first (non-overlapping across parts)', () => {
    // previous part ended at crop 4 → first = 5
    const r = clampSuggestionRange(2, 7, 5, 10)
    expect(r.start).toBe(5)
    expect(r.end).toBe(7)
  })
})

describe('chooseMixMode (no-music fallbacks)', () => {
  it('mixes when a music track is present', () => {
    expect(chooseMixMode({ musicPath: '/m.mp3', masterVolume: 1 })).toBe('music')
  })

  it('applies a volume-only pass when there is no music but master != 1', () => {
    expect(chooseMixMode({ musicPath: null, masterVolume: 0.5 })).toBe('volume')
  })

  it('straight-copies when there is no music and unity master volume', () => {
    expect(chooseMixMode({ musicPath: null, masterVolume: 1 })).toBe('copy')
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

describe('clampVolume', () => {
  it('clamps to [0,1] and defaults non-finite to 1', () => {
    expect(clampVolume(-1)).toBe(0)
    expect(clampVolume(2)).toBe(1)
    expect(clampVolume(0.3)).toBeCloseTo(0.3)
    expect(clampVolume(NaN)).toBe(1)
  })
})
