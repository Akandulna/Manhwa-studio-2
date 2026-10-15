/**
 * What the three Sleeper Cells pages share: Phone Status (the phones and their
 * controls), Accounts (ChatGPT and Gemini limits and plans) and Live Progress
 * (what the automation is doing). All three read the same overview receipt.
 *
 * Colour rule (the user's): red only for Sleeper-Cell closed on a phone; amber
 * for limits, stuck or paused work and waiting runs; green only for work
 * running now. Everything else is grey.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Info, Smartphone } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { PhoneRefreshButton } from '@/components/PhoneRefreshButton'
import type { PhoneReceipt } from '@/hooks/usePhoneReceipt'
import type { PhoneOverview, PhoneOverviewPhone, PhoneOverviewRun, RelayStatus } from '@/lib/api'
import { cn } from '@/lib/utils'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

export type Tone = 'good' | 'warn' | 'bad' | 'idle'

export const TONE: Record<Tone, { dot: string; ring: string; text: string; bar: string }> = {
  good: { dot: 'bg-emerald-500', ring: 'border-emerald-500', text: 'text-emerald-500', bar: 'bg-emerald-500' },
  warn: { dot: 'bg-amber-500', ring: 'border-amber-500', text: 'text-amber-500', bar: 'bg-amber-500' },
  bad: { dot: 'bg-red-500', ring: 'border-red-500', text: 'text-red-500', bar: 'bg-red-500' },
  idle: { dot: 'bg-muted-foreground/50', ring: 'border-muted-foreground/60', text: 'text-muted-foreground', bar: 'bg-muted-foreground/50' }
}

export function clock(iso: string | number | null): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

export function ago(iso: string | null, now: number): string {
  const at = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(at)) return 'never'
  const ms = Math.max(0, now - at)
  if (ms < MINUTE) return 'just now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`
  if (ms < 24 * HOUR) return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MINUTE)}m ago`
  return `${Math.floor(ms / (24 * HOUR))}d ago`
}

/** A stretch of time ahead: 55m, 1h 20m. */
export function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}

export function chapterLabel(place: { chapter: string; chapterNumber: number | null }): string {
  return place.chapterNumber !== null ? `Ch. ${place.chapterNumber}` : place.chapter
}

/** The page name without its extension: page_004.webp → page_004. */
export function pageLabel(page: string): string {
  return page.replace(/\.[a-z0-9]+$/i, '')
}

/**
 * A plan as Sleeper-Cell's profile check reports it, to show: ChatGPT's "plus" → "Plus", Gemini's "Google AI Pro" →
 * "AI Pro", "paid" → "Paid". Null when not known.
 */
export function planLabel(plan: string | null | undefined): string | null {
  const name = plan?.replace(/^google\s+/i, '').trim()
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Re-renders for the elapsed times: every second while something runs, else every minute. No request. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ticking ? 1000 : MINUTE)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

/**
 * The phones, as the server lists them; an older server lists none, so the one
 * phone is made up from the overview (it can only be started as "every phone").
 */
export function phoneList(overview: PhoneOverview | null, relay: RelayStatus | null): PhoneOverviewPhone[] {
  if (!overview) return []
  if (overview.phones?.length) return overview.phones
  if (!overview.reportedAt && !relay?.configured) return []
  return [{
    id: '',
    name: overview.device ?? 'Phone',
    connected: relay?.configured && relay.connected ? relay.phones > 0 : null,
    reportedAt: overview.reportedAt,
    automation: overview.automation,
    working: overview.working.length,
    runs: overview.runs.length
  }]
}

/** Is an item (a page, run or profile, labelled with its phone's name) on this phone. With one phone, everything is. */
export function onPhone(item: { phone: string | null }, phone: PhoneOverviewPhone, several: boolean): boolean {
  return !several || item.phone === phone.name
}

/** A narration, Editor 2.0 or voiceover run's headline: "Writing scripts", "Making timelines", "Voicing 3 splits". */
export function runTitle(run: PhoneOverviewRun): string {
  if (run.kind === 'narration') return run.tabs[0]?.language === 'hi' ? 'Converting to Hindi' : 'Writing scripts'
  if (run.kind === 'editor') return run.tabs.length > 1 ? `Making ${run.tabs.length} timelines` : 'Making timelines'
  return run.tabs.length > 1 ? `Voicing ${run.tabs.length} splits` : 'Voicing'
}

/** What one phone is doing, from the overview: its pages and runs, and the headline for them. */
export function phoneActivity(overview: PhoneOverview | null, phone: PhoneOverviewPhone, several: boolean) {
  const working = (overview?.working ?? []).filter(w => onPhone(w, phone, several))
  const runs = (overview?.runs ?? []).filter(r => onPhone(r, phone, several))
  const clipping = working.filter(w => !w.paused).length
  const activeRuns = runs.filter(r => !r.paused)
  // Image Clipper first: "Clipping 2 pages", then "Writing scripts", "Voicing 3 splits".
  const going = [...(clipping ? [`Clipping ${plural(clipping, 'page')}`] : []), ...activeRuns.map(runTitle)]
  const paused = working.length - clipping + runs.length - activeRuns.length
  return {
    working,
    runs,
    going,
    paused,
    busy: working.length + runs.length > 0,
    title: going.length ? going.join(' · ') : paused ? 'Paused' : null
  }
}

/** A status light: solid, pulsing while `live`, or a hollow ring for open-but-idle. */
export function Light({ tone, live = false, hollow = false, size = 'h-3 w-3' }: { tone: Tone; live?: boolean; hollow?: boolean; size?: string }) {
  return (
    <span className={cn('relative inline-flex flex-shrink-0', size)}>
      {live && <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', TONE[tone].dot)} />}
      <span className={cn('relative inline-flex rounded-full', size, hollow ? cn('border-2', TONE[tone].ring) : TONE[tone].dot)} />
    </span>
  )
}

/** A thin meter whose colour carries its meaning. */
export function Bar({ percent, tone, className }: { percent: number; tone: Tone | 'primary'; className?: string }) {
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-secondary', className)}>
      <div
        className={cn('h-full rounded-full transition-all', tone === 'primary' ? 'bg-primary' : TONE[tone].bar)}
        style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
      />
    </div>
  )
}

/** The explanation behind a label, on hover, so the page itself stays short. */
export function InfoTip({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn('inline-flex cursor-help text-muted-foreground/70 hover:text-muted-foreground', className)} title={text} aria-label={text}>
      <Info className="h-3.5 w-3.5" />
    </span>
  )
}

/** A phone's name as a small heading, when there are several. */
export function PhoneHeading({ name, className }: { name: string; className?: string }) {
  return (
    <p className={cn('flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground', className)}>
      <Smartphone className="h-3.5 w-3.5" />
      {name}
    </p>
  )
}

/** A Sleeper Cells page: its title, Refresh from phone, and the warning when nothing can reach the phone. */
export function SleeperPage({ icon: Icon, title, receipt, children }: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  receipt: PhoneReceipt<PhoneOverview>
  children: React.ReactNode
}) {
  const overview = receipt.status
  return (
    <div className="p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Icon className="h-7 w-7 text-primary" />
          <h1 className="text-3xl font-bold">{title}</h1>
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
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      {children}
    </div>
  )
}
