import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HINGLISH_RULES, HINGLISH_RULES_SHA256, shortSceneIssue } from '../hinglishRules.js'
import { presentationIssues } from '../narrationRules.js'
import { parseManualNarration } from '../narrationManual.js'

/**
 * Studio ⇄ phone Hinglish parity. The phone's HinglishParityTest.kt pins the same fingerprint and runs the same
 * cases with the same expected messages: change both together.
 */
describe('Hinglish parity with the phone', () => {
  it('uses the exact rule texts the phone uses', () => {
    expect(createHash('sha256').update(HINGLISH_RULES, 'utf8').digest('hex')).toBe(HINGLISH_RULES_SHA256)
  })

  it('flags header/caption wording with the phone\'s message', () => {
    expect(presentationIssues('ईसाक मुस्कुराता है।\n\nअंधेरे के बीच स्क्रीन पर चैप्टर हेडर आता है।')).toEqual([
      'Paragraph 2 contains non-story presentation wording: चैप्टर हेडर. Rewrite it as direct story narration, preserving story facts.'
    ])
    expect(presentationIssues('चैप्टर १६: आखिरी ट्रायल')).toEqual([
      'Paragraph 1 contains non-story presentation wording: चैप्टर १६: आखिरी ट्रायल. Rewrite it as direct story narration, preserving story facts.'
    ])
    expect(presentationIssues('A caption identifies him as Rilai Joshua.')).toEqual([
      'Paragraph 1 contains non-story presentation wording: caption identifies. Rewrite it as direct story narration, preserving story facts.'
    ])
    expect(presentationIssues('स्क्रीन पर क्वेस्ट दिखाई देता है। उसके चाचा उसका क्रेडिट छीन लेते हैं।')).toEqual([])
  })

  it('flags scenes cut short with the phone\'s message', () => {
    const english = ['one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty', 'a b c d e']
    const hindi = (n: number) => Array.from({ length: n }, () => 'शब्द').join(' ')
    expect(shortSceneIssue([{ start: 1, end: 1, text: hindi(11) }, { start: 2, end: 2, text: hindi(1) }], english)).toBe('Too short: P1 (11 words, the English has 20)')
    expect(shortSceneIssue([{ start: 1, end: 1, text: hindi(12) }, { start: 2, end: 2, text: hindi(1) }], english)).toBeNull()
    expect(shortSceneIssue([{ start: 1, end: 2, text: hindi(14) }], english)).toBe('Too short: P1-P2 (14 words, the English has 25)')
  })

  it('refuses a save with a short scene, header wording or a bad English source, listing every problem', () => {
    const english = Array.from({ length: 4 }, (_, i) => `Paragraph ${i + 1} tells how the hero walks into the old hall and meets his rival there again.`).join('\n')
    const line = 'हीरो पुराने हॉल में जाता है और वहाँ फिर से अपने राइवल से मिलता है, और दोनों एक दूसरे को देखते हैं।'
    const save = (scenes: string[], source = english) =>
      parseManualNarration(`===SCRIPT===\n${scenes.join('\n\n')}\n\n===SUMMARY===\nहीरो अपने राइवल से मिलता है।`, 'hi', source)
    const good = [1, 2, 3, 4].map(p => `[SCENE ${p}: P${p}]\n${line}`)
    expect(save(good).script).toContain('राइवल')
    expect(() => save([good[0], good[1], good[2], '[SCENE 4: P4]\nवो मिलते हैं।'])).toThrow(/^Too short: P4 \(3 words, the English has 17\)$/m)
    expect(() => save([good[0], good[1], good[2], `[SCENE 4: P4]\n${line} टाइटल कार्ड दिखता है।`])).toThrow(/Paragraph 4 contains non-story presentation wording: टाइटल कार्ड/)
    expect(() => save(good, english.replace('Paragraph 1 tells', 'A caption identifies'))).toThrow(/English source needs correction before conversion: Paragraph 1/)
  })
})
