/**
 * Run automation's "What the phone needs" checklist (server: phoneReadiness.ts):
 * for the run and series picked in step 2, whether the phone has what that run
 * works from (the chapters' pages, Editor 2.0's packages and prompt, the
 * scripts to voice), with a button for each thing that can be sent from here,
 * and "Get everything ready", which sends them all.
 *
 * It follows the phone live: a pushed receipt (the phone reporting chapters as
 * they land) or the end of a send reloads it. Editor 2.0's check LISTs R2, so
 * that one reloads only after a fix or on "Check again", never on a push.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, CheckCircle2, CircleDashed, Info, Loader2, RefreshCw, Send, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import {
  r2Api,
  type PhoneReadinessFixAction,
  type PhoneReadinessItem,
  type PhoneReadinessState,
  type PhoneRunKind,
  type PhoneRunReadiness,
  type PhoneSendJob
} from '@/lib/api'
import type { NarrationLanguage } from '@/lib/narrationLanguage'
import { useSocket } from '@/lib/socket'
import { cn } from '@/lib/utils'
import { readSavedEditorPrompt } from '@/pages/editor2/phoneEditor'

/** The fixes "Get everything ready" runs, in this order: the prompt and packages are quick, pages take a while. */
const FIX_ORDER: PhoneReadinessFixAction[] = ['send_prompt', 'send_editor', 'send_pages', 'ask_download']

/** A run of phone receipts comes in bursts (one per chapter landing): reload once they settle. */
const RELOAD_SETTLE_MS = 800

export interface RunReadiness {
  readiness: PhoneRunReadiness | null
  loading: boolean
  error: string | null
  /** The send to the phones going now, if any (any series). */
  job: PhoneSendJob | null
  /** The fix being sent, or 'all'. */
  fixing: PhoneReadinessFixAction | 'all' | null
  /** Items a button here can fix (not "run Narration first"). */
  fixable: PhoneReadinessItem[]
  reload: () => void
  fix: (item: PhoneReadinessItem) => Promise<boolean>
  fixAll: () => Promise<boolean>
}

/**
 * The checklist for `kind` on `seriesId` (null: none, e.g. Image Clipper going
 * on with the phone's last run). `onRunNarration` is the voiceover's fix: its
 * scripts come from a Narration scripts run.
 */
export function useRunReadiness(
  kind: PhoneRunKind | null,
  seriesId: string,
  language: NarrationLanguage,
  onRunNarration: () => void
): RunReadiness {
  const { socket } = useSocket()
  const { toast } = useToast()
  const [readiness, setReadiness] = useState<PhoneRunReadiness | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<PhoneSendJob | null>(null)
  const [fixing, setFixing] = useState<RunReadiness['fixing']>(null)
  // Only Editor 2.0 and the voiceover differ by language: the others don't reload on a change of it.
  const lang = kind === 'editor' || kind === 'voiceover' ? language : 'en'
  const target = kind && seriesId ? `${kind}:${seriesId}:${lang}` : null
  const current = useRef(target)
  current.current = target

  const load = useCallback(async () => {
    if (!kind || !seriesId) return
    const asked = `${kind}:${seriesId}:${lang}`
    setLoading(true)
    try {
      const next = await r2Api.getRunReadiness(kind, seriesId, lang)
      if (current.current !== asked) return
      setReadiness(prev => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      setError(null)
    } catch (e) {
      if (current.current === asked) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (current.current === asked) setLoading(false)
    }
  }, [kind, seriesId, lang])

  useEffect(() => {
    setReadiness(null)
    setError(null)
    if (target) void load()
  }, [target, load])

  // Live: the phone's receipts (chapters landing) and the send's progress.
  useEffect(() => {
    if (!socket || !target) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const soon = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(), RELOAD_SETTLE_MS)
    }
    const onReceipt = () => { if (kind !== 'editor') soon() }
    const onProgress = (next: PhoneSendJob) => {
      setJob(next.state === 'running' ? next : null)
      if (next.state !== 'running') soon()
    }
    socket.on('phone:receipt', onReceipt)
    socket.on('phone-send:progress', onProgress)
    return () => {
      if (timer) clearTimeout(timer)
      socket.off('phone:receipt', onReceipt)
      socket.off('phone-send:progress', onProgress)
    }
  }, [socket, target, kind, load])

  /** Sends one fix; resolves true when it went. Toasts only failures when `quiet`. */
  const send = useCallback(async (item: PhoneReadinessItem, quiet: boolean): Promise<boolean> => {
    const fix = item.fix
    if (!fix || !seriesId) return false
    if (fix.action === 'run_narration') {
      onRunNarration()
      return true
    }
    try {
      let prompt: string | undefined
      if (fix.action === 'send_prompt') {
        prompt = readSavedEditorPrompt()
        if (!prompt) throw new Error('No Editor 2.0 prompt is saved in this browser: save it in Settings → Editor 2.0 first.')
      }
      const done = await r2Api.fixRunReadiness({ action: fix.action, seriesId, chapterIds: fix.chapterIds, prompt })
      if (!quiet) toast({ title: fix.label, description: done.message })
      return true
    } catch (e) {
      toast({ title: `Couldn’t ${fix.label.charAt(0).toLowerCase()}${fix.label.slice(1)}`, description: e instanceof Error ? e.message : String(e), variant: 'destructive' })
      return false
    }
  }, [seriesId, onRunNarration, toast])

  const fix = useCallback(async (item: PhoneReadinessItem) => {
    if (!item.fix) return false
    setFixing(item.fix.action)
    try {
      const ok = await send(item, false)
      if (ok && item.fix.action !== 'run_narration') await load()
      return ok
    } finally {
      setFixing(null)
    }
  }, [send, load])

  const fixable = (readiness?.items ?? []).filter(i => i.fix && i.fix.action !== 'run_narration' && (i.state === 'missing' || i.state === 'waiting'))

  const fixAll = useCallback(async () => {
    const items = [...fixable].sort((a, b) => FIX_ORDER.indexOf(a.fix!.action) - FIX_ORDER.indexOf(b.fix!.action))
    // A send of pages asks the phones to download once it's up: no need to ask now as well.
    const sendsPages = items.some(i => i.fix!.action === 'send_pages')
    setFixing('all')
    try {
      let ok = true
      for (const item of items) {
        if (sendsPages && item.fix!.action === 'ask_download') continue
        ok = (await send(item, true)) && ok
      }
      await load()
      return ok
    } finally {
      setFixing(null)
    }
  }, [fixable, send, load])

  return { readiness, loading, error, job, fixing, fixable, reload: load, fix, fixAll }
}

const STATE_ICON: Record<PhoneReadinessState, { icon: typeof CheckCircle2; className: string }> = {
  ready: { icon: CheckCircle2, className: 'text-emerald-500' },
  waiting: { icon: CircleDashed, className: 'text-sky-500' },
  missing: { icon: XCircle, className: 'text-amber-500' },
  blocked: { icon: AlertTriangle, className: 'text-red-500' },
  note: { icon: Info, className: 'text-muted-foreground' }
}

/** How far the send going now is, in a line. */
function sendLine(job: PhoneSendJob): string {
  const sending = job.series.find(s => s.state === 'sending') ?? job.series[0]
  if (!sending) return 'Sending to R2…'
  const percent = sending.bytesTotal ? Math.round((sending.bytesDone / sending.bytesTotal) * 100) : 0
  return `Sending ${sending.title} to R2: ${sending.chaptersSent} of ${sending.chaptersTotal} chapters (${percent}%)…`
}

/** The checklist itself, under the series in step 2. */
export function RunReadinessPanel({ state }: { state: RunReadiness }) {
  const { readiness, loading, error, job, fixing, reload, fix } = state
  if (!readiness) {
    return (
      <div className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
        {error
          ? <span className="text-red-500">{error}</span>
          : <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Checking what the phone has…</span>}
      </div>
    )
  }
  return (
    <div className="space-y-2 rounded-md border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">What the phone needs</p>
        {readiness.ready && <span className="text-xs text-emerald-500">All there</span>}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2 text-xs"
          onClick={reload}
          disabled={loading}
          title="Check again"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </div>
      <ul className="space-y-2">
        {readiness.items.map(item => {
          const { icon: Icon, className } = STATE_ICON[item.state]
          const busy = fixing === 'all' || fixing === item.fix?.action
          return (
            <li key={item.id} className="flex items-start gap-2 text-sm">
              <Icon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', className)} />
              <div className="min-w-0 flex-1 space-y-1">
                <p>
                  <span className="font-medium">{item.label}</span>
                  <span className="text-muted-foreground"> · {item.detail}</span>
                </p>
                {(item.fix || item.link) && (
                  <div className="flex flex-wrap gap-2">
                    {item.fix && (
                      <Button
                        type="button"
                        size="sm"
                        variant={item.state === 'missing' ? 'default' : 'outline'}
                        className="h-7 text-xs"
                        disabled={fixing !== null || (item.fix.action === 'send_pages' && readiness.sending)}
                        onClick={() => void fix(item)}
                      >
                        {busy
                          ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          : item.fix.action === 'run_narration' ? <ArrowRight className="mr-1.5 h-3.5 w-3.5" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                        {item.fix.label}
                      </Button>
                    )}
                    {item.link && (
                      <Button asChild type="button" size="sm" variant="ghost" className="h-7 text-xs">
                        <Link to={item.link.to}>{item.link.label}</Link>
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {(job || readiness.sending) && (
        <p className="flex items-center gap-1.5 text-xs text-sky-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {job ? sendLine(job) : 'Sending to R2…'}
        </p>
      )}
    </div>
  )
}
