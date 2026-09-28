/**
 * Crop Studio (hybrid ChatGPT loop) — deterministic audit of one page's crops.
 *
 * Every finding here is a REVIEW TRIGGER, never an action: nothing is deleted,
 * split or moved because of it (PRD FR-032/033, §8.1). Two kinds:
 *
 *  - Geometry (pure): tall aspect, share of page height, height outlier against
 *    the other crops, duplicates, heavy overlap, tiny or sliver boxes.
 *  - Pixels (deterministic, not semantic): whether the rows/columns just past a
 *    box edge are blank, and how much of each uncovered stretch of the page is
 *    non-blank. "Non-blank" only means "not a flat colour" — speech bubbles,
 *    SFX and artwork all count — so these are pointers for the eye, never a
 *    claim that artwork was missed or clipped.
 *
 * Findings are derived on every read and never stored, so they can't go stale
 * against the crops they describe.
 */

import sharp from 'sharp'

export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface AuditCrop {
  key: string
  bounds: Box
}

export type FindingCode =
  | 'TALL_ASPECT'
  | 'PAGE_FRACTION'
  | 'HEIGHT_OUTLIER'
  | 'DUPLICATE'
  | 'HIGH_OVERLAP'
  | 'TINY'
  | 'SLIVER'
  | 'EDGE_ON_CONTENT'

export interface AuditFinding {
  code: FindingCode
  /** The crop this is about. */
  key: string
  /** The other crop, for DUPLICATE / HIGH_OVERLAP. */
  otherKey?: string
  /** For EDGE_ON_CONTENT: which edge. */
  edge?: 'top' | 'bottom' | 'left' | 'right'
  message: string
}

export interface UncoveredGap {
  y0: number
  y1: number
  /** Share of the gap's rows that are not a flat colour, 0–1; null when pixels were not checked. */
  nonBlankShare: number | null
}

export interface AuditReport {
  findings: AuditFinding[]
  gaps: UncoveredGap[]
}

// Thresholds — named so the review UI and the tests can cite them.
export const TALL_RATIO = 2
export const PAGE_FRACTION_LIMIT = 0.2
export const OUTLIER_FACTOR = 2.5
/** Fewer other crops than this and a median is not a meaningful comparison. */
export const OUTLIER_MIN_OTHERS = 2
export const DUPLICATE_IOU = 0.9
export const OVERLAP_IOU = 0.3
/** Share of the smaller box covered by the larger one that counts as heavy overlap. */
export const CONTAINMENT_SHARE = 0.6
export const TINY_SIDE_PX = 48
export const SLIVER_RATIO = 12
/** Uncovered stretches shorter than this are ordinary gutters and are not listed. */
export const MIN_GAP_PX = 200
/** Rows/columns sampled just past an edge. */
export const EDGE_BAND_PX = 6
/**
 * Share of "ink" pixels in that band at which the edge is flagged. Calibrated
 * on real pages: correct panel edges sit under ~0.2 even with a bubble outline
 * or SFX stroke crossing them, edges cut through artwork score 0.55+.
 */
export const EDGE_INK_SHARE = 0.35
/** A pixel is ink when it differs from its run's median by more than this (0–255). */
export const INK_DELTA = 32

const width = (b: Box) => b.x1 - b.x0
const height = (b: Box) => b.y1 - b.y0
const area = (b: Box) => Math.max(0, width(b)) * Math.max(0, height(b))

export function intersection(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  return w > 0 && h > 0 ? w * h : 0
}

export function iou(a: Box, b: Box): number {
  const inter = intersection(a, b)
  const union = area(a) + area(b) - inter
  return union > 0 ? inter / union : 0
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const pct = (value: number) => `${Math.round(value * 100)}%`

/** The pure geometric rules. */
export function auditGeometry(pageWidth: number, pageHeight: number, crops: AuditCrop[]): AuditFinding[] {
  const findings: AuditFinding[] = []

  for (const crop of crops) {
    const w = width(crop.bounds)
    const h = height(crop.bounds)

    if (h > TALL_RATIO * w) {
      findings.push({ code: 'TALL_ASPECT', key: crop.key, message: `${w}×${h} px is ${(h / w).toFixed(1)}× taller than wide — check it isn't several shots, or keep it as one continuous scene` })
    }
    if (h > PAGE_FRACTION_LIMIT * pageHeight) {
      findings.push({ code: 'PAGE_FRACTION', key: crop.key, message: `Covers ${pct(h / pageHeight)} of the page height (review above ${pct(PAGE_FRACTION_LIMIT)})` })
    }

    const others = crops.filter(c => c.key !== crop.key).map(c => height(c.bounds))
    if (others.length >= OUTLIER_MIN_OTHERS) {
      const m = median(others)
      if (m > 0 && h > OUTLIER_FACTOR * m) {
        findings.push({ code: 'HEIGHT_OUTLIER', key: crop.key, message: `${h} px tall, ${(h / m).toFixed(1)}× the median of the other crops (${Math.round(m)} px)` })
      }
    }

    if (Math.min(w, h) < TINY_SIDE_PX) {
      findings.push({ code: 'TINY', key: crop.key, message: `Only ${w}×${h} px — too small to be a readable shot, or a stray box` })
    } else if (Math.max(w, h) / Math.min(w, h) > SLIVER_RATIO) {
      findings.push({ code: 'SLIVER', key: crop.key, message: `${w}×${h} px is a thin sliver (over ${SLIVER_RATIO}:1)` })
    }
  }

  for (let i = 0; i < crops.length; i++) {
    for (let j = i + 1; j < crops.length; j++) {
      const a = crops[i]
      const b = crops[j]
      const overlap = iou(a.bounds, b.bounds)
      if (overlap >= DUPLICATE_IOU) {
        findings.push({ code: 'DUPLICATE', key: b.key, otherKey: a.key, message: `Nearly identical to ${a.key} (${pct(overlap)} overlap)` })
        continue
      }
      const inter = intersection(a.bounds, b.bounds)
      const smaller = Math.min(area(a.bounds), area(b.bounds))
      const contained = smaller > 0 ? inter / smaller : 0
      if (overlap >= OVERLAP_IOU || contained >= CONTAINMENT_SHARE) {
        findings.push({
          code: 'HIGH_OVERLAP',
          key: b.key,
          otherKey: a.key,
          message: contained >= CONTAINMENT_SHARE
            ? `${pct(contained)} of the smaller box lies inside ${a.key}`
            : `Overlaps ${a.key} by ${pct(overlap)}`
        })
      }
    }
  }

  return findings
}

/** Vertical stretches of the page no crop touches, at least MIN_GAP_PX tall. */
export function uncoveredIntervals(pageHeight: number, crops: AuditCrop[]): { y0: number; y1: number }[] {
  const spans = crops.map(c => [c.bounds.y0, c.bounds.y1] as const).sort((a, b) => a[0] - b[0])
  const gaps: { y0: number; y1: number }[] = []
  let cursor = 0
  for (const [y0, y1] of spans) {
    if (y0 - cursor >= MIN_GAP_PX) gaps.push({ y0: cursor, y1: y0 })
    cursor = Math.max(cursor, y1)
  }
  if (pageHeight - cursor >= MIN_GAP_PX) gaps.push({ y0: cursor, y1: pageHeight })
  return gaps
}

// ============ Pixels ============

/** One page as 8-bit luminance, row-major. */
export interface LumaPage {
  data: Buffer
  width: number
  height: number
}

/**
 * A run of pixels is blank when its luminance barely varies: flat white, black
 * or grey, plus JPEG noise. The threshold is a standard deviation in 0–255.
 */
export const BLANK_STDDEV = 8

function runIsBlank(values: (i: number) => number, count: number): boolean {
  if (count <= 0) return true
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < count; i++) {
    const v = values(i)
    sum += v
    sumSq += v * v
  }
  const mean = sum / count
  return Math.sqrt(Math.max(0, sumSq / count - mean * mean)) < BLANK_STDDEV
}

export function rowIsBlank(page: LumaPage, y: number, x0 = 0, x1 = page.width): boolean {
  const offset = y * page.width
  return runIsBlank(i => page.data[offset + x0 + i], x1 - x0)
}

/**
 * Share of a run's pixels that are "ink": further than INK_DELTA from the run's
 * median, i.e. from its background. A thin outline crossing a white gutter is a
 * few percent; artwork continuing across it is most of the run.
 */
function inkShare(values: (i: number) => number, count: number): number {
  if (count <= 0) return 0
  const hist = new Uint32Array(256)
  for (let i = 0; i < count; i++) hist[values(i)]++
  let median = 0
  for (let v = 0, acc = 0; v < 256; v++) {
    acc += hist[v]
    if (acc * 2 >= count) { median = v; break }
  }
  let ink = 0
  for (let v = 0; v < 256; v++) if (Math.abs(v - median) > INK_DELTA) ink += hist[v]
  return ink / count
}

export function rowInkShare(page: LumaPage, y: number, x0 = 0, x1 = page.width): number {
  const offset = y * page.width
  return inkShare(i => page.data[offset + x0 + i], x1 - x0)
}

export function columnInkShare(page: LumaPage, x: number, y0: number, y1: number): number {
  return inkShare(i => page.data[(y0 + i) * page.width + x], y1 - y0)
}

/**
 * Flags box edges where the band just outside is heavily inked: the artwork
 * seems to continue past the edge, so a subject may be cut. Edges on the page
 * border are skipped. A dense bubble or SFX right against an edge can trip it
 * too, which is why it is a check to tick off, not a verdict.
 */
export function auditEdges(page: LumaPage, crops: AuditCrop[]): AuditFinding[] {
  const findings: AuditFinding[] = []
  const band = EDGE_BAND_PX

  for (const { key, bounds: b } of crops) {
    const check = (edge: 'top' | 'bottom' | 'left' | 'right', lines: number[], share: (line: number) => number) => {
      if (lines.length === 0) return
      const mean = lines.reduce((sum, line) => sum + share(line), 0) / lines.length
      if (mean >= EDGE_INK_SHARE) {
        findings.push({
          code: 'EDGE_ON_CONTENT',
          key,
          edge,
          message: `The strip just past the ${edge} edge is ${pct(mean)} ink — artwork may continue past it (a dense bubble or SFX there also trips this)`
        })
      }
    }
    const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i)

    if (b.y0 > 0) check('top', range(Math.max(0, b.y0 - band), b.y0), y => rowInkShare(page, y, b.x0, b.x1))
    if (b.y1 < page.height) check('bottom', range(b.y1, Math.min(page.height, b.y1 + band)), y => rowInkShare(page, y, b.x0, b.x1))
    if (b.x0 > 0) check('left', range(Math.max(0, b.x0 - band), b.x0), x => columnInkShare(page, x, b.y0, b.y1))
    if (b.x1 < page.width) check('right', range(b.x1, Math.min(page.width, b.x1 + band)), x => columnInkShare(page, x, b.y0, b.y1))
  }
  return findings
}

export function gapsWithContent(page: LumaPage, gaps: { y0: number; y1: number }[]): UncoveredGap[] {
  return gaps.map(gap => {
    let busy = 0
    for (let y = gap.y0; y < gap.y1; y++) if (!rowIsBlank(page, y)) busy++
    return { ...gap, nonBlankShare: gap.y1 > gap.y0 ? busy / (gap.y1 - gap.y0) : 0 }
  })
}

/**
 * Decoded luminance pages, keyed by source hash. A page is re-read on every
 * review save, and decoding a 13,000 px page each time is wasted work; a few
 * pages stay resident (~10 MB each for an 800 px-wide page).
 */
const lumaCache = new Map<string, LumaPage>()
const LUMA_CACHE_SIZE = 4

export async function loadLuma(sourcePath: string, sha256: string): Promise<LumaPage> {
  const cached = lumaCache.get(sha256)
  if (cached) {
    lumaCache.delete(sha256)
    lumaCache.set(sha256, cached)
    return cached
  }
  const { data, info } = await sharp(sourcePath).greyscale().raw().toBuffer({ resolveWithObject: true })
  // greyscale() on an image with alpha can still hand back 2 channels.
  const luma = info.channels === 1 ? data : Buffer.from(data.filter((_, i) => i % info.channels === 0))
  const page: LumaPage = { data: luma, width: info.width, height: info.height }
  lumaCache.set(sha256, page)
  while (lumaCache.size > LUMA_CACHE_SIZE) lumaCache.delete(lumaCache.keys().next().value as string)
  return page
}

/** Geometry always; pixel rules when a decoded page is supplied. */
export function auditPage(pageWidth: number, pageHeight: number, crops: AuditCrop[], luma?: LumaPage): AuditReport {
  const findings = auditGeometry(pageWidth, pageHeight, crops)
  const intervals = uncoveredIntervals(pageHeight, crops)
  if (!luma) return { findings, gaps: intervals.map(g => ({ ...g, nonBlankShare: null })) }
  return {
    findings: [...findings, ...auditEdges(luma, crops)],
    gaps: gapsWithContent(luma, intervals)
  }
}
