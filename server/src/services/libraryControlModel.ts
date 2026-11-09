import { safeSegment } from './libraryManifest.js'
import { NARRATION_LANGUAGES, type NarrationLanguage } from './narrationLanguage.js'

export interface LibraryDecision { at: number; deviceId: string; done: boolean }
/** seriesDone is the user's manual Done mark for one narration language's series. */
export interface LibraryControl { folder: string; deleted?: LibraryDecision; archived?: LibraryDecision; restart?: LibraryDecision; parts?: Record<string, LibraryDecision>; seriesDone?: Partial<Record<NarrationLanguage, LibraryDecision>> }
const decision = (v: any): v is LibraryDecision => !!v && Number.isSafeInteger(v.at) && v.at > 0 &&
  typeof v.deviceId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v.deviceId) && typeof v.done === 'boolean'
export function validControls(value: unknown): value is LibraryControl[] {
  return Array.isArray(value) && value.every(c => c && safeSegment(c.folder) &&
    (c.deleted === undefined || decision(c.deleted) && c.deleted.done) &&
    (c.archived === undefined || decision(c.archived)) &&
    (c.restart === undefined || decision(c.restart) && c.restart.done) &&
    (c.parts === undefined || c.parts && typeof c.parts === 'object' && !Array.isArray(c.parts) &&
      Object.entries(c.parts).every(([n, d]) => /^[1-9]\d{0,4}$/.test(n) && decision(d))) &&
    (c.seriesDone === undefined || c.seriesDone && typeof c.seriesDone === 'object' && !Array.isArray(c.seriesDone) &&
      Object.entries(c.seriesDone).every(([lang, d]) => (NARRATION_LANGUAGES as string[]).includes(lang) && decision(d))))
}
const latest = (a?: LibraryDecision, b?: LibraryDecision) => !a ? b : !b ? a :
  b.at > a.at || b.at === a.at && (b.deviceId > a.deviceId || b.deviceId === a.deviceId && !b.done) ? b : a
export function mergeControl(a: LibraryControl, b: LibraryControl): LibraryControl {
  const parts: Record<string, LibraryDecision> = { ...a.parts }
  for (const [n, d] of Object.entries(b.parts ?? {})) parts[n] = latest(parts[n], d)!
  const seriesDone: Partial<Record<NarrationLanguage, LibraryDecision>> = { ...a.seriesDone }
  for (const [lang, d] of Object.entries(b.seriesDone ?? {}) as [NarrationLanguage, LibraryDecision][]) seriesDone[lang] = latest(seriesDone[lang], d)!
  return { folder: a.folder, ...(a.deleted || b.deleted ? { deleted: latest(a.deleted, b.deleted) } : {}), ...(a.archived || b.archived ? { archived: latest(a.archived, b.archived) } : {}), ...(a.restart || b.restart ? { restart: latest(a.restart, b.restart) } : {}), ...(Object.keys(parts).length ? { parts } : {}), ...(Object.keys(seriesDone).length ? { seriesDone } : {}) }
}
/** Match a whole series directory, never similarly named series or unrelated objects. */
export function isSeriesObject(key: string, folder: string): boolean {
  const segments = key.split('/')
  const i = segments.findIndex(kind => ['manhwa', 'scripts', 'crops', 'metadata', 'metadata-jobs', 'voiceover', 'editor'].includes(kind))
  return i >= 0 && segments[i + 1] === folder && segments.length > i + 2 ||
    segments.at(-1) === `${folder}.zip`
}
