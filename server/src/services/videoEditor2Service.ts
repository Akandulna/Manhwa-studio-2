/**
 * Video Editor 2.0 Service — Module 4v2
 *
 * Read model for the Editor 2.0 series → chapter → readiness screen. A chapter
 * is editable once it clears four gates: a generated script, full section
 * voiceover audio, Image Clipper 3.0 crops done for every source image, and a
 * "script with timeline" on every section. Unlike the v1 Video Editor, crops
 * are checked against Clipper 3.0's per-image filesystem artifacts rather than
 * the legacy CropSession model.
 */

import { prisma } from '../index.js'
import { getChapterManifest } from './clipperService.js'
import {
  extractCrops,
  listMetadataImageStems,
  listPointedImageStems,
  readImageMetadata,
  readImagePoints
} from './clipper3/perImageStore.js'

// ============ Types ============

export interface Editable2Chapter {
  id: string
  number: number
  title: string | null
  ready: boolean
  reason: string | null          // why it's not ready (null when ready)
  hasScript: boolean
  hasSectionAudio: boolean
  sectionCount: number
  hasCropsClipper3: boolean
  cropImageCount: number         // total source images in the chapter
  cropDoneCount: number          // of those, how many are "done" in Clipper 3.0
  hasTimelineScript: boolean
  isPartEnd: boolean
}

// ============ Helpers ============

/** A per-section AudioSection counts as "voiced" when its audio file is done. */
function sectionHasAudio(section: { status: string; audioFile: { status: string } | null }): boolean {
  return !!section.audioFile && section.audioFile.status === 'done'
}

/** Scans a chapter's images the same way Clipper 3.0's list route does. */
async function getClipper3ChapterStatus(folderPath: string): Promise<{ total: number; done: number }> {
  let manifest: Awaited<ReturnType<typeof getChapterManifest>>
  try {
    manifest = await getChapterManifest(folderPath)
  } catch {
    // No downloaded images yet — nothing to crop, so there's nothing "done".
    return { total: 0, done: 0 }
  }
  const pointed = await listPointedImageStems(folderPath)
  const described = await listMetadataImageStems(folderPath)

  let done = 0
  for (const img of manifest.images) {
    const stem = img.filename.replace(/\.[^/.]+$/, '')
    if (!pointed.has(stem) || !described.has(stem)) continue
    const stored = await readImagePoints(folderPath, img.filename)
    const crops = extractCrops(stored?.file ?? null)
    if (crops.length > 0) done++
  }

  return { total: manifest.images.length, done }
}

interface ReasonLabel {
  short: string   // used in the "N gates missing" joined form
  long: string    // used verbatim when this is the only gate missing
}

const REASON_LABELS = {
  script: {
    short: 'a script (Narration)',
    long: 'Needs a script — generate or finish it in the Narration module'
  },
  audio: {
    short: 'voiceover audio (Voiceover)',
    long: 'Needs voiceover audio — finish this chapter in the Voiceover module'
  },
  crops: {
    short: 'finalized crops (Image Clipper 3.0)',
    long: 'Needs finalized crops — finish this chapter in Image Clipper 3.0'
  },
  timeline: {
    short: 'a script with timeline (Voiceover)',
    long: 'Needs a script with timeline — add it in the Voiceover module'
  }
} satisfies Record<string, ReasonLabel>

/** Joins missing-gate labels into one reason string, matching the single-gate tone. */
function joinReasons(missing: ReasonLabel[]): string | null {
  if (missing.length === 0) return null
  if (missing.length === 1) return missing[0].long
  const shorts = missing.map(m => m.short)
  const joined =
    shorts.length === 2
      ? shorts.join(' and ')
      : `${shorts.slice(0, -1).join(', ')}, and ${shorts[shorts.length - 1]}`
  return `Needs ${joined}`
}

// ============ Editable chapters ============

/**
 * List a series' chapters with their Editor 2.0 editability. A chapter is
 * editable when it has a generated script, full section audio, Clipper 3.0
 * crops done for every image, and a timeline script on every section.
 */
export async function getEditableChapters2(seriesId: string): Promise<Editable2Chapter[]> {
  const chapters = await prisma.chapter.findMany({
    where: { seriesId },
    orderBy: { number: 'asc' },
    include: {
      audioSections: { include: { audioFile: true } },
      script: { select: { status: true, isPartEnd: true } }
    }
  })

  return Promise.all(
    chapters.map(async ch => {
      const hasScript = ch.script?.status === 'done' || ch.script?.status === 'edited'
      const sectionCount = ch.audioSections.length
      const hasSectionAudio = sectionCount > 0 && ch.audioSections.every(sectionHasAudio)
      const hasTimelineScript =
        sectionCount > 0 && ch.audioSections.every(s => !!s.timelineScript?.trim())

      const cropStatus = await getClipper3ChapterStatus(ch.folderPath)
      const hasCropsClipper3 = cropStatus.total > 0 && cropStatus.total === cropStatus.done

      const missing: ReasonLabel[] = []
      if (!hasScript) missing.push(REASON_LABELS.script)
      if (!hasSectionAudio) missing.push(REASON_LABELS.audio)
      if (!hasCropsClipper3) missing.push(REASON_LABELS.crops)
      if (!hasTimelineScript) missing.push(REASON_LABELS.timeline)
      const reason = joinReasons(missing)

      return {
        id: ch.id,
        number: ch.number,
        title: ch.title,
        ready: reason === null,
        reason,
        hasScript,
        hasSectionAudio,
        sectionCount,
        hasCropsClipper3,
        cropImageCount: cropStatus.total,
        cropDoneCount: cropStatus.done,
        hasTimelineScript,
        isPartEnd: ch.script?.isPartEnd ?? false
      }
    })
  )
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
 * heading — the gap is visible in the readiness badges, not here.
 */
export async function getChapterTimelineBundle(chapterId: string): Promise<{
  chapterId: string
  number: number
  title: string | null
  sectionCount: number
  includedCount: number
  text: string
} | null> {
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    include: { audioSections: { orderBy: { index: 'asc' } } }
  })
  if (!chapter) return null

  const parts: string[] = []
  for (const section of chapter.audioSections) {
    const body = section.timelineScript?.trim()
    if (!body) continue
    parts.push(`## Section ${section.index + 1}\n\n${body}`)
  }

  return {
    chapterId: chapter.id,
    number: chapter.number,
    title: chapter.title,
    sectionCount: chapter.audioSections.length,
    includedCount: parts.length,
    text: parts.join('\n\n')
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
