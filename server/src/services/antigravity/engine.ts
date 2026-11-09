/**
 * Adapter between AntiGravity jobs and the Sleeper-Cell review port
 * (./review, verified byte-for-byte against the phone's Kotlin).
 *
 * Mirrors the phone's geometry-only "Classic" path (ClipperPage.kt):
 *   analysis = withRules(GeometryWorkflow.prompt(h), Crop Rules, null)
 *   accept   = AnalysisImport (geometryOnly) → CropReview.seed
 *   review   = geometryReviewPrompt(state, items(audit(original page)), fresh=false, annotatedImages=false), no rules
 *   apply    = CropReview.applyReply(geometryOnly=true); refused → correctionPrompt(errors)
 *   done     = no blockers(geometryOnly=true, requireInspection=false)
 * Studio only adds a short delivery note: images come from MCP tools and the
 * JSON goes back through submit_analysis / submit_review.
 */

import fs from 'node:fs/promises'
import type { PromptPack } from './prompts.js'
import { parseAnalysis } from './review/analysisImport.js'
import { audit, lumaFromImage } from './review/cropAudit.js'
import { correctionPrompt, renderAnalysisPrompt, renderReviewPrompt } from './review/prompts.js'
import { applyReply, auditInput, blockers as reviewBlockers, items as reviewItems, parseState, seed, toJson } from './review/reviewState.js'
import type { Handoff, LumaPage, ReviewState } from './review/types.js'

export type EngineHandoff = Handoff

export const TOOL_DEFINITIONS = [
  {
    name: 'get_job_context',
    description: 'Return the assigned page (identity, size) and its ordered slice list with original-page offsets. Call this first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'fetch_slice',
    description: 'Return one slice image of the assigned page by slice_id (s01, s02, …), with its size and original-page offset. Inspect every slice.',
    inputSchema: { type: 'object', properties: { slice_id: { type: 'string' } }, required: ['slice_id'], additionalProperties: false }
  },
  {
    name: 'submit_analysis',
    description: 'Submit the crop-pointer JSON object for this page (as a string). Studio validates it and reports any problem to fix.',
    inputSchema: { type: 'object', properties: { json: { type: 'string', description: 'The complete JSON object, as text.' } }, required: ['json'], additionalProperties: false }
  },
  {
    name: 'submit_review',
    description: 'Submit the review JSON object for the current review round (as a string). Studio validates it and reports any problem to fix.',
    inputSchema: { type: 'object', properties: { json: { type: 'string', description: 'The complete JSON object, as text.' } }, required: ['json'], additionalProperties: false }
  }
]

/** Studio's handoff (preparation.buildHandoff) → the phone's Handoff shape. */
export function toEngineHandoff(raw: any): EngineHandoff {
  const s = raw?.source ?? {}
  return {
    jobId: String(raw.jobId),
    wholePage: false,
    source: {
      sha256: String(s.sha256),
      pageStem: String(s.pageStem),
      width: Number(s.width),
      height: Number(s.height),
      seriesTitle: String(s.seriesTitle ?? ''),
      chapterFolder: String(s.chapterFolder ?? ''),
      chapterNumber: s.chapterNumber !== undefined ? String(s.chapterNumber) : undefined,
      originalFilename: s.filename,
      format: s.format
    },
    slices: (raw?.slicing?.slices ?? []).map((x: any) => ({
      id: String(x.id), file: String(x.file), width: Number(x.width), height: Number(x.height),
      y0: Number(x.y0), y1: Number(x.y1), x0: Number(x.x0 ?? 0), x1: Number(x.x1 ?? x.width), sha256: x.sha256
    }))
  }
}

export function analysisPrompt(pack: PromptPack, handoff: EngineHandoff): string {
  return renderAnalysisPrompt({ template: pack.texts.analysis, cropRules: pack.texts.crop_rules, handoff })
}

const sliceList = (h: EngineHandoff) => h.slices.map(s => s.id).join(', ')

/** agy's print mode ends the whole turn on any refused action, so say it up front. */
export const NO_SHELL = 'This job has no shell, code, browser or other file access: any such call is refused and ends your turn without a result. The one exception is read_file on the image files Studio\'s tools hand you: when a tool result shows "[Resource offloaded to file://…]", call read_file on that exact path, because that is the only way to see the image. Do not run Python or any command. Sizes and offsets are in get_job_context; measure every edge by looking at the images.'

/** Added to every Studio image result: agy offloads MCP images to a file the model must open itself. */
export const OPEN_IMAGE_HINT = 'If this result shows "[Resource offloaded to file://…]" instead of a picture, call read_file on that exact path now to see the image; it is allowed. Never answer from the text alone.'

/**
 * Same-conversation follow-up when a turn ended without an accepted submission
 * (typically a refused command). Not a new analysis: the model keeps the slices
 * it already fetched.
 */
export function continuationPrompt(stage: 'analysis' | 'review', denied: string[]): string {
  const tool = stage === 'analysis' ? 'submit_analysis' : 'submit_review'
  return [
    denied.length
      ? `Your last turn ended because Studio refused: ${denied.join(', ')}. That is not available in this job and nothing was submitted.`
      : `Your last turn ended without an accepted ${tool} call, so nothing was submitted.`,
    NO_SHELL,
    `Continue the same task from where you stopped, using the slice images already in this conversation (call fetch_slice again only to re-check one). Send the complete JSON object through ${tool} {"json": "<the JSON object>"}. Once the tool accepts it, reply with one word: SUBMITTED.`
  ].join('\n')
}

export function withAnalysisDelivery(prompt: string, h: EngineHandoff): string {
  return [
    prompt,
    '',
    'STUDIO DELIVERY — this only replaces how the slices arrive and how the JSON is returned; every rule above still applies:',
    `- The slices are not attached to this message. Call the studio MCP tool get_job_context, then fetch_slice for every slice in order (${sliceList(h)}) and inspect each image before measuring.`,
    `- ${NO_SHELL}`,
    '- Send the JSON object as text through submit_analysis {"json": "<the JSON object>"} instead of replying with it. If the tool lists problems, fix them and call submit_analysis again.',
    '- Once the tool accepts it, reply with one word: SUBMITTED.'
  ].join('\n')
}

export function withReviewDelivery(prompt: string, h: EngineHandoff): string {
  return [
    prompt,
    '',
    'STUDIO DELIVERY — the rules above still apply:',
    `- The slices are the ones you fetched earlier in this conversation (${sliceList(h)}); call fetch_slice again if you need to re-check one.`,
    `- ${NO_SHELL}`,
    '- Send the JSON object as text through submit_review {"json": "<the JSON object>"} instead of replying with it. If the tool lists problems, fix them and call submit_review again.',
    '- Once the tool accepts it, reply with one word: SUBMITTED.'
  ].join('\n')
}

export async function lumaFor(sourcePath: string): Promise<LumaPage> {
  return lumaFromImage(await fs.readFile(sourcePath))
}

function state(json: string): ReviewState {
  const parsed = parseState(json)
  if (!parsed) throw new Error('Stored review state is unreadable.')
  return parsed
}

/** Audit the current crops on the original page and derive the review items. */
function reviewContext(current: ReviewState, h: EngineHandoff, luma: LumaPage) {
  const input = auditInput(current)
  const report = audit(h.source.width, h.source.height, input.crops, luma, input.reasons)
  return { report, items: reviewItems(current, report.findings) }
}

export function reviewPrompt(pack: PromptPack, stateJson: string, h: EngineHandoff, luma: LumaPage): string {
  const current = state(stateJson)
  const { report, items } = reviewContext(current, h, luma)
  return renderReviewPrompt({ template: pack.texts.review, state: current, items, audit: report, handoff: h })
}

export function blockers(stateJson: string, h: EngineHandoff, luma: LumaPage): string[] {
  const current = state(stateJson)
  const { items } = reviewContext(current, h, luma)
  return reviewBlockers(current, items, true, false).map(b => (b.key ? `${b.key}: ${b.message}` : b.message))
}

export function finalCrops(stateJson: string) {
  return state(stateJson).crops.map(c => ({ reason: c.reason, bounds: { x0: c.bounds.x0, y0: c.bounds.y0, x1: c.bounds.x1, y1: c.bounds.y1 } }))
}

export function jobContextText(h: EngineHandoff, stage: string): string {
  return [
    `Page "${h.source.pageStem}" (${h.source.originalFilename ?? h.source.pageStem}) from ${h.source.seriesTitle}, ${h.source.chapterFolder}.`,
    `Original page: ${h.source.width}×${h.source.height} px, SHA-256 ${h.source.sha256}. Job ${h.jobId}.`,
    `Current stage: ${stage}.`,
    'Slices (full width, top to bottom, no overlap; a seam is never a shot boundary):',
    ...h.slices.map(s => `  ${s.id}: ${s.width}×${s.height} px, original page y=${s.y0}..${s.y1}`),
    'Fetch each one with fetch_slice.'
  ].join('\n')
}

export function acceptAnalysis(text: string, h: EngineHandoff):
  | { ok: true; analysisJson: string; stateJson: string; count: number }
  | { ok: false; correction: string } {
  const result = parseAnalysis(text, h, true)
  if (!result.analysis || result.errors.length) return { ok: false, correction: correctionPrompt(result.errors.length ? result.errors : [{ code: 'GPT_JSON_INVALID', field: '', message: 'The analysis could not be read.', candidateId: null }]) }
  const seeded = seed(result.analysis, new Date().toISOString())
  return { ok: true, analysisJson: text, stateJson: toJson(seeded), count: result.analysis.candidates.length }
}

export function acceptReview(text: string, stateJson: string, h: EngineHandoff, luma: LumaPage):
  | { ok: true; stateJson: string; count: number; revision: number; blockers: string[] }
  | { ok: false; correction: string } {
  const current = state(stateJson)
  const { items } = reviewContext(current, h, luma)
  const applied = applyReply(text, current, items, h, new Date().toISOString(), true)
  if (!applied.state || applied.errors.length) return { ok: false, correction: correctionPrompt(applied.errors.length ? applied.errors : [{ code: 'GPT_JSON_INVALID', field: '', message: 'The review could not be read.', candidateId: null }]) }
  const nextJson = toJson(applied.state)
  return { ok: true, stateJson: nextJson, count: applied.state.crops.length, revision: applied.state.revision, blockers: blockers(nextJson, h, luma) }
}
