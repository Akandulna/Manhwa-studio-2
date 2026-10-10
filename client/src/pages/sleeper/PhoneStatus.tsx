/**
 * Phone Status — the phones themselves: is Sleeper-Cell open on each, how it
 * is set up to run (its Automation settings), its screen (Wake, Screen off,
 * Screenshot; see PhoneScreen.tsx), and Image Clipper's Start and Stop for it. One card per phone; with two or more that can be started, a
 * Split bar shares one series' chapters out between them.
 *
 * What the runs are doing is on Live Progress, and the accounts' limits on
 * Accounts; each card links there in one line.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, Clock, Loader2, Play, Smartphone, Split, Square, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { usePhoneOverview } from '@/hooks/usePhoneOverview'
import { usePhoneRelay } from '@/hooks/usePhoneRelay'
import { usePhoneScreens } from '@/hooks/usePhoneScreens'
import { r2Api, type PhoneOverview, type PhoneOverviewPhone, type PhoneScreen, type RelayStatus } from '@/lib/api'
import { uploadUsage } from '@/lib/uploadUsage'
import { cn } from '@/lib/utils'
import {
  ago,
  clock,
  InfoTip,
  Light,
  phoneActivity,
  phoneList,
  onPhone,
  plural,
  SleeperPage,
  span,
  TONE,
  useNow,
  type Tone
} from './sleeperShared'
import { PhoneScreenControls } from './PhoneScreen'

/** Image Clipper's most ChatGPT tabs at once (ClipperRun.MAX_TABS on the phone). */
const MAX_TABS = 4
const DEFAULT_TABS = 2

type Command = 'start' | 'stop'
type SendOptions = { seriesId?: string; tabs?: number; device?: string; split?: boolean }
type Send = (command: Command, options: SendOptions, to: string | null) => Promise<void>

/** The phone's state in a word or two, with the light for it. Red is only for Sleeper-Cell closed. */
function phoneState(phone: PhoneOverviewPhone, activity: ReturnType<typeof phoneActivity>, relay: RelayStatus | null, now: number) {
  const heard = phone.reportedAt ? `Last heard ${ago(phone.reportedAt, now)}` : 'No report from it yet'
  const resume = phone.automation?.resume ?? null
  const state = (tone: Tone, title: string, detail: string, extra: { live?: boolean; hollow?: boolean } = {}) =>
    ({ tone, title, detail, live: !!extra.live, hollow: !!extra.hollow })
  if (!relay?.configured || phone.connected === null) return state('idle', activity.title ?? 'Unknown', `${heard} · live status needs the relay`)
  if (!relay.connected) return state('warn', 'Can’t tell', `The relay is offline · ${heard}`)
  if (!phone.connected) return state('bad', 'Closed', `Sleeper-Cell isn’t open · ${heard}`)
  if (activity.going.length) return state('good', activity.title!, heard, { live: true })
  if (activity.paused) return state('warn', 'Paused', heard)
  if (resume) return state('warn', `Resumes ~${clock(resume.at)}`, `Waiting for the ChatGPT limit to lift · ${heard}`)
  return state('good', phone.automation?.remoteStart ? 'Ready' : 'Open · idle', heard, { hollow: true })
}

/** Why Start can't reach this phone, or null when it can. */
function startBlocker(relay: RelayStatus | null, phone: PhoneOverviewPhone, several: boolean): React.ReactNode | null {
  if (!relay?.configured) return <>Start and Stop need the phone relay: <Link to="/settings" className="underline">set it up</Link> in Settings → Cloudflare.</>
  if (!relay.connected) return 'Manhwa Studio can’t reach the relay right now.'
  if (several && !phone.id) return 'This is an old Sleeper-Cell build: update it to start it from here.'
  if (several && !phone.connected) return 'Open Sleeper-Cell on this phone to start it.'
  if (!phone.automation) return phone.reportedAt ? 'Update Sleeper-Cell: this build can’t be started from here.' : 'No report from it yet: Refresh from phone.'
  if (!phone.automation.remoteStart) return 'Turn on “Start from Manhwa Studio” on the phone: Tools → Settings → Automation.'
  return null
}

/** The series to offer first: the one waiting to resume, else the one running, else the first with pages left. */
function preferredSeries(overview: PhoneOverview | null, phone: PhoneOverviewPhone | null, several: boolean): string {
  const choices = overview?.series ?? []
  return (phone ? phone.automation?.resume?.seriesId : overview?.automation?.resume?.seriesId)
    ?? overview?.working.find(w => w.seriesId && (!phone || !several || w.phone === phone.name))?.seriesId
    ?? choices.find(s => s.crops && s.crops.done < s.crops.total)?.id
    ?? choices[0]?.id
    ?? ''
}

function SeriesSelect({ overview, value, onChange, className }: { overview: PhoneOverview | null; value: string; onChange: (id: string) => void; className?: string }) {
  const choices = overview?.series ?? []
  return (
    <Select value={value} onValueChange={onChange} disabled={!choices.length}>
      <SelectTrigger className={cn('h-9 w-64', className)} aria-label="Series">
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
  )
}

function TabPicker({ value, onChange, label = 'Tabs' }: { value: number; onChange: (n: number) => void; label?: string }) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="ChatGPT tabs">
      <span className="mr-1 text-xs text-muted-foreground">{label}</span>
      {Array.from({ length: MAX_TABS }, (_, i) => i + 1).map(n => (
        <Button key={n} size="sm" variant={value === n ? 'default' : 'outline'} className="h-8 w-8 p-0" onClick={() => onChange(n)}>
          {n}
        </Button>
      ))}
    </div>
  )
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  )
}

function OnOff({ on }: { on: boolean }) {
  return <span className={on ? '' : 'text-muted-foreground'}>{on ? 'On' : 'Off'}</span>
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</p>
}

/** One phone: its state, what it's on in a line, its Automation settings, its screen, and Image Clipper's Start and Stop. */
function PhoneCard({ phone, overview, relay, screen, several, now, send, sending }: {
  phone: PhoneOverviewPhone
  overview: PhoneOverview | null
  relay: RelayStatus | null
  screen: PhoneScreen | null
  several: boolean
  now: number
  send: Send
  sending: string | null
}) {
  const { toast } = useToast()
  const activity = phoneActivity(overview, phone, several)
  const state = phoneState(phone, activity, relay, now)
  const automation = phone.automation
  const resume = automation?.resume ?? null
  const blocker = startBlocker(relay, phone, several)
  const clipping = activity.working.length > 0

  const usages = (overview?.profiles ?? []).filter(p => onPhone(p, phone, several)).map(p => uploadUsage(p, now))
  const imagesLeft = usages.reduce((sum, u) => sum + u.left, 0)
  const ready = usages.filter(u => u.left > 0).length

  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState('')
  const [tabs, setTabs] = useState<number | null>(null)
  const seriesId = picked || preferredSeries(overview, phone, several)
  const tabCount = tabs ?? resume?.tabs ?? DEFAULT_TABS
  const target = several && phone.id ? { device: phone.id } : {}
  const key = phone.id || phone.name

  const [forgetting, setForgetting] = useState(false)
  const forget = async () => {
    if (!window.confirm(`Forget “${phone.name}”? Its last status is dropped from here and from the relay. It comes back if it reports again.`)) return
    setForgetting(true)
    try {
      await r2Api.forgetPhone(phone.id)
    } catch (error) {
      toast({ title: 'Could not forget the phone', description: error instanceof Error ? error.message : String(error), variant: 'destructive' })
    } finally {
      setForgetting(false)
    }
  }

  return (
    <Card className={cn('flex flex-col', state.tone === 'bad' && 'border-red-500/40')}>
      <CardContent className="flex flex-1 flex-col gap-5 p-5">
        {/* State */}
        <div className="flex items-start gap-3">
          <span className="pt-1.5"><Light tone={state.tone} live={state.live} hollow={state.hollow} size="h-3.5 w-3.5" /></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="truncate text-lg font-semibold" title={phone.id ? `id ${phone.id}` : undefined}>{phone.name}</h2>
              <span className={cn('text-lg font-semibold', state.tone === 'idle' || state.hollow ? 'text-foreground' : TONE[state.tone].text)}>
                {state.title}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">{state.detail}</p>
          </div>
          {relay?.configured && phone.connected === false && (
            <Button variant="ghost" size="sm" className="h-8 flex-shrink-0 gap-1.5 px-2 text-muted-foreground" title="Forget this phone" disabled={forgetting} onClick={forget}>
              {forgetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Forget
            </Button>
          )}
        </div>

        {/* Pointers to the other two pages */}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <Row label="Now">
            <Link to="/sleeper-cells/live" className="inline-flex items-center gap-1 hover:underline">
              {activity.title ?? <span className="text-muted-foreground">Nothing running</span>}
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            </Link>
          </Row>
          <Row label="ChatGPT images">
            <Link to="/sleeper-cells/accounts" className="inline-flex items-center gap-1 tabular-nums hover:underline">
              {usages.length
                ? <>{imagesLeft} left <span className="text-muted-foreground">· {ready} of {plural(usages.length, 'account')} ready</span></>
                : <span className="text-muted-foreground">Not reported</span>}
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            </Link>
          </Row>
        </dl>

        {/* Automation */}
        <div className="space-y-2">
          <SectionLabel>Automation <InfoTip text="Set on the phone: Sleeper-Cell → Tools → Settings → Automation." /></SectionLabel>
          {automation
            ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <Row label="Start from Manhwa Studio"><OnOff on={automation.remoteStart} /></Row>
                <Row label="Wake">
                  {automation.wakeMode === 'dedicated'
                    ? <>Dedicated <span className="text-muted-foreground">· unlocks, locks after</span></>
                    : <>Personal <span className="text-muted-foreground">· over the lock screen</span></>}
                </Row>
                <Row label="Resume after the limit"><OnOff on={automation.resumeAfterLimit} /></Row>
              </dl>
            )
            : <p className="text-sm text-muted-foreground">Not reported by this Sleeper-Cell build.</p>}
          {resume && (
            <p className="flex items-center gap-1.5 text-sm text-amber-500">
              <Clock className="h-4 w-4 flex-shrink-0" />
              <span>
                Resumes <span className="font-medium">{resume.series}</span> ~{clock(resume.at)}
                {Date.parse(resume.at) > now && <> (in {span(Date.parse(resume.at) - now)})</>} · {plural(resume.tabs, 'tab')}
              </span>
            </p>
          )}
        </div>

        {/* Screen */}
        <div className="border-t pt-4">
          <PhoneScreenControls phone={phone} relay={relay} screen={screen} now={now} />
        </div>

        {/* Image Clipper controls */}
        <div className="mt-auto space-y-3 border-t pt-4">
          <div className="flex items-center gap-2">
            <SectionLabel>Image Clipper</SectionLabel>
            <div className="ml-auto flex gap-2">
              {(clipping || resume) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!blocker || sending !== null}
                  title={resume && !clipping ? 'Cancels the resume' : undefined}
                  onClick={() => send('stop', target, phone.name)}
                >
                  {sending === `stop:${key}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
                  Stop
                </Button>
              )}
              {!clipping && !open && (
                <Button size="sm" disabled={!!blocker || sending !== null} onClick={() => setOpen(true)}>
                  <Play className="mr-2 h-4 w-4" /> Start…
                </Button>
              )}
            </div>
          </div>
          {open && !clipping && (
            <div className="flex flex-wrap items-center gap-3 rounded-md bg-secondary/40 p-3">
              <SeriesSelect overview={overview} value={seriesId} onChange={setPicked} className="w-auto min-w-0 flex-1" />
              <TabPicker value={tabCount} onChange={setTabs} />
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0" title="Cancel" onClick={() => setOpen(false)}>
                  <X className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  disabled={!!blocker || sending !== null}
                  onClick={() => send('start', { seriesId: seriesId || undefined, tabs: tabCount, ...target }, phone.name).then(() => setOpen(false))}
                >
                  {sending === `start:${key}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                  Start
                </Button>
              </div>
            </div>
          )}
          {blocker && (
            <p className="flex items-start gap-1.5 text-xs text-amber-500">
              <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" />
              <span>{blocker}</span>
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/** The chapters a phone was given, short: "Ch. 2, 5, 7" or "12 chapters". */
function chaptersLabel(chapters: string[], numbers: Map<string, number>): string {
  if (chapters.length > 6) return `${chapters.length} chapters`
  return `Ch. ${chapters.map(c => numbers.get(c) ?? c).join(', ')}`
}

/** One series split between the phones that can be started: each gets its own chapters, so no page is clipped twice. */
function SplitBar({ startable, overview, send, sending }: {
  startable: PhoneOverviewPhone[]; overview: PhoneOverview | null; send: Send; sending: string | null
}) {
  const [picked, setPicked] = useState('')
  const [tabs, setTabs] = useState(DEFAULT_TABS)
  const seriesId = picked || preferredSeries(overview, null, true)
  const clipping = startable.filter(p => p.working > 0)
  return (
    <Card className="mb-6">
      <CardContent className="flex flex-wrap items-center gap-3 p-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Split className="h-4 w-4 text-muted-foreground" />
          Split across {startable.length} phones
          <InfoTip text="Shares the series’ chapters left out between the phones, balanced by pages, in reading order: no page is clipped twice. Start again to share out what’s left." />
        </p>
        <SeriesSelect overview={overview} value={seriesId} onChange={setPicked} />
        <TabPicker value={tabs} onChange={setTabs} label="Tabs each" />
        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            disabled={sending !== null || !(overview?.working.length || startable.some(p => p.automation?.resume))}
            onClick={() => send('stop', {}, null)}
          >
            {sending === 'stop:all' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
            Stop all
          </Button>
          <Button
            disabled={sending !== null || !seriesId || clipping.length > 0}
            title={clipping.length ? `${clipping.map(p => p.name).join(' and ')} ${clipping.length === 1 ? 'is' : 'are'} clipping: stop first.` : undefined}
            onClick={() => send('start', { seriesId, tabs, split: true }, null)}
          >
            {sending === 'start:all' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            Start split
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** How Manhwa Studio hears from the phones, in one line. */
function ConnectionStrip({ relay, overview, phones, now }: { relay: RelayStatus | null; overview: PhoneOverview | null; phones: PhoneOverviewPhone[]; now: number }) {
  const open = phones.filter(p => p.connected).length
  const [tone, text]: [Tone, string] = !relay?.configured
    ? ['idle', 'No relay · status on Refresh only']
    : !relay.connected ? ['warn', 'Relay offline · reconnecting'] : ['good', 'Live through the relay']
  const receipts = overview?.configured
    ? `Last receipts: downloads ${clock(overview.reported.sync)} · scripts ${clock(overview.reported.scripts)} · crops ${clock(overview.reported.crops)}`
    : 'No receipts yet.'
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-card px-4 py-3 text-sm">
      <span className="flex items-center gap-2" title={relay?.lastError ?? undefined}>
        <Light tone={tone} size="h-2.5 w-2.5" />
        <span className="font-medium">{text}</span>
      </span>
      {relay?.configured && relay.connected && phones.length > 0 && (
        <span className="text-muted-foreground"><span className="text-foreground tabular-nums">{open} of {phones.length}</span> open</span>
      )}
      <span className="flex items-center gap-1.5 text-muted-foreground">
        Last heard <span className="text-foreground">{ago(overview?.reportedAt ?? null, now)}</span>
        <InfoTip text={receipts} />
      </span>
      {!relay?.configured && <Link to="/settings" className="ml-auto text-xs underline">Set up the relay for live status</Link>}
    </div>
  )
}

export default function PhoneStatus() {
  const receipt = usePhoneOverview()
  const relay = usePhoneRelay()
  const screens = usePhoneScreens()
  const overview = receipt.status
  const { toast } = useToast()
  const now = useNow(false)
  const phones = useMemo(() => phoneList(overview, relay), [overview, relay])
  const several = phones.length > 1
  const startable = phones.filter(p => p.id && p.connected && p.automation?.remoteStart)
  const [sending, setSending] = useState<string | null>(null)

  /** Sends Start or Stop to one phone (`to`, its name) or to every phone (null). */
  const send: Send = async (command, options, to) => {
    const phone = to === null ? null : phones.find(p => p.name === to) ?? null
    setSending(`${command}:${phone ? phone.id || phone.name : 'all'}`)
    try {
      const sent = await r2Api.sendPhoneClipper(command, options)
      const numbers = new Map<string, number>()
      for (const w of overview?.working ?? []) if (w.chapterNumber !== null) numbers.set(w.chapter, w.chapterNumber)
      const split = command === 'start' && options.split && sent.targets?.length
      const verb = command === 'start' ? 'Start' : 'Stop'
      toast({
        title: split ? `Start sent to ${sent.targets!.length} phones` : `${verb} sent to ${several ? to ?? 'every phone' : 'the phone'}`,
        description: split
          ? sent.targets!.map(t => `${t.name}: ${chaptersLabel(t.chapters ?? [], numbers)}${t.reached ? '' : ' (not connected)'}`).join(' · ')
          : sent.phones
          ? 'Sleeper-Cell got it. Live Progress shows what it does.'
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
    <SleeperPage icon={Smartphone} title="Phone Status" receipt={receipt}>
      {!overview
        ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        : (
          <>
            <ConnectionStrip relay={relay} overview={overview} phones={phones} now={now} />
            {startable.length >= 2 && <SplitBar startable={startable} overview={overview} send={send} sending={sending} />}
            {phones.length === 0
              ? overview.configured && (
                <Card><CardContent className="p-5 text-sm text-muted-foreground">No phone has reported yet. Open Sleeper-Cell on the phone, then Refresh from phone.</CardContent></Card>
              )
              : (
                <div className={cn('grid gap-6', several && 'lg:grid-cols-2')}>
                  {phones.map(phone => (
                    <PhoneCard
                      key={phone.id || phone.name}
                      phone={phone}
                      overview={overview}
                      relay={relay}
                      screen={screens.get(phone.id) ?? null}
                      several={several}
                      now={now}
                      send={send}
                      sending={sending}
                    />
                  ))}
                </div>
              )}
          </>
        )}
    </SleeperPage>
  )
}
