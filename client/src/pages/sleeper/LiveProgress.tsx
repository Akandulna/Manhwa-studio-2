import { useSeriesOrder } from '@/hooks/useSeriesOrder'
/**
 * Live Progress — what the automation on the phones is doing right now: Image
 * Clipper's Auto-run pages (each against the usual time per page) and the
 * Narration and Voiceover runs, one card per phone that is busy. Under them,
 * today's pace and the chapters the phone uploaded; the series table and the
 * finished pages fold away.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, AlertTriangle, ArrowRight, ChevronRight, Clock, Clapperboard, FileText, Gauge, ImageUp, Mic, Pause, PenLine, Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Progress } from '@/components/ui/progress'
import { formatTook, PhoneSyncBadge } from '@/components/PhoneSyncBadge'
import { usePhoneOverview } from '@/hooks/usePhoneOverview'
import { usePhoneRelay } from '@/hooks/usePhoneRelay'
import type { PhoneOverview, PhoneOverviewFinish, PhoneOverviewPhone, PhoneOverviewRun, PhoneOverviewWorking } from '@/lib/api'
import { LANGUAGE_LABEL } from '@/lib/narrationLanguage'
import { uploadUsage } from '@/lib/uploadUsage'
import { cn } from '@/lib/utils'
import {
  ago,
  Bar,
  chapterLabel,
  clock,
  HOUR,
  InfoTip,
  isMetadata,
  Light,
  onPhone,
  pageLabel,
  phoneActivity,
  phoneList,
  PhoneHeading,
  SleeperPage,
  span,
  useNow
} from './sleeperShared'

/** The average time per page is read over this many recent Auto-run pages. */
export const AVERAGE_OVER = 20
const RECENT_SHOWN = 10

function WorkingRow({ working, averageTook, now }: { working: PhoneOverviewWorking; averageTook: number | null; now: number }) {
  const since = working.since ? Date.parse(working.since) : NaN
  const elapsed = Number.isNaN(since) ? null : Math.max(0, (now - since) / 1000)
  const overdue = elapsed !== null && averageTook !== null && elapsed > averageTook * 1.5
  const percent = elapsed !== null && averageTook ? (elapsed / averageTook) * 100 : 0
  const where = (
    <>
      <span className="text-muted-foreground">{chapterLabel(working)} · </span>
      <span className="font-mono text-xs">{pageLabel(working.page)}</span>
    </>
  )
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-sm">
        {working.paused ? <Pause className="h-3.5 w-3.5 text-amber-500" /> : <Light tone="good" live size="h-2 w-2" />}
        {working.chapterId
          ? <Link to={`/clipper3/chapter/${working.chapterId}`} className="whitespace-nowrap hover:underline">{where}</Link>
          : <span className="whitespace-nowrap">{where}</span>}
        {working.paused && <span className="text-xs text-amber-500">paused</span>}
        {overdue && !working.paused && <span className="text-xs text-amber-500">slow</span>}
        <span className={cn('ml-auto whitespace-nowrap text-xs tabular-nums', overdue ? 'font-medium text-amber-500' : 'text-muted-foreground')}>
          {elapsed !== null ? formatTook(elapsed) : '—'}
          {averageTook !== null && <span className="text-muted-foreground"> of ~{formatTook(averageTook)}</span>}
        </span>
      </div>
      {averageTook !== null
        ? <Bar percent={percent} tone={working.paused || overdue ? 'warn' : 'primary'} />
        : (
          // No usual time to measure against yet: a bar that shows the page is going, not how far.
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary" title="Timed once a page has finished">
            <div className={cn('h-full w-full rounded-full', working.paused ? 'bg-amber-500/40' : 'animate-pulse bg-primary/40')} />
          </div>
        )}
    </div>
  )
}

const RUN_KIND = {
  narration: { icon: PenLine, name: 'Narration', unit: 'chapter' },
  editor: { icon: Clapperboard, name: 'Editor 2.0', unit: 'chapter' },
  voiceover: { icon: Mic, name: 'Voiceover', unit: 'split' }
} as const

/** A narration, Editor 2.0 or voiceover run: its progress, then one row per tab with the time on it so far. */
function RunSection({ run, now }: { run: PhoneOverviewRun; now: number }) {
  const kind = RUN_KIND[run.kind]
  const Icon = kind.icon
  const percent = run.total ? (run.done / run.total) * 100 : 0
  const language = run.tabs[0]?.language ?? 'en'
  const lang = language === 'hi' ? '?lang=hi' : ''
  const seriesLink = !run.seriesId ? null : run.kind === 'editor' ? `/editor2/${run.seriesId}` : `/narration/series/${run.seriesId}${lang}`
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">{kind.name}</span>
        <span className="text-muted-foreground">·</span>
        {seriesLink ? <Link to={seriesLink} className="truncate hover:underline">{run.series}</Link> : <span className="truncate">{run.series}</span>}
        {run.kind !== 'narration' && <span className="text-xs text-muted-foreground">{LANGUAGE_LABEL[language]}</span>}
        {run.paused && <span className="text-xs text-amber-500">paused</span>}
        {run.stopping && <span className="text-xs text-amber-500">stopping</span>}
        <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-muted-foreground">
          {run.done}/{run.total} {kind.unit}{run.total === 1 ? '' : 's'}
          {run.account && <> · {run.account}</>}
        </span>
      </div>
      <Bar percent={percent} tone={run.paused ? 'warn' : 'primary'} />
      {run.tabs.map(tab => {
        const since = tab.since ? Date.parse(tab.since) : NaN
        const elapsed = Number.isNaN(since) ? null : Math.max(0, (now - since) / 1000)
        const what = run.kind === 'voiceover'
          ? (tab.split !== null ? `split ${tab.split}${tab.splits ? ` of ${tab.splits}` : ''}` : 'split')
          : run.kind === 'editor' ? tab.step ?? 'timeline' : `${LANGUAGE_LABEL[tab.language]} script`
        const where = <><span className="text-muted-foreground">{chapterLabel(tab)} · </span>{what}</>
        const tabLang = tab.language === 'hi' ? '?lang=hi' : ''
        // Narration has no chapter page: its series page shows each chapter's script and voiceover.
        const link = !run.seriesId || run.kind === 'editor' ? null : `/narration/series/${run.seriesId}${tabLang}`
        return (
          <div key={`${tab.chapter}/${tab.language}/${tab.split ?? ''}`} className="flex items-center gap-2 pl-5 text-sm">
            {run.paused ? <Pause className="h-3.5 w-3.5 text-amber-500" /> : <Light tone="good" live size="h-2 w-2" />}
            {link ? <Link to={link} className="hover:underline">{where}</Link> : <span>{where}</span>}
            <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-muted-foreground">
              {elapsed !== null ? formatTook(elapsed) : '—'}
            </span>
          </div>
        )
      })}
      {run.tabs.length === 0 && <p className="pl-5 text-xs text-muted-foreground">Between {kind.unit}s.</p>}
    </div>
  )
}

const WORKING_KIND = {
  clipper: {
    icon: ImageUp,
    name: 'Image Clipper',
    tip: 'One page per ChatGPT tab. A page still running after 45 minutes is taken as a dead run and dropped.'
  },
  metadata: {
    icon: FileText,
    name: 'Metadata',
    tip: 'One page per AI Studio tab, writing the metadata for its reviewed crops. A page still running after 45 minutes is taken as a dead run and dropped.'
  }
} as const

/**
 * The pages one kind of page run is on, each timed against that run's usual time per page: Image Clipper's (from the
 * phones' finished pages, with the ChatGPT account) or Metadata's (timed by Studio as the phones finish pages).
 */
function WorkingSection({ process, working, account, averageTook, now }: {
  process: keyof typeof WORKING_KIND; working: PhoneOverviewWorking[]; account: string | null; averageTook: number | null; now: number
}) {
  const kind = WORKING_KIND[process]
  const Icon = kind.icon
  // Which series and chapters the open pages are in: "Monarch of Supreme Beings · Ch. 15, 16".
  const places = new Map<string, Set<string>>()
  for (const w of working) {
    const chapters = places.get(w.series) ?? new Set<string>()
    chapters.add(w.chapterNumber !== null ? String(w.chapterNumber) : w.chapter)
    places.set(w.series, chapters)
  }
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-sm">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">{kind.name}</span>
        <span className="truncate text-muted-foreground">
          · {[...places].map(([series, chapters]) => `${series} · Ch. ${[...chapters].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(', ')}`).join('; ')}
        </span>
        {account && <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">on {account}</span>}
        <InfoTip text={kind.tip} className={account ? '' : 'ml-auto'} />
      </p>
      {working.map(w => (
        <WorkingRow key={`${w.device ?? ''}/${w.series}/${w.chapter}/${w.page}`} working={w} averageTook={averageTook} now={now} />
      ))}
    </div>
  )
}

/** One busy phone: its Image Clipper and Metadata pages and its runs. */
export function PhoneProgress({ phone, overview, several, averageTook, now }: {
  phone: PhoneOverviewPhone; overview: PhoneOverview; several: boolean; averageTook: number | null; now: number
}) {
  const activity = phoneActivity(overview, phone, several)
  const resume = activity.working.length ? null : phone.automation?.resume ?? null
  const live = activity.going.length > 0 && phone.connected !== false
  const metadata = activity.working.filter(isMetadata)
  const clipping = activity.working.filter(w => !isMetadata(w))
  const account = (overview.profiles ?? [])
    .filter(p => onPhone(p, phone, several))
    .map(p => uploadUsage(p, now))
    .find(u => u.pace !== null)?.profile.name ?? null
  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="flex items-center gap-3">
          <Light tone={activity.going.length ? 'good' : 'warn'} live={live} size="h-3 w-3" />
          <h2 className="text-lg font-semibold">{activity.title ?? (resume ? `Resumes ~${clock(resume.at)}` : 'Idle')}</h2>
          {several && <PhoneHeading name={phone.name} className="ml-auto" />}
        </div>
        {phone.connected === false && (
          <p className="flex items-center gap-1.5 text-xs text-amber-500">
            <AlertTriangle className="h-3.5 w-3.5" /> Sleeper-Cell is closed, so this is its last report ({ago(phone.reportedAt, now)}).
          </p>
        )}
        {activity.youtube && <div className="space-y-2 rounded-lg border bg-muted/20 p-3"><p role="status" className="text-sm">{activity.youtube.paused ? 'Paused · ' : ''}{activity.youtube.step}</p><Link to={activity.youtube.seriesId ? `/youtube/${encodeURIComponent(activity.youtube.seriesId)}` : '/youtube'} className="text-sm text-primary hover:underline">Open YouTube workspace</Link></div>}
        {resume && (
          <p className="flex items-center gap-1.5 text-sm">
            <Clock className="h-4 w-4 flex-shrink-0 text-amber-500" />
            <span>
              <span className="font-medium">{resume.series}</span> · waiting for the ChatGPT limit to lift, then it starts again by itself
              {Date.parse(resume.at) > now && <> in {span(Date.parse(resume.at) - now)}</>}.
            </span>
          </p>
        )}
        {clipping.length > 0 && <WorkingSection process="clipper" working={clipping} account={account} averageTook={averageTook} now={now} />}
        {metadata.length > 0 && <WorkingSection process="metadata" working={metadata} account={null} averageTook={overview.metadataAverageTook ?? null} now={now} />}
        {activity.runs.map(run => <RunSection key={`${run.device ?? ''}/${run.kind}`} run={run} now={now} />)}
      </CardContent>
    </Card>
  )
}

function Tile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}

/** A section that starts folded: its title and count, then its content on a click. */
function Fold({ icon: Icon, title, count, children }: { icon: React.ComponentType<{ className?: string }>; title: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card>
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-6 py-4 text-left text-base font-semibold hover:bg-accent/40">
          <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
          <span className="text-sm font-normal text-muted-foreground tabular-nums">{count}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent>{children}</CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

function FinishRow({ finish, several }: { finish: PhoneOverviewFinish; several: boolean }) {
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
      {several && <td className="py-1.5 pr-3 text-xs text-muted-foreground whitespace-nowrap">{finish.phone ?? '—'}</td>}
      <td className="py-1.5 text-xs text-muted-foreground whitespace-nowrap">
        {finish.run === 'manual' ? 'Pasted by hand' : [finish.account, model].filter(Boolean).join(' · ') || '—'}
        {finish.models.length > 1 && <span title={finish.models.join(' → ')}> (+{finish.models.length - 1} fix)</span>}
      </td>
    </tr>
  )
}

export default function LiveProgress() {
  const receipt = usePhoneOverview()
  const relay = usePhoneRelay()
  const overview = receipt.status
  const orderedSeries = useSeriesOrder(overview?.series ?? [])
  const busy = (overview?.working.length ?? 0) + (overview?.runs.length ?? 0) > 0 || !!overview?.phones?.some(p => p.automation?.youtube?.active)
  const now = useNow(busy)
  const [showAllRecent, setShowAllRecent] = useState(false)
  const phones = useMemo(() => phoneList(overview, relay), [overview, relay])
  const several = phones.length > 1

  const stats = useMemo(() => {
    if (!overview) return null
    const today = new Date(now).toDateString()
    const times = overview.recent.map(f => Date.parse(f.at))
    const doneToday = times.filter(t => new Date(t).toDateString() === today).length
    const doneLastHour = times.filter(t => now - t < HOUR).length
    const auto = overview.recent.filter(f => f.run !== 'manual' && f.took !== null).slice(0, AVERAGE_OVER)
    const averageTook = auto.length ? auto.reduce((sum, f) => sum + f.took!, 0) / auto.length : null
    const pagesLeft = overview.series.reduce((sum, s) => sum + (s.crops ? Math.max(0, s.crops.total - s.crops.done) : 0), 0)
    // Pages per account today, busiest first.
    const accounts = new Map<string, number>()
    for (const f of overview.recent) {
      if (new Date(f.at).toDateString() !== today || f.run === 'manual') continue
      const account = f.account ?? f.profile ?? 'Unknown account'
      const name = several && f.phone ? `${f.phone} · ${account}` : account
      accounts.set(name, (accounts.get(name) ?? 0) + 1)
    }
    return {
      doneToday,
      doneLastHour,
      averageTook,
      pagesLeft,
      byAccount: [...accounts.entries()].sort((a, b) => b[1] - a[1]),
      /** Hours to finish what the phone has, at the last hour's pace. */
      hoursLeft: doneLastHour > 0 && pagesLeft > 0 ? pagesLeft / doneLastHour : null,
      /** The recent list is capped, so "today" may be more than this on a very busy day. */
      capped: overview.recentCapped && new Date(overview.recent[overview.recent.length - 1].at).toDateString() === today
    }
  }, [overview, now, several])

  const active = phones.filter(p => phoneActivity(overview, p, several).busy || (p.automation?.resume && p.working === 0))
  const idle = phones.filter(p => !active.includes(p))
  const last = overview?.recent[0] ?? null

  return (
    <SleeperPage icon={Activity} title="Live Progress" receipt={receipt}>
      {overview?.configured && stats && (
        <>
          {/* What's running, per phone */}
          {active.length
            ? (
              <div className={cn('mb-3 grid gap-6', active.length > 1 && 'lg:grid-cols-2')}>
                {active.map(phone => (
                  <PhoneProgress key={phone.id || phone.name} phone={phone} overview={overview} several={several} averageTook={stats.averageTook} now={now} />
                ))}
              </div>
            )
            : (
              <Card className="mb-3">
                <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-5">
                  <span className="flex items-center gap-3">
                    <Light tone="idle" size="h-3 w-3" />
                    <span className="text-lg font-semibold">Nothing running</span>
                  </span>
                  <span className="text-sm text-muted-foreground">
                    Last page done:{' '}
                    {last
                      ? <span className="text-foreground" title={clock(last.at)}>{last.series} · {chapterLabel(last)} · {ago(last.at, now)}</span>
                      : '—'}
                  </span>
                  <Link to="/sleeper-cells" className="ml-auto inline-flex items-center gap-1 text-sm hover:underline">
                    Start a run on Phone Status <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </CardContent>
              </Card>
            )}
          {several && active.length > 0 && idle.length > 0 && (
            <p className="mb-3 text-xs text-muted-foreground">
              Idle: {idle.map(p => p.name).join(' · ')}
            </p>
          )}

          <div className="mb-6 mt-6 grid gap-6 lg:grid-cols-[3fr_2fr]">
            {/* Today's pace */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Gauge className="h-4 w-4 text-muted-foreground" />
                  Today
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                  <Tile label="Pages done" value={`${stats.doneToday}${stats.capped ? '+' : ''}`} sub="with crop JSON" />
                  <Tile label="Last hour" value={stats.doneLastHour} sub="pages finished" />
                  <Tile label="Per page" value={stats.averageTook !== null ? formatTook(stats.averageTook) : '—'} sub={`last ${AVERAGE_OVER} Auto-run pages`} />
                  <Tile
                    label="Pages left"
                    value={stats.pagesLeft}
                    sub={stats.hoursLeft !== null
                      ? `~${stats.hoursLeft < 1 ? `${Math.round(stats.hoursLeft * 60)}m` : `${stats.hoursLeft.toFixed(1)}h`} at this pace`
                      : 'not yet clipped'}
                  />
                </div>
                {stats.byAccount.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
                    <span className="text-muted-foreground">By account:</span>
                    {stats.byAccount.map(([name, pages]) => (
                      <Badge key={name} variant="secondary" className="tabular-nums">{name} · {pages}</Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Chapter uploads from the phone */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Upload className="h-4 w-4 text-muted-foreground" />
                  Chapters uploaded
                  <InfoTip text="Zips with their crop JSON in R2. Image Clipper’s Sync json pulls them in." />
                </CardTitle>
              </CardHeader>
              <CardContent>
                {overview.uploads.length === 0
                  ? <p className="text-sm text-muted-foreground">The phone hasn’t uploaded a chapter yet.</p>
                  : (
                    <ul className="max-h-64 space-y-1.5 overflow-y-auto text-sm">
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
          </div>

          <div className="space-y-4">
            {/* Series on the phone */}
            <Fold icon={FileText} title="Series on the phones" count={overview.series.length}>
              <CardDescription className="mb-3">Downloaded zips, narration scripts and crop progress, by series.</CardDescription>
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
                        {orderedSeries.map(s => {
                          const percent = s.crops?.total ? (s.crops.done / s.crops.total) * 100 : 0
                          return (
                            <tr key={s.id} className="border-t align-middle">
                              <td className="py-2 pr-4">
                                <Link to={`/clipper3/series/${s.id}`} className="font-medium hover:underline">{s.title}</Link>
                                {s.working > 0 && <Badge className="ml-2 bg-sky-600 hover:bg-sky-600">{s.working} running</Badge>}
                                {s.runs.includes('narration') && <Badge className="ml-2 bg-sky-600 hover:bg-sky-600">writing scripts</Badge>}
                                {s.runs.includes('voiceover') && <Badge className="ml-2 bg-sky-600 hover:bg-sky-600">voicing</Badge>}
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
                                      <span className="w-20 text-right text-xs tabular-nums text-muted-foreground">{s.crops.done}/{s.crops.total}</span>
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
            </Fold>

            {/* Recently finished */}
            <Fold icon={Clock} title="Recently finished pages" count={overview.recent.length}>
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
                            {several && <th className="pb-2 pr-3 font-medium">Phone</th>}
                            <th className="pb-2 font-medium">Account · model</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(showAllRecent ? overview.recent : overview.recent.slice(0, RECENT_SHOWN)).map(f => (
                            <FinishRow key={`${f.series}/${f.chapter}/${f.page}`} finish={f} several={several} />
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
            </Fold>
          </div>
        </>
      )}
    </SleeperPage>
  )
}
