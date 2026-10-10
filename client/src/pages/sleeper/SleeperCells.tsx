/**
 * Sleeper Cells — the Sleeper-Cell phone app at a glance. The top row answers
 * the three questions that matter, in this order: is the phone active, how many
 * ChatGPT image uploads are left, and what the phone is doing right now (Image
 * Clipper's Auto-run, and the Narration and Voiceover libraries' runs), then
 * how much of Gemini's daily limits each profile has used. Under
 * them, Start and Stop for Image Clipper on the phone (through the relay), then
 * today's pace, where every series stands, and the history.
 *
 * Everything comes from the three receipts the phone sends (see
 * usePhoneOverview): live through the phone relay, or on "Refresh from phone"
 * without it. The only timer re-renders the elapsed times, with no request.
 *
 * Sleeper-Cell can run on several phones (through the relay). The server merges
 * their receipts; with more than one, each phone gets a row in the first card,
 * what is going on is labelled with its phone, and Start can split a series
 * between the phones or go to one.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  Clock,
  FileText,
  Gauge,
  ImageUp,
  Loader2,
  Mic,
  Pause,
  PenLine,
  Play,
  Smartphone,
  Sparkles,
  Square,
  Trash2,
  Upload
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { PhoneRefreshButton } from '@/components/PhoneRefreshButton'
import { formatTook, PhoneSyncBadge } from '@/components/PhoneSyncBadge'
import { usePhoneOverview } from '@/hooks/usePhoneOverview'
import { usePhoneRelay } from '@/hooks/usePhoneRelay'
import {
  r2Api,
  type PhoneAutomation,
  type PhoneOverview,
  type PhoneOverviewFinish,
  type PhoneOverviewPhone,
  type PhoneOverviewRun,
  type PhoneOverviewWorking,
  type PhoneGeminiProfile,
  type PhoneGeminiUsage,
  type RelayStatus
} from '@/lib/api'
import { LANGUAGE_LABEL } from '@/lib/narrationLanguage'
import { UPLOAD_LIMIT, uploadOverview, uploadUsage, type UploadUsage } from '@/lib/uploadUsage'
import { cn } from '@/lib/utils'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** The average time per page is read over this many recent Auto-run pages. */
const AVERAGE_OVER = 20
const RECENT_SHOWN = 10
/** A profile running out sooner than this is flagged. */
const RUNS_OUT_SOON_MS = 30 * MINUTE
/** Image Clipper's most ChatGPT tabs at once (ClipperRun.MAX_TABS on the phone). */
const MAX_TABS = 4
const DEFAULT_TABS = 2

type Tone = 'good' | 'warn' | 'bad' | 'idle'

const TONE: Record<Tone, { dot: string; text: string; bar: string }> = {
  good: { dot: 'bg-emerald-500', text: 'text-emerald-500', bar: 'bg-emerald-500' },
  warn: { dot: 'bg-amber-500', text: 'text-amber-500', bar: 'bg-amber-500' },
  bad: { dot: 'bg-red-500', text: 'text-red-500', bar: 'bg-red-500' },
  idle: { dot: 'bg-muted-foreground/50', text: 'text-muted-foreground', bar: 'bg-muted-foreground/50' }
}

function clock(iso: string | number | null): string {
  if (iso === null) return '—'
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

/** A stretch of time ahead: 55m, 1h 20m. */
function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}

function chapterLabel(place: { chapter: string; chapterNumber: number | null }): string {
  return place.chapterNumber !== null ? `Ch. ${place.chapterNumber}` : place.chapter
}

/** The page name without its extension: page_004.webp → page_004. */
function pageLabel(page: string): string {
  return page.replace(/\.[a-z0-9]+$/i, '')
}

/** Which phone something is on, shown only when there are several. */
function PhoneTag({ phone, className }: { phone: string | null; className?: string }) {
  if (!phone) return null
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1 rounded bg-secondary px-1.5 py-0 text-[10px] font-medium text-muted-foreground', className)} title={phone}>
      <Smartphone className="h-2.5 w-2.5 flex-shrink-0" />
      <span className="truncate">{phone}</span>
    </span>
  )
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

/** A status light; `live` pulses it. */
function Light({ tone, live = false, size = 'h-3 w-3' }: { tone: Tone; live?: boolean; size?: string }) {
  return (
    <span className={cn('relative inline-flex flex-shrink-0', size)}>
      {live && <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', TONE[tone].dot)} />}
      <span className={cn('relative inline-flex rounded-full', size, TONE[tone].dot)} />
    </span>
  )
}

/** A thin meter whose colour carries its meaning. */
function Bar({ percent, tone, className }: { percent: number; tone: Tone | 'primary'; className?: string }) {
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-secondary', className)}>
      <div
        className={cn('h-full rounded-full transition-all', tone === 'primary' ? 'bg-primary' : TONE[tone].bar)}
        style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
      />
    </div>
  )
}

/** One of the three cards in the top row: a question, its answer in large type, and the details under it. */
function AnswerCard({ icon: Icon, question, children, className }: {
  icon: React.ComponentType<{ className?: string }>
  question: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardContent className="flex flex-1 flex-col gap-4 p-5">
        <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Icon className="h-4 w-4" />
          {question}
        </p>
        {children}
      </CardContent>
    </Card>
  )
}

function Headline({ tone, live, title, detail }: { tone: Tone; live?: boolean; title: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-3">
        <Light tone={tone} live={live} size="h-3.5 w-3.5" />
        <span className={cn('text-3xl font-bold leading-none tracking-tight', tone === 'idle' ? '' : TONE[tone].text)}>{title}</span>
      </div>
      {detail && <p className="mt-2 text-sm text-muted-foreground">{detail}</p>}
    </div>
  )
}

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="mt-auto grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t pt-3 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

// ─── 1. Is the phone active? ────────────────────────────────────────────────

/** Is the phone open, as far as can be told: only the relay knows; without it, only when it last reported. */
function phoneState(relay: RelayStatus | null, overview: PhoneOverview | null, running: number, paused: number, now: number) {
  const lastHeard = ago(overview?.reportedAt ?? null, now)
  if (relay?.configured) {
    if (!relay.connected) {
      return { tone: 'warn' as Tone, live: false, title: 'Can’t tell', detail: `Manhwa Studio can’t reach the relay right now. Last heard from the phone ${lastHeard}.` }
    }
    if (relay.phones > 0) {
      if (running > 0) return { tone: 'good' as Tone, live: true, title: 'Active', detail: 'Sleeper-Cell is open and a run is working.' }
      if (paused > 0) return { tone: 'warn' as Tone, live: false, title: 'Open · paused', detail: 'Sleeper-Cell is open, but its run is paused.' }
      // With "Start from Manhwa Studio" on, the phone keeps its socket open with the app away and the screen off.
      if (overview?.automation?.remoteStart) {
        return { tone: 'good' as Tone, live: false, title: 'Ready', detail: 'Sleeper-Cell is listening: Start below reaches it, with its screen off too.' }
      }
      return { tone: 'good' as Tone, live: false, title: 'Open · idle', detail: 'Sleeper-Cell is open, but nothing is running.' }
    }
    return { tone: 'bad' as Tone, live: false, title: 'Closed', detail: `Sleeper-Cell isn’t open on the phone. Last heard ${lastHeard}.` }
  }
  return {
    tone: 'idle' as Tone,
    live: false,
    title: 'Unknown',
    detail: <>Without the relay, only “Refresh from phone” can tell. Last report {lastHeard}. <Link to="/settings" className="underline">Set up the relay</Link> for live status.</>
  }
}

function linkLabel(relay: RelayStatus | null): React.ReactNode {
  if (!relay?.configured) return <span className="text-muted-foreground">Not set up (R2 on request)</span>
  if (!relay.connected) return <span className="text-amber-500" title={relay.lastError ?? undefined}>Relay offline · reconnecting</span>
  return <span className="text-emerald-500">Live (relay)</span>
}

/** One phone's line: open or not, and what it's doing. */
function phoneLine(phone: PhoneOverviewPhone, relay: RelayStatus | null, now: number): { tone: Tone; live: boolean; text: string } {
  const doing = [
    ...(phone.working ? [`clipping ${phone.working} page${phone.working === 1 ? '' : 's'}`] : []),
    ...(phone.runs ? [`${phone.runs} run${phone.runs === 1 ? '' : 's'}`] : [])
  ].join(' · ')
  if (phone.connected === null || !relay?.connected) return { tone: 'idle', live: false, text: `${doing || 'last heard'} · ${ago(phone.reportedAt, now)}` }
  if (!phone.connected) return { tone: 'bad', live: false, text: `Closed · ${ago(phone.reportedAt, now)}` }
  if (doing) return { tone: 'good', live: true, text: doing[0].toUpperCase() + doing.slice(1) }
  return { tone: 'good', live: false, text: phone.automation?.remoteStart ? 'Ready' : 'Open · idle' }
}

/** Each phone, when there are several: its light, name and state; a phone that's gone can be forgotten. */
function PhoneList({ phones, relay, now }: { phones: PhoneOverviewPhone[]; relay: RelayStatus | null; now: number }) {
  const { toast } = useToast()
  const [forgetting, setForgetting] = useState<string | null>(null)
  const forget = async (phone: PhoneOverviewPhone) => {
    if (!window.confirm(`Forget “${phone.name}”? Its last status is dropped from here and from the relay. It comes back if it reports again.`)) return
    setForgetting(phone.id)
    try {
      await r2Api.forgetPhone(phone.id)
    } catch (error) {
      toast({ title: 'Could not forget the phone', description: error instanceof Error ? error.message : String(error), variant: 'destructive' })
    } finally {
      setForgetting(null)
    }
  }
  return (
    <ul className="space-y-1.5 text-sm">
      {phones.map(phone => {
        const line = phoneLine(phone, relay, now)
        return (
          <li key={phone.id || 'old'} className="flex items-center gap-2">
            <Light tone={line.tone} live={line.live} size="h-2 w-2" />
            <span className="truncate font-medium" title={phone.id ? `id ${phone.id}` : 'A Sleeper-Cell build from before phones had ids: update it'}>{phone.name}</span>
            <span className={cn('ml-auto whitespace-nowrap text-xs tabular-nums', line.tone === 'idle' ? 'text-muted-foreground' : TONE[line.tone].text)}>
              {line.text}
            </span>
            {relay?.configured && !phone.connected && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 flex-shrink-0 p-0 text-muted-foreground"
                title="Forget this phone"
                disabled={forgetting !== null}
                onClick={() => forget(phone)}
              >
                {forgetting === phone.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function PhoneCard({ relay, overview, running, paused, now }: {
  relay: RelayStatus | null; overview: PhoneOverview | null; running: number; paused: number; now: number
}) {
  const phones = overview?.phones ?? []
  let state = phoneState(relay, overview, running, paused, now)
  if (phones.length > 1 && relay?.configured && relay.connected) {
    const open = phones.filter(p => p.connected).length
    const busy = phones.filter(p => p.connected && p.working + p.runs > 0).length
    if (busy > 0) {
      state = { ...state, title: busy === phones.length ? `All ${busy} active` : `${busy} of ${phones.length} active` }
    } else if (open > 0) {
      state = { ...state, title: open === phones.length ? `All ${open} open` : `${open} of ${phones.length} open` }
    }
    if (open > 0) state = { ...state, detail: `${phones.length} phones run Sleeper-Cell. Each one’s state is below.` }
  }
  return (
    <AnswerCard icon={Smartphone} question={phones.length > 1 ? 'Are the phones active?' : 'Is the phone active?'}>
      <Headline tone={state.tone} live={state.live} title={state.title} detail={state.detail} />
      {phones.length > 1 && <PhoneList phones={phones} relay={relay} now={now} />}
      <Facts
        rows={[
          ['Last heard', <span title={overview?.reportedAt ? clock(overview.reportedAt) : undefined}>{ago(overview?.reportedAt ?? null, now)}</span>],
          ['Connection', linkLabel(relay)],
          phones.length > 1 ? ['Phones', phones.length] : ['Device', overview?.device ?? '—']
        ]}
      />
      {overview?.configured && (
        <p className="text-[11px] text-muted-foreground">
          Last receipts · downloads {clock(overview.reported.sync)} · scripts {clock(overview.reported.scripts)} · crops {clock(overview.reported.crops)}
        </p>
      )}
    </AnswerCard>
  )
}

// ─── 2. How many images can it still upload? ────────────────────────────────

function accountState(usage: UploadUsage, now: number): { tone: Tone; text: string } {
  if (usage.limitedUntil) return { tone: 'bad', text: `Limit hit · free ~${clock(usage.limitedUntil)}` }
  if (usage.exhaustsAt !== null) {
    const soon = usage.exhaustsAt - now < RUNS_OUT_SOON_MS
    return { tone: soon ? 'bad' : 'warn', text: `${usage.left} left · runs out in ${span(usage.exhaustsAt - now)}` }
  }
  return { tone: 'good', text: `${usage.left} left · ready` }
}

function AccountRow({ usage, now, several }: { usage: UploadUsage; now: number; several: boolean }) {
  const state = accountState(usage, now)
  const percent = usage.limitedUntil ? 100 : (usage.used / usage.limit) * 100
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-sm">
        <span className="truncate font-medium">{usage.profile.name}</span>
        {usage.pace !== null
          ? <Badge className="bg-sky-600 px-1.5 py-0 text-[10px] hover:bg-sky-600">uploading</Badge>
          : usage.profile.selected && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">next up</Badge>}
        <span className={cn('ml-auto whitespace-nowrap text-xs font-medium tabular-nums', TONE[state.tone].text)}>{state.text}</span>
      </div>
      <Bar percent={percent} tone={state.tone === 'good' ? 'primary' : state.tone} />
      <div className="flex justify-between gap-2 text-[11px] text-muted-foreground tabular-nums">
        <span className="flex min-w-0 items-center gap-1.5">
          {several && <PhoneTag phone={usage.profile.phone} />}
          <span className="whitespace-nowrap">{usage.used} / {usage.limit} used in the last 3h</span>
        </span>
        {usage.nextFreeAt !== null && !usage.limitedUntil && usage.used > 0 && (
          <span>+{usage.nextFree} back ~{clock(usage.nextFreeAt)}</span>
        )}
      </div>
    </div>
  )
}

function ImageLimitCard({ overview, now }: { overview: PhoneOverview | null; now: number }) {
  const usages = useMemo(() => (overview?.profiles ?? []).map(p => uploadUsage(p, now)), [overview, now])
  if (!usages.length) {
    return (
      <AnswerCard icon={Upload} question="Image limit">
        <Headline tone="idle" title="No data" detail="The phone hasn’t reported its ChatGPT uploads yet (older Sleeper-Cell builds don’t)." />
      </AnswerCard>
    )
  }
  const total = uploadOverview(usages, now)
  const capacity = usages.length * UPLOAD_LIMIT
  const inUse = usages.find(u => u.pace !== null)
  const lastDay = usages.reduce((sum, u) => sum + u.lastDay, 0)

  let tone: Tone = 'good'
  let detail: React.ReactNode = 'Every account can upload.'
  if (total.left === 0) {
    tone = 'bad'
    detail = total.nextLiftAt !== null ? `Every account is at the limit. The first frees up ~${clock(total.nextLiftAt)}.` : 'Every account is at the limit.'
  } else if (total.allUsedAt !== null) {
    const soon = total.allUsedAt - now < RUNS_OUT_SOON_MS
    tone = soon ? 'bad' : total.left < UPLOAD_LIMIT ? 'warn' : 'good'
    detail = <>At ~{Math.round(total.pace!)}/h, all of it is used up <span className="font-medium text-foreground">~{clock(total.allUsedAt)}</span> (in {span(total.allUsedAt - now)}).</>
  } else if (total.left < UPLOAD_LIMIT) {
    tone = 'warn'
  }

  return (
    <AnswerCard icon={Upload} question="Image limit">
      <Headline
        tone={tone}
        title={<>{total.left}<span className="text-lg font-semibold text-muted-foreground"> / {capacity} left</span></>}
        detail={detail}
      />
      <div className="space-y-3">
        {usages.map(usage => <AccountRow key={usage.profile.id} usage={usage} now={now} several={(overview?.phones?.length ?? 0) > 1} />)}
      </div>
      <p className="mt-auto border-t pt-3 text-[11px] text-muted-foreground">
        ChatGPT allows {UPLOAD_LIMIT} images per account in any 3 hours; each one counts for 3 hours.
        {inUse && <> Uploading on <span className="text-foreground">{inUse.profile.name}</span>.</>} {lastDay} uploaded in the last 24h.
      </p>
    </AnswerCard>
  )
}

// ─── 3. What is it doing? ───────────────────────────────────────────────────

function WorkingRow({ working, averageTook, now, several }: { working: PhoneOverviewWorking; averageTook: number | null; now: number; several: boolean }) {
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
        {several && <PhoneTag phone={working.phone} />}
        <span className={cn('ml-auto whitespace-nowrap text-xs tabular-nums', overdue ? 'font-medium text-amber-500' : 'text-muted-foreground')}>
          {elapsed !== null ? formatTook(elapsed) : '—'}
          {averageTook !== null && <span className="text-muted-foreground"> of ~{formatTook(averageTook)}</span>}
        </span>
      </div>
      <Bar percent={percent} tone={working.paused || overdue ? 'warn' : 'primary'} />
    </div>
  )
}

const RUN_KIND = {
  narration: { icon: PenLine, name: 'Narration', unit: 'chapter' },
  voiceover: { icon: Mic, name: 'Voiceover', unit: 'split' }
} as const

/** The run's headline: "Writing scripts", "Voicing 3 splits". */
function runTitle(run: PhoneOverviewRun): string {
  if (run.kind === 'narration') return run.tabs[0]?.language === 'hi' ? 'Converting to Hindi' : 'Writing scripts'
  const tabs = run.tabs.length
  return tabs > 1 ? `Voicing ${tabs} splits` : 'Voicing'
}

/** A narration or voiceover run: its progress, then one row per AI Studio tab with the time on it so far. */
function RunSection({ run, now, several }: { run: PhoneOverviewRun; now: number; several: boolean }) {
  const kind = RUN_KIND[run.kind]
  const Icon = kind.icon
  const percent = run.total ? (run.done / run.total) * 100 : 0
  const language = run.tabs[0]?.language ?? 'en'
  const lang = language === 'hi' ? '?lang=hi' : ''
  const seriesLink = run.seriesId ? `/narration/series/${run.seriesId}${lang}` : null
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">{kind.name}</span>
        <span className="text-muted-foreground">·</span>
        {seriesLink ? <Link to={seriesLink} className="truncate hover:underline">{run.series}</Link> : <span className="truncate">{run.series}</span>}
        {run.kind === 'voiceover' && <span className="text-xs text-muted-foreground">{LANGUAGE_LABEL[language]}</span>}
        {run.paused && <span className="text-xs text-amber-500">paused</span>}
        {run.stopping && <span className="text-xs text-amber-500">stopping</span>}
        {several && <PhoneTag phone={run.phone} />}
        <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-muted-foreground">
          {run.done}/{run.total} {kind.unit}{run.total === 1 ? '' : 's'}
        </span>
      </div>
      <Bar percent={percent} tone={run.paused ? 'warn' : 'primary'} />
      {run.tabs.map(tab => {
        const since = tab.since ? Date.parse(tab.since) : NaN
        const elapsed = Number.isNaN(since) ? null : Math.max(0, (now - since) / 1000)
        const what = run.kind === 'voiceover'
          ? (tab.split !== null ? `split ${tab.split}${tab.splits ? ` of ${tab.splits}` : ''}` : 'split')
          : `${LANGUAGE_LABEL[tab.language]} script`
        const where = <><span className="text-muted-foreground">{chapterLabel(tab)} · </span>{what}</>
        const tabLang = tab.language === 'hi' ? '?lang=hi' : ''
        const link = tab.chapterId
          ? run.kind === 'voiceover' ? `/narration/voiceover/${tab.chapterId}${tabLang}` : `/narration/chapter/${tab.chapterId}${tabLang}`
          : null
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
      {run.tabs.length === 0 && (
        <p className="pl-5 text-xs text-muted-foreground">Between {kind.unit}s{run.account ? ` · on ${run.account}` : ''}.</p>
      )}
      {run.account && run.tabs.length > 0 && <p className="pl-5 text-xs text-muted-foreground">on {run.account}</p>}
    </div>
  )
}

function DoingCard({ overview, running, paused, averageTook, phoneClosed, now }: {
  overview: PhoneOverview | null; running: number; paused: number; averageTook: number | null; phoneClosed: boolean; now: number
}) {
  const working = overview?.working ?? []
  const runs = overview?.runs ?? []
  const several = (overview?.phones?.length ?? 0) > 1
  const activeRuns = runs.filter(r => !r.paused)
  const last = overview?.recent[0] ?? null
  // Which series and chapters the open pages are in: "Monarch of Supreme Beings · Ch. 15, 16".
  const places = new Map<string, Set<string>>()
  for (const w of working) {
    const chapters = places.get(w.series) ?? new Set<string>()
    chapters.add(w.chapterNumber !== null ? String(w.chapterNumber) : w.chapter)
    places.set(w.series, chapters)
  }
  const usages = (overview?.profiles ?? []).map(p => uploadUsage(p, now))
  const account = usages.find(u => u.pace !== null)?.profile.name ?? last?.account ?? null

  // Waiting for a ChatGPT limit to lift: the phone starts again by itself then.
  const resume = working.length ? null : overview?.automation?.resume ?? null
  // What is going, Image Clipper first: "Clipping 2 pages", "Writing scripts", "Voicing 3 splits".
  const going = [
    ...(running > 0 ? [`Clipping ${running} page${running === 1 ? '' : 's'}`] : []),
    ...activeRuns.map(runTitle)
  ]
  const anyPaused = paused > 0 || runs.length > activeRuns.length
  const tone: Tone = going.length > 0 ? 'good' : anyPaused || resume ? 'warn' : 'idle'
  const title = going.length === 1
    ? going[0]
    : going.length > 1 ? `${going.length} runs going` : anyPaused ? 'Paused' : resume ? `Resumes ~${clock(resume.at)}` : 'Idle'
  const runsDetail = runs.length
    ? runs.map((r, i) => (
        <span key={`${r.device ?? ''}/${r.kind}`}>{i > 0 && '; '}{RUN_KIND[r.kind].name} · <span className="font-medium text-foreground">{r.series}</span></span>
      ))
    : null
  const detail = working.length === 0 && runsDetail
    ? <>{runsDetail}</>
    : resume
    ? <><span className="font-medium text-foreground">{resume.series}</span> · waiting for the ChatGPT limit to lift, then it starts again by itself.</>
    : working.length
    ? <>
        {[...places].map(([series, chapters], i) => (
          <span key={series}>{i > 0 && '; '}<span className="font-medium text-foreground">{series}</span> · Ch. {[...chapters].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(', ')}</span>
        ))}
        {account && <> · on <span className="text-foreground">{account}</span></>}
        {runsDetail && <>; {runsDetail}</>}
      </>
    : 'Nothing is running: no clipping, scripts or voiceover.'

  return (
    <AnswerCard icon={Activity} question="What is it doing?">
      <Headline tone={tone} live={going.length > 0 && !phoneClosed} title={title} detail={detail} />
      {phoneClosed && (working.length > 0 || runs.length > 0) && (
        <p className="flex items-center gap-1.5 text-xs text-amber-500">
          <AlertTriangle className="h-3.5 w-3.5" /> The app is closed, so this is from its last report ({ago(overview?.reportedAt ?? null, now)}).
        </p>
      )}
      {runs.map(run => <RunSection key={`${run.device ?? ''}/${run.kind}`} run={run} now={now} several={several} />)}
      {working.length > 0 && runs.length > 0 && (
        <p className="flex items-center gap-2 pt-1 text-sm font-medium"><ImageUp className="h-3.5 w-3.5 text-muted-foreground" /> Image Clipper</p>
      )}
      {working.length > 0 && (
        <div className="space-y-3" title="One page per ChatGPT tab. A page still running after 45 minutes is taken as a dead run and dropped.">
          {working.map(w => (
            <WorkingRow key={`${w.device ?? ''}/${w.series}/${w.chapter}/${w.page}`} working={w} averageTook={averageTook} now={now} several={several} />
          ))}
        </div>
      )}
      <Facts
        rows={[
          ['Last page done', last
            ? <span title={clock(last.at)}>{chapterLabel(last)} · <span className="font-mono text-xs">{pageLabel(last.page)}</span> · {ago(last.at, now)}</span>
            : '—'],
          ['Usual time per page', averageTook !== null ? `~${formatTook(averageTook)}` : '—']
        ]}
      />
    </AnswerCard>
  )
}

// ─── 4. How much Gemini is left? ────────────────────────────────────────────

function geminiState(profile: PhoneGeminiProfile): { tone: Tone; text: string } {
  if (profile.limitedUntil) return { tone: 'bad', text: `Limit hit · back ~${clock(profile.limitedUntil)}` }
  if (profile.limit === null) return { tone: 'good', text: 'limit not seen yet' }
  const left = Math.max(0, profile.limit - profile.today)
  return { tone: left === 0 ? 'bad' : left <= profile.limit * 0.2 ? 'warn' : 'good', text: `${left} left` }
}

function GeminiRow({ profile, inUse, several }: { profile: PhoneGeminiProfile; inUse: boolean; several: boolean }) {
  const state = geminiState(profile)
  const percent = profile.limitedUntil ? 100 : profile.limit ? (profile.today / profile.limit) * 100 : 0
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-sm">
        <span className="truncate font-medium">{profile.name}</span>
        {inUse
          ? <Badge className="bg-sky-600 px-1.5 py-0 text-[10px] hover:bg-sky-600">in use</Badge>
          : profile.selected && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">next up</Badge>}
        <span className={cn('ml-auto whitespace-nowrap text-xs font-medium tabular-nums', TONE[state.tone].text)}>{state.text}</span>
      </div>
      <Bar percent={percent} tone={state.tone === 'good' ? 'primary' : state.tone} />
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
        {several && <PhoneTag phone={profile.phone} />}
        <span className="whitespace-nowrap">{profile.today} / {profile.limit ?? '?'} requests today</span>
      </div>
    </div>
  )
}

/** One Gemini limit summed over the profiles: what's left where the limit is known, and how many are used up. */
function geminiTotals(usage: PhoneGeminiUsage) {
  const profiles = usage.profiles
  const limited = profiles.filter(p => p.limitedUntil).length
  const known = profiles.filter(p => p.limit !== null || p.limitedUntil)
  return {
    today: profiles.reduce((sum, p) => sum + p.today, 0),
    limited,
    allLimited: limited === profiles.length,
    allKnown: known.length === profiles.length,
    left: known.reduce((sum, p) => sum + (p.limitedUntil || p.limit === null ? 0 : Math.max(0, p.limit - p.today)), 0),
    capacity: known.reduce((sum, p) => sum + (p.limit ?? 0), 0)
  }
}

/** A Gemini limit's section: its totals in a line, then a row per profile. */
function GeminiSection({ label, usage, inUse, several }: {
  label: string; usage: PhoneGeminiUsage; inUse: { phone: string | null; account: string }[]; several: boolean
}) {
  const totals = geminiTotals(usage)
  const tone: Tone = totals.allLimited || (totals.allKnown && totals.left === 0) ? 'bad' : totals.limited > 0 ? 'warn' : 'good'
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className={cn('ml-auto whitespace-nowrap text-xs font-medium tabular-nums', TONE[tone].text)}>
          {totals.allLimited
            ? 'all at the limit'
            : totals.allKnown ? `${totals.left} / ${totals.capacity} left` : `${totals.today} used`}
        </span>
      </div>
      {/* With one profile, the run reports no account name: the selected profile is the one in use. */}
      {usage.profiles.map(p => (
        <GeminiRow
          key={p.id}
          profile={p}
          several={several}
          inUse={inUse.some(run => run.phone === p.phone && (run.account === p.name || (run.account === '' && p.selected)))}
        />
      ))}
    </div>
  )
}

/** Gemini requests per phone profile today, for the voiceover and narration runs, against the daily limit each last ran into. */
function GeminiLimitCard({ overview, now }: { overview: PhoneOverview | null; now: number }) {
  const speech = overview?.gemini?.speech?.profiles.length ? overview.gemini.speech : null
  const narration = overview?.gemini?.narration?.profiles.length ? overview.gemini.narration : null
  if (!speech && !narration) {
    return (
      <AnswerCard icon={Sparkles} question="Gemini limit">
        <Headline tone="idle" title="No data" detail="The phone hasn’t reported its AI Studio requests yet (older Sleeper-Cell builds don’t)." />
      </AnswerCard>
    )
  }
  // The profile each run of a kind is on, by phone: its name, '' when the phone has one profile (and names none).
  const onRun = (kind: PhoneOverviewRun['kind']) =>
    (overview?.runs ?? []).filter(r => r.kind === kind).map(r => ({ phone: r.phone, account: r.account ?? '' }))
  const several = (overview?.phones?.length ?? 0) > 1
  const sections = [
    speech && { label: 'Voiceover · speech', usage: speech, totals: geminiTotals(speech), inUse: onRun('voiceover') },
    narration && { label: 'Narration · scripts', usage: narration, totals: geminiTotals(narration), inUse: onRun('narration') }
  ].filter((x): x is NonNullable<typeof x> => !!x)
  const today = sections.reduce((sum, x) => sum + x.totals.today, 0)
  const resetsAt = Date.parse((speech ?? narration)!.resetsAt)
  const used = sections.filter(x => x.totals.allLimited)
  const unknown = sections.some(x => !x.totals.allKnown)

  const tone: Tone = used.length === sections.length ? 'bad' : used.length || sections.some(x => x.totals.limited) ? 'warn' : 'good'
  const detail = used.length
    ? <>{used.map(x => x.label.split(' ·')[0]).join(' and ')} {used.length === 1 ? 'is' : 'are'} at the limit on every profile until the reset ~{clock(resetsAt)}.</>
    : unknown
    ? 'A profile’s limit is learned the first time Gemini cuts it off; until then only its count shows.'
    : 'Every profile can still make requests.'

  return (
    <AnswerCard icon={Sparkles} question="Gemini limit">
      <Headline
        tone={tone}
        title={<>{today}<span className="text-lg font-semibold text-muted-foreground"> request{today === 1 ? '' : 's'} today</span></>}
        detail={detail}
      />
      {sections.map(x => <GeminiSection key={x.label} label={x.label} usage={x.usage} inUse={x.inUse} several={several} />)}
      <p className="mt-auto border-t pt-3 text-[11px] text-muted-foreground">
        AI Studio Run taps per profile; each limit is the count it reached before Gemini last stopped it. Speech and scripts are limited apart.
        Resets at midnight Pacific: ~{clock(resetsAt)} here{resetsAt > now && <>, in {span(resetsAt - now)}</>}.
      </p>
    </AnswerCard>
  )
}

// ─── Start and stop ─────────────────────────────────────────────────────────

/** Why Start and Stop can't reach the phone, or null when they can. */
function remoteBlocker(relay: RelayStatus | null, automation: PhoneAutomation | null): React.ReactNode | null {
  if (!relay?.configured) return <>Needs the phone relay: <Link to="/settings" className="underline">set it up</Link> in Settings → Cloudflare.</>
  if (!relay.connected) return 'Manhwa Studio can’t reach the relay right now.'
  if (!automation) return 'Update Sleeper-Cell on the phone: this build can’t be started from here.'
  if (!automation.remoteStart) return 'Turn on “Start from Manhwa Studio” on the phone: Tools → Settings → Automation.'
  return null
}

function automationSummary(automation: PhoneAutomation | null): string {
  if (!automation) return 'Start and stop Image Clipper on the phone from here.'
  const mode = automation.wakeMode === 'dedicated' ? 'Dedicated phone: unlocks itself and locks after' : 'Personal phone: runs over the lock screen'
  return `${mode} · resume after the limit ${automation.resumeAfterLimit ? 'on' : 'off'}`
}

/** "Every phone" for Stop, and for Start when there's one phone (or an older server that lists none). */
const ALL = 'all'
/** Start shares the series' chapters out between the phones that can be started. */
const SPLIT = 'split'

/** The chapters a phone was given, short: "Ch. 2, 5, 7" or "12 chapters". */
function chaptersLabel(chapters: string[], numbers: Map<string, number>): string {
  if (chapters.length > 6) return `${chapters.length} chapters`
  return `Ch. ${chapters.map(c => numbers.get(c) ?? c).join(', ')}`
}

/**
 * Starts Image Clipper on the phone, on a series it has, or stops it. The phone
 * wakes itself to start; what it does next shows in the cards above. With
 * several phones, Start splits the series between the ones that can be started
 * (each gets its own chapters, so none clips another's pages), or goes to one.
 */
function RemoteCard({ relay, overview, now }: { relay: RelayStatus | null; overview: PhoneOverview | null; now: number }) {
  const { toast } = useToast()
  const phones = overview?.phones ?? []
  const several = phones.length > 1
  const startable = phones.filter(p => p.id && p.connected && p.automation?.remoteStart)
  const choices = overview?.series ?? []
  // The series to offer first: the one waiting to resume, else the one running, else the first with pages left.
  const preferred = overview?.automation?.resume?.seriesId
    ?? overview?.working.find(w => w.seriesId)?.seriesId
    ?? choices.find(s => s.crops && s.crops.done < s.crops.total)?.id
    ?? choices[0]?.id
    ?? ''
  const [picked, setPicked] = useState('')
  const [tabs, setTabs] = useState<number | null>(null)
  const [pickedTarget, setPickedTarget] = useState('')
  const [sending, setSending] = useState<'start' | 'stop' | null>(null)
  const seriesId = picked || preferred

  const targets = [
    ...(startable.length >= 2 ? [{ value: SPLIT, label: `Split between ${startable.length} phones` }] : []),
    ...(several ? startable.map(p => ({ value: p.id, label: `Only ${p.name}` })) : [])
  ]
  const target = targets.some(t => t.value === pickedTarget) ? pickedTarget : targets[0]?.value ?? ALL
  const onePhone = target !== SPLIT && target !== ALL ? phones.find(p => p.id === target) ?? null : null
  // The phones Start goes to, and their automation (the only phone's, with one).
  const going = target === SPLIT ? startable : onePhone ? [onePhone] : phones
  const automation = onePhone?.automation ?? overview?.automation ?? null
  const busy = target === ALL && !several
    ? (overview?.working.length ?? 0) > 0
    : going.some(p => p.working > 0)
  const tabCount = tabs ?? automation?.resume?.tabs ?? DEFAULT_TABS
  const resumes = several
    ? phones.filter(p => p.automation?.resume).map(p => ({ phone: p.name, resume: p.automation!.resume! }))
    : automation?.resume ? [{ phone: null, resume: automation.resume }] : []
  const old = phones.find(p => !p.id)

  let blocker: React.ReactNode | null
  if (!several) {
    blocker = remoteBlocker(relay, automation)
  } else if (!relay?.configured || !relay.connected) {
    blocker = remoteBlocker(relay, automation)
  } else if (!startable.length) {
    blocker = 'No phone can be started now: open Sleeper-Cell and turn on “Start from Manhwa Studio” (Tools → Settings → Automation).'
  } else {
    blocker = null
  }
  const splitNeedsSeries = target === SPLIT && !seriesId

  const send = async (command: 'start' | 'stop') => {
    setSending(command)
    try {
      const options = command === 'start'
        ? { seriesId: seriesId || undefined, tabs: tabCount, ...(target === SPLIT ? { split: true } : onePhone ? { device: onePhone.id } : {}) }
        : onePhone ? { device: onePhone.id } : {}
      const sent = await r2Api.sendPhoneClipper(command, options)
      const numbers = new Map<string, number>()
      for (const w of overview?.working ?? []) if (w.chapterNumber !== null) numbers.set(w.chapter, w.chapterNumber)
      const split = command === 'start' && target === SPLIT && sent.targets?.length
      toast({
        title: command === 'start'
          ? split ? `Start sent to ${sent.targets!.length} phones` : 'Start sent to the phone'
          : onePhone ? `Stop sent to ${onePhone.name}` : 'Stop sent to the phone',
        description: split
          ? sent.targets!.map(t => `${t.name}: ${chaptersLabel(t.chapters ?? [], numbers)}${t.reached ? '' : ' (not connected)'}`).join(' · ')
          : sent.phones
          ? 'Sleeper-Cell got it. What it does shows here as it goes.'
          : 'The phone isn’t connected right now. It acts on this if it connects within 10 minutes.'
      })
    } catch (error) {
      toast({
        title: command === 'start' ? 'Could not start the phone' : 'Could not stop the phone',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive'
      })
    } finally {
      setSending(null)
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Play className="h-4 w-4 text-muted-foreground" />
          Image Clipper on the {several ? 'phones' : 'phone'}
        </CardTitle>
        <CardDescription>
          {several
            ? 'Split shares the series’ chapters left out between the phones, balanced by pages, in reading order: no page is clipped twice. Start again to share out what’s left.'
            : automationSummary(automation)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {resumes.map(({ phone, resume }) => (
          <p key={phone ?? 'one'} className="flex items-center gap-1.5 text-sm">
            <Clock className="h-4 w-4 flex-shrink-0 text-amber-500" />
            <span>
              {phone && <span className="font-medium">{phone}: </span>}
              Resumes <span className="font-medium">{resume.series}</span> at ~{clock(resume.at)}
              {Date.parse(resume.at) > now && <> (in {span(Date.parse(resume.at) - now)})</>} in {resume.tabs} tab{resume.tabs === 1 ? '' : 's'}.
              Stop cancels it.
            </span>
          </p>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <Select value={seriesId} onValueChange={setPicked} disabled={!choices.length}>
            <SelectTrigger className="w-72">
              <SelectValue placeholder="The phone’s last run" />
            </SelectTrigger>
            <SelectContent>
              {choices.map(s => (
                <SelectItem key={s.id} value={s.id}>
                  {s.title}{s.crops ? ` · ${s.crops.done}/${s.crops.total}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {several && targets.length > 0 && (
            <Select value={target} onValueChange={setPickedTarget}>
              <SelectTrigger className="w-60" aria-label="Which phones">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targets.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          <div className="flex items-center gap-1" role="group" aria-label="ChatGPT tabs">
            <span className="mr-1 text-xs text-muted-foreground">Tabs{target === SPLIT ? ' each' : ''}</span>
            {Array.from({ length: MAX_TABS }, (_, i) => i + 1).map(n => (
              <Button key={n} size="sm" variant={tabCount === n ? 'default' : 'outline'} className="h-8 w-8 p-0" onClick={() => setTabs(n)}>
                {n}
              </Button>
            ))}
          </div>
          <Button onClick={() => send('start')} disabled={!!blocker || busy || splitNeedsSeries || sending !== null}>
            {sending === 'start' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            {target === SPLIT ? 'Start split' : 'Start'}
          </Button>
          <Button
            variant="outline"
            onClick={() => send('stop')}
            disabled={!!blocker || (!going.some(p => p.working > 0) && !busy && !resumes.length) || sending !== null}
            title={onePhone ? `Stops ${onePhone.name} only` : several ? 'Stops every phone' : undefined}
          >
            {sending === 'stop' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
            {several && !onePhone ? 'Stop all' : 'Stop'}
          </Button>
        </div>
        {blocker
          ? <p className="flex items-center gap-1.5 text-xs text-amber-500"><AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />{blocker}</p>
          : busy && (
            <p className="text-xs text-muted-foreground">
              Image Clipper is running on {several ? going.filter(p => p.working > 0).map(p => p.name).join(' and ') : 'the phone'}: stop it to start another run.
            </p>
          )}
        {several && old && (
          <p className="text-xs text-muted-foreground">
            {old.name} runs a Sleeper-Cell build from before several phones: update it to start it from here or split with it.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ─── History ────────────────────────────────────────────────────────────────

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
      <td className="py-1.5 text-xs text-muted-foreground whitespace-nowrap">
        {several && <PhoneTag phone={finish.phone} className="mr-1.5" />}
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
    const ticking = (overview?.working.length ?? 0) + (overview?.runs.length ?? 0) > 0
    const timer = setInterval(() => setNow(Date.now()), ticking ? 1000 : MINUTE)
    return () => clearInterval(timer)
  }, [overview?.working.length, overview?.runs.length])

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
      const name = (overview.phones?.length ?? 0) > 1 && f.phone ? `${f.phone} · ${account}` : account
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
  }, [overview, now])

  const running = overview?.working.filter(w => !w.paused).length ?? 0
  const paused = (overview?.working.length ?? 0) - running
  // Is the phone busy at all: Image Clipper's pages plus the narration and voiceover runs.
  const runsActive = overview?.runs.filter(r => !r.paused).length ?? 0
  const runsPaused = (overview?.runs.length ?? 0) - runsActive
  const phoneClosed = !!relay?.configured && relay.connected && relay.phones === 0

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Smartphone className="h-7 w-7 text-primary" />
          <h1 className="text-3xl font-bold">Phone Status</h1>
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

      {/* The answers: active? · image limit · doing what? · Gemini limit */}
      <div className="mb-6 grid gap-6 md:grid-cols-2 2xl:grid-cols-4">
        <PhoneCard relay={relay} overview={overview} running={running + runsActive} paused={paused + runsPaused} now={now} />
        <ImageLimitCard overview={overview} now={now} />
        <DoingCard
          overview={overview}
          running={running}
          paused={paused}
          averageTook={stats?.averageTook ?? null}
          phoneClosed={phoneClosed}
          now={now}
        />
        <GeminiLimitCard overview={overview} now={now} />
      </div>

      {overview?.configured && <RemoteCard relay={relay} overview={overview} now={now} />}

      {/* Today's pace */}
      {stats && overview?.configured && (
        <Card className="mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Gauge className="h-4 w-4 text-muted-foreground" />
              Today
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Tile label="Pages done" value={`${stats.doneToday}${stats.capped ? '+' : ''}`} sub="with crop JSON" />
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
            </div>
            {stats.byAccount.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
                <span className="text-muted-foreground">Pages by account:</span>
                {stats.byAccount.map(([name, pages]) => (
                  <Badge key={name} variant="secondary" className="tabular-nums">{name} · {pages}</Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

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
                              {s.runs.includes('narration') && (
                                <Badge className="ml-2 bg-sky-600 hover:bg-sky-600">writing scripts</Badge>
                              )}
                              {s.runs.includes('voiceover') && (
                                <Badge className="ml-2 bg-sky-600 hover:bg-sky-600">voicing</Badge>
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
                            <FinishRow key={`${f.series}/${f.chapter}/${f.page}`} finish={f} several={(overview.phones?.length ?? 0) > 1} />
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
