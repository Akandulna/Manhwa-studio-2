/**
 * Memoize an availability probe (a Python `--check` spawn, an API round trip).
 *
 * Status endpoints are hit on every page open, and each uncached probe costs a
 * fresh interpreter start plus its ML imports — seconds, not milliseconds. A
 * passing probe is kept for `okTtlMs` (default: the life of the process); a
 * failing one only for `failTtlMs`, so finishing `npm run ml:setup` is picked
 * up on the next check without a restart. Concurrent callers share one probe.
 */
export interface CachedProbe<T> {
  (): Promise<T>
  /** Drop the cached result so the next call probes again. */
  clear(): void
}

export function cachedProbe<T>(
  probe: () => Promise<T>,
  opts: { isOk: (result: T) => boolean; okTtlMs?: number; failTtlMs?: number }
): CachedProbe<T> {
  const okTtlMs = opts.okTtlMs ?? Infinity
  const failTtlMs = opts.failTtlMs ?? 30_000
  let cached: { result: T; expiresAt: number } | null = null
  let inFlight: Promise<T> | null = null

  const run = (() => {
    if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.result)
    if (inFlight) return inFlight
    const current = probe()
      .then(result => {
        // A clear() while this probe ran leaves it detached; don't let it
        // repopulate the cache with a result from before the change.
        if (inFlight === current) {
          cached = { result, expiresAt: Date.now() + (opts.isOk(result) ? okTtlMs : failTtlMs) }
        }
        return result
      })
      .finally(() => {
        if (inFlight === current) inFlight = null
      })
    inFlight = current
    return current
  }) as CachedProbe<T>

  run.clear = () => {
    cached = null
    inFlight = null
  }
  return run
}

/** The `{ available }` shape every Python sidecar `--check` probe resolves with. */
export const isAvailable = (r: { available: boolean }) => r.available
