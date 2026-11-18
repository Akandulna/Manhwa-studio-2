/**
 * The Hinglish narration rules and checks, the same in every place a Hinglish script is written: Narration's copyable
 * manual prompts (narrationManualPrompts.ts), the Gemini app and AntiGravity stages (geminiMcp/hinglish.ts) and the
 * phone (Sleeper-Cell's HinglishLanguage.kt, NarrationQuality.kt, NarrationPacing.kt and HinglishConvert.kt).
 * Kept free of database imports.
 *
 * The rule texts must stay byte-identical with the phone's: hinglishRules.test.ts and the phone's
 * HinglishParityTest.kt pin the same fingerprint (HINGLISH_RULES_SHA256). Change both sides together.
 */

import { QUALITY_RULES, presentationIssues } from './narrationRules.js'

export const HINGLISH_LANGUAGE = `LANGUAGE: HINGLISH (Hindi + English mix, written in Devanagari)
- Write in Hinglish - the casual Hindi-English mix a popular Hindi manhwa recap YouTuber speaks, the way young Indian viewers actually talk. Not pure, formal, literary or "shuddh" Hindi
- Sentence structure and grammar stay Hindi (verbs, connectors, flow), but use English words wherever a Hinglish speaker naturally would instead of heavy Hindi words
- Always prefer the English word for manhwa/game/fantasy terms: power, level, system, skill, rank, quest, dungeon, gate, hunter, monster, boss, guild, mana, energy, attack, damage, fight, training, mission, master, sect, clan, academy, villain, hero, plan, chance, moment, shock, scene, tension, emotional
- Use English for everyday words people say in English anyway: actually, simply, seriously, finally, exactly, problem, situation, normal, strong, weak, important, team, family, office, school, phone, time, control, focus, support, respect, game, challenge, entry, return
- Avoid stiff Sanskritised Hindi: say पावर not शक्ति, सिस्टम not प्रणाली, अटैक not आक्रमण, लेवल not स्तर, प्लान not योजना, चांस not अवसर, सिचुएशन not परिस्थिति, फाइट not युद्ध/लड़ाई when it is a fight scene, मिशन not अभियान
- Keep it natural, not forced: roughly 25-40% English words, never whole English sentences. Hindi words that are already common and simple (लेकिन, फिर, अचानक, सब, डर, गुस्सा, ताकत, दुश्मन) stay Hindi
- Write EVERYTHING in Devanagari script, including the English words, spelled the way they are spoken: "उसका लेवल अचानक बहुत हाई हो गया।", "सिस्टम ने उसे एक नया क्वेस्ट दिया।" Never use Roman/Latin letters - the voiceover and alignment can only read Devanagari
- Character names, places and techniques also go in Devanagari as they are pronounced; do not add English translations or Roman-script words in brackets
- Narration voice: an engaging storyteller talking to the viewer, like explaining the story to a friend - calm and measured with a dry wit (no exaggerated hype, no stage directions like [excited] or *sighs*)
- Hindi muhavare and desi comparisons are optional, rare and brief, only when they fit naturally within the narration's length budget. No frequency quota; do not add a separate explanation or repeat an idiom
- Dry humour is optional and brief within the same length budget, never an extra required sentence beside the story. No sarcasm in sad, emotional or death scenes, and it must never change what happened
- Preserve the English story beats at a medium pace. Condense repeated wording and routine actions without losing meaning; scenes may be shorter than English and must not automatically expand
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

export const HINGLISH_QUALITY_RULES = `${QUALITY_RULES}
Apply these rules to Hinglish independently. For example, omit "स्क्रीन पर चैप्टर हेडर आता है", "एपिसोड सोलह का हेडर चमकता है", "प्रोडक्शन क्रेडिट्स दिखाई देते हैं" and "सीरीज़ का लोगो आ जाता है"; retain the surrounding story action.
Replace "एक टेक्स्ट बॉक्स बताता है कि तीन दिन पहले" with "तीन दिन पहले", and introduce a character directly instead of saying a caption or title card identifies them.`

/**
 * The storytelling pace the Hinglish follows: the phone's NarrationPacing.RULES (its base for both languages), which
 * also covers conversion. Studio's English narration keeps its own PACING_RULES.
 */
const HINGLISH_BASE_PACING = `STORYTELLING PACE:
Write a clear, engaging recap with enough detail to follow the story and feel its important moments. Avoid both a bare plot summary and an exhaustive panel-by-panel audiobook.
Preserve the opening and ending, distinct story events in source order, who does what to whom, causes and consequences, decisions, motives, meaningful dialogue and thoughts, emotional turns, clues, names, relevant numbers and ability/system rules.
Combine consecutive routine movements, repeated attacks and reactions into concise story beats. Retain any distinct action, tactic, injury, discovery or change of outcome. Do not erase an event merely to save words.
Explain each fact once. Condense repeated dialogue without losing its meaning, tone or speaker. Do not restate an emotion already clear from the action, explain the same rule twice, or add decorative descriptions, filler transitions or commentary that explains the obvious.
Give major reveals, betrayals, decisions and emotional moments room to land. Move more quickly through travel, routine exchanges and repetitive combat; do not give every panel equal narration time.
Detailed image/scene notes are evidence, not a sentence checklist. When image references are required, a concise paragraph may cover several consecutive images while preserving their story meaning and order; every story image must still be accounted for. During conversion, account for every English source paragraph through the scene ranges.
During drafting and review, retain concise wording and combined actions. Restore missing story meaning, not redundant description. These pacing rules override requests for exhaustive descriptions or extra commentary, while source accuracy and story coverage remain mandatory.`

export const HINGLISH_PACING_RULES = `${HINGLISH_BASE_PACING}
HINGLISH LENGTH AND DELIVERY:
Retell the same story beats in natural spoken Hinglish. Keep the English script's pace: do not cut it further or pad the conversion. Sentence and word counts may differ from English; a scene does not have to be longer. Do not expand every English phrase into an explanation.
Aim for roughly 90-115% of the English script's word count overall, without padding to reach a target. The checks accept 85-130% of the English words (with a 24-word allowance for short scripts), and each scene of 12 or more English words needs at least 6 Hinglish words for every 10 English ones; the exact chapter floor and ceiling are supplied with the English source. Word count is a pacing guide, not a promise of audio duration.
Keep idioms and dry humour optional, rare and brief, within the same length budget. Never require one every few paragraphs, append extra commentary to each scene, or use humour in sad, emotional or death scenes.
Check each scene against English for story meaning and emotional emphasis. Fix omissions concisely; do not restore repeated descriptions or add new events. Preserve all required scene ranges and source-paragraph coverage.`

/** Every Hinglish rule text, in prompt order; its sha256 is pinned on both sides (see the header). */
export const HINGLISH_RULES = [HINGLISH_LANGUAGE, HINGLISH_QUALITY_RULES, HINGLISH_PACING_RULES].join('\n\n')
export const HINGLISH_RULES_SHA256 = '462d67c422789d971ae0149ffe0f743173a6bf37a21a672ff0661cb2888967e6'

/** The Hinglish length window for an English source of [words] words (parseManualNarration enforces it). */
export const hinglishBudget = (words: number) => ({ floor: Math.ceil(words * 0.85), ceiling: Math.max(Math.ceil(words * 1.3), words + 24) })

/** The English script's paragraphs, numbered [P1]…[Pn] for the Hinglish scene ranges (as parseManualNarration counts them). */
export const englishParagraphs = (script: string) => script.split(/\r?\n/).map(p => p.trim()).filter(Boolean)

/** Whitespace-separated tokens with a letter or digit in any script (the phone's HinglishConvert.words). */
export const hinglishWords = (text: string) => text.split(/\s+/u).filter(w => /[\p{L}\p{N}]/u.test(w)).length

/** A scene covering at least MIN_CHECKED_WORDS English words needs at least MIN_SCENE_RATIO of them in Hinglish. */
export const MIN_SCENE_RATIO = 0.6
export const MIN_CHECKED_WORDS = 12

const label = (start: number, end: number) => start === end ? `P${start}` : `P${start}-P${end}`

/** The phone's "Too short" issue for scenes cut short, or null. [scenes] are the marked ranges and their Hinglish text. */
export function shortSceneIssue(scenes: { start: number; end: number; text: string }[], english: string[]): string | null {
  const short = scenes.flatMap(({ start, end, text }) => {
    let target = 0
    for (let p = Math.max(1, start); p <= Math.min(end, english.length); p++) target += hinglishWords(english[p - 1])
    const got = hinglishWords(text)
    return target >= MIN_CHECKED_WORDS && got < target * MIN_SCENE_RATIO ? [`${label(start, end)} (${got} words, the English has ${target})`] : []
  })
  return short.length ? `Too short: ${short.join(', ')}` : null
}

/** Header/caption wording in the English a Hinglish is written from (the phone refuses to convert it). */
export const englishSourceIssues = (english: string) =>
  presentationIssues(english).map(issue => `English source needs correction before conversion: ${issue}`)
