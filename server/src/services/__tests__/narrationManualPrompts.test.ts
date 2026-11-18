import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

vi.mock('../../index.js', () => ({ prisma: {} }))
const { buildManualPrompts, chapterManualPrompts, manualCorrectionPrompt, MANUAL_BATCH_SIZE } = await import('../narrationManualPrompts.js')
const { prisma } = await import('../../index.js')
const { parseManualNarration } = await import('../narrationManual.js')

const base = { seriesTitle: 'Hero', chapterNumber: '15', requireAbout: false, about: 'A hunter story.', previous: { summary: 'So far.', closing: 'He left.' },
  englishScript: null, englishSummary: null }

describe('manual narration prompts', () => {
  it('splits English into batches of sliced pieces, then draft, review and a final step in the saveable format', () => {
    const pages = Array.from({ length: 6 }, (_, i) => `${String(i + 1).padStart(3, '0')}.webp`)
    const pieces = pages.flatMap((source, i) => [1, 2].map(part => ({ file: `P000${i + 1}-T00${part}.jpg`, page: i + 1, part, parts: 2, source })))
    const steps = buildManualPrompts({ ...base, language: 'en', pages, pieces })
    const batches = Math.ceil(pieces.length / MANUAL_BATCH_SIZE)
    expect(steps).toHaveLength(batches + 3)
    expect(steps.slice(0, batches).flatMap(s => s.attach)).toEqual(pieces.map(p => p.file))
    expect(steps[0].prompt).toContain('P0001-T002.jpg - page 1, part 2 of 2')
    expect(steps[0].prompt).toContain('6 pages, cut into 12 images sent in 2 batches')
    expect(steps[batches].prompt).toContain('STORY SO FAR:\nSo far.')
    expect(steps[batches].prompt).not.toContain('===ABOUT===')
    expect(steps[batches + 1].prompt).not.toMatch(/40%|60%/)
    expect(steps.filter(s => s.final)).toEqual([steps.at(-1)])
    expect(steps.at(-1)!.prompt).toMatch(/===SCRIPT===[\s\S]*===SUMMARY===/)

    const reply = '===SCRIPT===\nHe opens the gate.\n\nThe monster falls.\n\n===SUMMARY===\nHe won.\n\n===CLOSING===\nThe monster falls.'
    expect(parseManualNarration(reply, 'en')).toMatchObject({ script: 'He opens the gate.\n\nThe monster falls.', summary: 'He won.' })
  })

  it('asks for ABOUT on the first chapter and refuses a chapter without pages', () => {
    const first = buildManualPrompts({ ...base, language: 'en', pages: ['1.jpg'], requireAbout: true, about: null, previous: null })
    expect(first[1].prompt).toContain('This is CHAPTER 1')
    expect(first.at(-1)!.prompt).toContain('===ABOUT===')
    expect(() => buildManualPrompts({ ...base, language: 'en', pages: [] })).toThrow(/no downloaded pages/)
  })

  it('shows one slice step until the English pages are cut', () => {
    const steps = buildManualPrompts({ ...base, language: 'en', pages: ['1.jpg', '2.jpg'], pieces: null })
    expect(steps[0]).toMatchObject({ slice: true, prompt: '' })
    expect(steps[0].attach).toBeUndefined()
    expect(steps).toHaveLength(4)
  })

  it('numbers the English source for Hinglish and states the length limits the validator enforces', () => {
    const english = 'He opens the gate and walks in.\nThe monster roars at him loudly.\nHe swings his sword and wins.'
    const steps = buildManualPrompts({ ...base, language: 'hi', pages: [], englishScript: english, englishSummary: 'He won.' })
    expect(steps.map(s => s.title)).toEqual(['Scene notes', 'Write the Hinglish', 'Final Hinglish check'])
    expect(steps[0].prompt).toContain('[P3] He swings his sword and wins.')
    expect(steps[0].prompt).toContain('between 17 and 43 words')
    expect(steps[0].prompt).toContain("Keep the English script's pace")
    expect(steps[0].prompt).not.toMatch(/40% (shorter|fewer|cut)|60%/)
    expect(() => buildManualPrompts({ ...base, language: 'hi', pages: [], englishScript: '' })).toThrow(/English script/)

    const reply = '===SCRIPT===\n[SCENE 1: P1-P3]\nवो गेट खोलता है और अंदर चला जाता है।\n\nमॉन्स्टर उस पर ज़ोर से दहाड़ता है।\n\nवो अपनी तलवार घुमाता है और जीत जाता है।\n\n===SUMMARY===\nवो जीत गया।'
    expect(parseManualNarration(reply, 'hi', english).script).not.toContain('SCENE')
  })

  it('builds a same-chat correction prompt from the validation error', () => {
    expect(manualCorrectionPrompt('Too long', 'hi')).toMatch(/^Your final output could not be saved: Too long[\s\S]*SCENE/)
  })

  it('binds ordinary Hinglish prompts to the saved English source without requiring a blocked receipt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manual-prompts-'))
    const previousRoot = process.env.DOWNLOAD_ROOT
    const folderPath = 'Hero/Chapter 015'
    const english = 'He enters the gate.\n\nThe monster waits.\n'
    try {
      process.env.DOWNLOAD_ROOT = root
      await fs.mkdir(path.join(root, folderPath), { recursive: true })
      await fs.writeFile(path.join(root, folderPath, 'script.md'), english)
      Object.assign(prisma, { chapter: {
        findUnique: async () => ({ id: 'c15', seriesId: 's1', number: 15, folderPath, pages: [],
          series: { title: 'Hero', aboutSummary: 'A hunter story.' }, scripts: [{ language: 'en', rollingSummary: 'He found the gate.' }] }),
        findFirst: async () => null
      } })
      const result = await chapterManualPrompts('c15', 'hi')
      expect(result.sourceSha256).toBe(createHash('sha256').update(english.trim()).digest('hex'))
      expect(result.steps.map(s => s.title)).toEqual(['Scene notes', 'Write the Hinglish', 'Final Hinglish check'])
      expect(result.steps[0].prompt).toContain('[P2] The monster waits.')
      expect(result.steps[0].prompt).toContain('He found the gate.')
    } finally {
      if (previousRoot === undefined) delete process.env.DOWNLOAD_ROOT
      else process.env.DOWNLOAD_ROOT = previousRoot
      delete (prisma as any).chapter
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
