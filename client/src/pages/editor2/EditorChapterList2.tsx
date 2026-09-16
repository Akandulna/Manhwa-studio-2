/**
 * EditorChapterList2 — Module 4v2: Editor 2.0
 *
 * Phase 1: a series' chapters with their 4-gate readiness (script, section
 * audio, Image Clipper 3.0 crops, script with timeline). Ready chapters are
 * not yet clickable — the compile/timeline workspace is a later phase.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  seriesApi,
  videoApi2,
  type Editable2Chapter,
  type Export2Job,
  type Exported2Chapter
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import {
  ArrowLeft,
  Clapperboard,
  Loader2,
  AlertTriangle,
  Scissors,
  Mic,
  ScrollText,
  Clock,
  CheckCircle2,
  Copy,
  Check,
  ClipboardPaste,
  Play,
  Eye,
  X,
  Film,
  Ban,
  ChevronRight,
  Coffee,
  Moon
} from 'lucide-react'

import { useWakeLock } from '@/hooks/useWakeLock'
import {
  clearTimeline,
  collectProcessed,
  getExpanded,
  getScrollTop,
  getTimelineJson,
  isProcessed,
  saveExpanded,
  saveScrollTop,
  setTimelineJson
} from './timelineHandoff'

/**
 * Where the Editor 2.0 prompt lives (Settings → Editor 2.0 → Prompt).
 *
 * localStorage, not the server settings table: that Settings card saves the
 * prompt to this browser only, the same way the Crop 3.0 documents do, so
 * this is the only place a saved prompt can actually be found.
 */
const CHAPTER_PROMPT_KEY = 'editor2.prompt'

/** The saved Editor 2.0 prompt, or '' when nothing has been saved here. */
function readSavedPrompt(): string {
  try {
    const raw = localStorage.getItem(CHAPTER_PROMPT_KEY)
    if (!raw) return ''
    const parsed = JSON.parse(raw) as { content?: unknown }
    return typeof parsed.content === 'string' ? parsed.content.trim() : ''
  } catch {
    // Unavailable or corrupt storage just means there is no prompt to add.
    return ''
  }
}

/** An export's size, for the Exported tooltip. */
function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** When an export was written, relative — "3h ago" reads faster than a date. */
function formatWhen(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(ms).toLocaleDateString()
}

/**
 * One of the four readiness gates, as a single icon.
 *
 * The list shows four of these per row, so they carry their meaning in the
 * tooltip rather than a visible label — a row has to stay one line tall.
 */
function GateDot({ ok, icon, label }: { ok: boolean; icon: React.ReactNode; label: string }) {
  return (
    <span
      className={ok ? 'text-green-600' : 'text-muted-foreground/30'}
      title={`${label}: ${ok ? 'ready' : 'missing'}`}
    >
      {icon}
    </span>
  )
}

export default function EditorChapterList2() {
  const { seriesId } = useParams<{ seriesId: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()

  const [seriesTitle, setSeriesTitle] = useState('')
  const [chapters, setChapters] = useState<Editable2Chapter[]>([])
  const [loading, setLoading] = useState(true)

  // Keyed by chapter id so each card's button tracks its own state and two
  // chapters' buttons never share a spinner.
  const [copying, setCopying] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // Pasted clipboard content per chapter. A chapter's entry exists only once
  // something has actually been pasted, which is what gates Start Processing.
  const [pasted, setPasted] = useState<Record<string, string>>({})
  const [pasting, setPasting] = useState<string | null>(null)

  // Bumped to re-read the "already processed" markers, which live in
  // localStorage and change while the preview screen is open.
  const [processedTick, setProcessedTick] = useState(0)

  // The running batch export, polled while it renders. Null when idle.
  const [exportJob, setExportJob] = useState<Export2Job | null>(null)
  const [starting, setStarting] = useState(false)

  // Chapters that already have an MP4 on disk, keyed by chapter id. Server
  // truth rather than a local flag: the record is the series' _video2 folder,
  // so this survives a cleared browser and is right on a second machine.
  const [exported, setExported] = useState<Record<string, Exported2Chapter>>({})

  // Which chapter's detail is open. Only one at a time: the list is the view,
  // and the detail is what you drop into for the chapter you are working on.
  const [expanded, setExpanded] = useState<string | null>(() =>
    seriesId ? getExpanded(seriesId) : null
  )

  // The ScrollArea's viewport, so the scroll offset can be saved on the way
  // out and restored on the way back.
  const scrollRootRef = useRef<HTMLDivElement | null>(null)

  /**
   * The scrolling element. A plain overflow container rather than the shared
   * ScrollArea: Radix wraps its content in a `display: table` wrapper whose
   * height collapses on a list this long, which caps scrollHeight and leaves
   * most of the chapters unreachable.
   */
  function viewport(): HTMLElement | null {
    return scrollRootRef.current
  }

  function toggleExpanded(chapterId: string) {
    setExpanded(prev => {
      const next = prev === chapterId ? null : chapterId
      if (seriesId) saveExpanded(seriesId, next)
      return next
    })
  }

  /**
   * Copy everything for one chapter in a single action: the Editor 2.0 prompt,
   * the chapter's full script with timeline (all sections joined), and its
   * full Clipper 3.0 crop metadata (all images joined) — one clipboard write,
   * so nothing has to be gathered section by section, file by file, or
   * button by button.
   */
  async function copyAll(ch: Editable2Chapter) {
    setCopying(ch.id)
    try {
      const [timeline, metadata] = await Promise.all([
        videoApi2.getTimelineBundle(ch.id),
        videoApi2.getCropMetadataBundle(ch.id)
      ])
      const prompt = readSavedPrompt()

      const sections: string[] = []
      if (prompt) sections.push(`# Prompt\n\n${prompt}`)
      if (timeline.text) sections.push(`# Script with Timeline\n\n${timeline.text}`)
      if (metadata.text) sections.push(`# Crop Metadata\n\n${metadata.text}`)

      if (sections.length === 0) {
        toast({
          title: 'Nothing to copy',
          description: 'No prompt, script with timeline, or crop metadata is available for this chapter yet.',
          variant: 'destructive'
        })
        return
      }

      await navigator.clipboard.writeText(sections.join('\n\n'))
      setCopied(ch.id)
      setTimeout(() => setCopied(prev => (prev === ch.id ? null : prev)), 1500)

      const missing: string[] = []
      if (!prompt) missing.push('prompt')
      if (!timeline.text) missing.push('script with timeline')
      if (!metadata.text) missing.push('crop metadata')
      toast({
        title: 'Copied',
        description: missing.length === 0
          ? `Prompt, script with timeline (${timeline.includedCount}/${timeline.sectionCount} sections) and crop metadata (${metadata.includedCount}/${metadata.imageCount} images) copied.`
          : `Copied what's available — missing: ${missing.join(', ')}.`
      })
    } catch (err) {
      toast({
        title: 'Copy Failed',
        description: err instanceof Error ? err.message : 'Could not copy',
        variant: 'destructive'
      })
    } finally {
      setCopying(prev => (prev === ch.id ? null : prev))
    }
  }

  /**
   * Paste from Clipboard — pulls everything on the clipboard into this
   * chapter's content area. Whatever arrives is kept verbatim; nothing is
   * parsed here, since what the content means is the processing step's
   * business, not this one's.
   */
  async function pasteFromClipboard(ch: Editable2Chapter) {
    setPasting(ch.id)
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) {
        toast({
          title: 'Clipboard Empty',
          description: 'There is nothing on the clipboard to paste.',
          variant: 'destructive'
        })
        return
      }
      setPasted(prev => ({ ...prev, [ch.id]: text }))
      // A fresh paste has not been processed yet, so this drops any previous
      // result and sends the button back to Start Processing.
      setTimelineJson(ch.id, text)
      setProcessedTick(t => t + 1)
      toast({
        title: 'Pasted',
        description: `${text.length.toLocaleString()} characters added — you can now start processing.`
      })
    } catch {
      toast({
        title: 'Paste Failed',
        description: 'Clipboard access was blocked. Paste manually with Cmd/Ctrl+V into the box.',
        variant: 'destructive'
      })
    } finally {
      setPasting(prev => (prev === ch.id ? null : prev))
    }
  }

  /** Drop this chapter's pasted content, disabling Start Processing again. */
  function clearPasted(chapterId: string) {
    setPasted(prev => {
      const next = { ...prev }
      delete next[chapterId]
      return next
    })
    clearTimeline(chapterId)
    setProcessedTick(t => t + 1)
  }

  /**
   * Start Processing — hand the pasted timeline JSON to the preview screen,
   * which processes it and plays the result back.
   *
   * The JSON travels through localStorage rather than the URL or a store:
   * it is far too large for a query string, and this keeps the preview
   * reloadable without re-pasting, even after the tab is closed.
   */
  function startProcessing(ch: Editable2Chapter) {
    const content = pasted[ch.id]?.trim()
    if (!content) return
    if (!setTimelineJson(ch.id, content)) {
      toast({
        title: 'Could not start',
        description: 'Browser storage is unavailable, so the timeline could not be handed over.',
        variant: 'destructive'
      })
      return
    }
    // Remember where the list was before leaving, so coming back from the
    // preview lands on this row rather than at the top.
    rememberPosition()
    navigate(`/editor2/chapter/${ch.id}/preview`)
  }

  /**
   * Export All — render every not-yet-exported chapter to its own MP4 in one
   * background job.
   *
   * Chapters that already have an MP4 in the series' _video2 folder are left
   * out: pressing Export again means "finish the rest", not "re-encode hours
   * of finished video". The server enforces the same rule, so a chapter
   * exported by another session is skipped there even if this list has not
   * re-scanned yet. `force` re-renders everything, for when the crops, audio
   * or timeline have genuinely changed.
   *
   * Each chapter's pasted JSON goes with the request: Editor 2.0 keeps it in
   * the browser, and re-processing it server-side is what makes the exported
   * video match the preview.
   */
  async function exportAll(force = false) {
    if (!seriesId) return
    const all = collectProcessed(chapters.filter(ch => ch.ready).map(ch => ch.id))
    const inputs = force ? all : all.filter(i => !exported[i.chapterId])
    if (inputs.length === 0) return

    setStarting(true)
    try {
      const { jobId } = await videoApi2.exportAll(seriesId, inputs, force ? { force: true } : undefined)
      setExportJob({
        id: jobId,
        seriesId,
        status: 'running',
        percent: 0,
        chapters: [],
        startedAt: Date.now(),
        finishedAt: null,
        error: null
      })
      const skipped = all.length - inputs.length
      toast({
        title: 'Export started',
        description:
          `Rendering ${inputs.length} chapter${inputs.length === 1 ? '' : 's'}` +
          (skipped > 0 ? ` — ${skipped} already exported and skipped` : '') +
          ' — you can keep working while it runs.'
      })
    } catch (err) {
      toast({
        title: 'Could not start the export',
        description: err instanceof Error ? err.message : 'Export failed to start',
        variant: 'destructive'
      })
    } finally {
      setStarting(false)
    }
  }

  async function cancelExport() {
    if (!exportJob) return
    try {
      await videoApi2.cancelExport(exportJob.id)
    } catch {
      // A job that already finished cannot be cancelled — the poll below will
      // show its real state in a moment either way.
    }
  }

  // Follow a running job. Polling rather than a socket subscription: the job
  // is short-lived and this view is the only thing watching it, so a one-second
  // poll is simpler than threading another event through the socket context.
  useEffect(() => {
    if (!exportJob || exportJob.status !== 'running') return
    let cancelled = false

    const id = setInterval(async () => {
      try {
        const job = await videoApi2.getExportJob(exportJob.id)
        if (cancelled) return
        setExportJob(job)
        if (job.status !== 'running') {
          const done = job.chapters.filter(c => c.status === 'done').length
          const skipped = job.chapters.filter(c => c.status === 'skipped').length
          const failed = job.chapters.filter(c => c.status === 'failed')
          // Whatever just rendered is now on disk, so re-scan: the rows keep
          // their Exported badge after this job is forgotten.
          if (seriesId) void refreshExported(seriesId)
          const skipNote = skipped > 0 ? ` ${skipped} already exported.` : ''
          if (job.status === 'cancelled') {
            toast({ title: 'Export cancelled', description: `${done} chapter${done === 1 ? '' : 's'} finished before it stopped.${skipNote}` })
          } else if (failed.length > 0) {
            toast({
              title: 'Export finished with errors',
              description: `${done} exported, ${failed.length} failed — ${failed[0].error ?? 'see the server log'}`,
              variant: 'destructive'
            })
          } else {
            toast({
              title: 'Export complete',
              description: done > 0
                ? `${done} chapter${done === 1 ? '' : 's'} rendered to the series _video2 folder.${skipNote}`
                : 'Every chapter was already exported — nothing to render.'
            })
          }
        }
      } catch {
        // A failed poll is not worth interrupting the user over — the next
        // tick will usually succeed.
      }
    }, 1000)

    return () => { cancelled = true; clearInterval(id) }
  }, [exportJob?.id, exportJob?.status, seriesId, toast])

  /** Save the list's scroll offset for this series. */
  function rememberPosition() {
    const el = viewport()
    if (el && seriesId) saveScrollTop(seriesId, el.scrollTop)
  }

  /**
   * Restore the scroll offset once the chapters are on screen.
   *
   * useLayoutEffect rather than useEffect so the jump happens before the
   * browser paints — restoring after paint shows the top of the list for a
   * frame, which reads as a flicker back to the start.
   */
  useLayoutEffect(() => {
    if (loading || !seriesId || chapters.length === 0) return
    const el = viewport()
    if (!el) return
    const top = getScrollTop(seriesId)
    if (top > 0) el.scrollTop = top
  }, [loading, seriesId, chapters.length])

  // Keep the saved offset current while scrolling, so any route away from
  // here — not just Start Processing — comes back to the right place.
  useEffect(() => {
    const el = viewport()
    if (!el || !seriesId) return
    let frame = 0
    const onScroll = () => {
      // Coalesce to one write per frame: the scroll event fires far more
      // often than localStorage should be touched.
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        saveScrollTop(seriesId, el.scrollTop)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [seriesId, loading, chapters.length])

  /**
   * Re-scan which chapters have an MP4 on disk.
   *
   * Called on load and again when an export job ends, so rows flip to
   * "Exported" for good rather than only for the life of the finished job.
   */
  async function refreshExported(id: string) {
    try {
      const rows = await videoApi2.getExportedChapters(id)
      setExported(Object.fromEntries(rows.map(r => [r.chapterId, r])))
    } catch {
      // A failed scan just means the badges stay as they are; nothing here is
      // worth interrupting the user over.
    }
  }

  useEffect(() => {
    if (!seriesId) return
    setLoading(true)
    Promise.all([
      seriesApi.getById(seriesId),
      videoApi2.getEditableChapters(seriesId),
      videoApi2.getExportedChapters(seriesId).catch(() => [] as Exported2Chapter[])
    ])
      .then(([s, chs, exportedRows]) => {
        setSeriesTitle(s.title)
        setChapters(chs)
        setExported(Object.fromEntries(exportedRows.map(r => [r.chapterId, r])))
        // Bring back anything already handed over for these chapters, so
        // returning from the preview does not look like the paste was lost.
        const restored: Record<string, string> = {}
        for (const ch of chs) {
          const json = getTimelineJson(ch.id)
          if (json) restored[ch.id] = json
        }
        setPasted(restored)
      })
      .catch(err => console.error(err))
      .finally(() => setLoading(false))
  }, [seriesId])

  // The preview screen records "processed" while this list is still mounted
  // behind it, so re-read those markers whenever this view is shown again.
  useEffect(() => {
    const refresh = () => setProcessedTick(t => t + 1)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  const exporting = exportJob?.status === 'running'

  // Keep the display awake for the length of the render. A batch export runs
  // for minutes with no input, so the screen would otherwise sleep — and on a
  // laptop the machine can follow it down mid-encode. Called before the
  // loading guard below because hooks cannot sit behind an early return.
  const wakeLock = useWakeLock(exporting)

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  // How much of the series is ready to export. Read through processedTick so
  // this recomputes after a paste, a clear, or a return from the preview —
  // the markers live in localStorage, which React cannot subscribe to.
  void processedTick
  // Only chapters that cleared the four gates can ever be processed, so they
  // are what "all chapters processed" has to mean — counting the ones still
  // missing a script or crops would leave the button permanently dead on a
  // series whose later chapters have not been through the pipeline yet.
  const readyChapters = chapters.filter(ch => ch.ready)
  const processedInputs = collectProcessed(readyChapters.map(ch => ch.id))
  const processedCount = processedInputs.length
  const allProcessed = readyChapters.length > 0 && processedCount === readyChapters.length

  // Of the processed chapters, how many still need rendering. This — not the
  // processed count — is what Export All would actually do, so it is what the
  // button counts and what decides whether it has anything to do at all.
  const pendingExport = processedInputs.filter(i => !exported[i.chapterId]).length
  const exportedCount = readyChapters.filter(ch => exported[ch.id]).length
  const everythingExported = allProcessed && pendingExport === 0

  const currentlyRendering = exportJob?.chapters.find(c => c.status === 'rendering') ?? null

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/editor2')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <Clapperboard className="h-5 w-5 text-primary" />
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">{seriesTitle}</h1>
          <p className="text-xs text-muted-foreground">
            Editor 2.0 — script, audio, crops and timeline readiness
          </p>
        </div>

        {/* Export All — the whole series in one action, offered only once
            every chapter has been processed. */}
        {exporting ? (
          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="text-right">
              <p className="text-xs font-medium flex items-center justify-end gap-1">
                Exporting {exportJob!.percent}%
                {currentlyRendering && (
                  <span className="text-muted-foreground font-normal">
                    · Chapter {currentlyRendering.chapterNumber}
                  </span>
                )}
                {/* Says plainly whether the screen is being held awake — and
                    stays quiet when it is, so the icon only draws the eye if
                    the lock was refused or is unavailable. */}
                {wakeLock.active ? (
                  <span title="Screen kept awake while this export runs">
                    <Coffee className="h-3 w-3 text-muted-foreground" />
                  </span>
                ) : (
                  <span
                    title={
                      wakeLock.supported
                        ? 'The screen may sleep — the browser did not grant a wake lock (this tab must stay visible).'
                        : 'This browser cannot keep the screen awake. The export still finishes on the server.'
                    }
                  >
                    <Moon className="h-3 w-3 text-yellow-600" />
                  </span>
                )}
              </p>
              <div className="h-1.5 w-40 bg-secondary rounded-full mt-1 overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${exportJob!.percent}%` }}
                />
              </div>
            </div>
            <Button variant="outline" size="sm" className="h-8" onClick={cancelExport}>
              <Ban className="h-3 w-3 mr-1" />
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* How much of the series is already rendered, so the state is
                readable without counting badges down the list. */}
            {exportedCount > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {exportedCount}/{readyChapters.length} exported
              </span>
            )}

            <Button
              size="sm"
              variant={everythingExported ? 'outline' : 'default'}
              className="h-8"
              onClick={() => exportAll(everythingExported)}
              disabled={!allProcessed || starting}
              title={
                readyChapters.length === 0
                  ? 'No chapter is ready yet — finish a script, voiceover, crops and timeline first'
                  : !allProcessed
                    ? `${processedCount} of ${readyChapters.length} ready chapters processed — process them all to export`
                    : everythingExported
                      ? `Every chapter is already exported — re-render all ${readyChapters.length} from scratch`
                      : `Render the ${pendingExport} chapter${pendingExport === 1 ? '' : 's'} that have not been exported yet`
              }
            >
              {starting ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Film className="h-3 w-3 mr-1" />
              )}
              {everythingExported ? 'Re-export All' : 'Export All'}
              {allProcessed && !everythingExported && exportedCount > 0 && (
                <span className="ml-1 opacity-70">({pendingExport})</span>
              )}
              {!allProcessed && readyChapters.length > 0 && (
                <span className="ml-1 opacity-70">({processedCount}/{readyChapters.length})</span>
              )}
            </Button>
          </div>
        )}
      </div>

      <div ref={scrollRootRef} className="flex-1 overflow-y-auto">
        <div className="divide-y">
          {chapters.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Clapperboard className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p>No chapters found for this series.</p>
            </div>
          )}

          {chapters.map(ch => {
            const content = pasted[ch.id]?.trim() ?? ''
            const done = content.length > 0 && isProcessed(ch.id, content)
            const isOpen = expanded === ch.id
            const rowExport = exportJob?.chapters.find(c => c.chapterId === ch.id)
            const exportedRow = exported[ch.id]

            return (
              <div key={ch.id} data-chapter-row={ch.id}>
                {/* The row itself: one line per chapter, so a long series
                    scans as a list rather than a stack of tall cards. */}
                <div
                  className={`flex items-center gap-3 px-4 py-2 cursor-pointer hover:bg-muted/50 transition-colors ${
                    isOpen ? 'bg-muted/40' : ''
                  }`}
                  onClick={() => toggleExpanded(ch.id)}
                >
                  <ChevronRight
                    className={`h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform ${
                      isOpen ? 'rotate-90' : ''
                    }`}
                  />

                  <span className="font-semibold text-sm tabular-nums w-14 flex-shrink-0">
                    Ch {ch.number}
                  </span>

                  <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
                    {ch.title || <span className="opacity-50">Untitled</span>}
                  </span>

                  {/* Gate dots — the four-gate readiness compressed to a row
                      of icons, so the state reads at a glance without opening
                      anything. */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <GateDot ok={ch.hasScript} icon={<ScrollText className="h-3 w-3" />} label="Script" />
                    <GateDot
                      ok={ch.hasSectionAudio}
                      icon={<Mic className="h-3 w-3" />}
                      label={`Audio${ch.sectionCount > 0 ? ` (${ch.sectionCount} sections)` : ''}`}
                    />
                    <GateDot
                      ok={ch.hasCropsClipper3}
                      icon={<Scissors className="h-3 w-3" />}
                      label={`Crops${ch.cropImageCount > 0 ? ` (${ch.cropDoneCount}/${ch.cropImageCount})` : ''}`}
                    />
                    <GateDot ok={ch.hasTimelineScript} icon={<Clock className="h-3 w-3" />} label="Timeline" />
                  </div>

                  {/* Status: where this chapter stands in the paste → process
                      → export run, which is what the user is actually tracking. */}
                  <div className="w-28 flex-shrink-0 flex justify-end">
                    {rowExport && rowExport.status !== 'pending' ? (
                      <span className="text-xs flex items-center gap-1">
                        {rowExport.status === 'rendering' && (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin text-primary" />
                            <span className="text-primary tabular-nums">{Math.round(rowExport.percent)}%</span>
                          </>
                        )}
                        {rowExport.status === 'done' && (
                          <><Film className="h-3 w-3 text-green-600" /><span className="text-green-600">Exported</span></>
                        )}
                        {/* Skipped reads as Exported, because that is what it
                            means to the user: the MP4 is there. The tooltip
                            carries the distinction. */}
                        {rowExport.status === 'skipped' && (
                          <span
                            className="text-green-600 flex items-center gap-1"
                            title="Already exported — left alone by this run"
                          >
                            <Film className="h-3 w-3" /> Exported
                          </span>
                        )}
                        {rowExport.status === 'failed' && (
                          <span className="text-destructive flex items-center gap-1" title={rowExport.error ?? undefined}>
                            <AlertTriangle className="h-3 w-3" /> Failed
                          </span>
                        )}
                        {rowExport.status === 'cancelled' && (
                          <span className="text-muted-foreground">Cancelled</span>
                        )}
                      </span>
                    ) : exportedRow ? (
                      /* No job running — the standing state from the folder
                         scan, which is what makes "Exported" survive a reload
                         rather than living only inside a finished job. */
                      <span
                        className="text-xs text-green-600 flex items-center gap-1"
                        title={`${exportedRow.fileName} · ${formatSize(exportedRow.size)} · exported ${formatWhen(exportedRow.modifiedAt)}`}
                      >
                        <Film className="h-3 w-3" /> Exported
                      </span>
                    ) : done ? (
                      <span className="text-xs text-green-600 flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Processed
                      </span>
                    ) : content ? (
                      <span className="text-xs text-blue-500 flex items-center gap-1">
                        <ClipboardPaste className="h-3 w-3" /> Pasted
                      </span>
                    ) : ch.ready ? (
                      <span className="text-xs text-muted-foreground">Ready</span>
                    ) : (
                      <span className="text-xs text-yellow-600 flex items-center gap-1" title={ch.reason ?? undefined}>
                        <AlertTriangle className="h-3 w-3" /> Incomplete
                      </span>
                    )}
                  </div>

                  {/* The actions, inline. Copy and Paste are the two steps a
                      chapter still needs, so an unprocessed row offers them
                      here rather than only behind an expand — going through
                      a hundred chapters otherwise means opening every one. A
                      processed row has finished with them and shows only
                      Preview, which keeps the common case quiet. */}
                  <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                    {!done && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => copyAll(ch)}
                          disabled={copying === ch.id}
                          title="Copy All — prompt, script with timeline and crop metadata"
                        >
                          {copying === ch.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : copied === ch.id ? (
                            <Check className="h-3.5 w-3.5 text-green-500" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => pasteFromClipboard(ch)}
                          disabled={pasting === ch.id}
                          title="Paste the timeline JSON from the clipboard"
                        >
                          {pasting === ch.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ClipboardPaste className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </>
                    )}

                    <Button
                      size="sm"
                      variant={done ? 'outline' : 'default'}
                      className="h-7 w-28"
                      onClick={() => startProcessing(ch)}
                      disabled={!content}
                      title={content ? undefined : 'Paste content from the clipboard first'}
                    >
                      {done ? (
                        <><Eye className="h-3 w-3 mr-1" /> Preview</>
                      ) : (
                        <><Play className="h-3 w-3 mr-1" /> Process</>
                      )}
                    </Button>
                  </div>
                </div>

                {/* Expanded detail: everything the old card showed, revealed
                    only for the chapter being worked on. */}
                {isOpen && (
                  <div className="px-4 pb-3 pl-11 space-y-2 bg-muted/20">
                    {!ch.ready && ch.reason && (
                      <p className="flex items-center gap-1 text-xs text-yellow-600">
                        <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                        {ch.reason}
                      </p>
                    )}

                    {!ch.ready && (
                      <div className="flex items-center gap-3 flex-wrap">
                        {!ch.hasScript && (
                          <Link to="/narration" className="text-xs text-primary hover:underline flex items-center gap-1">
                            <ScrollText className="h-3 w-3" /> Script
                          </Link>
                        )}
                        {!ch.hasSectionAudio && (
                          <Link to={`/narration/voiceover/${ch.id}`} className="text-xs text-primary hover:underline flex items-center gap-1">
                            <Mic className="h-3 w-3" /> Voice
                          </Link>
                        )}
                        {!ch.hasCropsClipper3 && (
                          <Link to={`/clipper3/chapter/${ch.id}`} className="text-xs text-primary hover:underline flex items-center gap-1">
                            <Scissors className="h-3 w-3" /> Clip
                          </Link>
                        )}
                        {!ch.hasTimelineScript && (
                          <Link to={`/narration/voiceover/${ch.id}`} className="text-xs text-primary hover:underline flex items-center gap-1">
                            <Clock className="h-3 w-3" /> Timeline
                          </Link>
                        )}
                      </div>
                    )}

                    {/* An unprocessed row carries Copy and Paste inline, so
                        the detail repeats them only for a processed chapter —
                        which has none on its row, and would otherwise have no
                        way back to re-copying or re-pasting. */}
                    {done && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7"
                          onClick={() => copyAll(ch)}
                          disabled={copying === ch.id}
                        >
                          {copying === ch.id ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : copied === ch.id ? (
                            <Check className="h-3 w-3 mr-1 text-green-500" />
                          ) : (
                            <Copy className="h-3 w-3 mr-1" />
                          )}
                          {copied === ch.id ? 'Copied' : 'Copy All (Prompt + Timeline + Crop Metadata)'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7"
                          onClick={() => pasteFromClipboard(ch)}
                          disabled={pasting === ch.id}
                        >
                          {pasting === ch.id ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <ClipboardPaste className="h-3 w-3 mr-1" />
                          )}
                          Paste from Clipboard
                        </Button>
                      </div>
                    )}

                    {pasted[ch.id] && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-green-600 flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          {pasted[ch.id].length.toLocaleString()} characters ready
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-muted-foreground"
                          onClick={() => clearPasted(ch.id)}
                        >
                          <X className="h-3 w-3 mr-1" />
                          Clear
                        </Button>
                      </div>
                    )}

                    {rowExport?.status === 'failed' && rowExport.error && (
                      <p className="text-xs text-destructive">{rowExport.error}</p>
                    )}
                    {rowExport?.status === 'done' && rowExport.outputPath && (
                      <p className="text-xs text-muted-foreground font-mono break-all">
                        {rowExport.outputPath}
                      </p>
                    )}

                    {pasted[ch.id] !== undefined && (
                      <div className="space-y-1">
                        <Label htmlFor={`pasted-${ch.id}`} className="text-xs text-muted-foreground">
                          Pasted content
                        </Label>
                        <Textarea
                          id={`pasted-${ch.id}`}
                          value={pasted[ch.id]}
                          onChange={(e) => {
                            const value = e.target.value
                            setPasted(prev => ({ ...prev, [ch.id]: value }))
                            // Editing the JSON by hand also counts as a new
                            // paste, so the result has to be rebuilt.
                            setTimelineJson(ch.id, value)
                            setProcessedTick(t => t + 1)
                          }}
                          rows={6}
                          className="font-mono text-xs"
                          spellCheck={false}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
