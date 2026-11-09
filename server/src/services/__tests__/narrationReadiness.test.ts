import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ chapters: [] as any[], controls: [] as any[] }))
vi.mock('../../index.js', () => ({ prisma: {} }))
vi.mock('../libraryControls.js', () => ({ libraryControls: async () => state.controls }))
vi.mock('../phoneSend.js', () => ({ getSendJob: () => null, getSeriesSendPlan: async () => ({ folder: 'SSS', chapters: state.chapters }), startPhoneSend: vi.fn() }))
vi.mock('../phoneEditor.js', () => ({ getEditorReadiness: vi.fn(), publishReadyEditorPackages: vi.fn(), saveEditorPrompt: vi.fn() }))
vi.mock('../r2Service.js', () => ({ requestPhoneUpdate: vi.fn(), getPhoneScripts: vi.fn() }))
import { getRunReadiness } from '../phoneReadiness.js'
beforeEach(() => {
  state.controls = [{ folder: 'SSS', parts: { '1': { at: 100, deviceId: 'mac', done: true } } }]
  state.chapters = Array.from({ length: 60 }, (_, i) => ({ chapterId: `c${i + 1}`, folder: `Chapter ${String(i + 1).padStart(3, '0')}`, number: i + 1,
    state: 'on_phone', needsStitch: false, desktop: { published: false, script: false, scriptHi: false } }))
})
describe('Studio narration readiness for the selected part', () => {
  it('defaults to Part 2 and ignores missing or unstitched earlier/later chapters', async () => {
    state.chapters[14].state = 'new'; state.chapters[14].needsStitch = true
    state.chapters[40].state = 'new'; state.chapters[40].needsStitch = true
    const check = await getRunReadiness('narration', 'sss', 'en')
    expect(check.narrationScope?.part).toBe(2)
    expect(check.narrationScope?.chapters).toEqual(state.chapters.slice(20, 40).map(c => c.folder))
    expect(check.items.find(i => i.id === 'chapter-scope')?.detail).toContain('Chapters 21–40 only (20 chapters)')
    expect(check.ready).toBe(true)
    expect(check.items.some(i => i.id === 'stitch')).toBe(false)
    expect((await getRunReadiness('narration', 'sss', 'en', 'all')).ready).toBe(false)
  })
  it('limits Get ready & start page sending to the chosen part', async () => {
    for (const c of state.chapters) c.state = 'new'
    const check = await getRunReadiness('narration', 'sss', 'en', 2)
    expect(check.ready).toBe(false)
    expect(check.items.find(i => i.id === 'pages')?.fix?.chapterIds).toEqual(state.chapters.slice(20, 40).map(c => c.chapterId))
  })
  it('keeps an unavailable Part 2 blocked instead of falling back to Part 1', async () => {
    state.chapters = state.chapters.slice(0, 20)
    const check = await getRunReadiness('narration', 'sss', 'en', 2)
    expect(check.narrationScope).toMatchObject({ part: 2, chapters: [] })
    expect(check.ready).toBe(false)
    expect(check.canWork).toBe(false)
    expect(check.items.find(i => i.id === 'pages')?.fix).toBeUndefined()
  })
})
