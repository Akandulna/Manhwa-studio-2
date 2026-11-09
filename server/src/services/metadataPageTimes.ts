/**
 * How long the phones' Metadata run takes per page, measured here: the phones
 * report when each Metadata page started (its working page's `since`) but keep
 * no finish times, unlike Image Clipper's `finished`. Each crops receipt is
 * compared with that phone's last one; a Metadata page that left the working
 * list counts as finished when its chapter's metadata `done` count rose or the
 * run is still on other Metadata pages (a stopped run's pages are left out).
 *
 * Kept in memory only: after Studio starts, Live Progress has no Metadata
 * average until the first page finishes. index.ts feeds it every crops receipt.
 */
/** The average is read over this many recent pages, as Live Progress does for Image Clipper. */
const AVERAGE_OVER = 20
/** Shorter than this is a page that was already done; longer, a dead run (the server's WORKING_STALE_MS). */
const MIN_TOOK_S = 15
const MAX_TOOK_S = 45 * 60

interface Seen {
  /** `<series>/<chapter>/<page>` → when the phone started it (ms). */
  working: Map<string, { series: string; chapter: string; since: number }>
  /** `<series>/<chapter>` → metadata pages done. */
  done: Map<string, number>
}

const seen = new Map<string, Seen>()
/** Seconds per finished Metadata page, oldest first. */
const took: number[] = []

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Reads one crops receipt from `device`: its Metadata working pages and metadata done counts. */
function read(body: object): Seen {
  const working: Seen['working'] = new Map()
  const done: Seen['done'] = new Map()
  const receipt = body as Record<string, unknown>
  for (const [series, entry] of Object.entries(isObject(receipt.series) ? receipt.series : {})) {
    if (!isObject(entry)) continue
    const pages = Array.isArray(entry.workingPages) ? entry.workingPages : entry.working ? [entry.working] : []
    for (const w of pages) {
      if (!isObject(w) || w.process !== 'metadata' || typeof w.chapter !== 'string' || typeof w.page !== 'string') continue
      const since = typeof w.since === 'string' ? Date.parse(w.since) : NaN
      if (!Number.isNaN(since)) working.set(`${series}/${w.chapter}/${w.page}`, { series, chapter: w.chapter, since })
    }
  }
  for (const [series, chapters] of Object.entries(isObject(receipt.metadata) ? receipt.metadata : {})) {
    if (!isObject(chapters)) continue
    for (const [chapter, progress] of Object.entries(chapters)) {
      if (isObject(progress) && Number.isFinite(Number(progress.done))) done.set(`${series}/${chapter}`, Number(progress.done))
    }
  }
  return { working, done }
}

/** Takes in a phone's crops receipt, received at `now` (ms). */
export function recordMetadataReceipt(device: string, body: object, now = Date.now()): void {
  const next = read(body)
  const last = seen.get(device)
  seen.set(device, next)
  if (!last) return
  const stillRunning = next.working.size > 0
  for (const [key, page] of last.working) {
    if (next.working.has(key)) continue
    const chapter = `${page.series}/${page.chapter}`
    const rose = (next.done.get(chapter) ?? 0) > (last.done.get(chapter) ?? 0)
    if (!rose && !stillRunning) continue
    const seconds = (now - page.since) / 1000
    if (seconds < MIN_TOOK_S || seconds > MAX_TOOK_S) continue
    took.push(seconds)
    if (took.length > AVERAGE_OVER) took.shift()
  }
}

/** The average seconds per Metadata page over the recent ones; null before any finished since Studio started. */
export function metadataAverageTook(): number | null {
  return took.length ? took.reduce((sum, s) => sum + s, 0) / took.length : null
}

/** Forgets every measurement (tests). */
export function resetMetadataPageTimes(): void {
  seen.clear()
  took.length = 0
}
