import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { io, Socket } from 'socket.io-client'

interface QueueStatus {
  isPaused: boolean
  pending: number
  active: number
  completed: number
  failed: number
  currentChapter?: string
}

interface ChapterProgress {
  chapterId: string
  downloaded: number
  total: number
  percent: number
}

interface ChapterStatus {
  chapterId: string
  status: string
  error?: string
}

interface DiscoveryProgress {
  currentNumber: number
  discovered: number
  total: number
  status: 'checking' | 'found' | 'miss' | 'stopped'
}

// Module 2: Narration progress
interface NarrationProgress {
  chapterId: string
  chapterNumber: number
  stage: 'preprocessing' | 'extracting-beats' | 'generating-script' | 'generating-summary' | 'saving' | 'done' | 'failed'
  batchCurrent?: number
  batchTotal?: number
  preprocessPercent?: number
  error?: string
}

interface NarrationRangeProgress extends NarrationProgress {
  overallCurrent: number
  overallTotal: number
}

interface NarrationRangeComplete {
  success: boolean
  completed: number
  failed: number
  errors: string[]
}

// Module 2 Part 2: Voiceover progress
interface VoiceoverSectionProgress {
  chapterId: string
  sectionId: string
  index: number
}

interface VoiceoverBatchProgress {
  chapterId: string
  completed: number
  total: number
}

interface VoiceoverBatchComplete {
  chapterId: string
  successful: number
  failed: number
}

// Module 3: Clipper progress
interface ClipperFinalizeProgress {
  sessionId: string
  current: number
  total: number
}

interface ClipperFinalizeComplete {
  sessionId: string
  success: boolean
  outputDir?: string
  exportedCount?: number
  error?: string
}

// Module 3 AI: Auto-Crop progress
export interface SuggestionOverlayDTO {
  id: string
  canvasX: number
  canvasY: number
  canvasW: number
  canvasH: number
  aspectPreset: string
  confidence: number
  status: string
}

interface AiCropSuggestProgress {
  cropSessionId: string
  phase: string
  percent: number
}

interface AiCropSuggestComplete {
  cropSessionId: string
  mode?: 'trained' | 'rule-based'
  modelVersion?: number | null
  suggestions?: SuggestionOverlayDTO[]
  error?: string
}

interface AiCropTrainingProgress {
  phase: string
  percent: number
  sampleCount?: number
}

interface AiCropTrainingComplete {
  version?: number
  status?: string
  metrics?: Record<string, unknown>
  error?: string
  sampleCount?: number
  minSamples?: number
  usesEmbeddings?: boolean
  hasCutModel?: boolean
  cutMetrics?: { boundaryRecall?: number | null; boundaryPrecision?: number | null } | null
}

interface AiCropEvaluateProgress {
  phase: string
  percent: number
  chapterId?: string
}

interface AiCropEvaluateComplete {
  runId?: string
  mode?: string
  aggregate?: Record<string, number | null>
  perChapter?: unknown[]
  error?: string
}

// Module 3 v2: Image Clipper 2.0 progress
interface Clipper2Issue {
  code: string
  rule: string
  message: string
  cropId?: string
  severity: 'error' | 'warning'
}

interface Clipper2DetectProgress {
  chapterId: string
  phase: string
  percent: number
  message?: string
}

interface Clipper2DetectComplete {
  chapterId: string
  cropCount?: number
  warnings?: Clipper2Issue[]
  error?: string
}

interface Clipper2ApplyProgress {
  chapterId: string
  current: number
  total: number
}

interface Clipper2ApplyComplete {
  chapterId: string
  exported?: number
  failed?: number
  exportDir?: string
  registered?: boolean
  warnings?: string[]
  error?: string
}

// Module 4: Video Editor progress
interface VideoRenderProgress {
  projectId: string
  exportId?: string
  percent: number
}

interface VideoRenderResult {
  projectId: string
  exportId?: string
  status: 'done' | 'failed' | 'cancelled'
  outputPath?: string
  error?: string
}

interface VideoPreviewProgress {
  projectId: string
  percent: number
}

interface VideoPreviewResult {
  projectId: string
  success: boolean
  error?: string
}

interface SocketContextType {
  socket: Socket | null
  isConnected: boolean
  queueStatus: QueueStatus
  chapterProgress: Record<string, ChapterProgress>
  chapterStatuses: Record<string, ChapterStatus>
  discoveryProgress: DiscoveryProgress | null
  lastStatusUpdate: number
  // Module 2: Narration
  narrationProgress: NarrationProgress | null
  narrationRangeProgress: NarrationRangeProgress | null
  narrationRangeComplete: NarrationRangeComplete | null
  // Module 2 Part 2: Voiceover
  voiceoverSectionProgress: VoiceoverSectionProgress | null
  voiceoverBatchProgress: VoiceoverBatchProgress | null
  // Module 3: Clipper
  clipperFinalizeProgress: ClipperFinalizeProgress | null
  clipperFinalizeComplete: ClipperFinalizeComplete | null
  // Module 3 AI: Auto-Crop
  aiCropSuggestProgress: AiCropSuggestProgress | null
  aiCropSuggestComplete: AiCropSuggestComplete | null
  aiCropTrainingProgress: AiCropTrainingProgress | null
  aiCropTrainingComplete: AiCropTrainingComplete | null
  aiCropEvaluateProgress: AiCropEvaluateProgress | null
  aiCropEvaluateComplete: AiCropEvaluateComplete | null
  // Module 3 v2: Image Clipper 2.0
  clipper2DetectProgress: Clipper2DetectProgress | null
  clipper2DetectComplete: Clipper2DetectComplete | null
  clipper2ApplyProgress: Clipper2ApplyProgress | null
  clipper2ApplyComplete: Clipper2ApplyComplete | null
  // Module 4: Video Editor
  videoRenderProgress: VideoRenderProgress | null
  videoRenderResult: VideoRenderResult | null
  videoPreviewProgress: VideoPreviewProgress | null
  videoPreviewResult: VideoPreviewResult | null
}

const SocketContext = createContext<SocketContextType>({
  socket: null,
  isConnected: false,
  queueStatus: {
    isPaused: false,
    pending: 0,
    active: 0,
    completed: 0,
    failed: 0
  },
  chapterProgress: {},
  chapterStatuses: {},
  discoveryProgress: null,
  lastStatusUpdate: 0,
  narrationProgress: null,
  narrationRangeProgress: null,
  narrationRangeComplete: null,
  voiceoverSectionProgress: null,
  voiceoverBatchProgress: null,
  clipperFinalizeProgress: null,
  clipperFinalizeComplete: null,
  aiCropSuggestProgress: null,
  aiCropSuggestComplete: null,
  aiCropTrainingProgress: null,
  aiCropTrainingComplete: null,
  aiCropEvaluateProgress: null,
  aiCropEvaluateComplete: null,
  clipper2DetectProgress: null,
  clipper2DetectComplete: null,
  clipper2ApplyProgress: null,
  clipper2ApplyComplete: null,
  videoRenderProgress: null,
  videoRenderResult: null,
  videoPreviewProgress: null,
  videoPreviewResult: null
})

export function SocketProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [queueStatus, setQueueStatus] = useState<QueueStatus>({
    isPaused: false,
    pending: 0,
    active: 0,
    completed: 0,
    failed: 0
  })
  const [chapterProgress, setChapterProgress] = useState<Record<string, ChapterProgress>>({})
  const [chapterStatuses, setChapterStatuses] = useState<Record<string, ChapterStatus>>({})
  const [discoveryProgress, setDiscoveryProgress] = useState<DiscoveryProgress | null>(null)
  const [lastStatusUpdate, setLastStatusUpdate] = useState(0)
  
  // Module 2: Narration state
  const [narrationProgress, setNarrationProgress] = useState<NarrationProgress | null>(null)
  const [narrationRangeProgress, setNarrationRangeProgress] = useState<NarrationRangeProgress | null>(null)
  const [narrationRangeComplete, setNarrationRangeComplete] = useState<NarrationRangeComplete | null>(null)
  
  // Module 2 Part 2: Voiceover state
  const [voiceoverSectionProgress, setVoiceoverSectionProgress] = useState<VoiceoverSectionProgress | null>(null)
  const [voiceoverBatchProgress, setVoiceoverBatchProgress] = useState<VoiceoverBatchProgress | null>(null)

  // Module 3: Clipper state
  const [clipperFinalizeProgress, setClipperFinalizeProgress] = useState<ClipperFinalizeProgress | null>(null)
  const [clipperFinalizeComplete, setClipperFinalizeComplete] = useState<ClipperFinalizeComplete | null>(null)

  // Module 3 AI: Auto-Crop state
  const [aiCropSuggestProgress, setAiCropSuggestProgress] = useState<AiCropSuggestProgress | null>(null)
  const [aiCropSuggestComplete, setAiCropSuggestComplete] = useState<AiCropSuggestComplete | null>(null)
  const [aiCropTrainingProgress, setAiCropTrainingProgress] = useState<AiCropTrainingProgress | null>(null)
  const [aiCropTrainingComplete, setAiCropTrainingComplete] = useState<AiCropTrainingComplete | null>(null)
  const [aiCropEvaluateProgress, setAiCropEvaluateProgress] = useState<AiCropEvaluateProgress | null>(null)
  const [aiCropEvaluateComplete, setAiCropEvaluateComplete] = useState<AiCropEvaluateComplete | null>(null)

  // Module 3 v2: Image Clipper 2.0
  const [clipper2DetectProgress, setClipper2DetectProgress] = useState<Clipper2DetectProgress | null>(null)
  const [clipper2DetectComplete, setClipper2DetectComplete] = useState<Clipper2DetectComplete | null>(null)
  const [clipper2ApplyProgress, setClipper2ApplyProgress] = useState<Clipper2ApplyProgress | null>(null)
  const [clipper2ApplyComplete, setClipper2ApplyComplete] = useState<Clipper2ApplyComplete | null>(null)

  // Module 4: Video Editor state
  const [videoRenderProgress, setVideoRenderProgress] = useState<VideoRenderProgress | null>(null)
  const [videoRenderResult, setVideoRenderResult] = useState<VideoRenderResult | null>(null)
  const [videoPreviewProgress, setVideoPreviewProgress] = useState<VideoPreviewProgress | null>(null)
  const [videoPreviewResult, setVideoPreviewResult] = useState<VideoPreviewResult | null>(null)

  useEffect(() => {
    const socketInstance = io('http://localhost:3002', {
      transports: ['websocket', 'polling']
    })

    socketInstance.on('connect', () => {
      setIsConnected(true)
      console.log('Socket connected')
    })

    socketInstance.on('disconnect', () => {
      setIsConnected(false)
      console.log('Socket disconnected')
    })

    socketInstance.on('queue:status', (status: QueueStatus) => {
      setQueueStatus(status)
    })

    socketInstance.on('chapter:progress', (progress: ChapterProgress) => {
      setChapterProgress(prev => ({
        ...prev,
        [progress.chapterId]: progress
      }))
    })

    socketInstance.on('chapter:status', (status: ChapterStatus) => {
      // Update chapter status
      setChapterStatuses(prev => ({
        ...prev,
        [status.chapterId]: status
      }))
      setLastStatusUpdate(Date.now())
      
      // Clear progress when chapter completes
      if (status.status === 'done' || status.status === 'failed') {
        setChapterProgress(prev => {
          const { [status.chapterId]: _, ...rest } = prev
          return rest
        })
      }
    })

    socketInstance.on('discovery:progress', (progress: DiscoveryProgress) => {
      setDiscoveryProgress(progress)
    })

    // Module 2: Narration events
    socketInstance.on('narration:progress', (progress: NarrationProgress) => {
      setNarrationProgress(progress)
      if (progress.stage === 'done' || progress.stage === 'failed') {
        // Clear after a short delay
        setTimeout(() => setNarrationProgress(null), 2000)
      }
    })

    socketInstance.on('narration:range-progress', (progress: NarrationRangeProgress) => {
      setNarrationRangeProgress(progress)
    })

    socketInstance.on('narration:range-complete', (result: NarrationRangeComplete) => {
      setNarrationRangeComplete(result)
      setNarrationRangeProgress(null)
    })

    // Module 2 Part 2: Voiceover events
    socketInstance.on('voiceover:section-start', (progress: VoiceoverSectionProgress) => {
      setVoiceoverSectionProgress(progress)
    })

    socketInstance.on('voiceover:section-complete', () => {
      setVoiceoverSectionProgress(null)
    })

    socketInstance.on('voiceover:batch-start', (progress: VoiceoverBatchProgress) => {
      setVoiceoverBatchProgress({ ...progress, completed: 0 })
    })

    socketInstance.on('voiceover:batch-progress', (progress: VoiceoverBatchProgress) => {
      setVoiceoverBatchProgress(progress)
    })

    socketInstance.on('voiceover:batch-complete', () => {
      setVoiceoverBatchProgress(null)
    })

    // Module 3: Clipper events
    socketInstance.on('clipper:finalize-progress', (progress: ClipperFinalizeProgress) => {
      setClipperFinalizeProgress(progress)
    })

    socketInstance.on('clipper:finalize-complete', (result: ClipperFinalizeComplete) => {
      setClipperFinalizeComplete(result)
      setClipperFinalizeProgress(null)
    })

    // Module 3 AI: Auto-Crop events
    socketInstance.on('ai-crop:suggest-progress', (progress: AiCropSuggestProgress) => {
      setAiCropSuggestProgress(progress)
    })

    socketInstance.on('ai-crop:suggest-complete', (result: AiCropSuggestComplete) => {
      setAiCropSuggestComplete(result)
      setAiCropSuggestProgress(null)
    })

    socketInstance.on('ai-crop:training-progress', (progress: AiCropTrainingProgress) => {
      setAiCropTrainingProgress(progress)
    })

    socketInstance.on('ai-crop:training-complete', (result: AiCropTrainingComplete) => {
      setAiCropTrainingComplete(result)
      setAiCropTrainingProgress(null)
    })

    socketInstance.on('ai-crop:evaluate-progress', (progress: AiCropEvaluateProgress) => {
      setAiCropEvaluateProgress(progress)
    })

    socketInstance.on('ai-crop:evaluate-complete', (result: AiCropEvaluateComplete) => {
      setAiCropEvaluateComplete(result)
      setAiCropEvaluateProgress(null)
    })

    // Module 3 v2: Image Clipper 2.0 events
    socketInstance.on('clipper2:detect-progress', (progress: Clipper2DetectProgress) => {
      setClipper2DetectProgress(progress)
    })

    socketInstance.on('clipper2:detect-complete', (result: Clipper2DetectComplete) => {
      setClipper2DetectComplete(result)
      setClipper2DetectProgress(null)
    })

    socketInstance.on('clipper2:apply-progress', (progress: Clipper2ApplyProgress) => {
      setClipper2ApplyProgress(progress)
    })

    socketInstance.on('clipper2:apply-complete', (result: Clipper2ApplyComplete) => {
      setClipper2ApplyComplete(result)
      setClipper2ApplyProgress(null)
    })

    // Module 4: Video Editor events
    socketInstance.on('video:render-progress', (progress: VideoRenderProgress) => {
      setVideoRenderProgress(progress)
    })

    socketInstance.on('video:render-complete', (result: { projectId: string; exportId?: string; outputPath?: string }) => {
      setVideoRenderResult({ ...result, status: 'done' })
      setVideoRenderProgress(null)
    })

    socketInstance.on('video:render-failed', (result: { projectId: string; exportId?: string; error?: string }) => {
      setVideoRenderResult({ ...result, status: 'failed' })
      setVideoRenderProgress(null)
    })

    socketInstance.on('video:render-cancelled', (result: { projectId: string; exportId?: string }) => {
      setVideoRenderResult({ ...result, status: 'cancelled' })
      setVideoRenderProgress(null)
    })

    socketInstance.on('video:preview-progress', (progress: VideoPreviewProgress) => {
      setVideoPreviewProgress(progress)
    })

    socketInstance.on('video:preview-complete', (result: VideoPreviewResult) => {
      setVideoPreviewResult(result)
      setVideoPreviewProgress(null)
    })

    setSocket(socketInstance)

    return () => {
      socketInstance.disconnect()
    }
  }, [])

  return (
    <SocketContext.Provider value={{ 
      socket, 
      isConnected, 
      queueStatus, 
      chapterProgress,
      chapterStatuses,
      discoveryProgress,
      lastStatusUpdate,
      narrationProgress,
      narrationRangeProgress,
      narrationRangeComplete,
      voiceoverSectionProgress,
      voiceoverBatchProgress,
      clipperFinalizeProgress,
      clipperFinalizeComplete,
      aiCropSuggestProgress,
      aiCropSuggestComplete,
      aiCropTrainingProgress,
      aiCropTrainingComplete,
      aiCropEvaluateProgress,
      aiCropEvaluateComplete,
      clipper2DetectProgress,
      clipper2DetectComplete,
      clipper2ApplyProgress,
      clipper2ApplyComplete,
      videoRenderProgress,
      videoRenderResult,
      videoPreviewProgress,
      videoPreviewResult
    }}>
      {children}
    </SocketContext.Provider>
  )
}

export function useSocket() {
  return useContext(SocketContext)
}
