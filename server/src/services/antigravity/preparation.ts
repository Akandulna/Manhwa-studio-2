/**
 * AntiGravity page preparation (docs/PRD-antigravity-studio.md §8).
 *
 * Cuts one original page into full-width slices of 2000 px (the Antigravity
 * CLI scales anything above 2000 px per side, which would skew slice-local
 * coordinates), encodes them as lossless WebP, and proves the result:
 * the slices tile the decoded page with no gap or overlap, and every slice
 * decodes to exactly the original pixels of its region. Nothing is resized,
 * rotated or trimmed; a page that would need that fails with a reason.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { computeSlices } from '../clipper3/perImageSlice.js'

export const ANTIGRAVITY_SLICE_HEIGHT = 2000
/** Widest page Antigravity can receive without the CLI resizing it. */
export const ANTIGRAVITY_MAX_WIDTH = 2000
/** Product bound on slices per page (≈ 160 000 px tall); larger pages fail visibly. */
export const MAX_SLICES = 80

export const HANDOFF_SCHEMA = 'studio-antigravity-handoff/1'

export class PreparationError extends Error {
  constructor(readonly code: 'too_wide' | 'too_many_slices' | 'rotated' | 'unreadable' | 'verify_failed', message: string) {
    super(message)
  }
}

export interface PreparedSlice {
  id: string
  file: string
  x0: number
  y0: number
  x1: number
  y1: number
  width: number
  height: number
  bytes: number
  sha256: string
  mime: 'image/webp'
  data: Buffer
}

export interface PreparedPage {
  sourceSha256: string
  width: number
  height: number
  format: string
  pageStem: string
  slices: PreparedSlice[]
  verifiedAt: string
}

export const sha256 = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex')
export const stemOfFile = (filename: string) => filename.slice(0, filename.length - path.extname(filename).length)

/** Decode to 8-bit RGBA without rotating; equal inputs give byte-equal buffers. */
async function rgba(input: Buffer) {
  const { data, info } = await sharp(input, { failOn: 'error', limitInputPixels: false })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

export async function preparePage(sourcePath: string, filename: string): Promise<PreparedPage> {
  let bytes: Buffer
  try {
    bytes = await fs.readFile(sourcePath)
  } catch {
    throw new PreparationError('unreadable', `The source page ${filename} could not be read.`)
  }
  const meta = await sharp(bytes, { limitInputPixels: false }).metadata().catch(() => null)
  if (!meta?.width || !meta.height) throw new PreparationError('unreadable', `${filename} is not a readable image.`)
  if (meta.orientation && meta.orientation !== 1) {
    throw new PreparationError('rotated', `${filename} carries an EXIF rotation (${meta.orientation}); Studio does not rotate pages silently.`)
  }
  if (meta.width > ANTIGRAVITY_MAX_WIDTH) {
    throw new PreparationError('too_wide', `${filename} is ${meta.width} px wide; Antigravity would shrink anything wider than ${ANTIGRAVITY_MAX_WIDTH} px, so this page cannot be processed here.`)
  }
  const rects = computeSlices(meta.width, meta.height, ANTIGRAVITY_SLICE_HEIGHT)
  if (rects.length === 0) throw new PreparationError('unreadable', `${filename} has no pixels.`)
  if (rects.length > MAX_SLICES) throw new PreparationError('too_many_slices', `${filename} needs ${rects.length} slices (limit ${MAX_SLICES}).`)

  const original = await rgba(bytes)
  if (original.width !== meta.width || original.height !== meta.height) {
    throw new PreparationError('verify_failed', `${filename} decoded to ${original.width}×${original.height}, not ${meta.width}×${meta.height}.`)
  }
  const rowBytes = original.width * 4
  const stem = stemOfFile(filename)
  const slices: PreparedSlice[] = []
  let covered = 0
  for (const rect of rects) {
    if (rect.top !== covered || rect.left !== 0 || rect.width !== original.width) throw new PreparationError('verify_failed', 'Slices do not tile the page.')
    const region = original.data.subarray(rect.top * rowBytes, (rect.top + rect.height) * rowBytes)
    const data = await sharp(region, { raw: { width: rect.width, height: rect.height, channels: 4 } })
      .webp({ lossless: true, effort: 4 })
      .toBuffer()
    const decoded = await rgba(data)
    if (decoded.width !== rect.width || decoded.height !== rect.height || !decoded.data.equals(region)) {
      throw new PreparationError('verify_failed', `Slice ${rect.index} of ${filename} did not decode to the original pixels.`)
    }
    const n = String(rect.index).padStart(2, '0')
    slices.push({
      id: `s${n}`,
      file: `${stem}_slice-${n}.webp`,
      x0: 0,
      y0: rect.top,
      x1: rect.width,
      y1: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      bytes: data.length,
      sha256: sha256(data),
      mime: 'image/webp',
      data
    })
    covered += rect.height
  }
  if (covered !== original.height) throw new PreparationError('verify_failed', 'Slices do not cover the whole page.')
  return { sourceSha256: sha256(bytes), width: meta.width, height: meta.height, format: meta.format ?? 'unknown', pageStem: stem, slices, verifiedAt: new Date().toISOString() }
}

export interface HandoffIdentity {
  jobId: string
  seriesId: string
  seriesTitle: string
  chapterId: string
  chapterNumber: number
  chapterFolder: string
  filename: string
  pageIndex: number
}

/** The shared manifest stored locally and in Drive: no secrets, tokens or local paths. */
export function buildHandoff(identity: HandoffIdentity, page: PreparedPage, extra: { drive?: Record<string, unknown>; prompts?: Record<string, unknown> } = {}) {
  const sourceGeneration = sha256(JSON.stringify([identity.chapterId, identity.filename, page.sourceSha256, page.width, page.height]))
  return {
    schema: HANDOFF_SCHEMA,
    jobId: identity.jobId,
    createdAt: new Date().toISOString(),
    source: {
      seriesId: identity.seriesId,
      seriesTitle: identity.seriesTitle,
      chapterId: identity.chapterId,
      chapterNumber: identity.chapterNumber,
      chapterFolder: identity.chapterFolder,
      filename: identity.filename,
      pageStem: page.pageStem,
      pageIndex: identity.pageIndex,
      sha256: page.sourceSha256,
      width: page.width,
      height: page.height,
      format: page.format,
      orientation: 'as-stored'
    },
    generation: { sourceGeneration },
    slicing: {
      mode: 'full-width-vertical',
      sliceHeight: ANTIGRAVITY_SLICE_HEIGHT,
      encoding: 'webp-lossless',
      slices: page.slices.map(({ data: _data, ...s }) => s)
    },
    verification: { coverage: 'complete', pixels: 'identical', verifiedAt: page.verifiedAt },
    ...(extra.drive && { drive: extra.drive }),
    ...(extra.prompts && { prompts: extra.prompts })
  }
}
