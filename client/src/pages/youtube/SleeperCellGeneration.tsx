import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Loader2, Smartphone, RefreshCw, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { youtubeApi, type YouTubeJob, type YouTubeWorkspace } from '@/lib/youtube'

type Kind = 'titles' | 'descriptions' | 'thumbnail_prepare' | 'thumbnail_generate'
type Phone = Awaited<ReturnType<typeof youtubeApi.automationPhones>>[number]

/** Titles and descriptions run in AI Studio on the phone; thumbnails need ChatGPT's images. */
const aiStudio = (kind: Kind) => kind === 'titles' || kind === 'descriptions'
function capable(kind: Kind, phone: Phone) {
  if (aiStudio(kind)) return !!phone.aiStudioText
  return kind === 'thumbnail_generate' ? !!phone.thumbnailGeneration : !!phone.thumbnailPreparation
}
function withCapability(kind: Kind, list: Phone[]): Phone[] {
  return list.map(p => p.ready && !capable(kind, p) ? { ...p, ready: false, reason: aiStudio(kind) ? 'Update beta for AI Studio titles' : 'Update beta for thumbnail automation' } : p)
}
/** The phone may still be working on it, so Studio keeps checking. */
const pending = (job: YouTubeJob) => job.status === 'waiting' || job.status === 'dispatching'

export default function SleeperCellGeneration({ workspace, requestId, kind, onSaved, slot }: { workspace: YouTubeWorkspace; requestId: string; kind: Kind; slot?: number; onSaved: (w: YouTubeWorkspace) => void }) {
  const [phones, setPhones] = useState<Phone[]>([])
  const [device, setDevice] = useState('')
  const [job, setJob] = useState<YouTubeJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [confirmRetry, setConfirmRetry] = useState(false)
  const mounted = useRef(true)
  const onSavedRef = useRef(onSaved); onSavedRef.current = onSaved
  const shown = useRef('')

  function applyPhones(list: Phone[], preferred?: string) {
    const usable = withCapability(kind, list)
    setPhones(usable)
    setDevice(current => {
      const keep = [current, preferred].find(id => id && usable.some(p => p.id === id && p.ready))
      return keep ?? usable.find(p => p.ready)?.id ?? ''
    })
  }

  useEffect(() => {
    mounted.current = true
    void Promise.all([youtubeApi.automationPhones(), youtubeApi.automationLatest(workspace.seriesId, kind, requestId, slot)])
      .then(([list, saved]) => { if (!mounted.current) return; applyPhones(list, saved?.device); setJob(saved) })
      .catch(e => { if (mounted.current) setError(e.message) })
      .finally(() => { if (mounted.current) setLoading(false) })
    return () => { mounted.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.seriesId, kind, requestId, slot])

  useEffect(() => {
    if (!job) return
    if (job.status === 'done') {
      if (shown.current !== job.id) {
        shown.current = job.id
        void youtubeApi.openWorkspace(workspace.seriesId).then(w => { if (mounted.current) onSavedRef.current(w) }).catch(e => { shown.current = ''; if (mounted.current) setError(e.message) })
      }
      return
    }
    // Keep checking until the server settles the job, including past its 30-minute expiry, so it never spins forever.
    if (!pending(job)) return
    let stopped = false
    const timer = setInterval(() => {
      void youtubeApi.automationCheck(workspace.seriesId, job.id)
        .then(next => { if (!stopped && mounted.current) setJob(next) })
        .catch(e => { if (!stopped && mounted.current) setError(e.message) })
    }, 15000)
    return () => { stopped = true; clearInterval(timer) }
  }, [job, workspace.seriesId])

  async function act(task: () => Promise<YouTubeJob>, failure: string) {
    setBusy(true); setError(''); setConfirmRetry(false)
    try { const next = await task(); if (mounted.current) setJob(next) }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : failure) }
    finally { if (mounted.current) setBusy(false) }
  }
  const start = () => act(() => youtubeApi.automationStart(workspace.seriesId, kind, requestId, device, workspace.titles.revision, slot), 'Could not start automation')
  const cancel = () => job && act(() => youtubeApi.automationCancel(workspace.seriesId, job.id), 'Could not cancel')
  const retry = () => job && act(() => youtubeApi.automationRetry(workspace.seriesId, job.id, device, workspace.titles.revision), 'Could not retry')
  const retryImage = () => job && act(() => youtubeApi.automationRetryImage(workspace.seriesId, job.id), 'Could not retry transfer')
  async function refresh() {
    setBusy(true); setError('')
    try {
      const list = await youtubeApi.automationPhones()
      if (!mounted.current) return
      applyPhones(list)
      if (job && pending(job)) setJob(await youtubeApi.automationCheck(workspace.seriesId, job.id))
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'Could not refresh phones') }
    finally { if (mounted.current) setBusy(false) }
  }

  const deviceReady = phones.some(p => p.id === device && p.ready)
  const actionLabel = kind === 'thumbnail_generate' ? `Generate variation ${(slot ?? 0) + 1}` : kind === 'thumbnail_prepare' ? 'Prepare variation in ChatGPT' : `Generate ${kind === 'titles' ? 'titles' : 'descriptions'}`
  const help = kind === 'thumbnail_generate' ? 'Attaches the references, generates one image in ChatGPT, and saves it here for review. Your selected thumbnail stays as it is.'
    : kind === 'thumbnail_prepare' ? 'Copies this variation’s prompt and attaches the selected references. Stops before Send.'
    : phones.length ? 'Uses AI Studio on the phone (Gemini 4 Hydrogen · High, Google Search on) with its narration profile. Keep it signed in and enable Start from Manhwa Studio.'
    : 'Connect a Sleeper Cell phone with the YouTube beta update. You can use the manual controls below meanwhile.'
  const picker = <select aria-label="Sleeper Cell phone" value={device} onChange={e => setDevice(e.target.value)} disabled={busy} className="min-w-0 flex-1 rounded-md border bg-background p-2 text-xs"><option value="">Choose a phone</option>{phones.map(p => <option key={p.id} value={p.id} disabled={!p.ready}>{p.name}{p.ready ? '' : ` · ${p.reason}`}</option>)}</select>

  let body: ReactNode
  if (loading) body = <p className="text-xs text-muted-foreground">Checking phones…</p>
  else if (!job) body = <><div className="flex flex-col gap-2 sm:flex-row">{picker}<Button size="sm" disabled={busy || !deviceReady} onClick={() => void start()}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Smartphone className="mr-2 h-4 w-4" />}{actionLabel}</Button></div><p className="text-xs leading-relaxed text-muted-foreground">{help}</p></>
  else body = <div role="status" className="space-y-2 text-sm">
    <p className="flex items-start gap-2">{job.status === 'done' ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : pending(job) ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" /> : job.status === 'cancelled' ? <X className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : null}{job.message}</p>
    {pending(job) && job.phoneStep && <p className="text-xs text-muted-foreground">Phone: {job.phoneStep}</p>}
    {job.image && job.status === 'needs_attention' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void retryImage()}>Retry image transfer</Button>}
    {job.response && job.status === 'needs_attention' && <details><summary className="cursor-pointer text-xs">View returned response for manual import</summary><textarea readOnly value={job.response} aria-label="Sleeper Cell returned response" className="mt-2 h-40 w-full rounded border bg-background p-2 font-mono text-xs" /></details>}
    {pending(job) && !confirmRetry && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void cancel()}><X className="mr-2 h-3.5 w-3.5" />Cancel</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmRetry(true)}><RotateCcw className="mr-2 h-3.5 w-3.5" />Cancel &amp; retry</Button></div>}
    {job.status !== 'done' && !job.image && (!pending(job) || confirmRetry) && <div className="space-y-2 rounded-lg border bg-background/60 p-3">
      {confirmRetry && <p className="text-xs text-amber-600 dark:text-amber-400">If the phone already sent this prompt, it may be answered twice. Studio ignores the first answer once you retry.</p>}
      <div className="flex flex-col gap-2 sm:flex-row">{picker}<Button size="sm" disabled={busy || !deviceReady} onClick={() => void retry()}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}{confirmRetry ? 'Cancel & retry' : 'Retry'}</Button>{confirmRetry && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmRetry(false)}>Keep waiting</Button>}</div>
      <p className="text-xs text-muted-foreground">Sends the same prepared prompt again as a new request.</p>
    </div>}
  </div>

  return <section aria-label="Sleeper Cell generation" className="space-y-3 rounded-xl border border-primary/25 bg-primary/5 p-4">
    <div className="flex items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-sm font-semibold"><Smartphone className="h-4 w-4" />{kind.startsWith('thumbnail_') ? 'Generate thumbnail with Sleeper Cell' : 'Generate with Sleeper Cell'}</h3><Button size="sm" variant="ghost" disabled={busy || loading} onClick={() => void refresh()} aria-label="Refresh Sleeper Cell phones"><RefreshCw className="h-3.5 w-3.5" /></Button></div>
    {body}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>
}
