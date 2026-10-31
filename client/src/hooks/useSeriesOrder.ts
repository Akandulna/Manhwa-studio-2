import { useEffect, useMemo, useState } from 'react'
import { useSocket } from '@/lib/socket'

type ActivitySeries = { rootFolder?: string; lastActivityAt?: string; createdAt?: string }
const time = (value?: string) => Date.parse(value ?? '') || 0

/** Keep every module in the same activity order, including live phone work. */
export function useSeriesOrder<T extends ActivitySeries>(series: T[]): T[] {
  const { socket } = useSocket()
  const [activity, setActivity] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!socket) return
    const changed = (times: Record<string, string>) => setActivity(previous => {
      const next = { ...previous }
      let updated = false
      for (const [folder, at] of Object.entries(times)) if (time(at) > time(next[folder])) { next[folder] = at; updated = true }
      return updated ? next : previous
    })
    socket.on('series:activity', changed)
    return () => { socket.off('series:activity', changed) }
  }, [socket])
  return useMemo(() => {
    const last = (row: T) => Math.max(time(row.lastActivityAt), time(row.createdAt), time(activity[row.rootFolder?.split(/[\\/]/).pop() ?? '']))
    return [...series].sort((a, b) => last(b) - last(a))
  }, [series, activity])
}
