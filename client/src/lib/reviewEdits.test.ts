/**
 * Tests for the review box-edit geometry. Runs on Node's built-in runner — the
 * client has no test framework of its own:
 *
 *   node --test client/src/lib/reviewEdits.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Clipper3ReviewCrop } from './api'
import {
  drawnBox,
  moveBox,
  nextOperatorKey,
  readingOrder,
  resizeBox,
  splitBox,
  uniqueKey,
  withAdded,
  withBounds,
  withMerged,
  withSplit
} from './reviewEdits.ts'

const W = 800
const H = 5000
const box = { x0: 100, y0: 1000, x1: 700, y1: 1600 }

function crop(key: string, bounds = box, overrides: Partial<Clipper3ReviewCrop> = {}): Clipper3ReviewCrop {
  return {
    key,
    origin: 'chatgpt',
    reason: 'framed_reaction',
    bounds,
    description: 'An approved sentence.',
    description_status: 'approved',
    disposition: 'kept',
    visual_evidence: '',
    gpt_flags: ['seam_crossing'],
    unknown_flags: [],
    acknowledged: ['gpt:seam_crossing'],
    note: '',
    ...overrides
  }
}

describe('moveBox', () => {
  it('moves by whole pixels and keeps the size', () => {
    assert.deepEqual(moveBox(box, 10.4, -20.6, W, H), { x0: 110, y0: 979, x1: 710, y1: 1579 })
  })
  it('stops at the page edges', () => {
    assert.deepEqual(moveBox(box, 500, -5000, W, H), { x0: 200, y0: 0, x1: 800, y1: 600 })
  })
})

describe('resizeBox', () => {
  it('moves only the edges its handle controls', () => {
    assert.deepEqual(resizeBox(box, 's', 50, 40, W, H), { ...box, y1: 1640 })
    assert.deepEqual(resizeBox(box, 'nw', -30, -30, W, H), { x0: 70, y0: 970, x1: 700, y1: 1600 })
  })
  it('clamps to the page and never inverts or collapses', () => {
    assert.deepEqual(resizeBox(box, 'e', 900, 0, W, H), { ...box, x1: 800 })
    assert.deepEqual(resizeBox(box, 'n', 0, 9000, W, H), { ...box, y0: 1592 })
  })
})

describe('drawnBox', () => {
  it('accepts a drag in any direction', () => {
    assert.deepEqual(drawnBox(500, 900, 100, 300, W, H), { x0: 100, y0: 300, x1: 500, y1: 900 })
  })
  it('rejects a click or a tiny drag', () => {
    assert.equal(drawnBox(100, 100, 104, 300, W, H), null)
  })
})

describe('splitBox', () => {
  it('cuts horizontally and vertically with no gap or overlap', () => {
    assert.deepEqual(splitBox(box, 'h', 1300), [{ ...box, y1: 1300 }, { ...box, y0: 1300 }])
    assert.deepEqual(splitBox(box, 'v', 400), [{ ...box, x1: 400 }, { ...box, x0: 400 }])
  })
  it('refuses a cut that leaves a sliver', () => {
    assert.equal(splitBox(box, 'h', 1003), null)
  })
})

describe('reading order', () => {
  it('goes top to bottom, and left to right within a ragged row', () => {
    const order = readingOrder([
      crop('low', { x0: 0, y0: 3000, x1: 800, y1: 3500 }),
      crop('right', { x0: 400, y0: 1000, x1: 800, y1: 1500 }),
      crop('left', { x0: 0, y0: 1008, x1: 400, y1: 1500 })
    ]).map(c => c.key)
    assert.deepEqual(order, ['left', 'right', 'low'])
  })
})

describe('keys', () => {
  it('finds free keys', () => {
    assert.equal(uniqueKey('a.a', ['a.a', 'a.a-2']), 'a.a-3')
    assert.equal(nextOperatorKey(['op-01', 'op-03']), 'op-02')
  })
})

describe('crop edits', () => {
  it('a resize marks the crop adjusted and clears its acknowledgements', () => {
    const [next] = withBounds([crop('c1')], 'c1', { ...box, y1: 1700 })
    assert.equal(next.disposition, 'adjusted')
    assert.deepEqual(next.acknowledged, [])
  })

  it('a no-op resize changes nothing', () => {
    const crops = [crop('c1')]
    assert.equal(withBounds(crops, 'c1', { ...box })[0], crops[0])
  })

  it('a split makes two stale halves in reading order', () => {
    const result = withSplit([crop('c1'), crop('c0', { x0: 0, y0: 0, x1: 800, y1: 500 })], 'c1', 'h', 1300)
    assert.ok(result)
    assert.deepEqual(result.keys, ['c1.a', 'c1.b'])
    assert.deepEqual(result.crops.map(c => c.key), ['c0', 'c1.a', 'c1.b'])
    for (const half of result.crops.slice(1)) {
      assert.equal(half.disposition, 'split')
      assert.equal(half.description_status, 'stale')
      assert.equal(half.description, 'An approved sentence.')
      assert.deepEqual(half.acknowledged, [])
    }
  })

  it('a merge keeps the first crop over the union, description stale', () => {
    const result = withMerged([
      crop('top', { x0: 0, y0: 100, x1: 400, y1: 500 }),
      crop('bottom', { x0: 200, y0: 600, x1: 800, y1: 900 }, { description: '', description_status: 'missing' })
    ], ['bottom', 'top'])
    assert.ok(result)
    assert.equal(result.key, 'top')
    assert.equal(result.crops.length, 1)
    assert.deepEqual(result.crops[0].bounds, { x0: 0, y0: 100, x1: 800, y1: 900 })
    assert.equal(result.crops[0].disposition, 'merged')
    assert.equal(result.crops[0].description_status, 'stale')
  })

  it('a merge needs two crops', () => {
    assert.equal(withMerged([crop('a')], ['a']), null)
  })

  it('an added crop is the operator\'s, with no description yet', () => {
    const { crops, key } = withAdded([crop('c1')], { x0: 0, y0: 0, x1: 300, y1: 300 })
    assert.equal(key, 'op-01')
    assert.deepEqual(crops.map(c => c.key), ['op-01', 'c1'])
    assert.equal(crops[0].description_status, 'missing')
  })
})
