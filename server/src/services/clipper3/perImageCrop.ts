/**
 * Image Clipper 3.0 — cutting sections out of ONE image.
 *
 * 2.0's applyCropPoints resolves each crop against the stitched chapter canvas
 * and may span several source pages, so it carries a whole region-mapping
 * pipeline. 3.0 needs none of that: a crop's four points are normalized against
 * the single image they belong to, so cutting is a direct extract from that
 * file. Each image is independent, and one image failing never stops another.
 */

import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import {
  getOutputDir,
  getSourceFolderPath,
  type Clipper3CropEntry
} from './perImageStore.js'

export interface CutFile {
  cropId: string
  filename: string
  path: string
  width: number
  height: number
  bytes: number
}

export interface CutImageResult {
  imageFilename: string
  files: CutFile[]
  failed: number
  warnings: string[]
}

/** Filesystem-safe stem for output names. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'crop'
}

/**
 * The pixel rect a crop entry describes inside its own image.
 *
 * Uses the min/max of all four points rather than P1/P3 alone: a hand-authored
 * or perspective quad may be skewed, and the cut is the axis-aligned rectangle
 * that contains it — the same reading the 3.0 viewer draws.
 */
function entryPixelRect(
  entry: Clipper3CropEntry,
  imageWidth: number,
  imageHeight: number
): { left: number; top: number; width: number; height: number } {
  const points = (entry.crop?.points ?? []).filter(
    p => Number.isFinite(p.x) && Number.isFinite(p.y)
  )
  if (points.length === 0) {
    throw new Error('no usable points')
  }

  const xs = points.map(p => p.x)
  const ys = points.map(p => p.y)

  // Clamped, because a slightly out-of-bounds point is a warning at validation
  // time, not a reason to refuse the cut — but sharp will reject a rect that
  // leaves the image.
  const left = Math.round(Math.min(1, Math.max(0, Math.min(...xs))) * imageWidth)
  const top = Math.round(Math.min(1, Math.max(0, Math.min(...ys))) * imageHeight)
  const right = Math.round(Math.min(1, Math.max(0, Math.max(...xs))) * imageWidth)
  const bottom = Math.round(Math.min(1, Math.max(0, Math.max(...ys))) * imageHeight)

  const width = right - left
  const height = bottom - top
  if (width < 1 || height < 1) {
    throw new Error(`degenerate rect ${width}x${height}`)
  }

  return { left, top, width, height }
}

/**
 * Cut every crop of one image. Failures are per-crop and reported, never thrown,
 * so a single bad entry cannot lose the rest of the page's sections.
 */
export async function cutImageCrops(opts: {
  folderPath: string
  imageFilename: string
  crops: Clipper3CropEntry[]
  /** Prefix for output filenames, usually the series slug. */
  slug: string
}): Promise<CutImageResult> {
  const { folderPath, imageFilename, crops, slug } = opts
  const warnings: string[] = []
  const files: CutFile[] = []
  let failed = 0

  const sourcePath = path.join(getSourceFolderPath(folderPath), path.basename(imageFilename))
  const meta = await sharp(sourcePath).metadata()
  const imageWidth = meta.width ?? 0
  const imageHeight = meta.height ?? 0
  if (imageWidth < 1 || imageHeight < 1) {
    throw new Error(`Could not read dimensions of ${imageFilename}`)
  }

  const exportDir = getOutputDir(folderPath)
  await fs.mkdir(exportDir, { recursive: true })

  const stem = path.basename(imageFilename).replace(/\.[^/.]+$/, '')

  for (let i = 0; i < crops.length; i++) {
    const entry = crops[i]
    const reasonPart = entry.reason ? `_${slugify(entry.reason)}` : ''
    const filename = `${slug}_${stem}_${String(i + 1).padStart(2, '0')}${reasonPart}.png`
    const outputPath = path.join(exportDir, filename)

    try {
      const rect = entryPixelRect(entry, imageWidth, imageHeight)
      const info = await sharp(sourcePath).extract(rect).png().toFile(outputPath)
      const stat = await fs.stat(outputPath)
      files.push({
        cropId: entry.id,
        filename,
        path: path.resolve(outputPath),
        width: info.width,
        height: info.height,
        bytes: stat.size
      })
    } catch (err) {
      failed++
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[clipper3] crop ${entry.id} of ${imageFilename} failed:`, message)
      warnings.push(`${imageFilename} / ${entry.id}: ${message}`)
    }
  }

  return { imageFilename, files, failed, warnings }
}
