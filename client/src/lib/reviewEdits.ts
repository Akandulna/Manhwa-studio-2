/**
 * Crop Studio review — the geometry of every box edit, as pure functions.
 *
 * Everything is in integer pixels of the ORIGINAL page (x1/y1 exclusive), the
 * same space the server stores and exports from. The viewer converts mouse
 * positions into this space once and rounds; nothing here knows about zoom.
 *
 * Operator edits may clamp to the page — unlike an imported reply, whose
 * out-of-page box is a measuring error to report, a drag past the edge simply
 * means "to the edge".
 *
 * Description and review consequences follow PRD §8.3: a split or merge
 * invalidates the description of every resulting crop (the old text is kept as
 * a starting point, marked stale), and every changed box loses what was
 * acknowledged about it. The server re-applies the stale/ack rules on save, so
 * these are the client's intent, not the only guard.
 */

import type { Clipper3ReviewCrop } from './api'

export interface PxBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

/** No edit can make a box smaller than this on either side. */
export const MIN_BOX_PX = 8

export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))

/** Translates a box by whole pixels, stopping at the page edges (size kept). */
export function moveBox(box: PxBox, dx: number, dy: number, W: number, H: number): PxBox {
  const w = box.x1 - box.x0
  const h = box.y1 - box.y0
  const x0 = clamp(Math.round(box.x0 + dx), 0, W - w)
  const y0 = clamp(Math.round(box.y0 + dy), 0, H - h)
  return { x0, y0, x1: x0 + w, y1: y0 + h }
}

/** Drags the edges a handle controls, inside the page and never below MIN_BOX_PX. */
export function resizeBox(box: PxBox, handle: Handle, dx: number, dy: number, W: number, H: number): PxBox {
  let { x0, y0, x1, y1 } = box
  if (handle.includes('w')) x0 = clamp(Math.round(box.x0 + dx), 0, box.x1 - MIN_BOX_PX)
  if (handle.includes('e')) x1 = clamp(Math.round(box.x1 + dx), box.x0 + MIN_BOX_PX, W)
  if (handle.includes('n')) y0 = clamp(Math.round(box.y0 + dy), 0, box.y1 - MIN_BOX_PX)
  if (handle.includes('s')) y1 = clamp(Math.round(box.y1 + dy), box.y0 + MIN_BOX_PX, H)
  return { x0, y0, x1, y1 }
}

/** A box drawn from any corner to its opposite, clamped; null when too small to be a crop. */
export function drawnBox(ax: number, ay: number, bx: number, by: number, W: number, H: number): PxBox | null {
  const x0 = clamp(Math.round(Math.min(ax, bx)), 0, W)
  const x1 = clamp(Math.round(Math.max(ax, bx)), 0, W)
  const y0 = clamp(Math.round(Math.min(ay, by)), 0, H)
  const y1 = clamp(Math.round(Math.max(ay, by)), 0, H)
  return x1 - x0 >= MIN_BOX_PX && y1 - y0 >= MIN_BOX_PX ? { x0, y0, x1, y1 } : null
}

/**
 * Cuts a box in two along a horizontal line at page-y `at` ('h') or a vertical
 * line at page-x `at` ('v'). Null when either piece would be under MIN_BOX_PX.
 */
export function splitBox(box: PxBox, axis: 'h' | 'v', at: number): [PxBox, PxBox] | null {
  const cut = Math.round(at)
  if (axis === 'h') {
    if (cut - box.y0 < MIN_BOX_PX || box.y1 - cut < MIN_BOX_PX) return null
    return [{ ...box, y1: cut }, { ...box, y0: cut }]
  }
  if (cut - box.x0 < MIN_BOX_PX || box.x1 - cut < MIN_BOX_PX) return null
  return [{ ...box, x1: cut }, { ...box, x0: cut }]
}

/** The smallest box containing all of them. */
export function unionBox(boxes: PxBox[]): PxBox {
  return {
    x0: Math.min(...boxes.map(b => b.x0)),
    y0: Math.min(...boxes.map(b => b.y0)),
    x1: Math.max(...boxes.map(b => b.x1)),
    y1: Math.max(...boxes.map(b => b.y1))
  }
}

export function sameBox(a: PxBox, b: PxBox): boolean {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1
}

/**
 * Top to bottom, then left to right — the order final crop ids follow at export
 * (PRD FR-038). Boxes whose tops are within `rowTolerance` px count as one row,
 * so side-by-side panels with slightly ragged tops still read left to right.
 */
export function readingOrder<T extends { bounds: PxBox }>(crops: T[], rowTolerance = 12): T[] {
  return [...crops].sort((a, b) => {
    const dy = a.bounds.y0 - b.bounds.y0
    if (Math.abs(dy) > rowTolerance) return dy
    return a.bounds.x0 - b.bounds.x0 || dy
  })
}

/** A key not already used: `base`, else `base-2`, `base-3`, … */
export function uniqueKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`
}

/** The next operator key: op-01, op-02, … (skipping any in use). */
export function nextOperatorKey(taken: Iterable<string>): string {
  const used = new Set(taken)
  for (let n = 1; ; n++) {
    const key = `op-${String(n).padStart(2, '0')}`
    if (!used.has(key)) return key
  }
}

type Crop = Clipper3ReviewCrop

const staleDescription = (description: string): Pick<Crop, 'description_status'> => ({
  description_status: description.trim() ? 'stale' : 'missing'
})

/** A new box for an existing crop. An unreviewed or kept crop becomes `adjusted`. */
export function withBounds(crops: Crop[], key: string, bounds: PxBox): Crop[] {
  return crops.map(c => {
    if (c.key !== key || sameBox(c.bounds, bounds)) return c
    return {
      ...c,
      bounds,
      disposition: c.disposition === 'unreviewed' || c.disposition === 'kept' ? 'adjusted' : c.disposition,
      acknowledged: []
    }
  })
}

/** A crop the operator drew. It needs a reason edit and a description before export. */
export function withAdded(crops: Crop[], bounds: PxBox): { crops: Crop[]; key: string } {
  const key = nextOperatorKey(crops.map(c => c.key))
  const crop: Crop = {
    key,
    origin: 'operator',
    reason: 'operator_crop',
    bounds,
    description: '',
    description_status: 'missing',
    disposition: 'adjusted',
    visual_evidence: '',
    gpt_flags: [],
    unknown_flags: [],
    acknowledged: [],
    note: ''
  }
  return { crops: readingOrder([...crops, crop]), key }
}

export function withDeleted(crops: Crop[], keys: string[]): Crop[] {
  const drop = new Set(keys)
  return crops.filter(c => !drop.has(c.key))
}

/**
 * Replaces one crop by the two halves of a split. Both halves start from the
 * parent's text with the description marked stale — each must be re-approved
 * for its own half.
 */
export function withSplit(crops: Crop[], key: string, axis: 'h' | 'v', at: number): { crops: Crop[]; keys: [string, string] } | null {
  const parent = crops.find(c => c.key === key)
  if (!parent) return null
  const halves = splitBox(parent.bounds, axis, at)
  if (!halves) return null
  const taken = crops.map(c => c.key).filter(k => k !== key)
  const first = uniqueKey(`${key}.a`, taken)
  const second = uniqueKey(`${key}.b`, [...taken, first])
  const child = (childKey: string, bounds: PxBox): Crop => ({
    ...parent,
    key: childKey,
    bounds,
    disposition: 'split',
    ...staleDescription(parent.description),
    acknowledged: []
  })
  const next = crops.flatMap(c => (c.key === key ? [child(first, halves[0]), child(second, halves[1])] : [c]))
  return { crops: readingOrder(next), keys: [first, second] }
}

/**
 * Merges crops into the first of them in reading order, over their union box.
 * Its description is kept as a starting point but marked stale: it described
 * only part of the merged region.
 */
export function withMerged(crops: Crop[], keys: string[]): { crops: Crop[]; key: string } | null {
  const picked = readingOrder(crops.filter(c => keys.includes(c.key)))
  if (picked.length < 2) return null
  const [keep, ...rest] = picked
  const notes = picked.map(c => c.note).filter(Boolean)
  const merged: Crop = {
    ...keep,
    bounds: unionBox(picked.map(c => c.bounds)),
    disposition: 'merged',
    ...staleDescription(keep.description),
    acknowledged: [],
    note: notes.join(' · ')
  }
  const drop = new Set(rest.map(c => c.key))
  const next = crops.filter(c => !drop.has(c.key)).map(c => (c.key === keep.key ? merged : c))
  return { crops: readingOrder(next), key: keep.key }
}
