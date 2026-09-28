/**
 * The ChatGPT loop run through the OpenAI API, for Clipper3ImageList.
 *
 * The server does the work (services/clipper3/openaiAuto.ts): per page it
 * builds the verified package, sends prompt + slices, imports the reply, runs
 * review rounds in the same conversation and exports the finished page. This
 * file is only the chapter-page surface for it:
 *
 *  - useAutoRun: the chapter's run, polled while it is going (a run survives a
 *    page reload — the server keeps it — so the first poll picks it back up);
 *  - AutoRunDialog: what to run, with the model/key status from Settings;
 *  - AutoRunStrip: progress under the header, with Stop;
 *  - AutoRunBadge: one page's step on its row.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { AlertTriangle, Bot, CheckCircle2, Loader2, Square, X, XCircle } from 'lucide-react'
import {
  clipper3Api,
  type Clipper3AutoJob,
  type Clipper3AutoPage,
  type Clipper3AutoStep,
  type Clipper3Image,
  type Clipper3OpenAiSettings
} from '@/lib/api'

const POLL_MS = 2500

const ACTIVE_STEPS: Clipper3AutoStep[] = ['packaging', 'analyzing', 'reviewing', 'exporting']
const FINISHED_STEPS: Clipper3AutoStep[] = ['done', 'ready', 'needs_review', 'failed', 'cancelled']

export function isActiveStep(step: Clipper3AutoStep): boolean {
  return ACTIVE_STEPS.includes(step)
}

// ============ Hook ============

export function useAutoRun(chapterId: string | undefined, onFinished: (job: Clipper3AutoJob) => void) {
  const { toast } = useToast()
  const [job, setJob] = useState<Clipper3AutoJob | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const wasRunning = useRef(false)
  const finishedRef = useRef(onFinished)
  finishedRef.current = onFinished

  const refresh = useCallback(async () => {
    if (!chapterId) return
    try {
      const { job: fresh } = await clipper3Api.getAutoRun(chapterId)
      setJob(fresh)
      if (fresh && wasRunning.current && !fresh.running) {
        const count = (step: Clipper3AutoStep) => fresh.pages.filter(p => p.step === step).length
        const failed = count('failed')
        const open = count('needs_review')
        toast({
          title: fresh.cancelled ? 'ChatGPT API run stopped' : 'ChatGPT API run finished',
          description:
            [
              count('done') && `${count('done')} exported`,
              count('ready') && `${count('ready')} ready to export`,
              open && `${open} need a manual look`,
              failed && `${failed} failed`,
              count('cancelled') && `${count('cancelled')} not run`
            ].filter(Boolean).join(' · ') || 'Nothing was run',
          variant: failed > 0 ? 'destructive' : undefined
        })
        finishedRef.current(fresh)
      }
      wasRunning.current = !!fresh?.running
    } catch {
      // Transient; the next poll tries again.
    }
  }, [chapterId, toast])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!job?.running) return
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => clearInterval(timer)
  }, [job?.running, refresh])

  const start = useCallback(async (filenames: string[], exportPages: boolean) => {
    if (!chapterId) return
    const { job: started } = await clipper3Api.startAutoRun(chapterId, filenames, exportPages)
    wasRunning.current = true
    setDismissed(false)
    setJob(started)
  }, [chapterId])

  const cancel = useCallback(async () => {
    if (!chapterId) return
    const { job: after } = await clipper3Api.cancelAutoRun(chapterId)
    if (after) setJob(after)
  }, [chapterId])

  const pageStatus = useCallback(
    (filename: string): Clipper3AutoPage | null => job?.pages.find(p => p.filename === filename) ?? null,
    [job]
  )

  return {
    job,
    running: !!job?.running,
    visible: !!job && (job.running || !dismissed),
    dismiss: () => setDismissed(true),
    start,
    cancel,
    pageStatus
  }
}

// ============ Dialog ============

export function AutoRunDialog({
  open,
  onOpenChange,
  images,
  onStart
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  images: Clipper3Image[]
  onStart: (filenames: string[], exportPages: boolean) => Promise<void>
}) {
  const { toast } = useToast()
  const [settings, setSettings] = useState<Clipper3OpenAiSettings | null>(null)
  const [includeDone, setIncludeDone] = useState(false)
  const [exportPages, setExportPages] = useState(true)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (!open) return
    clipper3Api.getOpenAiSettings().then(setSettings).catch(() => setSettings(null))
  }, [open])

  const pending = images.filter(img => img.status !== 'done')
  const targets = includeDone ? images : pending

  const start = async () => {
    setStarting(true)
    try {
      await onStart(targets.map(img => img.filename), exportPages)
      onOpenChange(false)
    } catch (err) {
      toast({ title: 'Could not start', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setStarting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5" />
            Run ChatGPT via API
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          For each page: build the verified package, send the slices to ChatGPT, import its crops, let it
          do the review rounds, then export — the same steps as the page dialog, without copy and paste.
        </p>

        {settings && !settings.hasKey ? (
          <div className="rounded border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="inline h-4 w-4 mr-1 text-amber-500" />
            No OpenAI API key yet.{' '}
            <Link to="/settings?tab=crop3-prompts" className="underline">Add it in Settings → Crop 3.0</Link>.
          </div>
        ) : settings ? (
          <p className="text-xs text-muted-foreground">
            Model <span className="font-mono text-foreground">{settings.model}</span>
            {settings.reasoningEffort && <> ({settings.reasoningEffort} effort)</>} ·{' '}
            {settings.reviewRounds} review round{settings.reviewRounds === 1 ? '' : 's'} max ·{' '}
            {settings.concurrency} page{settings.concurrency === 1 ? '' : 's'} at a time ·{' '}
            crop rules {settings.includeRules ? 'included' : 'not sent'} ·{' '}
            <Link to="/settings?tab=crop3-prompts" className="underline">change</Link>
          </p>
        ) : null}

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="auto-include-done" className="text-sm font-normal">
              Also re-run pages already Done
              <span className="block text-xs text-muted-foreground">
                Their current crops are replaced on export (the old files are kept in the export history).
              </span>
            </Label>
            <Switch id="auto-include-done" checked={includeDone} onCheckedChange={setIncludeDone} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="auto-export" className="text-sm font-normal">
              Export pages that pass review
              <span className="block text-xs text-muted-foreground">
                Off: stop at "ready to export" so you can look first.
              </span>
            </Label>
            <Switch id="auto-export" checked={exportPages} onCheckedChange={setExportPages} />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={start} disabled={starting || targets.length === 0 || (settings !== null && !settings.hasKey)}>
            {starting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Bot className="h-4 w-4 mr-2" />}
            Run {targets.length} page{targets.length === 1 ? '' : 's'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ============ Strip + badge ============

export function AutoRunStrip({
  job,
  onCancel,
  onDismiss
}: {
  job: Clipper3AutoJob
  onCancel: () => void
  onDismiss: () => void
}) {
  const finished = job.pages.filter(p => FINISHED_STEPS.includes(p.step)).length
  const active = job.pages.filter(p => isActiveStep(p.step))
  const tokens = job.pages.reduce((n, p) => n + p.tokens, 0)
  const count = (step: Clipper3AutoStep) => job.pages.filter(p => p.step === step).length

  return (
    <div className="border-b bg-card px-4 py-2 flex items-center gap-3 flex-shrink-0">
      <Bot className="h-4 w-4 text-primary flex-shrink-0" />
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        ChatGPT API {finished}/{job.pages.length}
      </span>
      <Progress value={job.pages.length > 0 ? (finished / job.pages.length) * 100 : 0} className="flex-1 h-2" />
      <span className="text-xs text-muted-foreground truncate max-w-[340px]">
        {job.running
          ? active.map(p => `${p.filename}: ${p.message}`).join(' · ') || 'Starting…'
          : [
              count('done') && `${count('done')} exported`,
              count('ready') && `${count('ready')} ready`,
              count('needs_review') && `${count('needs_review')} need a look`,
              count('failed') && `${count('failed')} failed`,
              count('cancelled') && `${count('cancelled')} not run`
            ].filter(Boolean).join(' · ')}
      </span>
      {tokens > 0 && (
        <span className="text-[11px] text-muted-foreground font-mono whitespace-nowrap" title="Tokens used by this run">
          {tokens.toLocaleString()} tok
        </span>
      )}
      {job.running ? (
        <Button variant="outline" size="sm" className="h-7" onClick={onCancel} disabled={job.cancelled}>
          <Square className="h-3 w-3 mr-1" />
          {job.cancelled ? 'Stopping…' : 'Stop'}
        </Button>
      ) : (
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onDismiss} title="Dismiss">
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}

const STEP_LABEL: Record<Clipper3AutoStep, string> = {
  queued: 'Queued',
  packaging: 'Packaging',
  analyzing: 'Analyzing',
  reviewing: 'Reviewing',
  exporting: 'Exporting',
  done: 'Exported',
  ready: 'Ready',
  needs_review: 'Needs look',
  failed: 'API failed',
  cancelled: 'Not run'
}

export function AutoRunBadge({ page }: { page: Clipper3AutoPage }) {
  const title = [page.message, ...page.blockers.slice(0, 8)].join('\n')
  const label = page.step === 'reviewing' && page.round > 0 ? `Review ${page.round}` : STEP_LABEL[page.step]

  if (isActiveStep(page.step)) {
    return (
      <Badge variant="outline" className="flex items-center gap-1 flex-shrink-0 text-primary border-primary/50" title={title}>
        <Loader2 className="h-3 w-3 animate-spin" />
        {label}
      </Badge>
    )
  }
  if (page.step === 'done' || page.step === 'ready') {
    return (
      <Badge variant="outline" className="flex items-center gap-1 flex-shrink-0 text-green-600 border-green-600/50" title={title}>
        <CheckCircle2 className="h-3 w-3" />
        {label}
      </Badge>
    )
  }
  if (page.step === 'failed' || page.step === 'needs_review') {
    return (
      <Badge
        variant="outline"
        className={`flex items-center gap-1 flex-shrink-0 ${page.step === 'failed' ? 'text-destructive border-destructive/50' : 'text-amber-500 border-amber-500/50'}`}
        title={title}
      >
        {page.step === 'failed' ? <XCircle className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
        {label}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="flex-shrink-0 text-muted-foreground" title={title}>
      {label}
    </Badge>
  )
}
