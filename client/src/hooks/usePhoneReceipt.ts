/**
 * usePhoneReceipt — a receipt the Sleeper-Cell phone writes to R2, kept live
 * while the page is open.
 *
 * The phone writes its receipts to R2 as it works; there is no push from R2,
 * so this polls. Each poll is one HEAD on the server, which fetches the
 * receipt only when it changed. Polling pauses while the window is hidden and
 * catches up as soon as it is shown again.
 *
 * Like usePublishedChapters, failure is silent: the phone markers are advisory.
 */

import { useEffect, useRef, useState } from 'react'

const POLL_MS = 5_000

/** `load` is re-read on every poll; changing `key` starts over. */
export function usePhoneReceipt<T extends { configured: boolean }>(load: () => Promise<T>, key: string): T | null {
  const [status, setStatus] = useState<T | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    setStatus(null)

    const poll = async () => {
      clearTimeout(timer)
      if (inFlight) return // the running poll schedules the next one
      inFlight = true
      try {
        const next = await loadRef.current()
        if (cancelled) return
        // Keep the same object while nothing changed, so rows don't re-render every poll.
        setStatus(prev => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
        if (!next.configured) return // nothing to watch until R2 is set up
      } catch {
        // Advisory only; try again on the next tick.
      } finally {
        inFlight = false
      }
      if (!cancelled && document.visibilityState === 'visible') timer = setTimeout(poll, POLL_MS)
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') poll()
      else clearTimeout(timer)
    }

    poll()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [key])

  return status
}
