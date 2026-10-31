/**
 * PublishedBadge — the magenta "already shipped" marker.
 *
 * Shown in every module beside a chapter that has a rendered video, so the
 * user can tell at a glance what not to process again. Magenta is reserved for
 * this one meaning across the app: it is used by no module's own status colours
 * (green = done, amber = warning, red = failed, blue/violet = in progress), so
 * it cannot be confused with a step's own state.
 */

import { Archive, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'

const MAGENTA =
  'border-transparent bg-fuchsia-600 text-white hover:bg-fuchsia-600/80'

export function PublishedBadge({
  className,
  compact = false
}: {
  className?: string
  /** Icon only — for dense rows where the word does not fit. */
  compact?: boolean
}) {
  return (
    <span
      title="This chapter has already been rendered to video — no need to process it again"
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
        MAGENTA,
        compact && 'px-1.5',
        className
      )}
    >
      <CheckCircle2 className="h-3 w-3" />
      {!compact && 'Published'}
    </span>
  )
}

/**
 * A left edge stripe for a card or row, marking it published without taking
 * horizontal space. Pair with the badge, not instead of it — colour alone is
 * not a label.
 */
export const publishedRowClass = 'border-l-4 border-l-fuchsia-600'

/**
 * CompletedBadge — the chapter's Part was completed on the Storage page: its
 * files are gone and only the script continuity is kept, so there is nothing
 * left to work on. Slate, so it reads as closed rather than as a step's state.
 * `label` overrides the text (Editor 2.0 says "Part N done").
 */
export function CompletedBadge({
  part,
  label,
  className
}: {
  part?: number | null
  label?: string
  className?: string
}) {
  return (
    <span
      title={`${part ? `Part ${part}` : 'This Part'} is completed — its files were deleted after export; only the script continuity is kept`}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-transparent bg-slate-700 px-2.5 py-0.5 text-xs font-semibold text-white dark:bg-slate-600',
        className
      )}
    >
      <Archive className="h-3 w-3" />
      {label ?? (part ? `Completed · Part ${part}` : 'Completed')}
    </span>
  )
}

/** Row treatment for a completed chapter: muted, with a slate edge. */
export const completedRowClass = 'border-l-4 border-l-slate-500 opacity-70'

/** A series' completed Parts beside its title: "Part 1 completed", or "Parts 1, 2 completed". */
export function SeriesCompletedBadge({ parts, done = false }: { parts: number[]; done?: boolean }) {
  if (parts.length === 0) return null
  const which = `Part${parts.length === 1 ? '' : 's'} ${parts.join(', ')}`
  return (
    <CompletedBadge
      part={parts[parts.length - 1]}
      label={`${which} ${done ? 'done' : 'completed'}`}
      className="shrink-0"
    />
  )
}
