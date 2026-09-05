/**
 * Video Editor Service — Module 4: Video Editor
 *
 * Compiles existing artifacts (narration scripts, per-section voiceover audio,
 * cropped images) into a single exported MP4.
 *
 * This file (Step 1) covers project setup and the read models the editor needs:
 * - initProject: build the part tree from each chapter's AudioSections, plus a
 *   final editor-managed outro end-card part.
 * - getEditableChapters: which chapters are ready to edit (finalized crops AND
 *   per-section audio), with a reason for those that aren't.
 * - getChapterCrops: a chapter's finalized crop pool (image paths + crop numbers).
 * - getProjectTree: the full project with parts (→ images) and per-part script text.
 *
 * The FFmpeg render engine, AI assist, and music library land in later steps.
 */

import { spawn, ChildProcess, execSync } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import { Server } from 'socket.io'
import { prisma } from '../index.js'
import { getAudioMetadata } from './audioProcessor.js'
import {
  clampVolume,
  normalizePartDurations,
  chooseMixMode,
  ensureFfmpegAvailable
} from './videoMath.js'

export { normalizePartDurations } from './videoMath.js'

// ============ Helpers ============

/** Resolve a stored (possibly relative) download path against DOWNLOAD_ROOT. */
function getFullFolderPath(relativePath: string): string {
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
  return path.join(downloadRoot, relativePath)
}

/** A per-section AudioSection counts as "voiced" when its audio file is done. */
function sectionHasAudio(section: { status: string; audioFile: { status: string } | null }): boolean {
  return !!section.audioFile && section.audioFile.status === 'done'
}

/** Seconds for a section's master clock — prefer the cached durationMs, else ffprobe. */
async function resolveSectionDuration(audioFile: { filePath: string; durationMs: number | null }): Promise<number> {
  if (audioFile.durationMs && audioFile.durationMs > 0) {
    return audioFile.durationMs / 1000
  }
  // Fallback: probe the file directly (path may be relative to DOWNLOAD_ROOT).
  const abs = path.isAbsolute(audioFile.filePath)
    ? audioFile.filePath
    : path.resolve(audioFile.filePath)
  const meta = await getAudioMetadata(abs)
  return meta.durationMs / 1000
}

// ============ Types ============

export interface EditableChapter {
  id: string
  number: number
  title: string | null
  ready: boolean
  reason: string | null          // why it's not ready (null when ready)
  hasFinalizedCrops: boolean
  cropCount: number
  hasSectionAudio: boolean
  sectionCount: number
  isPartEnd: boolean             // narration Part boundary (this chapter ends a Part)
}

export interface ChapterCrop {
  id: string
  sequence: number               // crop number = story order
  imagePath: string              // absolute path to the exported crop PNG
  aspectRatio: string | null
}

// ============ Editable chapters ============

/**
 * List a series' chapters with their editability. A chapter is editable when it
 * has finalized crops AND every AudioSection has a done audio file.
 */
export async function getEditableChapters(seriesId: string): Promise<EditableChapter[]> {
  const chapters = await prisma.chapter.findMany({
    where: { seriesId },
    orderBy: { number: 'asc' },
    include: {
      cropSession: { include: { _count: { select: { crops: true } } } },
      audioSections: { include: { audioFile: true } },
      script: { select: { isPartEnd: true } }
    }
  })

  return chapters.map(ch => {
    const hasFinalizedCrops = ch.cropSession?.status === 'finalized'
    const cropCount = ch.cropSession?._count?.crops ?? 0
    const sectionCount = ch.audioSections.length
    const hasSectionAudio =
      sectionCount > 0 && ch.audioSections.every(sectionHasAudio)

    let reason: string | null = null
    if (!hasFinalizedCrops && !hasSectionAudio) {
      reason = 'Needs finalized crops (Clipper) and voiceover audio (Voiceover)'
    } else if (!hasFinalizedCrops) {
      reason = 'Needs finalized crops — finish this chapter in the Image Clipper'
    } else if (!hasSectionAudio) {
      reason = 'Needs voiceover audio — finish this chapter in the Voiceover module'
    }

    return {
      id: ch.id,
      number: ch.number,
      title: ch.title,
      ready: reason === null,
      reason,
      hasFinalizedCrops,
      cropCount,
      hasSectionAudio,
      sectionCount,
      isPartEnd: ch.script?.isPartEnd ?? false
    }
  })
}

// ============ Chapter crop pool ============

/**
 * The chapter's finalized crop pool, in crop-number (story) order. Only crops
 * that were actually exported to disk are returned.
 */
export async function getChapterCrops(chapterId: string): Promise<ChapterCrop[]> {
  const session = await prisma.cropSession.findUnique({
    where: { chapterId },
    include: { crops: { orderBy: { sequence: 'asc' } } }
  })

  if (!session) return []

  return session.crops
    .filter(c => !!c.exportPath)
    .map(c => ({
      id: c.id,
      sequence: c.sequence,
      imagePath: c.exportPath!,
      aspectRatio: c.aspectRatio
    }))
}

// ============ Project initialization ============

/**
 * Initialize a video project for a series across the given chapters (in order).
 *
 * For each chapter (in order) we create one VideoPartEdit per AudioSection
 * (master clock = that section's audio duration), with a global orderIndex.
 * Images are NOT auto-picked here (that's the AI-assist step). Finally we append
 * one editor-managed outro end-card part (isOutro, no section, fixed duration).
 */
export async function initProject(
  seriesId: string,
  chapterIds: string[],
  name?: string
): Promise<string> {
  if (chapterIds.length === 0) {
    throw new Error('At least one chapter is required')
  }

  const series = await prisma.series.findUnique({ where: { id: seriesId } })
  if (!series) throw new Error('Series not found')

  const chapterKey = JSON.stringify(chapterIds)

  // Reuse the existing project for this exact series + chapter set so the user's
  // saved image selections persist across visits (recompiling no longer wipes
  // them). Only rebuild parts if the project somehow has none.
  const existing = await prisma.videoProject.findFirst({
    where: { seriesId, chapterIds: chapterKey },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { parts: true } } }
  })
  if (existing) {
    if (existing._count.parts === 0) {
      await buildProjectParts(existing.id, chapterIds, existing.titleCardDuration)
    }
    return existing.id
  }

  // Create the project first so we can read its default title-card duration.
  const project = await prisma.videoProject.create({
    data: {
      seriesId,
      name: name?.trim() || `${series.title} — Video`,
      chapterIds: chapterKey
    }
  })

  await buildProjectParts(project.id, chapterIds, project.titleCardDuration)
  return project.id
}

/**
 * (Re)build a project's part tree from the given chapters in order: one part per
 * voiced AudioSection, then a final outro end-card part. Replaces any existing
 * parts. Shared by initProject and the chapter-set update.
 */
export async function buildProjectParts(
  projectId: string,
  chapterIds: string[],
  titleCardDuration: number
): Promise<void> {
  await prisma.videoPartEdit.deleteMany({ where: { projectId } })

  let orderIndex = 0
  let lastChapterId = chapterIds[0]

  for (const chapterId of chapterIds) {
    const sections = await prisma.audioSection.findMany({
      where: { chapterId },
      orderBy: { index: 'asc' },
      include: { audioFile: true }
    })

    for (const section of sections) {
      if (!sectionHasAudio(section)) continue // skip unvoiced sections
      const audioDuration = await resolveSectionDuration(section.audioFile!)
      await prisma.videoPartEdit.create({
        data: { projectId, chapterId, audioSectionId: section.id, orderIndex: orderIndex++, isOutro: false, audioDuration }
      })
    }
    lastChapterId = chapterId
  }

  // Append the editor-managed end title card as the final part.
  await prisma.videoPartEdit.create({
    data: { projectId, chapterId: lastChapterId, audioSectionId: null, orderIndex: orderIndex++, isOutro: true, audioDuration: titleCardDuration }
  })
}

// ============ Series projects (resume / accordion list) ============

export interface SeriesProjectChapter {
  chapterId: string
  number: number | null
  totalParts: number   // non-outro parts for this chapter
  editedParts: number  // parts with at least one image
}

export interface SeriesProjectSummary {
  id: string
  name: string
  status: string
  chapterIds: string[]
  totalParts: number    // editable (non-outro) parts across the project
  editedParts: number   // non-outro parts with at least one image
  progress: number      // 0–100, share of editable parts that have images
  hasExport: boolean
  updatedAt: Date
  chapters: SeriesProjectChapter[]
}

/**
 * All video projects ("parts") for a series, each with an editing-progress
 * summary so the editor can list them as resumable accordions. Progress = the
 * share of non-outro parts that have at least one image selected. A finished
 * export forces 100%.
 */
export async function listSeriesProjects(seriesId: string): Promise<SeriesProjectSummary[]> {
  const projects = await prisma.videoProject.findMany({
    where: { seriesId },
    orderBy: { updatedAt: 'desc' },
    include: {
      parts: { select: { chapterId: true, isOutro: true, _count: { select: { images: true } } } },
      exports: { where: { status: 'done' }, select: { id: true } }
    }
  })

  // Resolve chapter numbers for every chapter referenced by any project.
  const allChapterIds = [...new Set(projects.flatMap(p => p.parts.map(part => part.chapterId)))]
  const chapterRows = allChapterIds.length
    ? await prisma.chapter.findMany({ where: { id: { in: allChapterIds } }, select: { id: true, number: true } })
    : []
  const numberById = new Map(chapterRows.map(c => [c.id, c.number]))

  return projects.map(p => {
    const editableParts = p.parts.filter(part => !part.isOutro)
    const editedParts = editableParts.filter(part => part._count.images > 0).length
    const totalParts = editableParts.length
    const hasExport = p.exports.length > 0

    // Per-chapter breakdown, in the project's stored chapter order.
    let chapterIds: string[] = []
    try { chapterIds = JSON.parse(p.chapterIds) } catch { chapterIds = [] }
    const chapters: SeriesProjectChapter[] = chapterIds.map(cid => {
      const parts = editableParts.filter(part => part.chapterId === cid)
      return {
        chapterId: cid,
        number: numberById.get(cid) ?? null,
        totalParts: parts.length,
        editedParts: parts.filter(part => part._count.images > 0).length
      }
    })

    const progress = hasExport ? 100 : totalParts > 0 ? Math.round((editedParts / totalParts) * 100) : 0

    return {
      id: p.id,
      name: p.name,
      status: p.status,
      chapterIds,
      totalParts,
      editedParts,
      progress,
      hasExport,
      updatedAt: p.updatedAt,
      chapters
    }
  })
}

/**
 * Delete a video project ("part") and everything under it. Parts, images,
 * exports and edit events cascade in the DB; we also best-effort remove any
 * rendered export files from disk so deleting a part frees its space.
 */
export async function deleteProject(projectId: string): Promise<void> {
  const project = await prisma.videoProject.findUnique({
    where: { id: projectId },
    include: { exports: { select: { outputPath: true } } }
  })
  if (!project) throw new Error('Project not found')

  for (const exp of project.exports) {
    if (!exp.outputPath) continue
    const abs = path.isAbsolute(exp.outputPath) ? exp.outputPath : path.resolve(exp.outputPath)
    await fs.rm(abs, { force: true }).catch(() => {})
  }

  await prisma.videoProject.delete({ where: { id: projectId } })
}

// ============ Project tree (read) ============

/**
 * Full project tree: project settings + ordered parts (→ images), each part
 * carrying its script text (from the linked AudioSection) for the editor.
 */
export async function getProjectTree(projectId: string) {
  const project = await prisma.videoProject.findUnique({
    where: { id: projectId },
    include: {
      series: { select: { id: true, title: true } },
      musicTrack: true,
      parts: {
        orderBy: { orderIndex: 'asc' },
        include: { images: { orderBy: { slotIndex: 'asc' } } }
      }
    }
  })

  if (!project) return null

  // Attach each part's script text from its AudioSection (outro has none).
  const sectionIds = project.parts
    .map(p => p.audioSectionId)
    .filter((id): id is string => !!id)

  const sections = sectionIds.length
    ? await prisma.audioSection.findMany({
        where: { id: { in: sectionIds } },
        select: { id: true, text: true, index: true }
      })
    : []
  const sectionById = new Map(sections.map(s => [s.id, s]))

  return {
    id: project.id,
    seriesId: project.seriesId,
    seriesTitle: project.series.title,
    name: project.name,
    status: project.status,
    chapterIds: JSON.parse(project.chapterIds) as string[],
    musicTrackId: project.musicTrackId,
    musicTrack: project.musicTrack,
    masterVolume: project.masterVolume,
    musicVolume: project.musicVolume,
    titleCardText: project.titleCardText,
    titleCardDuration: project.titleCardDuration,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    parts: project.parts.map(p => ({
      id: p.id,
      chapterId: p.chapterId,
      audioSectionId: p.audioSectionId,
      orderIndex: p.orderIndex,
      isOutro: p.isOutro,
      audioDuration: p.audioDuration,
      scriptText: p.audioSectionId ? sectionById.get(p.audioSectionId)?.text ?? null : null,
      images: p.images
    }))
  }
}

// ============================================================================
// FFmpeg render engine (Step 2 core: composite + drift motion + concat → MP4)
// No background music and no title-card text yet — those land in Step 3.
// ============================================================================

const DEFAULT_FPS = 30
const DEFAULT_CRF = 18
const AUDIO_BITRATE = '192k'
const AUDIO_SAMPLE_RATE = 44100

// zoompan truncates its x/y/zoom to integers every frame, so panning/zooming a
// display-sized image steps a whole pixel at a time → visible judder, and zoom-in
// upscales an already-downscaled image → soft. We render the foreground motion at
// SUPERSAMPLE× the display size (high-quality lanczos), then downscale: motion
// becomes sub-pixel-smooth and zoom samples real detail.
const FG_SUPERSAMPLE = 2
const SCALE_FLAGS = 'lanczos'

/** 16:9 output resolutions the editor offers. */
export const RESOLUTIONS: Record<string, { w: number; h: number }> = {
  '1920x1080': { w: 1920, h: 1080 },
  '1280x720': { w: 1280, h: 720 },
  '854x480': { w: 854, h: 480 }
}

/** Map the editor's quality preset to an x264 preset. */
const X264_PRESET: Record<string, string> = {
  fast: 'veryfast',
  medium: 'medium',
  slow: 'slow'
}

const GENTLE_EFFECTS = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'] as const

function getFfmpegPath(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg'
}
function getFfprobePath(): string {
  return process.env.FFPROBE_PATH || 'ffprobe'
}

// ---------- Capability detection (Part 2e) ----------

export interface VideoCapabilities {
  ffmpegAvailable: boolean
  ffmpegVersion?: string
  hasZoompan: boolean
  hasDrawtext: boolean
  blurFilter: 'gblur' | 'boxblur' | null // preferred blur, null if neither
  error?: string
}

let capabilitiesCache: VideoCapabilities | null = null

/**
 * Detect FFmpeg + the filters this engine needs. Cached after first run.
 * Degrades gracefully: gblur → boxblur; missing zoompan disables motion later.
 */
export function getVideoCapabilities(force = false): VideoCapabilities {
  if (capabilitiesCache && !force) return capabilitiesCache

  try {
    const versionOut = execSync(`${getFfmpegPath()} -version`, { encoding: 'utf-8', timeout: 5000 })
    const version = versionOut.match(/ffmpeg version ([^\s]+)/)?.[1]

    const filtersOut = execSync(`${getFfmpegPath()} -hide_banner -filters`, { encoding: 'utf-8', timeout: 5000 })
    const has = (name: string) => new RegExp(`\\s${name}\\s`).test(filtersOut)

    const hasGblur = has('gblur')
    const hasBoxblur = has('boxblur')

    capabilitiesCache = {
      ffmpegAvailable: true,
      ffmpegVersion: version,
      hasZoompan: has('zoompan'),
      hasDrawtext: has('drawtext'),
      blurFilter: hasGblur ? 'gblur' : hasBoxblur ? 'boxblur' : null
    }
  } catch (error) {
    capabilitiesCache = {
      ffmpegAvailable: false,
      hasZoompan: false,
      hasDrawtext: false,
      blurFilter: null,
      error: error instanceof Error ? error.message : 'FFmpeg not found on PATH'
    }
  }

  return capabilitiesCache
}

// ---------- Small probe + math helpers ----------

/** Even integer ≥ 2 (x264 requires even dimensions). */
function even(n: number): number {
  const r = Math.max(2, Math.round(n))
  return r % 2 === 0 ? r : r + 1
}

/** Pixel dimensions of an image via ffprobe. */
async function getImageDimensions(filePath: string): Promise<{ width: number; height: number }> {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(filePath)
  return new Promise((resolve, reject) => {
    const proc = spawn(getFfprobePath(), [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json',
      abs
    ])
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => (stdout += d.toString()))
    proc.stderr.on('data', d => (stderr += d.toString()))
    proc.on('error', reject)
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe failed for ${abs}: ${stderr}`))
      try {
        const s = JSON.parse(stdout).streams?.[0]
        resolve({ width: s.width, height: s.height })
      } catch {
        reject(new Error(`Could not parse image dimensions for ${abs}`))
      }
    })
  })
}

// ---------- Per-image filter chunk (reused by full render + proxy preview) ----------

export interface ImageRenderSpec {
  inputIndex: number          // ffmpeg input index within the part's render call
  frameW: number
  frameH: number
  fps: number
  durationFrames: number
  isFiller: boolean
  imgW?: number               // source pixel dims (omitted for filler)
  imgH?: number
  motionMode: string          // drift | focus
  motionEffect: string        // gentle set (drift); zoom-in|zoom-out direction (focus)
  motionIntensity: number
  anchorX?: number | null
  anchorY?: number | null
  // Manual foreground transform overrides (null = auto)
  scale?: number | null       // multiplier on the fit-height size (1 = touch top/bottom)
  offsetX?: number | null     // fraction of frame width to shift (0 = centered)
  offsetY?: number | null     // fraction of frame height to shift
  blurFilter: 'gblur' | 'boxblur' | null
  hasZoompan: boolean
}

/**
 * Build the filter_complex sub-graph for ONE image, consuming [{idx}:v] and
 * producing a labeled [v{idx}] segment of exactly durationFrames frames:
 *   - background: same image, cover-zoomed, blurred, 20% black overlay, no motion
 *   - foreground: image fit to frame height, centered, gentle drift motion
 * Filler images pass through a black frame.
 *
 * Returns the sub-graph string (each stage ';'-terminated) and the out label.
 */
export function buildImageFilterChunk(spec: ImageRenderSpec): { filter: string; outLabel: string } {
  const { inputIndex: i, frameW: W, frameH: H, fps, durationFrames: frames } = spec
  const outLabel = `[v${i}]`

  // Filler: the lavfi color input is already W×H for the right duration.
  if (spec.isFiller) {
    return { filter: `[${i}:v]setsar=1,fps=${fps}${outLabel};`, outLabel }
  }

  const f1 = Math.max(1, frames - 1) // denominator for linear interpolation
  const blur = spec.blurFilter === 'boxblur' ? 'boxblur=20:1' : spec.blurFilter === 'gblur' ? 'gblur=sigma=20' : null

  // Foreground size: fit frame height (a 4:3 crop → ~75% of a 16:9 frame),
  // multiplied by the manual scale override (1 = touch top/bottom; >1 = beyond).
  const imgW = spec.imgW || W
  const imgH = spec.imgH || H
  const scaleMul = spec.scale && spec.scale > 0 ? spec.scale : 1
  const fgH = even(H * scaleMul)
  const fgW = even(fgH * (imgW / imgH))

  // Manual position offsets (fraction of frame; 0 = centered).
  const ox = spec.offsetX ?? 0
  const oy = spec.offsetY ?? 0

  // --- Background sub-graph (cover 1.15×, blur, darken, hold for `frames`) ---
  const bgScale = `scale=${even(W * 1.15)}:${even(H * 1.15)}:force_original_aspect_ratio=increase:flags=${SCALE_FLAGS},crop=${W}:${H}`
  const bgStages = [bgScale]
  if (blur) bgStages.push(blur)
  bgStages.push(`drawbox=x=0:y=0:w=${W}:h=${H}:color=black@0.2:t=fill`, 'setsar=1')
  // Hold the still for the full duration. zoompan z=1 duplicates frames; without
  // zoompan, loop the single frame instead.
  const bgHold = spec.hasZoompan
    ? `zoompan=z=1:d=${frames}:s=${W}x${H}:fps=${fps}`
    : `loop=loop=${frames - 1}:size=1:start=0,fps=${fps}`
  bgStages.push(bgHold)

  // --- Foreground sub-graph (fit height × scale, gentle/focus motion) ---
  // Supersample the motion buffer so zoompan's per-frame integer rounding lands
  // on sub-pixels of the final frame (smooth drift) and zoom-in samples detail.
  const ss = spec.hasZoompan ? FG_SUPERSAMPLE : 1
  const fgWss = even(fgW * ss)
  const fgHss = even(fgH * ss)
  const fgScale = `scale=${fgWss}:${fgHss}:flags=${SCALE_FLAGS}`
  let fgMotion: string
  let fgDownscale = ''
  if (spec.hasZoompan) {
    fgMotion = `zoompan=${motionExpr(spec, f1)}:d=${frames}:s=${fgWss}x${fgHss}:fps=${fps}`
    if (ss > 1) fgDownscale = `,scale=${fgW}:${fgH}:flags=${SCALE_FLAGS}`
  } else {
    // No zoompan available → static hold (graceful degradation).
    fgMotion = `loop=loop=${frames - 1}:size=1:start=0,fps=${fps}`
  }

  // Overlay centered + manual offset; clipped to the frame when scaled beyond it.
  const overlayX = `(W-w)/2+(${ox})*W`
  const overlayY = `(H-h)/2+(${oy})*H`

  const filter =
    `[${i}:v]split=2[bs${i}][fs${i}];` +
    `[bs${i}]${bgStages.join(',')}[bg${i}];` +
    `[fs${i}]${fgScale},${fgMotion}${fgDownscale},setsar=1[fg${i}];` +
    `[bg${i}][fg${i}]overlay=x=${overlayX}:y=${overlayY}:eof_action=pass${outLabel};`

  return { filter, outLabel }
}

/** zoompan z/x/y expression for the gentle drift/focus motion of one image. */
function motionExpr(spec: ImageRenderSpec, f1: number): string {
  const k = Math.max(0, spec.motionIntensity)
  const effect = GENTLE_EFFECTS.includes(spec.motionEffect as any) ? spec.motionEffect : 'zoom-in'

  // Focus mode: zoom toward (or out from) an anchor point, kept fixed in frame.
  // motionEffect picks the direction (zoom-out reverses); default zoom-in.
  if (spec.motionMode === 'focus') {
    const ax = clamp01(spec.anchorX ?? 0.5)
    const ay = clamp01(spec.anchorY ?? 0.5)
    const z = spec.motionEffect === 'zoom-out'
      ? `1+${k}*(1-on/${f1})`
      : `1+${k}*on/${f1}`
    // Window top-left so the anchor stays centered, clamped inside the image.
    const x = `max(0,min(iw*${ax}-(iw/zoom/2),iw-iw/zoom))`
    const y = `max(0,min(ih*${ay}-(ih/zoom/2),ih-ih/zoom))`
    return `z='${z}':x='${x}':y='${y}'`
  }

  // Drift mode.
  const centerX = `iw/2-(iw/zoom/2)`
  const centerY = `ih/2-(ih/zoom/2)`
  switch (effect) {
    case 'zoom-out':
      return `z='1+${k}*(1-on/${f1})':x='${centerX}':y='${centerY}'`
    case 'pan-left':
      return `z='${1 + k}':x='(iw-iw/zoom)*(1-on/${f1})':y='${centerY}'`
    case 'pan-right':
      return `z='${1 + k}':x='(iw-iw/zoom)*on/${f1}':y='${centerY}'`
    case 'pan-up':
      return `z='${1 + k}':x='${centerX}':y='(ih-ih/zoom)*(1-on/${f1})'`
    case 'pan-down':
      return `z='${1 + k}':x='${centerX}':y='(ih-ih/zoom)*on/${f1}'`
    case 'zoom-in':
    default:
      return `z='1+${k}*on/${f1}':x='${centerX}':y='${centerY}'`
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

// ---------- Render orchestration ----------

export interface RenderOptions {
  resolution: string          // key of RESOLUTIONS
  preset: string              // fast | medium | slow
  fps?: number
}

export interface RenderHooks {
  io?: Server
  projectId?: string
  exportId?: string
  onProgress?: (percent: number) => void
  // Cooperative cancellation: set .cancelled and we kill the active child.
  control?: { cancelled: boolean; proc: ChildProcess | null }
}

interface PreparedImage {
  inputIndex: number
  isFiller: boolean
  imagePath: string | null
  imgW?: number
  imgH?: number
  duration: number
  motionMode: string
  motionEffect: string
  motionIntensity: number
  anchorX: number | null
  anchorY: number | null
  scale: number | null
  offsetX: number | null
  offsetY: number | null
}

/** Run one FFmpeg child, streaming -progress, honoring cooperative cancel. */
function runFfmpeg(
  args: string[],
  hooks: RenderHooks | undefined,
  onOutTime?: (sec: number) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (hooks?.control?.cancelled) return reject(new Error('cancelled'))

    const proc = spawn(getFfmpegPath(), args)
    if (hooks?.control) hooks.control.proc = proc

    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })

    if (onOutTime) {
      let buf = ''
      proc.stdout.on('data', d => {
        buf += d.toString()
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          const m = line.match(/^out_time_us=(\d+)/)
          if (m) onOutTime(parseInt(m[1], 10) / 1_000_000)
        }
      })
    }

    proc.on('error', reject)
    proc.on('close', code => {
      if (hooks?.control) hooks.control.proc = null
      if (hooks?.control?.cancelled) return reject(new Error('cancelled'))
      if (code === 0) resolve()
      else reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-2000)}`))
    })
  })
}

/**
 * Render the whole project to an MP4 and return the output path + duration.
 * Step 2: no music, no title-card text (outro = black + silence placeholder).
 */
export async function renderProject(
  projectId: string,
  options: RenderOptions,
  hooks?: RenderHooks
): Promise<{ outputPath: string; durationSec: number }> {
  ensureFfmpegAvailable(getVideoCapabilities())

  const res = RESOLUTIONS[options.resolution]
  if (!res) throw new Error(`Unsupported resolution: ${options.resolution}`)
  const fps = [24, 30, 60].includes(options.fps ?? 0) ? options.fps! : DEFAULT_FPS
  const x264Preset = X264_PRESET[options.preset] || 'medium'

  const project = await prisma.videoProject.findUnique({
    where: { id: projectId },
    include: {
      series: { select: { title: true, rootFolder: true } },
      parts: { orderBy: { orderIndex: 'asc' }, include: { images: { orderBy: { slotIndex: 'asc' } } } }
    }
  })
  if (!project) throw new Error('Project not found')
  if (project.parts.length === 0) throw new Error('Project has no parts')

  const outputDir = path.join(getFullFolderPath(project.series.rootFolder), '_video')
  await fs.mkdir(outputDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outputPath = path.join(outputDir, `${slugify(project.name)}_${options.resolution}_${stamp}.mp4`)

  const durationSec = await assembleVideo(
    project, project.parts, { res, fps, x264Preset, crf: DEFAULT_CRF }, outputPath, hooks
  )
  return { outputPath, durationSec }
}

interface AssembleOpts {
  res: { w: number; h: number }
  fps: number
  x264Preset: string
  crf: number
}

/**
 * Assemble a list of parts (in order) into a single MP4 at outputPath: render
 * each part (composited images + audio, or outro card), concat them, then mix
 * looped background music. Shared by the full renderer and the proxy preview.
 */
async function assembleVideo(
  project: any,
  parts: any[],
  opts: AssembleOpts,
  outputPath: string,
  hooks?: RenderHooks
): Promise<number> {
  const caps = getVideoCapabilities()
  if (parts.length === 0) throw new Error('Nothing to render')

  for (const part of parts) {
    if (!part.isOutro && part.images.length === 0) {
      throw new Error('A part has no images — select images or add a filler before exporting')
    }
  }

  const totalDuration = parts.reduce((s, p) => s + p.audioDuration, 0)
  const tmpDir = path.join(os.tmpdir(), `mhs_video_${project.id}_${Date.now()}`)
  await fs.mkdir(tmpDir, { recursive: true })

  const partFiles: string[] = []
  let priorDuration = 0

  try {
    for (let pi = 0; pi < parts.length; pi++) {
      if (hooks?.control?.cancelled) throw new Error('cancelled')
      const part = parts[pi]
      const partFile = path.join(tmpDir, `part_${String(pi).padStart(4, '0')}.mp4`)

      if (part.isOutro) {
        await renderOutroCard(partFile, part.audioDuration, opts.res, opts.fps, opts.x264Preset, opts.crf, {
          seriesTitle: project.series.title,
          titleCardText: project.titleCardText
        }, tmpDir, pi, hooks)
      } else {
        await renderImagePart(part, partFile, opts.res, opts.fps, opts.x264Preset, opts.crf, caps, hooks, sec => {
          reportProgress(hooks, Math.min(99, ((priorDuration + sec) / totalDuration) * 100))
        })
      }

      partFiles.push(partFile)
      priorDuration += part.audioDuration
      reportProgress(hooks, Math.min(99, (priorDuration / totalDuration) * 100))
    }

    const listPath = path.join(tmpDir, 'concat.txt')
    await fs.writeFile(listPath, partFiles.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'))

    const combinedPath = path.join(tmpDir, 'combined.mp4')
    await runFfmpeg(
      ['-hide_banner', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-y', combinedPath],
      hooks
    )

    const musicTrack = project.musicTrackId
      ? await prisma.musicTrack.findUnique({ where: { id: project.musicTrackId } })
      : null

    await mixAudioAndFinalize(combinedPath, outputPath, {
      musicPath: musicTrack?.filePath ?? null,
      masterVolume: project.masterVolume,
      musicVolume: project.musicVolume
    }, hooks)

    reportProgress(hooks, 100)
    return totalDuration
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Render a low-res proxy preview (640×360, ultrafast) for a scope — the whole
 * project, a single chapter, or a single part — using the same composition as
 * the final render so it's faithful. Returns a temp file path. Part 3.
 */
export async function renderProxyPreview(
  projectId: string,
  scope: 'project' | { partId?: string; chapterId?: string } | undefined,
  hooks?: RenderHooks
): Promise<{ outputPath: string }> {
  ensureFfmpegAvailable(getVideoCapabilities())

  const project = await prisma.videoProject.findUnique({
    where: { id: projectId },
    include: {
      series: { select: { title: true, rootFolder: true } },
      parts: { orderBy: { orderIndex: 'asc' }, include: { images: { orderBy: { slotIndex: 'asc' } } } }
    }
  })
  if (!project) throw new Error('Project not found')

  let parts = project.parts
  if (scope && typeof scope === 'object') {
    if (scope.partId) parts = parts.filter(p => p.id === scope.partId)
    else if (scope.chapterId) parts = parts.filter(p => p.chapterId === scope.chapterId && !p.isOutro)
  }
  if (parts.length === 0) throw new Error('Nothing to preview')

  const outputPath = path.join(os.tmpdir(), `mhs_preview_${projectId}_${Date.now()}.mp4`)
  await assembleVideo(project, parts, { res: { w: 640, h: 360 }, fps: 24, x264Preset: 'ultrafast', crf: 30 }, outputPath, hooks)
  return { outputPath }
}

function reportProgress(hooks: RenderHooks | undefined, percent: number) {
  hooks?.onProgress?.(percent)
  if (hooks?.io && hooks.projectId) {
    hooks.io.emit('video:render-progress', {
      projectId: hooks.projectId,
      exportId: hooks.exportId,
      percent: Math.round(percent)
    })
  }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'video'
}

/** Render a single non-outro part: composited image segments + the part audio. */
async function renderImagePart(
  part: { audioSectionId: string | null; audioDuration: number; images: any[] },
  outFile: string,
  res: { w: number; h: number },
  fps: number,
  x264Preset: string,
  crf: number,
  caps: VideoCapabilities,
  hooks: RenderHooks | undefined,
  onOutTime: (sec: number) => void
): Promise<void> {
  // Audio file for the master clock.
  const audioFile = part.audioSectionId
    ? await prisma.audioFile.findFirst({ where: { sectionId: part.audioSectionId, status: 'done' } })
    : null
  if (!audioFile) throw new Error('Part is missing its voiceover audio file')

  // Normalize durations so the images sum exactly to the audio duration.
  const normalized = normalizePartDurations(part.images, part.audioDuration)

  // Probe dimensions for non-filler images.
  const prepared: PreparedImage[] = []
  for (let idx = 0; idx < normalized.length; idx++) {
    const im = normalized[idx]
    let imgW: number | undefined
    let imgH: number | undefined
    if (!im.isFiller && im.imagePath) {
      const dim = await getImageDimensions(im.imagePath)
      imgW = dim.width
      imgH = dim.height
    }
    prepared.push({
      inputIndex: idx,
      isFiller: im.isFiller,
      imagePath: im.imagePath,
      imgW,
      imgH,
      duration: im.duration,
      motionMode: im.motionMode,
      motionEffect: im.motionEffect,
      motionIntensity: im.motionIntensity,
      anchorX: im.anchorX,
      anchorY: im.anchorY,
      scale: im.scale,
      offsetX: im.offsetX,
      offsetY: im.offsetY
    })
  }

  // Build inputs + filter chunks.
  const inputArgs: string[] = []
  const chunks: string[] = []
  const labels: string[] = []

  prepared.forEach(im => {
    const frames = Math.max(1, Math.round(im.duration * fps))
    if (im.isFiller || !im.imagePath) {
      inputArgs.push('-f', 'lavfi', '-i', `color=c=black:s=${res.w}x${res.h}:r=${fps}:d=${im.duration.toFixed(3)}`)
    } else {
      const abs = path.isAbsolute(im.imagePath) ? im.imagePath : path.resolve(im.imagePath)
      inputArgs.push('-i', abs)
    }
    const { filter, outLabel } = buildImageFilterChunk({
      inputIndex: im.inputIndex,
      frameW: res.w,
      frameH: res.h,
      fps,
      durationFrames: frames,
      isFiller: im.isFiller || !im.imagePath,
      imgW: im.imgW,
      imgH: im.imgH,
      motionMode: im.motionMode,
      motionEffect: im.motionEffect,
      motionIntensity: im.motionIntensity,
      anchorX: im.anchorX,
      anchorY: im.anchorY,
      scale: im.scale,
      offsetX: im.offsetX,
      offsetY: im.offsetY,
      blurFilter: caps.blurFilter,
      hasZoompan: caps.hasZoompan
    })
    chunks.push(filter)
    labels.push(outLabel)
  })

  const audioInputIndex = prepared.length
  const audioAbs = path.isAbsolute(audioFile.filePath) ? audioFile.filePath : path.resolve(audioFile.filePath)
  inputArgs.push('-i', audioAbs)

  const filterComplex = `${chunks.join('')}${labels.join('')}concat=n=${labels.length}:v=1:a=0[vout]`

  const args = [
    '-hide_banner', '-nostats', '-progress', 'pipe:1',
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', `${audioInputIndex}:a`,
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', x264Preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ar', String(AUDIO_SAMPLE_RATE),
    '-shortest',
    '-y', outFile
  ]

  await runFfmpeg(args, hooks, onOutTime)
}

const DEFAULT_CLOSING_LINE = 'Thanks for watching'

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const CARD_FONT_FAMILY = 'Helvetica, Arial, "Liberation Sans", sans-serif'

/**
 * Render the end-card image with sharp (SVG → PNG). We use sharp rather than
 * FFmpeg drawtext because text rendering must work on every machine, and this
 * build of FFmpeg may lack drawtext (libfreetype). sharp is already a hard
 * dependency (the Clipper uses it).
 */
export async function makeTitleCardImage(
  text: { seriesTitle: string; titleCardText: string | null },
  res: { w: number; h: number },
  outPath: string
): Promise<void> {
  const { w, h } = res
  const common = `text-anchor="middle" font-family='${CARD_FONT_FAMILY}'`

  let inner: string
  if (text.titleCardText && text.titleCardText.trim()) {
    const lines = text.titleCardText.split(/\r?\n/)
    const size = Math.round(h * 0.06)
    const lineH = Math.round(size * 1.3)
    const startY = Math.round(h / 2 - ((lines.length - 1) * lineH) / 2)
    inner = lines
      .map((ln, i) => `<text x="${w / 2}" y="${startY + i * lineH}" font-size="${size}" fill="#ffffff" ${common}>${xmlEscape(ln)}</text>`)
      .join('')
  } else {
    const titleSize = Math.round(h * 0.075)
    const subSize = Math.round(h * 0.04)
    inner =
      `<text x="${w / 2}" y="${Math.round(h / 2 - titleSize * 0.1)}" font-size="${titleSize}" font-weight="bold" fill="#ffffff" ${common}>${xmlEscape(text.seriesTitle)}</text>` +
      `<text x="${w / 2}" y="${Math.round(h / 2 + subSize * 1.8)}" font-size="${subSize}" fill="#CCCCCC" ${common}>${xmlEscape(DEFAULT_CLOSING_LINE)}</text>`
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#0B0B12"/>${inner}</svg>`
  await sharp(Buffer.from(svg)).png().toFile(outPath)
}

/**
 * Render the outro end title card: a still card image (series title + closing
 * line, or the editable override) held for the card duration, plus silent
 * narration audio (background music is mixed in during finalize). Part 3.
 */
async function renderOutroCard(
  outFile: string,
  duration: number,
  res: { w: number; h: number },
  fps: number,
  x264Preset: string,
  crf: number,
  text: { seriesTitle: string; titleCardText: string | null },
  tmpDir: string,
  partIndex: number,
  hooks: RenderHooks | undefined
): Promise<void> {
  const cardPng = path.join(tmpDir, `card_${partIndex}.png`)
  await makeTitleCardImage(text, res, cardPng)

  const args = [
    '-hide_banner', '-nostats',
    '-loop', '1', '-t', duration.toFixed(3), '-i', cardPng,
    '-f', 'lavfi', '-t', duration.toFixed(3), '-i', `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo`,
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', x264Preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ar', String(AUDIO_SAMPLE_RATE),
    '-shortest',
    '-y', outFile
  ]
  await runFfmpeg(args, hooks)
}

/**
 * Finalize: mix looped background music under the narration (narration at
 * masterVolume, music at musicVolume) and write the output. Falls back to a
 * volume-only pass or a straight copy when there's no music. Part 2c / 3.
 */
async function mixAudioAndFinalize(
  combinedPath: string,
  outputPath: string,
  opts: { musicPath: string | null; masterVolume: number; musicVolume: number },
  hooks: RenderHooks | undefined
): Promise<void> {
  const master = clampVolume(opts.masterVolume)
  const music = clampVolume(opts.musicVolume)
  const mode = chooseMixMode({ musicPath: opts.musicPath, masterVolume: opts.masterVolume })

  if (mode === 'music') {
    const musicAbs = path.isAbsolute(opts.musicPath!) ? opts.musicPath! : path.resolve(opts.musicPath!)
    await runFfmpeg([
      '-hide_banner', '-nostats',
      '-i', combinedPath,
      '-stream_loop', '-1', '-i', musicAbs,
      '-filter_complex',
      `[0:a]volume=${master}[a0];[1:a]volume=${music}[a1];[a0][a1]amix=inputs=2:duration=first:normalize=0[aout]`,
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ar', String(AUDIO_SAMPLE_RATE),
      '-shortest', '-movflags', '+faststart', '-y', outputPath
    ], hooks)
    return
  }

  if (mode === 'volume') {
    await runFfmpeg([
      '-hide_banner', '-nostats',
      '-i', combinedPath,
      '-filter:a', `volume=${master}`,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', AUDIO_BITRATE,
      '-movflags', '+faststart', '-y', outputPath
    ], hooks)
    return
  }

  // No music, unity volume → just finalize the container with faststart.
  await runFfmpeg([
    '-hide_banner', '-nostats', '-i', combinedPath,
    '-c', 'copy', '-movflags', '+faststart', '-y', outputPath
  ], hooks)
}

// ============================================================================
// Step 5: project settings, part-image editing, and render orchestration
// ============================================================================

/** Update mutable project settings. Rebuilds the part tree if chapters change. */
export async function updateProject(
  projectId: string,
  patch: {
    name?: string
    chapterIds?: string[]
    musicTrackId?: string | null
    masterVolume?: number
    musicVolume?: number
    titleCardText?: string | null
    titleCardDuration?: number
  }
) {
  const existing = await prisma.videoProject.findUnique({ where: { id: projectId } })
  if (!existing) throw new Error('Project not found')

  const data: any = {}
  if (patch.name !== undefined) data.name = patch.name
  if (patch.musicTrackId !== undefined) data.musicTrackId = patch.musicTrackId
  if (patch.masterVolume !== undefined) data.masterVolume = clampVolume(patch.masterVolume)
  if (patch.musicVolume !== undefined) data.musicVolume = clampVolume(patch.musicVolume)
  if (patch.titleCardText !== undefined) data.titleCardText = patch.titleCardText
  if (patch.titleCardDuration !== undefined) data.titleCardDuration = Math.max(0.5, patch.titleCardDuration)
  if (patch.chapterIds !== undefined) data.chapterIds = JSON.stringify(patch.chapterIds)

  await prisma.videoProject.update({ where: { id: projectId }, data })

  // Title-card duration also drives the outro part's clock.
  if (patch.titleCardDuration !== undefined) {
    await prisma.videoPartEdit.updateMany({
      where: { projectId, isOutro: true },
      data: { audioDuration: Math.max(0.5, patch.titleCardDuration) }
    })
  }

  // Rebuild parts only when the chapter set actually changes.
  if (patch.chapterIds !== undefined) {
    const prev = JSON.parse(existing.chapterIds) as string[]
    const changed = prev.length !== patch.chapterIds.length || prev.some((id, i) => id !== patch.chapterIds![i])
    if (changed) {
      const dur = patch.titleCardDuration ?? existing.titleCardDuration
      await buildProjectParts(projectId, patch.chapterIds, dur)
    }
  }

  return getProjectTree(projectId)
}

export interface IncomingPartImage {
  cropId?: string | null
  imagePath?: string | null
  isFiller?: boolean
  duration?: number
  motionMode?: string
  motionEffect?: string
  motionIntensity?: number
  anchorX?: number | null
  anchorY?: number | null
  scale?: number | null
  offsetX?: number | null
  offsetY?: number | null
  source?: string
}

function randomGentleEffect(): string {
  return GENTLE_EFFECTS[Math.floor(Math.random() * GENTLE_EFFECTS.length)]
}

/**
 * Bulk-set a part's image list. slotIndex follows the order the client sent, so
 * the user is free to arrange images in any order (not locked to story order).
 * Durations are normalized to sum to the part's audio duration. An optional
 * event is logged as a VideoEditEvent for the future style model.
 */
export async function setPartImages(
  partId: string,
  incoming: IncomingPartImage[],
  event?: { eventType: string; payload?: any }
) {
  const part = await prisma.videoPartEdit.findUnique({ where: { id: partId } })
  if (!part) throw new Error('Part not found')
  if (part.isOutro) throw new Error('The outro part has no images')
  if (incoming.length === 0) throw new Error('A part needs at least one image or a filler')

  // Resolve authoritative crop paths (order is whatever the client sent).
  const cropIds = incoming.map(i => i.cropId).filter((id): id is string => !!id)
  const crops = cropIds.length
    ? await prisma.crop.findMany({ where: { id: { in: cropIds } }, select: { id: true, sequence: true, exportPath: true } })
    : []
  const cropById = new Map(crops.map(c => [c.id, c]))

  // Keep the client's order; the editor decides arrangement, not story order.
  const ordered = incoming

  // Normalize durations to the part's audio duration (in slot order).
  const normalized = normalizePartDurations(
    ordered.map(im => ({ duration: typeof im.duration === 'number' ? im.duration : 0 })),
    part.audioDuration
  )

  await prisma.$transaction(async tx => {
    await tx.videoPartImage.deleteMany({ where: { partEditId: partId } })
    for (let i = 0; i < ordered.length; i++) {
      const im = ordered[i]
      const crop = im.cropId ? cropById.get(im.cropId) : null
      const isFiller = !!im.isFiller || !crop
      await tx.videoPartImage.create({
        data: {
          partEditId: partId,
          cropId: isFiller ? null : crop!.id,
          imagePath: isFiller ? null : crop!.exportPath ?? null,
          isFiller,
          slotIndex: i,
          duration: normalized[i].duration,
          motionMode: im.motionMode === 'focus' ? 'focus' : 'drift',
          motionEffect: im.motionEffect ?? randomGentleEffect(),
          motionIntensity: typeof im.motionIntensity === 'number' ? im.motionIntensity : 0.04,
          anchorX: im.anchorX ?? null,
          anchorY: im.anchorY ?? null,
          scale: im.scale ?? null,
          offsetX: im.offsetX ?? null,
          offsetY: im.offsetY ?? null,
          source: im.source ?? 'manual'
        }
      })
    }
    await tx.videoPartEdit.update({ where: { id: partId }, data: { updatedAt: new Date() } })
    if (event?.eventType) {
      await tx.videoEditEvent.create({
        data: {
          projectId: part.projectId,
          partEditId: partId,
          eventType: event.eventType,
          payloadJson: JSON.stringify(event.payload ?? {})
        }
      })
    }
  })

  const updated = await prisma.videoPartEdit.findUnique({
    where: { id: partId },
    include: { images: { orderBy: { slotIndex: 'asc' } } }
  })
  return updated
}

// ---------- Render orchestration (Part 2d) ----------

const activeRenders = new Map<string, { cancelled: boolean; proc: ChildProcess | null }>()

/**
 * Start a full project render in the background. Creates a VideoExport row,
 * returns its id immediately, and emits Socket.io lifecycle events. The render
 * runs off the event loop in spawned FFmpeg children.
 */
export async function startProjectRender(
  projectId: string,
  options: RenderOptions,
  io: Server
): Promise<string> {
  ensureFfmpegAvailable(getVideoCapabilities())
  if (!RESOLUTIONS[options.resolution]) {
    throw new Error(`Unsupported resolution: ${options.resolution}`)
  }

  const exportRow = await prisma.videoExport.create({
    data: { projectId, outputPath: '', resolution: options.resolution, preset: options.preset, status: 'rendering' }
  })
  await prisma.videoProject.update({ where: { id: projectId }, data: { status: 'rendering' } })

  const control = { cancelled: false, proc: null as ChildProcess | null }
  activeRenders.set(exportRow.id, control)

  // Fire-and-forget; the route already returned the exportId to the client.
  void (async () => {
    try {
      const { outputPath, durationSec } = await renderProject(projectId, options, {
        io, projectId, exportId: exportRow.id, control
      })
      const stat = await fs.stat(outputPath)
      await prisma.videoExport.update({
        where: { id: exportRow.id },
        data: { status: 'done', outputPath, durationSec, fileSizeMb: stat.size / 1_000_000 }
      })
      await prisma.videoProject.update({ where: { id: projectId }, data: { status: 'done' } })
      io.emit('video:render-complete', { projectId, exportId: exportRow.id, outputPath })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const cancelled = control.cancelled || message === 'cancelled'
      await prisma.videoExport.update({
        where: { id: exportRow.id },
        data: { status: 'failed', errorMsg: cancelled ? 'Cancelled' : message }
      })
      await prisma.videoProject.update({ where: { id: projectId }, data: { status: cancelled ? 'draft' : 'failed' } })
      io.emit(cancelled ? 'video:render-cancelled' : 'video:render-failed', {
        projectId, exportId: exportRow.id, error: cancelled ? undefined : message
      })
    } finally {
      activeRenders.delete(exportRow.id)
    }
  })()

  return exportRow.id
}

/** Cooperatively cancel a running render (kills the active FFmpeg child). */
export function cancelRender(exportId: string): boolean {
  const control = activeRenders.get(exportId)
  if (!control) return false
  control.cancelled = true
  control.proc?.kill('SIGKILL')
  return true
}
