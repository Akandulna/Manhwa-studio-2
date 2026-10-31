import ManagedCropReview from '../sleeper/ManagedCropReview'
/**
 * Clipper3Preview — Module 3 v3: Image Clipper 3.0
 *
 * The whole chapter shown together, but drawn the way 3.0 actually works: the
 * images are simply stacked one after another, and each image's pointers are
 * drawn against ITS OWN 0.0–1.0 box.
 *
 * This is the visible difference from 2.0's viewer, which normalizes every
 * pointer against one stitched canvas. Here a crop's `y: 0` means the top of
 * its own image, not the top of the chapter — so each overlay is positioned
 * inside its own image's frame and nothing is offset by what came before it.
 *
 * Pointer editing is delegated to CropPointerEditor (shared with the
 * per-image dialog in Clipper3ImageList) — this page just stacks one per
 * image with editing always enabled. A chapter-local session autosaves each
 * completed adjustment and keeps Undo history across all pages.
 *
 * It is also where the desktop reviews a chapter the Master phone did not:
 * the footer under the last page marks the whole chapter reviewed (Crop
 * Sections waits for that, as it does for a Master phone review) and moves on
 * to the next chapter. Chapters reviewed on the phone are cut by Sync json
 * already; editing one here and pressing Crop Sections re-cuts it. A chapter
 * already cut counts as reviewed, so its footer just says so.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  ArrowLeft,
  Loader2,
  AlertTriangle,
  ZoomIn,
  ZoomOut,
  Undo2,
  Check,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  ShieldAlert,
  Scissors,
  ChevronRight
} from 'lucide-react'
import {
  clipper3Api,
  type Clipper3ChapterImages,
  type Clipper3ChapterReview
} from '@/lib/api'
import { useToast } from '@/components/ui/use-toast'
import { CropPointerEditor, type CropMetadataEntry } from '@/components/clipper3/CropPointerEditor'
import ChapterSwitcher from '@/components/ChapterSwitcher'
import { CropReviewSession, type CropReviewPage } from '@/lib/cropReviewSession'

/**
 * Reads one image's metadata document into a crop-id -> entry map for the rail.
 *
 * Best-effort by design: the store keeps this document verbatim and never
 * parses it, so anything that isn't JSON with a `crops` array yields an empty
 * map and the rail just says there's no description. It never throws, because
 * a malformed document on one page must not take down the whole preview.
 */
function parseMetadataByCropId(content: string): Record<string, CropMetadataEntry> {
  if (!content.trim()) return {}
  let parsed: any
  try {
    parsed = JSON.parse(content)
  } catch {
    return {}
  }
  if (!Array.isArray(parsed?.crops)) return {}

  const out: Record<string, CropMetadataEntry> = {}
  for (const entry of parsed.crops) {
    if (typeof entry?.id !== 'string' || !entry.id) continue
    out[entry.id] = {
      id: entry.id,
      description: typeof entry.description === 'string' ? entry.description : undefined,
      exportedFilename: typeof entry.exportedFilename === 'string' ? entry.exportedFilename : undefined
    }
  }
  return out
}

/** "on phone (Redmi Note 10 Pro)" / "on desktop", plus when. */
function describeReview(review: Clipper3ChapterReview): string {
  const where = review.by === 'phone'
    ? `on phone${review.device ? ` (${review.device})` : ''}`
    : review.by === 'desktop' ? 'on desktop' : null
  const when = review.reviewedAt ? new Date(review.reviewedAt).toLocaleString() : null
  return ['Reviewed', where, when].filter(Boolean).join(' · ')
}

/** "Cropped · <time> — counts as reviewed". */
function describeCropped(review: Clipper3ChapterReview): string {
  const when = review.croppedAt ? new Date(review.croppedAt).toLocaleString() : null
  return ['Cropped', when].filter(Boolean).join(' · ') + ' — counts as reviewed'
}

/** Header chip beside the crop count. */
function ReviewBadge({ review }: { review: Clipper3ChapterReview }) {
  if (review.reviewed && review.cropped) {
    return (
      <Badge variant="success" className="flex items-center gap-1 flex-shrink-0" title={describeCropped(review)}>
        <Scissors className="h-3 w-3" />
        Cropped
      </Badge>
    )
  }
  return review.reviewed ? (
    <Badge variant="success" className="flex items-center gap-1 flex-shrink-0" title={describeReview(review)}>
      <ShieldCheck className="h-3 w-3" />
      Reviewed
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="flex items-center gap-1 flex-shrink-0 text-amber-500 border-amber-500/50"
      title="Crop Sections waits until the chapter is marked reviewed — at the bottom of this page, or on the Master phone"
    >
      <ShieldAlert className="h-3 w-3" />
      Not reviewed
    </Badge>
  )
}

// Keyed by chapter so Previous/Next remounts the page with fresh per-file state.
export default function Clipper3Preview() {
  const { id } = useParams<{ id: string }>()
  return <Clipper3ChapterPreview key={id} />
}

function Clipper3ChapterPreview() {
  const { id: chapterId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()
  const [savingReview, setSavingReview] = useState(false)

  const [data, setData] = useState<Clipper3ChapterImages | null>(null)
  const [session, setSession] = useState<CropReviewSession | null>(null)
  const [, refreshSession] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(0.4)
  const [draggingFile, setDraggingFile] = useState<string | null>(null)
  const [navOpen, setNavOpen] = useState(true)

  // Which image is currently in view, so the nav panel can highlight it.
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const scrollToImage = useCallback((filename: string) => {
    const el = cardRefs.current[filename]
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveFile(filename)
  }, [])

  useEffect(() => {
    if (!chapterId) return
    let cancelled = false
    setLoading(true)

    clipper3Api.getImages(chapterId)
      .then(async fresh => {
        if (cancelled) return
        setData(fresh)

        // Keep the original metadata text so Undo can restore removed crops
        // together with their descriptions and exported filenames.
        const entries = await Promise.all(
          fresh.images.filter(img => img.status === 'done' && !img.managed).map(async img => {
            const [points, metadata] = await Promise.all([
              clipper3Api.getImagePoints(chapterId, img.filename).catch(() => null),
              clipper3Api.getImageMetadata(chapterId, img.filename).catch(() => ({ content: '' }))
            ])
            return [img.filename, points?.file ? { file: points.file, metadata: metadata.content } : null] as const
          })
        )
        if (cancelled) return
        const pages: Record<string, CropReviewPage> = {}
        for (const [filename, page] of entries) if (page) pages[filename] = page
        setSession(new CropReviewSession(pages, fresh.seriesTitle, {
          putPoints: (filename, file) => clipper3Api.putImagePoints(chapterId, filename, JSON.stringify(file, null, 2)),
          putMetadata: (filename, content) => clipper3Api.putImageMetadata(chapterId, filename, content)
        }, () => { if (!cancelled) refreshSession(version => version + 1) }))
      })
      .catch(err => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load this chapter')
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [chapterId])

  // Highlight whichever card is nearest the top of the viewport as the user
  // scrolls by hand, so the nav panel reflects where they actually are rather
  // than only where they last clicked.
  useEffect(() => {
    if (!data) return
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (visible) {
          const filename = (visible.target as HTMLElement).dataset.filename
          if (filename) setActiveFile(filename)
        }
      },
      { rootMargin: '-10% 0px -80% 0px', threshold: 0 }
    )
    Object.values(cardRefs.current).forEach(el => { if (el) observer.observe(el) })
    return () => observer.disconnect()
  }, [data, loading])

  // Warn only while work is unsaved, rather than whenever a page is editable.
  useEffect(() => {
    if (!session?.pending && !draggingFile) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [session?.pending, draggingFile])

  const canLeave = useCallback(() => {
    if (!session?.pending && !draggingFile) return true
    toast({
      title: session?.errors.size ? 'Changes have not been saved' : 'Pointers are still saving',
      description: session?.errors.size ? 'Use Retry save before leaving this chapter.' : 'Finish the adjustment and wait for autosave to complete.'
    })
    return false
  }, [session, draggingFile, toast])

  /** The footer's Mark reviewed / Unmark. */
  const setReviewed = useCallback(async (reviewed: boolean) => {
    if (!chapterId || !canLeave()) return
    setSavingReview(true)
    try {
      const review = await clipper3Api.setChapterReview(chapterId, reviewed)
      setData(prev => prev && { ...prev, review })
    } catch (err) {
      toast({
        title: reviewed ? 'Could not mark reviewed' : 'Could not unmark',
        description: err instanceof Error ? err.message : 'Failed to save the review',
        variant: 'destructive'
      })
    } finally {
      setSavingReview(false)
    }
  }, [chapterId, toast, canLeave])

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

  const managedChapter=!!data?.images.some(image=>image.managed)
  const totalCrops = Object.values(session?.pages ?? {}).reduce((n, page) => n + page.file.crops.length, 0)+(data?.images.filter(image=>image.managed).reduce((total,image)=>total+image.cropCount,0)??0)
  const saveErrors = [...(session?.errors.entries() ?? [])]
  const unsaved = !!session?.pending || draggingFile != null
  const chapterLabel = `Chapter ${data.number}${data.title ? ` · ${data.title}` : ''}`

  return (
    <div className="flex flex-col h-full">
      <div className="border-b bg-card px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { if (canLeave()) navigate(`/clipper3/chapter/${chapterId}`) }}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setNavOpen(o => !o)}
          title={navOpen ? 'Hide image list' : 'Show image list'}
        >
          {navOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
        </Button>
        <span className="text-sm font-medium truncate">{chapterLabel}</span>
        <Badge variant="secondary" className="flex-shrink-0">
          {totalCrops} crop{totalCrops === 1 ? '' : 's'}
        </Badge>
        {data.review && (managedChapter?<Badge variant={data.review.reviewed?'success':'secondary'}>{data.review.reviewed?'Managed cuts verified':'Managed page review / cut'}</Badge>:<ReviewBadge review={data.review} />)}

        <span
          role="status"
          className={`text-xs flex items-center gap-1 ${saveErrors.length ? 'text-red-500' : 'text-muted-foreground'}`}
          title={saveErrors.map(([filename, message]) => `${filename}: ${message}`).join('\n') || (managedChapter?'Managed pages use their exact revision review controls. Other pages autosave.':'All pages are editable. Changes save automatically after each adjustment.')}
        >
          {saveErrors.length ? <AlertTriangle className="h-3 w-3" /> : unsaved ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          {saveErrors.length ? 'Save failed' : unsaved ? 'Saving…' : managedChapter?'Page review controls':'Autosave on'}
        </span>
        {saveErrors.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => session?.retry()} disabled={session?.saving}>
            Retry save
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={!session?.undoFilename || draggingFile != null || savingReview}
          title={session?.undoFilename ? `Undo last pointer edit on ${session.undoFilename}` : 'No pointer edits to undo'}
          onClick={() => {
            const filename = session?.undo()
            if (filename) scrollToImage(filename)
          }}
        >
          <Undo2 className="h-3.5 w-3.5 mr-1" />
          Undo
        </Button>

        <div className="flex items-center gap-1 ml-auto">
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={draggingFile != null}
            onClick={() => setZoom(z => Math.max(0.1, z - 0.1))}
            title="Zoom out"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs text-muted-foreground w-12 text-center">{Math.round(zoom * 100)}%</span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={draggingFile != null}
            onClick={() => setZoom(z => Math.min(1.5, z + 0.1))}
            title="Zoom in"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div>
          <ChapterSwitcher
            neighbours={data.neighbours}
            to={id => `/clipper3/chapter/${id}/preview`}
            canLeave={canLeave}
          />
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Jump-to-image panel. Thumbnails rather than filenames alone: at 14+
            near-identical page names, the picture is what the user actually
            recognises. */}
        {navOpen && (
          <div className="w-56 flex-shrink-0 border-r bg-card flex flex-col min-h-0">
            <div className="px-3 py-2 border-b flex-shrink-0">
              <p className="text-xs font-medium text-muted-foreground">
                {data.images.length} image{data.images.length === 1 ? '' : 's'}
              </p>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-1">
                {data.images.map((img, index) => {
                  const file = session?.pages[img.filename]?.file
                  const cropCount = file?.crops.length ?? (img.managed?img.cropCount:0)
                  const isActive = activeFile === img.filename
                  return (
                    <div
                      key={img.filename}
                      className={`rounded transition-colors ${
                        isActive ? 'bg-primary/15 ring-1 ring-primary' : 'hover:bg-muted'
                      }`}
                    >
                      <button
                        onClick={() => scrollToImage(img.filename)}
                        className="w-full flex items-center gap-2 p-1.5 text-left"
                        title={img.filename}
                      >
                        <span className="text-[10px] text-muted-foreground w-5 text-right flex-shrink-0">
                          {index + 1}
                        </span>
                        <img
                          src={clipper3Api.getImageUrl(chapterId!, img.filename)}
                          alt={img.filename}
                          loading="lazy"
                          draggable={false}
                          className="h-10 w-10 object-cover rounded border flex-shrink-0 bg-muted"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11px] font-mono truncate">{img.filename}</span>
                          <span className="block text-[10px] text-muted-foreground">
                            {cropCount > 0 ? `${cropCount} crop${cropCount === 1 ? '' : 's'}` : 'no crops'}
                          </span>
                        </span>
                      </button>
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          </div>
        )}

        <ScrollArea className="flex-1 bg-neutral-950">
        {/* Images stacked in order. Each one is its own positioning context, so
            its pointers are placed against its own box — never a chapter-wide
            canvas. A ring + alternating tint + gap between cards makes clear
            where one image ends and the next begins. */}
        <div className="flex flex-col items-center gap-6 py-6">
          {data.images.map((img, index) => {
            const file = session?.pages[img.filename]?.file
            const isEven = index % 2 === 0
            if(img.managed)return <div key={img.filename} ref={el=>{cardRefs.current[img.filename]=el}} data-filename={img.filename} className="w-full max-w-3xl rounded border bg-card p-3">
              <p className="mb-2 text-sm font-medium">#{index+1} · {img.filename} · Managed page</p>
              <p className="mb-3 text-sm text-muted-foreground">Review the proposed crops below. Use Adjust boundaries / flag feedback to save corrections before approving any cuts.</p>
              {img.managed.pageId?<ManagedCropReview pageId={img.managed.pageId} taskId={img.managed.taskId} onChanged={()=>{void clipper3Api.getChapterReview(chapterId!).then(review=>setData(previous=>previous?{...previous,review}:previous))}}/>:<p>Sync the exact source page before reviewing this managed task.</p>}
            </div>
            if (!file) return null

            return (
              <div
                key={img.filename}
                ref={el => { cardRefs.current[img.filename] = el }}
                data-filename={img.filename}
                className="relative ring-2 ring-offset-4 ring-offset-neutral-950 rounded-sm p-0 scroll-mt-4"
                style={{
                  // @ts-expect-error CSS custom property for the ring color
                  '--tw-ring-color': isEven ? '#3b82f6' : '#f97316'
                }}
              >
                <span
                  className="absolute text-[11px] font-mono px-1.5 py-0.5 rounded font-semibold"
                  style={{
                    top: 4,
                    left: 4,
                    background: isEven ? '#3b82f6' : '#f97316',
                    color: '#0a0a0a',
                    pointerEvents: 'none',
                    zIndex: 40
                  }}
                >
                  #{index + 1} · {img.filename}
                  {file.crops.length > 0 ? ` · ${file.crops.length} crop${file.crops.length === 1 ? '' : 's'}` : ''}
                </span>

                <div className="pt-8">
                  <CropPointerEditor
                    chapterId={chapterId!}
                    filename={img.filename}
                    width={img.width}
                    height={img.height}
                    zoom={zoom}
                    seriesTitle={data.seriesTitle}
                    initialFile={file}
                    idleAccent={isEven ? '#3b82f6' : '#f97316'}
                    reviewMode
                    hideInlineTrigger
                    metadataByCropId={parseMetadataByCropId(session?.pages[img.filename]?.metadata ?? '')}
                    showMetadataRail
                    onInteractionChange={dragging => setDraggingFile(dragging ? img.filename : null)}
                    onCommit={(next, removedCropId) => {
                      try {
                        session?.commit(img.filename, next, removedCropId)
                      } catch (error) {
                        toast({
                          title: 'Could not update pointers',
                          description: error instanceof Error ? error.message : 'Unknown error',
                          variant: 'destructive'
                        })
                      }
                    }}
                  />
                </div>
              </div>
            )
          })}

          {/* The end of the chapter is where a review finishes, so the mark
              lives here rather than in the header: reaching it means every
              page above was scrolled past. */}
          <div className="w-full max-w-xl mx-auto rounded-md border border-neutral-800 bg-card p-4 flex flex-wrap items-center gap-3">
            {managedChapter ? <p className="text-sm">Review and cut each managed page using its controls above. Chapter completion follows those verified page results.</p> : data.review?.reviewed && data.review.cropped ? (
              // Cut already, which counts as reviewed: nothing to mark, and
              // Crop Sections stays available for a re-cut.
              <span className="text-sm flex items-center gap-1.5 text-green-500 min-w-0">
                <Scissors className="h-4 w-4 flex-shrink-0" />
                <span className="truncate">{describeCropped(data.review)}</span>
              </span>
            ) : data.review?.reviewed ? (
              <>
                <span className="text-sm flex items-center gap-1.5 text-green-500 min-w-0">
                  <ShieldCheck className="h-4 w-4 flex-shrink-0" />
                  <span className="truncate">{describeReview(data.review)}</span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setReviewed(false)}
                  disabled={savingReview || unsaved}
                  title="Crop Sections is blocked again until the chapter is re-marked"
                >
                  Unmark
                </Button>
              </>
            ) : (
              <>
                <span className="text-sm text-muted-foreground">End of chapter {data.number}.</span>
                <Button
                  size="sm"
                  onClick={() => setReviewed(true)}
                  disabled={savingReview || unsaved}
                  title={unsaved ? 'Waiting for pointer changes to save' : 'Allow Crop Sections for this chapter'}
                >
                  {savingReview ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ShieldCheck className="h-4 w-4 mr-1" />}
                  Mark reviewed
                </Button>
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={!data.neighbours.next}
              title={data.neighbours.next ? `Chapter ${data.neighbours.next.number}` : 'No later downloaded chapter'}
              onClick={() => {
                const next = data.neighbours.next
                if (next && canLeave()) navigate(`/clipper3/chapter/${next.id}/preview`)
              }}
            >
              Next chapter
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
        </ScrollArea>
      </div>
    </div>
  )
}
