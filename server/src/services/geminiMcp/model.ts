/**
 * Gemini MCP narration: what the Studio client sees (no Prisma or Node imports, so the client can import the types).
 */

import type { NarrationLanguage } from '../narrationLanguage.js'

export type JobState = 'queued' | 'preparing' | 'ready' | 'working' | 'saved' | 'attention' | 'failed' | 'cancelled'

export interface GeminiJobView {
  id: string; ref: string; chapterId: string; language: NarrationLanguage
  state: JobState; stage: string; rewrite: boolean; queueOrder: number | null
  uploaded: number; total: number
  /** English: pieces with accepted notes. */
  noted: number
  /** When Gemini started, how long it took (to now while working), rejected submissions and accepted steps. */
  timing: { startedAt: string | null; seconds: number | null; rejected: number; steps: number }
  driveFolderName: string | null; driveFolderUrl: string | null
  lastError: string | null; lastActivityAt: string | null; createdAt: string; finishedAt: string | null
}

export interface GeminiLanguageStatus {
  hasScript: boolean
  scriptStatus: string | null
  job: GeminiJobView | null
  /** Why Process can't start it now, or null. */
  blocked: string | null
}

export interface GeminiChapterRow {
  id: string; number: number; title: string | null; part: number; pages: number
  en: GeminiLanguageStatus
  hi: GeminiLanguageStatus
}

export interface GeminiSeriesRow {
  id: string; title: string; rootFolder: string; createdAt: string
  chapters: number; english: number; hinglish: number; activeJobs: number
}
