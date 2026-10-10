/**
 * A phone's screen on its Phone Status card: whether it's on, Wake (on with
 * Sleeper-Cell over the lock screen, kept on until Screen off), Screen off,
 * and Screenshot of the browser tabs a run is using (the tab shown when
 * nothing runs). Each goes through the relay; the phone answers with its
 * screen state, which `usePhoneScreens` picks up.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, Camera, Loader2, Power, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { r2Api, type PhoneOverviewPhone, type PhoneScreen, type RelayStatus } from '@/lib/api'
import { ago, InfoTip, Light, type Tone } from './sleeperShared'

type Command = 'on' | 'off' | 'shot'

/** How long to wait for the phone's answer before saying it didn't come. */
const ANSWER_MS = 25_000

const ACTION_OF: Record<Command, string> = { on: 'screen_on', off: 'screen_off', shot: 'screenshot' }
const LABEL: Record<string, string> = { screen_on: 'Wake', screen_off: 'Screen off', screenshot: 'Screenshot' }

/** Why the screen controls can't reach this phone, or null when they can. */
function screenBlocker(relay: RelayStatus | null, phone: PhoneOverviewPhone): string | null {
  if (!relay?.configured) return 'The screen controls need the phone relay (Settings → Cloudflare).'
  if (!relay.connected) return 'Manhwa Studio can’t reach the relay right now.'
  if (!phone.id) return 'This is an old Sleeper-Cell build: update it to use the screen controls.'
  if (!phone.connected) return 'Sleeper-Cell isn’t connected: with “Start from Manhwa Studio” on, it stays connected with the screen off.'
  return null
}

function stateLine(screen: PhoneScreen['screen']): { tone: Tone; text: string } {
  if (!screen) return { tone: 'idle', text: 'Not reported yet' }
  if (!screen.on) return { tone: 'idle', text: screen.locked ? 'Off · locked' : 'Off' }
  const parts = [screen.keptOn ? 'On · kept on' : 'On']
  parts.push(screen.appOpen ? 'Sleeper-Cell showing' : 'another app showing')
  if (screen.locked) parts.push('over the lock screen')
  return { tone: 'good', text: parts.join(' · ') }
}

export function PhoneScreenControls({ phone, relay, screen, now }: {
  phone: PhoneOverviewPhone
  relay: RelayStatus | null
  screen: PhoneScreen | null
  now: number
}) {
  const { toast } = useToast()
  const [sending, setSending] = useState<Command | null>(null)
  /** A command sent, until the phone answers it or [ANSWER_MS] pass. */
  const [waiting, setWaiting] = useState<{ command: Command; id: string } | null>(null)
  const [late, setLate] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)

  const state = screen?.screen ?? null
  const last = state?.last ?? null
  const shot = screen?.screenshot ?? null
  const blocker = screenBlocker(relay, phone)
  const noRemote = phone.automation ? !phone.automation.remoteStart : state ? !state.remoteStart : false

  const answered = !!waiting && state?.answers === waiting.id
  useEffect(() => {
    if (!waiting || answered) return
    setLate(false)
    const timer = setTimeout(() => setLate(true), ANSWER_MS)
    return () => clearTimeout(timer)
  }, [waiting, answered])
  useEffect(() => {
    if (answered) setWaiting(null)
  }, [answered])

  const send = async (command: Command) => {
    setSending(command)
    try {
      const sent = await r2Api.sendPhoneScreen(command, phone.id)
      setWaiting({ command, id: sent.id })
      if (!sent.reached) {
        toast({ title: `${LABEL[ACTION_OF[command]]} sent`, description: 'The phone isn’t connected right now. It acts on this if it connects within 2 minutes.' })
      }
    } catch (error) {
      toast({ title: `Could not send ${LABEL[ACTION_OF[command]]}`, description: error instanceof Error ? error.message : String(error), variant: 'destructive' })
    } finally {
      setSending(null)
    }
  }

  const line = stateLine(state)
  const busy = sending !== null || (!!waiting && !late)
  const viewed = viewing !== null ? shot?.shots[viewing] : null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Screen
          <InfoTip text="Wake turns the screen on with Sleeper-Cell (over the lock screen with a PIN) and keeps it on until Screen off, or until you turn it off on the phone. Screen off locks the phone when Sleeper-Cell is a device admin (Settings → Automation); during a run it only makes the screen look off, so the run goes on. Screenshot shows the tabs a run is using, or the tab shown." />
        </p>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!!blocker || noRemote || busy}
            title={noRemote ? 'Turn on “Start from Manhwa Studio” on the phone first' : undefined}
            onClick={() => send('on')}
          >
            {sending === 'on' || (waiting?.command === 'on' && !late) ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sun className="mr-2 h-4 w-4" />}
            Wake
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!!blocker || noRemote || busy}
            title={noRemote ? 'Turn on “Start from Manhwa Studio” on the phone first' : undefined}
            onClick={() => send('off')}
          >
            {sending === 'off' || (waiting?.command === 'off' && !late) ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Power className="mr-2 h-4 w-4" />}
            Screen off
          </Button>
          <Button size="sm" variant="outline" disabled={!!blocker || busy} onClick={() => send('shot')}>
            {sending === 'shot' || (waiting?.command === 'shot' && !late) ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Camera className="mr-2 h-4 w-4" />}
            Screenshot
          </Button>
        </div>
      </div>

      <div className="space-y-1 text-sm">
        <p className="flex items-center gap-2">
          <Light tone={line.tone} hollow={line.tone === 'good' && !state?.keptOn} size="h-2.5 w-2.5" />
          <span>{line.text}</span>
          {state && <span className="text-muted-foreground">· {ago(state.at, now)}</span>}
        </p>
        {last && !waiting && (
          <p className={last.ok ? 'text-muted-foreground' : 'text-amber-500'}>
            {LABEL[last.action] ?? last.action}: {last.note} <span className="text-muted-foreground">· {ago(last.at, now)}</span>
          </p>
        )}
        {waiting && late && (
          <p className="flex items-start gap-1.5 text-amber-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            No answer to {LABEL[ACTION_OF[waiting.command]]} yet. Sleeper-Cell may need updating for the screen controls.
          </p>
        )}
        {(blocker || noRemote) && (
          <p className="flex items-start gap-1.5 text-xs text-amber-500">
            <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" />
            <span>{blocker ?? 'Wake and Screen off need “Start from Manhwa Studio” on: Tools → Settings → Automation.'}</span>
          </p>
        )}
      </div>

      {shot && (
        <div className="space-y-1.5">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {shot.shots.map((s, i) => (
              <button
                key={s.url}
                type="button"
                className="group flex-shrink-0 overflow-hidden rounded-md border bg-black text-left"
                title={`${s.label}: click to enlarge`}
                onClick={() => setViewing(i)}
              >
                <img src={s.url} alt={s.label} className="h-44 w-auto object-contain transition-opacity group-hover:opacity-90" />
                <span className="block max-w-[8.5rem] truncate bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground">{s.label}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Screenshot taken {ago(shot.takenAt, now)}</p>
        </div>
      )}

      <Dialog open={!!viewed} onOpenChange={open => { if (!open) setViewing(null) }}>
        <DialogContent className="max-w-[min(96vw,56rem)] p-3">
          <DialogTitle className="pr-8 text-sm font-medium">{phone.name} · {viewed?.label}</DialogTitle>
          {viewed && <img src={viewed.url} alt={viewed.label} className="mx-auto max-h-[80vh] w-auto rounded object-contain" />}
        </DialogContent>
      </Dialog>
    </div>
  )
}
