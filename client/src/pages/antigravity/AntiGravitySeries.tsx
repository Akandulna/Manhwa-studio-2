/**
 * AntiGravity → series list (PRD §6.1–6.2). Uses the canonical library list
 * and saved activity ordering (useSeriesOrder), like every other module.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BookOpen, Loader2, Orbit } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { clipper3Api, type Clipper3ChapterSummary, type Clipper3Series } from '@/lib/api'
import { useSeriesOrder } from '@/hooks/useSeriesOrder'
import { AntiGravityTopBar, useReadiness } from './shared'

export default function AntiGravitySeries() {
  const [series, setSeries] = useState<Clipper3Series[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [totals, setTotals] = useState<Record<string, { done: number; total: number }>>({})
  const ordered = useSeriesOrder(series ?? [])
  const readiness = useReadiness()

  useEffect(() => {
    clipper3Api.getSeries().then(setSeries).catch(e => setError((e as Error).message))
  }, [])

  // Pointer totals, two series at a time (each summary reads every chapter's crop state).
  useEffect(() => {
    if (!series?.length) return
    let cancelled = false
    const queue = [...series]
    const worker = async () => {
      for (let s = queue.shift(); s && !cancelled; s = queue.shift()) {
        const summary = await clipper3Api.getSeriesSummary(s.id).catch(() => ({ chapters: [] as Clipper3ChapterSummary[] }))
        const t = summary.chapters.reduce((acc, c) => ({ done: acc.done + c.attachedImages, total: acc.total + c.totalImages }), { done: 0, total: 0 })
        if (!cancelled) setTotals(prev => ({ ...prev, [s.id]: t }))
      }
    }
    void Promise.all([worker(), worker()])
    return () => { cancelled = true }
  }, [series])

  const driveState = readiness.drive?.state
  const agReady = readiness.antigravity?.proofValid

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <AntiGravityTopBar crumbs={[{ label: 'AntiGravity' }]} />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold"><Orbit className="h-6 w-6" /> AntiGravity</h1>
          <p className="text-sm text-muted-foreground">Choose a series, then a part, then Image Clipper. Studio prepares pages on Google Drive and the local Antigravity CLI generates crop pointers for human review.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={driveState === 'connected' ? 'success' : 'outline'}>Drive: {driveState === 'connected' ? readiness.drive?.account?.email : (driveState ?? '…').replace('_', ' ')}</Badge>
          <Badge variant={agReady ? 'success' : 'outline'}>Antigravity: {agReady ? readiness.antigravity?.settings.modelLabel ?? 'verified' : 'not verified'}</Badge>
        </div>
      </header>

      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{error}</div>}
      {!series && !error && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading the library…</div>}
      {series?.length === 0 && (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No series with downloaded chapters yet. Add a series from the Library first.</CardContent></Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ordered.map(s => {
          const t = totals[s.id]
          return (
            <Link key={s.id} to={`/antigravity/series/${s.id}`} className="group rounded-lg border bg-card p-4 transition-colors hover:border-primary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted"><BookOpen className="h-5 w-5 text-muted-foreground" /></div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium group-hover:text-primary">{s.title}</div>
                  <div className="text-xs text-muted-foreground">{s.chapterCount} chapter{s.chapterCount === 1 ? '' : 's'} downloaded</div>
                  <div className="mt-2 text-xs">
                    {t ? (
                      <span className={t.total > 0 && t.done === t.total ? 'text-green-600 dark:text-green-400' : ''}>Pointers {t.done}/{t.total} pages</span>
                    ) : (
                      <span className="text-muted-foreground">Counting pointers…</span>
                    )}
                  </div>
                </div>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
