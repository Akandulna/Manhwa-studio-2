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
