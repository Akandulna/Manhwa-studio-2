/**
 * Tests for Auto stitch planning. Runs on Node's built-in runner:
 *
 *   node --test client/src/lib/autoStitch.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  autoOptions,
  blankBands,
  buildStrip,
  outputPieces,
  piecesOf,
  planChapter,
  planCuts,
  segments,
  toggleDropped,
  withCut,
  withoutCut,
  type PageProfile
} from './autoStitch.ts'

/** A page whose profile has one row per source px; `blank` lists [from, to) blank row ranges. */
function page(n: number, height: number, blank: [number, number][], fill = 128, width = 800) {
  const ink = new Uint8Array(height).fill(fill)
  for (const [a, b] of blank) ink.fill(0, a, b)
  const filename = `p${n}`
  const profile: PageProfile = { filename, rows: height, ink: Buffer.from(ink).toString('base64') }
  return { page: { filename, width, height }, profile }
}

function strip(defs: ReturnType<typeof page>[], excluded = new Set<string>()) {
  return buildStrip(
    defs.map(d => d.page),
    defs.map(d => d.profile),
    excluded
  )
}

const options = autoOptions(12000, 16383)

describe('buildStrip', () => {
  it('scales kept pages to the widest and stacks them', () => {
    const s = strip([page(1, 1000, []), page(2, 500, [], 128, 400), page(3, 700, [])], new Set(['p3']))
    assert.equal(s.width, 800)
    assert.equal(s.height, 2000)
    assert.deepEqual(s.pages.map(p => [p.filename, p.top, p.scaledHeight]), [
      ['p1', 0, 1000],
      ['p2', 1000, 1000]
    ])
  })
})

describe('blankBands', () => {
  it('finds runs of blank rows and joins them across page boundaries', () => {
    const s = strip([page(1, 1000, [[100, 110], [950, 1000]]), page(2, 1000, [[0, 30], [500, 600]])])
    assert.deepEqual(blankBands(s), [
      { top: 950, bottom: 1030 },
      { top: 1500, bottom: 1600 }
    ])
  })
})

describe('planCuts', () => {
  it('cuts only in blank bands, near the target, ignoring page boundaries', () => {
    // 3 pages of 10k: art everywhere except gaps at 11.5k, 13k and 23.8k.
    const s = strip([
      page(1, 10000, []),
      page(2, 10000, [[1500, 1600], [3000, 3100]]),
      page(3, 10000, [[3800, 3900]])
    ])
    const cuts = planCuts(s, blankBands(s), options)
    assert.deepEqual(cuts.map(c => [c.y, c.kind]), [
      [11550, 'gap'],
      [23850, 'gap']
    ])
    assert.deepEqual(segments(s, cuts).map(r => r.bottom - r.top), [11550, 12300, 6150])
  })

  it('balances the pages instead of leaving a short last page', () => {
    // 26k of strip with a gap every 1k: 2 pages of 13k beat 12k + 12k + 2k.
    const blank: [number, number][] = []
    for (let y = 1000; y < 26000; y += 1000) blank.push([y - 50, y + 50])
    const s = strip([page(1, 26000, blank)])
    const heights = segments(s, planCuts(s, blankBands(s), options)).map(r => r.bottom - r.top)
    assert.deepEqual(heights, [13000, 13000])
  })

  it('falls back to the emptiest row when no gap fits, and marks the cut forced', () => {
    const ink = page(1, 24000, [])
    // Lightest artwork at 12k.
    const bytes = Buffer.from(ink.profile.ink, 'base64')
    bytes.fill(5, 11990, 12010)
    ink.profile.ink = bytes.toString('base64')
    const s = strip([ink])
    const cuts = planCuts(s, blankBands(s), options)
    assert.equal(cuts.length, 1)
    assert.equal(cuts[0].kind, 'forced')
    assert.ok(Math.abs(cuts[0].y - 12000) <= 10, `cut at ${cuts[0].y}`)
    for (const r of segments(s, cuts)) assert.ok(r.bottom - r.top <= 16383)
  })

  it('keeps a chapter shorter than the target as one page', () => {
    const s = strip([page(1, 4000, [[2000, 2100]]), page(2, 3000, [])])
    assert.deepEqual(planCuts(s, blankBands(s), options), [])
  })
})

describe('outputPieces', () => {
  it('sends whole pages by name and cut pages as source-row pieces that meet exactly', () => {
    // p2 is half as wide, so strip px are 2x its source rows.
    const s = strip([page(1, 1000, []), page(2, 1000, [], 128, 400), page(3, 1000, [])])
    const cuts = [{ y: 1501, kind: 'gap' as const }]
    assert.deepEqual(outputPieces(s, cuts), [
      ['p1', { file: 'p2', top: 0, bottom: 251 }],
      [{ file: 'p2', top: 251, bottom: 1000 }, 'p3']
    ])
    assert.deepEqual(
      piecesOf(s, { top: 0, bottom: 1000 }).map(p => [p.page.filename, p.top, p.bottom]),
      [['p1', 0, 1000]]
    )
  })
})

describe('planChapter', () => {
  // 40k strip: intro art 0–1500 (own page), story with gaps every 1k, outro art from 38.5k (own page).
  const blank: [number, number][] = []
  for (let y = 1000; y < 37000; y += 1000) blank.push([y - 50, y + 50])
  const defs = [page(1, 1500, []), page(2, 37000, blank), page(3, 1500, [])]

  it('drops the repeated intro and outro at page boundaries and plans the story between', () => {
    const s = strip(defs)
    const edges = {
      intro: { file: 'p1', row: 1450, referenceNumber: 2 },
      outro: { file: 'p3', row: 80, referenceNumber: 4 }
    }
    const { cuts, dropped } = planChapter(s, blankBands(s), options, edges)
    assert.deepEqual(dropped, [
      { y: 0, reason: 'Intro — repeats Ch 2' },
      { y: 38500, reason: 'Outro — repeats Ch 4' }
    ])
    assert.equal(cuts[0].y, 1500)
    assert.equal(cuts[cuts.length - 1].y, 38500)
    const kept = outputPieces(s, cuts, dropped)
    assert.equal(kept.length, segments(s, cuts).length - 2)
    assert.ok(kept.flat().every(p => p !== 'p1' && p !== 'p3'))
  })

  it('drops nothing when no boundary or gap is near the repeated art', () => {
    const s = strip([page(1, 20000, [])])
    const { dropped } = planChapter(s, blankBands(s), options, {
      intro: { file: 'p1', row: 3000, referenceNumber: 2 },
      outro: null
    })
    assert.deepEqual(dropped, [])
  })
})

describe('dropped pages', () => {
  const cuts = [{ y: 100, kind: 'gap' as const }, { y: 200, kind: 'gap' as const }]

  it('keeps a merged page only if both halves were dropped', () => {
    // Page at 100 dropped, page at 200 kept: the merged page is kept.
    assert.deepEqual(withoutCut(cuts, [{ y: 100, reason: '' }], 200).dropped, [])
    assert.deepEqual(withoutCut(cuts, [{ y: 100, reason: 'a' }, { y: 200, reason: 'b' }], 200).dropped, [{ y: 100, reason: 'a' }])
    assert.deepEqual(withoutCut(cuts, [{ y: 200, reason: '' }], 200).dropped, [])
  })

  it('splitting a dropped page keeps both halves dropped', () => {
    const next = withCut(cuts, [{ y: 100, reason: 'Intro' }], { y: 150, kind: 'gap' })
    assert.deepEqual(next.cuts.map(c => c.y), [100, 150, 200])
    assert.deepEqual(next.dropped, [{ y: 100, reason: 'Intro' }, { y: 150, reason: 'Intro' }])
  })

  it('toggles a page', () => {
    assert.deepEqual(toggleDropped([], 100), [{ y: 100, reason: '' }])
    assert.deepEqual(toggleDropped([{ y: 100, reason: 'x' }], 100), [])
  })
})
