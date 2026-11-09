/**
 * Adapter between AntiGravity jobs and the four-step port (./review/steps.ts), the way engine.ts is for the
 * one-prompt ("Classic") flow. Mirrors the phone's geometry-only STEPS path (ClipperPage.nextStep/pasteStep):
 *
 *   step 1 = withRules(inventoryPrompt, Crop Rules)            → applyInventory
 *   step 2 = withRules(geometryPrompt, Crop Rules)             → applyGeometry
 *   step 3 = inspectionPrompt(batch of 8 crop images), no rules → inspections; after the last batch Studio
 *            assembles chatgpt-analysis/1.0 → AnalysisImport (geometryOnly) → CropReview.seed (all "inspected")
 *   step 4 = withRules(reviewStepPrompt + annotated slices, Crop Rules) → applyReply(geometryOnly); crops it
 *            adds or moves go back to step 3, then another review
 *   done   = stage review, nothing due, no blockers(geometryOnly = true, requireInspection = true)
 *
 * Studio adds a short delivery note: images come from MCP tools (fetch_slice, fetch_step_image) and every
 * step's JSON goes back through submit_step.
 */

import type { PromptPack } from './prompts.js'
import { TOOL_DEFINITIONS, NO_SHELL, type EngineHandoff } from './engine.js'
import { parseAnalysis } from './review/analysisImport.js'
import { audit } from './review/cropAudit.js'
import { withRules } from './review/prompts.js'
import { applyReply, auditInput, blockers as reviewBlockers, items as reviewItems, parseState, seed, toJson as reviewToJson } from './review/reviewState.js'
import * as steps from './review/steps.js'
import type { StepPlan, StepsState } from './review/steps.js'
import type { Box, LumaPage, ReviewState } from './review/types.js'
import { renderCrop, renderReviewSlice, reviewImageId, type StepImage } from './stepImages.js'

export type ClipperFlow = 'classic' | 'steps'

/** Gemini 3.8 Flash (any effort tier) on the Antigravity engine is put through the four-step flow. */
export function flowFor(engine: string, model: string | null | undefined): ClipperFlow {
  return engine === 'antigravity' && typeof model === 'string' && /^gemini-3\.8-flash(?:$|-)/.test(model) ? 'steps' : 'classic'
}

export const FLOW_LABELS: Record<ClipperFlow, string> = { classic: 'one prompt', steps: '4 steps' }

const byName = (name: string) => TOOL_DEFINITIONS.find(t => t.name === name)!

export const STEPS_TOOL_DEFINITIONS = [
  byName('get_job_context'),
  byName('fetch_slice'),
  {
    name: 'fetch_step_image',
    description: 'Return one image Studio made for the current step by image_id: a crop cut from the page (step 3, ids such as candidate-01) or a slice with every crop drawn on it (step 4, ids review-<slice_id>, e.g. review-s01). The step prompt lists the ids.',
    inputSchema: { type: 'object', properties: { image_id: { type: 'string' } }, required: ['image_id'], additionalProperties: false }
  },
  {
    name: 'submit_step',
    description: 'Submit the JSON object answering the current step (as a string). Studio validates it and reports any problem to fix.',
    inputSchema: { type: 'object', properties: { json: { type: 'string', description: 'The complete JSON object, as text.' } }, required: ['json'], additionalProperties: false }
  }
]

export const toolsFor = (flow: ClipperFlow) => (flow === 'steps' ? STEPS_TOOL_DEFINITIONS : TOOL_DEFINITIONS)

function reviewOf(json: string | null | undefined): ReviewState | null {
  return json ? parseState(json) : null
}

function reviewContext(review: ReviewState, h: EngineHandoff, luma: LumaPage) {
  const input = auditInput(review)
  const report = audit(h.source.width, h.source.height, input.crops, luma, input.reasons)
  return { report, items: reviewItems(review, report.findings) }
}

/** What still blocks delivery on the four-step flow (crops must also have been inspected). */
export function blockers(review: ReviewState, h: EngineHandoff, luma: LumaPage): string[] {
  const { items } = reviewContext(review, h, luma)
  return reviewBlockers(review, items, true, true).map(b => (b.key ? `${b.key}: ${b.message}` : b.message))
}

export interface StepView {
  state: StepsState
  review: ReviewState | null
  plan: StepPlan | null
  blockers: string[]
}

/** Where the page is and what to ask next. [luma] is needed once a review state exists. */
export function view(stepsJson: string | null, reviewJson: string | null, h: EngineHandoff, luma: () => LumaPage, now: string): StepView {
  const state = steps.parseSteps(stepsJson) ?? steps.start(h, now)
  const review = reviewOf(reviewJson)
  const open = review && state.stage === 'review' ? blockers(review, h, luma()) : []
  return { state, review, plan: steps.plan(state, open.length > 0), blockers: open }
}

/** The step 3 batch with its boxes: step 2's rectangles, or the review's current crops once redescribing. */
function batchBoxes(plan: StepPlan, state: StepsState, review: ReviewState | null): [string, Box][] {
  const boxes = new Map<string, Box>(state.redescribe
    ? (review?.crops ?? []).map(c => [c.key, c.bounds] as [string, Box])
    : state.placed.map(p => [p.id, p.bounds] as [string, Box]))
  return plan.batch.map(id => {
    const b = boxes.get(id)
    if (!b) throw new Error(`${id} is no longer one of the page's crops`)
    return [id, b]
  })
}

/** The images the model must fetch for this step before submit_step is accepted (slices for step 1). */
export function requiredImages(plan: StepPlan, h: EngineHandoff): { kind: 'slice' | 'step'; ids: string[] } {
  if (plan.stage === 'inventory') return { kind: 'slice', ids: h.slices.map(s => s.id) }
  if (plan.stage === 'describe') return { kind: 'step', ids: plan.batch }
  if (plan.stage === 'review') return { kind: 'step', ids: h.slices.map(s => reviewImageId(s.id)) }
  return { kind: 'step', ids: [] }
}

/** One step image by id, for the current plan; null when [id] isn't one of this step's images. */
export async function stepImage(id: string, v: StepView, h: EngineHandoff, source: Buffer): Promise<{ image: StepImage; caption: string } | null> {
  const plan = v.plan
  if (!plan) return null
  if (plan.stage === 'describe') {
    const crops = batchBoxes(plan, v.state, v.review)
    const index = crops.findIndex(([key]) => key === id)
    if (index < 0) return null
    const [, b] = crops[index]!
    const image = await renderCrop(source, id, b)
    return { image, caption: `${index + 1}/${crops.length} · ${id}: crop ${b.x1 - b.x0}×${b.y1 - b.y0} px, page y ${b.y0}–${b.y1} (grey ID band added by Studio).` }
  }
  if (plan.stage === 'review' && v.review) {
    const slice = h.slices.find(s => reviewImageId(s.id) === id)
    if (!slice) return null
    const image = await renderReviewSlice(source, slice, v.review.crops.map(c => [c.key, c.bounds] as [string, Box]))
    return { image, caption: `${id}: ${slice.id} (${slice.width}×${slice.height} px, original page y=${slice.y0}..${slice.y1}) with every current crop drawn on it.` }
  }
  return null
}

const sliceList = (h: EngineHandoff) => h.slices.map(s => s.id).join(', ')

const SUBMIT = [
  '- Send the JSON object as text through submit_step {"json": "<the JSON object>"} instead of replying with it. If the tool lists problems, fix them and call submit_step again.',
  '- Once the tool accepts it, reply with one word: SUBMITTED.'
]

/** The message for [plan], with the crop rules ahead of steps 1, 2 and 4 (as the phone sends them). */
export function stepPrompt(pack: PromptPack, v: StepView, h: EngineHandoff, luma: () => LumaPage): string {
  const plan = v.plan
  if (!plan) throw new Error('Nothing to ask: the page is finished.')
  const rules = pack.texts.crop_rules
  const note = (lines: string[]) => ['', 'STUDIO DELIVERY — this only replaces how the images arrive and how the JSON is returned; every rule above still applies:', ...lines, `- ${NO_SHELL}`, ...SUBMIT].join('\n')
  switch (plan.stage) {
    case 'inventory':
      return withRules(steps.inventoryPrompt(h), rules, null) + note([
        `- The slices are not attached to this message. Call the studio MCP tool get_job_context, then fetch_slice for every slice in order (${sliceList(h)}) and inspect each image.`
      ])
    case 'geometry':
      return withRules(steps.geometryPrompt(v.state, h), rules, null) + note([
        `- The slices are the ones you fetched earlier in this conversation (${sliceList(h)}); call fetch_slice again to re-check one before measuring.`
      ])
    case 'describe': {
      const crops = batchBoxes(plan, v.state, v.review)
      return steps.inspectionPrompt(h, crops) + note([
        `- The crop images are not attached to this message. Call fetch_step_image for each, in this order: ${crops.map(([id]) => id).join(', ')}.`
      ])
    }
    case 'review': {
      const review = v.review
      if (!review) throw new Error('Step 3 has not finished: there are no crops to review yet.')
      const { report, items } = reviewContext(review, h, luma())
      return withRules(steps.reviewStepPrompt(review, items, report, h), rules, null) + note([
        `- The drawn-on slices are not attached to this message. Call fetch_step_image for each, in order: ${h.slices.map(s => reviewImageId(s.id)).join(', ')}.`,
        `- The clean slices are the ones you fetched earlier in this conversation (${sliceList(h)}); call fetch_slice again to re-check an edge.`
      ])
    }
  }
}

/** Same-conversation follow-up when a turn ended without an accepted submit_step. */
export function continuationPrompt(plan: StepPlan, denied: string[]): string {
  return [
    denied.length
      ? `Your last turn ended because Studio refused: ${denied.join(', ')}. That is not available in this job and nothing was submitted.`
      : 'Your last turn ended without an accepted submit_step call, so nothing was submitted.',
    NO_SHELL,
    `Continue ${steps.label(plan)} from where you stopped, using the images already in this conversation (fetch them again only to re-check one). Send the complete JSON object through submit_step {"json": "<the JSON object>"}. Once the tool accepts it, reply with one word: SUBMITTED.`
  ].join('\n')
}

export type SubmitOutcome =
  | { ok: true; stepsJson: string; reviewJson?: string; analysisJson?: string; reply: string; event: string }
  /** Refused. [stepsJson] is set when the page still moved (step 3's assembled corners didn't import: back to step 2). */
  | { ok: false; reply: string; stepsJson?: string }

/** Validates a submit_step reply against the step the page is at and moves the page on. */
export function submit(raw: string, v: StepView, h: EngineHandoff, luma: () => LumaPage, now: string): SubmitOutcome {
  const plan = v.plan
  if (!plan) return { ok: false, reply: 'This page has nothing left to submit.' }
  const state = v.state
  const accepted = (next: StepsState, event: string, extra: { reviewJson?: string; analysisJson?: string } = {}): SubmitOutcome => ({
    ok: true,
    stepsJson: steps.toJson({ ...next, updatedAt: now }),
    ...extra,
    reply: `Step ${plan.part} accepted. Studio will send the next instructions. Reply with one word: SUBMITTED.`,
    event
  })

  /** Step 3 is through its queue: import the built answer the way the one-prompt flow imports its own. */
  const assembled = (next: StepsState, event: string): SubmitOutcome => {
    const text = steps.assemble(next, h)
    const parsed = parseAnalysis(text, h, true)
    if (!parsed.analysis || parsed.errors.length) {
      // The corners didn't import: back to step 2 to correct them.
      return {
        ok: false,
        stepsJson: steps.toJson({ ...next, stage: 'geometry', updatedAt: now }),
        reply: steps.stepCorrection(2, parsed.errors) + '\nStudio will ask step 2 again in its next message.'
      }
    }
    const seeded = seed(parsed.analysis, now)
    const review = { ...seeded, crops: seeded.crops.map(c => ({ ...c, descriptionStatus: 'inspected' })) }
    return accepted(
      { ...next, stage: 'review', queue: [], queueTotal: 0, reviewDue: true },
      `${event}; ${review.crops.length} crops assembled for review`,
      { reviewJson: reviewToJson(review), analysisJson: text }
    )
  }

  switch (plan.stage) {
    case 'inventory': {
      const parsed = steps.applyInventory(raw, state, h, now)
      if (!parsed.value) return { ok: false, reply: steps.stepCorrection(1, parsed.errors) }
      const n = parsed.value.shots.length
      return accepted(parsed.value, `step 1 accepted (${n} shot${n === 1 ? '' : 's'}${parsed.value.noArtwork ? ', no artwork' : ''})`)
    }
    case 'geometry': {
      const parsed = steps.applyGeometry(raw, state, h, now)
      if (!parsed.value) return { ok: false, reply: steps.stepCorrection(2, parsed.errors) }
      const n = parsed.value.placed.length
      const event = `step 2 accepted (${n} crop${n === 1 ? '' : 's'}${parsed.value.dropped.length ? `, ${parsed.value.dropped.length} shot(s) dropped` : ''})`
      return parsed.value.queue.length === 0 ? assembled(parsed.value, event) : accepted(parsed.value, event)
    }
    case 'describe': {
      const batch = plan.batch
      const parsed = steps.parseInspections(raw, h, batch)
      if (!parsed.value) return { ok: false, reply: steps.stepCorrection(3, parsed.errors) }
      const inspected = parsed.value
      const flagged = Object.values(inspected).filter(Boolean).length
      const event = `step 3 accepted (${steps.label(plan)}: ${batch.length} inspected${flagged ? `, ${flagged} flagged` : ''})`
      const left = state.queue.slice(batch.length)
      const counted = { ...state, accepted: state.accepted + 1 }
      if (!state.redescribe) {
        const next = { ...counted, inspected: { ...state.inspected, ...inspected }, queue: left }
        return left.length === 0 ? assembled(next, event) : accepted(next, event)
      }
      const review = v.review
      if (!review) return { ok: false, reply: 'The page has no review to inspect crops for.' }
      const updated: ReviewState = {
        ...review,
        updatedAt: now,
        crops: review.crops.map(crop => {
          if (!(crop.key in inspected)) return crop
          const problem = inspected[crop.key]
          return { ...crop, description: '', descriptionStatus: 'inspected', gptFlags: [...new Set([...crop.gptFlags, ...(problem ? [problem] : [])])] }
        })
      }
      return accepted({ ...counted, queue: left, stage: left.length === 0 ? 'review' : 'describe' }, event, { reviewJson: reviewToJson(updated) })
    }
    case 'review': {
      const review = v.review
      if (!review) return { ok: false, reply: 'Step 3 has not finished: there are no crops to review yet.' }
      const { items } = reviewContext(review, h, luma())
      const applied = applyReply(raw, review, items, h, now, true)
      if (!applied.state || applied.errors.length) return { ok: false, reply: steps.stepCorrection(4, applied.errors.length ? applied.errors : [{ code: 'GPT_JSON_INVALID', field: '', message: 'The review could not be read.', candidateId: null }]) }
      const next = applied.state
      const queue = next.crops.filter(c => c.descriptionStatus !== 'inspected').map(c => c.key)
      return accepted({
        ...state,
        stage: queue.length === 0 ? 'review' : 'describe',
        queue,
        queueTotal: queue.length,
        redescribe: true,
        reviewDue: applied.changed,
        reviewRounds: state.reviewRounds + 1,
        accepted: state.accepted + 1
      }, `step 4 review round accepted (${next.crops.length} crops, revision ${next.revision}${applied.changed ? ', crops changed' : ''}${queue.length ? `, ${queue.length} to inspect` : ''})`, { reviewJson: reviewToJson(next) })
    }
    default:
      return { ok: false, reply: 'Unknown step.' }
  }
}
