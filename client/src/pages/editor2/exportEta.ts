import type { Export2Job } from '@/lib/api'

/** Chapter-weighted estimate, matching the export progress bar without counting skipped work. */
export function exportEtaLabel(job: Export2Job, now = Date.now()): string {
  if (job.status !== 'running') return ''
  const chapters = job.chapters.filter(chapter => chapter.status !== 'skipped')
  if (!chapters.length) return 'Estimating time…'
  const unfinished = chapters.filter(chapter => chapter.status === 'pending' || chapter.status === 'rendering')
  if (!unfinished.length || unfinished.every(chapter => chapter.status === 'rendering' && chapter.percent >= 99)) {
    return 'Finalizing…'
  }
  // Failed/cancelled chapters have no remaining work, but consumed some elapsed time.
  const completed = chapters.reduce((sum, chapter) => sum + (
    chapter.status === 'pending' ? 0 : chapter.status === 'rendering'
      ? Math.max(0, Math.min(100, chapter.percent)) / 100 : 1
  ), 0)
  const elapsed = now - job.startedAt
  if (elapsed < 15_000 || completed <= 0 || !Number.isFinite(elapsed)) return 'Estimating time…'
  const remaining = elapsed / completed * (chapters.length - completed)
  if (!Number.isFinite(remaining) || remaining < 0) return 'Estimating time…'
  const minutes = Math.max(1, Math.ceil(remaining / 60_000))
  if (minutes < 60) return `~${minutes} min left`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `~${hours} hr${rest ? ` ${rest} min` : ''} left`
}
