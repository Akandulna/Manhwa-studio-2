import { describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ chapters: [] as any[], scripts: {} as Record<string, any>, hi: {} as Record<string, any> }))
vi.mock('../../index.js', () => ({ prisma: {} }))
vi.mock('../voiceoverChapterScope.js', () => ({ voiceoverChapterScope: async (_series: string, part?: number | 'all') => {
  const chapters = state.chapters.filter(c => part === undefined || part === 'all' || Math.ceil(c.number / 20) === part)
  return { chapters, excluded: ['Chapter 001'], parts: { part: part ?? 'all', parts: [], chapters: chapters.map(c => c.id) } }
} }))
vi.mock('../phoneSend.js', () => ({ getSendJob: () => null, getSeriesSendPlan: vi.fn(), startPhoneSend: vi.fn() }))
vi.mock('../phoneEditor.js', () => ({ getEditorReadiness: vi.fn(), publishReadyEditorPackages: vi.fn(), saveEditorPrompt: vi.fn() }))
vi.mock('../r2Service.js', () => ({ requestPhoneUpdate: vi.fn(), getPhoneScripts: async () => ({
  series: { s1: { done: 35, total: 40 } }, chapters: state.scripts,
  hi: { series: { s1: { done: 20, total: 40 } }, chapters: state.hi }
}) }))
import { getRunReadiness } from '../phoneReadiness.js'
describe('Part 2 voiceover checklist', () => {
  it('shows Chapters 21–40 and counts only their scripts', async () => {
    state.chapters = Array.from({ length: 20 }, (_, i) => ({ id: `c${i + 21}`, number: i + 21 }))
    state.scripts = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`c${i + 1}`, { status: 'done' }]))
    state.hi = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${i + 1}`, { status: 'done' }]))
    const english = await getRunReadiness('voiceover', 's1', 'en')
    expect(english.items.find(i => i.id === 'chapter-scope')?.detail).toBe('Ch. 21–40. Completed parts are excluded.')
    expect(english.items.find(i => i.id === 'scripts')?.detail).toBe('15 of 20 chapters have one; the rest aren’t voiced.')
    expect(english.canWork).toBe(true)
    const hindi = await getRunReadiness('voiceover', 's1', 'hi')
    expect(hindi.canWork).toBe(false)
    expect(hindi.items.find(i => i.id === 'scripts')?.state).toBe('blocked')
  })
  it('narrows the checklist to the picked part', async () => {
    state.chapters = Array.from({ length: 40 }, (_, i) => ({ id: `c${i + 1}`, number: i + 1 }))
    state.scripts = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`c${i + 1}`, { status: 'done' }]))
    const part2 = await getRunReadiness('voiceover', 's1', 'en', 2)
    expect(part2.voiceoverScope?.part).toBe(2)
    expect(part2.items.find(i => i.id === 'chapter-scope')?.detail).toBe('Part 2 · Ch. 21–40. Completed parts and other parts are excluded.')
    expect(part2.items.find(i => i.id === 'scripts')?.detail).toBe('5 of 20 chapters have one; the rest aren’t voiced.')
    const part3 = await getRunReadiness('voiceover', 's1', 'en', 3)
    expect(part3.canWork).toBe(false)
    expect(part3.items[0].detail).toBe('No unfinished chapters remain for voiceover in Part 3.')
  })
  it('blocks an all-completed series instead of offering a whole-series start', async () => {
    state.chapters = []
    const result = await getRunReadiness('voiceover', 's1', 'en')
    expect(result.ready).toBe(false)
    expect(result.canWork).toBe(false)
    expect(result.items[0].detail).toBe('No unfinished chapters remain for voiceover.')
  })
})
