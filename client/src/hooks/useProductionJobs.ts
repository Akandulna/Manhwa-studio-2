import { useEffect, useState } from 'react'
import { productionApi, type ProductionJob } from '@/lib/api'
import { useSocket } from '@/lib/socket'

export function useProductionJobs() {
  const { socket } = useSocket()
  const [jobs, setJobs] = useState<Map<string, ProductionJob>>(new Map())
  useEffect(() => {
    let cancelled = false
    const load = () => { void productionApi.list().then(rows => { if (!cancelled) setJobs(new Map(rows.map(j => [j.seriesId, j]))) }).catch(() => {}) }
    const receive = (job: ProductionJob) => setJobs(previous => new Map(previous).set(job.seriesId, job))
    load()
    socket?.on('production:updated', receive)
    socket?.on('connect', load)
    return () => { cancelled = true; socket?.off('production:updated', receive); socket?.off('connect', load) }
  }, [socket])
  return jobs
}
