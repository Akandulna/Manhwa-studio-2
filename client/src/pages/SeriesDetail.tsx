import { useEffect, useState } from 'react'
import { usePublishedChapters } from '@/hooks/usePublishedChapters'
import { PublishedBadge, publishedRowClass } from '@/components/PublishedBadge'
import { useParams, useNavigate } from 'react-router-dom'
import { seriesApi, downloadsApi, chaptersApi, Series, Chapter } from '@/lib/api'
import { useSocket } from '@/lib/socket'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { 
  ArrowLeft, 
  Download, 
  Pause, 
  Play, 
  RotateCcw,
  FolderOpen,
  Loader2,
  BookOpen,
  Globe,
  Calendar,
  Check,
  X,
  Clock,
  AlertTriangle,
  Trash2,
  Plus,
  Link2,
  Pencil
} from 'lucide-react'

/**
 * Turn an example chapter URL into a fetch template by replacing the last
 * run of digits with the {n} placeholder. If the input already contains
 * {n} it is returned as-is (the user typed a template directly).
 */
function deriveUrlTemplate(input: string): string {
  const trimmed = input.trim()
  if (!trimmed || trimmed.includes('{n}')) return trimmed
  const match = trimmed.match(/\d+(?=\D*$)/)
  if (!match) return trimmed
  const idx = trimmed.lastIndexOf(match[0])
  return trimmed.slice(0, idx) + '{n}' + trimmed.slice(idx + match[0].length)
}

export default function SeriesDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()
  const { chapterProgress, chapterStatuses, queueStatus, lastStatusUpdate } = useSocket()
  
  // Chapters already rendered to video, so they are not re-downloaded or
  // reprocessed by mistake.
  const { isPublished } = usePublishedChapters(id)

  const [series, setSeries] = useState<Series | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set())
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  
  // Fetch more chapters state
  const [showFetchMore, setShowFetchMore] = useState(false)
  const [fetchFromChapter, setFetchFromChapter] = useState('')
  const [fetchToChapter, setFetchToChapter] = useState('')
  const [fetching, setFetching] = useState(false)

  // Source URL (urlTemplate) editing — needed when the series was imported
  // from a backup and has no URL pattern to resume fetching from.
  const [editingUrl, setEditingUrl] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [savingUrl, setSavingUrl] = useState(false)
  
  useEffect(() => {
    if (id) {
      loadSeries()
    }
  }, [id])
  
  const loadSeries = async () => {
    try {
      const data = await seriesApi.getById(id!)
      setSeries(data)
      
      // Auto-set fetch range to next chapters
      if (data.chapters && data.chapters.length > 0) {
        const maxChapter = Math.max(...data.chapters.map(c => c.number))
        setFetchFromChapter(String(Math.floor(maxChapter) + 1))
        setFetchToChapter(String(Math.floor(maxChapter) + 20))
      }
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
  
  // Refresh when chapter status changes
  useEffect(() => {
    if (lastStatusUpdate > 0) {
      loadSeries()
    }
  }, [lastStatusUpdate])
  
  // Refresh data periodically when downloading
  useEffect(() => {
    if (queueStatus.active > 0 || queueStatus.pending > 0) {
      const interval = setInterval(loadSeries, 5000)
      return () => clearInterval(interval)
    }
  }, [queueStatus])
  
  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'done':
        return <Badge variant="success"><Check className="h-3 w-3 mr-1" />Done</Badge>
      case 'failed':
        return <Badge variant="destructive"><X className="h-3 w-3 mr-1" />Failed</Badge>
      case 'downloading':
        return <Badge variant="default"><Loader2 className="h-3 w-3 mr-1 animate-spin" />Downloading</Badge>
      case 'queued':
        return <Badge variant="secondary"><Clock className="h-3 w-3 mr-1" />Queued</Badge>
      case 'skipped':
        return <Badge variant="outline">Skipped</Badge>
      default:
        return <Badge variant="outline">Pending</Badge>
    }
  }
  
  const handleSelectAll = () => {
    if (!series?.chapters) return
    const pending = series.chapters.filter(c => c.status === 'pending' || c.status === 'failed')
    setSelectedChapters(new Set(pending.map(c => c.id)))
  }
  
  const handleSelectNone = () => {
    setSelectedChapters(new Set())
  }
  
  const handleSelectRange = () => {
    if (!series?.chapters) return
    const start = parseFloat(rangeStart) || 0
    const end = parseFloat(rangeEnd) || Infinity
    
    const inRange = series.chapters.filter(c => 
      c.number >= start && c.number <= end &&
      (c.status === 'pending' || c.status === 'failed')
    )
    setSelectedChapters(new Set(inRange.map(c => c.id)))
  }
  
  const handleToggleChapter = (chapterId: string) => {
    const newSelected = new Set(selectedChapters)
    if (newSelected.has(chapterId)) {
      newSelected.delete(chapterId)
    } else {
      newSelected.add(chapterId)
    }
    setSelectedChapters(newSelected)
  }
  
  const handleDownloadSelected = async () => {
    if (selectedChapters.size === 0) return
    
    try {
      await downloadsApi.queueChapters(Array.from(selectedChapters))
      toast({
        title: 'Download Started',
        description: `Added ${selectedChapters.size} chapters to queue`
      })
      setSelectedChapters(new Set())
      loadSeries()
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to queue downloads',
        variant: 'destructive'
      })
    }
  }
  
  const handleRetryFailed = async () => {
    try {
      await downloadsApi.retryFailed(id)
      toast({
        title: 'Retry Started',
        description: 'Retrying failed chapters'
      })
      loadSeries()
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to retry chapters',
        variant: 'destructive'
      })
    }
  }
  
  const handleOpenFolder = async () => {
    if (!series) return
    try {
      await downloadsApi.openFolder(series.rootFolder)
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to open folder',
        variant: 'destructive'
      })
    }
  }
  
  const handleDeleteSeries = async () => {
    if (!series) return
    if (!confirm(`Delete "${series.title}"? This will remove the series from your library but not delete downloaded files.`)) {
      return
    }
    
    try {
      await seriesApi.delete(series.id)
      toast({
        title: 'Deleted',
        description: 'Series removed from library'
      })
      navigate('/')
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to delete series',
        variant: 'destructive'
      })
    }
  }
  
  const handleFetchMoreChapters = async () => {
    if (!series || !series.urlTemplate) {
      toast({
        title: 'Error',
        description: 'No URL template available for this series',
        variant: 'destructive'
      })
      return
    }
    
    const from = parseInt(fetchFromChapter) || 1
    const to = parseInt(fetchToChapter) || from + 19
    
    if (to < from) {
      toast({
        title: 'Error',
        description: 'End chapter must be >= start chapter',
        variant: 'destructive'
      })
      return
    }
    
    if (to - from > 200) {
      toast({
        title: 'Error',
        description: 'Maximum 200 chapters at once',
        variant: 'destructive'
      })
      return
    }
    
    setFetching(true)
    
    try {
      // Discover chapters in the range
      const result = await seriesApi.discoverChapters({
        template: series.urlTemplate,
        fromChapter: from,
        toChapter: to,
        padding: 0 // TODO: Could store padding in series
      })
      
      if (result.chapters.length === 0) {
        toast({
          title: 'No Chapters Found',
          description: `No valid chapters found between ${from} and ${to}`,
          variant: 'destructive'
        })
        return
      }
      
      // Add discovered chapters to series
      const chaptersToAdd = result.chapters.map(c => ({
        number: c.number,
        url: c.url,
        title: c.title
      }))
      
      await seriesApi.addChapters(series.id, chaptersToAdd)
      
      toast({
        title: 'Chapters Added',
        description: `Added ${chaptersToAdd.length} new chapters`
      })
      
      setShowFetchMore(false)
      loadSeries()
      
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to fetch chapters',
        variant: 'destructive'
      })
    } finally {
      setFetching(false)
    }
  }
  
  const handleSaveUrlTemplate = async () => {
    if (!series) return

    const template = deriveUrlTemplate(urlInput)

    if (!template) {
      toast({
        title: 'Error',
        description: 'Enter a chapter URL or template first',
        variant: 'destructive'
      })
      return
    }

    if (!template.includes('{n}')) {
      toast({
        title: 'Error',
        description: 'Could not find a chapter number in the URL. Paste a chapter URL (e.g. .../chapter-12) or use {n} to mark where the number goes.',
        variant: 'destructive'
      })
      return
    }

    setSavingUrl(true)

    try {
      await seriesApi.update(series.id, { urlTemplate: template })
      toast({
        title: 'Source URL Saved',
        description: 'You can now fetch more chapters for this series'
      })
      setEditingUrl(false)
      await loadSeries()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save URL',
        variant: 'destructive'
      })
    } finally {
      setSavingUrl(false)
    }
  }

  // Get real-time status for a chapter (combines DB status with socket updates)
  const getChapterStatus = (chapter: Chapter): string => {
    const socketStatus = chapterStatuses[chapter.id]
    return socketStatus?.status || chapter.status
  }
  
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }
  
  if (!series) {
    return (
      <div className="p-6 text-center">
        <h2 className="text-xl font-semibold">Series not found</h2>
        <Button variant="link" onClick={() => navigate('/')}>
          Return to Library
        </Button>
      </div>
    )
  }
  
  const chapters = series.chapters || []
  const doneCount = chapters.filter(c => c.status === 'done').length
  const failedCount = chapters.filter(c => c.status === 'failed').length
  const downloadingCount = chapters.filter(c => c.status === 'downloading' || c.status === 'queued').length
  
  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-start gap-6 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        
        <div className="flex-1">
          <h1 className="text-3xl font-bold mb-2">{series.title}</h1>
          
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-1">
              <Globe className="h-4 w-4" />
              {series.sourceSite}
            </div>
            <div className="flex items-center gap-1">
              <BookOpen className="h-4 w-4" />
              {chapters.length} chapters
            </div>
            <div className="flex items-center gap-1">
              <Calendar className="h-4 w-4" />
              Added {new Date(series.createdAt).toLocaleDateString()}
            </div>
          </div>
          
          {/* Progress bar */}
          <div className="mt-4 max-w-md">
            <div className="flex items-center justify-between text-sm mb-1">
              <span>{doneCount} of {chapters.length} downloaded</span>
              <span>{Math.round((doneCount / chapters.length) * 100)}%</span>
            </div>
            <Progress value={(doneCount / chapters.length) * 100} className="h-2" />
          </div>
        </div>
        
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleOpenFolder}>
            <FolderOpen className="h-4 w-4 mr-2" />
            Open Folder
          </Button>
          <Button variant="destructive" size="icon" onClick={handleDeleteSeries}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      
      {/* Actions */}
      <Card className="mb-6">
        <CardContent className="py-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleSelectAll}>
                Select Pending
              </Button>
              <Button variant="outline" size="sm" onClick={handleSelectNone}>
                Clear
              </Button>
            </div>
            
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Range:</span>
              <Input
                type="number"
                className="w-20 h-8"
                placeholder="From"
                value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value)}
              />
              <span>-</span>
              <Input
                type="number"
                className="w-20 h-8"
                placeholder="To"
                value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value)}
              />
              <Button variant="outline" size="sm" onClick={handleSelectRange}>
                Apply
              </Button>
            </div>
            
            <div className="flex-1" />
            
            <div className="flex items-center gap-2">
              {failedCount > 0 && (
                <Button variant="outline" onClick={handleRetryFailed}>
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Retry Failed ({failedCount})
                </Button>
              )}
              <Button 
                onClick={handleDownloadSelected}
                disabled={selectedChapters.size === 0}
              >
                <Download className="h-4 w-4 mr-2" />
                Download ({selectedChapters.size})
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      
      {/* Chapter list */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              Chapters
              {downloadingCount > 0 && (
                <Badge variant="default">
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  {downloadingCount} downloading
                </Badge>
              )}
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const next = !showFetchMore
                if (next) {
                  setUrlInput(series.urlTemplate || '')
                  setEditingUrl(!series.urlTemplate)
                }
                setShowFetchMore(next)
              }}
            >
              <Plus className="h-4 w-4 mr-2" />
              Fetch More Chapters
            </Button>
          </div>
          
          {/* Fetch More Chapters Panel */}
          {showFetchMore && (
            <div className="mt-4 p-4 border rounded-lg bg-muted/50">
              {!series.urlTemplate || editingUrl ? (
                /* Source URL setup — required to resume fetching (e.g. after a backup import) */
                <div>
                  {!series.urlTemplate && (
                    <p className="text-sm font-medium mb-1 flex items-center gap-2">
                      <Link2 className="h-4 w-4" />
                      Set the source URL to enable fetching
                    </p>
                  )}
                  <label className="text-sm font-medium">Chapter URL</label>
                  <div className="flex items-center gap-2 mt-1">
                    <Input
                      type="text"
                      className="flex-1 h-9"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      placeholder="https://example.com/series-name/chapter-12"
                    />
                    <Button onClick={handleSaveUrlTemplate} disabled={savingUrl}>
                      {savingUrl ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        'Save URL'
                      )}
                    </Button>
                    {series.urlTemplate && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setUrlInput(series.urlTemplate || '')
                          setEditingUrl(false)
                        }}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  {(() => {
                    const derived = deriveUrlTemplate(urlInput)
                    if (derived && derived !== urlInput.trim() && derived.includes('{n}')) {
                      return (
                        <p className="text-xs text-muted-foreground mt-2">
                          Pattern: <code className="text-foreground">{derived}</code>
                        </p>
                      )
                    }
                    return null
                  })()}
                  <p className="text-xs text-muted-foreground mt-2">
                    Paste the URL of any chapter — the chapter number is detected automatically.
                    You can also type the pattern directly using <code>{'{n}'}</code> where the number goes.
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex items-end gap-4">
                    <div>
                      <label className="text-sm font-medium">From Chapter</label>
                      <Input
                        type="number"
                        className="w-24 h-9 mt-1"
                        value={fetchFromChapter}
                        onChange={(e) => setFetchFromChapter(e.target.value)}
                        placeholder="1"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium">To Chapter</label>
                      <Input
                        type="number"
                        className="w-24 h-9 mt-1"
                        value={fetchToChapter}
                        onChange={(e) => setFetchToChapter(e.target.value)}
                        placeholder="20"
                      />
                    </div>
                    <Button onClick={handleFetchMoreChapters} disabled={fetching}>
                      {fetching ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Checking...
                        </>
                      ) : (
                        'Fetch & Add'
                      )}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setShowFetchMore(false)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground mt-2">
                    <span>Source:</span>
                    <code className="text-foreground">{series.urlTemplate}</code>
                    <button
                      className="ml-1 inline-flex items-center gap-1 hover:text-foreground underline"
                      onClick={() => {
                        setUrlInput(series.urlTemplate || '')
                        setEditingUrl(true)
                      }}
                    >
                      <Pencil className="h-3 w-3" />
                      Edit
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Discovers chapters in this range using the series URL pattern. Max 200 chapters at a time.
                  </p>
                </>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[calc(100vh-450px)]">
            <div className="space-y-2">
              {chapters.map((chapter) => {
                const progress = chapterProgress[chapter.id]
                const currentStatus = getChapterStatus(chapter)
                const isSelectable = currentStatus === 'pending' || currentStatus === 'failed'
                
                return (
                  <div 
                    key={chapter.id}
                    className={`
                      flex items-center gap-4 p-3 rounded-lg border
                      ${isSelectable ? 'hover:bg-accent cursor-pointer' : ''}
                      ${selectedChapters.has(chapter.id) ? 'bg-accent border-primary' : ''}
                      ${isPublished(chapter.id) ? publishedRowClass : ''}
                    `}
                    onClick={() => isSelectable && handleToggleChapter(chapter.id)}
                  >
                    {isSelectable && (
                      <Checkbox
                        checked={selectedChapters.has(chapter.id)}
                        onCheckedChange={() => handleToggleChapter(chapter.id)}
                      />
                    )}
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">Chapter {chapter.number}</span>
                        {chapter.title && (
                          <span className="text-sm text-muted-foreground truncate">
                            - {chapter.title}
                          </span>
                        )}
                      </div>
                      
                      {progress && (
                        <div className="mt-1">
                          <Progress value={progress.percent} className="h-1" />
                          <span className="text-xs text-muted-foreground">
                            {progress.downloaded}/{progress.total} pages
                          </span>
                        </div>
                      )}
                      
                      {chapter.error && (
                        <div className="flex items-center gap-1 mt-1 text-xs text-destructive">
                          <AlertTriangle className="h-3 w-3" />
                          {chapter.error}
                        </div>
                      )}
                    </div>
                    
                    <div className="flex items-center gap-2">
                      {chapter.pageCount && currentStatus === 'done' && (
                        <span className="text-sm text-muted-foreground">
                          {chapter.downloadedCount}/{chapter.pageCount} pages
                        </span>
                      )}
                      {isPublished(chapter.id) && <PublishedBadge />}
                      {getStatusBadge(currentStatus)}
                    </div>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}
