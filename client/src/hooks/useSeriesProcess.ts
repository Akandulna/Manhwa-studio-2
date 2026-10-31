import { useCallback, useEffect, useState } from 'react'
import { libraryProgressApi, type ProcessSnapshot } from '@/lib/api'
import { useSocket } from '@/lib/socket'

export function useSeriesProcess() {
  const { socket } = useSocket()
  const [progress, setProgress] = useState<ProcessSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const receive = useCallback((value: ProcessSnapshot) => {
    setProgress(previous => previous && Date.parse(previous.updatedAt) > Date.parse(value.updatedAt) ? previous : value)
    setError(null)
  }, [])
  const load = useCallback(() => {
    void libraryProgressApi.get().then(receive).catch(() => setError('Could not load process progress.'))
  }, [receive])
  useEffect(() => {
    load()
    if (!socket) return
    socket.on('series-process:updated', receive)
    socket.on('connect', load)
    socket.on('library:updated', load)
    return () => {
      socket.off('series-process:updated', receive)
      socket.off('connect', load)
      socket.off('library:updated', load)
    }
  }, [socket, load, receive])
  return { progress, error, reload: load }
}
