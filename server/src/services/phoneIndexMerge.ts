/**
 * A series' phone index (`<phone folder><Series>/index.json`) has two writers:
 * this server (phoneSend.ts) and the Master phone (Sleeper-Cell's
 * PhoneIndex.kt, which sends chapters it downloaded). Neither replaces it:
 * each merges its own entries into what is in R2, so the phones fetch both.
 *
 *   - A chapter only one side sent keeps that side's zip. Entries the Master
 *     wrote (`from: "master"`) for chapters this library doesn't have are kept;
 *     other entries for chapters no longer here are dropped, as before.
 *   - A chapter both sent: the later send's zip fields win (key, etag, sentAt,
 *     files, bytes, fingerprint, cleared, from); a clear wins over the same
 *     send not cleared.
 *   - The desktop's own fields (number, done, crops, script, scriptHi,
 *     published) are always the desktop's: only it knows them.
 *
 * Keep in step with PhoneIndex.kt in Sleeper-Cell.
 */

export const FROM_MASTER = 'master'

export interface IndexChapter {
  name: string
  number: number
  key: string | null
  etag: string | null
  sentAt: string
  files: number
  bytes: number
  fingerprint: string | null
  done: boolean
  crops: boolean
  script: boolean
  scriptHi: boolean
  published: boolean
  cleared: boolean
  /** Who sent the zip: "master" for the Master phone; left out for this server. */
  from?: string
}

type Entry = Record<string, unknown>

const TRANSPORT = ['key', 'etag', 'sentAt', 'files', 'bytes', 'fingerprint', 'cleared', 'from'] as const

function isObject(value: unknown): value is Entry {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function time(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) || 0 : 0
}

/** The entries of the index in R2 (or of nothing), by chapter name. */
export function indexEntries(existing: unknown): Map<string, Entry> {
  const entries = new Map<string, Entry>()
  const list = isObject(existing) && Array.isArray(existing.chapters) ? existing.chapters : []
  for (const entry of list) {
    if (isObject(entry) && typeof entry.name === 'string' && entry.name) entries.set(entry.name, entry)
  }
  return entries
}

/** The desktop's index chapters with the Master's entries in R2 merged in, in reading order. */
export function mergeIndex(existing: unknown, own: IndexChapter[]): Entry[] {
  const theirs = indexEntries(existing)
  const merged: Entry[] = own.map(chapter => {
    const other = theirs.get(chapter.name)
    if (!other) return { ...chapter }
    const ours = time(chapter.sentAt)
    const their = time(other.sentAt)
    const otherWins = their > ours || (their === ours && their > 0 && other.cleared === true && !chapter.cleared)
    if (!otherWins) return { ...chapter }
    const result: Entry = { ...chapter }
    for (const field of TRANSPORT) {
      if (field in other) result[field] = other[field]
      else delete result[field]
    }
    return result
  })
  const names = new Set(own.map(c => c.name))
  for (const [name, entry] of theirs) {
    if (!names.has(name) && entry.from === FROM_MASTER) merged.push(entry)
  }
  const number = (e: Entry) => (typeof e.number === 'number' ? e.number : Number.MAX_VALUE)
  return merged.sort((a, b) => number(a) - number(b) || String(a.name).localeCompare(String(b.name)))
}
