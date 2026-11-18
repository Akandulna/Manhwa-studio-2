/**
 * The agent's Image Clipper powers: everything the user can do in AntiGravity → Image Clipper for a part and in a
 * chapter's Preview there —
 *   • status per part / chapter / page (Clipper's own pointer status + the AntiGravity job of each page)
 *   • Start process (the part's next pending pages) or Start selected (ticked chapters / pages; joins a live process)
 *   • Upload to Drive only (slice + upload, no AI turn)
 *   • Pause / Resume / Stop / Keep running / Stop now
 *   • per page: Retry / Process again, Review again, Share with phones, Reject (only, or and process again)
 *   • Fetch finished pages (phones' results from R2; only when the user asks — R2 free-tier rule)
 *   • Mark reviewed / Unmark a chapter, and Crop Sections
 * Every action goes through Studio's own HTTP API, exactly like a click there, so the same server checks apply.
 * The agent cannot see page images and does not edit crop pointers. Approval in the chat for: Stop now, Reject,
 * Mark reviewed (the user vouches they checked the crops) and cutting a chapter again.
 */

import type { AgentTool, ToolContext } from './agentTools.js'
import { engineReadiness, runEngineTest } from './engineReady.js'
import { ACTIVE_JOB, PROBLEM_JOB, type ToolKit } from './scriptTools.js'

/** Image Clipper parts are 20 chapters (antigravity/jobs.ts CLIPPER_PART_SIZE). */
export const clipperPart = (chapterNumber: number) => Math.max(1, Math.ceil(chapterNumber / 20))
/** agy scales images above 2000 px per side, so AntiGravity slices are 2000 px wide and pages must fit (AntiGravityClipper). */
const MAX_SIDE = 2000
/** Start process skips pages whose last job ended here until the user retries or ticks them. */
const WAITS_FOR_YOU = new Set(['failed', 'needs_attention', 'stale'])
const REJECTABLE = new Set(['ready_for_human_review', 'publish_failed'])
const STAGE: Record<string, string> = {
  pending: 'selected', preparing: 'slicing', uploading: 'uploading to Drive', prepared: 'uploaded to Drive (no AI yet)', queued: 'queued', analyzing: 'analyzing',
  reviewing: 'AI review', validating: 'validating', delivering: 'importing', publishing: 'publishing to R2', ready_for_human_review: 'ready for human review',
  needs_attention: 'needs attention', failed: 'failed', cancelled: 'stopped', stale: 'stale', interrupted: 'interrupted', publish_failed: 'imported, R2 pending',
  rejected: 'rejected', done: 'saved', skipped_existing: 'already saved'
}
const stageText = (stage: string) => STAGE[stage] ?? stage

interface Image { filename: string; width: number; height: number; status: 'done' | 'pending'; managed?: unknown; cropCount: number; redo?: { status?: string } | null }

/** Why a page can't be ticked (Start selected), or null. A failed page can be ticked: it is processed again. */
export function tickBlock(image: Image, job?: any): string | null {
  if (job && ACTIVE_JOB.has(job.stage)) return 'processing now'
  if (image.managed) return 'managed page'
  if (image.status === 'done') return 'pointers already saved (Reject it first to redo it)'
  if (image.width > MAX_SIDE) return `wider than ${MAX_SIDE} px`
  return null
}
/** Why Start process (whole part) skips a page, or null when it is next in line. */
export function startSkip(image: Image, job?: any): string | null {
  return tickBlock(image, job) ?? (job && WAITS_FOR_YOU.has(job.stage) ? 'waits for Retry (or tick it)' : null)
}

export function clipperTools(kit: ToolKit): AgentTool[] {
  const { call, ToolError, resolveSeries, chapterOf, int, bool, compact } = kit
  const fail = (m: string) => new ToolError(m)
  const clip = (text: string | null | undefined, max = 200) => (text && text.length > max ? `${text.slice(0, max)}…` : text ?? '')

  const numberList = (value: unknown, name: string, max = 60): number[] => {
    const list = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]
    const out = list.map(v => int(v, name, 0))
    if (new Set(out).size !== out.length) throw fail(`${name} lists a number twice.`)
    if (out.length > max) throw fail(`At most ${max} per call.`)
    return out
  }

  /** The chapters of a part that Clipper knows (downloaded, readable), in order, with Clipper's chapter summary. */
  async function partChapters(ctx: ToolContext, seriesId: string, part?: number) {
    const summary = (await call<{ chapters: any[] }>(ctx, 'GET', `/clipper3/series/${seriesId}/summary`)).chapters
    const byId = new Map(summary.map(s => [s.chapterId, s]))
    const rows = await ctx.prisma.chapter.findMany({ where: { seriesId }, orderBy: { number: 'asc' }, select: { id: true, number: true } })
    return rows.filter(r => byId.has(r.id) && (part === undefined || clipperPart(r.number) === part)).map(r => ({ id: r.id, number: r.number, summary: byId.get(r.id) }))
  }
  async function images(ctx: ToolContext, chapterId: string): Promise<Image[]> {
    return (await call<{ images: Image[] }>(ctx, 'GET', `/clipper3/chapters/${chapterId}/images`)).images
  }
  /** The newest AntiGravity Image Clipper job of each page, keyed chapterId|filename. */
  async function jobsOf(ctx: ToolContext, chapterIds: string[]) {
    const map = new Map<string, any>()
    if (!chapterIds.length) return map
    for (const j of await call<any[]>(ctx, 'POST', '/antigravity/page-jobs', { chapterIds, kind: 'clipper' })) map.set(`${j.chapterId}|${j.filename}`, j)
    return map
  }
  async function liveProcess(ctx: ToolContext) {
    const cur = await call<{ live: boolean; run: any | null }>(ctx, 'GET', '/antigravity/runs/current')
    return cur.live && cur.run ? cur.run : null
  }
  const kindName = (kind: string | undefined) => (kind === 'metadata' ? 'Metadata' : kind === 'editor' ? 'Timeline' : kind === 'narration' ? 'Narration' : 'Image Clipper')
  const isClipper = (run: any) => (run?.kind ?? 'clipper') === 'clipper'

  /** Drive (slices are uploaded there) and R2 (results are published there for phones). */
  async function driveAndR2(ctx: ToolContext) {
    const drive = await call<any>(ctx, 'GET', '/google-drive/status').catch(() => null)
    const driveBlockers: string[] = []
    if (!drive || drive.state !== 'connected') driveBlockers.push(drive?.state === 'reconnect_required' ? 'Reconnect Google Drive in Settings → AntiGravity.' : 'Connect Google Drive in Settings → AntiGravity.')
    else if (drive.root?.state === 'missing') driveBlockers.push('Repair the Manhwa Studio folder in Drive (Settings → AntiGravity).')
    const r2 = await call<{ configured: boolean }>(ctx, 'GET', '/antigravity/r2-status').catch(() => null)
    return { driveAccount: drive?.account?.email ?? null, driveBlockers, r2Blocker: r2?.configured === false ? 'Set up Cloudflare R2 (Settings → Cloudflare): results are published there for phones.' : null }
  }

  /** Everything Start needs, running the engine's compatibility test when that is all that is missing (never while a process runs). */
  async function readyToStart(ctx: ToolContext, uploadOnly: boolean) {
    const store = await driveAndR2(ctx)
    if (uploadOnly) {
      if (store.driveBlockers.length) throw fail(store.driveBlockers.join(' '))
      return { engine: null, tested: false, driveAccount: store.driveAccount }
    }
    let engine = await engineReadiness(call, ctx)
    let tested = false
    const others = [...store.driveBlockers, ...(store.r2Blocker ? [store.r2Blocker] : [])]
    if (engine.proofOnly && !others.length) {
      const report = await runEngineTest(call, ctx, engine.engine).catch(error => { throw fail(`The ${engine.label} compatibility test for ${engine.model} could not run: ${error instanceof Error ? error.message : error}`) })
      if (!report.ok) throw fail(`The ${engine.label} compatibility test for ${engine.model} failed${report.error ? `: ${clip(report.error, 300)}` : ''}. Nothing was started.`)
      tested = true
      engine = await engineReadiness(call, ctx)
    }
    const blockers = [...others, ...engine.blockers]
    if (blockers.length) throw fail(blockers.join(' '))
    return { engine, tested, driveAccount: store.driveAccount }
  }

  /** "page" as the page's number in the chapter (#3, as the page list shows it) or its filename. */
  function pickPage(list: Image[], ref: unknown): { image: Image; index: number } {
    if (typeof ref === 'string' && !/^\d+$/.test(ref.trim())) {
      const index = list.findIndex(i => i.filename === ref.trim())
      if (index < 0) throw fail(`No page "${ref}" in this chapter. Pages are ${list[0]?.filename ?? '—'} … ${list.at(-1)?.filename ?? '—'}.`)
      return { image: list[index], index }
    }
    const n = int(ref, 'page', 1, list.length || 1)
    if (!list[n - 1]) throw fail(`This chapter has ${list.length} pages.`)
    return { image: list[n - 1], index: n - 1 }
  }

  const reviewText = (r: any) => (r?.reviewed ? `reviewed${r.by === 'phone' ? ` on ${r.device ?? 'a phone'}` : r.by === 'cropped' ? ' (implied: already cut)' : ''}` : 'not reviewed')
  const cropText = (s: any) => (s.cropping ? 'cutting now' : s.cropComplete ? 'cropped' : s.chopped ? 'partly cropped (out of date or pages missing)' : 'not cropped')

  return [
    {
      name: 'clipper_status',
      help: 'AntiGravity Image Clipper status. Without part: pages with crop pointers per part. With part: per chapter pages done/processing/need you/pending, reviewed or not, cropped or not, plus the process running now and whether this Mac can start (engine, model, Drive, R2, blockers). With chapter: each page (number, filename, pointers, its AntiGravity job stage and last error, why Start skips it).',
      args: { series: 'title or id', part: 'optional part number (1 = chapters 1–20)', chapter: 'optional chapter number for the page-by-page view' },
      run: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        if (a.chapter !== undefined && a.chapter !== null && a.chapter !== '') {
          const chapter = await chapterOf(ctx, s.id, a.chapter)
          const list = await images(ctx, chapter.id)
          const jobs = await jobsOf(ctx, [chapter.id])
          const review = await call<any>(ctx, 'GET', `/clipper3/chapters/${chapter.id}/review`).catch(() => null)
          const pages = list.slice(0, 150).map((img, i) => {
            const job = jobs.get(`${chapter.id}|${img.filename}`)
            const skip = img.status === 'done' ? null : startSkip(img, job)
            return `#${i + 1} ${img.filename}: ${img.redo?.status === 'pending' ? 'rejected (pointers removed)' : img.status === 'done' ? `pointers saved (${img.cropCount} crops)` : 'no pointers'}${job ? ` · job ${stageText(job.stage)}${job.lastError ? ` — ${clip(job.lastError, 140)}` : ''}` : ''}${skip ? ` · ${skip}` : ''}`
          })
          return { series: s.title, chapter: chapter.number, part: clipperPart(chapter.number), pages: list.length, done: list.filter(i => i.status === 'done').length, review: reviewText(review), pageList: pages, ...(list.length > 150 && { note: `Only the first 150 of ${list.length} pages are listed.` }) }
        }
        if (a.part === undefined || a.part === null || a.part === '') {
          const all = await partChapters(ctx, s.id)
          const parts = new Map<number, { chapters: number[]; done: number; total: number; reviewed: number; cropped: number }>()
          for (const c of all) {
            const p = parts.get(clipperPart(c.number)) ?? { chapters: [], done: 0, total: 0, reviewed: 0, cropped: 0 }
            p.chapters.push(c.number); p.done += c.summary.attachedImages; p.total += c.summary.totalImages
            if (c.summary.review?.reviewed) p.reviewed++
            if (c.summary.cropComplete) p.cropped++
            parts.set(clipperPart(c.number), p)
          }
          return { series: s.title, parts: [...parts].sort(([x], [y]) => x - y).map(([part, p]) => ({ part, chapters: compact(p.chapters), pagesWithPointers: `${p.done}/${p.total}`, chaptersReviewed: `${p.reviewed}/${p.chapters.length}`, chaptersCropped: `${p.cropped}/${p.chapters.length}` })) }
        }
        const part = int(a.part, 'part')
        const chapters = await partChapters(ctx, s.id, part)
        if (!chapters.length) throw fail(`Part ${part} of "${s.title}" has no downloaded chapters Clipper can read.`)
        const jobs = await jobsOf(ctx, chapters.map(c => c.id))
        const rows = chapters.map(c => {
          let processing = 0, waiting = 0
          const problems: string[] = []
          for (const [k, j] of jobs) {
            if (!k.startsWith(`${c.id}|`)) continue
            if (ACTIVE_JOB.has(j.stage)) processing++
            else if (WAITS_FOR_YOU.has(j.stage)) { waiting++; if (problems.length < 2) problems.push(`${j.filename}: ${stageText(j.stage)}${j.lastError ? ` — ${clip(j.lastError, 100)}` : ''}`) }
          }
          const done = c.summary.attachedImages, total = c.summary.totalImages
          return {
            chapter: c.number, pages: `${done}/${total} done`, ...(processing && { processing }), ...(waiting && { needYou: waiting, problems }),
            pending: Math.max(0, total - done - processing - waiting), review: reviewText(c.summary.review), crop: cropText(c.summary)
          }
        })
        const proc = await liveProcess(ctx)
        const engine = await engineReadiness(call, ctx).catch(() => null)
        const store = await driveAndR2(ctx)
        return {
          series: s.title, part, chapters: rows,
          process: proc ? { kind: kindName(proc.kind), part: proc.partNumber, thisPart: proc.seriesId === s.id && proc.partNumber === part, state: proc.control, engine: proc.engine ?? 'antigravity', model: proc.model } : 'none running',
          thisMac: {
            engine: engine?.label ?? 'unknown', model: engine?.model ?? null, ...(engine?.effort && { effort: engine.effort }), parallelPages: engine?.concurrency ?? 1, drive: store.driveAccount ?? 'not connected',
            blockers: [...store.driveBlockers, ...(store.r2Blocker ? [store.r2Blocker] : []), ...(engine?.blockers ?? ['could not read the engine'])]
          }
        }
      }
    },
    {
      name: 'clipper_start',
      help: 'Image Clipper on this Mac (AntiGravity: slice each page, upload to Drive, AI finds the crop pointers; results arrive in Clipper as candidates for human review and are shared with phones). Without chapters: Start process = the part\'s next pending pages in order until none is left. With chapters (and optionally pages of ONE chapter): Start selected = only those pages; with this part\'s process running they join it. upload_only true = Upload to Drive (slice + upload, no AI; not while a process runs). Runs the engine\'s compatibility test first when that is all that is missing. Pages with saved pointers, managed pages and pages wider than 2000 px are skipped (Reject a page first to redo it).',
      args: { series: 'title or id', part: 'part number (optional when chapters are given)', chapters: 'optional list of chapter numbers', pages: 'optional, with exactly one chapter: page numbers (#n) or filenames', upload_only: 'optional true: Upload to Drive only' },
      prepare: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const picked = numberList(a.chapters, 'chapters')
        const parts = new Set(picked.map(clipperPart))
        if (parts.size > 1) throw fail(`Those chapters are in several parts (${[...parts].join(', ')}). One part at a time.`)
        const part = a.part !== undefined && a.part !== null && a.part !== '' ? int(a.part, 'part') : picked.length ? clipperPart(picked[0]) : (() => { throw fail('Say which part (1 = chapters 1–20 …).') })()
        if (picked.length && clipperPart(picked[0]) !== part) throw fail(`Chapter ${picked[0]} is not in part ${part}.`)
        const uploadOnly = a.upload_only === undefined ? false : bool(a.upload_only, 'upload_only')
        const pageRefs = Array.isArray(a.pages) ? a.pages : a.pages === undefined || a.pages === null || a.pages === '' ? [] : [a.pages]
        if (pageRefs.length && picked.length !== 1) throw fail('Give pages together with exactly one chapter.')
        if (uploadOnly && !picked.length) throw fail('Upload to Drive is for chosen chapters or pages; say which.')

        const proc = await liveProcess(ctx)
        const joins = !!proc && proc.seriesId === s.id && proc.partNumber === part && isClipper(proc)
        if (proc && !joins) throw fail(`A ${kindName(proc.kind)} process is ${proc.control} on ${proc.seriesId === s.id ? `part ${proc.partNumber}` : 'another series'}. One process at a time: wait for it, or stop it first.`)
        if (joins && uploadOnly) throw fail('A process is running on this part. Upload to Drive when it has finished, or add the pages to it (without upload_only).')
        if (joins && proc.control === 'stop_requested') throw fail('This part\'s process is stopping after the page in progress. Start again once it has stopped (or use clipper_control keep_running).')
        if (joins && !picked.length) return { join: true, runId: proc.id, seriesId: s.id, title: s.title, part, state: proc.control }
        const ready = joins ? { engine: null, tested: false } : await readyToStart(ctx, uploadOnly)

        if (!picked.length) return { seriesId: s.id, title: s.title, part, pages: [], tested: ready.tested }
        const chapters = await partChapters(ctx, s.id, part)
        const chosen = picked.map(n => chapters.find(c => c.number === n) ?? (() => { throw fail(`Chapter ${n} is not a downloaded chapter of part ${part}.`) })())
        const jobs = await jobsOf(ctx, chosen.map(c => c.id))
        const pages: { chapterId: string; filename: string }[] = []
        const skipped: string[] = []
        for (const c of chosen) {
          const list = await images(ctx, c.id)
          const wanted = pageRefs.length ? pageRefs.map(r => pickPage(list, r)) : list.map((image, index) => ({ image, index }))
          for (const { image, index } of wanted) {
            const why = tickBlock(image, jobs.get(`${c.id}|${image.filename}`))
            if (why) { if (pageRefs.length || why !== 'pointers already saved (Reject it first to redo it)') skipped.push(`ch ${c.number} #${index + 1}: ${why}`); continue }
            pages.push({ chapterId: c.id, filename: image.filename })
          }
        }
        if (!pages.length) throw fail(`Nothing to start: ${skipped.slice(0, 4).join('; ') || 'every page of those chapters already has pointers'}.`)
        return { seriesId: s.id, title: s.title, part, pages, numbers: picked, skipped: skipped.slice(0, 6), uploadOnly, joins, tested: ready.tested }
      },
      run: async (a, ctx) => {
        if (a.join) {
          // Start process on the part already running: it carries on taking the next pending pages.
          await call(ctx, 'POST', '/antigravity/runs', { seriesId: a.seriesId, partNumber: a.part, mode: 'next', kind: 'clipper' })
          await ctx.watch?.({ kind: 'clipper', runId: a.runId, seriesId: a.seriesId, title: a.title, part: a.part })
          return { alreadyRunning: true, series: a.title, part: a.part, note: 'This part\'s Image Clipper process is already running; it now takes the next pending pages itself. I will post here when it finishes or a page needs you.' }
        }
        const body = a.pages.length
          ? { seriesId: a.seriesId, partNumber: a.part, pages: a.pages, prepareOnly: !!a.uploadOnly, kind: 'clipper' }
          : { seriesId: a.seriesId, partNumber: a.part, mode: 'next', kind: 'clipper' }
        const r = await call<{ runId: string | null; created: string[]; reused: string[]; skipped: { filename: string; reason: string }[] }>(ctx, 'POST', '/antigravity/runs', body)
        const total = r.created.length + r.reused.length
        if (!total) throw fail(`Nothing could start${r.skipped.length ? `: ${r.skipped.slice(0, 3).map(x => `${x.filename} (${x.reason})`).join('; ')}` : ' (no pending page in this part)'}.`)
        if (r.runId) await ctx.watch?.({ kind: 'clipper', runId: r.runId, seriesId: a.seriesId, title: a.title, part: a.part })
        return {
          started: true, series: a.title, part: a.part, what: a.uploadOnly ? 'Upload to Drive (no AI)' : a.pages.length ? (a.joins ? 'added to the running process' : 'Start selected') : 'Start process (the part\'s pending pages, in order)',
          ...(a.pages.length && { pages: total, chapters: compact(a.numbers) }), ...(r.reused.length && { alreadyInProgressOrUploaded: r.reused.length }),
          ...((a.skipped?.length || r.skipped.length) && { skipped: [...(a.skipped ?? []), ...r.skipped.slice(0, 3).map(x => `${x.filename}: ${x.reason}`)].slice(0, 6) }),
          ...(a.tested && { compatibilityTest: 'passed (run first because the model had changed)' }),
          note: 'Runs in the background; I will post here when it finishes or a page needs you.'
        }
      }
    },
    {
      name: 'clipper_control',
      help: 'Control the Image Clipper process running on this Mac: pause (no new pages start), resume, stop (the pages in progress finish and save first), keep_running (take back a stop), or stop_now (cancels the pages in progress; needs the user\'s approval).',
      args: { action: 'pause | resume | stop | keep_running | stop_now' },
      prepare: async (a, ctx) => {
        const action = typeof a.action === 'string' ? a.action.trim().toLowerCase().replace(/-/g, '_') : ''
        if (!['pause', 'resume', 'stop', 'keep_running', 'stop_now'].includes(action)) throw fail('action must be pause, resume, stop, keep_running or stop_now.')
        const proc = await liveProcess(ctx)
        if (!proc) throw fail('No AntiGravity process is running.')
        if (!isClipper(proc)) throw fail(`The running process is ${kindName(proc.kind)}, not Image Clipper.`)
        if (action === 'stop_now' && proc.control !== 'stop_requested') throw fail('Stop now comes after Stop (as on the page): use action stop first; the pages in progress then finish, or stop_now cancels them.')
        if (action === 'keep_running' && proc.control !== 'stop_requested') throw fail(`The process is ${proc.control}, not stopping; nothing to take back.`)
        const row = await ctx.prisma.series.findUnique({ where: { id: proc.seriesId }, select: { title: true } })
        return { action, runId: proc.id, part: proc.partNumber, title: row?.title ?? 'this series' }
      },
      approval: async a => (a.action === 'stop_now' ? `Stop the Image Clipper process on "${a.title}" part ${a.part} now: pages in progress are cancelled and cannot save a late result (pages already finished stay)` : null),
      run: async (a, ctx) => {
        const url = a.action === 'keep_running' ? 'resume' : a.action === 'stop_now' ? 'stop-now' : a.action
        await call(ctx, 'POST', `/antigravity/runs/${a.runId}/${url}`)
        return { done: a.action, series: a.title, part: a.part }
      }
    },
    {
      name: 'clipper_page',
      help: 'Act on one page\'s AntiGravity Image Clipper result. retry = new attempt (also "Process again" for a rejected page, and "publish again" for a page stuck at "imported, R2 pending"); review_again = more AI review rounds in the same conversation for a page that needs attention (no new analysis); share_with_phones = publish a page ready for review to the phones through R2; reject = remove its pointers (backed up; phones told it is void); reject_and_process_again = reject, then run it again at once. Reject needs the user\'s approval.',
      args: { series: 'title or id', chapter: 'chapter number', page: 'page number (#n) or filename', action: 'retry | review_again | share_with_phones | reject | reject_and_process_again', note: 'optional, for reject: what was wrong (kept in the run log, not sent to the model)' },
      prepare: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const chapter = await chapterOf(ctx, s.id, a.chapter)
        const action = typeof a.action === 'string' ? a.action.trim().toLowerCase().replace(/[-\s]+/g, '_') : ''
        const actions = ['retry', 'process_again', 'review_again', 'share_with_phones', 'reject', 'reject_and_process_again']
        if (!actions.includes(action)) throw fail(`action must be one of: ${actions.join(', ')}.`)
        const list = await images(ctx, chapter.id)
        const { image, index } = pickPage(list, a.page)
        const job = (await jobsOf(ctx, [chapter.id])).get(`${chapter.id}|${image.filename}`)
        const where = `chapter ${chapter.number} page #${index + 1} (${image.filename})`
        if (!job) throw fail(`${where} has no AntiGravity job. ${image.status === 'done' ? 'Its pointers came from a phone or by hand; reject those in Clipper itself.' : 'Start it with clipper_start.'}`)
        const stage = job.stage as string
        if ((action === 'retry' || action === 'process_again') && !PROBLEM_JOB.has(stage)) throw fail(`${where} is "${stageText(stage)}"; Retry is for failed, stopped, rejected or needs-attention pages.`)
        if (action === 'review_again' && !['needs_attention', 'interrupted'].includes(stage)) throw fail(`${where} is "${stageText(stage)}"; Review again is for pages that need attention or were interrupted.`)
        if (action === 'share_with_phones' && !(stage === 'ready_for_human_review' && job.importState === 'imported')) throw fail(`${where} is "${stageText(stage)}"; only an imported page ready for review can be shared${stage === 'publish_failed' ? ' (this one: use retry to publish again)' : ''}.`)
        if (action.startsWith('reject') && !(REJECTABLE.has(stage) && job.importState === 'imported')) throw fail(`${where} is "${stageText(stage)}"; only a result imported into Clipper can be rejected.`)
        const note = typeof a.note === 'string' ? a.note.trim().slice(0, 300) : ''
        return { action: action === 'process_again' ? 'retry' : action, jobId: job.id, runId: job.runId, seriesId: s.id, title: s.title, number: chapter.number, page: index + 1, filename: image.filename, stage, note, part: clipperPart(chapter.number) }
      },
      approval: async a => (a.action.startsWith('reject')
        ? `Reject "${a.title}" chapter ${a.number} page #${a.page} (${a.filename}): its crop pointers and any crops cut from them are backed up and removed, and phones are told the result is void${a.action === 'reject_and_process_again' ? '; then the page is processed again in a new conversation' : ''}${a.note ? `. Note: "${a.note}"` : ''}`
        : null),
      run: async (a, ctx) => {
        let after: any
        if (a.action === 'retry') after = await call(ctx, 'POST', `/antigravity/jobs/${a.jobId}/retry`)
        else if (a.action === 'review_again') after = await call(ctx, 'POST', `/antigravity/jobs/${a.jobId}/review`)
        else if (a.action === 'share_with_phones') after = await call(ctx, 'POST', `/antigravity/jobs/${a.jobId}/publish`)
        else after = await call(ctx, 'POST', `/antigravity/jobs/${a.jobId}/reject`, { rerun: a.action === 'reject_and_process_again', ...(a.note && { note: a.note }) })
        if (['retry', 'review_again', 'reject_and_process_again'].includes(a.action)) await ctx.watch?.({ kind: 'clipper', runId: after?.runId ?? a.runId, seriesId: a.seriesId, title: a.title, part: a.part })
        return { done: a.action, chapter: a.number, page: `#${a.page} ${a.filename}`, now: stageText(after?.stage ?? 'unknown'), ...(after?.lastError && { note: clip(after.lastError, 240) }) }
      }
    },
    {
      name: 'clipper_fetch_finished',
      help: 'Fetch finished pages: read the pages phones (and AntiGravity) finished for a part from R2 and import missing crop pointers here. Saved pointers are never replaced. Reads R2 (1 list + 1 read per new page): only when the user asks.',
      args: { series: 'title or id', part: 'part number' },
      run: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const part = int(a.part, 'part')
        const chapters = await partChapters(ctx, s.id, part)
        if (!chapters.length) throw fail(`Part ${part} has no downloaded chapters.`)
        const out = await call<any>(ctx, 'POST', '/antigravity/results/fetch', { seriesId: s.id, chapterIds: chapters.map(c => c.id) })
        return {
          series: s.title, part, sharedOnR2: out.listed, newOrChanged: out.read, imported: out.imported,
          ...(out.already && { alreadyHere: out.already }), ...(out.conflicts && { keptLocalPointers: out.conflicts }), ...(out.stale && { fromOlderPageSet: out.stale }),
          ...(out.skipped && { legacyOrOther: `${out.skipped} (use Clipper's Sync json for those)` }), ...(out.rejected && { rejectedHere: out.rejected }), ...(out.errors?.length && { errors: out.errors.slice(0, 3) })
        }
      }
    },
    {
      name: 'clipper_review',
      help: 'Mark chapters reviewed (or unmark them), as Preview → Mark reviewed / Unmark does; phones see it too. Crop Sections waits for it. You cannot see the crops, so mark only when the user says they checked these chapters, and it needs their approval. Unmarking runs at once.',
      args: { series: 'title or id', chapters: 'list of chapter numbers', reviewed: 'true to mark reviewed, false to unmark' },
      prepare: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const numbers = numberList(a.chapters, 'chapters', 40)
        if (!numbers.length) throw fail('Say which chapters.')
        const reviewed = bool(a.reviewed, 'reviewed')
        const rows = await Promise.all(numbers.map(n => chapterOf(ctx, s.id, n)))
        const states = await Promise.all(rows.map(r => call<any>(ctx, 'GET', `/clipper3/chapters/${r.id}/review`)))
        const change = rows.filter((_, i) => !!states[i].reviewed !== reviewed || (reviewed && states[i].by !== 'desktop' && states[i].by !== 'phone'))
        if (!change.length) throw fail(`Chapter${numbers.length === 1 ? '' : 's'} ${compact(numbers)} ${numbers.length === 1 ? 'is' : 'are'} already ${reviewed ? 'reviewed' : 'not reviewed'}.`)
        return { seriesId: s.id, title: s.title, reviewed, chapterIds: change.map(r => r.id), numbers: change.map(r => r.number) }
      },
      approval: async a => (a.reviewed ? `Mark "${a.title}" chapter ${compact(a.numbers)} as reviewed: you confirm you checked every page's crops. Crop Sections can then cut ${a.numbers.length === 1 ? 'it' : 'them'}, and the phones show ${a.numbers.length === 1 ? 'it' : 'them'} as reviewed` : null),
      run: async (a, ctx) => {
        const done: number[] = [], failed: string[] = []
        for (let i = 0; i < a.chapterIds.length; i++) {
          try { await call(ctx, 'PUT', `/clipper3/chapters/${a.chapterIds[i]}/review`, { reviewed: a.reviewed }); done.push(a.numbers[i]) } catch (error) { failed.push(`chapter ${a.numbers[i]}: ${error instanceof Error ? clip(error.message, 160) : error}`) }
        }
        return { [a.reviewed ? 'markedReviewed' : 'unmarked']: done.length ? compact(done) : 'none', ...(failed.length && { failed }) }
      }
    },
    {
      name: 'clipper_crop',
      help: 'Crop Sections: cut reviewed chapters into crop sections (the pages with pointers). One chapter = the Preview button (also cuts a chapter with some pages still pending; cutting an already cropped chapter again needs the user\'s approval). Several chapters = queued one after another, skipping chapters that are not reviewed, still have pending pages or are already cropped. Runs in the background; Studio posts here when the cut is done.',
      args: { series: 'title or id', chapters: 'list of chapter numbers' },
      prepare: async (a, ctx) => {
        const s = await resolveSeries(ctx, a.series)
        const numbers = numberList(a.chapters, 'chapters', 40)
        if (!numbers.length) throw fail('Say which chapters.')
        const rows = await Promise.all(numbers.map(n => chapterOf(ctx, s.id, n)))
        const summary = new Map((await call<{ chapters: any[] }>(ctx, 'GET', `/clipper3/series/${s.id}/summary`)).chapters.map(c => [c.chapterId, c]))
        const info = rows.map(r => ({ id: r.id, number: r.number, s: summary.get(r.id) }))
        if (info.length === 1) {
          const c = info[0]
          if (!c.s) throw fail(`Chapter ${c.number} has no readable pages in Clipper.`)
          if (c.s.cropping) throw fail(`Chapter ${c.number} is being cut right now.`)
          if (!c.s.review?.reviewed) throw fail(`Chapter ${c.number} is not reviewed yet. Crop Sections waits for the review (clipper_review, after the user has checked it).`)
          if (!c.s.attachedImages) throw fail(`Chapter ${c.number} has no page with pointers yet.`)
        }
        return { seriesId: s.id, title: s.title, single: info.length === 1, chapterIds: info.map(c => c.id), numbers: info.map(c => c.number), again: info.length === 1 && !!(info[0].s?.chopped || info[0].s?.review?.cropped), pending: info.length === 1 ? info[0].s.totalImages - info[0].s.attachedImages : 0 }
      },
      approval: async a => (a.again ? `Cut "${a.title}" chapter ${a.numbers[0]} again: its crop sections are replaced by a fresh cut from the current pointers` : null),
      run: async (a, ctx) => {
        let queued: number[], skipped: string[] = []
        if (a.single) {
          const r = await call<{ started: boolean; images: number }>(ctx, 'POST', `/clipper3/chapters/${a.chapterIds[0]}/crop`)
          queued = r.started ? [a.numbers[0]] : []
        } else {
          const r = await call<{ queued: { chapterNumber: number }[]; skipped: { chapterNumber: number; reason: string }[] }>(ctx, 'POST', `/clipper3/series/${a.seriesId}/crop-reviewed`, { chapterIds: a.chapterIds })
          queued = r.queued.map(q => q.chapterNumber)
          skipped = r.skipped.map(x => `chapter ${x.chapterNumber}: ${x.reason}`)
        }
        if (!queued.length) throw fail(`Nothing was cut: ${skipped.slice(0, 4).join('; ') || 'Studio did not start the cut'}.`)
        await ctx.watch?.({ kind: 'crop', seriesId: a.seriesId, title: a.title, chapterIds: a.chapterIds.filter((_: string, i: number) => queued.includes(a.numbers[i])), numbers: queued })
        return { cutting: compact(queued), ...(skipped.length && { skipped: skipped.slice(0, 6) }), ...(a.single && a.pending > 0 && { note: `${a.pending} page(s) still have no pointers and are not cut.` }), next: 'I will post here when the cut is done.' }
      }
    }
  ]
}
