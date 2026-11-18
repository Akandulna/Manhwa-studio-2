/**
 * In-memory "stitching now" marks, so the Studio can show a spinner while a chapter is
 * being analysed and re-cut (auto preparation before a phone send, or a manual stitch).
 * Nested marks for the same chapter are counted, so the outer one decides when it ends.
 */
const active = new Map<string, number>()
const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of listeners) {
    try { listener() } catch (error) { console.error('[stitch-activity] listener failed:', error) }
  }
}

export function isStitching(folderPath: string): boolean {
  return (active.get(folderPath) ?? 0) > 0
}

export function onStitchActivityChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Marks the chapter as stitching for the duration of `work`. */
export async function withStitchActivity<T>(folderPath: string, work: () => Promise<T>): Promise<T> {
  const before = active.get(folderPath) ?? 0
  active.set(folderPath, before + 1)
  if (before === 0) changed()
  try {
    return await work()
  } finally {
    const left = (active.get(folderPath) ?? 1) - 1
    if (left > 0) active.set(folderPath, left)
    else {
      active.delete(folderPath)
      changed()
    }
  }
}
