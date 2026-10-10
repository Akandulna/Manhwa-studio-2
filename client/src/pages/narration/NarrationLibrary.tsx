/**
 * Narration Library Page
 * 
 * Shows all series with downloaded chapters, mirroring Module 1's library
 * but with script progress instead of download progress.
 *
 * English and Hindi tabs: the same manhwa is narrated once per language, each
 * with its own scripts and voiceover. The chosen tab travels with every link.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { narrationApi, NarrationSeries } from '@/lib/api'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { 
  BookOpen, 
  Globe, 
  FileText,
  CheckCircle,
  Loader2,
  AlertCircle,
  Smartphone
} from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/lib/socket'
import { usePhoneScripts } from '@/hooks/usePhoneScripts'
import { LanguageTabs } from '@/components/LanguageTabs'
import { LANGUAGE_LABEL, useNarrationLanguage, withLang } from '@/lib/narrationLanguage'
import { usePublishedChapters } from '@/hooks/usePublishedChapters'
import { SeriesCompletedBadge } from '@/components/PublishedBadge'

export default function NarrationLibrary() {
  // Parts completed on the Storage page (files deleted, continuity kept).
  const { seriesCompletedParts } = usePublishedChapters()
  const [language, setLanguage] = useNarrationLanguage('narration')
  const [series, setSeries] = useState<NarrationSeries[]>([])
  const [loading, setLoading] = useState(true)
  const { toast } = useToast()
  const { narrationRangeComplete } = useSocket()
  // Scripts written in the Sleeper-Cell phone app, per series.
  // The server's last copy; "Refresh from phone" on a series page updates it.
  const { status: phoneScripts } = usePhoneScripts()

  useEffect(() => {
    loadSeries()
  }, [language])

  // Reload when range generation completes
  useEffect(() => {
    if (narrationRangeComplete) {
      loadSeries()
    }
  }, [narrationRangeComplete])

  const loadSeries = async () => {
    try {
      const data = await narrationApi.getSeries(language)
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
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold">Narration Library</h1>
          <LanguageTabs value={language} onChange={setLanguage} />
        </div>
        
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
            Generate {LANGUAGE_LABEL[language]} narration scripts and voiceovers for your downloaded manhwa chapters
          </p>
        </div>
        <LanguageTabs value={language} onChange={setLanguage} />
      </div>

      <Card className="overflow-hidden divide-y">
        {series.map((s) => {
          const progress = getScriptProgress(s)
          // The phone writes English scripts only
          const onPhone = language === 'en' ? phoneScripts?.series[s.id] : undefined
          return (
            <Link
              key={s.id}
              to={withLang(`/narration/series/${s.id}`, language)}
              className="flex items-center gap-4 px-4 py-3 hover:bg-accent/50 transition-colors"
            >
              <div className="h-10 w-10 shrink-0 rounded-md bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                <FileText className="h-5 w-5 text-primary/40" />
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

              {onPhone && (
                <span className="hidden md:flex items-center gap-1 shrink-0 text-xs text-muted-foreground">
                  <Smartphone className="h-3 w-3" />
                  {onPhone.done}/{onPhone.total} done on phone
                </span>
              )}

              <span className="w-24 shrink-0 text-sm text-muted-foreground text-right">
                {s.downloadedChapterCount} chapters
              </span>

              <div className="hidden sm:flex w-36 shrink-0 items-center gap-2">
                <Progress value={progress} className="h-1 flex-1" />
                <span className="w-9 text-xs text-muted-foreground text-right">{progress}%</span>
              </div>

              <div className="w-32 shrink-0 flex justify-end">{getStatusBadge(s)}</div>
            </Link>
          )
        })}
      </Card>
    </div>
  )
}
