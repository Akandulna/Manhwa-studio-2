/**
 * Clipper2SeriesView — Module 3 v2: Image Clipper 2.0
 *
 * Chapter list for one series, reached from Clipper2Library after picking a
 * series — the same "pick a series, then a chapter" flow used by Image
 * Clipper v1 (ClipperLibrary -> ClipperSeriesView) and Narration Studio.
 * Clicking a chapter opens the pointer workspace (Clipper2Workspace),
 * unchanged. Reuses PointerStateBadge/formatWhen from Clipper2Library so the
 * chapter state reads identically wherever it's shown.
 */

import { useState, useEffect, useMemo } from 'react'
import { usePublishedChapters } from '@/hooks/usePublishedChapters'
import { PublishedBadge, publishedRowClass } from '@/components/PublishedBadge'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ArrowLeft, Images, ChevronRight, Loader2, AlertTriangle } from 'lucide-react'
import { clipper2Api, type Clipper2ChapterSummary } from '@/lib/api'
import { PointerStateBadge, formatWhen } from './Clipper2Library'

export default function Clipper2SeriesView() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [chapters, setChapters] = useState<Clipper2ChapterSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Chapters already rendered to video, so the user can skip re-cutting them.
  const { isPublished } = usePublishedChapters(id)

  useEffect(() => {
    let cancelled = false
    clipper2Api.getChapters()
      .then(all => { if (!cancelled) setChapters(all) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load chapters') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

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
        <Button variant="link" onClick={() => navigate('/clipper2')}>
          Return to Library
        </Button>
      </div>
    )
  }

  const appliedCount = seriesChapters.filter(c => c.status === 'applied').length
  const progress = seriesChapters.length > 0 ? Math.round((appliedCount / seriesChapters.length) * 100) : 0

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-6 pb-4 border-b flex-shrink-0">
        <div className="flex items-start gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/clipper2')}>
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
          {seriesChapters.map(chapter => (
            <Link key={chapter.id} to={`/clipper2/chapter/${chapter.id}`} className="block">
              <Card className={`cursor-pointer hover:border-primary transition-colors group ${
                isPublished(chapter.id) ? publishedRowClass : ''
              }`}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium text-sm truncate">
                      Chapter {chapter.number}
                      {chapter.title ? ` · ${chapter.title}` : ''}
                    </p>
                    <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
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
                    {isPublished(chapter.id) && <PublishedBadge />}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
