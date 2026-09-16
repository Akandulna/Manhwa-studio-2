/**
 * PublishedBadge — the magenta "already shipped" marker.
 *
 * Shown in every module beside a chapter that has a rendered video, so the
 * user can tell at a glance what not to process again. Magenta is reserved for
 * this one meaning across the app: it is used by no module's own status colours
 * (green = done, amber = warning, red = failed, blue/violet = in progress), so
 * it cannot be confused with a step's own state.
 */

import { CheckCircle2 } from 'lucide-react'
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
