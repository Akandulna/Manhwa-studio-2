/**
 * Video Editor 2.0 Service — Module 4v2
 *
 * Read model for the Editor 2.0 series → chapter screen: each chapter's
 * four-item readiness checklist, in one narration language.
 *
 *   audio      every voiceover section has its audio file on disk
 *   alignment  the chapter's alignment document (script-timeline.md /
 *              script-timeline.hi.md) is on disk — or, for chapters aligned
 *              before Narration wrote that file, every section carries its
 *              script with timeline in the database
 *   timeline   a timeline JSON is stored for the chapter (Editor2Timeline:
 *              pasted from ChatGPT, or fetched from the phone)
 *   crops      Image Clipper 3.0 has cut the chapter: every page done and
 *              crops3/ holds exactly the files those pages cut to
 *
 * Preview and Export wait for all four. Copy All, which is how the timeline
 * JSON gets made, only needs the alignment text and the crop metadata.
 */

import fs from 'fs/promises'
import path from 'path'
import { prisma } from '../index.js'
import { alignmentFileName, type NarrationLanguage } from './narrationLanguage.js'
import { getChapterManifest } from './chapterManifest.js'
import { scanVideoCleanupFolder, videoDirsFor } from './storageService.js'
import {
  chapterCropOutputs,
  expectedExportedFilenames,
  extractCrops,
  hasNoCrops,
  listMetadataImageStems,
  listPointedImageStems,
  readImageMetadata,
  readImagePoints,
  stemOf,
  validateMetadata
} from './clipper3/perImageStore.js'

// ============ Types ============

export type ChecklistKey = 'audio' | 'alignment' | 'timeline' | 'crops'

export interface ChecklistItem {
  ok: boolean
  /** What was found, for the item's tooltip: why it passes or what is missing. */
  detail: string
}

export interface Editable2Chapter {
  id: string
  number: number
  title: string | null
  checklist: Record<ChecklistKey, ChecklistItem>
  /** All four items pass: Preview and Export are open. */
  ready: boolean
  /** Labels of the items that don't pass, in checklist order. */
  missing: string[]
  /** Everything but the timeline JSON is there — what Send to phone waits for. */
  inputsReady: boolean
  /** Copy All has alignment text and crop metadata to copy. */
  canCopy: boolean
  /** Why Copy All is disabled (null when canCopy). */
  copyBlockedReason: string | null
  sectionCount: number
  isPartEnd: boolean
}

export const CHECKLIST_LABELS: Record<ChecklistKey, string> = {
  audio: 'Voiceover audio',
  alignment: 'Alignment',
  timeline: 'Timeline JSON',
  crops: 'Cropped images'
}

const CHECKLIST_ORDER: ChecklistKey[] = ['audio', 'alignment', 'timeline', 'crops']

// ============ Helpers ============

/** Resolve a stored (possibly relative) download path against DOWNLOAD_ROOT. */
function getFullFolderPath(relativePath: string): string {
  return path.join(process.env.DOWNLOAD_ROOT || './downloads', relativePath)
}

/**
 * The series slug Clipper 3.0 prefixes its crop files with. Mirrors the
 * private seriesSlug in routes/clipper3.ts — keep the two the same, or every
 * expected filename misses.
 */
function seriesSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'series'
}

/** Whether a file exists with something in it. */
async function hasContent(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).size > 0
  } catch {
    return false
  }
}

/** An AudioFile's path as the preview and export open it (see editor2Timeline). */
function audioPath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(filePath)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

interface SectionRow {
  timelineScript: string | null
  audioFile: { status: string; filePath: string } | null
}

/** Every voiceover section has a finished audio file that is still on disk. */
async function checkAudio(sections: SectionRow[]): Promise<ChecklistItem> {
  if (sections.length === 0) return { ok: false, detail: 'No voiceover sections yet — split the script in Voiceover' }
  let present = 0
  for (const s of sections) {
    if (s.audioFile?.status === 'done' && (await hasContent(audioPath(s.audioFile.filePath)))) present++
  }
  return present === sections.length
    ? { ok: true, detail: `All ${plural(sections.length, 'section')} have audio on disk` }
    : { ok: false, detail: `${present}/${sections.length} sections have audio on disk` }
}

/**
 * The alignment document is on disk. Until Narration writes it for every
 * chapter, a full set of per-section scripts with timeline in the database is
 * accepted in its place — that is what the file is made from.
 */
async function checkAlignment(
  folderPath: string,
  language: NarrationLanguage,
  sections: SectionRow[]
): Promise<ChecklistItem & { hasText: boolean }> {
  const fileName = alignmentFileName(language)
  const aligned = sections.filter(s => !!s.timelineScript?.trim()).length
  if (await hasContent(path.join(getFullFolderPath(folderPath), fileName))) {
    return { ok: true, hasText: true, detail: `${fileName} is on disk` }
  }
  if (sections.length > 0 && aligned === sections.length) {
    return {
      ok: true,
      hasText: true,
      detail: `${fileName} is not on disk, but all ${plural(sections.length, 'section')} have their script with timeline in the database — accepted for chapters aligned before the file was written`
    }
  }
  return {
    ok: false,
    hasText: aligned > 0,
    detail: sections.length === 0
      ? `No ${fileName} and no voiceover sections yet`
      : `No ${fileName} — ${aligned}/${sections.length} sections aligned in Voiceover`
  }
}

/**
 * Clipper 3.0's own "cut and matching" test (its series summary's
 * cropComplete): every page has crops and metadata that still validates
 * against them, and crops3/ holds exactly the files those pages cut to, none
 * older than its page's crop points.
 */
async function checkCrops(folderPath: string, slug: string): Promise<ChecklistItem & { hasMetadata: boolean }> {
  let manifest: Awaited<ReturnType<typeof getChapterManifest>>
  try {
    manifest = await getChapterManifest(folderPath)
  } catch {
    return { ok: false, hasMetadata: false, detail: 'No page images on disk' }
  }
  const pointed = await listPointedImageStems(folderPath)
  const described = await listMetadataImageStems(folderPath)

  const expected: string[] = []
  const doneFiles: string[] = []
  for (const img of manifest.images) {
    const stem = stemOf(img.filename)
    if (!pointed.has(stem) || !described.has(stem)) continue
    const stored = await readImagePoints(folderPath, img.filename)
    const crops = extractCrops(stored?.file ?? null)
    if (crops.length === 0 && !hasNoCrops(stored?.file ?? null)) continue
    const metadata = await readImageMetadata(folderPath, img.filename)
    const names = expectedExportedFilenames(slug, img.filename, crops)
    if (metadata == null || !validateMetadata(metadata, crops.map(c => c.id), names, slug).isValid) continue
    expected.push(...names)
    doneFiles.push(img.filename)
  }

  const total = manifest.images.length
  const allDone = total > 0 && doneFiles.length === total
  const outputs = await chapterCropOutputs(folderPath, expected, allDone, { slug, filenames: doneFiles })
  const hasMetadata = described.size > 0
  if (outputs.complete) return { ok: true, hasMetadata, detail: `All ${plural(total, 'page')} cut — ${plural(outputs.files, 'crop')} in crops3` }
  if (!allDone) return { ok: false, hasMetadata, detail: `${doneFiles.length}/${total} pages done in Image Clipper` }
  const issues: string[] = []
  if (outputs.missing > 0) issues.push(`${outputs.missing} missing`)
  if (outputs.extra > 0) issues.push(`${outputs.extra} extra`)
  if (outputs.changed > 0) issues.push(`${plural(outputs.changed, 'page')} changed since cut`)
  return {
    ok: false,
    hasMetadata,
    detail: outputs.files === 0
      ? 'Pages are done but not cut yet — run Crop Sections in Image Clipper'
      : `crops3 doesn't match the pages (${issues.join(', ')}) — cut again in Image Clipper`
  }
}

/** One chapter's checklist. `storedJson` is its Editor2Timeline paste, if any. */
async function buildChecklist(
  chapter: { folderPath: string; audioSections: SectionRow[] },
  language: NarrationLanguage,
  slug: string,
  storedJson: string | null
): Promise<Pick<Editable2Chapter, 'checklist' | 'ready' | 'missing' | 'inputsReady' | 'canCopy' | 'copyBlockedReason'>> {
  const [audio, alignment, crops] = await Promise.all([
    checkAudio(chapter.audioSections),
    checkAlignment(chapter.folderPath, language, chapter.audioSections),
    checkCrops(chapter.folderPath, slug)
  ])
  const timeline: ChecklistItem = storedJson?.trim()
    ? { ok: true, detail: 'Timeline JSON stored for this chapter' }
    : { ok: false, detail: 'No timeline JSON yet — Copy All → ChatGPT → Paste, or Fetch from phone' }

  const checklist: Record<ChecklistKey, ChecklistItem> = {
    audio: { ok: audio.ok, detail: audio.detail },
    alignment: { ok: alignment.ok, detail: alignment.detail },
    timeline,
    crops: { ok: crops.ok, detail: crops.detail }
  }
  const missing = CHECKLIST_ORDER.filter(k => !checklist[k].ok).map(k => CHECKLIST_LABELS[k])

  const copyMissing: string[] = []
  if (!alignment.hasText) copyMissing.push('alignment (script with timeline)')
  if (!crops.hasMetadata) copyMissing.push('crop metadata')

  return {
    checklist,
    ready: missing.length === 0,
    missing,
    inputsReady: audio.ok && alignment.ok && crops.ok,
    canCopy: copyMissing.length === 0,
    copyBlockedReason: copyMissing.length === 0 ? null : `Nothing to copy yet — no ${copyMissing.join(' or ')}`
  }
}

// ============ Editable chapters ============

/** A saved compressed video is the series-level completion marker, even after render cleanup. */
export async function getSeriesCompletion2(seriesId: string, language: NarrationLanguage = 'en') {
  const series = await prisma.series.findUnique({ where: { id: seriesId }, select: { rootFolder: true } })
  if (!series) return { done: false, compressedVideos: [] as string[] }
  const folders = await Promise.all(videoDirsFor(language).map(dir => scanVideoCleanupFolder(series.rootFolder, dir)))
  const compressedVideos = folders.flatMap(folder => folder.compressedVideos.map(file => `${folder.dir}/${file}`))
  return { done: compressedVideos.length > 0, compressedVideos }
}

/**
 * A series' chapters with their Editor 2.0 checklist. Audio, alignment and
 * the timeline JSON are checked in the requested language; crops are shared,
 * since both languages cut the same images.
 */
export async function getEditableChapters2(
  seriesId: string,
  language: NarrationLanguage = 'en'
): Promise<Editable2Chapter[]> {
  const series = await prisma.series.findUnique({ where: { id: seriesId }, select: { title: true } })
  if (!series) return []
  const slug = seriesSlug(series.title)

  const chapters = await prisma.chapter.findMany({
    where: { seriesId },
    orderBy: { number: 'asc' },
    include: {
      audioSections: { where: { language }, include: { audioFile: true } },
      scripts: { where: { language }, select: { isPartEnd: true } }
    }
  })
  const stored = await prisma.editor2Timeline.findMany({
    where: { chapterId: { in: chapters.map(c => c.id) }, language },
    select: { chapterId: true, json: true }
  })
  const jsonByChapter = new Map(stored.map(r => [r.chapterId, r.json]))

  return Promise.all(
    chapters.map(async ch => ({
      id: ch.id,
      number: ch.number,
      title: ch.title,
      ...(await buildChecklist(ch, language, slug, jsonByChapter.get(ch.id) ?? null)),
      sectionCount: ch.audioSections.length,
      isPartEnd: ch.scripts[0]?.isPartEnd ?? false
    }))
  )
}

/**
 * What still keeps one chapter from Preview and Export, apart from the
 * timeline JSON (the caller holds that). Empty when nothing does; null when
 * the chapter doesn't exist.
 */
export async function getChapterBlockers(chapterId: string, language: NarrationLanguage): Promise<string[] | null> {
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    include: {
      series: { select: { title: true } },
      audioSections: { where: { language }, include: { audioFile: true } }
    }
  })
  if (!chapter) return null
  const result = await buildChecklist(chapter, language, seriesSlug(chapter.series.title), 'held by the caller')
  return result.missing
}

// ============ Chapter-level bundles (one-click copy) ============

/**
 * Every section's "script with timeline", joined into one chapter-level
 * document in reading order.
 *
 * The Voiceover module stores these per AudioSection, so a whole chapter's
 * timeline lives in as many pieces as the chapter has sections. This stitches
 * them back together so a user copies once instead of section by section.
 * Sections with nothing saved are skipped rather than emitting an empty
 * heading — the gap is visible in the checklist, not here. With no section
 * saved at all, the alignment document on disk stands in.
 */
export async function getChapterTimelineBundle(
  chapterId: string,
  language: NarrationLanguage = 'en'
): Promise<{
  chapterId: string
  number: number
  title: string | null
  sectionCount: number
  includedCount: number
  text: string
} | null> {
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    include: { audioSections: { where: { language }, orderBy: { index: 'asc' } } }
  })
  if (!chapter) return null

  const parts: string[] = []
  for (const section of chapter.audioSections) {
    const body = section.timelineScript?.trim()
    if (!body) continue
    parts.push(`## Section ${section.index + 1}\n\n${body}`)
  }

  // Nothing in the database but the alignment document is on disk (the
  // checklist accepts either), so copy the document as it stands.
  let text = parts.join('\n\n')
  if (!text) {
    try {
      text = (await fs.readFile(path.join(getFullFolderPath(chapter.folderPath), alignmentFileName(language)), 'utf-8')).trim()
    } catch {
      // No document either — the empty text says so.
    }
  }

  return {
    chapterId: chapter.id,
    number: chapter.number,
    title: chapter.title,
    sectionCount: chapter.audioSections.length,
    includedCount: parts.length,
    text
  }
}

/**
 * Every image's Clipper 3.0 metadata document for a chapter, joined in image
 * order.
 *
 * Clipper 3.0 keeps one free-form metadata document per source image, so a
 * chapter's metadata is spread across as many files as it has images. Each is
 * stored verbatim and never parsed, so they are concatenated as-is under a
 * heading naming the image they describe.
 */
export async function getChapterCropMetadataBundle(chapterId: string): Promise<{
  chapterId: string
  number: number
  title: string | null
  imageCount: number
  includedCount: number
  text: string
} | null> {
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    select: { id: true, number: true, title: true, folderPath: true }
  })
  if (!chapter) return null

  let manifest: Awaited<ReturnType<typeof getChapterManifest>>
  try {
    manifest = await getChapterManifest(chapter.folderPath)
  } catch {
    // No downloaded images — nothing to describe.
    return {
      chapterId: chapter.id,
      number: chapter.number,
      title: chapter.title,
      imageCount: 0,
      includedCount: 0,
      text: ''
    }
  }

  const parts: string[] = []
  for (const img of manifest.images) {
    const body = (await readImageMetadata(chapter.folderPath, img.filename))?.trim()
    if (!body) continue
    parts.push(`## ${img.filename}\n\n${body}`)
  }

  return {
    chapterId: chapter.id,
    number: chapter.number,
    title: chapter.title,
    imageCount: manifest.images.length,
    includedCount: parts.length,
    text: parts.join('\n\n')
  }
}
