/** Fixed production parts, independent of narration breaks and the destructive storage archive. */
export const PART_CHAPTERS = 20
export const PROCESS_STAGES = [
  'download', 'cleanup', 'stitch', 'script_en', 'script_hi',
  'split_en', 'voice_en', 'split_hi', 'voice_hi', 'align_en', 'align_hi',
  'crop_json', 'review', 'crop', 'metadata', 'timeline_en', 'processed_en', 'export_en', 'timeline_hi', 'processed_hi', 'export_hi'
] as const
export type ProcessStage = typeof PROCESS_STAGES[number]
export type ProcessState = 'pending' | 'active' | 'partial' | 'review' | 'failed' | 'done'
export interface StageProgress { state: ProcessState; done?: number; total?: number }
export type ChapterStages = Record<ProcessStage, StageProgress>
export interface ProcessChapter { id: string; name: string; number: number; stages: ChapterStages; pageRevision?: string; restartRevision?: string }
export interface StageCount { done: number; total: number; active: number; attention: number; unitsDone: number; unitsTotal: number }
export interface ProcessPart {
  number: number; firstChapter: number; lastChapter: number; complete: boolean; manualComplete?: boolean; present: number; expected: number
  stages: Record<ProcessStage, StageCount>; chapters: ProcessChapter[]
}
export interface ProcessSeries {
  seriesId: string; folder: string; title: string; completedParts: number[]; completedThrough: number
  parts: ProcessPart[]; stages: Record<ProcessStage, StageCount>
}
export interface ProcessSnapshot { schema: 'series-process/1'; deviceId: string; updatedAt: string; series: ProcessSeries[] }
export const emptyStages = (): ChapterStages => Object.fromEntries(PROCESS_STAGES.map(s => [s, { state: 'pending' }])) as ChapterStages
export const stage = (done: number, total: number, active = false): StageProgress => ({
  state: total > 0 && done >= total ? 'done' : active ? 'active' : done > 0 ? 'partial' : 'pending', done, total
})

/** Completion on any device counts once. Counts from duplicate copies are never added together. */
export function mergeStage(a: StageProgress, b: StageProgress): StageProgress {
  if (a.state === 'done') return a
  if (b.state === 'done') return b
  const rank: ProcessState[] = ['pending', 'partial', 'failed', 'review', 'active', 'done']
  const better = rank.indexOf(b.state) > rank.indexOf(a.state) || (b.state === a.state && (b.done ?? 0) > (a.done ?? 0))
  return better ? b : a
}

function counts(chapters: ProcessChapter[], expected: number): Record<ProcessStage, StageCount> {
  return Object.fromEntries(PROCESS_STAGES.map(key => [key, {
    done: chapters.filter(c => c.stages[key].state === 'done').length, total: expected,
    active: chapters.filter(c => c.stages[key].state === 'active').length,
    attention: chapters.filter(c => ['failed', 'review'].includes(c.stages[key].state)).length,
    unitsDone: chapters.reduce((n, c) => n + (c.stages[key].done ?? 0), 0),
    unitsTotal: chapters.reduce((n, c) => n + (c.stages[key].total ?? 0), 0)
  }])) as Record<ProcessStage, StageCount>
}

export function buildProcessSeries(series: { id: string; rootFolder: string; title: string }, chapters: ProcessChapter[], manualParts: number[] = []): ProcessSeries {
  const groups = new Map<number, ProcessChapter[]>()
  for (const ch of chapters) {
    const part = Math.max(1, Math.ceil(ch.number / PART_CHAPTERS))
    groups.set(part, [...(groups.get(part) ?? []), ch])
  }
  for (const number of manualParts) if (!groups.has(number)) groups.set(number, [])
  const parts: ProcessPart[] = [...groups].sort(([a], [b]) => a - b).map(([number, entries]) => {
    const firstChapter = (number - 1) * PART_CHAPTERS + 1
    const lastChapter = number * PART_CHAPTERS
    // A partial import or a hole in the chapter range must never appear completed.
    const allNumbersPresent = Array.from({ length: PART_CHAPTERS }, (_, i) => firstChapter + i).every(n => entries.some(c => c.number === n))
    const expected = Math.max(PART_CHAPTERS, entries.length)
    const manualComplete = manualParts.includes(number)
    const complete = manualComplete || allNumbersPresent && entries.every(c => c.stages.export_en.state === 'done' && c.stages.export_hi.state === 'done')
    return { number, firstChapter, lastChapter, complete, manualComplete, present: entries.length, expected, stages: counts(entries, expected), chapters: entries.sort((a, b) => a.number - b.number) }
  })
  const completedParts = parts.filter(p => p.complete).map(p => p.number)
  let completedThrough = 0
  while (completedParts.includes(completedThrough + 1)) completedThrough++
  return { seriesId: series.id, folder: series.rootFolder, title: series.title, completedParts, completedThrough,
    parts, stages: counts(chapters, parts.reduce((n, p) => n + p.expected, 0)) }
}

/** Progress changes settle for this long before a publication; while changes keep coming, one goes out at most this often. */
export const PROCESS_PUBLISH_DEBOUNCE_MS = 600
export const PROCESS_PUBLISH_INTERVAL_MS = 30_000
/** The wait before the next relay/R2 publication: the debounce when quiet, else until the interval since the last one ends. */
export function processPublishDelay(lastStartedAt: number, now: number): number {
  if (!lastStartedAt || now < lastStartedAt) return PROCESS_PUBLISH_DEBOUNCE_MS
  return Math.max(PROCESS_PUBLISH_DEBOUNCE_MS, lastStartedAt + PROCESS_PUBLISH_INTERVAL_MS - now)
}
