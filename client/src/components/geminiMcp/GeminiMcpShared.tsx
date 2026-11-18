/**
 * Shared bits of PROCESSOR → Gemini MCP (docs/PRD-gemini-app-narration.md §5): breadcrumbs, job state badge and
 * the "paste into Gemini" prompt dialog.
 */

import { Fragment, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, Copy, ExternalLink, Settings as SettingsIcon, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { geminiMcpApi, type GeminiJobLog, type GeminiJobView } from '@/lib/api'

export function GeminiMcpCrumbs({ crumbs }: { crumbs: { label: string; to?: string }[] }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b pb-3">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
        <Sparkles className="h-4 w-4 shrink-0" />
        {crumbs.map((c, i) => (
          <Fragment key={`${c.label}-${i}`}>
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
            {c.to ? <Link to={c.to} className="truncate hover:text-foreground">{c.label}</Link> : <span className="truncate font-medium text-foreground">{c.label}</span>}
          </Fragment>
        ))}
      </nav>
      <Button asChild variant="ghost" size="sm"><Link to="/settings?tab=gemini-mcp"><SettingsIcon className="mr-1.5 h-4 w-4" />Connector</Link></Button>
    </div>
  )
}

export const ACTIVE_STATES = new Set(['queued', 'preparing', 'ready', 'working'])
/** States the page refreshes for on its own (local API only). */
export const MOVING_STATES = new Set(['queued', 'preparing', 'working'])

const STAGE_LABELS: Record<string, string> = {
  draft: 'Draft', review: 'Review', check: 'Check', done: 'Saving',
  hi_scenes: 'Scene notes', hi_script: 'Writing Hinglish', hi_check: 'Check'
}

export function jobLabel(job: GeminiJobView): string {
  switch (job.state) {
    case 'queued': return job.queueOrder !== null ? `Queued #${job.queueOrder}` : 'Queued'
    case 'preparing': return job.total ? `Uploading ${job.uploaded}/${job.total}` : 'Cutting pages'
    case 'ready': return 'Ready'
    case 'working':
      if (job.stage === 'notes') return `Reading ${job.noted}/${job.total}`
      return STAGE_LABELS[job.stage] ?? job.stage
    case 'saved': return 'Saved'
    case 'attention': return 'Needs attention'
    case 'failed': return 'Failed'
    case 'cancelled': return 'Cancelled'
  }
}

export function JobBadge({ job }: { job: GeminiJobView }) {
  const variant = job.state === 'saved' ? 'success' : job.state === 'ready' || job.state === 'working' ? 'default'
    : job.state === 'failed' || job.state === 'attention' ? 'destructive' : job.state === 'cancelled' ? 'outline' : 'warning'
  return <Badge variant={variant} title={job.lastError ?? job.ref}>{jobLabel(job)}</Badge>
}

export function ago(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

/** "38 min · 3 rejected" for a finished job, "12 min so far" while Gemini works. */
export function timingText(job: GeminiJobView, now = Date.now()): string | null {
  const { startedAt, seconds, rejected } = job.timing
  if (!startedAt) return null
  const running = job.state === 'working'
  const total = running ? Math.round((now - Date.parse(startedAt)) / 1000) : seconds
  if (total === null) return null
  const span = total < 60 ? `${total}s` : total < 3600 ? `${Math.round(total / 60)} min` : `${Math.floor(total / 3600)} h ${Math.round((total % 3600) / 60)} min`
  return `${running ? `${span} so far` : `took ${span}`} · ${rejected} rejected`
}

/** The prompt to paste into a new Gemini chat, with Copy. */
export function PromptDialog({ open, onOpenChange, title, description, prompt, job, note }: {
  open: boolean; onOpenChange: (open: boolean) => void
  title: string; description: string; prompt: string
  job?: GeminiJobView | null; note?: string
}) {
  const { toast } = useToast()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(prompt)
    setCopied(true)
    toast({ title: 'Prompt copied', description: 'Paste it into a new Gemini chat.' })
  }
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) setCopied(false); onOpenChange(o) }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {job && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-xs">{job.ref}</span>
            <JobBadge job={job} />
            {job.state === 'preparing' || job.state === 'queued'
              ? <span className="text-muted-foreground">You can paste it now: until the pages are in Drive, Gemini hears "preparing".</span>
              : null}
            {job.driveFolderUrl && (
              <a className="ml-auto inline-flex items-center gap-1 text-primary hover:underline" href={job.driveFolderUrl} target="_blank" rel="noreferrer">
                Drive folder <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        )}
        {note && <p className="text-sm text-muted-foreground">{note}</p>}
        <textarea readOnly value={prompt} className="h-72 w-full resize-none rounded-md border bg-muted p-3 font-mono text-xs" onFocus={e => e.currentTarget.select()} />
        <div className="flex justify-end">
          <Button onClick={copy}><Copy className="mr-2 h-4 w-4" />{copied ? 'Copied' : 'Copy prompt'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

const time = (iso: string) => new Date(iso).toLocaleTimeString()

/** A job's accepted steps (when, after how many rejections) and every refused submission with its problems. */
export function JobLogDialog({ job, onOpenChange }: { job: GeminiJobView; onOpenChange: (open: boolean) => void }) {
  const [log, setLog] = useState<GeminiJobLog | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { geminiMcpApi.log(job.id).then(setLog).catch(e => setError((e as Error).message)) }, [job.id])
  const events = log ? [
    ...log.steps.map(s => ({ at: s.at, kind: 'accepted' as const, key: s.key, text: s.rejected ? `accepted after ${s.rejected} rejected` : 'accepted' })),
    ...log.rejections.map(r => ({ at: r.at, kind: 'rejected' as const, key: r.key, text: r.problems.join(' ') }))
  ].sort((a, b) => a.at.localeCompare(b.at)) : []
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Log · {job.ref}</DialogTitle>
          <DialogDescription>
            {log?.startedAt ? `Gemini started at ${new Date(log.startedAt).toLocaleString()}.` : 'Gemini has not started this job.'}{' '}
            {timingText(job) ?? ''}
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="max-h-[60vh] space-y-1.5 overflow-y-auto text-sm">
          {log && !events.length && <p className="text-muted-foreground">Nothing submitted yet.</p>}
          {events.map((e, i) => (
            <div key={i} className="flex gap-3">
              <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{time(e.at)}</span>
              <span className="w-24 shrink-0 font-mono text-xs">{e.key}</span>
              <span className={e.kind === 'rejected' ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}>{e.text}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
