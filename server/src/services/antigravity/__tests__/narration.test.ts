/**
 * AntiGravity Narration's checks (narrationFlow.ts) and piece cutting (narrationPieces.ts): notes are matched by the
 * check code read off each piece, never by position; names must be printed on the pages or given by the background;
 * pages are cut into labelled pieces agy shows at full size (at most 2,000 px a side with the band).
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import * as flow from '../narrationFlow.js'
import { PACING_RULES, lengthCutRule, lengthCutTarget, narrationWords } from '../../narrationRules.js'
import { HINGLISH_PACING_RULES } from '../../hinglishRules.js'
import { AGY_MAX_SIDE, bandSvg, blankCuts, checkCode, pieceSizes, prepareChapterPages, type Piece } from '../narrationPieces.js'

const piece = (page: number, part: number, check: string): Piece => ({
  id: `P${String(page).padStart(4, '0')}-T${String(part).padStart(3, '0')}`, page, part, parts: 1, source: `page_${page}.png`,
  top: 0, bottom: 100, check, file: `/tmp/${page}-${part}.jpg`, width: 700, height: 164
})
const batch = [piece(1, 1, 'ACDE'), piece(2, 1, 'K7QM'), piece(3, 1, 'XY34')]
const entry = (p: Piece, extra: Record<string, unknown> = {}) => ({
  id: p.id, check: p.check, opening: `Start ${p.id}`, events: [`Event ${p.id}`], text: [`TEXT ${p.id}`], closing: `End ${p.id}`, nonStory: false, uncertainties: [], ...extra
})
const reject = (fn: () => unknown, message: RegExp) => expect(fn).toThrow(message)

describe('batches and submissions', () => {
  const pieces = Array.from({ length: 23 }, (_, i) => piece(i + 1, 1, 'ACDE'))
  it('splits pieces into batches of 10, the last one shorter', () => {
    expect(flow.BATCH_SIZE).toBe(10)
    expect(flow.batches(pieces).map(b => b.length)).toEqual([10, 10, 3])
  })

  it('reuses a notes task only for exactly the same pieces; older tasks fall back to their batch number', () => {
    const state = flow.startState('r', pieces)
    const task = (extra: Partial<flow.NotesTask>): flow.NotesTask => ({ schema: 'studio-ag-narration-notes/1', parentAttemptId: 'p', batchNumber: 2, accepted: false, issues: [], ...extra })
    const second = flow.batches(pieces)[1]
    expect(flow.readsPieces(task({ pieceIds: second.map(p => p.id) }), second)).toBe(true)
    expect(flow.readsPieces(task({ pieceIds: pieces.slice(5, 10).map(p => p.id) }), second)).toBe(false)
    expect(flow.readsPieces(task({}), second)).toBe(false)
    expect(flow.taskPieces(task({ pieceIds: ['P0006-T001', 'P0007-T001'] }), state)!.map(p => p.id)).toEqual(['P0006-T001', 'P0007-T001'])
    expect(flow.taskPieces(task({ pieceIds: ['P0099-T001'] }), state)).toBeNull()
    expect(flow.taskPieces(task({}), state)).toEqual(second)
    expect(flow.parseNotesTask(JSON.stringify(task({ pieceIds: ['a'] })))?.pieceIds).toEqual(['a'])
    expect(flow.parseNotesTask(JSON.stringify(task({ pieceIds: [1] as any })))).toBeNull()
  })

  it('takes a submission under json, as the arguments themselves, or as the one value under another name', () => {
    const notes = { pieces: [{ id: 'x' }] }
    const text = JSON.stringify(notes)
    expect(flow.submittedText({ json: text }, 'json', 'pieces')).toBe(text)
    expect(flow.submittedText({ json: notes }, 'json', 'pieces')).toBe(text)
    expect(flow.submittedText(notes, 'json', 'pieces')).toBe(text)
    expect(flow.submittedText({ notes }, 'json', 'pieces')).toBe(text)
    expect(flow.submittedText({ submission: text }, 'json', 'pieces')).toBe(text)
    expect(flow.submittedText({ body: 'draft' }, 'text')).toBe('draft')
    reject(() => flow.submittedText({}, 'json', 'pieces'), /empty.*argument named json/)
    reject(() => flow.submittedText({ a: '1', b: '2' }, 'json', 'pieces'), /one argument named json \(got a, b\)/)
  })
})

describe('narration notes', () => {
  it('match each entry by its ID and check code and come back in page order, whatever order they were given in', () => {
    const notes = flow.readNotes(JSON.stringify({ pieces: [entry(batch[2]), entry(batch[0]), entry(batch[1])] }), batch)
    expect(notes.map(n => n.id)).toEqual(batch.map(p => p.id))
    expect(notes[1].text).toEqual(['TEXT P0002-T001'])
  })

  it('refuse a wrong or missing check code: the band was not read', () => {
    for (const check of ['ZZZZ', '', undefined]) {
      const rows: Record<string, unknown>[] = batch.map(p => entry(p))
      rows[1] = { ...rows[1], check }
      reject(() => flow.readNotes(JSON.stringify({ pieces: rows }), batch), /check code for P0002-T001 is wrong/)
    }
    // Case and spaces are forgiven.
    const loose = batch.map(p => entry(p, { check: ` ${p.check.toLowerCase().split('').join(' ')} ` }))
    expect(flow.readNotes(JSON.stringify({ pieces: loose }), batch)).toHaveLength(3)
  })

  it('refuse missing, duplicated or unknown pieces, unresolved evidence and notes without printed text', () => {
    reject(() => flow.readNotes(JSON.stringify({ pieces: [entry(batch[0]), entry(batch[1])] }), batch), /exactly one entry for each of the 3/)
    reject(() => flow.readNotes(JSON.stringify({ pieces: [entry(batch[0]), entry(batch[0]), entry(batch[1])] }), batch), /appears twice/)
    reject(() => flow.readNotes(JSON.stringify({ pieces: [entry(batch[0]), entry(batch[1]), { ...entry(batch[2]), id: 'P0009-T001' }] }), batch), /Unknown piece ID/)
    // A doubt blocks only a piece with nothing readable.
    reject(() => flow.readNotes(JSON.stringify({ pieces: batch.map((p, i) => entry(p, i ? {} : { uncertainties: ['Bubble unreadable'], events: [], text: [] })) }), batch), /Unresolved evidence/)
    const noText = batch.map(p => entry(p)) as Record<string, unknown>[]
    delete noText[0].text
    reject(() => flow.readNotes(JSON.stringify({ pieces: noText }), batch), /Missing text array/)
  })
})

describe('narration notes with readable story and a doubt', () => {
  it('keep the doubt as unclear instead of refusing the batch', () => {
    const notes = flow.readNotes(JSON.stringify({ pieces: batch.map((p, i) => entry(p, i ? {} : { uncertainties: ['First words of the faded bubble are not legible'] })) }), batch)
    expect(notes[0].unclear).toEqual(['First words of the faded bubble are not legible'])
    expect(notes[1].unclear).toBeUndefined()
  })
})

describe('narration review', () => {
  const notes: flow.Note[] = [
    { id: 'P0001-T001', opening: 'a', events: ['b'], text: ['ABELLA, FROM THE MAGIC TOWER', 'LORD ARTHUR, HERE! A POTION!'], closing: 'c', nonStory: false },
    { id: 'P0001-T002', opening: 'a', events: ['b'], text: [], closing: 'c', nonStory: false }
  ]
  const review = (texts: string[], extra: Record<string, unknown> = {}) => JSON.stringify({
    passed: true, issues: [], corrections: [], nonStoryImages: [], summary: 'S', closing: texts.at(-1),
    paragraphs: texts.map((text, i) => ({ text, images: [notes[i].id] })), ...extra
  })
  const background = 'Series\nCrash Valheim was betrayed.'

  it('accepts names printed on the pages or in the background, and refuses invented ones', () => {
    expect(flow.readReview(review(['Abella turns to Arthur.', 'Lord Arthur looks at Crash, and Crash waits.']), notes, false, background).reply.script)
      .toBe('Abella turns to Arthur.\n\nLord Arthur looks at Crash, and Crash waits.')
    reject(() => flow.readReview(review(['The healer Alicia leans on Arthur.', 'He names Lucifer.']), notes, false, background), /Alicia, Lucifer/)
    // Spelling counts: the pages print Valheim.
    expect(flow.unsupportedNames('The boy Crash Valhein stands.', notes, background)).toEqual(['Valhein'])
    // Sentence starts and quotations are not names.
    expect(flow.unsupportedNames('Arthur stops. Everyone waits. He asks, "Why now?" Nobody answers.', notes, background)).toEqual([])
  })

  it('keeps coverage and order: every story piece, never backward, the closing is the last paragraph', () => {
    reject(() => flow.readReview(JSON.stringify({ ...JSON.parse(review(['One.', 'Two.'])), paragraphs: [{ text: 'Two.', images: ['P0001-T002'] }, { text: 'One.', images: ['P0001-T001'] }], closing: 'One.' }), notes, false, background), /moves backward/)
    reject(() => flow.readReview(JSON.stringify({ ...JSON.parse(review(['One.', 'Two.'])), paragraphs: [{ text: 'One.', images: ['P0001-T001'] }], closing: 'One.' }), notes, false, background), /omits story pieces: P0001-T002/)
    reject(() => flow.readReview(review(['One.', 'Two.'], { closing: 'Other.' }), notes, false, background), /closing must exactly equal/)
    reject(() => flow.readReview(review(['One.', 'Two.']), notes, true, background), /Missing about text/)
  })

  it('the final check keeps the paragraph map and removes presentation wording', () => {
    const reviewed = flow.readReview(review(['One.', 'Two.']), notes, false, background).review
    expect(flow.readCheck(review(['One.', 'Two.']), notes, false, reviewed, background).reply.closing).toBe('Two.')
    reject(() => flow.readCheck(review(['A title card appears.', 'Two.'], { corrections: ['x'] }), notes, false, reviewed, background), /presentation wording: title card/)
    reject(() => flow.readCheck(review(['One again.', 'Two.']), notes, false, reviewed, background), /Describe the narration edits/)
  })

  it('a draft needs its script, summary and closing (and the overview for a first chapter)', () => {
    const draft = '===SCRIPT===\nOne.\n\nTwo.\n===SUMMARY===\nS.\n===CLOSING===\nTwo.'
    expect(flow.checkDraft(draft, false).closing).toBe('Two.')
    reject(() => flow.checkDraft(draft, true), /ABOUT/)
    reject(() => flow.checkDraft(draft.replace('===CLOSING===\nTwo.', '===CLOSING===\nOne.'), false), /CLOSING must exactly match/)
  })

  it('the English review aims ~30% under the draft, at most 560 words; Hinglish rules carry no cut; nothing enforces a word count', () => {
    expect(lengthCutTarget(1000)).toBe(560)
    expect(lengthCutTarget(700)).toBe(490)
    expect(lengthCutTarget(5000)).toBe(560)
    const state = { ...flow.startState('r', []), draft: { script: 'word '.repeat(1000).trim(), summary: 'S', closing: 'word', about: null } }
    const input = { seriesTitle: 'S', chapterNumber: 1, requireAbout: false, about: null, previous: null, pages: [], scriptSha256: null } as unknown as flow.NarrationInput
    const review = flow.reviewPrompt(input, state)
    expect(review).toContain('about 1000 spoken words. Make the final narration shorter: aim for roughly 560 words')
    expect(review).toContain('up to about 640 words')
    expect(flow.draftPrompt(input, state)).not.toContain('LENGTH CUT')
    expect(lengthCutRule()).toContain('no more than about 560 words')
    expect(HINGLISH_PACING_RULES).not.toContain('LENGTH CUT')
  })

  it('has no percentage word cut in the pace rules, and long scripts are accepted', () => {
    expect(PACING_RULES).not.toMatch(/40%|60%|30%/)
    expect(narrationWords('वो गेट खोलता है।')).toBe(4)
    const long = review(['word '.repeat(300).trim(), 'word '.repeat(300).trim()])
    const accepted = flow.readReview(long, notes, false, background)
    expect(narrationWords(accepted.reply.script)).toBe(600)
    expect(narrationWords(flow.readCheck(long, notes, false, accepted.review, background).reply.script)).toBe(600)
  })
})

describe('narration pieces', () => {
  it('cut at the gutter nearest the target, within the size limits, without a tiny tail', () => {
    const sizes = pieceSizes(709)
    expect(sizes.max + bandSvg(709, 'ID').height).toBe(AGY_MAX_SIDE)
    const blank = (y: number) => y > 0 && y % 1500 < 40
    const cuts = blankCuts(12_000, blank, sizes)
    expect(cuts[0][0]).toBe(0)
    expect(cuts.at(-1)![1]).toBe(12_000)
    cuts.slice(1).forEach(([top], i) => { expect(top).toBe(cuts[i][1]); expect(blank(top)).toBe(true) })
    expect(cuts.every(([a, b]) => b - a >= sizes.min && b - a <= sizes.max)).toBe(true)
    // No gutter in reach: straight cuts, and the last piece is never a sliver.
    expect(blankCuts(sizes.max + 100, () => false, sizes).every(([a, b]) => b - a >= sizes.min)).toBe(true)
    expect(blankCuts(sizes.max, () => true, sizes)).toEqual([[0, sizes.max]])
  })

  it('check codes use only characters that cannot be confused', () => {
    const codes = Array.from({ length: 300 }, () => checkCode())
    expect(codes.every(c => /^[ACDEFHJKLMNPRTUVWXY34679]{4}$/.test(c))).toBe(true)
  })

  it('a 12,000 px page becomes pieces of at most 2,000 px with their band; a too-wide page is scaled to fit; sources are untouched', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-pieces-'))
    try {
      // A 600 × 12,000 page of busy stripes with white gutters every 1,800 rows.
      const width = 600, height = 12000
      const raw = Buffer.alloc(width * height * 3)
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const v = y % 1800 >= 1700 && y % 1800 < 1760 ? 255 : ((x >> 3) + (y >> 3)) % 2 ? 30 : 200
        raw.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3)
      }
      const page1 = path.join(tmp, 'page_001.png')
      await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(page1)
      const page2 = path.join(tmp, 'page_002.png')
      await sharp({ create: { width: 3000, height: 2400, channels: 3, background: '#808080' } }).png().toFile(page2)
      const original = await fs.readFile(page1)
      const pieces = await prepareChapterPages([{ file: page1, source: 'page_001.png' }, { file: page2, source: 'page_002.png' }], path.join(tmp, 'out'), () => 'ACDE')
      const first = pieces.filter(p => p.page === 1)
      expect(first.length).toBeGreaterThanOrEqual(7)
      expect(first.every(p => p.parts === first.length)).toBe(true)
      // Every source row once, in order, and each cut inside a gutter.
      expect(first[0].top).toBe(0)
      expect(first.at(-1)!.bottom).toBe(12000)
      first.slice(1).forEach((p, i) => { expect(p.top).toBe(first[i].bottom); expect(p.top % 1800).toBeGreaterThanOrEqual(1700); expect(p.top % 1800).toBeLessThan(1760) })
      // The 3,000 px wide page is scaled to 2,000 px wide, then cut to fit.
      const wide = pieces.filter(p => p.page === 2)
      expect(wide.every(p => p.width === AGY_MAX_SIDE)).toBe(true)
      expect(wide.at(-1)!.bottom).toBe(2400)
      for (const p of pieces) {
        const meta = await sharp(p.file).metadata()
        expect([meta.width, meta.height]).toEqual([p.width, p.height])
        expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(AGY_MAX_SIDE)
      }
      expect(await fs.readFile(page1)).toEqual(original)
      // The band is white with dark text in the middle.
      const band = await sharp(first[0].file).extract({ left: 0, top: 0, width, height: 50 }).greyscale().raw().toBuffer()
      expect(band[0]).toBeGreaterThan(240)
      expect(Math.min(...band)).toBeLessThan(80)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  }, 30_000)
})
