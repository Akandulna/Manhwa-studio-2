/**
 * usePhoneRelay — is the server connected to the phone relay, and is
 * Sleeper-Cell open on the phone right now. Read once from the server, then
 * kept current by its `phone:relay` socket event; nothing polls.
 */

import { useEffect, useState } from 'react'
import { r2Api, type RelayStatus } from '@/lib/api'
import { useSocket } from '@/lib/socket'

export function usePhoneRelay(): RelayStatus | null {
  const { socket } = useSocket()
  const [status, setStatus] = useState<RelayStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    r2Api.getRelay().then(next => { if (!cancelled) setStatus(next) }).catch(() => { /* advisory only */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!socket) return
    const onStatus = (next: RelayStatus) => setStatus(next)
    socket.on('phone:relay', onStatus)
    return () => { socket.off('phone:relay', onStatus) }
  }, [socket])

  return status
}
