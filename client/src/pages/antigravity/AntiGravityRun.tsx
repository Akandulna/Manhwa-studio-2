/**
 * AntiGravity → one process's detail (PRD §6.1, §13), shown inside Running
 * processes: durable run state, the pages being processed now (one row per
 * parallel page), the pages it finished, AI time, attempt, conversation and
 * model evidence, controls, and the event log. Reloads from the server on each
 * local progress event (no R2 traffic).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, Eye, Loader2, MessageSquareMore, Pause, Play, RotateCcw, Square, Timer, UploadCloud } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { antigravityJobsApi, ENGINE_LABELS, type AntigravityRunDetail } from '@/lib/api'
import { useSocket } from '@/lib/socket'
import { AiTime, JobBadge, RETRYABLE } from './AntiGravityClipper'

/** Stages a page ends in (mirrors the server's TERMINAL_STAGES); anything else is still being processed. */
const TERMINAL = new Set(['ready_for_human_review', 'done', 'skipped_existing', 'needs_attention', 'failed', 'cancelled', 'stale', 'interrupted', 'publish_failed', 'rejected'])
import { attemptDuration, formatDuration, jobUnitLabel, kindLabel, runOriginPath, useTicker } from './shared'
import { canReject, RejectJobButton } from './RejectJobButton'


export function RunDetail({ runId, seriesTitleOf }: { runId: string; seriesTitleOf?: (seriesId: string) => string | undefined }) {
  const { socket } = useSocket()
  const { toast } = useToast()
  const [detail, setDetail] = useState<AntigravityRunDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!runId) return
    try { setDetail(await antigravityJobsApi.run(runId)); setError(null) } catch (e) { setError((e as Error).message) }
  }, [runId])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!socket) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const onProgress = (event: { runId?: string | null }) => { if (event.runId === runId && !timer) timer = setTimeout(() => { timer = null; void load() }, 800) }
    socket.on('antigravity:progress', onProgress)
    return () => { socket.off('antigravity:progress', onProgress); if (timer) clearTimeout(timer) }
  }, [socket, runId, load])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try { await fn(); await load() } catch (e) { toast({ title: 'AntiGravity', description: (e as Error).message, variant: 'destructive' }) } finally { setBusy(false) }
  }

  const running = !!detail?.jobs.some(j => j.attempts?.some(a => a.status === 'active' && !a.finishedAt))
  const now = useTicker(running)
  /** AI time over every attempt of every page (slicing and Drive upload excluded), and the average per page that reached review. */
  const timing = useMemo(() => {
    if (!detail) return null
    let total = 0
    const finished: number[] = []
    for (const job of detail.jobs) {
      for (const a of job.attempts ?? []) total += attemptDuration(a, now)?.ms ?? 0
      const last = attemptDuration(job.attempts?.at(-1), now)
      if (last && !last.running && ['ready_for_human_review', 'publish_failed', 'done'].includes(job.stage)) finished.push(last.ms)
    }
    return { total, average: finished.length ? finished.reduce((a, b) => a + b, 0) / finished.length : null, finished: finished.length }
  }, [detail, now])

  // Metadata and Timeline: saved in Studio, no review rounds or R2 columns. A Timeline job is one chapter + language.
  const metadata = detail?.run.kind === 'metadata' || detail?.run.kind === 'editor'
  const timeline = detail?.run.kind === 'editor'
  const pageTable = (list: AntigravityRunDetail['jobs']) => !detail ? null : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            {metadata
              ? <tr><th className="py-1.5">{timeline ? 'Timeline' : 'Page'}</th><th>Stage</th><th title={timeline ? 'The chapter\'s timeline conversation, every turn' : 'The page\'s Metadata conversation, all batches'}>AI time</th><th>Attempt / conversation</th><th>Result</th><th /></tr>
              : <tr><th className="py-1.5">Page</th><th>Stage</th><th title="Analysis + review by the AI. Slicing and the Drive upload are not counted.">AI time</th><th>Attempt / conversation</th><th>Review rounds</th><th>Result</th><th>R2</th><th /></tr>}
          </thead>
          <tbody>
            {list.map(job => {
              const attempt = job.attempts?.at(-1)
              return (
                <tr key={job.id} className="border-t align-top">
                  <td className="py-1.5">
                    <div className={timeline ? 'text-xs font-medium' : 'font-mono text-xs'}>{jobUnitLabel(job)}</div>
                    <Link to={`/antigravity/series/${detail.run.seriesId}/parts/${detail.run.partNumber}/chapters/${job.chapterId}`} className="inline-flex items-center gap-0.5 text-xs text-muted-foreground underline"><Eye className="h-3 w-3" /> Preview</Link>
                    {job.driveFolderId && <a href={`https://drive.google.com/drive/folders/${job.driveFolderId}`} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-0.5 text-xs text-muted-foreground underline">Drive <ExternalLink className="h-3 w-3" /></a>}
                  </td>
                  <td className="py-1.5"><JobBadge job={job} />{job.lastError && <div className="mt-1 max-w-xs text-xs text-muted-foreground">{job.lastError}</div>}</td>
                  <td className="py-1.5">
                    <AiTime job={job} now={now} />
                    {(job.attempts?.length ?? 0) > 1 && (
                      <div className="text-xs text-muted-foreground" title={job.attempts!.map(a => `#${a.number}: ${(() => { const d = attemptDuration(a, now); return d ? formatDuration(d.ms) : '—' })()} (${a.status})`).join('\n')}>
                        {job.attempts!.length} attempts
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 text-xs">
                    {attempt ? (
                      <>
                        <div>#{attempt.number} · {attempt.status}</div>
                        <div className="font-mono text-muted-foreground" title={attempt.engine === 'codex' ? 'Codex thread (codex exec resume <id>)' : 'Antigravity conversation'}>{attempt.conversationId ?? 'no conversation yet'}</div>
                        {attempt.engine === 'codex' && attempt.observedModel !== 'unknown' && <div className="text-muted-foreground">Codex session model: {attempt.observedModel}</div>}
                        {!metadata && <div className="text-muted-foreground">slices delivered: {attempt.delivered.length}</div>}
                      </>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  {!metadata && <td className="py-1.5 text-xs">{attempt?.reviewRounds ?? 0}</td>}
                  <td className="py-1.5 text-xs">{job.resultSha256 ? <span className="font-mono">{job.resultSha256.slice(0, 10)}… · {job.importState}</span> : '—'}</td>
                  {!metadata && <td className="py-1.5 text-xs">{(() => {
                    const d = job.deliveries?.at(-1)
                    if (!d) return <span className="text-muted-foreground">—</span>
                    return (
                      <div title={`${d.destination}\n${d.pointerKey}`}>
                        <div>{d.state === 'published' ? 'shared with phones' : d.state === 'phone_has_page' ? 'a phone already had it' : d.state}{d.tries > 1 ? ` · ${d.tries} tries` : ''}</div>
                        {d.publishedAt && <div className="text-muted-foreground">{new Date(d.publishedAt).toLocaleString()}</div>}
                        {d.error && <div className="max-w-xs text-destructive">{d.error}</div>}
                      </div>
                    )
                  })()}</td>}
                  <td className="py-1.5">
                    {RETRYABLE.has(job.stage) && <Button size="sm" variant="ghost" disabled={busy} title={job.stage === 'publish_failed' ? 'Publish again (no AI request)' : metadata ? 'New attempt in a new conversation' : 'New attempt from the prepared Drive inputs'} onClick={() => act(() => antigravityJobsApi.retry(job.id))}><RotateCcw className="mr-1 h-3.5 w-3.5" /> {job.stage === 'rejected' ? 'Process again' : 'Retry'}</Button>}
                    {canReject(job) && <RejectJobButton job={job} onChanged={() => void load()} />}
                    {metadata && ['needs_attention', 'interrupted'].includes(job.stage) && attempt?.conversationId && (
                      <Button size="sm" variant="ghost" disabled={busy} title={timeline ? `Continue this timeline in conversation ${attempt.conversationId} (accepted batches are kept)` : `Continue the remaining batches in conversation ${attempt.conversationId}`} onClick={() => act(() => antigravityJobsApi.reviewAgain(job.id))}><MessageSquareMore className="mr-1 h-3.5 w-3.5" /> Continue</Button>
                    )}
                    {!metadata && ['needs_attention', 'interrupted'].includes(job.stage) && job.importState !== 'conflict' && attempt?.conversationId && attempt.analysisSha256 && (
                      <Button size="sm" variant="ghost" disabled={busy} title={`More review rounds in conversation ${attempt.conversationId} (no new analysis)`} onClick={() => act(() => antigravityJobsApi.reviewAgain(job.id))}><MessageSquareMore className="mr-1 h-3.5 w-3.5" /> Review again</Button>
                    )}
                    {job.stage === 'ready_for_human_review' && job.importState === 'imported' && !job.deliveries?.some(d => d.state === 'published') && (
                      <Button size="sm" variant="ghost" disabled={busy} title="Share this page with the phones through R2 shared/crops (no AI request)" onClick={() => act(() => antigravityJobsApi.publish(job.id))}><UploadCloud className="mr-1 h-3.5 w-3.5" /> Share with phones</Button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
  )

  if (error) return <div className="p-6 text-sm text-destructive">{error}</div>
  if (!detail) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading run…</div>
  const { run, jobs, events } = detail
  const count = (stages: string[]) => jobs.filter(j => stages.includes(j.stage)).length
  // Now processing: pages this process holds that have not ended yet (newest admitted last); the rest finished.
  const inFlight = jobs.filter(j => !TERMINAL.has(j.stage))
  const finished = jobs.filter(j => TERMINAL.has(j.stage)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  const live = ['running', 'preparing', 'pause_requested'].includes(run.control)

  return (
    <div className="min-w-0 space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">
            {kindLabel(run.kind)} · {seriesTitleOf?.(run.seriesId) ?? 'Series'} · Part {run.partNumber} <span className="font-mono text-sm font-normal text-muted-foreground">{run.mode === 'next' ? 'process' : 'run'} {run.id.slice(0, 8)}</span>
          </h2>
          <Link to={runOriginPath(run)} className="text-xs text-muted-foreground underline">Open this part's {kindLabel(run.kind)}</Link>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant={live ? 'secondary' : run.control === 'completed' ? 'success' : run.control === 'paused' ? 'warning' : 'outline'}>{run.control.replace(/_/g, ' ')}</Badge>
            <Badge variant="outline">{ENGINE_LABELS[run.engine ?? 'antigravity']}</Badge>
            <span>Requested model {run.model}{run.effort ? ` (${run.effort})` : ''}{run.engine === 'codex' ? ' · session model recorded per attempt' : ' · served model not reported by the CLI'}</span>
            <span>· {run.concurrency} page{run.concurrency === 1 ? '' : 's'} at a time{run.sandbox ? ' · sandbox' : ''}</span>
          </div>
          {metadata ? (
            <div className="text-xs text-muted-foreground">
              Saved {count(['done'])} · already saved {count(['skipped_existing'])} · in progress {count(['queued', 'describing', 'planning', 'validating', 'delivering'])} · needs attention {count(['needs_attention'])} · failed {count(['failed'])} · stopped {count(['cancelled', 'interrupted'])}
            </div>
          ) : <div className="text-xs text-muted-foreground">
            Ready for human review {count(['ready_for_human_review'])} · in progress {count(['pending', 'preparing', 'uploading', 'queued', 'analyzing', 'reviewing', 'validating', 'delivering', 'publishing'])} · imported, R2 pending {count(['publish_failed'])} · prepared {count(['prepared'])} · needs attention {count(['needs_attention'])} · failed {count(['failed'])} · stale {count(['stale'])} · stopped {count(['cancelled', 'interrupted'])} · rejected {count(['rejected'])}
          </div>}
          {timing && timing.total > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Analysis + review by the AI. Slicing and the Drive upload are not counted.">
              <Timer className="h-3.5 w-3.5" /> AI time {formatDuration(timing.total)}
              {timing.average !== null && <> · {formatDuration(timing.average)} per page on average ({timing.finished} page{timing.finished === 1 ? '' : 's'} done)</>}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {live && run.control !== 'pause_requested' && <Button variant="outline" size="sm" disabled={busy} onClick={() => act(() => antigravityJobsApi.control(run.id, 'pause'))} title="Stop dispatching new pages; pages in progress finish"><Pause className="mr-2 h-4 w-4" /> Pause</Button>}
          {['paused', 'pause_requested', 'interrupted'].includes(run.control) && <Button variant="outline" size="sm" disabled={busy} onClick={() => act(() => antigravityJobsApi.control(run.id, 'resume'))}><Play className="mr-2 h-4 w-4" /> Resume</Button>}
          {live && <Button variant="destructive" size="sm" disabled={busy} onClick={() => window.confirm('Stop this run? In-flight pages are cancelled and cannot commit late results.') && act(() => antigravityJobsApi.control(run.id, 'stop'))}><Square className="mr-2 h-4 w-4" /> Stop</Button>}
        </div>
      </header>
      {run.control === 'pause_requested' && <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm">Pausing: no new pages start; pages in progress finish their analysis, review and import first.</div>}
      {run.control === 'paused' && (() => {
        const reason = [...events].reverse().find(e => e.message.startsWith('Run paused:'))
        return reason ? <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm">{reason.message}</div> : null
      })()}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Now processing{inFlight.length ? ` (${inFlight.length})` : ''}</h2>
        {inFlight.length > 0 ? pageTable(inFlight) : (
          <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">{live ? 'Picking the next page…' : 'No page is being processed.'}</p>
        )}
      </section>

      {finished.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Finished in this process ({finished.length})</h2>
          {pageTable(finished)}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Events</h2>
        <ol className="max-h-80 space-y-0.5 overflow-auto rounded-md border p-2 font-mono text-xs">
          {events.map(e => <li key={e.seq}><span className="text-muted-foreground">{new Date(e.at).toLocaleTimeString()}</span> {e.message}</li>)}
          {events.length === 0 && <li className="text-muted-foreground">No events yet.</li>}
        </ol>
      </section>
    </div>
  )
}
