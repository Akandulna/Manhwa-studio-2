/**
 * Tests for the Page Stitcher grouping. Runs on Node's built-in runner:
 *
 *   node --test client/src/lib/stitchPlan.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  autoGroups,
  joinWithPrevious,
  moveImages,
  outOfOrderGroups,
  outputGroups,
  splitGroup,
  stitchedSize
} from './stitchPlan.ts'

const page = (n: number, height: number, width = 800) => ({ filename: `p${n}`, width, height })

describe('stitchedSize', () => {
  it('scales narrower pages up to the widest', () => {
    assert.deepEqual(stitchedSize([page(1, 1000), page(2, 500, 400)]), { width: 800, height: 2000 })
  })
})

describe('autoGroups', () => {
  const pages = [page(1, 1500), page(2, 500), page(3, 1500), page(4, 500), page(5, 1500)]

  it('fills each output page up to the target', () => {
    assert.deepEqual(autoGroups(pages, new Set(), 2000), [[0, 1], [2, 3], [4]])
  })

  it('gives an over-tall page its own output and ignores excluded pages', () => {
    assert.deepEqual(autoGroups([page(1, 500), page(2, 9000), page(3, 500)], new Set(), 2000), [[0], [1], [2]])
    // p3 adds no height and stays where it is, in the first group
    assert.deepEqual(autoGroups(pages, new Set(['p3']), 2500), [[0, 1, 2, 3], [4]])
  })
})

describe('split / join', () => {
  it('splits a group at an index and joins it back', () => {
    const split = splitGroup([[0, 1, 2], [3]], 0, 1)
    assert.deepEqual(split, [[0], [1, 2], [3]])
    assert.deepEqual(joinWithPrevious(split, 1), [[0, 1, 2], [3]])
    assert.deepEqual(splitGroup([[0, 1]], 0, 0), [[0, 1]])
  })
})

describe('moveImages', () => {
  const groups = [[0, 1, 2], [3, 4], [5]]

  it('moves one image into another group at a position', () => {
    assert.deepEqual(moveImages(groups, [4], { group: 0, index: 1 }), [[0, 4, 1, 2], [3], [5]])
  })

  it('counts the slot without the moved images when moving inside a group', () => {
    // drop 0 just before 2 (index 2 in the old layout)
    assert.deepEqual(moveImages(groups, [0], { group: 0, index: 2 }), [[1, 0, 2], [3, 4], [5]])
  })

  it('moves a selection in layout order and removes emptied groups', () => {
    assert.deepEqual(moveImages(groups, [5, 3], { group: 0, index: 3 }), [[0, 1, 2, 3, 5], [4]])
  })

  it('starts a new group between groups or at the end', () => {
    assert.deepEqual(moveImages(groups, [1, 2], { newGroupAt: 1 }), [[0], [1, 2], [3, 4], [5]])
    assert.deepEqual(moveImages(groups, [5], { newGroupAt: 3 }), groups)
    assert.deepEqual(moveImages(groups, [0], { newGroupAt: 3 }), [[1, 2], [3, 4], [5], [0]])
  })
})

describe('outOfOrderGroups / outputGroups', () => {
  it('flags the group where reading order goes backwards, ignoring excluded pages', () => {
    assert.deepEqual([...outOfOrderGroups([[0, 2], [1, 3]], () => false)], [1])
    assert.deepEqual([...outOfOrderGroups([[0, 2], [1, 3]], i => i === 2)], [])
  })

  it('drops excluded pages and empty groups', () => {
    const pages = [page(1, 1), page(2, 1), page(3, 1), page(4, 1)]
    assert.deepEqual(outputGroups(pages, [[0, 1], [2], [3]], new Set(['p3'])), [['p1', 'p2'], ['p4']])
  })
})
