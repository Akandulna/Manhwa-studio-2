/**
 * Hinglish convert step — the pure half: the prompts, the check and what gets
 * saved. The Gemini calls and the database live in hinglishService.ts.
 *
 * Hinglish ("Hindi" on the desktop tab) is never written from the manhwa
 * images: a one-pass Hindi script came out about half as long as the English
 * one. Instead each chapter's English script is written as usual and then
 * retold, text only, in two steps of one chat. Converting it paragraph by
 * paragraph read like a translation, so the model first splits the English
 * paragraphs [P1]..[PN] into scenes and makes notes on each (step 1), then
 * writes each scene in its own words (step 2). Every scene of the reply is
 * marked with the paragraphs it covers, [SCENE 2: P5-P7], so the check can
 * still tell exactly which paragraphs were dropped or cut short.
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
- End sentences with the Hindi full stop (।)

SPOKEN HINDI, NOT TRANSLATED HINDI
- Tell it the way you would tell this story to a friend out loud, not the way a translator writes. Never keep an English sentence's shape and just swap in Hindi words
- Use spoken forms: वो, ये, उसे, अगर, असल में - not वह, यह, यदि, वास्तव में, अतः, किंतु, परंतु, मृत्यु
- Link sentences with the connectors people use while talking - लेकिन, और, तो, पर, अब, फिर, यानी, बस, तभी, उधर - where a speaker naturally would, not on every line
- Turn English "only when", "if", "which" and "because" clauses into the way Hindi speakers say it: "उसे ... करना पड़ेगा", "... के लिए", "जैसे ही", or two short sentences
- Put the twist or the important part at the end of the sentence, where the Hindi verb lands
- Tell the action in the present tense, like recap channels do ("वो दरवाज़ा खोलता है", "तभी उसे समझ आता है"), and backstory in the past tense
- Prefer short, punchy sentences to long ones strung together with commas
Examples (✗ translated, ✓ spoken):
✗ ये स्किल सिर्फ़ तभी ऐक्टिवेट होगी, जब वह मर जाएगा।
✓ लेकिन ये स्किल ऐक्टिवेट करने के लिए उसे मरना पड़ेगा।
✗ यदि वह यह क्वेस्ट पूरा नहीं करता है, तो उसकी मृत्यु हो जाएगी।
✓ और अगर ये क्वेस्ट पूरा नहीं हुआ, तो सीधा मौत।
✗ उसे यह एहसास हुआ कि वह अकेला नहीं था।
✓ तभी उसे समझ आता है कि वो अकेला नहीं है।
✗ वह आदमी, जिससे वह पहले मिला था, वास्तव में गिल्ड का मास्टर था।
✓ और जिस आदमी से वो पहले मिला था? वो असल में गिल्ड मास्टर निकला।`

/** Settings key holding the editable rules. */
export const HINGLISH_RULES_SETTING = 'narrationHinglishRules'

// Thresholds of the check.
const SHORT_SCENE_MIN_WORDS = 12
const SHORT_SCENE_RATIO = 0.6
const SHORT_OVERALL_RATIO = 0.85

/**
 * The English script's paragraphs: every non-blank line, trimmed. The
 * narration is written one paragraph per line (blank lines between), so a line
 * is the unit the scenes have to account for.
 */
export function englishParagraphs(script: string): string[] {
  return script.split('\n').map(line => line.trim()).filter(Boolean)
}

/** SHA-256 hex of the English script as saved, trimmed — what a Hinglish script records as its source. */
export function sourceSha256(englishScript: string): string {
  return createHash('sha256').update(englishScript.trim(), 'utf8').digest('hex')
}

/**
 * Step 1, the first message of the chat: the rules, the English script and
 * summary, and the ask to split the script into scenes and make notes on each,
 * without writing the narration yet.
 */
export function buildConvertPrompt(rules: string, englishScript: string, englishSummary: string | null | undefined): string {
  const paragraphs = englishParagraphs(englishScript)
  const n = paragraphs.length
  const summary = (englishSummary ?? '').trim()
  const numbered = paragraphs.map((p, i) => `[P${i + 1}] ${p}`).join('\n\n')

  return `${rules}

---

TASK: Retell the English manhwa recap narration script below in Hinglish, following the language rules above.

This is not a translation. A translation keeps the English sentences and sounds stiff; the story has to be told again in your own words, the way a Hindi recap YouTuber would tell it. So it is done in two steps, in this chat:
1. Now: read the whole script, understand the story scene by scene and make notes
2. Next message: write the Hinglish narration from your notes

STEP 1 - SCENE NOTES (do not write the narration yet):
- Split the English script into scenes. A scene is a run of paragraphs about one moment, place or exchange, usually 2 to 6 paragraphs. Every paragraph from [P1] to [P${n}] belongs to exactly one scene, in order, with no gaps or overlaps
- Under each scene, write short notes in Hinglish (Devanagari):
  - everything that happens, in order: every event, action, description, name, number and inner thought
  - what each character says - the meaning and tone of the line, not a translation of it
  - the mood of the scene, and what the viewer should feel
  - where a Hindi muhavara or a sarcastic narrator comment would fit, if anywhere

Format your response EXACTLY like this:
===SCENES===
[SCENE 1: P1-P4]
- <note>
- <note>

[SCENE 2: P5-P7]
- <note>

...

ENGLISH SCRIPT (${n} paragraphs):
${numbered}${summary ? `

ENGLISH STORY SUMMARY:
${summary}` : ''}`
}

/** Step 2, sent in the same chat after the scene notes: write the narration scene by scene. */
export function buildWritePrompt(paragraphCount: number, withSummary: boolean): string {
  return `STEP 2 - WRITE: Now write the full Hinglish narration from your scene notes, following the language rules from my first message - spoken Hindi, not translated Hindi.
- Go scene by scene, with the same scenes as your notes. Start each scene with its mark on a line of its own, exactly as in your notes: [SCENE 1: P1-P4]. Between them the scenes must cover [P1] to [P${paragraphCount}]
- Tell each scene in your own words. Do not follow the English sentences or their order - only what happens has to match. Merge, split and reorder sentences inside a scene however it sounds most natural when spoken
- Keep everything from your notes: every event, action, description, name, number and inner thought. Do not summarize, skip or shorten, and do not add new events. Muhavare and sarcastic comments are extra lines - they never replace or change what happens
- Rewrite dialogue the way that character would say it in Hinglish, with the same meaning and tone
- Each scene should be about as long as the English paragraphs it covers, or longer - Hinglish usually needs more words than English, never fewer
- Keep paragraphs short for easy voice-over reading: one paragraph per line, a blank line between paragraphs${withSummary ? `
- Then retell the English story summary in the same Hinglish style, keeping all of its details` : ''}

Format your response EXACTLY like this:
===SCRIPT===
[SCENE 1: P1-P4]
<Hinglish paragraph>

<Hinglish paragraph>

[SCENE 2: P5-P7]
<Hinglish paragraph>

...${withSummary ? `

===SUMMARY===
<Hinglish story summary>` : ''}`
}

// ============ Parsing the reply ============

/** One scene of the step 2 reply: the English paragraphs it covers, start..end, and its Hinglish paragraphs. */
export interface Scene {
  start: number
  end: number
  paragraphs: string[]
}

export interface ParsedConversion {
  /** Scenes in reply order; an exact repeat of an earlier range is dropped. */
  scenes: Scene[]
  /** The SUMMARY section, trimmed; '' when missing. */
  summary: string
  /** The reply is step 1's scene notes (===SCENES===, no ===SCRIPT===), not the narration. */
  notesOnly: boolean
}

/**
 * A scene mark at a line start, possibly dressed as bold, a heading or a quote:
 * `[SCENE 2: P5-P7]`, `**[Scene 2 – P5 to P7]**`, `## [SCENE 3: P8]`.
 */
const SCENE_MARK = /^[ \t*_#>]*\[\s*SCENE\s*\d*\s*[:.\-–—]?\s*P\s*(\d+)\s*(?:(?:-|–|—|to)\s*P?\s*(\d+)\s*)?\][ \t*_:.\-–—]*/gim

/** Step 1's section marker, which a pasted step 1 reply has instead of ===SCRIPT===. */
const SCENES_SECTION = /^[ \t*#_`>]*===\s*SCENES\s*===/im

/** Reads the SCRIPT section's marked scenes and the SUMMARY section of a reply. */
export function parseConversionReply(reply: string): ParsedConversion {
  const sections = parseDelimitedResponse(reply)
  const summary = (sections.summary ?? '').trim()
  if (sections.script === undefined && SCENES_SECTION.test(reply)) return { scenes: [], summary, notesOnly: true }

  const script = sections.script ?? ''
  const scenes: Scene[] = []
  const marks = [...script.matchAll(SCENE_MARK)]
  marks.forEach((mark, i) => {
    const first = Number(mark[1])
    const last = mark[2] === undefined ? first : Number(mark[2])
    const [start, end] = first <= last ? [first, last] : [last, first]
    if (scenes.some(scene => scene.start === start && scene.end === end)) return
    const from = mark.index! + mark[0].length
    const to = i + 1 < marks.length ? marks[i + 1].index! : script.length
    const paragraphs = script.slice(from, to).split('\n').map(line => line.trim()).filter(Boolean)
    scenes.push({ start, end, paragraphs })
  })

  return { scenes, summary, notesOnly: false }
}

// ============ The check ============

/** Whitespace-separated tokens with at least one letter or digit, in any script. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(token => /[\p{L}\p{N}]/u.test(token)).length
}

/** `P5` or `P5-P7`. */
function rangeLabel(start: number, end: number): string {
  return start === end ? `P${start}` : `P${start}-P${end}`
}

/** Ascending paragraph numbers as runs: `P2, P5-P7`. */
function runs(numbers: number[]): string {
  const labels: string[] = []
  let i = 0
  while (i < numbers.length) {
    let j = i
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++
    labels.push(rangeLabel(numbers[i], numbers[j]))
    i = j + 1
  }
  return labels.join(', ')
}

const NOTES_ONLY_ISSUE = 'This is the step 1 reply (the scene notes), not the narration - send the step 2 prompt in the same chat and use its reply'
const NO_SCENES_ISSUE = 'No scenes found - start each scene with its mark on a line of its own, like [SCENE 1: P1-P4]'

/**
 * The check's issue lines, worded as in the follow-up prompt; empty means the
 * reply passed. Only paragraphs 1..N are counted and checked; a scene with no
 * text covers nothing.
 */
export function checkConversion(english: string[], englishSummary: string | null | undefined, parsed: ParsedConversion): string[] {
  if (parsed.notesOnly) return [NOTES_ONLY_ISSUE]
  const n = english.length
  const scenes = parsed.scenes.filter(scene => scene.paragraphs.length > 0)
  const issues: string[] = []

  if (scenes.length === 0) {
    issues.push(NO_SCENES_ISSUE)
  } else {
    const englishWords = english.map(countWords)
    const coverage = new Array<number>(n + 1).fill(0)
    const short: string[] = []
    const latin: string[] = []
    let hinglishTotal = 0

    for (const scene of scenes) {
      let sceneEnglish = 0
      for (let p = scene.start; p <= Math.min(scene.end, n); p++) {
        coverage[p]++
        sceneEnglish += englishWords[p - 1]
      }
      const words = scene.paragraphs.reduce((sum, paragraph) => sum + countWords(paragraph), 0)
      hinglishTotal += words
      const label = rangeLabel(scene.start, scene.end)
      if (sceneEnglish >= SHORT_SCENE_MIN_WORDS && words < SHORT_SCENE_RATIO * sceneEnglish) {
        short.push(`${label} (${words} words, the English has ${sceneEnglish})`)
      }
      if (scene.paragraphs.some(paragraph => /[A-Za-z]/.test(paragraph))) latin.push(label)
    }

    const numbers = Array.from({ length: n }, (_, i) => i + 1)
    const missing = numbers.filter(p => coverage[p] === 0)
    const doubled = numbers.filter(p => coverage[p] > 1)
    const englishTotal = englishWords.reduce((sum, words) => sum + words, 0)

    if (missing.length > 0) issues.push(`Missing paragraphs: ${runs(missing)}`)
    if (doubled.length > 0) issues.push(`Paragraphs in more than one scene: ${runs(doubled)}`)
    if (short.length > 0) issues.push(`Too short: ${short.join(', ')}`)
    if (hinglishTotal < SHORT_OVERALL_RATIO * englishTotal) {
      const needed = Math.ceil(SHORT_OVERALL_RATIO * englishTotal)
      issues.push(`Too short overall: ${hinglishTotal} words, it needs at least ${needed} (the English has ${englishTotal})`)
    }
    if (latin.length > 0) issues.push(`Roman/Latin letters in: ${latin.join(', ')} - write those words in Devanagari`)
  }
  if ((englishSummary ?? '').trim() && !parsed.summary) issues.push('The ===SUMMARY=== section is missing')
  return issues
}

/** The one follow-up sent in the same conversation when the step 2 reply fails the check. */
export function buildFollowUp(issues: string[], paragraphCount: number, withSummary: boolean): string {
  return `Your reply did not pass the check:
${issues.map(issue => `- ${issue}`).join('\n')}
Send the complete narration again in the same format: every scene with its [SCENE n: Px-Py] mark, covering [P1] to [P${paragraphCount}] between them, fully written${withSummary ? ', then ===SUMMARY===.' : '.'}`
}

// ============ What gets saved ============

export interface ConvertedScript {
  /** Every scene's paragraphs in reply order, without the marks. */
  script: string
  /** The last saved paragraph. */
  closing: string
  /** The Hinglish SUMMARY section, or ''. */
  summary: string
}

/** Whether a reply has anything to save at all: a scene with text in a SCRIPT section. */
export function hasUsableScript(parsed: ParsedConversion): boolean {
  return parsed.scenes.some(scene => scene.paragraphs.length > 0)
}

export function assembleConversion(parsed: ParsedConversion): ConvertedScript {
  const saved = parsed.scenes.flatMap(scene => scene.paragraphs)
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
