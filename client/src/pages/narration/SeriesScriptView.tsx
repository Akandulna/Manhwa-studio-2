/**
 * Series Script View Page
 * 
 * Shows all chapters for a series with their script status,
 * part groupings, and generation controls.
 */

import { useEffect, useState } from 'react'
import { usePublishedChapters } from '@/hooks/usePublishedChapters'
import { PublishedBadge, publishedRowClass } from '@/components/PublishedBadge'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { narrationApi, NarrationSeriesDetail, NarrationChapterSummary, AIStatus } from '@/lib/api'
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

export default function SeriesScriptView() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()
  const { narrationProgress, narrationRangeProgress, narrationRangeComplete } = useSocket()

  const [series, setSeries] = useState<NarrationSeriesDetail | null>(null)

  // Chapters already rendered to video — no need to rewrite or re-voice them.
  const { isPublished } = usePublishedChapters(id)
  const [aiStatus, setAIStatus] = useState<AIStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  
  // Range generation
  const [rangeFrom, setRangeFrom] = useState('')
  const [rangeTo, setRangeTo] = useState('')

  useEffect(() => {
    if (id) {
      loadData()
    }
  }, [id])

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

                        {chapter.voiceover.status === 'done' ? (
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
                          <Link to={`/narration/voiceover/${chapter.id}`}>
                            <Button variant="outline" size="sm">
                              <Volume2 className="h-4 w-4 mr-1" />
                              Voice
                            </Button>
                          </Link>
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
