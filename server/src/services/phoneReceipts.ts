/**
 * Sleeper-Cell can run on several phones at once. Each sends its own three
 * receipts (sync, scripts, crops; see r2Service and phoneSend), each about
 * its own copy of the series. These merge them into one receipt of the same
 * shape, so every page reading a receipt sees the work of all phones:
 *
 * - Progress is merged page by page and chapter by chapter, keeping the
 *   furthest state any phone reached (a page clipped on one phone is done),
 *   so phones working on different chapters add up, and the same chapters on
 *   both are not counted twice.
 * - What is going on (pages Auto-run is on, narration and voiceover runs,
 *   ChatGPT and Gemini accounts, finished pages) is listed from every phone,
 *   each item tagged with the phone it is on: `device` (its id) and `phone`
 *   (its name).
 * - Downloads are the other way round: a chapter is on the phones only once
 *   every phone has it, and cleared only once every phone has cleared it, so
 *   its zip isn't deleted from R2 while a phone still needs it.
 *
 * With one phone the receipt is passed on as it is, only tagged.
 */

type Obj = Record<string, unknown>

/** One phone's receipt. `device` is "" for Sleeper-Cell builds from before phones had an id. */
export interface PhoneReceipt<T extends object = Obj> {
  device: string
  /** The phone's name, as the desktop shows it. */
  name: string
  body: T
}

function isObject(value: unknown): value is Obj {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function objectAt(parent: unknown, key: string): Obj {
  return isObject(parent) && isObject(parent[key]) ? parent[key] : {}
}

function time(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) || 0 : 0
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** The receipt-wide fields: when, the request answered (the newest receipt's), and every phone's name. */
function header(list: PhoneReceipt<Obj>[]): Obj {
  const newest = [...list].sort((a, b) => time(b.body.updatedAt) - time(a.body.updatedAt))[0]
  return {
    ...(newest.body.version !== undefined ? { version: newest.body.version } : {}),
    device: list.length === 1 ? (newest.body.device ?? newest.name) : list.map(r => r.name).join(' + '),
    ...(newest.body.updatedAt !== undefined ? { updatedAt: newest.body.updatedAt } : {}),
    ...(newest.body.answers !== undefined ? { answers: newest.body.answers } : {})
  }
}

function tag(item: unknown, receipt: PhoneReceipt<Obj>): unknown {
  return isObject(item) ? { ...item, device: receipt.device, phone: receipt.name } : item
}

/** The higher-ranked of two states; unknown states rank lowest. */
function furthest(ranks: string[], a: unknown, b: unknown): unknown {
  return ranks.indexOf(String(b)) > ranks.indexOf(String(a)) ? b : a
}

/** Every key of the same object in each receipt, in first-seen order. */
function keysOf(objects: Obj[]): string[] {
  return [...new Set(objects.flatMap(o => Object.keys(o)))]
}

// ─── Crops (ClipperReceipt.kt) ──────────────────────────────────────────────

const PAGE_RANK = ['changed', 'in_progress', 'done']

/** A series entry's pages in progress, tagged; older phone builds send only `working`. */
function taggedWorking(entry: Obj, receipt: PhoneReceipt<Obj>): unknown[] {
  const working = Array.isArray(entry.workingPages) ? entry.workingPages : entry.working ? [entry.working] : []
  return working.map(w => tag(w, receipt))
}

/** One phone's series entry, with its pages in progress and finished pages tagged. */
function tagCropsSeries(entry: Obj, receipt: PhoneReceipt<Obj>): Obj {
  const workingPages = taggedWorking(entry, receipt)
  const chapters: Obj = {}
  for (const [folder, chapter] of Object.entries(objectAt(entry, 'chapters'))) {
    if (!isObject(chapter)) continue
    const finished: Obj = {}
    for (const [page, finish] of Object.entries(objectAt(chapter, 'finished'))) finished[page] = tag(finish, receipt)
    chapters[folder] = { ...chapter, ...(isObject(chapter.finished) ? { finished } : {}) }
  }
  const tagged: Obj = { ...entry, chapters }
  delete tagged.working
  delete tagged.workingPages
  if (workingPages.length) {
    tagged.working = workingPages[0]
    tagged.workingPages = workingPages
  }
  return tagged
}

function mergeCropsChapter(entries: Obj[]): Obj {
  const pages: Obj = {}
  const finished: Obj = {}
  let zip: Obj | null = null
  for (const chapter of entries) {
    const own = objectAt(chapter, 'pages')
    for (const [page, state] of Object.entries(own)) pages[page] = page in pages ? furthest(PAGE_RANK, pages[page], state) : state
    // A page's finish comes from a phone where it is done; the newest when several are.
    for (const [page, finish] of Object.entries(objectAt(chapter, 'finished'))) {
      if (own[page] !== 'done') continue
      if (!(page in finished) || time((finish as Obj)?.at) > time((finished[page] as Obj)?.at)) finished[page] = finish
    }
    const z = chapter.zip
    if (isObject(z) && (!zip || time(z.uploadedAt) > time(zip.uploadedAt))) zip = z
  }
  return {
    total: Math.max(...entries.map(c => count(c.total))),
    done: Object.values(pages).filter(state => state === 'done').length,
    pages,
    ...(Object.keys(finished).length ? { finished } : {}),
    ...(zip ? { zip } : {})
  }
}

function mergeGemini(list: PhoneReceipt<Obj>[], key: 'speech' | 'narration'): Obj | null {
  const usages = list.filter(r => isObject(r.body[key]))
  if (!usages.length) return null
  const first = usages[0].body[key] as Obj
  return {
    ...first,
    profiles: usages.flatMap(r => {
      const usage = r.body[key] as Obj
      return (Array.isArray(usage.profiles) ? usage.profiles : []).map(p => taggedProfile(p, r, list.length > 1))
    })
  }
}

/** A ChatGPT or Gemini profile, tagged; its id made unique across phones when there are several. */
function taggedProfile(profile: unknown, receipt: PhoneReceipt<Obj>, several: boolean): unknown {
  if (!isObject(profile)) return profile
  const tagged = tag(profile, receipt) as Obj
  if (several && typeof profile.id === 'string') tagged.id = `${receipt.device}:${profile.id}`
  return tagged
}

/**
 * The crops receipts as one. Per series: totals are the most pages any phone
 * has; done counts pages done on any phone. Pages in progress, finished pages
 * and accounts are tagged with their phone. `automation` is per phone, so it
 * is left as the first phone's; the overview reads each phone's own.
 */
export function mergeCropsReceipts(list: PhoneReceipt<Obj>[]): Obj {
  if (!list.length) return {}
  const several = list.length > 1
  const series: Obj = {}
  for (const folder of keysOf(list.map(r => objectAt(r.body, 'series')))) {
    const holders = list.filter(r => isObject(objectAt(r.body, 'series')[folder]))
    const tagged = holders.map(r => tagCropsSeries(objectAt(r.body, 'series')[folder] as Obj, r))
    if (tagged.length === 1) {
      series[folder] = tagged[0]
      continue
    }
    const chapters: Obj = {}
    for (const chapter of keysOf(tagged.map(e => objectAt(e, 'chapters')))) {
      chapters[chapter] = mergeCropsChapter(tagged.map(e => objectAt(e, 'chapters')[chapter]).filter(isObject))
    }
    const workingPages = tagged.flatMap(e => (Array.isArray(e.workingPages) ? e.workingPages : []))
    series[folder] = {
      total: Math.max(...tagged.map(e => count(e.total))),
      done: Object.values(chapters).reduce((sum: number, c) => sum + count((c as Obj).done), 0),
      chapters,
      ...(workingPages.length ? { working: workingPages[0], workingPages } : {})
    }
  }
  const merged: Obj = { ...header(list), series }
  const profiles = list.flatMap(r => (Array.isArray(r.body.profiles) ? r.body.profiles.map(p => taggedProfile(p, r, several)) : []))
  if (list.some(r => Array.isArray(r.body.profiles))) merged.profiles = profiles
  for (const key of ['speech', 'narration'] as const) {
    const usage = mergeGemini(list, key)
    if (usage) merged[key] = usage
  }
  const automation = list.find(r => isObject(r.body.automation))?.body.automation
  if (automation) merged.automation = automation
  return merged
}

// ─── Scripts (ScriptReceipt.kt) ─────────────────────────────────────────────

const SCRIPT_RANK = ['stale', 'needs_summary', 'done']
const HINGLISH_RANK = ['stale', 'review', 'done']

/** Chapters by folder, each the furthest any phone got, with that phone's `savedAt`. */
function mergeScriptChapters(entries: Obj[], ranks: string[]): Obj {
  const chapters: Obj = {}
  for (const entry of entries) {
    for (const [folder, chapter] of Object.entries(objectAt(entry, 'chapters'))) {
      if (!isObject(chapter)) continue
      const held = chapters[folder] as Obj | undefined
      const better = !held || ranks.indexOf(String(chapter.status)) > ranks.indexOf(String(held.status)) ||
        (chapter.status === held.status && time(chapter.savedAt) > time(held.savedAt))
      if (better) chapters[folder] = chapter
    }
  }
  return chapters
}

function newest(values: unknown[]): unknown {
  return values.filter(v => typeof v === 'string').sort((a, b) => time(b) - time(a))[0]
}

/**
 * The scripts receipts as one. Per series: chapters are the furthest any
 * phone got (done over needing a summary over stale), totals the most
 * chapters any phone has. Runs are listed from every phone, tagged.
 */
export function mergeScriptsReceipts(list: PhoneReceipt<Obj>[]): Obj {
  if (!list.length) return {}
  const series: Obj = {}
  for (const folder of keysOf(list.map(r => objectAt(r.body, 'series')))) {
    const entries = list.map(r => objectAt(r.body, 'series')[folder]).filter(isObject)
    if (entries.length === 1) {
      series[folder] = entries[0]
      continue
    }
    const chapters = mergeScriptChapters(entries, SCRIPT_RANK)
    const merged: Obj = {
      total: Math.max(...entries.map(e => count(e.total))),
      done: Object.values(chapters).filter(c => (c as Obj).status === 'done').length,
      chapters
    }
    const uploadedAt = newest(entries.map(e => e.uploadedAt))
    if (uploadedAt) merged.uploadedAt = uploadedAt
    const hinglish = entries.map(e => e.hi).filter(isObject)
    if (hinglish.length) {
      const hiChapters = mergeScriptChapters(hinglish, HINGLISH_RANK)
      const hiUploadedAt = newest(hinglish.map(h => h.uploadedAt))
      merged.hi = {
        total: Math.max(...hinglish.map(h => count(h.total))),
        // Like the phone's: review counts as converted.
        done: Object.values(hiChapters).filter(c => ['done', 'review'].includes(String((c as Obj).status))).length,
        ...(hiUploadedAt ? { uploadedAt: hiUploadedAt } : {}),
        chapters: hiChapters
      }
    }
    series[folder] = merged
  }
  const merged: Obj = { ...header(list), series }
  if (list.some(r => Array.isArray(r.body.runs))) {
    merged.runs = list.flatMap(r => (Array.isArray(r.body.runs) ? r.body.runs.map(run => tag(run, r)) : []))
  }
  return merged
}

// ─── Downloads (ManhwaSync.kt, receipt v2) ──────────────────────────────────

/**
 * The sync receipts as one, for what Send to phone does next. Per chapter:
 * - cleared once every phone has cleared it (the earliest clear, so a clear
 *   from before the chapter was sent again doesn't count);
 * - otherwise on the phones only when every phone that hasn't cleared it has
 *   it: the oldest copy when they differ (so a phone behind shows as
 *   outdated), downloading while any phone still is.
 * Phones sending version 1 (whole-series zips) know no chapters and are left out.
 */
export function mergeSyncReceipts(list: PhoneReceipt<Obj>[]): Obj {
  const phones = list.filter(r => r.body.version === 2 && isObject(r.body.series))
  if (phones.length <= 1) return phones[0]?.body ?? list[0]?.body ?? {}
  const series: Obj = {}
  for (const folder of keysOf(phones.map(r => objectAt(r.body, 'series')))) {
    const entries = phones.map(r => objectAt(r.body, 'series')[folder]).map(e => (isObject(e) ? e : {}))
    const chapters: Obj = {}
    const cleared: Obj = {}
    for (const chapter of keysOf(entries.flatMap(e => [objectAt(e, 'chapters'), objectAt(e, 'cleared')]))) {
      const clears = entries.map(e => objectAt(e, 'cleared')[chapter])
      const holding = entries.filter((_, i) => !isObject(clears[i]))
      if (!holding.length) {
        cleared[chapter] = [...clears].sort((a, b) => time((a as Obj).at) - time((b as Obj).at))[0]
        continue
      }
      const copies = holding.map(e => objectAt(e, 'chapters')[chapter])
      if (!copies.every(isObject)) continue
      const oldest = [...(copies as Obj[])].sort((a, b) => time(a.sentAt) - time(b.sentAt))[0]
      const downloading = (copies as Obj[]).some(c => c.state === 'downloading')
      chapters[chapter] = { ...oldest, ...(downloading ? { state: 'downloading' } : {}) }
    }
    series[folder] = { chapters, cleared }
  }
  const prefix = phones.find(r => typeof r.body.prefix === 'string')?.body.prefix
  return { ...header(phones), version: 2, ...(prefix !== undefined ? { prefix } : {}), series }
}
