import { useState } from 'react'
import type { PhoneSendJob, PhoneSendSeriesProgress } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { formatBytes } from '@/lib/utils'
import { AlertTriangle, CheckCircle, ChevronDown, ChevronUp, Loader2, Scissors, Smartphone, XCircle } from 'lucide-react'

interface Props {
  job: PhoneSendJob
  onCancel: () => void
  onDismiss: () => void
}

const SERIES_STATE_LABEL: Record<PhoneSendSeriesProgress['state'], string> = {
  queued: 'Queued',
  sending: 'Sending…',
  done: 'Sent',
  skipped: 'Nothing new',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

function pct(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
}

function chapters(n: number): string {
  return `${n} chapter${n === 1 ? '' : 's'}`
}

/** How the phone was told; it starts downloading at once only if Sleeper-Cell is open. */
function phoneLine(job: PhoneSendJob): string | null {
  if (job.phoneError) return `Couldn't ask the phone to fetch them: ${job.phoneError}. Tap "Check for new uploads" in Sleeper-Cell.`
  if (!job.phone) return null
  if (job.phone.via === 'relay') {
    return job.phone.phones
      ? 'Sleeper-Cell is open and is downloading them now.'
      : 'Sleeper-Cell will download them the next time it is opened.'
  }
  return 'Sleeper-Cell picks them up within 30 s while it is open, or tap "Check for new uploads".'
}

/**
 * Bottom bar for sending chapters to Sleeper-Cell. While running it shows the
 * current series and chapter with one bar (each chapter is zipped, then
 * uploaded); once finished, the outcome and how the phone was told, with a
 * Done button. The job is server-side, so this comes back in the right state
 * after navigating away.
 */
export function PhoneSendStatusBar({ job, onCancel, onDismiss }: Props) {
  const [expanded, setExpanded] = useState(false)

  const running = job.state === 'running'
  const sent = job.series.filter(s => s.state === 'done')
  const failed = job.series.filter(s => s.state === 'failed')
  const chaptersSent = job.series.reduce((sum, s) => sum + s.chaptersSent, 0)
  const bytesSent = job.series.reduce((sum, s) => sum + (s.chaptersSent > 0 ? s.bytesDone : 0), 0)
  const activeIndex = job.series.findIndex(s => s.state === 'sending')
  const active = activeIndex >= 0 ? job.series[activeIndex] : null
  const stitching = job.series.find(s => s.preparing)
  const label = job.auto ? 'Auto-sending new chapters to the phone' : 'Sending chapters to the phone'

  let icon = <Loader2 className="h-5 w-5 animate-spin text-primary" />
  let title = `${label} · ${job.bucket}`
  let detail = active
    ? `${active.title} — ${active.current ? `${active.current.folder} (${active.chaptersSent + 1} of ${active.chaptersTotal})` : chapters(active.chaptersTotal)}`
    : stitching?.preparing
      ? `${stitching.title} — stitching chapter ${stitching.preparing.chapterNumber} (${stitching.preparing.index} of ${stitching.preparing.total}) before sending`
      : 'Preparing…'

  if (job.state === 'cancelled') {
    icon = <XCircle className="h-5 w-5 text-muted-foreground" />
    title = 'Sending cancelled'
    detail = `${chapters(chaptersSent)} sent before stopping`
  } else if (job.state === 'done' && failed.length > 0) {
    icon = <AlertTriangle className="h-5 w-5 text-amber-500" />
    title = 'Sending finished with errors'
    detail = `${chapters(chaptersSent)} sent, ${failed.length} series failed — see Details`
  } else if (job.state === 'done') {
    icon = <CheckCircle className="h-5 w-5 text-green-500" />
    title = chaptersSent > 0
      ? `Sent ${chapters(chaptersSent)} of ${sent.length} series to the phone`
      : 'Nothing new to send'
    detail = chaptersSent > 0
      ? [formatBytes(bytesSent), phoneLine(job)].filter(Boolean).join(' · ')
      : 'Every chapter is already on the phone or in R2. The phone’s list of done chapters was updated.'
  }

  return (
    <div className="border-t bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      {expanded && (
        <div className="max-h-56 overflow-auto border-b px-6 py-3 space-y-2">
          {job.series.map(s => (
            <div key={s.seriesId} className="text-sm">
              <div className="flex items-center gap-3">
                <span className="w-56 truncate font-medium" title={s.title}>{s.title}</span>
                <span className="flex-1 truncate text-muted-foreground" title={s.folder}>
                  {s.state === 'queued' ? '' : `${s.chaptersSent} of ${chapters(s.chaptersTotal)}`}
                  {s.folder ? ` · ${s.folder}` : ''}
                </span>
                <span
                  className={`w-24 text-right ${
                    s.state === 'failed' ? 'text-destructive'
                      : s.state === 'done' ? 'text-green-500'
                      : 'text-muted-foreground'
                  }`}
                >
                  {SERIES_STATE_LABEL[s.state]}
                </span>
              </div>
              {(s.error || s.note) && (
                <p className={`text-xs break-all ${s.error ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {[s.error, s.note].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="px-6 py-3 space-y-2">
        <div className="flex items-center gap-4">
          <div className="shrink-0">{icon}</div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{title}</p>
            <p className="truncate text-sm text-muted-foreground">{detail}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setExpanded(v => !v)}>
              {expanded ? <ChevronDown className="h-4 w-4 mr-1" /> : <ChevronUp className="h-4 w-4 mr-1" />}
              Details
            </Button>
            {running ? (
              <Button variant="outline" size="sm" onClick={onCancel}>
                Cancel
              </Button>
            ) : (
              <Button size="sm" onClick={onDismiss}>
                Done
              </Button>
            )}
          </div>
        </div>

        {running && !active && stitching?.preparing && (
          <div className="flex items-center gap-3 pl-9 text-sm">
            <Scissors className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="w-20 shrink-0 text-muted-foreground">Stitching</span>
            <Progress value={pct(stitching.preparing.index - 1, stitching.preparing.total)} className="h-2 flex-1" />
            <span className="w-48 shrink-0 text-right text-muted-foreground tabular-nums">
              Chapter {stitching.preparing.index} of {stitching.preparing.total}
            </span>
          </div>
        )}

        {running && active && (
          <div className="flex items-center gap-3 pl-9 text-sm">
            <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="w-20 shrink-0 text-muted-foreground">
              {active.current?.phase === 'uploading' ? 'Uploading' : 'Zipping'}
            </span>
            <Progress value={pct(active.bytesDone, active.bytesTotal)} className="h-2 flex-1" />
            <span className="w-48 shrink-0 text-right text-muted-foreground tabular-nums">
              {formatBytes(active.bytesDone)} / {formatBytes(active.bytesTotal)} · {pct(active.bytesDone, active.bytesTotal)}%
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
