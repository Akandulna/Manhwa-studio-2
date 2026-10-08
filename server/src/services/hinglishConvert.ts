/**
 * Hinglish convert step — the pure half: the prompt, the check and what gets
 * saved. The Gemini calls and the database live in hinglishService.ts.
 *
 * Hinglish ("Hindi" on the desktop tab) is never written from the manhwa
 * images: a one-pass Hindi script came out about half as long as the English
 * one. Instead each chapter's English script is written as usual and then
 * converted, text only, paragraph by paragraph. The English paragraphs go out
 * numbered [P1]..[PN] and the reply must come back with the same marks, so the
 * check can tell exactly which paragraphs were dropped or shortened.
 *
 * This is the contract shared with Sleeper-Cell (the phone does the same
 * conversion), so prompt text, issue wording and the saved shape must stay in
 * step with it word for word.
 */

import { createHash } from 'crypto'
import { parseDelimitedResponse } from './ai/prompts.js'

/** Default Hinglish rules; the Settings value `narrationHinglishRules` replaces it. */
export const DEFAULT_HINGLISH_RULES = `LANGUAGE: HINGLISH (Hindi + English mix, written in Devanagari)
- Write in Hinglish - the casual Hindi-English mix a popular Hindi manhwa recap YouTuber speaks, the way young Indian viewers actually talk. Not pure, formal, literary or "shuddh" Hindi
- Sentence structure and grammar stay Hindi (verbs, connectors, flow), but use English words wherever a Hinglish speaker naturally would instead of heavy Hindi words
- Always prefer the English word for manhwa/game/fantasy terms: power, level, system, skill, rank, quest, dungeon, gate, hunter, monster, boss, guild, mana, energy, attack, damage, fight, training, mission, master, sect, clan, academy, villain, hero, plan, chance, moment, shock, scene, tension, emotional
- Use English for everyday words people say in English anyway: actually, simply, seriously, finally, exactly, problem, situation, normal, strong, weak, important, team, family, office, school, phone, time, control, focus, support, respect, game, challenge, entry, return
- Avoid stiff Sanskritised Hindi: say पावर not शक्ति, सिस्टम not प्रणाली, अटैक not आक्रमण, लेवल not स्तर, प्लान not योजना, चांस not अवसर, सिचुएशन not परिस्थिति, फाइट not युद्ध/लड़ाई when it is a fight scene, मिशन not अभियान
- Keep it natural, not forced: roughly 25-40% English words, never whole English sentences. Hindi words that are already common and simple (लेकिन, फिर, अचानक, सब, डर, गुस्सा, ताकत, दुश्मन) stay Hindi
- Write EVERYTHING in Devanagari script, including the English words, spelled the way they are spoken: "उसका लेवल अचानक बहुत हाई हो गया।", "सिस्टम ने उसे एक नया क्वेस्ट दिया।" Never use Roman/Latin letters - the voiceover and alignment can only read Devanagari
- Character names, places and techniques also go in Devanagari as they are pronounced; do not add English translations or Roman-script words in brackets
- Narration voice: an engaging storyteller talking to the viewer, like explaining the story to a friend - calm and measured with a dry wit (no exaggerated hype, no stage directions like [excited] or *sighs*)
- Use Hindi muhavare and desi comparisons where they fit the moment, the way a Hindi storyteller naturally would: "आ बैल मुझे मार", "ऊंट के मुंह में जीरा", "उल्टा चोर कोतवाल को डांटे", "अपने पैरों पर कुल्हाड़ी मारना", "नाच न जाने आंगन टेढ़ा", "जले पर नमक छिड़कना", "दाल में कुछ काला है". About one every few paragraphs, never forced, never the same one twice in a script
- Drop in a short sarcastic narrator comment here and there - a dry one-line aside about a character's bad decision, a villain's overconfidence or an obvious trap: "वाह, क्या ज़बरदस्त प्लान था।", "और हमारे हीरो साहब को लगा कि सब ठीक है।", "जैसे ये पहली बार हो रहा हो।" About one every few paragraphs, as an extra sentence beside the story, never replacing it. No sarcasm in sad, emotional or death scenes, and it must never change what actually happened
- End sentences with the Hindi full stop (।)`

/** Settings key holding the editable rules. */
export const HINGLISH_RULES_SETTING = 'narrationHinglishRules'

// Thresholds of the check.
const SHORT_PARAGRAPH_MIN_WORDS = 12
const SHORT_PARAGRAPH_RATIO = 0.6
const SHORT_OVERALL_RATIO = 0.85

/**
 * The English script's paragraphs: every non-blank line, trimmed. The
 * narration is written one paragraph per line (blank lines between), so a line
 * is the unit the reply has to account for.
 */
export function englishParagraphs(script: string): string[] {
  return script.split('\n').map(line => line.trim()).filter(Boolean)
}

/** SHA-256 hex of the English script as saved, trimmed — what a Hinglish script records as its source. */
export function sourceSha256(englishScript: string): string {
  return createHash('sha256').update(englishScript.trim(), 'utf8').digest('hex')
}

/** The full convert prompt for one chapter's English script and summary. */
export function buildConvertPrompt(rules: string, englishScript: string, englishSummary: string | null | undefined): string {
  const paragraphs = englishParagraphs(englishScript)
  const n = paragraphs.length
  const summary = (englishSummary ?? '').trim()
  const numbered = paragraphs.map((p, i) => `[P${i + 1}] ${p}`).join('\n\n')

  return `${rules}

---

TASK: Convert the English manhwa recap narration script below into Hinglish, following the language rules above.

This is a full adaptation, not a summary:
- The English script is split into numbered paragraphs, [P1] to [P${n}]. Write exactly one Hinglish paragraph for each, in the same order, starting with the same mark: [P1], [P2], ... [P${n}]
- Keep every event, action, description, line of dialogue, name, number and inner thought of each paragraph. Do not merge, skip, shorten or summarize paragraphs, and do not add new events
- Each Hinglish paragraph should be about as long as its English paragraph or longer - Hinglish usually needs more words than English, never fewer
- Keep dialogue as dialogue, in the same tone${summary ? `
- Also convert the story summary into the same Hinglish style, keeping all of its details` : ''}

Format your response EXACTLY like this:
===SCRIPT===
[P1] <Hinglish paragraph 1>

[P2] <Hinglish paragraph 2>

...${summary ? `

===SUMMARY===
<Hinglish story summary>` : ''}

ENGLISH SCRIPT (${n} paragraphs):
${numbered}${summary ? `

ENGLISH STORY SUMMARY:
${summary}` : ''}`
}

// ============ Parsing the reply ============

export interface ParsedConversion {
  /** Paragraph text by mark number; the first occurrence of a mark wins. */
  paragraphs: Map<number, string>
  /** The SUMMARY section, trimmed; '' when missing. */
  summary: string
}

/** A mark at a line start, possibly dressed as bold, a heading or a quote: `**[P3]**`, `## [P3]:`, `> [ P 3 ] -`. */
const MARK = /^[ \t*_#>]*\[\s*P\s*(\d+)\s*\][ \t*_:.\-]*/gim

/** Reads the SCRIPT section's marked paragraphs and the SUMMARY section of a reply. */
export function parseConversionReply(reply: string): ParsedConversion {
  const sections = parseDelimitedResponse(reply)
  const script = sections.script ?? ''
  const paragraphs = new Map<number, string>()

  const marks = [...script.matchAll(MARK)]
  marks.forEach((mark, i) => {
    const number = Number(mark[1])
    if (paragraphs.has(number)) return
    const start = mark.index! + mark[0].length
    const end = i + 1 < marks.length ? marks[i + 1].index! : script.length
    const text = script
      .slice(start, end)
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .join(' ')
    paragraphs.set(number, text)
  })

  return { paragraphs, summary: (sections.summary ?? '').trim() }
}

// ============ The check ============

/** Whitespace-separated tokens with at least one letter or digit, in any script. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(token => /[\p{L}\p{N}]/u.test(token)).length
}

/**
 * The check's issue lines, worded as in the follow-up prompt; empty means the
 * reply passed. Only paragraphs 1..N are counted and checked.
 */
export function checkConversion(english: string[], englishSummary: string | null | undefined, parsed: ParsedConversion): string[] {
  const missing: string[] = []
  const short: string[] = []
  const latin: string[] = []
  let englishTotal = 0
  let hinglishTotal = 0

  english.forEach((paragraph, i) => {
    const number = i + 1
    const englishWords = countWords(paragraph)
    englishTotal += englishWords
    const text = parsed.paragraphs.get(number) ?? ''
    if (!text) {
      missing.push(`P${number}`)
      return
    }
    const words = countWords(text)
    hinglishTotal += words
    if (englishWords >= SHORT_PARAGRAPH_MIN_WORDS && words < SHORT_PARAGRAPH_RATIO * englishWords) {
      short.push(`P${number} (${words} words, the English has ${englishWords})`)
    }
    if (/[A-Za-z]/.test(text)) latin.push(`P${number}`)
  })

  const issues: string[] = []
  if (missing.length > 0) issues.push(`Missing paragraphs: ${missing.join(', ')}`)
  if (short.length > 0) issues.push(`Too short: ${short.join(', ')}`)
  if (hinglishTotal < SHORT_OVERALL_RATIO * englishTotal) {
    const needed = Math.ceil(SHORT_OVERALL_RATIO * englishTotal)
    issues.push(`Too short overall: ${hinglishTotal} words, it needs at least ${needed} (the English has ${englishTotal})`)
  }
  if (latin.length > 0) issues.push(`Roman/Latin letters in: ${latin.join(', ')} - write those words in Devanagari`)
  if ((englishSummary ?? '').trim() && !parsed.summary) issues.push('The ===SUMMARY=== section is missing')
  return issues
}

/** The one follow-up sent in the same conversation when the first reply fails the check. */
export function buildFollowUp(issues: string[], paragraphCount: number): string {
  return `Your reply did not pass the check:
${issues.map(issue => `- ${issue}`).join('\n')}
Send the complete reply again in the same format: every paragraph from [P1] to [P${paragraphCount}], fully converted, then ===SUMMARY===.`
}

// ============ What gets saved ============

export interface ConvertedScript {
  /** Paragraphs 1..N in order, then any extra marks above N, without the marks. */
  script: string
  /** The last saved paragraph. */
  closing: string
  /** The Hinglish SUMMARY section, or ''. */
  summary: string
}

/** Whether a reply has anything to save at all: a SCRIPT section with at least one mark. */
export function hasUsableScript(parsed: ParsedConversion): boolean {
  return parsed.paragraphs.size > 0
}

export function assembleConversion(parsed: ParsedConversion, paragraphCount: number): ConvertedScript {
  const numbers = [...parsed.paragraphs.keys()]
  const inRange = numbers.filter(n => n >= 1 && n <= paragraphCount).sort((a, b) => a - b)
  const extra = numbers.filter(n => n > paragraphCount).sort((a, b) => a - b)
  const saved = [...inRange, ...extra].map(n => parsed.paragraphs.get(n)!).filter(Boolean)
  return {
    script: saved.join('\n\n'),
    closing: saved[saved.length - 1] ?? '',
    summary: parsed.summary
  }
}

/** Stored `review` column ⇄ issue lines. */
export function encodeReview(issues: string[] | null | undefined): string | null {
  return issues && issues.length > 0 ? JSON.stringify(issues) : null
}

export function decodeReview(value: string | null | undefined): string[] | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.length > 0 ? parsed.map(String) : null
  } catch {
    return null
  }
}

/**
 * A chapter's Hinglish status (the contract's table, plus the desktop's own
 * `failed` for a chapter whose only conversion attempt failed): waiting while
 * there is no English script, pending with no Hinglish one, stale once the
 * English it was converted from has changed (a script with no recorded source,
 * e.g. an old one written from the images, is stale too), review when saved
 * despite failing the check, otherwise done. A failed re-conversion keeps the
 * script it had, and its state.
 */
export type HinglishState = 'waiting' | 'pending' | 'stale' | 'review' | 'done' | 'failed'

export function hinglishState(input: {
  englishSha256: string | null
  hindi: { status: string; hasScript: boolean; sourceSha256: string | null; review: string | null } | null
}): HinglishState {
  const { englishSha256, hindi } = input
  if (!englishSha256) return 'waiting'
  if (!hindi || !hindi.hasScript) return hindi?.status === 'failed' ? 'failed' : 'pending'
  if (hindi.sourceSha256 !== englishSha256) return 'stale'
  return decodeReview(hindi.review) ? 'review' : 'done'
}

/** States the "Convert to Hinglish" action picks up. */
export function needsConversion(state: HinglishState): boolean {
  return state === 'pending' || state === 'stale' || state === 'failed'
}
