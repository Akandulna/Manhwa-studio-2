/**
 * Run automation — Phone Status's one way to start a run on a phone, in two
 * steps: which automation (Image Clipper, Narration scripts, Editor 2.0
 * timelines, Voiceover), then how (its series, and the choices that run has:
 * ChatGPT or Gemini, one prompt or four steps, ChatGPT's mode, model and
 * effort on plans that have them (PhoneProfile.tsx), tabs, language, one phone
 * or split between them). The runs and their choices are AUTOMATIONS below; a new
 * phone run is one more entry there, plus its start on the phone
 * (Automation.kt) and the relay (relay/src/index.ts).
 */

import { useState } from 'react'
import { AlertTriangle, ArrowLeft, Clapperboard, Loader2, Mic, PenLine, Play, Scissors, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type {
  PhoneAutomationOptions,
  PhoneChatGptSettings,
  PhoneClipperAi,
  PhoneClipperFlow,
  PhoneOverview,
  PhoneOverviewPhone,
  PhoneOverviewSeries,
  PhoneRunKind,
  PhoneScreen,
  PhoneUploadProfile,
  RelayStatus
} from '@/lib/api'
import { LANGUAGE_LABEL, NARRATION_LANGUAGES, type NarrationLanguage } from '@/lib/narrationLanguage'
import { cn } from '@/lib/utils'
import { ChatGptChoices, hasChoices, NO_CHATGPT_CHOICES } from './PhoneProfile'
import { clock } from './sleeperShared'

/** Image Clipper's and the voiceover's most tabs at once (MAX_TABS in ClipperRun and VoiceoverRun on the phone). */
export const MAX_TABS = 4
export const DEFAULT_TABS = 2

interface Automation {
  kind: PhoneRunKind
  name: string
  icon: LucideIcon
  /** What it does, in a line. */
  does: string
  /** Where it asks, as the tile says it. */
  ai: string
  /** The choices step 2 offers besides the series. */
  tabs?: boolean
  language?: boolean
  /** Image Clipper's: ChatGPT or Gemini, one prompt or four steps, and splitting a series between phones. */
  clipper?: boolean
  /** How it asks, when there's no choice to make. */
  fixed?: string
  /** The series' progress for this run, shown in the series list. */
  progress?: (series: PhoneOverviewSeries) => { done: number; total: number } | null
}

export const AUTOMATIONS: Automation[] = [
  {
    kind: 'clipper',
    name: 'Image Clipper',
    icon: Scissors,
    does: 'Crops every page left in a series',
    ai: 'ChatGPT or Gemini',
    tabs: true,
    clipper: true,
    progress: s => s.crops
  },
  {
    kind: 'narration',
    name: 'Narration scripts',
    icon: PenLine,
    does: 'Writes each chapter’s script, then its Hindi retelling',
    ai: 'Gemini',
    fixed: 'Gemini in AI Studio writes the English script from the chapter’s pages, then retells it in Hinglish in a chat of its own.',
    progress: s => s.scripts
  },
  {
    kind: 'editor',
    name: 'Editor 2.0 timelines',
    icon: Clapperboard,
    does: 'Makes each chapter’s timeline from its package',
    ai: 'ChatGPT',
    language: true,
    fixed: 'ChatGPT with GPT-6 Astra, in the profiles that have it (Plus and up). Needs the chapters sent to the phone from Editor 2.0.'
  },
  {
    kind: 'voiceover',
    name: 'Voiceover',
    icon: Mic,
    does: 'Voices every split without audio',
    ai: 'Gemini speech',
    tabs: true,
    language: true,
    fixed: 'Gemini speech in AI Studio, with the voice and style set on the phone.'
  }
]

export const AUTOMATION_NAME = Object.fromEntries(AUTOMATIONS.map(a => [a.kind, a.name])) as Record<PhoneRunKind, string>

const AI_CHOICES: Choice<PhoneClipperAi>[] = [
  { value: 'chatgpt', label: 'ChatGPT', hint: 'Uses the ChatGPT accounts’ image uploads; switches account at each limit.' },
  { value: 'aistudio', label: 'Gemini', hint: 'Gemini in AI Studio at High thinking, against each profile’s own Gemini limit.' }
]

const FLOW_CHOICES: Choice<PhoneClipperFlow>[] = [
  { value: 'classic', label: '1 step', hint: 'One long prompt finds, measures and describes every crop, then review rounds.' },
  { value: 'steps', label: '4 steps', hint: 'Find the shots, place them, describe them, review: smaller asks, for lower models.' }
]

const LANGUAGE_CHOICES: Choice<NarrationLanguage>[] = NARRATION_LANGUAGES.map(language => ({ value: language, label: LANGUAGE_LABEL[language] }))

/** The runs this phone's Sleeper-Cell can start; builds from before the others say nothing and start only Image Clipper. */
export function phoneRuns(phone: PhoneOverviewPhone): PhoneRunKind[] {
  return phone.automation?.runs ?? ['clipper']
}

/** The series to offer first for `kind`: the one waiting to resume or running, else the first with work left. */
function preferredSeries(kind: PhoneRunKind, overview: PhoneOverview, phone: PhoneOverviewPhone, several: boolean): string {
  const choices = overview.series
  const left = (p: { done: number; total: number } | null) => !!p && p.done < p.total
  if (kind === 'clipper') {
    return phone.automation?.resume?.seriesId
      ?? overview.working.find(w => w.seriesId && (!several || w.phone === phone.name))?.seriesId
      ?? choices.find(s => left(s.crops))?.id
      ?? choices[0]?.id
      ?? ''
  }
  if (kind === 'narration') return (choices.find(s => s.sync && left(s.scripts)) ?? choices.find(s => s.sync) ?? choices[0])?.id ?? ''
  // Editor 2.0 and the voiceover work from the scripts.
  return (choices.find(s => s.scripts && s.scripts.done > 0) ?? choices[0])?.id ?? ''
}

interface Choice<T extends string> {
  value: T
  label: string
  hint?: string
}

/** A row of buttons, one chosen, with the chosen one's hint under it. */
/** `disabled` greys the choices out and says why in place of the hint. */
function Choices<T extends string>({ label, choices, value, onChange, disabled }: {
  label: string; choices: Choice<T>[]; value: T; onChange: (value: T) => void; disabled?: string
}) {
  const hint = disabled ?? choices.find(c => c.value === value)?.hint
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {choices.map(c => (
          <Button
            key={c.value}
            type="button"
            size="sm"
            role="radio"
            aria-checked={value === c.value}
            disabled={!!disabled}
            variant={value === c.value ? 'default' : 'outline'}
            className="min-w-[4.5rem]"
            onClick={() => onChange(c.value)}
          >
            {c.label}
          </Button>
        ))}
      </div>
      {hint && <p className={cn('text-xs', disabled ? 'text-amber-500' : 'text-muted-foreground')}>{hint}</p>}
    </div>
  )
}

function TabChoices({ value, onChange, each }: { value: number; onChange: (n: number) => void; each: boolean }) {
  const choices = Array.from({ length: MAX_TABS }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))
  return (
    <Choices
      label={each ? 'Tabs on each phone' : 'Tabs at once'}
      choices={choices.map(c => ({ ...c, hint: value === 1 ? 'One page at a time.' : `${value} at a time, taking turns with the screen.` }))}
      value={String(value)}
      onChange={v => onChange(Number(v))}
    />
  )
}

/**
 * The dialog: step 1 picks the automation, step 2 how it runs. `onStart` sends
 * it (the page toasts how that went) and resolves once sent, closing the dialog.
 * `startable` counts the phones that can be started now, for Image Clipper's split.
 */
export function RunAutomationDialog({ open, onOpenChange, phone, overview, several, startable, profiles, relay, screen, now, sending, onStart }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  phone: PhoneOverviewPhone
  overview: PhoneOverview
  several: boolean
  startable: PhoneOverviewPhone[]
  /** This phone's profiles: the selected one's plan and options give Image Clipper's ChatGPT choices. */
  profiles: PhoneUploadProfile[]
  relay: RelayStatus | null
  screen: PhoneScreen | null
  now: number
  sending: boolean
  onStart: (options: PhoneAutomationOptions) => Promise<boolean>
}) {
  const runs = phoneRuns(phone)
  // Builds that say how Image Clipper last ran also take its AI and method.
  const last = phone.automation?.clipper ?? null
  const choosesHow = last !== null
  const resume = phone.automation?.resume ?? null

  const [kind, setKind] = useState<PhoneRunKind | null>(null)
  const [picked, setPicked] = useState<Partial<Record<PhoneRunKind, string>>>({})
  const [ai, setAi] = useState<PhoneClipperAi>(last?.ai ?? 'chatgpt')
  const [flow, setFlow] = useState<PhoneClipperFlow>(last?.flow ?? 'classic')
  const [clipTabs, setClipTabs] = useState(last?.tabs ?? resume?.tabs ?? DEFAULT_TABS)
  const [voiceTabs, setVoiceTabs] = useState(DEFAULT_TABS)
  const [language, setLanguage] = useState<NarrationLanguage>('en')
  const [split, setSplit] = useState(false)
  const [chatGpt, setChatGpt] = useState<PhoneChatGptSettings>(last?.chatGpt ?? NO_CHATGPT_CHOICES)
  // Only builds that report the last choices (null from older ones) take them with the start.
  const choosesChatGpt = !!last?.chatGpt

  const automation = AUTOMATIONS.find(a => a.kind === kind) ?? null
  const seriesId = kind ? picked[kind] ?? preferredSeries(kind, overview, phone, several) : ''
  const canSplit = kind === 'clipper' && several && startable.length >= 2 && startable.some(p => p.id === phone.id)
  const splitting = canSplit && split
  const tabs = kind === 'voiceover' ? voiceTabs : clipTabs

  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) setKind(null)
  }

  const start = async () => {
    if (!automation) return
    const options: PhoneAutomationOptions = {
      kind: automation.kind,
      seriesId: seriesId || undefined,
      ...(automation.tabs ? { tabs } : {}),
      ...(automation.clipper && choosesHow ? { ai, flow } : {}),
      ...(automation.clipper && choosesChatGpt && ai === 'chatgpt'
        ? { chatGpt: hasChoices(profiles.find(p => p.selected) ?? null) === false ? NO_CHATGPT_CHOICES : chatGpt }
        : {}),
      ...(automation.language ? { language } : {}),
      ...(splitting ? { split: true } : phone.id && several ? { device: phone.id } : {})
    }
    if (await onStart(options)) close(false)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {automation ? 'Step 2 of 2 · How' : 'Step 1 of 2 · Which automation'}
          </p>
          <DialogTitle className="flex items-center gap-2">
            {automation ? <><automation.icon className="h-5 w-5 text-muted-foreground" /> {automation.name}</> : 'Run automation'}
          </DialogTitle>
          <DialogDescription>
            {automation ? `On ${splitting ? `${startable.length} phones` : phone.name}. ${automation.does}.` : `What should ${phone.name} run?`}
          </DialogDescription>
        </DialogHeader>

        {!automation
          ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {AUTOMATIONS.map(a => {
                const supported = runs.includes(a.kind)
                return (
                  <button
                    key={a.kind}
                    type="button"
                    disabled={!supported}
                    onClick={() => setKind(a.kind)}
                    className={cn(
                      'flex flex-col gap-1.5 rounded-lg border p-4 text-left transition-colors',
                      supported ? 'hover:border-primary hover:bg-secondary/50' : 'cursor-not-allowed opacity-50'
                    )}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <a.icon className="h-4 w-4 text-muted-foreground" /> {a.name}
                    </span>
                    <span className="text-sm text-muted-foreground">{a.does}</span>
                    <span className="mt-auto pt-1 text-xs text-muted-foreground">
                      {supported ? a.ai : 'Update Sleeper-Cell on this phone to start it from here'}
                    </span>
                  </button>
                )
              })}
            </div>
          )
          : (
            <div className="space-y-5">
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Series</p>
                <Select value={seriesId} onValueChange={id => setPicked(p => ({ ...p, [automation.kind]: id }))} disabled={!overview.series.length}>
                  <SelectTrigger className="h-9" aria-label="Series">
                    <SelectValue placeholder={automation.clipper ? 'The phone’s last run' : 'Pick a series'} />
                  </SelectTrigger>
                  <SelectContent>
                    {overview.series.map(s => {
                      const progress = automation.progress?.(s) ?? null
                      return (
                        <SelectItem key={s.id} value={s.id}>
                          {s.title}{progress ? ` · ${progress.done}/${progress.total}` : ''}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              </div>

              {automation.clipper && (
                <>
                  <Choices
                    label="AI"
                    choices={AI_CHOICES}
                    value={ai}
                    onChange={setAi}
                    disabled={choosesHow ? undefined : `${phone.name} runs an older Sleeper-Cell: it uses the AI last picked on the phone. Update it to pick here.`}
                  />
                  <Choices
                    label="Method"
                    choices={FLOW_CHOICES}
                    value={flow}
                    onChange={setFlow}
                    disabled={choosesHow ? undefined : 'Same for the method: 1 step or 4 steps as last picked on the phone.'}
                  />
                  {ai === 'chatgpt' && (choosesChatGpt
                    ? <ChatGptChoices phone={phone} profiles={profiles} relay={relay} screen={screen} value={chatGpt} onChange={setChatGpt} now={now} />
                    : <p className="text-xs text-muted-foreground">Update Sleeper-Cell on {phone.name} to pick ChatGPT’s mode, model and effort here.</p>)}
                </>
              )}

              {automation.language && <Choices label="Language" choices={LANGUAGE_CHOICES} value={language} onChange={setLanguage} />}

              {automation.tabs && (
                <TabChoices value={tabs} onChange={kind === 'voiceover' ? setVoiceTabs : setClipTabs} each={splitting} />
              )}

              {canSplit && (
                <Choices
                  label="Phones"
                  choices={[
                    { value: 'one', label: `Only ${phone.name}` },
                    {
                      value: 'split',
                      label: `Split across ${startable.length}`,
                      hint: 'Shares the series’ chapters left out between the phones, balanced by pages, in reading order: no page is clipped twice.'
                    }
                  ]}
                  value={split ? 'split' : 'one'}
                  onChange={v => setSplit(v === 'split')}
                />
              )}

              {automation.fixed && (
                <p className="rounded-md bg-secondary/40 px-3 py-2 text-sm text-muted-foreground">{automation.fixed}</p>
              )}

              {resume && automation.kind !== 'clipper' && (
                <p className="flex items-start gap-1.5 text-xs text-amber-500">
                  <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" />
                  <span>Starting this drops Image Clipper’s resume of {resume.series} at ~{clock(resume.at)}.</span>
                </p>
              )}
            </div>
          )}

        <DialogFooter className="gap-2 sm:justify-between">
          {automation
            ? (
              <>
                <Button variant="ghost" onClick={() => setKind(null)}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back
                </Button>
                <Button onClick={start} disabled={sending || (!seriesId && !automation.clipper)}>
                  {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                  {splitting ? `Start on ${startable.length} phones` : 'Start'}
                </Button>
              </>
            )
            : <Button variant="ghost" className="ml-auto" onClick={() => close(false)}>Cancel</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
