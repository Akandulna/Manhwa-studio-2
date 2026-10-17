/**
 * Splitting a run between the phones: Run automation's "Split across N", for
 * Image Clipper, Editor 2.0 timelines and Voiceover. Never Narration scripts:
 * each chapter's prompt goes on from the previous chapter's summary, so one
 * phone writes a series' chapters in order (NARRATION_ONE_PHONE).
 *
 * It's two steps, so a split never steps on what a phone is already doing:
 * first planSplit says which phone gets which chapters (Run automation shows it
 * to confirm), then sendAutomationCommand (r2Service.ts) sends each phone its
 * share, exactly as confirmed. Each phone is read from its own receipts:
 *
 * - busy with something else (another run, or this run on another series, paused
 *   or not): left out, untouched, with the reason shown.
 * - busy with this run on this series: keeps the chapters it's on, and gets the
 *   same start with its new share, which a build saying `automation.rescope`
 *   takes as its run's new scope without restarting ("rescope"). Older builds
 *   would start over on the whole series, so the plan refuses them.
 * - free: gets a share ("start").
 *
 * Then the chapters left (per run, below) go out in reading order, each to the
 * phone that may take it with the least work so far (its pages), ties to the
 * phone with fewer chapters to pick from. Keep in step with splitRunChapters
 * and splitChapters in the phone's MasterCommands.kt.
 */

import path from 'path'
import { prisma } from '../index.js'
import { LANGUAGE_NAMES, type NarrationLanguage } from './narrationLanguage.js'
import { mergeCropsReceipts } from './phoneReceipts.js'
import { relayReceipts } from './phoneRelay.js'
import { filterReplacedCropFacts } from './chapterPageReplacement.js'
import { parseScriptRuns, RUN_LABEL, startablePhones, WORKING_STALE_MS, type PhoneRunKind } from './r2Service.js'

type Obj = Record<string, unknown>

function isObject(value: unknown): value is Obj {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function objectAt(parent: unknown, key: string): Obj {
  return isObject(parent) && isObject(parent[key]) ? parent[key] : {}
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** A time as the phone writes it, in ms; 0 when missing (Times.parseOrNull(…) ?: 0 on the phone). */
function millis(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) || 0 : 0
}

/** One phone that could take a share, with its own receipts (bodies), as the relay keeps them. */
export interface SplitPhone {
  id: string
  name: string
  automation: Obj | null
  sync: Obj | null
  scripts: Obj | null
  crops: Obj | null
}

/** A chapter of the series in the library: its folder, number and pages. */
export interface SplitChapter {
  folder: string
  number: number | null
  pageCount: number | null
}

export type SplitAction = 'start' | 'rescope' | 'finish' | 'skip'

export interface SplitTarget {
  device: string
  name: string
  /** Its whole share in reading order: the chapters it's on (inProgress) and those it's given. Empty for a skip or finish. */
  chapters: string[]
  /** The chapters it's on now: kept in its share, unless another phone is on the same one too (then it finishes what it's on of it). */
  inProgress: string[]
  /**
   * start: a free phone starts on `chapters`. rescope: a phone already on this run takes `chapters` as its new
   * scope. finish: a phone already on this run with nothing left for it finishes what it's on (run_finish).
   * skip: left alone (busy with something else, or nothing for it).
   */
  action: SplitAction
  reason?: string
}

export interface SplitPlan {
  kind: PhoneRunKind
  seriesId: string
  /** The series folder, as the phones name it. */
  series: string
  language: NarrationLanguage
  targets: SplitTarget[]
  /** Chapter numbers by folder, for showing the shares ("Ch 1–4, 7"). */
  numbers: Record<string, number>
}

/** What a phone is doing, as far as this split goes. */
export type SplitState =
  | { state: 'idle' }
  | { state: 'busySame'; inProgress: string[] }
  | { state: 'busyOther'; reason: string }

/** Image Clipper's pages in progress on a phone, by series folder (stale ones dropped, as on Live Progress). */
function clipperWorking(crops: Obj | null, now: number): Map<string, string[]> {
  const bySeries = new Map<string, string[]>()
  for (const [series, entry] of Object.entries(objectAt(crops, 'series'))) {
    if (!isObject(entry)) continue
    const list = Array.isArray(entry.workingPages) ? entry.workingPages : entry.working ? [entry.working] : []
    const chapters = list
      .filter((w): w is Obj => isObject(w) && typeof w.chapter === 'string' && !!w.chapter && typeof w.page === 'string' && !!w.page)
      .filter(w => !(typeof w.since === 'string' && now - Date.parse(w.since) > WORKING_STALE_MS))
      .map(w => w.chapter as string)
    if (chapters.length) bySeries.set(series, [...new Set(chapters)])
  }
  return bySeries
}

/**
 * A scripts run's language: the run's own `language` when the phone says it,
 * else its tabs', else null (not known). Narration's runs do both languages.
 */
function runLanguage(raw: unknown): NarrationLanguage | null {
  if (!isObject(raw)) return null
  if (raw.language === 'en' || raw.language === 'hi') return raw.language
  const tab = (Array.isArray(raw.tabs) ? raw.tabs : []).find(t => isObject(t) && (t.language === 'en' || t.language === 'hi'))
  return isObject(tab) ? tab.language as NarrationLanguage : null
}

/**
 * How a phone stands for splitting `kind` on `series`: see the top of this
 * file. An Editor 2.0 or voiceover run on this series in the other language is
 * something else; one whose language isn't known counts as this run, so it's
 * rescoped rather than left going over the whole series.
 */
export function splitState(kind: PhoneRunKind, series: string, language: NarrationLanguage, phone: SplitPhone, now = Date.now()): SplitState {
  const raws = Array.isArray(phone.scripts?.runs) ? phone.scripts!.runs as unknown[] : []
  const runs = raws.flatMap(raw => parseScriptRuns([raw], now).map(run => ({ ...run, language: runLanguage(raw) })))
  const working = clipperWorking(phone.crops, now)
  const busy = (label: string, on: string, paused = false) => ({ state: 'busyOther' as const, reason: `busy: ${label} · ${on}${paused ? ' (paused)' : ''}` })
  if (kind === 'clipper') {
    const run = runs[0]
    if (run) return busy(RUN_LABEL[run.kind], run.series, run.paused)
    const other = [...working.keys()].find(s => s !== series)
    if (other) return busy(RUN_LABEL.clipper, other)
    const here = working.get(series)
    return here ? { state: 'busySame', inProgress: here } : { state: 'idle' }
  }
  const clipping = [...working.keys()][0]
  if (clipping !== undefined) return busy(RUN_LABEL.clipper, clipping)
  const isThis = (r: (typeof runs)[number]) =>
    r.kind === kind && r.series === series && (kind === 'narration' || r.language === null || r.language === language)
  const other = runs.find(r => !isThis(r))
  if (other) {
    const inLanguage = other.kind !== 'narration' && other.language ? ` (${LANGUAGE_NAMES[other.language]})` : ''
    return busy(RUN_LABEL[other.kind], `${other.series}${inLanguage}`, other.paused)
  }
  const same = runs.filter(isThis)
  if (!same.length) return { state: 'idle' }
  return { state: 'busySame', inProgress: [...new Set(same.flatMap(r => r.tabs.map(t => t.chapter)))] }
}

/** It takes a `chapters` list for `kind`: Image Clipper always; the others from builds listing them in `chapterRuns`. */
export function takesChapters(kind: PhoneRunKind, automation: Obj | null): boolean {
  if (kind === 'clipper') return true
  const runs = automation?.chapterRuns
  if (Array.isArray(runs)) return runs.includes(kind)
  // Builds from before `chapterRuns` took a share of Editor 2.0 when they said its tabs.
  return kind === 'editor' && isObject(automation?.editor)
}

/** A chapter a split can give out, with the phones that may take it (null: any of them). */
export interface SplitCandidate {
  chapter: string
  eligible: string[] | null
}

/** Reading order: the library's chapter number, then the folder name for chapters it doesn't know. */
function reading(chapters: SplitChapter[]): (a: string, b: string) => number {
  const numbers = new Map(chapters.map(c => [c.folder, c.number]))
  return (a, b) => {
    const x = numbers.get(a) ?? null
    const y = numbers.get(b) ?? null
    if (x !== null && y !== null && x !== y) return x - y
    if (x === null && y !== null) return 1
    if (x !== null && y === null) return -1
    return a.localeCompare(b)
  }
}

const SCRIPT_READY = new Set(['done', 'needs_summary', 'review'])
const VOICED = new Set(['voiced', 'uploaded'])

/**
 * Voiceover: a phone may take a chapter whose script it has in the language
 * (status done, needs_summary or review; Hindi from `hi`), and only when its
 * copy is the newest any phone has (savedAt). A chapter whose newest copy is
 * voiced or uploaded already is left out: an older phone's finished audio must
 * not hide a newer script on another phone.
 */
export function voiceoverCandidates(series: string, language: NarrationLanguage, devices: string[], phones: SplitPhone[], chapters: SplitChapter[]): {
  candidates: SplitCandidate[]; available: Map<string, number>
} {
  const scriptsOf = (phone: SplitPhone | undefined): Obj => {
    const entry = objectAt(objectAt(phone?.scripts, 'series'), series)
    return objectAt(language === 'hi' ? objectAt(entry, 'hi') : entry, 'chapters')
  }
  const own = new Map(phones.map(p => [p.id, p]))
  const available = new Map(devices.map(d => {
    const list = scriptsOf(own.get(d))
    return [d, new Set(Object.keys(list).filter(c => SCRIPT_READY.has(String(objectAt(list, c).status))))]
  }))
  const progress = new Map<string, Obj[]>()
  for (const phone of phones) {
    for (const [chapter, entry] of Object.entries(scriptsOf(phone))) {
      if (isObject(entry)) progress.set(chapter, [...(progress.get(chapter) ?? []), entry])
    }
  }
  const latest = new Map([...progress].map(([chapter, entries]) => [chapter, Math.max(...entries.map(e => millis(e.savedAt)))]))
  const voiced = new Set([...progress]
    .filter(([chapter, entries]) => entries.some(e => millis(e.savedAt) === latest.get(chapter) && VOICED.has(String(objectAt(e, 'voiceover').status))))
    .map(([chapter]) => chapter))
  const all = [...new Set([...available.values()].flatMap(s => [...s]))].filter(c => !voiced.has(c)).sort(reading(chapters))
  return {
    candidates: all.map(chapter => ({
      chapter,
      eligible: devices.filter(d => available.get(d)!.has(chapter) && millis(objectAt(scriptsOf(own.get(d)), chapter).savedAt) === (latest.get(chapter) ?? 0))
    })),
    available: new Map([...available].map(([d, s]) => [d, s.size]))
  }
}

/**
 * Image Clipper: the chapters the phones have downloaded (when they report
 * downloads), in the library's reading order, not every page of which has its
 * crop JSON on some phone. Weighs each by its pages left.
 */
export function clipperCandidates(series: string, syncs: Obj[], crops: Obj[], chapters: SplitChapter[]): {
  candidates: SplitCandidate[]; pagesLeft: Map<string, number>
} {
  const merged = mergeCropsReceipts(crops.map((body, i) => ({ device: String(i), name: String(i), body })))
  const progress = objectAt(objectAt(objectAt(merged, 'series'), series), 'chapters')
  const downloaded = new Set<string>()
  for (const body of syncs) for (const chapter of Object.keys(objectAt(objectAt(objectAt(body, 'series'), series), 'chapters'))) downloaded.add(chapter)
  const candidates: SplitCandidate[] = []
  const pagesLeft = new Map<string, number>()
  const order = reading(chapters)
  for (const chapter of [...chapters].sort((a, b) => order(a.folder, b.folder))) {
    const phone = objectAt(progress, chapter.folder)
    const total = count(phone.total) || chapter.pageCount || 0
    const done = count(phone.done)
    pagesLeft.set(chapter.folder, Math.max(0, total - done))
    if (downloaded.size && !downloaded.has(chapter.folder)) continue
    if (total > 0 && done >= total) continue
    candidates.push({ chapter: chapter.folder, eligible: null })
  }
  return { candidates, pagesLeft }
}

/**
 * Shares `candidates` out between `phones` (each with the chapters pinned to
 * it, which count toward its load and aren't given again): in order, each to
 * the eligible phone with the least load, ties to fewer chapters available.
 * Returns the chapters each is given, besides its pinned ones.
 */
export function assignSplit(
  candidates: SplitCandidate[],
  phones: { id: string; pinned: string[] }[],
  weight: (chapter: string) => number,
  available?: Map<string, number>
): Map<string, string[]> {
  const pinned = new Set(phones.flatMap(p => p.pinned))
  const left = candidates.filter(c => !pinned.has(c.chapter))
  const load = new Map(phones.map(p => [p.id, p.pinned.reduce((sum, c) => sum + weight(c), 0)]))
  const choices = available ?? new Map(phones.map(p => [p.id, left.filter(c => !c.eligible || c.eligible.includes(p.id)).length]))
  const shares = new Map(phones.map(p => [p.id, [] as string[]]))
  for (const candidate of left) {
    const eligible = phones.map(p => p.id).filter(id => !candidate.eligible || candidate.eligible.includes(id))
    if (!eligible.length) continue
    const lightest = eligible.reduce((a, b) => {
      const byLoad = load.get(b)! - load.get(a)!
      if (byLoad !== 0) return byLoad < 0 ? b : a
      return (choices.get(b) ?? 0) < (choices.get(a) ?? 0) ? b : a
    })
    shares.get(lightest)!.push(candidate.chapter)
    load.set(lightest, load.get(lightest)! + weight(candidate.chapter))
  }
  return shares
}

/** Narration scripts are never split: each chapter's prompt goes on from the one before's summary. */
export const NARRATION_ONE_PHONE = 'Narration scripts run on one phone at a time: start it on one phone'

export interface SplitInput {
  kind: PhoneRunKind
  seriesId: string
  series: string
  language: NarrationLanguage
  /** The phones that can be started now (connected, with an id, "Start from Manhwa Studio" on), in the order shown. */
  phones: SplitPhone[]
  /** Every phone's receipts, startable or not: what's done anywhere counts. */
  all: SplitPhone[]
  chapters: SplitChapter[]
  /** Editor 2.0's chapters waiting for their timeline (from R2); asked for only once the phones are fit to split. */
  editorWaiting?: () => Promise<string[]>
  now?: number
}

/** The plan, from the phones' receipts (planSplit gathers them). Throws when it can't be split as asked. */
export async function buildSplitPlan(input: SplitInput): Promise<SplitPlan> {
  const { kind, series, language, phones, all, chapters } = input
  const label = RUN_LABEL[kind]
  if (kind === 'narration') throw new Error(NARRATION_ONE_PHONE)
  if (phones.length < 2) throw new Error('Splitting needs two phones open with “Start from Manhwa Studio” on')
  const old = phones.filter(p => !takesChapters(kind, p.automation))
  if (old.length) throw new Error(`Update Sleeper-Cell on ${old.map(p => p.name).join(' and ')} to split ${label} between the phones`)

  const states = new Map(phones.map(p => [p.id, splitState(kind, series, language, p, input.now)]))
  const stale = phones.find(p => states.get(p.id)!.state === 'busySame' && p.automation?.rescope !== true)
  if (stale) throw new Error(`${stale.name} is already running this with an older Sleeper-Cell. Stop it or update the app.`)
  const taking = phones.filter(p => states.get(p.id)!.state !== 'busyOther')
  if (taking.length < 2) {
    const busy = phones.flatMap(p => {
      const state = states.get(p.id)!
      return state.state === 'busyOther' ? [`${p.name} is ${state.reason}`] : []
    })
    throw new Error(`Splitting needs two phones free for ${label}: ${busy.join('; ')}. Stop it there, or start on one phone.`)
  }
  const ids = taking.map(p => p.id)
  const inProgressOf = (id: string) => {
    const state = states.get(id)!
    return state.state === 'busySame' ? state.inProgress : []
  }
  // A chapter two phones are on already (Image Clipper's pages of it) stays in the first one's share; the other
  // finishes what it's on of it, then goes on with its own share.
  const pinned = new Map<string, string[]>()
  const held = new Set<string>()
  for (const id of ids) {
    pinned.set(id, inProgressOf(id).filter(c => !held.has(c)))
    for (const c of inProgressOf(id)) held.add(c)
  }
  const pinnedOf = (id: string) => pinned.get(id) ?? []

  const pages = new Map(chapters.map(c => [c.folder, c.pageCount]))
  let weight = (chapter: string) => Math.max(1, pages.get(chapter) ?? 1)
  let candidates: SplitCandidate[]
  let available: Map<string, number> | undefined
  if (kind === 'clipper') {
    const made = clipperCandidates(series, all.flatMap(p => (p.sync ? [p.sync] : [])), all.flatMap(p => (p.crops ? [p.crops] : [])), chapters)
    candidates = made.candidates
    weight = chapter => Math.max(1, made.pagesLeft.get(chapter) ?? pages.get(chapter) ?? 1)
  } else if (kind === 'editor') {
    candidates = (await input.editorWaiting!()).map(chapter => ({ chapter, eligible: null }))
  } else {
    const made = voiceoverCandidates(series, language, ids, all, chapters)
    candidates = made.candidates
    available = made.available
  }

  const shares = assignSplit(candidates, taking.map(p => ({ id: p.id, pinned: pinnedOf(p.id) })), weight, available)
  const order = reading(chapters)
  const targets: SplitTarget[] = phones.map(phone => {
    const state = states.get(phone.id)!
    if (state.state === 'busyOther') return { device: phone.id, name: phone.name, chapters: [], inProgress: [], action: 'skip', reason: state.reason }
    const inProgress = [...inProgressOf(phone.id)].sort(order)
    const share = [...new Set([...pinnedOf(phone.id), ...shares.get(phone.id)!])].sort(order)
    if (state.state === 'busySame') {
      return share.length
        ? { device: phone.id, name: phone.name, chapters: share, inProgress, action: 'rescope' }
        : { device: phone.id, name: phone.name, chapters: [], inProgress, action: 'finish', reason: 'Nothing left for it: finishes what it’s on, then stops' }
    }
    return share.length
      ? { device: phone.id, name: phone.name, chapters: share, inProgress: [], action: 'start' }
      : { device: phone.id, name: phone.name, chapters: [], inProgress: [], action: 'skip', reason: 'Nothing left for it' }
  })
  if (!targets.some(t => t.action === 'start' || t.action === 'rescope')) throw new Error(NOTHING_LEFT[kind])

  const numbers: Record<string, number> = {}
  const known = new Map(chapters.map(c => [c.folder, c.number]))
  for (const chapter of targets.flatMap(t => t.chapters)) {
    const number = known.get(chapter)
    if (number !== null && number !== undefined) numbers[chapter] = number
  }
  return { kind, seriesId: input.seriesId, series, language, targets, numbers }
}

const NOTHING_LEFT: Record<PhoneRunKind, string> = {
  clipper: 'Every chapter of this series is clipped on the phones already',
  narration: NARRATION_ONE_PHONE,
  editor: 'No chapter of this series is waiting for its timeline on the phones',
  voiceover: 'No chapter of this series is waiting for its voiceover on the phones'
}

/** Each phone's receipts as the relay keeps them: `phoneOf` one phone, and every phone with a receipt. */
function relayedPhones(): { phoneOf: (id: string, name: string) => SplitPhone; devices: Set<string> } {
  const bodies = (kind: 'sync' | 'scripts' | 'crops') =>
    new Map((relayReceipts<Obj>(kind) ?? []).map(r => [r.device, r.body]))
  const sync = bodies('sync')
  const scripts = bodies('scripts')
  const crops = bodies('crops')
  const phoneOf = (id: string, name: string): SplitPhone => {
    const cropsBody = crops.get(id) ?? null
    return {
      id,
      name,
      automation: isObject(cropsBody?.automation) ? cropsBody!.automation as Obj : null,
      sync: sync.get(id) ?? null,
      scripts: scripts.get(id) ?? null,
      crops: cropsBody
    }
  }
  return { phoneOf, devices: new Set([...sync.keys(), ...scripts.keys(), ...crops.keys()]) }
}

/** Whether `device` is on `kind` in `series` now, by its receipts (a split's start there rescopes it). */
export function onThisRun(kind: PhoneRunKind, series: string, language: NarrationLanguage, device: string): boolean {
  return splitState(kind, series, language, relayedPhones().phoneOf(device, device)).state === 'busySame'
}

/** The split plan for `kind` on a series, from the phones the relay can start now and their receipts. */
export async function planSplit(kind: PhoneRunKind, seriesId: string, language: NarrationLanguage = 'en'): Promise<SplitPlan> {
  if (kind === 'narration') throw new Error(NARRATION_ONE_PHONE)
  const row = await prisma.series.findUnique({
    where: { id: seriesId },
    select: { rootFolder: true, chapters: { select: { folderPath: true, number: true, pageCount: true } } }
  })
  if (!row) throw new Error('Series not found')
  const series = path.basename(row.rootFolder)
  const { phoneOf, devices } = relayedPhones()
  const filterPhone = async (phone: SplitPhone): Promise<SplitPhone> => ({ ...phone, crops: phone.crops ? await filterReplacedCropFacts(phone.crops) : null })
  return buildSplitPlan({
    kind,
    seriesId,
    series,
    language,
    phones: await Promise.all(startablePhones().map(p => filterPhone(phoneOf(p.id, p.name)))),
    all: await Promise.all([...devices].map(id => filterPhone(phoneOf(id, id)))),
    chapters: row.chapters.map(c => ({ folder: path.basename(c.folderPath), number: c.number ?? null, pageCount: c.pageCount ?? null })),
    editorWaiting: async () => (await import('./phoneEditor.js')).editorWaitingChapters(seriesId, language)
  })
}
