import { describe, expect, it } from 'vitest'
import { mergeCropsReceipts, mergeScriptsReceipts, mergeSyncReceipts } from '../phoneReceipts.js'

const phone = (device: string, body: Record<string, unknown>) => ({ device, name: `Phone ${device}`, body })

describe('mergeCropsReceipts', () => {
  it('passes one phone through, only tagging what it is doing', () => {
    const merged = mergeCropsReceipts([phone('a', {
      device: 'Pixel', updatedAt: '2026-10-10T10:00:00Z',
      series: { S: { total: 4, done: 1, working: { chapter: 'C1', page: 'p2' }, chapters: { C1: { total: 4, done: 1, pages: { p1: 'done' }, finished: { p1: { at: 'x' } } } } } },
      profiles: [{ id: 'default', name: 'Main' }]
    })])
    expect(merged.device).toBe('Pixel')
    expect(merged.series).toEqual({ S: {
      total: 4, done: 1,
      working: { chapter: 'C1', page: 'p2', device: 'a', phone: 'Phone a' },
      workingPages: [{ chapter: 'C1', page: 'p2', device: 'a', phone: 'Phone a' }],
      chapters: { C1: { total: 4, done: 1, pages: { p1: 'done' }, finished: { p1: { at: 'x', device: 'a', phone: 'Phone a' } } } }
    } })
    // One phone: profile ids stay as they are.
    expect(merged.profiles).toEqual([{ id: 'default', profileId: 'default', name: 'Main', device: 'a', phone: 'Phone a' }])
  })

  it('adds up pages done on either phone without counting a page twice', () => {
    const merged = mergeCropsReceipts([
      phone('a', {
        updatedAt: '2026-10-10T10:00:00Z', answers: 'old',
        series: { S: { total: 10, done: 3, workingPages: [{ chapter: 'C2', page: 'p1' }], chapters: {
          C1: { total: 3, done: 3, pages: { p1: 'done', p2: 'done', p3: 'done' }, finished: { p3: { at: '2026-10-10T09:00:00Z' } } }
        } } },
        profiles: [{ id: 'default', name: 'Main' }]
      }),
      phone('b', {
        updatedAt: '2026-10-10T11:00:00Z', answers: 'new',
        series: { S: { total: 10, done: 2, workingPages: [{ chapter: 'C3', page: 'p1' }], chapters: {
          C1: { total: 3, done: 1, pages: { p1: 'done', p2: 'changed' }, finished: { p1: { at: '2026-10-10T10:30:00Z' } } },
          C3: { total: 7, done: 1, pages: { p1: 'in_progress', p2: 'done' }, zip: { uploadedAt: '2026-10-10T10:00:00Z' } }
        } } },
        profiles: [{ id: 'default', name: 'Main' }]
      })
    ])
    const series = (merged.series as Record<string, Record<string, unknown>>).S
    expect(series.total).toBe(10)
    // C1: three pages done (one counted once, though both phones have it), C3: one.
    expect(series.done).toBe(4)
    const chapters = series.chapters as Record<string, Record<string, unknown>>
    expect(chapters.C1.pages).toEqual({ p1: 'done', p2: 'done', p3: 'done' })
    // p1's finish is the newest from a phone where it's done.
    expect(chapters.C1.finished).toEqual({
      p1: { at: '2026-10-10T10:30:00Z', device: 'b', phone: 'Phone b' },
      p3: { at: '2026-10-10T09:00:00Z', device: 'a', phone: 'Phone a' }
    })
    expect(chapters.C3).toMatchObject({ total: 7, done: 1, zip: { uploadedAt: '2026-10-10T10:00:00Z' } })
    expect(series.workingPages).toEqual([
      { chapter: 'C2', page: 'p1', device: 'a', phone: 'Phone a' },
      { chapter: 'C3', page: 'p1', device: 'b', phone: 'Phone b' }
    ])
    expect(merged.answers).toBe('new')
    expect(merged.device).toBe('Phone a + Phone b')
    // Same profile id on two phones: made unique.
    expect((merged.profiles as { id: string }[]).map(p => p.id)).toEqual(['a:default', 'b:default'])
  })
})

describe('mergeScriptsReceipts', () => {
  it('keeps the furthest state of each chapter and lists every phone\'s runs', () => {
    const merged = mergeScriptsReceipts([
      phone('a', {
        series: { S: { total: 5, done: 1, chapters: { C1: { status: 'done' }, C2: { status: 'stale' } },
          hi: { total: 5, done: 1, chapters: { C1: { status: 'review' } } } } },
        runs: [{ kind: 'narration', series: 'S' }]
      }),
      phone('b', {
        series: { S: { total: 5, done: 2, chapters: { C2: { status: 'done' }, C3: { status: 'done' } } } },
        runs: [{ kind: 'voiceover', series: 'S' }]
      })
    ])
    expect((merged.series as Record<string, unknown>).S).toEqual({
      total: 5, done: 3,
      chapters: { C1: { status: 'done' }, C2: { status: 'done' }, C3: { status: 'done' } },
      hi: { total: 5, done: 1, chapters: { C1: { status: 'review' } } }
    })
    expect(merged.runs).toEqual([
      { kind: 'narration', series: 'S', device: 'a', phone: 'Phone a' },
      { kind: 'voiceover', series: 'S', device: 'b', phone: 'Phone b' }
    ])
  })
})

describe('mergeSyncReceipts', () => {
  const T1 = '2026-10-08T00:00:00.000Z'
  const T2 = '2026-10-09T00:00:00.000Z'
  const copy = (sentAt: string, state = 'downloaded') => ({ state, etag: 'e', sentAt, at: '2026-10-10T10:00:00Z' })

  it('has a chapter on the phones only once every phone has it, and cleared once every phone cleared it', () => {
    const merged = mergeSyncReceipts([
      phone('a', { version: 2, prefix: '', series: { S: {
        chapters: { C1: copy(T1), C2: copy(T1), C3: copy(T2), C5: copy(T1) },
        cleared: { C4: { at: '2026-10-09T00:00:00Z' } }
      } } }),
      phone('b', { version: 2, prefix: '', series: { S: {
        chapters: { C1: copy(T1, 'downloading'), C3: copy(T1) },
        cleared: { C4: { at: '2026-10-10T00:00:00Z' }, C5: { at: '2026-10-10T00:00:00Z' } }
      } } })
    ])
    expect(merged.prefix).toBe('')
    const series = (merged.series as Record<string, { chapters: Record<string, unknown>; cleared: Record<string, unknown> }>).S
    // C1 still downloading on b; C2 not on b at all; C3 older on b; C5 cleared on b only, so a's copy counts.
    expect(series.chapters).toEqual({
      C1: copy(T1, 'downloading'),
      C3: copy(T1),
      C5: copy(T1)
    })
    // C4 cleared on both: the earlier clear.
    expect(series.cleared).toEqual({ C4: { at: '2026-10-09T00:00:00Z' } })
  })

  it('passes one phone through, and leaves out phones still on whole-series zips', () => {
    const v2 = { version: 2, series: { S: { chapters: { C1: copy(T1) } } } }
    expect(mergeSyncReceipts([phone('a', v2)])).toBe(v2)
    expect(mergeSyncReceipts([phone('a', v2), phone('b', { version: 1, series: {} })])).toBe(v2)
  })
})
