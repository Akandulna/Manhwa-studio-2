/**
 * ClipperWorkspace — Module 3: Image Clipper
 * 
 * Full-screen crop workspace with:
 * - Virtualized vertical canvas (lazy image loading)
 * - Manual crop tool (draw rectangle)
 * - Draggable/resizable crop overlays
 * - Aspect ratio presets
 * - Minimap navigation
 * - Crop list sidebar
 * - Finalize button with progress
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  ArrowLeft,
  ArrowRight,
  Scissors,
  Film,
  Download,
  Trash2,
  Loader2,
  Plus,
  GripVertical,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Sparkles,
  Check,
  CheckCheck,
  Ban,
  X
} from 'lucide-react'
import { useSocket } from '@/lib/socket'
import { useToast } from '@/components/ui/use-toast'
import {
  clipperApi,
  aiCropApi,
  type ImageManifest,
  type ManifestImage,
  type CropSession,
  type AiCropStatus
} from '@/lib/api'

// ============ Types ============

interface CropOverlay {
  id: string
  canvasX: number
  canvasY: number
  canvasW: number
  canvasH: number
  sequence: number
  aspectRatio?: string
}

// AI suggestion overlay (not a real crop until accepted). Tracks its original
// rect so we can detect whether the user adjusted it before accepting.
interface SuggestionOverlay {
  id: string
  canvasX: number
  canvasY: number
  canvasW: number
  canvasH: number
  aspectPreset: string
  confidence: number
  origX: number
  origY: number
  origW: number
  origH: number
}

const BUFFER_PX = 2000 // How many pixels above/below viewport to preload

// ============ Component ============

export default function ClipperWorkspace() {
  const { id: chapterId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()
  const {
    clipperFinalizeProgress,
    clipperFinalizeComplete,
    aiCropSuggestProgress,
    aiCropSuggestComplete
  } = useSocket()

  // State
  const [manifest, setManifest] = useState<ImageManifest | null>(null)
  const [session, setSession] = useState<CropSession | null>(null)
  const [crops, setCrops] = useState<CropOverlay[]>([])
  const [loading, setLoading] = useState(true)
  const [zoom, setZoom] = useState(0.5) // Scale factor
  const [selectedCropId, setSelectedCropId] = useState<string | null>(null)
  const [isFinalizing, setIsFinalizing] = useState(false)
  const [sidebarOpen] = useState(true)
  const [previews, setPreviews] = useState<Record<string, string>>({})

  // AI Auto-Crop state
  const [aiStatus, setAiStatus] = useState<AiCropStatus | null>(null)
  const [suggestions, setSuggestions] = useState<SuggestionOverlay[]>([])
  const [isSuggesting, setIsSuggesting] = useState(false)

  // Drag/resize state
  const [dragState, setDragState] = useState<{
    cropId: string
    target: 'crop' | 'suggestion'
    type: 'move' | 'resize'
    handle?: string
    startX: number
    startY: number
    originalCrop: { canvasX: number; canvasY: number; canvasW: number; canvasH: number }
  } | null>(null)

  // Refs
  const canvasContainerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(0)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ============ Load Data ============

  useEffect(() => {
    if (chapterId) {
      loadWorkspace()
    }
  }, [chapterId])

  async function loadWorkspace() {
    try {
      setLoading(true)

      // Load manifest and session in parallel
      const [manifestData, sessionData] = await Promise.all([
        clipperApi.getManifest(chapterId!),
        clipperApi.createSession(chapterId!)
      ])

      setManifest(manifestData)
      setSession(sessionData)

      // Convert session crops to overlay format
      if (sessionData.crops) {
        setCrops(sessionData.crops.map(c => ({
          id: c.id,
          canvasX: c.canvasX,
          canvasY: c.canvasY,
          canvasW: c.canvasW,
          canvasH: c.canvasH,
          sequence: c.sequence,
          aspectRatio: c.aspectRatio
        })))
      }

      // Auto-fit zoom
      if (manifestData.canvasWidth > 0) {
        // Fit to available width (minus sidebar)
        const availableWidth = window.innerWidth - 64 - (sidebarOpen ? 280 : 0) - 80
        const fitZoom = Math.min(1, availableWidth / manifestData.canvasWidth)
        setZoom(Math.max(0.1, Math.min(1, fitZoom)))
      }
    } catch (error) {
      console.error('Error loading workspace:', error)
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to load workspace',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }

  // ============ Finalization Events ============

  useEffect(() => {
    if (clipperFinalizeComplete && session && clipperFinalizeComplete.sessionId === session.id) {
      setIsFinalizing(false)
      if (clipperFinalizeComplete.success) {
        toast({
          title: 'Export Complete',
          description: `${clipperFinalizeComplete.exportedCount} crops exported successfully.`
        })
        // Refresh session
        loadWorkspace()
      } else {
        toast({
          title: 'Export Failed',
          description: clipperFinalizeComplete.error || 'Unknown error',
          variant: 'destructive'
        })
      }
    }
  }, [clipperFinalizeComplete])

  // ============ Scroll Tracking ============

  useEffect(() => {
    const container = canvasContainerRef.current
    if (!container) return

    const handleScroll = () => {
      setScrollTop(container.scrollTop)
    }

    const observer = new ResizeObserver(() => {
      setContainerHeight(container.clientHeight)
    })

    container.addEventListener('scroll', handleScroll, { passive: true })
    observer.observe(container)
    setContainerHeight(container.clientHeight)

    return () => {
      container.removeEventListener('scroll', handleScroll)
      observer.disconnect()
    }
  }, [loading])

  // ============ Image Visibility ============

  const isImageVisible = useCallback((img: ManifestImage): boolean => {
    const scaledY = img.canvasY * zoom
    const scaledH = img.canvasHeight * zoom
    const viewTop = scrollTop - BUFFER_PX
    const viewBottom = scrollTop + containerHeight + BUFFER_PX
    return scaledY + scaledH > viewTop && scaledY < viewBottom
  }, [scrollTop, containerHeight, zoom])

  // ============ Click-to-Add Crop ============

  function getCanvasCoords(e: React.MouseEvent): { x: number; y: number } {
    const container = canvasContainerRef.current
    if (!container) return { x: 0, y: 0 }
    const rect = container.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left + container.scrollLeft) / zoom,
      y: (e.clientY - rect.top + container.scrollTop) / zoom
    }
  }

  // Click anywhere on the page to drop a full-width crop centered on that point.
  // The crop spans edge-to-edge horizontally and starts as a 1:1 square; the user
  // then only adjusts its height.
  async function handleCanvasMouseDown(e: React.MouseEvent) {
    // Ignore clicks on existing overlays or while dragging/resizing.
    if ((e.target as HTMLElement).dataset.cropOverlay) return
    if (dragState) return
    if (!manifest || !session) return

    const coords = getCanvasCoords(e)

    const fullW = manifest.canvasWidth
    // Initial 1:1 square height, never exceeding the image's total height.
    const initialH = Math.min(fullW, manifest.canvasHeight)
    const y = Math.max(0, Math.min(coords.y - initialH / 2, manifest.canvasHeight - initialH))

    e.preventDefault()

    try {
      const crop = await clipperApi.createCrop(session.id, {
        canvasX: 0,
        canvasY: y,
        canvasW: fullW,
        canvasH: initialH
      })

      setCrops(prev => [...prev, {
        id: crop.id,
        canvasX: crop.canvasX,
        canvasY: crop.canvasY,
        canvasW: crop.canvasW,
        canvasH: crop.canvasH,
        sequence: crop.sequence,
        aspectRatio: crop.aspectRatio
      }])
      // Number the new crop by its vertical position (inserts renumber the rest).
      resequenceAndPersist()

      setSelectedCropId(crop.id)
      loadPreview(crop.id)
    } catch (error) {
      console.error('Error creating crop:', error)
    }
  }

  function handleCanvasMouseMove(e: React.MouseEvent) {
    if (dragState) {
      handleDragMove(e)
      e.preventDefault()
    }
  }

  function handleCanvasMouseUp(_e: React.MouseEvent) {
    if (dragState) {
      handleDragEnd()
    }
  }

  // ============ Drag & Resize ============

  function handleCropMouseDown(e: React.MouseEvent, cropId: string, type: 'move' | 'resize', handle?: string) {
    e.stopPropagation()
    e.preventDefault()

    const crop = crops.find(c => c.id === cropId)
    if (!crop) return

    const coords = getCanvasCoords(e)
    setDragState({
      cropId,
      target: 'crop',
      type,
      handle,
      startX: coords.x,
      startY: coords.y,
      originalCrop: { canvasX: crop.canvasX, canvasY: crop.canvasY, canvasW: crop.canvasW, canvasH: crop.canvasH }
    })
    setSelectedCropId(cropId)
  }

  // Suggestion overlays reuse the same drag machinery so users can adjust a
  // suggestion before accepting it (recorded as an "adjusted" outcome).
  function handleSuggestionMouseDown(e: React.MouseEvent, suggestionId: string, type: 'move' | 'resize', handle?: string) {
    e.stopPropagation()
    e.preventDefault()

    const s = suggestions.find(s => s.id === suggestionId)
    if (!s) return

    const coords = getCanvasCoords(e)
    setDragState({
      cropId: suggestionId,
      target: 'suggestion',
      type,
      handle,
      startX: coords.x,
      startY: coords.y,
      originalCrop: { canvasX: s.canvasX, canvasY: s.canvasY, canvasW: s.canvasW, canvasH: s.canvasH }
    })
  }

  function handleDragMove(e: React.MouseEvent) {
    if (!dragState) return

    const coords = getCanvasCoords(e)
    const dx = coords.x - dragState.startX
    const dy = coords.y - dragState.startY
    const orig = dragState.originalCrop

    // AI suggestions keep their free move/resize behavior on all handles.
    if (dragState.target === 'suggestion') {
      let newRect: { canvasX: number; canvasY: number; canvasW: number; canvasH: number }
      if (dragState.type === 'move') {
        newRect = { canvasX: orig.canvasX + dx, canvasY: orig.canvasY + dy, canvasW: orig.canvasW, canvasH: orig.canvasH }
      } else {
        let newX = orig.canvasX
        let newY = orig.canvasY
        let newW = orig.canvasW
        let newH = orig.canvasH

        const h = dragState.handle
        if (h?.includes('e')) newW = Math.max(20, orig.canvasW + dx)
        if (h?.includes('s')) newH = Math.max(20, orig.canvasH + dy)
        if (h?.includes('w')) {
          newX = orig.canvasX + dx
          newW = Math.max(20, orig.canvasW - dx)
        }
        if (h?.includes('n')) {
          newY = orig.canvasY + dy
          newH = Math.max(20, orig.canvasH - dy)
        }
        newRect = { canvasX: newX, canvasY: newY, canvasW: newW, canvasH: newH }
      }
      setSuggestions(prev => prev.map(s => s.id === dragState.cropId ? { ...s, ...newRect } : s))
      return
    }

    // Manual crops: move and resize freely (height and width) via any handle.
    // Every edit is clamped so the crop never extends past the image.
    const maxW = manifest ? manifest.canvasWidth : orig.canvasX + orig.canvasW
    const maxH = manifest ? manifest.canvasHeight : orig.canvasY + orig.canvasH

    let newX = orig.canvasX
    let newY = orig.canvasY
    let newW = orig.canvasW
    let newH = orig.canvasH

    if (dragState.type === 'move') {
      newX = Math.max(0, Math.min(orig.canvasX + dx, maxW - orig.canvasW))
      newY = Math.max(0, Math.min(orig.canvasY + dy, maxH - orig.canvasH))
    } else {
      const h = dragState.handle
      if (h?.includes('e')) {
        newW = Math.max(20, Math.min(orig.canvasW + dx, maxW - orig.canvasX))
      }
      if (h?.includes('s')) {
        newH = Math.max(20, Math.min(orig.canvasH + dy, maxH - orig.canvasY))
      }
      if (h?.includes('w')) {
        const right = orig.canvasX + orig.canvasW
        newX = Math.max(0, Math.min(orig.canvasX + dx, right - 20))
        newW = right - newX
      }
      if (h?.includes('n')) {
        const bottom = orig.canvasY + orig.canvasH
        newY = Math.max(0, Math.min(orig.canvasY + dy, bottom - 20))
        newH = bottom - newY
      }
    }

    const newRect = { canvasX: newX, canvasY: newY, canvasW: newW, canvasH: newH }
    setCrops(prev => prev.map(c => c.id === dragState.cropId ? { ...c, ...newRect } : c))
  }

  function handleDragEnd() {
    if (!dragState) return

    // Suggestion edits stay local until the user accepts (saved on accept).
    if (dragState.target === 'crop') {
      const crop = crops.find(c => c.id === dragState.cropId)
      if (crop) {
        // Debounce save
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
        saveTimeoutRef.current = setTimeout(async () => {
          try {
            await clipperApi.updateCrop(crop.id, {
              canvasX: crop.canvasX,
              canvasY: crop.canvasY,
              canvasW: crop.canvasW,
              canvasH: crop.canvasH
            })
            loadPreview(crop.id)
          } catch (error) {
            console.error('Error saving crop:', error)
          }
        }, 300)
      }
      // Moving a crop can change its vertical order — renumber accordingly.
      resequenceAndPersist()
    }

    setDragState(null)
  }

  // ============ Crop Operations ============

  // Crops are numbered top-to-bottom: the highest crop is #1, the next below #2,
  // and so on. Sort by vertical position (stable tiebreak on the old sequence)
  // and renumber.
  function resequenceCrops(list: CropOverlay[]): CropOverlay[] {
    return [...list]
      .sort((a, b) => a.canvasY - b.canvasY || a.sequence - b.sequence)
      .map((c, i) => ({ ...c, sequence: i + 1 }))
  }

  // Persist the position-based order so exports (named by sequence) match what
  // the user sees.
  function persistOrder(ordered: CropOverlay[]) {
    if (!session) return
    clipperApi.reorderCrops(session.id, ordered.map(c => c.id)).catch(err =>
      console.error('Error persisting crop order:', err)
    )
  }

  // Renumber the current crops by position and persist if the order changed.
  // Runs after any create / move / delete. Uses a functional update so it always
  // sees the freshest crop list (the geometry/add/remove update queued before it).
  function resequenceAndPersist() {
    setCrops(prev => {
      const ordered = resequenceCrops(prev)
      const orderChanged =
        prev.length !== ordered.length ||
        ordered.some(c => prev.find(p => p.id === c.id)?.sequence !== c.sequence)
      if (orderChanged) persistOrder(ordered)
      return ordered
    })
  }

  async function deleteCrop(cropId: string) {
    try {
      await clipperApi.deleteCrop(cropId)
      setCrops(prev => prev.filter(c => c.id !== cropId))
      setPreviews(prev => {
        const next = { ...prev }
        delete next[cropId]
        return next
      })
      if (selectedCropId === cropId) setSelectedCropId(null)
      // Renumber the survivors so numbering stays gap-free and position-ordered.
      resequenceAndPersist()
    } catch (error) {
      console.error('Error deleting crop:', error)
    }
  }

  async function loadPreview(cropId: string) {
    try {
      const { preview } = await clipperApi.previewCrop(cropId)
      setPreviews(prev => ({ ...prev, [cropId]: preview }))
    } catch (error) {
      console.error('Error loading preview:', error)
    }
  }

  // Load all previews on initial load
  useEffect(() => {
    crops.forEach(c => {
      if (!previews[c.id]) {
        loadPreview(c.id)
      }
    })
  }, [crops.length])

  // ============ AI Auto-Crop ============

  // Load model status + any persisted pending suggestions once the session exists.
  useEffect(() => {
    if (!session) return
    let cancelled = false

    aiCropApi.getStatus()
      .then(s => { if (!cancelled) setAiStatus(s) })
      .catch(() => { /* status is best-effort */ })

    aiCropApi.getSuggestions(session.id)
      .then(rows => {
        if (cancelled) return
        setSuggestions(rows.map(toSuggestionOverlay))
      })
      .catch(() => { /* no suggestions yet */ })

    return () => { cancelled = true }
  }, [session?.id])

  function toSuggestionOverlay(r: {
    id: string; canvasX: number; canvasY: number; canvasW: number; canvasH: number
    aspectPreset: string; confidence: number
  }): SuggestionOverlay {
    return {
      id: r.id,
      canvasX: r.canvasX, canvasY: r.canvasY, canvasW: r.canvasW, canvasH: r.canvasH,
      aspectPreset: r.aspectPreset, confidence: r.confidence,
      origX: r.canvasX, origY: r.canvasY, origW: r.canvasW, origH: r.canvasH
    }
  }

  async function runSuggest() {
    if (!session || isSuggesting) return
    setIsSuggesting(true)
    setSuggestions([])
    try {
      await aiCropApi.suggest(session.id)
    } catch (error) {
      setIsSuggesting(false)
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to start AI crop',
        variant: 'destructive'
      })
    }
  }

  // React to streamed suggestion results.
  useEffect(() => {
    if (!aiCropSuggestComplete || !session) return
    if (aiCropSuggestComplete.cropSessionId !== session.id) return

    setIsSuggesting(false)

    if (aiCropSuggestComplete.error) {
      toast({ title: 'AI crop failed', description: aiCropSuggestComplete.error, variant: 'destructive' })
      return
    }

    const list = aiCropSuggestComplete.suggestions || []
    setSuggestions(list.map(toSuggestionOverlay))

    const modeLabel = aiCropSuggestComplete.mode === 'trained'
      ? `Model v${aiCropSuggestComplete.modelVersion}`
      : 'rule-based detection'
    toast({
      title: `${list.length} suggestion${list.length !== 1 ? 's' : ''}`,
      description: `Generated with ${modeLabel}. Review, accept, or reject each one.`
    })
  }, [aiCropSuggestComplete])

  function rectChanged(s: SuggestionOverlay): boolean {
    const eps = 1
    return Math.abs(s.canvasX - s.origX) > eps || Math.abs(s.canvasY - s.origY) > eps ||
      Math.abs(s.canvasW - s.origW) > eps || Math.abs(s.canvasH - s.origH) > eps
  }

  async function acceptSuggestion(s: SuggestionOverlay) {
    if (!session) return
    const adjusted = rectChanged(s)
    try {
      // Convert to a real, fully-editable crop.
      const crop = await clipperApi.createCrop(session.id, {
        canvasX: s.canvasX, canvasY: s.canvasY, canvasW: s.canvasW, canvasH: s.canvasH,
        aspectRatio: s.aspectPreset
      })
      setCrops(prev => [...prev, {
        id: crop.id,
        canvasX: crop.canvasX, canvasY: crop.canvasY, canvasW: crop.canvasW, canvasH: crop.canvasH,
        sequence: crop.sequence, aspectRatio: crop.aspectRatio
      }])
      // Number the accepted crop by its vertical position.
      resequenceAndPersist()
      loadPreview(crop.id)

      // Record the feedback (accepted vs adjusted) for the next training run.
      await aiCropApi.updateSuggestion(s.id, {
        status: adjusted ? 'adjusted' : 'accepted',
        finalRect: { canvasX: s.canvasX, canvasY: s.canvasY, canvasW: s.canvasW, canvasH: s.canvasH }
      })

      setSuggestions(prev => prev.filter(x => x.id !== s.id))
      setSelectedCropId(crop.id)
    } catch (error) {
      console.error('Error accepting suggestion:', error)
      toast({ title: 'Error', description: 'Failed to accept suggestion', variant: 'destructive' })
    }
  }

  async function rejectSuggestion(s: SuggestionOverlay) {
    setSuggestions(prev => prev.filter(x => x.id !== s.id))
    try {
      await aiCropApi.updateSuggestion(s.id, { status: 'rejected' })
    } catch (error) {
      console.error('Error rejecting suggestion:', error)
    }
  }

  async function acceptAllSuggestions() {
    const list = [...suggestions]
    for (const s of list) {
      await acceptSuggestion(s)
    }
  }

  async function rejectAllSuggestions() {
    const list = [...suggestions]
    setSuggestions([])
    await Promise.all(list.map(s =>
      aiCropApi.updateSuggestion(s.id, { status: 'rejected' }).catch(() => {})
    ))
  }

  async function handleFinalize() {
    if (!session) return
    setIsFinalizing(true)
    try {
      await clipperApi.finalize(session.id)
    } catch (error) {
      console.error('Error starting finalization:', error)
      setIsFinalizing(false)
      toast({
        title: 'Error',
        description: 'Failed to start export',
        variant: 'destructive'
      })
    }
  }

  function scrollToCrop(cropId: string) {
    const crop = crops.find(c => c.id === cropId)
    if (!crop || !canvasContainerRef.current) return

    const targetScroll = crop.canvasY * zoom - containerHeight / 2
    canvasContainerRef.current.scrollTo({
      top: Math.max(0, targetScroll),
      behavior: 'smooth'
    })
    setSelectedCropId(cropId)
  }

  // ============ Minimap ============

  const MINIMAP_HEIGHT = 200
  const minimapScale = manifest ? MINIMAP_HEIGHT / (manifest.canvasHeight * zoom) : 0
  const minimapViewportHeight = containerHeight * minimapScale
  const minimapScrollTop = scrollTop * minimapScale

  function handleMinimapClick(e: React.MouseEvent) {
    if (!canvasContainerRef.current || !manifest) return
    const rect = (e.target as HTMLElement).closest('[data-minimap]')?.getBoundingClientRect()
    if (!rect) return
    const clickY = e.clientY - rect.top
    const targetScroll = (clickY / MINIMAP_HEIGHT) * (manifest.canvasHeight * zoom) - containerHeight / 2
    canvasContainerRef.current.scrollTo({
      top: Math.max(0, targetScroll),
      behavior: 'smooth'
    })
  }

  // ============ Render ============

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!manifest || !session) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>Failed to load workspace</p>
      </div>
    )
  }

  const scaledWidth = manifest.canvasWidth * zoom
  const scaledHeight = manifest.canvasHeight * zoom

  // AI status labels
  const aiModelStatusLabel = !aiStatus
    ? 'Checking AI…'
    : !aiStatus.sidecarAvailable
      ? 'AI sidecar not installed'
      : aiStatus.activeModelVersion != null
        ? `Model v${aiStatus.activeModelVersion} active`
        : 'No model trained yet — using rule-based detection'

  const aiCropButtonTooltip = isSuggesting
    ? 'A suggestion run is already in progress'
    : aiStatus && !aiStatus.sidecarAvailable
      ? (aiStatus.sidecarError || 'Run `npm run ml:setup` to enable AI cropping')
      : 'Generate AI crop suggestions for this chapter'

  const suggestProgress = aiCropSuggestProgress?.cropSessionId === session.id
    ? aiCropSuggestProgress
    : null

  const finalizeProgress = clipperFinalizeProgress?.sessionId === session.id
    ? clipperFinalizeProgress
    : null

  return (
    <div className="flex flex-col h-full">
      {/* Top Toolbar */}
      <div className="border-b bg-card px-4 py-2 flex items-center gap-3 flex-shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(session.chapter?.seriesId ? `/clipper/series/${session.chapter.seriesId}` : '/clipper')}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>

        <Separator orientation="vertical" className="h-6" />

        <span className="text-sm font-medium">
          Chapter {session.chapter?.number || '?'}
        </span>

        {/* Prev / Next chapter navigation */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs px-2"
            onClick={() => session.navigation?.prevChapterId && navigate(`/clipper/chapter/${session.navigation.prevChapterId}`)}
            disabled={!session.navigation?.prevChapterId}
            title={session.navigation?.prevChapterId ? `Go to Chapter ${session.navigation.prevChapterNumber}` : 'No previous chapter'}
          >
            <ArrowLeft className="h-3.5 w-3.5 mr-1" />
            Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs px-2"
            onClick={() => session.navigation?.nextChapterId && navigate(`/clipper/chapter/${session.navigation.nextChapterId}`)}
            disabled={!session.navigation?.nextChapterId}
            title={session.navigation?.nextChapterId ? `Go to Chapter ${session.navigation.nextChapterNumber}` : 'No next chapter'}
          >
            Next
            <ArrowRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>

        <Separator orientation="vertical" className="h-6" />

        {/* Zoom Controls */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setZoom(z => Math.max(0.1, z - 0.1))}
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs text-muted-foreground w-12 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setZoom(z => Math.min(2, z + 0.1))}
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => {
              if (manifest) {
                const availableWidth = window.innerWidth - 64 - (sidebarOpen ? 280 : 0) - 80
                setZoom(Math.min(1, availableWidth / manifest.canvasWidth))
              }
            }}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        <Separator orientation="vertical" className="h-6" />

        {/* AI Auto-Crop */}
        <div className="flex items-center gap-2" title={aiCropButtonTooltip}>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={runSuggest}
            disabled={isSuggesting || (aiStatus != null && !aiStatus.sidecarAvailable)}
          >
            {isSuggesting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                Cropping…
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5 mr-1" />
                Crop using AI
              </>
            )}
          </Button>
          {isSuggesting && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => session && aiCropApi.cancel(session.id)}
            >
              Cancel
            </Button>
          )}
          <span className="text-[11px] text-muted-foreground max-w-[200px] truncate">
            {aiModelStatusLabel}
          </span>
        </div>

        <div className="flex-1" />

        {/* Edit Video → (jump to the Video Editor for this series) */}
        {session.chapter?.seriesId && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => navigate(`/editor/${session.chapter!.seriesId}`)}
          >
            <Film className="h-3.5 w-3.5 mr-1" />
            Edit Video →
          </Button>
        )}

        {/* Crop Count */}
        <Badge variant="secondary">
          <Scissors className="h-3 w-3 mr-1" />
          {crops.length} crops
        </Badge>

        {/* Finalize Button */}
        <Button
          size="sm"
          onClick={handleFinalize}
          disabled={crops.length === 0 || isFinalizing}
        >
          {isFinalizing ? (
            <>
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              Exporting...
            </>
          ) : (
            <>
              <Download className="h-4 w-4 mr-1" />
              Save all crops
            </>
          )}
        </Button>
      </div>

      {/* Finalize Progress Bar */}
      {finalizeProgress && (
        <div className="border-b bg-card px-4 py-2">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              Exporting {finalizeProgress.current}/{finalizeProgress.total}
            </span>
            <Progress
              value={(finalizeProgress.current / finalizeProgress.total) * 100}
              className="flex-1 h-2"
            />
          </div>
        </div>
      )}

      {/* AI Suggest Progress Bar */}
      {suggestProgress && (
        <div className="border-b bg-card px-4 py-2">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground capitalize">
              AI: {suggestProgress.phase}…
            </span>
            <Progress value={suggestProgress.percent} className="flex-1 h-2" />
          </div>
        </div>
      )}

      {/* Suggestion Review Bar */}
      {suggestions.length > 0 && (
        <div className="border-b bg-amber-500/10 px-4 py-2 flex items-center gap-3">
          <Sparkles className="h-4 w-4 text-amber-500" />
          <span className="text-xs font-medium">
            {suggestions.length} AI suggestion{suggestions.length !== 1 ? 's' : ''} — drag to adjust, then accept or reject
          </span>
          <div className="flex-1" />
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={acceptAllSuggestions}>
            <CheckCheck className="h-3.5 w-3.5 mr-1" />
            Accept all
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={rejectAllSuggestions}>
            <Ban className="h-3.5 w-3.5 mr-1" />
            Reject all
          </Button>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Canvas Area */}
        <div
          ref={canvasContainerRef}
          className="flex-1 overflow-auto bg-neutral-950 relative"
          style={{ cursor: 'crosshair' }}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
        >
          {/* Canvas Container */}
          <div
            className="relative mx-auto"
            style={{
              width: scaledWidth,
              height: scaledHeight,
              margin: '20px auto'
            }}
          >
            {/* Images */}
            {manifest.images.map(img => {
              const visible = isImageVisible(img)
              return (
                <div
                  key={img.filename}
                  style={{
                    position: 'absolute',
                    top: img.canvasY * zoom,
                    left: 0,
                    // Canvas extents: every slice is scaled to the reference width.
                    width: manifest.canvasWidth * zoom,
                    height: img.canvasHeight * zoom
                  }}
                >
                  {visible ? (
                    <img
                      src={clipperApi.getImageUrl(chapterId!, img.filename)}
                      alt={img.filename}
                      style={{
                        width: '100%',
                        height: '100%',
                        display: 'block',
                        pointerEvents: 'none',
                        userSelect: 'none'
                      }}
                      draggable={false}
                      loading="lazy"
                    />
                  ) : (
                    <div
                      style={{
                        width: '100%',
                        height: '100%',
                        background: '#1a1a1a'
                      }}
                    />
                  )}
                </div>
              )
            })}

            {/* Crop Overlays */}
            {crops.map(crop => {
              const isSelected = crop.id === selectedCropId
              return (
                <CropOverlayDiv
                  key={crop.id}
                  crop={crop}
                  zoom={zoom}
                  isSelected={isSelected}
                  onSelect={() => {
                    setSelectedCropId(crop.id)
                  }}
                  onMove={(e) => handleCropMouseDown(e, crop.id, 'move')}
                  onResize={(e, handle) => handleCropMouseDown(e, crop.id, 'resize', handle)}
                  onDelete={() => deleteCrop(crop.id)}
                />
              )
            })}

            {/* AI Suggestion Overlays (distinct dashed amber, not real crops yet) */}
            {suggestions.map(s => (
              <SuggestionOverlayDiv
                key={s.id}
                suggestion={s}
                zoom={zoom}
                onMove={(e) => handleSuggestionMouseDown(e, s.id, 'move')}
                onResize={(e, handle) => handleSuggestionMouseDown(e, s.id, 'resize', handle)}
                onAccept={() => acceptSuggestion(s)}
                onReject={() => rejectSuggestion(s)}
              />
            ))}
          </div>
        </div>

        {/* Right Sidebar: Crop List */}
        {sidebarOpen && (
          <div className="w-[280px] border-l bg-card flex flex-col flex-shrink-0">
            <div className="p-4 border-b">
              <h3 className="text-sm font-semibold">Crops</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {crops.length} crop{crops.length !== 1 ? 's' : ''} total
              </p>
            </div>

            <ScrollArea className="flex-1">
              <div className="p-3 space-y-2">
                {crops.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Plus className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p className="text-xs">Click on the page to add a crop, then drag its edges or corners to adjust the height and width</p>
                  </div>
                ) : (
                  crops
                    .sort((a, b) => a.sequence - b.sequence)
                    .map(crop => (
                      <div
                        key={crop.id}
                        className={`p-2 rounded-lg border cursor-pointer transition-all ${
                          crop.id === selectedCropId
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:border-primary/50'
                        }`}
                        onClick={() => scrollToCrop(crop.id)}
                      >
                        <div className="flex items-center gap-2">
                          <GripVertical className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                          <span className="text-xs font-medium">
                            Crop #{crop.sequence}
                          </span>
                          {crop.aspectRatio && crop.aspectRatio !== 'free' && (
                            <Badge variant="outline" className="text-[10px] h-4 px-1">
                              {crop.aspectRatio}
                            </Badge>
                          )}
                          <div className="flex-1" />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={(e) => {
                              e.stopPropagation()
                              deleteCrop(crop.id)
                            }}
                          >
                            <Trash2 className="h-3 w-3 text-destructive" />
                          </Button>
                        </div>

                        {/* Preview thumbnail */}
                        {previews[crop.id] ? (
                          <div className="mt-2 rounded overflow-hidden bg-black">
                            <img
                              src={previews[crop.id]}
                              alt={`Crop ${crop.sequence}`}
                              className="w-full h-auto"
                              style={{ maxHeight: 120, objectFit: 'contain' }}
                            />
                          </div>
                        ) : (
                          <div className="mt-2 h-16 bg-muted rounded flex items-center justify-center">
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          </div>
                        )}

                        <div className="mt-1 text-[10px] text-muted-foreground">
                          {Math.round(crop.canvasW)}×{Math.round(crop.canvasH)} px
                        </div>
                      </div>
                    ))
                )}
              </div>
            </ScrollArea>
          </div>
        )}

        {/* Minimap */}
        {manifest.canvasHeight > 0 && (
          <div
            data-minimap
            className="fixed bottom-4 right-4 w-16 bg-card border rounded-lg overflow-hidden shadow-lg"
            style={{
              height: MINIMAP_HEIGHT,
              right: sidebarOpen ? 296 : 16,
              zIndex: 50
            }}
            onClick={handleMinimapClick}
          >
            {/* Canvas representation */}
            <div className="w-full h-full relative bg-neutral-900">
              {/* Simplified image bars */}
              {manifest.images.map(img => (
                <div
                  key={img.filename}
                  style={{
                    position: 'absolute',
                    top: (img.canvasY / manifest.canvasHeight) * MINIMAP_HEIGHT,
                    left: 0,
                    width: '100%',
                    height: Math.max(1, (img.canvasHeight / manifest.canvasHeight) * MINIMAP_HEIGHT),
                    background: '#333',
                    borderBottom: '1px solid #222'
                  }}
                />
              ))}

              {/* Crop indicators */}
              {crops.map(crop => (
                <div
                  key={crop.id}
                  style={{
                    position: 'absolute',
                    top: (crop.canvasY / manifest.canvasHeight) * MINIMAP_HEIGHT,
                    left: (crop.canvasX / manifest.canvasWidth) * 64,
                    width: Math.max(2, (crop.canvasW / manifest.canvasWidth) * 64),
                    height: Math.max(1, (crop.canvasH / manifest.canvasHeight) * MINIMAP_HEIGHT),
                    background: crop.id === selectedCropId ? '#3b82f6' : 'rgba(59,130,246,0.5)',
                    borderRadius: 1
                  }}
                />
              ))}

              {/* Viewport indicator */}
              <div
                className="absolute left-0 w-full border border-white/40 bg-white/10"
                style={{
                  top: Math.max(0, minimapScrollTop),
                  height: Math.min(minimapViewportHeight, MINIMAP_HEIGHT - minimapScrollTop)
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ============ Crop Overlay Component ============

interface CropOverlayDivProps {
  crop: CropOverlay
  zoom: number
  isSelected: boolean
  onSelect: () => void
  onMove: (e: React.MouseEvent) => void
  onResize: (e: React.MouseEvent, handle: string) => void
  onDelete: () => void
}

function CropOverlayDiv({
  crop,
  zoom,
  isSelected,
  onSelect,
  onMove,
  onResize,
  onDelete
}: CropOverlayDivProps) {
  const handleSize = 8
  // Resize from any edge or corner: top/bottom change height, left/right change
  // width, corners change both.
  const handles = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w']

  const handlePositions: Record<string, React.CSSProperties> = {
    nw: { top: -handleSize / 2, left: -handleSize / 2, cursor: 'nw-resize' },
    ne: { top: -handleSize / 2, right: -handleSize / 2, cursor: 'ne-resize' },
    sw: { bottom: -handleSize / 2, left: -handleSize / 2, cursor: 'sw-resize' },
    se: { bottom: -handleSize / 2, right: -handleSize / 2, cursor: 'se-resize' },
    n: { top: -handleSize / 2, left: '50%', marginLeft: -handleSize / 2, cursor: 'n-resize' },
    s: { bottom: -handleSize / 2, left: '50%', marginLeft: -handleSize / 2, cursor: 's-resize' },
    e: { top: '50%', right: -handleSize / 2, marginTop: -handleSize / 2, cursor: 'e-resize' },
    w: { top: '50%', left: -handleSize / 2, marginTop: -handleSize / 2, cursor: 'w-resize' }
  }

  return (
    <div
      data-crop-overlay
      style={{
        position: 'absolute',
        left: crop.canvasX * zoom,
        top: crop.canvasY * zoom,
        width: crop.canvasW * zoom,
        height: crop.canvasH * zoom,
        border: isSelected ? '2px solid #3b82f6' : '2px solid rgba(255,255,255,0.6)',
        background: isSelected ? 'rgba(59,130,246,0.1)' : 'rgba(255,255,255,0.05)',
        cursor: 'move',
        zIndex: isSelected ? 20 : 10,
        boxShadow: isSelected ? '0 0 0 1px rgba(59,130,246,0.3)' : undefined
      }}
      onMouseDown={(e) => {
        e.stopPropagation()
        onSelect()
        onMove(e)
      }}
    >
      {/* Sequence label */}
      <div
        style={{
          position: 'absolute',
          top: 4,
          left: 4,
          background: isSelected ? '#3b82f6' : 'rgba(0,0,0,0.7)',
          color: 'white',
          fontSize: 10,
          fontWeight: 600,
          padding: '1px 6px',
          borderRadius: 4,
          pointerEvents: 'none',
          userSelect: 'none'
        }}
      >
        {crop.sequence}
      </div>

      {/* Delete button */}
      {isSelected && (
        <button
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            background: '#ef4444',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            width: 20,
            height: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            fontSize: 12
          }}
          onMouseDown={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          ×
        </button>
      )}

      {/* Resize Handles */}
      {isSelected && handles.map(h => (
        <div
          key={h}
          style={{
            position: 'absolute',
            width: handleSize,
            height: handleSize,
            background: '#3b82f6',
            border: '1px solid white',
            borderRadius: 2,
            ...handlePositions[h]
          }}
          onMouseDown={(e) => {
            e.stopPropagation()
            onResize(e, h)
          }}
        />
      ))}
    </div>
  )
}

// ============ AI Suggestion Overlay Component ============

interface SuggestionOverlayDivProps {
  suggestion: SuggestionOverlay
  zoom: number
  onMove: (e: React.MouseEvent) => void
  onResize: (e: React.MouseEvent, handle: string) => void
  onAccept: () => void
  onReject: () => void
}

const SUGGESTION_COLOR = '#f59e0b' // amber-500

function SuggestionOverlayDiv({
  suggestion: s,
  zoom,
  onMove,
  onResize,
  onAccept,
  onReject
}: SuggestionOverlayDivProps) {
  const handleSize = 8
  const handles = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w']
  const handlePositions: Record<string, React.CSSProperties> = {
    nw: { top: -handleSize / 2, left: -handleSize / 2, cursor: 'nw-resize' },
    ne: { top: -handleSize / 2, right: -handleSize / 2, cursor: 'ne-resize' },
    sw: { bottom: -handleSize / 2, left: -handleSize / 2, cursor: 'sw-resize' },
    se: { bottom: -handleSize / 2, right: -handleSize / 2, cursor: 'se-resize' },
    n: { top: -handleSize / 2, left: '50%', marginLeft: -handleSize / 2, cursor: 'n-resize' },
    s: { bottom: -handleSize / 2, left: '50%', marginLeft: -handleSize / 2, cursor: 's-resize' },
    e: { top: '50%', right: -handleSize / 2, marginTop: -handleSize / 2, cursor: 'e-resize' },
    w: { top: '50%', left: -handleSize / 2, marginTop: -handleSize / 2, cursor: 'w-resize' }
  }

  const confidencePct = Math.round(s.confidence * 100)

  return (
    <div
      data-crop-overlay
      style={{
        position: 'absolute',
        left: s.canvasX * zoom,
        top: s.canvasY * zoom,
        width: s.canvasW * zoom,
        height: s.canvasH * zoom,
        border: `2px dashed ${SUGGESTION_COLOR}`,
        background: 'rgba(245, 158, 11, 0.08)',
        cursor: 'move',
        zIndex: 15
      }}
      onMouseDown={(e) => {
        e.stopPropagation()
        onMove(e)
      }}
    >
      {/* Confidence + preset badge */}
      <div
        style={{
          position: 'absolute',
          top: 4,
          left: 4,
          background: SUGGESTION_COLOR,
          color: 'white',
          fontSize: 10,
          fontWeight: 600,
          padding: '1px 6px',
          borderRadius: 4,
          pointerEvents: 'none',
          userSelect: 'none',
          display: 'flex',
          gap: 4
        }}
      >
        <span>AI</span>
        <span>{confidencePct}%</span>
        {s.aspectPreset && s.aspectPreset !== 'free' && <span>{s.aspectPreset}</span>}
      </div>

      {/* Accept / Reject buttons */}
      <div style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 4 }}>
        <button
          title="Accept"
          style={{
            background: '#22c55e', color: 'white', border: 'none', borderRadius: 4,
            width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer'
          }}
          onMouseDown={(e) => { e.stopPropagation(); onAccept() }}
        >
          <Check className="h-3 w-3" />
        </button>
        <button
          title="Reject"
          style={{
            background: '#ef4444', color: 'white', border: 'none', borderRadius: 4,
            width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer'
          }}
          onMouseDown={(e) => { e.stopPropagation(); onReject() }}
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {/* Resize Handles */}
      {handles.map(h => (
        <div
          key={h}
          style={{
            position: 'absolute',
            width: handleSize,
            height: handleSize,
            background: SUGGESTION_COLOR,
            border: '1px solid white',
            borderRadius: 2,
            ...handlePositions[h]
          }}
          onMouseDown={(e) => { e.stopPropagation(); onResize(e, h) }}
        />
      ))}
    </div>
  )
}
