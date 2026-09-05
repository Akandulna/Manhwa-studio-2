/**
 * Clipper Service — Module 3: Image Clipper
 * 
 * Core image processing logic for the crop workspace.
 * Handles:
 * - Building image manifests (dimensions + canvas offsets)
 * - Mapping canvas-space crop rectangles to source file regions
 * - Executing crops with sharp (including cross-file stitching)
 * - Finalizing sessions (batch export to disk)
 */

import sharp from 'sharp'
import fs from 'fs/promises'
import path from 'path'
import { Server } from 'socket.io'
import { prisma } from '../index.js'
import { applyWhiteFill, watermarkRectsForCrop, detectChapterWatermarkRects } from './watermarkService.js'

// ============ Types ============

/**
 * One source slice, described in BOTH spaces.
 *
 * Webtoon chapters arrive as slices of the same logical page encoded at different
 * resolutions — 713px, 800px and 968px wide in the same chapter is normal. They are
 * the same content width, just different encodings, so the canvas scales every slice
 * up to the widest one (`ImageManifest.canvasWidth`) instead of stacking them at
 * their raw sizes. Stacking raw would leave narrower pages as short columns with
 * dead space to their right, and would make `x = 1.0` point past the artwork.
 *
 * The consequence is that source pixels and canvas pixels are no longer the same
 * unit for a scaled page, so both are carried explicitly:
 *  - `width` / `height` are SOURCE pixels — what sharp extracts from.
 *  - `canvasY` / `canvasHeight` are CANVAS pixels — what crop rectangles are in.
 *  - `scale` converts between them (`canvas = source * scale`).
 *
 * For a uniform-width chapter every `scale` is 1 and the two spaces coincide, which
 * is why this distinction went unnoticed for so long.
 */
export interface ManifestImage {
  filename: string
  /** Source pixel width. Equals canvasWidth only when `scale === 1`. */
  width: number
  /** Source pixel height. */
  height: number
  /** Cumulative Y offset in the virtual canvas, in CANVAS pixels. */
  canvasY: number
  /** This slice's height in CANVAS pixels (`height * scale`). */
  canvasHeight: number
  /** `manifest.canvasWidth / width` — always >= 1. */
  scale: number
}

export interface ImageManifest {
  /** The reference width: the widest slice. Every page is scaled up to this. */
  canvasWidth: number
  /** Sum of every slice's SCALED height. */
  canvasHeight: number
  images: ManifestImage[]
}

export interface SourceFileRegion {
  filename: string
  // Extract region within the source file (pixels)
  x: number
  y: number
  width: number
  height: number
}

export interface CropRect {
  canvasX: number
  canvasY: number
  canvasW: number
  canvasH: number
}

// ============ Helpers ============

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif']

function getFullFolderPath(relativePath: string): string {
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
  return path.join(downloadRoot, relativePath)
}

/**
 * Get sorted list of image filenames from a chapter folder.
 * Only returns filenames in the root of the folder (no subdirectories).
 */
async function getImageFiles(folderPath: string): Promise<string[]> {
  const entries = await fs.readdir(folderPath, { withFileTypes: true })

  return entries
    .filter(entry => {
      if (!entry.isFile()) return false
      const ext = path.extname(entry.name).toLowerCase()
      return IMAGE_EXTENSIONS.includes(ext)
    })
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

// ============ Manifest ============

/**
 * Build an image manifest for a chapter.
 * Reads each image's dimensions with sharp and lays them out on a single continuous
 * canvas whose width is the widest slice (see `ManifestImage`).
 *
 * Two passes are required, not one: the reference width is not known until every
 * slice has been measured, and every slice's scaled height depends on it. A
 * single-pass version would have to assume the first page is the widest.
 */
export async function getChapterManifest(folderPath: string): Promise<ImageManifest> {
  const fullPath = getFullFolderPath(folderPath)
  const filenames = await getImageFiles(fullPath)

  if (filenames.length === 0) {
    throw new Error(`No images found in ${folderPath}`)
  }

  // Pass 1 — measure.
  const measured: Array<{ filename: string; width: number; height: number }> = []
  for (const filename of filenames) {
    const metadata = await sharp(path.join(fullPath, filename)).metadata()

    if (!metadata.width || !metadata.height) {
      throw new Error(`Could not read dimensions for ${filename}`)
    }
    measured.push({ filename, width: metadata.width, height: metadata.height })
  }

  const canvasWidth = Math.max(...measured.map(m => m.width))
  if (!Number.isFinite(canvasWidth) || canvasWidth <= 0) {
    throw new Error(`Could not determine a reference width for ${folderPath}`)
  }

  // Pass 2 — scale each slice to the reference width and stack the scaled heights.
  const images: ManifestImage[] = []
  let canvasY = 0
  for (const m of measured) {
    const scale = canvasWidth / m.width
    const canvasHeight = m.height * scale
    images.push({ ...m, canvasY, canvasHeight, scale })
    canvasY += canvasHeight
  }

  return {
    canvasWidth,
    canvasHeight: canvasY,
    images
  }
}

// ============ Crop Mapping ============

/**
 * Map a canvas-space crop rectangle to source file regions.
 * Handles crops that span multiple source images.
 *
 * The crop arrives in CANVAS pixels and sharp needs SOURCE pixels, so every extent
 * is divided by that slice's `scale`. On a uniform-width chapter `scale` is 1 and
 * this is the identity; on a mixed-width chapter it is the whole point — without it
 * a crop on a 713px slice of a 968px canvas would be read 36% too far right and too
 * far down within that file.
 */
export function computeCropFromCanvas(
  crop: CropRect,
  manifest: ImageManifest
): SourceFileRegion[] {
  const regions: SourceFileRegion[] = []
  const cropTop = crop.canvasY
  const cropBottom = crop.canvasY + crop.canvasH

  for (const img of manifest.images) {
    const imgTop = img.canvasY
    const imgBottom = img.canvasY + img.canvasHeight

    // Check if crop overlaps this image
    if (cropTop >= imgBottom || cropBottom <= imgTop) {
      continue
    }

    // Compute overlap region within this image, still in canvas pixels
    const overlapTop = Math.max(cropTop, imgTop)
    const overlapBottom = Math.min(cropBottom, imgBottom)

    // Convert to image-local SOURCE coordinates
    const scale = img.scale > 0 ? img.scale : 1
    const localY = (overlapTop - imgTop) / scale
    const localHeight = (overlapBottom - overlapTop) / scale

    // X coordinate — clamp to image width
    const localX = Math.max(0, Math.min(crop.canvasX / scale, img.width - 1))
    const localWidth = Math.min(crop.canvasW / scale, img.width - localX)

    // Round edges, then clamp width/height so the region never exceeds the
    // image bounds (independent rounding of position + size can overflow by 1px,
    // which makes sharp throw "bad extract area").
    const x = Math.round(localX)
    const y = Math.round(localY)
    const width = Math.min(Math.round(localWidth), img.width - x)
    const height = Math.min(Math.round(localHeight), img.height - y)

    // Skip degenerate slivers (e.g. a sub-pixel overlap at a page seam).
    if (width <= 0 || height <= 0) continue

    regions.push({ filename: img.filename, x, y, width, height })
  }

  if (regions.length === 0) {
    throw new Error('Crop does not overlap any source images')
  }

  return regions
}

// ============ Crop Execution ============

/**
 * Execute a single crop from source files.
 * If the crop spans a single file, extracts directly.
 * If it spans multiple files, stitches them vertically first.
 */
export async function executeCrop(
  crop: CropRect,
  manifest: ImageManifest,
  folderPath: string,
  outputPath: string,
  watermarkRects: CropRect[] = []
): Promise<{ width: number; height: number; bytes: number }> {
  const fullFolderPath = getFullFolderPath(folderPath)
  const regions = computeCropFromCanvas(crop, manifest)

  let resultBuffer: Buffer

  if (regions.length === 1) {
    // Single-file crop — direct extraction
    const region = regions[0]
    const filePath = path.join(fullFolderPath, region.filename)

    // A scaled slice extracts fewer source pixels than the crop measures on the
    // canvas, so it is resized back up to canvas scale. Without this, two crops of
    // identical on-screen size would export at different pixel sizes depending on
    // which slice they came from — and the multi-file branch below already
    // normalizes to canvas width, so skipping it here would make a crop's output
    // size depend on whether it happened to straddle a seam.
    const scale = manifest.images.find(img => img.filename === region.filename)?.scale ?? 1

    let pipeline = sharp(filePath).extract({
      left: region.x,
      top: region.y,
      width: region.width,
      height: region.height
    })

    if (Math.abs(scale - 1) > 1e-9) {
      pipeline = pipeline.resize({
        width: Math.max(1, Math.round(region.width * scale)),
        height: Math.max(1, Math.round(region.height * scale)),
        fit: 'fill'
      })
    }

    resultBuffer = await pipeline.png().toBuffer()
  } else {
    // Multi-file crop — stitch then extract
    // Extract each region, normalizing width
    const slices: { buffer: Buffer; height: number }[] = []
    const cropWidth = Math.round(crop.canvasW)

    for (const region of regions) {
      const filePath = path.join(fullFolderPath, region.filename)
      const slice = await sharp(filePath)
        .extract({
          left: region.x,
          top: region.y,
          width: region.width,
          height: region.height
        })
        .resize({ width: cropWidth }) // Normalize width
        .png()
        .toBuffer()
      const meta = await sharp(slice).metadata()
      slices.push({ buffer: slice, height: meta.height || region.height })
    }

    // Compute total height
    const totalHeight = slices.reduce((sum, s) => sum + s.height, 0)

    // Composite all slices vertically
    const compositeInputs = []
    let yOffset = 0
    for (const slice of slices) {
      compositeInputs.push({
        input: slice.buffer,
        top: yOffset,
        left: 0
      })
      yOffset += slice.height
    }

    resultBuffer = await sharp({
      create: {
        width: cropWidth,
        height: totalHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite(compositeInputs)
      .png()
      .toBuffer()
  }

  // White-fill any detected watermark that falls inside this crop.
  const localWatermarks = watermarkRectsForCrop(crop, watermarkRects)
  if (localWatermarks.length > 0) {
    resultBuffer = await applyWhiteFill(resultBuffer, localWatermarks)
  }

  // Ensure output directory exists
  await fs.mkdir(path.dirname(outputPath), { recursive: true })

  // Write to disk
  await fs.writeFile(outputPath, resultBuffer)

  // Get final metadata
  const meta = await sharp(resultBuffer).metadata()

  return {
    width: meta.width || 0,
    height: meta.height || 0,
    bytes: resultBuffer.length
  }
}

/**
 * Generate a preview thumbnail for a crop (returns base64 PNG).
 * Preview is downscaled to fit within 300x300 px.
 */
export async function generateCropPreview(
  crop: CropRect,
  manifest: ImageManifest,
  folderPath: string
): Promise<string> {
  const fullFolderPath = getFullFolderPath(folderPath)
  const regions = computeCropFromCanvas(crop, manifest)

  let resultBuffer: Buffer

  if (regions.length === 1) {
    const region = regions[0]
    const filePath = path.join(fullFolderPath, region.filename)
    resultBuffer = await sharp(filePath)
      .extract({
        left: region.x,
        top: region.y,
        width: region.width,
        height: region.height
      })
      .resize(300, 300, { fit: 'inside' })
      .png()
      .toBuffer()
  } else {
    // Multi-file: stitch first, then resize
    // First extract each region, normalizing all slices to same width
    const slices: { buffer: Buffer; height: number }[] = []
    const cropWidth = Math.round(crop.canvasW)

    for (const region of regions) {
      const filePath = path.join(fullFolderPath, region.filename)
      const slice = await sharp(filePath)
        .extract({
          left: region.x,
          top: region.y,
          width: region.width,
          height: region.height
        })
        .resize({ width: cropWidth }) // Normalize width
        .png()
        .toBuffer()
      const meta = await sharp(slice).metadata()
      slices.push({ buffer: slice, height: meta.height || region.height })
    }

    const totalHeight = slices.reduce((sum, s) => sum + s.height, 0)

    const compositeInputs = []
    let yOffset = 0
    for (const slice of slices) {
      compositeInputs.push({ input: slice.buffer, top: yOffset, left: 0 })
      yOffset += slice.height
    }

    const stitched = await sharp({
      create: {
        width: cropWidth,
        height: totalHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite(compositeInputs)
      .png() // encode so the buffer can be re-read by sharp below
      .toBuffer()

    resultBuffer = await sharp(stitched)
      .resize(300, 300, { fit: 'inside' })
      .png()
      .toBuffer()
  }

  return `data:image/png;base64,${resultBuffer.toString('base64')}`
}

/**
 * Render an arbitrary canvas-space rectangle to a PNG buffer (no disk write).
 * Shares the same single-file / multi-file stitching logic as executeCrop,
 * and is used by the AI dataset exporter to produce training images.
 */
export async function renderCanvasRegionBuffer(
  crop: CropRect,
  manifest: ImageManifest,
  folderPath: string
): Promise<Buffer> {
  const fullFolderPath = getFullFolderPath(folderPath)
  const regions = computeCropFromCanvas(crop, manifest)

  if (regions.length === 1) {
    const region = regions[0]
    const filePath = path.join(fullFolderPath, region.filename)
    return sharp(filePath)
      .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
      .png()
      .toBuffer()
  }

  // Multi-file — stitch vertically, normalizing width
  const cropWidth = Math.round(crop.canvasW)
  const slices: { buffer: Buffer; height: number }[] = []

  for (const region of regions) {
    const filePath = path.join(fullFolderPath, region.filename)
    const slice = await sharp(filePath)
      .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
      .resize({ width: cropWidth })
      .png()
      .toBuffer()
    const meta = await sharp(slice).metadata()
    slices.push({ buffer: slice, height: meta.height || region.height })
  }

  const totalHeight = slices.reduce((sum, s) => sum + s.height, 0)
  const compositeInputs: { input: Buffer; top: number; left: number }[] = []
  let yOffset = 0
  for (const slice of slices) {
    compositeInputs.push({ input: slice.buffer, top: yOffset, left: 0 })
    yOffset += slice.height
  }

  return sharp({
    create: {
      width: cropWidth,
      height: totalHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite(compositeInputs)
    .png()
    .toBuffer()
}

// ============ Session Finalization ============

/**
 * Finalize a crop session — export all crops to disk.
 * Output: storage/<series>/<chapter>/crops/<slug>_crop_<seq>.png
 */
export async function finalizeSession(
  sessionId: string,
  io?: Server
): Promise<{ outputDir: string; exportedCount: number }> {
  // Load session with crops and chapter info
  const session = await prisma.cropSession.findUnique({
    where: { id: sessionId },
    include: {
      crops: { orderBy: { sequence: 'asc' } },
      chapter: {
        include: { series: true }
      }
    }
  })

  if (!session) {
    throw new Error('Session not found')
  }

  if (session.crops.length === 0) {
    throw new Error('No crops to export')
  }

  const chapter = session.chapter
  const series = chapter.series

  // Build manifest for the chapter
  const manifest = await getChapterManifest(chapter.folderPath)

  // Detect site watermarks once for the whole chapter (canvas-space rects).
  // Each crop white-fills only the rects that fall inside it. Best-effort:
  // if the sidecar is unavailable or there are no templates, this is just [].
  let watermarkRects: CropRect[] = []
  try {
    watermarkRects = await detectChapterWatermarkRects(chapter.folderPath, series.id, manifest)
  } catch (err) {
    console.error('Watermark detection failed (continuing without white-fill):', err)
  }

  // Output directory: <folderPath>/crops/
  const fullFolderPath = getFullFolderPath(chapter.folderPath)
  const outputDir = path.join(fullFolderPath, 'crops')
  await fs.mkdir(outputDir, { recursive: true })

  // Generate slug from series title
  const slug = series.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  let exportedCount = 0

  for (const crop of session.crops) {
    const seqStr = String(crop.sequence).padStart(3, '0')
    const outputFilename = `${slug}_crop_${seqStr}.png`
    const outputPath = path.join(outputDir, outputFilename)

    try {
      await executeCrop(
        {
          canvasX: crop.canvasX,
          canvasY: crop.canvasY,
          canvasW: crop.canvasW,
          canvasH: crop.canvasH
        },
        manifest,
        chapter.folderPath,
        outputPath,
        watermarkRects
      )

      // Update crop with export path
      await prisma.crop.update({
        where: { id: crop.id },
        data: { exportPath: outputPath }
      })

      // Log event
      await prisma.cropEvent.create({
        data: {
          sessionId,
          cropId: crop.id,
          action: 'finalized',
          payload: JSON.stringify({ exportPath: outputPath })
        }
      })

      exportedCount++
    } catch (error) {
      console.error(`Failed to export crop ${crop.sequence}:`, error)
    }

    // Emit progress
    if (io) {
      io.emit('clipper:finalize-progress', {
        sessionId,
        current: exportedCount,
        total: session.crops.length
      })
    }
  }

  // Update session status
  await prisma.cropSession.update({
    where: { id: sessionId },
    data: { status: 'finalized' }
  })

  // Emit completion
  if (io) {
    io.emit('clipper:finalize-complete', {
      sessionId,
      success: exportedCount === session.crops.length,
      outputDir,
      exportedCount
    })
  }

  return { outputDir, exportedCount }
}

/**
 * Compute normalized coordinates for a crop relative to the full canvas.
 */
export function normalizeCoordinates(
  crop: CropRect,
  manifest: ImageManifest
): { normX: number; normY: number; normW: number; normH: number } {
  return {
    normX: crop.canvasX / manifest.canvasWidth,
    normY: crop.canvasY / manifest.canvasHeight,
    normW: crop.canvasW / manifest.canvasWidth,
    normH: crop.canvasH / manifest.canvasHeight
  }
}
