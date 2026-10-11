import { describe, expect, it } from 'vitest'
import { mergeIndex, type IndexChapter } from '../phoneIndexMerge.js'

const chapter = (name: string, number: number, sentAt: string, extra: Partial<IndexChapter> = {}): IndexChapter => ({
  name,
  number,
  key: sentAt ? `manhwa/S/${name}.zip` : null,
  etag: sentAt ? `mac-${name}` : null,
  sentAt,
  files: 20,
  bytes: 100,
  fingerprint: `fp-${name}`,
  done: false,
  crops: true,
  script: false,
  scriptHi: false,
  published: false,
  cleared: false,
  ...extra
})

const master = (name: string, number: number, sentAt: string, extra: Record<string, unknown> = {}) => ({
  name,
  number,
  key: `manhwa/S/${name}.zip`,
  etag: `master-${name}`,
  sentAt,
  files: 15,
  bytes: 80,
  fingerprint: `m-${name}`,
  done: false,
  crops: false,
  script: false,
  scriptHi: false,
  published: false,
  cleared: false,
  from: 'master',
  ...extra
})

describe('mergeIndex', () => {
  it('keeps the Master’s chapters the desktop does not have', () => {
    const merged = mergeIndex({ chapters: [master('Chapter 003', 3, '2026-10-05T00:00:00.000Z')] }, [
      chapter('Chapter 001', 1, '2026-10-01T00:00:00.000Z')
    ])
    expect(merged.map(c => c.name)).toEqual(['Chapter 001', 'Chapter 003'])
    expect(merged[1].from).toBe('master')
  })

  it('takes the later send’s zip but keeps the desktop’s flags', () => {
    // The desktop never sent chapter 2; the Master did.
    const merged = mergeIndex({ chapters: [master('Chapter 002', 2, '2026-10-05T00:00:00.000Z')] }, [chapter('Chapter 002', 2, '', { crops: true })])
    expect(merged[0].etag).toBe('master-Chapter 002')
    expect(merged[0].crops).toBe(true)
    expect(merged[0].from).toBe('master')
    // The desktop's newer send wins, and its entry carries no "from".
    const newer = mergeIndex({ chapters: [master('Chapter 002', 2, '2026-10-01T00:00:00.000Z')] }, [chapter('Chapter 002', 2, '2026-10-05T00:00:00.000Z')])
    expect(newer[0].etag).toBe('mac-Chapter 002')
    expect('from' in newer[0]).toBe(false)
  })

  it('drops old desktop entries for chapters no longer here, and lets a clear of the same send win', () => {
    const sentAt = '2026-10-05T00:00:00.000Z'
    const merged = mergeIndex(
      { chapters: [chapter('Chapter 009', 9, sentAt), master('Chapter 004', 4, sentAt, { cleared: true, key: null, etag: null })] },
      [chapter('Chapter 004', 4, sentAt, { key: 'manhwa/S/Chapter 004.zip' })]
    )
    expect(merged.map(c => c.name)).toEqual(['Chapter 004'])
    expect(merged[0].cleared).toBe(true)
    expect(merged[0].key).toBeNull()
  })
})
