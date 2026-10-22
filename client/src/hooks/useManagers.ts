import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { managersApi, type ManagerOverview } from '@/lib/api'
import { useSocket } from '@/lib/socket'

function useManagerSource() {
  const { socket } = useSocket()
  const [data, setData] = useState<ManagerOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  const active = useRef<Promise<void> | null>(null)
  const refreshAgain = useRef(false)
  const reload = useCallback((): Promise<void> => {
    refreshAgain.current = true
    if (active.current) return active.current
    active.current = (async () => {
      while (refreshAgain.current) {
        refreshAgain.current = false
        const version = ++request.current
        try { const next = await managersApi.get(); if (version === request.current) { setData(next); setError(null) } }
        catch { if (version === request.current) setError('Manager reporting is unavailable. Previously loaded facts are last known.') }
      }
    })().finally(() => { active.current = null })
    return active.current
  }, [])
  useEffect(() => {
    void reload()
    const receive = () => { void reload() }
    socket?.on('managers:updated', receive); socket?.on('connect', receive)
    const timer = setInterval(receive, 60_000)
    return () => { clearInterval(timer); socket?.off('managers:updated',receive); socket?.off('connect',receive) }
  }, [socket,reload])
  return { data,error,reload }
}

const ManagerContext = createContext<ReturnType<typeof useManagerSource> | null>(null)
export function ManagerProvider({ children }: { children: ReactNode }) {
  const value = useManagerSource()
  return createElement(ManagerContext.Provider,{ value },children)
}
export function useManagers() {
  const value = useContext(ManagerContext)
  if (!value) throw new Error('ManagerProvider is required')
  return value
}
