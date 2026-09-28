import { useState } from 'react'
import type { R2UploadJob, R2SeriesProgress } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { formatBytes } from '@/lib/utils'
import { AlertTriangle, CheckCircle, ChevronDown, ChevronUp, UploadCloud, Loader2, XCircle } from 'lucide-react'

interface Props {
  job: R2UploadJob
  onCancel: () => void
  onDismiss: () => void
}

const SERIES_STATE_LABEL: Record<R2SeriesProgress['state'], string> = {
  queued: 'Queued',
  zipping: 'Zipping…',
  uploading: 'Uploading…',
  done: 'Uploaded',
  skipped: 'Skipped',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

function pct(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
}

function chapterSummary(s: R2SeriesProgress): string {
  const parts = [`${s.chaptersIncluded} chapter${s.chaptersIncluded === 1 ? '' : 's'}`]
  if (s.chaptersPublished > 0) parts.push(`${s.chaptersPublished} published left out`)
  return parts.join(' · ')
}

/** One labelled bar: "Zipping ▓▓▓░░ 120 MB / 300 MB · 40%". */
function PhaseBar({ label, done, total, active, waiting }: {
  label: string
  done: number
  total: number
  active: boolean
  waiting?: string
}) {
  const value = pct(done, total)
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className={`w-20 shrink-0 ${active ? 'font-medium' : 'text-muted-foreground'}`}>{label}</span>
      <Progress value={value} className={`h-2 flex-1 ${active ? '' : 'opacity-60'}`} />
      <span className="w-48 shrink-0 text-right text-muted-foreground tabular-nums">
        {waiting ?? `${formatBytes(done)} / ${formatBytes(total)} · ${value}%`}
      </span>
    </div>
  )
}

/**
 * Bottom bar for the Library's R2 backup. While running it shows the current
 * series' two phases — zipping, then uploading — and once finished the outcome
 * with a Done button. The job is server-side, so this reappears in the right
 * state after navigating away and back.
 */
export function R2UploadStatusBar({ job, onCancel, onDismiss }: Props) {
  const [expanded, setExpanded] = useState(false)

  const running = job.state === 'running'
  const total = job.series.length
  const uploaded = job.series.filter(s => s.state === 'done')
  const skipped = job.series.filter(s => s.state === 'skipped')
  const failed = job.series.filter(s => s.state === 'failed')
  const activeIndex = job.series.findIndex(s => s.state === 'zipping' || s.state === 'uploading')
  const active = activeIndex >= 0 ? job.series[activeIndex] : null
  const uploadedBytes = uploaded.reduce((sum, s) => sum + s.uploadBytesTotal, 0)

  let icon = <Loader2 className="h-5 w-5 animate-spin text-primary" />
  let title = `Backing up to R2 · ${job.bucket}`
  let detail = active
    ? `Series ${activeIndex + 1} of ${total} · ${active.title} — ${chapterSummary(active)}`
    : 'Preparing…'

  if (job.state === 'cancelled') {
    icon = <XCircle className="h-5 w-5 text-muted-foreground" />
    title = 'Backup cancelled'
    detail = `${uploaded.length} of ${total} series uploaded before stopping`
  } else if (job.state === 'done' && failed.length > 0) {
    icon = <AlertTriangle className="h-5 w-5 text-amber-500" />
    title = 'Backup finished with errors'
    detail = `${uploaded.length} uploaded, ${failed.length} failed${skipped.length ? `, ${skipped.length} skipped` : ''} — see Details`
  } else if (job.state === 'done') {
    icon = <CheckCircle className="h-5 w-5 text-green-500" />
    title = uploaded.length > 0
      ? `Upload complete · ${uploaded.length} series to ${job.bucket}`
      : 'Nothing was uploaded'
    detail = [
      uploaded.length > 0 && `${formatBytes(uploadedBytes)} uploaded`,
      skipped.length > 0 && `${skipped.length} skipped (no unpublished chapters)`
    ].filter(Boolean).join(' · ') || 'No series had chapters to back up'
  }

  return (
    <div className="border-t bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      {expanded && (
        <div className="max-h-56 overflow-auto border-b px-6 py-3 space-y-2">
          {job.series.map(s => (
            <div key={s.seriesId} className="text-sm">
              <div className="flex items-center gap-3">
                <span className="w-56 truncate font-medium" title={s.title}>{s.title}</span>
                <span className="flex-1 truncate text-muted-foreground">
                  {s.state === 'queued' ? '' : chapterSummary(s)}
                  {s.state === 'done' && s.key ? ` · ${s.key} (${formatBytes(s.uploadBytesTotal)})` : ''}
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
                  {s.error || s.note}
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

        {running && active && (
          <div className="space-y-1.5 pl-9">
            <PhaseBar
              label="Zipping"
              done={active.zipBytesDone}
              total={active.zipBytesTotal}
              active={active.state === 'zipping'}
            />
            <PhaseBar
              label="Uploading"
              done={active.uploadBytesDone}
              total={active.uploadBytesTotal}
              active={active.state === 'uploading'}
              waiting={active.state === 'zipping' ? 'Waiting for zip…' : undefined}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/** Shown above the status bar while picking series to upload. */
export function R2SelectionBar({
  count,
  total,
  busy,
  storage,
  onToggleAll,
  onCancel,
  onUpload
}: {
  count: number
  total: number
  busy: boolean
  /** Bucket bytes vs the free plan, when known. */
  storage: { used: number; limit: number } | null
  onToggleAll: () => void
  onCancel: () => void
  onUpload: () => void
}) {
  return (
    <div className="border-t bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <div className="flex items-center gap-3 px-6 py-3">
        <UploadCloud className="h-5 w-5 text-primary" />
        <div className="flex-1 min-w-0">
          <p className="text-sm">
            <span className="font-medium">{count}</span> of {total} series selected for upload to Cloudflare R2
          </p>
          <p className="text-xs text-muted-foreground">
            Each series is zipped and uploaded. Published chapters are left out.
            {storage && (
              <> · R2 storage {(storage.used / 1000 ** 3).toFixed(2)} of {(storage.limit / 1000 ** 3).toFixed(0)} GB free plan
                used — uploads that would exceed it are blocked.</>
            )}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onToggleAll}>
          {count === total ? 'Deselect All' : 'Select All'}
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={onUpload} disabled={count === 0 || busy}>
          {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UploadCloud className="h-4 w-4 mr-2" />}
          Upload {count} Series
        </Button>
      </div>
    </div>
  )
}
