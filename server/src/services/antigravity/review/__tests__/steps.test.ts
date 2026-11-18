import sharp from 'sharp'
import { beforeAll, describe, expect, it } from 'vitest'
import type { PromptPack } from '../../prompts.js'
import { renderCrop, renderReviewSlice } from '../../stepImages.js'
import { summarizeImagesViewed, unopenedImages } from '../../toolUse.js'
import * as flow from '../../stepsFlow.js'
import { parseAnalysis } from '../analysisImport.js'
import { audit, lumaFromImage } from '../cropAudit.js'
import { auditInput, currentCrops, items, parseState } from '../reviewState.js'
import * as steps from '../steps.js'
import type { Handoff, LumaPage, ReviewState } from '../types.js'

const SHA = '0123456789abcdef'.repeat(4)
const JOB = 'solo_leveling-ch010-page_003-0123456789ab'
const NOW = '2026-11-08T10:00:00.000Z'

function handoff(): Handoff {
  return {
    jobId: JOB,
    wholePage: false,
    source: { seriesTitle: 'Solo Leveling', chapterFolder: 'Chapter 10', pageStem: 'page_003', sha256: SHA, width: 800, height: 5000 },
    slices: [
      { id: 's01', file: 'page_003_slice-01.webp', x0: 0, y0: 0, x1: 800, y1: 2048, width: 800, height: 2048 },
      { id: 's02', file: 'page_003_slice-02.webp', x0: 0, y0: 2048, x1: 800, y1: 4096, width: 800, height: 2048 },
      { id: 's03', file: 'page_003_slice-03.webp', x0: 0, y0: 4096, x1: 800, y1: 5000, width: 800, height: 904 },
    ],
  }
}

const pack = { texts: { crop_rules: 'CROP RULES\nKeep faces whole.', analysis: '', review: '' } } as unknown as PromptPack

let page: Buffer
let luma: LumaPage
beforeAll(async () => {
  // A white page with two inked panels: one in s01, one in s02.
  const panel = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#202020' } }).png().toBuffer()
  page = await sharp({ create: { width: 800, height: 5000, channels: 3, background: '#FFFFFF' } })
    .composite([
      { input: await panel(700, 1400), left: 50, top: 100 },
      { input: await panel(700, 1600), left: 50, top: 2200 },
    ])
    .png()
    .toBuffer()
  luma = await lumaFromImage(page)
})

const inventory = (shots: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ schema_version: steps.INVENTORY_SCHEMA, job_id: JOB, shots, page_has_no_artwork: false, ...extra })
const shot = (id: string, from: [string, string], to: [string, string]) => ({ shot_id: id, subjects: 'a fighter mid-swing', from: { slice_id: from[0], part: from[1] }, to: { slice_id: to[0], part: to[1] }, notes: '' })
const candidate = (id: string, shotIds: string[], tl: [string, number, number], br: [string, number, number]) => ({
  candidate_id: id, shot_ids: shotIds, reason: 'framed_action',
  top_left: { slice_id: tl[0], x: tl[1], y: tl[2] }, bottom_right: { slice_id: br[0], x: br[1], y: br[2] },
  visual_evidence: 'framed panel', review_flags: [],
})
const geometry = (candidates: unknown[], dropped: unknown[] = []) => JSON.stringify({ schema_version: steps.GEOMETRY_SCHEMA, job_id: JOB, coordinate_system: 'slice_local_pixels', candidates, dropped_shots: dropped })
const inspections = (list: [string, string | null][]) => JSON.stringify({ schema_version: steps.INSPECTION_SCHEMA, job_id: JOB, inspections: list.map(([id, p]) => ({ candidate_id: id, box_problem: p })) })

/** Applies a reply the way the bridge does, returning the stored JSON. */
function step(stored: { steps: string | null; review: string | null }, reply: string) {
  const v = flow.view(stored.steps, stored.review, handoff(), () => luma, NOW)
  const out = flow.submit(reply, v, handoff(), () => luma, NOW)
  if (out.ok) return { out, stored: { steps: out.stepsJson, review: out.reviewJson ?? stored.review } }
  return { out, stored: { steps: out.stepsJson ?? stored.steps, review: stored.review } }
}

/** A geometry-review reply keeping every crop as it is and acknowledging every check it was shown. */
function keepAll(review: ReviewState, moved: Record<string, [string, number, number, string, number, number]> = {}) {
  const report = audit(800, 5000, auditInput(review).crops, luma, auditInput(review).reasons)
  const crops = currentCrops(review, items(review, report.findings), handoff().slices)
  return JSON.stringify({
    schema_version: 'clipper-review-geometry/1.0', job_id: JOB, source_sha256: SHA, review_revision: review.revision, coordinate_system: 'slice_local_pixels',
    crops: crops.map(c => {
      const m = moved[c.key]
      return {
        key: c.key, reason: c.reason,
        top_left: m ? { slice_id: m[0], x: m[1], y: m[2] } : c.top_left,
        bottom_right: m ? { slice_id: m[3], x: m[4], y: m[5] } : c.bottom_right,
        checks_reviewed: c.checks.map(k => k.token),
      }
    }),
    removed_keys: [], redescribe_keys: [], sweep_done: true, page_has_no_artwork: false, notes: '',
  })
}

describe('flowFor', () => {
  it('puts Gemini 3.8 Flash on Antigravity through the four steps, nothing else', () => {
    expect(flow.flowFor('antigravity', 'gemini-3.8-flash-high')).toBe('steps')
    expect(flow.flowFor('antigravity', 'gemini-3.8-flash-low')).toBe('steps')
    expect(flow.flowFor('antigravity', 'gemini-3.8-flash')).toBe('steps')
    expect(flow.flowFor('antigravity', 'gemini-3.8-flashlight')).toBe('classic')
    expect(flow.flowFor('antigravity', 'gemini-4-argon-low')).toBe('classic')
    expect(flow.flowFor('antigravity', 'claude-sonnet-5-5-medium')).toBe('classic')
    expect(flow.flowFor('codex', 'gemini-3.8-flash-high')).toBe('classic')
    expect(flow.flowFor('antigravity', null)).toBe('classic')
  })

  it('gives each flow only its own submit tools', () => {
    const names = (f: flow.ClipperFlow) => flow.toolsFor(f).map(t => t.name)
    expect(names('steps')).toEqual(['get_job_context', 'fetch_slice', 'fetch_step_image', 'submit_step'])
    expect(names('classic')).toEqual(['get_job_context', 'fetch_slice', 'submit_analysis', 'submit_review'])
  })
})

describe('four-step prompts', () => {
  it('step 1 carries the crop rules, the slices to fetch and submit_step', () => {
    const v = flow.view(null, null, handoff(), () => luma, NOW)
    expect(v.plan).toMatchObject({ stage: 'inventory', part: 1 })
    const prompt = flow.stepPrompt(pack, v, handoff(), () => luma)
    expect(prompt.startsWith('CROP RULES — use these')).toBe(true)
    expect(prompt).toContain('Keep faces whole.')
    expect(prompt).toContain('STEP 1 OF 4 · FIND THE SHOTS')
    expect(prompt).toContain('  s02 = page_003_slice-02.webp — 800×2048 px, page y 2048–4096')
    expect(prompt).toContain('fetch_slice for every slice in order (s01, s02, s03)')
    expect(prompt).toContain('submit_step {"json"')
    expect(prompt).not.toContain('submit_analysis')
  })

  it('step 3 is the phone\'s geometry-only inspection prompt, without rules', () => {
    const text = steps.inspectionPrompt(handoff(), [['candidate-01', { x0: 50, y0: 100, x1: 750, y1: 1500 }]])
    // As on the phone: trimIndent keeps the template's indent, because the inserted continuity rules start at column 0.
    expect(text.split('\n')[0]).toBe('        STEP 3 OF 4: visually inspect these ACTUAL crop images, in the listed order. The grey ID label is app-added.')
    expect(text).toContain('Crops: candidate-01 (700x1400)')
    expect(text).toContain(`{"schema_version":"clipper-crop-inspection/1","job_id":"${JOB}","inspections":[{"candidate_id":"candidate-01","box_problem":null}]}`)
  })
})

describe('four-step flow end to end', () => {
  it('walks find → corners → inspect → review and finishes with nothing open', () => {
    let stored: { steps: string | null; review: string | null } = { steps: null, review: null }

    // Step 1: refused without a part, then accepted.
    let r = step(stored, inventory([{ ...shot('shot-01', ['s01', 'top'], ['s01', 'bottom']), from: { slice_id: 's01' } }]))
    expect(r.out.ok).toBe(false)
    expect(r.out.reply).toContain('STEP 1 OF 4 · CORRECTION')
    expect(r.out.reply).toContain('part must be "top", "middle" or "bottom"')
    r = step(stored, inventory([shot('shot-02', ['s02', 'top'], ['s02', 'bottom']), shot('shot-01', ['s01', 'top'], ['s01', 'bottom'])]))
    expect(r.out.ok).toBe(true)
    stored = r.stored
    let s = steps.parseSteps(stored.steps)!
    expect(s.stage).toBe('geometry')
    expect(s.shots.map(x => x.id)).toEqual(['shot-01', 'shot-02'])

    // Step 2: a shot must be accounted for.
    r = step(stored, geometry([candidate('candidate-01', ['shot-01'], ['s01', 50, 100], ['s01', 750, 1500])]))
    expect(r.out.ok).toBe(false)
    expect(r.out.reply).toContain('Not accounted for: shot-02')
    r = step(stored, geometry([
      candidate('candidate-02', ['shot-02'], ['s02', 50, 152], ['s02', 750, 1752]),
      candidate('candidate-01', ['shot-01'], ['s01', 50, 100], ['s01', 750, 1500]),
    ]))
    expect(r.out.ok).toBe(true)
    stored = r.stored
    s = steps.parseSteps(stored.steps)!
    expect(s.stage).toBe('describe')
    expect(s.queue).toEqual(['candidate-01', 'candidate-02'])
    expect(s.placed[1]!.bounds).toEqual({ x0: 50, y0: 2200, x1: 750, y1: 3800 })

    // Step 3: exactly the batch; then Studio assembles the analysis and seeds the review.
    r = step(stored, inspections([['candidate-01', null]]))
    expect(r.out.ok).toBe(false)
    expect(r.out.reply).toContain('Missing: candidate-02')
    r = step(stored, inspections([['candidate-01', null], ['candidate-02', 'clipped_subject']]))
    expect(r.out.ok).toBe(true)
    if (!r.out.ok) throw new Error('unreachable')
    expect(parseAnalysis(r.out.analysisJson!, handoff(), true).errors).toEqual([])
    stored = r.stored
    s = steps.parseSteps(stored.steps)!
    expect(s.stage).toBe('review')
    expect(s.reviewDue).toBe(true)
    let review = parseState(stored.review!)!
    expect(review.crops.map(c => [c.key, c.descriptionStatus, c.gptFlags])).toEqual([
      ['candidate-01', 'inspected', []],
      ['candidate-02', 'inspected', ['clipped_subject']],
    ])

    // Step 4: the next plan is a review round with the drawn-on slices to fetch.
    let v = flow.view(stored.steps, stored.review, handoff(), () => luma, NOW)
    expect(v.plan).toMatchObject({ stage: 'review', part: 4 })
    expect(flow.requiredImages(v.plan!, handoff())).toEqual({ kind: 'step', ids: ['review-s01', 'review-s02', 'review-s03'] })
    const prompt = flow.stepPrompt(pack, v, handoff(), () => luma)
    expect(prompt).toContain('STEP 4 OF 4 · REVIEW ROUND for "page_003"')
    expect(prompt).toContain('gpt:clipped_subject')

    // A round that moves candidate-02 sends it back to step 3, then to another review.
    r = step(stored, keepAll(review, { 'candidate-02': ['s02', 40, 140, 's02', 760, 1760] }))
    expect(r.out.ok).toBe(true)
    stored = r.stored
    s = steps.parseSteps(stored.steps)!
    expect(s).toMatchObject({ stage: 'describe', queue: ['candidate-02'], redescribe: true, reviewDue: true, reviewRounds: 1 })
    v = flow.view(stored.steps, stored.review, handoff(), () => luma, NOW)
    expect(v.plan).toMatchObject({ stage: 'describe', batch: ['candidate-02'] })
    r = step(stored, inspections([['candidate-02', null]]))
    expect(r.out.ok).toBe(true)
    stored = r.stored
    expect(steps.parseSteps(stored.steps)!.stage).toBe('review')
    review = parseState(stored.review!)!
    expect(review.crops.find(c => c.key === 'candidate-02')!.descriptionStatus).toBe('inspected')

    // A round that keeps everything and clears every check finishes the page.
    r = step(stored, keepAll(review))
    expect(r.out.ok).toBe(true)
    stored = r.stored
    v = flow.view(stored.steps, stored.review, handoff(), () => luma, NOW)
    expect(v.blockers).toEqual([])
    expect(v.plan).toBeNull()
    expect(parseState(stored.review!)!.crops.map(c => c.bounds)).toEqual([
      { x0: 50, y0: 100, x1: 750, y1: 1500 },
      { x0: 40, y0: 2188, x1: 760, y1: 3808 },
    ])
  })

  it('carries a sideways crop\'s rotate from step 2 into the assembled analysis and the review', () => {
    let stored: { steps: string | null; review: string | null } = { steps: null, review: null }
    stored = step(stored, inventory([shot('shot-01', ['s01', 'top'], ['s01', 'bottom']), shot('shot-02', ['s02', 'top'], ['s02', 'bottom'])])).stored
    expect(steps.geometryPrompt(steps.parseSteps(stored.steps)!, handoff())).toContain('- rotate: only on sideways art. SIDEWAYS ART:')
    const bad = step(stored, geometry([
      { ...candidate('candidate-01', ['shot-01'], ['s01', 50, 100], ['s01', 750, 1500]), rotate: 180 },
      candidate('candidate-02', ['shot-02'], ['s02', 50, 152], ['s02', 750, 1752]),
    ]))
    expect(bad.out.ok).toBe(false)
    expect(bad.out.reply).toContain('rotate must be 90, -90 or left out')
    let r = step(stored, geometry([
      { ...candidate('candidate-01', ['shot-01'], ['s01', 50, 100], ['s01', 750, 1500]), rotate: -90 },
      candidate('candidate-02', ['shot-02'], ['s02', 50, 152], ['s02', 750, 1752]),
    ]))
    expect(r.out.ok).toBe(true)
    stored = r.stored
    expect(steps.parseSteps(stored.steps)!.placed.map(p => p.rotate)).toEqual([-90, undefined])
    r = step(stored, inspections([['candidate-01', null], ['candidate-02', null]]))
    if (!r.out.ok) throw new Error(r.out.reply)
    expect(parseAnalysis(r.out.analysisJson!, handoff(), true).analysis!.candidates.map(c => c.rotate)).toEqual([-90, undefined])
    const review = parseState(r.stored.review!)!
    expect(review.crops.map(c => c.rotate)).toEqual([-90, undefined])
    const prompt = steps.reviewStepPrompt(review, [], audit(800, 5000, auditInput(review).crops, luma), handoff())
    expect(prompt).toContain('"rotate": -90')
    expect(prompt.trimEnd().endsWith('or "rotate": 0 when a listed crop is actually upright.')).toBe(true)
  })

  it('a page with no artwork goes straight from step 2 to review', () => {
    let r = step({ steps: null, review: null }, inventory([], { page_has_no_artwork: true }))
    expect(r.out.ok).toBe(true)
    r = step(r.stored, geometry([]))
    expect(r.out.ok).toBe(true)
    expect(steps.parseSteps(r.stored.steps)!.stage).toBe('review')
    expect(parseState(r.stored.review!)!.crops).toEqual([])
  })

  it('budgets: review rounds and messages', () => {
    const base = steps.start(handoff(), NOW)
    const review: steps.StepPlan = { stage: 'review', part: 4, batch: [], batchIndex: 0, batchCount: 0 }
    expect(steps.overBudget({ ...base, reviewRounds: 4 }, review)).toContain('4 review rounds')
    expect(steps.overBudget({ ...base, messages: 20 }, { ...review, stage: 'inventory', part: 1 })).toContain('20 messages')
    expect(steps.overBudget(base, review)).toBeNull()
    expect(steps.resetBudget({ ...base, messages: 20, reviewRounds: 4, accepted: 7 }, NOW)).toMatchObject({ messages: 0, reviewRounds: 0, accepted: 7 })
  })
})

describe('step images', () => {
  it('cuts a crop under a grey label band, and draws boxes on a slice at its size', async () => {
    const crop = await renderCrop(page, 'candidate-01', { x0: 50, y0: 100, x1: 750, y1: 1500 })
    expect([crop.width, crop.height]).toEqual([700, 1444])
    const meta = await sharp(crop.data).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 700, 1444])
    const slice = handoff().slices[1]!
    const drawn = await renderReviewSlice(page, slice, [['candidate-01', { x0: 50, y0: 100, x1: 750, y1: 1500 }], ['candidate-02', { x0: 50, y0: 2200, x1: 750, y1: 3800 }]])
    const m2 = await sharp(drawn.data).metadata()
    expect([m2.width, m2.height]).toEqual([800, 2048])
    // candidate-02, the second box, is stroked in cyan along its left edge.
    const { data, info } = await sharp(drawn.data).raw().toBuffer({ resolveWithObject: true })
    const at = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3))
    const [r, g, b] = at(51, 1000)
    expect(r).toBeLessThan(80)
    expect(g).toBeGreaterThan(180)
    expect(b).toBeGreaterThan(180)
  })
})

describe('geometry only, and answered from the page', () => {
  it('no step asks for descriptions or story; the review lists crops without a description field', () => {
    let stored: { steps: string | null; review: string | null } = { steps: null, review: null }
    const prompts: string[] = []
    const ask = () => { const v = flow.view(stored.steps, stored.review, handoff(), () => luma, NOW); prompts.push(flow.stepPrompt(pack, v, handoff(), () => luma)) }
    ask()
    stored = step(stored, inventory([shot('shot-01', ['s01', 'top'], ['s01', 'bottom'])])).stored
    ask()
    stored = step(stored, geometry([candidate('candidate-01', ['shot-01'], ['s01', 50, 100], ['s01', 750, 1500])])).stored
    ask()
    stored = step(stored, inspections([['candidate-01', null]])).stored
    ask()
    for (const p of prompts) {
      expect(p).not.toMatch(/"description"|redescribe_keys|description rules/i)
      expect(p).not.toMatch(/write (?:a|one|each) description|describe (?:each|the) crop/i)
    }
    for (const i of [0, 1, 3]) expect(prompts[i]).toContain('GEOMETRY ONLY: write no descriptions, story context, character names or script links. Metadata is made later by a separate process')
    expect(prompts[2]).toContain('Do not write descriptions, story context or script links.')
    expect(parseState(stored.review!)!.crops.every(c => c.description === '')).toBe(true)
  })

  it('refuses the prompt\'s example copied back as an answer', () => {
    let r = step({ steps: null, review: null }, inventory([{ ...shot('shot-01', ['s01', 'top'], ['s01', 'middle']), subjects: 'man on rooftop, wide' }]))
    expect(r.out.ok).toBe(false)
    expect(r.out.reply).toContain('That is the example from the prompt, not this page.')
    r = step({ steps: null, review: null }, inventory([shot('shot-01', ['s01', 'top'], ['s01', 'middle'])]))
    const copied = step(r.stored, geometry([candidate('candidate-01', ['shot-01'], ['s01', 35, 110], ['s01', 800, 810])]))
    expect(copied.out.ok).toBe(false)
    expect(copied.out.reply).toContain('That is the example from the prompt, not this page.')
    const evidence = step(r.stored, geometry([{ ...candidate('candidate-01', ['shot-01'], ['s01', 50, 100], ['s01', 750, 1500]), visual_evidence: 'Distinct framed shot with one main reaction' }]))
    expect(evidence.out.ok).toBe(false)
  })

  it('reads from the agy transcript which offloaded images the model opened', () => {
    const conv = '/home/u/.gemini/antigravity-cli/brain/c1/.system_generated/steps'
    const result = (n: number, first: string) => JSON.stringify({ step_index: n, type: 'GENERIC', content: `Created At: x\nCompleted At: y\n${first}\nIf this result shows "[Resource offloaded to file://…]" instead of a picture, call read_file.\n[Resource offloaded to file://${conv}/${n}/media_0.webp]` })
    const read = (n: number) => JSON.stringify({ step_index: n + 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: { Path: `"${conv}/${n}/media_0.webp"` } }] })
    const lines = [
      result(4, 's01: 720×2000 px, original page y=0..2000 (page 720×4000).'), read(4),
      result(6, 's02: 720×2000 px, original page y=2000..4000 (page 720×4000).'),
      result(8, '1/2 · candidate-01: crop 700×1400 px, page y 100–1500 (grey ID band added by Studio).'),
      result(10, 'review-s01: s01 (720×2000 px, original page y=0..2000) with every current crop drawn on it.'), read(10),
    ]
    const viewed = summarizeImagesViewed(lines)
    expect([...viewed.fetched.keys()]).toEqual(['s01', 's02', 'candidate-01', 'review-s01'])
    expect(unopenedImages(viewed, ['s01', 's02', 's03', 'candidate-01', 'review-s01'])).toEqual([
      { id: 's02', file: `${conv}/6/media_0.webp` },
      { id: 'candidate-01', file: `${conv}/8/media_0.webp` },
    ])
  })
})
