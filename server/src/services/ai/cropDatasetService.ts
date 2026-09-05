/**
 * Crop Dataset Service — Module 3 AI: Auto-Crop
 *
 * Exports finalized user crops into an on-disk training dataset under
 * server/ml/dataset/, consumed by the Python trainer (server/ml/train.py).
 *
 * The export is:
 *  - incremental  — already-exported crops are skipped (tracked in manifest.json)
 *  - re-runnable  — safe to call repeatedly; pass { force: true } to rebuild
 *
 * Each sample carries geometric features, sequence context, the canvas→source
 * file mapping, an adjustment signal derived from CropEvent history, and two
 * downscaled WebP images (the crop region + a vertically-extended context region).
 */

import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import { prisma } from '../../index.js'
import {
  getChapterManifest,
  renderCanvasRegionBuffer,
  type ImageManifest
} from '../clipperService.js'
import type {
  CropSample,
  CanvasRect,
  DatasetManifest,
  DatasetExportResult,
  SampleSourceRegion
} from './aiCropTypes.js'

// ============ Paths ============

/** Dataset root: <server>/ml/dataset. process.cwd() is the server/ dir at runtime. */
export function getDatasetDir(): string {
  return path.join(process.cwd(), 'ml', 'dataset')
}

/** Absolute path to a chapter's image folder (mirrors clipperService). */
function fullFolderPath(relativePath: string): string {
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
  return path.resolve(downloadRoot, relativePath)
}

/** Phase B: where the cut-detector index lives (chapter strips + cut positions). */
function getCutIndexPath(): string {
  return path.join(getDatasetDir(), 'cuts_index.json')
}

function getImagesDir(): string {
  return path.join(getDatasetDir(), 'images')
}

function getManifestPath(): string {
  return path.join(getDatasetDir(), 'manifest.json')
}

function getSamplesPath(): string {
  return path.join(getDatasetDir(), 'samples.jsonl')
}

function getFeedbackPath(): string {
  return path.join(getDatasetDir(), 'feedback.jsonl')
}

function getFeedbackManifestPath(): string {
  return path.join(getDatasetDir(), 'feedback_manifest.json')
}

// Downscale target for dataset images (keeps the dataset small & offline-friendly)
const IMAGE_MAX_DIM = 256
const CONTEXT_EXPAND_RATIO = 0.5 // extend the crop 50% above and below

// ============ Manifest I/O ============

function emptyManifest(): DatasetManifest {
  return { version: 1, updatedAt: new Date().toISOString(), sampleCount: 0, exportedCropIds: [], cursor: null }
}

async function readManifest(): Promise<DatasetManifest> {
  try {
    const raw = await fs.readFile(getManifestPath(), 'utf-8')
    const parsed = JSON.parse(raw) as DatasetManifest
    if (parsed.version !== 1 || !Array.isArray(parsed.exportedCropIds)) return emptyManifest()
    return parsed
  } catch {
    return emptyManifest()
  }
}

async function writeManifest(manifest: DatasetManifest): Promise<void> {
  manifest.updatedAt = new Date().toISOString()
  await fs.mkdir(getDatasetDir(), { recursive: true })
  await fs.writeFile(getManifestPath(), JSON.stringify(manifest, null, 2))
}

// ============ Public API ============

/** Number of training samples currently in the dataset (for the train guardrail). */
export async function getDatasetSampleCount(): Promise<number> {
  const manifest = await readManifest()
  return manifest.sampleCount
}

/**
 * Live count of finalized crops available to train on, computed straight from
 * the DB. Unlike {@link getDatasetSampleCount} (which reads manifest.json and
 * is only refreshed during a training run), this reflects crops the moment they
 * are finalized — so the "can I train yet?" gate isn't deadlocked behind an
 * export that only happens once training has already started.
 *
 * Mirrors the export's notion of a sample: one row per crop in a finalized
 * session (see exportDataset's per-crop loop).
 */
export async function getFinalizedCropCount(): Promise<number> {
  return prisma.crop.count({ where: { session: { status: 'finalized' } } })
}

/**
 * Export all finalized crops not yet in the dataset.
 * Returns counts; never throws on a single bad crop (logs and skips it so it
 * is retried on the next run).
 */
export async function exportDataset(opts: { force?: boolean } = {}): Promise<DatasetExportResult> {
  const datasetDir = getDatasetDir()
  await fs.mkdir(getImagesDir(), { recursive: true })

  let manifest = await readManifest()

  if (opts.force) {
    // Rebuild from scratch
    await fs.rm(getImagesDir(), { recursive: true, force: true })
    await fs.rm(getSamplesPath(), { force: true })
    await fs.mkdir(getImagesDir(), { recursive: true })
    manifest = emptyManifest()
  }

  // Load every finalized crop, grouped by session so we can compute neighbours.
  const sessions = await prisma.cropSession.findMany({
    where: { status: 'finalized' },
    include: {
      crops: { orderBy: { sequence: 'asc' } },
      chapter: { select: { id: true, folderPath: true, seriesId: true } }
    }
  })

  const exportedIds = new Set(manifest.exportedCropIds)
  let exported = 0
  let skipped = 0
  let total = 0
  let cursor = manifest.cursor

  // Phase B cut detector: full (non-incremental) index of every finalized
  // chapter's image folder + manifest + the user's cut Y-positions. Python
  // rebuilds the page strip from these (same code path as inference) and learns
  // where the user cuts.
  const cutIndex: Array<{
    chapterId: string
    imageDir: string
    manifest: { canvasWidth: number; canvasHeight: number; images: unknown[] }
    cutYs: number[]
  }> = []

  for (const session of sessions) {
    if (session.crops.length === 0) continue

    // Build the manifest once per chapter (expensive: reads every page's dimensions).
    let imageManifest: ImageManifest
    try {
      imageManifest = await getChapterManifest(session.chapter.folderPath)
    } catch (err) {
      console.error(`[dataset] skipping session ${session.id}: failed to build manifest`, err)
      continue
    }

    // Record this chapter's cut boundaries (crop tops + bottoms, deduped/sorted).
    const cutSet = new Set<number>()
    for (const c of session.crops) {
      cutSet.add(Math.round(c.canvasY))
      cutSet.add(Math.round(c.canvasY + c.canvasH))
    }
    cutIndex.push({
      chapterId: session.chapter.id,
      imageDir: fullFolderPath(session.chapter.folderPath),
      manifest: {
        canvasWidth: imageManifest.canvasWidth,
        canvasHeight: imageManifest.canvasHeight,
        images: imageManifest.images as unknown[]
      },
      cutYs: Array.from(cutSet).sort((a, b) => a - b)
    })

    for (let i = 0; i < session.crops.length; i++) {
      const crop = session.crops[i]
      total++

      if (exportedIds.has(crop.id)) {
        skipped++
        continue
      }

      try {
        const prev = session.crops[i - 1]
        const next = session.crops[i + 1]
        const sample = await buildSample(crop, session, imageManifest, prev, next)
        await fs.appendFile(getSamplesPath(), JSON.stringify(sample) + '\n')

        exportedIds.add(crop.id)
        exported++
        const createdIso = crop.createdAt.toISOString()
        if (!cursor || createdIso > cursor) cursor = createdIso
      } catch (err) {
        // Leave the crop unmarked so it is retried next run.
        console.error(`[dataset] failed to export crop ${crop.id}`, err)
      }
    }
  }

  manifest.exportedCropIds = Array.from(exportedIds)
  manifest.sampleCount = manifest.exportedCropIds.length
  manifest.cursor = cursor
  await writeManifest(manifest)

  // Refresh the cut-detector index (full snapshot every run).
  await fs.writeFile(getCutIndexPath(), JSON.stringify({ chapters: cutIndex }))

  return { exported, skipped, total, sampleCount: manifest.sampleCount, datasetDir }
}

/**
 * Export AI-suggestion feedback (Part 1.3): accepted/adjusted suggestions become
 * positive samples and rejected ones become negatives for the confidence
 * calibrator. Incremental & re-runnable (tracks exported suggestion ids).
 */
export async function exportSuggestionFeedback(opts: { force?: boolean } = {}): Promise<{ exported: number }> {
  await fs.mkdir(getImagesDir(), { recursive: true })

  let exportedIds = new Set<string>()
  if (opts.force) {
    await fs.rm(getFeedbackPath(), { force: true })
  } else {
    try {
      const raw = await fs.readFile(getFeedbackManifestPath(), 'utf-8')
      exportedIds = new Set<string>(JSON.parse(raw).exportedIds || [])
    } catch {
      /* first run */
    }
  }

  // Resolved feedback: accept/adjust/reject only (pending is not feedback yet).
  const suggestions = await prisma.aISuggestion.findMany({
    where: { status: { in: ['accepted', 'adjusted', 'rejected'] } },
    include: { session: { include: { chapter: { select: { folderPath: true } } } } },
    orderBy: { createdAt: 'asc' }
  })

  const manifestCache = new Map<string, ImageManifest>()
  let exported = 0

  for (const s of suggestions) {
    if (exportedIds.has(s.id)) continue
    try {
      const folderPath = s.session.chapter.folderPath
      let imageManifest = manifestCache.get(folderPath)
      if (!imageManifest) {
        imageManifest = await getChapterManifest(folderPath)
        manifestCache.set(folderPath, imageManifest)
      }

      // Kept crops use the final rect; rejected use the originally suggested rect.
      const kept = s.status !== 'rejected'
      const rect: CanvasRect = JSON.parse((kept && s.finalRectJson) ? s.finalRectJson : s.rectJson)

      const cropRel = path.join('images', `fb_${s.id}_crop.webp`)
      const ctxRel = path.join('images', `fb_${s.id}_ctx.webp`)
      await renderRegionToWebp(rect, imageManifest, folderPath, path.join(getDatasetDir(), cropRel))
      const ctxRect = expandContext(rect, imageManifest.canvasHeight)
      await renderRegionToWebp(ctxRect, imageManifest, folderPath, path.join(getDatasetDir(), ctxRel))

      const fbSample = {
        suggestionId: s.id,
        chapterId: s.chapterId,
        canvasWidth: imageManifest.canvasWidth,
        canvasHeight: imageManifest.canvasHeight,
        rect,
        aspectPreset: s.aspectPreset,
        kept,
        sequence: 0,
        count: 1,
        images: { crop: cropRel, context: ctxRel }
      }
      await fs.appendFile(getFeedbackPath(), JSON.stringify(fbSample) + '\n')
      exportedIds.add(s.id)
      exported++
    } catch (err) {
      console.error(`[dataset] failed to export feedback ${s.id}`, err)
    }
  }

  await fs.writeFile(getFeedbackManifestPath(), JSON.stringify({
    updatedAt: new Date().toISOString(),
    exportedIds: Array.from(exportedIds)
  }, null, 2))

  return { exported }
}

// ============ Sample construction ============

type SessionWithChapter = {
  id: string
  chapter: { id: string; folderPath: string; seriesId: string }
}

type CropRow = {
  id: string
  sessionId: string
  sequence: number
  canvasX: number
  canvasY: number
  canvasW: number
  canvasH: number
  normX: number
  normY: number
  normW: number
  normH: number
  sourceFiles: string
  aspectRatio: string | null
  createdAt: Date
}

async function buildSample(
  crop: CropRow,
  session: SessionWithChapter & { crops: CropRow[] },
  imageManifest: ImageManifest,
  prev: CropRow | undefined,
  next: CropRow | undefined
): Promise<CropSample> {
  const rect: CanvasRect = {
    canvasX: crop.canvasX,
    canvasY: crop.canvasY,
    canvasW: crop.canvasW,
    canvasH: crop.canvasH
  }

  // Sequence context (canvas-space vertical gaps between consecutive crops).
  const distanceFromPrev = prev ? crop.canvasY - (prev.canvasY + prev.canvasH) : null
  const gapToNext = next ? next.canvasY - (crop.canvasY + crop.canvasH) : null

  let sourceFiles: SampleSourceRegion[] = []
  try {
    sourceFiles = JSON.parse(crop.sourceFiles) as SampleSourceRegion[]
  } catch {
    sourceFiles = []
  }

  const adjustment = await buildAdjustmentSignal(crop)

  // Render & persist the two images.
  const cropRel = path.join('images', `${crop.id}_crop.webp`)
  const ctxRel = path.join('images', `${crop.id}_ctx.webp`)

  await renderRegionToWebp(rect, imageManifest, session.chapter.folderPath, path.join(getDatasetDir(), cropRel))

  const ctxRect = expandContext(rect, imageManifest.canvasHeight)
  await renderRegionToWebp(ctxRect, imageManifest, session.chapter.folderPath, path.join(getDatasetDir(), ctxRel))

  return {
    cropId: crop.id,
    sessionId: crop.sessionId,
    chapterId: session.chapter.id,
    seriesId: session.chapter.seriesId,
    sequence: crop.sequence,
    cropCountInChapter: session.crops.length,
    distanceFromPrev,
    gapToNext,
    aspectPreset: crop.aspectRatio || 'free',
    canvasWidth: imageManifest.canvasWidth,
    canvasHeight: imageManifest.canvasHeight,
    rect,
    normRect: { normX: crop.normX, normY: crop.normY, normW: crop.normW, normH: crop.normH },
    sourceFiles,
    adjustment,
    images: { crop: cropRel, context: ctxRel },
    source: 'crop'
  }
}

/** Vertically extend a crop rect by CONTEXT_EXPAND_RATIO, clamped to the canvas. */
function expandContext(rect: CanvasRect, canvasHeight: number): CanvasRect {
  const pad = rect.canvasH * CONTEXT_EXPAND_RATIO
  const top = Math.max(0, rect.canvasY - pad)
  const bottom = Math.min(canvasHeight, rect.canvasY + rect.canvasH + pad)
  return { canvasX: rect.canvasX, canvasY: top, canvasW: rect.canvasW, canvasH: bottom - top }
}

async function renderRegionToWebp(
  rect: CanvasRect,
  manifest: ImageManifest,
  folderPath: string,
  outputPath: string
): Promise<void> {
  const png = await renderCanvasRegionBuffer(rect, manifest, folderPath)
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await sharp(png)
    .resize(IMAGE_MAX_DIM, IMAGE_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(outputPath)
}

/**
 * Derive how much the user adjusted this crop from their first draft, using the
 * CropEvent log. A large delta = the user re-padded / repositioned the AI/initial
 * rectangle, which is signal for their padding habits.
 */
async function buildAdjustmentSignal(crop: CropRow): Promise<CropSample['adjustment']> {
  const events = await prisma.cropEvent.findMany({
    where: { cropId: crop.id },
    orderBy: { createdAt: 'asc' }
  })

  let firstDraftRect: CanvasRect | null = null
  let resizeCount = 0
  let moveCount = 0

  for (const ev of events) {
    if (ev.action === 'resized') resizeCount++
    if (ev.action === 'moved') moveCount++
    if (ev.action === 'created' && ev.payload && !firstDraftRect) {
      try {
        const p = JSON.parse(ev.payload)
        if (p.canvasX != null && p.canvasY != null && p.canvasW != null && p.canvasH != null) {
          firstDraftRect = { canvasX: p.canvasX, canvasY: p.canvasY, canvasW: p.canvasW, canvasH: p.canvasH }
        }
      } catch {
        /* ignore malformed payload */
      }
    }
  }

  const deltaFromFirstDraft = firstDraftRect
    ? {
        dx: crop.canvasX - firstDraftRect.canvasX,
        dy: crop.canvasY - firstDraftRect.canvasY,
        dw: crop.canvasW - firstDraftRect.canvasW,
        dh: crop.canvasH - firstDraftRect.canvasH
      }
    : null

  return { firstDraftRect, resizeCount, moveCount, deltaFromFirstDraft }
}
