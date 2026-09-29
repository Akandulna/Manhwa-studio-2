/**
 * PhoneSyncBadge — has the Sleeper-Cell phone app downloaded this series' R2 zip?
 *
 * The phone writes a receipt to the bucket after each sync (see r2Service
 * getPhoneSync). Shown only for series with a zip in R2. Colours follow the
 * app's status scheme: green = done, blue = in progress, amber = needs action.
 */

import { Loader2, Smartphone } from 'lucide-react'
import type { PhoneSeriesSync } from '@/lib/api'
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
