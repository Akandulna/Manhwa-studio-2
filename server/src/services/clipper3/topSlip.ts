/**
 * Image Clipper 3.0 — crops whose top edge sits one step above their panel.
 *
 * Some clipping models (Codex gpt-6.1-terra at low effort most of all, and the
 * phones' ChatGPT now and then) report a crop's top almost exactly 256 px — or
 * 512 px — higher than the panel really starts, with every other edge right.
 * The crop then takes in the gutter, a speech bubble or the tail of the panel
 * above. Fixing those by hand was most of the work in Preview.
 *
 * This finds them so Preview can offer "Move top here". It only ever
 * suggests: pointers are never changed here.
 *
 * A top is suggested when all of these hold, measured across the crop's own
 * width on the page's luminance:
 *
 *   - no panel border runs along the current top (few columns change sharply
 *     across it, and the art just above looks like the art just below);
 *   - a border does run along a row 256 px (or 512 px) lower, give or take
 *     SEARCH_PX — the suggestion is that exact row, not the round number;
 *   - the strip between the two is mostly background, as gutter and bubbles are.
 *
 * The thresholds were fitted on 4,063 Studio-made crops against the tops the
 * user had already corrected by hand (2026-11-15): 175 of 206 corrected slips
 * found, each within 26 px of the hand-placed top, and 1 suggestion on 1,509
 * crops from engines that do not slip. Change them only against data like that.
 */

import path from 'path'
import sharp from 'sharp'
import { rowInkShare } from '../antigravity/review/cropAudit.js'
import type { LumaPage } from '../antigravity/review/types.js'
import { extractCrops, getSourceFolderPath, readImagePoints, type Clipper3CropEntry } from './perImageStore.js'

/** The model's slip, in page pixels: one step, or two. */
export const SLIP_STEPS_PX = [256, 512] as const
/** A slipped top is this close to a whole step above the panel. */
export const SEARCH_PX = 26
/** A row is "at" the current top within this many pixels. */
export const AT_TOP_PX = 10
/** A column changes sharply across a row when the luminance 2 px either side differs by more than this. */
export const STEP_LUMA = 35
/** The current top already lies on a border when this share of columns changes sharply across it. */
export const BORDER_AT_TOP = 0.5
/** The proposed top needs at least this share. */
export const BORDER_AT_SUGGESTION = 0.45
/** Rows beside the strongest one belong to the same border while they keep this share of its strength. */
export const BORDER_RUN = 0.9
/** The art within COMPARE_PX above and below the current top: under this distance (0–1) it is the same stretch. */
export const SAME_ACROSS_TOP = 0.3
export const COMPARE_PX = 100
/** The strip to be cut off is background when its rows average at most this ink share. */
export const STRIP_INK = 0.3
/** Never suggest a top that would leave less of the crop than this. */
export const MIN_REMAINING_PX = 60

const HISTOGRAM_BINS = 32

export interface PixelBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Share of the columns in [x0, x1) whose luminance changes sharply across row y. */
export function borderShare(page: LumaPage, y: number, x0: number, x1: number): number {
  if (y < 2 || y >= page.height - 2 || x1 <= x0) return 0
  const above = (y - 2) * page.width
  const below = (y + 2) * page.width
  let sharp = 0
  for (let x = x0; x < x1; x++) {
    if (Math.abs(page.data[below + x]! - page.data[above + x]!) > STEP_LUMA) sharp++
  }
  return sharp / (x1 - x0)
}

/** How different rows [y0, y) and [y, y1) look across [x0, x1): 0 the same, 1 nothing shared. */
function distanceAcross(page: LumaPage, y0: number, y: number, y1: number, x0: number, x1: number): number {
  y0 = Math.max(0, y0)
  y1 = Math.min(page.height, y1)
  if (y <= y0 || y1 <= y) return 1
  const upper = new Float64Array(HISTOGRAM_BINS)
  const lower = new Float64Array(HISTOGRAM_BINS)
  for (let row = y0; row < y1; row++) {
    const hist = row < y ? upper : lower
    const offset = row * page.width
    for (let x = x0; x < x1; x++) hist[page.data[offset + x]! >> 3]!++
  }
  const upperCount = (y - y0) * (x1 - x0)
  const lowerCount = (y1 - y) * (x1 - x0)
  let sum = 0
  for (let i = 0; i < HISTOGRAM_BINS; i++) sum += Math.abs(upper[i]! / upperCount - lower[i]! / lowerCount)
  return sum / 2
}

/**
 * The row this crop's top should move down to, or null when the top looks
 * right (or wrong in some way other than a whole-step slip).
 */
export function suggestedTop(page: LumaPage, box: PixelBox): number | null {
  const x0 = Math.max(0, box.x0)
  const x1 = Math.min(page.width, box.x1)
  const top = box.y0
  if (x1 - x0 < 8 || top < 0) return null

  for (let y = top - AT_TOP_PX; y <= top + AT_TOP_PX; y++) {
    if (borderShare(page, y, x0, x1) >= BORDER_AT_TOP) return null
  }
  if (distanceAcross(page, top - COMPARE_PX, top, top + COMPARE_PX, x0, x1) >= SAME_ACROSS_TOP) return null

  for (const step of SLIP_STEPS_PX) {
    const first = top + step - SEARCH_PX
    const shares: number[] = []
    for (let y = first; y <= top + step + SEARCH_PX; y++) shares.push(borderShare(page, y, x0, x1))
    const share = Math.max(...shares)
    if (share < BORDER_AT_SUGGESTION) continue
    // A border shows on the few rows either side of it (borderShare looks 2 px
    // each way), so the panel starts at the middle of that run, not its edge.
    let from = shares.indexOf(share)
    let to = from
    while (from > 0 && shares[from - 1]! >= share * BORDER_RUN) from--
    while (to < shares.length - 1 && shares[to + 1]! >= share * BORDER_RUN) to++
    const row = first + Math.ceil((from + to) / 2)
    if (row >= box.y1 - MIN_REMAINING_PX) continue

    let ink = 0
    for (let y = top; y < row; y++) ink += rowInkShare(page, y, x0, x1)
    if (ink / (row - top) > STRIP_INK) continue
    return row
  }
  return null
}

/** What Preview draws: which crop, where its top is now, and where it should go. Normalized like the pointers. */
export interface TopSuggestion {
  cropId: string
  top: number
  left: number
  suggestedTop: number
  movePx: number
}

/** The crop's bounding box as its four points give it, normalized. */
function normalizedBounds(entry: Clipper3CropEntry): { left: number; top: number; right: number; bottom: number } {
  const xs = entry.crop.points.map(p => p.x)
  const ys = entry.crop.points.map(p => p.y)
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }
}

/** Suggestions for one decoded page and its crops. */
export function topSuggestions(page: LumaPage, crops: Clipper3CropEntry[]): TopSuggestion[] {
  const out: TopSuggestion[] = []
  for (const entry of crops) {
    const bounds = normalizedBounds(entry)
    const box: PixelBox = {
      x0: Math.round(bounds.left * page.width),
      y0: Math.round(bounds.top * page.height),
      x1: Math.round(bounds.right * page.width),
      y1: Math.round(bounds.bottom * page.height)
    }
    const row = suggestedTop(page, box)
    if (row == null) continue
    out.push({ cropId: entry.id, top: bounds.top, left: bounds.left, suggestedTop: row / page.height, movePx: row - box.y0 })
  }
  return out
}

/**
 * One page as 8-bit luminance. Decoded by sharp off the main thread — a
 * chapter is twenty-odd pages of ten megapixels each, and Preview asks for
 * all of them at once.
 */
export async function pageLuma(file: string): Promise<LumaPage> {
  const { data, info } = await sharp(file).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true })
  if (info.channels !== 1) throw new Error(`Expected one luminance channel, got ${info.channels}`)
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) }
}

/** Pages decoded at once: each is a whole page in memory. */
const PAGES_AT_ONCE = 3

/**
 * Suggestions for every page of a chapter that has pointers, keyed by image
 * filename; pages with none are left out. A page that cannot be read is
 * skipped — suggestions are a convenience, never a reason to fail a preview.
 */
export async function chapterTopSuggestions(folderPath: string, filenames: string[]): Promise<Record<string, TopSuggestion[]>> {
  const pages: Record<string, TopSuggestion[]> = {}
  const queue = [...filenames]
  const worker = async () => {
    for (let filename = queue.shift(); filename !== undefined; filename = queue.shift()) {
      try {
        const stored = await readImagePoints(folderPath, filename)
        const crops = extractCrops(stored?.file ?? null)
        if (crops.length === 0) continue
        const page = await pageLuma(path.join(getSourceFolderPath(folderPath), path.basename(filename)))
        const found = topSuggestions(page, crops)
        if (found.length > 0) pages[filename] = found
      } catch (error) {
        console.warn(`[clipper3] top check skipped for ${filename}:`, error instanceof Error ? error.message : error)
      }
    }
  }
  await Promise.all(Array.from({ length: PAGES_AT_ONCE }, worker))
  return pages
}
