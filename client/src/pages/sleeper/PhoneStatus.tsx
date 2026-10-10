/**
 * Phone Status — the phones themselves: is Sleeper-Cell open on each, how it
 * is set up to run (its Automation settings), its screen (Wake, Screen off,
 * Screenshot; see PhoneScreen.tsx), and Run automation and Stop for it: any of
 * the phone's runs, picked and set up in RunAutomation.tsx. One card per
 * phone; with two or more, Image Clipper can be split between them there, and
 * a bar stops every phone at once.
 *
 * What the runs are doing is on Live Progress, and the accounts' limits on
 * Accounts; each card links there in one line.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, Clock, Loader2, Play, Smartphone, Square, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import { usePhoneOverview } from '@/hooks/usePhoneOverview'
import { usePhoneRelay } from '@/hooks/usePhoneRelay'
import { usePhoneScreens } from '@/hooks/usePhoneScreens'
import { r2Api, type PhoneAutomationOptions, type PhoneOverview, type PhoneOverviewPhone, type PhoneScreen, type RelayStatus } from '@/lib/api'
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
import { AUTOMATION_NAME, RunAutomationDialog } from './RunAutomation'

type Command = 'start' | 'stop'
/** Sends a start or stop; resolves true once the relay took it. */
type Send = (command: Command, options: PhoneAutomationOptions, to: string | null) => Promise<boolean>

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

/** Why Run automation can't reach this phone, or null when it can. */
function startBlocker(relay: RelayStatus | null, phone: PhoneOverviewPhone, several: boolean): React.ReactNode | null {
  if (!relay?.configured) return <>Run automation and Stop need the phone relay: <Link to="/settings" className="underline">set it up</Link> in Settings → Cloudflare.</>
  if (!relay.connected) return 'Manhwa Studio can’t reach the relay right now.'
  if (several && !phone.id) return 'This is an old Sleeper-Cell build: update it to start it from here.'
  if (several && !phone.connected) return 'Open Sleeper-Cell on this phone to start it.'
  if (!phone.automation) return phone.reportedAt ? 'Update Sleeper-Cell: this build can’t be started from here.' : 'No report from it yet: Refresh from phone.'
  if (!phone.automation.remoteStart) return 'Turn on “Start from Manhwa Studio” on the phone: Tools → Settings → Automation.'
  return null
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

/** One phone: its state, what it's on in a line, its Automation settings, its screen, and Run automation and Stop. */
function PhoneCard({ phone, overview, relay, screen, several, startable, now, send, sending }: {
  phone: PhoneOverviewPhone
  overview: PhoneOverview | null
  relay: RelayStatus | null
  screen: PhoneScreen | null
  several: boolean
  startable: PhoneOverviewPhone[]
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
  const busy = activity.busy

  const usages = (overview?.profiles ?? []).filter(p => onPhone(p, phone, several)).map(p => uploadUsage(p, now))
  const imagesLeft = usages.reduce((sum, u) => sum + u.left, 0)
  const ready = usages.filter(u => u.left > 0).length

  const [open, setOpen] = useState(false)
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
          <SectionLabel>Automation settings <InfoTip text="Set on the phone: Sleeper-Cell → Tools → Settings → Automation." /></SectionLabel>
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

        {/* Run automation */}
        <div className="mt-auto space-y-3 border-t pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <SectionLabel>Runs</SectionLabel>
            <div className="ml-auto flex gap-2">
              {(busy || resume) && (
                <Button
                  variant="outline"
                  disabled={!!blocker || sending !== null}
                  title={resume && !busy ? 'Cancels the resume' : undefined}
                  onClick={() => send('stop', target, phone.name)}
                >
                  {sending === `stop:${key}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
                  Stop
                </Button>
              )}
              {!busy && (
                <Button disabled={!!blocker || sending !== null} onClick={() => setOpen(true)}>
                  <Play className="mr-2 h-4 w-4" /> Run automation
                </Button>
              )}
            </div>
          </div>
          {overview && open && (
            <RunAutomationDialog
              open={open}
              onOpenChange={setOpen}
              phone={phone}
              overview={overview}
              several={several}
              startable={startable}
              sending={sending === `start:${key}` || sending === 'start:all'}
              onStart={options => send('start', options, options.split ? null : phone.name)}
            />
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

/** With several phones that can be started: stops whatever runs on all of them at once. */
function StopAllBar({ startable, overview, send, sending }: {
  startable: PhoneOverviewPhone[]; overview: PhoneOverview | null; send: Send; sending: string | null
}) {
  const going = !!(overview?.working.length || overview?.runs.length || startable.some(p => p.automation?.resume))
  return (
    <Card className="mb-6">
      <CardContent className="flex flex-wrap items-center gap-3 p-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          {startable.length} phones ready
          <InfoTip text="Run automation on a phone’s card. Image Clipper can split a series between the phones there: no page is clipped twice." />
        </p>
        <Button className="ml-auto" variant="outline" disabled={sending !== null || !going} onClick={() => send('stop', {}, null)}>
          {sending === 'stop:all' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
          Stop all
        </Button>
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

  /** Sends a start or Stop to one phone (`to`, its name) or to every phone (null). */
  const send: Send = async (command, options, to) => {
    const phone = to === null ? null : phones.find(p => p.name === to) ?? null
    setSending(`${command}:${phone ? phone.id || phone.name : 'all'}`)
    try {
      const sent = await r2Api.sendPhoneAutomation(command, options)
      const numbers = new Map<string, number>()
      for (const w of overview?.working ?? []) if (w.chapterNumber !== null) numbers.set(w.chapter, w.chapterNumber)
      const split = command === 'start' && options.split && sent.targets?.length
      const verb = command === 'start' ? AUTOMATION_NAME[options.kind ?? 'clipper'] : 'Stop'
      toast({
        title: split ? `${verb} sent to ${sent.targets!.length} phones` : `${verb} sent to ${several ? to ?? 'every phone' : 'the phone'}`,
        description: split
          ? sent.targets!.map(t => `${t.name}: ${chaptersLabel(t.chapters ?? [], numbers)}${t.reached ? '' : ' (not connected)'}`).join(' · ')
          : sent.phones
          ? 'Sleeper-Cell got it. Live Progress shows what it does.'
          : 'The phone isn’t connected right now. It acts on this if it connects within 10 minutes.'
      })
      return true
    } catch (error) {
      toast({
        title: command === 'start' ? 'Could not start the run' : 'Could not stop the phone',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive'
      })
      return false
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
            {startable.length >= 2 && <StopAllBar startable={startable} overview={overview} send={send} sending={sending} />}
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
                      startable={startable}
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
