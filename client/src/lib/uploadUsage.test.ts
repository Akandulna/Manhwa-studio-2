/**
 * Tests for the ChatGPT upload-limit estimate. Runs on Node's built-in runner:
 *
 *   node --test client/src/lib/uploadUsage.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PhoneUploadLimit, PhoneUploadProfile } from './api'
import { uploadOverview, uploadUsage } from './uploadUsage.ts'

const NOW = Date.parse('2026-10-01T12:00:00Z')
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

function profile(over: Partial<PhoneUploadProfile> = {}): PhoneUploadProfile {
  return { id: 'p', name: 'Main', selected: false, limitedUntil: null, trackingSince: at(600), counting: null, uploads: [], limits: [], ...over }
}

function limit(over: Partial<PhoneUploadLimit> = {}): PhoneUploadLimit {
  return { at: at(300), until: at(240), used: 60, countedSince: at(600), complete: true, flagged: false, reason: '', ...over }
}

describe('uploadUsage', () => {
  it('takes the latest complete limit and runs out at the last half hour\'s pace', () => {
    const usage = uploadUsage(profile({
      counting: { since: at(300), images: 30 },
      uploads: [{ at: at(30), images: 10 }, { at: at(15), images: 10 }, { at: at(5), images: 10 }],
      limits: [limit({ used: 50 }), limit({ used: 60 }), limit({ used: 99, flagged: true })]
    }), NOW)
    assert.equal(usage.limit, 60)
    assert.equal(usage.limitAtLeast, false)
    assert.equal(usage.left, 30)
    assert.equal(usage.lastHour, 30)
    assert.equal(usage.pace, 60) // 30 images over the 30 minutes since the first slot
    assert.equal(usage.exhaustsAt, NOW + 30 * 60_000)
  })

  it('treats a first limit as a lower bound and knows nothing before one', () => {
    const first = uploadUsage(profile({ limits: [limit({ complete: false, used: 40 })] }), NOW)
    assert.equal(first.limit, 40)
    assert.equal(first.limitAtLeast, true)

    const none = uploadUsage(profile({ uploads: [{ at: at(2), images: 4 }], counting: { since: at(600), images: 4 } }), NOW)
    assert.equal(none.limit, null)
    assert.equal(none.left, null)
    assert.equal(none.exhaustsAt, null)
    assert.equal(none.pace, 24) // 4 images over the 10-minute minimum window
  })

  it('has nothing left while limited, and is idle without recent uploads', () => {
    const limited = uploadUsage(profile({ limitedUntil: at(-90), limits: [limit()], uploads: [{ at: at(3), images: 5 }] }), NOW)
    assert.equal(limited.limitedUntil, NOW + 90 * 60_000)
    assert.equal(limited.left, 0)
    assert.equal(limited.exhaustsAt, null)

    const lifted = uploadUsage(profile({ limitedUntil: at(10), limits: [limit()] }), NOW)
    assert.equal(lifted.limitedUntil, null)
    assert.equal(lifted.left, 60)
    assert.equal(lifted.pace, null)
  })
})

describe('uploadOverview', () => {
  it('adds up what is left and runs the profiles out one after another', () => {
    const main = uploadUsage(profile({ limits: [limit()], counting: { since: at(300), images: 50 }, uploads: [{ at: at(10), images: 10 }] }), NOW)
    const alt = uploadUsage(profile({ id: 'alt', limits: [limit({ used: 40 })] }), NOW)
    const off = uploadUsage(profile({ id: 'off', limitedUntil: at(-30), limits: [limit()] }), NOW)
    const overview = uploadOverview([main, alt, off], NOW)
    assert.equal(overview.left, 50)
    assert.equal(overview.unknown, 0)
    assert.equal(overview.pace, 60)
    assert.equal(overview.allUsedAt, NOW + 50 * 60_000)
    assert.equal(overview.nextLiftAt, NOW + 30 * 60_000)

    const fresh = uploadUsage(profile({ id: 'new' }), NOW)
    assert.equal(uploadOverview([main, fresh], NOW).allUsedAt, null)
  })
})
