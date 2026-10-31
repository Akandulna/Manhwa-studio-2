import { describe, expect, it, vi } from 'vitest'

vi.mock('../r2Usage.js', () => ({ FREE_PLAN: {}, attachUsageCounter: () => {}, getMonthUsage: () => ({}), monthKey: () => '' }))
vi.mock('../../index.js', () => ({ prisma: {} }))

const { parseScriptRuns } = await import('../r2Service.js')

const NOW = Date.parse('2026-10-07T12:00:00Z')

describe('parseScriptRuns', () => {
  it('reads the narration and voiceover runs ScriptReceipt.kt sends', () => {
    const runs = parseScriptRuns([
      {
        kind: 'narration', series: 'Solo Hero', done: 3, total: 12, paused: false, stopping: false,
        since: '2026-10-07T11:00:00Z', at: '2026-10-07T11:50:00Z',
        tabs: [{ chapter: 'Chapter 004', language: 'hi', since: '2026-10-07T11:50:00Z' }]
      },
      {
        kind: 'voiceover', series: 'Solo Hero', done: 7, total: 40, paused: true, stopping: false, account: 'Work',
        since: '2026-10-07T11:30:00Z', at: '2026-10-07T11:58:00Z',
        tabs: [
          { chapter: 'Chapter 001', language: 'en', split: 8, splits: 20, since: '2026-10-07T11:58:00Z' },
          { chapter: 'Chapter 001', language: 'en', split: 9, splits: 20, since: '2026-10-07T11:57:00Z' }
        ]
      }
    ], NOW)

    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({
      kind: 'narration', series: 'Solo Hero', done: 3, total: 12, paused: false, account: null,
      tabs: [{ chapter: 'Chapter 004', language: 'hi', split: null, splits: null, since: '2026-10-07T11:50:00Z' }]
    })
    expect(runs[1]).toMatchObject({ kind: 'voiceover', paused: true, account: 'Work', done: 7, total: 40 })
    expect(runs[1].tabs.map(t => t.split)).toEqual([8, 9])
  })

  it('drops a run that has not changed in 45 minutes, as one killed with the app', () => {
    const runs = parseScriptRuns([
      { kind: 'voiceover', series: 'Solo Hero', done: 1, total: 4, at: '2026-10-07T11:00:00Z', tabs: [] }
    ], NOW)
    expect(runs).toEqual([])
  })

  it('skips malformed runs and tabs, and tolerates builds without runs', () => {
    expect(parseScriptRuns(undefined, NOW)).toEqual([])
    const runs = parseScriptRuns([
      { kind: 'clipper', series: 'Solo Hero' },
      { kind: 'narration' },
      { kind: 'narration', series: 'Solo Hero', at: '2026-10-07T11:59:00Z', tabs: [{ language: 'en' }, 'x', { chapter: 'Chapter 002' }] }
    ], NOW)
    expect(runs).toHaveLength(1)
    expect(runs[0].tabs).toEqual([{ chapter: 'Chapter 002', language: 'en', split: null, splits: null, since: null }])
  })
})
