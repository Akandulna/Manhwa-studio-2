import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HINGLISH_RULES,
  assembleConversion,
  buildConvertPrompt,
  buildFollowUp,
  buildWritePrompt,
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
  it('asks for scene notes on the numbered paragraphs, with the summary when there is one', () => {
    const prompt = buildConvertPrompt('RULES', 'First line.\n\nSecond line.', '  The story so far.  ')
    expect(prompt.startsWith('RULES\n\n---\n\nTASK: Retell the English manhwa recap narration script below in Hinglish')).toBe(true)
    expect(prompt).toContain('STEP 1 - SCENE NOTES (do not write the narration yet):')
    expect(prompt).toContain('Every paragraph from [P1] to [P2] belongs to exactly one scene')
    expect(prompt).toContain('===SCENES===\n[SCENE 1: P1-P4]\n- <note>')
    expect(prompt).not.toContain('===SCRIPT===')
    expect(prompt.endsWith(`ENGLISH SCRIPT (2 paragraphs):
[P1] First line.

[P2] Second line.

ENGLISH STORY SUMMARY:
The story so far.`)).toBe(true)
  })

  it('leaves the summary out when the English summary is empty', () => {
    const prompt = buildConvertPrompt(DEFAULT_HINGLISH_RULES, 'Only.', '   ')
    expect(prompt.startsWith(DEFAULT_HINGLISH_RULES + '\n\n---\n\n')).toBe(true)
    expect(prompt).not.toContain('SUMMARY')
    expect(prompt.endsWith('...\n\nENGLISH SCRIPT (1 paragraphs):\n[P1] Only.')).toBe(true)
  })
})

describe('buildWritePrompt', () => {
  it('asks for the narration scene by scene, and the summary only when there is one', () => {
    const prompt = buildWritePrompt(12, true)
    expect(prompt.startsWith('STEP 2 - WRITE: Now write the full Hinglish narration from your scene notes')).toBe(true)
    expect(prompt).toContain('Between them the scenes must cover [P1] to [P12]')
    expect(prompt).toContain('- Then retell the English story summary in the same Hinglish style')
    expect(prompt.endsWith('[SCENE 2: P5-P7]\n<Hinglish paragraph>\n\n...\n\n===SUMMARY===\n<Hinglish story summary>')).toBe(true)

    const bare = buildWritePrompt(3, false)
    expect(bare).not.toContain('SUMMARY')
    expect(bare).not.toContain('story summary')
    expect(bare.endsWith('[SCENE 2: P5-P7]\n<Hinglish paragraph>\n\n...')).toBe(true)
  })
})

describe('parseConversionReply', () => {
  it('reads scene marks dressed as bold, headings or quotes, one paragraph per line', () => {
    const parsed = parseConversionReply(`Sure, here it is.
===SCRIPT===
Intro text before any mark is ignored.
**[SCENE 1: P1-P2]**
पहला पैराग्राफ।

दूसरा पैराग्राफ।
## [Scene 2 – P3 to P4]: तीसरा।
> [ scene 3 : p 5 ] - चौथा।
===SUMMARY===
  सारांश।  `)
    expect(parsed.scenes).toEqual([
      { start: 1, end: 2, paragraphs: ['पहला पैराग्राफ।', 'दूसरा पैराग्राफ।'] },
      { start: 3, end: 4, paragraphs: ['तीसरा।'] },
      { start: 5, end: 5, paragraphs: ['चौथा।'] }
    ])
    expect(parsed.summary).toBe('सारांश।')
    expect(parsed.notesOnly).toBe(false)
  })

  it('drops an exact repeat of a range, and turns a reversed range around', () => {
    const parsed = parseConversionReply('===SCRIPT===\n[SCENE 1: P1-P2]\nएक।\n[SCENE 1: P1-P2]\nफिर से।\n[SCENE 2: P4-P3]\nदो।')
    expect(parsed.scenes).toEqual([
      { start: 1, end: 2, paragraphs: ['एक।'] },
      { start: 3, end: 4, paragraphs: ['दो।'] }
    ])
  })

  it('only counts a mark at a line start', () => {
    const parsed = parseConversionReply('===SCRIPT===\n[SCENE 1: P1]\nएक, जैसा [SCENE 2: P2] में लिखा।')
    expect(parsed.scenes).toEqual([{ start: 1, end: 1, paragraphs: ['एक, जैसा [SCENE 2: P2] में लिखा।'] }])
  })

  it('finds nothing without a SCRIPT section', () => {
    const parsed = parseConversionReply('[SCENE 1: P1]\nएक।')
    expect(parsed.scenes).toEqual([])
    expect(hasUsableScript(parsed)).toBe(false)
  })

  it('recognises step 1 notes pasted instead of the narration', () => {
    const parsed = parseConversionReply('**===SCENES===**\n[SCENE 1: P1-P2]\n- जिन गेट में जाता है')
    expect(parsed.notesOnly).toBe(true)
    expect(parsed.scenes).toEqual([])
    expect(checkConversion(['a'], '', parsed)).toEqual([
      'This is the step 1 reply (the scene notes), not the narration - send the step 2 prompt in the same chat and use its reply'
    ])
  })
})

describe('countWords', () => {
  it('counts tokens with a letter or digit in any script', () => {
    expect(countWords('उसका लेवल 10 हो गया । — !!')).toBe(5)
    expect(countWords('  ')).toBe(0)
  })
})

describe('checkConversion', () => {
  // P1+P2 = 46 English words, P3+P4 = 40; 86 in all.
  const en = [english(41), english(5), english(30), english(10)]
  const reply = (scenes: [string, string[]][], summary = 'सारांश।') =>
    parseConversionReply(`===SCRIPT===\n${scenes.map(([mark, ps]) => `${mark}\n${ps.join('\n\n')}`).join('\n\n')}\n===SUMMARY===\n${summary}`)

  it('passes a full retelling, however the scenes are split into paragraphs', () => {
    const parsed = reply([['[SCENE 1: P1-P2]', [hindi(20), hindi(30)]], ['[SCENE 2: P3-P4]', [hindi(40)]]])
    expect(checkConversion(en, 'Summary.', parsed)).toEqual([])
  })

  it('reports paragraphs no scene covers, including empty scenes, as runs', () => {
    const parsed = reply([['[SCENE 1: P1]', [hindi(45)]], ['[SCENE 2: P2-P3]', []], ['[SCENE 3: P4]', [hindi(45)]]])
    expect(checkConversion(en, 'Summary.', parsed)).toEqual(['Missing paragraphs: P2-P3'])
  })

  it('reports paragraphs in more than one scene', () => {
    const parsed = reply([['[SCENE 1: P1-P3]', [hindi(80)]], ['[SCENE 2: P3-P4]', [hindi(40)]]])
    expect(checkConversion(en, 'Summary.', parsed)).toEqual(['Paragraphs in more than one scene: P3'])
  })

  it('reports scenes under 0.6 of the English they cover, when that is 12+ words', () => {
    // P1-P2: 27 < 27.6; P3-P4: 24 = 0.6 × 40 passes; the whole is 51 + 30 extra words.
    const parsed = reply([['[SCENE 1: P1-P2]', [hindi(27)]], ['[SCENE 2: P3-P4]', [hindi(24), hindi(30)]]])
    expect(checkConversion(en, 'Summary.', parsed)).toEqual(['Too short: P1-P2 (27 words, the English has 46)'])
  })

  it('reports the whole script under 0.85 of the English', () => {
    // 73 < 73.1, and no scene is under 0.6.
    const parsed = reply([['[SCENE 1: P1-P2]', [hindi(40)]], ['[SCENE 2: P3-P4]', [hindi(33)]]])
    expect(checkConversion(en, 'Summary.', parsed)).toEqual([
      'Too short overall: 73 words, it needs at least 74 (the English has 86)'
    ])
  })

  it('reports Latin letters in scenes but not in the marks or the summary', () => {
    const parsed = reply([['[SCENE 1: P1-P2]', [hindi(50) + ' level']], ['[SCENE 2: P3-P4]', [hindi(40)]]], 'Summary in English')
    expect(checkConversion(en, 'Summary.', parsed)).toEqual([
      'Roman/Latin letters in: P1-P2 - write those words in Devanagari'
    ])
  })

  it('reports a missing summary only when the English has one', () => {
    const parsed = reply([['[SCENE 1: P1-P4]', [hindi(90)]]], '')
    expect(checkConversion(en, 'Summary.', parsed)).toEqual(['The ===SUMMARY=== section is missing'])
    expect(checkConversion(en, '', parsed)).toEqual([])
  })

  it('reports a reply without scene marks once, not every paragraph as missing', () => {
    const parsed = parseConversionReply(`===SCRIPT===\n${hindi(90)}`)
    expect(checkConversion(en, 'Summary.', parsed)).toEqual([
      'No scenes found - start each scene with its mark on a line of its own, like [SCENE 1: P1-P4]',
      'The ===SUMMARY=== section is missing'
    ])
  })

  it('lists every issue in the follow-up order', () => {
    const parsed = parseConversionReply(`===SCRIPT===\n[SCENE 1: P1-P2]\n${hindi(10)}\n[SCENE 2: P2]\n${hindi(5)} abc`)
    expect(checkConversion(en, 'Summary.', parsed)).toEqual([
      'Missing paragraphs: P3-P4',
      'Paragraphs in more than one scene: P2',
      'Too short: P1-P2 (10 words, the English has 46)',
      'Too short overall: 16 words, it needs at least 74 (the English has 86)',
      'Roman/Latin letters in: P2 - write those words in Devanagari',
      'The ===SUMMARY=== section is missing'
    ])
  })
})

describe('buildFollowUp', () => {
  it('lists the issues and asks for the whole narration again', () => {
    expect(buildFollowUp(['Missing paragraphs: P7, P12-P13', 'The ===SUMMARY=== section is missing'], 20, true)).toBe(
      `Your reply did not pass the check:
- Missing paragraphs: P7, P12-P13
- The ===SUMMARY=== section is missing
Send the complete narration again in the same format: every scene with its [SCENE n: Px-Py] mark, covering [P1] to [P20] between them, fully written, then ===SUMMARY===.`
    )
    expect(buildFollowUp(['x'], 3, false).endsWith('covering [P1] to [P3] between them, fully written.')).toBe(true)
  })
})

describe('assembleConversion', () => {
  it('saves every scene\'s paragraphs in reply order, without the marks', () => {
    const parsed = parseConversionReply('===SCRIPT===\n[SCENE 1: P1-P2]\nएक।\n\nदो।\n[SCENE 2: P3]\n[SCENE 3: P4]\nचार।\n===SUMMARY===\nसारांश।')
    expect(assembleConversion(parsed)).toEqual({ script: 'एक।\n\nदो।\n\nचार।', closing: 'चार।', summary: 'सारांश।' })
  })

  it('closes on the last paragraph, with an empty summary when there is none', () => {
    const parsed = parseConversionReply('===SCRIPT===\n[SCENE 1: P1-P2]\nएक।\nदो।')
    expect(assembleConversion(parsed)).toEqual({ script: 'एक।\n\nदो।', closing: 'दो।', summary: '' })
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
