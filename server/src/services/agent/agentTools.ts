/**
 * What the Studio Agent can do. Every action is one of the things the user can already do in the
 * Library; mutations go through Studio's own HTTP API on loopback, so they behave (and notify the
 * UI) exactly like a click. Destructive actions are never run directly: they wait for the user's
 * approval in the chat (agent.ts).
 */

import type { PrismaClient } from '@prisma/client'
import type { AgentStore } from './agentStore.js'
import { scriptTools, type ToolKit } from './scriptTools.js'
import { settingsTools } from './settingsTools.js'
import { clipperTools } from './clipperTools.js'
import type { WatchRequest } from './scriptWatcher.js'

export interface ToolContext {
  prisma: PrismaClient
  store: AgentStore
  /** Base URL of Studio's own API, e.g. http://127.0.0.1:3002/api */
  api: string
  /** The chat this turn belongs to, and the user's latest message in it (for actions that take pasted text). */
  chatId?: string
  lastUserText?: string
  /** Ask for a message in this chat when a run (scripts, Image Clipper, a crop) the action started ends or hits a problem (scriptWatcher.ts). */
  watch?: (request: WatchRequest) => Promise<void>
}

export interface AgentTool {
  name: string
  /** One line for the system prompt. */
  help: string
  /** Argument names with a short hint, for the system prompt. */
  args: Record<string, string>
  /** Needs the user's approval in the chat before it runs. */
  destructive?: boolean
  /** Short human line for the approval card. */
  describe?: (args: Record<string, any>) => string
  /**
   * Approval that depends on the arguments (for example a rewrite of an existing script): returns the line for the
   * approval card when the user must approve this call, or null when it can run at once. Ignored when `destructive`.
   */
  approval?: (args: Record<string, any>, ctx: ToolContext) => Promise<string | null>
  /** Checks and completes the arguments before approval or run (errors reach the agent, not the user). */
  prepare?: (args: Record<string, any>, ctx: ToolContext) => Promise<Record<string, any>>
  run: (args: Record<string, any>, ctx: ToolContext) => Promise<unknown>
}

export class ToolError extends Error {}

export async function call<T = any>(ctx: ToolContext, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${ctx.api}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Studio-Client': '1' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10 * 60_000)
  })
  const text = await response.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!response.ok) throw new ToolError(`${(data && typeof data === 'object' && data.error) || text || response.statusText} (HTTP ${response.status})`)
  return data
}

interface SeriesRow { id: string; title: string; rootFolder: string; sourceSite?: string; urlTemplate?: string | null }

async function allSeries(ctx: ToolContext): Promise<SeriesRow[]> {
  return ctx.prisma.series.findMany({ select: { id: true, title: true, rootFolder: true, sourceSite: true, urlTemplate: true }, orderBy: { createdAt: 'desc' } })
}

/** Accepts an id, an exact title, or a unique part of a title. */
export async function resolveSeries(ctx: ToolContext, ref: unknown): Promise<SeriesRow> {
  if (typeof ref !== 'string' || !ref.trim()) throw new ToolError('Say which series (its title or id).')
  const rows = await allSeries(ctx)
  const q = ref.trim().toLowerCase()
  const byId = rows.find(r => r.id === ref.trim())
  if (byId) return byId
  const exact = rows.filter(r => r.title.toLowerCase() === q)
  if (exact.length === 1) return exact[0]
  const partial = rows.filter(r => r.title.toLowerCase().includes(q))
  if (partial.length === 1) return partial[0]
  if (partial.length === 0) throw new ToolError(`No series matches "${ref}". Use library_overview to see the titles.`)
  throw new ToolError(`"${ref}" matches several series: ${partial.slice(0, 8).map(r => `"${r.title}"`).join(', ')}. Use the exact title.`)
}

export const int = (value: unknown, name: string, min = 1, max = 99999) => {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new ToolError(`${name} must be a whole number from ${min} to ${max}.`)
  return n
}
export const bool = (value: unknown, name: string) => {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new ToolError(`${name} must be true or false.`)
}

const KEY_STAGES = ['stitch', 'script_en', 'script_hi', 'voice_en', 'voice_hi', 'crop', 'metadata', 'export_en', 'export_hi'] as const

export async function overview(ctx: ToolContext, filter: string) {
  // Loaded on use: these modules pull in the whole server (index.ts), which must not start inside tests.
  const { libraryControls } = await import('../libraryControls.js')
  const { getSeriesProcess } = await import('../seriesProcess.js')
  const [rows, controls, process, grouped] = await Promise.all([
    allSeries(ctx),
    libraryControls(),
    getSeriesProcess().catch(() => null),
    ctx.prisma.chapter.groupBy({ by: ['seriesId', 'status'], _count: { _all: true } })
  ])
  const control = new Map(controls.map(c => [c.folder, c]))
  const progress = new Map((process?.series ?? []).map(s => [s.seriesId, s]))
  const list = rows.filter(r => !control.get(r.rootFolder)?.deleted).map(r => {
    const c = control.get(r.rootFolder)
    const counts: Record<string, number> = {}
    for (const g of grouped.filter(g => g.seriesId === r.id)) counts[g.status] = g._count._all
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    const archived = !!c?.archived?.done
    const doneEn = !!c?.seriesDone?.en?.done
    const doneHi = !!c?.seriesDone?.hi?.done
    const p = progress.get(r.id)
    const pipeline = p ? Object.fromEntries(KEY_STAGES.map(k => [k, `${p.stages[k].done}/${p.stages[k].total}`])) : undefined
    const state = archived ? 'archived' : doneEn || doneHi ? 'finished' : 'ongoing'
    return {
      id: r.id, title: r.title, state,
      markedDone: { english: doneEn, hindi: doneHi },
      chapters: { total, downloaded: counts.done ?? 0, failed: counts.failed ?? 0, waiting: (counts.pending ?? 0) + (counts.queued ?? 0) + (counts.downloading ?? 0) },
      completedParts: p?.completedParts ?? [],
      ...(pipeline && { pipelineChaptersDone: pipeline })
    }
  })
  const shown = filter === 'all' ? list : list.filter(s => s.state === filter)
  return { counts: { total: list.length, ongoing: list.filter(s => s.state === 'ongoing').length, finished: list.filter(s => s.state === 'finished').length, archived: list.filter(s => s.state === 'archived').length }, series: shown }
}

/** Two seed links are needed to find the numbering; with one, the next chapter is guessed by adding 1 to its last number. */
export function secondSeed(url: string): string | null {
  const m = /(\d+)(?!.*\d)/.exec(url)
  if (!m) return null
  const next = String(Number(m[1]) + 1).padStart(m[1].length, '0')
  return url.slice(0, m.index) + next + url.slice(m.index + m[1].length)
}

export const compact = (numbers: number[]) => {
  const out: string[] = []
  const sorted = [...numbers].sort((a, b) => a - b)
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    out.push(i === j ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`)
    i = j + 1
  }
  return out.join(', ')
}


interface StitchJob { running: boolean; chapters: string; total: number; startedAt: string; current?: number; index?: number; finishedAt?: string; error?: string }
/** Auto stitches this agent started (in memory: gone after a restart; the chapters' own stitch state is the record). */
const stitchJobs = new Map<string, StitchJob>()

export async function chapterOf(ctx: ToolContext, seriesId: string, number: unknown) {
  const n = int(number, 'chapter', 0)
  const chapter = await ctx.prisma.chapter.findFirst({ where: { seriesId, number: n }, select: { id: true, number: true, status: true } })
  if (!chapter) throw new ToolError(`Chapter ${n} is not in that series.`)
  return chapter
}

async function pagesOf(ctx: ToolContext, series: unknown, chapterNumber: unknown) {
  const s = await resolveSeries(ctx, series)
  const chapter = await chapterOf(ctx, s.id, chapterNumber)
  if (chapter.status !== 'done') throw new ToolError(`Chapter ${chapter.number} is not downloaded yet.`)
  const state = await call(ctx, 'GET', `/page-preview/chapters/${chapter.id}`)
  return { chapter, state }
}

/** Names from page positions (1-based) or file names; anything unknown is an error, never a guess. */
export function pickPages(pages: { filename: string }[], wanted: unknown, label: string): string[] {
  return pickNames(pages.map(p => p.filename), wanted, label)
}
export function pickNames(names: string[], wanted: unknown, label: string): string[] {
  const list = Array.isArray(wanted) ? wanted : wanted === undefined || wanted === null ? [] : [wanted]
  if (!list.length) throw new ToolError(`Say which ${label} (positions like 1, 2 or file names).`)
  if (list.length > 200) throw new ToolError('At most 200 pages per call.')
  const out = new Set<string>()
  for (const w of list) {
    const asNumber = typeof w === 'number' || (typeof w === 'string' && /^\d+$/.test(w.trim())) ? Number(w) : null
    const byName = typeof w === 'string' ? names.find(n => n === w.trim()) : undefined
    if (byName) out.add(byName)
    else if (asNumber !== null && asNumber >= 1 && asNumber <= names.length) out.add(names[asNumber - 1])
    else throw new ToolError(`"${w}" is not one of the ${names.length} ${label} (use a position from 1 to ${names.length} or a file name).`)
  }
  return [...out]
}

const STALE_MS = 30 * 60_000

function untilText(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return null
  if (ms <= 0) return 'already reset'
  const m = Math.round(ms / 60_000)
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`
}

function windowRow(label: string, usedPercent: number | null, resetsAt: string | null | undefined, now: number) {
  const reset = resetsAt && Date.parse(resetsAt) > now ? resetsAt : null
  return {
    limit: label,
    usedPercent: usedPercent === null ? 'unknown' : Math.round(usedPercent),
    ...(usedPercent !== null && { leftPercent: Math.max(0, 100 - Math.round(usedPercent)) }),
    resetsAt: resetsAt ? new Date(resetsAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'unknown',
    resetsIn: untilText(resetsAt, now),
    ...(resetsAt && !reset && { note: 'that reset time has passed; the figure is out of date' })
  }
}

/** The AI Engines usage snapshot (GET /antigravity/usage) in plain numbers: % used, when it resets, and how fresh each figure is. */
export function summarizeUsage(raw: any, now = Date.now()) {
  const fresh = (at: string | null | undefined) => {
    if (!at) return { asOf: 'never recorded', stale: true }
    const age = now - Date.parse(at)
    return { asOf: new Date(at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), stale: !(age < STALE_MS) }
  }
  const out: Record<string, unknown> = {}

  const g = raw?.google
  if (g) {
    out.antigravity = {
      account: g.account ?? null,
      ...(g.error && { error: g.error }),
      ...fresh(g.quota?.at ?? g.checkedAt),
      groups: (g.quota?.groups ?? []).map((grp: any) => ({
        models: grp.name, includes: grp.description ?? undefined,
        limits: (grp.buckets ?? []).map((b: any) => windowRow(
          b.window === '5h' ? '5-hour' : b.window === 'weekly' ? 'weekly' : String(b.window ?? b.name),
          typeof b.remainingFraction === 'number' ? (1 - b.remainingFraction) * 100 : null, b.resetTime, now))
      }))
    }
  }

  const c = raw?.claude
  if (c) {
    out.claude = {
      ...(c.error && { error: c.error }),
      ...fresh(c.usage?.at ?? c.checkedAt),
      plan: c.usage?.source ?? undefined,
      limits: (c.usage?.windows ?? []).map((w: any) => windowRow(/session/i.test(w.label) ? `${w.label} (5-hour)` : w.label, w.usedPercent, w.resetsAt, now)),
      ...((c.limits ?? []).some((l: any) => l.status === 'rejected') && { limitReached: true })
    }
  }

  out.chatgpt = (raw?.codex?.accounts ?? []).map((a: any) => {
    const l = a.limits
    const rows = []
    if (l?.primary) rows.push(windowRow(l.primary.windowMinutes === 300 ? '5-hour' : `${l.primary.windowMinutes} min window`, l.primary.usedPercent, l.primary.resetsAt, now))
    if (l?.secondary) rows.push(windowRow(l.secondary.windowMinutes === 10080 ? 'weekly' : `${l.secondary.windowMinutes} min window`, l.secondary.usedPercent, l.secondary.resetsAt, now))
    const blocked = a.limitedUntil && Date.parse(a.limitedUntil) > now
    return {
      account: a.label, enabled: a.enabled, plan: l?.planType ?? undefined,
      ...fresh(l?.at),
      limits: rows.length ? rows : 'no figures recorded yet (ChatGPT only reports limits while it runs a job on that account)',
      ...(blocked && { blockedUntil: new Date(a.limitedUntil).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }), blockedBecause: a.limitReason })
    }
  })
  return out
}

const BASE_TOOLS: AgentTool[] = [
  {
    name: 'library_overview',
    help: 'List the library: every series with its state (ongoing / finished / archived), download counts and pipeline progress.',
    args: { filter: 'optional: all | ongoing | finished | archived (default all)' },
    run: async (a, ctx) => {
      const filter = typeof a.filter === 'string' ? a.filter : 'all'
      if (!['all', 'ongoing', 'finished', 'archived'].includes(filter)) throw new ToolError('filter must be all, ongoing, finished or archived.')
      return overview(ctx, filter)
    }
  },
  {
    name: 'series_details',
    help: 'One series in detail: chapter numbers by status, source site and URL pattern.',
    args: { series: 'title or id' },
    run: async (a, ctx) => {
      const s = await resolveSeries(ctx, a.series)
      const chapters = await ctx.prisma.chapter.findMany({ where: { seriesId: s.id }, select: { number: true, status: true }, orderBy: { number: 'asc' } })
      const by: Record<string, number[]> = {}
      for (const c of chapters) (by[c.status] ??= []).push(c.number)
      return { id: s.id, title: s.title, sourceSite: s.sourceSite, urlTemplate: s.urlTemplate, totalChapters: chapters.length, chaptersByStatus: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, compact(v)])) }
    }
  },
  {
    name: 'downloads_status',
    help: 'The download queue right now (paused, waiting, active, failed).',
    args: {},
    run: (_a, ctx) => call(ctx, 'GET', '/downloads/status')
  },
  {
    name: 'add_series_from_link',
    help: 'Add a NEW series to the library from a chapter link (a link to any one chapter, ideally chapter 1). Studio finds the numbering pattern, checks which chapters exist, creates the series and starts downloading.',
    args: { url: 'chapter link', second_url: 'optional: the next chapter\'s link (use when the first guess fails)', title: 'optional title (default: the page title)', from_chapter: 'optional first chapter number (default: the link\'s number)', to_chapter: 'optional last chapter number (default: from + 19; max 200 chapters per call)' },
    run: async (a, ctx) => {
      const url = typeof a.url === 'string' ? a.url.trim() : ''
      if (!/^https?:\/\/\S+$/i.test(url)) throw new ToolError('url must be a full http(s) link.')
      const second = typeof a.second_url === 'string' && a.second_url.trim() ? a.second_url.trim() : secondSeed(url)
      if (!second) throw new ToolError('Could not find a chapter number in that link. Send the link of a chapter page, or give second_url.')
      const inferred = await call(ctx, 'POST', '/series/infer-pattern', { seedUrls: [url, second] })
      if (!inferred.template?.includes('{n}')) throw new ToolError(`Could not find the chapter numbering in the links (${inferred.message ?? 'no pattern'}). Give second_url (the next chapter's link).`)
      const from = a.from_chapter !== undefined ? int(a.from_chapter, 'from_chapter', 0) : Math.max(1, Number(inferred.startNumber) || 1)
      const to = a.to_chapter !== undefined ? int(a.to_chapter, 'to_chapter', 0) : from + 19
      if (to < from || to - from > 200) throw new ToolError('Choose at most 200 chapters per call (to_chapter ≥ from_chapter).')
      const found = await call(ctx, 'POST', '/series/discover-chapters', { template: inferred.template, fromChapter: from, toChapter: to, padding: inferred.padding ?? 0 })
      const chapters = (found.chapters ?? []).filter((c: any) => c.exists !== false)
      if (!chapters.length) throw new ToolError(`No readable chapters were found between ${from} and ${to} with pattern ${inferred.template}. The site may block automated access, or the link is not a chapter page.`)
      const title = (typeof a.title === 'string' && a.title.trim()) || inferred.suggestedTitle || ''
      if (!title) throw new ToolError('The page title could not be read; give a title.')
      const existing = (await allSeries(ctx)).find(r => r.title.toLowerCase() === title.toLowerCase() || (r.urlTemplate && r.urlTemplate === inferred.template))
      if (existing) throw new ToolError(`"${existing.title}" is already in the library. Use add_chapters to add more chapters to it.`)
      const created = await call(ctx, 'POST', '/series', { title, sourceSite: inferred.sourceSite, urlTemplate: inferred.template, chapters: chapters.map((c: any) => ({ number: c.number, url: c.url, title: c.title })) })
      return { added: created.title, id: created.id, chaptersAdded: chapters.length, firstChapter: chapters[0].number, lastChapter: chapters[chapters.length - 1].number, note: 'Downloads are queued.' }
    }
  },
  {
    name: 'add_chapters',
    help: 'Add more chapters (by number range) to a series already in the library, using its saved URL pattern, and queue them for download.',
    args: { series: 'title or id', from_chapter: 'first chapter number', to_chapter: 'last chapter number (max 200 per call)' },
    run: async (a, ctx) => {
      const s = await resolveSeries(ctx, a.series)
      if (!s.urlTemplate) throw new ToolError(`"${s.title}" has no saved URL pattern (it was added manually).`)
      const from = int(a.from_chapter, 'from_chapter', 0)
      const to = int(a.to_chapter, 'to_chapter', 0)
      if (to < from || to - from > 200) throw new ToolError('Choose at most 200 chapters per call.')
      const found = await call(ctx, 'POST', '/series/discover-chapters', { template: s.urlTemplate, fromChapter: from, toChapter: to, padding: 0 })
      const chapters = (found.chapters ?? []).filter((c: any) => c.exists !== false)
      if (!chapters.length) throw new ToolError(`No readable chapters were found from ${from} to ${to}.`)
      await call(ctx, 'POST', `/series/${s.id}/chapters`, { chapters: chapters.map((c: any) => ({ number: c.number, url: c.url, title: c.title })) })
      return { series: s.title, chaptersAdded: chapters.length, firstChapter: chapters[0].number, lastChapter: chapters[chapters.length - 1].number, note: 'Downloads are queued.' }
    }
  },
  {
    name: 'download_chapters',
    help: 'Queue chapters of a series for download.',
    args: { series: 'title or id', which: 'optional: not_done (default) | failed | pending' },
    run: async (a, ctx) => {
      const s = await resolveSeries(ctx, a.series)
      const which = typeof a.which === 'string' ? a.which : 'not_done'
      const where = which === 'failed' ? { status: 'failed' } : which === 'pending' ? { status: 'pending' } : which === 'not_done' ? { status: { in: ['pending', 'failed', 'skipped'] } } : null
      if (!where) throw new ToolError('which must be not_done, failed or pending.')
      const ids = (await ctx.prisma.chapter.findMany({ where: { seriesId: s.id, ...where }, select: { id: true } })).map(c => c.id)
      if (!ids.length) return { series: s.title, queued: 0, note: 'Nothing to queue.' }
      await call(ctx, 'POST', '/downloads/queue', { chapterIds: ids })
      return { series: s.title, queued: ids.length }
    }
  },
  { name: 'pause_downloads', help: 'Pause the download queue.', args: {}, run: (_a, ctx) => call(ctx, 'POST', '/downloads/pause') },
  { name: 'resume_downloads', help: 'Resume the download queue.', args: {}, run: (_a, ctx) => call(ctx, 'POST', '/downloads/resume') },
  {
    name: 'retry_failed_downloads',
    help: 'Retry every failed chapter download (of one series, or all).',
    args: { series: 'optional: title or id' },
    run: async (a, ctx) => {
      const s = a.series ? await resolveSeries(ctx, a.series) : null
      return call(ctx, 'POST', '/downloads/retry-failed', { seriesId: s?.id })
    }
  },
  {
    name: 'mark_part_complete',
    help: 'Mark a production part (20 chapters each; part 1 = chapters 1–20) complete or not complete.',
    args: { series: 'title or id', part: 'part number', done: 'true or false' },
    run: async (a, ctx) => {
      const s = await resolveSeries(ctx, a.series)
      const part = int(a.part, 'part'), done = bool(a.done, 'done')
      await call(ctx, 'PUT', `/series/${s.id}/parts/${part}/completion`, { done })
      return { series: s.title, part, done }
    }
  },
  {
    name: 'mark_series_done',
    help: 'Mark a series Done (finished) for one language, or undo it.',
    args: { series: 'title or id', language: 'en or hi', done: 'true or false' },
    run: async (a, ctx) => {
      const s = await resolveSeries(ctx, a.series)
      const language = a.language === 'hi' || a.language === 'hindi' ? 'hi' : a.language === 'en' || a.language === 'english' ? 'en' : null
      if (!language) throw new ToolError('language must be en or hi.')
      const done = bool(a.done, 'done')
      await call(ctx, 'PUT', `/series/${s.id}/done`, { language, done })
      return { series: s.title, language, done }
    }
  },
  {
    name: 'archive_series',
    help: 'Archive a series (hide it from the library, keeping all files) or restore it.',
    args: { series: 'title or id', archived: 'true to archive, false to restore' },
    run: async (a, ctx) => {
      const archived = bool(a.archived, 'archived')
      const s = archived ? await resolveSeries(ctx, a.series) : await resolveArchived(ctx, a.series)
      await call(ctx, 'POST', `/series/${s.id}/archive`, { archived })
      return { series: s.title, archived }
    }
  },
  {
    name: 'delete_series',
    help: 'Delete a series and all its files everywhere (this computer, the phone library, cloud copies). Cannot be undone.',
    args: { series: 'title or id' },
    destructive: true,
    describe: a => `Delete the series "${a.series}" and all its files everywhere (cannot be undone)`,
    run: async (a, ctx) => {
      const s = await resolveSeries(ctx, a.series)
      await call(ctx, 'POST', `/series/${s.id}/delete-everywhere`)
      return { series: s.title, deleting: true }
    }
  },
  {
    name: 'stitch_status',
    help: 'Stitching status: which downloaded chapters are stitched, which are waiting, and whether an auto stitch you started is still running. Leave series out to cover the whole library in one answer.',
    args: { series: 'optional: title or id (default: every series)' },
    run: async (a, ctx) => {
      const rows = a.series ? [await resolveSeries(ctx, a.series)] : await allSeries(ctx)
      const { readStitchCompletion } = await import('../stitchCompletion.js')
      const { isStitching } = await import('../stitchActivity.js')
      const out = []
      for (const s of rows) {
        const chapters = await ctx.prisma.chapter.findMany({ where: { seriesId: s.id, status: 'done' }, select: { number: true, folderPath: true }, orderBy: { number: 'asc' } })
        const stitched: number[] = [], waiting: number[] = [], active: number[] = []
        for (const c of chapters) {
          if (isStitching(c.folderPath)) active.push(c.number)
          else if (await readStitchCompletion(c.folderPath)) stitched.push(c.number)
          else waiting.push(c.number)
        }
        const job = stitchJobs.get(s.id)
        out.push({
          series: s.title, downloadedChapters: chapters.length,
          stitched: stitched.length ? { count: stitched.length, chapters: compact(stitched) } : 0,
          notStitchedYet: waiting.length ? { count: waiting.length, chapters: compact(waiting) } : 0,
          ...(active.length && { stitchingNow: compact(active) }),
          ...(job && { lastAutoStitch: job })
        })
      }
      return a.series ? out[0] : out
    }
  },
  {
    name: 'auto_stitch',
    help: 'Start Auto stitch for a series\' downloaded chapters that are not stitched yet: joins the short pages, cuts at blank rows into ~12,000 px pages, and drops the repeated intro/outro. It runs in the background (check progress with stitch_status). The originals are backed up, so it can be undone with undo_stitch.',
    args: { series: 'title or id', from_chapter: 'optional first chapter number', to_chapter: 'optional last chapter number' },
    run: async (a, ctx) => {
      const s = await resolveSeries(ctx, a.series)
      if (stitchJobs.get(s.id)?.running) throw new ToolError(`An auto stitch of "${s.title}" is already running.`)
      const from = a.from_chapter !== undefined ? int(a.from_chapter, 'from_chapter', 0) : 0
      const to = a.to_chapter !== undefined ? int(a.to_chapter, 'to_chapter', 0) : 1_000_000
      const { readStitchCompletion } = await import('../stitchCompletion.js')
      const rows = await ctx.prisma.chapter.findMany({ where: { seriesId: s.id, status: 'done', number: { gte: from, lte: to } }, select: { id: true, number: true, folderPath: true }, orderBy: { number: 'asc' } })
      const todo: typeof rows = []
      for (const c of rows) if (!(await readStitchCompletion(c.folderPath))) todo.push(c)
      if (!todo.length) return { series: s.title, started: false, note: 'Every downloaded chapter in that range is already stitched.' }
      const job: StitchJob = { running: true, chapters: compact(todo.map(c => c.number)), total: todo.length, startedAt: new Date().toISOString() }
      stitchJobs.set(s.id, job)
      void (async () => {
        try {
          const { prepareLibrarySeries } = await import('../libraryPreparation.js')
          await prepareLibrarySeries(s.id, todo.map(c => c.id), p => { job.current = p.chapterNumber; job.index = p.index })
        } catch (error) { job.error = toolErrorText(error) }
        finally { job.running = false; job.finishedAt = new Date().toISOString() }
      })()
      return { series: s.title, started: true, chapters: job.chapters, note: 'Running in the background; ask for stitch_status to follow it.' }
    }
  },
  {
    name: 'chapter_pages',
    help: 'The pages of one downloaded chapter (count, sizes) and how many deleted pages are in its bin.',
    args: { series: 'title or id', chapter: 'chapter number' },
    run: async (a, ctx) => {
      const { chapter, state } = await pagesOf(ctx, a.series, a.chapter)
      const pages = state.pages as { filename: string; width: number; height: number }[]
      const short = pages.length > 80
      return {
        chapter: chapter.number, pageCount: pages.length,
        pages: short ? `${pages.length} pages (list shortened)` : pages.map((p, i) => `${i + 1}: ${p.filename} ${p.width}x${p.height}`),
        deletedInBin: (state.deleted ?? []).map((d: any) => d.filename),
        ...(state.blockers?.length && { blocked: state.blockers })
      }
    }
  },
  {
    name: 'delete_pages',
    help: 'Delete unwanted pages of a chapter (for example ads or credit pages the user names). They move to the chapter\'s bin and can be restored. You cannot see the images, so only delete pages the user identifies.',
    args: { series: 'title or id', chapter: 'chapter number', pages: 'list of page positions (1 = first page) or file names' },
    run: async (a, ctx) => {
      const { chapter, state } = await pagesOf(ctx, a.series, a.chapter)
      const names = pickPages(state.pages, a.pages, 'pages')
      const r = await call(ctx, 'POST', `/page-preview/chapters/${chapter.id}/delete`, { filenames: names })
      return { chapter: chapter.number, movedToBin: names, result: r }
    }
  },
  {
    name: 'restore_pages',
    help: 'Put pages back from a chapter\'s bin.',
    args: { series: 'title or id', chapter: 'chapter number', pages: 'file names from the bin, or "all"' },
    run: async (a, ctx) => {
      const { chapter, state } = await pagesOf(ctx, a.series, a.chapter)
      const bin: string[] = (state.deleted ?? []).map((d: any) => d.filename)
      const names = a.pages === 'all' ? bin : pickNames(bin, a.pages, 'pages')
      if (!names.length) throw new ToolError('The bin is empty.')
      const r = await call(ctx, 'POST', `/page-preview/chapters/${chapter.id}/restore`, { filenames: names })
      return { chapter: chapter.number, restored: names, result: r }
    }
  },
  {
    name: 'empty_page_bin',
    help: 'Permanently remove the deleted pages in a chapter\'s bin. Cannot be undone.',
    args: { series: 'title or id', chapter: 'chapter number' },
    destructive: true,
    describe: a => `Permanently remove the deleted pages in the bin of "${a.series}" chapter ${a.chapter} (cannot be undone)`,
    run: async (a, ctx) => {
      const { chapter } = await pagesOf(ctx, a.series, a.chapter)
      return call(ctx, 'DELETE', `/page-preview/chapters/${chapter.id}/bin`)
    }
  },
  {
    name: 'undo_stitch',
    help: 'Undo a chapter\'s stitch: the original pages come back (works while the stitch backup still exists).',
    args: { series: 'title or id', chapter: 'chapter number' },
    run: async (a, ctx) => {
      const s = await resolveSeries(ctx, a.series)
      const chapter = await chapterOf(ctx, s.id, a.chapter)
      await call(ctx, 'POST', `/stitch/chapters/${chapter.id}/undo`)
      return { series: s.title, chapter: chapter.number, undone: true }
    }
  },
  {
    name: 'discard_stitch_backup',
    help: 'Delete the backup of a chapter\'s original pages (frees disk space, but the stitch can no longer be undone).',
    args: { series: 'title or id', chapter: 'chapter number' },
    destructive: true,
    describe: a => `Delete the original-pages backup of "${a.series}" chapter ${a.chapter} (the stitch can then no longer be undone)`,
    run: async (a, ctx) => {
      const s = await resolveSeries(ctx, a.series)
      const chapter = await chapterOf(ctx, s.id, a.chapter)
      await call(ctx, 'DELETE', `/stitch/chapters/${chapter.id}/backup`)
      return { series: s.title, chapter: chapter.number, backupDeleted: true }
    }
  },
  {
    name: 'ai_usage',
    help: 'Usage limits of the AI engines: Antigravity (Gemini and Claude/GPT model groups), Claude, and every ChatGPT account — percent used and when each 5-hour / weekly / per-model limit resets. Also says how fresh each figure is.',
    args: { refresh: 'optional true: re-read Antigravity and Claude live first (takes a few seconds)' },
    run: async (a, ctx) => summarizeUsage(await call(ctx, 'GET', `/antigravity/usage${a.refresh === true || a.refresh === 'true' ? '?refresh=1' : ''}`))
  },
  {
    name: 'refresh_chatgpt_usage',
    help: 'Find out a ChatGPT account\'s CURRENT 5-hour and weekly usage by running one tiny job ("reply ok") as that account; ChatGPT reports its limits only while it runs something. Costs a few tokens. Leave account out to refresh every enabled account.',
    args: { account: 'optional: account name as shown in ai_usage (e.g. "Agent 001"); default all enabled accounts' },
    run: async (a, ctx) => {
      const [{ CodexAccountStore, isLimited }, { detectCodex }, { runAgentTurn }] = await Promise.all([
        import('../antigravity/codexAccounts.js'), import('../antigravity/codexCli.js'), import('./agentEngine.js')
      ])
      const paths = await ctx.store.enginePaths()
      const exe = (await detectCodex(paths.codex)).path
      if (!exe) throw new ToolError('Codex is not installed, so a ChatGPT account cannot be checked.')
      const store = new CodexAccountStore({ prisma: ctx.prisma, executable: async () => exe })
      const state = await store.read()
      const q = typeof a.account === 'string' ? a.account.trim().toLowerCase() : ''
      const chosen = state.accounts.filter(acc => (q ? acc.label.toLowerCase().includes(q) || acc.id === q : acc.enabled))
      if (!chosen.length) throw new ToolError(q ? `No ChatGPT account matches "${a.account}".` : 'No enabled ChatGPT account.')
      const settings = await ctx.store.settings()
      const ran: Record<string, string> = {}
      for (const acc of chosen) {
        if (isLimited(acc)) { ran[acc.label] = `skipped: it is blocked until ${new Date(acc.limitedUntil!).toLocaleString()} (limit reached); showing the last recorded figures`; continue }
        try {
          await runAgentTurn('codex', { executable: exe, model: settings.models.codex, effort: 'low', prompt: 'Reply with the single word: ok', timeoutMs: 120_000, env: { CODEX_HOME: store.home(acc.id) } })
          ran[acc.label] = 'ran a one-word job'
        } catch (error) { ran[acc.label] = `job failed: ${toolErrorText(error)}` }
      }
      const usage = await store.usage()
      const rows = (summarizeUsage({ codex: usage }) as any).chatgpt.filter((r: any) => chosen.some(c => c.label === r.account))
      return { jobs: ran, accounts: rows }
    }
  },
  {
    name: 'remember',
    help: 'Save one short note to your own memory file so you remember it in later chats (the user may ask you to remember a preference or fact).',
    args: { note: 'the note, one sentence' },
    run: async (a, ctx) => {
      if (typeof a.note !== 'string') throw new ToolError('note must be text.')
      await ctx.store.remember(a.note)
      return { saved: true }
    }
  }
]

async function resolveArchived(ctx: ToolContext, ref: unknown): Promise<SeriesRow> {
  const archived: { id: string; title: string; rootFolder: string }[] = await call(ctx, 'GET', '/series/archived')
  const q = typeof ref === 'string' ? ref.trim().toLowerCase() : ''
  const hits = archived.filter(r => r.id === ref || r.title.toLowerCase() === q || (q && r.title.toLowerCase().includes(q)))
  if (hits.length !== 1) throw new ToolError(hits.length ? `Several archived series match: ${hits.map(h => `"${h.title}"`).join(', ')}.` : `No archived series matches "${ref}".`)
  return hits[0]
}

const kit: ToolKit = { call, ToolError, resolveSeries, chapterOf, int, bool, compact }
/** Library actions, then the script-writing ones (scriptTools.ts), then Settings (settingsTools.ts). */
export const TOOLS: AgentTool[] = [...BASE_TOOLS, ...scriptTools(kit), ...clipperTools(kit), ...settingsTools(kit)]

export const toolByName = (name: string) => TOOLS.find(t => t.name === name)

export function toolErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
