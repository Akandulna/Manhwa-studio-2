/**
 * Beat Formatter
 *
 * Turns per-word alignment timings into the "Script with Timeline" format
 * this project already uses:
 *
 *   00:00.00 - 00:07.42: "The first sentence."
 *   00:07.42 - 00:15.00: "The second sentence."
 *
 * Timestamps are relative to the section's own audio, and consecutive beats
 * share a boundary (each beat starts where the previous one ended) so the
 * result reads as a continuous timeline with no gaps.
 */

export interface AlignedWord {
  word: string
  start: number | null
  end: number | null
}

export interface Beat {
  startSec: number
  endSec: number
  text: string
}

/**
 * Split script text into sentence-sized beats.
 *
 * Splits after . ! ? (and their closing quotes/brackets) when followed by
 * whitespace. Common abbreviations and decimal numbers are left intact so
 * "Mr. Han" and "3.5" do not become beat boundaries.
 */
export function splitIntoSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return []

  const ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc',
    'inc', 'ltd', 'co', 'e.g', 'i.e', 'approx', 'no', 'vol', 'fig'
  ])

  const sentences: string[] = []
  let current = ''

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]
    current += char

    if (char !== '.' && char !== '!' && char !== '?') continue

    // Absorb any closing punctuation that belongs to this sentence.
    let j = i + 1
    while (j < normalized.length && /["'”’)\]]/.test(normalized[j])) {
      current += normalized[j]
      j++
    }

    // A boundary needs whitespace (or end of text) after it.
    if (j < normalized.length && normalized[j] !== ' ') {
      i = j - 1
      continue
    }

    // Decimal number: "3.5" - the dot is not a boundary.
    if (char === '.' && /\d$/.test(current.slice(0, -1)) && /^\s?\d/.test(normalized.slice(j))) {
      i = j - 1
      continue
    }

    // Known abbreviation: "Mr." - not a boundary.
    if (char === '.') {
      const lastToken = current.slice(0, -1).split(/[\s"'“‘([]/).pop()?.toLowerCase() ?? ''
      if (ABBREVIATIONS.has(lastToken)) {
        i = j - 1
        continue
      }
    }

    sentences.push(current.trim())
    current = ''
    i = j - 1
  }

  if (current.trim()) sentences.push(current.trim())

  return sentences
}

/** Strip everything but letters/digits so aligner tokens can be matched to script tokens. */
function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/gi, '')
}

/**
 * Walk the aligned words alongside the sentences, assigning each sentence the
 * span from its first word's start to its last word's end.
 *
 * The aligner returns one entry per spoken word in the same order as the input
 * text, so this is a positional walk rather than a search. Words the aligner
 * could not place (null timings) are skipped when picking a boundary, falling
 * back to neighbouring beats so a single unplaced word cannot collapse a beat.
 */
export function buildBeats(sentences: string[], words: AlignedWord[]): Beat[] {
  const usable = words.filter(w => normalizeToken(w.word).length > 0)

  const beats: Beat[] = []
  let cursor = 0

  for (const sentence of sentences) {
    const tokenCount = sentence
      .split(/\s+/)
      .filter(t => normalizeToken(t).length > 0)
      .length

    if (tokenCount === 0) continue

    const slice = usable.slice(cursor, cursor + tokenCount)
    cursor += tokenCount

    if (slice.length === 0) continue

    const firstTimed = slice.find(w => w.start !== null)
    const lastTimed = [...slice].reverse().find(w => w.end !== null)

    beats.push({
      startSec: firstTimed?.start ?? Number.NaN,
      endSec: lastTimed?.end ?? Number.NaN,
      text: sentence
    })
  }

  return repairBoundaries(beats)
}

/**
 * Fill in any beat boundary the aligner could not place, and make the timeline
 * continuous: each beat starts exactly where the previous one ended.
 */
function repairBoundaries(beats: Beat[]): Beat[] {
  if (beats.length === 0) return beats

  // Forward fill: a missing start becomes the previous beat's end.
  for (let i = 0; i < beats.length; i++) {
    if (Number.isNaN(beats[i].startSec)) {
      beats[i].startSec = i === 0 ? 0 : beats[i - 1].endSec
    }
  }

  // Backward fill: a missing end becomes the next beat's start.
  for (let i = beats.length - 1; i >= 0; i--) {
    if (Number.isNaN(beats[i].endSec)) {
      beats[i].endSec = i === beats.length - 1 ? beats[i].startSec : beats[i + 1].startSec
    }
  }

  // Any still-unresolved value (e.g. every word unplaced) collapses to 0.
  for (const beat of beats) {
    if (Number.isNaN(beat.startSec)) beat.startSec = 0
    if (Number.isNaN(beat.endSec)) beat.endSec = beat.startSec
  }

  // Continuity: close gaps so beat N+1 starts where beat N ended.
  beats[0].startSec = 0
  for (let i = 1; i < beats.length; i++) {
    beats[i].startSec = beats[i - 1].endSec
    if (beats[i].endSec < beats[i].startSec) {
      beats[i].endSec = beats[i].startSec
    }
  }

  return beats
}

/** Format seconds as MM:SS.CC (centiseconds), matching the existing scripts. */
export function formatTimestamp(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const totalCentis = Math.round(safe * 100)
  const minutes = Math.floor(totalCentis / 6000)
  const secs = Math.floor((totalCentis % 6000) / 100)
  const centis = totalCentis % 100

  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`
}

/** Render beats as the "Script with Timeline" text block. */
export function formatBeats(beats: Beat[]): string {
  return beats
    .map(b => `${formatTimestamp(b.startSec)} - ${formatTimestamp(b.endSec)}: "${b.text.replace(/"/g, "'")}"`)
    .join('\n')
}

/** Convenience: script text + aligned words -> finished timeline block. */
export function buildTimelineScript(text: string, words: AlignedWord[]): string {
  return formatBeats(buildBeats(splitIntoSentences(text), words))
}
