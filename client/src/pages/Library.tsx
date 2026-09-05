import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { seriesApi, videoApi, Series } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
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
import { Plus, BookOpen, Globe, CheckCircle, XCircle, Clock, Loader2, FolderInput, RefreshCw } from 'lucide-react'
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
  const [videoStatus, setVideoStatus] = useState<Record<string, 'draft' | 'exported'>>({})
  const [loading, setLoading] = useState(true)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [importing, setImporting] = useState(false)
  const [scannedSeries, setScannedSeries] = useState<ScannedSeries[]>([])
  const [selectedForImport, setSelectedForImport] = useState<Set<string>>(new Set())
  const { toast } = useToast()

  useEffect(() => {
    loadSeries()
  }, [])

  const loadSeries = async () => {
    try {
      const data = await seriesApi.getAll()
      setSeries(data)
      videoApi.getSeriesStatus().then(setVideoStatus).catch(() => {})
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

  const getStatusInfo = (statusCounts: Series['statusCounts']) => {
    if (!statusCounts) return { label: 'Unknown', variant: 'outline' as const, progress: 0 }
    
    const total = Object.values(statusCounts).reduce((a, b) => a + b, 0)
    const done = statusCounts.done
    const failed = statusCounts.failed
    const downloading = statusCounts.downloading + statusCounts.queued
    
    if (downloading > 0) {
      return {
        label: `Downloading (${downloading})`,
        variant: 'default' as const,
        progress: Math.round((done / total) * 100)
      }
    }
    
    if (failed > 0) {
      return {
        label: `${failed} Failed`,
        variant: 'destructive' as const,
        progress: Math.round((done / total) * 100)
      }
    }
    
    if (done === total) {
      return {
        label: 'Complete',
        variant: 'success' as const,
        progress: 100
      }
    }
    
    return {
      label: `${done}/${total} Done`,
      variant: 'secondary' as const,
      progress: Math.round((done / total) * 100)
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
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Library</h1>
          <p className="text-muted-foreground">
            {series.length} series in your collection
          </p>
        </div>
        <div className="flex gap-2">
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {series.map((s) => {
            const status = getStatusInfo(s.statusCounts)
            
            return (
              <Link to={`/series/${s.id}`} key={s.id}>
                <Card className="h-full hover:shadow-lg transition-shadow cursor-pointer overflow-hidden">
                  {/* Cover image placeholder */}
                  <div className="aspect-[3/4] bg-gradient-to-br from-primary/20 to-primary/5 relative">
                    <div className="absolute inset-0 flex items-center justify-center">
                      <BookOpen className="h-16 w-16 text-primary/30" />
                    </div>
                    <div className="absolute bottom-2 right-2">
                      <Badge variant={status.variant}>
                        {status.label}
                      </Badge>
                    </div>
                    {videoStatus[s.id] && (
                      <div className="absolute top-2 left-2">
                        <Badge variant={videoStatus[s.id] === 'exported' ? 'success' : 'secondary'}>
                          {videoStatus[s.id] === 'exported' ? '🎬 Exported' : '🎬 Draft'}
                        </Badge>
                      </div>
                    )}
                  </div>
                  
                  <CardContent className="p-4">
                    <h3 className="font-semibold text-lg truncate mb-1">
                      {s.title}
                    </h3>
                    
                    <div className="flex items-center gap-1 text-sm text-muted-foreground mb-3">
                      <Globe className="h-3 w-3" />
                      <span className="truncate">{s.sourceSite}</span>
                    </div>
                    
                    <div className="flex items-center justify-between text-sm mb-2">
                      <span>{s.chapterCount} chapters</span>
                      <span>{status.progress}%</span>
                    </div>
                    
                    <Progress value={status.progress} className="h-1" />
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
