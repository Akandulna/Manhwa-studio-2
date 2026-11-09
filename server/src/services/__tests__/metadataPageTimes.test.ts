import { beforeEach, describe, expect, it } from 'vitest'
import { metadataAverageTook, recordMetadataReceipt, resetMetadataPageTimes } from '../metadataPageTimes.js'

const T0 = Date.parse('2026-11-05T10:00:00Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
const page = (chapter: string, name: string, since: number, process = 'metadata') => ({ chapter, page: name, since: at(since), paused: false, process })
const receipt = (working: object[], done: Record<string, number>) => ({
  series: { Hero: { total: 10, done: 0, workingPages: working } },
  metadata: { Hero: Object.fromEntries(Object.entries(done).map(([chapter, n]) => [chapter, { total: 10, jobs: 10, done: n, eligible: true }])) }
})

describe('metadata page times', () => {
  beforeEach(() => resetMetadataPageTimes())

  it('times a page from its start to the receipt it left the working list in', () => {
    recordMetadataReceipt('a', receipt([page('Chapter 001', 'p1.webp', 0)], { 'Chapter 001': 0 }), T0 + 60_000)
    expect(metadataAverageTook()).toBeNull()
    recordMetadataReceipt('a', receipt([], { 'Chapter 001': 1 }), T0 + 300_000)
    expect(metadataAverageTook()).toBe(300)
  })

  it('counts a page that left while the run goes on, and averages', () => {
    recordMetadataReceipt('a', receipt([page('Chapter 001', 'p1.webp', 0), page('Chapter 001', 'p2.webp', 100)], { 'Chapter 001': 0 }), T0 + 10_000)
    // p1 left, p3 took its tab: the done count comes in a later receipt.
    recordMetadataReceipt('a', receipt([page('Chapter 001', 'p2.webp', 100), page('Chapter 001', 'p3.webp', 200)], { 'Chapter 001': 0 }), T0 + 200_000)
    recordMetadataReceipt('a', receipt([page('Chapter 001', 'p3.webp', 200)], { 'Chapter 001': 2 }), T0 + 500_000)
    expect(metadataAverageTook()).toBe((200 + 400) / 2)
  })

  it('leaves out a stopped run, Image Clipper pages and other phones', () => {
    recordMetadataReceipt('a', receipt([page('Chapter 001', 'p1.webp', 0)], { 'Chapter 001': 0 }), T0)
    recordMetadataReceipt('a', receipt([], { 'Chapter 001': 0 }), T0 + 300_000)
    recordMetadataReceipt('b', receipt([page('Chapter 001', 'p1.webp', 0, 'clipper')], {}), T0)
    recordMetadataReceipt('b', receipt([], {}), T0 + 300_000)
    recordMetadataReceipt('c', receipt([page('Chapter 001', 'p1.webp', 0)], { 'Chapter 001': 0 }), T0)
    recordMetadataReceipt('d', receipt([], { 'Chapter 001': 5 }), T0 + 300_000)
    expect(metadataAverageTook()).toBeNull()
  })
})
