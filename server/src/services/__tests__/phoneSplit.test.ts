import { describe, expect, it, vi } from 'vitest'

vi.mock('../r2Usage.js', () => ({ FREE_PLAN: {}, attachUsageCounter: () => {}, getMonthUsage: () => ({}), monthKey: () => '' }))
vi.mock('../../index.js', () => ({ prisma: {} }))

const { buildSplitPlan, splitState } = await import('../phoneSplit.js')
type SplitPhone = import('../phoneSplit.js').SplitPhone
type SplitInput = import('../phoneSplit.js').SplitInput

const NOW = Date.parse('2026-10-15T12:00:00Z')
const AT = '2026-10-15T11:55:00Z'
const SERIES = 'Solo Hero'

const CHAPTERS = [1, 2, 3, 4, 5, 6].map(n => ({ folder: `Chapter 00${n}`, number: n, pageCount: 10 }))
const ch = (...ns: number[]) => ns.map(n => `Chapter 00${n}`)

const NEW = { remoteStart: true, runs: ['clipper', 'narration', 'editor', 'voiceover'], chapterRuns: ['clipper', 'narration', 'editor', 'voiceover'], rescope: true, editor: { tabs: 1 } }

function phone(id: string, parts: Partial<Omit<SplitPhone, 'id' | 'name'>> = {}): SplitPhone {
  return { id, name: id.toUpperCase(), automation: NEW, sync: null, scripts: null, crops: null, ...parts }
}

const run = (kind: string, series: string, chapters: string[], extra: Record<string, unknown> = {}) => ({
  kind, series, done: 0, total: 6, paused: false, stopping: false, at: AT,
  tabs: chapters.map(chapter => ({ chapter, language: 'en', since: AT })), ...extra
})

const plan = (input: Partial<SplitInput> & Pick<SplitInput, 'kind' | 'phones'>) =>
  buildSplitPlan({ seriesId: 's1', series: SERIES, language: 'en', all: input.phones, chapters: CHAPTERS, now: NOW, ...input })

describe('splitState', () => {
  it('tells a phone on this run from one on something else', () => {
    const narrating = phone('a', { scripts: { runs: [run('narration', SERIES, ch(2))] } })
    expect(splitState('voiceover', SERIES, 'en', narrating, NOW)).toMatchObject({ state: 'busyOther', reason: 'busy: Narration scripts · Solo Hero' })
    expect(splitState('editor', SERIES, 'en', narrating, NOW)).toMatchObject({ state: 'busyOther' })
    const editing = phone('h', { scripts: { runs: [run('editor', SERIES, ch(2))] } })
    expect(splitState('editor', SERIES, 'en', editing, NOW)).toEqual({ state: 'busySame', inProgress: ch(2) })
    expect(splitState('editor', 'Other', 'en', editing, NOW)).toMatchObject({ state: 'busyOther', reason: 'busy: Editor 2.0 timelines · Solo Hero (English)' })
    // Image Clipper is busy with any scripts run, and the scripts runs with any clipping.
    expect(splitState('clipper', SERIES, 'en', narrating, NOW)).toMatchObject({ state: 'busyOther' })
    const clipping = phone('b', { crops: { series: { [SERIES]: { workingPages: [{ chapter: 'Chapter 003', page: 'p1.webp', since: AT, paused: true }] } } } })
    expect(splitState('clipper', SERIES, 'en', clipping, NOW)).toEqual({ state: 'busySame', inProgress: ch(3) })
    expect(splitState('editor', SERIES, 'en', clipping, NOW)).toMatchObject({ state: 'busyOther', reason: 'busy: Image Clipper · Solo Hero' })
    // A paused run is still busy. Editor 2.0 and the voiceover in the other language are something else: the
    // run's `language`, else its tabs'.
    const paused = phone('c', { scripts: { runs: [run('editor', SERIES, ch(4), { paused: true })] } })
    expect(splitState('voiceover', SERIES, 'en', paused, NOW)).toMatchObject({ reason: 'busy: Editor 2.0 timelines · Solo Hero (English) (paused)' })
    expect(splitState('editor', SERIES, 'hi', paused, NOW)).toMatchObject({ state: 'busyOther', reason: 'busy: Editor 2.0 timelines · Solo Hero (English) (paused)' })
    expect(splitState('editor', SERIES, 'en', paused, NOW)).toEqual({ state: 'busySame', inProgress: ch(4) })
    const hindi = phone('e', { scripts: { runs: [run('voiceover', SERIES, ch(5), { language: 'hi', tabs: [{ chapter: 'Chapter 005', since: AT }] })] } })
    expect(splitState('voiceover', SERIES, 'hi', hindi, NOW)).toEqual({ state: 'busySame', inProgress: ch(5) })
    expect(splitState('voiceover', SERIES, 'en', hindi, NOW)).toMatchObject({ state: 'busyOther', reason: 'busy: Voiceover · Solo Hero (Hindi)' })
    // Language not known (no tabs, no `language`): taken as this run, so it's rescoped rather than left on the whole series.
    const unknown = phone('f', { scripts: { runs: [run('voiceover', SERIES, [])] } })
    expect(splitState('voiceover', SERIES, 'hi', unknown, NOW)).toEqual({ state: 'busySame', inProgress: [] })
    expect(splitState('editor', SERIES, 'en', phone('d'), NOW)).toEqual({ state: 'idle' })
  })
})

describe('buildSplitPlan', () => {
  it('never splits narration scripts: one phone writes a series in order', async () => {
    await expect(plan({ kind: 'narration', phones: [phone('a'), phone('b')] }))
      .rejects.toThrow('Narration scripts run on one phone at a time: start it on one phone')
  })

  it('keeps a phone already on the run on its chapter and rescopes it', async () => {
    const a = phone('a', { scripts: { runs: [run('editor', SERIES, ch(3))] } })
    const result = await plan({ kind: 'editor', phones: [a, phone('b')], editorWaiting: async () => ch(1, 2, 3, 4) })
    // A's Chapter 003 counts toward its load: B takes 1, A 2 (a tie, to the first), B 4.
    expect(result.targets).toEqual([
      { device: 'a', name: 'A', chapters: ch(2, 3), inProgress: ch(3), action: 'rescope' },
      { device: 'b', name: 'B', chapters: ch(1, 4), inProgress: [], action: 'start' }
    ])
    expect(result.numbers).toEqual({ 'Chapter 001': 1, 'Chapter 002': 2, 'Chapter 003': 3, 'Chapter 004': 4 })
  })

  it('refuses a phone on the run whose build would start over', async () => {
    const a = phone('a', { automation: { ...NEW, rescope: false }, scripts: { runs: [run('voiceover', SERIES, ch(1))] } })
    await expect(plan({ kind: 'voiceover', phones: [a, phone('b')] }))
      .rejects.toThrow('A is already running this with an older Sleeper-Cell. Stop it or update the app.')
  })

  it('leaves a phone busy with something else out, and needs two free ones', async () => {
    const busy = phone('a', { scripts: { runs: [run('voiceover', 'Other Series', ch(1))] } })
    const free = [phone('b'), phone('c')]
    const waiting = async () => ch(1, 2, 3)
    const result = await plan({ kind: 'editor', phones: [busy, ...free], editorWaiting: waiting })
    expect(result.targets).toEqual([
      { device: 'a', name: 'A', chapters: [], inProgress: [], action: 'skip', reason: 'busy: Voiceover · Other Series (English)' },
      { device: 'b', name: 'B', chapters: ch(1, 3), inProgress: [], action: 'start' },
      { device: 'c', name: 'C', chapters: ch(2), inProgress: [], action: 'start' }
    ])
    await expect(plan({ kind: 'editor', phones: [busy, free[0]], editorWaiting: waiting }))
      .rejects.toThrow('Splitting needs two phones free for Editor 2.0 timelines: A is busy: Voiceover · Other Series (English)')
  })

  it('needs every phone to take a share of the run', async () => {
    const old = phone('a', { automation: { remoteStart: true, runs: ['clipper', 'narration', 'editor', 'voiceover'] } })
    await expect(plan({ kind: 'voiceover', phones: [old, phone('b')] })).rejects.toThrow('Update Sleeper-Cell on A to split Voiceover')
    // Image Clipper always took one.
    const clip = await plan({ kind: 'clipper', phones: [old, phone('b')] })
    expect(clip.targets.map(t => t.chapters.length)).toEqual([3, 3])
    // Editor 2.0 from builds that said its tabs, before `chapterRuns`.
    const editor = await plan({ kind: 'editor', phones: [{ ...old, automation: { remoteStart: true, editor: { tabs: 2 } } }, phone('b')], editorWaiting: async () => ch(1, 2) })
    expect(editor.targets.map(t => t.chapters)).toEqual([ch(1), ch(2)])
  })

  it('voices each chapter on a phone with its newest script, leaving out voiced ones', async () => {
    const scripts = (chapters: Record<string, object>) => ({ series: { [SERIES]: { chapters } } })
    const a = phone('a', { scripts: scripts({
      'Chapter 001': { status: 'done', savedAt: '2026-10-10T00:00:00Z', voiceover: { status: 'uploaded' } },
      'Chapter 002': { status: 'done', savedAt: '2026-10-10T00:00:00Z' },
      'Chapter 003': { status: 'needs_summary', savedAt: '2026-10-12T00:00:00Z' },
      'Chapter 004': { status: 'stale', savedAt: '2026-10-12T00:00:00Z' }
    }) })
    const b = phone('b', { scripts: scripts({
      // Older than A's: B's audio doesn't count, and B can't take it.
      'Chapter 002': { status: 'done', savedAt: '2026-10-01T00:00:00Z', voiceover: { status: 'voiced' } },
      'Chapter 003': { status: 'done', savedAt: '2026-10-12T00:00:00Z' },
      'Chapter 005': { status: 'review', savedAt: '2026-10-12T00:00:00Z' }
    }) })
    const result = await plan({ kind: 'voiceover', phones: [a, b] })
    expect(result.targets).toEqual([
      { device: 'a', name: 'A', chapters: ch(2), inProgress: [], action: 'start' },
      { device: 'b', name: 'B', chapters: ch(3, 5), inProgress: [], action: 'start' }
    ])
    // Hindi reads the `hi` scripts.
    const hindi = phone('c', { scripts: { series: { [SERIES]: { hi: { chapters: { 'Chapter 006': { status: 'review', savedAt: AT } } } } } } })
    const hi = await plan({ kind: 'voiceover', language: 'hi', phones: [hindi, phone('d')] })
    expect(hi.targets.map(t => [t.device, t.chapters, t.action])).toEqual([['c', ch(6), 'start'], ['d', [], 'skip']])
  })

  it('pins Image Clipper\'s pages in progress and has a phone with nothing left finish', async () => {
    const crops = (working: object[]) => ({ series: { [SERIES]: {
      workingPages: working,
      chapters: Object.fromEntries(ch(1, 2, 3, 4, 5).map(c => [c, {
        total: 10, done: 10, pages: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}.webp`, 'done']))
      }]))
    } } })
    const a = phone('a', { crops: crops([{ chapter: 'Chapter 006', page: 'p3.webp', since: AT }]) })
    const b = phone('b', { crops: crops([{ chapter: 'Chapter 006', page: 'p4.webp', since: AT }]) })
    // Both on Chapter 006 (pages of it), and nothing else left: A keeps it, B finishes its page of it, then stops.
    const result = await plan({ kind: 'clipper', phones: [a, b] })
    expect(result.targets.map(t => [t.device, t.chapters, t.inProgress, t.action])).toEqual([
      ['a', ch(6), ch(6), 'rescope'], ['b', [], ch(6), 'finish']
    ])
    const idle = phone('c', { crops: crops([]) })
    const rest = await plan({ kind: 'clipper', phones: [a, idle] })
    expect(rest.targets.map(t => [t.device, t.chapters, t.action])).toEqual([['a', ch(6), 'rescope'], ['c', [], 'skip']])
  })
})
