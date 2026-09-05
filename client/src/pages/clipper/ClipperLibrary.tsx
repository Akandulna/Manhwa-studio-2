/**
 * ClipperLibrary — Module 3: Image Clipper
 *
 * Library landing page: a grid of series eligible for clipping, mirroring the
 * other modules' "pick a series first" flow. Selecting a series navigates to
 * the chapter list (ClipperSeriesView).
 */

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import {
  Scissors,
  Globe,
  Image,
  CheckCircle,
  Loader2,
} from 'lucide-react'
import { clipperApi, type ClipperSeries } from '@/lib/api'

export default function ClipperLibrary() {
  const [series, setSeries] = useState<ClipperSeries[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadSeries()
  }, [])

  async function loadSeries() {
    try {
      setLoading(true)
      const data = await clipperApi.getSeries()
      setSeries(data)
    } catch (error) {
      console.error('Error loading clipper series:', error)
    } finally {
      setLoading(false)
    }
  }

  function getProgress(s: ClipperSeries) {
    if (s.eligibleChapterCount === 0) return 0
    return Math.round((s.croppedChapterCount / s.eligibleChapterCount) * 100)
  }

  function getStatusBadge(s: ClipperSeries) {
    const progress = getProgress(s)
    if (progress === 100) {
      return (
        <Badge variant="success" className="flex items-center gap-1">
          <CheckCircle className="h-3 w-3" />
          Complete
        </Badge>
      )
    }
    return (
      <Badge variant="secondary" className="flex items-center gap-1">
        <Image className="h-3 w-3" />
        {s.croppedChapterCount}/{s.eligibleChapterCount}
      </Badge>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (series.length === 0) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 mb-6">
          <Scissors className="h-7 w-7 text-primary" />
          <h1 className="text-3xl font-bold">Image Clipper</h1>
        </div>

        <div className="text-center py-12">
          <Scissors className="h-16 w-16 mx-auto text-muted-foreground mb-4 opacity-30" />
          <h2 className="text-xl font-semibold mb-2">No Series Ready for Clipping</h2>
          <p className="text-muted-foreground max-w-md mx-auto">
            Download some chapters using the Library &amp; Downloader module first to unlock the Image Clipper.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <Scissors className="h-7 w-7 text-primary" />
            <h1 className="text-3xl font-bold">Image Clipper</h1>
          </div>
          <p className="text-muted-foreground mt-1">
            Select a series to start clipping its chapters
          </p>
        </div>
        <span className="text-sm text-muted-foreground">{series.length} series ready</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {series.map((s) => (
          <Link key={s.id} to={`/clipper/series/${s.id}`}>
            <Card className="h-full hover:border-primary transition-colors cursor-pointer">
              <CardContent className="p-4">
                {/* Cover placeholder or image */}
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

                {/* Title */}
                <h3 className="font-semibold truncate mb-2">{s.title}</h3>

                {/* Meta info */}
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
                  <Globe className="h-3 w-3" />
                  <span className="truncate">{s.sourceSite}</span>
                </div>

                {/* Clip progress */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    {getStatusBadge(s)}
                    <span className="text-xs text-muted-foreground">
                      {getProgress(s)}%
                    </span>
                  </div>
                  <Progress value={getProgress(s)} className="h-1.5" />
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
