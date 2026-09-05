/**
 * Narration Library Page
 * 
 * Shows all series with downloaded chapters, mirroring Module 1's library
 * but with script progress instead of download progress.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { narrationApi, NarrationSeries } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { 
  BookOpen, 
  Globe, 
  FileText,
  CheckCircle,
  Loader2,
  AlertCircle
} from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/lib/socket'

export default function NarrationLibrary() {
  const [series, setSeries] = useState<NarrationSeries[]>([])
  const [loading, setLoading] = useState(true)
  const { toast } = useToast()
  const { narrationRangeComplete } = useSocket()

  useEffect(() => {
    loadSeries()
  }, [])

  // Reload when range generation completes
  useEffect(() => {
    if (narrationRangeComplete) {
      loadSeries()
    }
  }, [narrationRangeComplete])

  const loadSeries = async () => {
    try {
      const data = await narrationApi.getSeries()
      setSeries(data)
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to load series',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }

  const getScriptProgress = (s: NarrationSeries) => {
    if (s.downloadedChapterCount === 0) return 0
    return Math.round((s.scriptedChapterCount / s.downloadedChapterCount) * 100)
  }

  const getStatusBadge = (s: NarrationSeries) => {
    const progress = getScriptProgress(s)
    
    if (progress === 100) {
      return (
        <Badge variant="success" className="flex items-center gap-1">
          <CheckCircle className="h-3 w-3" />
          Complete
        </Badge>
      )
    }
    
    if (s.downloadedChapterCount === 0) {
      return (
        <Badge variant="outline" className="flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          No chapters
        </Badge>
      )
    }
    
    return (
      <Badge variant="secondary" className="flex items-center gap-1">
        <FileText className="h-3 w-3" />
        {s.scriptedChapterCount}/{s.downloadedChapterCount}
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
        <h1 className="text-3xl font-bold mb-6">Narration Library</h1>
        
        <div className="text-center py-12">
          <BookOpen className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No Series with Downloaded Chapters</h2>
          <p className="text-muted-foreground mb-4">
            Download some chapters using the Library & Downloader module first.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Narration Library</h1>
          <p className="text-muted-foreground">
            Generate narration scripts for your downloaded manhwa chapters
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {series.map((s) => (
          <Link key={s.id} to={`/narration/series/${s.id}`}>
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

                {/* Script progress */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    {getStatusBadge(s)}
                    <span className="text-xs text-muted-foreground">
                      {getScriptProgress(s)}%
                    </span>
                  </div>
                  <Progress value={getScriptProgress(s)} className="h-1.5" />
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
