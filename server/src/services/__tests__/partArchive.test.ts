import { describe, expect, it, vi } from 'vitest'

vi.mock('../../index.js', () => ({ prisma: {} }))

const { chapterObjectKeys, scriptZipKeys } = await import('../partArchive.js')

const SERIES = 'Monarch of Supreme Beings'
const KEYS = [
  `manhwa/${SERIES}/Chapter 016.zip`,
  `manhwa/${SERIES}/Chapter 021.zip`,
  `manhwa/${SERIES}/index.json`,
  `voiceover/${SERIES}/Chapter 012.hi.zip`,
  `voiceover/${SERIES}/Chapter 012.zip`,
  `Manhwa/crops/${SERIES}/Chapter 001.zip`,
  `editor/${SERIES}/Chapter 001.package.json`,
  `editor/${SERIES}/Chapter 001.hi.timeline.json`,
  `editor/_prompt.json`,
  `manhwa/${SERIES} 2/Chapter 016.zip`,
  `manhwa/Other/Chapter 016.zip`,
  `scripts/${SERIES}/${SERIES}.zip`,
  `scripts/${SERIES}/${SERIES}.hi.zip`,
  `Manhwa/scripts/${SERIES}/${SERIES}.zip`,
  `scripts/Other/Other.zip`,
  `archive/${SERIES}/continuity.json`,
  `_sleeper-cell.json`
]

describe('chapterObjectKeys', () => {
  it("picks only the given chapters' zips and editor files, in both languages and under any prefix", () => {
    const picked = chapterObjectKeys(KEYS, SERIES, new Set(['Chapter 016', 'Chapter 012', 'Chapter 001']))
    expect(picked.sort()).toEqual([
      `Manhwa/crops/${SERIES}/Chapter 001.zip`,
      `editor/${SERIES}/Chapter 001.hi.timeline.json`,
      `editor/${SERIES}/Chapter 001.package.json`,
      `manhwa/${SERIES}/Chapter 016.zip`,
      `voiceover/${SERIES}/Chapter 012.hi.zip`,
      `voiceover/${SERIES}/Chapter 012.zip`
    ])
  })

  it('never touches the phone index, other series, the archive or receipts', () => {
    const picked = chapterObjectKeys(KEYS, SERIES, new Set(['Chapter 016', 'index', 'continuity']))
    expect(picked).toEqual([`manhwa/${SERIES}/Chapter 016.zip`])
  })

  it('escapes regex characters in series names', () => {
    const name = 'Solo (Re)Leveling? [Part 1]'
    expect(chapterObjectKeys([`crops/${name}/Chapter 001.zip`, 'crops/Solo Re/Chapter 001.zip'], name, new Set(['Chapter 001'])))
      .toEqual([`crops/${name}/Chapter 001.zip`])
  })
})

describe('scriptZipKeys', () => {
  it("finds the phone's English and Hinglish script zips for the series only", () => {
    expect(scriptZipKeys(KEYS, SERIES).sort()).toEqual([
      `Manhwa/scripts/${SERIES}/${SERIES}.zip`,
      `scripts/${SERIES}/${SERIES}.hi.zip`,
      `scripts/${SERIES}/${SERIES}.zip`
    ])
  })
})
