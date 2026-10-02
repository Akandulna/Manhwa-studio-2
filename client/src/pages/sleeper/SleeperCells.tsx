/**
 * Sleeper Cells — the Sleeper-Cell phone app at a glance: is it open, what
 * its Auto-run is clipping right now, how close each ChatGPT profile is to
 * its upload limit, and where every series stands on the phone.
 *
 * Everything comes from the three receipts the phone sends (see
 * usePhoneOverview): live through the phone relay, or on "Refresh from phone"
 * without it. The only timer re-renders the elapsed times, with no request.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  Clock,
  FileText,
  ImageUp,
  Pause,
  Smartphone,
  Upload
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { PhoneRefreshButton } from '@/components/PhoneRefreshButton'
import { PhoneUploadUsage } from '@/components/PhoneUploadUsage'
import { formatTook, PhoneSyncBadge } from '@/components/PhoneSyncBadge'
import { usePhoneOverview } from '@/hooks/usePhoneOverview'
import { usePhoneRelay } from '@/hooks/usePhoneRelay'
import type { PhoneOverview, PhoneOverviewFinish, PhoneOverviewWorking, RelayStatus } from '@/lib/api'
import { uploadUsage } from '@/lib/uploadUsage'
import { cn } from '@/lib/utils'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** The average time per page is read over this many recent Auto-run pages. */
const AVERAGE_OVER = 20
const RECENT_SHOWN = 15

function clock(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

function ago(iso: string | null, now: number): string {
  const at = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(at)) return 'never'
  const ms = Math.max(0, now - at)
  if (ms < MINUTE) return 'just now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`
  if (ms < 24 * HOUR) return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MINUTE)}m ago`
  return `${Math.floor(ms / (24 * HOUR))}d ago`
}

function chapterLabel(place: { chapter: string; chapterNumber: number | null }): string {
  return place.chapterNumber !== null ? `Ch. ${place.chapterNumber}` : place.chapter
}

/** The page name without its extension: page_004.webp → page_004. */
function pageLabel(page: string): string {
  return page.replace(/\.[a-z0-9]+$/i, '')
}

function Tile({ label, value, sub, className }: { label: string; value: React.ReactNode; sub?: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}

function Dot({ className }: { className: string }) {
  return <span className={cn('inline-block h-2.5 w-2.5 rounded-full', className)} />
}

/** Is the phone open, as far as can be told: only the relay knows; without it, only when it last reported. */
function phoneState(relay: RelayStatus | null, overview: PhoneOverview | null, now: number) {
  if (relay?.configured) {
    if (!relay.connected) {
      return { dot: 'bg-amber-500', label: 'Unknown', sub: 'Manhwa Studio can’t reach the relay' }
    }
    return relay.phones > 0
      ? { dot: 'bg-emerald-500', label: 'Open', sub: `Sleeper-Cell is open${relay.phones > 1 ? ` (${relay.phones} sockets)` : ''}` }
      : { dot: 'bg-muted-foreground/50', label: 'Closed', sub: `Last heard ${ago(overview?.reportedAt ?? null, now)}` }
  }
  return { dot: 'bg-muted-foreground/50', label: 'Unknown', sub: `No relay · last report ${ago(overview?.reportedAt ?? null, now)}` }
}

function relayState(relay: RelayStatus | null) {
  if (!relay?.configured) return { dot: 'bg-muted-foreground/50', label: 'Not set up', sub: 'Status comes from R2 on request' }
  if (!relay.connected) return { dot: 'bg-amber-500', label: 'Offline', sub: relay.lastError ?? 'Reconnecting…' }
  return { dot: 'bg-emerald-500', label: 'Live', sub: relay.lastReceiptAt ? `Last receipt ${clock(relay.lastReceiptAt)}` : 'No receipt yet' }
}

function WorkingRow({ working, averageTook, now }: { working: PhoneOverviewWorking; averageTook: number | null; now: number }) {
  const since = working.since ? Date.parse(working.since) : NaN
  const elapsed = Number.isNaN(since) ? null : Math.max(0, (now - since) / 1000)
  const overdue = elapsed !== null && averageTook !== null && elapsed > averageTook * 1.5
  const where = (
    <>
      <span className="font-medium">{working.series}</span>
      <span className="text-muted-foreground"> · {chapterLabel(working)} · </span>
      <span className="font-mono text-xs">{pageLabel(working.page)}</span>
    </>
  )
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm">
      {working.paused
        ? <Pause className="h-4 w-4 text-amber-500" />
        : <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-sky-500" /></span>}
      {working.chapterId
        ? <Link to={`/clipper3/chapter/${working.chapterId}`} className="hover:underline">{where}</Link>
        : <span>{where}</span>}
      {working.paused && <Badge variant="outline" className="border-amber-500 text-amber-600">Paused</Badge>}
      <span className={cn('ml-auto tabular-nums', overdue ? 'font-medium text-amber-600' : 'text-muted-foreground')}>
        {elapsed !== null ? formatTook(elapsed) : '—'}
        {averageTook !== null && <span className="text-muted-foreground"> / ~{formatTook(averageTook)} usual</span>}
      </span>
    </div>
  )
}

function FinishRow({ finish }: { finish: PhoneOverviewFinish }) {
  const model = finish.models[finish.models.length - 1]
  return (
    <tr className="border-t">
      <td className="py-1.5 pr-3 text-muted-foreground tabular-nums whitespace-nowrap">{clock(finish.at)}</td>
      <td className="py-1.5 pr-3 whitespace-nowrap">
        {finish.chapterId
          ? <Link to={`/clipper3/chapter/${finish.chapterId}`} className="hover:underline">{finish.series} · {chapterLabel(finish)}</Link>
          : <>{finish.series} · {chapterLabel(finish)}</>}
      </td>
      <td className="py-1.5 pr-3 font-mono text-xs">{pageLabel(finish.page)}</td>
      <td className="py-1.5 pr-3 tabular-nums whitespace-nowrap">{finish.took !== null ? formatTook(finish.took) : '—'}</td>
      <td className="py-1.5 text-xs text-muted-foreground whitespace-nowrap">
        {finish.run === 'manual' ? 'Pasted by hand' : [finish.account, model].filter(Boolean).join(' · ') || '—'}
        {finish.models.length > 1 && <span title={finish.models.join(' → ')}> (+{finish.models.length - 1} fix)</span>}
      </td>
    </tr>
  )
}

export default function SleeperCells() {
  const receipt = usePhoneOverview()
  const relay = usePhoneRelay()
  const overview = receipt.status
  const [now, setNow] = useState(() => Date.now())
  const [showAllRecent, setShowAllRecent] = useState(false)

  useEffect(() => {
    // Only the elapsed times move between receipts; tick every second while a page is running.
    const ticking = (overview?.working.length ?? 0) > 0
    const timer = setInterval(() => setNow(Date.now()), ticking ? 1000 : MINUTE)
    return () => clearInterval(timer)
  }, [overview?.working.length])

  const stats = useMemo(() => {
    if (!overview) return null
    const today = new Date(now).toDateString()
    const times = overview.recent.map(f => Date.parse(f.at))
    const doneToday = times.filter(t => new Date(t).toDateString() === today).length
    const doneLastHour = times.filter(t => now - t < HOUR).length
    const auto = overview.recent.filter(f => f.run !== 'manual' && f.took !== null).slice(0, AVERAGE_OVER)
    const averageTook = auto.length ? auto.reduce((sum, f) => sum + f.took!, 0) / auto.length : null
    const pagesLeft = overview.series.reduce((sum, s) => sum + (s.crops ? Math.max(0, s.crops.total - s.crops.done) : 0), 0)
    const uploadsLastDay = overview.profiles.reduce((sum, p) => sum + uploadUsage(p, now).lastDay, 0)
    // Pages per account today, busiest first.
    const accounts = new Map<string, number>()
    for (const f of overview.recent) {
      if (new Date(f.at).toDateString() !== today || f.run === 'manual') continue
      const name = f.account ?? f.profile ?? 'Unknown account'
      accounts.set(name, (accounts.get(name) ?? 0) + 1)
    }
    return {
      doneToday,
      doneLastHour,
      averageTook,
      pagesLeft,
      uploadsLastDay,
      byAccount: [...accounts.entries()].sort((a, b) => b[1] - a[1]),
      /** Hours to finish what the phone has, at the last hour's pace. */
      hoursLeft: doneLastHour > 0 && pagesLeft > 0 ? pagesLeft / doneLastHour : null,
      /** The recent list is capped, so "today" may be more than this on a very busy day. */
      capped: overview.recentCapped && new Date(overview.recent[overview.recent.length - 1].at).toDateString() === today
    }
  }, [overview, now])

  const phone = phoneState(relay, overview, now)
  const relayInfo = relayState(relay)
  const running = overview?.working.filter(w => !w.paused).length ?? 0
  const paused = (overview?.working.length ?? 0) - running

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Smartphone className="h-7 w-7 text-primary" />
            <h1 className="text-3xl font-bold">Sleeper Cells</h1>
          </div>
          <p className="mt-1 text-muted-foreground">
            The Sleeper-Cell phone app: whether it’s open, what Auto-run is clipping, its ChatGPT upload
            limits, and where each series stands on the phone.
          </p>
        </div>
        <PhoneRefreshButton receipt={receipt} size="default" />
      </div>

      {overview && !overview.configured && (
        <Card className="mb-6">
          <CardContent className="flex items-start gap-3 p-5 text-sm">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" />
            <div>
              <p className="font-medium">No way to hear from the phone yet</p>
              <p className="text-muted-foreground">
                Set up R2 or the phone relay in <Link to="/settings" className="underline">Settings → Cloudflare</Link>.
                Sleeper-Cell reports through the same bucket or relay.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Connection */}
      <Card className="mb-6">
        <CardContent className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Tile
              label="Phone"
              value={<span className="flex items-center gap-2"><Dot className={phone.dot} />{phone.label}</span>}
              sub={<>{phone.sub}{overview?.device && <> · {overview.device}</>}</>}
            />
            <Tile
              label="Relay"
              value={<span className="flex items-center gap-2"><Dot className={relayInfo.dot} />{relayInfo.label}</span>}
              sub={<span className="line-clamp-2" title={relayInfo.sub}>{relayInfo.sub}</span>}
            />
            <Tile
              label="Auto-run"
              value={running > 0 ? `${running} page${running === 1 ? '' : 's'}` : paused > 0 ? 'Paused' : 'Idle'}
              sub={running > 0
                ? `one per ChatGPT tab${paused ? ` · ${paused} paused` : ''}`
                : paused > 0 ? `${paused} page${paused === 1 ? '' : 's'} on hold` : 'nothing being clipped'}
            />
            <Tile
              label="Last report"
              value={ago(overview?.reportedAt ?? null, now)}
              sub={overview?.reportedAt ? clock(overview.reportedAt) : 'the phone hasn’t reported yet'}
            />
          </div>
          {overview?.configured && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
              <span title="Written after the phone downloads a series zip">Downloads: {clock(overview.reported.sync)}</span>
              <span title="Narration scripts written on the phone">Scripts: {clock(overview.reported.scripts)}</span>
              <span title="Crop pointers, Auto-run and upload counts">Crops &amp; uploads: {clock(overview.reported.crops)}</span>
              {!relay?.configured && (
                <span>
                  Without the relay nothing updates by itself. <Link to="/settings" className="underline">Set it up</Link> for live status.
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Now processing */}
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Processing now
          </CardTitle>
          <CardDescription>
            Pages Sleeper-Cell’s Auto-run is clipping in ChatGPT. A page still running after 45 minutes is taken as a dead run and dropped.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {overview?.working.length
            ? overview.working.map(w => (
                <WorkingRow key={`${w.series}/${w.chapter}/${w.page}`} working={w} averageTook={stats?.averageTook ?? null} now={now} />
              ))
            : <p className="text-sm text-muted-foreground">Auto-run isn’t clipping anything right now.</p>}
        </CardContent>
      </Card>

      {/* Throughput */}
      {stats && overview?.configured && (
        <Card className="mb-6">
          <CardContent className="space-y-4 p-5">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              <Tile label="Done today" value={`${stats.doneToday}${stats.capped ? '+' : ''}`} sub="pages with crop JSON" />
              <Tile label="Last hour" value={stats.doneLastHour} sub="pages finished" />
              <Tile
                label="Per page"
                value={stats.averageTook !== null ? formatTook(stats.averageTook) : '—'}
                sub={`average of the last ${AVERAGE_OVER} Auto-run pages`}
              />
              <Tile
                label="Pages left"
                value={stats.pagesLeft}
                sub={stats.hoursLeft !== null
                  ? `~${stats.hoursLeft < 1 ? `${Math.round(stats.hoursLeft * 60)}m` : `${stats.hoursLeft.toFixed(1)}h`} at the last hour’s pace`
                  : 'on the phone, not yet clipped'}
              />
              <Tile label="Images uploaded" value={stats.uploadsLastDay} sub="to ChatGPT in the last 24h" />
            </div>
            {stats.byAccount.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
                <span className="text-muted-foreground">Today by account:</span>
                {stats.byAccount.map(([name, pages]) => (
                  <Badge key={name} variant="secondary" className="tabular-nums">{name} · {pages}</Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ChatGPT upload limits */}
      <PhoneUploadUsage status={overview} className="mb-6" />

      {/* Series on the phone */}
      {overview?.configured && (
        <Card className="mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4 text-muted-foreground" />
              Series on the phone
            </CardTitle>
            <CardDescription>Downloaded zips, narration scripts and crop progress, by series.</CardDescription>
          </CardHeader>
          <CardContent>
            {overview.series.length === 0
              ? <p className="text-sm text-muted-foreground">The phone hasn’t reported any series from this library.</p>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="pb-2 pr-4 font-medium">Series</th>
                        <th className="pb-2 pr-4 font-medium">Download</th>
                        <th className="pb-2 pr-4 font-medium">Scripts</th>
                        <th className="pb-2 pr-4 font-medium min-w-[180px]">Crops</th>
                        <th className="pb-2 font-medium">Uploaded</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.series.map(s => {
                        const percent = s.crops?.total ? (s.crops.done / s.crops.total) * 100 : 0
                        return (
                          <tr key={s.id} className="border-t align-middle">
                            <td className="py-2 pr-4">
                              <Link to={`/clipper3/series/${s.id}`} className="font-medium hover:underline">{s.title}</Link>
                              {s.working > 0 && (
                                <Badge className="ml-2 bg-sky-600 hover:bg-sky-600">{s.working} running</Badge>
                              )}
                            </td>
                            <td className="py-2 pr-4">
                              {s.sync
                                ? <PhoneSyncBadge sync={s.sync} device={overview.device} />
                                : <span className="text-xs text-muted-foreground">no zip in R2</span>}
                            </td>
                            <td className="py-2 pr-4 tabular-nums">
                              {s.scripts
                                ? <span className={s.scripts.done === s.scripts.total ? 'text-emerald-600' : ''}>{s.scripts.done}/{s.scripts.total}</span>
                                : <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className="py-2 pr-4">
                              {s.crops
                                ? (
                                  <div className="flex items-center gap-2">
                                    <Progress value={percent} className="h-1.5 flex-1" />
                                    <span className="w-20 text-right text-xs tabular-nums text-muted-foreground">
                                      {s.crops.done}/{s.crops.total}
                                    </span>
                                  </div>
                                )
                                : <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className="py-2 tabular-nums">
                              {s.chaptersUploaded > 0 ? `${s.chaptersUploaded} ch.` : <span className="text-muted-foreground">—</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 2xl:grid-cols-[3fr_2fr]">
        {/* Recently finished */}
        {overview?.configured && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock className="h-4 w-4 text-muted-foreground" />
                Recently finished pages
              </CardTitle>
            </CardHeader>
            <CardContent>
              {overview.recent.length === 0
                ? <p className="text-sm text-muted-foreground">No pages finished on the phone yet.</p>
                : (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                            <th className="pb-2 pr-3 font-medium">At</th>
                            <th className="pb-2 pr-3 font-medium">Chapter</th>
                            <th className="pb-2 pr-3 font-medium">Page</th>
                            <th className="pb-2 pr-3 font-medium">Took</th>
                            <th className="pb-2 font-medium">Account · model</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(showAllRecent ? overview.recent : overview.recent.slice(0, RECENT_SHOWN)).map(f => (
                            <FinishRow key={`${f.series}/${f.chapter}/${f.page}`} finish={f} />
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {overview.recent.length > RECENT_SHOWN && (
                      <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShowAllRecent(v => !v)}>
                        {showAllRecent ? 'Show fewer' : `Show all ${overview.recent.length}`}
                      </Button>
                    )}
                  </>
                )}
            </CardContent>
          </Card>
        )}

        {/* Chapter uploads from the phone */}
        {overview?.configured && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Upload className="h-4 w-4 text-muted-foreground" />
                Chapters uploaded from the phone
              </CardTitle>
              <CardDescription>
                Zips with their crop JSON in R2. <span className="whitespace-nowrap">Image Clipper’s Sync json pulls them in.</span>
              </CardDescription>
            </CardHeader>
            <CardContent>
              {overview.uploads.length === 0
                ? <p className="text-sm text-muted-foreground">The phone hasn’t uploaded a chapter yet.</p>
                : (
                  <ul className="space-y-1.5 text-sm">
                    {overview.uploads.map(u => (
                      <li key={`${u.series}/${u.chapter}`} className="flex items-center gap-2">
                        <ImageUp className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        <span className="truncate">
                          {u.chapterId
                            ? <Link to={`/clipper3/chapter/${u.chapterId}`} className="hover:underline">{u.series} · {chapterLabel(u)}</Link>
                            : <>{u.series} · {chapterLabel(u)}</>}
                        </span>
                        <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                          {u.pages} pages · {clock(u.uploadedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
