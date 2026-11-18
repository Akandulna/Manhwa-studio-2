/**
 * Watches the script runs the agent started and posts a message in the chat on its own when one finishes or stops
 * with a problem (the user asked for this: a run takes hours and the agent otherwise only speaks when spoken to).
 *
 * - Mac (AntiGravity Narration): the run's jobs, from Studio's own database through its API; a job that needs
 *   attention or failed is reported once, a pause is reported once, the end is reported with what was saved.
 * - Mac (AntiGravity Image Clipper): pages that need the user (once each), a pause, then the end with how many pages got
 *   pointers. Crop Sections: when the chapters' cut is done (read from Clipper's own summary).
 * - Phone (Sleeper-Cell narration): the server's last copy of the phones' receipts (the relay pushes them live).
 *   Never reads R2 on a timer (see the R2 free-tier rule); the run is "finished" when it disappears from the receipt
 *   after being seen, and "never started" when it was not seen in time.
 * - Next process (mac_scripts_after): when the AntiGravity process running now ends — and, for a Narration run, its part
 *   has every English and Hinglish script — start scripts for another series' part with the same checks as
 *   mac_scripts_start, then watch that run as usual. The agent can't act on its own later; this is how "when X
 *   finishes, start Y" happens.
 * Watches are kept in the agent's own files so a restart does not forget them. The messages are fixed text, not
 * written by an AI engine, so watching costs no tokens.
 */

import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { AgentStore } from './agentStore.js'
import { call, toolByName, type ToolContext } from './agentTools.js'
import { partOf } from './scriptTools.js'

export type WatchRequest =
  | { kind: 'mac'; runId: string; seriesId: string; title: string; part: number }
  /** mac_scripts_switch: after this run has stopped (gracefully), apply the settings, check compatibility, start the part again. */
  | { kind: 'mac_switch'; runId: string; seriesId: string; title: string; part: number; changes: { setting: string; value: string | number | boolean | null; label: string }[]; resume: boolean }
  | { kind: 'phone'; device: string; phoneName: string; seriesId: string; title: string; part: number | null; before: { done: number; total: number } | null }
  /** An AntiGravity Image Clipper run on this Mac (clipperTools.ts). */
  | { kind: 'clipper'; runId: string; seriesId: string; title: string; part: number }
  /** Crop Sections of these chapters (clipperTools.ts clipper_crop). */
  | { kind: 'crop'; seriesId: string; title: string; chapterIds: string[]; numbers: number[] }
  /**
   * mac_scripts_after: when run `runId` (the process running when the user asked) ends, start Narration scripts for
   * seriesId/part on this Mac. requireComplete: only when that run's part (a Narration run) has every English and
   * Hinglish script by then; otherwise say why and start nothing.
   */
  | { kind: 'mac_next'; runId: string; afterKind: string; afterSeriesId: string; afterTitle: string; afterPart: number; seriesId: string; title: string; part: number; requireComplete: boolean }

export type Watch = WatchRequest & {
  id: string
  chatId: string
  startedAt: string
  /** The run was seen live (Mac) / in the phone's receipt. */
  seen?: boolean
  /** Problems already reported, so each is said once. */
  told?: string[]
  /** mac_next: the run it waited for has ended and passed its checks; the start is all that is left. */
  ready?: boolean
  /** mac_next: how the run it waited for ended, said with the start. */
  summary?: string
  /** mac_next: no new start attempt before this time (a usage limit is waiting to lift). */
  retryAt?: string
}

const POLL_MS = 30_000
const EXPIRES_MS = 72 * 3_600_000
/** A queued next process waits longer: the run before it can take days with usage limits in between. */
const NEXT_EXPIRES_MS = 7 * 24 * 3_600_000
/** How often a queued start is tried again while every account is at its usage limit. */
const LIMIT_RETRY_MS = 10 * 60_000
const SCRIPT_WRITTEN = ['done', 'edited', 'stale']
const STOPPED = new Set(['stopped', 'stop_requested', 'interrupted'])
/** A phone run that never shows up in the receipt within this long "never started". */
const NEVER_STARTED_MS = 12 * 60_000
const PROBLEM = new Set(['failed', 'needs_attention', 'interrupted', 'cancelled', 'publish_failed', 'rejected'])
const langOf = (filename: string) => (filename === 'narration-hi' ? 'Hinglish' : 'English')

export class ScriptWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  /** Watches begun while ticking (a switch that started the part again); added after the loop so they are not overwritten. */
  private spawned: { chatId: string; request: WatchRequest }[] = []

  constructor(
    private store: AgentStore,
    private prisma: PrismaClient,
    private api: () => string,
    /** Posts into a chat; false when the chat no longer exists. */
    private post: (chatId: string, text: string) => Promise<boolean>
  ) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), POLL_MS)
    this.timer.unref?.()
    void this.tick()
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null }

  async add(chatId: string, request: WatchRequest): Promise<void> {
    // One queued next process for this Mac: a new one replaces the old, whichever chat asked.
    const same = (w: Watch) => request.kind === 'mac_next' ? w.kind === 'mac_next' : w.chatId === chatId && w.kind === request.kind &&
      (request.kind === 'phone' ? (w as any).device === request.device && w.seriesId === request.seriesId
        : request.kind === 'crop' ? w.seriesId === request.seriesId && (w as any).chapterIds?.join() === request.chapterIds.join()
        : (w as any).runId === request.runId)
    const list = (await this.store.watches()).filter(w => !same(w))
    list.push({ ...request, id: randomUUID(), chatId, startedAt: new Date().toISOString() })
    await this.store.saveWatches(list)
  }

  private async get<T = any>(path: string): Promise<T> {
    const response = await fetch(`${this.api()}${path}`, { headers: { 'X-Studio-Client': '1' }, signal: AbortSignal.timeout(30_000) })
    if (response.status === 404) throw Object.assign(new Error('not found'), { status: 404 })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json() as Promise<T>
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const list = await this.store.watches()
      if (!list.length) return
      const keep: Watch[] = []
      let phone: any | undefined
      for (const w of list) {
        if (Date.now() - Date.parse(w.startedAt) > (w.kind === 'mac_next' ? NEXT_EXPIRES_MS : EXPIRES_MS)) {
          if (w.kind === 'mac_next') await this.say(w, `⚠ I gave up waiting to start "${w.title}" part ${w.part}: "${w.afterTitle}" part ${w.afterPart} did not end within 7 days. Nothing was started.`)
          continue
        }
        try {
          if (w.kind === 'phone' && phone === undefined) phone = await this.get('/r2/phone/overview').catch(() => null)
          const done = w.kind === 'mac' ? await this.checkMac(w)
            : w.kind === 'mac_switch' ? await this.checkSwitch(w)
            : w.kind === 'clipper' ? await this.checkClipper(w)
            : w.kind === 'crop' ? await this.checkCrop(w)
            : w.kind === 'mac_next' ? await this.checkNext(w)
            : await this.checkPhone(w, phone)
          if (!done) keep.push(w)
        } catch (error) {
          if ((error as { status?: number }).status === 404) continue
          keep.push(w) // transient: look again next time
        }
      }
      for (const s of this.spawned.splice(0)) keep.push({ ...s.request, id: randomUUID(), chatId: s.chatId, startedAt: new Date().toISOString() })
      await this.store.saveWatches(keep)
    } finally { this.ticking = false }
  }

  private async say(w: Watch, text: string): Promise<boolean> {
    return this.post(w.chatId, text)
  }

  private async chapterNumbers(ids: string[]): Promise<Map<string, number>> {
    const rows = ids.length ? await this.prisma.chapter.findMany({ where: { id: { in: ids } }, select: { id: true, number: true } }) : []
    return new Map(rows.map(r => [r.id, r.number]))
  }

  /** @returns true when the watch is finished with. */
  private async checkMac(w: Extract<Watch, { kind: 'mac' }> & Watch): Promise<boolean> {
    const detail = await this.get<{ run: any; jobs: any[]; events?: { message: string }[] }>(`/antigravity/runs/${w.runId}`)
    const run = detail.run
    const where = `"${w.title}" part ${w.part}`
    const live = !run.finishedAt
    if (live) w.seen = true
    const numbers = await this.chapterNumbers([...new Set(detail.jobs.map(j => j.chapterId))])
    const told = new Set(w.told ?? [])

    const problems = detail.jobs.filter(j => PROBLEM.has(j.stage))
    const fresh = problems.filter(j => !told.has(`${j.id}:${j.stage}`))
    if (live && fresh.length) {
      for (const j of fresh) told.add(`${j.id}:${j.stage}`)
      w.told = [...told]
      const lines = fresh.slice(0, 5).map(j => `• Chapter ${numbers.get(j.chapterId) ?? '?'} ${langOf(j.filename)}: ${j.stage.replace('_', ' ')}${j.lastError ? ` — ${String(j.lastError).slice(0, 220)}` : ''}`)
      if (!(await this.say(w, `⚠ The script run for ${where} on this Mac hit a problem:\n${lines.join('\n')}\nSay "continue", "retry" or "start over" for a chapter, or look at AntiGravity → Narration scripts.`))) return true
    }
    if (live && run.control === 'paused' && !told.has('paused')) {
      told.add('paused'); w.told = [...told]
      const last = detail.events?.slice(-1)[0]?.message
      if (!(await this.say(w, `⏸ The script run for ${where} on this Mac is paused${last ? ` (${String(last).slice(0, 200)})` : ''}. Say "resume" to carry on.`))) return true
    }
    if (live && run.control !== 'paused' && told.delete('paused')) w.told = [...told]
    if (live) return false

    // Finished (or stopped): only for a run seen live, or one that really ended after this watch began.
    if (!w.seen && Date.parse(run.finishedAt) < Date.parse(w.startedAt) - 5000) return Date.now() - Date.parse(w.startedAt) > 10 * 60_000
    const doneJobs = detail.jobs.filter(j => j.stage === 'done')
    const en = doneJobs.filter(j => j.filename === 'narration-en').length
    const hi = doneJobs.filter(j => j.filename === 'narration-hi').length
    const total = new Set(detail.jobs.map(j => j.chapterId)).size
    const bad = problems.length
    const stopped = run.control === 'stopped' || run.control === 'stop_requested'
    await this.say(w, `${bad ? '⚠' : '✓'} The script run for ${where} on this Mac ${stopped ? 'stopped' : 'finished'}: English saved for ${en} of ${total} chapter${total === 1 ? '' : 's'}, Hinglish for ${hi}.${bad ? ` ${bad} job${bad === 1 ? '' : 's'} still need${bad === 1 ? 's' : ''} attention (say "status" for the details).` : ''}${!bad && en + hi < total * 2 && !stopped ? ' Some chapters were not written; ask for the status to see why.' : ''}`)
    return true
  }

  /**
   * mac_scripts_switch, step by step: wait until the stopping run has ended → apply the settings (the same code as the
   * settings_change action) → make sure the selected engine's (Antigravity or ChatGPT/Codex) compatibility proof is valid for the new settings (runs the test when
   * it is not) → start the part again. Each outcome is said once. Every step is safe to repeat after a restart.
   * @returns true when the watch is finished with.
   */
  private async checkSwitch(w: Extract<Watch, { kind: 'mac_switch' }> & Watch): Promise<boolean> {
    const detail = await this.get<{ run: any }>(`/antigravity/runs/${w.runId}`)
    const run = detail.run
    const where = `"${w.title}" part ${w.part}`
    if (!run.finishedAt) {
      if (['running', 'preparing'].includes(run.control)) {
        await this.say(w, `⏸ I dropped the plan to switch settings for ${where}: the script process was resumed (it is running again). Nothing was changed.`)
        return true
      }
      return false // still finishing the chapter in progress
    }

    const ctx = { prisma: this.prisma, store: this.store, api: this.api() } as ToolContext
    const settingChange = toolByName('settings_change')!
    const lines: string[] = []
    for (const c of w.changes) {
      try {
        const prepared = await settingChange.prepare!({ setting: c.setting, value: c.value }, ctx)
        const r = await settingChange.run(prepared, ctx) as { from: string; now: string }
        lines.push(`${c.label}: ${r.from} → ${r.now}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/already|nothing to change/i.test(message)) { lines.push(`${c.label}: already set`); continue }
        await this.say(w, `⚠ The script process for ${where} stopped, but I could not change "${c.label}": ${message.slice(0, 300)}. I did not start it again.`)
        return true
      }
    }

    if (!w.resume) {
      await this.say(w, `✓ The script process for ${where} stopped and I changed the settings (${lines.join('; ')}). It stays stopped; say "continue" to start it again.`)
      return true
    }

    try {
      const other = await call<{ live: boolean; run: any | null }>(ctx, 'GET', '/antigravity/runs/current')
      if (other.live && other.run) {
        // Someone (the user) already started a process: it needs no test and a test now could block it.
        if (other.run.seriesId === w.seriesId && other.run.partNumber === w.part && other.run.kind === 'narration') this.spawned.push({ chatId: w.chatId, request: { kind: 'mac', runId: other.run.id, seriesId: w.seriesId, title: w.title, part: w.part } })
        await this.say(w, `✓ Settings changed (${lines.join('; ')}). A ${other.run.kind === 'narration' ? 'Narration' : 'different'} process is already running, so I did not start another or run the compatibility test.`)
        return true
      }
      // The proof belongs to the engine now selected: Antigravity's own, or ChatGPT (Codex)'s.
      const engine = (await call<any>(ctx, 'GET', '/antigravity/connection'))?.settings?.engine
      const base = engine === 'codex' ? '/antigravity/codex' : '/antigravity'
      const engineLabel = engine === 'codex' ? 'ChatGPT (Codex)' : 'Antigravity'
      let connection = await call<any>(ctx, 'GET', `${base}/connection`)
      let tested = ''
      if ((engine === 'antigravity' || engine === 'codex') && !connection.proofValid) {
        const report = await call<{ ok?: boolean }>(ctx, 'POST', `${base}/check`)
        connection = await call<any>(ctx, 'GET', `${base}/connection`)
        tested = report?.ok ? ` I ran ${engineLabel}'s compatibility test for the new settings and it passed.` : ''
        if (!connection.proofValid) {
          await this.say(w, `⚠ Settings changed (${lines.join('; ')}) but I did not start ${where} again: ${connection.proofNote ?? 'the compatibility test did not pass'}. Check AntiGravity → Settings, then say "continue".`)
          return true
        }
      }
      const started = await call<{ runId: string | null; created: string[]; reused: string[]; skipped: { reason: string }[] }>(ctx, 'POST', '/antigravity/runs', { seriesId: w.seriesId, partNumber: w.part, mode: 'next', kind: 'narration' })
      if (!started.created.length && !started.reused.length) {
        await this.say(w, `✓ Settings changed (${lines.join('; ')}). Nothing was left to write in ${where}${started.skipped[0] ? ` (${String(started.skipped[0].reason).slice(0, 160)})` : ''}.`)
        return true
      }
      if (started.runId) this.spawned.push({ chatId: w.chatId, request: { kind: 'mac', runId: started.runId, seriesId: w.seriesId, title: w.title, part: w.part } })
      await this.say(w, `▶ ${where} is writing again with the new settings (${lines.join('; ')}).${tested} ${started.created.length + started.reused.length} chapter job${started.created.length + started.reused.length === 1 ? '' : 's'} started. I will post here when it finishes or stops with a problem.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.say(w, `⚠ Settings changed (${lines.join('; ')}) but I could not start ${where} again: ${message.slice(0, 300)}. Say "continue" once that is fixed.`)
    }
    return true
  }

  /**
   * mac_scripts_after, step by step: wait for the run to end → (Narration, requireComplete) its part must have every
   * English and Hinglish script → wait while another process runs → start the next part through mac_scripts_start's
   * own checks (engine, compatibility test, what is missing) → watch the new run. Each outcome is said once.
   * @returns true when the watch is finished with.
   */
  private async checkNext(w: Extract<Watch, { kind: 'mac_next' }> & Watch): Promise<boolean> {
    const next = `"${w.title}" part ${w.part}`
    const before = `"${w.afterTitle}" part ${w.afterPart}`
    const told = new Set(w.told ?? [])
    const tell = async (key: string, text: string) => {
      if (told.has(key)) return true
      told.add(key); w.told = [...told]
      return this.say(w, text)
    }
    if (!w.ready) {
      const run = (await this.get<{ run: any }>(`/antigravity/runs/${w.runId}`)).run
      if (!run.finishedAt) return false
      if (STOPPED.has(run.control)) {
        await this.say(w, `⚠ ${before} was ${run.control === 'interrupted' ? 'interrupted' : 'stopped'} before it finished, so I did not start ${next}. Say "start ${w.title}" to begin it anyway, or "continue" for ${before}.`)
        return true
      }
      let summary = `${before} finished`
      if (w.afterKind === 'narration') {
        const rows = await this.prisma.chapter.findMany({ where: { seriesId: w.afterSeriesId }, select: { number: true, scripts: { select: { language: true, status: true } } } })
        const inPart = rows.filter(r => partOf(r.number) === w.afterPart)
        const has = (r: typeof rows[number], l: string) => r.scripts.some(x => x.language === l && SCRIPT_WRITTEN.includes(x.status))
        const missing = inPart.filter(r => !has(r, 'en') || !has(r, 'hi')).map(r => r.number).sort((a, b) => a - b)
        if (missing.length && w.requireComplete) {
          await this.say(w, `⚠ ${before} ended, but chapter${missing.length === 1 ? '' : 's'} ${missing.join(', ')} still ${missing.length === 1 ? 'lacks' : 'lack'} an English or Hinglish script, so I did not start ${next}. Say "status" for why, or "start ${w.title}" to begin it anyway.`)
          return true
        }
        summary += missing.length ? ` (chapter${missing.length === 1 ? '' : 's'} ${missing.join(', ')} still without both scripts)` : `: all ${inPart.length} chapters have English and Hinglish scripts`
      }
      w.ready = true
      w.summary = summary
    }
    const summary = w.summary ?? `${before} finished`
    if (w.retryAt && Date.now() < Date.parse(w.retryAt)) return false

    const ctx: ToolContext = {
      prisma: this.prisma, store: this.store, api: this.api(), chatId: w.chatId,
      watch: async request => { this.spawned.push({ chatId: w.chatId, request }) }
    }
    const current = await call<{ live: boolean; run: any | null }>(ctx, 'GET', '/antigravity/runs/current')
    if (current.live && current.run) {
      const r = current.run
      if (r.kind === 'narration' && r.seriesId === w.seriesId && r.partNumber === w.part) {
        // Someone already started it: just watch it.
        this.spawned.push({ chatId: w.chatId, request: { kind: 'mac', runId: r.id, seriesId: w.seriesId, title: w.title, part: w.part } })
        await this.say(w, `✓ ${summary}. ${next} is already running on this Mac (someone started it), so I left it alone. I will post here when it finishes or stops with a problem.`)
        return true
      }
      const kind = r.kind === 'metadata' ? 'Metadata' : r.kind === 'editor' ? 'Timeline' : r.kind === 'narration' ? 'Narration' : 'Image Clipper'
      return !(await tell(`busy:${r.id}`, `⏸ ${summary}, but a ${kind} process (part ${r.partNumber}) is running on this Mac now. I will start ${next} when it ends.`))
    }

    const start = toolByName('mac_scripts_start')!
    try {
      const prepared = await start.prepare!({ series: w.seriesId, part: w.part }, ctx)
      const result = await start.run(prepared, ctx) as { chapters?: string; alreadyInProgress?: number }
      await this.say(w, `▶ ${summary}. Started ${next} on this Mac (${result.chapters ?? 'the chapters missing a script'}). I will post here when it finishes or stops with a problem.`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/limit/i.test(message)) {
        w.retryAt = new Date(Date.now() + LIMIT_RETRY_MS).toISOString()
        return !(await tell('limit', `⏸ ${summary}, but I could not start ${next} yet: ${message.slice(0, 300)} I will try again every ${LIMIT_RETRY_MS / 60_000} minutes.`))
      }
      await this.say(w, `⚠ ${summary}, but I could not start ${next}: ${message.slice(0, 400)} Say "start ${w.title}" once that is fixed.`)
      return true
    }
  }

  /** An Image Clipper run: each page that needs the user once, a pause once, then the end with what came back. */
  private async checkClipper(w: Extract<Watch, { kind: 'clipper' }> & Watch): Promise<boolean> {
    const detail = await this.get<{ run: any; jobs: any[]; events?: { message: string }[] }>(`/antigravity/runs/${w.runId}`)
    const run = detail.run
    const where = `"${w.title}" part ${w.part}`
    const live = !run.finishedAt
    if (live) w.seen = true
    const numbers = await this.chapterNumbers([...new Set(detail.jobs.map(j => j.chapterId))])
    const told = new Set(w.told ?? [])
    const problems = detail.jobs.filter(j => PROBLEM.has(j.stage) && j.stage !== 'rejected')
    const fresh = problems.filter(j => !told.has(`${j.id}:${j.stage}`))
    if (live && fresh.length) {
      for (const j of fresh) told.add(`${j.id}:${j.stage}`)
      w.told = [...told]
      const lines = fresh.slice(0, 5).map(j => `• Chapter ${numbers.get(j.chapterId) ?? '?'} ${j.filename}: ${j.stage.replace(/_/g, ' ')}${j.lastError ? ` — ${String(j.lastError).slice(0, 200)}` : ''}`)
      if (!(await this.say(w, `⚠ The Image Clipper run for ${where} hit a problem on ${fresh.length} page${fresh.length === 1 ? '' : 's'}:\n${lines.join('\n')}${fresh.length > 5 ? `\n…and ${fresh.length - 5} more` : ''}\nThe process goes on with other pages. Say "retry" or "review again" for a page, or look at AntiGravity → Image Clipper.`))) return true
    }
    if (live && run.control === 'paused' && !told.has('paused')) {
      told.add('paused'); w.told = [...told]
      const last = detail.events?.slice(-1)[0]?.message
      if (!(await this.say(w, `⏸ The Image Clipper run for ${where} is paused${last ? ` (${String(last).slice(0, 200)})` : ''}. Say "resume" to carry on.`))) return true
    }
    if (live && run.control !== 'paused' && told.delete('paused')) w.told = [...told]
    if (live) return false

    if (!w.seen && Date.parse(run.finishedAt) < Date.parse(w.startedAt) - 5000) return Date.now() - Date.parse(w.startedAt) > 10 * 60_000
    const count = (stages: string[]) => detail.jobs.filter(j => stages.includes(j.stage)).length
    const total = detail.jobs.length
    const stopped = run.control === 'stopped' || run.control === 'stop_requested'
    const uploaded = count(['prepared'])
    if (uploaded && uploaded + problems.length >= total) {
      await this.say(w, `${problems.length ? '⚠' : '✓'} Upload to Drive for ${where} ${stopped ? 'stopped' : 'finished'}: ${uploaded} of ${total} page${total === 1 ? '' : 's'} sliced and uploaded (no AI yet).${problems.length ? ` ${problems.length} failed.` : ''} Say "start" to process them.`)
      return true
    }
    const ready = count(['ready_for_human_review', 'publish_failed', 'done'])
    const r2Pending = count(['publish_failed'])
    const chapters = [...new Set(detail.jobs.filter(j => ['ready_for_human_review', 'publish_failed', 'done'].includes(j.stage)).map(j => numbers.get(j.chapterId)).filter((n): n is number => typeof n === 'number'))].sort((a, b) => a - b)
    await this.say(w, `${problems.length ? '⚠' : '✓'} The Image Clipper run for ${where} ${stopped ? 'stopped' : 'finished'}: ${ready} of ${total} page${total === 1 ? '' : 's'} got crop pointers${chapters.length ? ` (chapter${chapters.length === 1 ? '' : 's'} ${chapters.join(', ')})` : ''}${r2Pending ? `, ${r2Pending} not yet shared with phones (R2)` : ''}.${problems.length ? ` ${problems.length} page${problems.length === 1 ? '' : 's'} still need${problems.length === 1 ? 's' : ''} you (say "status").` : ''}${ready ? ' They are candidates: check them in Preview; once you have, I can mark the chapters reviewed and run Crop Sections.' : ''}`)
    return true
  }

  /** Crop Sections: finished when none of the chapters is being cut and each was cut after the watch began (or 90 min passed). */
  private async checkCrop(w: Extract<Watch, { kind: 'crop' }> & Watch): Promise<boolean> {
    const summary = new Map((await this.get<{ chapters: any[] }>(`/clipper3/series/${w.seriesId}/summary`)).chapters.map(c => [c.chapterId, c]))
    const since = Date.parse(w.startedAt) - 5000
    const rows = w.chapterIds.map((id, i) => ({ number: w.numbers[i], s: summary.get(id) }))
    const cutNow = (r: typeof rows[number]) => !!r.s && !r.s.cropping && !!r.s.review?.croppedAt && Date.parse(r.s.review.croppedAt) >= since
    if (rows.some(r => r.s?.cropping)) return false
    const done = rows.filter(cutNow)
    if (done.length < rows.length && Date.now() - Date.parse(w.startedAt) < 90 * 60_000) return false
    const missing = rows.filter(r => !cutNow(r)).map(r => r.number)
    const partial = done.filter(r => !r.s.cropComplete).map(r => r.number)
    const where = `"${w.title}" chapter${w.numbers.length === 1 ? '' : 's'} ${w.numbers.join(', ')}`
    await this.say(w, `${missing.length || partial.length ? '⚠' : '✓'} Crop Sections for ${where}: ${done.length ? `cut ${done.map(r => r.number).join(', ')}` : 'nothing was cut'}.${partial.length ? ` Chapter ${partial.join(', ')} is only partly cropped (pages without pointers, or a cut failed); look at its Preview.` : ''}${missing.length ? ` Chapter ${missing.join(', ')} was not cut (no new crops after 90 minutes; the cut may have failed).` : ''}`)
    return true
  }

  private async checkPhone(w: Extract<Watch, { kind: 'phone' }> & Watch, overview: any | null): Promise<boolean> {
    if (!overview) return false
    const where = `"${w.title}"${w.part ? ` part ${w.part}` : ''}`
    const phone = (overview.phones ?? []).find((p: any) => p.id === w.device)
    const run = (overview.runs ?? []).find((r: any) => r.kind === 'narration' && r.device === w.device && r.seriesId === w.seriesId)
    const told = new Set(w.told ?? [])
    const progress = (overview.series ?? []).find((s: any) => s.id === w.seriesId)?.scripts as { done: number; total: number } | null | undefined
    const start = phone?.automation?.lastStart as { state?: string; reason?: string | null; at?: string; kind?: string; seriesId?: string | null } | null | undefined
    const startNote = start && start.kind === 'narration' && start.seriesId === w.seriesId && start.at && Date.parse(start.at) >= Date.parse(w.startedAt) - 60_000
      ? ` Last start report: ${start.state}${start.reason ? ` — ${String(start.reason).slice(0, 200)}` : ''}.` : ''

    if (run) {
      w.seen = true
      if (run.paused && !told.has('paused')) {
        told.add('paused'); w.told = [...told]
        if (!(await this.say(w, `⏸ ${w.phoneName} paused the script run for ${where} (${run.done}/${run.total} chapters).${run.account ? ` Profile: ${run.account}.` : ''} Check Phone Status; it may be waiting for a usage limit to lift.`))) return true
      }
      if (!run.paused && told.delete('paused')) w.told = [...told]
      return false
    }
    if (w.seen) {
      const now = progress ? `${progress.done}/${progress.total}` : 'unknown'
      const gained = progress && w.before ? progress.done - w.before.done : null
      const complete = !!progress && progress.done >= progress.total
      await this.say(w, `${complete ? '✓' : '⚠'} ${w.phoneName} stopped writing scripts for ${where}. Chapters scripted on the phone: ${now}${gained !== null ? ` (${gained >= 0 ? '+' : ''}${gained} since I started it)` : ''}.${complete ? ' Fetch them into Studio when you like (I can do that).' : ' It stopped before finishing: check Phone Status / Live Progress for the reason, or ask me to start it again.'}${startNote}`)
      return true
    }
    if (Date.now() - Date.parse(w.startedAt) > NEVER_STARTED_MS) {
      await this.say(w, `⚠ ${w.phoneName} did not start writing scripts for ${where} within ${Math.round(NEVER_STARTED_MS / 60000)} minutes.${phone?.connected === false ? ` It is offline${phone.left ? ` (${phone.left})` : ''}.` : ''}${startNote || ' Check that "Start from Manhwa Studio" is on in Sleeper-Cell.'}`)
      return true
    }
    return false
  }
}
