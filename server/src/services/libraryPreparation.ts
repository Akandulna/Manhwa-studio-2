/** Origin-only preparation. Receivers install the resulting pages without re-cutting them. */
import fs from 'fs/promises'
import path from 'path'
import { prisma } from '../index.js'
import { chapterDir, getStitchState, STITCH_MAX_HEIGHT, stitchChapter } from './pageStitch.js'
import { profilePages } from './stitchAnalysis.js'
import { detectIntroOutro } from './stitchIntroOutro.js'
import { autoOptions, blankBands, buildStrip, outputPieces, planChapter } from './libraryPagePlan.js'

export async function prepareLibrarySeries(seriesId: string, chapterIds?: string[]): Promise<void> {
  const chapters = await prisma.chapter.findMany({
    where: { seriesId, status: 'done', completedAt: null, ...(chapterIds ? { id: { in: chapterIds } } : {}) },
    orderBy: { number: 'asc' }
  })
  for (const chapter of chapters) {
    const marker = path.join(chapterDir(chapter.folderPath), '.library-prepared.json')
    if (await fs.access(marker).then(() => true, () => false)) continue
    const state = await getStitchState(chapter)
    // A manual stitch has already prepared the pages. Never rewrite existing production work.
    if (!state.stitched) {
      if (state.blockers.length) throw new Error(state.blockers[0])
      if (!state.pages.length) continue
      const profiles = await profilePages(chapterDir(chapter.folderPath), state.pages)
      const edges = await detectIntroOutro(chapter, state.pages)
      const strip = buildStrip(state.pages, profiles, new Set())
      const plan = planChapter(strip, blankBands(strip), autoOptions(12_000, STITCH_MAX_HEIGHT), edges)
      const groups = outputPieces(strip, plan.cuts, plan.dropped)
      if (!groups.length) throw new Error(`Preparation produced no pages for chapter ${chapter.number}`)
      await stitchChapter(chapter, groups)
    }
    await fs.writeFile(marker, JSON.stringify({ version: 1, preparedAt: new Date().toISOString() }))
  }
}
