/**
 * Video Editor pure helpers — Editor 2.0.
 *
 * Dependency-free math used by Editor 2.0's export. Kept free of prisma so it
 * can be unit-tested without importing the server bootstrap (prisma/index.ts).
 */

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

/** Throw a clear error when FFmpeg isn't available (export/preview disabled). */
export function ensureFfmpegAvailable(caps: { ffmpegAvailable: boolean; error?: string }): void {
  if (!caps.ffmpegAvailable) {
    throw new Error(caps.error || 'FFmpeg is not available — video export is disabled')
  }
}
