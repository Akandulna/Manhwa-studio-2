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

// Module 3: Image Clipper 3.0 cuts image by image, so progress counts images
// rather than crops and names the one being cut. `auto` marks a cut Sync json
// started for a chapter reviewed on the Master phone; `seriesId` lets the
// series page follow a cut it did not start.
interface Clipper3CropProgress {
  chapterId: string
  chapterNumber?: number
  seriesId?: string
  auto?: boolean
  current: number
  total: number
  filename: string
}

/**
 * One page whose metadata names a crop that is not in crops3/.
 *
 * Reported only at the end of a cut, when the folder is complete enough for
 * the absence to mean something. See findUnresolvedMetadataNames.
 */
export interface Clipper3UnresolvedPage {
  imageFilename: string
  missing: string[]
  total: number
}

interface Clipper3CropComplete {
  chapterId: string
  chapterNumber?: number
  seriesId?: string
  auto?: boolean
  images?: number
  exported?: number
  /** Old outputs the cut deleted because this run did not write them. */
  removed?: number
  failed?: number
  exportDir?: string
  warnings?: string[]
  /** Pages whose metadata names files the cut did not produce. */
  unresolved?: Clipper3UnresolvedPage[]
  error?: string
}

// Bulk slicing walks every page of every chapter in a series, so progress is
// counted in pages across the whole series rather than per chapter.
interface Clipper3SliceProgress {
  seriesId: string
  current: number
  total: number
  filename: string
}

interface Clipper3SliceComplete {
  seriesId: string
  chapters?: number
  images?: number
  sliced?: number
  parts?: number
  failed?: number
  warnings?: string[]
  error?: string
}

interface Clipper3SyncProgress {
  seriesId: string
  current: number
  total: number
  chapterNumber: number
}

/**
 * The outcome of one Sync json run. `results` carries only the chapters that
 * actually had a `Processed/` folder, so the UI can name what failed without
 * listing every untouched chapter in the series.
 */
interface Clipper3SyncComplete {
  seriesId: string
  chapters?: number
  imported?: number
  /** Attached pages overwritten by a Master phone review. */
  replaced?: number
  skipped?: number
  failed?: number
  results?: {
    chapterId: string
    chapterNumber: number
    imported: number
    ready: number
    replaced: number
    skipped: number
    failed: number
    pages: {
      folder: string
      filename: string | null
      status: 'imported' | 'ready' | 'replaced' | 'skipped' | 'failed'
      reason: string
      cropCount: number
    }[]
  }[]
  /** Chapters reviewed on the Master phone that this run sent to crop automatically. */
  autoCrop?: { chapterId: string; chapterNumber: number }[]
  error?: string
}

interface Clipper3UnsyncProgress {
  seriesId: string
  current: number
  total: number
  chapterNumber: number
}

interface Clipper3UnsyncComplete {
  seriesId: string
  chapters?: number
  detached?: number
  failed?: number
  results?: {
    chapterId: string
    chapterNumber: number
    detached: number
    attached: number
    failed: number
    pages: {
      filename: string
      status: 'detached' | 'attached' | 'failed'
      reason: string
      hadPoints: boolean
      hadMetadata: boolean
    }[]
  }[]
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
  // Module 3: Image Clipper 3.0
  clipper3CropProgress: Clipper3CropProgress | null
  clipper3CropComplete: Clipper3CropComplete | null
  clipper3SliceProgress: Clipper3SliceProgress | null
  clipper3SliceComplete: Clipper3SliceComplete | null
  clipper3SyncProgress: Clipper3SyncProgress | null
  clipper3SyncComplete: Clipper3SyncComplete | null
  clipper3UnsyncProgress: Clipper3UnsyncProgress | null
  clipper3UnsyncComplete: Clipper3UnsyncComplete | null
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
  clipper3CropProgress: null,
  clipper3CropComplete: null,
  clipper3SliceProgress: null,
  clipper3SliceComplete: null,
  clipper3SyncProgress: null,
  clipper3SyncComplete: null,
  clipper3UnsyncProgress: null,
  clipper3UnsyncComplete: null
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

  // Module 3: Image Clipper 3.0
  const [clipper3CropProgress, setClipper3CropProgress] = useState<Clipper3CropProgress | null>(null)
  const [clipper3CropComplete, setClipper3CropComplete] = useState<Clipper3CropComplete | null>(null)
  const [clipper3SliceProgress, setClipper3SliceProgress] = useState<Clipper3SliceProgress | null>(null)
  const [clipper3SliceComplete, setClipper3SliceComplete] = useState<Clipper3SliceComplete | null>(null)
  const [clipper3SyncProgress, setClipper3SyncProgress] = useState<Clipper3SyncProgress | null>(null)
  const [clipper3SyncComplete, setClipper3SyncComplete] = useState<Clipper3SyncComplete | null>(null)
  const [clipper3UnsyncProgress, setClipper3UnsyncProgress] = useState<Clipper3UnsyncProgress | null>(null)
  const [clipper3UnsyncComplete, setClipper3UnsyncComplete] = useState<Clipper3UnsyncComplete | null>(null)

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
    socketInstance.on('library:updated', () => setLastStatusUpdate(Date.now()))
    socketInstance.on('chapters:updated', () => setLastStatusUpdate(Date.now()))

    socketInstance.on('discovery:progress', (progress: DiscoveryProgress) => {
      setDiscoveryProgress(progress)
    })

    socketInstance.on('clipper3:crop-progress', (progress: Clipper3CropProgress) => {
      setClipper3CropProgress(progress)
    })

    socketInstance.on('clipper3:crop-complete', (result: Clipper3CropComplete) => {
      setClipper3CropComplete(result)
      setClipper3CropProgress(null)
    })

    socketInstance.on('clipper3:slice-progress', (progress: Clipper3SliceProgress) => {
      setClipper3SliceProgress(progress)
    })

    socketInstance.on('clipper3:slice-complete', (result: Clipper3SliceComplete) => {
      setClipper3SliceComplete(result)
      setClipper3SliceProgress(null)
    })

    socketInstance.on('clipper3:sync-progress', (progress: Clipper3SyncProgress) => {
      setClipper3SyncProgress(progress)
    })

    socketInstance.on('clipper3:sync-complete', (result: Clipper3SyncComplete) => {
      setClipper3SyncComplete(result)
      setClipper3SyncProgress(null)
    })

    socketInstance.on('clipper3:unsync-progress', (progress: Clipper3UnsyncProgress) => {
      setClipper3UnsyncProgress(progress)
    })

    socketInstance.on('clipper3:unsync-complete', (result: Clipper3UnsyncComplete) => {
      setClipper3UnsyncComplete(result)
      setClipper3UnsyncProgress(null)
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
      clipper3CropProgress,
      clipper3CropComplete,
      clipper3SliceProgress,
      clipper3SliceComplete,
      clipper3SyncProgress,
      clipper3SyncComplete,
      clipper3UnsyncProgress,
      clipper3UnsyncComplete
    }}>
      {children}
    </SocketContext.Provider>
  )
}

export function useSocket() {
  return useContext(SocketContext)
}
