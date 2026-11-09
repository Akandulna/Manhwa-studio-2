import path from 'node:path'
import { prisma } from '../index.js'
import { libraryControls } from './libraryControls.js'
import type { LibraryControl } from './libraryControlModel.js'
import { PART_CHAPTERS } from './seriesProcessModel.js'
import { narrationRunScope, type NarrationPartChoice } from './narrationRunScope.js'

/** Completed parts stay excluded even when a phone still retains their scripts. */
export function unfinishedVoiceoverChapters<T extends { number: number | null; completedAt?: unknown }>(chapters: T[], control?: LibraryControl): T[] {
  const completed = new Set(Object.entries(control?.parts ?? {})
    .filter(([, mark]) => mark.done && mark.at > (control?.restart?.at ?? 0))
    .map(([part]) => Number(part)))
  return chapters.filter(chapter => !chapter.completedAt &&
    (chapter.number == null || !completed.has(Math.max(1, Math.ceil(chapter.number / PART_CHAPTERS)))))
}

/** Shared by the run, its checklist and split planning so all use the same chapter range. */
/**
 * `part` narrows the run to one twenty-chapter part (Run automation's Part picker); omitted or
 * 'all' keeps every unfinished chapter. Chapters outside the part are `excluded` too.
 */
export async function voiceoverChapterScope(seriesId: string, part?: NarrationPartChoice) {
  const row = await prisma.series.findUnique({ where: { id: seriesId }, select: { rootFolder: true } })
  if (!row) throw new Error('Series not found')
  const all = await prisma.chapter.findMany({ where: { seriesId },
    select: { id: true, folderPath: true, number: true, completedAt: true }, orderBy: { number: 'asc' } })
  const control = (await libraryControls()).find(c => c.folder === path.basename(row.rootFolder))
  const unfinished = unfinishedVoiceoverChapters(all, control)
  const parts = narrationRunScope(unfinished.map(c => ({ name: path.basename(c.folderPath), number: c.number ?? 0, complete: false })),
    undefined, part ?? 'all')
  const inPart = new Set(parts.chapters)
  const chapters = unfinished.filter(c => inPart.has(path.basename(c.folderPath)))
  const kept = new Set(chapters.map(c => c.id))
  return { chapters, excluded: all.filter(c => !kept.has(c.id)).map(c => path.basename(c.folderPath)), parts }
}
