/**
 * EditorLibrary2 — Module 4v2: Editor 2.0
 *
 * Series picker landing page. Pick a series to see its chapters' readiness
 * for Editor 2.0 (script, audio, Image Clipper 3.0 crops, script with timeline).
 *
 * The English / Hindi tab picks which narration the series is edited with;
 * the same manhwa can be processed once in each.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { seriesApi, type Series } from '@/lib/api'
import { Card } from '@/components/ui/card'
import { Clapperboard, Globe, Loader2 } from 'lucide-react'
import { LanguageTabs } from '@/components/LanguageTabs'
import { LANGUAGE_LABEL, useNarrationLanguage, withLang } from '@/lib/narrationLanguage'
import { usePublishedChapters } from '@/hooks/usePublishedChapters'
import { SeriesCompletedBadge } from '@/components/PublishedBadge'

export default function EditorLibrary2() {
  const [language, setLanguage] = useNarrationLanguage('editor2')
  const [series, setSeries] = useState<Series[]>([])
  // Parts completed on the Storage page (files deleted, continuity kept).
  const { seriesCompletedParts } = usePublishedChapters()
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
            Select a series to see its chapters' readiness for the {LANGUAGE_LABEL[language]} video
          </p>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">{series.length} series</span>
          <LanguageTabs value={language} onChange={setLanguage} />
        </div>
      </div>

      <Card className="overflow-hidden divide-y">
        {series.map((s) => (
          <Link
            key={s.id}
            to={withLang(`/editor2/${s.id}`, language)}
            className="flex items-center gap-4 px-4 py-3 hover:bg-accent/50 transition-colors"
          >
            <div className="h-10 w-10 shrink-0 rounded-md bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
              <Clapperboard className="h-5 w-5 text-primary/40" />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                  <h3 className="font-semibold truncate">{s.title}</h3>
                  <SeriesCompletedBadge parts={seriesCompletedParts(s.id)} done />
                </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Globe className="h-3 w-3 shrink-0" />
                <span className="truncate">{s.sourceSite}</span>
              </div>
            </div>

            {s.chapterCount !== undefined && (
              <span className="w-24 shrink-0 text-sm text-muted-foreground text-right">
                {s.chapterCount} chapters
              </span>
            )}
          </Link>
        ))}
      </Card>
    </div>
  )
}
