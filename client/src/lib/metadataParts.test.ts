/**
 * Tests for Run automation → Metadata's part selection. Runs on Node's built-in runner:
 *
 *   node --test client/src/lib/metadataParts.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { defaultMetadataPart, metadataParts, partOf, scopeMetadata } from './metadataParts.ts'

const ch = (number: number) => ({ name: `Chapter ${number}`, number })
const blocked = (number: number) => ({ ...ch(number), id: `id-${number}`, reason: 'Not reviewed' })

describe('partOf', () => {
  it('uses fixed twenty-chapter parts', () => {
    assert.equal(partOf(1), 1)
    assert.equal(partOf(20), 1)
    assert.equal(partOf(20.5), 2)
    assert.equal(partOf(21), 2)
    assert.equal(partOf(40), 2)
    assert.equal(partOf(41), 3)
    assert.equal(partOf(0), 1)
  })
})

describe('metadata parts', () => {
  // Part 1 entirely blocked (not reviewed), Part 2 ready apart from one chapter.
  const ready = [ch(23), ch(21), ch(22)]
  const missing = [...Array.from({ length: 20 }, (_, i) => blocked(i + 1)), blocked(24)]
  const parts = metadataParts(ready, missing)

  it('groups and orders chapters by part', () => {
    assert.deepEqual(parts.map(p => [p.part, p.from, p.to, p.ready.length, p.blocked.length]), [[1, 1, 20, 0, 20], [2, 21, 40, 3, 1]])
    assert.deepEqual(parts[1].ready.map(c => c.number), [21, 22, 23])
  })

  it('defaults to the earliest part with ready chapters, not a blocked earlier part', () => {
    assert.equal(defaultMetadataPart(parts), 2)
  })

  it('scopes Part 2 to Chapters 21–40 only', () => {
    const scoped = scopeMetadata(parts, 2)
    assert.deepEqual(scoped.ready.map(c => c.number), [21, 22, 23])
    assert.deepEqual(scoped.blocked.map(c => c.number), [24])
  })

  it('offers every part explicitly', () => {
    const scoped = scopeMetadata(parts, 'all')
    assert.equal(scoped.ready.length, 3)
    assert.equal(scoped.blocked.length, 21)
  })

  it('keeps a picked part that has lost its chapters, empty, instead of falling back', () => {
    const kept = metadataParts([], [blocked(3)], 2)
    assert.deepEqual(kept.map(p => p.part), [1, 2])
    assert.deepEqual(scopeMetadata(kept, 2), { ready: [], blocked: [] })
  })

  it('falls back to the earliest part, then all', () => {
    assert.equal(defaultMetadataPart(metadataParts([], [blocked(45)])), 3)
    assert.equal(defaultMetadataPart([]), 'all')
  })
})
