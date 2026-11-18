/**
 * AntiGravity → Narration scripts for one part: each chapter's English script, written on this Mac from its pages
 * (docs/narration-page-order-fix.md). Pages are cut into pieces agy shows at full size (at most 2,000 px a side),
 * each with a label band ("P0003-T002 · CHECK K7QM") so the notes are matched to pieces by the code read off each
 * band, never by upload order. Notes go one batch per conversation; the draft, review and final check share one conversation.
 *
 * Start process writes the chapters that have no script, in chapter order, one at a time (each continues from the
 * previous chapter's summary). Ticking a chapter that has a script rewrites it: the old script is backed up, the
 * chapter's English voiceover, alignment and timeline are reset, and the new script goes to the phones for voiceover.
 *
 * After each English script is saved, the chapter's Hinglish is written from it (job "narration-hi": one text-only
 * conversation — scene notes, narration, final check) and saved the same way. Start process also writes the Hinglish
 * of chapters that have an English script but no Hinglish.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { Activity, AlertTriangle, FileText, Loader2, MessageSquareMore, Pause, Play, RefreshCcw, RotateCcw, Square, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { antigravityJobsApi, ENGINE_LABELS, type AntigravityJobView, type NarrationChapterStatus } from '@/lib/api'
import { useSocket } from '@/lib/socket'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { AntiGravityTopBar, partRange, useCurrentProcess, useReadiness, useSeriesScope, useTicker } from './shared'
import { ACTIVE_JOB, AiTime, JobBadge, RETRYABLE, WAITS_FOR_YOU } from './AntiGravityClipper'

const FILE = 'narration-en'
const FILE_HI = 'narration-hi'
const key = (chapterId: string, file = FILE) => `${chapterId}|${file}`

/** Why a chapter can't be ticked, or null. */
function blockReason(chapter: NarrationChapterStatus, job?: AntigravityJobView | null, hinglishJob?: AntigravityJobView | null): string | null {
  if ((job && ACTIVE_JOB.has(job.stage)) || (hinglishJob && ACTIVE_JOB.has(hinglishJob.stage))) return 'Being written now'
  return chapter.blocked
}

function ScriptBadge({ chapter }: { chapter: NarrationChapterStatus }) {
  if (chapter.hasScript) return <Badge variant="success" title={chapter.script ? `Status: ${chapter.script.status} · ${chapter.script.mode}` : undefined}>Has script</Badge>
  if (chapter.blocked) return <Badge variant="outline" title={chapter.blocked}>Waiting</Badge>
  return <Badge variant="secondary">No script</Badge>
}

function HinglishBadge({ chapter }: { chapter: NarrationChapterStatus }) {
  const h = chapter.hinglish
  if (h.hasScript && h.stale) return <Badge variant="warning" title="Written from an older English script. Rewriting the English (tick the chapter) rewrites it too.">Has script · older English</Badge>
  if (h.hasScript) return <Badge variant="success">Has script</Badge>
  if (h.blocked) return <Badge variant="outline" title={h.blocked}>Waiting</Badge>
  return <Badge variant="secondary">No script</Badge>
}

/** One script's AntiGravity job: its state, AI time, run link, last problem and Continue / Retry / Start over. */
function JobCell({ job, chapterNumber, hinglish, now, act }: {
  job?: AntigravityJobView; chapterNumber: number; hinglish: boolean; now: number
  act: (failure: string, fn: () => Promise<unknown>) => Promise<void>
}) {
  if (!job) return <span className="text-xs text-muted-foreground">—</span>
  const attempt = job.attempt
  const kept = hinglish ? 'the accepted scene notes and narration' : 'accepted notes, the draft and the review'
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <JobBadge job={job} />
        <AiTime job={job} now={now} />
        <Link to={`/antigravity/runs/${job.runId}`} className="text-xs text-muted-foreground underline">run</Link>
      </div>
      {job.lastError && (WAITS_FOR_YOU.has(job.stage) || job.stage === 'done') && <div className="max-w-sm text-xs text-muted-foreground">{job.lastError}</div>}
      <div className="flex flex-wrap items-center gap-1">
        {['needs_attention', 'interrupted', 'failed', 'cancelled'].includes(job.stage) && attempt && !(job.resultSha256 && job.importState !== 'imported') && (
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" title={`Continue this attempt in its own conversation${hinglish ? '' : 's'}: ${kept} are kept`} onClick={() => void act('Continue failed', () => antigravityJobsApi.reviewAgain(job.id))}><MessageSquareMore className="mr-1 h-3 w-3" /> Continue</Button>
        )}
        {RETRYABLE.has(job.stage) && <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" title={`New attempt in new conversations. ${kept[0].toUpperCase()}${kept.slice(1)} are kept when the ${hinglish ? 'English script hasn\'t' : 'pages and inputs haven\'t'} changed.`} onClick={() => void act('Retry failed', () => antigravityJobsApi.retry(job.id))}><RotateCcw className="mr-1 h-3 w-3" /> Retry</Button>}
        {RETRYABLE.has(job.stage) && (
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" title={`Throw away ${kept} and start again`} onClick={() => { if (window.confirm(hinglish ? `Start Chapter ${chapterNumber}'s Hinglish over? The accepted scene notes and narration are not used.` : `Start Chapter ${chapterNumber} over? The accepted notes, draft and review are not used; every page is read again.`)) void act('Start over failed', () => antigravityJobsApi.retry(job.id, true)) }}><RefreshCcw className="mr-1 h-3 w-3" /> Start over</Button>
        )}
      </div>
    </div>
  )
}

export default function AntiGravityNarration() {
  const { seriesId, partNumber } = useParams()
  const part = Number(partNumber)
  const scope = useSeriesScope(seriesId)
  const readiness = useReadiness()
  const [status, setStatus] = useState<NarrationChapterStatus[] | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<Map<string, AntigravityJobView>>(new Map())
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const { current, reload: reloadProcess } = useCurrentProcess()
  const { socket } = useSocket()
  const { toast } = useToast()

  const loadStatus = useCallback(async () => {
    if (!seriesId || !Number.isInteger(part) || part < 1) return
    try {
      setStatus((await antigravityJobsApi.narrationStatus(seriesId, part)).chapters)
      setStatusError(null)
    } catch (e) { setStatusError((e as Error).message) }
  }, [seriesId, part])
  const chapterIds = useMemo(() => (status ?? []).map(c => c.id), [status])
  const loadJobs = useCallback(async () => {
    if (chapterIds.length === 0) return
    try {
      const list = await antigravityJobsApi.pageJobs(chapterIds, 'narration')
      setJobs(new Map(list.map(j => [`${j.chapterId}|${j.filename}`, j])))
    } catch { /* the column stays as it was */ }
  }, [chapterIds])
  useEffect(() => { void loadStatus() }, [loadStatus])
  useEffect(() => { void loadJobs() }, [loadJobs])

  useEffect(() => {
    if (!socket) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = () => { void loadJobs(); void loadStatus(); reloadProcess() }
    const onProgress = () => { if (!timer) timer = setTimeout(() => { timer = null; refresh() }, 1500) }
    socket.on('antigravity:progress', onProgress)
    return () => { socket.off('antigravity:progress', onProgress); if (timer) clearTimeout(timer) }
  }, [socket, loadJobs, loadStatus, reloadProcess])

  const anyRunning = useMemo(() => [...jobs.values()].some(j => j.attempt?.status === 'active' && !j.attempt.finishedAt), [jobs])
  const now = useTicker(anyRunning)

  const ticked = useMemo(() => (status ?? []).filter(c => selected.has(c.id) && !blockReason(c, jobs.get(key(c.id)), jobs.get(key(c.id, FILE_HI)))), [selected, status, jobs])
  const toggle = (chapterId: string) => setSelected(prev => {
    const next = new Set(prev)
    next.has(chapterId) ? next.delete(chapterId) : next.add(chapterId)
    return next
  })

  const process = current?.live ? current.run : null
  const processHere = !!process && process.seriesId === seriesId && process.partNumber === part && process.kind === 'narration'
  const processElsewhere = !!process && !processHere
  const writing = useMemo(() => [...jobs.values()].filter(j => ACTIVE_JOB.has(j.stage)).length, [jobs])
  // Same rule as Metadata: the engine must be ready and the model must see images. No Google Drive.
  // Narration is written with Antigravity (agy) or ChatGPT (Codex) (server NARRATION_ENGINES); not Claude.
  const blockers = [
    ...(readiness.engine !== 'antigravity' && readiness.engine !== 'codex' ? [`Narration scripts are written with Antigravity or ChatGPT (Codex) only, and ${readiness.engineLabel} is selected. Choose one of those in Settings → AntiGravity → AI engine.`] : []),
    ...readiness.metadataBlockers
  ]
  const title = scope.series?.title ?? 'Series'
  const notesConcurrency = processHere ? process?.concurrency ?? readiness.concurrency : readiness.concurrency
  const engineLine = `Engine: ${readiness.engineLabel} · Model: ${readiness.modelLabel}${readiness.effort ? ` (${readiness.effort})` : ''}`
  const HOW = 'Each page is cut at blank gaps into pieces of at most 2,000 px (agy shrinks anything larger, which would make speech bubbles unreadable), each with an ID and check code to keep notes in page order. Notes go ten pieces per conversation, with up to the selected parallel limit running at once. Studio merges accepted notes in page order before a draft, an image review and a final spoken-narration check. Once the English script is saved, the chapter\'s Hinglish is written from it in one text-only conversation (scene notes, narration, final check) and saved the same way.'

  const startProcess = async () => {
    const message = [
      `Write the missing English and Hinglish scripts of ${title} · Part ${part}?`,
      HOW,
      'Scripts that already exist are left alone; tick a chapter to rewrite it. Chapters go one at a time, in chapter order: each chapter\'s English (it continues from the previous chapter\'s summary), then its Hinglish. Chapters that have an English script but no Hinglish get only the Hinglish.',
      engineLine,
      'Each script is saved like Replace in Narration and sent to the phones for voiceover.'
    ].join('\n\n')
    if (!window.confirm(message)) return
    setBusy(true)
    try { await antigravityJobsApi.startNext(seriesId!, part, 'narration'); reloadProcess(); void loadJobs() } catch (e) {
      toast({ title: 'Could not start', description: (e as Error).message, variant: 'destructive' })
    } finally { setBusy(false) }
  }

  const startSelected = async () => {
    if (ticked.length === 0) return
    const rewrites = ticked.filter(c => c.hasScript)
    const message = [
      processHere ? `Add ${ticked.length} chapter${ticked.length === 1 ? '' : 's'} to the running Narration process?` : `Write ${ticked.length} ticked chapter${ticked.length === 1 ? '' : 's'} of ${title} · Part ${part}?`,
      rewrites.length
        ? `REWRITE: Chapter ${rewrites.map(c => c.number).join(', ')} already ${rewrites.length === 1 ? 'has a script' : 'have scripts'}. When the new script is saved, the current one is backed up and replaced, and that chapter's English voiceover, alignment and Editor timeline are reset. The new script goes to the phones for a new voiceover. Its Hinglish is then rewritten from the new English the same way (backed up; Hindi voiceover, alignment and timeline reset). Other chapters are not changed.`
        : null,
      HOW,
      processHere ? null : engineLine
    ].filter(Boolean).join('\n\n')
    if (!window.confirm(message)) return
    setBusy(true)
    try {
      const out = await antigravityJobsApi.startPages(seriesId!, part, ticked.map(c => ({ chapterId: c.id, filename: FILE })), false, 'narration')
      const total = out.created.length + out.reused.length
      toast({
        title: total === 0 ? 'No ticked chapter could start' : `${total} chapter${total === 1 ? '' : 's'} ${processHere ? 'added to the process' : 'started'}`,
        description: [out.reused.length ? `${out.reused.length} already in progress` : '', out.skipped.length ? `${out.skipped.length} skipped: ${out.skipped.slice(0, 2).map(s => s.reason).join(' · ')}` : ''].filter(Boolean).join(' · ') || undefined,
        variant: total === 0 ? 'destructive' : undefined
      })
      if (total > 0) setSelected(new Set())
      reloadProcess()
      void loadJobs()
    } catch (e) {
      toast({ title: 'Could not start', description: (e as Error).message, variant: 'destructive' })
    } finally { setBusy(false) }
  }

  const controlProcess = async (action: 'pause' | 'resume' | 'stop' | 'stop-now') => {
    if (!process) return
    if (action === 'stop' && !window.confirm('Stop this Narration process? No new chapters start; the chapter in progress finishes and saves first, then the process stops.')) return
    if (action === 'stop-now' && !window.confirm('Stop now? The chapter in progress is cancelled and cannot save a late result. Saved scripts stay.')) return
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
  const stateLabel: Record<string, string> = { running: 'Running', preparing: 'Running', pause_requested: 'Pausing…', paused: 'Paused', stop_requested: 'Stopping after the current chapter…' }
  const withScript = (status ?? []).filter(c => c.hasScript).length
  const withHinglish = (status ?? []).filter(c => c.hinglish.hasScript).length

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <AntiGravityTopBar crumbs={[
        { label: 'AntiGravity', to: '/antigravity' },
        { label: title, to: `/antigravity/series/${seriesId}` },
        { label: `Part ${part}`, to: `/antigravity/series/${seriesId}/parts/${part}` },
        { label: 'Narration scripts' }
      ]} />
      <header>
        <h1 className="text-2xl font-semibold">Narration scripts · {title} · Part {part}</h1>
        <p className="text-sm text-muted-foreground">Chapters {first}–{last}. Each chapter's English script, written on this Mac from its pages (no Google Drive), then its Hinglish script, written from the English. Both are saved like Replace in Narration, then sent to the phones for voiceover.</p>
      </header>

      <section className="sticky top-0 z-10 space-y-3 rounded-lg border bg-background/95 p-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          {processHere && process ? (
            <>
              <Badge variant={process.control === 'paused' ? 'warning' : 'secondary'}>
                {process.control === 'running' && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{stateLabel[process.control] ?? process.control}
              </Badge>
              <span className="text-sm">{writing} chapter{writing === 1 ? '' : 's'} in progress · up to {notesConcurrency} notes conversation{notesConcurrency === 1 ? '' : 's'} at once · {ENGINE_LABELS[process.engine ?? 'antigravity']} · {process.model}</span>
              <Button asChild variant="ghost" size="sm"><Link to="/antigravity/runs"><Activity className="mr-1.5 h-4 w-4" /> View in Running processes</Link></Button>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">English: {withScript} of {(status ?? []).length} · Hinglish: {withHinglish} of {(status ?? []).length}</span>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            {ticked.length > 0 && (
              <Button
                size="sm"
                disabled={busy || processElsewhere || (!processHere && blockers.length > 0) || process?.control === 'stop_requested'}
                title={processElsewhere ? 'Another process is running. One process at a time.' : blockers.join('\n') || 'Write (or rewrite) the ticked chapters, in chapter order'}
                onClick={() => void startSelected()}
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                {processHere ? `Add ${ticked.length} to process` : `${ticked.some(c => c.hasScript) ? 'Rewrite' : 'Write'} ${ticked.length} selected`}
              </Button>
            )}
            {processHere && process ? (
              <>
                {process.control === 'running' && <Button variant="outline" size="sm" disabled={busy} onClick={() => void controlProcess('pause')} title="No new chapters start; the chapter in progress finishes"><Pause className="mr-2 h-4 w-4" /> Pause</Button>}
                {['paused', 'pause_requested'].includes(process.control) && <Button variant="outline" size="sm" disabled={busy} onClick={() => void controlProcess('resume')}><Play className="mr-2 h-4 w-4" /> Resume</Button>}
                {process.control !== 'stop_requested' && <Button variant="destructive" size="sm" disabled={busy} onClick={() => void controlProcess('stop')} title="No new chapters start; the chapter in progress finishes and saves, then the process stops"><Square className="mr-2 h-4 w-4" /> Stop</Button>}
                {process.control === 'stop_requested' && <Button variant="outline" size="sm" disabled={busy} onClick={() => void controlProcess('resume')} title="Take back the stop; the process carries on"><Play className="mr-2 h-4 w-4" /> Keep running</Button>}
                {process.control === 'stop_requested' && <Button variant="destructive" size="sm" disabled={busy} onClick={() => void controlProcess('stop-now')} title="Cancel the chapter in progress now; it cannot save a late result"><Square className="mr-2 h-4 w-4" /> Stop now</Button>}
              </>
            ) : (
              <Button
                size="sm"
                variant={ticked.length > 0 ? 'outline' : 'default'}
                disabled={busy || processElsewhere || !status?.length || blockers.length > 0}
                title={processElsewhere ? 'Another process is running. One process at a time.' : blockers.join('\n') || 'Write this part\'s missing scripts in chapter order'}
                onClick={() => void startProcess()}
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />} Start process
              </Button>
            )}
          </div>
        </div>
        {ticked.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">{ticked.length} ticked</span>
            {ticked.some(c => c.hasScript) && <span className="text-muted-foreground">· a ticked chapter with a script is rewritten (backed up; its English voiceover, alignment and timeline are reset), then its Hinglish from the new English</span>}
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => setSelected(new Set())}><X className="mr-1 h-3 w-3" /> Clear</Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{HOW}</p>
        {processElsewhere && process && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {process.kind === 'metadata' ? 'A Metadata process' : process.kind === 'editor' ? 'A Timeline process' : process.kind === 'narration' ? 'A Narration process' : 'An Image Clipper process'} is {process.control === 'paused' ? 'paused' : 'running'} on {process.seriesId === seriesId && process.partNumber === part ? 'this part' : `another part (Part ${process.partNumber})`}. One process at a time: let it finish or stop it first.
            <Link to="/antigravity/runs" className="underline">Open Running processes</Link>
          </div>
        )}
        <div className="text-xs text-muted-foreground">{engineLine} · One chapter at a time · No Google Drive needed · Change them in Settings → AntiGravity</div>
        {blockers.length > 0 && (
          <ul className="space-y-1 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs">
            {blockers.map(b => <li key={b} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {b}</li>)}
          </ul>
        )}
      </section>

      {(scope.error || statusError) && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{scope.error ?? statusError}</div>}
      {!status && !statusError && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Reading the chapters…</div>}
      {status && status.length === 0 && <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">No chapters in this part.</div>}

      {status && status.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="text-left">
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2">Chapter</th>
                <th className="px-3 py-2">English script</th>
                <th className="px-3 py-2">Hinglish script</th>
              </tr>
            </thead>
            <tbody>
              {status.map(chapter => {
                const job = jobs.get(key(chapter.id))
                const hinglishJob = jobs.get(key(chapter.id, FILE_HI))
                const blocked = blockReason(chapter, job, hinglishJob)
                const isTicked = !blocked && selected.has(chapter.id)
                const active = (job && ACTIVE_JOB.has(job.stage)) || (hinglishJob && ACTIVE_JOB.has(hinglishJob.stage))
                return (
                  <tr key={chapter.id} className={cn('border-t align-top', active && 'bg-primary/5', isTicked && 'bg-primary/10')}>
                    <td className="px-3 py-2">
                      <Checkbox
                        checked={isTicked}
                        disabled={!!blocked || busy}
                        onCheckedChange={() => toggle(chapter.id)}
                        aria-label={`Tick Chapter ${chapter.number}`}
                        title={blocked ?? (chapter.hasScript ? 'Tick to rewrite this chapter\'s script (then its Hinglish)' : 'Tick to write this chapter\'s script (then its Hinglish)')}
                        className="mt-0.5"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">Chapter {chapter.number}{chapter.title ? ` · ${chapter.title}` : ''}</div>
                      <div className="text-xs text-muted-foreground">{chapter.pages ? `${chapter.pages} pages` : ''}</div>
                      {(chapter.hasScript || chapter.hinglish.hasScript) && <Link to={`/narration/series/${seriesId}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground underline"><FileText className="h-3 w-3" /> Open in Narration</Link>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="space-y-1">
                        <ScriptBadge chapter={chapter} />
                        {chapter.blocked && <div className="max-w-xs text-xs text-muted-foreground">{chapter.blocked}</div>}
                        <JobCell job={job} chapterNumber={chapter.number} hinglish={false} now={now} act={act} />
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="space-y-1">
                        <HinglishBadge chapter={chapter} />
                        {chapter.hinglish.blocked && chapter.hasScript && <div className="max-w-xs text-xs text-muted-foreground">{chapter.hinglish.blocked}</div>}
                        <JobCell job={hinglishJob} chapterNumber={chapter.number} hinglish now={now} act={act} />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
