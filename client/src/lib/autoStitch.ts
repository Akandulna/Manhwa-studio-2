/**
 * Auto stitch — re-cut a whole chapter into ~12k px pages, cutting only where
 * a row is blank so no panel is split between two pages.
 *
 * The kept pages are scaled to the widest one and joined into one strip
 * (strip px = px at that common width). The server's row profiles mark which
 * rows are flat; runs of blank rows at least MIN_GAP tall are the places a
 * cut may go. Page boundaries mean nothing here: a cut can fall inside a
 * page, which then feeds two outputs as row pieces.
 *
 * Cuts are chosen together, not page by page, so the chapter ends evenly
 * instead of with a short leftover: each page costs its squared distance from
 * the target, plus a big penalty outside the allowed range (except a short
 * last page — cutting through art to avoid one is worse), and wider gaps
 * earn a small bonus. Where no blank gap fits, the emptiest row nearby is used
 * instead and the cut is marked `forced` so the preview can flag it.
 */

export interface ProfiledPage {
  filename: string
  width: number
  height: number
}

export interface PageProfile {
  filename: string
  rows: number
  /** Base64, one byte per row: 0 = blank. */
  ink: string
}

export interface StripPage {
  filename: string
  /** Source size. */
  width: number
  height: number
  /** Where the page starts in the strip and its height there. */
  top: number
  scaledHeight: number
  ink: Uint8Array
}

export interface Strip {
  width: number
  height: number
  pages: StripPage[]
}

/** A run of blank rows, in strip px. */
export interface Band {
  top: number
  bottom: number
}

export interface Cut {
  y: number
  /**
   * `gap`: on a blank row — inside a band, or on a blank run too short to be
   * one (no `band`). `forced`: no blank row fitted, so it crosses artwork.
   */
  kind: 'gap' | 'forced'
  band?: Band
}

export interface PieceSpec {
  file: string
  top: number
  bottom: number
}

/** A band of one page's source rows inside an output page. */
export interface StripPiece {
  page: StripPage
  top: number
  bottom: number
}

export interface AutoOptions {
  target: number
  min: number
  max: number
  /** No page may be taller than this (the WebP limit). */
  hardMax: number
}

/** Shortest run of blank rows that counts as a gap. */
export const MIN_GAP = 24

/** Allowed page heights around the target: 12k → 9k–15k. */
export function autoOptions(target: number, hardMax: number): AutoOptions {
  return {
    target: Math.min(target, hardMax),
    min: Math.round(target * 0.75),
    max: Math.min(Math.round(target * 1.25), hardMax),
    hardMax
  }
}

// Planner weights, in units of "1000 px away from the target, squared".
const OUTSIDE_RANGE = 100
const FORCED_BASE = 20
const FORCED_INK = 20
/** A blank run shorter than MIN_GAP: blank, but it may be a thin line inside a panel. */
const NARROW_GAP = 8
const GAP_BONUS = 2
const GAP_BONUS_FULL = 300
/** One fallback cut candidate is kept per this many strip px. */
const FALLBACK_STEP = 400

function decode(ink: string): Uint8Array {
  const raw = atob(ink)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** Join the kept pages, in reading order, into one strip at the widest page's width. */
export function buildStrip(
  pages: ProfiledPage[],
  profiles: PageProfile[],
  excluded: ReadonlySet<string>
): Strip {
  const byName = new Map(profiles.map(p => [p.filename, p]))
  const kept = pages.filter(p => !excluded.has(p.filename))
  const width = Math.max(0, ...kept.map(p => p.width))
  let top = 0
  const stripPages = kept.map(p => {
    const profile = byName.get(p.filename)
    if (!profile) throw new Error(`No row profile for ${p.filename}`)
    const scaledHeight = Math.round((p.height * width) / p.width)
    const page = { filename: p.filename, width: p.width, height: p.height, top, scaledHeight, ink: decode(profile.ink) }
    top += scaledHeight
    return page
  })
  return { width, height: top, pages: stripPages }
}

/** Visit every profile row with its strip span. */
function eachRow(strip: Strip, visit: (top: number, bottom: number, ink: number) => void) {
  for (const page of strip.pages) {
    const rows = page.ink.length
    const step = page.scaledHeight / rows
    for (let r = 0; r < rows; r++) visit(page.top + r * step, page.top + (r + 1) * step, page.ink[r])
  }
}

/** Runs of blank rows at least `minGap` tall, joined across page boundaries. */
export function blankBands(strip: Strip, minGap = MIN_GAP): Band[] {
  const bands: Band[] = []
  let start = -1
  let end = 0
  const close = () => {
    if (start >= 0 && end - start >= minGap) bands.push({ top: Math.round(start), bottom: Math.round(end) })
    start = -1
  }
  eachRow(strip, (top, bottom, ink) => {
    if (ink === 0) {
      if (start < 0) start = top
      end = bottom
    } else {
      close()
    }
  })
  close()
  return bands
}

export function bandMiddle(band: Band): number {
  return Math.round((band.top + band.bottom) / 2)
}

interface Candidate {
  y: number
  cost: number
  cut: Cut
}

/** The emptiest row outside the bands in each FALLBACK_STEP window, for stretches with no gap. */
function fallbackCandidates(strip: Strip, bands: Band[]): Candidate[] {
  const best = new Map<number, { y: number; ink: number }>()
  let b = 0
  eachRow(strip, (top, bottom, ink) => {
    const y = Math.round((top + bottom) / 2)
    while (b < bands.length && bands[b].bottom <= y) b++
    if (b < bands.length && bands[b].top <= y) return // the band's own candidate covers it
    const slot = Math.floor(y / FALLBACK_STEP)
    const current = best.get(slot)
    if (!current || ink < current.ink) best.set(slot, { y, ink })
  })
  return [...best.values()].map(({ y, ink }) =>
    ink === 0
      ? { y, cost: NARROW_GAP, cut: { y, kind: 'gap' as const } }
      : { y, cost: FORCED_BASE + (ink / 255) * FORCED_INK, cut: { y, kind: 'forced' as const } }
  )
}

/** The last page may run short — the chapter just ends — so only its distance from the target counts. */
function pageCost(height: number, o: AutoOptions, last: boolean): number {
  let cost = ((height - o.target) / 1000) ** 2
  if (height < o.min && !last) cost += OUTSIDE_RANGE + ((o.min - height) / 500) ** 2
  if (height > o.max) cost += OUTSIDE_RANGE + ((height - o.max) / 500) ** 2
  return cost
}

/** Choose the cuts for the whole strip (see the file comment). */
export function planCuts(strip: Strip, bands: Band[], o: AutoOptions): Cut[] {
  if (strip.height <= 0) return []
  const candidates: Candidate[] = [
    ...bands.map(band => {
      const y = bandMiddle(band)
      return { y, cost: -GAP_BONUS * Math.min(1, (band.bottom - band.top) / GAP_BONUS_FULL), cut: { y, kind: 'gap' as const, band } }
    }),
    ...fallbackCandidates(strip, bands)
  ]
    .filter(c => c.y > 0 && c.y < strip.height)
    .sort((a, b) => a.y - b.y)

  // Node 0 is the strip's top, the last node its bottom.
  const nodes: { y: number; cost: number; cut?: Cut }[] = [{ y: 0, cost: 0 }, ...candidates, { y: strip.height, cost: 0 }]
  const best = new Array<number>(nodes.length).fill(Infinity)
  const from = new Array<number>(nodes.length).fill(-1)
  best[0] = 0
  for (let j = 1; j < nodes.length; j++) {
    for (let i = j - 1; i >= 0; i--) {
      const height = nodes[j].y - nodes[i].y
      if (height > o.hardMax) break
      if (height <= 0 || best[i] === Infinity) continue
      const total = best[i] + pageCost(height, o, j === nodes.length - 1) + nodes[j].cost
      if (total < best[j]) {
        best[j] = total
        from[j] = i
      }
    }
  }

  const cuts: Cut[] = []
  let at = nodes.length - 1
  if (best[at] === Infinity) return []
  while (at > 0) {
    at = from[at]
    const cut = nodes[at].cut
    if (cut) cuts.push(cut)
  }
  return cuts.reverse()
}

/** Output pages as strip ranges. */
export function segments(strip: Strip, cuts: Cut[]): Band[] {
  const ys = [0, ...cuts.map(c => c.y).sort((a, b) => a - b), strip.height]
  const out: Band[] = []
  for (let i = 1; i < ys.length; i++) if (ys[i] > ys[i - 1]) out.push({ top: ys[i - 1], bottom: ys[i] })
  return out
}

/** Strip offset within a page → source row. Both sides of a cut use this, so pieces always meet. */
function sourceRow(page: StripPage, offset: number): number {
  if (offset <= 0) return 0
  if (offset >= page.scaledHeight) return page.height
  return Math.round((offset * page.height) / page.scaledHeight)
}

/** The source-row pieces that make up strip range [top, bottom). */
export function piecesOf(strip: Strip, range: Band): StripPiece[] {
  const pieces: StripPiece[] = []
  for (const page of strip.pages) {
    const end = page.top + page.scaledHeight
    if (end <= range.top || page.top >= range.bottom) continue
    const top = sourceRow(page, range.top - page.top)
    const bottom = sourceRow(page, range.bottom - page.top)
    if (bottom > top) pieces.push({ page, top, bottom })
  }
  return pieces
}

/** The `groups` body the server stitches: whole pages by name, cut ones as row pieces. */
export function outputPieces(strip: Strip, cuts: Cut[]): (string | PieceSpec)[][] {
  return segments(strip, cuts).map(range =>
    piecesOf(strip, range).map(({ page, top, bottom }) =>
      top === 0 && bottom === page.height ? page.filename : { file: page.filename, top, bottom }
    )
  )
}
