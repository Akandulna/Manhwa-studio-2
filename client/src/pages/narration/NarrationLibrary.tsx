/**
 * Narration Library Page
 *
 * Every manhwa with downloaded chapters, and how far its narration has come
 * onto this Mac: the Sleeper-Cell phones write the scripts and voice them, and
 * a series' page fetches both from R2 and aligns them.
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
import { BookOpen, CheckCircle, FileText, Globe, Loader2, Smartphone } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
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
  // Scripts written in the Sleeper-Cell phone app, per series: the server's
  // last copy of the phone's receipt, no R2 read.
  const { status: phoneScripts } = usePhoneScripts()

  useEffect(() => {
    loadSeries()
  }, [language])

  const loadSeries = async () => {
    try {
      setSeries(await narrationApi.getSeries(language))
    } catch {
      toast({ title: 'Error', description: 'Failed to load series', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Narration Library</h1>
          <p className="text-muted-foreground">
            Fetch the {LANGUAGE_LABEL[language]} scripts and voiceovers the phones made, and align them
          </p>
        </div>
        <LanguageTabs value={language} onChange={setLanguage} />
      </div>

      {series.length === 0 ? (
        <div className="text-center py-12">
          <BookOpen className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No series with downloaded chapters</h2>
          <p className="text-muted-foreground">Get chapters from the phones in Image Clipper first.</p>
        </div>
      ) : (
        <Card className="overflow-hidden divide-y">
          {series.map(s => {
            const progress = s.chapterCount > 0 ? Math.round((s.alignedCount / s.chapterCount) * 100) : 0
            const onPhone = phoneScripts?.series[s.id]
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

                {onPhone && language === 'en' && (
                  <span className="hidden md:flex items-center gap-1 shrink-0 text-xs text-muted-foreground">
                    <Smartphone className="h-3 w-3" />
                    {onPhone.done}/{onPhone.total} scripted on phone
                  </span>
                )}

                <span className="hidden lg:block w-56 shrink-0 text-xs text-muted-foreground text-right">
                  {s.chapterCount} chapters · {s.scriptedCount} scripts · {s.voicedCount} with audio
                </span>

                <div className="hidden sm:flex w-36 shrink-0 items-center gap-2">
                  <Progress value={progress} className="h-1 flex-1" />
                  <span className="w-9 text-xs text-muted-foreground text-right">{progress}%</span>
                </div>

                <div className="w-32 shrink-0 flex justify-end">
                  {s.chapterCount > 0 && s.alignedCount === s.chapterCount ? (
                    <Badge variant="success" className="flex items-center gap-1">
                      <CheckCircle className="h-3 w-3" />
                      All aligned
                    </Badge>
                  ) : (
                    <Badge variant="secondary" title="Chapters aligned (every section has its timeline)">
                      {s.alignedCount}/{s.chapterCount} aligned
                    </Badge>
                  )}
                </div>
              </Link>
            )
          })}
        </Card>
      )}
    </div>
  )
}
