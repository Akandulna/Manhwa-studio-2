/**
 * AntiGravity → Timeline: one chapter's Editor 2.0 timeline JSON in one language, in one conversation.
 * Text only (narration with timestamps + crop metadata; no images, no Drive). Two methods, chosen per run:
 *
 *   oneshot  — the Editor 2.0 prompt from Settings with the chapter's Copy All text (what the phone's
 *              full-package run pastes into ChatGPT); the whole timeline comes back through submit_timeline
 *              and is checked like the phone's TimelineCheck.kt (+ its story-link rule) and Editor's own
 *              processor before it is accepted.
 *   batches  — Studio's small batches (services/editorWorkflow.ts: index → route → select → review → repair),
 *              answered one after another through get_task / submit_task. Progress is the same checkpoint
 *              the Staged timeline dialog in Editor 2.0 uses, so a stopped chapter continues where it was.
 *
 * The finished timeline is saved like a paste in Editor 2.0 (unprocessed: Start Processing there), and Editor's
 * auto-publish sends it to the phones so they don't make it again.
 */

import type { NarrationLanguage } from '../narrationLanguage.js'

export const MANIFEST_SCHEMA = 'studio-ag-editor/1'
export const STATE_SCHEMA = 'studio-ag-editor-state/1'
export type EditorMethod = 'oneshot' | 'batches'
export const METHOD_LABELS: Record<EditorMethod, string> = { oneshot: 'One-shot', batches: 'Small batches' }
const LANGUAGE_LABELS: Record<NarrationLanguage, string> = { en: 'English', hi: 'Hindi' }
export const LANGUAGES: readonly NarrationLanguage[] = ['en', 'hi']

/** Batches answered in one turn before Studio starts the next turn (keeps each turn short and resumable). */
export const TASKS_PER_TURN = 15
/** Turns one small-batches attempt may take before it stops for the operator (Continue goes on). */
export const MAX_BATCH_TURNS = 40
/** agy and codex take the prompt as one argument; macOS allows about 1 MB for all of them. */
export const MAX_PROMPT_BYTES = 700_000
const MAX_LISTED = 25
const GAP_SEC = 2.0
const OVERRUN_SEC = 0.5

export interface EditorRunOptions { method: EditorMethod; languages: NarrationLanguage[] }

/** What a run asked for (pinned in its promptJson); old or missing values fall back to small batches in both languages. */
export function normalizeOptions(value: unknown): EditorRunOptions {
  const v = (value && typeof value === 'object' ? value : {}) as { method?: unknown; languages?: unknown }
  const method: EditorMethod = v.method === 'oneshot' ? 'oneshot' : 'batches'
  const languages = Array.isArray(v.languages) ? LANGUAGES.filter(l => (v.languages as unknown[]).includes(l)) : [...LANGUAGES]
  return { method, languages: languages.length ? languages : [...LANGUAGES] }
}

export function optionsOf(promptJson: string): EditorRunOptions {
  try { return normalizeOptions(JSON.parse(promptJson)?.editor) } catch { return normalizeOptions(null) }
}

/** A timeline job's "page": one per chapter and language. */
export const timelineFilename = (language: NarrationLanguage) => `timeline-${language}`
export function languageOfFilename(filename: string): NarrationLanguage | null {
  const m = /^timeline-(en|hi)$/.exec(filename)
  return m ? (m[1] as NarrationLanguage) : null
}
export const languageIndex = (language: NarrationLanguage) => LANGUAGES.indexOf(language)
export const languageLabel = (language: NarrationLanguage) => LANGUAGE_LABELS[language]

export interface EditorManifest { schema: typeof MANIFEST_SCHEMA; method: EditorMethod; language: NarrationLanguage; revision: string }

export function parseManifest(json: string | null | undefined): EditorManifest | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as EditorManifest
    if (v?.schema !== MANIFEST_SCHEMA || (v.method !== 'oneshot' && v.method !== 'batches') || (v.language !== 'en' && v.language !== 'hi') || typeof v.revision !== 'string') return null
    return v
  } catch { return null }
}

/** One attempt's progress: the accepted one-shot timeline (or its last problems), and the batches of this turn. */
export interface EditorState {
  schema: typeof STATE_SCHEMA
  revision: string
  json: string | null
  issues: string[]
  tasksThisTurn: number
  accepted: number
}

export const startState = (manifest: EditorManifest): EditorState => ({ schema: STATE_SCHEMA, revision: manifest.revision, json: null, issues: [], tasksThisTurn: 0, accepted: 0 })

export function parseState(json: string | null | undefined, manifest: EditorManifest): EditorState {
  if (!json) return startState(manifest)
  try {
    const v = JSON.parse(json) as EditorState
    if (v?.schema !== STATE_SCHEMA || v.revision !== manifest.revision) return startState(manifest)
    return { ...startState(manifest), ...v }
  } catch { return startState(manifest) }
}
export const stateJson = (state: EditorState) => JSON.stringify(state)

// ─── What Studio supplies (wired in routes/antigravity.ts; fakes in tests) ───

export interface OneShotInput {
  /** Binds the job to these exact inputs: the Editor package's sha + the Editor 2.0 prompt. */
  revision: string
  prompt: string
  timeline: string
  metadata: string
  sections: { number: number; durationSec: number | null }[]
  images: string[]
  /** The package keeps story links made for the previous English script (finalCropAuthority.retainedStoryLinks). */
  retainedStoryLinks: boolean
}

export interface BatchTask { id: string; stage: string; label: string; prompt: string; fingerprint: string }
export interface BatchView {
  task: BatchTask | null
  completed: number
  json: string | null
  error: string | null
  /** Changes whenever a reply is accepted. */
  revision: string
  /** The workflow's inputs (narration, metadata, crop files, audio sections). */
  sourceHash: string
  warnings: string[]
  counts: { beats: number; crops: number; visualGroups: number }
}

export interface EditorDeps {
  /** The chapter's saved timeline JSON in this language, or null when it has none. */
  savedTimeline(chapterId: string, language: NarrationLanguage): Promise<string | null>
  /** What Editor 2.0's checklist still misses, apart from the timeline (voiceover, alignment, crops…). */
  blockers(chapterId: string, language: NarrationLanguage): Promise<string[]>
  oneShot(chapterId: string, language: NarrationLanguage): Promise<OneShotInput | { reason: string }>
  /** The small-batches session: read the current batch, or accept a reply (throws a WorkflowReplyError to fix). */
  batches(chapterId: string, language: NarrationLanguage, reply?: { taskId: string; fingerprint: string; reply: string }): Promise<BatchView>
  /** Editor 2.0's own processor (read-only): image refs it cannot resolve, and its warnings. */
  process(chapterId: string, json: string, language: NarrationLanguage): Promise<{ missingRefs: string[]; warnings: string[] }>
  /** Saves the timeline like a paste in Editor 2.0 (unprocessed) and queues it for the phones. */
  save(chapterId: string, language: NarrationLanguage, json: string, model: string): Promise<void>
  /** A Timeline job was created or changed stage: the phones' "taken by Studio" markers need rebuilding. */
  claimsChanged?(): void
}

// ─── Tools ───

const CONTEXT_TOOL = {
  name: 'get_job_context',
  description: 'Return the assigned chapter, its language, its voice sections with their audio lengths and what this job is. Call this first.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }
}

export const ONESHOT_TOOLS = [
  CONTEXT_TOOL,
  {
    name: 'submit_timeline',
    description: 'Submit the complete timeline JSON object for the chapter (as a string). Studio checks it and lists any problem to fix.',
    inputSchema: { type: 'object', properties: { json: { type: 'string', description: 'The complete timeline JSON object, as text.' } }, required: ['json'], additionalProperties: false }
  }
]

export const BATCH_TOOLS = [
  CONTEXT_TOOL,
  {
    name: 'get_task',
    description: 'Return the current small batch: its task_id and its full instructions with the data to answer.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'submit_task',
    description: 'Submit the one JSON object the current batch asks for (as a string). Studio answers with the next batch, problems to fix, or when to stop.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, json: { type: 'string', description: 'The JSON object, as text.' } }, required: ['task_id', 'json'], additionalProperties: false }
  }
]

export const toolsFor = (flow: string) => (flow === 'editor-oneshot' ? ONESHOT_TOOLS : BATCH_TOOLS)

/** This job has no pictures: everything is text from Studio's tools and the message. */
export const TEXT_ONLY = 'This job is text only: there are no images or files to open. It has no shell, code, browser or file access: any such call is refused and ends your turn without a result. Do not run Python or any command. Everything you need is in this message and Studio\'s tools.'

/** Phone StoryMetadata.INSTRUCTIONS / HINGLISH_INSTRUCTIONS (what the phone adds to Copy All). */
const STORY_INSTRUCTIONS = 'Use the verified script-to-crop links in the metadata. Match each timed English narration passage to the numbered English script paragraphs first, then select crops linked to that same story moment. Return scriptRefs on every timeline slot. Every selected crop must share at least one of those paragraph IDs. A context crop may support thoughts or transitions within its linked scene. Do not use unmatched crops or infer identities from visual resemblance. Never add unrelated paragraph IDs merely to justify an image. Preserve the original audio timestamps and use the actual narration, rather than a script summary, to decide the story moment.'
const RETAINED_LINKS = ' The metadata and paragraph IDs are retained from the previous English script. Match the CURRENT timed narration by meaning to that original visual reference index; do not copy the old script into the narration or alter the current timestamps. Leave unsupported matches for review.'
export const HINGLISH_INSTRUCTIONS = 'The Script with Timeline is Hinglish narration with its own audio alignment. Reconcile this Hinglish script directly with the English crop metadata to select crop filenames. Follow the Hinglish narration\'s own flow, scene grouping and timestamps. Keep the crop metadata in English. Use crop descriptions, visual evidence and scene context to find suitable visuals. Do not map narration to English script paragraphs or impose their order, paragraph breaks or pacing. Any scriptSegments, scriptRefs and matchType in the metadata describe English-source links only; they are not requirements or crop eligibility restrictions for this Hinglish timeline. A crop marked unmatched against the English source may be selected when its visual description supports the Hinglish narration. Do not invent visual evidence. Return timeline and selectedImages for every slot; scriptRefs are not required. Preserve continuous coverage of the Hinglish audio.'

export interface ChapterInfo { series: string; number: number; title: string | null }
const chapterName = (c: ChapterInfo) => `${c.series}, Chapter ${c.number}${c.title ? ` (${c.title})` : ''}`

const clock = (seconds: number) => {
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${(seconds - minutes * 60).toFixed(2).padStart(5, '0')}`
}
const sectionLines = (sections: { number: number; durationSec: number | null }[]) =>
  sections.map(s => `  Section ${s.number}: ${s.durationSec != null ? `audio 00:00.00–${clock(s.durationSec)}` : 'audio length unknown'}`)

// ─── One-shot ───

/** The phone's EditorPackage.copyAllText: prompt, script with timeline, crop metadata, matching requirements. */
export function copyAllText(input: OneShotInput, language: NarrationLanguage): string {
  const matching = language === 'hi' ? HINGLISH_INSTRUCTIONS
    : storyIndex(input.metadata) ? STORY_INSTRUCTIONS + (input.retainedStoryLinks ? RETAINED_LINKS : '') : ''
  return [
    ['# Prompt', input.prompt.trim()], ['# Script with Timeline', input.timeline], ['# Crop Metadata', input.metadata],
    ['# Script-to-crop matching requirements', matching]
  ].filter(([, body]) => body).map(([heading, body]) => `${heading}\n\n${body}`).join('\n\n')
}

export function oneShotPrompt(input: OneShotInput, chapter: ChapterInfo, language: NarrationLanguage): string {
  return [
    copyAllText(input, language),
    '',
    'STUDIO DELIVERY — everything above still applies:',
    `- This is ${chapterName(chapter)}, ${languageLabel(language)} narration, with ${input.sections.length} voice section${input.sections.length === 1 ? '' : 's'}:`,
    ...sectionLines(input.sections),
    '- Cover each section from 00:00.00 to the end of its audio without gaps, keep the timestamps of the Script with Timeline, and use only exportedFilename values from the Crop Metadata in selectedImages.',
    `- ${TEXT_ONLY}`,
    '- Send the complete timeline JSON object as text through submit_timeline {"json": "<the JSON object>"} instead of replying with it. If the tool lists problems, fix every one and call submit_timeline again with the whole corrected JSON.',
    '- Once the tool accepts it, reply with one word: SUBMITTED.'
  ].join('\n')
}

/** Same conversation: the turn ended without an accepted timeline (or Continue after problems). */
export function oneShotContinuation(denied: string[], issues: string[], language: NarrationLanguage): string {
  return [
    denied.length
      ? `Your last turn ended because Studio refused: ${denied.join(', ')}. That is not available in this job and nothing was accepted.`
      : 'Your last turn ended without an accepted submit_timeline call, so no timeline was saved.',
    TEXT_ONLY,
    ...(issues.length ? [fixText(issues, language)] : ['Send the complete timeline JSON object for this chapter through submit_timeline {"json": "<the JSON object>"}.']),
    'Once the tool accepts it, reply with one word: SUBMITTED.'
  ].join('\n')
}

export function oneShotContextText(jobId: string, chapter: ChapterInfo, manifest: EditorManifest, input: OneShotInput | { reason: string }): string {
  if ('reason' in input) return `Job ${jobId}: ${chapterName(chapter)} cannot be worked on now: ${input.reason}`
  return [
    `Job ${jobId}. Task: Editor 2.0 timeline (${METHOD_LABELS.oneshot}) for ${chapterName(chapter)}, ${languageLabel(manifest.language)} narration.`,
    `Voice sections (cover each from 00:00.00 to the end of its audio):`,
    ...sectionLines(input.sections),
    `Crop files (${input.images.length}): use only exportedFilename values from the Crop Metadata in the instructions.`,
    'Submit the whole timeline through submit_timeline.'
  ].join('\n')
}

/** Phone TimelineCheck.fixPrompt, for submit_timeline. */
export function fixText(issues: string[], language: NarrationLanguage): string {
  return [
    'Studio could not accept this timeline. It has these problems:',
    ...issues.map(i => `- ${i}`),
    '',
    `Fix every one of them and call submit_timeline again with the whole corrected JSON, in the same format. Use only the exportedFilename values from the crop metadata for selectedImages, and cover each section's audio from 00:00.00 to its last timestamp without gaps.${language === 'hi' ? ` ${HINGLISH_INSTRUCTIONS}` : ' When crop metadata includes story links, return valid scriptRefs on each slot and choose only supported crops sharing those references.'}`
  ].join('\n')
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/** JSON objects in a Markdown document (crop metadata is per-page JSON under headings). */
function objects(text: string): unknown[] {
  const out: unknown[] = []
  let start = -1, depth = 0, quoted = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (start < 0) { if (c === '{') { start = i; depth = 1 } continue }
    if (quoted) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try { out.push(JSON.parse(text.slice(start, i + 1))) } catch { /* not a document */ }
      start = -1
    }
  }
  return out
}

/** Page documents inside a parsed root (StoryMetadata.pages). */
function pages(root: unknown): Json[] {
  if (!isObject(root)) return Array.isArray(root) ? root.flatMap(pages) : []
  if ('storyLinking' in root || 'crops' in root || 'exportedFilename' in root) return [root]
  return Object.values(root).flatMap(pages)
}

export interface StoryIndex { segments: Set<string>; crops: Map<string, { refs: string[]; type: string }> }

/** English story links in the crop metadata (StoryMetadata.parse, without its freshness checks — the package builder does those), or null. */
export function storyIndex(metadata: string): StoryIndex | null {
  const linked = objects(metadata).flatMap(pages).filter(p => isObject(p.storyLinking))
  if (!linked.length) return null
  const segments = new Set<string>()
  const crops = new Map<string, { refs: string[]; type: string }>()
  for (const page of linked) {
    const header = page.storyLinking as Json
    for (const s of Array.isArray(header.scriptSegments) ? header.scriptSegments : []) if (isObject(s) && typeof s.id === 'string') segments.add(s.id)
    for (const c of Array.isArray(page.crops) ? page.crops : []) {
      if (!isObject(c) || typeof c.exportedFilename !== 'string') continue
      crops.set(c.exportedFilename, { refs: Array.isArray(c.scriptRefs) ? c.scriptRefs.filter((r): r is string => typeof r === 'string') : [], type: typeof c.matchType === 'string' ? c.matchType : 'unmatched' })
    }
  }
  return { segments, crops }
}

/** "MM:SS.ss" (or "HH:MM:SS.ss") in seconds, as Editor's parseTimestamp reads it. */
function timestamp(raw: string): number | null {
  const text = raw.trim()
  if (!/^\d{1,2}:\d{1,2}(:\d{1,2})?(\.\d+)?$/.test(text)) return null
  const parts = text.split(':').map(Number)
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
}
function range(raw: string): [number, number] | null {
  const halves = raw.split(/\s*[-–]\s*/)
  if (halves.length !== 2) return null
  const a = timestamp(halves[0]), b = timestamp(halves[1])
  return a === null || b === null ? null : [a, b]
}
/** Editor's normalizeOutputName: no folder, no extension, lower case, spaces and hyphens as underscores. */
const normalizeName = (name: string) => name.trim().replace(/^.*\//, '').replace(/\.[^/.]+$/, '').toLowerCase().replace(/[\s-]+/g, '_')
const PAGE = /(page[_-]?\d+)/i

/** Whether [ref] names one of the chapter's crops: an exported file name, or a "<page>/<crop id>" pair (only its page is checked). */
function resolves(ref: string, known: Set<string>, pagesSeen: Set<string>): boolean {
  const trimmed = ref.trim().replace(/^\.?\/?crops3\//i, '').trim()
  if (known.has(normalizeName(trimmed))) return true
  const slash = trimmed.lastIndexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return false
  const head = trimmed.slice(0, slash), tail = trimmed.slice(slash + 1)
  if (known.has(normalizeName(tail))) return true
  if (/\.(png|jpe?g|webp)$/i.test(tail) && !/\.(png|jpe?g|webp)$/i.test(head)) return false
  const page = PAGE.exec(head)?.[1]?.toLowerCase().replace('-', '_')
  return !!page && pagesSeen.has(page)
}

/** A reply wrapped in ``` fences still counts. */
function stripFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed)
  return fenced ? fenced[1].trim() : trimmed
}

/**
 * Phone TimelineCheck.check: one "sections" entry per voice section ("Section 3" is the third), each with
 * "timelines" of "MM:SS.ss - MM:SS.ss" ranges and their selectedImages, covering the audio without gaps, every
 * image one of the chapter's crops; in English with story links, every slot's scriptRefs support its crops.
 * `json` is the normalized timeline when it parses, null otherwise.
 */
export function checkOneShot(raw: string, input: Pick<OneShotInput, 'sections' | 'images' | 'metadata'>, language: NarrationLanguage): { json: string | null; issues: string[] } {
  let root: unknown
  try { root = JSON.parse(stripFence(raw)) } catch (e) { return { json: null, issues: [`The reply isn't one valid JSON object (${(e as Error).message.slice(0, 120)}).`] } }
  if (!isObject(root)) return { json: null, issues: ['The reply isn\'t one JSON object.'] }
  const sections = root.sections
  if (!Array.isArray(sections) || sections.length === 0) return { json: null, issues: ['The JSON needs a non-empty "sections" array.'] }
  const issues: string[] = []
  const known = new Set(input.images.map(normalizeName))
  const pagesSeen = new Set(input.images.map(i => PAGE.exec(i)?.[1]?.toLowerCase().replace('-', '_')).filter((p): p is string => !!p))
  const durations = new Map(input.sections.map(s => [s.number, s.durationSec]))
  const story = language === 'en' ? storyIndex(input.metadata) : null
  const seen = new Set<number>()
  sections.forEach((section, s) => {
    if (!isObject(section)) { issues.push(`sections[${s}] isn't an object.`); return }
    const label = typeof section.section === 'string' && section.section.trim() ? section.section.trim() : `Section ${s + 1}`
    const n = Number(/\d+/.exec(label)?.[0] ?? NaN)
    const number = Number.isInteger(n) && n >= 1 ? n : s + 1
    if (seen.has(number)) issues.push(`${label} appears more than once.`)
    seen.add(number)
    if (durations.size && !durations.has(number)) { issues.push(`${label} isn't one of this chapter's ${durations.size} sections.`); return }
    const slots = section.timelines
    if (!Array.isArray(slots) || slots.length === 0) { issues.push(`${label} has no timelines.`); return }
    const duration = durations.get(number) ?? null
    const ranges: [number, number][] = []
    slots.forEach((slot, t) => {
      if (!isObject(slot)) { issues.push(`${label}: timelines[${t}] isn't an object.`); return }
      const text = typeof slot.timeline === 'string' ? slot.timeline : ''
      const r = range(text)
      if (!r) { issues.push(`${label}: can't read the time range "${text}" (use "MM:SS.ss - MM:SS.ss").`); return }
      if (r[1] <= r[0]) { issues.push(`${label} ${text} ends before it starts.`); return }
      if (duration != null && r[1] > duration + OVERRUN_SEC) issues.push(`${label} ${text} runs past the section's audio, which ends at ${clock(duration)}.`)
      const refs = (Array.isArray(slot.selectedImages) ? slot.selectedImages : []).filter((x): x is string => typeof x === 'string' && !!x.trim())
      if (!refs.length) { issues.push(`${label} ${text} has no selectedImages.`); return }
      if (known.size) for (const ref of refs) if (!resolves(ref, known, pagesSeen)) issues.push(`${label} ${text}: "${ref}" isn't one of the crop files in the metadata.`)
      if (story) {
        const ids = Array.isArray(slot.scriptRefs) ? slot.scriptRefs.map(String) : []
        if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !story.segments.has(id))) issues.push(`${label}: ${text}: Use non-empty scriptRefs containing only known English script paragraph IDs.`)
        for (const name of refs) {
          const crop = story.crops.get(name)
          if (!crop || crop.type === 'unmatched' || !crop.refs.some(r => ids.includes(r))) issues.push(`${label}: ${name} is not supported by this slot's scriptRefs; select a linked crop from the same story moment.`)
        }
      }
      ranges.push(r)
    })
    if (!ranges.length) return
    ranges.sort((a, b) => a[0] - b[0])
    if (ranges[0][0] > GAP_SEC) issues.push(`${label} shows nothing from 00:00.00 to ${clock(ranges[0][0])}.`)
    let end = ranges[0][1]
    for (const [start, stop] of ranges.slice(1)) {
      if (start - end > GAP_SEC) issues.push(`${label} shows nothing from ${clock(end)} to ${clock(start)}.`)
      end = Math.max(end, stop)
    }
    if (duration != null && duration - end > GAP_SEC) issues.push(`${label} ends at ${clock(end)} but its audio runs to ${clock(duration)}.`)
  })
  for (const number of [...durations.keys()].sort((a, b) => a - b)) if (!seen.has(number)) issues.push(`Section ${number} is missing.`)
  const listed = issues.length > MAX_LISTED ? [...issues.slice(0, MAX_LISTED), `…and ${issues.length - MAX_LISTED} more like these.`] : issues
  return { json: JSON.stringify(root, null, 2), issues: listed }
}

// ─── Small batches ───

export function batchesContextText(jobId: string, chapter: ChapterInfo, manifest: EditorManifest, view: BatchView | { error: string }): string {
  if (!('counts' in view)) return `Job ${jobId}: ${chapterName(chapter)} cannot be worked on now: ${view.error}`
  return [
    `Job ${jobId}. Task: Editor 2.0 timeline (${METHOD_LABELS.batches}) for ${chapterName(chapter)}, ${languageLabel(manifest.language)} narration.`,
    `${view.counts.beats} narration beats, ${view.counts.crops} crops in ${view.counts.visualGroups} visual groups; ${view.completed} batches accepted so far.`,
    view.task ? `Current batch: ${view.task.id} (${view.task.stage}). Call get_task for its instructions.` : 'Every batch is done.'
  ].join('\n')
}

export const taskText = (view: BatchView) => view.task
  ? `task_id: ${view.task.id}\nBatch ${view.completed + 1} (${view.task.stage}). Answer with exactly the JSON object these instructions ask for, through submit_task {"task_id": "${view.task.id}", "json": "<the JSON object>"}:\n\n${view.task.prompt}`
  : 'Every batch is done. Reply with one word: SUBMITTED.'

export function batchesPrompt(chapter: ChapterInfo, manifest: EditorManifest, view: BatchView): string {
  return [
    'STUDIO TIMELINE · SMALL BATCHES',
    `Make the Editor 2.0 timeline for ${chapterName(chapter)} (${languageLabel(manifest.language)} narration) by answering Studio's small batches one after another, in this conversation.`,
    `The chapter has ${view.counts.beats} narration beats and ${view.counts.crops} crops in ${view.counts.visualGroups} visual groups; ${view.completed} batches are already accepted.`,
    'How:',
    '1. Call get_task. It returns one batch: its task_id and its full instructions with the data.',
    '2. Follow that batch\'s instructions exactly and send the one JSON object they ask for through submit_task {"task_id": "<task_id>", "json": "<the JSON object>"}.',
    '3. submit_task answers with the next batch (answer it the same way), with problems to fix (fix them and submit the same batch again), or tells you to stop.',
    'Judge every batch only from its own instructions and data: earlier batches are not evidence for later ones. Never invent IDs, change timestamps or return filenames.',
    TEXT_ONLY,
    'When submit_task says to stop (every batch done, or enough for this turn), reply with one word: SUBMITTED.'
  ].join('\n')
}

/** A later turn of the same conversation: go on from the current batch. */
export function batchesNextTurn(view: BatchView, denied: string[] = []): string {
  return [
    denied.length ? `Your last turn ended because Studio refused: ${denied.join(', ')}. That is not available in this job.` : `Continue with the next batches (${view.completed} accepted so far).`,
    TEXT_ONLY,
    'Call get_task, answer each batch exactly as its instructions say through submit_task, and go on until submit_task tells you to stop. Then reply with one word: SUBMITTED.'
  ].join('\n')
}

export function batchFixText(message: string, taskId: string): string {
  return `Studio could not accept this answer: ${message}\nFix it and call submit_task again for batch ${taskId} with one corrected JSON object covering every required ID. No commentary.`
}
