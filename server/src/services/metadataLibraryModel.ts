export type MetadataState = 'pending' | 'partial' | 'complete' | 'blocked'
export interface MetadataPageStatus {
  filename: string
  state: 'pending' | 'complete' | 'invalid'
  reason?: string
  hasMetadata: boolean
}
export interface MetadataChapterStatus {
  id: string
  number: number
  title: string | null
  name: string
  state: MetadataState
  done: number
  total: number
  ready: boolean
  reason?: string
  pages: MetadataPageStatus[]
}
export interface MetadataSeriesStatus {
  id: string
  title: string
  rootFolder: string
  sourceSite: string
  lastActivityAt?: string
  chapters: MetadataChapterStatus[]
}
export interface MetadataSyncReport {
  checkedAt: string | null
  imported: number
  errors: { chapterId: string; reason: string }[]
}
export interface MetadataLibrarySnapshot {
  updatedAt: string
  configured: boolean
  syncing: boolean
  sync: MetadataSyncReport
  series: MetadataSeriesStatus[]
}

/** POST /api/metadata/series/:id/reset-stale (metadataReset.ts). */
export interface MetadataResetChapter {
  chapterId: string
  number: number
  /** Studio pages whose saved metadata was moved aside. */
  studioPages: string[]
  /** R2 result objects deleted (all folders). */
  r2Results: number
  /** Job files republished because they had changed (phones pick these up). */
  republished: boolean
  /** Why the chapter was left alone, when it was. */
  skipped?: string
}

export interface MetadataResetResult {
  seriesId: string
  title: string
  resetAt: string
  chapters: MetadataResetChapter[]
  studioPages: number
  r2Results: number
  republished: number
  phonesAsked: boolean
}
