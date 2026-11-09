/**
 * The images the four-step flow hands out after step 1 (port of the phone's clipper/CropRender.kt):
 * each crop cut out of the original page for step 3, and the page's slices with every crop drawn on them
 * for step 4. Rendered from the local source page (slices are lossless, unresized cuts of it, so page
 * pixels and slice pixels line up exactly).
 */

import sharp from 'sharp'
import type { Box, HandoffSlice } from './review/types.js'

/** A crop's longer side is scaled down to this; models shrink bigger images anyway. */
const MAX_SIDE = 4096
const JPEG_QUALITY = 92
const LABEL_BAND_PX = 44
const LABEL_TEXT_PX = 26

/** Box colours for the review images, picked to stand out on both light and dark artwork. */
const COLOURS = ['#FF1744', '#00E5FF', '#FFEA00', '#76FF03', '#D500F9', '#FF9100', '#2979FF', '#1DE9B6']

const escapeXml = (text: string) => text.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!)
/** Bold sans at 26 px averages about 0.62 em per character; generous so labels never clip. */
const textWidth = (text: string) => Math.ceil(text.length * LABEL_TEXT_PX * 0.62)

export interface StepImage {
  data: Buffer
  mime: 'image/jpeg'
  width: number
  height: number
}

/** One crop of [box] from [source], under a grey band carrying [key] (CropRender.crops). */
export async function renderCrop(source: Buffer, key: string, box: Box): Promise<StepImage> {
  const w0 = box.x1 - box.x0
  const h0 = box.y1 - box.y0
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0))
  const w = Math.max(1, Math.round(w0 * scale))
  const h = Math.max(1, Math.round(h0 * scale))
  const region = await sharp(source).extract({ left: box.x0, top: box.y0, width: w0, height: h0 }).resize(w, h).png().toBuffer()
  const width = Math.max(w, textWidth(key) + 24)
  const height = h + LABEL_BAND_PX
  const band = Buffer.from(
    `<svg width="${width}" height="${LABEL_BAND_PX}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="100%" height="100%" fill="#616161"/>` +
    `<text x="12" y="${LABEL_BAND_PX / 2}" dominant-baseline="central" font-family="Helvetica, Arial, sans-serif" font-weight="bold" font-size="${LABEL_TEXT_PX}" fill="#FFFFFF">${escapeXml(key)}</text>` +
    `</svg>`
  )
  const data = await sharp({ create: { width, height, channels: 3, background: '#FFFFFF' } })
    .composite([{ input: band, left: 0, top: 0 }, { input: region, left: 0, top: LABEL_BAND_PX }])
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer()
  return { data, mime: 'image/jpeg', width, height }
}

/**
 * [slice] of [source] with every one of [crops] (key, page box) that reaches it drawn as a coloured box
 * (CropReview.review). A crop is labelled with its key where it starts; a slice it runs on into gets the
 * key, with an arrow, at the top.
 */
export async function renderReviewSlice(source: Buffer, slice: HandoffSlice, crops: [string, Box][]): Promise<StepImage> {
  const x0 = slice.x0 ?? 0
  const stroke = Math.max(3, slice.width / 260)
  const half = stroke / 2
  const shapes: string[] = []
  crops.forEach(([key, box], index) => {
    if (box.y1 <= slice.y0 || box.y0 >= slice.y1) return
    const colour = COLOURS[index % COLOURS.length]
    const top = Math.max(0, box.y0 - slice.y0)
    const bottom = Math.min(slice.height, box.y1 - slice.y0)
    const left = box.x0 - x0 + half
    const right = box.x1 - x0 - half
    shapes.push(`<rect x="${left}" y="${top + half}" width="${Math.max(0, right - left)}" height="${Math.max(0, bottom - top - stroke)}" fill="none" stroke="${colour}" stroke-width="${stroke}"/>`)
    const label = box.y0 >= slice.y0 ? key : `↑ ${key}`
    const pad = 6
    const labelWidth = textWidth(label) + pad * 2
    const labelHeight = LABEL_TEXT_PX + pad * 2
    const labelLeft = Math.min(left, Math.max(0, slice.width - labelWidth))
    shapes.push(
      `<rect x="${labelLeft}" y="${top + half}" width="${labelWidth}" height="${labelHeight}" fill="${colour}"/>` +
      `<text x="${labelLeft + pad}" y="${top + half + labelHeight / 2}" dominant-baseline="central" font-family="Helvetica, Arial, sans-serif" font-weight="bold" font-size="${LABEL_TEXT_PX}" fill="#000000">${escapeXml(label)}</text>`
    )
  })
  const base = sharp(source).extract({ left: x0, top: slice.y0, width: slice.width, height: slice.height })
  const overlay = Buffer.from(`<svg width="${slice.width}" height="${slice.height}" xmlns="http://www.w3.org/2000/svg">${shapes.join('')}</svg>`)
  const data = await base.composite([{ input: overlay, left: 0, top: 0 }]).flatten({ background: '#FFFFFF' }).jpeg({ quality: JPEG_QUALITY }).toBuffer()
  return { data, mime: 'image/jpeg', width: slice.width, height: slice.height }
}

/** The step 4 image id for a slice: review-s01, review-s02, … */
export const reviewImageId = (sliceId: string) => `review-${sliceId}`
