import { useState } from 'react'
import { completionGroup, librarySections, sectionTitle } from '@/lib/librarySections'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { Link } from 'react-router-dom'
import { BookOpen, CheckCircle2, ChevronDown, Circle, Loader2, MoreVertical, Play, Trash2 } from 'lucide-react'
import { SeriesAutomationDialog } from './SeriesAutomationDialog'
import { useProductionJobs } from '@/hooks/useProductionJobs'
import { Button } from './ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu'
import type { Series, ProcessSnapshot, ProcessSeries, ProcessPart, ProcessStage, StageCount, PhoneSyncStatus, ProductionJob } from '@/lib/api'
import { PhoneSyncBadge } from './PhoneSyncBadge'
import { Badge } from './ui/badge'
import { Progress } from './ui/progress'

const STEPS: { title: string; items: { label: string; key: ProcessStage; units?: string }[] }[] = [
  { title: 'Preparation', items: [{ label: 'Download', key: 'download' }, { label: 'Unwanted pages', key: 'cleanup' }, { label: 'Stitch / split', key: 'stitch' }] },
  { title: 'Script generation', items: [{ label: 'English', key: 'script_en' }, { label: 'Hinglish', key: 'script_hi' }] },
  { title: 'Voiceover generation', items: [{ label: 'English · script splits', key: 'split_en', units: 'splits' }, { label: 'English · voiceover', key: 'voice_en', units: 'splits voiced' }, { label: 'Hinglish · script splits', key: 'split_hi', units: 'splits' }, { label: 'Hinglish · voiceover', key: 'voice_hi', units: 'splits voiced' }] },
  { title: 'Voiceover alignment', items: [{ label: 'English', key: 'align_en' }, { label: 'Hinglish', key: 'align_hi' }] },
  { title: 'Image clipping', items: [{ label: 'Crop pointers', key: 'crop_json', units: 'pages' }, { label: 'Review', key: 'review' }, { label: 'Cropping', key: 'crop' }, { label: 'Metadata', key: 'metadata', units: 'pages' }] },
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

type Actions = { onDelete: (series: Series) => void; onMarkPart: (series: Series, part: number, done: boolean) => void }
function Part({ part, active, onMark }: { part: ProcessPart; active: boolean; onMark: (done: boolean) => void }) {
  const both = part.chapters.filter(c => c.stages.export_en.state === 'done' && c.stages.export_hi.state === 'done').length
  return <details className="group/part rounded-lg border bg-background" open={active || undefined}>
    <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
      <ChevronDown className="h-4 w-4 shrink-0 -rotate-90 transition-transform group-open/part:rotate-0" />
      <div className="min-w-0 flex-1"><span className="text-sm font-semibold">Part {part.number}</span><span className="ml-2 text-xs text-muted-foreground">Ch. {part.firstChapter}–{part.lastChapter}</span></div>
      <span className="text-xs text-muted-foreground tabular-nums">{both}/{part.expected} exported in both languages</span>
      {part.complete && <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">{part.manualComplete ? 'Marked done' : 'Completed'}</Badge>}
    </summary>
    <div className="border-t px-4 pb-4 pt-3">
      <div className="mb-3 flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{part.manualComplete ? 'Manually marked done. Stage counters still show the saved work.' : `${part.present} of ${part.expected} chapters added.`}</p><Button size="sm" variant="outline" onClick={() => onMark(!part.manualComplete)}>{part.manualComplete ? 'Undo manual completion' : 'Mark part done'}</Button></div>
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

function SeriesRow({ series, tracker, phoneSync, onDelete, onMarkPart, onRunAutomation, automationJob, expanded }: { expanded: boolean; series: Series; tracker?: ProcessSeries; phoneSync: PhoneSyncStatus | null; onRunAutomation: (series: Series) => void; automationJob?: ProductionJob } & Actions) {
  const current = tracker?.parts.find(p => !p.complete) ?? tracker?.parts.at(-1)
  const exported = tracker?.stages
  const stitching = tracker?.parts.flatMap(p => p.chapters).filter(c => c.stages.stitch.state === 'active').map(c => c.number) ?? []
  return <details className="group/series border-t first:border-t-0" open={expanded || undefined}>
    <summary className="flex cursor-pointer list-none items-center gap-3 p-4 hover:bg-accent/40 [&::-webkit-details-marker]:hidden">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10"><BookOpen className="h-5 w-5 text-primary/60" /></div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><Link to={`/series/${series.id}`} onClick={e => e.stopPropagation()} className="truncate font-semibold hover:underline">{series.title}</Link>{tracker?.completedParts.length ? <Badge variant="secondary">{tracker.completedParts.length} part{tracker.completedParts.length === 1 ? '' : 's'} complete</Badge> : null}{stitching.length > 0 && <Badge variant="secondary" title="Auto stitch is re-cutting these chapters at blank rows before they go to the phone"><Loader2 className="mr-1 h-3 w-3 animate-spin" />Stitching ch. {stitching.join(', ')}</Badge>}{automationJob?.status === 'running' && <Badge variant="secondary"><Loader2 className="mr-1 h-3 w-3 animate-spin" />Automation running</Badge>}{automationJob?.status === 'review' && <Badge variant="outline">Ready for review</Badge>}</div>
        <p className="mt-1 text-xs text-muted-foreground">{series.chapterCount ?? 0} chapters · {current ? `Part ${current.number} · chapters ${current.firstChapter}–${current.lastChapter}` : 'Waiting for chapters'}</p>
        {current && <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          {(['stitch', 'script_en', 'voice_en', 'align_en', 'crop', 'export_en'] as ProcessStage[]).map((key, i) => <span key={key} className={`inline-flex items-center gap-1 ${current.stages[key].done === current.expected ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>{current.stages[key].active > 0 && <Loader2 className="h-3 w-3 animate-spin" />}{['Prepared', 'Scripts EN', 'Voice EN', 'Aligned EN', 'Cropped', 'Exported EN'][i]} {current.stages[key].done}/{current.expected}</span>)}
          <span>Exported Hinglish {current.stages.export_hi.done}/{current.expected}</span>
        </div>}
      </div>
      <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label={`Actions for ${series.title}`} onClick={e => e.stopPropagation()}><MoreVertical className="h-4 w-4" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={e => e.stopPropagation()}>
          <DropdownMenuItem onSelect={() => onMarkPart(series, 1, !tracker?.parts.find(p => p.number === 1)?.manualComplete)}>{tracker?.parts.find(p => p.number === 1)?.manualComplete ? 'Undo Part 1 completion' : 'Mark Part 1 done'}</DropdownMenuItem>
          <DropdownMenuSeparator /><DropdownMenuItem className="text-destructive" onSelect={() => onDelete(series)}><Trash2 className="mr-2 h-4 w-4" />Delete series everywhere…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="hidden shrink-0 space-y-1 text-right text-xs text-muted-foreground sm:block">
        {exported && <p>Exports · EN {exported.export_en.done}/{exported.export_en.total} · Hinglish {exported.export_hi.done}/{exported.export_hi.total}</p>}
        {phoneSync?.series[series.id] && <PhoneSyncBadge sync={phoneSync.series[series.id]} device={phoneSync.device} />}
      </div>
      <ChevronDown className="h-4 w-4 shrink-0 -rotate-90 text-muted-foreground transition-transform group-open/series:rotate-0" />
    </summary>
    <div className="space-y-3 bg-muted/20 px-4 pb-4 pt-1">
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
        <h3 className="text-sm font-semibold">Production process</h3>
        <Button size="sm" onClick={() => onRunAutomation(series)}>{automationJob?.status === 'running' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}{automationJob?.status === 'running' ? 'View automation' : 'Run Sleeper-Cell automation'}</Button>
      </div>
      <p className="text-xs text-muted-foreground">Each counter shows completed chapters. Parts complete after exports in both languages, or when you mark them done.</p>
      {tracker ? tracker.parts.length ? tracker.parts.map(p => <Part key={p.number} part={p} active={p.number === current?.number} onMark={done => onMarkPart(series, p.number, done)} />) : <p className="py-3 text-sm text-muted-foreground">No chapters added yet.</p> : <p className="py-3 text-sm text-muted-foreground">Checking process status…</p>}
    </div>
  </details>
}

export function SeriesProcessTracker({ series, progress, phoneSync, ...actions }: { series: Series[]; progress: ProcessSnapshot | null; phoneSync: PhoneSyncStatus | null } & Actions) {
  const [automationSeries, setAutomationSeries] = useState<Series | null>(null)
  const jobs = useProductionJobs()
  const [overrides, setOverrides] = useState<Record<number, boolean>>({})
  const byId = new Map(progress?.series.map(s => [s.seriesId, s]))
  const sections = librarySections(series, byId, new Set([...jobs.values()].filter(job => job.status === 'running').map(job => job.seriesId)))
  const latestId = series[0]?.id
  const latestGroup = completionGroup(byId.get(latestId))
  return <><div className="space-y-4">{sections.map(section => {
    const open = overrides[section.completed] ?? section.completed === latestGroup
    return <Collapsible key={section.completed} open={open} onOpenChange={value => setOverrides(previous => ({ ...previous, [section.completed]: value }))} className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full items-center gap-3 p-4 text-left hover:bg-accent/40">
          <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`} />
          <span className="flex-1 font-semibold">{sectionTitle(section.completed)}</span>
          <span className="text-xs text-muted-foreground">{section.series.length} series · {section.processing ? `${section.processing} processing` : 'No active processing'}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t">
        {section.series.map(s => <SeriesRow key={s.id} series={s} expanded={s.id === latestId} tracker={byId.get(s.id)} phoneSync={phoneSync} onRunAutomation={setAutomationSeries} automationJob={jobs.get(s.id)} {...actions} />)}
      </CollapsibleContent>
    </Collapsible>
  })}</div>
    {automationSeries && <SeriesAutomationDialog series={automationSeries} onClose={() => setAutomationSeries(null)} />}
  </>
}
