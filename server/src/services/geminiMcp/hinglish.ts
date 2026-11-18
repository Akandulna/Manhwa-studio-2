/**
 * Gemini MCP → Hinglish narration stages (docs/PRD-gemini-app-narration.md §4, Phase 4). A separate job and chat
 * from the English one; it reads no images, only the chapter's saved English script:
 *
 *   hi_scenes — scene notes: every English paragraph [P1]…[Pn] in exactly one scene, in order, each with notes
 *   hi_script — the Hinglish narration in Devanagari, scene by scene, with [SCENE n: Px-Py] marks, and its summary
 *   hi_check  — the final spoken-narration check of that narration
 *
 * The rules are Narration's copyable Hinglish prompts (hinglishRules.ts), phrased as a description of each stage's
 * result. hi_script and hi_check are checked with parseManualNarration, the same check the save runs (Devanagari
 * only, scene ranges covering every English paragraph once, the length window), so an accepted check always saves.
 */

import { LENGTH_LIMITS, parseManualNarration } from '../narrationManual.js'
import { HINGLISH_LANGUAGE, HINGLISH_PACING_RULES, HINGLISH_QUALITY_RULES, englishParagraphs, hinglishBudget } from '../hinglishRules.js'
import { InvalidReply } from '../antigravity/narrationFlow.js'
import { normalizeDraft } from './english.js'

export const HINGLISH_STAGES = ['hi_scenes', 'hi_script', 'hi_check'] as const
export type HinglishStage = typeof HINGLISH_STAGES[number]

export interface HinglishProgress {
  scenes: string | null
  script: string | null
  final: string | null
  rejections: Record<string, number>
  startedAt?: string
  steps?: { key: string; at: string; rejected: number }[]
  history?: { key: string; at: string; problems: string[] }[]
}

/** The English script and summary the Hinglish is written from. */
export interface EnglishSource { script: string; summary: string | null }

export const emptyHinglish = (): HinglishProgress => ({ scenes: null, script: null, final: null, rejections: {} })
export function parseHinglish(json: string | null | undefined): HinglishProgress {
  try {
    const v = JSON.parse(json ?? 'null') as Partial<HinglishProgress> | null
    return v && typeof v === 'object' ? { ...emptyHinglish(), ...v, rejections: v.rejections ?? {} } : emptyHinglish()
  } catch { return emptyHinglish() }
}

export function hinglishStage(progress: HinglishProgress): HinglishStage | 'done' {
  if (!progress.scenes) return 'hi_scenes'
  if (!progress.script) return 'hi_script'
  if (!progress.final) return 'hi_check'
  return 'done'
}

/** Gemini names stages its own way ("scenes", "Hinglish script", "final check"). */
export function hinglishStageArg(value: unknown): HinglishStage | null {
  const v = typeof value === 'string' ? value.toLowerCase() : ''
  if (/scene|note/.test(v)) return 'hi_scenes'
  if (/check|review|final/.test(v)) return 'hi_check'
  if (/script|write|narration|hinglish|hi_script/.test(v)) return 'hi_script'
  return null
}

const words = (text: string) => text.split(/\s+/u).filter(w => /[\p{L}\p{N}]/u.test(w)).length

function budget(source: EnglishSource) {
  const n = englishParagraphs(source.script).length
  const count = words(source.script)
  return { paragraphs: n, words: count, ...hinglishBudget(count) }
}

const SCENE_MARK = /^[ \t*_#>]*\[\s*SCENE\s*\d*\s*[:.\-–—]?\s*P\s*(\d+)\s*(?:(?:-|–|—|to)\s*P?\s*(\d+)\s*)?][ \t*_:.\-–—]*$/gim

/** Scene notes: marks covering [P1]…[Pn] once, in order, each with notes under it. */
export function readScenes(raw: string, paragraphs: number): string {
  let text = raw.trim().replace(/^```(?:\w+)?\s*\n/, '').replace(/\n```\s*$/, '').trim()
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    const scenes = value && typeof value === 'object' ? value.scenes ?? value.content ?? value.notes : null
    if (typeof scenes === 'string') text = scenes.trim()
  } catch { /* plain text, as asked */ }
  if (/===\s*(SCRIPT|SUMMARY)\s*===/i.test(text)) throw new InvalidReply('These are not scene notes: this stage is the scene notes only, under ===SCENES===, with no narration yet.')
  const marks = [...text.matchAll(SCENE_MARK)]
  if (!marks.length) throw new InvalidReply('No scene marks found. Each scene starts with a line like [SCENE 1: P1-P4].')
  let next = 1
  for (const [index, mark] of marks.entries()) {
    const start = Number(mark[1]), end = Number(mark[2] ?? mark[1])
    if (start !== next || end < start || end > paragraphs) {
      throw new InvalidReply(`Scene ${index + 1} covers P${start}-P${end}, but it must start at P${next}. The scenes cover P1 to P${paragraphs} once, in order, with no gaps or overlaps.`)
    }
    const body = text.slice(mark.index! + mark[0].length, marks[index + 1]?.index ?? text.length).trim()
    if (!body) throw new InvalidReply(`Scene ${index + 1} (P${start}-P${end}) has no notes.`)
    next = end + 1
  }
  if (next !== paragraphs + 1) throw new InvalidReply(`The scenes stop at P${next - 1}; they must cover every paragraph up to P${paragraphs}.`)
  return text.startsWith('===SCENES===') ? text : `===SCENES===\n${text}`
}

/** A Hinglish narration (hi_script or hi_check), checked exactly as the save will check it. */
export function readHinglish(raw: string, source: EnglishSource): string {
  const text = normalizeDraft(raw).trim().replace(/^```(?:\w+)?\s*\n/, '').replace(/\n```\s*$/, '').trim()
  try { parseManualNarration(text, 'hi', source.script) } catch (error) {
    const { words: english, floor, ceiling } = budget(source)
    const problem = error instanceof Error ? error.message : String(error)
    const count = (() => { try { const s = /===\s*SCRIPT\s*===([\s\S]*?)(?:===\s*SUMMARY\s*===|$)/i.exec(text)?.[1] ?? ''; return words(s.replace(SCENE_MARK, '')) } catch { return 0 } })()
    throw new InvalidReply(problem.split('\n').map(line => line === LENGTH_LIMITS
      ? `The Hinglish narration has ${count} words; it must be between ${floor} and ${ceiling} (English source: ${english} words), excluding scene marks and the summary.`
      : line.replace('Paste the complete narration', 'Send the complete narration').replace('Paste the final complete script', 'Send the final complete script')).join('\n'))
  }
  return text
}

const SCRIPT_FORMAT = `===SCRIPT===
[SCENE 1: P1-P4]
<Hinglish paragraph>

<Hinglish paragraph>

[SCENE 2: P5-P7]
<Hinglish paragraph>

...

===SUMMARY===
<Hinglish story summary>`

function scenesRules(source: EnglishSource) {
  const { paragraphs, words: count, floor, ceiling } = budget(source)
  return `${HINGLISH_LANGUAGE}

---

The job: a natural Hinglish narration of this fictional story segment (the English script, get_reference "english"), the way an Indian recap YouTuber would tell it, in three stages in this chat. This stage is the scene notes only; the narration comes in the next stage.

${HINGLISH_QUALITY_RULES}

${HINGLISH_PACING_RULES}

CHAPTER LENGTH BUDGET: English source = ${count} words. The Hinglish narration (next stage) stays between ${floor} and ${ceiling} words, excluding scene marks and summary. All story meaning is kept within this ceiling by removing repetition and filler, never by dropping events.

SCENE NOTES:
- The English script split into scenes. A scene is a run of paragraphs about one moment, place or exchange, usually 2 to 6 paragraphs. Every paragraph from [P1] to [P${paragraphs}] belongs to exactly one scene, in order, with no gaps or overlaps.
- Under each scene, short notes in Hinglish (Devanagari):
  - the story beats in order: events, causes, consequences, decisions, motives, meaningful thoughts, names, relevant numbers and rules; repeated actions and descriptions grouped without losing distinct developments
  - what each character says: the meaning and tone of the line, not a translation of it
  - the mood of the scene, and what the viewer should feel
  - an optional brief idiom only if it helps the moment without adding filler; no humour quota or extra commentary`
}

function scriptRules(source: EnglishSource) {
  const { paragraphs, floor, ceiling } = budget(source)
  return `The full Hinglish narration, written from the accepted scene notes (get_reference "scenes"), adapting the English script (get_reference "english") under the language rules of the scene-notes stage (get_reference "rules_scenes"): the original meaning, dramatic pacing and storytelling tone in natural spoken Hinglish.
${HINGLISH_QUALITY_RULES}
${HINGLISH_PACING_RULES}
- Scene by scene, with the same scenes as the notes. Each scene starts with its mark on a line of its own, exactly as in the notes: [SCENE 1: P1-P4]. Together the scenes cover [P1] to [P${paragraphs}].
- Each scene told in its own words. The English sentences and their order are not followed; only what happens has to match. Sentences inside a scene are merged, split and reordered however sounds most natural when spoken.
- Every distinct story beat, meaningful thought, name, relevant number and rule from the notes is kept. Routine movements, repeated descriptions and repeated dialogue are condensed; no events skipped or added.
- Each scene is cross-checked against the original English paragraphs; missing story meaning restored concisely, without restoring redundant descriptions.
- Dialogue the way that character would say it in Hinglish, with the same meaning and tone.
- Between ${floor} and ${ceiling} words in total. A scene may be shorter than its English source when its meaning is intact.
- Short paragraphs for easy voice-over reading: one paragraph per line, a blank line between paragraphs.
- ${source.summary ? 'Then the English story summary (get_reference "english") retold in the same Hinglish style, keeping all of its details.' : 'Then a short Hinglish summary of the story through this chapter (~150 words).'}
- Every word of the narration and the summary in Devanagari: no Roman/Latin letters except the ===SCRIPT===, ===SUMMARY=== and [SCENE n: Px-Py] markers.`
}

function checkRules(source: EnglishSource) {
  const { paragraphs, floor, ceiling } = budget(source)
  return `The final Hinglish spoken-narration check of the accepted narration (get_reference "hinglish"): EVERY paragraph inspected, including the opening and closing.
${HINGLISH_QUALITY_RULES}
${HINGLISH_PACING_RULES}
Cross-checked against the numbered English story (get_reference "english"). Story meaning, names, dialogue meanings, order and emotional emphasis preserved. Only offending narration corrected; no events added, clean paragraphs not rewritten for style. The total stays between ${floor} and ${ceiling} words.
Names are said directly, never as commentary about the story's telling (not "उसका नाम पता चलता है — कानाता" when nobody in the story learns it; say "कानाता अपने फादर को पुकारता है").
Every scene marker and its paragraph range stays exactly as written; together they cover [P1] to [P${paragraphs}] once, in order, and every scene contains narration.
Every word of the narration and the summary in Devanagari: no Roman/Latin letters anywhere except the ===SCRIPT===, ===SUMMARY=== and [SCENE n: Px-Py] markers.
Content: the complete corrected final output, nothing before or after it.`
}

/** What get_job gives for the job's current stage. */
export function hinglishStageData(progress: HinglishProgress, source: EnglishSource): Record<string, unknown> {
  const stage = hinglishStage(progress)
  const b = budget(source)
  const length = { english_paragraphs: b.paragraphs, english_words: b.words, hinglish_words_min: b.floor, hinglish_words_max: b.ceiling }
  switch (stage) {
    case 'hi_scenes':
      return { stage, references: ['english'], ...length, rules: scenesRules(source), content_format: '===SCENES===\n[SCENE 1: P1-P4]\n- <note>\n- <note>\n\n[SCENE 2: P5-P7]\n- <note>\n\n...' }
    case 'hi_script':
      return { stage, references: ['english', 'scenes', 'rules_scenes'], ...length, rules: scriptRules(source), content_format: SCRIPT_FORMAT }
    case 'hi_check':
      return { stage, references: ['english', 'hinglish'], ...length, rules: checkRules(source), content_format: SCRIPT_FORMAT }
    default:
      return { stage }
  }
}

export const HINGLISH_REFERENCES = ['english', 'scenes', 'hinglish', 'rules', 'rules_scenes'] as const

export function hinglishReference(name: string, progress: HinglishProgress, source: EnglishSource): Record<string, unknown> {
  const key = name.toLowerCase().replace(/[^a-z_]/g, '')
  if (key.startsWith('english') || key.startsWith('source')) {
    const paragraphs = englishParagraphs(source.script)
    return { name: 'english', note: 'Fictional source text.', paragraphs: paragraphs.length, story_script: paragraphs.map((p, i) => `[P${i + 1}] ${p}`).join('\n\n'), story_summary: source.summary }
  }
  if (key.startsWith('scene')) return progress.scenes ? { name: 'scenes', scenes: progress.scenes } : { status: 'error', reason: 'No scene notes have been accepted yet.' }
  if (key.startsWith('hinglish') || key === 'script' || key.startsWith('narration')) return progress.script ? { name: 'hinglish', hinglish: progress.script } : { status: 'error', reason: 'No Hinglish narration has been accepted yet.' }
  if (key === 'rules_scenes' || key === 'rulesscenes' || key === 'language') return { name: 'rules_scenes', rules: scenesRules(source) }
  if (key.startsWith('rule')) return { name: 'rules', ...hinglishStageData(progress, source) }
  return { status: 'error', reason: `No reference named "${name}". Available: ${HINGLISH_REFERENCES.join(', ')}.` }
}

/** Checks one submission; returns the progress with it accepted, or throws InvalidReply with the problems. */
export function acceptHinglish(stage: HinglishStage, raw: string, progress: HinglishProgress, source: EnglishSource): HinglishProgress {
  const expected = hinglishStage(progress)
  if (expected === 'done') throw new InvalidReply('Every stage of this job is already accepted.')
  if (stage !== expected) {
    throw new InvalidReply(HINGLISH_STAGES.indexOf(stage) < HINGLISH_STAGES.indexOf(expected)
      ? `The ${stage} stage is already accepted. The current stage is ${expected}.`
      : `The current stage is ${expected}; ${stage} comes later.`)
  }
  switch (stage) {
    case 'hi_scenes': return { ...progress, scenes: readScenes(raw, englishParagraphs(source.script).length) }
    case 'hi_script': return { ...progress, script: readHinglish(raw, source) }
    case 'hi_check': return { ...progress, final: readHinglish(raw, source) }
  }
}
