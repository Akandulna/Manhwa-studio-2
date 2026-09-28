/**
 * Chapter manifest — the page list of a downloaded chapter, measured.
 *
 * Lists a chapter folder's images in reading order, reads each one's pixel size
 * and lays them out on one continuous canvas. Image Clipper 3.0 and Editor 2.0
 * both build on it.
 */

import sharp from 'sharp'
import fs from 'fs/promises'
import path from 'path'

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
