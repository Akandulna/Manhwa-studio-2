import {hiddenLibraryFolders} from '../services/libraryControls.js'
import { withSeriesActivity } from '../services/seriesActivity.js'
/**
 * Narration API Routes
 *
 * The Sleeper-Cell phones write the narration scripts and voice them, and
 * upload both to R2. The desktop's Narration only brings them onto this Mac
 * and aligns them: each chapter's script and voiceover come down from R2, and
 * alignment then builds every section's "Script with Timeline" and the
 * chapter's alignment document (script-timeline.md, see alignmentDocument.ts).
 *
 *   GET  /series?lang=                     every manhwa, with chapters scripted / voiced / aligned
 *   GET  /series/:id?lang=                 its chapters' script, audio and alignment, and a running phone fetch
 *   GET  /alignment/status                 whether the WhisperX aligner can run on this Mac
 *   POST /series/:id/phone/preview?lang=   what "Fetch from phone" would bring (reads R2: one HEAD,
 *                                          the script zip if new, one or two LISTs)
 *   POST /series/:id/phone/fetch?lang=     { scriptsEtag?, scriptChapterIds, voiceoverChapterIds } — start
 *                                          the fetch; progress on `narration:fetch`, alignment on `alignment:*`
 *   POST /chapters/:id/align?lang=         align a chapter's unaligned sections again (or write its
 *                                          missing document), in the background
 *
 * R2 is only read from the two phone routes, which only the Fetch button calls.
 */

import { Router, Request, Response } from 'express'
import type { Server } from 'socket.io'
import { prisma } from '../index.js'
import { importPhoneScripts, previewPhoneScripts, type PhoneImportResult } from '../services/phoneScriptImport.js'
import {
  fetchPhoneVoiceover,
  previewPhoneVoiceover,
  voiceoverFetchedAt,
  type PhoneVoiceoverFetch
} from '../services/phoneVoiceoverImport.js'
import { getR2Config } from '../services/r2Service.js'
import { alignChapter, alignSection, checkAlignmentAvailable, pendingAlignments } from '../services/alignment/alignmentService.js'
import { resetSectionAlignment } from '../services/alignment/resetAlignment.js'
import { hasAlignmentDocument, writeAlignmentDocument } from '../services/alignment/alignmentDocument.js'
import { NarrationLanguage, requestLanguage } from '../services/narrationLanguage.js'
import { getReplacementScript, replaceChapterScript, scriptReplacementBusy, ScriptReplacementError } from '../services/scriptReplacement.js'

const router = Router()

let io: Server | null = null

export function initNarrationRoutes(socketIo: Server): Router {
  io = socketIo
  return router
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** Script rows that hold a script (the phone imports them as done). */
const SCRIPT_WRITTEN = ['done', 'edited', 'stale']

/** A section counts as aligned once it has a non-empty timeline. */
const ALIGNED = { AND: [{ timelineScript: { not: null } }, { timelineScript: { not: '' } }] }

interface SectionCounts {
  sections: number
  withAudio: number
  aligned: number
}

/** Per chapter: its sections in `language`, how many have audio and how many are aligned. */
async function sectionCounts(
  language: NarrationLanguage,
  chapter: { seriesId?: string; status: string }
): Promise<Map<string, SectionCounts>> {
  const where = { language, chapter }
  const [total, withAudio, aligned] = await Promise.all([
    prisma.audioSection.groupBy({ by: ['chapterId'], where, _count: { _all: true } }),
    prisma.audioSection.groupBy({ by: ['chapterId'], where: { ...where, audioFile: { isNot: null } }, _count: { _all: true } }),
    prisma.audioSection.groupBy({ by: ['chapterId'], where: { ...where, ...ALIGNED }, _count: { _all: true } })
  ])
  const counts = new Map<string, SectionCounts>()
  const entry = (chapterId: string) => {
    let row = counts.get(chapterId)
    if (!row) counts.set(chapterId, (row = { sections: 0, withAudio: 0, aligned: 0 }))
    return row
  }
  for (const g of total) entry(g.chapterId).sections = g._count._all
  for (const g of withAudio) entry(g.chapterId).withAudio = g._count._all
  for (const g of aligned) entry(g.chapterId).aligned = g._count._all
  return counts
}

const NO_SECTIONS: SectionCounts = { sections: 0, withAudio: 0, aligned: 0 }

// ============ Phone fetch jobs ============

/** A "Fetch from phone" run, as emitted on `narration:fetch`. */
interface PhoneFetchState {
  seriesId: string
  language: NarrationLanguage
  stage: 'scripts' | 'voiceover' | 'done' | 'failed'
  /** Voiceover: the chapter downloading now, as "current of total". */
  chapterNumber?: number
  current?: number
  total?: number
  /** Done: what each half did. */
  scripts?: PhoneImportResult | null
  voiceovers?: PhoneVoiceoverFetch | null
  error?: string
}

/** Fetches running now, by `seriesId:language`, so a page opened mid-run shows it. */
const fetchJobs = new Map<string, PhoneFetchState>()

/** Chapters whose "Align again" is running, by `chapterId:language`. */
const alignRuns = new Set<string>()

async function runPhoneFetch(
  seriesId: string,
  language: NarrationLanguage,
  scriptsEtag: string | null,
  scriptChapterIds: string[],
  voiceoverChapterIds: string[]
): Promise<void> {
  const key = `${seriesId}:${language}`
  const report = (state: Omit<PhoneFetchState, 'seriesId' | 'language'>) => {
    const full = { seriesId, language, ...state }
    if (state.stage === 'done' || state.stage === 'failed') fetchJobs.delete(key)
    else fetchJobs.set(key, full)
    io?.emit('narration:fetch', full)
  }

  try {
    // Scripts first, so the voiceover's script check compares with the new ones.
    let scripts: PhoneImportResult | null = null
    if (scriptChapterIds.length > 0 && scriptsEtag) {
      report({ stage: 'scripts' })
      scripts = await importPhoneScripts(seriesId, scriptsEtag, scriptChapterIds, language)
    }

    let voiceovers: PhoneVoiceoverFetch | null = null
    if (voiceoverChapterIds.length > 0) {
      report({ stage: 'voiceover', current: 0, total: voiceoverChapterIds.length })
      // Each attached chapter queues its sections for alignment, which writes
      // the alignment document once the last one is done.
      voiceovers = await fetchPhoneVoiceover(seriesId, voiceoverChapterIds, io, language, step =>
        report({ stage: 'voiceover', ...step })
      )
    }

    report({ stage: 'done', scripts, voiceovers })
  } catch (error) {
    console.error('[narration] fetch from phone failed:', error)
    report({ stage: 'failed', error: message(error, 'Fetch from phone failed') })
  }
}

// ============ Series / chapters ============

/**
 * Every manhwa with downloaded chapters, and how many of them are scripted,
 * voiced (every section has audio) and aligned (every section has a timeline)
 * in this language.
 */
router.get('/series', async (req: Request, res: Response) => {
  try {
    const language = requestLanguage(req)
    const hidden=await hiddenLibraryFolders()
    const [series, counts] = await Promise.all([
      prisma.series.findMany({
        where:{rootFolder:{notIn:hidden}},
        include: {
          chapters: {
            where: { status: 'done' },
            select: { id: true, scripts: { where: { language }, select: { status: true } } }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      sectionCounts(language, { status: 'done' })
    ])

    res.json((await withSeriesActivity(series)).map(s => {
      const rows = s.chapters.map(c => counts.get(c.id) ?? NO_SECTIONS)
      return {
        id: s.id,
        title: s.title,
        sourceSite: s.sourceSite,
        rootFolder: s.rootFolder,
        lastActivityAt: s.lastActivityAt,
        chapterCount: s.chapters.length,
        scriptedCount: s.chapters.filter(c => SCRIPT_WRITTEN.includes(c.scripts[0]?.status ?? '')).length,
        voicedCount: rows.filter(r => r.sections > 0 && r.withAudio === r.sections).length,
        alignedCount: rows.filter(r => r.sections > 0 && r.aligned === r.sections).length
      }
    }))
  } catch (error) {
    console.error('Error fetching series for narration:', error)
    res.status(500).json({ error: 'Failed to fetch series' })
  }
})

/**
 * A manhwa's chapters in this language: whether each has a script, its
 * sections with audio and aligned, whether its alignment document is on disk,
 * and when its voiceover was last fetched from the phone.
 */
router.get('/series/:id', async (req: Request, res: Response) => {
  try {
    const language = requestLanguage(req)
    const series = await prisma.series.findUnique({
      where: { id: req.params.id },
      include: {
        chapters: {
          where: { status: 'done' },
          select: {
            id: true,
            number: true,
            title: true,
            folderPath: true,
            scripts: { where: { language }, select: { status: true } }
          },
          orderBy: { number: 'asc' }
        }
      }
    })
    if (!series) return res.status(404).json({ error: 'Series not found' })

    const counts = await sectionCounts(language, { seriesId: series.id, status: 'done' })
    const chapters = await Promise.all(series.chapters.map(async c => {
      const sections = counts.get(c.id) ?? NO_SECTIONS
      const [documentWritten, fetchedAt] = await Promise.all([
        hasAlignmentDocument(c.folderPath, language),
        voiceoverFetchedAt(c.folderPath, language)
      ])
      return {
        id: c.id,
        number: c.number,
        title: c.title,
        folderPath: c.folderPath,
        hasScript: SCRIPT_WRITTEN.includes(c.scripts[0]?.status ?? ''),
        ...sections,
        aligning: pendingAlignments(c.id, language) > 0 || alignRuns.has(`${c.id}:${language}`),
        documentWritten,
        fetchedAt
      }
    }))

    res.json({
      id: series.id,
      title: series.title,
      rootFolder: series.rootFolder,
      language,
      chapters,
      phoneFetch: fetchJobs.get(`${series.id}:${language}`) ?? null
    })
  } catch (error) {
    console.error('Error fetching series:', error)
    res.status(500).json({ error: 'Failed to fetch series' })
  }
})

/** Whether the forced-alignment sidecar can run on this machine. */
router.get('/alignment/status', async (_req: Request, res: Response) => {
  try {
    res.json(await checkAlignmentAvailable())
  } catch (error) {
    res.json({ available: false, error: message(error, 'Alignment check failed') })
  }
})

// ============ Fetch from phone ============

/**
 * What "Fetch from phone" would bring for this series and language: the
 * phone's script zip, chapter by chapter (null when it hasn't uploaded one),
 * and its voiced chapters' zips. A script zip that can't be read is reported
 * beside the voiceovers rather than failing both.
 */
router.post('/series/:id/phone/preview', async (req: Request, res: Response) => {
  try {
    const language = requestLanguage(req)
    if (!getR2Config()) return res.json({ configured: false, scripts: null, scriptsError: null, voiceovers: null })

    const [scripts, voiceovers] = await Promise.all([
      previewPhoneScripts(req.params.id, language).then(
        preview => ({ preview, error: null as string | null }),
        error => ({ preview: null, error: message(error, 'Could not read the phone\'s script zip') })
      ),
      previewPhoneVoiceover(req.params.id, language)
    ])
    res.json({ configured: true, scripts: scripts.preview, scriptsError: scripts.error, voiceovers })
  } catch (error) {
    console.error('[narration] phone preview failed:', error)
    res.status(400).json({ error: message(error, 'Could not look at the phone\'s uploads') })
  }
})

/**
 * Starts fetching the ticked chapters: their scripts from the previewed zip
 * (refused if the phone uploaded a newer one since), then their voiceovers.
 * Answers at once; progress and the outcome arrive on `narration:fetch`.
 */
router.post('/series/:id/phone/fetch', async (req: Request, res: Response) => {
  try {
    const language = requestLanguage(req)
    const seriesId = req.params.id
    const { scriptsEtag, scriptChapterIds, voiceoverChapterIds } = req.body ?? {}
    const ids = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
    const scriptIds = ids(scriptChapterIds)
    const voiceoverIds = ids(voiceoverChapterIds)

    if (!getR2Config()) return res.status(400).json({ error: 'Cloudflare R2 is not set up' })
    if (scriptIds.length === 0 && voiceoverIds.length === 0) {
      return res.status(400).json({ error: 'Tick at least one chapter' })
    }
    if (scriptIds.length > 0 && (typeof scriptsEtag !== 'string' || !scriptsEtag)) {
      return res.status(400).json({ error: 'scriptsEtag is required to import scripts' })
    }
    if (fetchJobs.has(`${seriesId}:${language}`)) {
      return res.status(409).json({ error: 'A fetch for this series is already running' })
    }
    if ([...scriptIds, ...voiceoverIds].some(scriptReplacementBusy)) return res.status(409).json({ error: 'Wait for script replacement to finish' })
    const exists = await prisma.series.findUnique({ where: { id: seriesId }, select: { id: true } })
    if (!exists) return res.status(404).json({ error: 'Series not found' })

    // Marked running before answering, so a reload right after shows it.
    fetchJobs.set(`${seriesId}:${language}`, { seriesId, language, stage: scriptIds.length > 0 ? 'scripts' : 'voiceover' })
    runPhoneFetch(seriesId, language, scriptIds.length > 0 ? scriptsEtag : null, scriptIds, voiceoverIds)
    res.json({ started: true })
  } catch (error) {
    console.error('[narration] starting the phone fetch failed:', error)
    res.status(500).json({ error: message(error, 'Could not start the fetch') })
  }
})

// ============ Alignment ============

router.get('/chapters/:id/script', async (req: Request, res: Response) => {
  try { res.json(await getReplacementScript(req.params.id, requestLanguage(req))) }
  catch (error) { res.status(error instanceof ScriptReplacementError ? error.status : 500).json({ error: message(error, 'Could not read script') }) }
})

router.post('/chapters/:id/script/replace', async (req: Request, res: Response) => {
  try {
    const language = requestLanguage(req)
    const chapter = await prisma.chapter.findUnique({ where: { id: req.params.id }, select: { seriesId: true } })
    if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
    if (fetchJobs.has(`${chapter.seriesId}:${language}`) || alignRuns.has(`${req.params.id}:${language}`)) {
      return res.status(409).json({ error: 'Wait for this chapter’s fetch or alignment to finish' })
    }
    const result = await replaceChapterScript(req.params.id, language, req.body ?? {})
    io?.emit('narration:script-replaced', { chapterId: req.params.id, language })
    res.json(result)
  } catch (error) { res.status(error instanceof ScriptReplacementError ? error.status : 500).json({ error: message(error, 'Could not replace script') }) }
})

/**
 * Aligns the chapter's sections that have audio but no timeline yet (after a
 * failed or interrupted alignment). With every section aligned already, it
 * only writes the alignment document if that's missing. Runs in the
 * background; progress arrives on `alignment:progress` / `alignment:chapter-complete`.
 */
router.get('/chapters/:id/alignment-sections', async (req: Request, res: Response) => {
  try {
    const sections = await prisma.audioSection.findMany({
      where: { chapterId: req.params.id, language: requestLanguage(req) }, orderBy: { index: 'asc' },
      select: { id: true, index: true, timelineScript: true, audioFile: { select: { durationMs: true, status: true } } }
    })
    res.json(sections.map(s => ({ id: s.id, number: s.index + 1,
      audioReady: s.audioFile?.status === 'done', durationSec: (s.audioFile?.durationMs ?? 0) / 1000,
      aligned: !!s.timelineScript?.trim() })))
  } catch (error) { res.status(500).json({ error: message(error, 'Could not load sections') }) }
})

router.post('/chapters/:id/alignment-sections/:sectionId/reset', async (req: Request, res: Response) => {
  const chapterId = req.params.id
  const language = requestLanguage(req)
  const key = `${chapterId}:${language}`
  if (alignRuns.has(key) || pendingAlignments(chapterId, language) > 0 || scriptReplacementBusy(chapterId)) {
    return res.status(409).json({ error: 'Wait for this chapter’s alignment or script replacement to finish' })
  }
  const chapter = await prisma.chapter.findUnique({ where: { id: chapterId }, select: { seriesId: true } })
  if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
  if (fetchJobs.has(`${chapter.seriesId}:${language}`)) return res.status(409).json({ error: 'Wait for the phone fetch to finish' })
  // Reserve synchronously before any further awaits; the normal retry uses this same lock.
  if (alignRuns.has(key)) return res.status(409).json({ error: 'This chapter is already aligning' })
  alignRuns.add(key)
  try {
    const available = await checkAlignmentAvailable()
    if (!available.available) throw new Error(available.error ?? 'The aligner is unavailable')
    await resetSectionAlignment(chapterId, req.params.sectionId, language)
    io?.emit('alignment:progress', { chapterId, language, stage: 'aligning' })
    void alignSection(req.params.sectionId, io ?? undefined)
      .then(() => io?.emit('alignment:chapter-complete', { chapterId, language }))
      .catch(error => console.error('[narration] targeted alignment failed:', message(error, 'Alignment failed')))
      .finally(() => alignRuns.delete(key))
    res.json({ started: true })
  } catch (error) {
    alignRuns.delete(key)
    res.status(400).json({ error: message(error, 'Could not reset alignment') })
  }
})

router.post('/chapters/:id/align', async (req: Request, res: Response) => {
  try {
    const language = requestLanguage(req)
    const chapterId = req.params.id
    if (scriptReplacementBusy(chapterId)) return res.status(409).json({ error: 'Wait for script replacement to finish' })
    const key = `${chapterId}:${language}`
    const chapter = await prisma.chapter.findUnique({ where: { id: chapterId }, select: { id: true } })
    if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
    if (alignRuns.has(key) || pendingAlignments(chapterId, language) > 0) {
      return res.status(409).json({ error: 'This chapter is already aligning' })
    }

    const [withAudio, missing] = await Promise.all([
      prisma.audioSection.count({ where: { chapterId, language, audioFile: { isNot: null } } }),
      prisma.audioSection.count({ where: { chapterId, language, audioFile: { isNot: null }, NOT: ALIGNED } })
    ])
    if (withAudio === 0) return res.status(400).json({ error: 'This chapter has no voiceover audio yet' })

    if (missing === 0) {
      const documentWritten = await writeAlignmentDocument(chapterId, language)
      return res.json({ started: false, sections: 0, documentWritten })
    }

    alignRuns.add(key)
    alignChapter(chapterId, io ?? undefined, language, { onlyMissing: true })
      .catch(error => console.error(`[narration] aligning chapter ${chapterId} failed:`, message(error, 'Alignment failed')))
      .finally(() => alignRuns.delete(key))
    res.json({ started: true, sections: missing })
  } catch (error) {
    console.error('Error aligning chapter:', error)
    res.status(500).json({ error: message(error, 'Alignment failed') })
  }
})

export default router
