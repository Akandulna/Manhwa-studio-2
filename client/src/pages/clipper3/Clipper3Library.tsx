/**
 * Clipper3Library — Module 3 v3: Image Clipper 3.0
 *
 * Landing page for the four-pointer technique: a grid of series, "pick a
 * series first". Selecting a series
 * navigates to its chapter list (Clipper3SeriesView), which links into the
 * actual pointer workspace (Clipper3Workspace).
 *
 * Per-series progress is read from clipper3Api's own summary (crops +
 * metadata attached for every page).
 */

import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import {
  Locate,
  Loader2,
  AlertTriangle,
  FileText,
  CheckCircle2,
  Globe,
  Image as ImageIcon,
  Scissors
} from 'lucide-react'
import {
  clipper3Api,
  type Clipper3Chapter,
  type Clipper3Series,
  type Clipper3Status,
  type Clipper3ChapterSummary
} from '@/lib/api'

// ============ Helpers ============

function formatWhen(iso: string | null): string {
  if (!iso) return 'never'
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? 'unknown' : at.toLocaleString()
}

// ============ Page ============

export default function Clipper3Library() {
  const [status, setStatus] = useState<Clipper3Status | null>(null)
  const [seriesList, setSeriesList] = useState<Clipper3Series[]>([])
  const [chapters, setChapters] = useState<Clipper3Chapter[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /**
   * Clipper 3's own per-chapter progress, keyed by chapter id. `chopped` is
   * read from crops3/ on disk, which is the fact this module produces. Empty until the summaries resolve — the cards then re-render.
   */
  const [summaries, setSummaries] = useState<Record<string, Clipper3ChapterSummary>>({})
  /** For the phone profiles' ChatGPT upload counts, which aren't per series. */

  useEffect(() => {
    let cancelled = false

    // Settled independently on purpose: a failed status probe must not hide the
    // chapter list, and a failed listing must not hide the guidelines state.
    Promise.allSettled([clipper3Api.getStatus(), clipper3Api.getChapters(), clipper3Api.getSeries()])
      .then(([statusResult, listing, seriesResult]) => {
        if (cancelled) return
        if (statusResult.status === 'fulfilled') setStatus(statusResult.value)
        if (listing.status === 'fulfilled') setChapters(listing.value)
        else {
          setError(listing.reason instanceof Error ? listing.reason.message : 'Failed to load chapters')
        }
        if (seriesResult.status === 'fulfilled') setSeriesList(seriesResult.value)
        setLoading(false)
      })

    return () => { cancelled = true }
  }, [])

  // Only series with at least one chapter eligible for pointer detection.
  const seriesWithChapters = useMemo(
    () => seriesList.filter(s => chapters.some(c => c.seriesId === s.id)),
    [seriesList, chapters]
  )

  // Per-series, because that is the shape the endpoint has. Settled
  // independently so one unreadable series folder leaves the other cards'
  // counts intact rather than blanking the whole grid.
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
    <div className="mb-6">
      <div className="flex items-center gap-2">
        <Locate className="h-7 w-7 text-primary" />
        <h1 className="text-3xl font-bold">Image Clipper 3.0</h1>
      </div>
      <p className="text-muted-foreground mt-1">
        A vision model reads the crop guidelines and marks four crop pointers (P1–P4) per
        section into a JSON file; a second, fully deterministic pass cuts the images from
        those pointers.
      </p>
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

      {/* Status strip: the crop rules every run is judged against. */}
      <Card className="mb-6">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Guidelines</span>
              {status?.guidelinesPresent ? (
                <Badge variant={status.guidelinesIsDefault ? 'outline' : 'secondary'}>
                  {status.guidelinesIsDefault ? 'shipped default' : 'customised'}
                </Badge>
              ) : (
                <Badge variant="destructive">missing</Badge>
              )}
            </span>
            <span className="text-muted-foreground">
              Last edited {formatWhen(status?.guidelinesUpdatedAt ?? null)}
            </span>
            <Link to="/settings" className="text-sm underline text-primary">
              Edit guidelines in Settings
            </Link>
          </div>

          {status && !status.guidelinesPresent && (
            <div className="flex items-start gap-2 text-xs text-amber-600 bg-amber-500/10 rounded p-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>
                The crop detection guidelines document is missing — detection has no rules to
                follow. Open <Link to="/settings" className="underline">Settings</Link> to
                restore the shipped default.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

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
          <h2 className="text-xl font-semibold mb-2">No Chapters Ready for Pointer Detection</h2>
          <p className="text-muted-foreground max-w-md mx-auto">
            Download some chapters using the Library &amp; Downloader module first — only
            fully downloaded chapters can have their crop pointers detected.
          </p>
        </div>
      )}

      {seriesWithChapters.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {seriesWithChapters.map(s => {
            const seriesChapters = chapters.filter(c => c.seriesId === s.id)
            // Done here means "every page has its crops and matching metadata",
            // the same bar Clipper 3's own chapter list calls fully attached.
            // Chapters with no summary row yet (still loading, or a folder the
            // server could not read) count as not-done rather than being dropped
            // from the denominator, so the bar never overstates progress.
            const done = seriesChapters.filter(c => summaries[c.id]?.fullyAttached).length
            // Cut output is tracked separately: a chapter can be re-detected
            // after being cut, so this is a note on the card, not the progress.
            const chopped = seriesChapters.filter(c => summaries[c.id]?.chopped).length
            const progress = seriesChapters.length > 0 ? Math.round((done / seriesChapters.length) * 100) : 0
            return (
              <Link key={s.id} to={`/clipper3/series/${s.id}`}>
                <Card className="h-full hover:border-primary transition-colors cursor-pointer">
                  <CardContent className="p-4">
                    <div className="aspect-[3/4] bg-muted rounded-lg mb-3 flex items-center justify-center overflow-hidden">
                      {s.coverPath ? (
                        <img
                          src={`file://${s.coverPath}`}
                          alt={s.title}
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none'
                            e.currentTarget.parentElement!.innerHTML = `<div class="flex items-center justify-center w-full h-full"><span class="text-4xl">📚</span></div>`
                          }}
                        />
                      ) : (
                        <span className="text-4xl">📚</span>
                      )}
                    </div>

                    <h3 className="font-semibold truncate mb-2">{s.title}</h3>

                    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
                      <Globe className="h-3 w-3" />
                      <span className="truncate">{s.sourceSite}</span>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
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
                          {chopped > 0 && (
                            <Badge
                              variant="outline"
                              className="flex items-center gap-1"
                              title={`${chopped} of ${seriesChapters.length} chapters have cut output in crops3/`}
                            >
                              <Scissors className="h-3 w-3" />
                              {chopped}
                            </Badge>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">{progress}%</span>
                      </div>
                      <Progress value={progress} className="h-1.5" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
