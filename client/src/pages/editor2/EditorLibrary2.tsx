/**
 * EditorLibrary2 — Module 4v2: Editor 2.0
 *
 * Series picker landing page. Pick a series to see its chapters' readiness
 * for Editor 2.0 (script, audio, Image Clipper 3.0 crops, script with timeline).
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { seriesApi, type Series } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Clapperboard, Globe, Loader2 } from 'lucide-react'

export default function EditorLibrary2() {
  const [series, setSeries] = useState<Series[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    seriesApi.getAll()
      .then(setSeries)
      .catch(err => console.error('Error loading series:', err))
      .finally(() => setLoading(false))
  }, [])

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
          <Clapperboard className="h-7 w-7 text-primary" />
          <h1 className="text-3xl font-bold">Video Editor 2.0</h1>
        </div>
        <div className="text-center py-12">
          <Clapperboard className="h-16 w-16 mx-auto text-muted-foreground mb-4 opacity-30" />
          <h2 className="text-xl font-semibold mb-2">No Series Yet</h2>
          <p className="text-muted-foreground max-w-md mx-auto">
            Add and download a series first, then finish its script, voiceover, crops and timeline to compile a video.
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
            <Clapperboard className="h-7 w-7 text-primary" />
            <h1 className="text-3xl font-bold">Video Editor 2.0</h1>
          </div>
          <p className="text-muted-foreground mt-1">
            Select a series to see its chapters' readiness
          </p>
        </div>
        <span className="text-sm text-muted-foreground">{series.length} series</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {series.map((s) => (
          <Link key={s.id} to={`/editor2/${s.id}`}>
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
                        e.currentTarget.parentElement!.innerHTML = `<div class="flex items-center justify-center w-full h-full"><span class="text-4xl">🎬</span></div>`
                      }}
                    />
                  ) : (
                    <span className="text-4xl">🎬</span>
                  )}
                </div>

                <h3 className="font-semibold truncate mb-2">{s.title}</h3>

                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-1 min-w-0">
                    <Globe className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">{s.sourceSite}</span>
                  </span>
                  {s.chapterCount !== undefined && (
                    <Badge variant="secondary">{s.chapterCount} ch</Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
