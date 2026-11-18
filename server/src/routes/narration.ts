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
 *   POST /chapters/:id/voiceover/manual?lang=  multipart `file`: one audio file as the chapter's whole
 *                                          voiceover, then aligned like a fetched one
 *   POST /chapters/:id/voiceover/reset?lang=   removes the chapter's voiceover in this language here, in R2
 *                                          and (when they next check) on the phones; see voiceoverReset.ts
 *   POST /chapters/:id/align?lang=         align a chapter's unaligned sections again (or write its
 *                                          missing document), in the background
 *
 * R2 is only read from the two phone routes, which only the Fetch button calls.
 */

import { Router, Request, Response } from 'express'
import multer from 'multer'
import fs from 'fs/promises'
import path from 'path'
import type { Server } from 'socket.io'
import { prisma } from '../index.js'
import { chapterManualPrompts, manualCorrectionPrompt } from '../services/narrationManualPrompts.js'
import { removeManualSlices } from '../services/narrationManualSlices.js'
import { importPhoneScripts, phoneScriptFiles, previewPhoneScripts, type PhoneImportResult } from '../services/phoneScriptImport.js'
import { keepStudioVersion, narrationSeriesOpened, openConflicts, scheduleNarrationAutoSync } from '../services/phoneNarrationAutoSync.js'
import { listMetadataImageStems } from '../services/clipper3/perImageStore.js'
import {
  fetchPhoneVoiceover,
  previewPhoneVoiceover,
  voiceoverOrigin,
  type PhoneVoiceoverFetch
} from '../services/phoneVoiceoverImport.js'
import { getR2Config } from '../services/r2Service.js'
import { phoneFetchJobs, type PhoneFetchState } from '../services/narrationFetchJobs.js'
import { alignChapter, alignSection, alignmentProgress, checkAlignmentAvailable, pendingAlignments } from '../services/alignment/alignmentService.js'
import { resetSectionAlignment } from '../services/alignment/resetAlignment.js'
import { hasAlignmentDocument, writeAlignmentDocument } from '../services/alignment/alignmentDocument.js'
import { NarrationLanguage, requestLanguage } from '../services/narrationLanguage.js'
import { addManualVoiceover, ManualVoiceoverError, MAX_MANUAL_VOICEOVER_BYTES } from '../services/manualVoiceover.js'
import { resetChapterVoiceover, VoiceoverResetError } from '../services/voiceoverReset.js'
import { getReplacementScript, replaceChapterScript, scriptReplacementBusy, ScriptReplacementError } from '../services/scriptReplacement.js'
import { clearChapterScripts } from '../services/scriptClear.js'
import { getPublishedChapters } from '../services/storageService.js'

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

/** Fetches running now (yours and Studio's automatic ones), by `seriesId:language`, so a page opened mid-run shows it. */
const fetchJobs = phoneFetchJobs

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
      const [documentWritten, origin] = await Promise.all([
        hasAlignmentDocument(c.folderPath, language),
        voiceoverOrigin(c.folderPath, language)
      ])
      return {
        id: c.id,
        number: c.number,
        title: c.title,
        folderPath: c.folderPath,
        hasScript: SCRIPT_WRITTEN.includes(c.scripts[0]?.status ?? ''),
        ...sections,
        aligning: pendingAlignments(c.id, language) > 0 || alignRuns.has(`${c.id}:${language}`),
        alignmentProgress: alignmentProgress(c.id, language),
        documentWritten,
        fetchedAt: origin.at,
        voiceoverManual: origin.manual
      }
    }))

    // Finished scripts and voiceovers the phones sent since: fetched in the background (gaps only).
    narrationSeriesOpened(series.id)
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

// ============ Phone versions that differ ============

/**
 * Chapters where a phone has finished a different script than Studio's, which
 * automatic fetching never imports: both texts, and what in Studio was made
 * from Studio's script (so you can see what a switch would need redone).
 * Chapters where you kept Studio's version are left out until a phone sends
 * yet another version.
 */
router.get('/series/:id/phone/conflicts', async (req: Request, res: Response) => {
  try {
    const language = requestLanguage(req)
    if (!getR2Config()) return res.json({ conflicts: [] })
    const preview = await previewPhoneScripts(req.params.id, language)
    const open = await openConflicts(preview, language)
    if (open.length === 0) return res.json({ conflicts: [] })
    const phone = await phoneScriptFiles(req.params.id, language)
    const counts = await sectionCounts(language, { seriesId: req.params.id, status: 'done' })
    const conflicts = []
    for (const row of open) {
      const chapter = await prisma.chapter.findUnique({
        where: { id: row.chapterId },
        select: { folderPath: true, scripts: { where: { language: 'hi' }, select: { status: true } } }
      })
      const files = phone?.chapters.find(c => c.folder === row.folder)
      if (!chapter || !files?.script) continue
      const dir = path.join(process.env.DOWNLOAD_ROOT || './downloads', chapter.folderPath)
      const studioScript = await fs.readFile(path.join(dir, language === 'en' ? 'script.md' : 'script.hi.md'), 'utf-8').then(t => t.trim(), () => '')
      const sections = counts.get(row.chapterId) ?? NO_SECTIONS
      const timeline = await prisma.editor2Timeline.findUnique({ where: { chapterId_language: { chapterId: row.chapterId, language } } })
      conflicts.push({
        chapterId: row.chapterId,
        number: row.number,
        folder: row.folder,
        phoneSha256: row.phoneSha256,
        device: row.device,
        phoneSavedAt: row.savedAt,
        phoneScript: files.script,
        studioScript,
        studioStatus: row.desktopStatus,
        affects: {
          // Crop descriptions are linked to the English script.
          metadataPages: language === 'en' ? (await listMetadataImageStems(chapter.folderPath)).size : 0,
          voiceoverSections: sections.withAudio,
          alignedSections: sections.aligned,
          hinglish: language === 'en' && SCRIPT_WRITTEN.includes(chapter.scripts[0]?.status ?? ''),
          timeline: !!timeline?.json
        }
      })
    }
    res.json({ conflicts, etag: preview?.zip.etag ?? null })
  } catch (error) {
    console.error('[narration] phone conflicts failed:', error)
    res.status(400).json({ error: message(error, 'Could not compare the phones\' scripts') })
  }
})

/**
 * Your choice for one differing chapter: "phone" imports the phone's script
 * (what was made from Studio's script then needs redoing, as after any
 * replaced script); "studio" keeps Studio's and stops asking about this
 * phone version.
 */
router.post('/series/:id/phone/conflicts/resolve', async (req: Request, res: Response) => {
  try {
    const language = requestLanguage(req)
    const seriesId = req.params.id
    const { chapterId, choice, phoneSha256 } = req.body ?? {}
    if (typeof chapterId !== 'string' || typeof phoneSha256 !== 'string' || (choice !== 'phone' && choice !== 'studio')) {
      return res.status(400).json({ error: 'chapterId, phoneSha256 and choice (phone or studio) are required' })
    }
    if (fetchJobs.has(`${seriesId}:${language}`)) return res.status(409).json({ error: 'Wait for the phone fetch to finish' })
    if (scriptReplacementBusy(chapterId)) return res.status(409).json({ error: 'Wait for script replacement to finish' })
    const preview = await previewPhoneScripts(seriesId, language)
    const row = preview?.chapters.find(c => c.chapterId === chapterId)
    if (!preview || !row || row.action !== 'replace' || !row.textDiffers || row.phoneSha256 !== phoneSha256) {
      return res.status(409).json({ error: 'The phone version changed since you opened it. Open it again.' })
    }
    if (choice === 'studio') {
      await keepStudioVersion(chapterId, language, phoneSha256)
      return res.json({ kept: true })
    }
    // You saw both texts: a script Studio replaced earlier doesn't block the phone's.
    const result = await importPhoneScripts(seriesId, preview.zip.etag, [chapterId], language, { about: 'fill', overStudioReplacement: true })
    // A Hinglish script converted from the new English may now be importable.
    if (language === 'en') scheduleNarrationAutoSync(seriesId, 2_000)
    res.json({ imported: result.imported })
  } catch (error) {
    console.error('[narration] resolving phone version failed:', error)
    res.status(400).json({ error: message(error, 'Could not apply your choice') })
  }
})

// ============ Clear scripts ============

/**
 * The chapters with a script in Studio (either language) that Clear scripts
 * could clear, with what the phones have finished for each (null per language
 * when R2 can't be read), so chapters the phones no longer have stand out.
 */
router.get('/series/:id/scripts/clearable', async (req: Request, res: Response) => {
  try {
    const seriesId = req.params.id
    const chapters = await prisma.chapter.findMany({
      where: { seriesId, status: 'done', completedAt: null },
      select: { id: true, number: true, title: true, scripts: { select: { language: true, status: true } },
        _count: { select: { audioSections: true } } },
      orderBy: { number: 'asc' }
    })
    const scripted = chapters.filter(c => c.scripts.some(s => SCRIPT_WRITTEN.includes(s.status)))
    const phone: Partial<Record<NarrationLanguage, Set<string> | null>> = {}
    const published: Partial<Record<NarrationLanguage, Record<string, unknown>>> = {}
    for (const language of ['en', 'hi'] as const) {
      phone[language] = !getR2Config() ? null : await previewPhoneScripts(seriesId, language).then(
        preview => new Set(preview?.chapters.map(c => c.chapterId) ?? []),
        error => { console.warn(`[narration] clearable: phone ${language} scripts unreadable:`, message(error, 'R2')); return null })
      published[language] = (await getPublishedChapters(seriesId, language)).chapters
    }
    res.json({
      chapters: scripted.map(c => ({
        chapterId: c.id,
        number: c.number,
        title: c.title,
        en: c.scripts.some(s => s.language === 'en' && SCRIPT_WRITTEN.includes(s.status)),
        hi: c.scripts.some(s => s.language === 'hi' && SCRIPT_WRITTEN.includes(s.status)),
        voiceoverSections: c._count.audioSections,
        published: !!published.en?.[c.id] || !!published.hi?.[c.id],
        phoneEn: phone.en ? phone.en.has(c.id) : null,
        phoneHi: phone.hi ? phone.hi.has(c.id) : null
      }))
    })
  } catch (error) {
    console.error('[narration] clearable chapters failed:', error)
    res.status(400).json({ error: message(error, 'Could not list the chapters') })
  }
})

/** Clears the ticked chapters' English and Hinglish scripts and what was made from them (see scriptClear.ts). */
router.post('/series/:id/scripts/clear', async (req: Request, res: Response) => {
  try {
    const seriesId = req.params.id
    const chapterIds = Array.isArray(req.body?.chapterIds) ? req.body.chapterIds.filter((id: unknown): id is string => typeof id === 'string') : []
    if (fetchJobs.has(`${seriesId}:en`) || fetchJobs.has(`${seriesId}:hi`)) return res.status(409).json({ error: 'Wait for the phone fetch to finish' })
    if (chapterIds.some((id: string) => alignRuns.has(`${id}:en`) || alignRuns.has(`${id}:hi`))) {
      return res.status(409).json({ error: 'Wait for the chapter’s alignment to finish' })
    }
    const result = await clearChapterScripts(seriesId, chapterIds)
    for (const { chapterId } of result.cleared) for (const language of ['en', 'hi'] as const) io?.emit('narration:script-replaced', { chapterId, language })
    res.json(result)
  } catch (error) {
    console.error('[narration] clearing scripts failed:', error)
    res.status(error instanceof ScriptReplacementError ? error.status : 400).json({ error: message(error, 'Could not clear the scripts') })
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

// Copyable prompts for ordinary script replacement and prohibited-content manual completion.
router.get('/chapters/:id/script/manual-prompts', async (req: Request, res: Response) => {
  try {
    const language = requestLanguage(req)
    res.json({ ...(await chapterManualPrompts(req.params.id, language)), correctionTemplate: manualCorrectionPrompt('{error}', language) })
  } catch (error) { res.status((error as { status?: number }).status ?? 400).json({ error: message(error, 'Could not build the prompts') }) }
})

// English only: cuts the pages into ≤2,000 px pieces in a temporary folder (first prompt copy) and returns the prompts listing them.
router.post('/chapters/:id/script/manual-slices', async (req: Request, res: Response) => {
  try {
    if (requestLanguage(req) !== 'en') return res.status(400).json({ error: 'Only English prompts attach pages' })
    res.json({ ...(await chapterManualPrompts(req.params.id, 'en', { slice: true })), correctionTemplate: manualCorrectionPrompt('{error}', 'en') })
  } catch (error) {
    console.error('[narration] cutting pages for the manual prompts failed:', error)
    res.status((error as { status?: number }).status ?? 400).json({ error: message(error, 'Could not cut the pages') })
  }
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
    // The pasted script is saved, so the manual prompts' sliced pages are done with.
    if (language === 'en') await removeManualSlices(req.params.id).catch(error => console.error('[narration] removing the sliced pages failed:', error))
    io?.emit('narration:script-replaced', { chapterId: req.params.id, language })
    res.json(result)
  } catch (error) { res.status(error instanceof ScriptReplacementError ? error.status : 500).json({ error: message(error, 'Could not replace script') }) }
})

// ============ Manual voiceover ============

const voiceoverUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MANUAL_VOICEOVER_BYTES, files: 1, fields: 2 } })

/**
 * Attaches one audio file, chosen by hand, as the whole chapter's voiceover in
 * this language (see manualVoiceover.ts), and queues it for alignment.
 */
router.post('/chapters/:id/voiceover/manual', (req: Request, res: Response) => {
  voiceoverUpload.single('file')(req, res, async (uploadError: unknown) => {
    if (uploadError) {
      const tooBig = uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE'
      return res.status(400).json({ error: tooBig ? 'The audio file is larger than 512 MB.' : message(uploadError, 'Upload failed') })
    }
    const language = requestLanguage(req)
    const chapterId = req.params.id
    const key = `${chapterId}:${language}`
    try {
      if (!req.file) return res.status(400).json({ error: 'Choose an audio file' })
      const chapter = await prisma.chapter.findUnique({ where: { id: chapterId }, select: { seriesId: true } })
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      if (fetchJobs.has(`${chapter.seriesId}:${language}`)) return res.status(409).json({ error: 'Wait for the phone fetch to finish' })
      if (alignRuns.has(key) || pendingAlignments(chapterId, language) > 0 || scriptReplacementBusy(chapterId)) {
        return res.status(409).json({ error: 'Wait for this chapter’s alignment or script replacement to finish' })
      }
      alignRuns.add(key)
      try {
        // Browsers send UTF-8 names that multer reads as latin1.
        const name = Buffer.from(req.file.originalname, 'latin1').toString('utf-8')
        const result = await addManualVoiceover(chapterId, language, { name, data: req.file.buffer }, io)
        res.json(result)
      } finally {
        alignRuns.delete(key)
      }
    } catch (error) {
      console.error('[narration] manual voiceover failed:', error)
      res.status(error instanceof ManualVoiceoverError ? error.status : 400).json({ error: message(error, 'Could not add the voiceover') })
    }
  })
})

/**
 * Removes the chapter's voiceover in this language from Studio (backed up),
 * R2 and the phones, so it can be voiced again (see voiceoverReset.ts).
 */
router.post('/chapters/:id/voiceover/reset', async (req: Request, res: Response) => {
  const language = requestLanguage(req)
  const chapterId = req.params.id
  const key = `${chapterId}:${language}`
  try {
    const chapter = await prisma.chapter.findUnique({ where: { id: chapterId }, select: { seriesId: true } })
    if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
    if (fetchJobs.has(`${chapter.seriesId}:${language}`)) return res.status(409).json({ error: 'Wait for the phone fetch to finish' })
    if (alignRuns.has(key) || pendingAlignments(chapterId, language) > 0 || scriptReplacementBusy(chapterId)) {
      return res.status(409).json({ error: 'Wait for this chapter’s alignment or script replacement to finish' })
    }
    alignRuns.add(key)
    try {
      res.json(await resetChapterVoiceover(chapterId, language))
    } finally {
      alignRuns.delete(key)
    }
  } catch (error) {
    console.error('[narration] voiceover reset failed:', error)
    res.status(error instanceof VoiceoverResetError ? error.status : 500).json({ error: message(error, 'Could not reset the voiceover') })
  }
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
