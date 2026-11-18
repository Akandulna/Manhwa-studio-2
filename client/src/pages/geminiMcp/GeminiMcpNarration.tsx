/**
 * Gemini MCP → Narration Studio for one series (docs/PRD-gemini-app-narration.md §5).
 *
 * English and Hinglish are separate jobs in separate Gemini chats, so each has its own tab. Per chapter, Process
 * prepares the chapter (English: its pages cut into checked pieces and uploaded to Google Drive) and gives the prompt
 * to paste into a new Gemini chat; it starts or continues that chapter only. Master queues every remaining chapter
 * in order and gives one prompt that works through the queue, scheduling itself for the next chapter.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ExternalLink, History, ListOrdered, Loader2, Play, RefreshCw, RotateCcw, Square, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import { geminiMcpApi, type GeminiChapterRow, type GeminiJobView } from '@/lib/api'
import type { NarrationLanguage } from '@/lib/narrationLanguage'
import { cn } from '@/lib/utils'
import { ACTIVE_STATES, GeminiMcpCrumbs, JobBadge, JobLogDialog, MOVING_STATES, PromptDialog, ago, timingText } from '@/components/geminiMcp/GeminiMcpShared'

const LANGUAGES: { id: NarrationLanguage; label: string }[] = [{ id: 'en', label: 'English' }, { id: 'hi', label: 'Hinglish' }]

type Shown = { title: string; description: string; prompt: string; jobId?: string; note?: string }

export default function GeminiMcpNarration() {
  const { seriesId = '' } = useParams()
  const { toast } = useToast()
  const [language, setLanguage] = useState<NarrationLanguage>('en')
  const [data, setData] = useState<Awaited<ReturnType<typeof geminiMcpApi.chapters>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [shown, setShown] = useState<Shown | null>(null)
  const [now, setNow] = useState(Date.now())
  const [logJob, setLogJob] = useState<GeminiJobView | null>(null)

  const load = useCallback(async () => {
    try { setData(await geminiMcpApi.chapters(seriesId)); setError(null) } catch (e) { setError((e as Error).message) }
  }, [seriesId])
  useEffect(() => { void load() }, [load])

  const chapters = data?.chapters ?? []
  const jobs = useMemo(() => chapters.flatMap(c => [c.en.job, c.hi.job]).filter((j): j is GeminiJobView => !!j), [chapters])
  const moving = jobs.some(j => MOVING_STATES.has(j.state))
  // Local API only (no R2): refresh while pages upload or Gemini works.
  useEffect(() => {
    if (!moving) return
    const timer = setInterval(() => { void load(); setNow(Date.now()) }, 3000)
    return () => clearInterval(timer)
  }, [moving, load])

  const shownJob = shown?.jobId ? jobs.find(j => j.id === shown.jobId) ?? null : null
  const title = data?.series.title ?? 'Series'
  const languageName = LANGUAGES.find(l => l.id === language)!.label

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key)
    try { await task() } catch (e) {
      toast({ title: 'Could not do that', description: (e as Error).message, variant: 'destructive' })
    } finally { setBusy(null) }
  }

  const process = (chapter: GeminiChapterRow, restart = false) => run(`${chapter.id}|process`, async () => {
    const status = chapter[language]
    const going = status.job && ACTIVE_STATES.has(status.job.state)
    if (going && !restart) {
      // Just its prompt again: a chapter in the Master queue stays there.
      const { job, prompt } = await geminiMcpApi.job(status.job!.id)
      setShown({ title: `Chapter ${chapter.number} · ${languageName}`, description: 'Paste this into a new Gemini chat to start or continue this chapter. Studio keeps every accepted stage.', prompt, jobId: job.id })
      return
    }
    let rewrite = false
    if (status.hasScript && (!going || restart)) {
      if (!window.confirm(`Chapter ${chapter.number} already has a${language === 'en' ? 'n English' : ' Hinglish'} script. Rewrite it with Gemini? The current script stays until Gemini's new one is saved.`)) return
      rewrite = true
    } else if (restart && !window.confirm(`Start chapter ${chapter.number} over? Its current Gemini job is cancelled${language === 'en' ? ' and its pages are uploaded again with new check codes' : ''}. Use a new Gemini chat.`)) return
    const { job, prompt } = await geminiMcpApi.process({ chapterId: chapter.id, language, rewrite, restart })
    await load()
    setShown({
      title: `Chapter ${chapter.number} · ${languageName}`,
      description: 'Paste this into a new Gemini chat. It works on this chapter only; paste it again in a new chat to continue if it stops.',
      prompt, jobId: job.id
    })
  })

  const retry = (job: GeminiJobView) => run(`${job.id}|retry`, async () => {
    const { prompt } = await geminiMcpApi.retry(job.id)
    await load()
    setShown({
      title: `Retry ${job.ref}`,
      description: job.state === 'failed'
        ? 'Its pages are uploaded again. Paste this into a new Gemini chat.'
        : 'The accepted work is kept and the stuck step gets fresh attempts. Paste this into a new Gemini chat to continue.',
      prompt, jobId: job.id
    })
  })

  const cancel = (job: GeminiJobView) => run(`${job.id}|cancel`, async () => {
    if (!window.confirm(`Cancel ${job.ref}?${job.driveFolderUrl ? ' Its Drive folder is deleted.' : ''}`)) return
    await geminiMcpApi.cancel(job.id)
    await load()
  })

  const remaining = chapters.filter(c => !c[language].hasScript && !(c[language].job && ACTIVE_STATES.has(c[language].job!.state)))
  const queuedHere = jobs.filter(j => j.queueOrder !== null && ACTIVE_STATES.has(j.state))
  const master = () => run('master', async () => {
    if (!window.confirm(`Queue the ${languageName} scripts of ${title}'s remaining chapters (${remaining.length}), in chapter order? ${language === 'en' ? 'Studio uploads a few chapters ahead to Google Drive at a time.' : 'Only chapters with an English script can be queued.'}`)) return
    const result = await geminiMcpApi.master(seriesId, language)
    await load()
    if (!result.queued.length) {
      toast({ title: 'Nothing queued', description: result.skipped.length ? result.skipped.slice(0, 3).map(s => `Ch ${s.number}: ${s.reason}`).join(' · ') : 'Every chapter already has a script or a job.' })
      return
    }
    setShown({
      title: `Master · ${languageName}`,
      description: `${result.queued.length} chapter${result.queued.length === 1 ? '' : 's'} queued. Paste this into a new Gemini chat once; at the end of each chapter it schedules the next run by itself.`,
      prompt: result.prompt,
      note: result.skipped.length ? `Not queued: ${result.skipped.map(s => `Ch ${s.number} (${s.reason})`).join(', ')}.` : undefined
    })
  })
  const stopMaster = () => run('stop', async () => {
    if (!window.confirm('Stop the Master queue for this series? Chapters Gemini hasn\'t started are cancelled and their Drive folders deleted. A chapter Gemini is writing now is left alone.')) return
    const { cancelled } = await geminiMcpApi.stopMaster(seriesId)
    toast({ title: 'Master stopped', description: `${cancelled} queued chapter${cancelled === 1 ? '' : 's'} cancelled.` })
    await load()
  })

  const parts = useMemo(() => {
    const map = new Map<number, GeminiChapterRow[]>()
    for (const c of chapters) map.set(c.part, [...(map.get(c.part) ?? []), c])
    return [...map.entries()]
  }, [chapters])

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <GeminiMcpCrumbs crumbs={[{ label: 'Gemini MCP', to: '/gemini-mcp' }, { label: title, to: `/gemini-mcp/series/${seriesId}` }, { label: 'Narration Studio' }]} />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{title} · Narration Studio</h1>
          <p className="text-sm text-muted-foreground">English and Hinglish are separate jobs, each in its own Gemini chat. Hinglish is written from the saved English script.</p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => { void load(); setNow(Date.now()) }} title="Refresh"><RefreshCw className="h-4 w-4" /></Button>
      </header>

      <div className="flex border-b" role="tablist">
        {LANGUAGES.map(l => (
          <button key={l.id} role="tab" aria-selected={language === l.id} onClick={() => setLanguage(l.id)}
            className={cn('-mb-px border-b-2 px-4 py-2 text-sm font-medium', language === l.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {l.label}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-4">
          <ListOrdered className="h-5 w-5 text-muted-foreground" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium">Master · {languageName}</div>
            <div className="text-muted-foreground">
              {queuedHere.length
                ? `${queuedHere.length} chapter${queuedHere.length === 1 ? '' : 's'} in the queue. Gemini takes them one by one.`
                : `Queue every remaining chapter (${remaining.length}) and get one prompt that works through them, scheduling the next run by itself.`}
            </div>
          </div>
          {queuedHere.length > 0 && data && (
            <>
              <Button variant="outline" size="sm" onClick={() => setShown({ title: 'Master prompt', description: 'Paste this into a new Gemini chat to start (or restart) the queue.', prompt: data.masterPrompt })}>Show prompt</Button>
              <Button variant="outline" size="sm" onClick={stopMaster} disabled={!!busy}><Square className="mr-1.5 h-3.5 w-3.5" />Stop</Button>
            </>
          )}
          <Button size="sm" onClick={master} disabled={!!busy || remaining.length === 0}>
            {busy === 'master' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}{queuedHere.length ? 'Queue the rest' : 'Master'}
          </Button>
        </CardContent>
      </Card>

      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{error}</div>}
      {!data && !error && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading chapters…</div>}

      {parts.map(([part, list]) => (
        <section key={part} className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Part {part}</h2>
          <div className="divide-y rounded-lg border">
            {list.map(c => {
              const status = c[language]
              const job = status.job
              const going = !!job && ACTIVE_STATES.has(job.state)
              const label = going ? 'Prompt' : status.hasScript ? 'Rewrite' : 'Process'
              return (
                <div key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="w-16 shrink-0 font-medium">Ch {c.number}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {status.hasScript ? <Badge variant="success">Has script</Badge> : status.blocked ? <Badge variant="outline">Waiting</Badge> : <Badge variant="secondary">No script</Badge>}
                      {job && <JobBadge job={job} />}
                      {job && <span className="font-mono text-xs text-muted-foreground">{job.ref}</span>}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {[
                        status.blocked && !going ? status.blocked : null,
                        job?.lastError && job.state !== 'cancelled' && job.state !== 'saved' ? `${job.state === 'working' ? 'Last rejected: ' : ''}${job.lastError}` : null,
                        job ? timingText(job, now) : null,
                        job?.lastActivityAt && job.state === 'working' ? `last call ${ago(job.lastActivityAt, now)}` : null,
                        c.title
                      ].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  {job?.driveFolderUrl && (
                    <a href={job.driveFolderUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">Drive <ExternalLink className="h-3 w-3" /></a>
                  )}
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant={going ? 'outline' : 'default'} disabled={!!busy || (!!status.blocked && !going)} onClick={() => process(c)}>
                      {busy === `${c.id}|process` ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}{label}
                    </Button>
                    {job && (job.state === 'attention' || job.state === 'failed') && (
                      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => retry(job)} title="Continue with the accepted work kept">
                        {busy === `${job.id}|retry` ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1.5 h-3.5 w-3.5" />}Retry
                      </Button>
                    )}
                    {job && job.timing.startedAt && (
                      <Button size="icon" variant="ghost" className="h-8 w-8" title="Log" onClick={() => setLogJob(job)}><History className="h-4 w-4" /></Button>
                    )}
                    {job && going && (
                      <>
                        <Button size="icon" variant="ghost" className="h-8 w-8" title="Start over (new codes, new chat)" disabled={!!busy} onClick={() => process(c, true)}><RotateCcw className="h-4 w-4" /></Button>
                        <Button size="icon" variant="ghost" className="h-8 w-8" title="Cancel" disabled={!!busy} onClick={() => cancel(job)}><X className="h-4 w-4" /></Button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}

      {logJob && <JobLogDialog job={logJob} onOpenChange={o => { if (!o) setLogJob(null) }} />}
      {shown && (
        <PromptDialog open onOpenChange={o => { if (!o) setShown(null) }} title={shown.title} description={shown.description} prompt={shown.prompt} job={shownJob} note={shown.note} />
      )}
    </div>
  )
}
