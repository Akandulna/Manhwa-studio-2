/**
 * usePhoneScripts — which chapters have a narration script on the Sleeper-Cell
 * phone, kept live while the page is open.
 *
 * The phone writes a receipt to R2 right after each save; there is no push
 * from R2, so this polls. Each poll is one HEAD on the server, which fetches
 * the receipt only when it changed. Polling pauses while the window is hidden
 * and catches up as soon as it is shown again.
 *
 * Like usePublishedChapters, failure is silent: the phone marker is advisory.
 */

import { useEffect, useState } from 'react'
import { r2Api, PhoneScriptsStatus } from '@/lib/api'

const POLL_MS = 5_000

export function usePhoneScripts(seriesId?: string): PhoneScriptsStatus | null {
  const [status, setStatus] = useState<PhoneScriptsStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false

    const poll = async () => {
      clearTimeout(timer)
      if (inFlight) return // the running poll schedules the next one
      inFlight = true
      try {
        const next = await r2Api.getPhoneScripts(seriesId)
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
  }, [seriesId])

  return status
}
