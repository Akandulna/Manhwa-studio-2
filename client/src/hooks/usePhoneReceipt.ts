/**
 * usePhoneReceipt — a receipt the Sleeper-Cell phone writes to R2, read on
 * demand only.
 *
 * R2 operations count against the free tier, so nothing here polls. Opening a
 * page reads the server's last copy, which costs no R2 operation. `refresh`
 * ("Refresh from phone") asks the phone for fresh receipts, then checks R2 on
 * a slowing schedule until the phone's answer carries that request's id, or
 * gives up. The phone looks for requests every 30 s while Sleeper-Cell is
 * open, so an answer usually lands within half a minute.
 *
 * Like usePublishedChapters, a failed load is silent: the phone markers are
 * advisory. A refresh reports its outcome to the caller.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { r2Api } from '@/lib/api'

/** Seconds between R2 checks after asking: about 2.5 minutes in all, at most 13 HEADs. */
const WAIT_SCHEDULE_S = [8, 8, 8, 8, 8, 8, 15, 15, 15, 15, 15, 15, 15]

export type PhoneRefreshOutcome = 'answered' | 'no-answer'

export interface PhoneReceipt<T> {
  status: T | null
  /** True from asking the phone until it answers or the wait gives up. */
  refreshing: boolean
  refresh: () => Promise<PhoneRefreshOutcome>
}

/** `load(fresh)` reads the receipt: from the server's copy, or from R2 when `fresh`. Changing `key` reloads. */
export function usePhoneReceipt<T extends { configured: boolean; answers: string | null }>(
  load: (fresh: boolean) => Promise<T>,
  key: string
): PhoneReceipt<T> {
  const [status, setStatus] = useState<T | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const loadRef = useRef(load)
  loadRef.current = load
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const apply = useCallback((next: T) => {
    // Keep the same object while nothing changed, so rows don't re-render.
    setStatus(prev => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
  }, [])

  useEffect(() => {
    let cancelled = false
    setStatus(null)
    loadRef.current(false)
      .then(next => { if (!cancelled) apply(next) })
      .catch(() => { /* advisory only */ })
    return () => { cancelled = true }
  }, [key, apply])

  const refresh = useCallback(async (): Promise<PhoneRefreshOutcome> => {
    setRefreshing(true)
    try {
      const { id } = await r2Api.requestPhoneUpdate()
      for (const seconds of WAIT_SCHEDULE_S) {
        await new Promise(resolve => setTimeout(resolve, seconds * 1000))
        if (!alive.current) return 'no-answer'
        const next = await loadRef.current(true)
        if (!alive.current) return 'no-answer'
        apply(next)
        if (next.answers === id) return 'answered'
      }
      return 'no-answer'
    } finally {
      if (alive.current) setRefreshing(false)
    }
  }, [apply])

  return { status, refreshing, refresh }
}
