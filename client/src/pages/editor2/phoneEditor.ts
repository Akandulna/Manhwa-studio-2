/**
 * Editor 2.0 ⇄ the Sleeper-Cell phone (server: services/phoneEditor.ts).
 *
 * Send to phone hands each chapter's Copy All text to the phone, whose
 * Editor 2.0 run makes the timeline JSON in ChatGPT; Fetch from phone stores
 * the timelines it made as the chapters' pastes, ready for Start Processing.
 */

import type { NarrationLanguage } from '@/lib/narrationLanguage'

export interface EditorSendResult {
  sent: { chapterId: string; number: number }[]
  skipped: { chapterId: string; number: number; reason: string }[]
  phoneNotified: boolean
}

export interface EditorFetchResult {
  configured: boolean
  found: number
  imported: { chapterId: string; number: number; review: number; model: string | null }[]
  upToDate: number
  kept: { chapterId: string; number: number }[]
  unmatched: string[]
  failed: { key: string; error: string }[]
}

async function post<T>(endpoint: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/video2${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: `Request failed (${response.status} ${response.statusText})` }))
    throw new Error(error.error || error.message || 'Request failed')
  }
  return response.json()
}

export const phoneEditorApi = {
  send: (seriesId: string, lang: NarrationLanguage, chapterIds: string[], prompt: string) =>
    post<EditorSendResult>(`/series/${seriesId}/send-to-phone?lang=${lang}`, { chapterIds, prompt }),

  fetch: (seriesId: string, lang: NarrationLanguage) =>
    post<EditorFetchResult>(`/series/${seriesId}/fetch-phone-timelines?lang=${lang}`, {})
}

/** "Chapters 3, 4 and 7", for the toasts. */
export function chapterList(numbers: number[]): string {
  if (numbers.length === 0) return ''
  const label = numbers.length === 1 ? 'Chapter' : 'Chapters'
  if (numbers.length === 1) return `${label} ${numbers[0]}`
  return `${label} ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`
}
