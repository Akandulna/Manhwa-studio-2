/**
 * AntiGravity → Metadata for one part: crop descriptions + English-script links for chapters that are
 * human-reviewed and cut (Crop Sections), with an English script. A separate process from Image Clipper,
 * one conversation per page; the result is the same Metadata a phone makes, saved in Studio only (no Drive,
 * no R2). Page status is Studio's own Metadata status (POST /antigravity/metadata/status), so Metadata made
 * by a phone or by hand shows Saved here too.
 *
 * Like Image Clipper: Start process takes the part's next page without valid Metadata, in chapter order;
 * ticked pages run alone or join this part's Metadata process. One AntiGravity process at a time.
 *
 * Recreate: with "Include saved pages" on, pages that already have Metadata can be ticked too. They are made
 * again; the new Metadata replaces the old one in Studio (old file kept in .metadata-resets/), on R2 and on the
 * phones (new job revision, so each phone drops its old result and takes Studio's on its next sync).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { Activity, AlertTriangle, ChevronDown, ChevronRight, Eye, Loader2, MessageSquareMore, Pause, Play, RefreshCw, RotateCcw, Square, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { antigravityJobsApi, clipper3Api, ENGINE_LABELS, type AntigravityJobView, type Clipper3Chapter, type MetadataChapterStatus } from '@/lib/api'
import { useSocket } from '@/lib/socket'
import { useToast } from '@/components/ui/use-toast'
import { clipperPartNumber } from '@/lib/clipperParts'
import { cn } from '@/lib/utils'
import { AntiGravityTopBar, chapterLabel, partRange, useCurrentProcess, useReadiness, useSeriesScope, useTicker } from './shared'
import { ACTIVE_JOB, AiTime, JobBadge, RETRYABLE, WAITS_FOR_YOU } from './AntiGravityClipper'

const key = (chapterId: string, filename: string) => `${chapterId}|${filename}`
type MetadataPage = MetadataChapterStatus['pages'][number]

/** Studio's Metadata status reasons, with raw file errors put in words. */
export function friendlyReason(reason: string | undefined | null): string | undefined {
  if (!reason) return undefined
  if (reason.includes('.metadata-cut-receipt.json')) return 'Not cut yet: run Crop Sections in Preview'
  if (/ENOENT[^]*script\.md/.test(reason)) return 'No English script yet'
  return reason
}

/** Why a page can't be ticked (or Start process won't take it), or null. */
export function metadataBlockReason(chapter: MetadataChapterStatus | undefined, page: MetadataPage, job?: AntigravityJobView | null, includeSaved = false): string | null {
  if (job && ACTIVE_JOB.has(job.stage)) return 'Processing now'
  if (!chapter?.ready) return friendlyReason(chapter?.reason) ?? 'Chapter not ready for Metadata'
  if (page.state === 'complete' && !includeSaved) return 'Metadata saved (turn on "Include saved pages" to recreate it)'
  return null
}

function MetadataBadge({ page }: { page: MetadataPage }) {
  if (page.state === 'complete') return <Badge variant="success">Saved</Badge>
  if (page.state === 'invalid') return <Badge variant="warning" title={page.reason}>Out of date</Badge>
  return <Badge variant="outline">Pending</Badge>
}

/** Ready = reviewed + cut + script; otherwise Studio's own reason (review, cut, script, managed…). */
function ChapterFacts({ status, processing, waiting }: { status?: MetadataChapterStatus; processing: number; waiting: number }) {
  if (!status) return <span className="text-xs text-muted-foreground">Reading…</span>
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <Badge variant={status.state === 'complete' ? 'success' : 'outline'} title="Pages with Metadata valid for the current cut and English script (by AntiGravity, a phone or by hand)">Saved {status.done}/{status.total}</Badge>
      {processing > 0 && <Badge variant="secondary"><Loader2 className="mr-1 h-3 w-3 animate-spin" />Processing {processing}</Badge>}
      {waiting > 0 && <Badge variant="warning" title="Failed or needs attention: open the chapter and Retry or Continue">Needs you {waiting}</Badge>}
      {status.state !== 'complete' && (status.ready
        ? <Badge variant="secondary" title="Reviewed, cut and has an English script">Ready</Badge>
        : <Badge variant="outline" title={status.reason}>{friendlyReason(status.reason) ?? 'Not ready'}</Badge>)}
    </div>
  )
}

export default function AntiGravityMetadata() {
  const { seriesId, partNumber } = useParams()
  const part = Number(partNumber)
  const scope = useSeriesScope(seriesId)
  const readiness = useReadiness()
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<Map<string, MetadataChapterStatus>>(new Map())
  const [statusError, setStatusError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<Map<string, AntigravityJobView>>(new Map())
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [includeSaved, setIncludeSaved] = useState(false)
  const lastTick = useRef<{ chapterId: string; index: number } | null>(null)
  const { current, reload: reloadProcess } = useCurrentProcess()
  const { socket } = useSocket()
  const { toast } = useToast()

  const chapters: Clipper3Chapter[] = useMemo(() => scope.chapters.filter(c => clipperPartNumber(c.number) === part), [scope.chapters, part])

  const loadStatus = useCallback(async () => {
    if (!seriesId || !Number.isInteger(part) || part < 1) return
    try {
      const out = await antigravityJobsApi.metadataStatus(seriesId, part)
      setStatus(new Map(out.chapters.map(c => [c.id, c])))
      setStatusError(null)
    } catch (e) { setStatusError((e as Error).message) }
  }, [seriesId, part])
  const loadJobs = useCallback(async () => {
    if (chapters.length === 0) return
    try {
      const list = await antigravityJobsApi.pageJobs(chapters.map(c => c.id), 'metadata')
      setJobs(new Map(list.map(j => [key(j.chapterId, j.filename), j])))
    } catch { /* the column stays as it was */ }
  }, [chapters])
  useEffect(() => { void loadStatus() }, [loadStatus])
  useEffect(() => { void loadJobs() }, [loadJobs])

  const refreshAll = useRef(() => {})
  refreshAll.current = () => { void loadJobs(); void loadStatus(); reloadProcess() }
  useEffect(() => {
    if (!socket) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const onProgress = () => { if (!timer) timer = setTimeout(() => { timer = null; refreshAll.current() }, 1500) }
    socket.on('antigravity:progress', onProgress)
    return () => { socket.off('antigravity:progress', onProgress); if (timer) clearTimeout(timer) }
  }, [socket])

  const anyRunning = useMemo(() => [...jobs.values()].some(j => j.attempt?.status === 'active' && !j.attempt.finishedAt), [jobs])
  const now = useTicker(anyRunning)

  const tickable = (chapterId: string) => {
    const s = status.get(chapterId)
    return (s?.pages ?? []).filter(p => !metadataBlockReason(s, p, jobs.get(key(chapterId, p.filename)), includeSaved))
  }
  const selectedPages = useMemo(() => {
    const out: { chapterId: string; filename: string; saved: boolean }[] = []
    for (const chapter of chapters) for (const p of tickable(chapter.id)) if (selected.has(key(chapter.id, p.filename))) out.push({ chapterId: chapter.id, filename: p.filename, saved: p.state === 'complete' })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, chapters, status, jobs, includeSaved])
  const recreateCount = selectedPages.filter(p => p.saved).length

  const tickChapter = (chapterId: string, on: boolean) => {
    if (!on) { setSelected(prev => new Set([...prev].filter(k => !k.startsWith(`${chapterId}|`)))); return }
    const add = tickable(chapterId)
    if (add.length === 0) { toast({ title: 'Nothing to tick in this chapter', description: friendlyReason(status.get(chapterId)?.reason) ?? (includeSaved ? 'Every page is processing now.' : 'Every page has Metadata or is processing now. Turn on "Include saved pages" to recreate saved Metadata.') }); return }
    setSelected(prev => new Set([...prev, ...add.map(p => key(chapterId, p.filename))]))
  }
  const tickPage = (chapterId: string, pages: MetadataPage[], index: number, shift: boolean) => {
    const target = !selected.has(key(chapterId, pages[index].filename))
    const last = lastTick.current
    const range = shift && last?.chapterId === chapterId ? pages.slice(Math.min(last.index, index), Math.max(last.index, index) + 1) : [pages[index]]
    const allowed = new Set(tickable(chapterId).map(p => p.filename))
    setSelected(prev => {
      const next = new Set(prev)
      for (const p of range) if (allowed.has(p.filename)) target ? next.add(key(chapterId, p.filename)) : next.delete(key(chapterId, p.filename))
      return next
    })
    lastTick.current = { chapterId, index }
  }

  const process = current?.live ? current.run : null
  const processHere = !!process && process.seriesId === seriesId && process.partNumber === part && process.kind === 'metadata'
  const processElsewhere = !!process && !processHere
  const processing = useMemo(() => [...jobs.values()].filter(j => ACTIVE_JOB.has(j.stage)).length, [jobs])
  const blockers = readiness.metadataBlockers

  const title = scope.series?.title ?? 'Series'
  const engineLine = `Engine: ${readiness.engineLabel} · Model: ${readiness.modelLabel}${readiness.effort ? ` (${readiness.effort})` : ''}`

  const startProcess = async () => {
    const message = [
      `Start Metadata for ${title} · Part ${part}?`,
      `Studio takes the next page without Metadata in chapter order, ${readiness.concurrency} at a time, until none is left. Each page gets its own conversation: its approved crops go to the AI in batches of 8 with the chapter's English script.`,
      engineLine,
      'Only chapters that are human-reviewed, cut (Crop Sections) and have an English script are taken. Metadata is saved in Studio; failed pages wait for your Retry.'
    ].join('\n\n')
    if (!window.confirm(message)) return
    setBusy(true)
    try { await antigravityJobsApi.startNext(seriesId!, part, 'metadata'); reloadProcess(); void loadJobs() } catch (e) {
      toast({ title: 'Could not start', description: (e as Error).message, variant: 'destructive' })
    } finally { setBusy(false) }
  }

  const startSelected = async () => {
    const n = selectedPages.length
    if (n === 0) return
    const what = `${n} ticked page${n === 1 ? '' : 's'}`
    const recreateNote = recreateCount > 0
      ? `Recreate: ${recreateCount} of them already ${recreateCount === 1 ? 'has' : 'have'} Metadata. ${recreateCount === 1 ? 'It is' : 'They are'} made again and the new Metadata replaces the old in Studio (old file kept in .metadata-resets), on R2 and on the phones (they take it on their next sync). Editor packages are re-sent with it.`
      : ''
    const message = (processHere
      ? [`Add ${what} to the running Metadata process on Part ${part}?`, `They run on that process's engine and model (${process ? `${ENGINE_LABELS[process.engine ?? 'antigravity']} · ${process.model}` : ''}).`, recreateNote]
      : [`${recreateCount > 0 ? 'Make / recreate' : 'Make'} Metadata for ${what} of ${title} · Part ${part}?`, `One conversation per page, ${readiness.concurrency} at a time.`, engineLine, recreateNote]).filter(Boolean).join('\n\n')
    if (!window.confirm(message)) return
    setBusy(true)
    try {
      const out = await antigravityJobsApi.startPages(seriesId!, part, selectedPages.map(({ chapterId, filename }) => ({ chapterId, filename })), false, 'metadata', undefined, recreateCount > 0)
      const total = out.created.length + out.reused.length
      toast({
        title: total === 0 ? 'No ticked page could start' : `${total} page${total === 1 ? '' : 's'} ${processHere ? 'added to the process' : 'started'}`,
        description: [out.reused.length ? `${out.reused.length} already in progress` : '', out.skipped.length ? `${out.skipped.length} skipped: ${out.skipped.slice(0, 2).map(s => `${s.filename} (${s.reason})`).join(', ')}` : ''].filter(Boolean).join(' · ') || undefined,
        variant: total === 0 ? 'destructive' : undefined
      })
      if (total > 0) { setSelected(new Set()); lastTick.current = null }
      reloadProcess()
      void loadJobs()
    } catch (e) {
      toast({ title: 'Could not start', description: (e as Error).message, variant: 'destructive' })
    } finally { setBusy(false) }
  }

  const controlProcess = async (action: 'pause' | 'resume' | 'stop' | 'stop-now') => {
    if (!process) return
    if (action === 'stop' && !window.confirm('Stop this Metadata process? No new pages start; the page in progress finishes and saves first, then the process stops.')) return
    if (action === 'stop-now' && !window.confirm('Stop now? Pages in progress are cancelled and cannot save late results. Pages already saved stay.')) return
    setBusy(true)
    try { await antigravityJobsApi.control(process.id, action); reloadProcess(); void loadJobs() } catch (e) {
      toast({ title: 'AntiGravity', description: (e as Error).message, variant: 'destructive' })
    } finally { setBusy(false) }
  }

  const act = async (failure: string, fn: () => Promise<unknown>) => {
    try { await fn(); void loadJobs(); reloadProcess() } catch (e) { toast({ title: failure, description: (e as Error).message, variant: 'destructive' }) }
  }

  if (!Number.isInteger(part) || part < 1) return <Navigate to={`/antigravity/series/${seriesId}`} replace />
  const { first, last } = partRange(part)
  const totals = [...status.values()].reduce((acc, c) => ({ done: acc.done + c.done, total: acc.total + c.total, ready: acc.ready + (c.ready ? 1 : 0) }), { done: 0, total: 0, ready: 0 })
  const stateLabel: Record<string, string> = { running: 'Running', preparing: 'Running', pause_requested: 'Pausing…', paused: 'Paused', stop_requested: 'Stopping after the current page…' }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <AntiGravityTopBar crumbs={[
        { label: 'AntiGravity', to: '/antigravity' },
        { label: title, to: `/antigravity/series/${seriesId}` },
        { label: `Part ${part}`, to: `/antigravity/series/${seriesId}/parts/${part}` },
        { label: 'Metadata' }
      ]} />
      <header>
        <h1 className="text-2xl font-semibold">Metadata · {title} · Part {part}</h1>
        <p className="text-sm text-muted-foreground">Chapters {first}–{last}. Descriptions and English-script links for the approved crops of chapters that are human-reviewed, cut and have an English script. One conversation per page; saved in Studio, like a phone's Metadata.</p>
      </header>

      <section className="sticky top-0 z-10 space-y-3 rounded-lg border bg-background/95 p-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          {processHere && process ? (
            <>
              <Badge variant={process.control === 'paused' ? 'warning' : 'secondary'}>
                {process.control === 'running' && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{stateLabel[process.control] ?? process.control}
              </Badge>
              <span className="text-sm">{processing} page{processing === 1 ? '' : 's'} processing · {ENGINE_LABELS[process.engine ?? 'antigravity']} · {process.model}</span>
              <Button asChild variant="ghost" size="sm"><Link to="/antigravity/runs"><Activity className="mr-1.5 h-4 w-4" /> View in Running processes</Link></Button>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">{totals.done}/{totals.total} pages saved · {totals.ready} of {status.size} chapters ready</span>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            {selectedPages.length > 0 && (
              <Button
                size="sm"
                disabled={busy || processElsewhere || (!processHere && blockers.length > 0) || process?.control === 'stop_requested'}
                title={processElsewhere ? 'Another process is running. One process at a time.' : processHere ? 'Queue the ticked pages in the running Metadata process' : blockers.join('\n') || `Make Metadata for the ticked pages only, ${readiness.concurrency} at a time`}
                onClick={() => void startSelected()}
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : recreateCount > 0 ? <RefreshCw className="mr-2 h-4 w-4" /> : <Play className="mr-2 h-4 w-4" />} {processHere ? `Add ${selectedPages.length} to process` : `Start ${selectedPages.length} selected`}{recreateCount > 0 ? ` (${recreateCount} recreate)` : ''}
              </Button>
            )}
            {processHere && process ? (
              <>
                {process.control === 'running' && <Button variant="outline" size="sm" disabled={busy} onClick={() => void controlProcess('pause')} title="No new pages start; pages in progress finish"><Pause className="mr-2 h-4 w-4" /> Pause</Button>}
                {['paused', 'pause_requested'].includes(process.control) && <Button variant="outline" size="sm" disabled={busy} onClick={() => void controlProcess('resume')}><Play className="mr-2 h-4 w-4" /> Resume</Button>}
                {process.control !== 'stop_requested' && <Button variant="destructive" size="sm" disabled={busy} onClick={() => void controlProcess('stop')} title="No new pages start; the page in progress finishes and saves, then the process stops"><Square className="mr-2 h-4 w-4" /> Stop</Button>}
                {process.control === 'stop_requested' && <Button variant="outline" size="sm" disabled={busy} onClick={() => void controlProcess('resume')} title="Take back the stop; the process carries on"><Play className="mr-2 h-4 w-4" /> Keep running</Button>}
                {process.control === 'stop_requested' && <Button variant="destructive" size="sm" disabled={busy} onClick={() => void controlProcess('stop-now')} title="Cancel the page in progress now; it cannot save a late result"><Square className="mr-2 h-4 w-4" /> Stop now</Button>}
              </>
            ) : (
              <Button
                size="sm"
                variant={selectedPages.length > 0 ? 'outline' : 'default'}
                disabled={busy || processElsewhere || chapters.length === 0 || blockers.length > 0}
                title={processElsewhere ? 'Another process is running. One process at a time.' : blockers.join('\n') || `Make Metadata for this part's pages in chapter order, ${readiness.concurrency} at a time`}
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
              <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => { setSelected(new Set()); lastTick.current = null }}><X className="mr-1 h-3 w-3" /> Clear</Button>
            </>
          ) : (
            <span>Tick chapters or pages to process only those (Shift-click ticks a range), or Start process for the whole part.</span>
          )}
          <label className="ml-auto flex cursor-pointer items-center gap-1.5" title="Lets you tick pages that already have Metadata. They are made again and the new Metadata replaces the old one in Studio, on R2 and on the phones.">
            <Checkbox checked={includeSaved} disabled={busy} onCheckedChange={v => setIncludeSaved(v === true)} aria-label="Include saved pages (recreate their Metadata)" />
            <span className={cn(includeSaved && 'font-medium text-foreground')}>Include saved pages (recreate)</span>
          </label>
        </div>
        {processElsewhere && process && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {process.kind === 'metadata' ? 'A Metadata process' : process.kind === 'editor' ? 'A Timeline process' : process.kind === 'narration' ? 'A Narration process' : 'An Image Clipper process'} is {process.control === 'paused' ? 'paused' : 'running'} on {process.seriesId === seriesId && process.partNumber === part ? 'this part' : `another part (Part ${process.partNumber})`}. One process at a time: let it finish or stop it first.
            <Link to="/antigravity/runs" className="underline">Open Running processes</Link>
          </div>
        )}
        <div className="text-xs text-muted-foreground">{engineLine} · Parallel pages: {readiness.concurrency} · No Google Drive needed; R2 only for recreating saved pages · Change them in Settings → AntiGravity</div>
        {blockers.length > 0 && (
          <ul className="space-y-1 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs">
            {blockers.map(b => <li key={b} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {b}</li>)}
          </ul>
        )}
      </section>

      {scope.loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading chapters…</div>}
      {(scope.error || statusError) && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{scope.error ?? statusError}</div>}
      {!scope.loading && chapters.length === 0 && <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">No downloaded chapters in this part.</div>}

      <div className="space-y-2">
        {chapters.map(chapter => {
          const s = status.get(chapter.id)
          const chapterJobs = [...jobs.values()].filter(j => j.chapterId === chapter.id)
          const processingHere = chapterJobs.filter(j => ACTIVE_JOB.has(j.stage)).length
          const waiting = chapterJobs.filter(j => WAITS_FOR_YOU.has(j.stage)).length
          const canTick = tickable(chapter.id)
          const ticked = canTick.filter(p => selected.has(key(chapter.id, p.filename))).length
          const tickState: boolean | 'indeterminate' = ticked > 0 ? (ticked === canTick.length ? true : 'indeterminate') : false
          const isOpen = open.has(chapter.id)
          return (
            <div key={chapter.id} className={cn('rounded-lg border', processingHere > 0 && 'border-primary/60')}>
              <div className="flex flex-wrap items-center gap-3 px-3 py-2">
                <Checkbox
                  checked={tickState}
                  disabled={busy || !s || canTick.length === 0}
                  onCheckedChange={() => tickChapter(chapter.id, tickState === false)}
                  aria-label={includeSaved ? `Tick every page of ${chapterLabel(chapter)}` : `Tick every page of ${chapterLabel(chapter)} without Metadata`}
                  title={canTick.length === 0 ? (s?.ready ? (includeSaved ? 'Nothing to tick: every page is processing now' : 'Nothing to tick: every page has Metadata or is processing now') : friendlyReason(s?.reason) ?? 'Not ready') : tickState === true ? 'Untick this chapter' : includeSaved ? 'Tick every page (saved ones are recreated)' : 'Tick every page without Metadata'}
                />
                <button type="button" className="flex flex-1 items-center gap-2 text-left" onClick={() => setOpen(prev => { const next = new Set(prev); next.has(chapter.id) ? next.delete(chapter.id) : next.add(chapter.id); return next })} aria-expanded={isOpen}>
                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  <span className="font-medium">{chapterLabel(chapter)}</span>
                  <span className="text-xs text-muted-foreground">{s?.total ?? chapter.pageCount} pages</span>
                </button>
                <ChapterFacts status={s} processing={processingHere} waiting={waiting} />
                <Button asChild variant="ghost" size="sm"><Link to={`/antigravity/series/${seriesId}/parts/${part}/chapters/${chapter.id}`} title="All pages with their crops; mark the chapter reviewed and Crop Sections here"><Eye className="mr-1.5 h-4 w-4" /> Preview</Link></Button>
              </div>
              {isOpen && s && (
                <div className="border-t">
                  {s.pages.length === 0 && <div className="px-4 py-3 text-sm text-muted-foreground">{friendlyReason(s.reason) ?? 'No pages.'}</div>}
                  {s.pages.length > 0 && (
                    <table className="w-full text-sm">
                      <thead className="text-xs text-muted-foreground">
                        <tr className="text-left">
                          <th className="w-8 py-1.5 pl-3" />
                          <th className="px-2 py-1.5">Page</th>
                          <th className="px-2 py-1.5">Metadata</th>
                          <th className="px-2 py-1.5">AntiGravity job</th>
                          <th className="px-2 py-1.5" title="The page's Metadata conversation, all batches">AI time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.pages.map((page, index) => {
                          const k = key(chapter.id, page.filename)
                          const job = jobs.get(k)
                          const blocked = metadataBlockReason(s, page, job, includeSaved)
                          const isTicked = !blocked && selected.has(k)
                          const attempt = job?.attempt
                          return (
                            <tr key={page.filename} className={cn('border-t', job && ACTIVE_JOB.has(job.stage) && 'bg-primary/5', isTicked && 'bg-primary/10')}>
                              <td className="py-1.5 pl-3">
                                <Checkbox
                                  checked={isTicked}
                                  disabled={!!blocked || busy}
                                  onClick={e => { e.preventDefault(); tickPage(chapter.id, s.pages, index, e.shiftKey) }}
                                  aria-label={`Tick ${page.filename}`}
                                  title={blocked ?? 'Tick this page (Shift-click ticks a range)'}
                                />
                              </td>
                              <td className="px-2 py-1.5">
                                <div className="flex items-center gap-2">
                                  <img src={clipper3Api.getImageUrl(chapter.id, page.filename)} alt="" loading="lazy" className="h-12 w-9 shrink-0 rounded border object-cover object-top" />
                                  <div>
                                    <div className="font-mono text-xs">{page.filename}</div>
                                    <div className="text-xs text-muted-foreground">#{index + 1}{blocked && page.state !== 'complete' && blocked !== 'Processing now' && s.ready ? ` · ${blocked}` : ''}</div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-2 py-1.5">
                                <MetadataBadge page={page} />
                                {page.state === 'invalid' && page.reason && <div className="mt-0.5 max-w-xs text-xs text-muted-foreground">{page.reason}</div>}
                              </td>
                              <td className="px-2 py-1.5">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <JobBadge job={job} />
                                  {job && <Link to={`/antigravity/runs/${job.runId}`} className="text-xs text-muted-foreground underline">run</Link>}
                                  {job && RETRYABLE.has(job.stage) && <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" title="New attempt in a new conversation" onClick={() => void act('Retry failed', () => antigravityJobsApi.retry(job.id))}><RotateCcw className="mr-1 h-3 w-3" /> Retry</Button>}
                                  {job && ['needs_attention', 'interrupted'].includes(job.stage) && attempt?.conversationId && (
                                    <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" title={`Continue the remaining batches in conversation ${attempt.conversationId}`} onClick={() => void act('Continue failed', () => antigravityJobsApi.reviewAgain(job.id))}><MessageSquareMore className="mr-1 h-3 w-3" /> Continue</Button>
                                  )}
                                </div>
                                {job?.lastError && <div className="mt-0.5 max-w-xs text-xs text-muted-foreground">{job.lastError}</div>}
                              </td>
                              <td className="px-2 py-1.5"><AiTime job={job} now={now} /></td>
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
    </div>
  )
}
