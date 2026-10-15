import { useCallback, useEffect, useState } from 'react'
import { useSeriesProcess } from '@/hooks/useSeriesProcess'
import { SeriesProcessTracker } from '@/components/SeriesProcessTracker'
import { Link, useNavigate } from 'react-router-dom'
import { seriesApi, r2Api, stitchApi, Series, PhoneSendJob, PhoneSyncStatus, LARGE_CHAPTER_PAGES } from '@/lib/api'
import { useSocket } from '@/lib/socket'
import { PhoneSendStatusBar } from '@/components/PhoneSendStatusBar'
import { PhoneSendDialog } from '@/components/PhoneSendDialog'
import { PhonePullDialog } from '@/components/PhonePullDialog'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { 
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from '@/components/ui/checkbox'
import { Plus, BookOpen, Loader2, FolderInput, RefreshCw, Smartphone, Layers, Download } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'

const API_BASE = 'http://localhost:3002/api'

interface ScannedSeries {
  name: string
  folderPath: string
  chapterCount: number
  chapters: { number: number; pageCount: number }[]
}

export default function Library() {
  const [series, setSeries] = useState<Series[]>([])
  const [deleteTarget, setDeleteTarget] = useState<Series | null>(null)
  const [deleting, setDeleting] = useState(false)
  const { progress, error: progressError, reload: reloadProgress } = useSeriesProcess()
  const [loading, setLoading] = useState(true)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [importing, setImporting] = useState(false)
  const [scannedSeries, setScannedSeries] = useState<ScannedSeries[]>([])
  const [selectedForImport, setSelectedForImport] = useState<Set<string>>(new Set())
  const { toast } = useToast()

  // Chapters too long for the pipeline (normal ones are 14–20 pages), for the Stitch button's count.
  const [largeChapters, setLargeChapters] = useState(0)

  // Sending chapters to the Sleeper-Cell phone app through Cloudflare R2.
  const { socket } = useSocket()
  const navigate = useNavigate()
  const [sendOpen, setSendOpen] = useState(false)
  // Chapters the Master phone downloaded and sent, to bring in.
  const [pullOpen, setPullOpen] = useState(false)
  const [sendJob, setSendJob] = useState<PhoneSendJob | null>(null)
  const [dismissedJobId, setDismissedJobId] = useState<string | null>(null)

  // What the phone has of the chapters sent to it.
  const [phoneSync, setPhoneSync] = useState<PhoneSyncStatus | null>(null)
  const loadPhoneSync = useCallback(() => {
    r2Api.getPhoneSync().then(setPhoneSync).catch(() => {})
  }, [])

  useEffect(() => {
    loadSeries()
    // Pick up a send that is running, or finished while this page was closed (auto-send runs on its own).
    r2Api.getStatus().then(status => setSendJob(status.job)).catch(() => {})
    // From the server's copy of the phone's receipt. Nothing on window focus:
    // R2 operations must stay in the free tier.
    loadPhoneSync()
    stitchApi
      .getChapters()
      .then(rows => setLargeChapters(rows.filter(r => r.pageCount > LARGE_CHAPTER_PAGES && !r.stitched).length))
      .catch(() => {})
  }, [loadPhoneSync])

  // A finished send adds chapters the phone doesn't have yet.
  const sendFinished = sendJob !== null && sendJob.state !== 'running'
  useEffect(() => {
    if (sendFinished) loadPhoneSync()
  }, [sendFinished, sendJob?.id, loadPhoneSync])

  // Through the phone relay the phone reports each chapter it unpacks or clears.
  useEffect(() => {
    if (!socket) return
    const onReceipt = (event: { kind: string }) => {
      if (event.kind === 'sync') loadPhoneSync()
    }
    socket.on('phone:receipt', onReceipt)
    socket.on('library:updated', loadSeries)
    return () => {
      socket.off('phone:receipt', onReceipt)
      socket.off('library:updated', loadSeries)
    }
  }, [socket, loadPhoneSync])

  useEffect(() => {
    if (!socket) return
    const handleProgress = (job: PhoneSendJob) => setSendJob(job)
    socket.on('phone-send:progress', handleProgress)
    return () => {
      socket.off('phone-send:progress', handleProgress)
    }
  }, [socket])

  const handleOpenSend = async () => {
    try {
      const status = await r2Api.getStatus()
      if (!status.configured) {
        toast({
          title: 'Connect Cloudflare R2 first',
          description: 'Add your R2 credentials here, then come back to the Library to send chapters.'
        })
        navigate('/settings?tab=cloudflare')
        return
      }
      setSendJob(status.job)
      setSendOpen(true)
    } catch {
      toast({
        title: 'Error',
        description: 'Could not reach the server to check R2 settings',
        variant: 'destructive'
      })
    }
  }

  const markPart = async (item: Series, part: number, done: boolean) => {
    try {
      await seriesApi.markPart(item.id, part, done)
      reloadProgress()
      toast({ title: done ? `Part ${part} marked done` : `Part ${part} manual completion removed`, description: item.title })
    } catch (error) { toast({ title: 'Could not update part', description: error instanceof Error ? error.message : 'Please try again', variant: 'destructive' }) }
  }
  const deleteEverywhere = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await seriesApi.deleteEverywhere(deleteTarget.id)
      setDeleteTarget(null); await loadSeries(); reloadProgress()
      toast({ title: 'Deletion queued', description: 'The series will be removed from all synced devices and cloud storage.' })
    } catch (error) { toast({ title: 'Could not delete series', description: error instanceof Error ? error.message : 'Please try again', variant: 'destructive' }) }
    finally { setDeleting(false) }
  }

  const handleSend = async (picked: { seriesId: string; chapterIds: string[] }[]) => {
    try {
      setSendJob(await r2Api.sendToPhone(picked))
    } catch (error) {
      toast({
        title: 'Sending failed to start',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive'
      })
      throw error
    }
  }

  const handleCancelSend = async () => {
    try {
      const { job } = await r2Api.cancel()
      if (job) setSendJob(job)
    } catch {
      // The socket will still report the job's real state.
    }
  }

  const sendRunning = sendJob?.state === 'running'
  const showSendStatus = sendJob !== null && (sendRunning || sendJob.id !== dismissedJobId)

  const loadSeries = async () => {
    try {
      const data = await seriesApi.getAll()
      setSeries(data)
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to load series',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }

  const handleScanForImport = async () => {
    setScanning(true)
    setScannedSeries([])
    setSelectedForImport(new Set())
    
    try {
      const res = await fetch(`${API_BASE}/manual/import/scan`)
      if (!res.ok) throw new Error('Failed to scan')
      
      const data = await res.json()
      setScannedSeries(data.series || [])
      
      // Select all by default
      setSelectedForImport(new Set((data.series || []).map((s: ScannedSeries) => s.folderPath)))
      
      if (data.series?.length === 0) {
        toast({
          title: 'No series found',
          description: 'No new series found in the downloads folder'
        })
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to scan downloads folder',
        variant: 'destructive'
      })
    } finally {
      setScanning(false)
    }
  }

  const handleOpenImportDialog = () => {
    setImportDialogOpen(true)
    handleScanForImport()
  }

  const handleImport = async () => {
    if (selectedForImport.size === 0) {
      toast({
        title: 'Error',
        description: 'Please select at least one series to import',
        variant: 'destructive'
      })
      return
    }
    
    setImporting(true)
    
    try {
      const res = await fetch(`${API_BASE}/manual/import/series`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderNames: Array.from(selectedForImport)
        })
      })
      
      if (!res.ok) throw new Error('Failed to import')
      
      const result = await res.json()
      
      toast({
        title: 'Import Complete',
        description: result.message
      })
      
      setImportDialogOpen(false)
      loadSeries() // Refresh the library
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to import series',
        variant: 'destructive'
      })
    } finally {
      setImporting(false)
    }
  }

  const toggleSelectSeries = (folderPath: string) => {
    const newSelected = new Set(selectedForImport)
    if (newSelected.has(folderPath)) {
      newSelected.delete(folderPath)
    } else {
      newSelected.add(folderPath)
    }
    setSelectedForImport(newSelected)
  }

  const toggleSelectAll = () => {
    if (selectedForImport.size === scannedSeries.length) {
      setSelectedForImport(new Set())
    } else {
      setSelectedForImport(new Set(scannedSeries.map(s => s.folderPath)))
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="min-h-full flex flex-col">
    <div className="p-6 flex-1">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Library</h1>
          <p className="text-muted-foreground">
            {series.length} series in your collection
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleOpenSend} disabled={series.length === 0}>
            <Smartphone className="h-4 w-4 mr-2" />
            Send to phone
          </Button>
          <Button variant="outline" onClick={() => setPullOpen(true)} title="Chapters the Master phone downloaded and sent to R2">
            <Download className="h-4 w-4 mr-2" />
            Get from phones
          </Button>
          <Link to="/stitch">
            <Button variant="outline" title={`Chapters with more than ${LARGE_CHAPTER_PAGES} pages need stitching`}>
              <Layers className="h-4 w-4 mr-2" />
              Stitch Pages
              {largeChapters > 0 && (
                <Badge className="ml-2 border-transparent bg-amber-500 text-white hover:bg-amber-500">
                  {largeChapters}
                </Badge>
              )}
            </Button>
          </Link>
          <Button variant="outline" onClick={handleOpenImportDialog}>
            <FolderInput className="h-4 w-4 mr-2" />
            Import Existing
          </Button>
          <Link to="/add">
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Add Series
            </Button>
          </Link>
        </div>
      </div>

      {progressError && <div role="status" className="mb-4 flex items-center justify-between rounded-lg border border-amber-500/30 p-3 text-sm"><span>{progressError} Showing the last known status.</span><Button variant="ghost" size="sm" onClick={reloadProgress}>Retry</Button></div>}

      <PhonePullDialog open={pullOpen} onOpenChange={setPullOpen} onPulled={() => { loadSeries(); loadPhoneSync() }} />
      <Dialog open={deleteTarget !== null} onOpenChange={open => { if (!open && !deleting) setDeleteTarget(null) }}>
        <DialogContent><DialogHeader><DialogTitle>Delete “{deleteTarget?.title}” everywhere?</DialogTitle><DialogDescription>Permanently deletes this series, pages, scripts, audio, crops and exports from every synced device and cloud storage. Offline devices delete their copy when they reconnect with the updated app. This cannot be undone.</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" disabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="destructive" disabled={deleting} onClick={deleteEverywhere}>{deleting ? 'Deleting…' : 'Delete everywhere'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <PhoneSendDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        busy={sendRunning}
        onSend={handleSend}
      />

      {/* Import Dialog */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import Existing Series</DialogTitle>
            <DialogDescription>
              Scan the downloads folder for existing series and import them into your library.
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-4">
            {scanning ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span className="ml-3 text-muted-foreground">Scanning downloads folder...</span>
              </div>
            ) : scannedSeries.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <FolderInput className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p>No new series found in downloads folder</p>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={handleScanForImport}
                  className="mt-4"
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Scan Again
                </Button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm text-muted-foreground">
                    Found {scannedSeries.length} series
                  </span>
                  <Button variant="ghost" size="sm" onClick={toggleSelectAll}>
                    {selectedForImport.size === scannedSeries.length ? 'Deselect All' : 'Select All'}
                  </Button>
                </div>
                
                <ScrollArea className="h-80 border rounded-lg">
                  <div className="p-3 space-y-2">
                    {scannedSeries.map((s) => (
                      <div 
                        key={s.folderPath}
                        className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent cursor-pointer"
                        onClick={() => toggleSelectSeries(s.folderPath)}
                      >
                        <Checkbox 
                          checked={selectedForImport.has(s.folderPath)}
                          onCheckedChange={() => toggleSelectSeries(s.folderPath)}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{s.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {s.chapterCount} chapters • {s.chapters.reduce((acc, c) => acc + c.pageCount, 0)} total pages
                          </p>
                        </div>
                        <Badge variant="secondary">
                          Ch. {s.chapters[0]?.number || '?'} - {s.chapters[s.chapters.length - 1]?.number || '?'}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </>
            )}
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleImport}
              disabled={importing || selectedForImport.size === 0}
            >
              {importing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Importing...
                </>
              ) : (
                <>
                  <FolderInput className="h-4 w-4 mr-2" />
                  Import {selectedForImport.size} Series
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {series.length === 0 ? (
        <Card className="p-12 text-center">
          <BookOpen className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No series yet</h2>
          <p className="text-muted-foreground mb-4">
            Add your first manhwa series to get started
          </p>
          <Link to="/add">
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Add Series
            </Button>
          </Link>
        </Card>
      ) : (
        <SeriesProcessTracker series={series} progress={progress} phoneSync={phoneSync} onDelete={setDeleteTarget} onMarkPart={markPart} />
      )}
    </div>

      {showSendStatus && sendJob && (
        <div className="sticky bottom-0 z-20">
          <PhoneSendStatusBar
            job={sendJob}
            onCancel={handleCancelSend}
            onDismiss={() => setDismissedJobId(sendJob.id)}
          />
        </div>
      )}
    </div>
  )
}
