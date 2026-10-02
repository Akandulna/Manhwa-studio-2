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
  it('counts the last 3 hours against 80 and runs out at the recent pace', () => {
    const usage = uploadUsage(profile({
      uploads: [{ at: at(200), images: 40 }, { at: at(170), images: 20 }, { at: at(30), images: 10 }, { at: at(15), images: 10 }, { at: at(5), images: 10 }],
      limits: [limit(), limit({ flagged: true })]
    }), NOW)
    assert.equal(usage.limit, 80)
    assert.equal(usage.used, 50) // the slot from 200 minutes ago has aged out
    assert.equal(usage.left, 30)
    assert.equal(usage.nextFreeAt, NOW + 15 * 60_000) // 170 minutes ago + its 5-minute slot + 3 hours
    assert.equal(usage.nextFree, 20)
    assert.equal(usage.lastHour, 30)
    assert.equal(usage.pace, 60) // 30 images over the 30 minutes since the first slot
    assert.equal(usage.exhaustsAt, NOW + 30 * 60_000)
    assert.equal(usage.lastLimit?.flagged, false)
  })

  it('is limited with a full window until enough uploads age out', () => {
    const full = uploadUsage(profile({ uploads: [{ at: at(170), images: 30 }, { at: at(100), images: 30 }, { at: at(60), images: 20 }] }), NOW)
    assert.equal(full.used, 80)
    assert.equal(full.left, 0)
    assert.equal(full.limitedUntil, NOW + 15 * 60_000)
    assert.equal(full.exhaustsAt, null)
  })

  it('takes ChatGPT\'s own limit, and is idle without recent uploads', () => {
    const limited = uploadUsage(profile({ limitedUntil: at(-90), uploads: [{ at: at(3), images: 5 }] }), NOW)
    assert.equal(limited.limitedUntil, NOW + 90 * 60_000)
    assert.equal(limited.left, 0)
    assert.equal(limited.exhaustsAt, null)

    const lifted = uploadUsage(profile({ limitedUntil: at(10), uploads: [{ at: at(60), images: 4 }] }), NOW)
    assert.equal(lifted.limitedUntil, null)
    assert.equal(lifted.left, 76)
    assert.equal(lifted.pace, null)
  })
})

describe('uploadOverview', () => {
  it('adds up what is left and runs the profiles out one after another', () => {
    const main = uploadUsage(profile({ uploads: [{ at: at(100), images: 20 }, { at: at(10), images: 10 }] }), NOW)
    const alt = uploadUsage(profile({ id: 'alt' }), NOW)
    const off = uploadUsage(profile({ id: 'off', limitedUntil: at(-30) }), NOW)
    const overview = uploadOverview([main, alt, off], NOW)
    assert.equal(overview.left, 50 + 80)
    assert.equal(overview.pace, 60)
    assert.equal(overview.allUsedAt, NOW + 130 * 60_000)
    assert.equal(overview.nextLiftAt, NOW + 30 * 60_000)

    assert.equal(uploadOverview([alt], NOW).allUsedAt, null)
  })
})
