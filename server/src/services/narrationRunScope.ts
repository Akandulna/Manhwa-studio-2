import type { LibraryControl } from './libraryControlModel.js'
import { PART_CHAPTERS } from './seriesProcessModel.js'

export type NarrationPartChoice = number | 'all'
export interface NarrationRunPart {
  number: number
  first: number
  last: number
  chapters: string[]
  complete: boolean
}
export interface NarrationRunScope {
  part: NarrationPartChoice
  parts: NarrationRunPart[]
  chapters: string[]
}

/** Fixed chapter ranges, independent of which earlier scripts a phone still retains. */
export function narrationRunScope(
  chapters: { name: string; number: number; complete: boolean }[],
  control?: LibraryControl,
  choice?: NarrationPartChoice
): NarrationRunScope {
  const groups = new Map<number, typeof chapters>()
  for (const chapter of [...chapters].sort((a, b) => a.number - b.number)) {
    const number = Math.max(1, Math.ceil(chapter.number / PART_CHAPTERS))
    const group = groups.get(number) ?? []
    group.push(chapter)
    groups.set(number, group)
  }
  if (typeof choice === 'number' && !groups.has(choice)) groups.set(choice, [])
  const parts = [...groups].sort(([a], [b]) => a - b).map(([number, entries]) => {
    const mark = control?.parts?.[String(number)]
    const manual = !!mark?.done && mark.at > (control?.restart?.at ?? 0)
    return { number, first: (number - 1) * PART_CHAPTERS + 1, last: number * PART_CHAPTERS,
      chapters: entries.map(c => c.name), complete: manual || entries.length > 0 && entries.every(c => c.complete) }
  })
  const part = choice ?? parts.find(p => !p.complete)?.number ?? parts.at(-1)?.number ?? 'all'
  return { part, parts, chapters: parts.filter(p => part === 'all' || p.number === part).flatMap(p => p.chapters) }
}
