/**
 * PhoneSyncBadge — has the Sleeper-Cell phone app downloaded this series' R2 zip?
 * PhoneScriptBadge (below) — has the phone written this chapter's narration script?
 * PhoneCropsBadge / PhonePageBadge (below) — how far the phone's Image Clipper has got.
 *
 * The phone writes a receipt to the bucket after each sync (see r2Service
 * getPhoneSync). Shown only for series with a zip in R2. Colours follow the
 * app's status scheme: green = done, blue = in progress, amber = needs action.
 */

import { Loader2, Pause, Smartphone } from 'lucide-react'
import type { PhoneChapterScript, PhonePageState, PhoneSeriesSync } from '@/lib/api'
import { cn } from '@/lib/utils'

const STYLES: Record<PhoneSeriesSync['state'], { label: string; className: string }> = {
  downloaded: { label: 'On phone', className: 'bg-emerald-600 text-white' },
  downloading: { label: 'Downloading', className: 'bg-sky-600 text-white' },
  outdated: { label: 'Phone: old copy', className: 'bg-amber-500 text-white' },
  missing: { label: 'Not on phone', className: 'bg-background/90 text-muted-foreground border-border' }
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
  const uploaded = formatWhen(sync.uploadedAt)
  const upload = uploaded ? `the upload from ${uploaded}` : 'the latest upload'
  switch (sync.state) {
    case 'downloaded': {
      const at = formatWhen(sync.phoneAt)
      return `${phone} has ${upload}${at ? ` (unzipped ${at})` : ''}`
    }
    case 'downloading':
      return `${phone} is downloading ${upload}`
    case 'outdated':
      return `${phone} has an earlier upload, not ${upload}. Tap "Check for new uploads" on the phone.`
    case 'missing':
      return `${phone} hasn't downloaded this series yet. Tap "Check for new uploads" on the phone.`
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
      {style.label}
    </span>
  )
}

const SCRIPT_STYLES: Record<PhoneChapterScript['status'], { label: string; className: string; hint: string }> = {
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
  }
}

/** PhoneScriptBadge — the chapter's narration script status in the Sleeper-Cell app (see usePhoneScripts). */
export function PhoneScriptBadge({ script, device }: { script: PhoneChapterScript; device: string | null }) {
  const style = SCRIPT_STYLES[script.status]
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
 * `working` is the page its Auto-run is on in this chapter, if any.
 */
export function PhoneCropsBadge({
  done,
  total,
  working,
  device
}: {
  done: number
  total: number
  working?: { page: string; paused: boolean } | null
  device: string | null
}) {
  const complete = total > 0 && done >= total
  return (
    <>
      <span
        title={`${done} of ${total} pages have crop pointers and metadata ${onPhone(device)}`}
        className={cn(PILL, complete ? 'bg-emerald-600 text-white' : 'bg-sky-600 text-white')}
      >
        <Smartphone className="h-3 w-3" />
        {done}/{total} pages
      </span>
      {working && <PhoneWorkingBadge page={working.page} paused={working.paused} device={device} />}
    </>
  )
}

/** The page the phone's Auto-run is on right now. */
export function PhoneWorkingBadge({
  page,
  paused,
  device,
  showPage = true
}: {
  page: string
  paused: boolean
  device: string | null
  showPage?: boolean
}) {
  return (
    <span
      title={`Auto-run ${paused ? 'is paused on' : 'is making crop pointers for'} ${page} ${onPhone(device)}`}
      className={cn(PILL, 'max-w-full', paused ? 'bg-amber-500 text-white' : 'bg-sky-600 text-white')}
    >
      {paused ? <Pause className="h-3 w-3 flex-shrink-0" /> : <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />}
      <span className="truncate">
        {paused ? 'Paused' : 'Processing'}
        {showPage ? ` ${page}` : ' on phone'}
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

/** PhonePageBadge — one page's crop status in the Sleeper-Cell app (see usePhoneCrops). */
export function PhonePageBadge({ state, device }: { state: PhonePageState; device: string | null }) {
  const style = PAGE_STYLES[state]
  return (
    <span title={`${style.hint} ${onPhone(device)}`} className={cn(PILL, 'flex-shrink-0', style.className)}>
      <Smartphone className="h-3 w-3" />
      {style.label}
    </span>
  )
}
