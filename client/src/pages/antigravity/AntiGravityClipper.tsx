/**
 * AntiGravity → Image Clipper for one part (PRD §6.4–6.5): the Library view.
 *
 * Chapters of this series and part only, with expandable pages. Pointer
 * status is Clipper 3.0's own per-page status (GET /clipper3/chapters/:id/images),
 * so pages done by the phone, by hand or by any provider show Done here.
 * Human review and final cropping are shown separately, per chapter.
 *
 * Two ways to start, one process at a time either way:
 * - Start process (nothing ticked): takes the part's next pending page in
 *   chapter → page order, as many at a time as the parallel-pages setting
 *   allows, until none is left. Failed pages wait for Retry.
 * - Tick chapters and/or pages, then Start selected (or Upload to Drive to
 *   slice + upload only). With a process already live on this part the ticked
 *   pages join it; a process on another part must finish first.
 * Pages with saved pointers, managed pages and pages wider than 2000 px can't
 * be ticked. Replacing saved pointers goes through Reject (here) or Clipper's
 * explicit redo.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { Activity, AlertTriangle, ChevronDown, ChevronRight, DownloadCloud, ExternalLink, Eye, Loader2, Pause, Play, RotateCcw, Square, Timer, UploadCloud, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { antigravityJobsApi, clipper3Api, ENGINE_LABELS, type AntigravityJobView, type Clipper3Chapter, type Clipper3ChapterImages, type Clipper3ChapterSummary, type Clipper3Image } from '@/lib/api'
import { useSocket } from '@/lib/socket'
import { useToast } from '@/components/ui/use-toast'
import { clipperPartNumber } from '@/lib/clipperParts'
import { cn } from '@/lib/utils'
import { AntiGravityTopBar, attemptDuration, chapterLabel, formatDuration, partRange, useCurrentProcess, useReadiness, useSeriesScope, useTicker } from './shared'
import { PagePreviewDialog } from './PagePreviewDialog'
import { canReject, RejectJobButton } from './RejectJobButton'

/** agy scales images above 2000 px per side, so AntiGravity slices are 2000 px and pages must fit that width. */
export const ANTIGRAVITY_MAX_SIDE = 2000

const key = (chapterId: string, filename: string) => `${chapterId}|${filename}`

export const ACTIVE_JOB = new Set(['pending', 'preparing', 'uploading', 'queued', 'analyzing', 'describing', 'planning', 'reviewing', 'validating', 'delivering', 'publishing'])
export const RETRYABLE = new Set(['failed', 'needs_attention', 'interrupted', 'cancelled', 'publish_failed', 'rejected'])
/** Pages whose last job ended here wait for the operator (Retry / Review again); Start process skips them. */
export const WAITS_FOR_YOU = new Set(['failed', 'needs_attention', 'stale'])

/** Why Start process will not take a page (or why it is busy), or null when it is next in line. */
export function ineligibleReason(image: Clipper3Image, job?: AntigravityJobView | null): string | null {
  if (job && ACTIVE_JOB.has(job.stage)) return 'Processing now'
  if (image.managed) return 'Managed page — Start process skips it'
  if (image.status === 'done') return 'Pointers already saved (use Reject or Clipper redo to regenerate)'
  if (image.width > ANTIGRAVITY_MAX_SIDE) return `Wider than ${ANTIGRAVITY_MAX_SIDE} px — Start process skips it`
  if (job && WAITS_FOR_YOU.has(job.stage)) return 'Start process skips it until you Retry or tick it'
  return null
}

/** Why a page can't be ticked, or null. Unlike Start process, a ticked failed page is processed again. */
export function selectBlockReason(image: Clipper3Image, job?: AntigravityJobView | null): string | null {
  const reason = ineligibleReason(image, job)
  return reason && !(job && WAITS_FOR_YOU.has(job.stage) && reason.startsWith('Start process skips it until')) ? reason : null
}

function PointerBadge({ image }: { image: Clipper3Image }) {
  if (image.redo?.status === 'pending') return <Badge variant="warning" title="Rejected: its pointers were removed. Tick it and Start selected, or use Process again.">Rejected</Badge>
  if (image.status === 'done') return <Badge variant="success">Done</Badge>
  return <Badge variant="outline">Pending</Badge>
}

export const STAGE_LABEL: Record<string, string> = {
  pending: 'Selected', preparing: 'Slicing', uploading: 'Uploading', prepared: 'Prepared', queued: 'Queued', analyzing: 'Analyzing',
  reviewing: 'AI review', validating: 'Validating', delivering: 'Importing', publishing: 'Publishing to R2', ready_for_human_review: 'Ready for human review',
  needs_attention: 'Needs attention', failed: 'Failed', cancelled: 'Stopped', stale: 'Stale', interrupted: 'Interrupted', publish_failed: 'Imported · R2 pending',
  rejected: 'Rejected', describing: 'Describing', planning: 'Making timeline', done: 'Saved', skipped_existing: 'Already saved'
}

export function JobBadge({ job }: { job?: AntigravityJobView | null }) {
  if (!job) return <span className="text-xs text-muted-foreground">Not started</span>
  const variant = ['ready_for_human_review', 'done', 'skipped_existing'].includes(job.stage) ? 'success' : ['failed', 'stale'].includes(job.stage) ? 'destructive' : ['needs_attention', 'interrupted', 'cancelled', 'publish_failed', 'rejected'].includes(job.stage) ? 'warning' : 'secondary'
  return <Badge variant={variant} title={job.lastError ?? undefined}>{ACTIVE_JOB.has(job.stage) && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{STAGE_LABEL[job.stage] ?? job.stage}</Badge>
}

/** AI processing time of the page's current attempt (analysis + review; slicing and the Drive upload are not counted). */
export function AiTime({ job, now }: { job?: AntigravityJobView | null; now: number }) {
  const took = attemptDuration(job?.attempt ?? job?.attempts?.at(-1), now)
  if (!took) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap text-xs tabular-nums', took.running ? 'text-foreground' : 'text-muted-foreground')} title={took.running ? 'AI processing so far (slicing and Drive upload not counted)' : 'AI processing time: analysis + review (slicing and Drive upload not counted)'}>
      <Timer className="h-3 w-3" />{formatDuration(took.ms)}{took.running ? '…' : ''}
    </span>
  )
}

/** One chapter's page counts without opening it: done (Clipper's own), processing and waiting (AntiGravity jobs), pending. */
function chapterCounts(chapterId: string, summary: Clipper3ChapterSummary | undefined, jobs: Map<string, AntigravityJobView>) {
  let processing = 0
  let waiting = 0
  for (const job of jobs.values()) {
    if (job.chapterId !== chapterId) continue
    if (ACTIVE_JOB.has(job.stage)) processing++
    else if (WAITS_FOR_YOU.has(job.stage)) waiting++
  }
  const total = summary?.totalImages ?? 0
  const done = summary?.attachedImages ?? 0
  return { total, done, processing, waiting, pending: Math.max(0, total - done - processing - waiting) }
}

function ChapterFacts({ summary, counts }: { summary?: Clipper3ChapterSummary; counts: ReturnType<typeof chapterCounts> }) {
  if (!summary) return <span className="text-xs text-muted-foreground">No Clipper summary</span>
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <Badge variant={summary.fullyAttached ? 'success' : 'outline'} title="Pages with saved crop pointers (by AntiGravity, a phone or by hand)">Done {counts.done}/{counts.total}</Badge>
      {counts.processing > 0 && <Badge variant="secondary"><Loader2 className="mr-1 h-3 w-3 animate-spin" />Processing {counts.processing}</Badge>}
      {counts.waiting > 0 && <Badge variant="warning" title="Failed or needs attention: open the chapter and Retry">Needs you {counts.waiting}</Badge>}
      {counts.pending > 0 && !summary.fullyAttached && <Badge variant="outline">Pending {counts.pending}</Badge>}
      <Badge variant={summary.review.reviewed ? 'success' : 'outline'}>{summary.review.reviewed ? 'Human reviewed' : 'Review pending'}</Badge>
      <Badge variant={summary.cropComplete ? 'success' : summary.chopped ? 'warning' : 'outline'}>{summary.cropComplete ? 'Cropped' : summary.chopped ? 'Partly cropped' : summary.cropping ? 'Cropping…' : 'Not cropped'}</Badge>
    </div>
  )
}

export default function AntiGravityClipper() {
  const { seriesId, partNumber } = useParams()
  const part = Number(partNumber)
  const scope = useSeriesScope(seriesId)
  const readiness = useReadiness()
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [pages, setPages] = useState<Record<string, Clipper3ChapterImages | { error: string } | 'loading'>>({})
  const [jobs, setJobs] = useState<Map<string, AntigravityJobView>>(new Map())
  const [busy, setBusy] = useState(false)
  /** Ticked pages (`chapterId|filename`). Empty = Start process takes the part's next pending pages. */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastTick = useRef<{ chapterId: string; index: number } | null>(null)
  const { current, reload: reloadProcess } = useCurrentProcess()
  const { socket } = useSocket()
  const { toast } = useToast()

  const chapters: Clipper3Chapter[] = useMemo(() => scope.chapters.filter(c => clipperPartNumber(c.number) === part), [scope.chapters, part])

  const loadJobs = useCallback(async () => {
    if (chapters.length === 0) return
    try {
      const list = await antigravityJobsApi.pageJobs(chapters.map(c => c.id))
      setJobs(new Map(list.map(j => [`${j.chapterId}|${j.filename}`, j])))
    } catch { /* the column stays as it was */ }
  }, [chapters])
  useEffect(() => { void loadJobs() }, [loadJobs])

  /**
   * Re-reads the open chapters' pages in the background and swaps them in when
   * they arrive, so an expanded chapter never collapses to "Loading pages…"
   * while a run is going. Closed chapters forget their cached pages, unless
   * some of their pages are ticked (the selection is checked against them).
   */
  const openRef = useRef(open)
  openRef.current = open
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const refreshPages = useCallback(async () => {
    const openIds = [...new Set([...openRef.current, ...[...selectedRef.current].map(k => k.split('|')[0])])]
    setPages(prev => {
      const kept: typeof prev = {}
      for (const id of openIds) if (prev[id]) kept[id] = prev[id]
      return kept
    })
    await Promise.all(openIds.map(async id => {
      try {
        const list = await clipper3Api.getImages(id)
        setPages(prev => ({ ...prev, [id]: list }))
      } catch { /* keep what is on screen */ }
    }))
  }, [])

  const refreshAll = useRef(() => {})
  refreshAll.current = () => { void loadJobs(); void refreshPages(); scope.reload() }
  // Local progress events only (no R2 traffic); a durable snapshot is re-read on each event burst.
  // Subscribed once per socket, so re-renders never cancel the pending refresh.
  useEffect(() => {
    if (!socket) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const onProgress = () => { if (!timer) timer = setTimeout(() => { timer = null; refreshAll.current() }, 1500) }
    socket.on('antigravity:progress', onProgress)
    return () => { socket.off('antigravity:progress', onProgress); if (timer) clearTimeout(timer) }
  }, [socket])

  const anyRunning = useMemo(() => [...jobs.values()].some(j => j.attempt?.status === 'active' && !j.attempt.finishedAt), [jobs])
  const now = useTicker(anyRunning)
  const [preview, setPreview] = useState<{ chapterId: string; index: number } | null>(null)

  const loadPages = useCallback(async (chapterId: string): Promise<Clipper3ChapterImages | null> => {
    const existing = pages[chapterId]
    if (existing && existing !== 'loading' && !('error' in existing)) return existing
    setPages(p => ({ ...p, [chapterId]: 'loading' }))
    try {
      const list = await clipper3Api.getImages(chapterId)
      setPages(p => ({ ...p, [chapterId]: list }))
      return list
    } catch (error) {
      setPages(p => ({ ...p, [chapterId]: { error: (error as Error).message } }))
      return null
    }
  }, [pages])

  // Open chapters reload their pages after the cache is cleared (progress events, Fetch, Reject).
  useEffect(() => {
    for (const chapterId of open) if (!pages[chapterId]) void loadPages(chapterId)
  }, [open, pages, loadPages])

  const toggleOpen = (chapterId: string) => {
    setOpen(prev => {
      const next = new Set(prev)
      if (next.has(chapterId)) next.delete(chapterId)
      else { next.add(chapterId); void loadPages(chapterId) }
      return next
    })
  }

  /** A chapter's tickable pages, or null while its pages aren't loaded. */
  const tickable = (chapterId: string, images: Clipper3Image[]) => images.filter(img => !selectBlockReason(img, jobs.get(key(chapterId, img.filename))))

  /** Ticked pages that are still tickable, in chapter → page order. */
  const selectedPages = useMemo(() => {
    const out: { chapterId: string; filename: string }[] = []
    if (selected.size === 0) return out
    for (const chapter of chapters) {
      const list = pages[chapter.id]
      if (!list || list === 'loading' || 'error' in list) continue
      for (const img of tickable(chapter.id, list.images)) if (selected.has(key(chapter.id, img.filename))) out.push({ chapterId: chapter.id, filename: img.filename })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, chapters, pages, jobs])

  const tickChapter = async (chapterId: string, on: boolean) => {
    if (!on) {
      setSelected(prev => new Set([...prev].filter(k => !k.startsWith(`${chapterId}|`))))
      return
    }
    const list = await loadPages(chapterId)
    if (!list) return
    const add = tickable(chapterId, list.images)
    if (add.length === 0) { toast({ title: 'Nothing to tick in this chapter', description: 'Every page is done, managed, too wide or processing now.' }); return }
    setSelected(prev => new Set([...prev, ...add.map(img => key(chapterId, img.filename))]))
  }

  /** Click ticks one page; Shift-click ticks (or unticks) the range from the last clicked page in the same chapter. */
  const tickPage = (chapterId: string, images: Clipper3Image[], index: number, shift: boolean) => {
    const target = !selected.has(key(chapterId, images[index].filename))
    const last = lastTick.current
    const range = shift && last?.chapterId === chapterId
      ? images.slice(Math.min(last.index, index), Math.max(last.index, index) + 1)
      : [images[index]]
    const keys = tickable(chapterId, range).map(img => key(chapterId, img.filename))
    setSelected(prev => {
      const next = new Set(prev)
      for (const k of keys) target ? next.add(k) : next.delete(k)
      return next
    })
    lastTick.current = { chapterId, index }
  }

  // The one process: Image Clipper on this part, anything else (another part, or Metadata), or none.
  const process = current?.live ? current.run : null
  const processHere = !!process && process.seriesId === seriesId && process.partNumber === part && (process.kind ?? 'clipper') === 'clipper'
  const processElsewhere = !!process && !processHere
  const processing = useMemo(() => [...jobs.values()].filter(j => ACTIVE_JOB.has(j.stage)).length, [jobs])

  const startProcess = async () => {
    const message = [
      `Start processing ${title} · Part ${part}?`,
      `Studio takes the next pending page in chapter order, ${readiness.concurrency} at a time, until none is left: it slices the page, uploads it to Drive (${readiness.drive?.account?.email ?? 'no account'}) and sends it to the AI.`,
      `Engine: ${readiness.engineLabel} · Model: ${readiness.modelLabel}${readiness.effort ? ` (${readiness.effort})` : ''}`,
      'Pages already done, managed or wider than 2000 px are skipped; failed pages wait for your Retry. Results arrive as candidates for your normal review.'
    ].join('\n\n')
    if (!window.confirm(message)) return
    setBusy(true)
    try {
      await antigravityJobsApi.startNext(seriesId!, part)
      reloadProcess()
      void loadJobs()
    } catch (e) {
      toast({ title: 'Could not start', description: (e as Error).message, variant: 'destructive' })
    } finally { setBusy(false) }
  }

  /** Start selected (AI) or Upload to Drive (slice + upload only) for the ticked pages. */
  const startSelected = async (prepareOnly: boolean) => {
    const n = selectedPages.length
    if (n === 0) return
    const what = `${n} ticked page${n === 1 ? '' : 's'}`
    const message = prepareOnly
      ? [`Upload ${what} of ${title} · Part ${part} to Drive?`, `Studio slices each page and uploads it to ${readiness.drive?.account?.email ?? 'no account'}. No AI turn runs; Start selected later reuses these uploads.`].join('\n\n')
      : processHere
        ? [`Add ${what} to the running process on Part ${part}?`, `They run on that process's engine and model (${process ? `${ENGINE_LABELS[process.engine ?? 'antigravity']} · ${process.model}` : ''}), ahead of the next pending pages.`].join('\n\n')
        : [
          `Start ${what} of ${title} · Part ${part}?`,
          `Studio slices each page, uploads it to Drive (${readiness.drive?.account?.email ?? 'no account'}) and sends it to the AI, ${readiness.concurrency} at a time. Only the ticked pages run.`,
          `Engine: ${readiness.engineLabel} · Model: ${readiness.modelLabel}${readiness.effort ? ` (${readiness.effort})` : ''}`,
          'Results arrive as candidates for your normal review.'
        ].join('\n\n')
    if (!window.confirm(message)) return
    setBusy(true)
    try {
      const out = await antigravityJobsApi.startPages(seriesId!, part, selectedPages, prepareOnly)
      const total = out.created.length + out.reused.length
      toast({
        title: total === 0 ? 'No ticked page could start' : prepareOnly ? `Uploading ${total} page${total === 1 ? '' : 's'} to Drive` : `${total} page${total === 1 ? '' : 's'} ${processHere ? 'added to the process' : 'started'}`,
        description: [out.reused.length ? `${out.reused.length} already in progress or prepared` : '', out.skipped.length ? `${out.skipped.length} skipped: ${out.skipped.slice(0, 2).map(s => `${s.filename} (${s.reason})`).join(', ')}` : ''].filter(Boolean).join(' · ') || undefined,
        variant: total === 0 ? 'destructive' : undefined
      })
      if (total > 0) { setSelected(new Set()); lastTick.current = null }
      reloadProcess()
      void loadJobs()
    } catch (e) {
      toast({ title: prepareOnly ? 'Could not upload' : 'Could not start', description: (e as Error).message, variant: 'destructive' })
    } finally { setBusy(false) }
  }

  const controlProcess = async (action: 'pause' | 'resume' | 'stop' | 'stop-now') => {
    if (!process) return
    if (action === 'stop' && !window.confirm('Stop this process? No new pages start; the page in progress finishes and saves first, then the process stops.')) return
    if (action === 'stop-now' && !window.confirm('Stop now? Pages in progress are cancelled and cannot commit late results. Pages already finished stay.')) return
    setBusy(true)
    try { await antigravityJobsApi.control(process.id, action); reloadProcess(); void loadJobs() } catch (e) {
      toast({ title: 'AntiGravity', description: (e as Error).message, variant: 'destructive' })
    } finally { setBusy(false) }
  }

  const [fetching, setFetching] = useState(false)
  /** Explicit R2 collection for this part's chapters (never automatic: PRD §14.4, free-tier rule). */
  const fetchResults = async () => {
    setFetching(true)
    try {
      const out = await antigravityJobsApi.fetchResults(seriesId!, chapters.map(c => c.id))
      toast({
        title: out.listed === 0 ? 'No finished pages shared on R2 for this part' : `Fetched from R2: ${out.imported} page${out.imported === 1 ? '' : 's'} imported`,
        description: [`${out.listed} shared page${out.listed === 1 ? '' : 's'} (${out.read} new or changed)`, out.already ? `${out.already} already here` : '', out.conflicts ? `${out.conflicts} kept local pointers` : '', out.stale ? `${out.stale} from an older page set` : '', out.skipped ? `${out.skipped} legacy/other (use Sync json)` : '', out.rejected ? `${out.rejected} rejected here (not taken back)` : '', ...out.errors.slice(0, 2)].filter(Boolean).join(' · ')
      })
      if (out.imported) refreshAll.current()
    } catch (e) {
      toast({ title: 'Fetch failed', description: (e as Error).message, variant: 'destructive' })
    } finally { setFetching(false) }
  }

  const retry = async (jobId: string) => {
    try { await antigravityJobsApi.retry(jobId); void loadJobs() } catch (e) { toast({ title: 'Retry failed', description: (e as Error).message, variant: 'destructive' }) }
  }

  if (!Number.isInteger(part) || part < 1) return <Navigate to={`/antigravity/series/${seriesId}`} replace />
  const { first, last } = partRange(part)
  const title = scope.series?.title ?? 'Series'
  const partCounts = chapters.reduce((acc, c) => {
    const n = chapterCounts(c.id, scope.summaries.get(c.id), jobs)
    return { done: acc.done + n.done, total: acc.total + n.total, waiting: acc.waiting + n.waiting, pending: acc.pending + n.pending }
  }, { done: 0, total: 0, waiting: 0, pending: 0 })
  const stateLabel: Record<string, string> = { running: 'Running', preparing: 'Running', pause_requested: 'Pausing…', paused: 'Paused', stop_requested: 'Stopping after the current page…' }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <AntiGravityTopBar crumbs={[
        { label: 'AntiGravity', to: '/antigravity' },
        { label: title, to: `/antigravity/series/${seriesId}` },
        { label: `Part ${part}`, to: `/antigravity/series/${seriesId}/parts/${part}` },
        { label: 'Image Clipper' }
      ]} />
      <header>
        <h1 className="text-2xl font-semibold">Image Clipper · {title} · Part {part}</h1>
        <p className="text-sm text-muted-foreground">Chapters {first}–{last}. Pointer status is Image Clipper 3.0's own; AI results arrive as candidates and still need human review and Crop Sections.</p>
      </header>

      {/* Controls: one process at a time; ticked pages run alone or join this part's process */}
      <section className="sticky top-0 z-10 space-y-3 rounded-lg border bg-background/95 p-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          {processHere && process ? (
            <>
              <Badge variant={process.control === 'paused' ? 'warning' : 'secondary'}>
                {['running', 'preparing'].includes(process.control) && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{stateLabel[process.control] ?? process.control}
              </Badge>
              <span className="text-sm">
                {processing} page{processing === 1 ? '' : 's'} processing · {ENGINE_LABELS[process.engine ?? 'antigravity']} · {process.model}
              </span>
              <Button asChild variant="ghost" size="sm"><Link to="/antigravity/runs"><Activity className="mr-1.5 h-4 w-4" /> View in Running processes</Link></Button>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">
              {partCounts.done}/{partCounts.total} pages done · {partCounts.pending} pending{partCounts.waiting ? ` · ${partCounts.waiting} need you` : ''}
            </span>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" disabled={fetching || chapters.length === 0} onClick={() => void fetchResults()} title="Read the pages phones (and AntiGravity) finished for this part from R2 shared/crops and import missing geometry here (1 R2 list + 1 read per new page). Saved pointers are never replaced.">
              {fetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <DownloadCloud className="mr-2 h-4 w-4" />} Fetch finished pages
            </Button>
            {selectedPages.length > 0 && (
              <>
                {!process && (
                  <Button variant="outline" size="sm" disabled={busy || !readiness.drive?.account} title={readiness.drive?.account ? 'Slice the ticked pages and upload them to Drive now; no AI turn runs' : 'Connect Google Drive in Settings → AntiGravity'} onClick={() => void startSelected(true)}>
                    <UploadCloud className="mr-2 h-4 w-4" /> Upload to Drive
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={busy || processElsewhere || (!processHere && readiness.startBlockers.length > 0) || process?.control === 'stop_requested' || (processHere && process?.control === 'preparing')}
                  title={processElsewhere ? 'Another process is running. One process at a time.' : processHere ? 'Queue the ticked pages in the running process (its engine and model)' : readiness.startBlockers.join('\n') || `Process only the ticked pages, ${readiness.concurrency} at a time`}
                  onClick={() => void startSelected(false)}
                >
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />} {processHere ? `Add ${selectedPages.length} to process` : `Start ${selectedPages.length} selected`}
                </Button>
              </>
            )}
            {processHere && process ? (
              <>
                {['running', 'preparing'].includes(process.control) && <Button variant="outline" size="sm" disabled={busy} onClick={() => void controlProcess('pause')} title="No new pages start; pages in progress finish"><Pause className="mr-2 h-4 w-4" /> Pause</Button>}
                {['paused', 'pause_requested'].includes(process.control) && <Button variant="outline" size="sm" disabled={busy} onClick={() => void controlProcess('resume')}><Play className="mr-2 h-4 w-4" /> Resume</Button>}
                {process.control !== 'stop_requested' && <Button variant="destructive" size="sm" disabled={busy} onClick={() => void controlProcess('stop')} title="No new pages start; the page in progress finishes and saves, then the process stops"><Square className="mr-2 h-4 w-4" /> Stop</Button>}
                {process.control === 'stop_requested' && <Button variant="outline" size="sm" disabled={busy} onClick={() => void controlProcess('resume')} title="Take back the stop; the process carries on"><Play className="mr-2 h-4 w-4" /> Keep running</Button>}
                {process.control === 'stop_requested' && <Button variant="destructive" size="sm" disabled={busy} onClick={() => void controlProcess('stop-now')} title="Cancel the page in progress now; it cannot save a late result"><Square className="mr-2 h-4 w-4" /> Stop now</Button>}
              </>
            ) : (
              <Button
                size="sm"
                variant={selectedPages.length > 0 ? 'outline' : 'default'}
                disabled={busy || processElsewhere || chapters.length === 0 || readiness.startBlockers.length > 0}
                title={processElsewhere ? 'Another process is running. One process at a time.' : readiness.startBlockers.join('\n') || `Process this part's pending pages in chapter order, ${readiness.concurrency} at a time`}
                onClick={() => void startProcess()}
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />} Start process
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {selectedPages.length > 0 ? (
            <>
              <span className="font-medium text-foreground">{selectedPages.length} page{selectedPages.length === 1 ? '' : 's'} ticked</span>
              <span>in {new Set(selectedPages.map(p => p.chapterId)).size} chapter{new Set(selectedPages.map(p => p.chapterId)).size === 1 ? '' : 's'}</span>
              <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => { setSelected(new Set()); lastTick.current = null }}><X className="mr-1 h-3 w-3" /> Clear</Button>
            </>
          ) : (
            <span>Tick chapters or pages to process only those (Shift-click ticks a range), or Start process for the whole part.</span>
          )}
        </div>
        {processElsewhere && process && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {process.kind === 'metadata' ? 'A Metadata process' : process.kind === 'editor' ? 'A Timeline process' : process.kind === 'narration' ? 'A Narration process' : 'A process'} is {process.control === 'paused' ? 'paused' : 'running'} on {process.seriesId === seriesId && process.partNumber === part ? 'this part' : `another part (Part ${process.partNumber})`}. One process at a time: let it finish or stop it first.
            <Link to="/antigravity/runs" className="underline">Open Running processes</Link>
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          Destination: {readiness.drive?.account ? `${readiness.drive.account.email} → My Drive / Manhwa Studio / ${title} / Chapters` : 'no Google Drive connected'} · Engine: {readiness.engineLabel} · Model: {readiness.modelLabel ?? 'none'}{readiness.effort ? ` (${readiness.effort})` : ''} · Parallel pages: {readiness.concurrency} · Change them in Settings → AntiGravity
        </div>
        {readiness.startBlockers.length > 0 && (
          <ul className="space-y-1 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs">
            {readiness.startBlockers.map(b => <li key={b} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {b}</li>)}
          </ul>
        )}
      </section>

      {scope.loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading chapters…</div>}
      {scope.error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{scope.error}</div>}
      {!scope.loading && chapters.length === 0 && <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">No downloaded chapters in this part.</div>}

      <div className="space-y-2">
        {chapters.map(chapter => {
          const summary = scope.summaries.get(chapter.id)
          const list = pages[chapter.id]
          const loaded = list && list !== 'loading' && !('error' in list) ? list : null
          const counts = chapterCounts(chapter.id, summary, jobs)
          const isOpen = open.has(chapter.id)
          return (
            <div key={chapter.id} className={cn('rounded-lg border', counts.processing > 0 && 'border-primary/60')}>
              <div className="flex flex-wrap items-center gap-3 px-3 py-2">
                {(() => {
                  const canTick = loaded ? tickable(chapter.id, loaded.images) : null
                  const ticked = canTick ? canTick.filter(img => selected.has(key(chapter.id, img.filename))).length : 0
                  const state: boolean | 'indeterminate' = canTick && ticked > 0 ? (ticked === canTick.length ? true : 'indeterminate') : false
                  return (
                    <Checkbox
                      checked={state}
                      disabled={busy || list === 'loading' || (!!canTick && canTick.length === 0)}
                      onCheckedChange={() => void tickChapter(chapter.id, state === false)}
                      aria-label={`Tick every pending page of ${chapterLabel(chapter)}`}
                      title={canTick && canTick.length === 0 ? 'Nothing to tick: every page is done, managed, too wide or processing now' : state === true ? 'Untick this chapter' : 'Tick every pending page of this chapter'}
                    />
                  )
                })()}
                <button type="button" className="flex flex-1 items-center gap-2 text-left" onClick={() => toggleOpen(chapter.id)} aria-expanded={isOpen}>
                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  <span className="font-medium">{chapterLabel(chapter)}</span>
                  <span className="text-xs text-muted-foreground">{summary?.totalImages ?? chapter.pageCount} pages</span>
                </button>
                <ChapterFacts summary={summary} counts={counts} />
                <Button asChild variant="ghost" size="sm"><Link to={`/antigravity/series/${seriesId}/parts/${part}/chapters/${chapter.id}`} title="All pages with their crops; mark the chapter reviewed and Crop Sections here"><Eye className="mr-1.5 h-4 w-4" /> Preview</Link></Button>
              </div>
              {isOpen && (
                <div className="border-t">
                  {list === 'loading' && <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading pages…</div>}
                  {list && list !== 'loading' && 'error' in list && <div className="px-4 py-3 text-sm text-destructive">{list.error}</div>}
                  {loaded && (
                    <table className="w-full text-sm">
                      <thead className="text-xs text-muted-foreground">
                        <tr className="text-left">
                          <th className="w-8 py-1.5 pl-3" />
                          <th className="px-2 py-1.5">Page</th>
                          <th className="px-2 py-1.5">Clipper pointers</th>
                          <th className="px-2 py-1.5">AntiGravity job</th>
                          <th className="px-2 py-1.5" title="Analysis + review by the AI. Slicing and the Drive upload are not counted.">AI time</th>
                          <th className="px-2 py-1.5">Size</th>
                          <th className="w-10 px-2 py-1.5" />
                        </tr>
                      </thead>
                      <tbody>
                        {loaded.images.map((image, index) => {
                          const k = key(chapter.id, image.filename)
                          const job = jobs.get(k)
                          const reason = ineligibleReason(image, job)
                          const blocked = selectBlockReason(image, job)
                          const ticked = !blocked && selected.has(k)
                          return (
                            <tr key={image.filename} className={cn('border-t', job && ACTIVE_JOB.has(job.stage) && 'bg-primary/5', ticked && 'bg-primary/10')}>
                              <td className="py-1.5 pl-3">
                                <Checkbox
                                  checked={ticked}
                                  disabled={!!blocked || busy}
                                  onClick={e => { e.preventDefault(); tickPage(chapter.id, loaded.images, index, e.shiftKey) }}
                                  aria-label={`Tick ${image.filename}`}
                                  title={blocked ?? 'Tick this page (Shift-click ticks a range)'}
                                />
                              </td>
                              <td className="px-2 py-1.5">
                                <div className="flex items-center gap-2">
                                  <button type="button" onClick={() => setPreview({ chapterId: chapter.id, index })} title="Preview" className="shrink-0">
                                    <img src={clipper3Api.getImageUrl(chapter.id, image.filename)} alt="" loading="lazy" className="h-12 w-9 rounded border object-cover object-top" />
                                  </button>
                                  <div>
                                    <div className="font-mono text-xs">{image.filename}</div>
                                    <div className="text-xs text-muted-foreground">#{index + 1}{reason && image.status !== 'done' ? ` · ${reason}` : ''}</div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-2 py-1.5"><div className="flex items-center gap-1.5"><PointerBadge image={image} />{image.managed && <Badge variant="secondary">Managed</Badge>}{image.cropCount > 0 && <span className="text-xs text-muted-foreground">{image.cropCount} crops</span>}</div></td>
                              <td className="px-2 py-1.5">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <JobBadge job={job} />
                                  {job && <Link to={`/antigravity/runs/${job.runId}`} className="text-xs text-muted-foreground underline">run</Link>}
                                  {job?.driveFolderId && <a href={`https://drive.google.com/drive/folders/${job.driveFolderId}`} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground" title="Open Drive folder"><ExternalLink className="h-3 w-3" /></a>}
                                  {job && RETRYABLE.has(job.stage) && <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" title={job.stage === 'rejected' ? 'Process this page again (new conversation, same Drive slices)' : undefined} onClick={() => void retry(job.id)}><RotateCcw className="mr-1 h-3 w-3" /> {job.stage === 'rejected' ? 'Process again' : 'Retry'}</Button>}
                                  {job && canReject(job) && <RejectJobButton job={job} compact onChanged={() => refreshAll.current()} />}
                                </div>
                                {job?.lastError && <div className="mt-0.5 max-w-xs text-xs text-muted-foreground">{job.lastError}</div>}
                              </td>
                              <td className="px-2 py-1.5"><AiTime job={job} now={now} /></td>
                              <td className="px-2 py-1.5 text-xs text-muted-foreground">{image.width}×{image.height}</td>
                              <td className="px-2 py-1.5">
                                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Preview this page and its crops" aria-label={`Preview ${image.filename}`} onClick={() => setPreview({ chapterId: chapter.id, index })}><Eye className="h-4 w-4" /></Button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {(() => {
        const list = preview ? pages[preview.chapterId] : null
        const images = list && list !== 'loading' && !('error' in list) ? list.images : []
        return (
          <PagePreviewDialog
            chapterId={preview?.chapterId ?? ''}
            images={images}
            index={preview && images.length ? preview.index : null}
            onIndex={index => setPreview(p => p && { ...p, index })}
            onClose={() => setPreview(null)}
          />
        )
      })()}
    </div>
  )
}
