/**
 * ClipperSeriesView — Module 3: Image Clipper
 *
 * Chapter list for a single series. Reached from the Clipper library after
 * picking a series. Clicking a chapter opens the crop workspace.
 */

import { useState, useEffect } from 'react'
import { usePublishedChapters } from '@/hooks/usePublishedChapters'
import { PublishedBadge, publishedRowClass } from '@/components/PublishedBadge'
import { useParams, useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  ArrowLeft,
  Image,
  CheckCircle2,
  Circle,
  Loader2,
  ChevronRight,
} from 'lucide-react'
import {
  clipperApi,
  type ClipperSeriesDetail,
  type ClipperChapterSummary,
} from '@/lib/api'

export default function ClipperSeriesView() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [detail, setDetail] = useState<ClipperSeriesDetail | null>(null)

  // Chapters already rendered to video, so they need no re-cropping.
  const { isPublished } = usePublishedChapters(id)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (id) loadDetail(id)
  }, [id])

  async function loadDetail(seriesId: string) {
    try {
      setLoading(true)
      const data = await clipperApi.getSeriesDetail(seriesId)
      setDetail(data)
    } catch (error) {
      console.error('Error loading series detail:', error)
    } finally {
      setLoading(false)
    }
  }

  function getStatusIcon(chapter: ClipperChapterSummary) {
    if (chapter.sessionStatus === 'finalized') {
      return <CheckCircle2 className="h-4 w-4 text-green-500" />
    }
    if (chapter.hasSession) {
      return <Loader2 className="h-4 w-4 text-yellow-500" />
    }
    return <Circle className="h-4 w-4 text-muted-foreground" />
  }

  function getStatusLabel(chapter: ClipperChapterSummary) {
    if (chapter.sessionStatus === 'finalized') return 'Exported'
    if (chapter.hasSession) return `${chapter.cropCount} crops`
    return 'Ready'
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="p-6 text-center">
        <h2 className="text-xl font-semibold">Series not found</h2>
        <Button variant="link" onClick={() => navigate('/clipper')}>
          Return to Library
        </Button>
      </div>
    )
  }

  const exportedCount = detail.chapters.filter(
    ch => ch.sessionStatus === 'finalized'
  ).length
  const progress = detail.chapters.length > 0
    ? Math.round((exportedCount / detail.chapters.length) * 100)
    : 0

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-6 pb-4 border-b">
        <div className="flex items-start gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/clipper')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>

          <div className="flex-1">
            <h1 className="text-2xl font-bold">{detail.title}</h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground mt-1">
              <span>{detail.chapters.length} chapters eligible for clipping</span>
              <span>•</span>
              <span>{exportedCount} exported</span>
            </div>

            <div className="max-w-md mt-3">
              <div className="flex items-center justify-between text-sm mb-1">
                <span>Clip Progress</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
          </div>
        </div>
      </div>

      {/* Chapter Grid */}
      <ScrollArea className="flex-1">
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {detail.chapters.map(ch => (
            <Card
              key={ch.id}
              className={`cursor-pointer hover:border-primary transition-colors group ${
                isPublished(ch.id) ? publishedRowClass : ''
              }`}
              onClick={() => navigate(`/clipper/chapter/${ch.id}`)}
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    {getStatusIcon(ch)}
                    <span className="font-medium text-sm truncate">
                      Chapter {ch.number}
                    </span>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                </div>

                {ch.title && (
                  <p className="text-xs text-muted-foreground mt-1 truncate pl-6">
                    {ch.title}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2 mt-2 pl-6">
                  {isPublished(ch.id) && <PublishedBadge />}
                  <Badge variant={
                    ch.sessionStatus === 'finalized' ? 'default' :
                    ch.hasSession ? 'secondary' : 'outline'
                  } className="text-xs">
                    {getStatusLabel(ch)}
                  </Badge>
                  {ch.pageCount && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Image className="h-3 w-3" />
                      {ch.pageCount}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
