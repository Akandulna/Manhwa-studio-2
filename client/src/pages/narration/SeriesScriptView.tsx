/**
 * Series Script View Page
 * 
 * Shows all chapters for a series with their script status,
 * part groupings, and generation controls.
 *
 * Scripts are generated on the English tab only. Each English script is
 * converted to Hinglish (the Hindi tab) once it is saved; the English tab also
 * offers converting every chapter whose Hinglish is missing or stale. The
 * Hindi tab shows those scripts' status (done / needs review / stale / missing)
 * and keeps its own voiceover and phone controls.
 */

import { useEffect, useRef, useState } from 'react'
import { usePublishedChapters } from '@/hooks/usePublishedChapters'
import { PublishedBadge, publishedRowClass } from '@/components/PublishedBadge'
import { PhoneScriptBadge } from '@/components/PhoneSyncBadge'
import { usePhoneScripts } from '@/hooks/usePhoneScripts'
import { PhoneScriptImport } from '@/components/narration/PhoneScriptImport'
import { PhoneVoiceoverFetch } from '@/components/narration/PhoneVoiceoverFetch'
import { PhoneRefreshButton } from '@/components/PhoneRefreshButton'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  narrationApi,
  voiceoverApi,
  phoneScriptsIn,
  NarrationSeriesDetail,
  NarrationChapterSummary,
  AIStatus,
  HinglishEvent
} from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/lib/socket'
import { LanguageTabs } from '@/components/LanguageTabs'
import { LANGUAGE_LABEL, NarrationLanguage, useNarrationLanguage, withLang } from '@/lib/narrationLanguage'
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
  Volume2,
  Languages
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

/** The Hinglish conversion running for this series, from `narration:hinglish` events. */
interface HinglishRun {
  /** Converting now, if any. */
  chapterId: string | null
  chapterNumber: number | null
  stage: HinglishEvent['stage'] | null
  /** Chapters still queued or converting. */
  remaining: number
}

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
  const { socket, narrationProgress: anyNarrationProgress, narrationRangeProgress: anyRangeProgress, narrationRangeComplete } = useSocket()
  const [language, setLanguage] = useNarrationLanguage('narration')
  // Progress events from the other language's pipeline are not this tab's.
  const isThisLanguage = (event: { language?: NarrationLanguage } | null) =>
    !!event && (event.language ?? 'en') === language
  const narrationProgress = isThisLanguage(anyNarrationProgress) ? anyNarrationProgress : null
  const narrationRangeProgress = isThisLanguage(anyRangeProgress) ? anyRangeProgress : null

  const [series, setSeries] = useState<NarrationSeriesDetail | null>(null)

  // Chapters already rendered to video in this language — no need to rewrite
  // or re-voice them.
  const { isPublished } = usePublishedChapters(id, language)
  // Scripts written in the Sleeper-Cell phone app, updated as the phone saves
  // them: English on the English tab, its Hinglish conversions on the Hindi tab.
  const phoneScriptsReceipt = usePhoneScripts(id)
  const phoneScripts = phoneScriptsIn(phoneScriptsReceipt.status, language)
  const [aiStatus, setAIStatus] = useState<AIStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  
  // Range generation
  const [rangeFrom, setRangeFrom] = useState('')
  const [rangeTo, setRangeTo] = useState('')

  // Hinglish conversions of this series (they run on the server, one at a time)
  const [hinglishRun, setHinglishRun] = useState<HinglishRun | null>(null)
  const [queueingHinglish, setQueueingHinglish] = useState(false)

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
      // Runs shown in the list belong to the tab they were started from.
      setVoiceoverRuns({})
      loadData()
    }
  }, [id, language])

  // Live progress for one-click voiceover runs started from this page.
  useEffect(() => {
    if (!socket) return

    const handlePipeline = (data: VoiceoverRun & { chapterId: string; language?: NarrationLanguage }) => {
      const { chapterId, language: runLanguage, ...run } = data
      if ((runLanguage ?? 'en') !== language) return
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
  }, [socket, id, language])

  // Live Hinglish conversion progress, on both tabs: each finished chapter
  // changes the Hindi tab's statuses and the English tab's count.
  useEffect(() => {
    if (!socket || !id) return

    const handleHinglish = (event: HinglishEvent) => {
      if (event.seriesId !== id) return
      const finished = event.stage === 'done' || event.stage === 'review' || event.stage === 'failed'
      setHinglishRun(event.remaining > 0 || !finished
        ? {
            chapterId: finished ? null : event.chapterId,
            chapterNumber: finished ? null : event.chapterNumber,
            stage: finished ? null : event.stage,
            remaining: event.remaining
          }
        : null)
      if (finished) {
        loadSeries()
        if (event.stage === 'failed') {
          toast({
            title: `Hinglish conversion failed (Chapter ${event.chapterNumber})`,
            description: event.error || 'Unknown error',
            variant: 'destructive'
          })
        }
      }
    }

    socket.on('narration:hinglish', handleHinglish)
    return () => {
      socket.off('narration:hinglish', handleHinglish)
    }
  }, [socket, id, language])

  // Reload when generation completes
  useEffect(() => {
    if (narrationRangeComplete && isThisLanguage(narrationRangeComplete)) {
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
        narrationApi.getSeriesDetail(id!, language),
        narrationApi.getAIStatus()
      ])
      setSeries(seriesData)
      setAIStatus(aiData)
      setHinglishRun(runFromQueue(seriesData))
      
      // Set default range
      if (seriesData.chapters.length > 0) {
        const firstUnscripted = seriesData.chapters.find(c => !c.script || c.script.status === 'none' || c.script.status === 'failed')
        if (firstUnscripted) {
          setRangeFrom(String(firstUnscripted.number))
          setRangeTo(String(Math.min(firstUnscripted.number + 4, seriesData.chapters[seriesData.chapters.length - 1].number)))
        } else {
          setRangeFrom('')
          setRangeTo('')
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
      const data = await narrationApi.getSeriesDetail(id!, language)
      setSeries(data)
    } catch (error) {
      console.error('Failed to reload series:', error)
    }
  }

  /** The server's queue when the page loads, until the next event says more. */
  const runFromQueue = (data: NarrationSeriesDetail): HinglishRun | null => {
    const { running, queued } = data.hinglish.queue
    const remaining = queued.length + (running ? 1 : 0)
    if (remaining === 0) return null
    const current = data.chapters.find(c => c.id === running)
    return { chapterId: running, chapterNumber: current?.number ?? null, stage: running ? 'converting' : 'queued', remaining }
  }

  /** Queue every chapter whose English is written and whose Hinglish is missing, failed or stale. */
  const handleConvertHinglish = async () => {
    if (!aiStatus?.configured) {
      toast({
        title: 'AI Not Configured',
        description: 'Set GEMINI_API_KEY in .env, or use Copy Hinglish prompt in each chapter\'s Manual mode',
        variant: 'destructive'
      })
      return
    }

    setQueueingHinglish(true)
    try {
      const result = await narrationApi.convertHinglishSeries(id!)
      toast({
        title: 'Converting to Hinglish',
        description: result.queued > 0
          ? `${result.queued} chapter(s) queued - they convert one after another`
          : 'Every chapter that needs converting is already queued'
      })
      loadSeries()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to queue the conversion',
        variant: 'destructive'
      })
    } finally {
      setQueueingHinglish(false)
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
      await narrationApi.generateRange(id!, language, from, to)
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
      const result = await narrationApi.exportPart(id!, language, partNumber)
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
      await voiceoverApi.runPipeline(chapter.id, language)
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

        voiceoverApi.runPipeline(chapter.id, language).catch(error => {
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

  /** The Hindi tab's status: where the chapter's Hinglish conversion stands. */
  const getHinglishBadge = (chapter: NarrationChapterSummary) => {
    if (hinglishRun?.chapterId === chapter.id) {
      return (
        <Badge variant="default" className="flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          {hinglishRun.stage === 'retrying' ? 'Fixing...' : 'Converting...'}
        </Badge>
      )
    }

    switch (chapter.hinglish?.state) {
      case 'done':
        return chapter.script?.status === 'edited' ? (
          <Badge variant="default" className="flex items-center gap-1 bg-blue-500">
            <FileText className="h-3 w-3" />
            Edited
          </Badge>
        ) : (
          <Badge variant="success" className="flex items-center gap-1">
            <CheckCircle className="h-3 w-3" />
            Done
          </Badge>
        )
      case 'review':
        return (
          <Badge
            variant="outline"
            className="flex items-center gap-1 border-amber-500 text-amber-600"
            title={chapter.hinglish.review?.join('\n')}
          >
            <AlertTriangle className="h-3 w-3" />
            Needs review
          </Badge>
        )
      case 'stale':
        return (
          <Badge
            variant="outline"
            className="flex items-center gap-1 border-yellow-500 text-yellow-500"
            title="The English script changed after this was converted - convert again from the English tab"
          >
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
      case 'waiting':
        return (
          <Badge variant="outline" className="flex items-center gap-1 text-muted-foreground" title="No English script yet">
            <Clock className="h-3 w-3" />
            Waiting for English
          </Badge>
        )
      default:
        return (
          <Badge variant="outline" className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {hinglishRun && series?.hinglish.queue.queued.includes(chapter.id) ? 'Queued' : 'Missing'}
          </Badge>
        )
    }
  }

  const getStatusBadge = (chapter: NarrationChapterSummary) => {
    if (language === 'hi') return getHinglishBadge(chapter)

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
        <Button variant="link" onClick={() => navigate(withLang('/narration', language))}>
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

  // Hinglish: what "Convert to Hinglish" would pick up, and where the Hindi scripts stand.
  const convertible = series.hinglish.convertible
  const convertibleStale = series.chapters.filter(c => convertible.includes(c.id) && c.hinglish?.state === 'stale').length
  const convertibleFailed = series.chapters.filter(c => convertible.includes(c.id) && c.hinglish?.state === 'failed').length
  const hinglishCount = (state: string) => series.chapters.filter(c => c.hinglish?.state === state).length
  const phoneSeries = phoneScripts?.series[series.id]

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-start gap-6 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate(withLang('/narration', language))}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-4 mb-2">
            <h1 className="text-3xl font-bold">{series.title}</h1>
            {/* Locked while a bulk voiceover runs: it waits on this tab's events */}
            <LanguageTabs
              value={language}
              onChange={setLanguage}
              disabled={!!bulkVoiceover}
            />
          </div>
          
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground mb-4">
            <span>{series.chapters.length} chapters available</span>
            <span>•</span>
            <span>{scriptedCount} scripted in {LANGUAGE_LABEL[language]}</span>
            {/* The phone writes English scripts and converts them to Hinglish */}
            {phoneSeries && (
              <>
                <span>•</span>
                <span title={phoneScripts?.device ? `Sleeper-Cell on ${phoneScripts.device}` : 'Sleeper-Cell'}>
                  {phoneSeries.done}/{phoneSeries.total} {language === 'hi' ? 'converted' : 'done'} on phone
                </span>
              </>
            )}
            <PhoneRefreshButton receipt={phoneScriptsReceipt} />
          </div>
          
          {/* Progress bar */}
          <div className="max-w-md">
            <div className="flex items-center justify-between text-sm mb-1">
              <span>{LANGUAGE_LABEL[language]} Script Progress</span>
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

      {/* Hinglish: converted from English. Queued from the English tab; the Hindi tab shows where it stands. */}
      <Card className="mb-6">
        <CardContent className="py-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Languages className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Hinglish:</span>
            </div>

            {language === 'en' ? (
              <>
                <Button
                  size="sm"
                  onClick={handleConvertHinglish}
                  disabled={queueingHinglish || !aiStatus?.configured || convertible.length === 0}
                  title="Convert every chapter whose English script is written and whose Hinglish is missing, failed or stale"
                >
                  {queueingHinglish ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Languages className="h-4 w-4 mr-2" />}
                  Convert to Hinglish ({convertible.length})
                </Button>
                <span className="text-sm text-muted-foreground">
                  {convertible.length === 0
                    ? 'Every English script has an up-to-date Hinglish one'
                    : [
                        `${convertible.length - convertibleStale - convertibleFailed} missing`,
                        convertibleStale > 0 ? `${convertibleStale} stale` : null,
                        convertibleFailed > 0 ? `${convertibleFailed} failed` : null
                      ].filter(Boolean).join(', ') + ' - new English scripts convert by themselves'}
                </span>
              </>
            ) : (
              <>
                <span className="text-sm text-muted-foreground">
                  {hinglishCount('done')} done
                  {hinglishCount('review') > 0 && `, ${hinglishCount('review')} need review`}
                  {hinglishCount('stale') > 0 && `, ${hinglishCount('stale')} stale`}
                  {hinglishCount('pending') + hinglishCount('failed') > 0 &&
                    `, ${hinglishCount('pending') + hinglishCount('failed')} missing`}
                  {' '}- Hindi scripts are converted from the English ones
                </span>
                <Button size="sm" variant="outline" onClick={() => setLanguage('en')} disabled={!!bulkVoiceover}>
                  Convert on the English tab
                </Button>
              </>
            )}

            {hinglishRun && (
              <div className="flex items-center gap-2 ml-auto text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                {hinglishRun.chapterNumber !== null
                  ? `${hinglishRun.stage === 'retrying' ? 'Fixing' : 'Converting'} chapter ${hinglishRun.chapterNumber}`
                  : 'Queued'}
                <span className="text-muted-foreground">({hinglishRun.remaining} left)</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Scripts written on the Sleeper-Cell phone, uploaded as one zip per language */}
      <PhoneScriptImport seriesId={series.id} language={language} phoneScripts={phoneScripts} onImported={loadSeries} />

      {/* Chapters voiced on the phone, uploaded one zip per chapter and language */}
      <PhoneVoiceoverFetch seriesId={series.id} language={language} onFetched={loadSeries} />

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
                  {scriptedCount === 0
                    ? `No chapter has a ${LANGUAGE_LABEL[language]} script yet`
                    : voiceableCount === 0
                    ? 'Every scripted chapter is already voiced'
                    : `${voiceableCount} chapter(s) ready - runs one after another`}
                </span>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Range Generation — English only: Hindi scripts are converted, never generated */}
      {language === 'en' && (
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
      )}

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
                        
                        {language === 'en' && chapter.script?.error && (
                          <p className="text-xs text-destructive mt-1 truncate">
                            {chapter.script.error}
                          </p>
                        )}
                        {/* Hindi: the check's issues for a script saved for review, or why converting failed */}
                        {language === 'hi' && chapter.hinglish?.state === 'review' && chapter.hinglish.review && (
                          <div className="text-xs text-amber-600 mt-1">
                            {chapter.hinglish.review.map(line => (
                              <p key={line} className="truncate" title={line}>{line}</p>
                            ))}
                          </div>
                        )}
                        {language === 'hi' && chapter.hinglish?.error && (
                          <p className="text-xs text-destructive mt-1 truncate" title={chapter.hinglish.error}>
                            {chapter.hinglish.error}
                          </p>
                        )}
                      </div>
                      
                      <div className="flex items-center gap-2">
                        {phoneScripts?.chapters[chapter.id] && (
                          <PhoneScriptBadge
                            script={phoneScripts.chapters[chapter.id]}
                            device={phoneScripts.device}
                            hinglish={language === 'hi'}
                          />
                        )}
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

                        <Link to={withLang(`/narration/chapter/${chapter.id}`, language)}>
                          <Button variant="outline" size="sm">
                            {chapter.script?.status === 'done' || chapter.script?.status === 'edited' ? (
                              <>
                                <FileText className="h-4 w-4 mr-1" />
                                Edit
                              </>
                            ) : language === 'hi' ? (
                              <>
                                <FileText className="h-4 w-4 mr-1" />
                                Open
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

                            <Link to={withLang(`/narration/voiceover/${chapter.id}`, language)}>
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
