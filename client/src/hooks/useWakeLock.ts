/**
 * useWakeLock — keep the screen on while something long is running.
 *
 * A batch export renders for minutes or hours with no pointer or keyboard
 * activity, so the display sleeps and (on a laptop) the machine can follow it
 * down. The Screen Wake Lock API is the browser's sanctioned way to say "keep
 * this display awake"; it is a request, not a command, and the OS stays free
 * to refuse it on low battery.
 *
 * Two limits are worth knowing, because they shape what this can promise:
 *
 *  - The lock only holds while the page is *visible*. Switching tabs or
 *    minimizing releases it automatically — that is the spec, not a bug, and
 *    it cannot be worked around from a web page. The visibility listener below
 *    reacquires it the moment the tab is shown again, so coming back does not
 *    silently leave the screen unprotected for the rest of the run.
 *  - It keeps the *screen* awake. It does not stop a lid close or an OS sleep
 *    the user initiates.
 *
 * Unsupported browsers (Safari before 16.4, any non-secure origin) simply get
 * `supported: false` and no lock — nothing throws, and the caller carries on.
 */

import { useEffect, useRef, useState } from 'react'

/** Whether this browser exposes the Screen Wake Lock API at all. */
export function isWakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
}

export interface WakeLockState {
  /** The API exists here. False on older Safari and on non-HTTPS origins. */
  supported: boolean
  /** A lock is held right now. Goes false on its own when the tab is hidden. */
  active: boolean
}

/**
 * Hold a screen wake lock for as long as `enabled` is true.
 *
 * Acquiring and releasing is driven entirely by that flag, so a caller just
 * passes whether its job is running and never has to manage the sentinel.
 */
export function useWakeLock(enabled: boolean): WakeLockState {
  const [supported] = useState(isWakeLockSupported)
  const [active, setActive] = useState(false)

  // The live sentinel. A ref, not state: releasing must be able to reach the
  // current lock from a cleanup that does not re-run on every render.
  const sentinelRef = useRef<WakeLockSentinel | null>(null)

  // Read inside async callbacks that may resolve after `enabled` has flipped,
  // so a lock granted late is released immediately rather than left holding.
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  useEffect(() => {
    if (!supported) return

    let cancelled = false

    async function acquire() {
      // Already held, or the page is hidden — a request while hidden is
      // rejected by the browser, so it waits for the visibility handler.
      if (sentinelRef.current || document.visibilityState !== 'visible') return
      try {
        const sentinel = await navigator.wakeLock.request('screen')
        if (cancelled || !enabledRef.current) {
          // The job finished while the request was in flight.
          void sentinel.release().catch(() => {})
          return
        }
        sentinelRef.current = sentinel
        setActive(true)
        // Fires on release, including the automatic one when the tab hides.
        sentinel.addEventListener('release', () => {
          if (sentinelRef.current === sentinel) sentinelRef.current = null
          setActive(false)
        })
      } catch {
        // Refused — low battery, or a policy that forbids it. The export runs
        // on the server regardless, so this is never worth an error to the user.
        setActive(false)
      }
    }

    function release() {
      const sentinel = sentinelRef.current
      sentinelRef.current = null
      setActive(false)
      if (sentinel) void sentinel.release().catch(() => {})
    }

    if (enabled) {
      void acquire()
      // Re-acquire on return to the tab: the browser drops the lock whenever
      // the page is hidden, and without this a single tab switch would leave
      // the rest of a long render unprotected.
      const onVisible = () => {
        if (enabledRef.current && document.visibilityState === 'visible') void acquire()
      }
      document.addEventListener('visibilitychange', onVisible)
      return () => {
        cancelled = true
        document.removeEventListener('visibilitychange', onVisible)
        release()
      }
    }

    release()
    return () => { cancelled = true }
  }, [enabled, supported])

  return { supported, active }
}
