/**
 * Series Script View Page
 * 
 * Shows all chapters for a series with their script status,
 * part groupings, and generation controls.
 */

import { useEffect, useRef, useState } from 'react'
import { usePublishedChapters } from '@/hooks/usePublishedChapters'
import { PublishedBadge, publishedRowClass } from '@/components/PublishedBadge'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { narrationApi, voiceoverApi, NarrationSeriesDetail, NarrationChapterSummary, AIStatus } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/lib/socket'
import {
  ArrowLeft,
  FileText,
  Wand2,
  FolderOpen,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  Flag,
  Play,
  Download,
  RefreshCw,
  Volume2
} from 'lucide-react'

/** Short human label for the current pipeline stage, shown in the chapter row. */
function describeVoiceoverRun(run: VoiceoverRun): string {
  switch (run.stage) {
    case 'splitting':
      return 'Splitting script...'
    case 'split':
      return `Split into ${run.totalSections} sections`
    case 'generating':
      return `Generating ${run.totalSections} sections...`
    case 'generated':
      return `Voiced ${run.generated}/${run.totalSections}`
    case 'aligning':
      return `Aligning ${run.aligned ?? 0}/${run.totalSections}...`
    case 'complete':
      return `Done - ${run.aligned} aligned`
    case 'failed':
      return 'Failed'
  }
}

// Backstop for a single chapter in the bulk queue. Generation plus alignment on
// a long chapter runs several minutes; this only fires if a socket event is lost.
const BULK_CHAPTER_TIMEOUT_MS = 30 * 60 * 1000

/** Progress of the series-wide sequential voiceover run. */
interface BulkVoiceoverState {
  total: number
  completed: number
  failed: number
  currentChapterNumber: number | null
  cancelling: boolean
}

/** Live state of a one-click voiceover run for a single chapter. */
interface VoiceoverRun {
  stage: 'splitting' | 'split' | 'generating' | 'generated' | 'aligning' | 'complete' | 'failed'
  totalSections?: number
  generated?: number
  aligned?: number
  failed?: number
  alignFailed?: number
  error?: string
}

export default function SeriesScriptView() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()
  const { socket, narrationProgress, narrationRangeProgress, narrationRangeComplete } = useSocket()

  const [series, setSeries] = useState<NarrationSeriesDetail | null>(null)

  // Chapters already rendered to video — no need to rewrite or re-voice them.
  const { isPublished } = usePublishedChapters(id)
  const [aiStatus, setAIStatus] = useState<AIStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  
  // Range generation
  const [rangeFrom, setRangeFrom] = useState('')
  const [rangeTo, setRangeTo] = useState('')

  // One-click voiceover pipeline, keyed by chapter id so several chapters can
  // report progress independently in the list.
  const [voiceoverRuns, setVoiceoverRuns] = useState<Record<string, VoiceoverRun>>({})

  // Series-wide "Generate All Voiceover" run. Chapters are processed strictly
  // one after another: the TTS provider and the aligner are both single
  // resources, so overlapping chapters would only cause contention.
  const [bulkVoiceover, setBulkVoiceover] = useState<BulkVoiceoverState | null>(null)
  // Lets the queue await the chapter currently in flight. The socket handler
  // resolves it when that chapter reports complete/failed.
  const bulkWaiterRef = useRef<((outcome: 'complete' | 'failed') => void) | null>(null)
  const bulkCancelRef = useRef(false)

  useEffect(() => {
    if (id) {
      loadData()
    }
  }, [id])

  // Live progress for one-click voiceover runs started from this page.
  useEffect(() => {
    if (!socket) return

    const handlePipeline = (data: VoiceoverRun & { chapterId: string }) => {
      const { chapterId, ...run } = data
      setVoiceoverRuns(prev => ({ ...prev, [chapterId]: run }))

      if (run.stage === 'complete') {
        // Release the bulk queue first, so the next chapter starts immediately.
        bulkWaiterRef.current?.('complete')

        const alignNote = run.alignFailed
          ? `, ${run.alignFailed} timeline(s) failed`
          : ''
        toast({
          title: 'Voiceover Complete',
          description: `${run.generated}/${run.totalSections} sections voiced, ${run.aligned} aligned${alignNote}`
        })
        loadData()
        // Leave the finished badge up briefly, then fall back to the normal
        // voiceover status badge that loadData() has just refreshed.
        setTimeout(() => {
          setVoiceoverRuns(prev => {
            const next = { ...prev }
            delete next[chapterId]
            return next
          })
        }, 6000)
      }

      if (run.stage === 'failed') {
        bulkWaiterRef.current?.('failed')

        toast({
          title: 'Voiceover Failed',
          description: run.error || 'The voiceover pipeline failed',
          variant: 'destructive'
        })
        loadData()
      }
    }

    socket.on('voiceover:pipeline', handlePipeline)
    return () => {
      socket.off('voiceover:pipeline', handlePipeline)
    }
  }, [socket, id])

  // Reload when generation completes
  useEffect(() => {
    if (narrationRangeComplete) {
      loadSeries()
      setGenerating(false)
      
      if (narrationRangeComplete.success) {
        toast({
          title: 'Generation Complete',
          description: `Successfully generated ${narrationRangeComplete.completed} scripts`
        })
      } else {
        toast({
          title: 'Generation Incomplete',
          description: `Completed ${narrationRangeComplete.completed}, failed ${narrationRangeComplete.failed}`,
          variant: 'destructive'
        })
      }
    }
  }, [narrationRangeComplete])

  // Reload when single chapter completes
  useEffect(() => {
    if (narrationProgress?.stage === 'done') {
      loadSeries()
    }
  }, [narrationProgress])

  const loadData = async () => {
    try {
      const [seriesData, aiData] = await Promise.all([
        narrationApi.getSeriesDetail(id!),
        narrationApi.getAIStatus()
      ])
      setSeries(seriesData)
      setAIStatus(aiData)
      
      // Set default range
      if (seriesData.chapters.length > 0) {
        const firstUnscripted = seriesData.chapters.find(c => !c.script || c.script.status === 'none' || c.script.status === 'failed')
        if (firstUnscripted) {
          setRangeFrom(String(firstUnscripted.number))
          setRangeTo(String(Math.min(firstUnscripted.number + 4, seriesData.chapters[seriesData.chapters.length - 1].number)))
        }
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

  const loadSeries = async () => {
    try {
      const data = await narrationApi.getSeriesDetail(id!)
      setSeries(data)
    } catch (error) {
      console.error('Failed to reload series:', error)
    }
  }

  const handleGenerateChapter = async (chapterId: string) => {
    if (!aiStatus?.configured) {
      toast({
        title: 'AI Not Configured',
        description: 'Set GEMINI_API_KEY in .env or use Manual mode',
        variant: 'destructive'
      })
      return
    }

    setGenerating(true)
    try {
      await narrationApi.generateScript(chapterId)
      toast({
        title: 'Generation Started',
        description: 'Check progress in the chapter card'
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to start generation',
        variant: 'destructive'
      })
      setGenerating(false)
    }
  }

  const handleGenerateRange = async () => {
    if (!aiStatus?.configured) {
      toast({
        title: 'AI Not Configured',
        description: 'Set GEMINI_API_KEY in .env or use Manual mode',
        variant: 'destructive'
      })
      return
    }

    const from = parseFloat(rangeFrom)
    const to = parseFloat(rangeTo)
    
    if (isNaN(from) || isNaN(to) || from > to) {
      toast({
        title: 'Invalid Range',
        description: 'Please enter valid chapter numbers',
        variant: 'destructive'
      })
      return
    }

    setGenerating(true)
    try {
      await narrationApi.generateRange(id!, from, to)
      toast({
        title: 'Range Generation Started',
        description: `Generating chapters ${from} to ${to}`
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to start generation',
        variant: 'destructive'
      })
      setGenerating(false)
    }
  }

  const handleExportPart = async (partNumber: number) => {
    try {
      const result = await narrationApi.exportPart(id!, partNumber)
      if (result.success) {
        toast({
          title: 'Part Exported',
          description: `Saved to: ${result.path}`
        })
      }
    } catch (error) {
      toast({
        title: 'Export Failed',
        description: error instanceof Error ? error.message : 'Failed to export part',
        variant: 'destructive'
      })
    }
  }

  const handleOpenFolder = async () => {
    if (!series) return
    try {
      await narrationApi.openFolder(series.rootFolder)
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to open folder',
        variant: 'destructive'
      })
    }
  }

  /**
   * Start the one-click voiceover run for a chapter: split -> generate -> align.
   * The request returns immediately; everything after is socket-driven.
   */
  const handleGenerateVoiceover = async (chapter: NarrationChapterSummary) => {
    setVoiceoverRuns(prev => ({ ...prev, [chapter.id]: { stage: 'splitting' } }))
    try {
      await voiceoverApi.runPipeline(chapter.id)
      toast({
        title: 'Voiceover Started',
        description: `Chapter ${chapter.number}: splitting script, then generating audio`
      })
    } catch (error) {
      setVoiceoverRuns(prev => {
        const next = { ...prev }
        delete next[chapter.id]
        return next
      })
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to start voiceover',
        variant: 'destructive'
      })
    }
  }

  /**
   * Chapters eligible for a voiceover run: script is ready, and the chapter is
   * not already fully voiced. Published chapters are skipped - they are already
   * rendered, and re-voicing would invalidate the video.
   */
  const getVoiceableChapters = (): NarrationChapterSummary[] =>
    (series?.chapters ?? []).filter(
      c =>
        (c.script?.status === 'done' || c.script?.status === 'edited') &&
        c.voiceover.status !== 'done' &&
        !isPublished(c.id)
    )

  /**
   * Run the voiceover pipeline across every eligible chapter, strictly one at a
   * time. Each chapter is started via the same endpoint the per-row button uses,
   * then awaited until its socket reports complete/failed before moving on.
   */
  const handleGenerateAllVoiceover = async () => {
    const queue = getVoiceableChapters()
    if (queue.length === 0) return

    bulkCancelRef.current = false
    setBulkVoiceover({
      total: queue.length,
      completed: 0,
      failed: 0,
      currentChapterNumber: null,
      cancelling: false
    })

    for (const chapter of queue) {
      if (bulkCancelRef.current) break

      setBulkVoiceover(prev =>
        prev ? { ...prev, currentChapterNumber: chapter.number } : prev
      )

      // Wait for this chapter's pipeline to report a terminal stage. The socket
      // handler resolves the waiter; the timeout is a backstop so a dropped
      // event cannot wedge the queue forever.
      const outcome = await new Promise<'complete' | 'failed'>(resolve => {
        let settled = false
        const finish = (value: 'complete' | 'failed') => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          bulkWaiterRef.current = null
          resolve(value)
        }

        const timer = setTimeout(() => finish('failed'), BULK_CHAPTER_TIMEOUT_MS)
        bulkWaiterRef.current = finish

        voiceoverApi.runPipeline(chapter.id).catch(error => {
          toast({
            title: `Chapter ${chapter.number} Failed to Start`,
            description: error instanceof Error ? error.message : 'Could not start voiceover',
            variant: 'destructive'
          })
          finish('failed')
        })
      })

      setBulkVoiceover(prev =>
        prev
          ? {
              ...prev,
              completed: prev.completed + (outcome === 'complete' ? 1 : 0),
              failed: prev.failed + (outcome === 'failed' ? 1 : 0)
            }
          : prev
      )
    }

    setBulkVoiceover(prev => {
      if (prev) {
        toast({
          title: bulkCancelRef.current ? 'Voiceover Stopped' : 'All Voiceovers Complete',
          description: `${prev.completed} chapter(s) voiced${prev.failed ? `, ${prev.failed} failed` : ''}`
        })
      }
      return null
    })

    bulkCancelRef.current = false
    loadData()
  }

  /** Stop after the chapter currently in flight finishes. */
  const handleStopBulkVoiceover = () => {
    bulkCancelRef.current = true
    setBulkVoiceover(prev => (prev ? { ...prev, cancelling: true } : prev))
  }

  const getStatusBadge = (chapter: NarrationChapterSummary) => {
    // Check if this chapter is currently being generated
    if (narrationProgress?.chapterId === chapter.id) {
      const stage = narrationProgress.stage
      let label = 'Generating...'
      
      if (stage === 'preprocessing') {
        label = `Preprocessing ${narrationProgress.preprocessPercent || 0}%`
      } else if (stage === 'extracting-beats') {
        label = `Batch ${narrationProgress.batchCurrent}/${narrationProgress.batchTotal}`
      } else if (stage === 'generating-script') {
        label = 'Creating script...'
      } else if (stage === 'generating-summary') {
        label = 'Summarizing...'
      } else if (stage === 'saving') {
        label = 'Saving...'
      }
      
      return (
        <Badge variant="default" className="flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          {label}
        </Badge>
      )
    }

    const status = chapter.script?.status
    
    switch (status) {
      case 'done':
        return (
          <Badge variant="success" className="flex items-center gap-1">
            <CheckCircle className="h-3 w-3" />
            Done
          </Badge>
        )
      case 'edited':
        return (
          <Badge variant="default" className="flex items-center gap-1 bg-blue-500">
            <FileText className="h-3 w-3" />
            Edited
          </Badge>
        )
      case 'stale':
        return (
          <Badge variant="outline" className="flex items-center gap-1 border-yellow-500 text-yellow-500">
            <RefreshCw className="h-3 w-3" />
            Stale
          </Badge>
        )
      case 'failed':
        return (
          <Badge variant="destructive" className="flex items-center gap-1">
            <XCircle className="h-3 w-3" />
            Failed
          </Badge>
        )
      case 'generating':
        return (
          <Badge variant="default" className="flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Generating
          </Badge>
        )
      default:
        return (
          <Badge variant="outline" className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            Pending
          </Badge>
        )
    }
  }

  // Group chapters by part
  const getChaptersByPart = () => {
    if (!series) return []
    
    const parts: { partNumber: number; chapters: NarrationChapterSummary[] }[] = []
    let currentPart: NarrationChapterSummary[] = []
    let partNumber = 1
    
    for (const chapter of series.chapters) {
      currentPart.push(chapter)
      
      if (chapter.script?.isPartEnd) {
        parts.push({ partNumber, chapters: currentPart })
        currentPart = []
        partNumber++
      }
    }
    
    // Add remaining chapters
    if (currentPart.length > 0) {
      parts.push({ partNumber, chapters: currentPart })
    }
    
    return parts
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
        <Button variant="link" onClick={() => navigate('/narration')}>
          Return to Library
        </Button>
      </div>
    )
  }

  const scriptedCount = series.chapters.filter(c => 
    c.script?.status === 'done' || c.script?.status === 'edited'
  ).length
  const progress = series.chapters.length > 0 
    ? Math.round((scriptedCount / series.chapters.length) * 100)
    : 0

  const parts = getChaptersByPart()
  const voiceableCount = getVoiceableChapters().length

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-start gap-6 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate('/narration')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        
        <div className="flex-1">
          <h1 className="text-3xl font-bold mb-2">{series.title}</h1>
          
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground mb-4">
            <span>{series.chapters.length} chapters available</span>
            <span>•</span>
            <span>{scriptedCount} scripted</span>
          </div>
          
          {/* Progress bar */}
          <div className="max-w-md">
            <div className="flex items-center justify-between text-sm mb-1">
              <span>Script Progress</span>
              <span>{progress}%</span>
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        </div>
        
        <Button variant="outline" onClick={handleOpenFolder}>
          <FolderOpen className="h-4 w-4 mr-2" />
          Open Folder
        </Button>
      </div>

      {/* AI Status Warning */}
      {!aiStatus?.configured && (
        <Card className="mb-6 border-yellow-500">
          <CardContent className="py-4">
            <div className="flex items-center gap-3 text-yellow-600">
              <AlertTriangle className="h-5 w-5" />
              <div>
                <p className="font-medium">AI Provider Not Configured</p>
                <p className="text-sm text-muted-foreground">
                  Set GEMINI_API_KEY in .env for API mode, or use Manual mode to copy/paste prompts.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Series-wide voiceover */}
      <Card className="mb-6">
        <CardContent className="py-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Volume2 className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Voiceover:</span>
            </div>

            {bulkVoiceover ? (
              <>
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">
                    {bulkVoiceover.cancelling
                      ? 'Stopping after this chapter...'
                      : bulkVoiceover.currentChapterNumber !== null
                        ? `Chapter ${bulkVoiceover.currentChapterNumber}`
                        : 'Starting...'}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    ({bulkVoiceover.completed + bulkVoiceover.failed}/{bulkVoiceover.total} done
                    {bulkVoiceover.failed > 0 ? `, ${bulkVoiceover.failed} failed` : ''})
                  </span>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleStopBulkVoiceover}
                  disabled={bulkVoiceover.cancelling}
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  Stop
                </Button>

                <div className="ml-auto w-48">
                  <Progress
                    value={
                      ((bulkVoiceover.completed + bulkVoiceover.failed) / bulkVoiceover.total) * 100
                    }
                    className="h-2"
                  />
                </div>
              </>
            ) : (
              <>
                <Button
                  onClick={handleGenerateAllVoiceover}
                  disabled={voiceableCount === 0 || Object.keys(voiceoverRuns).length > 0}
                  size="sm"
                >
                  <Wand2 className="h-4 w-4 mr-2" />
                  Generate All Voiceover
                </Button>

                <span className="text-sm text-muted-foreground">
                  {voiceableCount === 0
                    ? 'Every scripted chapter is already voiced'
                    : `${voiceableCount} chapter(s) ready - runs one after another`}
                </span>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Range Generation */}
      <Card className="mb-6">
        <CardContent className="py-4">
          <div className="flex flex-wrap items-center gap-4">
            <span className="font-medium">Generate Range:</span>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">From</span>
              <Input
                type="number"
                className="w-20 h-8"
                value={rangeFrom}
                onChange={(e) => setRangeFrom(e.target.value)}
                placeholder="1"
              />
              <span className="text-sm text-muted-foreground">to</span>
              <Input
                type="number"
                className="w-20 h-8"
                value={rangeTo}
                onChange={(e) => setRangeTo(e.target.value)}
                placeholder="5"
              />
              <Button 
                onClick={handleGenerateRange}
                disabled={generating || !aiStatus?.configured}
                size="sm"
              >
                {generating ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                Generate
              </Button>
            </div>
            
            {/* Range progress */}
            {narrationRangeProgress && (
              <div className="flex items-center gap-2 ml-auto">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">
                  Chapter {narrationRangeProgress.overallCurrent} of {narrationRangeProgress.overallTotal}
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Chapters by Part */}
      <div className="space-y-6">
        {parts.map((part) => (
          <Card key={part.partNumber}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Flag className="h-5 w-5 text-primary" />
                  Part {part.partNumber}
                  <span className="text-sm font-normal text-muted-foreground">
                    ({part.chapters.length} chapters)
                  </span>
                </CardTitle>
                
                {part.chapters[part.chapters.length - 1]?.script?.isPartEnd && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExportPart(part.partNumber)}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Export Part
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {part.chapters.map((chapter) => (
                    <div
                      key={chapter.id}
                      className={`flex items-center gap-4 p-3 rounded-lg border hover:bg-accent transition-colors ${
                        isPublished(chapter.id) ? publishedRowClass : ''
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">Chapter {chapter.number}</span>
                          {chapter.title && (
                            <span className="text-sm text-muted-foreground truncate">
                              - {chapter.title}
                            </span>
                          )}
                          {chapter.script?.isPartEnd && (
                            <Badge variant="secondary" className="text-xs">
                              Part End
                            </Badge>
                          )}
                          {isPublished(chapter.id) && <PublishedBadge />}
                        </div>
                        
                        {chapter.script?.error && (
                          <p className="text-xs text-destructive mt-1 truncate">
                            {chapter.script.error}
                          </p>
                        )}
                      </div>
                      
                      <div className="flex items-center gap-2">
                        {getStatusBadge(chapter)}

                        {voiceoverRuns[chapter.id] ? (
                          <Badge variant="secondary" className="flex items-center gap-1">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            {describeVoiceoverRun(voiceoverRuns[chapter.id])}
                          </Badge>
                        ) : chapter.voiceover.status === 'done' ? (
                          <Badge variant="success" className="flex items-center gap-1">
                            <Volume2 className="h-3 w-3" />
                            Voiced
                          </Badge>
                        ) : chapter.voiceover.status === 'partial' ? (
                          <Badge variant="secondary" className="flex items-center gap-1">
                            <Volume2 className="h-3 w-3" />
                            Voice {chapter.voiceover.withAudio}/{chapter.voiceover.totalSections}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="flex items-center gap-1 text-muted-foreground">
                            <Volume2 className="h-3 w-3" />
                            No voice
                          </Badge>
                        )}

                        <Link to={`/narration/chapter/${chapter.id}`}>
                          <Button variant="outline" size="sm">
                            {chapter.script?.status === 'done' || chapter.script?.status === 'edited' ? (
                              <>
                                <FileText className="h-4 w-4 mr-1" />
                                Edit
                              </>
                            ) : (
                              <>
                                <Wand2 className="h-4 w-4 mr-1" />
                                Script
                              </>
                            )}
                          </Button>
                        </Link>
                        
                        {(chapter.script?.status === 'done' || chapter.script?.status === 'edited') && (
                          <>
                            {/* One-click: split -> generate -> align. Hidden once
                                the chapter is fully voiced, where re-running
                                would discard existing audio for no gain. */}
                            {chapter.voiceover.status !== 'done' && (
                              <Button
                                variant="default"
                                size="sm"
                                onClick={() => handleGenerateVoiceover(chapter)}
                                disabled={!!voiceoverRuns[chapter.id] || !!bulkVoiceover}
                                title="Split the script, generate all audio, then align timelines"
                              >
                                {voiceoverRuns[chapter.id] ? (
                                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                ) : (
                                  <Wand2 className="h-4 w-4 mr-1" />
                                )}
                                Generate Voiceover
                              </Button>
                            )}

                            <Link to={`/narration/voiceover/${chapter.id}`}>
                              <Button variant="outline" size="sm">
                                <Volume2 className="h-4 w-4 mr-1" />
                                Voice
                              </Button>
                            </Link>
                          </>
                        )}
                      </div>
                    </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
