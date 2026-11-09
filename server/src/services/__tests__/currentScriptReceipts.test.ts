import { describe, expect, it } from 'vitest'
import { filterRestartedScriptFacts } from '../currentScriptReceipts.js'
import { mergeScriptsReceipts } from '../phoneReceipts.js'

const controls = [{ folder: 'Hero', restart: { at: 123, deviceId: 'note', done: true } }]
const chapter = { status: 'done', savedAt: '2026-11-01T10:00:00Z' }

describe('script receipts after a series restart', () => {
  it('counts only the current restart before merging old and new phones, in both languages', () => {
    const old = { series: { Hero: { total: 20, done: 20, chapters: { 'Chapter 001': chapter, 'Chapter 002': chapter }, hi: { total: 20, done: 20, uploadedAt: 'old', chapters: { 'Chapter 001': chapter, 'Chapter 002': chapter } } } }, runs: [{ series: 'Hero', kind: 'narration' }] }
    const current = { series: { Hero: { restartRevision: '123-note', total: 20, done: 1, chapters: { 'Chapter 001': chapter }, hi: { total: 20, done: 0, chapters: {} } } }, runs: [{ series: 'Hero', kind: 'narration' }] }
    const merged: any = mergeScriptsReceipts([old, current].map((body, i) => ({ device: String(i), name: String(i), body: filterRestartedScriptFacts(body, controls) })))
    expect(merged.series.Hero).toEqual(current.series.Hero)
    expect(merged.runs).toHaveLength(1)
    expect(merged.runs[0].device).toBe('1')
    expect(old.series.Hero.done).toBe(20)
    expect(old.runs).toHaveLength(1)
  })

  it('excludes a different restart and a pending restart, including their runs', () => {
    for (const entry of [{ restartRevision: '122-note' }, { restartRevision: '123-note', restartPending: true }]) {
      const filtered = filterRestartedScriptFacts({ series: { Hero: entry }, runs: [{ series: 'Hero' }] }, controls)
      expect(filtered).toEqual({ series: {}, runs: [] })
    }
  })

  it('keeps legacy series without restarts and unrelated runs unchanged', () => {
    const body = { series: { Other: { total: 1, done: 1 } }, runs: [{ series: 'Other' }] }
    expect(filterRestartedScriptFacts(body, controls)).toBe(body)
    expect(filterRestartedScriptFacts(body, [])).toBe(body)
  })

  it('does not retain an old run without a matching current series entry', () => {
    expect(filterRestartedScriptFacts({ series: {}, runs: [{ series: 'Hero' }, { series: 'Other' }] }, controls).runs).toEqual([{ series: 'Other' }])
  })
})
