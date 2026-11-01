import { RejectPageButton } from '@/components/clipper3/RejectPageButton'
/**
 * Clipper3ImageList — Module 3 v3: Image Clipper 3.0
 *
 * Reached from Clipper3SeriesView by clicking a chapter. Lists every page of
 * the chapter with its own crop status, and holds the chapter's two actions:
 *
 *  - Preview — every page with its crop boxes, to look over / fix them and
 *    mark the chapter reviewed (Clipper3Preview).
 *  - Crop Sections — cut the Done pages into crops3/. Waits for the chapter to
 *    be reviewed, on the Master phone or in Preview. A chapter reviewed on the
 *    phone is normally cut already: Sync json sends it to crop by itself.
 *
 * The crop JSON itself comes from the Sleeper-Cell phones through Sync json.
 * A page is Done only once it has BOTH its crop JSON and metadata that still
 * matches it — read from the server per page, never inferred from another
 * page's crops. Clicking a page with crops opens it alone in the box editor.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { useSocket, type Clipper3UnresolvedPage } from '@/lib/socket'
import {
  ArrowLeft,
  Loader2,
  AlertTriangle,
  Images,
  CheckCircle2,
  Clock,
  Eye,
  ChevronRight,
  ScanEye,
  Scissors,
  ShieldCheck,
  ShieldAlert
} from 'lucide-react'
import {
  clipper3Api,
  Clipper3NotReviewedError,
  type Clipper3ChapterImages,
  type Clipper3ChapterReview,
  type Clipper3Image
} from '@/lib/api'
import { CropPointerEditor } from '@/components/clipper3/CropPointerEditor'
import { formatTook, PhonePageBadge, PhoneWorkingBadge } from '@/components/PhoneSyncBadge'
import { usePhoneCrops } from '@/hooks/usePhoneCrops'
import { PhoneRefreshButton } from '@/components/PhoneRefreshButton'
import ChapterSwitcher from '@/components/ChapterSwitcher'

// Keyed by chapter so Previous/Next remounts the page: its per-file state is
// keyed by filename, and filenames repeat from chapter to chapter.
export default function Clipper3ImageList() {
  const { id } = useParams<{ id: string }>()
  return <Clipper3ChapterImageList key={id} />
}

function Clipper3ChapterImageList() {
  const { id: chapterId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()
  const {
    clipper3CropProgress,
    clipper3CropComplete
  } = useSocket()

  const [data, setData] = useState<Clipper3ChapterImages | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isCropping, setIsCropping] = useState(false)

  // Pages whose metadata names crops the cut did not produce. Held in state
  // rather than shown only as a toast: this is the one moment the mismatch is
  // cheap to explain, and a toast is gone before the user can act on it.
  const [unresolvedPages, setUnresolvedPages] = useState<Clipper3UnresolvedPage[]>([])

  // One page's crop boxes, drawn and drag-adjustable — a quick check (or fix)
  // without opening the whole chapter in Preview.
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)

  const images = data?.images ?? []
  const doneCount = useMemo(() => images.filter(i => i.status === 'done').length, [images])

  // Crop pointers the Sleeper-Cell phone is making for this chapter: each page's
  // state there, and the page its Auto-run is on. Live through the phone relay;
  // without it, re-read from R2 only when "Refresh from phone" asks.
  // Pages match by filename, which the R2 zip carries to the phone unchanged.
  const phoneCropsReceipt = usePhoneCrops(data?.seriesId, chapterId)
  const phoneCrops = phoneCropsReceipt.status
  const phoneChapter = chapterId ? phoneCrops?.chapters[chapterId] : undefined
  // Auto-run can be on several pages of this chapter at once (one per ChatGPT tab).
  const phoneWorkingPages = useMemo(
    () => (phoneCrops?.workingPages ?? []).filter(w => w.chapterId === chapterId),
    [phoneCrops, chapterId]
  )
  const phoneWorkingByPage = useMemo(() => new Map(phoneWorkingPages.map(w => [w.page, w])), [phoneWorkingPages])
  // Average time per page the phone timed in this chapter (older phone builds send no times).
  const phoneAvgTook = useMemo(() => {
    const times = Object.values(phoneCrops?.finished ?? {}).flatMap(f => (f.took === null ? [] : [f.took]))
    return times.length ? times.reduce((sum, t) => sum + t, 0) / times.length : null
  }, [phoneCrops])
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    if (!chapterId) return
    let cancelled = false
    setLoading(true)

    clipper3Api.getImages(chapterId)
      .then(fresh => { if (!cancelled) setData(fresh) })
      .catch(err => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load this chapter')
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [chapterId])

  const previewImage: Clipper3Image | null =
    previewIndex != null ? images[previewIndex] ?? null : null

  // Mount-time snapshot: the socket context keeps the last event of each kind
  // forever, so one already present describes a run that ended before this page
  // loaded and must not toast or reload here.
  const handledCrop = useRef(clipper3CropComplete)

  useEffect(() => {
    const event = clipper3CropComplete
    if (!event || event === handledCrop.current) return
    handledCrop.current = event
    if (event.chapterId !== chapterId) return

    setIsCropping(false)
    // The header's Cropped marker is read from disk with the image list.
    clipper3Api.getImages(event.chapterId).then(setData).catch(() => { /* the old list stays */ })

    if (event.error) {
      toast({ title: 'Crop sections failed', description: event.error, variant: 'destructive' })
      return
    }

    const failed = event.failed ?? 0
    const unresolved = event.unresolved ?? []
    setUnresolvedPages(unresolved)

    const unresolvedCount = unresolved.reduce((n, page) => n + page.missing.length, 0)
    toast({
      title: failed > 0
        ? 'Cropped with failures'
        : event.auto ? 'Cropped automatically (reviewed on phone)' : 'Crop sections saved',
      description:
        `${event.exported ?? 0} section${event.exported === 1 ? '' : 's'} from ` +
        `${event.images ?? 0} image${event.images === 1 ? '' : 's'}` +
        `${failed > 0 ? `, ${failed} failed` : ''}.` +
        (event.removed ? ` Replaced the previous cut (${event.removed} old file${event.removed === 1 ? '' : 's'} removed).` : '') +
        // Named in the toast as well as the banner, so a run left unattended
        // still says something was wrong when the user comes back to it.
        (unresolvedCount > 0
          ? ` ${unresolvedCount} metadata name${unresolvedCount === 1 ? '' : 's'} on ` +
            `${unresolved.length} page${unresolved.length === 1 ? '' : 's'} match no file.`
          : ''),
      variant: failed > 0 || unresolvedCount > 0 ? 'destructive' : undefined
    })
  }, [clipper3CropComplete, chapterId, toast])

  // A cut this page did not start — the auto crop after Sync json, or one
  // started before the page opened — still owns the Crop button.
  const cropProgress = clipper3CropProgress?.chapterId === chapterId ? clipper3CropProgress : null
  useEffect(() => {
    if (cropProgress) setIsCropping(true)
  }, [cropProgress])

  const unresolvedNameCount = unresolvedPages.reduce((n, page) => n + page.missing.length, 0)

  /** Cuts every Done image using its own page-local coordinates. */
  const startCropSections = useCallback(async () => {
    if (!chapterId) return
    setIsCropping(true)
    // The previous run's report describes a crops3/ that is about to be
    // rewritten, so it must not outlive the cut that produced it.
    setUnresolvedPages([])
    try {
      await clipper3Api.crop(chapterId)
    } catch (error) {
      setIsCropping(false)
      if (error instanceof Clipper3NotReviewedError) {
        // The button is disabled for this already; reaching here means the
        // review was unmarked elsewhere (or a phone fetch reset it) since the
        // list loaded, so the list is re-read to match.
        clipper3Api.getImages(chapterId).then(setData).catch(() => { /* the old list stays */ })
        toast({ title: 'Chapter not reviewed yet', description: error.message, variant: 'destructive' })
        return
      }
      toast({
        title: 'Could not start cropping',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive'
      })
    }
  }, [chapterId, toast])

  // ============ Render ============

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!data || loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <AlertTriangle className="h-8 w-8 text-amber-500" />
        <p>{loadError || 'Failed to load this chapter'}</p>
        <Button variant="outline" size="sm" onClick={() => navigate('/clipper3')}>
          Back to Image Clipper 3.0
        </Button>
      </div>
    )
  }

  const chapterLabel = `Chapter ${data.number}${data.title ? ` · ${data.title}` : ''}`

  return (
    <div className="flex flex-col h-full">
      <div className="border-b bg-card px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/clipper3/series/${data.seriesId}`)}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <span className="text-sm font-medium truncate">{chapterLabel}</span>
        <span className="text-xs text-muted-foreground flex items-center gap-1 ml-2">
          <Images className="h-3.5 w-3.5" />
          {images.length} file{images.length === 1 ? '' : 's'}
        </span>
        <span className="text-xs text-muted-foreground ml-auto">
          {doneCount}/{images.length} done
        </span>
        <ChapterReviewBadge review={data.review} />
        <CropOutputsBadge outputs={data.cropOutputs} />

        <ChapterSwitcher neighbours={data.neighbours} to={id => `/clipper3/chapter/${id}`} />

        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`/clipper3/chapter/${chapterId}/preview`)}
          disabled={doneCount === 0}
          title={doneCount === 0 ? 'No image has crop pointers yet' : 'See every image with its crop boxes, fix them, mark the chapter reviewed'}
        >
          <ScanEye className="h-4 w-4 mr-1" />
          Preview
        </Button>

        {/* Wrapped so the reason shows on hover: a disabled button gets no
            pointer events, so its own title never appears. Cropping waits
            for the whole chapter to be reviewed (Preview or Master phone). */}
        <span
          title={
            data.images.some(image=>image.managed)
              ? 'Use Preview to review and cut each exact managed page'
              : doneCount === 0
              ? 'No image has crop pointers yet'
              : !data.review?.reviewed
                ? 'Mark reviewed first (Preview or Master phone)'
                : 'Cut every Done image into its sections'
          }
        >
          <Button
            variant="outline"
            size="sm"
            onClick={startCropSections}
            disabled={isCropping || doneCount === 0 || !data.review?.reviewed || data.images.some(image=>image.managed)}
          >
            {isCropping ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Scissors className="h-4 w-4 mr-1" />
            )}
            Crop Sections
          </Button>
        </span>
        <Button variant="outline" size="sm" disabled={isCropping || !data.review?.reviewed || data.images.some(image=>image.managed)}
          onClick={async()=>{
            try {
              const response=await fetch(`/api/clipper3/chapters/${chapterId}/metadata/sync`,{method:'POST'})
              const result=await response.json()
              if(!response.ok)throw new Error(result.error||'Metadata synchronization failed')
              toast({title:'Metadata · AI Studio',description:`${result.queued??0} approved page jobs queued; ${result.imported??0} metadata pages imported.${result.errors?.length?' '+result.errors.join('; '):''}`})
              window.location.reload()
            }catch(error){toast({title:'Metadata is not ready',description:error instanceof Error?error.message:String(error),variant:'destructive'})}
          }}>Sync Metadata</Button>
      </div>

      {/* The Sleeper-Cell phone's progress on this chapter, re-read only when
          asked. Tapping the Processing chip scrolls to the page it is on. */}
      {phoneCrops?.configured && (
        <div className="border-b bg-card px-4 py-2 flex flex-wrap items-center gap-3 flex-shrink-0">
          <PhoneRefreshButton receipt={phoneCropsReceipt} />
          {phoneChapter && (
            <span
              className="text-xs text-muted-foreground"
              title={phoneCrops.device ? `Sleeper-Cell on ${phoneCrops.device}` : 'Sleeper-Cell'}
            >
              {phoneChapter.done}/{phoneChapter.total} pages done on phone
              {phoneAvgTook !== null && ` · avg ${formatTook(phoneAvgTook)}/page`}
            </span>
          )}
          {phoneWorkingPages.map(working => (
            <button
              key={working.page}
              type="button"
              className="min-w-0"
              onClick={() => rowRefs.current.get(working.page)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
            >
              <PhoneWorkingBadge page={working.page} paused={working.paused} device={working.phone ?? phoneCrops.device} />
            </button>
          ))}
        </div>
      )}

      {cropProgress && (
        <div className="border-b bg-card px-4 py-2 flex items-center gap-3 flex-shrink-0">
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {cropProgress.auto ? 'Auto crop (reviewed on phone) · ' : ''}
            Cutting {cropProgress.current}/{cropProgress.total}
          </span>
          <Progress
            value={cropProgress.total > 0 ? (cropProgress.current / cropProgress.total) * 100 : 0}
            className="flex-1 h-2"
          />
          <span className="text-xs text-muted-foreground font-mono truncate max-w-[200px]">
            {cropProgress.filename}
          </span>
        </div>
      )}

      {unresolvedPages.length > 0 && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 flex-shrink-0">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-destructive">
                {unresolvedNameCount} metadata name{unresolvedNameCount === 1 ? '' : 's'} on{' '}
                {unresolvedPages.length} page{unresolvedPages.length === 1 ? '' : 's'} match no file in
                crops3/
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Save {unresolvedPages.length === 1 ? 'this page' : 'these pages'} again in Preview (the
                names are rebuilt from the crop boxes on save) or re-sync from the phone, then crop
                again. Left as they are, Editor 2.0 cannot resolve them.
              </p>
              <ul className="mt-1 space-y-0.5">
                {unresolvedPages.map(page => (
                  <li key={page.imageFilename} className="text-[11px] font-mono text-muted-foreground">
                    <span className="text-foreground">{page.imageFilename}</span>{' '}
                    <span className="text-destructive">
                      {page.missing.length}/{page.total}
                    </span>
                    {/* First one only: the whole list overflows the banner, and
                        one example is enough to recognise which cut is stale. */}
                    <span className="ml-1 truncate">— {page.missing[0]}</span>
                    {page.missing.length > 1 && <span> +{page.missing.length - 1} more</span>}
                  </li>
                ))}
              </ul>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] flex-shrink-0"
              onClick={() => setUnresolvedPages([])}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-2">
          {images.map((img, index) => {
            const isDone = img.status === 'done'
            const canPreview = img.cropCount > 0
            const phonePage = phoneCrops?.pages[img.filename]
            const phoneWorking = phoneWorkingByPage.get(img.filename) ?? null
            const phoneOnThis = phoneWorking !== null
            return (
              <Card
                key={img.filename}
                ref={el => {
                  if (el) rowRefs.current.set(img.filename, el)
                  else rowRefs.current.delete(img.filename)
                }}
                className={`transition-colors ${canPreview ? 'cursor-pointer hover:border-primary' : ''} ${
                  phoneOnThis ? 'border-sky-500 ring-2 ring-sky-500/40' : ''
                }`}
                onClick={() => { if (canPreview) setPreviewIndex(index) }}
              >
                <CardContent className="p-3 flex items-center gap-3">
                  {/* The phone's Auto-run points at the page it is on. */}
                  <span className="text-xs text-muted-foreground w-8 flex-shrink-0 flex items-center justify-end">
                    {phoneOnThis ? (
                      <ChevronRight
                        className={`h-5 w-5 text-sky-500 ${phoneWorking?.paused ? '' : 'animate-pulse'}`}
                        aria-label="The phone is on this page"
                      />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <img
                    src={clipper3Api.getImageUrl(chapterId!, img.filename)}
                    alt={img.filename}
                    loading="lazy"
                    draggable={false}
                    className="h-14 w-14 object-cover rounded border flex-shrink-0 bg-muted"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-mono truncate">{img.filename}</p>
                    <p className="text-xs text-muted-foreground truncate" title={img.metadataErrors.join(' ') || undefined}>
                      {img.width} × {img.height}px
                      {img.cropCount > 0 && ` · ${img.cropCount} crop${img.cropCount === 1 ? '' : 's'}`}
                      {/* A half-finished row says which piece it is still waiting on.
                          Invalid metadata shows the ACTUAL reason from the server
                          (e.g. which crop ids don't match) rather than a generic
                          "something's wrong" — that's the whole point of surfacing it. */}
                      {!isDone && !img.hasPoints && !img.hasMetadata && ' · no crop JSON yet — Sync json'}
                      {img.hasPoints && !img.hasMetadata && ' · metadata follows manual review and cropping'}
                      {!isDone && !img.hasPoints && img.hasMetadata && ' · needs crop JSON'}
                      {!isDone && img.hasPoints && img.hasMetadata && !img.metadataValid && (
                        img.metadataErrors.length > 0
                          ? ` · ${img.metadataErrors.join(' ')}`
                          : ' · metadata no longer matches these crops'
                      )}
                    </p>
                  </div>
                  {phoneOnThis && phoneWorking ? (
                    <PhoneWorkingBadge page={img.filename} paused={phoneWorking.paused} device={phoneWorking.phone ?? phoneCrops?.device ?? null} showPage={false} />
                  ) : phonePage && (
                    <PhonePageBadge state={phonePage} device={phoneCrops?.finished[img.filename]?.phone ?? phoneCrops?.device ?? null} finish={phoneCrops?.finished[img.filename]} />
                  )}
                  {!img.managed && (img.hasPoints || img.hasMetadata || img.redo?.status === 'pending') &&
                    <RejectPageButton chapterId={chapterId!} filename={img.filename} redo={img.redo} disabled={isCropping}
                      onChanged={() => { setPreviewIndex(null); void clipper3Api.getImages(chapterId!).then(setData) }} />}
                  {isDone ? (
                    <Badge variant="success" className="flex items-center gap-1 flex-shrink-0">
                      <CheckCircle2 className="h-3 w-3" />
                      Done
                    </Badge>
                  ) : img.hasMetadata && !img.metadataValid ? (
                    <Badge
                      variant="destructive"
                      className="flex items-center gap-1 flex-shrink-0"
                      title={img.metadataErrors.join(' ') || 'Metadata no longer matches these crops'}
                    >
                      <AlertTriangle className="h-3 w-3" />
                      Invalid metadata
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="flex items-center gap-1 text-muted-foreground flex-shrink-0">
                      <Clock className="h-3 w-3" />
                      Pending
                    </Badge>
                  )}

                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7 flex-shrink-0"
                    title={canPreview ? "Preview this image's crop boxes" : 'No crop boxes to preview yet'}
                    disabled={!canPreview}
                    onClick={e => { e.stopPropagation(); setPreviewIndex(index) }}
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </ScrollArea>

      {/* One image's crop boxes, drawn and drag-adjustable — a quick visual
          check (or fix) without leaving the list. */}
      <Dialog open={previewIndex != null} onOpenChange={open => { if (!open) setPreviewIndex(null) }}>
        <DialogContent className="w-[95vw] max-w-6xl h-[92vh] flex flex-col p-4 sm:p-6">
          {previewImage && (
            <>
              <DialogHeader className="flex-shrink-0">
                <DialogTitle className="font-mono text-sm truncate">{previewImage.filename}</DialogTitle>
              </DialogHeader>

              {/* Zoom is driven by WIDTH only, deliberately never clamped to
                  the dialog's height: source pages here run extremely tall
                  (800x10480 is typical), and fitting height as well would
                  crush the width down with it — the crop boxes becoming a
                  sliver too thin to read. Vertical overflow is exactly what
                  this container's own scrollbar is for. */}
              <div className="flex-1 min-h-0 overflow-auto">
                <CropPointerEditor
                  chapterId={chapterId!}
                  filename={previewImage.filename}
                  width={previewImage.width}
                  height={previewImage.height}
                  zoom={Math.min(1, (window.innerWidth * 0.95 - 64) / previewImage.width)}
                  seriesTitle={data.seriesTitle}
                  onSaved={stored => {
                    setData(prev => prev && {
                      ...prev,
                      images: prev.images.map(i =>
                        i.filename === previewImage.filename
                          ? { ...i, cropCount: stored.cropCount, status: stored.status, hasPoints: true }
                          : i
                      )
                    })
                  }}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Whether the whole chapter is reviewed — Crop Sections waits for it. */
function ChapterReviewBadge({ review }: { review: Clipper3ChapterReview }) {
  // A previous cut implies review; CropOutputsBadge shows the current output
  // status without duplicating Cropped or hiding out-of-date crops.
  if (review.reviewed && review.cropped) return null
  if (review.reviewed) {
    const onPhone = review.by === 'phone'
    return (
      <Badge
        variant="success"
        className="flex items-center gap-1 flex-shrink-0"
        title={[
          onPhone ? `Reviewed on ${review.device || 'the Master phone'}` : 'Reviewed in Preview',
          review.reviewedAt ? new Date(review.reviewedAt).toLocaleString() : null
        ].filter(Boolean).join(' · ')}
      >
        <ShieldCheck className="h-3 w-3" />
        {onPhone ? 'Reviewed on phone' : 'Reviewed in Preview'}
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="flex items-center gap-1 flex-shrink-0 text-amber-500 border-amber-500/50"
      title="Crop Sections waits until the chapter is marked reviewed — at the bottom of Preview, or on the Master phone"
    >
      <ShieldAlert className="h-3 w-3" />
      Not reviewed
    </Badge>
  )
}

/** Whether the chapter's cut in crops3/ is finished and matches every page. */
function CropOutputsBadge({ outputs }: { outputs: Clipper3ChapterImages['cropOutputs'] }) {
  if (outputs.complete) {
    return (
      <Badge variant="success" className="flex items-center gap-1 flex-shrink-0" title={`${outputs.files} crops in crops3/`}>
        <CheckCircle2 className="h-3 w-3" />
        Cropped
      </Badge>
    )
  }
  if (outputs.files === 0) return null

  const reasons = [
    outputs.missing > 0 && `${outputs.missing} crop${outputs.missing === 1 ? '' : 's'} not cut yet`,
    outputs.extra > 0 && `${outputs.extra} old file${outputs.extra === 1 ? '' : 's'} the next cut will remove`,
    outputs.changed > 0 && `${outputs.changed} page${outputs.changed === 1 ? '' : 's'} edited since ${outputs.changed === 1 ? 'it was' : 'they were'} cut`
  ].filter(Boolean)
  return (
    <Badge
      variant="outline"
      className="flex items-center gap-1 flex-shrink-0 text-amber-500 border-amber-500/50"
      title={reasons.length > 0 ? `Crop Sections again: ${reasons.join(', ')}.` : 'Some pages are not done yet.'}
    >
      <Scissors className="h-3 w-3" />
      Crops out of date
    </Badge>
  )
}
