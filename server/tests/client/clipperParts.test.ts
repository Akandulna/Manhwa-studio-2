import { describe, expect, it } from 'vitest'
import { canBulkCrop, clipperChapterParts, currentClipperPart } from '../../../client/src/lib/clipperParts'
import { buildProcessSeries, emptyStages } from '../../src/services/seriesProcessModel'
import type { Clipper3ChapterSummary } from '../../../client/src/lib/api'

const series = { id: 's', title: 'Series', rootFolder: 'Series' }
const tracker = (exported: number[], manual: number[] = []) => buildProcessSeries(series, exported.map(number => {
  const stages = emptyStages()
  stages.export_en = { state: 'done' }
  return { id: String(number), name: `Chapter ${number}`, number, stages }
}), manual)
const twenty = Array.from({ length: 20 }, (_, i) => i + 1)

describe('Clipper parts', () => {
  it('keeps numeric twenty-chapter boundaries with gaps and decimal chapters', () => {
    expect(clipperChapterParts([{ number: 41 }, { number: 20 }, { number: 1 }, { number: 21 }, { number: 20.5 }]))
      .toEqual([{ number: 1, chapters: [{ number: 1 }, { number: 20 }] }, { number: 2, chapters: [{ number: 20.5 }, { number: 21 }] }, { number: 3, chapters: [{ number: 41 }] }])
    expect(clipperChapterParts([])).toEqual([])
  })
  it('advances only through consecutively finished parts, with either language or manual completion', () => {
    expect(currentClipperPart()).toBe(1)
    expect(currentClipperPart(tracker(twenty))).toBe(2)
    expect(currentClipperPart(tracker([1, 2, 3]))).toBe(1)
    expect(currentClipperPart(tracker([], [2]))).toBe(1)
    expect(currentClipperPart(tracker([], [1, 2]))).toBe(3)
    const hindi = tracker(twenty)
    for (const chapter of hindi.parts[0].chapters) {
      chapter.stages.export_en = { state: 'pending' }
      chapter.stages.export_hi = { state: 'done' }
    }
    expect(currentClipperPart(hindi)).toBe(2)
  })
  it('offers bulk cropping only for reviewed, fully attached, outdated chapters', () => {
    const ready = { review: { reviewed: true }, fullyAttached: true, cropComplete: false, cropping: false } as Clipper3ChapterSummary
    expect(canBulkCrop(ready)).toBe(true)
    expect(canBulkCrop()).toBe(false)
    expect(canBulkCrop({ ...ready, review: { ...ready.review, reviewed: false } })).toBe(false)
    expect(canBulkCrop({ ...ready, fullyAttached: false })).toBe(false)
    expect(canBulkCrop({ ...ready, cropComplete: true })).toBe(false)
    expect(canBulkCrop({ ...ready, cropping: true })).toBe(false)
  })
})
