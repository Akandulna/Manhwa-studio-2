import { describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ chapters: [] as { id: string; folderPath: string; number: number; completedAt: null }[] }))
vi.mock('../../index.js', () => ({ prisma: {
  series: { findUnique: async () => ({ rootFolder: '/lib/Summon' }) },
  chapter: { findMany: async () => db.chapters }
} }))
vi.mock('../libraryControls.js', () => ({ libraryControls: vi.fn(async () => [{ folder: 'Summon', parts: { '1': { at: 100, deviceId: 'mac', done: true } } }]) }))
import { unfinishedVoiceoverChapters, voiceoverChapterScope } from '../voiceoverChapterScope.js'
import type { LibraryControl } from '../libraryControlModel.js'
const chapters = Array.from({ length: 40 }, (_, i) => ({ number: i + 1, completedAt: null }))
const control: LibraryControl = { folder: 'Summon', parts: { '1': { at: 100, deviceId: 'mac', done: true } } }
describe('voiceover chapter scope', () => {
  it('retains exactly Chapters 21–40 when Part 1 is complete', () => {
    expect(unfinishedVoiceoverChapters(chapters, control).map(c => c.number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 21))
  })
  it('honors undo and a newer series restart without dropping partial parts', () => {
    expect(unfinishedVoiceoverChapters(chapters, { ...control, parts: { '1': { at: 101, deviceId: 'mac', done: false } } })).toEqual(chapters)
    expect(unfinishedVoiceoverChapters(chapters, { ...control, restart: { at: 101, deviceId: 'mac', done: true } })).toEqual(chapters)
    expect(unfinishedVoiceoverChapters(chapters.slice(20, 34), control)).toHaveLength(14)
  })
  it('excludes archived chapters and uses the same fractional chapter boundaries as production parts', () => {
    expect(unfinishedVoiceoverChapters([{ number: 20, completedAt: null }, { number: 20.5, completedAt: null }, { number: 21, completedAt: 'saved' }], control)).toEqual([{ number: 20.5, completedAt: null }])
  })
  it('keeps only the picked part and excludes the rest', async () => {
    db.chapters = Array.from({ length: 60 }, (_, i) => ({ id: `c${i + 1}`, folderPath: `/lib/Summon/Chapter ${i + 1}`, number: i + 1, completedAt: null }))
    const all = await voiceoverChapterScope('s1')
    expect(all.chapters.map(c => c.number)).toEqual(Array.from({ length: 40 }, (_, i) => i + 21))
    expect(all.parts.part).toBe('all')
    expect(all.parts.parts.map(p => p.number)).toEqual([2, 3])
    const part2 = await voiceoverChapterScope('s1', 2)
    expect(part2.chapters.map(c => c.number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 21))
    expect(part2.excluded).toHaveLength(40)
    expect(part2.parts.chapters).toEqual(part2.chapters.map(c => `Chapter ${c.number}`))
  })
})
