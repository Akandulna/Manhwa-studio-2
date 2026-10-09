/**
 * Repeated intro / outro detection for Auto stitch.
 *
 * Scanlators put the same credit art (warning banners, "read at" banners,
 * the title card, end cards) at the start and end of chapters — but not
 * always in the same order or at the same offset: one chapter may have an
 * extra banner first, another a different site's banner last. So the first
 * and last ~10k px of this chapter are compared with the same end of a few
 * nearby chapters at every offset, and any block that repeats is marked.
 * The intro then runs from the top through repeated blocks and blank rows
 * until the first content that does not repeat; the outro likewise from the
 * bottom.
 *
 * Each page is shrunk to EDGE_WIDTH px wide, so edges are comparable between
 * chapters whatever their page width. The same banner is rarely pixel-equal
 * from one chapter to the next — it sits a few px higher or lower and is
 * re-encoded — so ~400 px windows are compared as blurred cell grids by
 * correlation, which ignores those differences (and brightness), while flat
 * windows, which would match anything, are skipped.
 *
 * The result is a position in this chapter's own pages (file + source row);
 * the client turns it into a cut, snapped to a blank gap or a page boundary.
 */

import sharp from 'sharp'
import fs from 'fs/promises'
import path from 'path'
import { prisma } from '../index.js'
import { getImageFiles } from './chapterManifest.js'
import { StitchPage, backupDir, chapterDir, measurePages, readRecord } from './pageStitch.js'

/** Edge images are this many px wide; px are square, so 1 px ≈ 12.5 source px of an 800-wide page. */
export const EDGE_WIDTH = 64
/** Edge rows read at each end of a chapter: ~10k px of an 800 px-wide chapter. */
const EDGE_ROWS = 800
/** Windows are compared as grids of CELL×CELL px averages — the blur that absorbs small shifts. */
const CELL = 4
/** Window height: 32 px ≈ 400 source px, a grid of 16 × 8 cells. */
const WINDOW = 32
const OWN_STEP = 4
/** Correlation above which two windows show the same art… */
const SAME_ART = 0.9
/** …as long as their cells also differ by at most this much on average (grey levels). */
const MAX_CELL_DIFF = 16
/**
 * Only windows dense with content are compared: at least this share of
 * cells differs clearly from its cell row's average. Mostly-blank windows (a
 * bubble on white) correlate with each other far too easily.
 */
const MIN_DENSE_SHARE = 0.2
const DENSE_DIFF = 12
/** A row whose darkest and lightest pixels differ by more than this has content. */
const CONTENT_RANGE = 40
/** Nearby chapters compared on each side. */
const REFERENCES_PER_SIDE = 2

/** One edge row and the source rows it covers. */
interface EdgeRow {
  file: string
  top: number
  bottom: number
}

/** The first (or last, reversed) EDGE_ROWS rows of a chapter, EDGE_WIDTH px wide. */
export interface Edge {
  data: Uint8Array
  rows: EdgeRow[]
}

export interface EdgeMatch {
  /** Intro: where the repeated art ends. Outro: where it starts. In source rows of `file`. */
  file: string
  row: number
  /** The chapter it was found in too. */
  referenceNumber: number
}

export interface IntroOutro {
  intro: EdgeMatch | null
  outro: EdgeMatch | null
}

const signatureCache = new Map<string, Uint8Array>()
const CACHE_LIMIT = 500

async function pageSignature(file: string, page: StitchPage): Promise<Uint8Array> {
  const stat = await fs.stat(file)
  const key = `${file}|${stat.size}|${stat.mtimeMs}`
  const hit = signatureCache.get(key)
  if (hit) return hit
  const rows = Math.max(1, Math.round((page.height * EDGE_WIDTH) / page.width))
  // Read into memory: libvips caches by filename, and stitching reuses names.
  const data = await sharp(await fs.readFile(file))
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize(EDGE_WIDTH, rows, { fit: 'fill' })
    .raw()
    .toBuffer()
  const signature = new Uint8Array(data.buffer, data.byteOffset, data.length)
  if (signatureCache.size >= CACHE_LIMIT) signatureCache.delete(signatureCache.keys().next().value!)
  signatureCache.set(key, signature)
  return signature
}

/** Edge rows from the top of the chapter down, or (`fromEnd`) from the bottom up. */
export async function readEdge(dir: string, pages: StitchPage[], fromEnd: boolean): Promise<Edge> {
  const data = new Uint8Array(EDGE_ROWS * EDGE_WIDTH)
  const rows: EdgeRow[] = []
  for (const page of fromEnd ? [...pages].reverse() : pages) {
    if (rows.length >= EDGE_ROWS) break
    const signature = await pageSignature(path.join(dir, page.filename), page)
    const count = signature.length / EDGE_WIDTH
    for (let k = 0; k < count && rows.length < EDGE_ROWS; k++) {
      const r = fromEnd ? count - 1 - k : k
      data.set(signature.subarray(r * EDGE_WIDTH, (r + 1) * EDGE_WIDTH), rows.length * EDGE_WIDTH)
      rows.push({
        file: page.filename,
        top: Math.round((r * page.height) / count),
        bottom: Math.round(((r + 1) * page.height) / count)
      })
    }
  }
  return { data: data.subarray(0, rows.length * EDGE_WIDTH), rows }
}

export function rowHasContent(edge: Edge, i: number): boolean {
  let min = 255
  let max = 0
  for (let c = 0; c < EDGE_WIDTH; c++) {
    const v = edge.data[i * EDGE_WIDTH + c]
    if (v < min) min = v
    if (v > max) max = v
  }
  return max - min > CONTENT_RANGE
}

const CELLS_X = EDGE_WIDTH / CELL
const CELLS_Y = WINDOW / CELL
const CELLS = CELLS_X * CELLS_Y

interface Window {
  /** Cell averages. */
  raw: Float32Array
  /**
   * Cells minus their cell row's average, scaled to unit length: a dot
   * product of two is their correlation. Removing row averages drops the
   * light/dark bands every panel edge makes, which would otherwise match
   * between any two chapters; what is left is the text and drawing.
   */
  unit: Float32Array
}

/** Every window of `edge` starting at multiples of `step`, or null where it is too sparse to compare. */
function windows(edge: Edge, step: number): (Window | null)[] {
  const n = edge.rows.length
  // Column sums of CELL-px-wide strips per row, then a running sum down the rows.
  const strip = new Float64Array((n + 1) * CELLS_X)
  for (let r = 0; r < n; r++) {
    for (let cx = 0; cx < CELLS_X; cx++) {
      let sum = 0
      for (let c = cx * CELL; c < (cx + 1) * CELL; c++) sum += edge.data[r * EDGE_WIDTH + c]
      strip[(r + 1) * CELLS_X + cx] = strip[r * CELLS_X + cx] + sum
    }
  }
  const out: (Window | null)[] = []
  for (let top = 0; top + WINDOW <= n; top += step) {
    const raw = new Float32Array(CELLS)
    for (let cy = 0; cy < CELLS_Y; cy++) {
      const a = top + cy * CELL
      for (let cx = 0; cx < CELLS_X; cx++) {
        raw[cy * CELLS_X + cx] = (strip[(a + CELL) * CELLS_X + cx] - strip[a * CELLS_X + cx]) / (CELL * CELL)
      }
    }
    const unit = new Float32Array(CELLS)
    for (let cy = 0; cy < CELLS_Y; cy++) {
      let mean = 0
      for (let cx = 0; cx < CELLS_X; cx++) mean += raw[cy * CELLS_X + cx]
      mean /= CELLS_X
      for (let cx = 0; cx < CELLS_X; cx++) unit[cy * CELLS_X + cx] = raw[cy * CELLS_X + cx] - mean
    }
    let dense = 0
    let norm = 0
    for (let k = 0; k < CELLS; k++) {
      if (Math.abs(unit[k]) > DENSE_DIFF) dense++
      norm += unit[k] * unit[k]
    }
    if (dense < CELLS * MIN_DENSE_SHARE) {
      out.push(null)
      continue
    }
    const scale = 1 / Math.sqrt(norm)
    for (let k = 0; k < CELLS; k++) unit[k] *= scale
    out.push({ raw, unit })
  }
  return out
}

/** Mark the rows of `own` covered by a window that also appears somewhere in `ref`, at any offset. */
export function markRepeated(own: Edge, ref: Edge, repeated: boolean[]): void {
  const theirs = windows(ref, 1).filter((w): w is Window => w !== null)
  if (theirs.length === 0) return
  windows(own, OWN_STEP).forEach((mine, k) => {
    if (!mine) return
    const top = k * OWN_STEP
    for (const other of theirs) {
      let dot = 0
      for (let i = 0; i < CELLS; i++) dot += mine.unit[i] * other.unit[i]
      if (dot < SAME_ART) continue
      let diff = 0
      for (let i = 0; i < CELLS; i++) diff += Math.abs(mine.raw[i] - other.raw[i])
      if (diff <= MAX_CELL_DIFF * CELLS) {
        for (let r = top; r < top + WINDOW; r++) repeated[r] = true
        return
      }
    }
  })
}

/**
 * Rows from the edge that are repeated art or blank, up to the first content
 * row that is not repeated; returns how many rows end at the last repeated one.
 */
export function edgeRun(content: boolean[], repeated: boolean[]): number {
  let end = 0
  for (let i = 0; i < content.length; i++) {
    if (repeated[i]) end = i + 1
    else if (content[i]) break
  }
  return end
}

interface ChapterRef {
  id: string
  seriesId: string
  number: number
  folderPath: string
}

/** A chapter's pages as they came from the source: the backed-up originals if it was stitched. */
async function originalPages(chapter: { folderPath: string }): Promise<{ dir: string; pages: StitchPage[] }> {
  const record = await readRecord(chapter.folderPath)
  const dir = record ? backupDir(chapter.folderPath) : chapterDir(chapter.folderPath)
  const names = record ? record.originals : await getImageFiles(dir)
  return { dir, pages: await measurePages(dir, names) }
}

export async function detectIntroOutro(chapter: ChapterRef, pages: StitchPage[]): Promise<IntroOutro> {
  const select = { id: true, number: true, folderPath: true }
  const [before, after] = await Promise.all([
    prisma.chapter.findMany({
      where: { seriesId: chapter.seriesId, status: 'done', number: { lt: chapter.number } },
      orderBy: { number: 'desc' },
      take: REFERENCES_PER_SIDE,
      select
    }),
    prisma.chapter.findMany({
      where: { seriesId: chapter.seriesId, status: 'done', number: { gt: chapter.number } },
      orderBy: { number: 'asc' },
      take: REFERENCES_PER_SIDE,
      select
    })
  ])
  if (before.length + after.length === 0 || pages.length === 0) return { intro: null, outro: null }

  const dir = chapterDir(chapter.folderPath)
  const ends = [await readEdge(dir, pages, false), await readEdge(dir, pages, true)]
  const content = ends.map(edge => edge.rows.map((_, i) => rowHasContent(edge, i)))
  const repeated = ends.map(edge => edge.rows.map(() => false))
  // Remember which chapter first explained each end, for the label in the preview.
  const found: (number | null)[] = [null, null]

  // Each nearby chapter can add blocks: one may share the warning banner, another the end card.
  for (const ref of [before[0], after[0], before[1], after[1]].filter(Boolean)) {
    try {
      const source = await originalPages(ref)
      if (source.pages.length === 0) continue
      for (const side of [0, 1]) {
        const had = edgeRun(content[side], repeated[side])
        markRepeated(ends[side], await readEdge(source.dir, source.pages, side === 1), repeated[side])
        if (found[side] === null && edgeRun(content[side], repeated[side]) > had) found[side] = ref.number
      }
    } catch (error) {
      console.warn(`[stitch] intro/outro: could not read chapter ${ref.number}:`, error)
    }
  }

  const [intro, outro] = [0, 1].map(side => {
    const rows = edgeRun(content[side], repeated[side])
    // Nothing found, or the whole window is repeated (no end in sight): leave it alone.
    if (rows === 0 || rows >= ends[side].rows.length) return null
    const last = ends[side].rows[rows - 1]
    return { file: last.file, row: side === 0 ? last.bottom : last.top, referenceNumber: found[side]! }
  })
  return { intro, outro }
}
