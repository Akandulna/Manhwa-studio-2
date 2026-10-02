/**
 * PhoneUploadUsage — how many images each Sleeper-Cell profile has uploaded
 * to ChatGPT in the last 3 hours, how many of the 80 that leaves, and when, at
 * the pace of the run, it will be used up (see lib/uploadUsage). One row per browser profile
 * on the phone, so a profile added there shows up here by itself.
 *
 * It reads the crops receipt the page already has; the only timer re-renders
 * the times once a minute, with no request.
 */

import { useEffect, useState } from 'react'
import { Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import type { PhoneCropsStatus } from '@/lib/api'
import { UPLOAD_LIMIT, uploadOverview, uploadUsage, type UploadUsage } from '@/lib/uploadUsage'

function clock(ms: number): string {
  const date = new Date(ms)
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
}

function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}

function ProfileRow({ usage, now }: { usage: UploadUsage; now: number }) {
  const { profile, limit, left, used, pace } = usage
  const percent = Math.min(100, (used / limit) * 100)
  const state = usage.limitedUntil
    ? <Badge variant="destructive">Limited · lifts ~{clock(usage.limitedUntil)}</Badge>
    : pace
      ? <Badge className="bg-sky-600 hover:bg-sky-600">Uploading</Badge>
      : <Badge variant="outline">Idle</Badge>

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{profile.name}</span>
        {profile.selected && <Badge variant="secondary">selected on phone</Badge>}
        {state}
        <span className="ml-auto text-muted-foreground tabular-nums">
          {used} / {limit} in 3h · {left} left
        </span>
      </div>
      <Progress
        value={usage.limitedUntil ? 100 : percent}
        className={`h-1.5 ${usage.limitedUntil || percent >= 85 ? '[&>div]:bg-destructive' : percent >= 60 ? '[&>div]:bg-amber-500' : ''}`}
      />
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
        {pace !== null && <span>Pace ~{Math.round(pace)}/h</span>}
        {usage.exhaustsAt !== null && (
          <span className={usage.exhaustsAt - now < 30 * 60_000 ? 'text-destructive font-medium' : 'text-foreground'}>
            Runs out ~{clock(usage.exhaustsAt)} (in {span(usage.exhaustsAt - now)})
          </span>
        )}
        <span>Last hour {usage.lastHour} · last 24h {usage.lastDay}</span>
        {usage.nextFreeAt !== null && !usage.limitedUntil && (
          <span>+{usage.nextFree} free again ~{clock(usage.nextFreeAt)}</span>
        )}
        {usage.lastLimit && (
          <span title={usage.lastLimit.reason || undefined}>
            Last stopped by ChatGPT {clock(Date.parse(usage.lastLimit.at))}
          </span>
        )}
      </div>
    </div>
  )
}

export function PhoneUploadUsage({ status, className = '' }: {
  status: Pick<PhoneCropsStatus, 'profiles' | 'reportedAt'> | null
  className?: string
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const profiles = status?.profiles ?? []
  if (!profiles.length) return null
  const usages = profiles.map(p => uploadUsage(p, now))
  const overview = uploadOverview(usages, now)

  return (
    <Card className={className}>
      <CardContent className="p-4 space-y-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Upload className="h-4 w-4 text-muted-foreground" />
            ChatGPT uploads on the phone
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            ~{overview.left} images left across {profiles.length} profile{profiles.length === 1 ? '' : 's'}
            {overview.allUsedAt !== null && ` · all used up ~${clock(overview.allUsedAt)} at ~${Math.round(overview.pace!)}/h`}
            {overview.nextLiftAt !== null && ` · next lift ~${clock(overview.nextLiftAt)}`}
          </span>
        </div>
        {usages.map(usage => <ProfileRow key={usage.profile.id} usage={usage} now={now} />)}
        <p className="text-[11px] text-muted-foreground">
          ChatGPT takes {UPLOAD_LIMIT} files per account in any 3 hours; each upload frees up 3 hours after it was
          made. As of {status?.reportedAt ? clock(Date.parse(status.reportedAt)) : 'the last report'}.
        </p>
      </CardContent>
    </Card>
  )
}
