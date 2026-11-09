/**
 * AntiGravity → one chapter's Preview, without leaving AntiGravity: every page
 * with its crop pointers (Image Clipper 3.0's own preview and autosave), Mark
 * reviewed / Unmark at the end of the chapter, and Crop Sections beside it.
 * Review and cropping use the same Clipper endpoints, so a chapter reviewed or
 * cut here is reviewed or cut everywhere.
 */

import { useEffect, useRef, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { Loader2, Scissors } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { clipper3Api, Clipper3NotReviewedError } from '@/lib/api'
import { clipperPartNumber } from '@/lib/clipperParts'
import { useSocket } from '@/lib/socket'
import { Clipper3ChapterPreview, type ChapterPreviewFooterContext } from '../clipper3/Clipper3Preview'
import { AntiGravityTopBar, chapterLabel, useSeriesScope } from './shared'

/** Crop Sections for the previewed chapter; waits for the chapter review like Clipper's own button. */
function CropSectionsButton({ chapterId, data, unsaved, refreshReview }: ChapterPreviewFooterContext) {
  const { clipper3CropProgress, clipper3CropComplete } = useSocket()
  const { toast } = useToast()
  const [starting, setStarting] = useState(false)
  const progress = clipper3CropProgress?.chapterId === chapterId ? clipper3CropProgress : null
  // The socket keeps the last finished cut forever; only one finishing after this mounted counts.
  const handled = useRef(clipper3CropComplete)

  useEffect(() => {
    const event = clipper3CropComplete
    if (!event || event === handled.current) return
    handled.current = event
    if (event.chapterId !== chapterId) return
    setStarting(false)
    refreshReview()
    if (event.error) return void toast({ title: 'Crop Sections failed', description: event.error, variant: 'destructive' })
    const failed = event.failed ?? 0
    toast({
      title: failed ? 'Cropped with failures' : 'Crop Sections saved',
      description: `${event.exported ?? 0} section${event.exported === 1 ? '' : 's'} from ${event.images ?? 0} page${event.images === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.`,
      variant: failed ? 'destructive' : undefined
    })
  }, [clipper3CropComplete, chapterId, refreshReview, toast])

  if (data.images.some(image => image.managed)) return null
  const reviewed = !!data.review?.reviewed
  const donePages = data.images.filter(image => image.status === 'done').length
  const busy = starting || !!progress
  const blocked = !reviewed ? 'Mark the chapter reviewed first' : unsaved ? 'Waiting for pointer changes to save' : donePages === 0 ? 'No page has pointers yet' : null

  const start = async () => {
    setStarting(true)
    try {
      await clipper3Api.crop(chapterId)
    } catch (error) {
      setStarting(false)
      if (error instanceof Clipper3NotReviewedError) refreshReview()
      toast({ title: error instanceof Clipper3NotReviewedError ? 'Chapter not reviewed yet' : 'Could not start cropping', description: (error as Error).message, variant: 'destructive' })
    }
  }

  return (
    <Button size="sm" variant={data.review?.cropped ? 'outline' : 'default'} disabled={busy || !!blocked} title={blocked ?? `Cut the ${donePages} page${donePages === 1 ? '' : 's'} with pointers into crop sections`} onClick={() => void start()}>
      {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Scissors className="mr-1 h-4 w-4" />}
      {progress ? `Cutting ${progress.current}/${progress.total}` : busy ? 'Starting…' : data.review?.cropped ? 'Crop again' : 'Crop Sections'}
    </Button>
  )
}

export default function AntiGravityChapterPreview() {
  const { seriesId, partNumber, chapterId } = useParams()
  const scope = useSeriesScope(seriesId)
  const chapter = scope.chapters.find(c => c.id === chapterId)
  // The part comes from the chapter itself, so the switcher can cross into the next part.
  const part = chapter ? clipperPartNumber(chapter.number) : Number(partNumber)
  if (!chapterId || !Number.isInteger(part) || part < 1) return <Navigate to={`/antigravity/series/${seriesId}`} replace />
  const title = scope.series?.title ?? 'Series'
  const clipperPage = `/antigravity/series/${seriesId}/parts/${part}/image-clipper`
  const hrefFor = (id: string) => {
    const other = scope.chapters.find(c => c.id === id)
    return `/antigravity/series/${seriesId}/parts/${other ? clipperPartNumber(other.number) : part}/chapters/${id}`
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 px-6 pt-4 pb-3">
        <AntiGravityTopBar crumbs={[
          { label: 'AntiGravity', to: '/antigravity' },
          { label: title, to: `/antigravity/series/${seriesId}` },
          { label: `Part ${part}`, to: `/antigravity/series/${seriesId}/parts/${part}` },
          { label: 'Image Clipper', to: clipperPage },
          { label: chapter ? `${chapterLabel(chapter)} · Preview` : 'Preview' }
        ]} />
      </div>
      <div className="min-h-0 flex-1 border-t">
        <Clipper3ChapterPreview
          key={chapterId}
          chapterId={chapterId}
          backTo={clipperPage}
          chapterHref={hrefFor}
          footerExtra={context => <CropSectionsButton {...context} />}
        />
      </div>
    </div>
  )
}
