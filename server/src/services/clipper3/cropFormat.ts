/**
 * Wire-format helpers for exported crop files: crop ids and ratio precision.
 *
 * These rules (`OUT-08`, `OUT-10`) come from the crop pointer guidelines, so an
 * exported page must follow them byte for byte.
 */

/** Normalized ratios keep at most this many decimal places. */
export const RATIO_PRECISION = 9

/**
 * `OUT-10`: the exact normalized ratio, at most 9 decimal places, trailing zeros
 * stripped. Rounding to a coarser grid is a defect, not tidying — 0.244140625
 * (= 500 / 2048) has to survive unchanged, so 9 dp is a ceiling and never a
 * target precision.
 */
export function formatRatio(n: number): number {
  if (!Number.isFinite(n)) return 0
  const rounded = Number(n.toFixed(RATIO_PRECISION))
  // Collapse -0 so `OUT-11` rendering can never produce "-0.0".
  return rounded === 0 ? 0 : rounded
}

/** `OUT-08`: zero-padded to at least two digits, 1-based. */
export function cropIdFor(index: number): string {
  const ordinal = Number.isFinite(index) ? Math.max(0, Math.floor(index)) + 1 : 1
  return `crop-${String(ordinal).padStart(2, '0')}`
}
