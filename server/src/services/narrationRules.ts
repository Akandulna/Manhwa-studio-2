/**
 * Narration rule texts shared by the manual "Continue manually" prompts (narrationManualPrompts.ts) and AntiGravity
 * Narration (antigravity/narrationFlow.ts). They follow Sleeper-Cell's NarrationPrompt.kt, NarrationQuality.kt and
 * NarrationPacing.kt and the phone's default "Script" prompt: keep them in sync when the phone's prompts change.
 */

export const SCRIPT_STYLE = `You are writing a concise manhwa recap narration script for spoken delivery.

STYLE RULES:
- Third-person narration with clear, straightforward prose
- Calm, measured tone - avoid dramatic exclamations or over-the-top language
- No prologue or epilogue - start directly with the story action
- No ending/epilogue lines (unless this is explicitly marked as a Part end)
- Keep dialogue natural but not exaggerated
- Use present tense for action, past tense for backstory
- Keep paragraphs short for easy voice-over reading
- Do NOT include stage directions like [excited], [whisper], *sighs*, etc.
- Avoid excessive punctuation (!!!, ???, ...) - use periods and commas
- Write for a neutral reading pace - no dramatic pauses needed
- Keep distinct story developments and meaningful emotion; combine routine actions, repeated attacks and reactions into concise story beats
- Explain each fact once; give important reveals and decisions more room than travel or routine exchanges`

export const QUALITY_RULES = `SPOKEN NARRATION ONLY:
Output only words intended to be spoken as the story. Never narrate chapter/episode numbers or headers, title cards, series logos, production/end credits, watermarks, scanlator messages or promotional text, even when they share an image with story panels.
Supplied notes can contain page-presentation descriptions. Those descriptions are not story events and must not be carried into the spoken script, including its opening and closing.
Preserve meaningful information from captions, dialogue and internal thoughts, but tell it directly. Do not describe a text box, caption, speech bubble, panel, camera shot or the act of narration.
Examples: "A chapter header marks episode sixteen above running students" becomes "The students run"; "A caption identifies him as Rilai" becomes "He is Rilai"; "A text box introduces a flashback three days earlier" becomes "Three days earlier"; "He smiles while the credits appear below" becomes "He smiles".
Do not add "the chapter begins/ends", cliffhanger announcements, review notes, source labels, headings or stage directions. Begin and end with the actual story events.
Preserve screens, signs, documents, game/system messages and titles that exist within the story, along with their meaningful content. A character earning credit or holding a title is valid story content. Do not delete sentences merely because they contain words such as screen, title or credit.
This restriction overrides requests to preserve every description: preserve STORY meaning and order, excluding publication/presentation material. Repeated descriptions may be condensed under the pacing rules.`

export const PACING_RULES = `STORYTELLING PACE:
Write a concise, engaging recap. Preserve story meaning while removing repeated reactions, routine description and filler.
Preserve the opening and ending, distinct story events in source order, who does what to whom, causes and consequences, decisions, motives, meaningful dialogue and thoughts, emotional turns, clues, names, relevant numbers and ability/system rules.
Combine consecutive routine movements, repeated attacks and reactions into concise story beats. Retain any distinct action, tactic, injury, discovery or change of outcome. Do not erase an event merely to save words.
Explain each fact once. Condense repeated dialogue without losing its meaning, tone or speaker. Do not restate an emotion already clear from the action, explain the same rule twice, or add decorative descriptions, filler transitions or commentary that explains the obvious.
Give major reveals, betrayals, decisions and emotional moments room to land. Move more quickly through travel, routine exchanges and repetitive combat; do not give every panel equal narration time.
Detailed image notes are evidence, not a sentence checklist. A concise paragraph may cover several consecutive images while preserving their story meaning and order; every story image must still be accounted for.
During drafting and review, retain concise wording and combined actions. Restore missing story meaning, not redundant description. These pacing rules override requests for exhaustive descriptions or extra commentary, while source accuracy and story coverage remain mandatory.`

/**
 * English scripts ran too long (2026-11-13): the review cuts the draft by about this share. A soft target in the
 * prompt only — never validated, so a script is not thrown away over a few words. English only: the Hinglish
 * is converted from the saved English script (its budget is relative to it), so it shrinks with it.
 * Same wording as Sleeper-Cell's NarrationPacing.lengthCut.
 */
export const ENGLISH_LENGTH_CUT = 0.3

/**
 * Chapters should export under 4 minutes (2026-11-17). The voice reads ~165 English words a minute, so the review
 * also aims at no more than ENGLISH_WORD_AIM words, allowing up to ENGLISH_WORD_STRETCH for a dense chapter
 * (≈3.4–3.9 min). Soft, like the cut: nothing counts the result.
 */
export const ENGLISH_WORD_AIM = 560
export const ENGLISH_WORD_STRETCH = 640

/** The review's word aim for a draft of [draftWords] words: 30% under it, at most ENGLISH_WORD_AIM, rounded to tens. */
export const lengthCutTarget = (draftWords: number) =>
  Math.min(ENGLISH_WORD_AIM, Math.max(10, Math.round(draftWords * (1 - ENGLISH_LENGTH_CUT) / 10) * 10))

/** The review's length instruction; without a count (manual prompts) the model measures its own draft. */
export function lengthCutRule(draftWords?: number): string {
  const aim = draftWords
    ? `The draft has about ${draftWords} spoken words. Make the final narration shorter: aim for roughly ${lengthCutTarget(draftWords)} words.`
    : `Make the final narration about 30% shorter than your draft script, and no more than about ${ENGLISH_WORD_AIM} words.`
  return `LENGTH CUT (each chapter's voiceover must stay under 4 minutes):
${aim}
Only a chapter dense with distinct story events may go up to about ${ENGLISH_WORD_STRETCH} words; never go beyond that.
Get there by cutting repeated reactions, routine movement and travel, restated emotions, decorative description, filler transitions and secondary lines of dialogue, and by merging consecutive minor beats into one sentence.
Keep the opening and ending, every distinct story event in order, who does what to whom, causes and consequences, decisions, reveals, names and ability/system rules. This is an aim, not a hard limit: never drop a story event to reach the number.`
}

/** Spoken script words only; excludes summaries, scene markers and audit text. */
export const narrationWords = (script: string): number => script.split(/\s+/u).filter(w => /[\p{L}\p{N}]/u.test(w)).length

/**
 * Non-story presentation wording (chapter headers, title cards, credits, "a caption identifies…") that must never be
 * voiced. Deliberately specific phrases, not keywords: ambiguous prose still needs the model's check. The same
 * patterns and message as Sleeper-Cell's NarrationQuality.issues; keep the two lists identical.
 */
const PRESENTATION = [
  /\b(?:chapter|episode)\s+(?:header|heading|number)\b/i,
  /\btitle\s+card\b/i,
  /\b(?:production|end[- ]of[- ]chapter|end)\s+credits\b/i,
  /\bcredits\s+(?:appear|roll|below|card)\b/i,
  /\b(?:series|manhwa)\s+(?:title\s+)?logo\b/i,
  /\b(?:text\s*box|caption(?:\s+box)?|speech\s+bubble)\s+(?:formally\s+)?(?:introduces?|identifies?|reads?|states?|says?|explains?|transitions?|declares?|reveals?)\b/i,
  /\b(?:internal\s+monologue|narration)\s+(?:states?|introduces?|explains?|reveals?)\b/i,
  /\bthrough\s+narration\b/i,
  /\b(?:establishing|overhead|exterior)\s+(?:camera\s+)?(?:shot|view)\s+(?:shows?|opens?)\b/i,
  /\b(?:the\s+)?chapter\s+(?:begins|ends|closes)\b/i,
  /(?:चैप्टर|एपिसोड)\s+(?:का\s+)?(?:हेडर|हेडिंग|नंबर)/i,
  /एपिसोड\s+[^।!?\n]{1,24}\s+का\s+हेडर/i,
  /टाइटल\s+कार्ड|प्रोडक्शन\s+क्रेडिट्स|एंड\s+क्रेडिट्स/i,
  /(?:सीरीज़|सीरीज|मैनह्वा|मनह्वा)\s+का\s+लोगो/i,
  /(?:टेक्स्ट\s+बॉक्स|कैप्शन)\s+(?:हमें\s+)?(?:बताता|बताती|आता|दिखाई|से\s+पता)/i,
  /(?:चैप्टर\s+(?:खत्म|ख़त्म|समाप्त)|नैरेटर\s+बताता)/i
]
const HEADING = /^\s*(?:#+\s*)?(?:chapter|episode|चैप्टर|एपिसोड)\s+[\d०-९]+\s*[:.\-–—]?.*$/i

/** One issue per offending paragraph (non-blank line). Flags for correction; never strips text. */
export function presentationIssues(script: string): string[] {
  return script.split('\n').filter(l => l.trim()).flatMap((line, index) => {
    const match = PRESENTATION.map(r => r.exec(line)?.[0]).find(Boolean) ?? HEADING.exec(line)?.[0]
    return match ? [`Paragraph ${index + 1} contains non-story presentation wording: ${match}. Rewrite it as direct story narration, preserving story facts.`] : []
  })
}
