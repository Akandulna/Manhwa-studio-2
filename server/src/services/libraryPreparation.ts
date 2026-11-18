/** Origin-only preparation. Receivers install the resulting pages without re-cutting them. */
import fs from 'fs/promises'
import path from 'path'
import { prisma } from '../index.js'
import { chapterDir, getStitchState, STITCH_MAX_HEIGHT, stitchChapter } from './pageStitch.js'
import { profilePages } from './stitchAnalysis.js'
import { detectIntroOutro } from './stitchIntroOutro.js'
import { autoOptions, blankBands, buildStrip, outputPieces, planChapter } from './libraryPagePlan.js'
import { withStitchActivity } from './stitchActivity.js'

/** Which chapter preparation is on: `index` counts from 1 over the chapters still to prepare. */
export interface PreparationProgress { chapterNumber: number; index: number; total: number }

export async function prepareLibrarySeries(seriesId: string, chapterIds?: string[], onProgress?: (progress: PreparationProgress) => void): Promise<void> {
  const chapters = await prisma.chapter.findMany({
    where: { seriesId, status: 'done', completedAt: null, ...(chapterIds ? { id: { in: chapterIds } } : {}) },
    orderBy: { number: 'asc' }
  })
  const waiting = []
  for (const chapter of chapters) {
    const marker = path.join(chapterDir(chapter.folderPath), '.library-prepared.json')
    if (!(await fs.access(marker).then(() => true, () => false))) waiting.push({ chapter, marker })
  }
  for (const [i, { chapter, marker }] of waiting.entries()) {
    onProgress?.({ chapterNumber: chapter.number, index: i + 1, total: waiting.length })
    await withStitchActivity(chapter.folderPath, async () => {
      const state = await getStitchState(chapter)
      // A manual stitch has already prepared the pages. Never rewrite existing production work.
      if (!state.stitched) {
        if (state.blockers.length) throw new Error(state.blockers[0])
        if (!state.pages.length) return
        const profiles = await profilePages(chapterDir(chapter.folderPath), state.pages)
        const edges = await detectIntroOutro(chapter, state.pages)
        const strip = buildStrip(state.pages, profiles, new Set())
        const plan = planChapter(strip, blankBands(strip), autoOptions(12_000, STITCH_MAX_HEIGHT), edges)
        const groups = outputPieces(strip, plan.cuts, plan.dropped)
        if (!groups.length) throw new Error(`Preparation produced no pages for chapter ${chapter.number}`)
        await stitchChapter(chapter, groups)
      }
      await fs.writeFile(marker, JSON.stringify({ version: 1, preparedAt: new Date().toISOString() }))
    })
  }
}
