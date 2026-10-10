/**
 * usePhoneScreens — each phone's screen state and last screenshot (Phone
 * Status). Read once, then again whenever the server pushes `phone:screen`
 * (a phone answered Wake, Screen off or Screenshot); nothing polls.
 */

import { useCallback, useEffect, useState } from 'react'
import { r2Api, type PhoneScreen } from '@/lib/api'
import { useSocket } from '@/lib/socket'

export function usePhoneScreens(): Map<string, PhoneScreen> {
  const { socket } = useSocket()
  const [screens, setScreens] = useState<Map<string, PhoneScreen>>(new Map())

  const load = useCallback(() => {
    r2Api.getPhoneScreens()
      .then(({ phones }) => setScreens(new Map(phones.map(p => [p.device, p]))))
      .catch(() => { /* advisory only */ })
  }, [])

  useEffect(load, [load])

  useEffect(() => {
    if (!socket) return
    socket.on('phone:screen', load)
    return () => { socket.off('phone:screen', load) }
  }, [socket, load])

  return screens
}
