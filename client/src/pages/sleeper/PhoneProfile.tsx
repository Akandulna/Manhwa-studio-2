/**
 * A phone's browser profile on its Phone Status card: which one is selected
 * (the one the next run starts in; changed only with no run going), and that
 * profile's ChatGPT settings for Image Clipper (mode, model, effort), picked
 * from what its account offers. "Read options" has the phone open ChatGPT in
 * the profile and read its modes, models and efforts (waking the phone for it
 * when Sleeper-Cell isn't on screen). Each goes through the relay; the phone
 * answers in its profiles, and with how it went in its screen receipt.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw, Save, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import {
  r2Api,
  type PhoneChatGptMode,
  type PhoneChatGptSettings,
  type PhoneOverviewPhone,
  type PhoneScreen,
  type PhoneUploadProfile,
  type RelayStatus
} from '@/lib/api'
import { ago, InfoTip } from './sleeperShared'

type Command = 'select' | 'settings' | 'options'

/** The Select value for "as the account has it" (an item can't have ""). */
const AS_IS = '__as_is'

const LABEL: Record<Command, string> = { select: 'Select profile', settings: 'ChatGPT settings', options: 'Read options' }

/** How long each waits for the phone's answer: reading options can mean waking the phone and a dozen taps. */
const ANSWER_MS: Record<Command, number> = { select: 25_000, settings: 25_000, options: 180_000 }

function blockerOf(relay: RelayStatus | null, phone: PhoneOverviewPhone): string | null {
  if (!relay?.configured) return 'Profile controls need the phone relay (Settings → Cloudflare).'
  if (!relay.connected) return 'Manhwa Studio can’t reach the relay right now.'
  if (!phone.id) return 'This is an old Sleeper-Cell build: update it to use the profile controls.'
  if (!phone.connected) return 'Sleeper-Cell isn’t connected.'
  return null
}

function settingsOf(raw: { mode: string | null; model: string | null; effort: string | null } | undefined): PhoneChatGptSettings {
  const mode = raw?.mode === 'Chat' || raw?.mode === 'Work' ? raw.mode : null
  return { mode, model: raw?.model ?? null, effort: raw?.effort ?? null }
}

const same = (a: PhoneChatGptSettings, b: PhoneChatGptSettings) => a.mode === b.mode && a.model === b.model && a.effort === b.effort

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[4.5rem_1fr] items-center gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

export function PhoneProfileControls({ phone, profiles, relay, screen, busy, now }: {
  phone: PhoneOverviewPhone
  /** This phone's profiles. */
  profiles: PhoneUploadProfile[]
  relay: RelayStatus | null
  screen: PhoneScreen | null
  /** A run is going on the phone: the profile can't be changed. */
  busy: boolean
  now: number
}) {
  const { toast } = useToast()
  const selected = profiles.find(p => p.selected) ?? null
  const chatGpt = selected?.chatGpt ?? null
  const saved = settingsOf(chatGpt?.settings)
  const [draft, setDraft] = useState<PhoneChatGptSettings>(saved)
  const [sending, setSending] = useState<Command | null>(null)
  const [waiting, setWaiting] = useState<{ command: Command; id: string } | null>(null)
  const [late, setLate] = useState(false)

  // A new profile, or settings saved (from here or elsewhere): the form shows them. The overview reloads on
  // every receipt during a run, so only a change in what's saved resets a draft.
  const savedKey = JSON.stringify([selected?.profileId ?? null, saved.mode, saved.model, saved.effort])
  useEffect(() => setDraft(settingsOf(chatGpt?.settings)), [savedKey])

  const last = screen?.screen?.last ?? null
  const answered = !!waiting && screen?.screen?.answers === waiting.id
  useEffect(() => {
    if (!waiting || answered) return
    setLate(false)
    const timer = setTimeout(() => setLate(true), ANSWER_MS[waiting.command])
    return () => clearTimeout(timer)
  }, [waiting, answered])
  // Keep the answer's note up until the next command; only the spinner stops.
  const [answer, setAnswer] = useState<{ ok: boolean; note: string; at: string } | null>(null)
  useEffect(() => {
    if (!answered || !last) return
    setAnswer({ ok: last.ok, note: last.note, at: last.at })
    setWaiting(null)
  }, [answered, last])

  const blocker = blockerOf(relay, phone)
  const pending = sending !== null || (!!waiting && !late)

  const send = async (command: Command, profile: string, settings?: PhoneChatGptSettings) => {
    setSending(command)
    setAnswer(null)
    try {
      const sent = await r2Api.sendPhoneProfile(command, phone.id, profile, settings)
      setWaiting({ command, id: sent.id })
      if (!sent.reached) toast({ title: `${LABEL[command]} sent`, description: 'The phone isn’t connected right now. It acts on this if it connects within 2 minutes.' })
    } catch (error) {
      toast({ title: `Could not send ${LABEL[command]}`, description: error instanceof Error ? error.message : String(error), variant: 'destructive' })
    } finally {
      setSending(null)
    }
  }

  // The choices: the drafted mode's, else the mode the account was on when read, else the only one.
  const modes = chatGpt?.options?.modes ?? []
  const switchModes = modes.map(m => m.name).filter((m): m is 'Chat' | 'Work' => m === 'Chat' || m === 'Work')
  const modeOptions: PhoneChatGptMode | null =
    modes.find(m => m.name === (draft.mode ?? chatGpt?.options?.current ?? null)) ?? (modes.length === 1 ? modes[0] : null)
  const models = modeOptions?.models ?? []
  const efforts = modeOptions?.efforts ?? []
  const read = !!chatGpt?.options
  const reading = chatGpt?.reading === true || (waiting?.command === 'options' && !late)
  const dirty = !same(draft, saved)

  /** A saved name the account didn't list when read stays pickable, marked. */
  const withSaved = (names: string[], value: string | null) => (value && !names.includes(value) ? [...names, value] : names)

  if (!profiles.length) {
    return (
      <div className="space-y-2">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Profile</p>
        <p className="text-sm text-muted-foreground">No profiles reported yet: Refresh from phone.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Profile
          <InfoTip text="The browser profile the phone is on, which the next run starts in (one ChatGPT account each). It can be changed only when no run is going." />
        </p>
        <Select
          value={selected?.profileId ?? ''}
          disabled={!!blocker || busy || pending}
          onValueChange={id => { if (id !== selected?.profileId) send('select', id) }}
        >
          <SelectTrigger className="ml-auto h-8 w-56" aria-label="Profile" title={busy ? 'A run is going: change the profile once it’s done' : undefined}>
            <UserRound className="mr-1.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <SelectValue placeholder="Pick a profile" />
          </SelectTrigger>
          <SelectContent>
            {profiles.map(p => <SelectItem key={p.profileId} value={p.profileId}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {selected && (
        <div className="space-y-2.5 rounded-md bg-secondary/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              ChatGPT for Image Clipper
              <InfoTip text="Every new chat an Image Clipper run opens on this profile is set to these. “As the account has it” leaves that alone (with nothing set, a run uses High effort in Chat mode, as before). When Work’s usage is used up, the run still goes to Chat, where Work’s model and effort don’t apply. Picking a model puts the effort to its lowest unless you pick one too." />
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 px-2 text-xs"
              disabled={!!blocker || busy || pending || reading}
              title={busy ? 'A run is going: read the options once it’s done' : 'The phone opens ChatGPT in this profile and reads its modes, models and efforts (waking it if need be)'}
              onClick={() => send('options', selected.profileId)}
            >
              {reading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              {reading ? 'Reading…' : read ? 'Read again' : 'Read options'}
            </Button>
          </div>

          {!read && !reading && (
            <p className="text-xs text-muted-foreground">Read the options first: the models and efforts differ by account and plan.</p>
          )}
          {chatGpt?.options?.readAt && (
            <p className="text-xs text-muted-foreground">Options read {ago(chatGpt.options.readAt, now)}</p>
          )}

          <Field label="Mode">
            <Select
              value={draft.mode ?? AS_IS}
              disabled={!read && !draft.mode}
              onValueChange={v => setDraft(d => ({ mode: v === AS_IS ? null : (v as 'Chat' | 'Work'), model: v === d.mode ? d.model : null, effort: v === d.mode ? d.effort : null }))}
            >
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={AS_IS}>As the account has it</SelectItem>
                {withSaved(switchModes, draft.mode).map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Model">
            <Select
              value={draft.model ?? AS_IS}
              disabled={!models.length && !draft.model}
              onValueChange={v => setDraft(d => ({ ...d, model: v === AS_IS ? null : v }))}
            >
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={AS_IS}>As the account has it</SelectItem>
                {withSaved(models.map(m => m.name), draft.model).map(name => {
                  const known = models.find(m => m.name === name)
                  return (
                    <SelectItem key={name} value={name}>
                      {name}{known?.picked ? ' · current' : ''}{!known ? ' · not listed when read' : ''}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Effort">
            <Select
              value={draft.effort ?? AS_IS}
              disabled={!efforts.some(e => e.name && !e.locked) && !draft.effort}
              onValueChange={v => setDraft(d => ({ ...d, effort: v === AS_IS ? null : v }))}
            >
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={AS_IS}>As the account has it</SelectItem>
                {efforts.map((e, i) => e.locked || !e.name
                  ? <SelectItem key={`locked-${i}`} value={`__locked_${i}`} disabled>{e.name ?? `Step ${i + 1}`} · locked on this plan</SelectItem>
                  : <SelectItem key={e.name} value={e.name}>{e.name}{e.picked ? ' · current' : ''}</SelectItem>)}
                {draft.effort && !efforts.some(e => e.name === draft.effort) && (
                  <SelectItem value={draft.effort}>{draft.effort} · not listed when read</SelectItem>
                )}
              </SelectContent>
            </Select>
          </Field>

          {models.length === 0 && read && modeOptions && (
            <p className="text-xs text-muted-foreground">No model list in {modeOptions.name ?? 'this account’s'} mode: only the effort can be set there.</p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            {dirty && (
              <Button size="sm" variant="ghost" className="h-8" disabled={pending} onClick={() => setDraft(saved)}>
                Undo
              </Button>
            )}
            <Button size="sm" className="h-8" disabled={!!blocker || !dirty || pending} onClick={() => send('settings', selected.profileId, draft)}>
              {sending === 'settings' || (waiting?.command === 'settings' && !late) ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
              Save
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-1 text-sm">
        {waiting?.command === 'select' && !late && (
          <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Selecting…</p>
        )}
        {answer && (
          <p className={answer.ok ? 'text-muted-foreground' : 'text-amber-500'}>{answer.note}</p>
        )}
        {!answer && !reading && chatGpt?.error && (
          <p className="text-amber-500">Reading the options failed: {chatGpt.error}</p>
        )}
        {waiting && late && (
          <p className="flex items-start gap-1.5 text-amber-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            No answer to {LABEL[waiting.command]} yet. Sleeper-Cell may need updating for the profile controls.
          </p>
        )}
        {blocker && (
          <p className="flex items-start gap-1.5 text-xs text-amber-500">
            <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" />
            <span>{blocker}</span>
          </p>
        )}
      </div>
    </div>
  )
}
