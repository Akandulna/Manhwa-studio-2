/**
 * EditorLibrary2 — Module 4v2: Editor 2.0
 *
 * Series picker landing page. Each row counts the chapters ready to edit —
 * voiceover audio, alignment, timeline JSON and cropped images all there —
 * and opens the series' chapter checklist.
 *
 * The English / Hindi tab picks which narration the series is edited with;
 * the same manhwa can be processed once in each.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { seriesApi, videoApi2, type Series, type Editor2SeriesReadiness } from '@/lib/api'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Clapperboard, Globe, Loader2, RefreshCw } from 'lucide-react'
import { LanguageTabs } from '@/components/LanguageTabs'
import { LANGUAGE_LABEL, useNarrationLanguage, withLang } from '@/lib/narrationLanguage'
import { usePublishedChapters } from '@/hooks/usePublishedChapters'
import { SeriesCompletedBadge } from '@/components/PublishedBadge'
import { SeriesDoneBadge } from './SeriesDoneBadge'

/**
 * Series whose checklists are scanned at once. Each scan reads every page's
 * crop files from disk, so a long library fills in a few rows at a time
 * rather than all of them racing for the disk.
 */
const READINESS_CONCURRENCY = 3

type SeriesReadiness = Editor2SeriesReadiness | 'error'

export default function EditorLibrary2() {
  const [language, setLanguage] = useNarrationLanguage('editor2')
  const [series, setSeries] = useState<Series[]>([])
  // Parts completed on the Storage page (files deleted, continuity kept).
  const { seriesCompletedParts, completedPart } = usePublishedChapters()
  const [loading, setLoading] = useState(true)
  // Per series, in the current language; missing while its scan runs.
  const [readiness, setReadiness] = useState<Record<string, SeriesReadiness>>({})
  const [scanTick, setScanTick] = useState(0)

  useEffect(() => {
    seriesApi.getAll()
      .then(setSeries)
      .catch(err => console.error('Error loading series:', err))
      .finally(() => setLoading(false))
  }, [])

  // Scan each series' checklist, a few at a time, again when the tab changes.
  useEffect(() => {
    if (series.length === 0) return
    let cancelled = false
    setReadiness({})
    const queue = [...series]
    const worker = async () => {
      for (let s = queue.shift(); s && !cancelled; s = queue.shift()) {
        const id = s.id
        const result: SeriesReadiness = await videoApi2
          .getSeriesReadiness(id, language)
          .catch(() => 'error' as const)
        if (!cancelled) setReadiness(prev => ({ ...prev, [id]: result }))
      }
    }
    for (let i = 0; i < READINESS_CONCURRENCY; i++) void worker()
    return () => { cancelled = true }
  }, [series, language, scanTick])

  /** "4/12 ready", leaving out chapters of completed Parts (nothing left to edit). */
  function readinessLabel(seriesId: string): { text: string; allReady: boolean } | null {
    const r = readiness[seriesId]
    if (r === undefined) return null
    if (r === 'error') return { text: '—', allReady: false }
    const open = r.chapters.filter(ch => completedPart(ch.id) === null)
    const ready = open.filter(ch => ch.ready).length
    return { text: `${ready}/${open.length} ready`, allReady: open.length > 0 && ready === open.length }
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
          <Clapperboard className="h-7 w-7 text-primary" />
          <h1 className="text-3xl font-bold">Video Editor 2.0</h1>
        </div>
        <div className="text-center py-12">
          <Clapperboard className="h-16 w-16 mx-auto text-muted-foreground mb-4 opacity-30" />
          <h2 className="text-xl font-semibold mb-2">No Series Yet</h2>
          <p className="text-muted-foreground max-w-md mx-auto">
            Add a series first, then finish its voiceover, alignment and crops to make and edit its timeline.
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
            Select a series to see each chapter's checklist for the {LANGUAGE_LABEL[language]} video
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Button variant="outline" size="sm" onClick={() => setScanTick(t => t + 1)}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Rescan
          </Button>
          <span className="text-sm text-muted-foreground">{series.length} series</span>
          <LanguageTabs value={language} onChange={setLanguage} />
        </div>
      </div>

      <Card className="overflow-hidden divide-y">
        {series.map((s) => {
          const status = readiness[s.id]
          return (
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
                  <SeriesDoneBadge completion={status === 'error' ? null : status ?? null} />
                  <SeriesCompletedBadge parts={seriesCompletedParts(s.id)} done />
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Globe className="h-3 w-3 shrink-0" />
                  <span className="truncate">{s.sourceSite}</span>
                </div>
              </div>

              {/* Chapters ready to edit: the whole checklist passes. */}
              <span className="w-24 shrink-0 text-sm text-right tabular-nums">
                {(() => {
                  const label = readinessLabel(s.id)
                  if (!label) return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground inline" />
                  return (
                    <span
                      className={label.allReady ? 'text-green-600' : 'text-muted-foreground'}
                      title="Chapters with voiceover audio, alignment, timeline JSON and cropped images all in place"
                    >
                      {label.text}
                    </span>
                  )
                })()}
              </span>

              {s.chapterCount !== undefined && (
                <span className="w-24 shrink-0 text-sm text-muted-foreground text-right">
                  {s.chapterCount} chapters
                </span>
              )}
            </Link>
          )
        })}
      </Card>
    </div>
  )
}
