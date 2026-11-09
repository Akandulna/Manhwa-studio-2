/**
 * Shared pieces for the AntiGravity screens (docs/PRD-antigravity-studio.md §6).
 *
 * Every status shown here comes from the existing Clipper 3.0 endpoints
 * (series, chapters, per-chapter summary, per-page status), so a page that
 * Clipper calls Done is Done here too, whoever produced it. Part membership
 * reuses lib/clipperParts (20 chapters per part).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Activity, ChevronRight, Library, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  antigravityApi,
  antigravityJobsApi,
  clipper3Api,
  codexApi,
  ENGINE_LABELS,
  googleDriveApi,
  type AiEngine,
  type AntigravityConnection,
  type AntigravityCurrentProcess,
  type CodexConnection,
  type Clipper3Chapter,
  type Clipper3ChapterSummary,
  type Clipper3Series,
  type DriveStatus
} from '@/lib/api'
import { CLIPPER_PART_SIZE, clipperChapterParts } from '@/lib/clipperParts'
import { useSocket } from '@/lib/socket'

export function Breadcrumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
      {items.map((item, i) => (
        <span key={`${item.label}-${i}`} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="h-4 w-4" aria-hidden />}
          {item.to ? <Link to={item.to} className="hover:text-foreground">{item.label}</Link> : <span className="text-foreground" aria-current="page">{item.label}</span>}
        </span>
      ))}
    </nav>
  )
}

/** Where Settings → AntiGravity lives; the page sends the place it was opened from in location state. */
export const ANTIGRAVITY_SETTINGS_PATH = '/settings?tab=antigravity'
export interface SettingsReturnState { from: string; fromLabel: string }

/**
 * The bar on every AntiGravity page: Library | Running processes tabs, the
 * Settings shortcut (which remembers this page so Settings can come back to
 * it), then the breadcrumbs.
 */
const LAST_LIBRARY_PAGE = 'antigravity:lastLibraryPage'

/** The last Library-side AntiGravity page this window showed (series list when none). */
export function lastLibraryPage(): string {
  try { return sessionStorage.getItem(LAST_LIBRARY_PAGE) || '/antigravity' } catch { return '/antigravity' }
}

/** Where a run was started from: its part's Image Clipper, Metadata or Timeline page. */
export const runOriginPath = (run: { seriesId: string; partNumber: number; kind?: string }) =>
  `/antigravity/series/${run.seriesId}/parts/${run.partNumber}/${run.kind === 'metadata' ? 'metadata' : run.kind === 'editor' ? 'timeline' : 'image-clipper'}`

/** "Image Clipper" / "Metadata" / "Timeline" for a run or job. */
export const kindLabel = (kind?: string | null) => (kind === 'metadata' ? 'Metadata' : kind === 'editor' ? 'Timeline' : 'Image Clipper')

/** A Timeline job's "page" (timeline-en / timeline-hi) as its language, else the filename. */
export const jobUnitLabel = (job: { filename: string; kind?: string | null }) =>
  job.kind === 'editor' ? (job.filename === 'timeline-hi' ? 'Hindi timeline' : job.filename === 'timeline-en' ? 'English timeline' : job.filename) : job.filename

/**
 * `libraryTo` overrides where the Library tab goes (Running processes sends
 * it back to the page the selected run was started from); otherwise it
 * returns to the last Library page shown.
 */
export function AntiGravityTopBar({ crumbs, tab = 'library', libraryTo }: { crumbs: { label: string; to?: string }[]; tab?: 'library' | 'runs'; libraryTo?: string }) {
  const location = useLocation()
  const here = `${location.pathname}${location.search}`
  useEffect(() => {
    if (tab !== 'library') return
    try { sessionStorage.setItem(LAST_LIBRARY_PAGE, here) } catch { /* private mode */ }
  }, [tab, here])
  const libraryLink = tab === 'library' ? '/antigravity' : libraryTo ?? lastLibraryPage()
  const back: SettingsReturnState = {
    from: here,
    fromLabel: crumbs.length > 1 ? crumbs.slice(1).map(c => c.label).join(' › ') : crumbs[0]?.label ?? 'AntiGravity'
  }
  const tabClass = (on: boolean) => cn(
    'flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
    on ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
  )
  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3 border-b">
        <nav aria-label="AntiGravity" className="-mb-px flex">
          <Link to={libraryLink} className={tabClass(tab === 'library')} aria-current={tab === 'library' ? 'page' : undefined}><Library className="h-4 w-4" /> Library</Link>
          <Link to="/antigravity/runs" className={tabClass(tab === 'runs')} aria-current={tab === 'runs' ? 'page' : undefined}><Activity className="h-4 w-4" /> Running processes</Link>
        </nav>
        <Button asChild variant="ghost" size="sm" className="mb-1">
          <Link to={ANTIGRAVITY_SETTINGS_PATH} state={back}><Settings className="mr-1.5 h-4 w-4" /> Settings</Link>
        </Button>
      </div>
      <Breadcrumbs items={crumbs} />
    </div>
  )
}

/** "4.2 s", "1 m 07 s", "1 h 02 m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} m ${String(Math.round(s % 60)).padStart(2, '0')} s`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`
}

/**
 * AI processing time of one attempt: from the moment the page entered
 * analysis (slicing and the Drive upload are already done by then) until the
 * reviewed result was accepted or the attempt ended. Null when not started;
 * `running` while still in flight (timed against `now`).
 */
export function attemptDuration(attempt: { startedAt: string; finishedAt: string | null; status: string } | null | undefined, now: number) {
  if (!attempt) return null
  const start = Date.parse(attempt.startedAt)
  if (Number.isNaN(start)) return null
  const running = !attempt.finishedAt && attempt.status === 'active'
  const end = attempt.finishedAt ? Date.parse(attempt.finishedAt) : running ? now : NaN
  if (Number.isNaN(end)) return null
  return { ms: end - start, running }
}

/** A clock that ticks every second only while something is running. */
export function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** Run controls that hold the single process slot (mirrors the server's LIVE_CONTROLS). */
export const LIVE_PROCESS = new Set(['running', 'preparing', 'pause_requested', 'paused', 'stop_requested'])

/**
 * The one AntiGravity process (the live run, else the most recent one), re-read on local progress
 * events only (no R2 traffic). `reload` after Start / Pause / Stop.
 */
export function useCurrentProcess() {
  const { socket } = useSocket()
  const [current, setCurrent] = useState<AntigravityCurrentProcess | null>(null)
  const reload = useCallback(() => { antigravityJobsApi.current().then(setCurrent).catch(() => { /* keep what is shown */ }) }, [])
  useEffect(() => { reload() }, [reload])
  useEffect(() => {
    if (!socket) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const onProgress = () => { if (!timer) timer = setTimeout(() => { timer = null; reload() }, 1000) }
    socket.on('antigravity:progress', onProgress)
    return () => { socket.off('antigravity:progress', onProgress); if (timer) clearTimeout(timer) }
  }, [socket, reload])
  return { current, reload }
}

export const partRange =(part: number) => ({ first: (part - 1) * CLIPPER_PART_SIZE + 1, last: part * CLIPPER_PART_SIZE })

export const chapterLabel = (chapter: Pick<Clipper3Chapter, 'number' | 'title'>) =>
  `Chapter ${chapter.number}${chapter.title && chapter.title !== String(chapter.number) ? ` — ${chapter.title}` : ''}`

export interface SeriesScope {
  loading: boolean
  error: string | null
  series: Clipper3Series | null
  chapters: Clipper3Chapter[]
  summaries: Map<string, Clipper3ChapterSummary>
  parts: { number: number; chapters: Clipper3Chapter[] }[]
  reload: () => void
}

/**
 * One series' downloaded chapters, Clipper summaries and parts, rebuilt from
 * persistent data (deep links work). `reload()` refreshes in the background:
 * the current lists stay on screen until the new ones arrive, so live
 * progress never blanks the page.
 */
export function useSeriesScope(seriesId: string | undefined): SeriesScope {
  const [state, setState] = useState<Omit<SeriesScope, 'reload' | 'parts'>>({ loading: true, error: null, series: null, chapters: [], summaries: new Map() })
  const [tick, setTick] = useState(0)
  const loadedFor = useRef<string | null>(null)
  const reload = useCallback(() => setTick(t => t + 1), [])
  useEffect(() => {
    if (!seriesId) return
    let cancelled = false
    // Only a different series shows the loading state; a refresh of the same one is silent.
    const quiet = loadedFor.current === seriesId
    if (!quiet) setState(s => ({ ...s, loading: true, error: null }))
    Promise.all([clipper3Api.getSeries(), clipper3Api.getChapters(), clipper3Api.getSeriesSummary(seriesId).catch(() => ({ chapters: [] }))])
      .then(([allSeries, allChapters, summary]) => {
        if (cancelled) return
        loadedFor.current = seriesId
        setState({
          loading: false,
          error: null,
          series: allSeries.find(s => s.id === seriesId) ?? null,
          chapters: allChapters.filter(c => c.seriesId === seriesId).sort((a, b) => a.number - b.number),
          summaries: new Map(summary.chapters.map(c => [c.chapterId, c]))
        })
      })
      .catch(error => { if (!cancelled && !quiet) setState(s => ({ ...s, loading: false, error: (error as Error).message })) })
    return () => { cancelled = true }
  }, [seriesId, tick])
  const parts = useMemo(() => clipperChapterParts(state.chapters), [state.chapters])
  return { ...state, parts, reload }
}

export function pointerTotals(chapters: Clipper3Chapter[], summaries: Map<string, Clipper3ChapterSummary>) {
  let done = 0
  let total = 0
  for (const chapter of chapters) {
    const s = summaries.get(chapter.id)
    done += s?.attachedImages ?? 0
    total += s?.totalImages ?? chapter.pageCount
  }
  return { done, total }
}

export interface Readiness {
  drive: DriveStatus | null
  antigravity: AntigravityConnection | null
  codex: CodexConnection | null
  /** The engine new runs use (Settings → AntiGravity → AI engine). */
  engine: AiEngine
  engineLabel: string
  /** The selected model of that engine, for display. */
  modelLabel: string | null
  effort: string | null
  concurrency: number
  /** Specific reasons processing cannot start yet. */
  startBlockers: string[]
  /** Specific reasons preparation (slice + upload) cannot run yet. */
  prepareBlockers: string[]
  /** Why Metadata cannot start (engine and model only: Metadata needs neither Drive nor R2). */
  metadataBlockers: string[]
  /** Why Timeline cannot start (engine and model only: it is text, saved in Editor 2.0). */
  editorBlockers: string[]
}

/** What Prepare / Start need, with the exact missing piece named (PRD §6.5). */
export function useReadiness(): Readiness {
  const [drive, setDrive] = useState<DriveStatus | null>(null)
  const [antigravity, setAntigravity] = useState<AntigravityConnection | null>(null)
  const [codex, setCodex] = useState<CodexConnection | null>(null)
  const [r2, setR2] = useState<boolean | null>(null)
  useEffect(() => {
    googleDriveApi.status().then(setDrive).catch(() => setDrive(null))
    antigravityApi.connection().then(conn => {
      setAntigravity(conn)
      if (conn.settings.engine === 'codex') codexApi.connection().then(setCodex).catch(() => setCodex(null))
    }).catch(() => setAntigravity(null))
    antigravityJobsApi.r2Status().then(s => setR2(s.configured)).catch(() => setR2(null))
  }, [])
  const prepareBlockers: string[] = []
  if (!drive || drive.state !== 'connected') prepareBlockers.push(drive?.state === 'reconnect_required' ? 'Reconnect Google Drive in Settings.' : 'Connect Google Drive in Settings.')
  else if (drive.root?.state === 'missing') prepareBlockers.push('Repair the Manhwa Studio folder in Settings.')
  const engineBlockers: string[] = []
  const engine: AiEngine = antigravity?.settings.engine ?? 'antigravity'
  if (engine === 'codex') {
    if (!codex) engineBlockers.push('Checking ChatGPT (Codex)…')
    else if (!codex.installation.path) engineBlockers.push('Install the ChatGPT desktop app (it includes the Codex CLI).')
    else if (codex.account && !codex.account.signedIn) engineBlockers.push('Sign in to Codex with ChatGPT (Plus or above) in Settings → AntiGravity.')
    else if (!codex.settings.model) engineBlockers.push('Choose a Codex model in Settings → AntiGravity.')
    else if (!codex.proofValid) engineBlockers.push(codex.proofNote ?? 'Run the Codex compatibility test in Settings → AntiGravity.')
  } else if (!antigravity?.installation.path) engineBlockers.push('Install the Antigravity CLI.')
  else if (!antigravity.settings.model) engineBlockers.push('Choose a model in Settings.')
  else if (!antigravity.proofValid) engineBlockers.push(antigravity.proofNote ?? 'Run the compatibility test in Settings.')
  const startBlockers = [...prepareBlockers, ...engineBlockers]
  if (r2 === false) startBlockers.push('Set up Cloudflare R2 (Settings → Cloudflare): results are published there for phones.')
  const metadataBlockers = [...engineBlockers]
  // Same rule as Settings' model picker (LocalAntigravityCard TEXT_ONLY): Metadata has to see the crops.
  if (engine === 'antigravity' && /^gpt-oss/i.test(antigravity?.settings.model ?? '')) metadataBlockers.push(`${antigravity?.settings.modelLabel ?? antigravity?.settings.model} has no image input: choose a vision model in Settings → AntiGravity.`)
  const selected = engine === 'codex' ? codex?.settings : antigravity?.settings
  return {
    drive, antigravity, codex, engine, engineLabel: ENGINE_LABELS[engine],
    modelLabel: selected?.modelLabel ?? selected?.model ?? null, effort: engine === 'codex' ? codex?.settings.effort ?? null : null,
    concurrency: antigravity?.settings.concurrency ?? 1, startBlockers, prepareBlockers, metadataBlockers, editorBlockers: [...engineBlockers]
  }
}
