/**
 * usePublishedChapters — which chapters already have a rendered video.
 *
 * Every module that lists chapters (narration, the three clippers, both
 * editors) shows the same magenta "Published" marker from this one source, so
 * a chapter that has shipped reads identically everywhere and never gets
 * reprocessed by accident.
 *
 * Failure is deliberately silent: the marker is an advisory, and a module's
 * chapter list must still render if the lookup fails. An unknown chapter is
 * simply "not published" — the safe direction, since the cost of a missing
 * marker is redundant work, while a false marker would hide real work.
 */

import { useEffect, useState } from 'react'
import { storageApi } from '@/lib/api'

export interface SeriesPublished {
  published: number
  total: number
}

export interface PublishedState {
  /** True when this chapter has a rendered MP4. */
  isPublished: (chapterId: string) => boolean
  /** How many of the given chapters are published. */
  publishedCount: (chapterIds: string[]) => number
  /** Published/total for a whole series, or null if it is not known yet. */
  seriesPublished: (seriesId: string) => SeriesPublished | null
  loading: boolean
}

export function usePublishedChapters(seriesId?: string): PublishedState {
  const [map, setMap] = useState<Record<string, boolean>>({})
  const [seriesMap, setSeriesMap] = useState<Record<string, SeriesPublished>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    storageApi
      .getPublished(seriesId)
      .then(result => {
        if (cancelled) return
        setMap(result.chapters)
        setSeriesMap(result.series ?? {})
      })
      .catch(() => {
        // Advisory only — leave every chapter unmarked.
        if (cancelled) return
        setMap({})
        setSeriesMap({})
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [seriesId])

  return {
    isPublished: (chapterId: string) => map[chapterId] === true,
    publishedCount: (chapterIds: string[]) => chapterIds.filter(id => map[id] === true).length,
    seriesPublished: (seriesId: string) => seriesMap[seriesId] ?? null,
    loading
  }
}
