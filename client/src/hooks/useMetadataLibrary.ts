import { useCallback, useEffect, useRef, useState } from 'react'
import { metadataApi, type MetadataLibrarySnapshot } from '@/lib/api'
import { useSocket } from '@/lib/socket'

export function useMetadataLibrary() {
  const { socket } = useSocket()
  const [snapshot, setSnapshot] = useState<MetadataLibrarySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const mounted = useRef(false)
  const request = useRef(0)
  const reload = useCallback(async () => {
    const version = ++request.current
    try {
      const next = await metadataApi.library()
      if (mounted.current && request.current === version) { setSnapshot(next); setError(null) }
    } catch (error) {
      if (mounted.current && request.current === version) setError(error instanceof Error ? error.message : 'Could not load Metadata')
    }
  }, [])
  const sync = useCallback(async () => {
    setFetching(true)
    try { await metadataApi.sync(); await reload() }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Could not fetch Metadata') }
    finally { if (mounted.current) setFetching(false) }
  }, [reload])
  useEffect(() => {
    mounted.current = true
    const load = () => { void reload() }
    load()
    const timer = setInterval(load, 15_000)
    const events = ['metadata:updated', 'metadata:syncing', 'library:updated', 'connect']
    for (const event of events) socket?.on(event, load)
    return () => {
      mounted.current = false; request.current++
      clearInterval(timer)
      for (const event of events) socket?.off(event, load)
    }
  }, [socket, reload])
  return { snapshot, error, sync, fetching: fetching || !!snapshot?.syncing }
}
