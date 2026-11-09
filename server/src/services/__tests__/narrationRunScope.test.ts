import { describe, expect, it } from 'vitest'
import { narrationRunScope } from '../narrationRunScope.js'
const chapters = Array.from({ length: 60 }, (_, i) => ({ name: `Chapter ${String(i + 1).padStart(3, '0')}`, number: i + 1, complete: false }))
const done = { folder: 'SSS', parts: { '1': { at: 100, done: true, deviceId: 'mac' } } }
describe('Studio narration part scope', () => {
  it('defaults past a manually completed Part 1 even if its Hinglish scripts are missing', () => {
    expect(narrationRunScope(chapters, done)).toMatchObject({ part: 2, chapters: chapters.slice(20, 40).map(c => c.name) })
  })
  it('selects only 21–40; all chapters requires an explicit choice', () => {
    expect(narrationRunScope(chapters, undefined, 2).chapters).toEqual(chapters.slice(20, 40).map(c => c.name))
    expect(narrationRunScope(chapters, done, 'all').chapters).toEqual(chapters.map(c => c.name))
    expect(narrationRunScope(chapters, done, 1).chapters).toEqual(chapters.slice(0, 20).map(c => c.name))
  })
  it('honors completion undo, restart and existing scripts when choosing a default', () => {
    expect(narrationRunScope(chapters, { ...done, restart: { at: 101, done: true, deviceId: 'mac' } }).part).toBe(1)
    expect(narrationRunScope(chapters, { ...done, parts: { '1': { ...done.parts['1'], done: false } } }).part).toBe(1)
    expect(narrationRunScope(chapters.map(c => ({ ...c, complete: c.number <= 20 }))).part).toBe(2)
  })
  it('keeps fractional boundaries and a disappeared selection without widening the run', () => {
    const sparse = [20, 20.5, 40, 41].map(number => ({ name: `Chapter ${number}`, number, complete: false }))
    expect(narrationRunScope(sparse, undefined, 2).chapters).toEqual(['Chapter 20.5', 'Chapter 40'])
    const empty = narrationRunScope(chapters.slice(0, 20), undefined, 2)
    expect(empty.chapters).toEqual([])
    expect(empty.parts.find(p => p.number === 2)?.chapters).toEqual([])
  })
})
