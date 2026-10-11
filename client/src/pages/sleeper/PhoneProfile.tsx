/**
 * A phone's browser profiles on Phone Status:
 *
 * - PhoneProfilePicker, in Run automation's step 2 after the series: the
 *   profile selected (the one the run starts in) with its ChatGPT plan. Plans
 *   are what Sleeper-Cell's Tools → Profiles → Check last found there (each
 *   profile's `check`); nothing is checked from here.
 * - ChatGptChoices, in Run automation's Image Clipper step: the ChatGPT mode,
 *   model and effort, offered only on plans that have them (Plus and up; Free
 *   and Go have neither the switch nor the model picker), from what the
 *   selected profile's account offered when last read ("Read options").
 *
 * Each goes through the relay; the phone answers in its profiles, and with how
 * it went in its screen receipt (`answers` / `last`). The phone wakes itself
 * for a read when Sleeper-Cell isn't on screen.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import { ago, InfoTip, planLabel } from './sleeperShared'

type Command = 'select' | 'options'

/** The Select value for "as the account has it" (an item can't have ""). */
const AS_IS = '__as_is'

const LABEL: Record<Command, string> = { select: 'Select profile', options: 'Read options' }

/** How long each waits for the phone's answer: a read can mean waking the phone and a minute of taps. */
const ANSWER_MS: Record<Command, number> = { select: 25_000, options: 180_000 }

const NOT_CHECKED = 'Not checked on the phone yet: Sleeper-Cell → Tools → Profiles → Check.'

/** ChatGPT's plans without the Chat / Work switch or the model picker. */
const NO_CHOICES = new Set(['free', 'go'])

export const NO_CHATGPT_CHOICES: PhoneChatGptSettings = { mode: null, model: null, effort: null }

/** Whether a profile's ChatGPT plan offers the mode, model and effort; null when not known. */
export function hasChoices(profile: PhoneUploadProfile | null): boolean | null {
  const plan = profile?.check?.chatGpt?.plan?.toLowerCase()
  return plan ? !NO_CHOICES.has(plan) : null
}

function blockerOf(relay: RelayStatus | null, phone: PhoneOverviewPhone): string | null {
  if (!relay?.configured) return 'Profile controls need the phone relay (Settings → Cloudflare).'
  if (!relay.connected) return 'Manhwa Studio can’t reach the relay right now.'
  if (!phone.id) return 'This is an old Sleeper-Cell build: update it to use the profile controls.'
  if (!phone.connected) return 'Sleeper-Cell isn’t connected.'
  return null
}

/** Sends a profile command and follows it to the phone's answer. */
function useProfileCommand(phone: PhoneOverviewPhone, screen: PhoneScreen | null) {
  const { toast } = useToast()
  const [sending, setSending] = useState<Command | null>(null)
  const [waiting, setWaiting] = useState<{ command: Command; id: string } | null>(null)
  const [late, setLate] = useState(false)
  const [answer, setAnswer] = useState<{ ok: boolean; note: string } | null>(null)

  const last = screen?.screen?.last ?? null
  const answered = !!waiting && screen?.screen?.answers === waiting.id
  useEffect(() => {
    if (!waiting || answered) return
    setLate(false)
    const timer = setTimeout(() => setLate(true), ANSWER_MS[waiting.command])
    return () => clearTimeout(timer)
  }, [waiting, answered])
  useEffect(() => {
    if (!answered || !last) return
    setAnswer({ ok: last.ok, note: last.note })
    setWaiting(null)
  }, [answered, last])

  const send = async (command: Command, profile: string) => {
    setSending(command)
    setAnswer(null)
    try {
      const sent = await r2Api.sendPhoneProfile(command, phone.id, profile)
      setWaiting({ command, id: sent.id })
      if (!sent.reached) toast({ title: `${LABEL[command]} sent`, description: 'The phone isn’t connected right now. It acts on this if it connects within 2 minutes.' })
    } catch (error) {
      toast({ title: `Could not send ${LABEL[command]}`, description: error instanceof Error ? error.message : String(error), variant: 'destructive' })
    } finally {
      setSending(null)
    }
  }

  /** The command waiting for its answer, until it comes or is late. */
  const pending: Command | null = sending ?? (waiting && !late ? waiting.command : null)
  return { send, pending, answer, late: waiting && late ? waiting.command : null }
}

function Status({ answer, late, blocker }: { answer: { ok: boolean; note: string } | null; late: Command | null; blocker: string | null }) {
  if (!answer && !late && !blocker) return null
  return (
    <div className="space-y-1 text-xs">
      {answer && <p className={answer.ok ? 'text-muted-foreground' : 'text-amber-500'}>{answer.note}</p>}
      {late && (
        <p className="flex items-start gap-1.5 text-amber-500">
          <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" />
          No answer to {LABEL[late]} yet. Sleeper-Cell may need updating for the profile controls.
        </p>
      )}
      {blocker && (
        <p className="flex items-start gap-1.5 text-amber-500">
          <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" />
          <span>{blocker}</span>
        </p>
      )}
    </div>
  )
}

/** The ChatGPT plan as a small badge: Plus and up stand out; dashed when not known. */
function PlanBadge({ profile }: { profile: PhoneUploadProfile }) {
  const chatGpt = profile.check?.chatGpt ?? null
  const plan = planLabel(chatGpt?.plan)
  const choices = hasChoices(profile)
  const signedOut = !!chatGpt && !chatGpt.signedIn && !chatGpt.error
  return (
    <span
      className={cn(
        'rounded border px-1.5 py-px text-[11px] font-medium',
        signedOut ? 'border-amber-500/50 text-amber-500'
          : choices ? 'border-primary/50 text-primary'
          : plan ? 'text-muted-foreground'
          : 'border-dashed text-muted-foreground'
      )}
      title={profile.check
        ? `ChatGPT${chatGpt?.email ? ` · ${chatGpt.email}` : ''} · checked on the phone ${new Date(profile.check.checkedAt).toLocaleString()}`
        : NOT_CHECKED}
    >
      {signedOut ? 'Signed out' : plan ?? 'Plan ?'}
    </span>
  )
}

/** The profile the run starts in, picked in Run automation, with its ChatGPT plan. */
export function PhoneProfilePicker({ phone, profiles, relay, screen, onPending }: {
  phone: PhoneOverviewPhone
  /** This phone's profiles. */
  profiles: PhoneUploadProfile[]
  relay: RelayStatus | null
  screen: PhoneScreen | null
  /** Whether a selection is on its way to the phone, so the run isn't started before it lands. */
  onPending?: (pending: boolean) => void
}) {
  const { send, pending, answer, late } = useProfileCommand(phone, screen)
  const selected = profiles.find(p => p.selected) ?? null
  const blocker = blockerOf(relay, phone)
  const selecting = pending === 'select'
  useEffect(() => { onPending?.(selecting) }, [selecting, onPending])
  if (!profiles.length) return null

  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        Profile
        <InfoTip text="The browser profile the run starts in (one ChatGPT account each); picking one switches the phone to it now. Plans are what Sleeper-Cell’s Tools → Profiles → Check last found: Free and Go have no mode or model choices; Plus and up do." />
      </p>
      <div className="flex items-center gap-2">
        <Select
          value={selected?.profileId ?? ''}
          disabled={!!blocker || pending !== null}
          onValueChange={id => { if (id !== selected?.profileId) send('select', id) }}
        >
          <SelectTrigger className="h-9 flex-1" aria-label="Profile">
            <SelectValue placeholder="Pick a profile" />
          </SelectTrigger>
          <SelectContent>
            {profiles.map(p => (
              <SelectItem key={p.profileId} value={p.profileId}>
                {p.name}{planLabel(p.check?.chatGpt?.plan) ? ` · ${planLabel(p.check?.chatGpt?.plan)}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selecting && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {selected && <PlanBadge profile={selected} />}
      </div>
      <Status answer={answer} late={late} blocker={blocker} />
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[4.5rem_1fr] items-center gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

/**
 * Image Clipper's ChatGPT mode, model and effort, for Run automation, from the
 * selected profile's plan and options. The phone keeps what's picked for its
 * later runs and resumes, and uses it on every account a run moves to whose
 * plan has the choices.
 */
export function ChatGptChoices({ phone, profiles, relay, screen, value, onChange, now }: {
  phone: PhoneOverviewPhone
  profiles: PhoneUploadProfile[]
  relay: RelayStatus | null
  screen: PhoneScreen | null
  value: PhoneChatGptSettings
  onChange: (value: PhoneChatGptSettings) => void
  now: number
}) {
  const { send, pending, answer, late } = useProfileCommand(phone, screen)
  const selected = profiles.find(p => p.selected) ?? null
  const chatGpt = selected?.chatGpt ?? null
  const choices = hasChoices(selected)
  const blocker = blockerOf(relay, phone)
  const reading = chatGpt?.reading === true || pending === 'options'

  // The choices: the picked mode's, else the mode the account was on when read, else the only one.
  const modes = chatGpt?.options?.modes ?? []
  const switchModes = modes.map(m => m.name).filter((m): m is 'Chat' | 'Work' => m === 'Chat' || m === 'Work')
  const modeOptions: PhoneChatGptMode | null =
    modes.find(m => m.name === (value.mode ?? chatGpt?.options?.current ?? null)) ?? (modes.length === 1 ? modes[0] : null)
  const models = modeOptions?.models ?? []
  const efforts = modeOptions?.efforts ?? []
  const read = modes.length > 0

  // On a plan without the choices, only "as the account has it" is sent.
  useEffect(() => {
    if (choices === false && (value.mode || value.model || value.effort)) onChange(NO_CHATGPT_CHOICES)
  }, [choices, value, onChange])

  return (
    <div className="space-y-2.5 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          ChatGPT
          <InfoTip text="Every new chat of the run is set to these, on the selected profile and on each Plus account the run moves to at a limit; Free and Go accounts run as they are (High effort where they have it). “As the account has it” leaves that alone. When Work’s usage runs out the run goes to Chat, where Work’s model and effort don’t apply. Picking a model puts the effort to its lowest unless you pick one too. The phone keeps these for its later runs." />
        </p>
        <span className="text-xs text-muted-foreground">
          on {selected ? <>{selected.name} · {planLabel(selected.check?.chatGpt?.plan) ?? 'plan not known'}</> : 'no profile'}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 px-2 text-xs"
          disabled={!!blocker || !selected || choices !== true || pending !== null || reading}
          title="The phone opens ChatGPT in this profile and reads its modes, models and efforts (waking it if need be)"
          onClick={() => selected && send('options', selected.profileId)}
        >
          {reading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
          {reading ? 'Reading…' : read ? 'Read again' : 'Read options'}
        </Button>
      </div>

      {choices === false && (
        <p className="text-xs text-muted-foreground">
          {planLabel(selected?.check?.chatGpt?.plan)} has no Chat / Work switch or model picker: the run uses the account as it is.
        </p>
      )}
      {choices === null && (
        <p className="text-xs text-muted-foreground">The plan isn’t known. {NOT_CHECKED}</p>
      )}
      {choices && !read && !reading && (
        <p className="text-xs text-muted-foreground">Read the options: the models and efforts differ by account.</p>
      )}

      {choices && (
        <>
          {chatGpt?.options?.readAt && <p className="text-xs text-muted-foreground">Options read {ago(chatGpt.options.readAt, now)}</p>}
          <Field label="Mode">
            <Select
              value={value.mode ?? AS_IS}
              disabled={!switchModes.length && !value.mode}
              onValueChange={v => {
                const mode = v === AS_IS ? null : (v as 'Chat' | 'Work')
                onChange(mode === value.mode ? value : { mode, model: null, effort: null })
              }}
            >
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={AS_IS}>As the account has it</SelectItem>
                {switchModes.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                {value.mode && !switchModes.includes(value.mode) && <SelectItem value={value.mode}>{value.mode} · not listed when read</SelectItem>}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Model">
            <Select
              value={value.model ?? AS_IS}
              disabled={!models.length && !value.model}
              onValueChange={v => onChange({ ...value, model: v === AS_IS ? null : v })}
            >
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={AS_IS}>As the account has it</SelectItem>
                {models.map(m => <SelectItem key={m.name} value={m.name}>{m.name}{m.picked ? ' · current' : ''}</SelectItem>)}
                {value.model && !models.some(m => m.name === value.model) && <SelectItem value={value.model}>{value.model} · not listed when read</SelectItem>}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Effort">
            <Select
              value={value.effort ?? AS_IS}
              disabled={!efforts.some(e => e.name && !e.locked) && !value.effort}
              onValueChange={v => onChange({ ...value, effort: v === AS_IS ? null : v })}
            >
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={AS_IS}>As the account has it</SelectItem>
                {efforts.map((e, i) => e.locked || !e.name
                  ? <SelectItem key={`locked-${i}`} value={`__locked_${i}`} disabled>{e.name ?? `Step ${i + 1}`} · locked on this plan</SelectItem>
                  : <SelectItem key={e.name} value={e.name}>{e.name}{e.picked ? ' · current' : ''}</SelectItem>)}
                {value.effort && !efforts.some(e => e.name === value.effort) && <SelectItem value={value.effort}>{value.effort} · not listed when read</SelectItem>}
              </SelectContent>
            </Select>
          </Field>
          {read && models.length === 0 && modeOptions && (
            <p className="text-xs text-muted-foreground">No model list in {modeOptions.name ?? 'this'} mode: only the effort can be set there.</p>
          )}
        </>
      )}

      {!answer && !reading && chatGpt?.error && <p className="text-xs text-amber-500">Reading failed: {chatGpt.error}</p>}
      <Status answer={answer} late={late} blocker={blocker} />
    </div>
  )
}
