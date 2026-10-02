/**
 * usePhoneReceipt — a status receipt from the Sleeper-Cell phone.
 *
 * With the phone relay set up (Settings → Cloudflare), the phone sends a
 * receipt whenever something changes and the server pushes `phone:receipt`
 * over the socket; this reloads from the server's copy right then, so the
 * markers update live and no R2 operation is spent.
 *
 * Without the relay, receipts sit in R2 and nothing polls: opening a page
 * reads the server's last copy, and `refresh` ("Refresh from phone") asks the
 * phone, then checks R2 on a slowing schedule until the answer carries that
 * request's id. The phone looks for requests every 30 s while it is open.
 *
 * Like usePublishedChapters, a failed load is silent: the phone markers are
 * advisory. A refresh reports its outcome to the caller.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { r2Api, type PhoneUpdateRequest } from '@/lib/api'
import { useSocket } from '@/lib/socket'

/** Without the relay: seconds between R2 checks after asking, about 2.5 minutes in all, at most 13 HEADs. */
const WAIT_SCHEDULE_S = [8, 8, 8, 8, 8, 8, 15, 15, 15, 15, 15, 15, 15]

/** With the relay: how long to wait for the answer to arrive over the socket. */
const RELAY_WAIT_MS = 150_000

export type PhoneRefreshOutcome = 'answered' | 'no-answer'

export interface PhoneReceipt<T> {
  status: T | null
  /** True from asking the phone until it answers or the wait gives up. */
  refreshing: boolean
  /** How the last ask went out, so the caller can word the outcome. */
  lastRequest: PhoneUpdateRequest | null
  refresh: () => Promise<PhoneRefreshOutcome>
}

/**
 * `load(fresh)` reads the receipt: from the server's copy, or (without the
 * relay) from R2 when `fresh`. Changing `key` reloads. `kind` is the receipt
 * whose `phone:receipt` event triggers a reload; 'all' reloads on any of them.
 */
export function usePhoneReceipt<T extends { configured: boolean; answers: string | null }>(
  kind: 'scripts' | 'crops' | 'all',
  load: (fresh: boolean) => Promise<T>,
  key: string
): PhoneReceipt<T> {
  const { socket } = useSocket()
  const [status, setStatus] = useState<T | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRequest, setLastRequest] = useState<PhoneUpdateRequest | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  const alive = useRef(true)
  /** Called with each copy loaded after a push, while a relay refresh waits for its answer. */
  const onPushed = useRef<((next: T) => void) | null>(null)

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

  useEffect(() => {
    if (!socket) return
    const onReceipt = (event: { kind: string }) => {
      if (kind !== 'all' && event.kind !== kind) return
      loadRef.current(false)
        .then(next => {
          if (!alive.current) return
          apply(next)
          onPushed.current?.(next)
        })
        .catch(() => { /* advisory only */ })
    }
    socket.on('phone:receipt', onReceipt)
    return () => { socket.off('phone:receipt', onReceipt) }
  }, [socket, kind, apply])

  const refresh = useCallback(async (): Promise<PhoneRefreshOutcome> => {
    setRefreshing(true)
    try {
      const request = await r2Api.requestPhoneUpdate()
      if (alive.current) setLastRequest(request)

      if (request.via === 'relay') {
        return await new Promise<PhoneRefreshOutcome>(resolve => {
          const timer = setTimeout(() => {
            onPushed.current = null
            resolve('no-answer')
          }, RELAY_WAIT_MS)
          onPushed.current = next => {
            if (next.answers !== request.id) return
            clearTimeout(timer)
            onPushed.current = null
            resolve('answered')
          }
        })
      }

      for (const seconds of WAIT_SCHEDULE_S) {
        await new Promise(resolve => setTimeout(resolve, seconds * 1000))
        if (!alive.current) return 'no-answer'
        const next = await loadRef.current(true)
        if (!alive.current) return 'no-answer'
        apply(next)
        if (next.answers === request.id) return 'answered'
      }
      return 'no-answer'
    } finally {
      if (alive.current) setRefreshing(false)
    }
  }, [apply])

  return { status, refreshing, lastRequest, refresh }
}
