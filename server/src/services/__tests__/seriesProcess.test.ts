import { describe, expect, it } from 'vitest'
import { buildProcessSeries, emptyStages, mergeStage, type ProcessChapter } from '../seriesProcessModel.js'

const series = { id: 's', title: 'Demo', rootFolder: 'Demo' }
const chapter = (number: number, en = true, hi = true): ProcessChapter => ({
  id: `c${number}`, name: `Chapter ${number}`, number,
  stages: { ...emptyStages(), export_en: { state: en ? 'done' : 'pending' }, export_hi: { state: hi ? 'done' : 'pending' } }
})

describe('20-chapter series process parts', () => {
  it('marks a part done without inventing chapter files or stage completions, and undo restores automatic progress', () => {
    const chapters = [chapter(1, false, false)]
    const manual = buildProcessSeries(series, chapters, [1])
    expect(manual.completedThrough).toBe(1)
    expect(manual.parts[0]).toMatchObject({ complete: true, manualComplete: true, present: 1 })
    expect(manual.parts[0].stages.export_en.done).toBe(0)
    expect(buildProcessSeries(series, chapters).completedThrough).toBe(0)
    expect(buildProcessSeries(series, [], [1]).parts[0].chapters).toEqual([])
  })
  it('completes a part only with every chapter exported in both languages', () => {
    const chapters = Array.from({ length: 20 }, (_, i) => chapter(i + 1))
    expect(buildProcessSeries(series, chapters).completedThrough).toBe(1)
    chapters[19] = chapter(20, true, false)
    const result = buildProcessSeries(series, chapters)
    expect(result.completedThrough).toBe(0)
    expect(result.parts[0].complete).toBe(false)
    expect(result.parts[0].stages.export_en.done).toBe(20)
    expect(result.parts[0].stages.export_hi.done).toBe(19)
  })

  it('does not complete a partial last part even if every imported chapter is exported', () => {
    const result = buildProcessSeries(series, Array.from({ length: 25 }, (_, i) => chapter(i + 1)))
    expect(result.completedParts).toEqual([1])
    expect(result.parts[1]).toMatchObject({ number: 2, firstChapter: 21, lastChapter: 40, expected: 20, present: 5, complete: false })
  })

  it('does not mistake a hole or an out-of-order completed part for completed earlier parts', () => {
    const result = buildProcessSeries(series, Array.from({ length: 40 }, (_, i) => chapter(i + 1)).filter(c => c.number !== 10))
    expect(result.completedParts).toEqual([2])
    expect(result.completedThrough).toBe(0)
    expect(result.parts[0].stages.export_en).toMatchObject({ done: 19, total: 20 })
  })

  it('moves through successive parts only after each complete 20-chapter range', () => {
    expect(buildProcessSeries(series, Array.from({ length: 60 }, (_, i) => chapter(i + 1))).completedThrough).toBe(3)
    expect(buildProcessSeries(series, []).parts).toEqual([])
  })

  it('never adds duplicate voiceover counts from two devices', () => {
    expect(mergeStage({ state: 'partial', done: 5, total: 10 }, { state: 'partial', done: 5, total: 10 })).toMatchObject({ done: 5, total: 10, state: 'partial' })
    expect(mergeStage({ state: 'partial', done: 5, total: 10 }, { state: 'done', done: 10, total: 10 }).state).toBe('done')
  })
})
