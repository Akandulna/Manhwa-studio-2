/**
 * Port of the phone's CropAudit.kt: the deterministic checks run on a page's crops. Every finding is a
 * pointer for ChatGPT's review round, never an action. Geometry is pure; the pixel checks ask whether the
 * artwork seems to run on past an edge, how much of a crop is flat colour, and how much ink an uncovered
 * stretch holds. Constants are the phone's.
 */
import sharp from 'sharp'
import { auditFinding, boxHeight, boxWidth, type AuditFinding, type AuditReport, type Box, type LumaPage, type UncoveredGap } from './types.js'

export const TALL_RATIO = 2.0
export const PAGE_FRACTION_LIMIT = 0.2
export const OUTLIER_FACTOR = 2.5
export const OUTLIER_MIN_OTHERS = 2
export const DUPLICATE_IOU = 0.9
export const OVERLAP_IOU = 0.3
export const CONTAINMENT_SHARE = 0.6
export const TINY_SIDE_PX = 48
export const SLIVER_RATIO = 12
/** Crops whose facing edges are at most this far apart meet with no gutter between them. */
export const SHARED_EDGE_PX = 8
/** Facing edges must overlap by this share of the shorter one to count as shared. */
export const SHARED_EDGE_OVERLAP = 0.5
/** Uncovered stretches shorter than this are ordinary gutters. */
export const MIN_GAP_PX = 200
export const EDGE_BAND_PX = 6
/** Calibrated on real pages: correct edges sit under ~0.2, edges cut through artwork score 0.55+. */
export const EDGE_INK_SHARE = 0.35
/** Lines on each side of an inked edge whose luminance histograms are compared. */
export const EDGE_COMPARE_PX = 24
/** An inked edge is flagged only when the strip outside looks like the strip inside (histogram distance below this). */
export const EDGE_SAME_ART_DISTANCE = 0.35
/** Share of a crop's rows that are flat colour at which it's flagged MOSTLY_BLANK. */
export const MOSTLY_BLANK_SHARE = 0.4
/** Mean row ink share at which an uncovered stretch may hold artwork. */
export const GAP_ARTWORK_INK = 0.2
/** Words in a crop's reason that name filler rather than a shot. */
export const FILLER_REASON_WORDS = [
  'transition', 'transitions', 'narration', 'caption', 'captions', 'credit', 'credits', 'lettering',
  'sfx', 'onomatopoeia', 'bubble', 'bubbles', 'speech', 'dialogue', 'text', 'particle', 'particles',
]
export const INK_DELTA = 32
export const BLANK_STDDEV = 8.0
const HISTOGRAM_BINS = 32

/** A crop as the audit sees it: its review key and page-pixel box (Kotlin `Pair<String, Box>`). */
export type KeyedBox = [key: string, box: Box]

function area(b: Box): number {
  return Math.max(0, boxWidth(b)) * Math.max(0, boxHeight(b))
}

export function intersection(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  return w > 0 && h > 0 ? w * h : 0
}

export function iou(a: Box, b: Box): number {
  const inter = intersection(a, b)
  const union = area(a) + area(b) - inter
  return union > 0 ? inter / union : 0.0
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2.0
}

/** JavaScript's Math.round(value * 100) + "%", as the phone writes it. */
function pct(value: number): string {
  return `${Math.floor(value * 100 + 0.5)}%`
}

/** JavaScript's toFixed(1) (the phone's BigDecimal HALF_UP gives the same for positive values). */
function fixed1(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Cannot format ${value}`) // BigDecimal throws on the phone too
  return value.toFixed(1)
}

/** The geometry checks. [reasons] maps a crop's key to its snake_case reason, for FILLER_REASON. */
export function geometry(pageWidth: number, pageHeight: number, crops: KeyedBox[], reasons: Map<string, string> = new Map()): AuditFinding[] {
  void pageWidth
  const findings: AuditFinding[] = []
  for (const [key, b] of crops) {
    const w = boxWidth(b)
    const h = boxHeight(b)
    if (h > TALL_RATIO * w) {
      findings.push(auditFinding('TALL_ASPECT', key, `${w}×${h} px is ${fixed1(h / w)}× taller than wide — check it isn't several shots, or keep it as one continuous scene`))
    }
    if (h > PAGE_FRACTION_LIMIT * pageHeight) {
      findings.push(auditFinding('PAGE_FRACTION', key, `Covers ${pct(h / pageHeight)} of the page height (review above ${pct(PAGE_FRACTION_LIMIT)})`))
    }
    const others = crops.filter(([k]) => k !== key).map(([, o]) => boxHeight(o))
    if (others.length >= OUTLIER_MIN_OTHERS) {
      const m = median(others)
      if (m > 0 && h > OUTLIER_FACTOR * m) {
        findings.push(auditFinding('HEIGHT_OUTLIER', key, `${h} px tall, ${fixed1(h / m)}× the median of the other crops (${Math.floor(m + 0.5)} px)`))
      }
    }
    if (Math.min(w, h) < TINY_SIDE_PX) {
      findings.push(auditFinding('TINY', key, `Only ${w}×${h} px — too small to be a readable shot, or a stray box`))
    } else if (Math.max(w, h) / Math.min(w, h) > SLIVER_RATIO) {
      findings.push(auditFinding('SLIVER', key, `${w}×${h} px is a thin sliver (over ${SLIVER_RATIO}:1)`))
    }
  }
  for (let i = 0; i < crops.length; i++) {
    for (let j = i + 1; j < crops.length; j++) {
      const [aKey, a] = crops[i]!
      const [bKey, b] = crops[j]!
      const overlap = iou(a, b)
      if (overlap >= DUPLICATE_IOU) {
        findings.push(auditFinding('DUPLICATE', bKey, `Nearly identical to ${aKey} (${pct(overlap)} overlap)`, aKey))
        continue
      }
      const smaller = Math.min(area(a), area(b))
      const contained = smaller > 0 ? intersection(a, b) / smaller : 0.0
      if (overlap >= OVERLAP_IOU || contained >= CONTAINMENT_SHARE) {
        const message = contained >= CONTAINMENT_SHARE
          ? `${pct(contained)} of the smaller box lies inside ${aKey}`
          : `Overlaps ${aKey} by ${pct(overlap)}`
        findings.push(auditFinding('HIGH_OVERLAP', bKey, message, aKey))
        continue
      }
      const shared = sharedEdge(aKey, a, bKey, b)
      if (shared !== null) findings.push(shared)
    }
  }
  for (const [key] of crops) {
    const reason = reasons.get(key)
    if (reason === undefined) continue
    const words = reason.toLowerCase().split('_').filter((w) => w.length > 0)
    const filler = FILLER_REASON_WORDS.find((w) => words.includes(w))
    if (filler === undefined) continue
    findings.push(auditFinding(
      'FILLER_REASON', key,
      `Its reason "${reason}" names ${filler} — keep it only if a person, creature, object or place is its subject, not background, bubbles or lettering`,
    ))
  }
  return findings
}

/** Two crops that meet edge to edge with no gutter. The finding goes on the lower (or right) crop and names the other. */
function sharedEdge(aKey: string, a: Box, bKey: string, b: Box): AuditFinding | null {
  const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => {
    const shorter = Math.min(a1 - a0, b1 - b0)
    return shorter > 0 && Math.min(a1, b1) - Math.max(a0, b0) >= SHARED_EDGE_OVERLAP * shorter
  }
  const meets = (firstEnd: number, secondStart: number) => Math.abs(secondStart - firstEnd) <= SHARED_EDGE_PX
  const [upper, lower]: [KeyedBox, KeyedBox] = a.y0 <= b.y0 ? [[aKey, a], [bKey, b]] : [[bKey, b], [aKey, a]]
  if (overlaps(a.x0, a.x1, b.x0, b.x1) && meets(upper[1].y1, lower[1].y0)) {
    return auditFinding(
      'SHARED_EDGE', lower[0],
      `Its top edge meets ${upper[0]}'s bottom edge with no gutter — if the same shot continues across that line, merge the two; keep them apart only if a drawn panel border, gutter or clear artwork break runs along it`,
      upper[0],
    )
  }
  const [left, right]: [KeyedBox, KeyedBox] = a.x0 <= b.x0 ? [[aKey, a], [bKey, b]] : [[bKey, b], [aKey, a]]
  if (overlaps(a.y0, a.y1, b.y0, b.y1) && meets(left[1].x1, right[1].x0)) {
    return auditFinding(
      'SHARED_EDGE', right[0],
      `Its left edge meets ${left[0]}'s right edge with no gutter — if the same shot continues across that line, merge the two; keep them apart only if a drawn panel border, gutter or clear artwork break runs along it`,
      left[0],
    )
  }
  return null
}

/** Vertical stretches no crop touches, at least [MIN_GAP_PX] tall. */
export function uncoveredIntervals(pageHeight: number, crops: Box[]): [number, number][] {
  const gaps: [number, number][] = []
  let cursor = 0
  for (const b of [...crops].sort((p, q) => p.y0 - q.y0)) {
    if (b.y0 - cursor >= MIN_GAP_PX) gaps.push([cursor, b.y0])
    cursor = Math.max(cursor, b.y1)
  }
  if (pageHeight - cursor >= MIN_GAP_PX) gaps.push([cursor, pageHeight])
  return gaps
}

// Pixels

function runIsBlank(count: number, value: (i: number) => number): boolean {
  if (count <= 0) return true
  let sum = 0.0
  let sumSq = 0.0
  for (let i = 0; i < count; i++) {
    const v = value(i)
    sum += v
    sumSq += v * v
  }
  const mean = sum / count
  return Math.sqrt(Math.max(0.0, sumSq / count - mean * mean)) < BLANK_STDDEV
}

export function rowIsBlank(page: LumaPage, y: number, x0 = 0, x1 = page.width): boolean {
  const offset = y * page.width
  return runIsBlank(x1 - x0, (i) => page.data[offset + x0 + i]!)
}

/** Share of a run's pixels further than [INK_DELTA] from its median, i.e. from its background. */
function inkShare(count: number, value: (i: number) => number): number {
  if (count <= 0) return 0.0
  const hist = new Int32Array(256)
  for (let i = 0; i < count; i++) hist[value(i)]!++
  let med = 0
  let acc = 0
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!
    if (acc * 2 >= count) {
      med = v
      break
    }
  }
  let ink = 0
  for (let v = 0; v < 256; v++) if (Math.abs(v - med) > INK_DELTA) ink += hist[v]!
  return ink / count
}

export function rowInkShare(page: LumaPage, y: number, x0: number, x1: number): number {
  const offset = y * page.width
  return inkShare(x1 - x0, (i) => page.data[offset + x0 + i]!)
}

export function columnInkShare(page: LumaPage, x: number, y0: number, y1: number): number {
  return inkShare(y1 - y0, (i) => page.data[(y0 + i) * page.width + x]!)
}

/** The luminance histogram of a rectangle, as shares of its pixels. */
function lumaHistogram(page: LumaPage, b: Box): Float64Array {
  const hist = new Float64Array(HISTOGRAM_BINS)
  let count = 0
  for (let y = b.y0; y < b.y1; y++) {
    const offset = y * page.width
    for (let x = b.x0; x < b.x1; x++) {
      hist[page.data[offset + x]! >> 3]!++
      count++
    }
  }
  if (count > 0) for (let i = 0; i < HISTOGRAM_BINS; i++) hist[i]! /= count
  return hist
}

/** How different two rectangles' luminance is, 0 (same) to 1 (nothing shared). */
export function histogramDistance(page: LumaPage, a: Box, b: Box): number {
  const ha = lumaHistogram(page, a)
  const hb = lumaHistogram(page, b)
  let sum = 0.0
  for (let i = 0; i < HISTOGRAM_BINS; i++) sum += Math.abs(ha[i]! - hb[i]!)
  return sum / 2
}

/**
 * Flags edges where the artwork seems to continue past them: the band just outside is heavily inked AND
 * looks like the strip just inside. Edges on the page border are skipped.
 */
export function edges(page: LumaPage, crops: KeyedBox[]): AuditFinding[] {
  const findings: AuditFinding[] = []
  const near = EDGE_COMPARE_PX
  for (const [key, b] of crops) {
    /** [first, last) lines, like Kotlin's `first until last`. */
    const check = (edge: string, first: number, end: number, outside: Box, inside: Box, share: (line: number) => number) => {
      if (end <= first) return
      let sum = 0
      for (let line = first; line < end; line++) sum += share(line)
      const mean = sum / (end - first)
      if (mean < EDGE_INK_SHARE) return
      if (histogramDistance(page, outside, inside) >= EDGE_SAME_ART_DISTANCE) return
      findings.push(auditFinding(
        'EDGE_ON_CONTENT', key,
        `The strip just past the ${edge} edge is ${pct(mean)} ink and looks like the artwork inside — the shot may continue past it`,
        null, edge,
      ))
    }
    if (b.y0 > 0) {
      check('top', Math.max(0, b.y0 - EDGE_BAND_PX), b.y0,
        { ...b, y0: Math.max(0, b.y0 - near), y1: b.y0 }, { ...b, y1: Math.min(b.y1, b.y0 + near) }, (y) => rowInkShare(page, y, b.x0, b.x1))
    }
    if (b.y1 < page.height) {
      check('bottom', b.y1, Math.min(page.height, b.y1 + EDGE_BAND_PX),
        { ...b, y0: b.y1, y1: Math.min(page.height, b.y1 + near) }, { ...b, y0: Math.max(b.y0, b.y1 - near) }, (y) => rowInkShare(page, y, b.x0, b.x1))
    }
    if (b.x0 > 0) {
      check('left', Math.max(0, b.x0 - EDGE_BAND_PX), b.x0,
        { ...b, x0: Math.max(0, b.x0 - near), x1: b.x0 }, { ...b, x1: Math.min(b.x1, b.x0 + near) }, (x) => columnInkShare(page, x, b.y0, b.y1))
    }
    if (b.x1 < page.width) {
      check('right', b.x1, Math.min(page.width, b.x1 + EDGE_BAND_PX),
        { ...b, x0: b.x1, x1: Math.min(page.width, b.x1 + near) }, { ...b, x0: Math.max(b.x0, b.x1 - near) }, (x) => columnInkShare(page, x, b.y0, b.y1))
    }
  }
  return findings
}

/** Flags crops that are largely flat colour: an empty transition, a black or white stretch, a plain background. */
export function blank(page: LumaPage, crops: KeyedBox[]): AuditFinding[] {
  const findings: AuditFinding[] = []
  for (const [key, b] of crops) {
    if (b.y1 <= b.y0 || b.x1 <= b.x0) continue
    let blankRows = 0
    for (let y = b.y0; y < b.y1; y++) if (rowIsBlank(page, y, b.x0, b.x1)) blankRows++
    const share = blankRows / (b.y1 - b.y0)
    if (share < MOSTLY_BLANK_SHARE) continue
    findings.push(auditFinding(
      'MOSTLY_BLANK', key,
      `${pct(share)} of its rows are a flat colour — check it holds a real shot, not an empty transition or a plain background behind lettering`,
    ))
  }
  return findings
}

function gapsWithContent(page: LumaPage, gaps: [number, number][]): UncoveredGap[] {
  return gaps.map(([y0, y1]) => {
    let ink = 0.0
    for (let y = y0; y < y1; y++) ink += rowInkShare(page, y, 0, page.width)
    return { y0, y1, inkShare: y1 > y0 ? ink / (y1 - y0) : 0.0 }
  })
}

/** Geometry always; the pixel rules when a decoded page is supplied. [reasons] maps crop keys to reasons. */
export function audit(
  pageWidth: number,
  pageHeight: number,
  crops: KeyedBox[],
  luma: LumaPage | null,
  reasons: Map<string, string> = new Map(),
): AuditReport {
  const findings = geometry(pageWidth, pageHeight, crops, reasons)
  const intervals = uncoveredIntervals(pageHeight, crops.map(([, b]) => b))
  if (luma === null) return { findings, gaps: intervals.map(([y0, y1]) => ({ y0, y1, inkShare: null })) }
  return { findings: [...findings, ...edges(luma, crops), ...blank(luma, crops)], gaps: gapsWithContent(luma, intervals) }
}

// Greyscale

/**
 * The phone's CropAudit.Greyscale: sRGB to 8-bit grey the way sharp's greyscale() does it (luminance from
 * linear light, Rec. 709 weights, encoded back to sRGB), with the phone's float32 tables reproduced exactly
 * (Math.fround), so the same RGB gives the same grey byte as on the phone.
 */
const TO_LINEAR = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255.0
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
const STEPS = 4096
const TO_SRGB = new Uint8Array(STEPS + 1)
for (let i = 0; i <= STEPS; i++) {
  const l = i / STEPS
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055
  TO_SRGB[i] = Math.min(255, Math.max(0, Math.round(c * 255)))
}
const WR = Math.fround(0.2126)
const WG = Math.fround(0.7152)
const WB = Math.fround(0.0722)

export function greyscaleLuma(r: number, g: number, b: number): number {
  const f = Math.fround
  const y = f(f(f(WR * TO_LINEAR[r]!) + f(WG * TO_LINEAR[g]!)) + f(WB * TO_LINEAR[b]!))
  const index = Math.round(f(y * STEPS))
  return TO_SRGB[Math.min(STEPS, Math.max(0, index))]!
}

/**
 * Decodes an image to the page's luma grid for [audit]. sharp decodes to 8-bit sRGB (no EXIF rotation, as
 * the phone's BitmapRegionDecoder keeps stored pixels; alpha is dropped without flattening), then each pixel
 * goes through the phone's [greyscaleLuma].
 */
export async function lumaFromImage(buffer: Buffer): Promise<LumaPage> {
  const { data, info } = await sharp(buffer).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const out = new Uint8Array(width * height)
  for (let p = 0, i = 0; p < out.length; p++, i += channels) {
    out[p] = channels >= 3 ? greyscaleLuma(data[i]!, data[i + 1]!, data[i + 2]!) : data[i]!
  }
  return { width, height, data: out }
}
