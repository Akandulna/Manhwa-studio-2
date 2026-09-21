/**
 * Clipper3SeriesView — Module 3 v3: Image Clipper 3.0
 *
 * Chapter list for one series, reached from Clipper3Library after picking a
 * series — the same "pick a series, then a chapter" flow used by Image
 * Clipper v1/v2. Clicking a chapter opens the pointer workspace
 * (Clipper3Workspace). Reuses PointerStateBadge/formatWhen from
 * Clipper3Library so the chapter state reads identically wherever it's shown.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { usePublishedChapters } from '@/hooks/usePublishedChapters'
import { PublishedBadge, publishedRowClass } from '@/components/PublishedBadge'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  ArrowLeft,
  Images,
  ChevronRight,
  Loader2,
  AlertTriangle,
  FileCheck2,
  Scissors,
  Clock,
  Rows3,
  RefreshCw,
  Unlink
} from 'lucide-react'
import {
  clipper2Api,
  clipper3Api,
  type Clipper2ChapterSummary,
  type Clipper3ChapterSummary,
  type Clipper3ChapterSyncResult,
  type Clipper3ChapterUnsyncResult,
  type Clipper3SyncPreview,
  type Clipper3UnsyncPreview
} from '@/lib/api'
import { PointerStateBadge, formatWhen } from './Clipper3Library'
import { useToast } from '@/components/ui/use-toast'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useSocket } from '@/lib/socket'

/** Whether every image in this chapter has both its crop JSON and its metadata. */
function AttachedStatusBadge({ summary }: { summary: Clipper3ChapterSummary | undefined }) {
  if (!summary) return null
  if (summary.fullyAttached) {
    return (
      <Badge variant="success" className="flex items-center gap-1">
        <FileCheck2 className="h-3 w-3" />
        Fully attached
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="flex items-center gap-1 text-muted-foreground">
      <Clock className="h-3 w-3" />
      {summary.attachedImages}/{summary.totalImages} attached
    </Badge>
  )
}

/** Whether the chapter's crop/cut step has been run and produced output. */
function ChoppedStatusBadge({ summary }: { summary: Clipper3ChapterSummary | undefined }) {
  if (!summary) return null
  if (summary.chopped) {
    return (
      <Badge variant="success" className="flex items-center gap-1">
        <Scissors className="h-3 w-3" />
        Chopped
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="flex items-center gap-1 text-muted-foreground">
      <Scissors className="h-3 w-3" />
      Not chopped
    </Badge>
  )
}

export default function Clipper3SeriesView() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [chapters, setChapters] = useState<Clipper2ChapterSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Chapters already rendered to video, so the user can skip re-cutting them.
  const { isPublished } = usePublishedChapters(id)
  const [summaries, setSummaries] = useState<Record<string, Clipper3ChapterSummary>>({})

  const { toast } = useToast()
  const {
    clipper3SliceProgress,
    clipper3SliceComplete,
    clipper3SyncProgress,
    clipper3SyncComplete,
    clipper3UnsyncProgress,
    clipper3UnsyncComplete
  } = useSocket()
  const [slicingAll, setSlicingAll] = useState(false)
  const [syncing, setSyncing] = useState(false)

  // Sync is two steps: scan, then confirm. `syncPreview` holds what the scan
  // found and is what the dialog renders — it is set before anything is
  // written, so the user agrees to a specific list of pages rather than to
  // the idea of syncing.
  const [scanning, setScanning] = useState(false)
  const [syncPreview, setSyncPreview] = useState<Clipper3SyncPreview | null>(null)

  // Pages the completed run could not attach, kept until dismissed: a toast
  // cannot hold a per-page list, and "3 pages failed" with no way to see
  // WHICH is not actionable.
  const [syncReport, setSyncReport] = useState<Clipper3ChapterSyncResult[] | null>(null)

  // Unsync mirrors sync's two steps for the same reason: it deletes files, and
  // the count it deletes is not knowable from the chapter list — a chapter
  // showing "12/40 attached" loses 12 pages, not 40.
  const [unsyncing, setUnsyncing] = useState(false)
  const [unsyncScanning, setUnsyncScanning] = useState(false)
  const [unsyncPreview, setUnsyncPreview] = useState<Clipper3UnsyncPreview | null>(null)

  // The picker dialog: which chapters to clear. Its own selection rather than
  // the slicing one, so the two cannot be confused for each other.
  const [unsyncPicker, setUnsyncPicker] = useState(false)
  const [unsyncPicked, setUnsyncPicked] = useState<Set<string>>(new Set())

  // The chapters the pending unsync applies to, captured when the preview was
  // taken. Held apart from `unsyncPicked` so the picker closing behind the
  // confirmation cannot change what Unsync clears.
  const [unsyncTargets, setUnsyncTargets] = useState<string[]>([])

  const [unsyncReport, setUnsyncReport] = useState<Clipper3ChapterUnsyncResult[] | null>(null)

  /**
   * The last completion event already acted on, so a finished run is reported
   * exactly once.
   *
   * These events live in the socket PROVIDER, which outlives this page: the
   * value sits there until another run replaces it. Without this guard the
   * completion effect re-fires on every mount and replays an old run —
   * re-opening its dialog and re-showing its toast each time the user
   * navigates back, describing pages that may no longer be on disk at all.
   *
   * Seeded lazily with whatever is already in the provider at mount, so a run
   * that finished BEFORE this page opened counts as already handled. A run
   * that finishes while the page is open produces a new object, which is not
   * the seeded one, and is reported normally.
   */
  const handledSliceComplete = useRef<unknown>(undefined)
  const handledSyncComplete = useRef<unknown>(undefined)
  const handledUnsyncComplete = useRef<unknown>(undefined)
  if (handledSliceComplete.current === undefined) handledSliceComplete.current = clipper3SliceComplete
  if (handledSyncComplete.current === undefined) handledSyncComplete.current = clipper3SyncComplete
  if (handledUnsyncComplete.current === undefined) handledUnsyncComplete.current = clipper3UnsyncComplete

  // Picking chapters is a mode rather than an always-on column: the cards are
  // links, and a stray click should open a chapter, not silently select it.
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const toggleChapter = useCallback((chapterId: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(chapterId)) next.delete(chapterId)
      else next.add(chapterId)
      return next
    })
  }, [])

  /**
   * Slices every page of the selected chapters. Even a few chapters run to
   * dozens of pages, so the server works in the background and streams
   * progress — this only kicks it off.
   */
  const sliceSelected = useCallback(async (chapterIds: string[]) => {
    if (!id || chapterIds.length === 0) return
    setSlicingAll(true)
    try {
      const started = await clipper3Api.sliceSeries(id, chapterIds)
      toast({
        title: 'Slicing started',
        description: `${started.images} page${started.images === 1 ? '' : 's'} across ${started.chapters} chapter${started.chapters === 1 ? '' : 's'} — this runs in the background.`
      })
      setSelecting(false)
      setSelected(new Set())
    } catch (err) {
      setSlicingAll(false)
      toast({
        title: 'Could not start slicing',
        description: err instanceof Error ? err.message : 'Failed to start slicing',
        variant: 'destructive'
      })
    }
  }, [id, toast])

  // The job outlives this component's request, so completion arrives over the
  // socket rather than from the call that started it — and, because the event
  // outlives the job too, only a result this mount has not already seen.
  useEffect(() => {
    if (!clipper3SliceComplete || clipper3SliceComplete.seriesId !== id) return
    if (handledSliceComplete.current === clipper3SliceComplete) return
    handledSliceComplete.current = clipper3SliceComplete
    setSlicingAll(false)

    if (clipper3SliceComplete.error) {
      toast({
        title: 'Slicing failed',
        description: clipper3SliceComplete.error,
        variant: 'destructive'
      })
      return
    }

    const { sliced = 0, parts = 0, failed = 0, chapters: done = 0 } = clipper3SliceComplete
    toast({
      title: failed > 0 ? `Sliced ${sliced} pages, ${failed} failed` : `Sliced ${sliced} pages`,
      description: `${parts} part${parts === 1 ? '' : 's'} across ${done} chapter${done === 1 ? '' : 's'}, written into each chapter's slices3 folder.`,
      variant: failed > 0 ? 'destructive' : undefined
    })
  }, [clipper3SliceComplete, id, toast])

  // A run started before this page mounted still owns the series, so adopt its
  // progress rather than showing an idle button beside a running job.
  useEffect(() => {
    if (clipper3SliceProgress?.seriesId === id) setSlicingAll(true)
  }, [clipper3SliceProgress, id])

  /**
   * Step one: finds the crop JSON sitting in each chapter's `Processed/`
   * folder and reports what it could attach, writing nothing. The result
   * fills the confirmation dialog.
   */
  const scanProcessed = useCallback(async () => {
    if (!id) return
    setScanning(true)
    setSyncReport(null)
    try {
      const preview = await clipper3Api.previewProcessed(id)
      setSyncPreview(preview)
    } catch (err) {
      toast({
        title: 'Could not scan for files',
        description: err instanceof Error ? err.message : 'Failed to scan Processed folders',
        variant: 'destructive'
      })
    } finally {
      setScanning(false)
    }
  }, [id, toast])

  /**
   * Step two: actually attaches what the preview listed. Re-runs the same
   * checks server-side rather than trusting the preview's verdict — the files
   * are on disk and could have changed between the two calls — so a page that
   * stopped validating in between is reported, not written on the strength of
   * a stale scan.
   */
  const confirmSync = useCallback(async () => {
    if (!id) return
    setSyncPreview(null)
    setSyncing(true)
    try {
      await clipper3Api.syncProcessed(id)
    } catch (err) {
      setSyncing(false)
      toast({
        title: 'Could not start syncing',
        description: err instanceof Error ? err.message : 'Failed to start syncing',
        variant: 'destructive'
      })
    }
  }, [id, toast])

  // Completion arrives over the socket, not from the call that started it.
  useEffect(() => {
    if (!clipper3SyncComplete || clipper3SyncComplete.seriesId !== id) return
    if (handledSyncComplete.current === clipper3SyncComplete) return
    handledSyncComplete.current = clipper3SyncComplete
    setSyncing(false)

    if (clipper3SyncComplete.error) {
      toast({
        title: 'Sync failed',
        description: clipper3SyncComplete.error,
        variant: 'destructive'
      })
      return
    }

    const { imported = 0, skipped = 0, failed = 0, results = [] } = clipper3SyncComplete

    // Newly attached pages change every Attached chip on the page, so the
    // rollup is re-fetched rather than patched from the result — the server
    // re-validates on read, which is the same check that decided the import.
    if (imported > 0) {
      clipper3Api.getSeriesSummary(id)
        .then(result => setSummaries(Object.fromEntries(result.chapters.map(c => [c.chapterId, c]))))
        .catch(() => {})
    }

    // Only failures get the dialog: a clean run is fully described by its
    // counts, and a modal over "nothing went wrong" is just another click.
    if (failed > 0) setSyncReport(results.filter(r => r.failed > 0))

    toast({
      title: imported > 0
        ? `Attached ${imported} page${imported === 1 ? '' : 's'}`
        : 'Nothing new to attach',
      description: [
        skipped > 0 ? `${skipped} already attached` : null,
        failed > 0 ? `${failed} could not be attached` : null,
        imported === 0 && skipped === 0 && failed === 0
          ? 'No Processed folders found in this series.'
          : null
      ].filter(Boolean).join(' · ') || undefined,
      variant: failed > 0 ? 'destructive' : undefined
    })
  }, [clipper3SyncComplete, id, toast])

  // Same reasoning as slicing: a run already underway owns the button.
  useEffect(() => {
    if (clipper3SyncProgress?.seriesId === id) setSyncing(true)
  }, [clipper3SyncProgress, id])

  const toggleUnsyncPick = useCallback((chapterId: string) => {
    setUnsyncPicked(prev => {
      const next = new Set(prev)
      if (next.has(chapterId)) next.delete(chapterId)
      else next.add(chapterId)
      return next
    })
  }, [])

  /** Opens the picker empty — nothing is ever pre-ticked for a delete. */
  const openUnsyncPicker = useCallback(() => {
    setUnsyncPicked(new Set())
    setUnsyncReport(null)
    setUnsyncPicker(true)
  }, [])

  /**
   * Unsync step one: counts what the selected chapters have attached, so the
   * confirmation names a real number of pages rather than a number of
   * chapters. Deletes nothing.
   *
   * The selection is captured here, not read at Proceed time: selection mode
   * closes behind the dialog, and a Proceed that consulted `selected` after
   * that would clear an empty set or, worse, a re-made one.
   */
  const scanForUnsync = useCallback(async (chapterIds: string[]) => {
    if (!id || chapterIds.length === 0) return
    setUnsyncScanning(true)
    setUnsyncReport(null)
    try {
      const preview = await clipper3Api.previewUnsyncProcessed(id, chapterIds)
      setUnsyncTargets(chapterIds)
      setUnsyncPicker(false)
      setUnsyncPreview(preview)
    } catch (err) {
      toast({
        title: 'Could not check those chapters',
        description: err instanceof Error ? err.message : 'Failed to read the attached files',
        variant: 'destructive'
      })
    } finally {
      setUnsyncScanning(false)
    }
  }, [id, toast])

  /**
   * Unsync step two: removes the attached crop JSON and metadata from the
   * chapters the preview was taken over, putting their pages back to pending.
   * Only the store is touched — the files under `Processed/` stay put, so this
   * is undone by running Sync json again.
   */
  const confirmUnsync = useCallback(async () => {
    if (!id || unsyncTargets.length === 0) return
    setUnsyncPreview(null)
    setUnsyncing(true)
    try {
      await clipper3Api.unsyncProcessed(id, unsyncTargets)
      setUnsyncPicked(new Set())
    } catch (err) {
      setUnsyncing(false)
      toast({
        title: 'Could not start unsyncing',
        description: err instanceof Error ? err.message : 'Failed to start unsyncing',
        variant: 'destructive'
      })
    }
  }, [id, unsyncTargets, toast])

  // Completion arrives over the socket, not from the call that started it.
  useEffect(() => {
    if (!clipper3UnsyncComplete || clipper3UnsyncComplete.seriesId !== id) return
    if (handledUnsyncComplete.current === clipper3UnsyncComplete) return
    handledUnsyncComplete.current = clipper3UnsyncComplete
    setUnsyncing(false)

    if (clipper3UnsyncComplete.error) {
      toast({
        title: 'Unsync failed',
        description: clipper3UnsyncComplete.error,
        variant: 'destructive'
      })
      return
    }

    const { detached = 0, failed = 0, results = [] } = clipper3UnsyncComplete

    // Every Attached chip on the page just changed, so the rollup is re-read
    // rather than patched — same reasoning as the sync side.
    if (detached > 0) {
      clipper3Api.getSeriesSummary(id)
        .then(result => setSummaries(Object.fromEntries(result.chapters.map(c => [c.chapterId, c]))))
        .catch(() => {})
    }

    if (failed > 0) setUnsyncReport(results.filter(r => r.failed > 0))

    toast({
      title: detached > 0
        ? `Unsynced ${detached} page${detached === 1 ? '' : 's'}`
        : 'Nothing was attached',
      description: [
        detached > 0 ? 'The files in Processed/ were left in place — Sync json will re-attach them.' : null,
        failed > 0 ? `${failed} could not be removed` : null
      ].filter(Boolean).join(' · ') || undefined,
      variant: failed > 0 ? 'destructive' : undefined
    })
  }, [clipper3UnsyncComplete, id, toast])

  // A run already underway owns the button.
  useEffect(() => {
    if (clipper3UnsyncProgress?.seriesId === id) setUnsyncing(true)
  }, [clipper3UnsyncProgress, id])

  useEffect(() => {
    let cancelled = false
    clipper2Api.getChapters()
      .then(all => { if (!cancelled) setChapters(all) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load chapters') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Attached/chopped chips: display-only rollup, so a failed fetch just leaves
  // the chips off rather than blocking the chapter list itself.
  useEffect(() => {
    if (!id) return
    let cancelled = false
    clipper3Api.getSeriesSummary(id)
      .then(result => {
        if (cancelled) return
        setSummaries(Object.fromEntries(result.chapters.map(c => [c.chapterId, c])))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [id])

  const seriesChapters = useMemo(
    () => chapters.filter(c => c.seriesId === id).sort((a, b) => a.number - b.number),
    [chapters, id]
  )
  const seriesTitle = seriesChapters[0]?.seriesTitle ?? ''

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (seriesChapters.length === 0 && !error) {
    return (
      <div className="p-6 text-center">
        <h2 className="text-xl font-semibold">Series not found</h2>
        <Button variant="link" onClick={() => navigate('/clipper3')}>
          Return to Library
        </Button>
      </div>
    )
  }

  const appliedCount = seriesChapters.filter(c => c.status === 'applied').length
  const progress = seriesChapters.length > 0 ? Math.round((appliedCount / seriesChapters.length) * 100) : 0

  // Only this series' run: the socket carries every series' slice progress.
  const sliceProgress = clipper3SliceProgress?.seriesId === id ? clipper3SliceProgress : null
  const slicePercent = sliceProgress && sliceProgress.total > 0
    ? Math.round((sliceProgress.current / sliceProgress.total) * 100)
    : 0

  const syncProgress = clipper3SyncProgress?.seriesId === id ? clipper3SyncProgress : null
  const syncPercent = syncProgress && syncProgress.total > 0
    ? Math.round((syncProgress.current / syncProgress.total) * 100)
    : 0

  const unsyncProgress = clipper3UnsyncProgress?.seriesId === id ? clipper3UnsyncProgress : null
  const unsyncPercent = unsyncProgress && unsyncProgress.total > 0
    ? Math.round((unsyncProgress.current / unsyncProgress.total) * 100)
    : 0

  // Any run that writes the store locks every button that writes the store, so
  // two of them can never be started over the same files.
  const busy = slicingAll || syncing || scanning || unsyncing || unsyncScanning

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-6 pb-4 border-b flex-shrink-0">
        <div className="flex items-start gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/clipper3')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>

          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold truncate">{seriesTitle}</h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground mt-1">
              <span>{seriesChapters.length} chapters ready for pointer detection</span>
              <span>•</span>
              <span>{appliedCount} applied</span>
            </div>

            <div className="max-w-md mt-3">
              <div className="flex items-center justify-between text-sm mb-1">
                <span>Apply Progress</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>

            {/* Separate from Apply Progress: this counts pages sliced across
                the whole series, not chapters whose pointers were applied. */}
            {sliceProgress && (
              <div className="max-w-md mt-3">
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="truncate mr-2">
                    Slicing {sliceProgress.current}/{sliceProgress.total} ·{' '}
                    <span className="font-mono text-xs text-muted-foreground">
                      {sliceProgress.filename}
                    </span>
                  </span>
                  <span className="flex-shrink-0">{slicePercent}%</span>
                </div>
                <Progress value={slicePercent} className="h-2" />
              </div>
            )}

            {/* Counts chapters scanned for Processed/ folders, not pages —
                most chapters have none and are passed over in an instant. */}
            {syncProgress && (
              <div className="max-w-md mt-3">
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="truncate mr-2">
                    Syncing chapter {syncProgress.chapterNumber} ·{' '}
                    {syncProgress.current}/{syncProgress.total}
                  </span>
                  <span className="flex-shrink-0">{syncPercent}%</span>
                </div>
                <Progress value={syncPercent} className="h-2" />
              </div>
            )}

            {unsyncProgress && (
              <div className="max-w-md mt-3">
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="truncate mr-2">
                    Unsyncing chapter {unsyncProgress.chapterNumber} ·{' '}
                    {unsyncProgress.current}/{unsyncProgress.total}
                  </span>
                  <span className="flex-shrink-0">{unsyncPercent}%</span>
                </div>
                <Progress value={unsyncPercent} className="h-2" />
              </div>
            )}
          </div>

          {/* Bulk slicing, so pages are cut into upload-sized parts without
              opening each chapter one at a time. */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {selecting ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelecting(false)
                    setSelected(new Set())
                  }}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setSelected(
                      selected.size === seriesChapters.length
                        ? new Set()
                        : new Set(seriesChapters.map(c => c.id))
                    )
                  }
                  disabled={busy}
                >
                  {selected.size === seriesChapters.length ? 'Clear all' : 'Select all'}
                </Button>
                <Button
                  onClick={() => sliceSelected([...selected])}
                  disabled={busy || selected.size === 0}
                >
                  {slicingAll ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Rows3 className="h-4 w-4 mr-2" />
                  )}
                  {slicingAll
                    ? 'Slicing…'
                    : selected.size === 0
                      ? 'Slice chapters'
                      : `Slice ${selected.size} chapter${selected.size === 1 ? '' : 's'}`}
                </Button>
              </>
            ) : (
              <>
                {/* Attaching already-made files is a read of the disk, so it
                    needs no chapter selection — every chapter is scanned and
                    the ones with nothing in Processed/ cost nothing. */}
                <Button
                  variant="outline"
                  onClick={scanProcessed}
                  disabled={busy}
                  title="Find crop pointers and metadata in each chapter's Processed folder"
                >
                  {scanning || syncing ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  {scanning ? 'Scanning…' : syncing ? 'Syncing…' : 'Sync json'}
                </Button>

                {/* Unsync gets its own picker rather than riding the slicing
                    selection mode: it deletes files, and reaching it through a
                    mode named for slicing puts a destructive button one stray
                    click from a harmless one. */}
                <Button
                  variant="outline"
                  onClick={openUnsyncPicker}
                  disabled={busy}
                  title="Remove attached crop JSON from chosen chapters — the files in Processed/ are kept"
                >
                  {unsyncing || unsyncScanning ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Unlink className="h-4 w-4 mr-2" />
                  )}
                  {unsyncScanning ? 'Checking…' : unsyncing ? 'Unsyncing…' : 'Unsync json'}
                </Button>

              <Button
                variant="outline"
                onClick={() => setSelecting(true)}
                disabled={busy}
                title="Pick chapters to slice into parts, or to unsync"
              >
                {slicingAll ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Rows3 className="h-4 w-4 mr-2" />
                )}
                {slicingAll ? 'Slicing…' : 'Slice pages'}
              </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-4 flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded p-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Chapter grid */}
      <ScrollArea className="flex-1">
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {seriesChapters.map(chapter => {
            const isSelected = selected.has(chapter.id)

            // While selecting, the card toggles instead of navigating — so the
            // same card is a link in one mode and a checkbox row in the other.
            const card = (
              <Card className={`cursor-pointer transition-colors group ${
                isSelected ? 'border-primary bg-accent' : 'hover:border-primary'
              } ${isPublished(chapter.id) ? publishedRowClass : ''}`}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {selecting && (
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleChapter(chapter.id)}
                          disabled={busy}
                          className="flex-shrink-0"
                        />
                      )}
                      <p className="font-medium text-sm truncate">
                        Chapter {chapter.number}
                        {chapter.title ? ` · ${chapter.title}` : ''}
                      </p>
                    </div>
                    {!selecting && (
                      <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                    )}
                  </div>

                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                    <Images className="h-3 w-3" />
                    {chapter.pageCount} page{chapter.pageCount !== 1 ? 's' : ''}
                    {chapter.detectedAt && (
                      <span className="ml-2">detected {formatWhen(chapter.detectedAt)}</span>
                    )}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <PointerStateBadge chapter={chapter} />
                    <AttachedStatusBadge summary={summaries[chapter.id]} />
                    <ChoppedStatusBadge summary={summaries[chapter.id]} />
                    {isPublished(chapter.id) && <PublishedBadge />}
                  </div>
                </CardContent>
              </Card>
            )

            return selecting ? (
              <div
                key={chapter.id}
                className="block"
                role="button"
                tabIndex={0}
                onClick={() => !busy && toggleChapter(chapter.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    if (!busy) toggleChapter(chapter.id)
                  }
                }}
              >
                {card}
              </div>
            ) : (
              <Link key={chapter.id} to={`/clipper3/chapter/${chapter.id}`} className="block">
                {card}
              </Link>
            )
          })}
        </div>
      </ScrollArea>

      {/* Step one's result: what was found, before anything is written. Pages
          are grouped by chapter and listed individually — the whole point of
          confirming is seeing WHICH pages, so a bare count would not be worth
          the extra click. */}
      <Dialog open={syncPreview !== null} onOpenChange={open => !open && setSyncPreview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {syncPreview && syncPreview.ready > 0
                ? `Attach ${syncPreview.ready} page${syncPreview.ready === 1 ? '' : 's'}?`
                : 'Nothing to attach'}
            </DialogTitle>
            <DialogDescription>
              {syncPreview && syncPreview.ready > 0 ? (
                <>
                  Found in {syncPreview.chapters} chapter
                  {syncPreview.chapters === 1 ? '' : 's'}. These pages will be marked done.
                  {syncPreview.skipped > 0 && <> {syncPreview.skipped} already attached.</>}
                  {syncPreview.failed > 0 && <> {syncPreview.failed} cannot be attached.</>}
                </>
              ) : (
                <>
                  No new crop JSON was found in this series&apos; Processed folders.
                  {syncPreview && syncPreview.skipped > 0 && (
                    <> {syncPreview.skipped} page{syncPreview.skipped === 1 ? ' is' : 's are'} already attached.</>
                  )}
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[50vh] pr-3">
            <div className="space-y-4">
              {(syncPreview?.results ?? []).map(chapter => {
                // Already-attached pages are counted in the summary above but
                // not listed: they are the bulk of a re-run and would bury the
                // handful of pages this dialog exists to show.
                const shown = chapter.pages.filter(page => page.status !== 'skipped')
                if (shown.length === 0) return null

                return (
                  <div key={chapter.chapterId}>
                    <p className="text-sm font-medium mb-1">Chapter {chapter.chapterNumber}</p>
                    <div className="space-y-1.5">
                      {shown.map(page => (
                        <div
                          key={`${chapter.chapterId}-${page.folder}`}
                          className={`text-xs rounded p-2 flex items-start gap-2 ${
                            page.status === 'ready' ? 'bg-muted' : 'bg-destructive/10'
                          }`}
                        >
                          {page.status === 'ready' ? (
                            <FileCheck2 className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-green-500" />
                          ) : (
                            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-destructive" />
                          )}
                          <span className="min-w-0">
                            <span className="font-mono">{page.filename ?? page.folder}</span>
                            {page.status === 'ready' ? (
                              <span className="text-muted-foreground">
                                {' '}— {page.cropCount} crop{page.cropCount === 1 ? '' : 's'}
                              </span>
                            ) : (
                              <span className="text-muted-foreground"> — {page.reason}</span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </ScrollArea>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setSyncPreview(null)}>
              Cancel
            </Button>
            <Button onClick={confirmSync} disabled={!syncPreview || syncPreview.ready === 0}>
              Proceed
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The Unsync picker: which chapters to clear. Each row carries its
          attached count from the summary already on screen, so a chapter with
          nothing to remove is visible before it is ticked rather than after
          the scan comes back empty. */}
      <Dialog open={unsyncPicker} onOpenChange={open => !open && setUnsyncPicker(false)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Unsync chapters</DialogTitle>
            <DialogDescription>
              Pick the chapters whose crop JSON should be removed. Their pages go back to
              pending. The files in <span className="font-mono">Processed/</span> are kept,
              so Sync json can re-attach them.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {unsyncPicked.size === 0
                ? 'Nothing selected'
                : `${unsyncPicked.size} chapter${unsyncPicked.size === 1 ? '' : 's'} selected`}
            </span>
            {/* Only chapters that HAVE something attached are offered to
                "select all": ticking the rest adds nothing to remove and
                inflates the count the confirmation is read against. */}
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => {
                const attachedChapters = seriesChapters.filter(
                  c => (summaries[c.id]?.attachedImages ?? 0) > 0
                )
                setUnsyncPicked(
                  unsyncPicked.size === attachedChapters.length
                    ? new Set()
                    : new Set(attachedChapters.map(c => c.id))
                )
              }}
            >
              {unsyncPicked.size > 0 ? 'Clear all' : 'Select all attached'}
            </Button>
          </div>

          <ScrollArea className="max-h-[45vh] pr-3">
            <div className="space-y-1">
              {seriesChapters.map(chapter => {
                const attached = summaries[chapter.id]?.attachedImages ?? 0
                const picked = unsyncPicked.has(chapter.id)

                // A chapter with nothing attached is shown but not selectable:
                // hiding it would read as a missing chapter, and offering it
                // would promise a removal that does nothing.
                const empty = attached === 0

                return (
                  <div
                    key={chapter.id}
                    role="button"
                    tabIndex={empty ? -1 : 0}
                    aria-disabled={empty}
                    onClick={() => !empty && toggleUnsyncPick(chapter.id)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        if (!empty) toggleUnsyncPick(chapter.id)
                      }
                    }}
                    className={`flex items-center gap-2 rounded p-2 text-sm ${
                      empty
                        ? 'opacity-50 cursor-not-allowed'
                        : `cursor-pointer ${picked ? 'bg-accent' : 'hover:bg-muted'}`
                    }`}
                  >
                    <Checkbox
                      checked={picked}
                      disabled={empty}
                      onCheckedChange={() => !empty && toggleUnsyncPick(chapter.id)}
                      className="flex-shrink-0"
                    />
                    <span className="truncate min-w-0 flex-1">
                      Chapter {chapter.number}
                      {chapter.title ? ` · ${chapter.title}` : ''}
                    </span>
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      {empty
                        ? 'nothing attached'
                        : `${attached} page${attached === 1 ? '' : 's'}`}
                    </span>
                  </div>
                )
              })}
            </div>
          </ScrollArea>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setUnsyncPicker(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => scanForUnsync([...unsyncPicked])}
              disabled={unsyncPicked.size === 0 || unsyncScanning}
            >
              {unsyncScanning && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {unsyncScanning ? 'Checking…' : 'Continue'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unsync step one: how many attached pages the selected chapters are
          actually carrying. Pages are listed per chapter — the count is the
          decision, so it has to be visible before Proceed, not after. */}
      <Dialog open={unsyncPreview !== null} onOpenChange={open => !open && setUnsyncPreview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {unsyncPreview && unsyncPreview.attached > 0
                ? `Unsync ${unsyncPreview.attached} page${unsyncPreview.attached === 1 ? '' : 's'}?`
                : 'Nothing to unsync'}
            </DialogTitle>
            <DialogDescription>
              {unsyncPreview && unsyncPreview.attached > 0 ? (
                <>
                  Across {unsyncPreview.chapters} chapter
                  {unsyncPreview.chapters === 1 ? '' : 's'}. Their crop pointers and metadata
                  will be removed and the pages go back to pending. The files in{' '}
                  <span className="font-mono">Processed/</span> are kept, so Sync json can
                  re-attach them.
                </>
              ) : (
                <>None of the selected chapters have crop JSON attached.</>
              )}
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[50vh] pr-3">
            <div className="space-y-4">
              {(unsyncPreview?.results ?? []).map(chapter => (
                <div key={chapter.chapterId}>
                  <p className="text-sm font-medium mb-1">
                    Chapter {chapter.chapterNumber}
                    <span className="text-muted-foreground font-normal">
                      {' '}— {chapter.attached} page{chapter.attached === 1 ? '' : 's'}
                    </span>
                  </p>
                  <div className="space-y-1.5">
                    {chapter.pages.map(page => (
                      <div
                        key={`${chapter.chapterId}-${page.filename}`}
                        className="text-xs rounded bg-muted p-2 flex items-start gap-2"
                      >
                        <Unlink className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="font-mono">{page.filename}</span>
                          {/* A page carrying only one half is called out: it
                              reads as pending in the list, so seeing it here
                              would otherwise look like a miscount. */}
                          {!page.hadMetadata && (
                            <span className="text-muted-foreground"> — pointers only</span>
                          )}
                          {!page.hadPoints && (
                            <span className="text-muted-foreground"> — metadata only</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setUnsyncPreview(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmUnsync}
              disabled={!unsyncPreview || unsyncPreview.attached === 0}
            >
              Unsync
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Every page the unsync could not clear, with the reason. */}
      <Dialog open={unsyncReport !== null} onOpenChange={open => !open && setUnsyncReport(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Pages that could not be unsynced</DialogTitle>
            <DialogDescription>
              These pages still have their crop JSON attached. Everything else in the run
              was removed.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[50vh] pr-3">
            <div className="space-y-4">
              {(unsyncReport ?? []).map(chapter => (
                <div key={chapter.chapterId}>
                  <p className="text-sm font-medium mb-1">Chapter {chapter.chapterNumber}</p>
                  <div className="space-y-1.5">
                    {chapter.pages.filter(page => page.status === 'failed').map(page => (
                      <div
                        key={`${chapter.chapterId}-${page.filename}`}
                        className="text-xs rounded bg-destructive/10 p-2"
                      >
                        <span className="font-mono">{page.filename}</span>
                        <span className="text-muted-foreground"> — {page.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Every page Sync json could not attach, with the reason it gave. The
          reasons are the validator's own words — the same text the workspace
          shows when a paste is rejected — so a fix made here and a fix made
          there are the same fix. */}
      <Dialog open={syncReport !== null} onOpenChange={open => !open && setSyncReport(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Pages that could not be attached</DialogTitle>
            <DialogDescription>
              These pages were left untouched. Everything else in the run was attached or
              was already done.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[50vh] pr-3">
            <div className="space-y-4">
              {(syncReport ?? []).map(chapter => (
                <div key={chapter.chapterId}>
                  <p className="text-sm font-medium mb-1">Chapter {chapter.chapterNumber}</p>
                  <div className="space-y-1.5">
                    {chapter.pages.filter(page => page.status === 'failed').map(page => (
                      <div
                        key={`${chapter.chapterId}-${page.folder}`}
                        className="text-xs rounded bg-destructive/10 p-2"
                      >
                        <span className="font-mono">{page.filename ?? page.folder}</span>
                        <span className="text-muted-foreground"> — {page.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  )
}
