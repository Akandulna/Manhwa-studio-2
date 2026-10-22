import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ saveStoredTimeline: vi.fn() }))
vi.mock('@/lib/api', () => ({ videoApi2: api }))
import { getTimelineJson, getProcessedJson, resetTimeline } from '../../../client/src/pages/editor2/timelineHandoff'

beforeEach(() => {
  vi.useFakeTimers()
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  })
  api.saveStoredTimeline.mockReset()
  api.saveStoredTimeline.mockImplementation(async (chapterId, language, body) => ({ chapterId, language, ...body }))
  for (const key of ['c', 'c@hi', 'other']) {
    localStorage.setItem(`editor2:timeline-json:${key}`, 'timeline')
    localStorage.setItem(`editor2:processed:${key}`, 'timeline')
    localStorage.setItem(`editor2:model:${key}`, 'model')
  }
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('persists an empty timeline and clears processing only for the selected chapter/language', async () => {
  await resetTimeline('c', 'en')
  expect(getTimelineJson('c', 'en')).toBeNull()
  expect(getProcessedJson('c', 'en')).toBeNull()
  expect(localStorage.getItem('editor2:model:c')).toBeNull()
  expect(getProcessedJson('c', 'hi')).toBe('timeline')
  expect(getProcessedJson('other', 'en')).toBe('timeline')
  expect(api.saveStoredTimeline).toHaveBeenCalledWith('c', 'en', {
    json: '', processedJson: null, updatedAt: expect.any(Number)
  })
  await vi.runAllTimersAsync()
  expect(api.saveStoredTimeline).toHaveBeenCalledTimes(1)
})

it('reports failed persistence instead of claiming reset succeeded', async () => {
  api.saveStoredTimeline.mockRejectedValueOnce(new Error('Offline'))
  await expect(resetTimeline('c', 'en')).rejects.toThrow('Offline')
})

it('preserves and reports a newer server timeline rather than claiming it was reset', async () => {
  api.saveStoredTimeline.mockResolvedValueOnce({ chapterId: 'c', language: 'en', json: 'new', processedJson: 'new', updatedAt: Date.now() + 1000 })
  await expect(resetTimeline('c', 'en')).rejects.toThrow('changed elsewhere')
  expect(getTimelineJson('c', 'en')).toBe('new')
})
