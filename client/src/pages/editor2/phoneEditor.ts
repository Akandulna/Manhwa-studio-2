/**
 * Editor 2.0 ⇄ the Sleeper-Cell phone (server: services/phoneEditor.ts).
 *
 * Send to phone hands each chapter's script with timeline and crop metadata
 * to the phone, whose Editor 2.0 run makes the timeline JSON in ChatGPT with
 * the Editor 2.0 prompt (put in R2 by Settings on every save); Fetch from
 * phone stores the timelines it made as the chapters' pastes, ready for Start
 * Processing.
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

async function post<T>(endpoint: string, body: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api/video2${endpoint}`, {
    method,
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
  send: (seriesId: string, lang: NarrationLanguage, chapterIds: string[], prompt: string, workflow: 'legacy' | 'staged' = 'legacy') =>
    post<EditorSendResult>(`/series/${seriesId}/send-to-phone?lang=${lang}`, { chapterIds, prompt, workflow }),

  fetch: (seriesId: string, lang: NarrationLanguage) =>
    post<EditorFetchResult>(`/series/${seriesId}/fetch-phone-timelines?lang=${lang}`, {}),

  /** Puts the Editor 2.0 prompt in R2, where the phone fetches it (Settings calls this on every save). */
  savePrompt: (content: string) => post<{ phoneNotified: boolean }>('/prompt', { content }, 'PUT')
}

/**
 * Browser cache of the Editor 2.0 prompt (Settings → Editor 2.0 → Prompt).
 * The desktop database also retains it for browsers without this cache.
 */
export const EDITOR_PROMPT_KEY = 'editor2.prompt'

/** The saved Editor 2.0 prompt, or '' when nothing has been saved here. */
export function readSavedEditorPrompt(): string {
  try {
    const raw = localStorage.getItem(EDITOR_PROMPT_KEY)
    if (!raw) return ''
    const parsed = JSON.parse(raw) as { content?: unknown }
    return typeof parsed.content === 'string' ? parsed.content.trim() : ''
  } catch {
    // Unavailable or corrupt storage just means there is no prompt.
    return ''
  }
}

/** Recover the saved desktop instructions when this browser's cache is empty. */
export async function loadSavedEditorPrompt(): Promise<string> {
  const local = readSavedEditorPrompt()
  if (local) return local
  const response = await fetch('/api/video2/prompt')
  if (!response.ok) throw new Error('Could not load the saved Editor 2.0 prompt. Check Settings → Editor 2.0.')
  const saved = await response.json() as { content?: unknown }
  const content = typeof saved.content === 'string' ? saved.content.trim() : ''
  if (content) {
    try { localStorage.setItem(EDITOR_PROMPT_KEY, JSON.stringify({ content, savedAt: null })) }
    catch { /* Copying still works when browser storage is unavailable. */ }
  }
  return content
}

/** "Chapters 3, 4 and 7", for the toasts. */
export function chapterList(numbers: number[]): string {
  if (numbers.length === 0) return ''
  const label = numbers.length === 1 ? 'Chapter' : 'Chapters'
  if (numbers.length === 1) return `${label} ${numbers[0]}`
  return `${label} ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`
}
