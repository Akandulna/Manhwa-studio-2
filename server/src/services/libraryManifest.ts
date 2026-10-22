import { validControls, type LibraryControl } from './libraryControlModel.js'
/** Wire format shared with Sleeper-Cell's LibrarySync.kt. No source URLs on replicas. */
export interface LibraryChapter {
  id?: string
  name: string
  number: number
  title?: string | null
  key?: string | null
  etag?: string | null
  sentAt?: string
  files?: number
  bytes?: number
  fingerprint?: string | null
}
export interface LibrarySeries { id?: string; folder: string; title: string; sourceSite?: string; chapters: LibraryChapter[] }
export interface LibraryManifest { schema: 'manhwa-library/1'; deviceId: string; device: string; updatedAt: string; series: LibrarySeries[]; controls?: LibraryControl[] }
export const safeSegment = (v: unknown): v is string => typeof v === 'string' && !!v && v !== '.' && v !== '..' && !v.startsWith('.') && !/[/\\\0]/.test(v)

export function parseLibraryManifest(value: unknown): LibraryManifest | null {
  const m = value as LibraryManifest | null
  if (!m || m.schema !== 'manhwa-library/1' || typeof m.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(m.deviceId) ||
      typeof m.updatedAt !== 'string' || !Number.isFinite(Date.parse(m.updatedAt)) || !Array.isArray(m.series) ||
      m.controls !== undefined && !validControls(m.controls)) return null
  if (!m.series.every(s => s && typeof s === 'object' && safeSegment(s.folder) && (s.id === undefined || typeof s.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s.id)) && typeof s.title === 'string' && Array.isArray(s.chapters) &&
      s.chapters.every(c => c && typeof c === 'object' && safeSegment(c.name) && (c.id === undefined || typeof c.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(c.id)) && Number.isFinite(c.number) && c.number >= 0 &&
        (!c.key || (typeof c.key === 'string' && c.key.endsWith(`/manhwa/${s.folder}/${c.name}.zip`) || c.key === `manhwa/${s.folder}/${c.name}.zip`)) &&
        (!c.key || Number.isFinite(Date.parse(c.sentAt ?? '')))))) return null
  return m
}
