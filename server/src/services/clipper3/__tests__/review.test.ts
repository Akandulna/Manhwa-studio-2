/**
 * Tests for the Crop Studio review stage:
 * - geometric audit rules (tall, page share, median outlier, duplicates,
 *   overlap, tiny/sliver) and uncovered intervals
 * - pixel rules on synthetic pages (edge on content, mostly blank crops, ink share of gaps)
 * - review save rules (provenance, stale descriptions, cleared acks, validation)
 * - readiness blockers
 * - seeding from an import and from existing pointers, revision conflicts, staleness
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import {
  auditBlank,
  auditEdges,
  auditGeometry,
  gapsWithContent,
  GAP_ARTWORK_INK,
  iou,
  uncoveredIntervals,
  type AuditCrop,
  type LumaPage
} from '../auditRules.js'
import {
  applyReviewSave,
  findingToken,
  getReview,
  readiness,
  reviewItems,
  saveReview,
  startReview,
  ReviewError,
  type ReviewCrop,
  type ReviewState
} from '../reviewState.js'
import { buildHandoff } from '../handoff.js'
import { importAnalysis } from '../analysisImport.js'

const box = (key: string, x0: number, y0: number, x1: number, y1: number): AuditCrop => ({ key, bounds: { x0, y0, x1, y1 } })
const codesFor = (findings: { code: string; key: string }[], key: string) => findings.filter(f => f.key === key).map(f => f.code)

describe('auditGeometry', () => {
  it('flags tall aspect and a large share of the page', () => {
    const findings = auditGeometry(800, 10000, [box('a', 0, 0, 800, 2500)])
    expect(codesFor(findings, 'a')).toEqual(['TALL_ASPECT', 'PAGE_FRACTION'])
  })

  it('leaves an ordinary panel alone', () => {
    expect(auditGeometry(800, 10000, [box('a', 0, 0, 800, 900)])).toEqual([])
  })

  it('compares height with the median of the OTHER crops, only when there are enough', () => {
    const crops = [box('a', 0, 0, 800, 400), box('b', 0, 500, 800, 900), box('big', 0, 1000, 800, 2100)]
    expect(codesFor(auditGeometry(800, 20000, crops), 'big')).toContain('HEIGHT_OUTLIER')
    expect(codesFor(auditGeometry(800, 20000, crops.slice(1)), 'big')).not.toContain('HEIGHT_OUTLIER')
  })

  it('tells duplicates from overlaps and containment', () => {
    const findings = auditGeometry(800, 10000, [
      box('a', 0, 0, 800, 1000),
      box('dup', 0, 10, 800, 1005),
      box('inside', 100, 100, 400, 400),
      box('far', 0, 5000, 800, 5600)
    ])
    expect(findings).toContainEqual(expect.objectContaining({ code: 'DUPLICATE', key: 'dup', otherKey: 'a' }))
    expect(findings).toContainEqual(expect.objectContaining({ code: 'HIGH_OVERLAP', key: 'inside', otherKey: 'a' }))
    expect(codesFor(findings, 'far')).toEqual([])
  })

  it('flags tiny boxes and slivers', () => {
    const findings = auditGeometry(800, 10000, [box('tiny', 0, 0, 40, 300), box('sliver', 0, 1000, 800, 1060)])
    expect(codesFor(findings, 'tiny')).toContain('TINY')
    expect(codesFor(findings, 'sliver')).toEqual(['SLIVER'])
  })

  it('flags a crop whose reason names filler, matching whole words only', () => {
    const findings = auditGeometry(800, 10000, [
      { ...box('t', 0, 0, 800, 600), reason: 'dark_summoning_transition' },
      { ...box('n', 0, 700, 800, 1300), reason: 'narration_environment' },
      { ...box('fx', 0, 1400, 800, 2000), reason: 'action_effects' },
      { ...box('wall', 0, 2100, 800, 2700), reason: 'textured_wall' }
    ])
    expect(codesFor(findings, 't')).toEqual(['FILLER_REASON'])
    expect(codesFor(findings, 'n')).toEqual(['FILLER_REASON'])
    expect(codesFor(findings, 'fx')).toEqual([])
    expect(codesFor(findings, 'wall')).toEqual([])
  })

  it('computes IoU', () => {
    expect(iou({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 5, y0: 0, x1: 15, y1: 10 })).toBeCloseTo(50 / 150)
  })
})

describe('uncoveredIntervals', () => {
  it('lists stretches at least 200 px tall, including before the first and after the last crop', () => {
    const gaps = uncoveredIntervals(5000, [box('a', 0, 300, 800, 1000), box('b', 0, 1100, 800, 2000), box('c', 0, 1500, 800, 2500)])
    expect(gaps).toEqual([{ y0: 0, y1: 300 }, { y0: 2500, y1: 5000 }])
  })
})

/** A white 400×1000 page with a textured "panel" at y 200–600. */
function syntheticPage(): LumaPage {
  const width = 400
  const height = 1000
  const data = Buffer.alloc(width * height, 255)
  for (let y = 200; y < 600; y++) {
    for (let x = 20; x < 380; x++) data[y * width + x] = (x * 7 + y * 13) % 200
  }
  return { data, width, height }
}

describe('pixel rules', () => {
  it('flags an edge that cuts through content, not one in the gutter', () => {
    const page = syntheticPage()
    const findings = auditEdges(page, [box('cut', 20, 200, 380, 400), box('clean', 10, 190, 390, 610)])
    expect(findings).toContainEqual(expect.objectContaining({ key: 'cut', code: 'EDGE_ON_CONTENT', edge: 'bottom' }))
    expect(findings.filter(f => f.key === 'clean')).toEqual([])
  })

  it('ignores a thin outline crossing the gutter (a bubble tail, an SFX stroke)', () => {
    const page = syntheticPage()
    for (let y = 600; y < 640; y++) for (let x = 100; x < 103; x++) page.data[y * page.width + x] = 0
    expect(auditEdges(page, [box('panel', 20, 200, 380, 600)])).toEqual([])
  })

  it('does not flag a correct edge on a frameless page whose background is inked texture', () => {
    // Striped dark background everywhere (about half its pixels are ink), bright artwork at y 200–600.
    const width = 400
    const height = 1000
    const data = Buffer.alloc(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        data[y * width + x] = y >= 200 && y < 600 ? 55 + (x * 7 + y * 13) % 200 : (x % 2 ? 90 : 0)
      }
    }
    const page = { data, width, height }
    const findings = auditEdges(page, [box('shot', 0, 200, 400, 600), box('cut', 0, 200, 400, 400)])
    expect(findings.filter(f => f.key === 'shot')).toEqual([])
    expect(findings).toContainEqual(expect.objectContaining({ key: 'cut', code: 'EDGE_ON_CONTENT', edge: 'bottom' }))
  })

  it('flags a crop that is mostly flat colour', () => {
    const findings = auditBlank(syntheticPage(), [box('empty', 0, 500, 400, 1000), box('panel', 20, 200, 380, 600)])
    expect(findings).toEqual([expect.objectContaining({ key: 'empty', code: 'MOSTLY_BLANK' })])
  })

  it('reports how much ink an uncovered stretch holds', () => {
    const [blank, busy] = gapsWithContent(syntheticPage(), [{ y0: 700, y1: 1000 }, { y0: 100, y1: 600 }])
    expect(blank.inkShare).toBe(0)
    expect(busy.inkShare).toBeGreaterThan(GAP_ARTWORK_INK)
  })
})

// ============ Save rules and readiness ============

function crop(key: string, overrides: Partial<ReviewCrop> = {}): ReviewCrop {
  return {
    key,
    origin: 'chatgpt',
    reason: 'framed_reaction',
    bounds: { x0: 0, y0: 100, x1: 800, y1: 900 },
    description: 'A character reacts in a framed close shot against a softly shaded background panel.',
    description_status: 'approved',
    disposition: 'kept',
    visual_evidence: 'framed shot',
    gpt_flags: ['seam_crossing'],
    unknown_flags: [],
    acknowledged: ['gpt:seam_crossing'],
    note: '',
    ...overrides
  }
}

function state(crops: ReviewCrop[] = [crop('candidate-01')]): ReviewState {
  return {
    schema_version: 'crop-studio-review/1.0',
    job_id: 'job',
    source_sha256: 'a'.repeat(64),
    source_width: 800,
    source_height: 5000,
    page_stem: 'page_008',
    review_revision: 3,
    created_at: '2026-09-26T00:00:00.000Z',
    updated_at: '2026-09-26T00:00:00.000Z',
    based_on: { kind: 'chatgpt_import', response_sha256: 'r', imported_at: 'now' },
    crops,
    provenance: {},
    page: { sweep_done: true, no_eligible_artwork_confirmed: false, note: '' }
  }
}

describe('applyReviewSave', () => {
  it('bumps the revision and keeps provenance from the stored crop', () => {
    const forged = { ...crop('candidate-01'), origin: 'operator', gpt_flags: [], visual_evidence: 'forged' }
    const { state: next, errors } = applyReviewSave(state(), { crops: [forged], page: { sweep_done: true } }, 'later')
    expect(errors).toEqual([])
    expect(next?.review_revision).toBe(4)
    expect(next?.crops[0]).toMatchObject({ origin: 'chatgpt', gpt_flags: ['seam_crossing'], visual_evidence: 'framed shot' })
  })

  it('makes an approved description stale and clears acks when the box moves', () => {
    const moved = crop('candidate-01', { bounds: { x0: 0, y0: 100, x1: 800, y1: 950 } })
    const { state: next } = applyReviewSave(state(), { crops: [moved] }, 'later')
    expect(next?.crops[0]).toMatchObject({ description_status: 'stale', acknowledged: [] })
  })

  it('restores approval and acks when a box returns to where they were given (undo)', () => {
    const moved = applyReviewSave(state(), { crops: [crop('candidate-01', { bounds: { x0: 0, y0: 100, x1: 800, y1: 950 } })] }, 'later').state!
    expect(moved.crops[0]).toMatchObject({ description_status: 'stale', acknowledged: [] })
    const back = applyReviewSave(moved, { crops: [crop('candidate-01')] }, 'later').state!
    expect(back.crops[0]).toMatchObject({ description_status: 'approved', acknowledged: ['gpt:seam_crossing'] })
  })

  it('does not let a return restore acks that were never given there', () => {
    const moved = applyReviewSave(state(), { crops: [crop('candidate-01', { bounds: { x0: 0, y0: 100, x1: 800, y1: 950 } })] }, 'later').state!
    const back = applyReviewSave(moved, { crops: [crop('candidate-01', { acknowledged: ['gpt:seam_crossing', 'TALL_ASPECT'] })] }, 'later').state!
    expect(back.crops[0].acknowledged).toEqual(['gpt:seam_crossing'])
  })

  it('keeps it approved when the description was rewritten together with the move', () => {
    const moved = crop('candidate-01', { bounds: { x0: 0, y0: 100, x1: 800, y1: 950 }, description: 'A rewritten sentence describing the larger framed reaction shot with more of the background visible.' })
    expect(applyReviewSave(state(), { crops: [moved] }, 'later').state?.crops[0].description_status).toBe('approved')
  })

  it('never stores an empty description as approved', () => {
    const { state: next } = applyReviewSave(state(), { crops: [crop('candidate-01', { description: '  ' })] }, 'later')
    expect(next?.crops[0].description_status).toBe('missing')
  })

  it('restores provenance for a key that was deleted in an earlier revision (undo)', () => {
    const first = applyReviewSave(state(), { crops: [] }, 'later').state!
    expect(first.crops).toEqual([])
    const restored = applyReviewSave(first, { crops: [{ ...crop('candidate-01'), origin: 'operator', gpt_flags: [] }] }, 'later').state!
    expect(restored.crops[0]).toMatchObject({ origin: 'chatgpt', gpt_flags: ['seam_crossing'], visual_evidence: 'framed shot' })
  })

  it('gives new crops operator provenance', () => {
    const { state: next } = applyReviewSave(state(), { crops: [crop('candidate-01'), crop('added', { origin: 'chatgpt', gpt_flags: ['x'] })] }, 'later')
    expect(next?.crops[1]).toMatchObject({ origin: 'operator', gpt_flags: [] })
  })

  it.each([
    ['out-of-page bounds', { bounds: { x0: 0, y0: 4000, x1: 800, y1: 5001 } }, /outside the 800×5000 page/],
    ['fractional bounds', { bounds: { x0: 0.5, y0: 0, x1: 800, y1: 100 } }, /four whole pixels/],
    ['no area', { bounds: { x0: 10, y0: 100, x1: 10, y1: 200 } }, /no area/],
    ['a bad disposition', { disposition: 'maybe' }, /disposition must be one of/],
    ['an empty reason', { reason: '!!' }, /reason must be/]
  ])('rejects %s', (_label, overrides, message) => {
    const { state: next, errors } = applyReviewSave(state(), { crops: [crop('candidate-01', overrides as Partial<ReviewCrop>)] }, 'later')
    expect(next).toBeNull()
    expect(errors.join('\n')).toMatch(message)
  })

  it('rejects duplicate keys', () => {
    expect(applyReviewSave(state(), { crops: [crop('a'), crop('a')] }, 'later').errors).toEqual(['Duplicate crop key "a"'])
  })
})

describe('readiness', () => {
  it('is ready when every crop is decided, acknowledged and described, and the sweep is done', () => {
    const s = state()
    expect(readiness(s, reviewItems(s, []), false)).toEqual({ ready: true, blockers: [] })
  })

  it('lists every blocker', () => {
    const s = state([crop('a', { disposition: 'unreviewed', acknowledged: [], description_status: 'stale' })])
    s.page.sweep_done = false
    const findings = [{ code: 'TALL_ASPECT' as const, key: 'a', message: 'tall' }]
    const { ready, blockers } = readiness(s, reviewItems(s, findings), true)
    expect(ready).toBe(false)
    expect(blockers.map(b => b.code)).toEqual(['REVIEW_STALE', 'CROP_UNREVIEWED', 'FINDING_UNACKNOWLEDGED', 'DESCRIPTION_NOT_APPROVED', 'SWEEP_NOT_DONE'])
    expect(blockers[2].message).toMatch(/TALL_ASPECT, seam_crossing/)
  })

  it('requires an explicit confirmation for a page with no crops', () => {
    const s = state([])
    expect(readiness(s, [], false).blockers.map(b => b.code)).toEqual(['EMPTY_NOT_CONFIRMED'])
    s.page.no_eligible_artwork_confirmed = true
    expect(readiness(s, [], false).ready).toBe(true)
  })

  it('tokens name the other crop or the edge', () => {
    expect(findingToken({ code: 'HIGH_OVERLAP', otherKey: 'b' })).toBe('HIGH_OVERLAP:b')
    expect(findingToken({ code: 'EDGE_ON_CONTENT', edge: 'bottom' })).toBe('EDGE_ON_CONTENT:bottom')
    expect(findingToken({ code: 'TALL_ASPECT' })).toBe('TALL_ASPECT')
  })
})

// ============ Against real files ============

const SERIES = 'Bad Business'
const CHAPTER = 'Chapter 006'
const folderPath = `${SERIES}/${CHAPTER}`
let root: string
let previousRoot: string | undefined

beforeEach(async () => {
  previousRoot = process.env.DOWNLOAD_ROOT
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crop-studio-review-'))
  process.env.DOWNLOAD_ROOT = root
})

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = previousRoot
  await fs.rm(root, { recursive: true, force: true })
})

async function page(filename = 'page_008.png') {
  const target = path.join(root, SERIES, CHAPTER, filename)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await sharp({ create: { width: 800, height: 5000, channels: 3, background: '#ffffff' } }).png().toFile(target)
  return target
}

async function importedPage() {
  const target = await page()
  const { manifest } = await buildHandoff({ folderPath, imageFilename: 'page_008.png', seriesTitle: SERIES, seriesSlug: 'bad_business', chapterNumber: 6 })
  const outcome = await importAnalysis(folderPath, 'page_008.png', JSON.stringify({
    schema_version: 'chatgpt-analysis/1.0',
    job_id: manifest.job_id,
    source_sha256: manifest.source.sha256,
    page_stem: 'page_008',
    source_width: 800,
    source_height: 5000,
    coordinate_system: 'canonical_original_pixels',
    page_inspection_complete: true,
    candidates: [{
      candidate_id: 'candidate-01',
      reason: 'framed_reaction',
      bounds: { x0: 0, y0: 100, x1: 800, y1: 2500 },
      description: 'A character reacts in a framed close shot against a softly shaded background panel.',
      visual_evidence: 'framed shot',
      review_flags: ['boundary_uncertain']
    }],
    page_review_flags: []
  }))
  expect(outcome.imported).toBe(true)
  return target
}

describe('review lifecycle', () => {
  it('starts from an import with audit items and blockers, then saves to readiness', async () => {
    await importedPage()
    const view = await startReview(folderPath, 'page_008.png', 'import', false)
    expect(view.state?.review_revision).toBe(1)
    expect(view.state?.crops[0]).toMatchObject({ key: 'candidate-01', description_status: 'unreviewed', disposition: 'unreviewed' })
    // The test page is plain white, so the crop is also flagged as mostly flat colour.
    expect(view.items.map(i => i.token)).toEqual(['TALL_ASPECT', 'PAGE_FRACTION', 'MOSTLY_BLANK', 'gpt:boundary_uncertain'])
    expect(view.audit?.gaps).toEqual([{ y0: 2500, y1: 5000, inkShare: 0 }])
    expect(view.readiness.ready).toBe(false)

    const decided = {
      ...view.state!,
      crops: [{ ...view.state!.crops[0], disposition: 'kept', description_status: 'approved', acknowledged: view.items.map(i => i.token) }],
      page: { sweep_done: true, no_eligible_artwork_confirmed: false, note: '' }
    }
    const saved = await saveReview(folderPath, 'page_008.png', decided, 1)
    expect(saved.state?.review_revision).toBe(2)
    expect(saved.readiness).toEqual({ ready: true, blockers: [] })

    const history = await fs.readdir(path.join(root, SERIES, '.crop-studio', CHAPTER, 'page_008', 'review-history'))
    expect(history).toHaveLength(2)
  })

  it('refuses a save based on an old revision, and a second start without replace', async () => {
    await importedPage()
    const view = await startReview(folderPath, 'page_008.png', 'import', false)
    await saveReview(folderPath, 'page_008.png', view.state, 1)
    await expect(saveReview(folderPath, 'page_008.png', view.state, 1)).rejects.toMatchObject({ status: 409 })
    await expect(startReview(folderPath, 'page_008.png', 'import', false)).rejects.toBeInstanceOf(ReviewError)
    expect((await startReview(folderPath, 'page_008.png', 'import', true)).state?.review_revision).toBe(1)
  })

  it('goes stale when the page changes and refuses edits', async () => {
    const target = await importedPage()
    const view = await startReview(folderPath, 'page_008.png', 'import', false)
    await fs.appendFile(target, Buffer.from([0]))
    const after = await getReview(folderPath, 'page_008.png')
    expect(after.stale).toBe(true)
    expect(after.readiness.blockers[0].code).toBe('REVIEW_STALE')
    await expect(saveReview(folderPath, 'page_008.png', view.state, 1)).rejects.toMatchObject({ status: 422 })
  })

  it('starts from existing Clipper 3.0 pointers and their metadata', async () => {
    await page()
    const pointsDir = path.join(root, SERIES, CHAPTER, 'crop_points3')
    const metaDir = path.join(root, SERIES, CHAPTER, 'crop_metadata3')
    await fs.mkdir(pointsDir, { recursive: true })
    await fs.mkdir(metaDir, { recursive: true })
    await fs.writeFile(path.join(pointsDir, 'page_008.json'), JSON.stringify({
      format: 'four-point-crop', version: '1.0', image: { filename: 'page_008', width: 800, height: 5000 }, coordinateSystem: 'normalized',
      crops: [{ id: 'crop-01', reason: 'framed_reaction', crop: { mode: 'rectangle', points: [
        { id: 'P1', x: 0.025, y: 0.02 }, { id: 'P2', x: 0.975, y: 0.02 }, { id: 'P3', x: 0.975, y: 0.18 }, { id: 'P4', x: 0.025, y: 0.18 }
      ] } }]
    }))
    await fs.writeFile(path.join(metaDir, 'page_008.txt'), JSON.stringify({
      crops: [{ id: 'crop-01', exportedFilename: 'bad_business_page_008_01_framed_reaction.png', description: 'An existing description.' }]
    }))

    const view = await startReview(folderPath, 'page_008.png', 'pointers', false)
    expect(view.state?.based_on.kind).toBe('existing_pointers')
    expect(view.state?.job_id).toBeNull()
    expect(view.state?.crops[0]).toMatchObject({
      key: 'crop-01',
      origin: 'existing_pointers',
      bounds: { x0: 20, y0: 100, x1: 780, y1: 900 },
      description: 'An existing description.',
      description_status: 'approved'
    })
  })
})
