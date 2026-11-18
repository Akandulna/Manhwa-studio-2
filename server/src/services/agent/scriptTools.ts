/**
 * The agent's script-writing actions: everything the user can do to get a chapter's English and Hinglish script, in
 * the three places that write them —
 *   • AntiGravity → Narration scripts   (written on this Mac, `mac_*`)
 *   • Narration Library                 (Replace, Clear scripts, Fetch from phone, phone versions; `script_*`, `phone_script*`)
 *   • Sleeper-Cell → Run automation → Narration scripts (written on a phone, `phone_*`)
 * Every action goes through Studio's own HTTP API, exactly like a click on those pages. Anything that replaces or throws
 * away work (a rewrite, Replace, Clear scripts, the phone's version over Studio's, Start over, Stop now) is parked for
 * the user's approval in the chat. Not here (by decision): Gemini MCP, the copy-paste "Create with prompts", voiceover.
 */

import type { AgentTool, ToolContext } from './agentTools.js'
import { findSetting, sameValue, SettingError, type SettingDef } from './settingsTools.js'
import { engineReadiness, runEngineTest } from './engineReady.js'

type Parsed = string | number | boolean | null

export interface ToolKit {
  call: <T = any>(ctx: ToolContext, method: string, path: string, body?: unknown) => Promise<T>
  ToolError: new (message: string) => Error
  resolveSeries: (ctx: ToolContext, ref: unknown) => Promise<{ id: string; title: string; rootFolder: string }>
  chapterOf: (ctx: ToolContext, seriesId: string, number: unknown) => Promise<{ id: string; number: number; status: string }>
  int: (value: unknown, name: string, min?: number, max?: number) => number
  bool: (value: unknown, name: string) => boolean
  compact: (numbers: number[]) => string
}

/** Fixed production parts of 20 chapters (seriesProcessModel PART_CHAPTERS). */
export const PART_SIZE = 20
export const partOf = (chapterNumber: number) => Math.max(1, Math.ceil(chapterNumber / PART_SIZE))
const SCRIPT_WRITTEN = ['done', 'edited', 'stale']
/** Job stages in which AntiGravity is working on a chapter (AntiGravityClipper ACTIVE_JOB). */
export const ACTIVE_JOB = new Set(['pending', 'preparing', 'uploading', 'queued', 'analyzing', 'describing', 'planning', 'reviewing', 'validating', 'delivering', 'publishing'])
/** Job stages the user can Continue / Retry / Start over from. */
export const PROBLEM_JOB = new Set(['failed', 'needs_attention', 'interrupted', 'cancelled', 'publish_failed', 'rejected'])
const FILE = { en: 'narration-en', hi: 'narration-hi' } as const

type Lang = 'en' | 'hi'
const langName = (l: Lang) => (l === 'hi' ? 'Hinglish' : 'English')
/** The long "waiting" reasons AntiGravity gives, in a few words (the agent's context is small). */
export const shortReason = (reason: string) => reason
  .replace(/^Chapter \d+ needs its English script.*$/i, 'waiting for the previous chapter\'s script')
  .replace(/^Needs its English script first.*$/i, 'needs its English script first')
const clip = (text: string | null | undefined, max = 200) => (text && text.length > max ? `${text.slice(0, max)}…` : text ?? '')
const words = (text: string) => (text.trim().match(/\S+/g) ?? []).length

/** A phone's name or id, a profile's name: a unique match by exact text first, then by part of it. */
function pickOne<T>(items: T[], ref: unknown, text: (item: T) => string[], what: string, fail: (m: string) => Error): T {
  const q = typeof ref === 'string' ? ref.trim().toLowerCase() : ''
  if (!q) throw fail(`Say which ${what}.`)
  const exact = items.filter(i => text(i).some(t => t.toLowerCase() === q))
  if (exact.length === 1) return exact[0]
  const part = items.filter(i => text(i).some(t => t.toLowerCase().includes(q)))
  if (part.length === 1) return part[0]
  if (!part.length) throw fail(`No ${what} matches "${ref}".`)
  throw fail(`"${ref}" matches several ${what}s: ${part.slice(0, 6).map(i => text(i)[0]).join(', ')}. Use the exact name.`)
}

export function scriptTools(kit: ToolKit): AgentTool[] {
  const { call, ToolError, resolveSeries, chapterOf, int, bool, compact } = kit
  const fail = (m: string) => new ToolError(m)

  const lang = (value: unknown, fallback?: Lang): Lang => {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (['en', 'english'].includes(v)) return 'en'
    if (['hi', 'hindi', 'hinglish'].includes(v)) return 'hi'
    if (!v && fallback) return fallback
    throw fail('language must be en (English) or hi (Hinglish).')
  }

  /** The part to work on: given, or the one every named chapter belongs to. */
  const partFrom = (a: Record<string, any>, numbers?: number[]): number => {
    if (a.part !== undefined && a.part !== null && a.part !== '') return int(a.part, 'part')
    if (numbers?.length) {
      const parts = new Set(numbers.map(partOf))
      if (parts.size === 1) return [...parts][0]
      throw fail(`Those chapters are in several parts (${[...parts].join(', ')}). Do one part at a time, or say which part.`)
    }
    throw fail('Say which part (1 = chapters 1–20, 2 = 21–40 …).')
  }

  const numberList = (value: unknown, name: string): number[] => {
    const list = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]
    const out = list.map(v => int(v, name, 0))
    if (new Set(out).size !== out.length) throw fail(`${name} lists a chapter twice.`)
    if (out.length > 60) throw fail('At most 60 chapters per call.')
    return out
  }

  // ─── What each part looks like (AntiGravity's own per-chapter status) ───
  async function partStatus(ctx: ToolContext, seriesId: string, part: number) {
    return (await call<{ chapters: any[] }>(ctx, 'POST', '/antigravity/narration/status', { seriesId, partNumber: part })).chapters
  }
  async function narrationJobs(ctx: ToolContext, chapterIds: string[]) {
    if (!chapterIds.length) return []
    return call<any[]>(ctx, 'POST', '/antigravity/page-jobs', { chapterIds, kind: 'narration' })
  }
  const jobOf = (jobs: any[], chapterId: string, language: Lang) => jobs.find(j => j.chapterId === chapterId && j.filename === FILE[language])

  /**
   * Why the Mac can't write scripts now (empty blockers = it can). Antigravity or ChatGPT (Codex) write them, never
   * Claude. The agent switches the engine only when the user asks (settings_change ai.engine, with approval).
   */
  async function macBlockers(ctx: ToolContext): Promise<{ blockers: string[]; engine: string; model: string | null; effort: string | null; proofOnly: boolean }> {
    const view = await call<any>(ctx, 'GET', '/antigravity/connection')
    const engine: string = view?.settings?.engine ?? 'antigravity'
    const blockers: string[] = []
    let proofOnly = false
    if (engine === 'codex') {
      const cx = await call<any>(ctx, 'GET', '/antigravity/codex/connection')
      const model: string | null = cx?.settings?.modelLabel ?? cx?.settings?.model ?? null
      const usable = (cx?.accounts?.accounts ?? []).filter((a: any) => a.enabled && !a.limited)
      if (!cx?.installation?.path) blockers.push('The Codex CLI (inside ChatGPT.app) was not found on this Mac.')
      else if (!cx.account?.signedIn) blockers.push(cx.account?.detail ?? 'No ChatGPT account is signed in to Codex (Settings → AntiGravity → ChatGPT (Codex)).')
      else if (!cx.settings?.model) blockers.push('No ChatGPT (Codex) model is chosen (settings_change ai.codex.model).')
      else if (!usable.length) blockers.push('Every ChatGPT account Studio can use has reached its Codex limit or is turned off (Settings → AntiGravity → ChatGPT (Codex) shows when one resets).')
      else if (!cx.proofValid) { blockers.push(cx.proofNote ?? 'Run the Codex compatibility test.'); proofOnly = true }
      return { blockers, engine, model, effort: cx?.settings?.effort ?? null, proofOnly }
    }
    const model: string | null = view?.settings?.modelLabel ?? view?.settings?.model ?? null
    if (engine !== 'antigravity') {
      blockers.push(`Narration scripts are written with Antigravity or ChatGPT (Codex), and "${engine}" is selected in Settings → AntiGravity → AI engine. Tell the user; switch it only if they ask (settings_change ai.engine, needs their approval), or use a phone.`)
    } else if (!view?.installation?.path) blockers.push('The Antigravity CLI is not installed.')
    else if (!view.settings?.model) blockers.push('No Antigravity model is chosen (Settings → AntiGravity).')
    else if (!view.proofValid) { blockers.push(view.proofNote ?? 'Run the Antigravity compatibility test in Settings → AntiGravity.'); proofOnly = true }
    else if (/^gpt-oss/i.test(view.settings.model)) blockers.push(`${model} has no image input; the user must choose a vision model in Settings → AntiGravity.`)
    return { blockers, engine, model, effort: view?.settings?.effort ?? null, proofOnly }
  }

  /**
   * Runs the selected engine's compatibility test (Antigravity or ChatGPT/Codex: two small real turns on the selected
   * model; uses a little quota) and returns what the Mac's blockers are afterwards. A model change makes the last test
   * invalid, and the user wants the agent to run the test itself rather than send them to Settings.
   */
  async function runCompatibilityTest(ctx: ToolContext, engine: string) {
    const route = engine === 'codex' ? '/antigravity/codex/check' : '/antigravity/check'
    const report = await call<{ ok?: boolean; error?: string | null; model?: string; durationMs?: number }>(ctx, 'POST', route)
    return { report, after: await macBlockers(ctx) }
  }

  async function currentMacProcess(ctx: ToolContext) {
    const cur = await call<{ live: boolean; run: any | null }>(ctx, 'GET', '/antigravity/runs/current')
    return cur.live && cur.run ? cur.run : null
  }
  const kindName = (kind: string | undefined) => (kind === 'metadata' ? 'Metadata' : kind === 'editor' ? 'Timeline' : kind === 'narration' ? 'Narration' : 'Image Clipper')

  // ─── Phones ───
  async function phoneOverview(ctx: ToolContext, fresh = false) {
    return call<any>(ctx, 'GET', `/r2/phone/overview${fresh ? '?fresh=1' : ''}`)
  }
  const phoneCanWrite = (p: any) => Array.isArray(p?.automation?.runs) && p.automation.runs.includes('narration')
  const phoneScopes = (p: any) => Array.isArray(p?.automation?.chapterRuns) && p.automation.chapterRuns.includes('narration')
  const phoneIdle = (p: any) => p.connected === true && (p.runs ?? 0) === 0 && (p.working ?? 0) === 0 && !p.automation?.resume
  const phoneState = (p: any) => (p.connected === true ? ((p.runs ?? 0) + (p.working ?? 0) > 0 ? 'busy' : p.automation?.resume ? 'waiting to resume a run' : 'idle') : p.connected === false ? `offline${p.left ? ` (${p.left})` : ''}` : 'unknown (no relay)')

  function pickPhone(overview: any, ref: unknown) {
    const phones: any[] = (overview.phones ?? []).filter((p: any) => p.id)
    if (!phones.length) throw fail('No phone is known to the relay (Settings → Cloudflare, then open Sleeper-Cell on the phone).')
    if (ref !== undefined && ref !== null && ref !== '') return pickOne(phones, ref, p => [p.name, p.id], 'phone', fail)
    const ready = phones.filter(p => phoneIdle(p) && phoneCanWrite(p) && phoneScopes(p))
    if (ready.length >= 1) return ready[0]
    throw fail(`No phone is online and idle with a Sleeper-Cell build that can write scripts for a part. Phones: ${phones.map(p => `${p.name} (${phoneState(p)}${phoneCanWrite(p) ? '' : ', build cannot start narration'})`).join('; ')}.`)
  }

  async function narrationReadiness(ctx: ToolContext, seriesId: string, part?: number) {
    const q = new URLSearchParams({ kind: 'narration', seriesId, language: 'en', ...(part ? { part: String(part) } : {}) })
    return call<any>(ctx, 'GET', `/r2/phone/readiness?${q}`)
  }

  /** Selects a browser profile on a phone and waits (up to ~25 s) until the phone's receipt shows it selected. */
  async function selectProfile(ctx: ToolContext, phone: any, profileRef: unknown) {
    const overview = await phoneOverview(ctx)
    const profiles: any[] = (overview.profiles ?? []).filter((p: any) => p.device === phone.id)
    if (!profiles.length) throw fail(`${phone.name} has not reported any browser profiles yet (Phone Status → Refresh from phone).`)
    const profile = pickOne(profiles, profileRef, p => [p.name, p.profileId], 'profile', fail)
    if (profile.selected) return { profile: profile.name, changed: false }
    await call(ctx, 'POST', '/r2/phone/profile', { command: 'select', device: phone.id, profile: profile.profileId })
    const until = Date.now() + 25_000
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, 2500))
      const now = await phoneOverview(ctx)
      if ((now.profiles ?? []).some((p: any) => p.device === phone.id && p.profileId === profile.profileId && p.selected)) return { profile: profile.name, changed: true }
    }
    throw fail(`Asked ${phone.name} to switch to profile "${profile.name}" but it has not confirmed yet. Check Phone Status, then try again.`)
  }

  const seriesWatchInfo = (s: { id: string; title: string }) => ({ seriesId: s.id, title: s.title })

  return [
    // ───────────────────────── reading ─────────────────────────
    {
      name: 'scripts_status',
      help: 'Where a series stands on narration scripts: per part, how many chapters have an English and a Hinglish script; for one part, each chapter\'s scripts, why a chapter is blocked, its AntiGravity job state and last problem; plus the AntiGravity process and the phone runs going now.',
      args: { series: 'title or id', part: 'optional part number (1 = chapters 1–20); give it for the per-chapter view' },
      run: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const rows = await ctx.prisma.chapter.findMany({ where: { seriesId: s.id }, orderBy: { number: 'asc' }, select: { number: true, status: true, completedAt: true, scripts: { select: { language: true, status: true } } } })
        const written = (r: typeof rows[number], l: Lang) => r.scripts.some(x => x.language === l && SCRIPT_WRITTEN.includes(x.status))
        const parts = new Map<number, { downloaded: number[]; en: number[]; hi: number[]; completed: boolean }>()
        for (const r of rows) {
          const p = parts.get(partOf(r.number)) ?? { downloaded: [], en: [], hi: [], completed: true }
          if (r.status === 'done') p.downloaded.push(r.number)
          if (written(r, 'en')) p.en.push(r.number)
          if (written(r, 'hi')) p.hi.push(r.number)
          if (!r.completedAt) p.completed = false
          parts.set(partOf(r.number), p)
        }
        const overviewByPart = [...parts].sort(([x], [y]) => x - y).map(([part, p]) => ({
          part, chapters: `${compact([...p.downloaded])} downloaded`, english: `${p.en.length}/${p.downloaded.length}`, hinglish: `${p.hi.length}/${p.downloaded.length}`, ...(p.completed && p.downloaded.length ? { completed: true } : {})
        }))
        const out: Record<string, unknown> = { series: s.title, parts: overviewByPart }
        if (a.part !== undefined && a.part !== null && a.part !== '') {
          const part = int(a.part, 'part')
          const status = await partStatus(ctx, s.id, part)
          const jobs = await narrationJobs(ctx, status.map(c => c.id))
          out.part = part
          out.chapters = status.map(c => {
            const ej = jobOf(jobs, c.id, 'en'), hj = jobOf(jobs, c.id, 'hi')
            const line = (l: Lang, has: boolean, blocked: string | null, stale: boolean, job: any) =>
              `${has ? (stale ? 'has script (older English)' : 'has script') : blocked ? `waiting: ${clip(shortReason(blocked), 120)}` : 'no script'}${job ? ` · job ${job.stage}${job.lastError ? `: ${clip(job.lastError, 160)}` : ''}` : ''}`
            return { chapter: c.number, ...(c.pages ? { pages: c.pages } : { pages: 'none downloaded' }), english: line('en', c.hasScript, c.blocked, false, ej), hinglish: line('hi', c.hinglish.hasScript, c.hinglish.blocked, c.hinglish.stale, hj) }
          })
        }
        const process = await currentMacProcess(ctx)
        out.antigravityProcess = process
          ? { kind: kindName(process.kind), part: process.partNumber, state: process.control, thisSeries: process.seriesId === s.id }
          : 'none running'
        try {
          const o = await phoneOverview(ctx)
          const mine = (o.series ?? []).find((x: any) => x.id === s.id)
          out.phones = {
            scriptsOnPhones: mine?.scripts ? `${mine.scripts.done}/${mine.scripts.total} chapters scripted` : 'none yet',
            runningNow: (o.runs ?? []).filter((r: any) => r.kind === 'narration').map((r: any) => ({ phone: r.phone, series: r.series, done: `${r.done}/${r.total}`, ...(r.paused && { paused: true }), ...(r.stopping && { stopping: true }), chapters: (r.tabs ?? []).map((t: any) => t.chapter) }))
          }
        } catch { out.phones = 'could not read the phone status' }
        return out
      }
    },
    {
      name: 'scripts_where',
      help: 'Where scripts can be written right now, with a suggestion. This Mac (AntiGravity): engine, model and blockers. Phones: online or not, idle or busy, whether the build can write scripts, their browser profiles, and what the phone still needs for this series and part (pages). Call it before starting scripts when the user did not say where.',
      args: { series: 'title or id', part: 'optional part number', refresh: 'optional true: re-read the phones\' receipts from R2 first (only when the user asks)' },
      run: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const part = a.part !== undefined && a.part !== null && a.part !== '' ? int(a.part, 'part') : undefined
        const mac = await macBlockers(ctx)
        const proc = await currentMacProcess(ctx)
        const macBusy = proc ? `a ${kindName(proc.kind)} process is ${proc.control} (part ${proc.partNumber}${proc.seriesId === s.id ? ', this series' : ', another series'}); only one runs at a time` : null
        const overview = await phoneOverview(ctx, a.refresh === true || a.refresh === 'true')
        const phones = (overview.phones ?? []).filter((p: any) => p.id).map((p: any) => ({
          name: p.name, state: phoneState(p), canWriteScripts: phoneCanWrite(p) && phoneScopes(p),
          profiles: (() => {
            const mine: any[] = (overview.profiles ?? []).filter((x: any) => x.device === p.id)
            const limited = mine.filter(x => x.limitedUntil && Date.parse(x.limitedUntil) > Date.now()).map(x => x.name)
            return `${mine.length} profiles; selected: ${mine.find(x => x.selected)?.name ?? 'none'}; others: ${mine.filter(x => !x.selected).map(x => x.name).join(', ') || '—'}${limited.length ? `; ChatGPT-limited now: ${limited.join(', ')}` : ''}`
          })()
        }))
        let needs: unknown = 'not checked (needs the phone relay)'
        let ready = false
        try {
          const r = await narrationReadiness(ctx, s.id, part)
          ready = !!r.ready
          needs = { part: r.narrationScope?.part, chaptersInScope: r.narrationScope?.chapters?.length ?? 0, ready: r.ready, canWork: r.canWork, items: (r.items ?? []).filter((i: any) => i.state !== 'ready').map((i: any) => `${i.label}: ${i.state} — ${clip(i.detail, 160)}${i.fix ? ` [fix: ${i.fix.label}]` : ''}`) }
        } catch (error) { needs = `could not check: ${error instanceof Error ? error.message : error}` }
        const idle = (overview.phones ?? []).filter((p: any) => p.id && phoneIdle(p) && phoneCanWrite(p) && phoneScopes(p))
        const suggested = idle.length ? { where: 'phone', phone: idle[0].name, why: 'a phone is online and idle' }
          : !mac.blockers.length && !macBusy ? { where: 'mac', why: 'no phone is online and idle; this Mac (AntiGravity) is ready' }
          : { where: 'none', why: 'no phone is online and idle, and this Mac cannot start now (see mac.blockers / mac.busy)' }
        return { series: s.title, suggested, mac: { engine: mac.engine, model: mac.model, ...(mac.effort && { effort: mac.effort }), blockers: mac.blockers, ...(macBusy && { busy: macBusy }) }, phones, phoneNeeds: needs, phoneReady: ready }
      }
    },
    {
      name: 'script_read',
      help: 'Read a chapter\'s saved script (the first ~5,000 characters, with its length).',
      args: { series: 'title or id', chapter: 'chapter number', language: 'en or hi (default en)' },
      run: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const chapter = await chapterOf(ctx, s.id, a.chapter)
        const l = lang(a.language, 'en')
        const r = await call<{ text: string }>(ctx, 'GET', `/narration/chapters/${chapter.id}/script?lang=${l}`)
        if (!r.text) return { chapter: chapter.number, language: langName(l), script: null, note: 'No script saved.' }
        return { chapter: chapter.number, language: langName(l), words: words(r.text), characters: r.text.length, script: clip(r.text, 5000) }
      }
    },

    // ───────────────────────── this Mac: AntiGravity → Narration scripts ─────────────────────────
    {
      name: 'antigravity_compat_test',
      help: 'Run the compatibility test of the selected AI engine (Antigravity, ChatGPT/Codex or Claude) on its selected model (Settings → AntiGravity → Run test): two small real turns, a little quota, about a minute or two. Needed after the engine, model or sandbox changes before scripts can start on this Mac. mac_scripts_start runs it by itself when it is the only thing missing, so call this only when the user asks for the test on its own (e.g. "change to X and test compatibility").',
      args: {},
      run: async (_a, ctx) => {
        const running = await currentMacProcess(ctx)
        if (running) throw fail(`A ${kindName(running.kind)} process is ${running.control} (part ${running.partNumber}). Do not run the test while a process is running: a failed test would block its next chapters. Nothing was run.`)
        // Any engine: Image Clipper, Metadata and Timeline run on all three; scripts on Antigravity or Codex only.
        const before = await engineReadiness(call, ctx)
        if (!before.proofOnly && before.blockers.length) throw fail(before.blockers.join(' '))
        const report = await runEngineTest(call, ctx, before.engine)
        const after = await engineReadiness(call, ctx)
        const scripts = await macBlockers(ctx)
        return {
          engine: before.label, passed: !!report.ok, model: report.model ?? before.model, ...(before.effort && { effort: before.effort }), ...(report.error && { error: clip(report.error, 300) }),
          readyForJobs: !after.blockers.length, readyForScripts: !scripts.blockers.length, ...(after.blockers.length && { stillBlocked: after.blockers }),
          ...(before.engine === 'claude' && { note: 'Claude can run Image Clipper, Metadata and Timeline jobs, not narration scripts.' })
        }
      }
    },
    {
      name: 'mac_scripts_start',
      help: 'Write scripts on this Mac with AntiGravity (English, then its Hinglish, chapter by chapter in order, each saved like Replace and sent to the phones for voiceover). Without chapters: Start process = every chapter of the part that is missing a script. With chapters: write or rewrite just those; a chapter that already has a script is rewritten (needs the user\'s approval: the old script is backed up, its voiceover/alignment/timeline reset). Joins a process already running on that part. Works with the Antigravity or the ChatGPT (Codex) engine (whichever Settings → AntiGravity → AI engine selects; runs its compatibility test first when that is all that is missing). With Claude selected, tell the user; change the engine only when they ask (settings_change ai.engine, needs approval).',
      args: { series: 'title or id', part: 'part number (optional when chapters are given)', chapters: 'optional list of chapter numbers to write or rewrite' },
      prepare: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const picked = numberList(a.chapters, 'chapters')
        const part = partFrom(a, picked)
        // A process may already be running (the user or Studio started it a moment ago): then this is a join, not a start.
        const proc = await currentMacProcess(ctx)
        if (proc && (proc.seriesId !== s.id || proc.partNumber !== part || proc.kind !== 'narration')) {
          throw fail(`A ${kindName(proc.kind)} process is ${proc.control} on another part or series. Only one process runs at a time: wait for it, or ask the user to stop it.`)
        }
        if (proc && !picked.length) return { alreadyRunning: true, runId: proc.id, state: proc.control, seriesId: s.id, title: s.title, part, chapterIds: [] as string[], numbers: [] as number[], rewrites: [] as number[] }
        if (!proc) {
          let { blockers, proofOnly, model, engine } = await macBlockers(ctx)
          if (proofOnly) {
            // Only the compatibility test is missing (usually after a model change): run it, then carry on. Never while a process runs.
            const tested = await runCompatibilityTest(ctx, engine).catch(error => { throw fail(`The compatibility test for ${model} could not run: ${error instanceof Error ? error.message : error}`) })
            if (!tested.report.ok) throw fail(`The compatibility test for ${model} failed${tested.report.error ? `: ${clip(tested.report.error, 300)}` : ''}. Scripts were not started; the user can look at AntiGravity → Settings.`)
            blockers = tested.after.blockers
          }
          if (blockers.length) throw fail(blockers.join(' '))
        }
        const status = await partStatus(ctx, s.id, part)
        if (!status.length) throw fail(`Part ${part} has no chapters in "${s.title}".`)
        const jobs = await narrationJobs(ctx, status.map(c => c.id))
        const busy = (c: any) => ACTIVE_JOB.has(jobOf(jobs, c.id, 'en')?.stage) || ACTIVE_JOB.has(jobOf(jobs, c.id, 'hi')?.stage)
        if (!picked.length) {
          // Start process writes chapters with no English script, and the Hinglish of those that have English only.
          const missing = status.filter(c => (!c.hasScript && !c.blocked) || (c.hasScript && !c.hinglish.hasScript && !c.hinglish.blocked))
          if (!missing.length) throw fail(`Every chapter in part ${part} already has its English and Hinglish script, or is blocked (see scripts_status). Name chapters to rewrite them.`)
          return { seriesId: s.id, title: s.title, part, chapterIds: [] as string[], numbers: [] as number[], rewrites: [] as number[] }
        }
        const chosen = picked.map(n => {
          const c = status.find(x => x.number === n)
          if (!c) throw fail(`Chapter ${n} is not in part ${part}.`)
          if (busy(c)) throw fail(`Chapter ${n} is already being written: the process is running (check scripts_status), nothing to start.`)
          if (c.blocked && !c.hasScript) throw fail(`Chapter ${n} cannot be written yet: ${c.blocked}`)
          if (c.blocked && c.hasScript && /completed|no pages|not downloaded/i.test(c.blocked)) throw fail(`Chapter ${n} cannot be rewritten: ${c.blocked}`)
          return c
        })
        return { seriesId: s.id, title: s.title, part, chapterIds: chosen.map(c => c.id), numbers: chosen.map(c => c.number), rewrites: chosen.filter(c => c.hasScript).map(c => c.number) }
      },
      approval: async a => a.rewrites?.length
        ? `Rewrite the script of "${a.title}" chapter ${compact(a.rewrites)} on this Mac. The current English script is backed up and replaced; that chapter's English voiceover, alignment and Editor timeline are reset, then its Hinglish is rewritten too (Hindi ones reset the same way) and both go to the phones for a new voiceover`
        : null,
      run: async (a, ctx) => {
        if (a.alreadyRunning) {
          await ctx.watch?.({ kind: 'mac', runId: a.runId, ...seriesWatchInfo({ id: a.seriesId, title: a.title }), part: a.part })
          return { alreadyRunning: true, series: a.title, part: a.part, state: a.state, note: 'The Narration process for this part is already running (started by the user or Studio); nothing to start. I will post here when it finishes or stops with a problem.' }
        }
        const body = a.chapterIds.length
          ? { seriesId: a.seriesId, partNumber: a.part, pages: a.chapterIds.map((chapterId: string) => ({ chapterId, filename: FILE.en })), prepareOnly: false, kind: 'narration' }
          : { seriesId: a.seriesId, partNumber: a.part, mode: 'next', kind: 'narration' }
        const r = await call<{ runId: string | null; created: string[]; reused: string[]; skipped: { reason: string }[] }>(ctx, 'POST', '/antigravity/runs', body)
        const total = r.created.length + r.reused.length
        if (!total) throw fail(`Nothing could start: ${r.skipped.slice(0, 3).map(x => x.reason).join('; ') || 'no chapter needs a script'}.`)
        if (r.runId) await ctx.watch?.({ kind: 'mac', runId: r.runId, ...seriesWatchInfo({ id: a.seriesId, title: a.title }), part: a.part })
        return { started: true, series: a.title, part: a.part, chapters: a.chapterIds.length ? compact(a.numbers) : 'all chapters of the part that are missing a script', alreadyInProgress: r.reused.length, skipped: r.skipped.slice(0, 3).map(x => x.reason), note: 'Runs in the background; I will post here when it finishes or stops with a problem.' }
      }
    },
    {
      name: 'mac_scripts_after',
      help: 'Queue the next script run on this Mac: when the AntiGravity process running now ends, Studio starts Narration scripts for another series\' part by itself (same checks as mac_scripts_start: engine, compatibility test, only what is missing) and posts here. Use it right away for "when X finishes, start Y" — you cannot wait or act later yourself. By default it starts only if the running Narration part ended with every English and Hinglish script (the usual meaning of "finished"); a stopped run never starts the next. If every ChatGPT/Antigravity account is at its limit then, Studio retries every 10 minutes. One queued start per Mac: a new one replaces the old. Nothing running now → use mac_scripts_start instead.',
      args: { series: 'the series to start next (title or id)', part: 'optional part number (default: its first part with chapters missing a script)', require_complete: 'optional true/false (default true): start only when the running part has all its scripts' },
      prepare: async (a, ctx) => {
        const proc = await currentMacProcess(ctx)
        if (!proc) throw fail('Nothing is running on this Mac, so there is nothing to wait for. Start it now with mac_scripts_start.')
        const s = await resolveSeries(ctx, a.series)
        let part: number
        if (a.part !== undefined && a.part !== null && a.part !== '') part = int(a.part, 'part')
        else {
          const rows = await ctx.prisma.chapter.findMany({ where: { seriesId: s.id }, orderBy: { number: 'asc' }, select: { number: true, scripts: { select: { language: true, status: true } } } })
          const has = (r: typeof rows[number], l: Lang) => r.scripts.some(x => x.language === l && SCRIPT_WRITTEN.includes(x.status))
          const first = rows.find(r => !has(r, 'en') || !has(r, 'hi'))
          if (!first) throw fail(`Every chapter of "${s.title}" already has its English and Hinglish script.`)
          part = partOf(first.number)
        }
        if (proc.kind === 'narration' && proc.seriesId === s.id && proc.partNumber === part) throw fail(`"${s.title}" part ${part} is the process running now; nothing to queue.`)
        const status = await partStatus(ctx, s.id, part)
        if (!status.length) throw fail(`Part ${part} has no chapters in "${s.title}".`)
        if (status.every(c => c.hasScript && c.hinglish?.hasScript)) throw fail(`Every chapter in "${s.title}" part ${part} already has its English and Hinglish script.`)
        const afterTitle = (await ctx.prisma.series.findUnique({ where: { id: proc.seriesId }, select: { title: true } }))?.title ?? 'the running series'
        const requireComplete = a.require_complete === undefined || a.require_complete === null || a.require_complete === '' ? true : bool(a.require_complete, 'require_complete')
        const queued = (await ctx.store?.watches().catch(() => []) ?? []).find(w => w.kind === 'mac_next') as { title: string; part: number } | undefined
        const { blockers, proofOnly } = await macBlockers(ctx)
        return {
          runId: proc.id, afterKind: proc.kind as string, afterSeriesId: proc.seriesId as string, afterTitle, afterPart: proc.partNumber as number,
          seriesId: s.id, title: s.title, part, requireComplete,
          replaces: queued ? `"${queued.title}" part ${queued.part}` : null,
          // Not a reason to refuse (a limit may lift, a test runs by itself), but the agent should mention it.
          macNow: blockers.length && !proofOnly ? blockers : []
        }
      },
      run: async (a, ctx) => {
        if (!ctx.watch) throw fail('This needs a chat to post in.')
        await ctx.watch({ kind: 'mac_next', runId: a.runId, afterKind: a.afterKind, afterSeriesId: a.afterSeriesId, afterTitle: a.afterTitle, afterPart: a.afterPart, seriesId: a.seriesId, title: a.title, part: a.part, requireComplete: a.requireComplete })
        return {
          queued: true, next: `"${a.title}" part ${a.part}`, after: `"${a.afterTitle}" part ${a.afterPart} (${kindName(a.afterKind)}, running now)`,
          condition: a.afterKind === 'narration' && a.requireComplete ? 'starts only if that part ends with every English and Hinglish script; a stopped run starts nothing' : 'starts when that process ends (not if it is stopped)',
          ...(a.replaces && { replaced: `the earlier queued start of ${a.replaces}` }),
          ...(a.macNow.length && { blockedRightNow: a.macNow, blockedNote: 'If this is still true when the run ends, Studio says so here (a usage limit is retried every 10 minutes).' }),
          note: 'Studio does this by itself and posts here when it starts the next part (or why it did not). Do not wait or poll.'
        }
      }
    },
    {
      name: 'mac_run_watch',
      help: 'Have Studio post here when the AntiGravity Narration or Image Clipper process running on this Mac (started by anyone) finishes or stops with a problem. Use it when the user asks to be told when a run ends and no start action of yours already set that up. Reading actions (scripts_status, clipper_status …) never set it up.',
      args: {},
      prepare: async (_a, ctx) => {
        const proc = await currentMacProcess(ctx)
        if (!proc) throw fail('Nothing is running on this Mac.')
        if (proc.kind !== 'narration' && proc.kind !== 'clipper') throw fail(`The running process is ${kindName(proc.kind)}; I can only report on Narration and Image Clipper runs.`)
        const title = (await ctx.prisma.series.findUnique({ where: { id: proc.seriesId }, select: { title: true } }))?.title ?? 'this series'
        return { runId: proc.id, kind: proc.kind, seriesId: proc.seriesId, title, part: proc.partNumber }
      },
      run: async (a, ctx) => {
        if (!ctx.watch) throw fail('This needs a chat to post in.')
        await ctx.watch({ kind: a.kind === 'clipper' ? 'clipper' : 'mac', runId: a.runId, seriesId: a.seriesId, title: a.title, part: a.part })
        return { watching: `${kindName(a.kind)} "${a.title}" part ${a.part}`, note: 'Studio posts here when it finishes or stops with a problem.' }
      }
    },
    {
      name: 'mac_scripts_control',
      help: 'Control the AntiGravity Narration process running on this Mac: pause, resume, stop (the chapter in progress finishes and saves first), keep_running (take back a stop), or stop_now (cancels the chapter in progress; needs the user\'s approval).',
      args: { action: 'pause | resume | stop | keep_running | stop_now' },
      prepare: async (a, ctx) => {
        const action = typeof a.action === 'string' ? a.action.trim().toLowerCase().replace(/-/g, '_') : ''
        if (!['pause', 'resume', 'stop', 'keep_running', 'stop_now'].includes(action)) throw fail('action must be pause, resume, stop, keep_running or stop_now.')
        const proc = await currentMacProcess(ctx)
        if (!proc) throw fail('No AntiGravity process is running.')
        if (proc.kind !== 'narration') throw fail(`The running process is ${kindName(proc.kind)}, not Narration scripts; I only control script runs.`)
        return { action, runId: proc.id, part: proc.partNumber, seriesId: proc.seriesId }
      },
      approval: async a => a.action === 'stop_now' ? 'Stop the Narration process now: the chapter being written is cancelled and cannot save a late result (saved scripts stay)' : null,
      run: async (a, ctx) => {
        const url = a.action === 'keep_running' ? 'resume' : a.action === 'stop_now' ? 'stop-now' : a.action
        await call(ctx, 'POST', `/antigravity/runs/${a.runId}/${url}`)
        return { done: a.action, part: a.part }
      }
    },
    {
      name: 'mac_scripts_switch',
      help: 'Do this in order, hands-off: stop the Narration process on this Mac after the chapter being written finishes and saves (a graceful stop), change AntiGravity setting(s) (usually the model), then start the same part again so it carries on with the new setting. Studio does the later steps by itself and posts here. Use it when the user says things like "when the current script finishes, switch to Gemini 4 Hydrogen High and continue". The reasoning level of an Antigravity model is part of its id (gemini-4-hydrogen-high = Gemini 4 Hydrogen, High): "set effort to 4 hydrogen high" means setting ai.antigravity.model to that id; check ids with settings_list if unsure. To move the run to ChatGPT (Codex), e.g. "switch to 6.1 Terra High": changes ai.engine = codex, ai.codex.model = gpt-6.1-terra, ai.codex.effort = high (Codex keeps the reasoning level separate from the model; check ids with settings_list). Switching ai.engine needs the user\'s approval and only antigravity or codex can write scripts. A new engine or model needs its compatibility test again; Studio runs it (two small jobs) before continuing. Only ai.engine, ai.antigravity.* (not sandbox off) and ai.codex.*; for anything else use settings_change.',
      args: { setting: 'e.g. ai.antigravity.model', value: 'e.g. gemini-4-hydrogen-high', changes: 'optional instead of setting/value: a list of {setting, value} for several changes', continue: 'optional true/false: start the part again afterwards (default true)' },
      prepare: async (a, ctx) => {
        const proc = await currentMacProcess(ctx)
        if (!proc) throw fail('No AntiGravity process is running. Change the setting with settings_change, then start the scripts with mac_scripts_start.')
        if (proc.kind !== 'narration') throw fail(`The running process is ${kindName(proc.kind)}, not Narration scripts; I only do this for script runs.`)
        if (!['running', 'preparing', 'paused', 'pause_requested'].includes(proc.control)) throw fail(`The Narration process is already ${proc.control}. Change the setting with settings_change, then use mac_scripts_control resume or mac_scripts_start.`)
        const asked: { setting?: unknown; value?: unknown }[] = Array.isArray(a.changes) && a.changes.length ? a.changes : [{ setting: a.setting, value: a.value }]
        if (asked.length > 6) throw fail('At most 6 changes at once.')
        const current = await call<Record<string, any>>(ctx, 'GET', '/antigravity/settings')
        const models = await call<{ models?: { id: string }[] }>(ctx, 'GET', '/antigravity/models').catch(() => null)
        let codex: any = null
        const changes: { setting: string; label: string; value: Parsed; from: string }[] = []
        for (const item of asked) {
          let def: SettingDef
          let value: Parsed
          try {
            def = findSetting(item.setting)
            if (!('value' in item)) throw new SettingError(`Give the new value for ${def.id}.`)
            value = def.parse(item.value)
          } catch (error) { throw fail(error instanceof Error ? error.message : String(error)) }
          const engineSwitch = def.id === 'ai.engine'
          if (!engineSwitch && (!['antigravity', 'codex'].includes(def.area) || def.risk)) throw fail(`${def.id} is not one I change in this sequence (the engine, and the Antigravity or ChatGPT (Codex) model, reasoning level, parallel runs and timeout only). Use settings_change for it.`)
          if (engineSwitch && value !== 'antigravity' && value !== 'codex') throw fail('Narration scripts are written with antigravity or codex only; Claude cannot take over a script run.')
          if (def.id === 'ai.antigravity.model' && value && models?.models && !models.models.some(m => m.id === value)) {
            throw fail(`The signed-in Antigravity does not offer "${value}". Its models: ${models.models.map(m => m.id).join(', ')}.`)
          }
          if (def.area === 'codex') codex ??= await call<any>(ctx, 'GET', '/antigravity/codex/connection')
          if (def.id === 'ai.codex.model' && value && codex?.models && !codex.models.some((m: any) => m.id === value && m.image)) {
            throw fail(`ChatGPT (Codex) has no image model "${value}". Its models: ${codex.models.filter((m: any) => m.image).map((m: any) => `${m.id} (${m.label})`).join(', ')}.`)
          }
          const before = def.pick(def.area === 'codex' ? codex?.settings ?? {} : current)
          if (sameValue(before, value)) continue
          changes.push({ setting: def.id, label: def.label, value, from: before === null || before === undefined ? 'default' : String(before) })
        }
        if (!changes.length) throw fail('Everything asked for is already set. Nothing to switch.')
        const row = await ctx.prisma.series.findUnique({ where: { id: proc.seriesId }, select: { title: true } })
        return { runId: proc.id, seriesId: proc.seriesId, title: row?.title ?? 'this series', part: proc.partNumber, changes, resume: a.continue === undefined ? true : bool(a.continue, 'continue') }
      },
      approval: async a => {
        const engine = (a.changes as { setting: string; value: Parsed; from: string }[]).find(c => c.setting === 'ai.engine')
        return engine
          ? `After the chapter being written on this Mac finishes, switch the engine behind every new AntiGravity job from ${engine.from} to ${engine.value}${a.changes.length > 1 ? ` (and: ${a.changes.filter((c: any) => c.setting !== 'ai.engine').map((c: any) => `${c.label} → ${c.value ?? 'default'}`).join('; ')})` : ''}, run its compatibility test if needed (a little quota), then ${a.resume ? `carry on with "${a.title}" part ${a.part}` : 'leave the process stopped'}`
          : null
      },
      run: async (a, ctx) => {
        await call(ctx, 'POST', `/antigravity/runs/${a.runId}/stop`)
        const run = await call<{ control: string; finishedAt?: string | null }>(ctx, 'GET', `/antigravity/runs/${a.runId}`).then(r => (r as any).run ?? r)
        if (!['stop_requested', 'stopped'].includes(run.control)) throw fail(`Studio did not accept the stop (the process is "${run.control}"). Nothing was changed; try mac_scripts_control stop, or ask the user.`)
        await ctx.watch?.({ kind: 'mac_switch', runId: a.runId, seriesId: a.seriesId, title: a.title, part: a.part, changes: a.changes.map((c: any) => ({ setting: c.setting, value: c.value, label: c.label })), resume: a.resume })
        return {
          stopping: true, series: a.title, part: a.part,
          then: a.changes.map((c: any) => `${c.label}: ${c.from} → ${c.value ?? 'default'}`),
          afterwards: a.resume ? 'start the part again (it carries on where it stopped; a chapter with English but no Hinglish gets its Hinglish)' : 'stay stopped',
          note: 'The chapter being written finishes and saves first. Studio does the remaining steps by itself and I will post here at each outcome; do not wait or poll.'
        }
      }
    },
    {
      name: 'mac_script_job',
      help: 'Act on one chapter\'s AntiGravity script job after it stopped: continue (same conversations, accepted work kept), retry (new attempt, accepted work kept when the pages/inputs did not change), or start_over (throws the accepted notes, draft and review away; needs the user\'s approval).',
      args: { series: 'title or id', chapter: 'chapter number', language: 'en or hi (default en)', action: 'continue | retry | start_over' },
      prepare: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const chapter = await chapterOf(ctx, s.id, a.chapter)
        const l = lang(a.language, 'en')
        const action = typeof a.action === 'string' ? a.action.trim().toLowerCase().replace(/-/g, '_') : ''
        if (!['continue', 'retry', 'start_over'].includes(action)) throw fail('action must be continue, retry or start_over.')
        const job = jobOf(await narrationJobs(ctx, [chapter.id]), chapter.id, l)
        if (!job) throw fail(`Chapter ${chapter.number} has no AntiGravity ${langName(l)} job. Use mac_scripts_start.`)
        if (!PROBLEM_JOB.has(job.stage)) throw fail(`Chapter ${chapter.number}'s ${langName(l)} job is "${job.stage}"${ACTIVE_JOB.has(job.stage) ? ': it is already being worked on (the process is running)' : ', not stopped'}; nothing to ${action.replace('_', ' ')}.`)
        return { action, jobId: job.id, runId: job.runId, seriesId: s.id, title: s.title, number: chapter.number, language: l, part: partOf(chapter.number) }
      },
      approval: async a => a.action === 'start_over' ? `Start the ${langName(a.language)} script of "${a.title}" chapter ${a.number} over on this Mac: its accepted notes, draft and review are thrown away and every page is read again` : null,
      run: async (a, ctx) => {
        if (a.action === 'continue') await call(ctx, 'POST', `/antigravity/jobs/${a.jobId}/review`)
        else await call(ctx, 'POST', `/antigravity/jobs/${a.jobId}/retry`, a.action === 'start_over' ? { fresh: true } : undefined)
        await ctx.watch?.({ kind: 'mac', runId: a.runId, seriesId: a.seriesId, title: a.title, part: a.part })
        return { done: a.action, chapter: a.number, language: langName(a.language), note: 'Running in the background; I will post here when it finishes or stops with a problem.' }
      }
    },

    // ───────────────────────── Narration Library (local Studio) ─────────────────────────
    {
      name: 'script_replace',
      help: 'Replace a chapter\'s saved script in one language with text (Narration → Replace). The old script is backed up; that language\'s voiceover, alignment and timeline are reset; optionally the new script is sent to the phones for voiceover. ALWAYS needs the user\'s approval. For a long pasted script use source "last_message": it saves the user\'s latest chat message exactly (so the user must paste the script as a message of its own, after saying which chapter); never retype a long script yourself.',
      args: { series: 'title or id', chapter: 'chapter number', language: 'en or hi (default en)', source: 'last_message (use the user\'s latest message as the script) or text', text: 'only for source "text": a short script', send_to_phones: 'optional true/false (default true when phones are set up)' },
      prepare: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const chapter = await chapterOf(ctx, s.id, a.chapter)
        const l = lang(a.language, 'en')
        const source = a.source === 'last_message' ? 'last_message' : 'text'
        const text = source === 'last_message' ? ctx.lastUserText : typeof a.text === 'string' ? a.text : undefined
        if (!text?.trim()) throw fail(source === 'last_message'
          ? 'The user\'s latest message is empty. Ask them to paste the script as a message of its own, then call again.'
          : 'text is empty. For a pasted script use source "last_message".')
        if (source === 'last_message' && words(text) < 40) throw fail('The user\'s latest message is too short to be a script (it looks like an instruction). Ask them to paste the whole script as a message of its own, then call again with source "last_message".')
        const jobs = await narrationJobs(ctx, [chapter.id])
        if (ACTIVE_JOB.has(jobOf(jobs, chapter.id, l)?.stage)) throw fail(`AntiGravity is writing chapter ${chapter.number}'s ${langName(l)} script right now. Stop it first or wait.`)
        const current = await call<{ sha256: string | null; phoneConfigured: boolean }>(ctx, 'GET', `/narration/chapters/${chapter.id}/script?lang=${l}`)
        const send = a.send_to_phones === undefined ? current.phoneConfigured : bool(a.send_to_phones, 'send_to_phones') && current.phoneConfigured
        return { chapterId: chapter.id, number: chapter.number, title: s.title, language: l, text: text.trim(), expectedSha256: current.sha256, sendToPhones: send, hadScript: current.sha256 !== null, wordCount: words(text) }
      },
      approval: async a => `Replace the ${langName(a.language)} script of "${a.title}" chapter ${a.number} with the text you pasted (${a.wordCount} words). ${a.hadScript ? 'The current script is backed up and replaced; ' : ''}that language's voiceover, alignment and Editor timeline are reset${a.sendToPhones ? ', and the new script is sent to the phones for a new voiceover' : ''}`,
      run: async (a, ctx) => {
        const r = await call<any>(ctx, 'POST', `/narration/chapters/${a.chapterId}/script/replace?lang=${a.language}`, { text: a.text, expectedSha256: a.expectedSha256, sendToPhones: a.sendToPhones })
        return { saved: true, chapter: a.number, language: langName(a.language), unchanged: !!r.unchanged, sentToPhones: !!r.phoneSent, ...(a.sendToPhones && !r.phoneSent && { phoneProblem: r.phoneError ?? 'the phone upload failed; use script_replace again to retry' }) }
      }
    },
    {
      name: 'scripts_clear',
      help: 'Clear Scripts: remove the English AND Hinglish scripts, voiceovers, alignment and Editor timelines of the named chapters from Studio (backed up in each chapter folder first), e.g. ones the phones cleared. Pages, crops and Metadata stay. ALWAYS needs the user\'s approval.',
      args: { series: 'title or id', chapters: 'list of chapter numbers' },
      prepare: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const picked = numberList(a.chapters, 'chapters')
        if (!picked.length) throw fail('Say which chapters to clear (a list of chapter numbers).')
        const rows = await ctx.prisma.chapter.findMany({ where: { seriesId: s.id, number: { in: picked } }, select: { id: true, number: true, scripts: { select: { language: true, status: true } } } })
        const missing = picked.filter(n => !rows.some(r => r.number === n))
        if (missing.length) throw fail(`Not in this series: chapter ${compact(missing)}.`)
        const noScript = rows.filter(r => !r.scripts.some(x => SCRIPT_WRITTEN.includes(x.status))).map(r => r.number)
        if (noScript.length) throw fail(`Chapter ${compact(noScript)} has no script to clear.`)
        return { seriesId: s.id, title: s.title, chapterIds: rows.map(r => r.id), numbers: rows.map(r => r.number).sort((x, y) => x - y) }
      },
      approval: async a => `Clear the English and Hinglish scripts, voiceovers, alignment and Editor timelines of "${a.title}" chapter ${compact(a.numbers)} (each backed up in its chapter folder first; pages, crops and Metadata stay)`,
      run: async (a, ctx) => {
        const r = await call<{ cleared: { number: number; backupPath: string }[] }>(ctx, 'POST', `/narration/series/${a.seriesId}/scripts/clear`, { chapterIds: a.chapterIds })
        return { cleared: r.cleared.map(c => c.number), note: 'Backed up in each chapter folder.' }
      }
    },

    // ───────────────────────── phone scripts → Studio (Fetch from phone, phone versions) ─────────────────────────
    {
      name: 'phone_scripts_preview',
      help: 'What the phones uploaded for a series and language (reads R2, on request only): per chapter whether the phone\'s script is new here, would replace a different one, or is the same; and the chapters where a phone finished a DIFFERENT script than Studio\'s.',
      args: { series: 'title or id', language: 'en or hi (default en)' },
      run: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const l = lang(a.language, 'en')
        const p = await call<any>(ctx, 'POST', `/narration/series/${s.id}/phone/preview?lang=${l}`)
        if (!p.configured) throw fail('Cloudflare R2 is not set up (Settings → Cloudflare).')
        const conflicts = await call<{ conflicts: any[] }>(ctx, 'GET', `/narration/series/${s.id}/phone/conflicts?lang=${l}`).catch(() => ({ conflicts: [] as any[] }))
        const chapters: any[] = p.scripts?.chapters ?? []
        const by = (action: string) => compact(chapters.filter(c => c.action === action).map(c => c.number))
        return {
          series: s.title, language: langName(l),
          ...(p.scriptsError && { scriptsError: p.scriptsError }),
          phoneScripts: p.scripts ? { uploadedAt: p.scripts.zip?.uploadedAt, newHere: by('new') || 'none', wouldReplaceStudiosDifferentScript: by('replace') || 'none', same: by('same') || 'none', publishedAlready: compact(chapters.filter(c => c.published).map(c => c.number)) || 'none' } : 'the phone has not uploaded a script zip',
          differentOnPhone: conflicts.conflicts.map(c => ({ chapter: c.number, phone: c.device, savedOnPhone: c.phoneSavedAt, studioStatus: c.studioStatus, redoIfPhoneChosen: Object.entries(c.affects ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}${typeof v === 'number' ? ` ${v}` : ''}`) }))
        }
      }
    },
    {
      name: 'phone_scripts_fetch',
      help: 'Fetch from phone, scripts only: save the phones\' finished scripts into Studio. Default = the chapters whose phone script is new here (not yet published). Naming a chapter whose phone script would REPLACE a different Studio script needs the user\'s approval. Runs in the background.',
      args: { series: 'title or id', language: 'en or hi (default en)', chapters: 'optional list of chapter numbers (default: the new ones)' },
      prepare: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const l = lang(a.language, 'en')
        const p = await call<any>(ctx, 'POST', `/narration/series/${s.id}/phone/preview?lang=${l}`)
        if (!p.configured) throw fail('Cloudflare R2 is not set up (Settings → Cloudflare).')
        if (!p.scripts) throw fail(p.scriptsError ? `The phone's script zip could not be read: ${p.scriptsError}` : 'The phones have not uploaded a script zip for this series.')
        const all: any[] = p.scripts.chapters
        const named = numberList(a.chapters, 'chapters')
        const chosen = named.length
          ? named.map(n => all.find(c => c.number === n) ?? (() => { throw fail(`The phone has no script for chapter ${n}.`) })())
          : all.filter(c => c.action === 'new' && !c.published)
        const todo = chosen.filter(c => c.action !== 'same')
        if (!todo.length) throw fail(named.length ? 'Those chapters already match the phone\'s script.' : 'Nothing new on the phones for this series.')
        return { seriesId: s.id, title: s.title, language: l, scriptsEtag: p.scripts.zip.etag, chapterIds: todo.map(c => c.chapterId), numbers: todo.map(c => c.number), replaces: todo.filter(c => c.action === 'replace').map(c => c.number) }
      },
      approval: async a => a.replaces?.length ? `Replace Studio's ${langName(a.language)} script of "${a.title}" chapter ${compact(a.replaces)} with the phone's different version (what was made from Studio's script — voiceover, alignment, Metadata, timeline — needs redoing)` : null,
      run: async (a, ctx) => {
        await call(ctx, 'POST', `/narration/series/${a.seriesId}/phone/fetch?lang=${a.language}`, { scriptsEtag: a.scriptsEtag, scriptChapterIds: a.chapterIds, voiceoverChapterIds: [] })
        return { started: true, chapters: compact(a.numbers), note: 'Saving in the background; scripts_status shows them once saved.' }
      }
    },
    {
      name: 'phone_script_choose',
      help: 'Settle a chapter where a phone finished a different script than Studio\'s: "studio" keeps Studio\'s (and stops offering that phone version), "phone" imports the phone\'s (needs the user\'s approval; what was made from Studio\'s script must be redone).',
      args: { series: 'title or id', chapter: 'chapter number', language: 'en or hi (default en)', choice: 'studio or phone' },
      prepare: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const l = lang(a.language, 'en')
        const choice = a.choice === 'phone' || a.choice === 'studio' ? a.choice : null
        if (!choice) throw fail('choice must be studio or phone.')
        const n = int(a.chapter, 'chapter', 0)
        const { conflicts } = await call<{ conflicts: any[] }>(ctx, 'GET', `/narration/series/${s.id}/phone/conflicts?lang=${l}`)
        const c = conflicts.find(x => x.number === n)
        if (!c) throw fail(`Chapter ${n} has no differing phone version in ${langName(l)} (see phone_scripts_preview).`)
        return { seriesId: s.id, title: s.title, language: l, chapterId: c.chapterId, phoneSha256: c.phoneSha256, number: n, choice }
      },
      approval: async a => a.choice === 'phone' ? `Use the phone's ${langName(a.language)} script for "${a.title}" chapter ${a.number} instead of Studio's (what was made from Studio's script — voiceover, alignment, Metadata, Hinglish, timeline — needs redoing)` : null,
      run: async (a, ctx) => {
        await call(ctx, 'POST', `/narration/series/${a.seriesId}/phone/conflicts/resolve?lang=${a.language}`, { chapterId: a.chapterId, phoneSha256: a.phoneSha256, choice: a.choice })
        return { chapter: a.number, kept: a.choice === 'studio' ? "Studio's script" : "the phone's script (imported)" }
      }
    },

    // ───────────────────────── phones: Run automation → Narration scripts ─────────────────────────
    {
      name: 'phone_scripts_prepare',
      help: 'Get a phone ready to write a series\' scripts: sends the pages the phone is missing and/or asks it to download (the "Send what\'s missing" buttons of Run automation). It takes a while; check scripts_where until phoneReady is true, then call phone_scripts_start.',
      args: { series: 'title or id', part: 'optional part number' },
      run: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const part = a.part !== undefined && a.part !== null && a.part !== '' ? int(a.part, 'part') : undefined
        const r = await narrationReadiness(ctx, s.id, part)
        if (r.sending) return { series: s.title, note: 'A send to the phones is already running; check scripts_where in a few minutes.' }
        const fixes = (r.items ?? []).filter((i: any) => i.fix && ['send_pages', 'ask_download'].includes(i.fix.action))
        if (!fixes.length) {
          const open = (r.items ?? []).filter((i: any) => i.state !== 'ready' && i.state !== 'note').map((i: any) => `${i.label}: ${i.state} — ${clip(i.detail, 140)}`)
          return { series: s.title, nothingToSend: true, ready: !!r.ready, ...(open.length && { stillOpen: open }) }
        }
        const done: string[] = []
        for (const i of fixes) {
          const res = await call<{ message: string }>(ctx, 'POST', '/r2/phone/readiness/fix', { action: i.fix.action, seriesId: s.id, ...(i.fix.chapterIds ? { chapterIds: i.fix.chapterIds } : {}) })
          done.push(res.message)
        }
        return { series: s.title, sent: done, note: 'Sending in the background. Check scripts_where for phoneReady before starting.' }
      }
    },
    {
      name: 'phone_set_profile',
      help: 'Switch the browser profile (account) a phone starts its next run in; waits until the phone confirms.',
      args: { phone: 'phone name', profile: 'profile name' },
      run: async (a, ctx) => {
        const phones: any[] = ((await phoneOverview(ctx)).phones ?? []).filter((p: any) => p.id)
        if (!phones.length) throw fail('No phone is known to the relay.')
        const phone = !a.phone && phones.length === 1 ? phones[0] : pickOne(phones, a.phone, p => [p.name, p.id], 'phone', fail)
        const r = await selectProfile(ctx, phone, a.profile)
        return { phone: phone.name, profile: r.profile, ...(r.changed ? {} : { note: 'it was already selected' }) }
      }
    },
    {
      name: 'phone_scripts_start',
      help: 'Start Narration scripts on a phone: Gemini in AI Studio writes the English script of each chapter of the part, then its Hinglish, one phone at a time, in order. Leave phone out to use the first phone that is online and idle. Optionally switches the phone to a profile first. The phone must already have the pages (see scripts_where / phone_scripts_prepare).',
      args: { series: 'title or id', part: 'optional part number (default: the first part not finished)', phone: 'optional phone name', profile: 'optional profile name to start in' },
      prepare: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const part = a.part !== undefined && a.part !== null && a.part !== '' ? int(a.part, 'part') : undefined
        const overview = await phoneOverview(ctx)
        const phone = pickPhone(overview, a.phone)
        if (!phoneCanWrite(phone)) throw fail(`Sleeper-Cell on ${phone.name} cannot start Narration scripts from here (update the app).`)
        if (!phoneScopes(phone)) throw fail(`Sleeper-Cell on ${phone.name} cannot start scripts for one part (update the app).`)
        if (phone.connected === false) throw fail(`${phone.name} is offline (${phone.left ?? 'not connected'}).`)
        if ((phone.runs ?? 0) + (phone.working ?? 0) > 0) throw fail(`${phone.name} is busy with a run. Wait for it, or stop it first.`)
        const r = await narrationReadiness(ctx, s.id, part)
        const chapters: string[] = r.narrationScope?.chapters ?? []
        if (!chapters.length) throw fail(`There are no chapters to write in ${part ? `part ${part}` : 'that series'}.`)
        const open = (r.items ?? []).filter((i: any) => i.state === 'missing' || i.state === 'blocked' || i.state === 'waiting')
        if (open.length) throw fail(`The phone is not ready: ${open.map((i: any) => `${i.label} — ${clip(i.detail, 140)}`).join('; ')}. Use phone_scripts_prepare, then check scripts_where.`)
        return { seriesId: s.id, title: s.title, device: phone.id, phoneName: phone.name, chapters, part: r.narrationScope.part, profile: typeof a.profile === 'string' && a.profile.trim() ? a.profile : null }
      },
      run: async (a, ctx) => {
        const phone = { id: a.device, name: a.phoneName }
        const switched = a.profile ? await selectProfile(ctx, phone, a.profile) : null
        const before = (await phoneOverview(ctx)).series?.find((x: any) => x.id === a.seriesId)?.scripts ?? null
        const sent = await call<{ targets?: { reached: boolean }[] }>(ctx, 'POST', '/r2/phone/automation', { command: 'start', kind: 'narration', seriesId: a.seriesId, device: a.device, chapters: a.chapters })
        if (sent.targets && !sent.targets.some(t => t.reached)) throw fail(`${a.phoneName} did not receive the start (the relay could not reach it). Check Phone Status.`)
        await ctx.watch?.({ kind: 'phone', device: a.device, phoneName: a.phoneName, seriesId: a.seriesId, title: a.title, part: a.part === 'all' ? null : a.part, before })
        return { started: true, phone: a.phoneName, series: a.title, part: a.part, chapters: a.chapters.length, ...(switched && { profile: switched.profile }), note: 'The phone wakes and starts by itself; I will post here when it stops or finishes.' }
      }
    },
    {
      name: 'phone_run_stop',
      help: 'Stop the Narration scripts run on a phone. finish_chapter true = let the chapter it is writing finish and save, then stop. Otherwise it stops right now (needs the user\'s approval). Only script runs are stopped.',
      args: { phone: 'optional phone name (default: the phone running scripts)', finish_chapter: 'true to stop after the current chapter' },
      prepare: async (a, ctx) => {
        const overview = await phoneOverview(ctx)
        const running = (overview.runs ?? []).filter((r: any) => r.kind === 'narration')
        const phones: any[] = (overview.phones ?? []).filter((p: any) => p.id && running.some((r: any) => r.device === p.id))
        if (!phones.length) throw fail('No phone is writing scripts right now.')
        const phone = a.phone ? pickOne(phones, a.phone, p => [p.name, p.id], 'phone running scripts', fail) : phones.length === 1 ? phones[0] : (() => { throw fail(`Several phones are writing scripts (${phones.map((p: any) => p.name).join(', ')}). Say which.`) })()
        const finish = a.finish_chapter === undefined ? false : bool(a.finish_chapter, 'finish_chapter')
        if (finish && phone.automation?.stopAfter !== true) throw fail(`Sleeper-Cell on ${phone.name} cannot finish the chapter first (older build); it can only stop now.`)
        const others = (phone.runs ?? 0) > running.filter((r: any) => r.device === phone.id).length || (phone.working ?? 0) > 0
        if (others) throw fail(`${phone.name} is also running something else, and Stop would end that too. Ask the user to stop it from Phone Status.`)
        return { device: phone.id, phoneName: phone.name, finish }
      },
      approval: async a => a.finish ? null : `Stop the Narration scripts run on ${a.phoneName} right now (the chapter being written is abandoned; saved scripts stay)`,
      run: async (a, ctx) => {
        const sent = await call<{ targets?: { reached: boolean }[] }>(ctx, 'POST', '/r2/phone/automation', { command: 'stop', device: a.device, ...(a.finish ? { after: true } : {}) })
        if (sent.targets && !sent.targets.some(t => t.reached)) throw fail(`${a.phoneName} did not receive the stop. Check Phone Status.`)
        return { phone: a.phoneName, stopping: a.finish ? 'after the current chapter' : 'now' }
      }
    }
  ]
}
