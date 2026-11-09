/**
 * Usage limits for both AntiGravity engines, shown on Running processes.
 *
 *   Google (Antigravity): live from `agy /usage` (the server caches it for
 *     two minutes; Refresh forces a new read). Bars show what is left.
 *   ChatGPT (Codex): each account's 5-hour and weekly windows as Codex last
 *     recorded them in its session files (updated after every Codex turn).
 *
 * Refreshes on mount, on Refresh, and (debounced) on local AntiGravity
 * progress events. Nothing here touches R2.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Gauge, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { aiUsageApi, type AiUsageLimits, type CodexRateLimits } from '@/lib/api'
import { useSocket } from '@/lib/socket'
import { cn } from '@/lib/utils'

const resetLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : null

const windowName = (w: string | null, fallback: string) =>
  w === 'weekly' ? 'Weekly' : w === 'daily' ? 'Daily' : w ? w.replace(/_/g, ' ') : fallback

/** One bar of what is left (0–100). */
function LeftBar({ label, left, resetsAt, title }: { label: string; left: number; resetsAt: string | null; title?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(left)))
  const tone = pct <= 10 ? 'bad' : pct <= 30 ? 'warn' : 'ok'
  return (
    <div className="space-y-0.5" title={title}>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className={cn('shrink-0 tabular-nums', tone === 'bad' ? 'text-destructive' : tone === 'warn' ? 'text-yellow-600 dark:text-yellow-400' : 'text-foreground')}>
          {pct}% left
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-muted">
        <div className={cn('h-full', tone === 'bad' ? 'bg-destructive' : tone === 'warn' ? 'bg-yellow-500' : 'bg-primary')} style={{ width: `${pct}%` }} />
      </div>
      {resetsAt && <div className="text-[10px] text-muted-foreground">resets {resetLabel(resetsAt)}</div>}
    </div>
  )
}

function CodexWindow({ label, window }: { label: string; window: CodexRateLimits['primary'] }) {
  if (!window) return null
  return <LeftBar label={label} left={100 - window.usedPercent} resetsAt={window.resetsAt} />
}

export function UsageLimitsPanel() {
  const { socket } = useSocket()
  const [data, setData] = useState<AiUsageLimits | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true)
    try {
      setData(await aiUsageApi.get(refresh))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => { void load(false) }, [load])
  // Runs change usage: follow local progress events, at most every 20 s (the server caches Google for 2 min).
  useEffect(() => {
    if (!socket) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const onProgress = () => { if (!timer) timer = setTimeout(() => { timer = null; void loadRef.current(false) }, 20_000) }
    socket.on('antigravity:progress', onProgress)
    return () => { socket.off('antigravity:progress', onProgress); if (timer) clearTimeout(timer) }
  }, [socket])

  const google = data?.google
  const codex = data?.codex.accounts ?? []

  return (
    <section className="space-y-2" aria-label="Usage limits">
      <div className="flex items-center justify-between px-1">
        <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"><Gauge className="h-3.5 w-3.5" /> Usage limits</h2>
        <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Refresh usage limits" title="Read the limits again now" disabled={loading} onClick={() => void load(true)}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {!data && !error && <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Reading limits…</div>}
      {error && <div className="px-1 text-xs text-destructive">{error}</div>}

      {data && (
        <div className="space-y-3 rounded-md border p-3">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">Google · Antigravity</span>
              {google?.checkedAt && <span className="shrink-0 text-[10px] text-muted-foreground" title={new Date(google.checkedAt).toLocaleString()}>live</span>}
            </div>
            {google?.account && <div className="truncate text-[11px] text-muted-foreground" title={google.account}>{google.account}</div>}
            {google?.quota?.groups.map(group => (
              <div key={group.name} className="space-y-1.5">
                {group.buckets.map(b => (
                  <LeftBar
                    key={b.id}
                    label={`${group.name} · ${windowName(b.window, b.name)}`}
                    left={(b.remainingFraction ?? 0) * 100}
                    resetsAt={b.resetTime}
                    title={[group.description, b.name].filter(Boolean).join(' — ')}
                  />
                ))}
              </div>
            ))}
            {google?.quota && google.quota.groups.length === 0 && <div className="text-xs text-muted-foreground">agy reported no limits.</div>}
            {google?.error && <div className="text-xs text-destructive">{google.error}</div>}
          </div>

          <div className="space-y-2 border-t pt-3">
            <span className="text-sm font-medium">ChatGPT · Codex</span>
            {codex.map(a => (
              <div key={a.id} className={cn('space-y-1.5', !a.enabled && 'opacity-60')}>
                <div className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="truncate font-medium" title={a.label}>{a.label}{a.limits?.planType ? <span className="font-normal text-muted-foreground"> · {a.limits.planType}</span> : null}</span>
                  {!a.enabled ? <span className="shrink-0 text-muted-foreground">off</span>
                    : a.limited && a.limitedUntil ? <span className="shrink-0 text-destructive">out until {resetLabel(a.limitedUntil)}</span> : null}
                </div>
                {a.limits && (a.limits.primary || a.limits.secondary) ? (
                  <>
                    <CodexWindow label="5-hour" window={a.limits.primary} />
                    <CodexWindow label="Weekly" window={a.limits.secondary} />
                    <div className="text-[10px] text-muted-foreground" title="Codex records its limits after each turn; Studio reads that record.">as of {new Date(a.limits.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
                  </>
                ) : (
                  <div className="text-[11px] text-muted-foreground">No usage recorded yet — it appears after the first Codex turn on this account.</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
