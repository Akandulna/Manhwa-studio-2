import { canBulkCrop, clipperChapterParts } from '@/lib/clipperParts'
import { CloudClipperPanel } from './CloudClipperPanel'
/**
 * Clipper3SeriesView — Module 3 v3: Image Clipper 3.0
 *
 * Chapter list for one series, reached from Clipper3Library after picking a
 * series. Clicking a chapter opens its pages (Clipper3ImageList).
 *
 * Sync json pulls the phones' finished-chapter zips from R2 and attaches them.
 * Every chapter the Master phone reviewed is then cut straight away on the
 * server, one chapter at a time — its progress shows here over the same
 * crop events Crop Sections uses. The other chapters wait for Preview → Crop.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { usePublishedChapters } from '@/hooks/usePublishedChapters'
import { CompletedBadge, PublishedBadge, completedRowClass, publishedRowClass } from '@/components/PublishedBadge'
import { PhoneCropsBadge } from '@/components/PhoneSyncBadge'
import { usePhoneCrops } from '@/hooks/usePhoneCrops'
import { PhoneRefreshButton } from '@/components/PhoneRefreshButton'
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom'
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
  Unlink,
  DownloadCloud,
  ShieldCheck,
  ShieldAlert,
  Replace
} from 'lucide-react'
import {
  clipper3Api,
  type Clipper3Chapter,
  type Clipper3ChapterSummary,
  type Clipper3ChapterSyncResult,
  type Clipper3ChapterUnsyncResult,
  type Clipper3SyncPreview,
  type Clipper3PhoneCropsFetch,
  type Clipper3UnsyncPreview
} from '@/lib/api'
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

/**
 * Whether the whole chapter has been reviewed — Crop Sections waits for it.
 * Shown once the chapter has crops at all; "Not reviewed" on a chapter with
 * nothing attached would be noise.
 */
function ReviewStatusBadge({ summary }: { summary: Clipper3ChapterSummary | undefined }) {
  if (!summary) return null
  const review = summary.review
  // A previous cut implies review. ChoppedStatusBadge owns the current crop
  // status, including when those outputs are now out of date.
  if (review?.reviewed && review.cropped) return null
  if (review?.reviewed) {
    const onPhone = review.by === 'phone'
    return (
      <Badge
        variant="success"
        className="flex items-center gap-1"
        title={[
          onPhone ? `Reviewed on ${review.device || 'the Master phone'}` : 'Reviewed in Preview',
          review.reviewedAt ? new Date(review.reviewedAt).toLocaleString() : null
        ].filter(Boolean).join(' · ')}
      >
        <ShieldCheck className="h-3 w-3" />
        {onPhone ? 'Reviewed on phone' : 'Reviewed'}
      </Badge>
    )
  }
  if (summary.attachedImages === 0) return null
  return (
    <Badge
      variant="outline"
      className="flex items-center gap-1 text-muted-foreground"
      title="Review the chapter on the Master phone or in Preview before Crop Sections"
    >
      <ShieldAlert className="h-3 w-3" />
      Not reviewed
    </Badge>
  )
}

/**
 * What Sync json pulled from R2 before scanning: which finished chapters were
 * downloaded from the phone's uploads, and any it couldn't place.
 */
function R2FetchSummary({ result }: { result: Clipper3PhoneCropsFetch }) {
  const { found, fetched, upToDate, unmatched, failed, cropped, reviewedMarkers } = result
  const pages = fetched.reduce((sum, c) => sum + c.pages, 0)
  return (
    <div className="rounded-md border p-3 text-sm space-y-1.5">
      <p className="flex items-center gap-2 font-medium">
        <DownloadCloud className="h-4 w-4 flex-shrink-0" />
        {found === 0
          ? 'No finished chapters from the phone in R2 yet'
          : fetched.length > 0
            ? `Fetched ${fetched.length} chapter${fetched.length === 1 ? '' : 's'} from R2 (${pages} page${pages === 1 ? '' : 's'})`
            : 'Nothing new from the phone in R2'}
      </p>
      {fetched.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {fetched.map(c => `Ch ${c.chapterNumber}${c.reviewed ? ' · reviewed on phone' : ''}`).join(', ')}
        </p>
      )}
      {upToDate > 0 && (
        <p className="text-xs text-muted-foreground">
          {upToDate} chapter{upToDate === 1 ? '' : 's'} already fetched earlier.
        </p>
      )}
      {unmatched.length > 0 && (
        <p className="text-xs text-destructive">
          No chapter folder named {unmatched.map(f => `"${f}"`).join(', ')} in this series — not fetched.
        </p>
      )}
      {cropped && cropped.published.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Told the phones {cropped.published.length} chapter{cropped.published.length === 1 ? ' is' : 's are'} already
          cropped: {cropped.published.join(', ')}.
        </p>
      )}
      {cropped?.failed.map(f => (
        <p key={`cropped-${f.folder}`} className="text-xs text-destructive">
          {f.folder}: could not mark as cropped in R2 — {f.reason}
        </p>
      ))}
      {reviewedMarkers && reviewedMarkers.published.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Told the phones {reviewedMarkers.published.length} chapter{reviewedMarkers.published.length === 1 ? ' is' : 's are'} reviewed
          here: {reviewedMarkers.published.join(', ')}.
        </p>
      )}
      {reviewedMarkers?.failed.map(f => (
        <p key={`reviewed-${f.folder}`} className="text-xs text-destructive">
          {f.folder}: could not mark as reviewed in R2 — {f.reason}
        </p>
      ))}
      {failed.map(f => (
        <p key={f.folder} className="text-xs text-destructive">
          {f.folder}: {f.reason}
        </p>
      ))}
    </div>
  )
}

/** Whether the chapter's crop/cut step has been run and produced output. */
function ChoppedStatusBadge({ summary, cropping }: { summary: Clipper3ChapterSummary | undefined; cropping: boolean }) {
  if (!summary) return null
  if (cropping) {
    return (
      <Badge variant="outline" className="flex items-center gap-1 text-sky-500 border-sky-500/50">
        <Loader2 className="h-3 w-3 animate-spin" />
        Cropping…
      </Badge>
    )
  }
  if (summary.cropComplete) {
    return (
      <Badge variant="success" className="flex items-center gap-1" title="Every page is cut and crops3/ matches them">
        <Scissors className="h-3 w-3" />
        Cropped
      </Badge>
    )
  }
  if (summary.chopped) {
    return (
      <Badge
        variant="outline"
        className="flex items-center gap-1 text-amber-500 border-amber-500/50"
        title="crops3/ no longer matches the pages — run Crop Sections again"
      >
        <Scissors className="h-3 w-3" />
        Crops out of date
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
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedPart = Number(searchParams.get('part')) || null
  const [startingCrop, setStartingCrop] = useState(false)
  const [cropReport, setCropReport] = useState<{ chapterNumber: number; reason: string }[] | null>(null)
  const [chapters, setChapters] = useState<Clipper3Chapter[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Chapters already rendered to video, so the user can skip re-cutting them.
  const { isPublished, completedPart } = usePublishedChapters(id)
  const [summaries, setSummaries] = useState<Record<string, Clipper3ChapterSummary>>({})
  // Crop pointers the Sleeper-Cell phone is making. Live through the phone
  // relay; without it, re-read from R2 only when "Refresh from phone" asks.
  const phoneCropsReceipt = usePhoneCrops(id)
  const phoneCrops = phoneCropsReceipt.status
  const phoneSeries = id ? phoneCrops?.series[id] : undefined

  const { toast } = useToast()
  const {
    clipper3CropProgress,
    clipper3CropComplete,
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

  // Before the scan, the phone's finished-chapter zips are pulled from R2 into
  // Processed/; what that did is shown at the top of the same dialog.
  const [fetchingR2, setFetchingR2] = useState(false)
  const [r2Fetch, setR2Fetch] = useState<Clipper3PhoneCropsFetch | null>(null)

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
  const handledCropComplete = useRef<unknown>(undefined)
  if (handledSliceComplete.current === undefined) handledSliceComplete.current = clipper3SliceComplete
  if (handledSyncComplete.current === undefined) handledSyncComplete.current = clipper3SyncComplete
  if (handledUnsyncComplete.current === undefined) handledUnsyncComplete.current = clipper3UnsyncComplete
  if (handledCropComplete.current === undefined) handledCropComplete.current = clipper3CropComplete

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
      description: `${parts} part${parts === 1 ? '' : 's'} across ${done} chapter${done === 1 ? '' : 's'}, written into each chapter's slices3 folder inside the series-named subfolder.`,
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
    setSyncReport(null)
    setR2Fetch(null)

    // A failed fetch doesn't stop the scan: files already in Processed/ can
    // still be attached, and the toast says R2 was not reached.
    setFetchingR2(true)
    try {
      const fetched = await clipper3Api.fetchPhoneCrops(id)
      setR2Fetch(fetched)
      // Every fetched zip rewrote its chapter's review, so the Reviewed chips
      // are re-read now rather than after the sync the user may cancel.
      if (fetched.fetched.length > 0) {
        clipper3Api.getSeriesSummary(id)
          .then(result => setSummaries(Object.fromEntries(result.chapters.map(c => [c.chapterId, c]))))
          .catch(() => {})
      }
    } catch (err) {
      toast({
        title: 'Could not fetch from R2',
        description: `${err instanceof Error ? err.message : 'Failed to reach R2'} — scanning local files only.`,
        variant: 'destructive'
      })
    } finally {
      setFetchingR2(false)
    }

    setScanning(true)
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

    const { imported = 0, replaced = 0, skipped = 0, failed = 0, results = [], autoCrop = [] } = clipper3SyncComplete

    // Newly attached pages change every Attached chip on the page, so the
    // rollup is re-fetched rather than patched from the result — the server
    // re-validates on read, which is the same check that decided the import.
    // A replaced page can put a chapter's cut out of date, so it counts too,
    // and a chapter sent to crop shows its Cropping chip from the same read.
    if (imported > 0 || replaced > 0 || autoCrop.length > 0) {
      clipper3Api.getSeriesSummary(id)
        .then(result => setSummaries(Object.fromEntries(result.chapters.map(c => [c.chapterId, c]))))
        .catch(() => {})
    }

    // Only failures get the dialog: a clean run is fully described by its
    // counts, and a modal over "nothing went wrong" is just another click.
    setSyncReport(failed > 0 ? results.filter(r => r.failed > 0) : null)

    toast({
      title: imported > 0
        ? `Attached ${imported} page${imported === 1 ? '' : 's'}`
        : replaced > 0
          ? `Updated ${replaced} page${replaced === 1 ? '' : 's'}`
          : 'Nothing new to attach',
      description: [
        imported > 0 && replaced > 0 ? `${replaced} page updates` : null,
        skipped > 0 ? `${skipped} already attached` : null,
        failed > 0 ? `${failed} could not be attached` : null,
        imported === 0 && replaced === 0 && skipped === 0 && failed === 0
          ? 'No Processed folders found in this series.'
          : null,
        // Reviewed on the Master phone, so they need no Preview here.
        autoCrop.length > 0
          ? `Reviewed on phone, sent to crop automatically: ${autoCrop.map(c => `Ch ${c.chapterNumber}`).join(', ')}`
          : null
      ].filter(Boolean).join(' · ') || undefined,
      variant: failed > 0 ? 'destructive' : undefined
    })
  }, [clipper3SyncComplete, id, toast])

  // A cut of one of this series' chapters finished — usually the auto crop
  // after Sync json. Its Cropped chip is re-read from disk.
  useEffect(() => {
    const event = clipper3CropComplete
    if (!event || event.seriesId !== id) return
    if (handledCropComplete.current === event) return
    handledCropComplete.current = event

    clipper3Api.getSeriesSummary(id!)
      .then(result => setSummaries(Object.fromEntries(result.chapters.map(c => [c.chapterId, c]))))
      .catch(() => {})

    const label = `Chapter ${event.chapterNumber ?? ''}`.trim()
    if (event.error) {
      toast({ title: `Cropping ${label} failed`, description: event.error, variant: 'destructive' })
      return
    }
    const failed = event.failed ?? 0
    toast({
      title: event.auto ? `${label} cropped automatically` : `${label} cropped`,
      description:
        `${event.exported ?? 0} section${event.exported === 1 ? '' : 's'} from ` +
        `${event.images ?? 0} image${event.images === 1 ? '' : 's'}` +
        `${failed > 0 ? `, ${failed} failed` : ''}` +
        (event.auto ? ' · reviewed on the Master phone.' : '.'),
      variant: failed > 0 ? 'destructive' : undefined
    })
  }, [clipper3CropComplete, id, toast])

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
    clipper3Api.getChapters()
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
  const chapterParts = useMemo(() => clipperChapterParts(seriesChapters), [seriesChapters])
  const visibleParts = selectedPart ? chapterParts.filter(part => part.number === selectedPart) : chapterParts
  const reviewedChapterIds = seriesChapters.filter(chapter =>
    completedPart(chapter.id) === null && canBulkCrop(summaries[chapter.id])
  ).map(chapter => chapter.id)
  const cropActive = Object.values(summaries).some(summary => summary.cropping)

  // The server owns the queue after navigation or a lost socket connection.
  useEffect(() => {
    if (!id || (!startingCrop && !cropActive)) return
    let cancelled = false
    const timer = window.setInterval(() => {
      clipper3Api.getSeriesSummary(id).then(result => {
        if (!cancelled) setSummaries(Object.fromEntries(result.chapters.map(chapter => [chapter.chapterId, chapter])))
      }).catch(() => {})
    }, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [id, startingCrop, cropActive])

  const cropReviewed = async (chapterIds: string[]) => {
    if (!id || startingCrop || chapterIds.length === 0) return
    setStartingCrop(true)
    setCropReport(null)
    try {
      const result = await clipper3Api.cropReviewed(id, chapterIds)
      // Reflect accepted queue entries immediately, including if the refresh fails.
      setSummaries(previous => {
        const next = { ...previous }
        for (const chapter of result.queued) {
          if (next[chapter.chapterId]) next[chapter.chapterId] = { ...next[chapter.chapterId], cropping: true }
        }
        return next
      })
      if (result.skipped.length) setCropReport(result.skipped)
      toast({
        title: result.queued.length ? `Queued ${result.queued.length} reviewed chapter${result.queued.length === 1 ? '' : 's'}` : 'No chapters need cropping',
        description: 'Chapters crop one at a time in the background. Review and page readiness are checked again before each cut.'
      })
      clipper3Api.getSeriesSummary(id)
        .then(result => setSummaries(Object.fromEntries(result.chapters.map(chapter => [chapter.chapterId, chapter]))))
        .catch(() => {})
    } catch (err) {
      toast({ title: 'Could not start cropping', description: err instanceof Error ? err.message : 'Failed to queue reviewed chapters', variant: 'destructive' })
    } finally {
      setStartingCrop(false)
    }
  }
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

  // Same bar as the library card: every page has crops and matching metadata.
  const attachedCount = seriesChapters.filter(c => summaries[c.id]?.fullyAttached).length
  const progress = seriesChapters.length > 0 ? Math.round((attachedCount / seriesChapters.length) * 100) : 0

  // Only this series' run: the socket carries every series' slice progress.
  const sliceProgress = clipper3SliceProgress?.seriesId === id ? clipper3SliceProgress : null
  const slicePercent = sliceProgress && sliceProgress.total > 0
    ? Math.round((sliceProgress.current / sliceProgress.total) * 100)
    : 0

  const syncProgress = clipper3SyncProgress?.seriesId === id ? clipper3SyncProgress : null
  const syncPercent = syncProgress && syncProgress.total > 0
    ? Math.round((syncProgress.current / syncProgress.total) * 100)
    : 0

  // A cut of one of this series' chapters, usually the auto crop after Sync json.
  const cropProgress = clipper3CropProgress?.seriesId === id ? clipper3CropProgress : null
  const cropPercent = cropProgress && cropProgress.total > 0
    ? Math.round((cropProgress.current / cropProgress.total) * 100)
    : 0

  const unsyncProgress = clipper3UnsyncProgress?.seriesId === id ? clipper3UnsyncProgress : null
  const unsyncPercent = unsyncProgress && unsyncProgress.total > 0
    ? Math.round((unsyncProgress.current / unsyncProgress.total) * 100)
    : 0

  // Any run that writes the store locks every button that writes the store, so
  // two of them can never be started over the same files.
  const busy = slicingAll || syncing || scanning || fetchingR2 || unsyncing || unsyncScanning || startingCrop || cropActive

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
              <span>{seriesChapters.length} chapters</span>
              <span>•</span>
              <span>{attachedCount} fully attached</span>
              {phoneSeries && (
                <>
                  <span>•</span>
                  <span title={phoneCrops?.device ? `Sleeper-Cell on ${phoneCrops.device}` : 'Sleeper-Cell'}>
                    {phoneSeries.done}/{phoneSeries.total} pages done on phone
                  </span>
                </>
              )}
              <PhoneRefreshButton receipt={phoneCropsReceipt} />
            </div>

            <div className="max-w-md mt-3">
              <div className="flex items-center justify-between text-sm mb-1">
                <span>Attach Progress</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>

            <CloudClipperPanel seriesId={id!} chapters={seriesChapters.map(c => ({id:c.id,label:`Chapter ${c.number}`}))} onImported={() => { void clipper3Api.getSeriesSummary(id!).then(result => setSummaries(Object.fromEntries(result.chapters.map(c => [c.chapterId,c])))).catch(() => {}) }} />

            {/* Separate from Attach Progress: this counts pages sliced across
                the whole series, not chapters that are fully attached. */}
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

            {cropProgress && (
              <div className="max-w-md mt-3">
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="truncate mr-2">
                    {cropProgress.auto ? 'Auto crop' : 'Cropping'} chapter {cropProgress.chapterNumber} ·{' '}
                    {cropProgress.current}/{cropProgress.total}
                    {cropProgress.auto && (
                      <span className="text-xs text-muted-foreground"> · reviewed on phone</span>
                    )}
                  </span>
                  <span className="flex-shrink-0">{cropPercent}%</span>
                </div>
                <Progress value={cropPercent} className="h-2" />
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
          <div className="flex flex-wrap justify-end items-center gap-2 max-w-xl">
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
                <Button
                  onClick={() => cropReviewed(reviewedChapterIds)}
                  disabled={busy || reviewedChapterIds.length === 0}
                  title="Crop all reviewed chapters in this series whose pages are fully attached and whose crops need updating"
                >
                  {startingCrop || cropActive ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Scissors className="h-4 w-4 mr-2" />}
                  {startingCrop ? 'Queueing…' : cropActive ? 'Cropping…' : `Crop Images (${reviewedChapterIds.length})`}
                </Button>

                {/* Attaching already-made files is a read of the disk, so it
                    needs no chapter selection — every chapter is scanned and
                    the ones with nothing in Processed/ cost nothing. */}
                <Button
                  variant="outline"
                  onClick={scanProcessed}
                  disabled={busy}
                  title="Fetch the phone's finished chapters from R2, then find crop pointers and metadata in each chapter's Processed folder"
                >
                  {fetchingR2 || scanning || syncing ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  {fetchingR2
                    ? 'Fetching from R2…'
                    : scanning
                      ? 'Scanning…'
                      : syncing
                        ? 'Syncing…'
                        : 'Sync json'}
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
        <div className="p-6 space-y-6">
          <div className="flex flex-wrap gap-2" aria-label="Chapter parts">
            <Button size="sm" variant={selectedPart === null ? 'default' : 'outline'} onClick={() => setSearchParams({})}>All chapters</Button>
            {chapterParts.map(part => (
              <Button key={part.number} size="sm" variant={selectedPart === part.number ? 'default' : 'outline'} onClick={() => setSearchParams({ part: String(part.number) })}>Part {part.number}</Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Crop Images processes reviewed chapters with every page attached. Chapters already cropped are skipped.</p>
          {visibleParts.length === 0 && <p className="text-sm text-muted-foreground">No chapters in this part. Choose All chapters to see the series.</p>}
          {visibleParts.map(part => {
            const ready = part.chapters.filter(chapter => reviewedChapterIds.includes(chapter.id)).map(chapter => chapter.id)
            return (
              <section key={part.number} aria-labelledby={`clipper-part-${part.number}`}>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div>
                    <h2 id={`clipper-part-${part.number}`} className="font-semibold">Part {part.number}</h2>
                    <p className="text-xs text-muted-foreground">Chapters {(part.number - 1) * 20 + 1}–{part.number * 20} · {part.chapters.length} chapters · {ready.length} ready to crop</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => cropReviewed(ready)} disabled={busy || ready.length === 0}>
                    <Scissors className="h-4 w-4 mr-2" />Crop Images ({ready.length})
                    <span className="sr-only"> in Part {part.number}</span>
                  </Button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {part.chapters.map(chapter => {
            const isSelected = selected.has(chapter.id)
            // A completed Part's pages and crops are deleted: shown, not opened.
            const completed = completedPart(chapter.id)

            // While selecting, the card toggles instead of navigating — so the
            // same card is a link in one mode and a checkbox row in the other.
            const card = (
              <Card className={`transition-colors group ${completed !== null ? 'cursor-default' : 'cursor-pointer'} ${
                isSelected ? 'border-primary bg-accent' : completed !== null ? '' : 'hover:border-primary'
              } ${completed !== null ? completedRowClass : isPublished(chapter.id) ? publishedRowClass : ''} ${
                phoneCrops?.workingPages.some(w => w.chapterId === chapter.id) ? 'ring-2 ring-sky-500/60' : ''
              }`}>
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
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {completed !== null ? (
                      <CompletedBadge part={completed} />
                    ) : (
                      <>
                        <AttachedStatusBadge summary={summaries[chapter.id]} />
                        <ChoppedStatusBadge
                          summary={summaries[chapter.id]}
                          cropping={cropProgress?.chapterId === chapter.id || (summaries[chapter.id]?.cropping ?? false)}
                        />
                        <ReviewStatusBadge summary={summaries[chapter.id]} />
                        {isPublished(chapter.id) && <PublishedBadge />}
                      </>
                    )}
                    {phoneCrops && (phoneCrops.chapters[chapter.id] || phoneCrops.workingPages.some(w => w.chapterId === chapter.id)) && (
                      <PhoneCropsBadge
                        done={phoneCrops.chapters[chapter.id]?.done ?? 0}
                        total={phoneCrops.chapters[chapter.id]?.total ?? chapter.pageCount}
                        working={phoneCrops.workingPages.filter(w => w.chapterId === chapter.id)}
                        device={phoneCrops.device}
                      />
                    )}
                  </div>
                </CardContent>
              </Card>
            )

            if (completed !== null) {
              return <div key={chapter.id} className="block cursor-default">{card}</div>
            }

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
              </section>
            )
          })}
        </div>
      </ScrollArea>

      <Dialog open={cropReport !== null} onOpenChange={open => !open && setCropReport(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Chapters not queued</DialogTitle>
            <DialogDescription>These chapters changed or cannot be cropped yet. Other eligible chapters were queued.</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[50vh]">
            <div className="space-y-2 text-sm">
              {cropReport?.map((chapter, index) => <p key={index}>Chapter {chapter.chapterNumber}: {chapter.reason}</p>)}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

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
                : syncPreview && syncPreview.replaced > 0
                  ? `Apply the phone review to ${syncPreview.replaced} page${syncPreview.replaced === 1 ? '' : 's'}?`
                  : 'Sync JSON'}
            </DialogTitle>
            <DialogDescription>
              {syncPreview && (syncPreview.ready > 0 || syncPreview.replaced > 0) ? (
                <>
                  Found in {syncPreview.chapters} chapter
                  {syncPreview.chapters === 1 ? '' : 's'}.
                  {syncPreview.ready > 0 && <> {syncPreview.ready} page{syncPreview.ready === 1 ? '' : 's'} will be marked done.</>}
                  {syncPreview.replaced > 0 && (
                    <> {syncPreview.replaced} page{syncPreview.replaced === 1 ? '' : 's'} will receive page updates; approved crops stay unchanged.</>
                  )}
                  {syncPreview.skipped > 0 && <> {syncPreview.skipped} already attached.</>}
                  {syncPreview.failed > 0 && <> {syncPreview.failed} cannot be attached.</>}
                </>
              ) : (
                <>
                  No new JSON is ready to attach. Requested page redos will appear after Sleeper Cell finishes and uploads them.
                  {syncPreview && syncPreview.skipped > 0 && (
                    <> {syncPreview.skipped} page{syncPreview.skipped === 1 ? ' is' : 's are'} already attached.</>
                  )}
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {r2Fetch?.configured && <R2FetchSummary result={r2Fetch} />}

          <ScrollArea className="max-h-[50vh] pr-3">
            <div className="space-y-4">
              {(syncPreview?.results ?? []).map(chapter => {
                // Already-attached pages are counted in the summary above but
                // not listed: they are the bulk of a re-run and would bury the
                // handful of pages this dialog exists to show. Replaced pages
                // ARE listed — they overwrite what is on screen today.
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
                            page.status === 'ready' ? 'bg-muted' : page.status === 'replaced' ? 'bg-sky-500/10' : 'bg-destructive/10'
                          }`}
                        >
                          {page.status === 'ready' ? (
                            <FileCheck2 className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-green-500" />
                          ) : page.status === 'replaced' ? (
                            <Replace className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-sky-500" />
                          ) : (
                            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-destructive" />
                          )}
                          <span className="min-w-0">
                            <span className="font-mono">{page.filename ?? page.folder}</span>
                            {page.status === 'ready' ? (
                              <span className="text-muted-foreground">
                                {' '}— {page.cropCount} crop{page.cropCount === 1 ? '' : 's'}
                              </span>
                            ) : page.status === 'replaced' ? (
                              <span className="text-muted-foreground">
                                {' '}— {page.cropCount} crop{page.cropCount === 1 ? '' : 's'} · {page.reason}
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
            <Button onClick={confirmSync} disabled={!syncPreview || (syncPreview.ready === 0 && syncPreview.replaced === 0)}>
              Sync JSON
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
