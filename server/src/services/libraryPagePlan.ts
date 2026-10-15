/**
 * Server-side copy of client/src/lib/autoStitch.ts; keep the planning rules in step.
 *
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

/** Choose the cuts for strip range `range` (default: all of it; see the file comment). */
export function planCuts(
  strip: Strip,
  bands: Band[],
  o: AutoOptions,
  range: Band = { top: 0, bottom: strip.height }
): Cut[] {
  if (range.bottom - range.top <= 0) return []
  const candidates: Candidate[] = [
    ...bands.map(band => {
      const y = bandMiddle(band)
      return { y, cost: -GAP_BONUS * Math.min(1, (band.bottom - band.top) / GAP_BONUS_FULL), cut: { y, kind: 'gap' as const, band } }
    }),
    ...fallbackCandidates(strip, bands)
  ]
    .filter(c => c.y > range.top && c.y < range.bottom)
    .sort((a, b) => a.y - b.y)

  // Node 0 is the strip's top, the last node its bottom.
  const nodes: { y: number; cost: number; cut?: Cut }[] = [
    { y: range.top, cost: 0 },
    ...candidates,
    { y: range.bottom, cost: 0 }
  ]
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

/** The `groups` body the server stitches: whole pages by name, cut ones as row pieces. Dropped pages are left out. */
export function outputPieces(strip: Strip, cuts: Cut[], dropped: Dropped[] = []): (string | PieceSpec)[][] {
  const gone = new Set(dropped.map(d => d.y))
  return segments(strip, cuts)
    .filter(range => !gone.has(range.top))
    .map(range =>
      piecesOf(strip, range).map(({ page, top, bottom }) =>
        top === 0 && bottom === page.height ? page.filename : { file: page.filename, top, bottom }
      )
    )
}

// ============ Dropped pages and repeated intro / outro ============

/** An output page left out of the stitch, named by the strip y it starts at. */
export interface Dropped {
  y: number
  /** Shown on the page; empty when the user deleted it by hand. */
  reason: string
}

/** Where the server found repeated art: intro ends / outro starts at `row` of `file`. */
export interface EdgeMark {
  file: string
  row: number
  referenceNumber: number
}

export interface EdgeMarks {
  intro: EdgeMark | null
  outro: EdgeMark | null
}

/** A repeated intro/outro is only cut off at a page boundary or blank gap this close to where it ends. */
const EDGE_SNAP = 200

function stripY(strip: Strip, mark: EdgeMark): number | null {
  const page = strip.pages.find(p => p.filename === mark.file)
  return page ? page.top + Math.round((mark.row * page.scaledHeight) / page.height) : null
}

/**
 * The cut that separates repeated art ending (or starting) near `y`: a page
 * boundary if one is close — scanlators usually add their art as separate
 * images — else the nearest blank gap. Never a cut through artwork: with
 * neither nearby, nothing is dropped and the user can delete it by hand.
 */
export function edgeCut(strip: Strip, bands: Band[], y: number): Cut | null {
  const near = (at: number) => Math.abs(at - y) <= EDGE_SNAP
  const boundaries = strip.pages.slice(1).map(p => p.top).filter(near)
  if (boundaries.length > 0) {
    const at = boundaries.reduce((a, b) => (Math.abs(b - y) < Math.abs(a - y) ? b : a))
    return { y: at, kind: 'gap' }
  }
  const gaps = bands.filter(b => near(bandMiddle(b)) || (b.top <= y && b.bottom >= y))
  if (gaps.length === 0) return null
  const band = gaps.reduce((a, b) => (Math.abs(bandMiddle(b) - y) < Math.abs(bandMiddle(a) - y) ? b : a))
  return { y: bandMiddle(band), kind: 'gap', band }
}

/**
 * Plan the whole chapter: cut off the repeated intro and outro (when found
 * and `edges` is given) as dropped pages, and plan the cuts between them.
 */
export function planChapter(
  strip: Strip,
  bands: Band[],
  o: AutoOptions,
  edges: EdgeMarks | null
): { cuts: Cut[]; dropped: Dropped[] } {
  let top = 0
  let bottom = strip.height
  const cuts: Cut[] = []
  const dropped: Dropped[] = []

  const introY = edges?.intro ? stripY(strip, edges.intro) : null
  const intro = introY !== null ? edgeCut(strip, bands, introY) : null
  if (intro && intro.y > 0 && intro.y < bottom) {
    top = intro.y
    cuts.push(intro)
    dropped.push({ y: 0, reason: `Intro — repeats Ch ${edges!.intro!.referenceNumber}` })
  }

  const outroY = edges?.outro ? stripY(strip, edges.outro) : null
  const outro = outroY !== null ? edgeCut(strip, bands, outroY) : null
  // Leave at least a page of story between them.
  if (outro && outro.y > top + o.min && outro.y < bottom) {
    bottom = outro.y
    dropped.push({ y: outro.y, reason: `Outro — repeats Ch ${edges!.outro!.referenceNumber}` })
  }

  cuts.push(...planCuts(strip, bands, o, { top, bottom }))
  if (bottom < strip.height) cuts.push(outro!)
  return { cuts, dropped }
}

/** Remove the cut at `y`. The two pages it separated merge, and stay dropped only if both were. */
export function withoutCut(cuts: Cut[], dropped: Dropped[], y: number): { cuts: Cut[]; dropped: Dropped[] } {
  const above = Math.max(0, ...cuts.filter(c => c.y < y).map(c => c.y))
  const belowDropped = dropped.some(d => d.y === y)
  return {
    cuts: cuts.filter(c => c.y !== y),
    dropped: dropped.filter(d => d.y !== y && (d.y !== above || belowDropped))
  }
}

/** Add a cut. Splitting a dropped page leaves both halves dropped. */
export function withCut(cuts: Cut[], dropped: Dropped[], cut: Cut): { cuts: Cut[]; dropped: Dropped[] } {
  if (cuts.some(c => c.y === cut.y)) return { cuts, dropped }
  const top = Math.max(0, ...cuts.filter(c => c.y < cut.y).map(c => c.y))
  const parent = dropped.find(d => d.y === top)
  return {
    cuts: [...cuts, cut].sort((a, b) => a.y - b.y),
    dropped: parent ? [...dropped, { y: cut.y, reason: parent.reason }] : dropped
  }
}

/** Delete or restore the page starting at `y`. */
export function toggleDropped(dropped: Dropped[], y: number): Dropped[] {
  return dropped.some(d => d.y === y) ? dropped.filter(d => d.y !== y) : [...dropped, { y, reason: '' }]
}
