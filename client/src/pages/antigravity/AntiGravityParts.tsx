/**
 * AntiGravity → one series' parts (PRD §6.2). Part membership is the existing
 * Clipper grouping (20 chapters per part); any part can be opened, and a
 * nominal range missing chapters says so instead of pretending to be whole.
 */

import { Link, useParams } from 'react-router-dom'
import { Layers, Loader2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { CLIPPER_PART_SIZE } from '@/lib/clipperParts'
import { AntiGravityTopBar, partRange, pointerTotals, useSeriesScope } from './shared'

export default function AntiGravityParts() {
  const { seriesId } = useParams()
  const scope = useSeriesScope(seriesId)
  const title = scope.series?.title ?? 'Series'

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <AntiGravityTopBar crumbs={[{ label: 'AntiGravity', to: '/antigravity' }, { label: title }]} />
      <header>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">Choose a part. Each part is {CLIPPER_PART_SIZE} chapters, the same grouping Image Clipper uses. Newest part first.</p>
      </header>

      {scope.loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading chapters…</div>}
      {scope.error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{scope.error}</div>}
      {!scope.loading && !scope.error && scope.chapters.length === 0 && (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
          {scope.series ? 'This series has no downloaded source pages yet.' : 'This series was not found in the library (it may be hidden or deleted).'}
        </CardContent></Card>
      )}

      <div className="flex flex-col gap-3">
        {[...scope.parts].sort((a, b) => b.number - a.number).map(part => {
          const { first, last } = partRange(part.number)
          const totals = pointerTotals(part.chapters, scope.summaries)
          const whole = part.chapters.filter(c => Number.isInteger(c.number)).length
          return (
            <Link key={part.number} to={`/antigravity/series/${seriesId}/parts/${part.number}`} className="group rounded-lg border bg-card p-4 transition-colors hover:border-primary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted"><Layers className="h-5 w-5 text-muted-foreground" /></div>
                <div className="flex-1">
                  <div className="font-medium group-hover:text-primary">Part {part.number}</div>
                  <div className="text-xs text-muted-foreground">
                    Chapters {first}–{last} · {part.chapters.length} downloaded{whole < CLIPPER_PART_SIZE ? ` (${CLIPPER_PART_SIZE - whole} of ${CLIPPER_PART_SIZE} numbers missing)` : ''}
                  </div>
                </div>
                <div className={totals.total > 0 && totals.done === totals.total ? 'text-sm text-green-600 dark:text-green-400' : 'text-sm'}>
                  {totals.done}/{totals.total}
                  <div className="text-right text-xs text-muted-foreground">pages pointed</div>
                </div>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
