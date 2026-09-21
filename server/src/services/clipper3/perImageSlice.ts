/**
 * Image Clipper 3.0 — slicing ONE image into vertical parts on disk.
 *
 * Distinct from perImageCrop: that cuts the panels a crop artifact describes,
 * this cuts the whole page into evenly-sized pieces so it can be handed to a
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

/**
 * The slice count must stay BELOW this, i.e. at most MAX_SLICES - 1 = 8.
 * Squares are used while they fit that budget; past it the slices grow taller
 * than wide so the count never exceeds it.
 */
export const MAX_SLICES = 9

export interface SliceRect {
  /** 1-based, in top-to-bottom order. */
  index: number
  left: number
  top: number
  width: number
  height: number
}

/**
 * Cuts a W×H image into at most `MAX_SLICES - 1` vertical slices, top to bottom.
 *
 * Squares (height = W) are preferred and used while they fit the budget; only
 * the final slice may then be shorter. Past the budget the height grows to
 * ceil(H / limit) — the shortest uniform height that still tiles H in `limit`
 * pieces — so the slices turn taller than wide and the count stays capped.
 * Either way the slices tile the full height with no gap or overlap.
 */
export function computeSlices(width: number, height: number): SliceRect[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return []
  }

  const limit = MAX_SLICES - 1
  const squareCount = Math.ceil(height / width)
  const sliceHeight = squareCount <= limit ? width : Math.ceil(height / limit)

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

/** Where one image's slices live: `slices3/<image stem>/`. */
export function getSliceDir(folderPath: string, imageFilename: string): string {
  const base = path.basename(imageFilename)
  if (!base || base === '.' || base === '..') {
    throw new Error(`Unusable image filename: ${imageFilename}`)
  }
  const stem = base.replace(/\.[^/.]+$/, '')
  return path.join(getSourceFolderPath(folderPath), 'slices3', stem)
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
    const filename = `${stem}_slice-${String(rect.index).padStart(pad, '0')}.png`
    const outputPath = path.join(dir, filename)

    const info = await sharp(sourcePath)
      .extract({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
      .png()
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
