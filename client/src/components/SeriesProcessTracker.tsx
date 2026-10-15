import { Link } from 'react-router-dom'
import { BookOpen, CheckCircle2, ChevronDown, Circle, Loader2 } from 'lucide-react'
import type { Series, ProcessSnapshot, ProcessSeries, ProcessPart, ProcessStage, StageCount, PhoneSyncStatus } from '@/lib/api'
import { PhoneSyncBadge } from './PhoneSyncBadge'
import { Badge } from './ui/badge'
import { Progress } from './ui/progress'

const STEPS: { title: string; items: { label: string; key: ProcessStage; units?: string }[] }[] = [
  { title: 'Preparation', items: [{ label: 'Download', key: 'download' }, { label: 'Unwanted pages', key: 'cleanup' }, { label: 'Stitch / split', key: 'stitch' }] },
  { title: 'Script generation', items: [{ label: 'English', key: 'script_en' }, { label: 'Hinglish', key: 'script_hi' }] },
  { title: 'Voiceover generation', items: [{ label: 'English · script splits', key: 'split_en', units: 'splits' }, { label: 'English · voiceover', key: 'voice_en', units: 'splits voiced' }, { label: 'Hinglish · script splits', key: 'split_hi', units: 'splits' }, { label: 'Hinglish · voiceover', key: 'voice_hi', units: 'splits voiced' }] },
  { title: 'Voiceover alignment', items: [{ label: 'English', key: 'align_en' }, { label: 'Hinglish', key: 'align_hi' }] },
  { title: 'Image clipping', items: [{ label: 'JSON generation', key: 'crop_json', units: 'pages' }, { label: 'Review', key: 'review' }, { label: 'Cropping', key: 'crop' }] },
  { title: 'Editor 2.0', items: [{ label: 'English · timeline', key: 'timeline_en' }, { label: 'English · processed', key: 'processed_en' }, { label: 'English · exported', key: 'export_en' }, { label: 'Hinglish · timeline', key: 'timeline_hi' }, { label: 'Hinglish · processed', key: 'processed_hi' }, { label: 'Hinglish · exported', key: 'export_hi' }] }
]

function Count({ value, units }: { value: StageCount; units?: string }) {
  const done = value.total > 0 && value.done === value.total
  const Icon = done ? CheckCircle2 : value.active ? Loader2 : Circle
  return <span className={`inline-flex flex-col items-end gap-0.5 ${done ? 'text-emerald-600 dark:text-emerald-400' : value.attention ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
    <span className="inline-flex items-center gap-1.5 tabular-nums text-xs font-medium" title={`${value.done} of ${value.total} chapters complete${value.attention ? ` · ${value.attention} need attention` : ''}`}>
      <Icon className={`h-3.5 w-3.5 ${value.active ? 'animate-spin' : ''}`} />{value.done}/{value.total}
      {value.attention > 0 && <span className="text-[10px]">· {value.attention} to check</span>}
    </span>
    {units && value.unitsTotal > 0 && <span className="text-[10px] text-muted-foreground tabular-nums">{units === 'splits' ? `${value.unitsTotal} splits` : `${value.unitsDone}/${value.unitsTotal} ${units}`}</span>}
  </span>
}

function Part({ part, active }: { part: ProcessPart; active: boolean }) {
  const both = part.chapters.filter(c => c.stages.export_en.state === 'done' && c.stages.export_hi.state === 'done').length
  return <details className="group/part rounded-lg border bg-background" open={active || undefined}>
    <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
      <ChevronDown className="h-4 w-4 shrink-0 -rotate-90 transition-transform group-open/part:rotate-0" />
      <div className="min-w-0 flex-1"><span className="text-sm font-semibold">Part {part.number}</span><span className="ml-2 text-xs text-muted-foreground">Ch. {part.firstChapter}–{part.lastChapter}</span></div>
      <span className="text-xs text-muted-foreground tabular-nums">{both}/{part.expected} exported in both languages</span>
      {part.complete && <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">Completed</Badge>}
    </summary>
    <div className="border-t px-4 pb-4 pt-3">
      {part.present < 20 && <p className="mb-3 text-xs text-muted-foreground">{part.present} of 20 chapters added. The remaining chapters keep this part in progress.</p>}
      <Progress value={both * 100 / part.expected} className="mb-4 h-1" />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {STEPS.map((step, index) => <div key={step.title} className="rounded-md border p-3">
          <h4 className="mb-3 text-xs font-semibold"><span className="mr-2 text-muted-foreground">{index + 1}.</span>{step.title}</h4>
          <div className="space-y-2.5">{step.items.map(item => <div key={item.key} className="flex items-start justify-between gap-3 text-xs"><span className="pt-0.5 text-muted-foreground">{item.label}</span><Count value={part.stages[item.key]} units={item.units} /></div>)}</div>
        </div>)}
      </div>
    </div>
  </details>
}

function SeriesRow({ series, tracker, phoneSync }: { series: Series; tracker?: ProcessSeries; phoneSync: PhoneSyncStatus | null }) {
  const current = tracker?.parts.find(p => !p.complete) ?? tracker?.parts.at(-1)
  const exported = tracker?.stages
  return <details className="group/series border-t first:border-t-0">
    <summary className="flex cursor-pointer list-none items-center gap-3 p-4 hover:bg-accent/40 [&::-webkit-details-marker]:hidden">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10"><BookOpen className="h-5 w-5 text-primary/60" /></div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><Link to={`/series/${series.id}`} onClick={e => e.stopPropagation()} className="truncate font-semibold hover:underline">{series.title}</Link>{tracker?.completedParts.length ? <Badge variant="secondary">{tracker.completedParts.length} part{tracker.completedParts.length === 1 ? '' : 's'} complete</Badge> : null}</div>
        <p className="mt-1 text-xs text-muted-foreground">{series.chapterCount ?? 0} chapters · {current ? `Part ${current.number} · chapters ${current.firstChapter}–${current.lastChapter}` : 'Waiting for chapters'}</p>
        {current && <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          {(['stitch', 'script_en', 'voice_en', 'align_en', 'crop', 'export_en'] as ProcessStage[]).map((key, i) => <span key={key} className={current.stages[key].done === current.expected ? 'text-emerald-600 dark:text-emerald-400' : ''}>{['Prepared', 'Scripts EN', 'Voice EN', 'Aligned EN', 'Cropped', 'Exported EN'][i]} {current.stages[key].done}/{current.expected}</span>)}
          <span>Exported Hinglish {current.stages.export_hi.done}/{current.expected}</span>
        </div>}
      </div>
      <div className="hidden shrink-0 space-y-1 text-right text-xs text-muted-foreground sm:block">
        {exported && <p>Exports · EN {exported.export_en.done}/{exported.export_en.total} · Hinglish {exported.export_hi.done}/{exported.export_hi.total}</p>}
        {phoneSync?.series[series.id] && <PhoneSyncBadge sync={phoneSync.series[series.id]} device={phoneSync.device} />}
      </div>
      <ChevronDown className="h-4 w-4 shrink-0 -rotate-90 text-muted-foreground transition-transform group-open/series:rotate-0" />
    </summary>
    <div className="space-y-3 bg-muted/20 px-4 pb-4 pt-1">
      <p className="text-xs text-muted-foreground">Each counter shows completed chapters. A part completes after all 20 chapters are exported in English and Hinglish.</p>
      {tracker ? tracker.parts.length ? tracker.parts.map(p => <Part key={p.number} part={p} active={p.number === current?.number} />) : <p className="py-3 text-sm text-muted-foreground">No chapters added yet.</p> : <p className="py-3 text-sm text-muted-foreground">Checking process status…</p>}
    </div>
  </details>
}

export function SeriesProcessTracker({ series, progress, phoneSync }: { series: Series[]; progress: ProcessSnapshot | null; phoneSync: PhoneSyncStatus | null }) {
  const byId = new Map(progress?.series.map(s => [s.seriesId, s]))
  const groups = new Map<number, Series[]>()
  for (const s of series) {
    const key = byId.get(s.id)?.completedThrough ?? (progress ? 0 : -1)
    groups.set(key, [...(groups.get(key) ?? []), s])
  }
  return <div className="space-y-4">{[...groups].sort(([a], [b]) => a - b).map(([completed, rows]) => <details key={completed} className="group/section overflow-hidden rounded-xl border bg-card shadow-sm" open={completed <= 0 || undefined}>
    <summary className="flex cursor-pointer list-none items-center gap-3 bg-muted/30 px-4 py-4 [&::-webkit-details-marker]:hidden">
      <ChevronDown className="h-4 w-4 -rotate-90 transition-transform group-open/section:rotate-0" />
      <h2 className="flex-1 text-sm font-semibold">{completed < 0 ? 'Checking process status' : completed === 0 ? 'No parts completed' : `Part ${completed} completed`}</h2>
      {completed > 1 && <span className="text-xs text-muted-foreground">Parts 1–{completed} complete</span>}
      <Badge variant="secondary">{rows.length} series</Badge>
    </summary>
    <div>{rows.map(s => <SeriesRow key={s.id} series={s} tracker={byId.get(s.id)} phoneSync={phoneSync} />)}</div>
  </details>)}</div>
}
