/**
 * Editor 2.0 — timeline JSON processor.
 *
 * Turns the pasted timeline JSON into a flat, playable plan.
 *
 * The JSON names images either as "<source image>/<crop id>" (e.g.
 * "page_002.webp/crop-01") or as a bare exported filename (e.g.
 * "pick_me_up_page_002_01_full_width_character_panel.png"). Both are accepted,
 * because both are authored: the pair points at Image Clipper 3.0's own
 * artifacts, while the filename is what an AI writes when it is handed the
 * metadata document — which lists `exportedFilename` per crop and never
 * mentions crop ids.
 *
 * A filename resolves against the crops3 listing directly. A pair resolves
 * through crop_metadata3 where it names the file outright, and otherwise falls
 * back to the crop's ordinal position in that page's crop_points3 artifact.
 *
 * Timestamps restart at 00:00 in every section because each section is timed
 * against its own audio file. Sections play back to back, so the plan carries
 * both the section-relative time (what the JSON said) and the absolute time
 * (where it lands in the finished video).
 */

import fs from 'fs/promises'
import path from 'path'
import { prisma } from '../index.js'
import {
  extractCrops,
  getOutputDir,
  readImageMetadata,
  readImagePoints,
  stemOf
} from './clipper3/perImageStore.js'

// ============ Incoming JSON shape ============

/** One slot as written in the pasted JSON. */
interface IncomingTimeline {
  timeline?: unknown
  selectedImages?: unknown
}

interface IncomingSection {
  section?: unknown
  timelines?: unknown
}

// ============ Outgoing plan shape ============

/**
 * The same gentle motion set Editor 1.0 uses (videoEditorService's
 * GENTLE_EFFECTS), so both editors move images the same way.
 */
export const GENTLE_EFFECTS = [
  'zoom-in',
  'zoom-out',
  'pan-left',
  'pan-right',
  'pan-up',
  'pan-down'
] as const

export type MotionEffect = typeof GENTLE_EFFECTS[number]

/** Editor 1.0's default intensity for a slow, unobtrusive drift. */
export const DEFAULT_MOTION_INTENSITY = 0.04

/**
 * Pick an effect for one image without a random number generator.
 *
 * Editor 1.0 randomizes on write, which it can afford because it stores the
 * choice. This plan is rebuilt on every processing run, so a random pick would
 * change the motion each time the same JSON is processed. Deriving it from the
 * image's position keeps a chapter's motion stable while still varying between
 * neighbouring images, and alternating zoom-in/zoom-out on consecutive slots
 * avoids two identical pushes in a row.
 */
function effectFor(position: number): MotionEffect {
  return GENTLE_EFFECTS[position % GENTLE_EFFECTS.length]
}

export interface PlanImage {
  /** The reference exactly as the JSON wrote it, for error reporting. */
  ref: string
  /** Source page image the crop came from, e.g. "page_002.webp". */
  sourceImage: string
  /** Crop id within that page, e.g. "crop-01". */
  cropId: string
  /** Resolved crops3 filename, or null when nothing on disk matches. */
  filename: string | null
  /** URL the client can load the image from; null when unresolved. */
  url: string | null
  /**
   * Absolute path to the crop on disk, for the renderer. Server-side only —
   * the preview never needs it, but FFmpeg cannot read the URL above.
   */
  imagePath: string | null
  /** Seconds this image is on screen. */
  duration: number
  /** Absolute start/end across the whole chapter. */
  startTime: number
  endTime: number
  /** Ken Burns motion for this image, matching Editor 1.0's gentle set. */
  motionEffect: MotionEffect
  motionIntensity: number
}

export interface PlanSlot {
  /** The slot's raw "MM:SS.ss - MM:SS.ss" text. */
  timeline: string
  /** Section-relative bounds, as written. */
  relStart: number
  relEnd: number
  /** Absolute bounds across the whole chapter. */
  startTime: number
  endTime: number
  images: PlanImage[]
}

export interface PlanSection {
  /** "Section 1" as written. */
  label: string
  /** Zero-based AudioSection index this maps to. */
  index: number
  /** Where this section starts in the finished video. */
  startTime: number
  /** The section's own audio length, from the AudioSection's file. */
  audioDuration: number
  /** Streaming URL for this section's audio; null when it has none. */
  audioUrl: string | null
  /**
   * Absolute path to the section's audio on disk, for the renderer. As with
   * PlanImage.imagePath, FFmpeg needs a file rather than the URL above.
   */
  audioPath: string | null
  slots: PlanSlot[]
}

export interface TimelinePlan {
  chapterId: string
  chapterNumber: number
  chapterTitle: string | null
  seriesTitle: string
  /** Total runtime in seconds. */
  totalDuration: number
  imageCount: number
  /** References the JSON asked for that no file on disk satisfies. */
  missingRefs: string[]
  /** Non-fatal problems worth showing the user. */
  warnings: string[]
  sections: PlanSection[]
}

// ============ Parsing helpers ============

/**
 * Parse "MM:SS.ss" (or "HH:MM:SS.ss") into seconds.
 *
 * Returns null rather than throwing: one malformed stamp should be reported
 * as a warning about that slot, not abort the whole chapter.
 */
export function parseTimestamp(raw: string): number | null {
  const text = raw.trim()
  if (!/^\d{1,2}:\d{1,2}(:\d{1,2})?(\.\d+)?$/.test(text)) return null
  const parts = text.split(':').map(Number)
  if (parts.some(n => !Number.isFinite(n))) return null
  const seconds = parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1]
  return Number.isFinite(seconds) ? seconds : null
}

/** Split "00:00.00 - 00:05.51" into its two bounds. */
export function parseRange(raw: string): { start: number; end: number } | null {
  // Accept an en dash as well as a hyphen — these strings are hand-pasted.
  const halves = raw.split(/\s*[-–]\s*/)
  if (halves.length !== 2) return null
  const start = parseTimestamp(halves[0])
  const end = parseTimestamp(halves[1])
  if (start === null || end === null) return null
  return { start, end }
}

/** Pull the zero-based section index out of a "Section 3" label. */
function parseSectionIndex(label: string, fallback: number): number {
  const match = /(\d+)/.exec(label)
  if (!match) return fallback
  const n = Number(match[1])
  return Number.isFinite(n) && n >= 1 ? n - 1 : fallback
}

/**
 * What one entry of `selectedImages` is pointing at.
 *
 * Two shapes are accepted because two things author these lists. The
 * "<page>/<crop id>" pair is what this module was built for. A bare exported
 * filename is what an AI writes when it is handed the metadata document, which
 * lists `exportedFilename` for every crop and never mentions crop ids — so that
 * is the shape most timeline JSON actually arrives in.
 */
type ImageRef =
  | { kind: 'pair'; sourceImage: string; cropId: string }
  | { kind: 'filename'; filename: string }

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i

function parseImageRef(ref: string): ImageRef | null {
  let trimmed = ref.trim()
  if (!trimmed) return null

  // An AI that has seen the export folder sometimes prefixes it. Strip it, so
  // the slash it adds does not read as a page/crop separator.
  trimmed = trimmed.replace(/^\.?\/?crops3\//i, '').trim()
  if (!trimmed) return null

  const slash = trimmed.lastIndexOf('/')

  // The extension is the discriminator: a crop id never ends in .png.
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { kind: 'filename', filename: trimmed }
  }
  if (IMAGE_EXT.test(trimmed) && !IMAGE_EXT.test(trimmed.slice(0, slash))) {
    return { kind: 'filename', filename: trimmed }
  }

  return {
    kind: 'pair',
    sourceImage: trimmed.slice(0, slash).trim(),
    cropId: trimmed.slice(slash + 1).trim()
  }
}

/**
 * The key both sides of a filename comparison are reduced to before matching.
 *
 * Applied to the ref AND to the real directory entry, never to just one. Drops
 * any path the author invented, drops the extension (so a ref that forgot
 * ".png" still lands), lowercases because the filesystem here is
 * case-insensitive, and folds spaces and hyphens to underscore because that is
 * how these names get reformatted in transit.
 */
function normalizeOutputName(name: string): string {
  return path
    .basename(name.trim())
    .replace(/\.[^/.]+$/, '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

// ============ Image resolution ============

interface CropIndex {
  /** "<page stem>/<crop id>" -> crops3 filename. */
  byPair: Map<string, string>
  /** normalizeOutputName(file) -> the real crops3 filename. */
  byName: Map<string, string>
  warnings: string[]
}

/**
 * Every way this chapter's crops can be named, resolved against what is
 * actually in crops3/.
 *
 * Built in ascending order of trust, so a later layer overwrites an earlier
 * one's guess:
 *
 *   0. byName — the directory listing itself. A ref that names a file is
 *      answered from here, which is the only layer that cannot be wrong.
 *   1. byPair, positionally — the Nth crop in a page's artifact was exported
 *      with index N. This is a guess, but it is the only thing available for
 *      chapters cut before crop ids were recorded anywhere.
 *   2. byPair, from crop_metadata3 — the metadata document names an
 *      `exportedFilename` per crop id. Trusted only where that name is
 *      confirmed by byName, so a stale or invented name cannot enter the map.
 *
 * Where a page has been cut more than once, several files share an index; the
 * most recently written one wins, since that is the cut the user last asked for.
 */
async function buildCropFileIndex(folderPath: string): Promise<CropIndex> {
  const map = new Map<string, string>()
  const byName = new Map<string, { filename: string; mtimeMs: number }>()
  const warnings: string[] = []
  const outputDir = getOutputDir(folderPath)

  const finish = (): CropIndex => ({
    byPair: map,
    byName: new Map([...byName].map(([k, v]) => [k, v.filename])),
    warnings
  })

  let outputs: string[]
  try {
    outputs = await fs.readdir(outputDir)
  } catch {
    warnings.push('No crops3 output folder — run "Crop Sections" in Image Clipper 3.0 first.')
    return finish()
  }

  // Group output files by page stem + zero-padded index, newest first.
  const byKey = new Map<string, { filename: string; mtimeMs: number }[]>()
  for (const filename of outputs) {
    if (!IMAGE_EXT.test(filename)) continue

    let mtimeMs = 0
    try {
      mtimeMs = (await fs.stat(path.join(outputDir, filename))).mtimeMs
    } catch {
      // A file that vanished mid-scan simply loses the tie-break.
    }

    // Layer 0: the name itself. Normalization can in principle collide, so the
    // newest file wins — the same rule the positional layer uses.
    const nameKey = normalizeOutputName(filename)
    const seen = byName.get(nameKey)
    if (!seen || mtimeMs > seen.mtimeMs) byName.set(nameKey, { filename, mtimeMs })

    // e.g. pick_me_up_page_002_01_full_width_character_panel.png
    const match = /(page[_-]?\d+)[_-](\d+)/i.exec(filename)
    if (!match) continue
    const key = `${match[1].toLowerCase().replace(/[_-]/g, '_')}#${Number(match[2])}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key)!.push({ filename, mtimeMs })
  }
  for (const entries of byKey.values()) {
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  // Walk each page's crop artifact so crop ids keep their authored order.
  let pointFiles: string[] = []
  try {
    pointFiles = (await fs.readdir(path.join(outputDir, '..', 'crop_points3')))
      .filter(n => n.toLowerCase().endsWith('.json'))
  } catch {
    warnings.push('No crop_points3 folder — crop ids cannot be resolved by name.')
    return finish()
  }

  for (const pointFile of pointFiles) {
    const pageStem = pointFile.replace(/\.json$/i, '')
    const stored = await readImagePoints(folderPath, `${pageStem}.webp`)
    const crops = extractCrops(stored?.file ?? null)
    crops.forEach((crop, i) => {
      const index = i + 1
      const key = `${pageStem.toLowerCase().replace(/[_-]/g, '_')}#${index}`
      const candidates = byKey.get(key)
      if (!candidates || candidates.length === 0) return
      // Key on the page stem so "page_002.webp", "page_002.png" and
      // "page_002" all resolve to the same crop set.
      map.set(`${pageStem}/${crop.id}`, candidates[0].filename)
    })

    // Layer 2: the metadata document states the filename for each crop id
    // outright, which beats counting positions — a crop dropped for bad
    // geometry shifts every later index, and the positional guess shifts with
    // it. Only names confirmed present on disk are taken.
    const metaText = await readImageMetadata(folderPath, `${pageStem}.webp`)
    if (!metaText) continue
    let described: unknown
    try {
      described = JSON.parse(metaText)
    } catch {
      // The metadata document is free-form by contract; a non-JSON one simply
      // offers nothing here and is not an error.
      continue
    }
    const entries = (described as { crops?: unknown })?.crops
    if (!Array.isArray(entries)) continue
    for (const entry of entries as { id?: unknown; exportedFilename?: unknown }[]) {
      if (typeof entry?.id !== 'string' || typeof entry?.exportedFilename !== 'string') continue
      const real = byName.get(normalizeOutputName(entry.exportedFilename))
      if (!real) continue

      // A name that exists on disk but belongs to ANOTHER source page is the
      // one error this layer must not honour: it resolves successfully, so it
      // would silently overwrite layer 1's correct positional answer with a
      // crop from the wrong page. Seen for real when per-page metadata was
      // concatenated into one document and the page prefixes were rewritten.
      const namedStem = /_(page_\d+)_\d{2}(?:_|\.)/.exec(entry.exportedFilename)?.[1]
      if (namedStem && namedStem !== pageStem) {
        console.warn(
          `[editor2] ${pageStem} metadata: crop "${entry.id}" names "${entry.exportedFilename}", which belongs to ${namedStem}. Ignoring it and keeping the positional match.`
        )
        continue
      }

      map.set(`${pageStem}/${entry.id}`, real.filename)
    }
  }

  return finish()
}

// ============ Processing ============

/**
 * Build a playable plan for one chapter from pasted timeline JSON.
 *
 * Nothing is written to disk and nothing is guessed: a reference that cannot
 * be resolved is reported in `missingRefs` and left with a null filename so
 * the player can show the gap rather than silently shifting the timing.
 */
export async function processTimelineJson(
  chapterId: string,
  rawJson: string
): Promise<TimelinePlan> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : 'could not parse'}`)
  }

  const incomingSections = (parsed as { sections?: unknown })?.sections
  if (!Array.isArray(incomingSections) || incomingSections.length === 0) {
    throw new Error('The JSON needs a non-empty "sections" array.')
  }

  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    include: {
      series: { select: { title: true } },
      audioSections: { orderBy: { index: 'asc' }, include: { audioFile: true } }
    }
  })
  if (!chapter) throw new Error('Chapter not found')

  const { byPair: cropFiles, byName: cropNames, warnings } = await buildCropFileIndex(chapter.folderPath)
  // Where the resolved crop filenames actually live, so the plan can carry an
  // absolute path for the renderer next to the URL the preview loads.
  const cropOutputDir = getOutputDir(chapter.folderPath)
  const missingRefs: string[] = []
  const sections: PlanSection[] = []

  let cursor = 0   // absolute seconds consumed so far
  let imageCount = 0
  let position = 0 // running image index, so motion varies between neighbours

  for (let s = 0; s < incomingSections.length; s++) {
    const incoming = incomingSections[s] as IncomingSection
    const label = typeof incoming.section === 'string' ? incoming.section : `Section ${s + 1}`
    const index = parseSectionIndex(label, s)

    const audioSection = chapter.audioSections[index]
    if (!audioSection) {
      warnings.push(`${label}: this chapter has no matching voice section — skipped.`)
      continue
    }

    const audioFile = audioSection.audioFile
    const audioDuration = audioFile?.durationMs && audioFile.durationMs > 0
      ? audioFile.durationMs / 1000
      : 0
    if (!audioFile) {
      warnings.push(`${label}: no voiceover audio yet — it will play silent.`)
    }

    const sectionStart = cursor
    const slots: PlanSlot[] = []
    const incomingTimelines = Array.isArray(incoming.timelines) ? incoming.timelines : []
    if (incomingTimelines.length === 0) {
      warnings.push(`${label}: no timelines listed — nothing will show during it.`)
    }

    for (const rawSlot of incomingTimelines as IncomingTimeline[]) {
      const timelineText = typeof rawSlot.timeline === 'string' ? rawSlot.timeline : ''
      const range = timelineText ? parseRange(timelineText) : null
      if (!range) {
        warnings.push(`${label}: could not read the time range "${timelineText}" — slot skipped.`)
        continue
      }
      if (range.end <= range.start) {
        warnings.push(`${label} ${timelineText}: ends before it starts — slot skipped.`)
        continue
      }

      const refs = (Array.isArray(rawSlot.selectedImages) ? rawSlot.selectedImages : [])
        .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      if (refs.length === 0) {
        warnings.push(`${label} ${timelineText}: no images listed — slot skipped.`)
        continue
      }

      // A slot's images share it evenly. Splitting by height was considered,
      // but even shares keep the pacing predictable and match what the author
      // sees when they list two images against one line of narration.
      const slotDuration = range.end - range.start
      const perImage = slotDuration / refs.length

      const images: PlanImage[] = refs.map((ref, i) => {
        const parts = parseImageRef(ref)
        let filename: string | null = null
        let sourceImage = ref
        let cropId = ''

        if (parts?.kind === 'pair') {
          sourceImage = parts.sourceImage
          cropId = parts.cropId
          const pageStem = stemOf(parts.sourceImage)
          filename = cropFiles.get(`${pageStem}/${cropId}`) ?? null
          // A pair that names a real file in its own right still resolves —
          // "page_003.webp/pick_me_up_page_003_02_....png" is a shape an AI
          // produces when it mixes the two conventions.
          if (!filename) filename = cropNames.get(normalizeOutputName(parts.cropId)) ?? null
        } else if (parts?.kind === 'filename') {
          filename = cropNames.get(normalizeOutputName(parts.filename)) ?? null
          // Report the page the file came from, so the plan still says where
          // each image belongs even when the ref never mentioned it.
          const page = filename ? /(page[_-]?\d+)/i.exec(filename) : null
          if (page) sourceImage = page[1].toLowerCase().replace(/[_-]/g, '_')
        }
        if (!filename && !missingRefs.includes(ref)) missingRefs.push(ref)
        if (filename) imageCount++

        const startTime = sectionStart + range.start + perImage * i
        const motionEffect = effectFor(position)
        position++
        return {
          ref,
          sourceImage,
          cropId,
          filename,
          url: filename
            ? `/api/clipper3/chapters/${chapter.id}/output/${encodeURIComponent(filename)}`
            : null,
          imagePath: filename ? path.resolve(cropOutputDir, filename) : null,
          duration: perImage,
          startTime,
          endTime: startTime + perImage,
          motionEffect,
          motionIntensity: DEFAULT_MOTION_INTENSITY
        }
      })

      slots.push({
        timeline: timelineText,
        relStart: range.start,
        relEnd: range.end,
        startTime: sectionStart + range.start,
        endTime: sectionStart + range.end,
        images
      })
    }

    // A section lasts as long as its audio. Where there is no audio (or the
    // slots run past it), fall back to whatever the slots themselves cover so
    // the section is never shorter than the images it has to show.
    const slotsEnd = slots.reduce((max, slot) => Math.max(max, slot.relEnd), 0)
    const sectionDuration = Math.max(audioDuration, slotsEnd)
    if (audioDuration > 0 && slotsEnd > audioDuration + 0.5) {
      warnings.push(
        `${label}: timeline runs to ${slotsEnd.toFixed(2)}s but the audio is ${audioDuration.toFixed(2)}s.`
      )
    }

    sections.push({
      label,
      index,
      startTime: sectionStart,
      audioDuration: sectionDuration,
      audioUrl: audioFile ? `/api/video2/chapters/${chapter.id}/sections/${audioSection.id}/audio` : null,
      audioPath: audioFile
        ? (path.isAbsolute(audioFile.filePath) ? audioFile.filePath : path.resolve(audioFile.filePath))
        : null,
      slots
    })

    cursor = sectionStart + sectionDuration
  }

  if (sections.length === 0) {
    throw new Error('None of the sections in the JSON could be matched to this chapter.')
  }

  return {
    chapterId: chapter.id,
    chapterNumber: chapter.number,
    chapterTitle: chapter.title,
    seriesTitle: chapter.series.title,
    totalDuration: cursor,
    imageCount,
    missingRefs,
    warnings,
    sections
  }
}
