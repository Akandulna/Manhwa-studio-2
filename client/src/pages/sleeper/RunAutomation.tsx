import { useSeriesOrder } from '@/hooks/useSeriesOrder'
/**
 * Run automation — Phone Status's one way to start a run on a phone, in two
 * steps: which automation (Image Clipper, Narration scripts, Editor 2.0
 * timelines, Voiceover), then how (its series, the profile it starts in, and
 * the choices that run has: ChatGPT or Gemini, one prompt or four steps, ChatGPT's mode, model and
 * effort on plans that have them (PhoneProfile.tsx), tabs, language, one phone
 * or split between them). Image Clipper, Metadata, Editor 2.0 and the voiceover can be
 * split between phones (never the narration scripts: each chapter's prompt goes
 * on from the one before's summary, so one phone writes them in order): each phone has
 * its own profile picker, so each can work in an account of its own, and Start
 * first shows the plan (server: phoneSplit.ts), which phone takes which
 * chapters, which keeps the chapter it's on and which is left alone as busy
 * with something else, to confirm before anything is sent. The runs and their choices
 * are AUTOMATIONS below; a new phone run is one more entry there, plus its start
 * on the phone (Automation.kt) and the relay (relay/src/index.ts).
 *
 * Step 2 offers every series in the library, not only those the phone has,
 * and checks what the picked run needs on the phone (RunReadiness.tsx): what's
 * missing can be sent from there, and "Get ready & start" sends it all, then
 * starts the run by itself once the phone has it.
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, Clapperboard, Loader2, Mic, PenLine, Play, Scissors, Send, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  r2Api,
  seriesApi,
  type Series,
  type NarrationPartChoice,
  type NarrationRunScope,
  type PhoneAutomationOptions,
  type PhoneChatGptSettings,
  type PhoneClipperAi,
  type PhoneClipperFlow,
  type PhoneOverview,
  type PhoneOverviewPhone,
  type PhoneOverviewSeries,
  type PhoneReadinessItem,
  type PhoneRunKind,
  type PhoneRunReadiness,
  type PhoneScreen,
  type PhoneSplitPlan,
  type PhoneSplitTarget,
  type PhoneUploadProfile,
  type RelayStatus
} from '@/lib/api'
import { defaultMetadataPart, metadataParts, scopeMetadata, type MetadataBlockedChapter, type MetadataChapter, type MetadataPart, type MetadataPartChoice } from '@/lib/metadataParts'
import { LANGUAGE_LABEL, NARRATION_LANGUAGES, type NarrationLanguage } from '@/lib/narrationLanguage'
import { cn } from '@/lib/utils'
import { ChatGptChoices, hasChoices, NO_CHATGPT_CHOICES, PhoneProfilePicker } from './PhoneProfile'
import { RunReadinessPanel, useRunReadiness } from './RunReadiness'
import { clock, onPhone } from './sleeperShared'

/** The most tabs a run takes at once (MAX_TABS in ClipperRun, EditorRun and VoiceoverRun on the phone). */
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
  /** The choices step 2 offers besides the series: tabs at once, with what each tab works on. */
  tabs?: { unit: string }
  language?: boolean
  /** Image Clipper's: ChatGPT or Gemini, one prompt or four steps. */
  clipper?: boolean
  /** Its series' chapters can be shared out between the phones. */
  split?: boolean
  /** How it asks, when there's no choice to make. */
  fixed?: string
  /** The series' progress for this run, shown in the series list. */
  progress?: (series: PhoneOverviewSeries) => { done: number; total: number } | null
}

export const AUTOMATIONS: Automation[] = [
  {kind:'metadata',name:'Metadata',icon:PenLine,does:'Creates descriptions and English-script links from reviewed crops',ai:'AI Studio only',
   tabs:{unit:'page'},split:true,fixed:'Review and cut chapters in Studio first. Select approved chapters below. The phone recreates temporary crops from originals and deletes them after saving metadata; only JSON is synchronized.'},
  {
    kind: 'narration',
    name: 'Narration scripts',
    icon: PenLine,
    does: 'Writes each chapter’s script, then its Hindi retelling',
    ai: 'Gemini',
    fixed: 'Gemini in AI Studio writes the English script from the chapter’s pages, then retells it in Hinglish in a chat of its own. One phone at a time: each chapter goes on from the one before’s summary, so it isn’t split between phones.',
    progress: s => s.scripts
  },
  {
    kind: 'voiceover',
    name: 'Voiceover',
    icon: Mic,
    does: 'Voices every split without audio',
    ai: 'Gemini speech',
    tabs: { unit: 'split' },
    language: true,
    split: true,
    fixed: 'Gemini speech in AI Studio, with the voice and style set on the phone.'
  },
  {
    kind: 'clipper',
    name: 'Image Clipper',
    icon: Scissors,
    does: 'Crops every page left in a series',
    ai: 'ChatGPT or AI Studio',
    tabs: { unit: 'page' },
    clipper: true,
    split: true,
    progress: s => s.crops
  },
  {
    kind: 'editor',
    name: 'Editor 2.0 timelines',
    icon: Clapperboard,
    does: 'Makes each chapter’s timeline from its package',
    ai: 'ChatGPT or AI Studio',
    tabs: { unit: 'chapter' },
    language: true,
    split: true,
    fixed: 'Send chapters from Editor 2.0 first. Small batches save each accepted audio section and resume after interruptions. AI Studio uses the model selected in that phone profile. Sign in to the selected provider before starting.'
  }
]

export const AUTOMATION_NAME = Object.fromEntries(AUTOMATIONS.map(a => [a.kind, a.name])) as Record<PhoneRunKind, string>

/** What "Split across N" shares out, for each run. */
const SPLIT_HINT: Partial<Record<PhoneRunKind, string>> = {
  clipper: 'Shares the series’ chapters left out between the phones, balanced by pages, in reading order: no page is clipped twice.',
  metadata: 'Shares the approved chapters picked above between the selected phones, balanced by pages, in reading order: no chapter gets its metadata twice. Each phone needs the chapter’s original pages and English script.',
  editor: 'Shares the chapters waiting for their timeline out between the phones, in reading order: no chapter is made twice.',
  voiceover: 'Shares the chapters waiting for their voiceover out between the phones with their newest script, in reading order: no split is voiced twice.'
}

const AI_CHOICES: Choice<PhoneClipperAi>[] = [
  { value: 'chatgpt', label: 'ChatGPT', hint: 'Uses the ChatGPT accounts’ image uploads; switches account at each limit.' },
  { value: 'aistudio', label: 'AI Studio', hint: 'Gemini in AI Studio at High thinking, against each profile’s own Gemini limit.' },
]

const EDITOR_AI_CHOICES: Choice<'chatgpt' | 'aistudio'>[] = [
  { value: 'chatgpt', label: 'ChatGPT', hint: 'Small batches work with the account’s available model, including free accounts.' },
  { value: 'aistudio', label: 'AI Studio', hint: 'Uses the model selected in AI Studio in the phone’s profile.' }
]
const EDITOR_METHOD_CHOICES: Choice<'batches' | 'full'>[] = [
  { value: 'batches', label: 'Small batches', hint: 'Matches one complete audio section per request and saves accepted sections for resume.' },
  { value: 'full', label: 'Full package', hint: 'Sends the full chapter prompt. Packages with a batch plan always use batches.' }
]

const FLOW_CHOICES: Choice<PhoneClipperFlow>[] = [
  { value: 'classic', label: 'Classic', hint: 'Find shots and place corners, then inspect crops and audit annotated pages.' },
  { value: 'steps', label: '4 steps', hint: 'Find shots, place corners, inspect actual crops, then audit annotated pages.' }
]

const LANGUAGE_CHOICES: Choice<NarrationLanguage>[] = NARRATION_LANGUAGES.map(language => ({ value: language, label: LANGUAGE_LABEL[language] }))

/** Its Sleeper-Cell takes a share of a split of `kind`: Image Clipper always; the others from builds saying so (`chapterRuns`). */
function takesShare(kind: PhoneRunKind, phone: PhoneOverviewPhone): boolean {
  const automation = phone.automation
  if (kind === 'clipper') return true
  if (automation?.chapterRuns) return automation.chapterRuns.includes(kind)
  // Builds from before `chapterRuns` took a share of Editor 2.0 when they said its tabs.
  return kind === 'editor' && !!automation?.editor
}

/**
 * Metadata's checklist for the picked part only: its eligible count and its not-ready chapters.
 * Chapters of other parts never show as blockers. Not-ready chapters are notes while some
 * chapter of the part can run (they're simply not selectable), blockers when none can.
 */
function scopedMetadataReadiness(
  check: PhoneRunReadiness,
  parts: MetadataPart[],
  part: MetadataPartChoice,
  scope: { ready: MetadataChapter[]; blocked: MetadataBlockedChapter[] }
): PhoneRunReadiness {
  const range = parts.find(p => p.part === part)
  const where = part === 'all' ? 'All parts' : `Part ${part}${range ? ` (Ch. ${range.from}–${range.to})` : ''}`
  const eligible = scope.ready.length
  const items: PhoneReadinessItem[] = [
    {
      id: 'metadata-ready',
      label: 'Reviewed and cut chapters',
      state: eligible ? 'ready' : 'blocked',
      detail: `${where}: ${eligible} chapter${eligible === 1 ? '' : 's'} eligible${scope.blocked.length ? `, ${scope.blocked.length} not ready yet` : ''}. Metadata uses AI Studio, on one phone or split across the selected phones. Synchronize original pages and the English script on each phone first.`
    },
    ...scope.blocked.map((chapter): PhoneReadinessItem => ({
      id: `metadata-${chapter.id}`,
      label: `Chapter ${chapter.number}`,
      state: eligible ? 'note' : 'blocked',
      detail: chapter.reason,
      link: { to: '/clipper3', label: 'Review and cut in Image Clipper' }
    }))
  ]
  return { ...check, items, ready: items.every(i => i.state === 'ready' || i.state === 'note'), canWork: eligible > 0 }
}

/** Chapters, short and in order: "Ch 1–4, 7"; folders without a number by name. */
export function chapterRanges(chapters: string[], numbers: Record<string, number>): string {
  const known = chapters.map(c => numbers[c]).filter((n): n is number => n !== undefined).sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < known.length; i++) {
    let j = i
    while (j + 1 < known.length && known[j + 1] === known[j] + 1) j++
    parts.push(j > i ? `${known[i]}–${known[j]}` : String(known[i]))
    i = j
  }
  const named = chapters.filter(c => numbers[c] === undefined)
  return [parts.length ? `Ch ${parts.join(', ')}` : '', ...named].filter(Boolean).join(', ')
}

const PLAN_ACTION: Record<PhoneSplitTarget['action'], string> = {
  start: 'Starts on',
  rescope: 'Already on it: keeps going, on',
  finish: 'Already on it, nothing more for it: finishes what it’s on, then stops',
  skip: 'Left alone'
}

/** Split across the phones, before it's sent: each phone and what it'd do. */
function SplitPlanView({ plan }: { plan: PhoneSplitPlan }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Each phone gets chapters of its own, so none is done twice. A phone already on this run keeps the chapter it’s on; one busy with something else isn’t touched.
      </p>
      <ul className="space-y-2">
        {plan.targets.map(t => {
          const keeps = t.inProgress.filter(c => t.chapters.includes(c))
          const finishing = t.inProgress.filter(c => !t.chapters.includes(c))
          return (
            <li key={t.device} className={cn('rounded-md border px-3 py-2 text-sm', t.action === 'skip' && 'opacity-60')}>
              <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium">{t.name}</span>
                <span className="text-xs text-muted-foreground">{t.chapters.length ? `${t.chapters.length} chapter${t.chapters.length === 1 ? '' : 's'}` : ''}</span>
              </p>
              <p className="text-muted-foreground">
                {PLAN_ACTION[t.action]}
                {t.chapters.length > 0 && <> <span className="text-foreground">{chapterRanges(t.chapters, plan.numbers)}</span></>}
              </p>
              {keeps.length > 0 && <p className="text-xs text-sky-500">In progress there now: {chapterRanges(keeps, plan.numbers)}</p>}
              {finishing.length > 0 && <p className="text-xs text-sky-500">Finishes what it’s on of {chapterRanges(finishing, plan.numbers)} (another phone keeps it)</p>}
              {t.action === 'skip' && t.reason && <p className="text-xs text-amber-500">{t.reason}</p>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const LINE = 'bg-muted-foreground/40'
/** The column gap the Voiceover → Metadata arrow runs through (2.5rem), so each column's centre is 25% ∓ 0.625rem. */
const LEFT_CENTRE = 'left-[calc(25%-0.625rem)]'
const RIGHT_CENTRE = 'right-[calc(25%-0.625rem)]'

function ArrowTip({ right }: { right?: boolean }) {
  return right
    ? <span className="h-0 w-0 border-y-[5px] border-l-[6px] border-y-transparent border-l-muted-foreground/40" />
    : <span className="h-0 w-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-muted-foreground/40" />
}

function DownArrow({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('flex flex-col items-center', className)}>
      <span className={cn('w-[1.5px] flex-1', LINE)} />
      <ArrowTip />
    </span>
  )
}

/**
 * The runs in the order work goes through them: narration scripts → voiceover, Image Clipper → metadata,
 * voiceover → metadata, and voiceover and metadata both → Editor 2.0 timelines. [card] draws one run's tile;
 * the tiles stay in reading order for keyboards and screen readers, and the connectors are decoration.
 */
export function AutomationFlow({ card }: { card: (kind: PhoneRunKind) => ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_2.5rem_minmax(0,1fr)]">
      {card('narration')}
      <span />
      {card('clipper')}

      <DownArrow className="h-7" />
      <span />
      <DownArrow className="h-7" />

      {card('voiceover')}
      <span aria-hidden className="flex items-center px-1">
        <span className={cn('h-[1.5px] flex-1', LINE)} />
        <ArrowTip right />
      </span>
      {card('metadata')}

      <div aria-hidden className="relative col-span-3 h-9">
        <span className={cn('absolute top-0 h-1/2 w-[1.5px] -translate-x-1/2', LINE, LEFT_CENTRE)} />
        <span className={cn('absolute top-0 h-1/2 w-[1.5px] translate-x-1/2', LINE, RIGHT_CENTRE)} />
        <span className={cn('absolute top-1/2 h-[1.5px]', LINE, LEFT_CENTRE, RIGHT_CENTRE)} />
        <DownArrow className="absolute bottom-0 left-1/2 top-1/2 -translate-x-1/2" />
      </div>

      <div className="col-span-3 flex justify-center">
        <div className="flex w-[calc(50%-1.25rem)] flex-col">{card('editor')}</div>
      </div>
    </div>
  )
}

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

export function EditorSettings({ ai, smallBatches, onAiChange, onSmallBatchesChange, disabled }: {
  ai: 'chatgpt' | 'aistudio'; smallBatches: boolean
  onAiChange: (ai: 'chatgpt' | 'aistudio') => void
  onSmallBatchesChange: (value: boolean) => void
  disabled?: string
}) {
  return <>
    <Choices label="AI" choices={EDITOR_AI_CHOICES} value={ai} onChange={onAiChange} disabled={disabled} />
    <Choices label="Method" choices={EDITOR_METHOD_CHOICES} value={smallBatches ? 'batches' : 'full'} onChange={v => onSmallBatchesChange(v === 'batches')} disabled={disabled} />
  </>
}

export function NarrationPartChoices({ scope, onChange, allHint, disabled }: {
  scope: NarrationRunScope; onChange: (part: NarrationPartChoice) => void; allHint?: string; disabled?: string
}) {
  return <Choices label="Part" value={String(scope.part)} onChange={value => onChange(value === 'all' ? 'all' : Number(value))} disabled={disabled}
    choices={[
      ...scope.parts.map(part => ({ value: String(part.number), label: `Part ${part.number}`,
        hint: `Chapters ${part.first}–${part.last} only · ${part.chapters.length} chapters.${part.complete ? ' Marked complete or already scripted.' : ''}` })),
      { value: 'all', label: 'All chapters', hint: allHint ?? 'Checks every available chapter, including unfinished English or Hinglish scripts in earlier parts.' }
    ]} />
}

function TabChoices({ value, onChange, each, unit, disabled }: {
  value: number; onChange: (n: number) => void; each: boolean; unit: string; disabled?: string
}) {
  const choices = Array.from({ length: MAX_TABS }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))
  const hint = value === 1 ? `One ${unit} at a time.` : `${value} ${unit}s at a time, each in its own tab, taking turns with the screen.`
  return (
    <Choices
      label={each ? 'Tabs on each phone' : 'Tabs at once'}
      choices={choices.map(c => ({ ...c, hint }))}
      value={String(value)}
      onChange={v => onChange(Number(v))}
      disabled={disabled}
    />
  )
}

/** Image Clipping settings shared by individual runs and the production sequence. */
export function ClipperSettings({ phone, profiles, relay, screen, now, value, onChange }: {
  phone: PhoneOverviewPhone; profiles: PhoneUploadProfile[]; relay: RelayStatus | null; screen: PhoneScreen | null; now: number
  value: { ai: PhoneClipperAi; flow: PhoneClipperFlow; tabs: number; chatGpt: PhoneChatGptSettings }
  onChange: (next: typeof value) => void
}) {
  const supportsSettings = !!phone.automation?.clipper
  return <div className="space-y-4">
    <Choices label="AI" choices={AI_CHOICES} value={value.ai} onChange={ai => onChange({ ...value, ai })} disabled={supportsSettings ? undefined : 'Update Sleeper-Cell to configure Image Clipping.'} />
    <Choices label="Method" choices={FLOW_CHOICES.filter(c=>c.value===(value.ai==='chatgpt'?'classic':'steps'))} value={value.ai==='chatgpt'?'classic':'steps'} onChange={flow => onChange({ ...value, flow })} disabled={supportsSettings ? undefined : 'Update Sleeper-Cell to configure Image Clipping.'} />
    {value.ai === 'chatgpt' && phone.automation?.clipper?.chatGpt && <ChatGptChoices phone={phone} profiles={profiles} relay={relay} screen={screen} now={now} value={value.chatGpt} onChange={chatGpt => onChange({ ...value, chatGpt })} />}
    <TabChoices value={value.tabs} onChange={tabs => onChange({ ...value, tabs })} each={false} unit="page" />
  </div>
}

/**
 * A profile picker for each phone a split run goes to, so each works in an
 * account of its own, with a warning when two are on the same ChatGPT account
 * (they'd share its limits).
 */
function SplitProfiles({ phones, overview, relay, screens, onPending }: {
  phones: PhoneOverviewPhone[]
  overview: PhoneOverview
  relay: RelayStatus | null
  screens: Map<string, PhoneScreen>
  onPending: (phone: string, pending: boolean) => void
}) {
  const each = phones.map(phone => ({ phone, profiles: overview.profiles.filter(p => onPhone(p, phone, true)) }))
  const accounts = new Map<string, string[]>()
  for (const { phone, profiles } of each) {
    const email = profiles.find(p => p.selected)?.check?.chatGpt?.email?.toLowerCase()
    if (email) accounts.set(email, [...(accounts.get(email) ?? []), phone.name])
  }
  const shared = [...accounts].filter(([, names]) => names.length > 1)
  return (
    <div className="space-y-3">
      {each.map(({ phone, profiles }) => (
        <PhoneProfilePicker
          key={phone.id}
          label={`Profile on ${phone.name}`}
          phone={phone}
          profiles={profiles}
          relay={relay}
          screen={screens.get(phone.id) ?? null}
          onPending={pending => onPending(phone.id, pending)}
        />
      ))}
      {shared.map(([email, names]) => (
        <p key={email} className="flex items-start gap-1.5 text-xs text-amber-500">
          <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" />
          <span>{names.join(' and ')} are on the same ChatGPT account ({email}), so they’d share its limits. Pick a different profile on one of them.</span>
        </p>
      ))}
    </div>
  )
}

/**
 * The dialog: step 1 picks the automation, step 2 how it runs. `onStart` sends
 * it (the page toasts how that went) and resolves once sent, closing the dialog.
 * `startable` counts the phones that can be started now, for a split between them.
 */
export function RunAutomationDialog({ open, onOpenChange, phone, overview, several, startable, profiles, relay, screen, screens, now, sending, onStart, fixedSeries }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  phone: PhoneOverviewPhone
  overview: PhoneOverview
  several: boolean
  startable: PhoneOverviewPhone[]
  /** This phone's profiles: picked from in step 2; the selected one's plan and options give Image Clipper's ChatGPT choices. */
  profiles: PhoneUploadProfile[]
  relay: RelayStatus | null
  screen: PhoneScreen | null
  /** Every phone's screen, by device id: a split run has a profile picker per phone. */
  screens: Map<string, PhoneScreen>
  now: number
  sending: boolean
  onStart: (options: PhoneAutomationOptions) => Promise<boolean>
  /** Starting from a series' production process keeps every run on that series. */
  fixedSeries?: Pick<Series, 'id' | 'title'>
}) {
  const runs = phoneRuns(phone)
  // Builds that say how Image Clipper last ran also take its AI and method.
  const last = phone.automation?.clipper ?? null
  const choosesHow = last !== null
  const resume = phone.automation?.resume ?? null
  // Builds whose Editor 2.0 run takes tabs and a share of a split say how many tabs it last used.
  const editorLast = phone.automation?.editor ?? null

  const [kind, setKind] = useState<PhoneRunKind | null>(null)
  const [picked, setPicked] = useState<Partial<Record<PhoneRunKind, string>>>({})
  const [ai, setAi] = useState<PhoneClipperAi>(last?.ai==='gemini'?'aistudio':last?.ai ?? 'chatgpt')
  const [clipTabs, setClipTabs] = useState(last?.tabs ?? resume?.tabs ?? DEFAULT_TABS)
  const [voiceTabs, setVoiceTabs] = useState(DEFAULT_TABS)
  const [editorTabs, setEditorTabs] = useState(editorLast?.tabs ?? 1)
  const [editorAi, setEditorAi] = useState<'chatgpt' | 'aistudio'>(editorLast?.ai ?? 'chatgpt')
  const [smallBatches, setSmallBatches] = useState(editorLast?.smallBatches ?? true)
  const choosesEditor = editorLast?.providers?.includes('chatgpt') && editorLast.providers.includes('aistudio') && typeof editorLast.smallBatches === 'boolean'
  const [language, setLanguage] = useState<NarrationLanguage>('en')
  const [split, setSplit] = useState(false)
  // "Selected devices": the phones a split goes to, every startable phone until some are unticked.
  const [unselected, setUnselected] = useState<Set<string>>(new Set())
  const [chatGpt, setChatGpt] = useState<PhoneChatGptSettings>(last?.chatGpt ?? NO_CHATGPT_CHOICES)
  const [editorChatGpt, setEditorChatGpt] = useState<PhoneChatGptSettings>(editorLast?.chatGpt ?? NO_CHATGPT_CHOICES)
  // Phones a profile selection is on its way to (by device id, '' for this one when it has none).
  const [selecting, setSelecting] = useState<Record<string, boolean>>({})
  const onPending = useCallback((device: string, pending: boolean) => {
    setSelecting(s => (!!s[device] === pending ? s : { ...s, [device]: pending }))
  }, [])
  const onThisPending = useCallback((pending: boolean) => onPending(phone.id, pending), [onPending, phone.id])
  // Only builds that report the last choices (null from older ones) take them with the start.
  const choosesChatGpt = !!last?.chatGpt

  // Every series in the library: one the phone hasn't got yet can be sent to it from here.
  const [library, setLibrary] = useState<Series[]>([])
  useEffect(() => {
    if (!open || fixedSeries) return
    let cancelled = false
    seriesApi.getAll()
      .then(all => { if (!cancelled) setLibrary(all) })
      .catch(() => { /* the phone's series are still offered */ })
    return () => { cancelled = true }
  }, [open, fixedSeries])
  const orderedLibrary = useSeriesOrder(library)
  const onPhoneIds = new Set(overview.series.map(s => s.id))
  const notOnPhone = orderedLibrary.filter(s => !onPhoneIds.has(s.id))

  const automation = AUTOMATIONS.find(a => a.kind === kind) ?? null
  const seriesId = kind ? fixedSeries?.id ?? picked[kind] ?? preferredSeries(kind, overview, phone, several) : ''
  // The voiceover's scripts come from a Narration scripts run: its fix switches to that, on the same series.
  const runNarration = useCallback(() => {
    if (!seriesId) return
    setPicked(p => ({ ...p, narration: seriesId }))
    setKind('narration')
  }, [seriesId])
  const [narrationPartBySeries, setNarrationPartBySeries] = useState<Record<string, NarrationPartChoice>>({})
  const narrationPart = kind === 'narration' ? narrationPartBySeries[seriesId] : undefined
  // The voiceover voices every unfinished chapter unless a part is picked (then only that part's chapters).
  const [voiceoverPartBySeries, setVoiceoverPartBySeries] = useState<Record<string, NarrationPartChoice>>({})
  const voiceoverPart = kind === 'voiceover' ? voiceoverPartBySeries[seriesId] : undefined
  const seriesReadiness = useRunReadiness(automation ? automation.kind : null, seriesId, language, runNarration, kind === 'voiceover' ? voiceoverPart : narrationPart)
  const narrationScope = kind === 'narration' ? seriesReadiness.readiness?.narrationScope : undefined
  // Lock the default once loaded, so live receipts cannot move a pending start to another part.
  useEffect(() => {
    if (kind === 'narration' && narrationPart === undefined && narrationScope) {
      setNarrationPartBySeries(previous => ({ ...previous, [seriesId]: narrationScope.part }))
    }
  }, [kind, seriesId, narrationPart, narrationScope])
  const outsideNarration = narrationScope ? overview.runs.filter(run => run.kind === 'narration' && run.seriesId === seriesId && run.device === phone.id)
    .flatMap(run => run.tabs).find(tab => !narrationScope.chapters.includes(tab.chapter)) : undefined
  const narrationBlocked = kind === 'narration' && (!!outsideNarration || !phone.id || !phone.automation?.chapterRuns?.includes('narration') ||
    seriesReadiness.loading || !narrationScope?.chapters.length)
  const voiceoverScope = kind === 'voiceover' && seriesReadiness.readiness?.seriesId === seriesId ? seriesReadiness.readiness?.voiceoverScope : undefined
  // The last parts loaded for this series keep the picker in place while a newly picked part loads.
  const [voiceoverParts, setVoiceoverParts] = useState<{ seriesId: string; scope: NarrationRunScope } | null>(null)
  useEffect(() => { if (voiceoverScope) setVoiceoverParts({ seriesId, scope: voiceoverScope }) }, [voiceoverScope, seriesId])
  const shownVoiceoverScope = kind !== 'voiceover' ? undefined : voiceoverScope
    ?? (voiceoverParts?.seriesId === seriesId ? { ...voiceoverParts.scope, part: voiceoverPart ?? 'all' } : undefined)
  const voiceoverOnePart = kind === 'voiceover' && typeof voiceoverPart === 'number'
  const voiceoverPartUnsupported = !phone.automation?.chapterRuns?.includes('voiceover')
    ? `Update Sleeper-Cell on ${phone.name} to voice only one part.` : undefined
  // Metadata works on one part at a time (fixed twenty-chapter parts, as on the phone): only the
  // picked part's chapters are listed, checked, counted as blockers and sent.
  const metadataCheck = kind === 'metadata' && seriesReadiness.readiness?.kind === 'metadata' && seriesReadiness.readiness.seriesId === seriesId ? seriesReadiness.readiness : null
  const [pickedPart, setPickedPart] = useState<MetadataPartChoice | null>(null)
  useEffect(() => { setPickedPart(null) }, [kind, seriesId])
  const parts = metadataParts(metadataCheck?.metadataChapters ?? [], metadataCheck?.metadataBlocked ?? [], pickedPart)
  const metadataPart = pickedPart ?? defaultMetadataPart(parts)
  const metadataScope = scopeMetadata(parts, metadataPart)
  const availableMetadata = metadataScope.ready
  const metadataKey = availableMetadata.map(c => c.name).join('\0')
  const [metadataChapters, setMetadataChapters] = useState<string[]>([])
  useEffect(() => { setMetadataChapters(metadataKey ? metadataKey.split('\0') : []) }, [kind, seriesId, metadataPart, metadataKey])
  const readiness = metadataCheck ? { ...seriesReadiness, readiness: scopedMetadataReadiness(metadataCheck, parts, metadataPart, metadataScope) } : seriesReadiness
  const checked = readiness.readiness
  const blocked = !!checked?.items.some(i => i.state === 'blocked')
  // "Get ready & start": waits for the phone to have it all, then starts by itself.
  const [armed, setArmed] = useState(false)
  useEffect(() => { setArmed(false) }, [kind, seriesId, language, narrationPart, voiceoverPart])
  const canSplit = !!automation?.split && several && startable.length >= 2 && startable.some(p => p.id === phone.id)
  const selectedPhones = startable.filter(p => !unselected.has(p.id))
  const selectedKey = selectedPhones.map(p => p.id).join('\0')
  // Builds that take no share of this run would each do the whole series.
  const oldBuilds = automation ? selectedPhones.filter(p => !takesShare(automation.kind, p)) : []
  const splitBlocked = oldBuilds.length && automation
    ? `Update Sleeper-Cell on ${oldBuilds.map(p => p.name).join(' and ')} to split ${automation.name} between the phones, or untick it.`
    : undefined
  const splitting = canSplit && split
  // Shown, greyed out, when it can't be used: a phone that hasn't reported "Start from Manhwa Studio" yet must
  // not make the choice silently disappear.
  const notStartable = (overview.phones ?? []).filter(p => !startable.some(s => s.id === p.id))
    .map(p => `${p.name} (${!p.connected ? 'offline' : p.automation?.remoteStart === false ? '“Start from Manhwa Studio” off' : 'not reported yet'})`)
  const splitUnavailable = canSplit ? undefined
    : !startable.some(p => p.id === phone.id)
      ? `${phone.name} can’t be started from here yet. Connect it, turn on “Start from Manhwa Studio”, then Refresh from phone.`
      : `Selected devices needs two or more phones connected with “Start from Manhwa Studio” on.${notStartable.length ? ` Not ready: ${notStartable.join(', ')}.` : ''} Turn it on there, then Refresh from phone.`
  const tooFewSelected = splitting && selectedPhones.length < 2
  const tabs = kind === 'voiceover' ? voiceTabs : kind === 'editor' ? editorTabs : clipTabs
  const setTabs = kind === 'voiceover' ? setVoiceTabs : kind === 'editor' ? setEditorTabs : setClipTabs
  const tabsBlocked = kind === 'editor' && !editorLast
    ? `${phone.name} runs an older Sleeper-Cell: its Editor 2.0 run works in one tab. Update it to pick more.`
    : undefined
  const selectingProfile = Object.entries(selecting).some(([device, pending]) =>
    pending && (splitting ? selectedPhones.some(p => p.id === device) : device === phone.id))

  // Split across the phones: Start first asks for the plan, shown to confirm; Start there sends it as planned.
  const [plan, setPlan] = useState<PhoneSplitPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  useEffect(() => { setPlan(null); setPlanError(null) }, [kind, seriesId, language, splitting, selectedKey, kind === 'metadata' ? metadataChapters.join('\0') : '', voiceoverPart])
  // One part picked: wait for its chapters, and there must be some.
  const voiceoverPartBlocked = voiceoverOnePart && (seriesReadiness.loading || !voiceoverScope?.chapters.length || (!splitting && !!voiceoverPartUnsupported))
  const voiceoverPartChapters = voiceoverOnePart && voiceoverScope ? voiceoverScope.chapters : undefined
  const planned = plan ? plan.targets.filter(t => t.action !== 'skip') : []

  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setKind(null)
      setPlan(null)
    }
  }

  const start = async () => {
    if (!automation || narrationBlocked || voiceoverPartBlocked) return
    setArmed(false)
    if (splitting && !plan) {
      if (!seriesId) return
      setPlanning(true)
      setPlanError(null)
      try {
        setPlan(await r2Api.planPhoneSplit(automation.kind, seriesId, language, {
          devices: selectedPhones.map(p => p.id),
          ...(automation.kind === 'metadata' ? { chapters: metadataChapters } : {}),
          ...(voiceoverPartChapters ? { chapters: voiceoverPartChapters } : {})
        }))
      } catch (error) {
        setPlanError(error instanceof Error ? error.message : String(error))
      } finally {
        setPlanning(false)
      }
      return
    }
    const options: PhoneAutomationOptions = {
      kind: automation.kind,
      // A Metadata split sends each phone its share of the picked chapters, as planned, in place of one phone's list.
      ...(kind==='metadata'?{ai:'aistudio' as const,...(splitting?{}:{device:phone.id,chapters:metadataChapters})}:{}),
      ...(kind === 'narration' && narrationScope ? { device: phone.id, chapters: narrationScope.chapters } : {}),
      ...(voiceoverPartChapters && !splitting ? { device: phone.id, chapters: voiceoverPartChapters } : {}),
      seriesId: seriesId || undefined,
      ...(automation.tabs && !(kind === 'editor' && tabsBlocked) ? { tabs } : {}),
      ...(automation.clipper && choosesHow ? { ai, flow:ai==='chatgpt'?'classic' as const:'steps' as const } : {}),
      ...(automation.clipper && choosesChatGpt && ai === 'chatgpt'
        ? { chatGpt: hasChoices(profiles.find(p => p.selected) ?? null) === false ? NO_CHATGPT_CHOICES : chatGpt }
        : {}),
      ...(kind === 'editor' && choosesEditor ? { ai: editorAi, smallBatches } : {}),
      ...(kind === 'editor' && editorAi === 'chatgpt' && editorLast?.staged ? { chatGpt: hasChoices(profiles.find(p => p.selected) ?? null) === false ? NO_CHATGPT_CHOICES : editorChatGpt } : {}),
      ...(automation.language ? { language } : {}),
      ...(splitting && plan
        ? { split: true, devices: selectedPhones.map(p => p.id), assignments: Object.fromEntries(planned.map(t => [t.device, t.chapters])) }
        : phone.id && (several || kind==='metadata') ? { device: phone.id } : {})
    }
    if (await onStart(options)) close(false)
  }
  const startRef = useRef(start)
  startRef.current = start
  useEffect(() => {
    if (armed && !narrationBlocked && !voiceoverPartBlocked && checked?.ready && !checked.sending && !readiness.job && !readiness.loading && readiness.fixing === null) void startRef.current()
  }, [armed, checked, readiness.job, readiness.loading, readiness.fixing, narrationBlocked, voiceoverPartBlocked])

  const getReady = async () => {
    // With something only fixable elsewhere, it would never be all there: send what can be, but don't wait to start.
    setArmed(!blocked)
    if (!(await readiness.fixAll())) setArmed(false)
  }
  const notReady = !!seriesId && !!checked && !checked.ready

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {plan ? 'Split across the phones · Check the plan' : automation ? 'Step 2 of 2 · How' : 'Step 1 of 2 · Which automation'}
          </p>
          <DialogTitle className="flex items-center gap-2">
            {automation ? <><automation.icon className="h-5 w-5 text-muted-foreground" /> {automation.name}</> : 'Run automation'}
          </DialogTitle>
          <DialogDescription>
            {fixedSeries && <span className="mb-1 block font-medium text-foreground">{fixedSeries.title}</span>}
            {automation ? `On ${splitting ? `${selectedPhones.length} phones` : phone.name}. ${automation.does}.` : `What should ${phone.name} run?`}
          </DialogDescription>
        </DialogHeader>

        {automation && plan
          ? <SplitPlanView plan={plan} />
          : !automation
          ? (
            <AutomationFlow card={k => {
              const a = AUTOMATIONS.find(x => x.kind === k)!
              const supported = runs.includes(a.kind)
              return (
                <button
                  key={a.kind}
                  type="button"
                  disabled={!supported}
                  onClick={() => setKind(a.kind)}
                  className={cn(
                    'flex h-full flex-col gap-1.5 rounded-lg border p-4 text-left transition-colors',
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
            }} />
          )
          : (
            <div className="space-y-5">
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Series</p>
                {fixedSeries ? <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm">{fixedSeries.title}</p> : <Select value={seriesId} onValueChange={id => setPicked(p => ({ ...p, [automation.kind]: id }))} disabled={!overview.series.length && !notOnPhone.length}>
                  <SelectTrigger className="h-9" aria-label="Series">
                    <SelectValue placeholder={automation.clipper ? 'The phone’s last run' : 'Pick a series'} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {notOnPhone.length > 0 && <SelectLabel>On the phone</SelectLabel>}
                      {overview.series.map(s => {
                        const progress = automation.progress?.(s) ?? null
                        return (
                          <SelectItem key={s.id} value={s.id}>
                            {s.title}{progress ? ` · ${progress.done}/${progress.total}` : ''}
                          </SelectItem>
                        )
                      })}
                    </SelectGroup>
                    {notOnPhone.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Not on the phone yet</SelectLabel>
                        {notOnPhone.map(s => <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>)}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>}
              </div>

              {kind === 'narration' && narrationScope && <NarrationPartChoices scope={narrationScope} onChange={part => {
                setArmed(false)
                setNarrationPartBySeries(previous => ({ ...previous, [seriesId]: part }))
              }} />}
              {outsideNarration && <p className="text-xs text-amber-500">Stop the current Narration scripts run on {phone.name} ({outsideNarration.chapter}) before switching parts.</p>}
              {kind === 'narration' && !phone.automation?.chapterRuns?.includes('narration') && <p className="text-xs text-amber-500">Update Sleeper-Cell on {phone.name} to start scripts for a selected part.</p>}
              {shownVoiceoverScope && shownVoiceoverScope.parts.length > 0 && <NarrationPartChoices
                scope={shownVoiceoverScope}
                allHint="Voices every unfinished chapter, in reading order. Completed parts are skipped."
                onChange={part => {
                  setArmed(false)
                  setVoiceoverPartBySeries(previous => ({ ...previous, [seriesId]: part }))
                }} />}
              {voiceoverOnePart && !splitting && voiceoverPartUnsupported && <p className="text-xs text-amber-500">{voiceoverPartUnsupported}</p>}
              {seriesId && <RunReadinessPanel state={readiness} />}
              {kind === 'metadata' && parts.length > 0 && (
                <Choices
                  label="Part"
                  choices={[
                    ...parts.map(p => ({
                      value: String(p.part),
                      label: `Part ${p.part}`,
                      hint: `Ch. ${p.from}–${p.to} only: ${p.ready.length} ready${p.blocked.length ? `, ${p.blocked.length} not ready` : ''}. Other parts aren’t listed or sent.`
                    })),
                    { value: 'all', label: 'All parts', hint: `Every part: ${parts.reduce((n, p) => n + p.ready.length, 0)} ready, ${parts.reduce((n, p) => n + p.blocked.length, 0)} not ready.` }
                  ]}
                  value={String(metadataPart)}
                  onChange={v => setPickedPart(v === 'all' ? 'all' : Number(v))}
                />
              )}
              {kind==='metadata' && <div className="space-y-2">
                <p className="text-sm font-medium">Approved chapters</p>
                {availableMetadata.map(ch=><label key={ch.name} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={metadataChapters.includes(ch.name)} onChange={event=>setMetadataChapters(prev=>event.target.checked?[...prev,ch.name]:prev.filter(name=>name!==ch.name))}/>
                  Chapter {ch.number} · {ch.name}
                </label>)}
                {!availableMetadata.length && <p className="text-xs text-muted-foreground">No unfinished reviewed and cut chapters are eligible{metadataPart === 'all' ? '' : ` in Part ${metadataPart}`}. Review and cut them in Image Clipper, then check again.</p>}
              </div>}

              {splitting
                ? <SplitProfiles phones={selectedPhones} overview={overview} relay={relay} screens={screens} onPending={onPending} />
                : <PhoneProfilePicker phone={phone} profiles={profiles} relay={relay} screen={screen} onPending={onThisPending} />}

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
                    choices={FLOW_CHOICES.filter(c=>c.value===(ai==='chatgpt'?'classic':'steps'))}
                    value={ai==='chatgpt'?'classic':'steps'}
                    onChange={() => {}}
                    disabled={choosesHow ? undefined : 'Same for the method: 1 step or 4 steps as last picked on the phone.'}
                  />
                  {ai === 'chatgpt' && (choosesChatGpt
                    ? <ChatGptChoices phone={phone} profiles={profiles} relay={relay} screen={screen} value={chatGpt} onChange={setChatGpt} now={now} />
                    : <p className="text-xs text-muted-foreground">Update Sleeper-Cell on {phone.name} to pick ChatGPT’s mode, model and effort here.</p>)}
                </>
              )}

              {kind === 'editor' && <EditorSettings ai={editorAi} smallBatches={smallBatches} onAiChange={setEditorAi} onSmallBatchesChange={setSmallBatches} disabled={choosesEditor ? undefined : `Update Sleeper-Cell on ${phone.name} and refresh Phone Status to choose Editor AI and small batches.`} />}
              {kind === 'editor' && editorAi === 'chatgpt' && editorLast?.staged && <ChatGptChoices phone={phone} profiles={profiles} relay={relay} screen={screen} value={editorChatGpt} onChange={setEditorChatGpt} now={now} />}
              {automation.language && <Choices label="Language" choices={LANGUAGE_CHOICES} value={language} onChange={setLanguage} />}

              {automation.tabs && (
                <TabChoices value={tabs} onChange={setTabs} each={splitting} unit={automation.tabs.unit} disabled={tabsBlocked} />
              )}

              {automation.split && several && (
                <Choices
                  label="Phones"
                  choices={[
                    { value: 'one', label: `Only ${phone.name}` },
                    {
                      value: 'split',
                      label: 'Selected devices',
                      hint: `${SPLIT_HINT[automation.kind] ?? ''} A phone already on this run keeps the chapter it’s on; one busy with something else is left alone. Start shows the plan first. Each phone works in the profile picked for it.`
                    }
                  ]}
                  value={splitting ? 'split' : 'one'}
                  onChange={v => setSplit(v === 'split')}
                  disabled={splitUnavailable}
                />
              )}
              {splitting && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">Devices</p>
                    <Button variant="outline" size="sm" disabled={sending || planning || !unselected.size} onClick={() => setUnselected(new Set())}>
                      Select all devices
                    </Button>
                  </div>
                  {startable.map(p => (
                    <label key={p.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={!unselected.has(p.id)}
                        disabled={sending || planning}
                        onChange={event => setUnselected(prev => {
                          const next = new Set(prev)
                          if (event.target.checked) next.delete(p.id); else next.add(p.id)
                          return next
                        })}
                      />
                      {p.name}
                    </label>
                  ))}
                  {tooFewSelected && <p className="text-xs text-amber-500">Select at least two devices to split between them.</p>}
                  {splitBlocked && <p className="text-xs text-amber-500">{splitBlocked}</p>}
                </div>
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

        {planError && (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{planError}</span>
          </p>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          {automation
            ? (
              <>
                <Button variant="ghost" onClick={() => (plan ? setPlan(null) : setKind(null))}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back
                </Button>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {armed && (
                    <span className="flex items-center gap-1.5 text-xs text-sky-500">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Starts once the phone has it all. Keep this open.
                    </span>
                  )}
                  {notReady && readiness.fixable.length > 0 && !armed && !plan && (
                    <Button
                      onClick={() => void getReady()}
                      disabled={sending || readiness.fixing !== null || selectingProfile || narrationBlocked || voiceoverPartBlocked}
                      title={blocked ? 'Sends what can be sent from here; the rest needs doing first, so it won’t start by itself' : 'Sends what the phone is missing, then starts once it has it'}
                    >
                      {readiness.fixing === 'all' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                      {blocked ? 'Send what’s missing' : 'Get ready & start'}
                    </Button>
                  )}
                  {armed
                    ? <Button variant="outline" onClick={() => setArmed(false)}>Don’t start by itself</Button>
                    : (
                      <Button
                        variant={notReady && readiness.fixable.length > 0 && !plan ? 'outline' : 'default'}
                        onClick={start}
                        disabled={sending || planning || selectingProfile || narrationBlocked || voiceoverPartBlocked || tooFewSelected || (splitting && !!splitBlocked) || (kind==='metadata' && (!phone.id || !metadataChapters.length || readiness.loading)) || (!seriesId && (splitting || !automation.clipper)) || (!!plan && !planned.length)}
                        title={selectingProfile
                          ? 'Waiting for the phone to switch profile'
                          : splitting && !plan ? 'Shows which phone takes which chapters, to check before it starts'
                          : notReady ? 'Starts on what the phone has now' : undefined}
                      >
                        {sending || planning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                        {plan
                          ? `Start on ${planned.length} phone${planned.length === 1 ? '' : 's'}`
                          : splitting ? 'Plan the split' : notReady ? 'Start anyway' : 'Start'}
                      </Button>
                    )}
                </div>
              </>
            )
            : <Button variant="ghost" className="ml-auto" onClick={() => close(false)}>Cancel</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
