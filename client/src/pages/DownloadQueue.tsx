import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { downloadsApi, seriesApi, Series, DownloadStats } from '@/lib/api'
import { useSocket } from '@/lib/socket'
import { formatBytes } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { useToast } from '@/components/ui/use-toast'
import { 
  Pause, 
  Play, 
  X, 
  RotateCcw,
  Download,
  CheckCircle,
  XCircle,
  Clock,
  Loader2,
  HardDrive
} from 'lucide-react'

export default function DownloadQueue() {
  const { toast } = useToast()
  const { queueStatus, chapterProgress } = useSocket()
  const [stats, setStats] = useState<DownloadStats | null>(null)
  const [series, setSeries] = useState<Series[]>([])
  const [loading, setLoading] = useState(true)
  
  useEffect(() => {
    loadData()
  }, [])
  
  useEffect(() => {
    // Refresh stats when queue changes
    const interval = setInterval(loadData, 10000)
    return () => clearInterval(interval)
  }, [queueStatus])
  
  const loadData = async () => {
    try {
      const [statsData, seriesData] = await Promise.all([
        downloadsApi.getStats(),
        seriesApi.getAll()
      ])
      setStats(statsData)
      setSeries(seriesData)
    } catch (error) {
      console.error('Failed to load data:', error)
    } finally {
      setLoading(false)
    }
  }
  
  const handlePause = async () => {
    try {
      await downloadsApi.pause()
      toast({ title: 'Downloads paused' })
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to pause', variant: 'destructive' })
    }
  }
  
  const handleResume = async () => {
    try {
      await downloadsApi.resume()
      toast({ title: 'Downloads resumed' })
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to resume', variant: 'destructive' })
    }
  }
  
  const handleClear = async () => {
    try {
      await downloadsApi.clear()
      toast({ title: 'Queue cleared' })
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to clear queue', variant: 'destructive' })
    }
  }
  
  const handleRetryAll = async () => {
    try {
      await downloadsApi.retryFailed()
      toast({ title: 'Retrying failed downloads' })
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to retry', variant: 'destructive' })
    }
  }
  
  const activeDownloads = queueStatus.pending + queueStatus.active
  const totalProgress = Object.values(chapterProgress)
  
  // Get series with active downloads
  const activeSeries = series.filter(s => 
    s.statusCounts && (s.statusCounts.downloading > 0 || s.statusCounts.queued > 0)
  )
  
  // Get series with failed downloads
  const failedSeries = series.filter(s => 
    s.statusCounts && s.statusCounts.failed > 0
  )
  
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }
  
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Download Queue</h1>
          <p className="text-muted-foreground">
            Manage your active downloads
          </p>
        </div>
        
        <div className="flex items-center gap-2">
          {queueStatus.isPaused ? (
            <Button onClick={handleResume}>
              <Play className="h-4 w-4 mr-2" />
              Resume
            </Button>
          ) : (
            <Button variant="outline" onClick={handlePause} disabled={activeDownloads === 0}>
              <Pause className="h-4 w-4 mr-2" />
              Pause
            </Button>
          )}
          <Button variant="outline" onClick={handleClear} disabled={activeDownloads === 0}>
            <X className="h-4 w-4 mr-2" />
            Clear Queue
          </Button>
        </div>
      </div>
      
      {/* Stats cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-full bg-primary/10">
                <Download className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold">{activeDownloads}</p>
                <p className="text-sm text-muted-foreground">In Queue</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-full bg-green-500/10">
                <CheckCircle className="h-6 w-6 text-green-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats?.completed || 0}</p>
                <p className="text-sm text-muted-foreground">Completed</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-full bg-destructive/10">
                <XCircle className="h-6 w-6 text-destructive" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats?.failed || 0}</p>
                <p className="text-sm text-muted-foreground">Failed</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-full bg-secondary">
                <HardDrive className="h-6 w-6 text-muted-foreground" />
              </div>
              <div>
                <p className="text-2xl font-bold">{formatBytes(stats?.totalBytes || 0)}</p>
                <p className="text-sm text-muted-foreground">Downloaded</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      
      {/* Queue status */}
      {queueStatus.isPaused && (
        <Card className="border-amber-500 bg-amber-500/5">
          <CardContent className="py-4">
            <div className="flex items-center gap-3">
              <Pause className="h-5 w-5 text-amber-500" />
              <span className="font-medium">Downloads are paused</span>
              <Button size="sm" onClick={handleResume} className="ml-auto">
                Resume
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      
      {/* Active downloads */}
      {activeSeries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              Active Downloads
            </CardTitle>
            <CardDescription>
              {queueStatus.active} downloading, {queueStatus.pending} in queue
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {activeSeries.map(s => {
              const downloading = s.statusCounts?.downloading || 0
              const queued = s.statusCounts?.queued || 0
              const done = s.statusCounts?.done || 0
              const total = s.chapterCount || 0
              
              return (
                <Link to={`/series/${s.id}`} key={s.id}>
                  <div className="p-4 rounded-lg border hover:bg-accent transition-colors">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium">{s.title}</span>
                      <Badge variant="default">
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        {downloading} downloading, {queued} queued
                      </Badge>
                    </div>
                    <Progress value={(done / total) * 100} className="h-2" />
                    <p className="text-xs text-muted-foreground mt-1">
                      {done} of {total} chapters complete
                    </p>
                  </div>
                </Link>
              )
            })}
          </CardContent>
        </Card>
      )}
      
      {/* Failed downloads */}
      {failedSeries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-destructive" />
              Failed Downloads
            </CardTitle>
            <CardDescription>
              {stats?.failed || 0} chapters failed to download
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {failedSeries.map(s => (
              <Link to={`/series/${s.id}`} key={s.id}>
                <div className="p-4 rounded-lg border border-destructive/20 hover:bg-accent transition-colors">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{s.title}</span>
                    <Badge variant="destructive">
                      {s.statusCounts?.failed} failed
                    </Badge>
                  </div>
                </div>
              </Link>
            ))}
            
            <Button variant="outline" onClick={handleRetryAll} className="w-full">
              <RotateCcw className="h-4 w-4 mr-2" />
              Retry All Failed
            </Button>
          </CardContent>
        </Card>
      )}
      
      {/* Empty state */}
      {activeDownloads === 0 && failedSeries.length === 0 && (
        <Card className="p-12 text-center">
          <Download className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No active downloads</h2>
          <p className="text-muted-foreground mb-4">
            Select chapters from your library to start downloading
          </p>
          <Link to="/">
            <Button>Go to Library</Button>
          </Link>
        </Card>
      )}
    </div>
  )
}
