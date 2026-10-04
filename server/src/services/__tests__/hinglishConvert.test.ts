import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HINGLISH_RULES,
  assembleConversion,
  buildConvertPrompt,
  buildFollowUp,
  checkConversion,
  countWords,
  decodeReview,
  encodeReview,
  englishParagraphs,
  hasUsableScript,
  hinglishState,
  needsConversion,
  parseConversionReply,
  sourceSha256
} from '../hinglishConvert.js'

/** `count` Devanagari words. */
const hindi = (count: number) => Array.from({ length: count }, () => 'शब्द').join(' ')
/** `count` English words. */
const english = (count: number) => Array.from({ length: count }, () => 'word').join(' ')

describe('englishParagraphs', () => {
  it('makes every non-blank line a paragraph, trimmed', () => {
    expect(englishParagraphs('  One.  \n\n\nTwo two.\r\n   \nThree.\n')).toEqual(['One.', 'Two two.', 'Three.'])
    expect(englishParagraphs('\n \n')).toEqual([])
  })
})

describe('sourceSha256', () => {
  it('hashes the script trimmed', () => {
    const expected = createHash('sha256').update('One.\n\nTwo.').digest('hex')
    expect(sourceSha256('\nOne.\n\nTwo.\n')).toBe(expected)
    expect(sourceSha256('One.\n\nTwo.')).toBe(expected)
  })
})

describe('buildConvertPrompt', () => {
  it('numbers the paragraphs and asks for the summary when there is one', () => {
    const prompt = buildConvertPrompt('RULES', 'First line.\n\nSecond line.', '  The story so far.  ')
    expect(prompt).toBe(`RULES

---

TASK: Convert the English manhwa recap narration script below into Hinglish, following the language rules above.

This is a full adaptation, not a summary:
- The English script is split into numbered paragraphs, [P1] to [P2]. Write exactly one Hinglish paragraph for each, in the same order, starting with the same mark: [P1], [P2], ... [P2]
- Keep every event, action, description, line of dialogue, name, number and inner thought of each paragraph. Do not merge, skip, shorten or summarize paragraphs, and do not add new events
- Each Hinglish paragraph should be about as long as its English paragraph or longer - Hinglish usually needs more words than English, never fewer
- Keep dialogue as dialogue, in the same tone
- Also convert the story summary into the same Hinglish style, keeping all of its details

Format your response EXACTLY like this:
===SCRIPT===
[P1] <Hinglish paragraph 1>

[P2] <Hinglish paragraph 2>

...

===SUMMARY===
<Hinglish story summary>

ENGLISH SCRIPT (2 paragraphs):
[P1] First line.

[P2] Second line.

ENGLISH STORY SUMMARY:
The story so far.`)
  })

  it('leaves every summary part out when the English summary is empty', () => {
    const prompt = buildConvertPrompt(DEFAULT_HINGLISH_RULES, 'Only.', '   ')
    expect(prompt.startsWith(DEFAULT_HINGLISH_RULES + '\n\n---\n\n')).toBe(true)
    expect(prompt).not.toContain('SUMMARY')
    expect(prompt).not.toContain('story summary')
    expect(prompt).toContain('- Keep dialogue as dialogue, in the same tone\n\nFormat your response EXACTLY like this:')
    expect(prompt.endsWith('...\n\nENGLISH SCRIPT (1 paragraphs):\n[P1] Only.')).toBe(true)
  })
})

describe('parseConversionReply', () => {
  it('reads marks dressed as bold, headings or quotes, joining each paragraph\'s lines', () => {
    const parsed = parseConversionReply(`Sure, here it is.
===SCRIPT===
Intro text before any mark is ignored.
**[P1]** पहला
पैराग्राफ।

## [P2]: दूसरा।
> [ p 3 ] - तीसरा।
__[P4].__ चौथा।
===SUMMARY===
  सारांश।  `)
    expect([...parsed.paragraphs]).toEqual([
      [1, 'पहला पैराग्राफ।'],
      [2, 'दूसरा।'],
      [3, 'तीसरा।'],
      [4, 'चौथा।']
    ])
    expect(parsed.summary).toBe('सारांश।')
  })

  it('keeps the first of a repeated mark, and marks above N', () => {
    const parsed = parseConversionReply('===SCRIPT===\n[P1] एक।\n[P2] दो।\n[P1] फिर से एक।\n[P5] पाँच।')
    expect(parsed.paragraphs.get(1)).toBe('एक।')
    expect(parsed.paragraphs.get(5)).toBe('पाँच।')
    expect(parsed.summary).toBe('')
  })

  it('only counts a mark at a line start', () => {
    const parsed = parseConversionReply('===SCRIPT===\n[P1] एक, जैसा [P2] में लिखा।')
    expect([...parsed.paragraphs]).toEqual([[1, 'एक, जैसा [P2] में लिखा।']])
  })

  it('finds nothing without a SCRIPT section', () => {
    const parsed = parseConversionReply('[P1] एक।\n[P2] दो।')
    expect(parsed.paragraphs.size).toBe(0)
    expect(hasUsableScript(parsed)).toBe(false)
  })
})

describe('countWords', () => {
  it('counts tokens with a letter or digit in any script', () => {
    expect(countWords('उसका लेवल 10 हो गया । — !!')).toBe(5)
    expect(countWords('  ')).toBe(0)
  })
})

describe('checkConversion', () => {
  const en = [english(41), english(5), english(30), english(10)]
  const reply = (paragraphs: string[], summary = 'सारांश।') =>
    parseConversionReply(`===SCRIPT===\n${paragraphs.map((p, i) => `[P${i + 1}] ${p}`).join('\n\n')}\n===SUMMARY===\n${summary}`)

  it('passes a full conversion', () => {
    expect(checkConversion(en, 'Summary.', reply([hindi(45), hindi(5), hindi(30), hindi(10)]))).toEqual([])
  })

  it('reports missing paragraphs, including empty ones', () => {
    const parsed = parseConversionReply(`===SCRIPT===\n[P1] ${hindi(45)}\n[P2]\n[P4] ${hindi(40)}\n===SUMMARY===\nस।`)
    expect(checkConversion(en, 'Summary.', parsed)).toEqual(['Missing paragraphs: P2, P3'])
  })

  it('reports paragraphs under 0.6 of an English paragraph of 12+ words', () => {
    // P1: 24 < 24.6; P2 has 5 English words, so is never too short; P3: 18 = 0.6 × 30 passes.
    const parsed = reply([hindi(24), hindi(1), hindi(18), hindi(60)])
    expect(checkConversion(en, 'Summary.', parsed)).toEqual(['Too short: P1 (24 words, the English has 41)'])
  })

  it('reports the whole script under 0.85 of the English', () => {
    // English 86 words; 73 < 73.1, and no single paragraph is under 0.6.
    const parsed = reply([hindi(28), hindi(5), hindi(30), hindi(10)])
    expect(checkConversion(en, 'Summary.', parsed)).toEqual([
      'Too short overall: 73 words, it needs at least 74 (the English has 86)'
    ])
  })

  it('reports Latin letters in paragraphs but not in the summary', () => {
    const parsed = reply([hindi(44) + ' level', hindi(5), hindi(30), 'System ' + hindi(10)], 'Summary in English')
    expect(checkConversion(en, 'Summary.', parsed)).toEqual([
      'Roman/Latin letters in: P1, P4 - write those words in Devanagari'
    ])
  })

  it('reports a missing summary only when the English has one', () => {
    const parsed = reply([hindi(45), hindi(5), hindi(30), hindi(10)], '')
    expect(checkConversion(en, 'Summary.', parsed)).toEqual(['The ===SUMMARY=== section is missing'])
    expect(checkConversion(en, '', parsed)).toEqual([])
  })

  it('lists every issue in the follow-up order', () => {
    const parsed = parseConversionReply(`===SCRIPT===\n[P1] ${hindi(10)}\n[P3] ${hindi(5)} abc`)
    expect(checkConversion(en, 'Summary.', parsed)).toEqual([
      'Missing paragraphs: P2, P4',
      'Too short: P1 (10 words, the English has 41), P3 (6 words, the English has 30)',
      'Too short overall: 16 words, it needs at least 74 (the English has 86)',
      'Roman/Latin letters in: P3 - write those words in Devanagari',
      'The ===SUMMARY=== section is missing'
    ])
  })
})

describe('buildFollowUp', () => {
  it('lists the issues and asks for the whole reply again', () => {
    expect(buildFollowUp(['Missing paragraphs: P7, P12, P13', 'The ===SUMMARY=== section is missing'], 20)).toBe(
      `Your reply did not pass the check:
- Missing paragraphs: P7, P12, P13
- The ===SUMMARY=== section is missing
Send the complete reply again in the same format: every paragraph from [P1] to [P20], fully converted, then ===SUMMARY===.`
    )
  })
})

describe('assembleConversion', () => {
  it('saves 1..N in order, then marks above N, without the marks', () => {
    const parsed = parseConversionReply('===SCRIPT===\n[P9] नौ।\n[P2] दो।\n[P1] एक।\n[P4]\n[P7] सात।\n===SUMMARY===\nसारांश।')
    expect(assembleConversion(parsed, 4)).toEqual({
      script: 'एक।\n\nदो।\n\nसात।\n\nनौ।',
      closing: 'नौ।',
      summary: 'सारांश।'
    })
  })

  it('closes on the last paragraph, with an empty summary when there is none', () => {
    const parsed = parseConversionReply('===SCRIPT===\n[P1] एक।\n[P2] दो।')
    expect(assembleConversion(parsed, 2)).toEqual({ script: 'एक।\n\nदो।', closing: 'दो।', summary: '' })
  })
})

describe('review column', () => {
  it('stores issue lines as JSON, and nothing when the check passed', () => {
    expect(encodeReview([])).toBeNull()
    expect(encodeReview(null)).toBeNull()
    expect(decodeReview(encodeReview(['Missing paragraphs: P2']))).toEqual(['Missing paragraphs: P2'])
    expect(decodeReview('not json')).toBeNull()
  })
})

describe('hinglishState', () => {
  const row = (over: Partial<{ status: string; hasScript: boolean; sourceSha256: string | null; review: string | null }> = {}) => ({
    status: 'done',
    hasScript: true,
    sourceSha256: 'aaa',
    review: null,
    ...over
  })

  it('follows the English script it was converted from', () => {
    expect(hinglishState({ englishSha256: null, hindi: row() })).toBe('waiting')
    expect(hinglishState({ englishSha256: 'aaa', hindi: null })).toBe('pending')
    expect(hinglishState({ englishSha256: 'aaa', hindi: row({ hasScript: false, status: 'failed' }) })).toBe('failed')
    expect(hinglishState({ englishSha256: 'bbb', hindi: row() })).toBe('stale')
    expect(hinglishState({ englishSha256: 'aaa', hindi: row({ sourceSha256: null }) })).toBe('stale')
    expect(hinglishState({ englishSha256: 'aaa', hindi: row({ review: '["Too short overall"]' }) })).toBe('review')
    expect(hinglishState({ englishSha256: 'aaa', hindi: row({ status: 'edited' }) })).toBe('done')
  })

  it('picks up missing, failed and stale chapters for conversion', () => {
    expect(['waiting', 'pending', 'stale', 'review', 'done', 'failed'].filter(s => needsConversion(s as never))).toEqual([
      'pending',
      'stale',
      'failed'
    ])
  })
})
