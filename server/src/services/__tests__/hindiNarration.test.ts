import { describe, expect, it, vi } from 'vitest'

// voiceoverService pulls in the Prisma client through ../index.js; the
// functions under test are pure, so an empty stand-in is enough.
vi.mock('../../index.js', () => ({ prisma: {} }))

import { buildTimelineScript, splitIntoSentences } from '../alignment/beatFormatter.js'
import { splitScriptIntoSections } from '../voiceoverService.js'
import {
  audioFolderName,
  parseLanguage,
  requestLanguage,
  scriptFileName,
  video2FolderName
} from '../narrationLanguage.js'

describe('narration language helpers', () => {
  it('treats anything but "hi" as English', () => {
    expect(parseLanguage('hi')).toBe('hi')
    expect(parseLanguage('en')).toBe('en')
    expect(parseLanguage(undefined)).toBe('en')
    expect(parseLanguage('HI')).toBe('en')
    expect(requestLanguage({ query: { lang: 'hi' } })).toBe('hi')
    expect(requestLanguage({ query: {}, body: { lang: 'hi' } })).toBe('hi')
    expect(requestLanguage({ query: {} })).toBe('en')
  })

  it('keeps English on its original file names and puts Hindi beside them', () => {
    expect(scriptFileName('en')).toBe('script.md')
    expect(scriptFileName('hi')).toBe('script.hi.md')
    expect(audioFolderName('en')).toBe('audio')
    expect(audioFolderName('hi')).toBe('audio_hi')
    expect(video2FolderName('en')).toBe('_video2')
    expect(video2FolderName('hi')).toBe('_video2_hi')
  })
})

describe('Hindi sentence splitting', () => {
  it('splits on the danda', () => {
    expect(splitIntoSentences('वह आगे बढ़ा। दरवाज़ा खुला था। अंदर कोई नहीं था।')).toEqual([
      'वह आगे बढ़ा।',
      'दरवाज़ा खुला था।',
      'अंदर कोई नहीं था।'
    ])
  })

  it('still splits English the same way', () => {
    expect(splitIntoSentences('Mr. Han waits. The door opens!')).toEqual([
      'Mr. Han waits.',
      'The door opens!'
    ])
  })

  it('groups Hindi sentences into voice sections under the target length', () => {
    const sentence = 'यह एक लंबा वाक्य है जो कहानी को आगे बढ़ाता है।'
    const script = Array.from({ length: 30 }, () => sentence).join(' ')
    const sections = splitScriptIntoSections(script, 200)
    expect(sections.length).toBeGreaterThan(1)
    for (const section of sections) {
      expect(section.text.length).toBeLessThanOrEqual(200)
      expect(section.text.endsWith('।')).toBe(true)
    }
    expect(sections.map(s => s.text).join(' ')).toBe(script)
  })
})

describe('Hindi timeline beats', () => {
  it('matches Devanagari words to aligner timings', () => {
    const text = 'वह आगे बढ़ा। दरवाज़ा खुला था।'
    const words = [
      { word: 'वह', start: 0, end: 0.4 },
      { word: 'आगे', start: 0.4, end: 0.9 },
      { word: 'बढ़ा।', start: 0.9, end: 1.5 },
      { word: 'दरवाज़ा', start: 1.7, end: 2.3 },
      { word: 'खुला', start: 2.3, end: 2.7 },
      { word: 'था।', start: 2.7, end: 3.2 }
    ]
    expect(buildTimelineScript(text, words)).toBe(
      '00:00.00 - 00:01.50: "वह आगे बढ़ा।"\n' +
      '00:01.50 - 00:03.20: "दरवाज़ा खुला था।"'
    )
  })
})
