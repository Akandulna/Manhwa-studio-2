/**
 * PhoneSyncBadge — does the Sleeper-Cell phone app have the chapters sent to it?
 * PhoneScriptBadge (below) — has the phone written this chapter's narration script?
 * PhoneCropsBadge / PhonePageBadge (below) — how far the phone's Image Clipper has got.
 *
 * The phone reports each chapter it unpacks or clears (see phoneSend.ts
 * getPhoneSync). Shown only for series with chapters sent. Colours follow the
 * app's status scheme: green = done, blue = in progress, amber = needs action.
 */

import { Bot, Clock, Hand, Loader2, Pause, Smartphone } from 'lucide-react'
import type { PhoneChapterHinglish, PhoneChapterScript, PhonePageFinish, PhonePageState, PhoneSeriesSync } from '@/lib/api'
import { cn } from '@/lib/utils'

const STYLES: Record<PhoneSeriesSync['state'], { label: (s: PhoneSeriesSync) => string; className: string }> = {
  downloaded: { label: s => (s.sent > 0 ? `On phone ${s.onPhone}` : `Cleared ${s.cleared}`), className: 'bg-emerald-600 text-white' },
  downloading: { label: s => `Downloading ${s.downloading}`, className: 'bg-sky-600 text-white' },
  outdated: { label: s => `Phone: ${s.onPhone}/${s.sent}`, className: 'bg-amber-500 text-white' },
  missing: { label: () => 'Not on phone', className: 'bg-background/90 text-muted-foreground border-border' }
}

function formatWhen(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function describe(sync: PhoneSeriesSync, device: string | null): string {
  const phone = device ? `The phone (${device})` : 'The phone'
  const sent = formatWhen(sync.uploadedAt)
  const cleared = sync.cleared > 0 ? ` ${sync.cleared} cleared there once done.` : ''
  const chapters = `${sync.sent} chapter${sync.sent === 1 ? '' : 's'} sent${sent ? ` (last ${sent})` : ''}`
  switch (sync.state) {
    case 'downloaded': {
      const at = formatWhen(sync.phoneAt)
      return `${phone} has all ${chapters}${at ? `, last unpacked ${at}` : ''}.${cleared}`
    }
    case 'downloading':
      return `${phone} is downloading ${sync.downloading} of ${chapters}; it has ${sync.onPhone}.${cleared}`
    case 'outdated':
      return `${phone} has ${sync.onPhone} of ${chapters}. Tap "Check for new uploads" on the phone.${cleared}`
    case 'missing':
      return `${phone} has none of ${chapters} yet. Tap "Check for new uploads" on the phone.${cleared}`
  }
}

export function PhoneSyncBadge({ sync, device }: { sync: PhoneSeriesSync; device: string | null }) {
  const style = STYLES[sync.state]
  return (
    <span
      title={describe(sync, device)}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-transparent px-2 py-0.5 text-xs font-semibold shadow-sm',
        style.className
      )}
    >
      {sync.state === 'downloading'
        ? <Loader2 className="h-3 w-3 animate-spin" />
        : <Smartphone className="h-3 w-3" />}
      {style.label(sync)}
    </span>
  )
}

type PhoneScriptStatus = PhoneChapterScript['status'] | PhoneChapterHinglish['status']

const SCRIPT_STYLES: Record<PhoneScriptStatus, { label: string; className: string; hint: string }> = {
  done: { label: 'Phone: Done', className: 'bg-emerald-600 text-white', hint: 'Script, summary and closing saved' },
  needs_summary: {
    label: 'Phone: Needs summary',
    className: 'bg-amber-500 text-white',
    hint: 'Script saved without its summary or closing paragraph'
  },
  stale: {
    label: 'Phone: Stale',
    className: 'bg-amber-500 text-white',
    hint: 'An earlier chapter was saved again after this one'
  },
  review: {
    label: 'Phone: Needs review',
    className: 'bg-amber-500 text-white',
    hint: 'Hinglish saved even though it failed the length/paragraph check'
  }
}

/** On the Hindi tab "stale" means the English script changed after the conversion. */
const HINGLISH_STYLES: Partial<Record<PhoneScriptStatus, { label: string; className: string; hint: string }>> = {
  done: { label: 'Phone: Done', className: 'bg-emerald-600 text-white', hint: 'Hinglish converted and checked' },
  stale: {
    label: 'Phone: Stale',
    className: 'bg-amber-500 text-white',
    hint: 'The English script changed after this was converted'
  }
}

/**
 * PhoneScriptBadge — the chapter's narration script status in the Sleeper-Cell
 * app (see usePhoneScripts); `hinglish` for the Hindi tab's Hinglish script.
 */
export function PhoneScriptBadge({
  script,
  device,
  hinglish = false
}: {
  script: { status: PhoneScriptStatus; savedAt: string | null }
  device: string | null
  hinglish?: boolean
}) {
  const style = (hinglish && HINGLISH_STYLES[script.status]) || SCRIPT_STYLES[script.status]
  if (!style) return null
  const saved = formatWhen(script.savedAt)
  const where = device ? `on the phone (${device})` : 'on the phone'
  return (
    <span
      title={`${style.hint} ${where}${saved ? `, ${saved}` : ''}`}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-transparent px-2 py-0.5 text-xs font-semibold shadow-sm',
        style.className
      )}
    >
      <Smartphone className="h-3 w-3" />
      {style.label}
    </span>
  )
}

const PILL = 'inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-transparent px-2 py-0.5 text-xs font-semibold shadow-sm'

function onPhone(device: string | null): string {
  return device ? `on the phone (${device})` : 'on the phone'
}

/**
 * PhoneCropsBadge — a chapter's crop progress in the Sleeper-Cell app (see
 * usePhoneCrops): pages with their JSON files out of the pages the phone has.
 * `working` is the pages its Auto-run is on in this chapter (one per ChatGPT tab).
 */
export function PhoneCropsBadge({
  done,
  total,
  working,
  device
}: {
  done: number
  total: number
  working?: { page: string; paused: boolean }[]
  device: string | null
}) {
  const complete = total > 0 && done >= total
  const pages = working ?? []
  return (
    <>
      <span
        title={`${done} of ${total} pages have crop pointers and metadata ${onPhone(device)}`}
        className={cn(PILL, complete ? 'bg-emerald-600 text-white' : 'bg-sky-600 text-white')}
      >
        <Smartphone className="h-3 w-3" />
        {done}/{total} pages
      </span>
      {pages.length === 1 && <PhoneWorkingBadge page={pages[0].page} paused={pages[0].paused} device={device} />}
      {pages.length > 1 && (
        <PhoneWorkingBadge page={pages.map(p => p.page).join(', ')} paused={pages[0].paused} device={device} count={pages.length} />
      )}
    </>
  )
}

/** The page the phone's Auto-run is on right now; with `count`, several pages at once (`page` lists them). */
export function PhoneWorkingBadge({
  page,
  paused,
  device,
  showPage = true,
  count
}: {
  page: string
  paused: boolean
  device: string | null
  showPage?: boolean
  count?: number
}) {
  return (
    <span
      title={`Auto-run ${paused ? 'is paused on' : 'is making crop pointers for'} ${page} ${onPhone(device)}`}
      className={cn(PILL, 'max-w-full', paused ? 'bg-amber-500 text-white' : 'bg-sky-600 text-white')}
    >
      {paused ? <Pause className="h-3 w-3 flex-shrink-0" /> : <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />}
      <span className="truncate">
        {paused ? 'Paused' : 'Processing'}
        {count ? ` ${count} pages` : showPage ? ` ${page}` : ' on phone'}
      </span>
    </span>
  )
}

const PAGE_STYLES: Record<PhonePageState, { label: string; className: string; hint: string }> = {
  done: { label: 'Phone: Done', className: 'bg-emerald-600 text-white', hint: 'Crop pointers and metadata generated' },
  in_progress: {
    label: 'Phone: Started',
    className: 'bg-background/90 text-sky-600 border-sky-600/60',
    hint: 'Sections made; the ChatGPT rounds are not finished'
  },
  changed: {
    label: 'Phone: Page changed',
    className: 'bg-amber-500 text-white',
    hint: 'The page file was replaced since it was started, so it starts over'
  }
}

/** A duration in seconds as "45s", "3m 12s" or "1h 05m". */
export function formatTook(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** A time of day as "14:05", with the date in front when it isn't today. */
function formatClock(date: Date): string {
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === new Date().toDateString()) return time
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

/**
 * PhonePageBadge — one page's crop status in the Sleeper-Cell app (see usePhoneCrops).
 * A done page also shows how long it took there, when it started and finished
 * and, for Auto-run, which ChatGPT account (browser profile) and model made it,
 * when the phone says.
 */
export function PhonePageBadge({ state, device, finish }: { state: PhonePageState; device: string | null; finish?: PhonePageFinish }) {
  const style = PAGE_STYLES[state]
  const done = state === 'done' ? finish : undefined
  const took = done?.took != null ? formatTook(done.took) : null
  const finished = done ? formatWhen(done.at) : null
  const timing = took ? ` in ${took} (sections made to JSON exported)` : ''
  return (
    <>
      <span
        title={`${style.hint}${timing}${finished ? `, finished ${finished}` : ''} ${onPhone(device)}`}
        className={cn(PILL, 'flex-shrink-0', style.className)}
      >
        <Smartphone className="h-3 w-3" />
        {style.label}
        {took && <span className="font-normal opacity-90">· {took}</span>}
      </span>
      {done && <PhoneTimesBadge finish={done} />}
      {done?.run && <PhoneMadeByBadge finish={done} />}
    </>
  )
}

/**
 * When a done page was started and finished on the phone. The phone sends only
 * the export time and the duration, so the start is the export time minus `took`.
 */
function PhoneTimesBadge({ finish }: { finish: PhonePageFinish }) {
  const end = new Date(finish.at)
  if (Number.isNaN(end.getTime())) return null
  const start = finish.took != null ? new Date(end.getTime() - finish.took * 1000) : null
  const title = [
    start ? `Started ${start.toLocaleString()} (sections made)` : 'Start time not recorded',
    `finished ${end.toLocaleString()} (JSON exported)`
  ].join('; ')
  return (
    <span title={title} className={cn(PILL, 'flex-shrink-0 bg-background/90 text-muted-foreground border-border font-normal tabular-nums')}>
      <Clock className="h-3 w-3" />
      {start ? `${formatClock(start)} → ${formatClock(end)}` : `Finished ${formatClock(end)}`}
    </span>
  )
}

/** Who made a done page on the phone: Auto-run's ChatGPT account and model(s), or by hand. */
function PhoneMadeByBadge({ finish }: { finish: PhonePageFinish }) {
  if (finish.run === 'manual') {
    return (
      <span title="Crop pointers pasted by hand on the phone" className={cn(PILL, 'flex-shrink-0 bg-background/90 text-muted-foreground border-border font-normal')}>
        <Hand className="h-3 w-3" />
        By hand
      </span>
    )
  }
  const account = finish.account ?? finish.profile
  const model = finish.models.at(-1) ?? null
  const parts = [account, model].filter(Boolean)
  const title = [
    `Auto-run on the ChatGPT account ${finish.account ?? 'unknown'}${finish.profile ? ` (profile ${finish.profile})` : ''}`,
    finish.models.length ? `answered by ${finish.models.join(', then ')}` : 'model not recorded'
  ].join('; ')
  return (
    <span title={title} className={cn(PILL, 'flex-shrink-0 max-w-[16rem] bg-background/90 text-muted-foreground border-border font-normal')}>
      <Bot className="h-3 w-3 flex-shrink-0" />
      <span className="truncate">{parts.length ? parts.join(' · ') : 'Auto-run'}</span>
      {finish.models.length > 1 && <span className="opacity-80">+{finish.models.length - 1}</span>}
    </span>
  )
}
