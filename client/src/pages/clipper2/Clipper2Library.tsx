/**
 * Clipper2Library — Module 3 v2: Image Clipper 2.0
 *
 * Landing page for the four-pointer technique: a grid of series, mirroring
 * Image Clipper v1 and Narration Studio's "pick a series first" flow.
 * Selecting a series navigates to its chapter list (Clipper2SeriesView),
 * which links into the actual pointer workspace (Clipper2Workspace).
 *
 * The two stages are visible in the state a chapter reports. Detection writes
 * crop_points.json ("N pointers detected"); a hand edit through the JSON editor
 * flips the set to "edited"; only apply produces exported images. A chapter can
 * therefore have pointers and no outputs, which is the normal mid-flow state and
 * not an error. `PointerStateBadge`/`formatWhen` are exported for reuse by
 * Clipper2SeriesView's chapter cards.
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
  FileJson,
  FileText,
  CheckCircle2,
  Pencil,
  XCircle,
  Globe,
  Image as ImageIcon
} from 'lucide-react'
import {
  clipperApi,
  clipper2Api,
  type ClipperSeries,
  type Clipper2Status,
  type Clipper2ChapterSummary
} from '@/lib/api'

// ============ Helpers ============

export function formatWhen(iso: string | null): string {
  if (!iso) return 'never'
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? 'unknown' : at.toLocaleString()
}

/**
 * The pointer state of one chapter. `hasPoints` is a fact about the disk while
 * `status` comes from the index row, and the artifact is user-deletable — so a
 * row can claim 'detected' with no file behind it. The disk wins.
 */
export function PointerStateBadge({ chapter }: { chapter: Clipper2ChapterSummary }) {
  if (chapter.status === 'detecting') {
    return (
      <Badge variant="secondary" className="flex items-center gap-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        Detecting…
      </Badge>
    )
  }

  if (chapter.status === 'failed') {
    return (
      <Badge variant="destructive" className="flex items-center gap-1">
        <XCircle className="h-3 w-3" />
        Detection failed
      </Badge>
    )
  }

  if (!chapter.hasPoints) {
    return (
      <Badge variant="outline" className="flex items-center gap-1 text-muted-foreground">
        <FileJson className="h-3 w-3" />
        No pointers
      </Badge>
    )
  }

  if (chapter.status === 'applied') {
    return (
      <Badge variant="success" className="flex items-center gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Applied · {chapter.exportedCount} exported
      </Badge>
    )
  }

  if (chapter.status === 'edited') {
    return (
      <Badge variant="secondary" className="flex items-center gap-1">
        <Pencil className="h-3 w-3" />
        {chapter.cropCount} pointers · edited
      </Badge>
    )
  }

  return (
    <Badge variant="secondary" className="flex items-center gap-1">
      <Locate className="h-3 w-3" />
      {chapter.cropCount} pointers detected
    </Badge>
  )
}

// ============ Page ============

export default function Clipper2Library() {
  const [status, setStatus] = useState<Clipper2Status | null>(null)
  const [seriesList, setSeriesList] = useState<ClipperSeries[]>([])
  const [chapters, setChapters] = useState<Clipper2ChapterSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    // Settled independently on purpose: a failed status probe must not hide the
    // chapter list (an already-detected artifact stays inspectable and appliable
    // even with the detector down), and a failed listing must not hide what the
    // detector is configured with. Series come from the same source Image
    // Clipper v1 uses for its own library grid (title/cover/source site).
    Promise.allSettled([clipper2Api.getStatus(), clipper2Api.getChapters(), clipperApi.getSeries()])
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

  const header = (
    <div className="mb-6">
      <div className="flex items-center gap-2">
        <Locate className="h-7 w-7 text-primary" />
        <h1 className="text-3xl font-bold">Image Clipper 2.0</h1>
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

      {/* Status strip: what the detector will run with, before anything is started. */}
      <Card className="mb-6">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">Detection model</span>
              <code className="text-xs bg-muted rounded px-1.5 py-0.5">
                {status?.model || 'unknown'}
              </code>
            </span>
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">Artifact format</span>
              <code className="text-xs bg-muted rounded px-1.5 py-0.5">
                {status ? `${status.format} v${status.formatVersion}` : 'unknown'}
              </code>
            </span>
            <span className="flex items-center gap-2">
              {status?.geminiAvailable ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <span className="text-muted-foreground">Gemini ready</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  <span className="text-muted-foreground">Gemini unavailable</span>
                </>
              )}
            </span>
          </div>

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

          {status && !status.geminiAvailable && (
            <div className="flex items-start gap-2 text-xs text-amber-600 bg-amber-500/10 rounded p-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>
                Gemini is unavailable
                {status.geminiError ? <> — {status.geminiError}</> : <> — set <code>GEMINI_API_KEY</code></>}.
                Existing pointer files can still be edited and applied.
              </span>
            </div>
          )}

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
            const applied = seriesChapters.filter(c => c.status === 'applied').length
            const progress = seriesChapters.length > 0 ? Math.round((applied / seriesChapters.length) * 100) : 0
            return (
              <Link key={s.id} to={`/clipper2/series/${s.id}`}>
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
                        {progress === 100 ? (
                          <Badge variant="success" className="flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" />
                            Complete
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="flex items-center gap-1">
                            <ImageIcon className="h-3 w-3" />
                            {applied}/{seriesChapters.length}
                          </Badge>
                        )}
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
