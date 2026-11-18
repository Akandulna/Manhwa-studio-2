import { describe, it, expect } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { parseManualNarration, parseNarrationBlock, unresolvedNarrationBlocks } from '../narrationManual.js'

const block = (overrides = {}) => ({ id: 'blocked-15', chapter: 'Chapter 015', language: 'hi', failedAt: '2026-11-11T00:00:00Z',
  reason: 'Prohibited content', stage: 'Final narration check', account: 'Akan', conversationUrl: 'https://aistudio.google.com/prompts/retained_15',
  sourceSha256: 'a'.repeat(64), ...overrides })

describe('narration manual handoff', () => {
  it('validates the external receipt and permits only retained AI Studio conversation links', () => {
    expect(parseNarrationBlock(block())).toMatchObject(block())
    for (const url of ['javascript:alert(1)', 'https://evil.test/prompts/123', 'https://aistudio.google.com/prompts/new_chat', 'https://user@aistudio.google.com/prompts/123']) {
      expect(parseNarrationBlock(block({ conversationUrl: url }))!.conversationUrl).toBeNull()
    }
    for (const value of [null, block({ language: 'unknown' }), block({ chapter: '../Other' }), block({ failedAt: 'bad' })]) expect(parseNarrationBlock(value)).toBeNull()
  })

  it('keeps the latest block across devices and clears it only after a newer matching-language save', async () => {
    const chapters = [{ id: 'c15', folderPath: 'Hero/Chapter 015' }]
    const entries = [{ blocked: [block({ id: 'old', failedAt: '2026-11-10T00:00:00Z' })] }, { blocked: [block()] },
      { chapters: { 'Chapter 015': { status: 'done', savedAt: '2026-11-12T00:00:00Z' } }, hi: { chapters: { 'Chapter 015': { status: 'done', savedAt: '2026-11-10T00:00:00Z' } } } }]
    expect(await unresolvedNarrationBlocks(entries, chapters, 's', 'Nord')).toMatchObject([{ id: 'blocked-15', chapterId: 'c15', seriesId: 's', device: 'Nord' }])
    expect(await unresolvedNarrationBlocks([...entries, { hi: { chapters: { 'Chapter 015': { status: 'done', savedAt: '2026-11-11T00:01:00Z' } } } }], chapters, 's', 'Nord')).toEqual([])
  })

  it('hides a resolved local block even while the phone has not synced the completion', async () => {
    const previous = process.env.DOWNLOAD_ROOT
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'narration-manual-'))
    process.env.DOWNLOAD_ROOT = root
    try {
      await fs.mkdir(path.join(root, 'Hero/Chapter 015'), { recursive: true })
      await fs.writeFile(path.join(root, 'Hero/Chapter 015/.script-replacement.hi.json'), JSON.stringify({ savedAt: '2026-11-11T00:01:00Z' }))
      expect(await unresolvedNarrationBlocks([{ blocked: [block()] }], [{ id: 'c15', folderPath: 'Hero/Chapter 015' }], 's', 'Nord')).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.DOWNLOAD_ROOT; else process.env.DOWNLOAD_ROOT = previous
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('manual narration output', () => {
  it('extracts narration and continuity without voicing bookkeeping markers', () => {
    expect(parseManualNarration('===SCRIPT===\n[SCENE 1: P1-P2]\nवो अंदर जाता है।\n\n[SCENE 2: P3]\nगेट बंद होता है।\n\n===SUMMARY===\nवो गेट के अंदर है।', 'hi'))
      .toEqual({ script: 'वो अंदर जाता है।\n\nगेट बंद होता है।', summary: 'वो गेट के अंदर है।', about: null })
    expect(parseManualNarration('===SCRIPT===\nHe enters.\n\n===SUMMARY===\nHe is inside.\n\n===CLOSING===\nHe enters.\n\n===ABOUT===\nA hunter story.', 'en'))
      .toEqual({ script: 'He enters.', summary: 'He is inside.', about: 'A hunter story.' })
  })
  it('accepts passed review JSON and rejects unresolved reviews, notes, missing sections and Roman Hinglish', () => {
    const good = { passed: true, issues: [], script: '===SCRIPT===\n[SCENE 1: P1]\nवो जाता है।', summary: 'वो चला गया।' }
    expect(parseManualNarration('```json\n' + JSON.stringify(good) + '\n```', 'hi').script).toBe('वो जाता है।')
    for (const text of [JSON.stringify({ ...good, passed: false }), JSON.stringify({ ...good, issues: ['missing'] }),
      '===SCENES===\n[SCENE 1: P1]\n- notes', '===SCRIPT===\nIncomplete',
      '===SCRIPT===\nWoh jaata hai.\n===SUMMARY===\nवो गया।', '===SCRIPT===\nवो गया।\n===SUMMARY===\nसारांश।\n===SCRIPT===\nदोबारा।']) {
      expect(() => parseManualNarration(text, 'hi')).toThrow()
    }
  })
})


it('rejects incomplete or reordered Hinglish scene coverage against its bound English source', () => {
  const english = 'One paragraph here.\n\nA second paragraph here.'
  const output = '===SCRIPT===\n[SCENE 1: P1-P2]\nवो अंदर जाता है और गेट बंद हो जाता है।\n===SUMMARY===\nवो अंदर है।'
  expect(parseManualNarration(output, 'hi', english).script).toContain('वो अंदर')
  for (const range of ['P1', 'P2-P1', 'P1-P3']) expect(() => parseManualNarration(output.replace('P1-P2', range), 'hi', english)).toThrow()
})
