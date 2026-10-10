/**
 * A phone's screen on its Phone Status card: whether it's on, Wake (on with
 * Sleeper-Cell over the lock screen, kept on until Screen off), Screen off,
 * and Screenshot of the browser tabs a run is using (the tab shown when
 * nothing runs). Each goes through the relay; the phone answers with its
 * screen state, which `usePhoneScreens` picks up.
 *
 * A screenshot is kept nowhere: it opens in a viewer as soon as it comes,
 * held there as in-memory blobs (never the browser's cache), with Download
 * buttons; closing the viewer drops it here and on the server.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, Camera, Download, Eye, Loader2, Power, Sun } from 'lucide-react'
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

type Screenshot = NonNullable<PhoneScreen['screenshot']>
type Shot = Screenshot['shots'][number]

/** "Nord Tab 1 · ChatGPT 2026-10-11 14-05.jpg", safe as a file name. */
function fileName(phone: string, label: string, takenAt: string): string {
  const at = new Date(takenAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
  return `${phone} ${label} ${stamp}`.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 150) + '.jpg'
}

function save(url: string, name: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
}

/**
 * One screenshot, its tabs side by side to pick from. The images are fetched
 * once into blob URLs, revoked on close; `onClose` drops it on the server.
 */
function ScreenshotViewer({ phone, shot, now, onClose }: { phone: string; shot: Screenshot; now: number; onClose: () => void }) {
  const [images, setImages] = useState<(Shot & { blob: string })[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [index, setIndex] = useState(0)

  useEffect(() => {
    let cancelled = false
    const made: string[] = []
    Promise.all(shot.shots.map(async s => {
      const res = await fetch(s.url, { cache: 'no-store' })
      if (!res.ok) throw new Error(res.status === 404 ? 'It was dropped already (10 minutes unseen).' : `The server answered HTTP ${res.status}`)
      const blob = URL.createObjectURL(await res.blob())
      made.push(blob)
      return { ...s, blob }
    }))
      .then(list => { if (!cancelled) setImages(list) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => {
      cancelled = true
      made.forEach(url => URL.revokeObjectURL(url))
    }
  }, [shot])

  const current = images?.[Math.min(index, images.length - 1)] ?? null
  const saveAll = () => images?.forEach((img, i) => setTimeout(() => save(img.blob, fileName(phone, img.label, shot.takenAt)), i * 300))

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="flex max-h-[96vh] max-w-[min(96vw,60rem)] flex-col gap-3 p-4">
        <DialogTitle className="pr-8 text-sm font-medium">
          {phone} · Screenshot <span className="font-normal text-muted-foreground">· taken {ago(shot.takenAt, now)}</span>
        </DialogTitle>
        {error
          ? <p className="text-sm text-amber-500">{error}</p>
          : !images
          ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
          : (
            <>
              {images.length > 1 && (
                <div className="flex flex-wrap gap-2">
                  {images.map((img, i) => (
                    <Button key={img.url} size="sm" variant={img === current ? 'default' : 'outline'} className="max-w-[16rem]" onClick={() => setIndex(i)}>
                      <span className="truncate">{img.label}</span>
                    </Button>
                  ))}
                </div>
              )}
              {current && <img src={current.blob} alt={current.label} className="mx-auto min-h-0 max-h-[72vh] w-auto rounded border object-contain" />}
            </>
          )}
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">Kept nowhere: closing deletes it. Download what you want to keep.</p>
          <div className="ml-auto flex gap-2">
            {images && images.length > 1 && (
              <Button size="sm" variant="outline" onClick={saveAll}>
                <Download className="mr-2 h-4 w-4" /> Download all
              </Button>
            )}
            <Button size="sm" disabled={!current} onClick={() => current && save(current.blob, fileName(phone, current.label, shot.takenAt))}>
              <Download className="mr-2 h-4 w-4" /> Download
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
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
  /** The Screenshot or Wake whose screenshot opens the viewer by itself when it comes. */
  const [wantShot, setWantShot] = useState<string | null>(null)
  /** The screenshot open in the viewer, as it was when opened. */
  const [viewing, setViewing] = useState<Screenshot | null>(null)

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
  useEffect(() => {
    if (shot && wantShot && shot.answers === wantShot) {
      setViewing(shot)
      setWantShot(null)
    }
  }, [shot, wantShot])

  const closeViewer = () => {
    setViewing(null)
    r2Api.dropPhoneScreenshot(phone.id).catch(() => { /* gone already, or dropped after 10 minutes anyway */ })
  }

  const send = async (command: Command) => {
    setSending(command)
    try {
      const sent = await r2Api.sendPhoneScreen(command, phone.id)
      setWaiting({ command, id: sent.id })
      if (command !== 'off') setWantShot(sent.id)
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

      {shot && !viewing && (
        <div className="flex items-center gap-2 rounded-md bg-secondary/40 px-3 py-2 text-sm">
          <Camera className="h-4 w-4 text-muted-foreground" />
          <span>Screenshot waiting <span className="text-muted-foreground">· taken {ago(shot.takenAt, now)} · deleted unseen after 10 minutes</span></span>
          <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => setViewing(shot)}>
            <Eye className="mr-1.5 h-3.5 w-3.5" /> View
          </Button>
        </div>
      )}

      {viewing && <ScreenshotViewer phone={phone.name} shot={viewing} now={now} onClose={closeViewer} />}
    </div>
  )
}
