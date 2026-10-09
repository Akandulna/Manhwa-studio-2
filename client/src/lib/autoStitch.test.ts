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
  planCuts,
  segments,
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
