/**
 * Tests for the ChatGPT review round:
 * - the prompt carries the revision, every crop in slice-local corners and its check tokens
 * - slice-local corner conversion round-trips page pixels
 * - keep / adjust / split / merge / remove / add, and every key must be accounted for
 * - stale revision, wrong page, unknown keys are refused
 * - applied end to end: the review becomes ready and the page exports, with the
 *   export report saying ChatGPT gave the approvals
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import { applyChatGptReview, cornersFor, getReviewPrompt, REVIEW_REPLY_SCHEMA } from '../chatgptReview.js'
import { buildHandoff, type HandoffManifest } from '../handoff.js'
import { importAnalysis } from '../analysisImport.js'
import { getReview, startReview } from '../reviewState.js'
import { exportPage } from '../exportPage.js'

const SERIES = 'Bad Business'
const CHAPTER = 'Chapter 006'
const folderPath = `${SERIES}/${CHAPTER}`
const FILE = 'page_008.png'
const DESC = 'A figure stands in a framed shot against a softly shaded and detailed background panel here.'
let root: string
let previousRoot: string | undefined
let manifest: HandoffManifest

beforeEach(async () => {
  previousRoot = process.env.DOWNLOAD_ROOT
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crop-studio-gptreview-'))
  process.env.DOWNLOAD_ROOT = root
})

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = previousRoot
  await fs.rm(root, { recursive: true, force: true })
})

/** An 800×5000 page (slices 0–2048, 2048–4096, 4096–5000) with three imported candidates and a started review. */
async function reviewedPage() {
  const target = path.join(root, SERIES, CHAPTER, FILE)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await sharp({ create: { width: 800, height: 5000, channels: 3, background: '#ffffff' } }).png().toFile(target)
  manifest = (await buildHandoff({ folderPath, imageFilename: FILE, seriesTitle: SERIES, seriesSlug: 'bad_business', chapterNumber: 6 })).manifest
  const c = (id: string, bounds: object, flags: string[] = []) => ({ candidate_id: id, reason: 'framed_reaction', bounds, description: DESC, visual_evidence: 'x', review_flags: flags })
  const outcome = await importAnalysis(folderPath, FILE, JSON.stringify({
    schema_version: 'chatgpt-analysis/1.0', job_id: manifest.job_id, source_sha256: manifest.source.sha256,
    page_stem: 'page_008', source_width: 800, source_height: 5000, coordinate_system: 'canonical_original_pixels',
    page_inspection_complete: true, page_review_flags: [],
    candidates: [
      c('a', { x0: 0, y0: 100, x1: 800, y1: 900 }, ['boundary_uncertain']),
      c('b', { x0: 0, y0: 1900, x1: 800, y1: 2600 }, ['seam_crossing']),
      c('c', { x0: 0, y0: 3000, x1: 800, y1: 3600 })
    ]
  }))
  expect(outcome.imported).toBe(true)
  return startReview(folderPath, FILE, 'import', false)
}

/** A reply that keeps every crop as-is and reviews every listed check. */
async function keepAllReply(overrides: Record<string, unknown> = {}) {
  const view = await getReview(folderPath, FILE)
  return {
    schema_version: REVIEW_REPLY_SCHEMA,
    job_id: manifest.job_id,
    source_sha256: manifest.source.sha256,
    review_revision: view.state!.review_revision,
    coordinate_system: 'slice_local_pixels',
    crops: view.state!.crops.map(crop => ({
      key: crop.key,
      reason: crop.reason,
      ...cornersFor(crop.bounds, manifest.slices),
      description: DESC,
      checks_reviewed: view.items.filter(i => i.key === crop.key).map(i => i.token)
    })),
    removed_keys: [],
    sweep_done: true,
    page_has_no_artwork: false,
    ...overrides
  }
}

describe('cornersFor', () => {
  it('expresses page pixels in the slice each corner falls in, bottom edges closing their slice', async () => {
    await reviewedPage()
    expect(cornersFor({ x0: 0, y0: 1900, x1: 800, y1: 2600 }, manifest.slices)).toEqual({
      top_left: { slice_id: 'slice-01', x: 0, y: 1900 },
      bottom_right: { slice_id: 'slice-02', x: 800, y: 552 }
    })
    expect(cornersFor({ x0: 0, y0: 2048, x1: 800, y1: 4096 }, manifest.slices)).toEqual({
      top_left: { slice_id: 'slice-02', x: 0, y: 0 },
      bottom_right: { slice_id: 'slice-02', x: 800, y: 2048 }
    })
  })
})

describe('getReviewPrompt', () => {
  it('lists the revision, every crop and its check tokens', async () => {
    await reviewedPage()
    const { prompt, review_revision } = await getReviewPrompt(folderPath, FILE)
    expect(review_revision).toBe(1)
    expect(prompt).toContain(`${manifest.job_id} / ${manifest.source.sha256} / 1`)
    for (const key of ['"a"', '"b"', '"c"']) expect(prompt).toContain(`"key": ${key}`)
    expect(prompt).toContain('gpt:seam_crossing')
    expect(prompt).toContain('slice-03 y 904') // the uncovered stretch after the last crop
  })
})

describe('applyChatGptReview', () => {
  it('keeping everything with every check reviewed makes the review ready, and export notes ChatGPT', async () => {
    await reviewedPage()
    const outcome = await applyChatGptReview(folderPath, FILE, JSON.stringify(await keepAllReply()))
    expect(outcome.errors).toEqual([])
    expect(outcome.summary).toMatchObject({ kept: 3, adjusted: 0 })
    expect(outcome.view?.readiness).toEqual({ ready: true, blockers: [] })
    expect(outcome.view?.state?.chatgpt_reviews).toHaveLength(1)

    const report = await exportPage({ folderPath, imageFilename: FILE, seriesSlug: 'bad_business', chapterNumber: 6 })
    expect(report.status).toBe('completed')
    expect(report.notes.join(' ')).toMatch(/1 review round\(s\) were done by ChatGPT/)
  })

  it('adjusts, splits, merges, removes and adds in one reply', async () => {
    await reviewedPage()
    const reply = await keepAllReply()
    const [a, b, c] = reply.crops as any[]
    reply.crops = [
      { ...a, bottom_right: { slice_id: 'slice-01', x: 800, y: 950 } },                              // adjusted
      { key: null, from_keys: ['b'], reason: 'top_half', top_left: b.top_left, bottom_right: { slice_id: 'slice-02', x: 800, y: 100 }, description: DESC, checks_reviewed: [] },
      { key: null, from_keys: ['b'], reason: 'bottom_half', top_left: { slice_id: 'slice-02', x: 0, y: 100 }, bottom_right: b.bottom_right, description: DESC, checks_reviewed: [] },
      { key: null, reason: 'missed_insert', top_left: { slice_id: 'slice-03', x: 100, y: 200 }, bottom_right: { slice_id: 'slice-03', x: 500, y: 600 }, description: DESC, checks_reviewed: [] }
    ]
    reply.removed_keys = ['c'] as any
    void c
    const outcome = await applyChatGptReview(folderPath, FILE, JSON.stringify(reply))
    expect(outcome.errors).toEqual([])
    expect(outcome.summary).toEqual({ kept: 0, adjusted: 1, split: 2, merged: 0, added: 1, removed: 1 })
    const crops = outcome.view!.state!.crops
    expect(crops.map(x => [x.key, x.disposition, x.bounds.y0, x.bounds.y1])).toEqual([
      ['a', 'adjusted', 100, 950],
      ['b.a', 'split', 1900, 2148],
      ['b.b', 'split', 2148, 2600],
      ['op-01', 'adjusted', 4296, 4696]
    ])
    // The moved box's checks were for its old geometry: the next round has to look again.
    expect(crops[0].acknowledged).toEqual([])
    expect(outcome.view!.readiness.ready).toBe(false)
  })

  it('merges two crops into one key', async () => {
    await reviewedPage()
    const reply = await keepAllReply()
    const [a, b, c] = reply.crops as any[]
    reply.crops = [{ ...a, from_keys: ['b'], bottom_right: b.bottom_right }, c]
    const outcome = await applyChatGptReview(folderPath, FILE, JSON.stringify(reply))
    expect(outcome.errors).toEqual([])
    expect(outcome.view!.state!.crops.map(x => [x.key, x.disposition])).toEqual([['a', 'merged'], ['c', 'kept']])
  })

  it('refuses a reply that silently drops a crop', async () => {
    await reviewedPage()
    const reply = await keepAllReply()
    reply.crops = (reply.crops as any[]).slice(0, 2)
    const outcome = await applyChatGptReview(folderPath, FILE, JSON.stringify(reply))
    expect(outcome.applied).toBe(false)
    expect(outcome.errors[0].message).toMatch(/Not accounted for: c/)
  })

  it('refuses a stale revision, another page, and unknown keys', async () => {
    await reviewedPage()
    expect((await applyChatGptReview(folderPath, FILE, JSON.stringify(await keepAllReply({ review_revision: 7 })))).errors[0].message).toMatch(/copy the review prompt again/)
    expect((await applyChatGptReview(folderPath, FILE, JSON.stringify(await keepAllReply({ job_id: 'other' })))).errors[0].field).toBe('job_id')
    const reply = await keepAllReply()
    ;(reply.crops as any[])[0].key = 'zzz'
    expect((await applyChatGptReview(folderPath, FILE, JSON.stringify(reply))).errors.map(e => e.message).join()).toMatch(/"zzz" is not one of the current crops/)
  })

  it('leaves checks it did not name open, and the sweep undone unless claimed', async () => {
    await reviewedPage()
    const reply = await keepAllReply({ sweep_done: false })
    ;(reply.crops as any[])[1].checks_reviewed = []
    const outcome = await applyChatGptReview(folderPath, FILE, JSON.stringify(reply))
    expect(outcome.view!.readiness.blockers.map(b => b.code)).toEqual(['FINDING_UNACKNOWLEDGED', 'SWEEP_NOT_DONE'])
  })
})
