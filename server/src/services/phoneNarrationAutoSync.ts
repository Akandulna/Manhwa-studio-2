/**
 * Brings the phones' finished narration into Studio without "Fetch from phone".
 *
 * Phones send each finished chapter's scripts to R2 on their own
 * (`shared/scripts/<Series>/<Chapter>.script.json`) and each voiced chapter as
 * `voiceover/<Series>/<Chapter>.zip`. This fetches them when:
 *   - a phone's scripts receipt shows a chapter's script or voiceover changed,
 *   - Studio starts,
 *   - a series is opened in Narration.
 * There is no polling.
 *
 * Only gaps are filled, chapter by chapter and language by language:
 *   - a script is imported when Studio has none for that chapter (Hinglish only
 *     once it was converted from the English script Studio has);
 *   - a voiceover is attached when Studio has no sections in that language and
 *     the phone recorded it from the script Studio has; alignment then runs as
 *     after any fetch;
 *   - the image review (script.review.json) follows an English script that is
 *     the same on both sides.
 * A different script on a phone is never imported here: it is listed as a
 * conflict for you to decide in Narration (see phoneScriptConflicts). Nothing
 * Studio has is deleted or replaced, and nothing in R2 is deleted.
 */
import path from 'path'
import type { Server } from 'socket.io'
import { prisma } from '../index.js'
import { importPhoneScripts, previewPhoneScripts, updatePhoneScriptReviews, type PhoneImportPreview, type PhoneImportResult } from './phoneScriptImport.js'
import { fetchPhoneVoiceover, previewPhoneVoiceover, type PhoneVoiceoverFetch } from './phoneVoiceoverImport.js'
import { phoneFetchJobs, phoneFetchKey } from './narrationFetchJobs.js'
import { getR2Config } from './r2Service.js'
import { onPhoneReceipt } from './phoneRelay.js'
import { seriesRestartPending } from './seriesRestartGuard.js'
import { scriptReplacementBusy } from './scriptReplacement.js'
import { hiddenLibraryFolders } from './libraryControls.js'
import type { NarrationLanguage } from './narrationLanguage.js'

const LANGUAGES: NarrationLanguage[] = ['en', 'hi']
/** Script rows that hold a script. */
const SCRIPT_WRITTEN = ['done', 'edited', 'stale']

/** Saves close together (a phone finishing several chapters) become one fetch. */
const SETTLE_MS = 20_000
/** Opening a series again soon after doesn't list R2 again. */
const OPEN_INTERVAL_MS = 2 * 60_000
/** After Studio starts, before the first look. */
const STARTUP_DELAY_MS = 60_000

let io: Server | null = null
const timers = new Map<string, NodeJS.Timeout>()
const running = new Set<string>()
const lastRun = new Map<string, number>()
/** Per series folder: what the phones' receipts last said about its chapters, to act only on a change. */
const receiptSignatures = new Map<string, string>()

export interface AutoSyncLanguage {
  scripts: number
  voiceovers: number
  /** Chapters where a phone has a different script than Studio and you haven't chosen yet. */
  conflicts: number
}

export interface AutoSyncReport {
  seriesId: string
  languages: Partial<Record<NarrationLanguage, AutoSyncLanguage>>
  reviews: number
  errors: string[]
}

// ============ Kept versions ============

const keepKey = (chapterId: string, language: NarrationLanguage) => `phoneScriptKeep:${chapterId}:${language}`

/** Whether you chose Studio's script over this exact phone version (its SHA-256). */
export async function keptStudioVersion(chapterId: string, language: NarrationLanguage, phoneSha256: string): Promise<boolean> {
  return (await prisma.setting.findUnique({ where: { key: keepKey(chapterId, language) } }))?.value === phoneSha256
}

/** Remembers that Studio keeps its script over this phone version; a newer phone version asks again. */
export async function keepStudioVersion(chapterId: string, language: NarrationLanguage, phoneSha256: string): Promise<void> {
  await prisma.setting.upsert({ where: { key: keepKey(chapterId, language) }, update: { value: phoneSha256 }, create: { key: keepKey(chapterId, language), value: phoneSha256 } })
}

/**
 * The chapters of a preview whose script text differs from Studio's and still
 * need your choice. Same text with other details (summary, closing) differing
 * is not a different version and is left as it is.
 */
export async function openConflicts(preview: PhoneImportPreview | null, language: NarrationLanguage) {
  const rows = preview?.chapters.filter(c => c.action === 'replace' && c.textDiffers && !c.published) ?? []
  const open = []
  for (const row of rows) if (!(await keptStudioVersion(row.chapterId, language, row.phoneSha256))) open.push(row)
  return open
}

// ============ One series ============

/** Scripts first (voiceovers are checked against them), English before Hinglish (its source). */
export async function runNarrationAutoSync(seriesId: string): Promise<AutoSyncReport> {
  const report: AutoSyncReport = { seriesId, languages: {}, reviews: 0, errors: [] }
  if (!getR2Config()) return report
  const series = await prisma.series.findUnique({ where: { id: seriesId }, select: { rootFolder: true } })
  if (!series) return report
  // Archived and deleted series are left as they are.
  if ((await hiddenLibraryFolders()).includes(series.rootFolder)) return report
  if (await seriesRestartPending(path.basename(series.rootFolder))) return report

  for (const language of LANGUAGES) {
    const key = phoneFetchKey(seriesId, language)
    if (phoneFetchJobs.has(key)) continue // your own fetch is running; it covers this
    const result: AutoSyncLanguage = { scripts: 0, voiceovers: 0, conflicts: 0 }
    report.languages[language] = result
    let scripts: PhoneImportResult | null = null
    let voiceovers: PhoneVoiceoverFetch | null = null
    const emit = (stage: 'scripts' | 'voiceover' | 'done' | 'failed', extra: object = {}) => {
      const state = { seriesId, language, stage, automatic: true, ...extra }
      if (stage === 'done' || stage === 'failed') phoneFetchJobs.delete(key)
      else phoneFetchJobs.set(key, state)
      io?.emit('narration:fetch', state)
    }
    try {
      // ---- Scripts: only chapters Studio has none for.
      const preview = await previewPhoneScripts(seriesId, language)
      const ids = (preview?.chapters ?? [])
        .filter(c => c.action === 'new' && !c.published && !scriptReplacementBusy(c.chapterId) &&
          (language === 'en' || (c.sourceMatches === true && !c.review)))
        .map(c => c.chapterId)
      if (preview && ids.length > 0) {
        emit('scripts')
        scripts = await importPhoneScripts(seriesId, preview.zip.etag, ids, language, { about: 'fill' })
        result.scripts = scripts.imported
      }
      if (language === 'en' && preview) {
        report.reviews += await updatePhoneScriptReviews(seriesId, preview.chapters.filter(c => c.reviewChanged).map(c => c.chapterId))
      }
      result.conflicts = (await openConflicts(preview, language)).length

      // ---- Voiceovers: only chapters with no sections in this language, recorded from Studio's script.
      const listed = await previewPhoneVoiceover(seriesId, language)
      const candidates = listed.chapters.filter(c => c.state === 'new').map(c => c.chapterId)
      if (candidates.length > 0) {
        const chapters = await prisma.chapter.findMany({
          where: { id: { in: candidates } },
          select: { id: true, scripts: { where: { language }, select: { status: true } }, _count: { select: { audioSections: { where: { language } } } } }
        })
        const wanted = chapters
          .filter(c => c._count.audioSections === 0 && SCRIPT_WRITTEN.includes(c.scripts[0]?.status ?? '') && !scriptReplacementBusy(c.id))
          .map(c => c.id)
        if (wanted.length > 0) {
          emit('voiceover', { current: 0, total: wanted.length })
          voiceovers = await fetchPhoneVoiceover(seriesId, wanted, io, language,
            step => emit('voiceover', step), { requireMatchingScript: true })
          result.voiceovers = voiceovers.fetched.length
          report.errors.push(...voiceovers.failed.map(f => `${f.folder} (${language} voiceover): ${f.reason}`))
        }
      }
      if (scripts || voiceovers) emit('done', { scripts, voiceovers })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      report.errors.push(`${language}: ${reason}`)
      if (phoneFetchJobs.get(key)?.automatic) emit('failed', { error: reason })
    }
  }
  const changed = Object.values(report.languages).some(l => l && (l.scripts > 0 || l.voiceovers > 0)) || report.reviews > 0
  if (changed) {
    const { notifySeriesProcessChanged } = await import('./seriesProcess.js')
    notifySeriesProcessChanged(true)
  }
  if (changed || report.errors.length > 0) console.log('[narration] automatic phone fetch', JSON.stringify(report))
  io?.emit('narration:auto-sync', report)
  return report
}

// ============ When ============

/** Queues a look at one series, collapsing calls within [SETTLE_MS]. */
export function scheduleNarrationAutoSync(seriesId: string, delayMs = SETTLE_MS): void {
  if (timers.has(seriesId)) return
  timers.set(seriesId, setTimeout(() => {
    timers.delete(seriesId)
    if (running.has(seriesId)) return scheduleNarrationAutoSync(seriesId, SETTLE_MS)
    running.add(seriesId)
    lastRun.set(seriesId, Date.now())
    runNarrationAutoSync(seriesId)
      .catch(error => console.error('[narration] automatic phone fetch failed:', error))
      .finally(() => running.delete(seriesId))
  }, delayMs))
}

/** Narration opened this series: look unless it was looked at just now. */
export function narrationSeriesOpened(seriesId: string): void {
  if (Date.now() - (lastRun.get(seriesId) ?? 0) < OPEN_INTERVAL_MS) return
  scheduleNarrationAutoSync(seriesId, 1_000)
}

/** What a scripts receipt says about one series' chapters (scripts and voiceovers, both languages). */
export function receiptSignature(series: any): string {
  const part = (s: any) => Object.entries(s?.chapters ?? {})
    .map(([name, c]: [string, any]) => [name, c?.status ?? null, c?.savedAt ?? null, c?.voiceover?.done ?? null, c?.voiceover?.total ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  return JSON.stringify([part(series), part(series?.hi)])
}

async function onScriptsReceipt(body: any): Promise<void> {
  const seriesMap = body?.series
  if (!seriesMap || typeof seriesMap !== 'object') return
  const changed: string[] = []
  for (const [folder, series] of Object.entries(seriesMap)) {
    const signature = receiptSignature(series)
    if (receiptSignatures.get(folder) === signature) continue
    receiptSignatures.set(folder, signature)
    changed.push(folder)
  }
  if (changed.length === 0) return
  const rows = await prisma.series.findMany({ select: { id: true, rootFolder: true } })
  for (const row of rows) if (changed.includes(path.basename(row.rootFolder))) scheduleNarrationAutoSync(row.id)
}

/** Starts listening to phone receipts, and looks at every series once shortly after Studio starts. */
export function startNarrationAutoSync(socketIo: Server): void {
  io = socketIo
  onPhoneReceipt((kind, _device, body) => {
    if (kind === 'scripts') void onScriptsReceipt(body).catch(error => console.error('[narration] receipt check failed:', error))
  })
  setTimeout(() => {
    void prisma.series.findMany({ select: { id: true } })
      .then(rows => rows.forEach((row, i) => scheduleNarrationAutoSync(row.id, 1_000 + i * 5_000)))
      .catch(error => console.error('[narration] startup phone fetch failed:', error))
  }, STARTUP_DELAY_MS)
}
