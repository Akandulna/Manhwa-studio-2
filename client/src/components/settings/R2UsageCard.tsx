import { useEffect, useState } from 'react'
import { r2Api, type R2Usage } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { AlertTriangle, CheckCircle, Gauge, Loader2, RefreshCw, ShieldCheck, Trash2, XCircle } from 'lucide-react'

type Level = 'ok' | 'near' | 'over'

/** Past 80% is "near": one more large series could tip it. */
function levelOf(used: number, limit: number): Level {
  const ratio = limit > 0 ? used / limit : 0
  return ratio >= 1 ? 'over' : ratio >= 0.8 ? 'near' : 'ok'
}

const LEVEL = {
  ok: { label: 'Within free plan', icon: CheckCircle, iconClass: 'text-green-500', fill: 'bg-green-500' },
  near: { label: 'Near the limit', icon: AlertTriangle, iconClass: 'text-amber-500', fill: 'bg-amber-500' },
  over: { label: 'Over the free plan', icon: XCircle, iconClass: 'text-destructive', fill: 'bg-destructive' }
} as const

/** Decimal units, to match how Cloudflare states the 10 GB allowance. */
function formatSize(bytes: number): string {
  if (bytes >= 1000 ** 3) return `${(bytes / 1000 ** 3).toFixed(2)} GB`
  if (bytes >= 1000 ** 2) return `${(bytes / 1000 ** 2).toFixed(1)} MB`
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(0)} KB`
  return `${bytes} B`
}

function formatUtcDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

function Meter({ label, used, limit, usedText, limitText, hint }: {
  label: string
  used: number
  limit: number
  usedText: string
  limitText: string
  hint: string
}) {
  const level = levelOf(used, limit)
  const { label: levelLabel, icon: Icon, iconClass, fill } = LEVEL[level]
  const pct = limit > 0 ? (used / limit) * 100 : 0
  // Show a sliver for any non-zero use, so "a little" never reads as "none".
  const width = used > 0 ? Math.max(1, Math.min(100, pct)) : 0

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-medium">{label}</span>
        <span className="text-sm tabular-nums">
          {usedText} <span className="text-muted-foreground">of {limitText} · {pct < 1 && used > 0 ? '<1' : Math.round(pct)}%</span>
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-secondary"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
      >
        <div className={`h-full rounded-full ${fill} transition-all`} style={{ width: `${width}%` }} />
      </div>
      <div className="flex items-center justify-between gap-4 text-xs">
        <span className="text-muted-foreground">{hint}</span>
        <span className="flex shrink-0 items-center gap-1">
          <Icon className={`h-3.5 w-3.5 ${iconClass}`} />
          {levelLabel}
        </span>
      </div>
    </div>
  )
}

/**
 * Settings → Cloudflare: the three meters Cloudflare bills R2 on, against the
 * free plan. Storage is measured from the bucket; requests are what this app
 * has sent this month. Uploads that would go past either are blocked on the
 * server, so this card is for seeing headroom and freeing space.
 */
export function R2UsageCard() {
  const { toast } = useToast()
  const [usage, setUsage] = useState<R2Usage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      setUsage(await r2Api.getUsage())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read R2 usage')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const remove = async (key: string) => {
    if (!window.confirm(`Delete "${key}" from the bucket? This cannot be undone.`)) return
    setDeleting(key)
    try {
      await r2Api.deleteObject(key)
      toast({ title: 'Backup deleted', description: key })
      await load()
    } catch (err) {
      toast({ title: 'Delete failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setDeleting(null)
    }
  }

  const monthLabel = usage
    ? new Date(`${usage.month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    : ''
  // On the first month the ledger starts mid-month; say so rather than imply a full count.
  const countingSinceMidMonth = usage ? new Date(usage.ops.since).getUTCDate() > 1 : false
  const opBreakdown = usage
    ? Object.entries(usage.ops.ops).sort((a, b) => b[1] - a[1]).map(([op, n]) => `${op} ${n.toLocaleString()}`).join(' · ')
    : ''

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Gauge className="h-5 w-5" />
              Free plan usage
            </CardTitle>
            <CardDescription>
              {usage
                ? <>{monthLabel} · request counts reset {formatUtcDay(usage.resetsAt)} (UTC) · bucket <code>{usage.bucket}</code></>
                : 'R2 storage and requests against the free plan.'}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : !usage ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Measuring the bucket…
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
              <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-green-500" />
              <span>
                Uploads that would go past the free plan are <strong>blocked</strong> before anything is zipped or sent,
                so Upload to R2 never costs money.
              </span>
            </div>

            <Meter
              label="Storage"
              used={usage.storage.bytes}
              limit={usage.limits.storageBytes}
              usedText={formatSize(usage.storage.bytes)}
              limitText={formatSize(usage.limits.storageBytes)}
              hint={`${usage.storage.objectCount} object${usage.storage.objectCount === 1 ? '' : 's'} in the bucket, measured from R2 (refreshes at most once a minute). Deleting frees it immediately.`}
            />
            <Meter
              label="Class A requests"
              used={usage.ops.classA}
              limit={usage.limits.classA}
              usedText={usage.ops.classA.toLocaleString()}
              limitText={usage.limits.classA.toLocaleString()}
              hint="Writes and lists — about one per 16 MB uploaded."
            />
            <Meter
              label="Class B requests"
              used={usage.ops.classB}
              limit={usage.limits.classB}
              usedText={usage.ops.classB.toLocaleString()}
              limitText={usage.limits.classB.toLocaleString()}
              hint="Reads — connection tests and downloads."
            />

            <p className="text-xs text-muted-foreground">
              Storage is exact. Requests are the ones Manhwa Studio sent
              {countingSinceMidMonth ? ` since ${formatUtcDay(usage.ops.since)}` : ' this month'}; browsing the bucket in
              the Cloudflare dashboard adds a few that are not counted here. Deletes are free.
              {opBreakdown && <><br />Counted: {opBreakdown}</>}
            </p>

            <div className="space-y-2">
              <h4 className="text-sm font-medium">In the bucket</h4>
              {usage.storage.objects.length === 0 ? (
                <p className="text-sm text-muted-foreground">No backups yet.</p>
              ) : (
                <div className="rounded-md border divide-y">
                  {usage.storage.objects.map(obj => (
                    <div key={obj.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <span className="flex-1 truncate font-mono" title={obj.key}>{obj.key}</span>
                      <span className="w-24 text-right tabular-nums">{formatSize(obj.size)}</span>
                      <span className="w-28 text-right text-muted-foreground">
                        {obj.lastModified ? new Date(obj.lastModified).toLocaleDateString() : ''}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => remove(obj.key)}
                        disabled={deleting !== null}
                        title="Delete from bucket"
                      >
                        {deleting === obj.key
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <Trash2 className="h-4 w-4" />}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
