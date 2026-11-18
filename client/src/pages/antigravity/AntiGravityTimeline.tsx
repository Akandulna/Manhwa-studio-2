/**
 * AntiGravity → Editor 2.0 timelines for one part: each chapter's timeline JSON, per language, made on this
 * Mac in one conversation per chapter and language. Two methods, chosen before Start (pinned to the process):
 *   One-shot      — the Editor 2.0 prompt from Settings with the chapter's Copy All text, checked like the phone.
 *   Small batches — Studio's staged batches (the same checkpoint as Editor 2.0's Staged timeline dialog).
 * A chapter is ready when Editor 2.0's checklist has its voiceover, alignment and cut crops + metadata; status
 * is Editor's own (POST /antigravity/editor/status), so a pasted or phone-made timeline shows Saved here too.
 * Saved timelines are unprocessed (Start Processing in Editor 2.0) and go to the phones through Editor's sending.
 *
 * Like Metadata: Start process takes the next chapter without a timeline, in chapter order; ticked chapter ×
 * language cells run alone or join this part's Timeline process. One AntiGravity process at a time.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { Activity, AlertTriangle, Clapperboard, Loader2, MessageSquareMore, Pause, Play, RotateCcw, Square, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { antigravityJobsApi, ENGINE_LABELS, type AntigravityEditorMethod, type AntigravityJobView, type EditorTimelineChapterStatus, type EditorTimelineLanguageStatus } from '@/lib/api'
import { withLang, type NarrationLanguage } from '@/lib/narrationLanguage'
import { useSocket } from '@/lib/socket'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { AntiGravityTopBar, partRange, useCurrentProcess, useReadiness, useSeriesScope, useTicker } from './shared'
import { ACTIVE_JOB, AiTime, JobBadge, RETRYABLE, WAITS_FOR_YOU } from './AntiGravityClipper'

const LANGUAGES: NarrationLanguage[] = ['en', 'hi']
const LANGUAGE_NAMES: Record<NarrationLanguage, string> = { en: 'English', hi: 'Hindi' }
const fileOf = (language: NarrationLanguage) => `timeline-${language}`
const key = (chapterId: string, language: NarrationLanguage) => `${chapterId}|${fileOf(language)}`

export const METHOD_LABELS: Record<AntigravityEditorMethod, string> = { oneshot: 'One-shot', batches: 'Small batches' }
const METHOD_HINTS: Record<AntigravityEditorMethod, string> = {
  oneshot: 'The Editor 2.0 prompt from Settings with the chapter’s Copy All text, in one message; the whole timeline comes back and is checked like the phone checks it (sections covered without gaps, real crop files, story links).',
  batches: 'Studio’s small batches (index → route → select → review → repair), one after another in the chapter’s conversation. Accepted batches are kept, so a stopped chapter continues where it was — the same progress as Editor 2.0’s Staged timeline dialog.'
}
type LanguageChoice = 'both' | NarrationLanguage
const languagesOf = (choice: LanguageChoice): NarrationLanguage[] => (choice === 'both' ? LANGUAGES : [choice])

/** Remembered on this computer: the method and languages Start uses next time. */
function useStoredChoice<T extends string>(name: string, fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try { const v = localStorage.getItem(name) as T | null; return v && allowed.includes(v) ? v : fallback } catch { return fallback }
  })
  return [value, (v: T) => { setValue(v); try { localStorage.setItem(name, v) } catch { /* convenience only */ } }]
}

/** Why a chapter × language cell can't be ticked (or Start process won't take it), or null. */
function blockReason(status: EditorTimelineLanguageStatus | undefined, job?: AntigravityJobView | null): string | null {
  if (job && ACTIVE_JOB.has(job.stage)) return 'Processing now'
  if (!status) return 'Reading…'
  if (status.saved) return 'Timeline saved'
  if (!status.ready) return `Not ready in Editor 2.0: ${status.missing.map(m => m.label).join(', ')}`
  return null
}

function TimelineBadge({ status }: { status?: EditorTimelineLanguageStatus }) {
  if (!status) return <span className="text-xs text-muted-foreground">Reading…</span>
  if (status.saved) return <Badge variant="success" title={status.model ? `Made by ${status.model}` : 'Pasted or made earlier'}>{status.processed ? 'Saved · processed' : 'Saved'}</Badge>
  if (status.ready) return <Badge variant="secondary" title="Voiceover, alignment and cut crops are in place">Ready</Badge>
  return <Badge variant="outline" title={status.missing.map(m => `${m.label}: ${m.detail}`).join('\n')}>Missing {status.missing.map(m => m.label).join(', ')}</Badge>
}

export default function AntiGravityTimeline() {
  const { seriesId, partNumber } = useParams()
  const part = Number(partNumber)
  const scope = useSeriesScope(seriesId)
  const readiness = useReadiness()
  const [status, setStatus] = useState<EditorTimelineChapterStatus[] | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<Map<string, AntigravityJobView>>(new Map())
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [method, setMethod] = useStoredChoice<AntigravityEditorMethod>('antigravity:timelineMethod', 'batches', ['oneshot', 'batches'])
  const [languageChoice, setLanguageChoice] = useStoredChoice<LanguageChoice>('antigravity:timelineLanguages', 'both', ['both', 'en', 'hi'])
  const { current, reload: reloadProcess } = useCurrentProcess()
  const { socket } = useSocket()
  const { toast } = useToast()

  const loadStatus = useCallback(async () => {
    if (!seriesId || !Number.isInteger(part) || part < 1) return
    try {
      setStatus((await antigravityJobsApi.editorStatus(seriesId, part)).chapters)
      setStatusError(null)
    } catch (e) { setStatusError((e as Error).message) }
  }, [seriesId, part])
  const chapterIds = useMemo(() => (status ?? []).map(c => c.id), [status])
  const loadJobs = useCallback(async () => {
    if (chapterIds.length === 0) return
    try {
      const list = await antigravityJobsApi.pageJobs(chapterIds, 'editor')
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

  const selectedCells = useMemo(() => {
    const out: { chapterId: string; filename: string }[] = []
    for (const c of status ?? []) for (const l of LANGUAGES) {
      if (selected.has(key(c.id, l)) && !blockReason(c.languages[l], jobs.get(key(c.id, l)))) out.push({ chapterId: c.id, filename: fileOf(l) })
    }
    return out
  }, [selected, status, jobs])

  const toggle = (chapterId: string, language: NarrationLanguage) => setSelected(prev => {
    const next = new Set(prev)
    next.has(key(chapterId, language)) ? next.delete(key(chapterId, language)) : next.add(key(chapterId, language))
    return next
  })
  /** Column header: tick every chapter of this language that can run now. */
  const tickColumn = (language: NarrationLanguage) => {
    const can = (status ?? []).filter(c => !blockReason(c.languages[language], jobs.get(key(c.id, language))))
    if (can.length === 0) { toast({ title: `No ${LANGUAGE_NAMES[language]} timeline can start`, description: 'Every chapter has a timeline, is processing now or is not ready in Editor 2.0.' }); return }
    const all = can.every(c => selected.has(key(c.id, language)))
    setSelected(prev => {
      const next = new Set(prev)
      for (const c of can) all ? next.delete(key(c.id, language)) : next.add(key(c.id, language))
      return next
    })
  }

  const process = current?.live ? current.run : null
  const processHere = !!process && process.seriesId === seriesId && process.partNumber === part && process.kind === 'editor'
  const processElsewhere = !!process && !processHere
  const processing = useMemo(() => [...jobs.values()].filter(j => ACTIVE_JOB.has(j.stage)).length, [jobs])
  const blockers = readiness.editorBlockers
  const options = { method, languages: languagesOf(languageChoice) }

  const title = scope.series?.title ?? 'Series'
  const engineLine = `Engine: ${readiness.engineLabel} · Model: ${readiness.modelLabel}${readiness.effort ? ` (${readiness.effort})` : ''}`
  const pinnedLine = processHere && process?.editor ? `${METHOD_LABELS[process.editor.method]} · ${process.editor.languages.map(l => LANGUAGE_NAMES[l]).join(' + ')}` : null

  const startProcess = async () => {
    const message = [
      `Make Editor 2.0 timelines for ${title} · Part ${part}?`,
      `Method: ${METHOD_LABELS[method]}. ${METHOD_HINTS[method]}`,
      `Languages: ${options.languages.map(l => LANGUAGE_NAMES[l]).join(' and ')}. Studio takes the next chapter without a timeline in chapter order, ${readiness.concurrency} at a time, one conversation per chapter and language.`,
      engineLine,
      'Only chapters Editor 2.0 is ready for (voiceover, alignment, cut crops) are taken. Each timeline is saved in Editor 2.0 unprocessed — open the chapter there and Start Processing — and Editor sends it to the phones.'
    ].join('\n\n')
    if (!window.confirm(message)) return
    setBusy(true)
    try { await antigravityJobsApi.startNext(seriesId!, part, 'editor', options); reloadProcess(); void loadJobs() } catch (e) {
      toast({ title: 'Could not start', description: (e as Error).message, variant: 'destructive' })
    } finally { setBusy(false) }
  }

  const startSelected = async () => {
    const n = selectedCells.length
    if (n === 0) return
    const what = `${n} ticked timeline${n === 1 ? '' : 's'}`
    const message = processHere
      ? [`Add ${what} to the running Timeline process on Part ${part}?`, `They run with that process's method and model (${pinnedLine ?? ''}${process ? ` · ${ENGINE_LABELS[process.engine ?? 'antigravity']} · ${process.model}` : ''}).`].join('\n\n')
      : [`Make ${what} for ${title} · Part ${part}?`, `Method: ${METHOD_LABELS[method]}. ${METHOD_HINTS[method]}`, `One conversation per chapter and language, ${readiness.concurrency} at a time.`, engineLine].join('\n\n')
    if (!window.confirm(message)) return
    setBusy(true)
    try {
      const out = await antigravityJobsApi.startPages(seriesId!, part, selectedCells, false, 'editor', options)
      const total = out.created.length + out.reused.length
      toast({
        title: total === 0 ? 'No ticked timeline could start' : `${total} timeline${total === 1 ? '' : 's'} ${processHere ? 'added to the process' : 'started'}`,
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
    if (action === 'stop' && !window.confirm('Stop this Timeline process? No new chapters start; the chapter in progress finishes and saves first, then the process stops.')) return
    if (action === 'stop-now' && !window.confirm('Stop now? Chapters in progress are cancelled and cannot save late results. Saved timelines stay; small batches already accepted are kept for next time.')) return
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
  const count = (fn: (s: EditorTimelineLanguageStatus) => boolean) => (status ?? []).reduce((n, c) => n + LANGUAGES.filter(l => fn(c.languages[l])).length, 0)
  const stateLabel: Record<string, string> = { running: 'Running', preparing: 'Running', pause_requested: 'Pausing…', paused: 'Paused', stop_requested: 'Stopping after the current chapter…' }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <AntiGravityTopBar crumbs={[
        { label: 'AntiGravity', to: '/antigravity' },
        { label: title, to: `/antigravity/series/${seriesId}` },
        { label: `Part ${part}`, to: `/antigravity/series/${seriesId}/parts/${part}` },
        { label: 'Editor 2.0 timelines' }
      ]} />
      <header>
        <h1 className="text-2xl font-semibold">Editor 2.0 timelines · {title} · Part {part}</h1>
        <p className="text-sm text-muted-foreground">Chapters {first}–{last}. Each chapter's timeline JSON in English and Hindi, from its aligned narration and crop metadata (text only, no Drive). Saved in Editor 2.0 like a paste, then sent to the phones.</p>
      </header>

      <section className="sticky top-0 z-10 space-y-3 rounded-lg border bg-background/95 p-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          {processHere && process ? (
            <>
              <Badge variant={process.control === 'paused' ? 'warning' : 'secondary'}>
                {process.control === 'running' && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{stateLabel[process.control] ?? process.control}
              </Badge>
              <span className="text-sm">{processing} timeline{processing === 1 ? '' : 's'} in progress · {pinnedLine} · {ENGINE_LABELS[process.engine ?? 'antigravity']} · {process.model}</span>
              <Button asChild variant="ghost" size="sm"><Link to="/antigravity/runs"><Activity className="mr-1.5 h-4 w-4" /> View in Running processes</Link></Button>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">{count(s => s?.saved)} saved · {count(s => !!s && !s.saved && s.ready)} ready · {count(s => !!s && !s.saved && !s.ready)} not ready</span>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            {selectedCells.length > 0 && (
              <Button
                size="sm"
                disabled={busy || processElsewhere || (!processHere && blockers.length > 0) || process?.control === 'stop_requested'}
                title={processElsewhere ? 'Another process is running. One process at a time.' : processHere ? 'Queue the ticked timelines in the running Timeline process' : blockers.join('\n') || `Make the ticked timelines only (${METHOD_LABELS[method]}), ${readiness.concurrency} at a time`}
                onClick={() => void startSelected()}
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />} {processHere ? `Add ${selectedCells.length} to process` : `Start ${selectedCells.length} selected`}
              </Button>
            )}
            {processHere && process ? (
              <>
                {process.control === 'running' && <Button variant="outline" size="sm" disabled={busy} onClick={() => void controlProcess('pause')} title="No new chapters start; chapters in progress finish"><Pause className="mr-2 h-4 w-4" /> Pause</Button>}
                {['paused', 'pause_requested'].includes(process.control) && <Button variant="outline" size="sm" disabled={busy} onClick={() => void controlProcess('resume')}><Play className="mr-2 h-4 w-4" /> Resume</Button>}
                {process.control !== 'stop_requested' && <Button variant="destructive" size="sm" disabled={busy} onClick={() => void controlProcess('stop')} title="No new chapters start; the chapter in progress finishes and saves, then the process stops"><Square className="mr-2 h-4 w-4" /> Stop</Button>}
                {process.control === 'stop_requested' && <Button variant="outline" size="sm" disabled={busy} onClick={() => void controlProcess('resume')} title="Take back the stop; the process carries on"><Play className="mr-2 h-4 w-4" /> Keep running</Button>}
                {process.control === 'stop_requested' && <Button variant="destructive" size="sm" disabled={busy} onClick={() => void controlProcess('stop-now')} title="Cancel the chapter in progress now; it cannot save a late result"><Square className="mr-2 h-4 w-4" /> Stop now</Button>}
              </>
            ) : (
              <Button
                size="sm"
                variant={selectedCells.length > 0 ? 'outline' : 'default'}
                disabled={busy || processElsewhere || !status?.length || blockers.length > 0}
                title={processElsewhere ? 'Another process is running. One process at a time.' : blockers.join('\n') || `Make this part's missing timelines in chapter order (${METHOD_LABELS[method]}, ${options.languages.map(l => LANGUAGE_NAMES[l]).join(' + ')}), ${readiness.concurrency} at a time`}
                onClick={() => void startProcess()}
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />} Start process
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <fieldset className="flex items-center gap-1" disabled={busy}>
            <legend className="sr-only">Method</legend>
            <span className="mr-1 text-xs text-muted-foreground">Method</span>
            {(['oneshot', 'batches'] as const).map(m => (
              <Button key={m} type="button" size="sm" variant={method === m ? 'default' : 'outline'} className="h-7 px-2.5 text-xs" aria-pressed={method === m} title={METHOD_HINTS[m]} onClick={() => setMethod(m)}>
                {m === 'oneshot' ? '1 · ' : '2 · '}{METHOD_LABELS[m]}
              </Button>
            ))}
          </fieldset>
          <fieldset className="flex items-center gap-1" disabled={busy}>
            <legend className="sr-only">Languages for Start process</legend>
            <span className="mr-1 text-xs text-muted-foreground">Start process makes</span>
            {(['both', 'en', 'hi'] as const).map(c => (
              <Button key={c} type="button" size="sm" variant={languageChoice === c ? 'default' : 'outline'} className="h-7 px-2.5 text-xs" aria-pressed={languageChoice === c} onClick={() => setLanguageChoice(c)}>
                {c === 'both' ? 'English + Hindi' : LANGUAGE_NAMES[c]}
              </Button>
            ))}
          </fieldset>
          {selectedCells.length > 0 && (
            <span className="flex items-center gap-1 text-xs">
              <span className="font-medium">{selectedCells.length} ticked</span>
              <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => setSelected(new Set())}><X className="mr-1 h-3 w-3" /> Clear</Button>
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{METHOD_HINTS[method]}{processHere && pinnedLine ? ` The running process keeps its own method (${pinnedLine}).` : ''}</p>
        {processElsewhere && process && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {process.kind === 'metadata' ? 'A Metadata process' : process.kind === 'editor' ? 'A Timeline process' : process.kind === 'narration' ? 'A Narration process' : 'An Image Clipper process'} is {process.control === 'paused' ? 'paused' : 'running'} on {process.seriesId === seriesId && process.partNumber === part ? 'this part' : `another part (Part ${process.partNumber})`}. One process at a time: let it finish or stop it first.
            <Link to="/antigravity/runs" className="underline">Open Running processes</Link>
          </div>
        )}
        <div className="text-xs text-muted-foreground">{engineLine} · Parallel chapters: {readiness.concurrency} · No Google Drive needed · Change them in Settings → AntiGravity{method === 'oneshot' ? ' · One-shot uses the prompt in Settings → Editor 2.0' : ''}</div>
        {blockers.length > 0 && (
          <ul className="space-y-1 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs">
            {blockers.map(b => <li key={b} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {b}</li>)}
          </ul>
        )}
      </section>

      {(scope.error || statusError) && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{scope.error ?? statusError}</div>}
      {!status && !statusError && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Reading Editor 2.0's checklist…</div>}
      {status && status.length === 0 && <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">No chapters in this part.</div>}

      {status && status.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="text-left">
                <th className="px-3 py-2">Chapter</th>
                {LANGUAGES.map(l => (
                  <th key={l} className="px-3 py-2">
                    <button type="button" className="underline-offset-2 hover:underline" onClick={() => tickColumn(l)} title={`Tick every ${LANGUAGE_NAMES[l]} timeline that can start now`}>{LANGUAGE_NAMES[l]}</button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {status.map(chapter => (
                <tr key={chapter.id} className="border-t align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium">Chapter {chapter.number}{chapter.title ? ` · ${chapter.title}` : ''}</div>
                  </td>
                  {LANGUAGES.map(language => {
                    const s = chapter.languages[language]
                    const job = jobs.get(key(chapter.id, language))
                    const blocked = blockReason(s, job)
                    const ticked = !blocked && selected.has(key(chapter.id, language))
                    const attempt = job?.attempt
                    return (
                      <td key={language} className={cn('px-3 py-2', job && ACTIVE_JOB.has(job.stage) && 'bg-primary/5', ticked && 'bg-primary/10')}>
                        <div className="flex items-start gap-2">
                          <Checkbox
                            checked={ticked}
                            disabled={!!blocked || busy}
                            onCheckedChange={() => toggle(chapter.id, language)}
                            aria-label={`Tick the ${LANGUAGE_NAMES[language]} timeline of Chapter ${chapter.number}`}
                            title={blocked ?? 'Tick this timeline'}
                            className="mt-0.5"
                          />
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <TimelineBadge status={s} />
                              {job && <JobBadge job={job} />}
                              {job && <AiTime job={job} now={now} />}
                              {job && <Link to={`/antigravity/runs/${job.runId}`} className="text-xs text-muted-foreground underline">run</Link>}
                            </div>
                            {s && !s.saved && !s.ready && <div className="max-w-xs text-xs text-muted-foreground">{s.missing.map(m => m.detail).join(' · ')}</div>}
                            {s?.saved && s.model && <div className="max-w-xs truncate text-xs text-muted-foreground" title={s.model}>{s.model}</div>}
                            {job?.lastError && WAITS_FOR_YOU.has(job.stage) && <div className="max-w-xs text-xs text-muted-foreground">{job.lastError}</div>}
                            <div className="flex flex-wrap items-center gap-1">
                              {job && RETRYABLE.has(job.stage) && !s?.saved && <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" title="New attempt in a new conversation (small batches already accepted are kept)" onClick={() => void act('Retry failed', () => antigravityJobsApi.retry(job.id))}><RotateCcw className="mr-1 h-3 w-3" /> Retry</Button>}
                              {job && ['needs_attention', 'interrupted'].includes(job.stage) && attempt?.conversationId && !s?.saved && (
                                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" title={`Continue in conversation ${attempt.conversationId}`} onClick={() => void act('Continue failed', () => antigravityJobsApi.reviewAgain(job.id))}><MessageSquareMore className="mr-1 h-3 w-3" /> Continue</Button>
                              )}
                              {s?.saved && <Link to={withLang(`/editor2/${seriesId}`, language)} className="inline-flex items-center gap-1 text-xs text-muted-foreground underline"><Clapperboard className="h-3 w-3" /> {s.processed ? 'Open in Editor 2.0' : 'Start Processing in Editor 2.0'}</Link>}
                            </div>
                          </div>
                        </div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
