import type { ProcessSeries, Series } from './api'

export const EXPORTED = -1

export function completionGroup(tracker?: ProcessSeries): number {
  const completed = tracker?.completedParts.length ?? 0
  if (completed > 0) return completed
  return tracker?.parts.some(part => part.chapters.some(chapter =>
    chapter.stages.export_en.state === 'done' || chapter.stages.export_hi.state === 'done'
  )) ? EXPORTED : 0
}

export function sectionTitle(completed: number): string {
  if (completed === EXPORTED) return 'Videos exported'
  return completed === 0 ? 'No parts completed' : `${completed} ${completed === 1 ? 'part' : 'parts'} completed`
}

/** Input is already ordered by saved activity and live phone activity. */
export function librarySections(series: Series[], trackers: Map<string, ProcessSeries>, running: Set<string>) {
  const groups = new Map<number, { completed: number; series: Series[]; processing: number }>()
  for (const item of series) {
    const tracker = trackers.get(item.id)
    const completed = completionGroup(tracker)
    const group = groups.get(completed) ?? { completed, series: [], processing: 0 }
    group.series.push(item)
    if (running.has(item.id) || tracker?.parts.some(part => part.chapters.some(chapter =>
      Object.values(chapter.stages).some(stage => stage.state === 'active')
    ))) group.processing++
    groups.set(completed, group)
  }
  return [...groups.values()].sort((a, b) =>
    Number(b.processing > 0) - Number(a.processing > 0) ||
    (a.completed === EXPORTED ? Infinity : a.completed) - (b.completed === EXPORTED ? Infinity : b.completed)
  )
}
