import type { Clipper3ChapterSummary, ProcessSeries } from './api'

export const CLIPPER_PART_SIZE = 20

export function clipperPartNumber(chapterNumber: number): number {
  return Math.max(1, Math.ceil(chapterNumber / CLIPPER_PART_SIZE))
}

/** A later export cannot skip an unfinished earlier part; either complete language counts. */
export function currentClipperPart(series?: ProcessSeries): number {
  const finished = new Set(series?.parts.filter(part => part.manualComplete || ['en', 'hi'].some(language =>
    Array.from({ length: CLIPPER_PART_SIZE }, (_, i) => part.firstChapter + i).every(number =>
      part.chapters.some(chapter => chapter.number === number &&
        chapter.stages[language === 'en' ? 'export_en' : 'export_hi'].state === 'done')
    )
  )).map(part => part.number))
  let current = 1
  while (finished.has(current)) current++
  return current
}

export function clipperChapterParts<T extends { number: number }>(chapters: T[]) {
  const parts = new Map<number, T[]>()
  for (const chapter of [...chapters].sort((a, b) => a.number - b.number)) {
    const number = clipperPartNumber(chapter.number)
    const group = parts.get(number) ?? []
    group.push(chapter)
    parts.set(number, group)
  }
  return [...parts].sort(([a], [b]) => a - b).map(([number, entries]) => ({ number, chapters: entries }))
}

export function canBulkCrop(summary?: Clipper3ChapterSummary): boolean {
  return !!summary?.review.reviewed && summary.fullyAttached && !summary.cropComplete && !summary.cropping
}
