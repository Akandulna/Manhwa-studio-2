/**
 * AntiGravity → Narration, Hinglish: one chapter's Hinglish script, written from its saved English script once that
 * is in (Studio queues it right after an English script is saved, and Start process takes chapters that have an
 * English script but no Hinglish). Text only: no pages are read.
 *
 * One conversation, three stages, with the same rules and checks as the Gemini app's Hinglish (geminiMcp/hinglish.ts)
 * and Narration's copyable Hinglish prompts:
 *
 *   hi_scenes — scene notes: every English paragraph [P1]…[Pn] in exactly one scene, in order
 *   hi_script — the Hinglish narration in Devanagari, scene by scene, with [SCENE n: Px-Py] marks, and its summary
 *   hi_check  — the final spoken-narration check of that narration
 *
 * The accepted check is saved through Narration's script replacement (manual-output path: parseManualNarration runs
 * again, the English source must still match), which backs up the old Hinglish, resets the chapter's Hindi voiceover,
 * alignment and timeline, and sends the script to the phones.
 */

import {
  HINGLISH_REFERENCES, HINGLISH_STAGES, acceptHinglish, hinglishReference, hinglishStage, hinglishStageArg, hinglishStageData,
  type EnglishSource, type HinglishProgress, type HinglishStage
} from '../geminiMcp/hinglish.js'

export const FILENAME_HI = 'narration-hi'
export const STATE_SCHEMA_HI = 'studio-ag-narration-hi-state/1'
/** Same-conversation corrections allowed per stage before the chapter stops for the operator. */
export const MAX_SUBMISSIONS_HI = 4

/** What Studio supplies for a chapter's Hinglish (narrationStudio.ts; a stand-in in tests). */
export interface HinglishInput {
  /** Binds the job to these inputs: the English script and its summary. */
  revision: string
  seriesTitle: string
  chapterNumber: string
  source: EnglishSource
  /** sha256 of the English script, trimmed (what the save checks the source against). */
  sourceSha256: string
  /** The chapter's current Hinglish script (null: none yet). Saving refuses if it changed meanwhile. */
  scriptSha256: string | null
  /** The English the current Hinglish was written from, when its save recorded it. */
  madeFromSha256: string | null
}

export interface HinglishDeps {
  input(chapterId: string): Promise<HinglishInput | { reason: string; wait?: boolean }>
  /** Saves like Narration's Replace with the manual prompts' output (backup, reset, send to phones). Throws why it couldn't. */
  save(chapterId: string, text: string, expectedSha256: string | null, sourceSha256: string, model: string): Promise<{ phoneSent: boolean; phoneError?: string }>
}

/** A Hinglish job's resultJson: the checked reply and the English it was written from. */
export interface HinglishResult { text: string; sourceSha256: string }

export interface HinglishState {
  schema: typeof STATE_SCHEMA_HI
  revision: string
  progress: HinglishProgress
  /** The last problems a submission had (shown to the model when the stage continues). */
  issues: string[]
}

export const startHinglishState = (revision: string, carried?: HinglishProgress | null): HinglishState => ({
  schema: STATE_SCHEMA_HI, revision, issues: [],
  progress: { scenes: carried?.scenes ?? null, script: carried?.script ?? null, final: null, rejections: {} }
})

export function parseHinglishState(json: string | null | undefined): HinglishState | null {
  try {
    const v = JSON.parse(json ?? 'null') as HinglishState
    return v?.schema === STATE_SCHEMA_HI && typeof v.revision === 'string' && v.progress && typeof v.progress === 'object' ? v : null
  } catch { return null }
}
export const hinglishStateJson = (state: HinglishState) => JSON.stringify(state)

export const STAGE_LABELS: Record<HinglishStage, string> = { hi_scenes: 'scene notes', hi_script: 'Hinglish narration', hi_check: 'final Hinglish check' }

/** How much of [state] is accepted, for the run log. */
export function hinglishProgressText(state: HinglishState): string {
  const p = state.progress
  return [p.scenes && 'the scene notes', p.script && 'the narration', p.final && 'the final check'].filter(Boolean).join(', ') || 'nothing'
}

// ─── Tools ───

export const HINGLISH_TOOLS = [
  {
    name: 'get_job_context',
    description: 'Return the chapter, the current stage and the references it needs. Call this first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_reference',
    description: `Return one reference text by name: ${HINGLISH_REFERENCES.join(', ')}. "english" is the numbered English script [P1]…[Pn] and its summary.`,
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }
  },
  {
    name: 'submit_hinglish',
    description: 'Submit the current stage\'s result. stage: hi_scenes, hi_script or hi_check. text: the complete result in the stage\'s format.',
    inputSchema: { type: 'object', properties: { stage: { type: 'string' }, text: { type: 'string' } }, required: ['stage', 'text'], additionalProperties: false }
  }
]

// ─── Prompts ───

const NO_TOOLS_BUT_STUDIO = 'This job has no shell, code, browser or file access: any such call is refused and ends your turn without a result. Do not run Python or any command.'

/** The prompt that starts (or, without its conversation, re-explains) the current stage. */
export function hinglishStagePrompt(input: HinglishInput, state: HinglishState): string {
  const stage = hinglishStage(state.progress)
  if (stage === 'done') return 'Every stage of this job is accepted. Reply with one word: SUBMITTED.'
  const data = hinglishStageData(state.progress, input.source) as { references: string[]; rules: string; content_format: string; english_paragraphs: number; english_words: number; hinglish_words_min: number; hinglish_words_max: number }
  const number = HINGLISH_STAGES.indexOf(stage) + 1
  return `STUDIO NARRATION — "${input.seriesTitle}" Chapter ${input.chapterNumber} (a work of fiction), Hinglish.
${NO_TOOLS_BUT_STUDIO}
Everything comes through Studio's tools (get_job_context, get_reference and submit_hinglish). Only a submission Studio accepts counts; your final sentence does not.
Task: stage ${number} of 3 — ${STAGE_LABELS[stage]} (${stage}).
First call get_reference for each of: ${data.references.join(', ')}.
English source: ${data.english_paragraphs} paragraphs, ${data.english_words} words. Hinglish narration: ${data.hinglish_words_min}–${data.hinglish_words_max} words (scene marks and summary not counted).

WHAT THIS STAGE PRODUCES:
${data.rules}

FORMAT:
${data.content_format}

Call submit_hinglish with stage "${stage}" and text holding the complete result in exactly this format, nothing before or after it.
When submit_hinglish accepts, reply with one word: SUBMITTED.`
}

/** Same-conversation follow-up when a turn ended without the stage's accepted submission. */
export function hinglishContinuationPrompt(state: HinglishState, denied: string[]): string {
  const stage = hinglishStage(state.progress)
  return [
    denied.length ? `Your last action was refused (${denied.join(', ')}): this job has no shell, code or browser access.` : 'Your turn ended without an accepted submission.',
    state.issues.length ? `Fix these problems first:\n${state.issues.map(i => `- ${i}`).join('\n')}` : null,
    `Continue the same task and call submit_hinglish with stage "${stage}". When it accepts, reply with one word: SUBMITTED.`
  ].filter(Boolean).join('\n')
}

export function hinglishContextText(jobId: string, input: HinglishInput, state: HinglishState): string {
  const stage = hinglishStage(state.progress)
  const data = stage === 'done' ? null : hinglishStageData(state.progress, input.source) as { references: string[] }
  return [
    `Job ${jobId}. Task: Hinglish narration of "${input.seriesTitle}" Chapter ${input.chapterNumber}, written from its English script.`,
    stage === 'done' ? 'Every stage is accepted.' : `Stage: ${stage} (${STAGE_LABELS[stage]}). References it needs: ${data!.references.join(', ')}.`,
    `Accepted so far: ${hinglishProgressText(state)}.`
  ].join('\n')
}

/** get_reference: the Gemini app's references (english, scenes, hinglish, rules, rules_scenes). */
export const hinglishReferenceText = (name: string, input: HinglishInput, state: HinglishState) =>
  JSON.stringify(hinglishReference(name, state.progress, input.source))

/** The stage a submission names (models name stages their own way), else the current one. */
export const submittedStage = (args: Record<string, unknown>, expected: HinglishStage): HinglishStage => hinglishStageArg(args.stage) ?? expected

/** Checks one submission; the state with it accepted, or throws InvalidReply with the problems. */
export function acceptHinglishSubmission(state: HinglishState, stage: HinglishStage, text: string, input: HinglishInput): HinglishState {
  const progress = acceptHinglish(stage, text, state.progress, input.source)
  return { ...state, progress: { ...progress, rejections: { ...progress.rejections, [stage]: 0 } }, issues: [] }
}

export { hinglishStage, HINGLISH_STAGES, type HinglishStage }
