import { useSeriesOrder } from '@/hooks/useSeriesOrder'
/**
 * Clipper3Library — Module 3 v3: Image Clipper 3.0
 *
 * Landing page: the manhwa list. Selecting a series opens its chapters
 * (Clipper3SeriesView), and a chapter its pages (Clipper3ImageList), where
 * the crop boxes made on the Sleeper-Cell phones are previewed and cut.
 * "Get from phones" pulls the Master phone's downloaded pages into the library.
 * "Publish cropped chapters" tells the phones which chapters are already cut
 * (R2 `<Chapter>.cropped.json` markers), so the Master shows them as Cropped
 * and clipping phones leave them alone.
 *
 * Per-series progress is read from clipper3Api's own summary (crops +
 * metadata attached for every page).
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Locate,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Globe,
  Image as ImageIcon,
  Scissors,
  Smartphone,
  UploadCloud
} from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import {
  clipper3Api,
  type Clipper3Chapter,
  type Clipper3Series,
  type Clipper3ChapterSummary
} from '@/lib/api'
import { usePublishedChapters } from '@/hooks/usePublishedChapters'
import { SeriesCompletedBadge } from '@/components/PublishedBadge'
import { PhonePullDialog } from '@/components/PhonePullDialog'

// ============ Page ============

export default function Clipper3Library() {
  // Parts completed on the Storage page (files deleted, continuity kept).
  const { seriesCompletedParts } = usePublishedChapters()
  const [seriesList, setSeriesList] = useState<Clipper3Series[]>([])
  const orderedSeries = useSeriesOrder(seriesList)
  const [chapters, setChapters] = useState<Clipper3Chapter[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /**
   * Clipper 3's own per-chapter progress, keyed by chapter id. `chopped` is
   * read from crops3/ on disk, which is the fact this module produces. Empty until the summaries resolve — the rows then re-render.
   */
  const [summaries, setSummaries] = useState<Record<string, Clipper3ChapterSummary>>({})
  /** Get from phones: the Master phone's downloaded chapters, pulled from R2. */
  const [pullOpen, setPullOpen] = useState(false)
  /** Bumped after a pull so the listing reloads with the new chapters. */
  const [reloadKey, setReloadKey] = useState(0)
  const { toast } = useToast()
  const [publishingCropped, setPublishingCropped] = useState(false)

  /**
   * Writes the cropped markers R2 is missing, for every series. New cuts
   * publish their own; this is for chapters cut before markers existed.
   */
  const publishCropped = useCallback(async () => {
    setPublishingCropped(true)
    try {
      const result = await clipper3Api.publishCroppedMarkers()
      if (!result.configured) {
        toast({ title: 'Cloudflare R2 is not set up', description: 'Nothing was published.', variant: 'destructive' })
        return
      }
      const n = result.published.length
      toast({
        title: n > 0
          ? `Published ${n} cropped chapter${n === 1 ? '' : 's'}`
          : 'The phones already know every cropped chapter',
        description: [
          result.series > 0 ? `${result.series} series with cut chapters checked` : 'No chapter has been cut yet',
          result.failed.length > 0
            ? `${result.failed.length} failed: ${result.failed.slice(0, 3).map(f => `${f.series}/${f.folder}`).join(', ')}${result.failed.length > 3 ? '…' : ''}`
            : null
        ].filter(Boolean).join(' · '),
        variant: result.failed.length > 0 ? 'destructive' : undefined
      })
    } catch (err) {
      toast({
        title: 'Could not publish cropped chapters',
        description: err instanceof Error ? err.message : 'Failed to reach R2',
        variant: 'destructive'
      })
    } finally {
      setPublishingCropped(false)
    }
  }, [toast])

  useEffect(() => {
    let cancelled = false

    // Settled independently on purpose: a failed series listing must not hide
    // the chapter error, and the other way round.
    Promise.allSettled([clipper3Api.getChapters(), clipper3Api.getSeries()])
      .then(([listing, seriesResult]) => {
        if (cancelled) return
        if (listing.status === 'fulfilled') setChapters(listing.value)
        else {
          setError(listing.reason instanceof Error ? listing.reason.message : 'Failed to load chapters')
        }
        if (seriesResult.status === 'fulfilled') setSeriesList(seriesResult.value)
        setLoading(false)
      })

    return () => { cancelled = true }
  }, [reloadKey])

  // Only series with at least one downloaded chapter.
  const seriesWithChapters = useMemo(
    () => seriesList.filter(s => chapters.some(c => c.seriesId === s.id)),
    [seriesList, chapters]
  )

  // Per-series, because that is the shape the endpoint has. Settled
  // independently so one unreadable series folder leaves the other rows'
  // counts intact rather than blanking the whole list.
  useEffect(() => {
    if (seriesWithChapters.length === 0) return
    let cancelled = false

    Promise.allSettled(
      seriesWithChapters.map(s => clipper3Api.getSeriesSummary(s.id))
    ).then(results => {
      if (cancelled) return
      const next: Record<string, Clipper3ChapterSummary> = {}
      for (const result of results) {
        if (result.status !== 'fulfilled') continue
        for (const summary of result.value.chapters) next[summary.chapterId] = summary
      }
      setSummaries(next)
    })

    return () => { cancelled = true }
  }, [seriesWithChapters])

  const header = (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          <Locate className="h-7 w-7 text-primary" />
          <h1 className="text-3xl font-bold">Image Clipper 3.0</h1>
        </div>
        <p className="text-muted-foreground mt-1">
          The Sleeper-Cell phones mark each page&apos;s crop boxes. Sync json brings them in,
          Preview checks and fixes them, and Crop cuts the images. Chapters reviewed on the
          Master phone are cut as soon as they sync.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="outline"
          onClick={publishCropped}
          disabled={publishingCropped}
          title="Mark every chapter already cut as Cropped for the phones (the Master won't review them)"
        >
          {publishingCropped ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UploadCloud className="h-4 w-4 mr-2" />}
          Publish cropped chapters
        </Button>
        <Button variant="outline" onClick={() => setPullOpen(true)}>
          <Smartphone className="h-4 w-4 mr-2" />
          Get from phones
        </Button>
      </div>
    </div>
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="p-6">
      {header}

      {error && (
        <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded p-2 mb-6">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* The empty state is suppressed when the listing itself failed: "nothing is
          ready" would be a claim about the library this page could not make. */}
      {chapters.length === 0 && !error && (
        <div className="text-center py-12">
          <Locate className="h-16 w-16 mx-auto text-muted-foreground mb-4 opacity-30" />
          <h2 className="text-xl font-semibold mb-2">No Chapters Yet</h2>
          <p className="text-muted-foreground max-w-md mx-auto">
            Download chapters in the Library, or on the Master phone and bring them
            here with Get from phones.
          </p>
        </div>
      )}

      {seriesWithChapters.length > 0 && (
        <Card className="overflow-hidden divide-y">
          {orderedSeries.filter(s => chapters.some(c => c.seriesId === s.id)).map(s => {
            const seriesChapters = chapters.filter(c => c.seriesId === s.id)
            // Done here means "every page has its crops and matching metadata",
            // the same bar Clipper 3's own chapter list calls fully attached.
            // Chapters with no summary row yet (still loading, or a folder the
            // server could not read) count as not-done rather than being dropped
            // from the denominator, so the bar never overstates progress.
            const done = seriesChapters.filter(c => summaries[c.id]?.fullyAttached).length
            // Cut output is tracked separately: a chapter can be re-synced
            // after being cut, so this is a note on the row, not the progress.
            const chopped = seriesChapters.filter(c => summaries[c.id]?.chopped).length
            const progress = seriesChapters.length > 0 ? Math.round((done / seriesChapters.length) * 100) : 0
            return (
              <Link
                key={s.id}
                to={`/clipper3/series/${s.id}`}
                className="flex items-center gap-4 px-4 py-3 hover:bg-accent/50 transition-colors"
              >
              <div className="h-10 w-10 shrink-0 rounded-md bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                <Scissors className="h-5 w-5 text-primary/40" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <h3 className="font-semibold truncate">{s.title}</h3>
                  <SeriesCompletedBadge parts={seriesCompletedParts(s.id)} />
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Globe className="h-3 w-3 shrink-0" />
                  <span className="truncate">{s.sourceSite}</span>
                </div>
              </div>

                <div className="hidden md:flex items-center gap-1.5 shrink-0">
                  {chopped > 0 && (
                    <Badge
                      variant="outline"
                      className="flex items-center gap-1"
                      title={`${chopped} of ${seriesChapters.length} chapters have cut output in crops3/`}
                    >
                      <Scissors className="h-3 w-3" />
                      {chopped} cut
                    </Badge>
                  )}
                </div>

                <span className="w-24 shrink-0 text-sm text-muted-foreground text-right">
                  {seriesChapters.length} chapters
                </span>

                <div className="hidden sm:flex w-36 shrink-0 items-center gap-2">
                  <Progress value={progress} className="h-1 flex-1" />
                  <span className="w-9 text-xs text-muted-foreground text-right">{progress}%</span>
                </div>

                <div className="w-32 shrink-0 flex justify-end">
                  {progress === 100 ? (
                    <Badge variant="success" className="flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      Complete
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="flex items-center gap-1">
                      <ImageIcon className="h-3 w-3" />
                      {done}/{seriesChapters.length}
                    </Badge>
                  )}
                </div>
              </Link>
            )
          })}
        </Card>
      )}

      <PhonePullDialog open={pullOpen} onOpenChange={setPullOpen} onPulled={() => setReloadKey(k => k + 1)} />
    </div>
  )
}
