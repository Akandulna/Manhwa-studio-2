/**
 * Video Editor pure helpers — Module 4.
 *
 * Dependency-free math/ordering used by the render engine, the part-image
 * editor, and the AI assist. Kept separate from videoEditorService so it can be
 * unit-tested without importing the server bootstrap (prisma/index.ts).
 */

/** Clamp a volume to [0, 1]; non-finite → 1.0. */
export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1.0
  return Math.max(0, Math.min(1, v))
}

/**
 * Normalize image durations so they sum exactly to the part's audio duration.
 * - sum 0 → equal split.
 * - otherwise scale proportionally; rounding drift absorbed into the last image.
 */
export function normalizePartDurations<T extends { duration: number }>(
  images: T[],
  audioDuration: number
): (T & { duration: number })[] {
  if (images.length === 0) return []
  const total = images.reduce((s, im) => s + (im.duration > 0 ? im.duration : 0), 0)

  let out: (T & { duration: number })[]
  if (total <= 0) {
    const each = audioDuration / images.length
    out = images.map(im => ({ ...im, duration: each }))
  } else {
    const scale = audioDuration / total
    out = images.map(im => ({ ...im, duration: Math.max(0, im.duration) * scale }))
  }

  const summedExceptLast = out.slice(0, -1).reduce((s, im) => s + im.duration, 0)
  out[out.length - 1] = {
    ...out[out.length - 1],
    duration: Math.max(0.05, audioDuration - summedExceptLast)
  }
  return out
}

/**
 * Derive slot order from incoming images: crop-backed images sort by their crop
 * sequence (story order); fillers (no crop) slot just after the preceding item
 * in the incoming array. Returns items with a contiguous 0-based slotIndex.
 */
export function deriveSlotOrder<T extends { cropId?: string | null }>(
  incoming: T[],
  cropSeqById: Map<string, number>
): { item: T; slotIndex: number }[] {
  let lastKey = -1
  const keyed = incoming.map((item, idx) => {
    const seq = item.cropId ? cropSeqById.get(item.cropId) : undefined
    if (seq !== undefined) {
      lastKey = seq
      return { item, key: seq }
    }
    // Filler / unknown crop: keep its place relative to the previous item.
    return { item, key: lastKey + 0.5 + idx * 1e-6 }
  })
  keyed.sort((a, b) => a.key - b.key)
  return keyed.map((k, i) => ({ item: k.item, slotIndex: i }))
}

/** Pick the finalize audio path: music mix, volume-only, or straight copy. */
export function chooseMixMode(opts: { musicPath: string | null; masterVolume: number }): 'music' | 'volume' | 'copy' {
  if (opts.musicPath) return 'music'
  if (clampVolume(opts.masterVolume) !== 1.0) return 'volume'
  return 'copy'
}

/**
 * Clamp an AI-suggested crop range to the available window and keep it valid
 * (start ≤ end, both within [first, last]). `first` may be > 1 to enforce the
 * forward-only / non-overlapping constraint across consecutive parts.
 */
export function clampSuggestionRange(
  rawStart: number,
  rawEnd: number,
  first: number,
  last: number
): { start: number; end: number } {
  const start = Math.max(first, Math.min(Math.round(rawStart), last))
  const end = Math.max(start, Math.min(Math.round(rawEnd), last))
  return { start, end }
}

/** Throw a clear error when FFmpeg isn't available (export/preview disabled). */
export function ensureFfmpegAvailable(caps: { ffmpegAvailable: boolean; error?: string }): void {
  if (!caps.ffmpegAvailable) {
    throw new Error(caps.error || 'FFmpeg is not available — video export is disabled')
  }
}
