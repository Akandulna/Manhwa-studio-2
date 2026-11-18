/**
 * AntiGravity → Narration: a chapter's pages as labelled pieces that agy shows at full size.
 *
 * agy scales every image it shows the model to at most 2,000 px a side (its changelog; 354 stored images checked on
 * 2026-11-11). A whole stitched page (709 × ~12,000 px) would reach the model about 118 px wide, with unreadable
 * speech bubbles and check codes. So each page is cut, top to bottom, into pieces whose height plus the label band
 * stays within AGY_MAX_SIDE, at blank rows where it can (a bubble is never split when a gutter is in reach); a page
 * wider than AGY_MAX_SIDE is first scaled down to that width. Every piece gets a white band on top:
 * "<ID> · CHECK <CODE>". The code is random per attempt and never written in a prompt, so the model can only report
 * it by looking at that piece. Source page files are never changed.
 *
 * Sleeper-Cell cuts its AI Studio uploads to ~2,000 px pieces as well (PageFit.kt, beta 1.0.231).
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

/** How pages are prepared now. A new attempt takes over an earlier attempt's notes only when this matches. */
export const PREPARATION = 'agy-pieces-2000/1'
/** The longest side agy shows the model without scaling. */
export const AGY_MAX_SIDE = 2000
/** A row is blank when its brightness varies by no more than this (0–255). */
const BLANK_RANGE = 12
/** Blank runs shorter than this are a gap between lines of art, not between panels. */
const MIN_GAP = 8
/** Rows are scanned on a copy this many times narrower and shorter. */
const SCAN_SAMPLE = 4

/** Letters and digits that can't be mistaken for each other when read off an image (as the phone). */
const CHECK_ALPHABET = 'ACDEFHJKLMNPRTUVWXY34679'
export function checkCode(random: () => number = () => crypto.randomInt(0, 1 << 30) / (1 << 30)): string {
  let code = ''
  for (let i = 0; i < 4; i++) code += CHECK_ALPHABET[Math.floor(random() * CHECK_ALPHABET.length)]
  return code
}

export const pieceId = (page: number, part: number) => `P${String(page).padStart(4, '0')}-T${String(part).padStart(3, '0')}`

export interface Piece {
  id: string
  page: number
  part: number
  parts: number
  /** The page's file name in the chapter folder. */
  source: string
  /** Source rows [top, bottom). */
  top: number
  bottom: number
  check: string
  /** The labelled JPEG. */
  file: string
  width: number
  height: number
}

export const bandHeight = (width: number) => Math.min(160, Math.max(48, Math.round(width * 0.09)))

/** Piece heights (art rows, band excluded) for a page [width] px wide: at most `max`, aiming for `target`. */
export function pieceSizes(width: number, maxSide = AGY_MAX_SIDE) {
  const max = maxSide - bandHeight(width)
  return { target: Math.round(max * 0.9), max, min: Math.floor(max * 0.45), minGap: MIN_GAP }
}

/**
 * The rows [0, height) cut into pieces at blank rows where it can. Each piece is at most `max` rows and at least
 * `min` (the last one too), unless the page is shorter. A cut goes in the middle of the blank run nearest `target`
 * that is at least `minGap` rows; failing that, the longest blank run in reach; failing that, straight at `target`.
 */
export function blankCuts(height: number, blank: (y: number) => boolean, opts: { target: number; max: number; min: number; minGap: number }): [number, number][] {
  const { target, max, min, minGap } = opts
  if (!(min >= 1 && min <= target && target <= max && 2 * min <= max)) throw new Error('Invalid piece sizes.')
  const pieces: [number, number][] = []
  let start = 0
  while (height - start > max) {
    const low = start + min
    const high = Math.min(start + max, height - min)
    const runs: [number, number][] = []
    for (let y = low; y <= high;) {
      if (!blank(y)) { y++; continue }
      const first = y
      while (y <= high && blank(y)) y++
      runs.push([first, y])
    }
    const aim = start + target
    const middle = (r: [number, number]) => Math.floor((r[0] + r[1] - 1) / 2)
    const wide = runs.filter(r => r[1] - r[0] >= minGap)
    const chosen = wide.length
      ? wide.reduce((a, b) => (Math.abs(middle(b) - aim) < Math.abs(middle(a) - aim) ? b : a))
      : runs.length ? runs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a)) : null
    const cut = chosen ? Math.floor((chosen[0] + chosen[1]) / 2) : Math.min(Math.max(aim, low), high)
    pieces.push([start, cut])
    start = cut
  }
  pieces.push([start, height])
  return pieces
}

/** For each row of [image] (height rows), whether it is one flat colour. */
async function blankRows(image: Buffer | string, width: number, height: number): Promise<(y: number) => boolean> {
  const w = Math.max(1, Math.round(width / SCAN_SAMPLE))
  const h = Math.max(1, Math.round(height / SCAN_SAMPLE))
  const { data } = await sharp(image).resize(w, h, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true })
  const blank = new Array<boolean>(h)
  for (let y = 0; y < h; y++) {
    let lo = 255, hi = 0
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    blank[y] = hi - lo <= BLANK_RANGE
  }
  return y => blank[Math.min(h - 1, Math.max(0, Math.floor(y * h / height)))]
}

const escapeXml = (s: string) => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)

/** A white band [width] wide with [text] in bold black, and a black rule under it. */
export function bandSvg(width: number, text: string): { svg: Buffer; height: number } {
  const height = bandHeight(width)
  // Monospace glyphs are about 0.6 em wide.
  const size = Math.max(10, Math.min(Math.round(height * 0.55), Math.floor(width * 0.94 / (text.length * 0.6))))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="100%" height="100%" fill="#ffffff"/>`
    + `<rect y="${height - 3}" width="100%" height="3" fill="#000000"/>`
    + `<text x="50%" y="${Math.round(height / 2)}" dominant-baseline="central" text-anchor="middle" font-family="Menlo, DejaVu Sans Mono, Courier New, monospace" font-weight="bold" font-size="${size}" fill="#000000">${escapeXml(text)}</text>`
    + '</svg>'
  return { svg: Buffer.from(svg), height }
}

/**
 * Cuts [pages] (in chapter order) into labelled pieces written to [outDir], each at most [maxSide] px a side with
 * its band. Page numbers are the pages' positions, from 1. [code] makes each piece's check code (tests pass a fixed one);
 * null labels pieces with their id alone (the manual copy-paste prompts, which never ask for a code).
 */
export async function prepareChapterPages(pages: { file: string; source: string }[], outDir: string, code: (() => string) | null = () => checkCode(), maxSide = AGY_MAX_SIDE): Promise<Piece[]> {
  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(outDir, { recursive: true })
  const pieces: Piece[] = []
  for (const [index, page] of pages.entries()) {
    const number = index + 1
    const meta = await sharp(page.file).metadata()
    if (!meta.width || !meta.height) throw new Error(`${page.source} can't be read as an image.`)
    // A page wider than agy shows is scaled down as a whole first; rows are then cut on the scaled page.
    const scale = meta.width > maxSide ? maxSide / meta.width : 1
    const width = Math.round(meta.width * scale)
    const height = Math.max(1, Math.round(meta.height * scale))
    const image: Buffer | string = scale < 1 ? await sharp(page.file).resize(width, height, { fit: 'fill' }).png().toBuffer() : page.file
    const sizes = pieceSizes(width, maxSide)
    const rows = height <= sizes.max ? [[0, height] as [number, number]] : blankCuts(height, await blankRows(image, width, height), sizes)
    for (const [i, [top, bottom]] of rows.entries()) {
      const id = pieceId(number, i + 1)
      const check = code ? code() : ''
      const art = await sharp(image).extract({ left: 0, top, width, height: bottom - top }).png().toBuffer()
      const band = bandSvg(width, check ? `${id} · CHECK ${check}` : id)
      const file = path.join(outDir, `${id}.jpg`)
      await sharp({ create: { width, height: band.height + bottom - top, channels: 3, background: '#ffffff' } })
        .composite([{ input: band.svg, top: 0, left: 0 }, { input: art, top: band.height, left: 0 }])
        .jpeg({ quality: 90 }).toFile(file)
      pieces.push({
        id, page: number, part: i + 1, parts: rows.length, source: page.source,
        top: Math.round(top / scale), bottom: Math.min(meta.height, Math.round(bottom / scale)),
        check, file, width, height: band.height + bottom - top
      })
    }
  }
  return pieces
}
