/**
 * Row profiles for Auto stitch — where a chapter's pages can be cut without
 * touching artwork.
 *
 * Each page is shrunk to a fixed width in greyscale and every row gets an
 * "ink" score: the share of its pixels that differ from the row's most common
 * value by more than a small tolerance. A row scoring 0 is flat from left to
 * right — a gutter of any colour, or one line of a vertical gradient — so a
 * cut there touches nothing. Text, bubbles, SFX and artwork all score above 0.
 *
 * The client joins the profiles of the pages it keeps into one strip, finds
 * runs of blank rows and picks the cuts (see client lib/autoStitch.ts). Doing
 * only the pixel work here keeps re-planning instant when the user changes
 * the target height or drops a page.
 */

import sharp from 'sharp'
import fs from 'fs/promises'
import path from 'path'
import type { StitchPage } from './pageStitch.js'

/** Width pages are shrunk to before measuring; rows shrink by the same factor. */
export const PROFILE_WIDTH = 320

/** A pixel this close to the row's most common grey value counts as background. */
const TOLERANCE = 10

/** Columns skipped at each side: some sources leave a 1–2 px border artefact. */
const EDGE_SKIP = 4

export interface PageProfile {
  filename: string
  /** Rows in `ink`; row r covers source rows [r·h/rows, (r+1)·h/rows). */
  rows: number
  /** Base64 of one byte per row: 0 = blank, 255 = every pixel off the background. */
  ink: string
}

// Profiles depend only on the file's pixels, so cache them by file identity.
const cache = new Map<string, PageProfile>()
const CACHE_LIMIT = 2000

async function profilePage(file: string, page: StitchPage): Promise<PageProfile> {
  const stat = await fs.stat(file)
  const key = `${file}|${stat.size}|${stat.mtimeMs}`
  const hit = cache.get(key)
  if (hit) return hit

  const rows = Math.max(1, Math.round((page.height * PROFILE_WIDTH) / page.width))
  // Read into memory: libvips caches by filename, and stitching reuses names.
  const { data } = await sharp(await fs.readFile(file))
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize(PROFILE_WIDTH, rows, { fit: 'fill', kernel: 'linear' })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const ink = Buffer.alloc(rows)
  const histogram = new Uint32Array(256)
  const from = EDGE_SKIP
  const to = PROFILE_WIDTH - EDGE_SKIP
  for (let r = 0; r < rows; r++) {
    const base = r * PROFILE_WIDTH
    histogram.fill(0)
    for (let c = from; c < to; c++) histogram[data[base + c]]++
    let mode = 0
    for (let v = 1; v < 256; v++) if (histogram[v] > histogram[mode]) mode = v
    let off = 0
    for (let c = from; c < to; c++) if (Math.abs(data[base + c] - mode) > TOLERANCE) off++
    // Any off pixel at all must stay above 0, so only truly flat rows read as blank.
    ink[r] = off === 0 ? 0 : Math.max(1, Math.round((off * 255) / (to - from)))
  }

  const profile = { filename: page.filename, rows, ink: ink.toString('base64') }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  cache.set(key, profile)
  return profile
}

export async function profilePages(dir: string, pages: StitchPage[]): Promise<PageProfile[]> {
  const profiles: PageProfile[] = []
  for (const page of pages) profiles.push(await profilePage(path.join(dir, page.filename), page))
  return profiles
}
