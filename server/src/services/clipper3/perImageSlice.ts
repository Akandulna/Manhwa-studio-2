/**
 * Image Clipper 3.0 — slicing ONE image into vertical parts on disk.
 *
 * Distinct from perImageCrop: that cuts the panels a crop artifact describes,
 * this cuts the whole page into fixed-height pieces so it can be handed to a
 * chat model without being downscaled into mush.
 *
 * Slicing happens here rather than in the browser for two reasons: sharp reads
 * the true pixel dimensions off the file and extracts losslessly, and the
 * result lands in a real folder the user can open and select from — which is
 * the only way to get many images onto the clipboard at once, since the system
 * clipboard holds a single decoded image but any number of file references.
 */

import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import { getSourceFolderPath } from './perImageStore.js'

/** Every slice is this tall except the last, which takes whatever is left. */
export const SLICE_HEIGHT = 2048

/** WebP cannot encode either side past this many pixels. */
const WEBP_MAX_DIMENSION = 16383

export interface SliceRect {
  /** 1-based, in top-to-bottom order. */
  index: number
  left: number
  top: number
  width: number
  height: number
}

/**
 * Cuts a W×H image into full-width vertical slices of `SLICE_HEIGHT`, top to
 * bottom. Only the final slice may be shorter: an 11240px page gives five
 * 2048px slices and one of 1000px. The slices tile the full height with no gap
 * or overlap, and there is no cap on how many a very tall page produces.
 */
export function computeSlices(width: number, height: number): SliceRect[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return []
  }

  const sliceHeight = SLICE_HEIGHT

  const rects: SliceRect[] = []
  for (let top = 0, index = 1; top < height; top += sliceHeight, index++) {
    rects.push({
      index,
      left: 0,
      top,
      width,
      // The final slice is clipped to whatever height is left over.
      height: Math.min(sliceHeight, height - top)
    })
  }

  return rects
}

export interface SliceFile {
  index: number
  filename: string
  width: number
  height: number
  bytes: number
}

export interface SliceImageResult {
  imageFilename: string
  /** Absolute path of the folder holding the slices, for the OS file explorer. */
  directory: string
  sourceWidth: number
  sourceHeight: number
  files: SliceFile[]
}

/**
 * Where one image's slices live, kept out of the source chapter folder:
 *
 *   <Series>/<Series>/<Chapter>/slices3/<image stem>/
 *
 * The inner folder repeats the series folder's own name and mirrors its
 * chapter folders one for one. Its name holds no "chapter N", so the importer
 * never mistakes it for a chapter.
 */
export function getSliceDir(folderPath: string, imageFilename: string): string {
  const base = path.basename(imageFilename)
  if (!base || base === '.' || base === '..') {
    throw new Error(`Unusable image filename: ${imageFilename}`)
  }
  const stem = base.replace(/\.[^/.]+$/, '')
  const chapterDir = getSourceFolderPath(folderPath)
  const seriesDir = path.dirname(chapterDir)
  return path.join(seriesDir, path.basename(seriesDir), path.basename(chapterDir), 'slices3', stem)
}

/**
 * Slices one source image into its own folder and returns what was written.
 *
 * The folder is emptied first, so re-slicing never leaves last run's pieces
 * behind to be selected alongside the new ones.
 */
export async function sliceImage(opts: {
  folderPath: string
  imageFilename: string
}): Promise<SliceImageResult> {
  const { folderPath, imageFilename } = opts

  const sourcePath = path.join(getSourceFolderPath(folderPath), path.basename(imageFilename))
  const meta = await sharp(sourcePath).metadata()
  const sourceWidth = meta.width ?? 0
  const sourceHeight = meta.height ?? 0
  if (sourceWidth < 1 || sourceHeight < 1) {
    throw new Error(`Could not read dimensions of ${imageFilename}`)
  }

  if (sourceWidth > WEBP_MAX_DIMENSION) {
    throw new Error(`${imageFilename} is ${sourceWidth}px wide; WebP slices cannot be wider than ${WEBP_MAX_DIMENSION}px`)
  }

  const rects = computeSlices(sourceWidth, sourceHeight)
  if (rects.length === 0) {
    throw new Error(`${imageFilename} has no usable dimensions to slice`)
  }

  const dir = getSliceDir(folderPath, imageFilename)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })

  const stem = path.basename(imageFilename).replace(/\.[^/.]+$/, '')
  const pad = String(rects.length).length

  const files: SliceFile[] = []
  for (const rect of rects) {
    // Zero-padded so the OS sorts them in reading order, which is the order
    // they get attached in after a select-all.
    const filename = `${stem}_slice-${String(rect.index).padStart(pad, '0')}.webp`
    const outputPath = path.join(dir, filename)

    const info = await sharp(sourcePath)
      .extract({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
      // Lossless, so a slice decodes to the original's visible pixels. Only the hidden RGB of fully transparent pixels
      // may change: sharp does not expose libwebp's `exact` flag.
      .webp({ lossless: true, effort: 4 })
      .toFile(outputPath)

    const stat = await fs.stat(outputPath)
    files.push({
      index: rect.index,
      filename,
      width: info.width,
      height: info.height,
      bytes: stat.size
    })
  }

  return {
    imageFilename: path.basename(imageFilename),
    directory: path.resolve(dir),
    sourceWidth,
    sourceHeight,
    files
  }
}
