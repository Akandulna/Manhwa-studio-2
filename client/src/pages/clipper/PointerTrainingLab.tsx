/**
 * Image Clipper 2.0 Training — manual crop -> real PNG export.
 *
 * Same interaction model as Module 3 v1's ClipperWorkspace (click to drop a
 * full-width crop, drag any edge/corner to resize, drag the body to move) and
 * the same cutting code (clipperService.executeCrop), applied to a chapter's
 * existing stitched canvas (clipperApi.getManifest — the same manifest
 * ClipperWorkspace and AiCropLab already use).
 *
 * This is a training/export tool ONLY. Exports go to crops_training/, a
 * folder the production Clipper 2.0 pipeline (detect/apply), CropSession, and
 * Module 4 never read — nothing here can affect a real crop_points.json,
 * crops2/ export, or anything the Video Editor sees.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import {
  Trash2, Eye, EyeOff, ZoomIn, ZoomOut, Loader2, Download, ClipboardPaste,
  ArrowLeft, ChevronRight, Globe, Image as ImageIcon, CheckCircle,
  Upload, Plus, ArrowUp, ArrowDown, X, FolderOpen
} from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import {
  clipperApi, pointerTrainingApi, pointerTrainingUploadApi,
  type ImageManifest, type ManifestImage, type ClipperSeries,
  type TrainingChapterSummary, type TrainingExportedFile
} from '@/lib/api'
import { renderTrainingCropPreview } from '@/lib/trainingCropPreview'

// ============ Local types ============

interface LocalCrop {
  id: string
  reason: string
  canvasX: number
  canvasY: number
  canvasW: number
  canvasH: number
  visible: boolean
}

interface DragState {
  cropId: string
  type: 'move' | 'resize'
  handle?: string
  startX: number
  startY: number
  originalCrop: { canvasX: number; canvasY: number; canvasW: number; canvasH: number }
}

const CROP_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#ef4444', '#84cc16']
const BUFFER_PX = 2000
const MIN_CROP_SIZE = 20

function colorFor(index: number): string {
  return CROP_COLORS[index % CROP_COLORS.length]
}

// ============ Component ============

export default function PointerTrainingLab() {
  const { toast } = useToast()

  // Series -> Chapters -> Workspace, same flow as Image Clipper v1 (ClipperLibrary
  // -> ClipperSeriesView -> ClipperWorkspace) and Narration Studio. 'upload' is a
  // parallel entry point: build an ordered image set from disk instead of picking
  // a downloaded chapter, to test the crop tool against anything at hand.
  const [view, setView] = useState<'series' | 'chapters' | 'upload' | 'workspace'>('series')
  const [seriesList, setSeriesList] = useState<ClipperSeries[]>([])
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(true)

  const [chapters, setChapters] = useState<TrainingChapterSummary[]>([])
  const [chapterId, setChapterId] = useState<string>('')
  // Non-null exactly when the current workspace is an uploaded image set rather
  // than a downloaded chapter — every source-dependent action below branches on it.
  const [uploadId, setUploadId] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const [manifest, setManifest] = useState<ImageManifest | null>(null)
  const [crops, setCrops] = useState<LocalCrop[]>([])
  const [selectedCropId, setSelectedCropId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [zoom, setZoom] = useState(0.5)
  const [exportedFiles, setExportedFiles] = useState<TrainingExportedFile[]>([])
  const nextCropNumber = useRef(1)

  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteMode, setPasteMode] = useState<'append' | 'replace'>('append')

  const [dragState, setDragState] = useState<DragState | null>(null)
  const canvasContainerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(0)

  const refreshChapters = useCallback(async () => {
    try {
      setChapters(await pointerTrainingApi.getChapters())
    } catch (err) {
      console.error('Error loading training chapters:', err)
    }
  }, [])

  useEffect(() => {
    (async () => {
      setListLoading(true)
      try {
        const [s, ch] = await Promise.all([clipperApi.getSeries(), pointerTrainingApi.getChapters()])
        setSeriesList(s)
        setChapters(ch)
      } catch (err) {
        console.error('Error loading training library:', err)
      } finally {
        setListLoading(false)
      }
    })()
  }, [])

  // Only series that actually have a chapter eligible for training (status: done).
  const trainingSeries = useMemo(
    () => seriesList.filter(s => chapters.some(c => c.seriesId === s.id)),
    [seriesList, chapters]
  )
  const selectedSeries = useMemo(
    () => trainingSeries.find(s => s.id === selectedSeriesId) ?? null,
    [trainingSeries, selectedSeriesId]
  )
  const seriesChapters = useMemo(
    () => chapters.filter(c => c.seriesId === selectedSeriesId).sort((a, b) => a.number - b.number),
    [chapters, selectedSeriesId]
  )

  function openSeries(id: string) {
    setSelectedSeriesId(id)
    setView('chapters')
  }

  function backToSeries() {
    setView('series')
    setSelectedSeriesId(null)
  }

  /** Leaving the workspace goes back to wherever it was opened from: the
   * chapter grid for a real chapter, or the upload picker for a sandbox set. */
  function backFromWorkspace() {
    setView(uploadId ? 'upload' : 'chapters')
    setChapterId('')
    setManifest(null)
    setCrops([])
    setSelectedCropId(null)
    setExportedFiles([])
  }

  // ============ Load a chapter ============

  async function loadChapter(id: string) {
    if (!id) return
    setLoading(true)
    setSelectedCropId(null)
    setCrops([])
    nextCropNumber.current = 1
    try {
      const [m, outputs] = await Promise.all([
        clipperApi.getManifest(id),
        pointerTrainingApi.getOutputs(id).catch(() => ({ exportDir: null, files: [] }))
      ])
      setManifest(m)
      setExportedFiles(outputs.files)
      const availableWidth = window.innerWidth - 64 - 340
      const fitZoom = Math.min(1, availableWidth / m.canvasWidth)
      setZoom(Math.max(0.1, Math.min(1, fitZoom)))
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to load chapter', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  function openChapter(id: string) {
    setUploadId(null)
    setChapterId(id)
    setView('workspace')
    loadChapter(id)
  }

  // ============ Upload picker: build an ordered image set from disk ============

  function openUploadPicker() {
    setView('upload')
  }

  function handleAddFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    const images = Array.from(fileList).filter(f => f.type.startsWith('image/'))
    setPendingFiles(prev => [...prev, ...images])
    if (uploadInputRef.current) uploadInputRef.current.value = ''
  }

  function movePendingFile(index: number, dir: -1 | 1) {
    setPendingFiles(prev => {
      const target = index + dir
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      const tmp = next[index]
      next[index] = next[target]
      next[target] = tmp
      return next
    })
  }

  function removePendingFile(index: number) {
    setPendingFiles(prev => prev.filter((_, i) => i !== index))
  }

  async function handleStartTesting() {
    if (pendingFiles.length === 0) return
    setLoading(true)
    try {
      // Best-effort: don't leave the previous sandbox session's folder behind
      // when starting a new one from the same picker.
      if (uploadId) pointerTrainingUploadApi.remove(uploadId).catch(() => {})

      const result = await pointerTrainingUploadApi.upload(pendingFiles)
      setUploadId(result.uploadId)
      setChapterId('')
      setManifest(result.manifest)
      setCrops([])
      setSelectedCropId(null)
      setExportedFiles([])
      nextCropNumber.current = 1
      const availableWidth = window.innerWidth - 64 - 340
      const fitZoom = Math.min(1, availableWidth / result.manifest.canvasWidth)
      setZoom(Math.max(0.1, Math.min(1, fitZoom)))
      setView('workspace')
    } catch (err) {
      toast({ title: 'Upload failed', description: err instanceof Error ? err.message : 'Failed to upload images', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  /** Deletes the sandbox session entirely (images + exports) and returns to the picker. */
  async function handleDeleteUploadSession() {
    if (!uploadId) return
    try {
      await pointerTrainingUploadApi.remove(uploadId)
    } catch (err) {
      console.error('Error deleting upload session:', err)
    }
    setUploadId(null)
    setPendingFiles([])
    setChapterId('')
    setManifest(null)
    setCrops([])
    setSelectedCropId(null)
    setExportedFiles([])
    setView('upload')
  }

  /** Source-agnostic image URL: an uploaded sandbox set, or a real chapter's pages. */
  const imageUrlFor = useCallback((filename: string) => {
    return uploadId ? pointerTrainingUploadApi.getImageUrl(uploadId, filename) : clipperApi.getImageUrl(chapterId, filename)
  }, [uploadId, chapterId])

  // Thumbnail previews for the upload picker. Regenerated (and the old ones
  // revoked) whenever the pending list changes shape or order.
  const [pendingPreviews, setPendingPreviews] = useState<string[]>([])
  useEffect(() => {
    const urls = pendingFiles.map(f => URL.createObjectURL(f))
    setPendingPreviews(urls)
    return () => { urls.forEach(u => URL.revokeObjectURL(u)) }
  }, [pendingFiles])

  // ============ Scroll tracking (virtualization) ============

  useEffect(() => {
    const container = canvasContainerRef.current
    if (!container) return
    const handleScroll = () => setScrollTop(container.scrollTop)
    const observer = new ResizeObserver(() => setContainerHeight(container.clientHeight))
    container.addEventListener('scroll', handleScroll, { passive: true })
    observer.observe(container)
    setContainerHeight(container.clientHeight)
    return () => {
      container.removeEventListener('scroll', handleScroll)
      observer.disconnect()
    }
  }, [manifest])

  const isImageVisible = useCallback((img: ManifestImage): boolean => {
    const scaledY = img.canvasY * zoom
    const scaledH = img.canvasHeight * zoom
    const viewTop = scrollTop - BUFFER_PX
    const viewBottom = scrollTop + containerHeight + BUFFER_PX
    return scaledY + scaledH > viewTop && scaledY < viewBottom
  }, [scrollTop, containerHeight, zoom])

  // ============ Coordinates ============

  function getCanvasCoords(e: React.MouseEvent): { x: number; y: number } {
    const container = canvasContainerRef.current
    if (!container) return { x: 0, y: 0 }
    const rect = container.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left + container.scrollLeft) / zoom,
      y: (e.clientY - rect.top + container.scrollTop) / zoom
    }
  }

  // ============ Click empty canvas to add a full-width crop (same as v1) ============

  function handleCanvasMouseDown(e: React.MouseEvent) {
    if ((e.target as HTMLElement).dataset.cropOverlay) return
    if (dragState || !manifest) return

    const coords = getCanvasCoords(e)
    const fullW = manifest.canvasWidth
    const squareH = Math.min(manifest.canvasHeight, fullW)
    let y = coords.y - squareH / 2
    y = Math.max(0, Math.min(y, manifest.canvasHeight - squareH))

    const newCrop: LocalCrop = {
      id: `crop-${nextCropNumber.current++}`,
      reason: '',
      canvasX: 0,
      canvasY: y,
      canvasW: fullW,
      canvasH: squareH,
      visible: true
    }
    setCrops(prev => [...prev, newCrop])
    setSelectedCropId(newCrop.id)
  }

  // ============ Drag: move or resize ============

  function handleCropMouseDown(e: React.MouseEvent, cropId: string, type: 'move' | 'resize', handle?: string) {
    e.stopPropagation()
    e.preventDefault()
    const crop = crops.find(c => c.id === cropId)
    if (!crop) return
    const coords = getCanvasCoords(e)
    setDragState({
      cropId, type, handle,
      startX: coords.x, startY: coords.y,
      originalCrop: { canvasX: crop.canvasX, canvasY: crop.canvasY, canvasW: crop.canvasW, canvasH: crop.canvasH }
    })
    setSelectedCropId(cropId)
  }

  function handleCanvasMouseMove(e: React.MouseEvent) {
    if (!dragState || !manifest) return
    const coords = getCanvasCoords(e)
    const dx = coords.x - dragState.startX
    const dy = coords.y - dragState.startY
    const orig = dragState.originalCrop
    const maxW = manifest.canvasWidth
    const maxH = manifest.canvasHeight

    let newX = orig.canvasX
    let newY = orig.canvasY
    let newW = orig.canvasW
    let newH = orig.canvasH

    if (dragState.type === 'move') {
      newX = Math.max(0, Math.min(orig.canvasX + dx, maxW - orig.canvasW))
      newY = Math.max(0, Math.min(orig.canvasY + dy, maxH - orig.canvasH))
    } else {
      const h = dragState.handle
      if (h?.includes('e')) newW = Math.max(MIN_CROP_SIZE, Math.min(orig.canvasW + dx, maxW - orig.canvasX))
      if (h?.includes('s')) newH = Math.max(MIN_CROP_SIZE, Math.min(orig.canvasH + dy, maxH - orig.canvasY))
      if (h?.includes('w')) {
        const right = orig.canvasX + orig.canvasW
        newX = Math.max(0, Math.min(orig.canvasX + dx, right - MIN_CROP_SIZE))
        newW = right - newX
      }
      if (h?.includes('n')) {
        const bottom = orig.canvasY + orig.canvasH
        newY = Math.max(0, Math.min(orig.canvasY + dy, bottom - MIN_CROP_SIZE))
        newH = bottom - newY
      }
    }

    setCrops(prev => prev.map(c => c.id === dragState.cropId ? { ...c, canvasX: newX, canvasY: newY, canvasW: newW, canvasH: newH } : c))
  }

  function handleCanvasMouseUp() {
    setDragState(null)
  }

  // ============ Crop list operations ============

  function updateCrop(id: string, patch: Partial<LocalCrop>) {
    setCrops(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c))
  }

  function deleteCrop(id: string) {
    setCrops(prev => prev.filter(c => c.id !== id))
    if (selectedCropId === id) setSelectedCropId(null)
  }

  function scrollToCrop(id: string) {
    const crop = crops.find(c => c.id === id)
    const container = canvasContainerRef.current
    if (!crop || !container) return
    const targetY = crop.canvasY * zoom - containerHeight / 2
    container.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' })
  }

  const orderedCrops = useMemo(() => [...crops].sort((a, b) => a.canvasY - b.canvasY), [crops])

  // ============ Export ============

  async function handleExport() {
    if ((!chapterId && !uploadId) || orderedCrops.length === 0) return
    setExporting(true)
    try {
      const rects = orderedCrops.map(c => ({ canvasX: c.canvasX, canvasY: c.canvasY, canvasW: c.canvasW, canvasH: c.canvasH }))
      const result = uploadId
        ? await pointerTrainingUploadApi.export(uploadId, rects)
        : await pointerTrainingApi.export(chapterId, rects)
      setExportedFiles(result.files)
      toast({
        title: 'Export complete',
        description: `${result.exported} crop(s) exported${result.failed ? `, ${result.failed} failed` : ''} to crops_training/.`
      })
      if (!uploadId) refreshChapters()
    } catch (err) {
      toast({ title: 'Export failed', description: err instanceof Error ? err.message : 'Failed to export', variant: 'destructive' })
    } finally {
      setExporting(false)
    }
  }

  async function handleClearExports() {
    if (!chapterId && !uploadId) return
    try {
      if (uploadId) await pointerTrainingUploadApi.clearOutputs(uploadId)
      else await pointerTrainingApi.clear(chapterId)
      setExportedFiles([])
      toast({ title: 'Cleared exported training crops' })
      if (!uploadId) refreshChapters()
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to clear', variant: 'destructive' })
    }
  }

  // ============ Paste JSON ============

  /**
   * A pasted entry can be either this tool's own rect shape (canvasX/Y/W/H) or
   * this app's standard four-point-crop shape (crop.points, 4 normalized [0,1]
   * P1..P4 points) — the format crop_points.json/Gemini/ChatGPT output already
   * uses elsewhere in the app, and the more likely thing someone has on hand.
   * The outer AABB of the 4 points becomes the rect (points are always an
   * axis-aligned rectangle in that format's "rectangle" mode; a "perspective"
   * quad is flattened to its bounding box, since this tool is rectangle-only).
   */
  function rectFromEntry(entry: any, index: number): { canvasX: number; canvasY: number; canvasW: number; canvasH: number } {
    const points = entry?.crop?.points
    if (Array.isArray(points)) {
      if (!manifest) throw new Error('No chapter loaded to resolve normalized points against')
      if (points.length !== 4) throw new Error(`crop #${index + 1}: crop.points must have exactly 4 points`)
      const xs = points.map((p: any) => Number(p?.x))
      const ys = points.map((p: any) => Number(p?.y))
      if (![...xs, ...ys].every(Number.isFinite)) {
        throw new Error(`crop #${index + 1}: crop.points needs numeric x/y on every point`)
      }
      const minX = Math.min(...xs), maxX = Math.max(...xs)
      const minY = Math.min(...ys), maxY = Math.max(...ys)
      return {
        canvasX: minX * manifest.canvasWidth,
        canvasY: minY * manifest.canvasHeight,
        canvasW: (maxX - minX) * manifest.canvasWidth,
        canvasH: (maxY - minY) * manifest.canvasHeight
      }
    }

    const canvasX = Number(entry?.canvasX)
    const canvasY = Number(entry?.canvasY)
    const canvasW = Number(entry?.canvasW)
    const canvasH = Number(entry?.canvasH)
    if (![canvasX, canvasY, canvasW, canvasH].every(Number.isFinite)) {
      throw new Error(`crop #${index + 1} needs either canvasX/canvasY/canvasW/canvasH, or a "crop.points" array of 4 normalized {x,y} points`)
    }
    return { canvasX, canvasY, canvasW, canvasH }
  }

  function handlePasteLoad() {
    try {
      const parsed = JSON.parse(pasteText)
      const rawCrops = Array.isArray(parsed?.crops) ? parsed.crops : Array.isArray(parsed) ? parsed : null
      if (!rawCrops) throw new Error('Expected an object with a "crops" array (or a bare array of crops)')

      const maxW = manifest?.canvasWidth ?? Infinity
      const maxH = manifest?.canvasHeight ?? Infinity
      const existingIds = new Set(pasteMode === 'append' ? crops.map(c => c.id) : [])

      const loaded: LocalCrop[] = rawCrops.map((entry: any, i: number) => {
        const { canvasX: x, canvasY: y, canvasW: w, canvasH: h } = rectFromEntry(entry, i)

        let id = typeof entry.id === 'string' && entry.id.trim() ? entry.id : `crop-${nextCropNumber.current++}`
        while (existingIds.has(id)) id = `${id}-2`
        existingIds.add(id)

        const canvasW = Math.max(MIN_CROP_SIZE, Math.min(w, maxW))
        const canvasH = Math.max(MIN_CROP_SIZE, Math.min(h, maxH))
        return {
          id,
          reason: typeof entry.reason === 'string' ? entry.reason : '',
          canvasX: Math.max(0, Math.min(x, maxW - canvasW)),
          canvasY: Math.max(0, Math.min(y, maxH - canvasH)),
          canvasW,
          canvasH,
          visible: true
        }
      })

      setCrops(prev => pasteMode === 'append' ? [...prev, ...loaded] : loaded)
      setPasteOpen(false)
      setPasteText('')
      toast({ title: 'Loaded', description: `${loaded.length} crop(s) loaded from pasted JSON.` })
    } catch (err) {
      toast({ title: 'Paste failed', description: err instanceof Error ? err.message : 'Invalid JSON', variant: 'destructive' })
    }
  }

  const selectedCrop = useMemo(() => crops.find(c => c.id === selectedCropId) ?? null, [crops, selectedCropId])
  const currentChapter = useMemo(() => chapters.find(c => c.id === chapterId) ?? null, [chapters, chapterId])

  // ============ Render: pick a series ============

  if (view === 'series') {
    if (listLoading) {
      return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
    }
    if (trainingSeries.length === 0) {
      return (
        <div className="p-6 text-center">
          <ImageIcon className="h-16 w-16 mx-auto text-muted-foreground mb-4 opacity-30" />
          <h2 className="text-xl font-semibold mb-2">No Series Ready for Training</h2>
          <p className="text-muted-foreground max-w-md mx-auto mb-4">
            Download some chapters using the Library &amp; Downloader module first to unlock Image Clipper 2.0 Training.
          </p>
          <Button onClick={openUploadPicker}>
            <Upload className="h-4 w-4 mr-1" />Or upload images to test the crop tool
          </Button>
        </div>
      )
    }
    return (
      <div className="p-6 h-full overflow-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold">Image Clipper 2.0 Training</h2>
            <p className="text-muted-foreground mt-1 text-sm">Select a series to start manually cropping its chapters</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{trainingSeries.length} series</span>
            <Button size="sm" variant="outline" onClick={openUploadPicker}>
              <Upload className="h-4 w-4 mr-1" />Upload Images to Test
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {trainingSeries.map(s => {
            const chs = chapters.filter(c => c.seriesId === s.id)
            const exported = chs.filter(c => c.exportedCount > 0).length
            const progress = chs.length > 0 ? Math.round((exported / chs.length) * 100) : 0
            return (
              <Card key={s.id} className="h-full hover:border-primary transition-colors cursor-pointer" onClick={() => openSeries(s.id)}>
                <CardContent className="p-4">
                  <div className="aspect-[3/4] bg-muted rounded-lg mb-3 flex items-center justify-center overflow-hidden">
                    {s.coverPath ? (
                      <img
                        src={`file://${s.coverPath}`}
                        alt={s.title}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none'
                          e.currentTarget.parentElement!.innerHTML = `<div class="flex items-center justify-center w-full h-full"><span class="text-4xl">📚</span></div>`
                        }}
                      />
                    ) : (
                      <span className="text-4xl">📚</span>
                    )}
                  </div>
                  <h3 className="font-semibold truncate mb-2">{s.title}</h3>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
                    <Globe className="h-3 w-3" />
                    <span className="truncate">{s.sourceSite}</span>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      {progress === 100
                        ? <Badge variant="success" className="flex items-center gap-1"><CheckCircle className="h-3 w-3" />Complete</Badge>
                        : <Badge variant="secondary" className="flex items-center gap-1"><ImageIcon className="h-3 w-3" />{exported}/{chs.length}</Badge>}
                      <span className="text-xs text-muted-foreground">{progress}%</span>
                    </div>
                    <Progress value={progress} className="h-1.5" />
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>
    )
  }

  // ============ Render: pick a chapter within the series ============

  if (view === 'chapters') {
    const exportedCount = seriesChapters.filter(c => c.exportedCount > 0).length
    const progress = seriesChapters.length > 0 ? Math.round((exportedCount / seriesChapters.length) * 100) : 0
    return (
      <div className="flex flex-col h-full">
        <div className="p-6 pb-4 border-b flex-shrink-0">
          <div className="flex items-start gap-4">
            <Button variant="ghost" size="icon" onClick={backToSeries}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-bold truncate">{selectedSeries?.title}</h2>
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground mt-1">
                <span>{seriesChapters.length} chapters eligible for training</span>
                <span>•</span>
                <span>{exportedCount} with exports</span>
              </div>
              <div className="max-w-md mt-3">
                <div className="flex items-center justify-between text-sm mb-1">
                  <span>Training Progress</span>
                  <span>{progress}%</span>
                </div>
                <Progress value={progress} className="h-2" />
              </div>
            </div>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {seriesChapters.map(ch => (
              <Card key={ch.id} className="cursor-pointer hover:border-primary transition-colors group" onClick={() => openChapter(ch.id)}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm truncate">Chapter {ch.number}</span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                  </div>
                  {ch.title && <p className="text-xs text-muted-foreground mt-1 truncate">{ch.title}</p>}
                  <div className="flex items-center gap-2 mt-2">
                    <Badge variant={ch.exportedCount > 0 ? 'default' : 'outline'} className="text-xs">
                      {ch.exportedCount > 0 ? `${ch.exportedCount} exported` : 'Ready'}
                    </Badge>
                    {ch.pageCount > 0 && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <ImageIcon className="h-3 w-3" />{ch.pageCount}
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </ScrollArea>
      </div>
    )
  }

  // ============ Render: upload picker ============

  if (view === 'upload') {
    return (
      <div className="flex flex-col h-full">
        <div className="p-6 pb-4 border-b flex-shrink-0">
          <div className="flex items-start gap-4">
            <Button variant="ghost" size="icon" onClick={() => setView('series')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-bold">Upload Images to Test</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Pick single or multiple manhwa page images from disk — they stitch into one canvas
                in the order shown below. Use the arrows to fix the order before starting.
              </p>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-6 max-w-2xl mx-auto space-y-4">
            <input
              ref={uploadInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => handleAddFiles(e.target.files)}
            />
            <div className="flex items-center gap-2">
              <Button onClick={() => uploadInputRef.current?.click()}>
                <Plus className="h-4 w-4 mr-1" />Add Images
              </Button>
              {pendingFiles.length > 0 && (
                <Button variant="ghost" className="text-destructive" onClick={() => setPendingFiles([])}>
                  Clear all
                </Button>
              )}
              <div className="flex-1" />
              <span className="text-sm text-muted-foreground">
                {pendingFiles.length} image{pendingFiles.length === 1 ? '' : 's'}
              </span>
            </div>

            {pendingFiles.length === 0 ? (
              <div className="text-center py-16 border-2 border-dashed rounded-lg text-muted-foreground">
                <FolderOpen className="h-10 w-10 mx-auto mb-2 opacity-40" />
                <p>No images added yet. Click "Add Images" to pick one or more files.</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {pendingFiles.map((file, i) => (
                  <div key={`${file.name}-${i}`} className="flex items-center gap-3 border rounded-md p-2">
                    <span className="w-6 text-center text-xs font-semibold text-muted-foreground">{i + 1}</span>
                    {pendingPreviews[i] && (
                      <img src={pendingPreviews[i]} alt="" className="w-10 h-10 object-cover rounded border flex-shrink-0" />
                    )}
                    <span className="flex-1 text-sm truncate">{file.name}</span>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={i === 0} onClick={() => movePendingFile(i, -1)}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={i === pendingFiles.length - 1} onClick={() => movePendingFile(i, 1)}>
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => removePendingFile(i)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="p-4 border-t flex justify-end flex-shrink-0">
          <Button onClick={handleStartTesting} disabled={pendingFiles.length === 0 || loading}>
            {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />}
            Start Testing
          </Button>
        </div>
      </div>
    )
  }

  // ============ Render: workspace ============

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 p-3 border-b flex-wrap">
        <Button size="sm" variant="ghost" onClick={backFromWorkspace}>
          <ArrowLeft className="h-4 w-4 mr-1" />Back
        </Button>
        <div className="text-sm font-medium truncate max-w-[260px]">
          {uploadId
            ? `Uploaded test set (${manifest?.images.length ?? pendingFiles.length} images)`
            : <>{selectedSeries?.title}{currentChapter ? ` · Chapter ${currentChapter.number}` : ''}</>}
        </div>

        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}

        {uploadId && (
          <Button size="sm" variant="ghost" className="text-destructive" onClick={handleDeleteUploadSession}>
            <Trash2 className="h-4 w-4 mr-1" />Delete test session
          </Button>
        )}

        <div className="flex-1" />

        <Button size="sm" variant="outline" onClick={() => setZoom(z => Math.max(0.1, z - 0.1))} disabled={!manifest}>
          <ZoomOut className="h-4 w-4" />
        </Button>
        <span className="text-xs text-muted-foreground w-10 text-center">{Math.round(zoom * 100)}%</span>
        <Button size="sm" variant="outline" onClick={() => setZoom(z => Math.min(1.5, z + 0.1))} disabled={!manifest}>
          <ZoomIn className="h-4 w-4" />
        </Button>

        <Button size="sm" variant="outline" onClick={() => setPasteOpen(true)} disabled={!manifest}>
          <ClipboardPaste className="h-4 w-4 mr-1" />Paste JSON
        </Button>

        <Button size="sm" onClick={handleExport} disabled={!manifest || crops.length === 0 || exporting}>
          {exporting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />}
          Export Crops
        </Button>
      </div>

      {!manifest ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          {loading ? 'Loading…' : 'Failed to load this image set.'}
        </div>
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* Canvas */}
          <div
            ref={canvasContainerRef}
            className="flex-1 overflow-auto bg-neutral-950 relative"
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            onMouseLeave={handleCanvasMouseUp}
          >
            <div
              className="relative mx-auto"
              style={{ width: manifest.canvasWidth * zoom, height: manifest.canvasHeight * zoom }}
            >
              {manifest.images.filter(isImageVisible).map(img => (
                <img
                  key={img.filename}
                  src={imageUrlFor(img.filename)}
                  alt=""
                  loading="lazy"
                  draggable={false}
                  style={{
                    position: 'absolute', top: img.canvasY * zoom, left: 0,
                    width: manifest.canvasWidth * zoom, height: img.canvasHeight * zoom,
                    pointerEvents: 'none', userSelect: 'none'
                  }}
                />
              ))}

              {crops.map(c => (
                <CropOverlayDiv
                  key={c.id}
                  crop={c}
                  zoom={zoom}
                  sequence={orderedCrops.findIndex(o => o.id === c.id) + 1}
                  color={colorFor(orderedCrops.findIndex(o => o.id === c.id))}
                  isSelected={c.id === selectedCropId}
                  onSelect={() => setSelectedCropId(c.id)}
                  onMove={(e) => handleCropMouseDown(e, c.id, 'move')}
                  onResize={(e, handle) => handleCropMouseDown(e, c.id, 'resize', handle)}
                  onDelete={() => deleteCrop(c.id)}
                />
              ))}
            </div>
          </div>

          {/* Sidebar */}
          <div className="w-[340px] border-l flex flex-col min-h-0">
            <div className="p-2 text-xs text-muted-foreground border-b flex items-center justify-between">
              <span>{crops.length} crop{crops.length === 1 ? '' : 's'} — click empty canvas to add one</span>
              {crops.length > 0 && (
                <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 text-destructive" onClick={() => setCrops([])}>
                  Clear all
                </Button>
              )}
            </div>
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-1.5">
                {orderedCrops.map((c, i) => (
                  <div
                    key={c.id}
                    className={`border rounded-md p-2 space-y-1.5 cursor-pointer ${c.id === selectedCropId ? 'ring-1 ring-primary' : ''}`}
                    onClick={() => { setSelectedCropId(c.id); scrollToCrop(c.id) }}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-semibold text-white flex-shrink-0" style={{ background: colorFor(i) }}>
                        {i + 1}
                      </span>
                      <span className="text-xs font-medium flex-1 truncate">{c.id}</span>
                      <Button
                        size="sm" variant="ghost" className="h-5 w-5 p-0"
                        onClick={(e) => { e.stopPropagation(); updateCrop(c.id, { visible: !c.visible }) }}
                      >
                        {c.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3 text-muted-foreground" />}
                      </Button>
                      <Button
                        size="sm" variant="ghost" className="h-5 w-5 p-0 text-destructive"
                        onClick={(e) => { e.stopPropagation(); deleteCrop(c.id) }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                    <Input
                      value={c.reason}
                      placeholder="reason (e.g. dialogue_bubble_top)"
                      className="h-6 text-[11px]"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => updateCrop(c.id, { reason: e.target.value })}
                    />
                  </div>
                ))}
                {crops.length === 0 && (
                  <p className="text-xs text-muted-foreground italic p-2">
                    No crops yet. Click anywhere on the page to drop a full-width crop, then drag its edges/corners to resize.
                  </p>
                )}
              </div>
            </ScrollArea>

            {/* Inspector */}
            {selectedCrop && manifest && (
              <div className="border-t p-3 space-y-2 flex-shrink-0 max-h-64 overflow-y-auto">
                <InspectorPreview
                  getImageUrl={imageUrlFor}
                  manifest={manifest}
                  crop={selectedCrop}
                  onClose={() => setSelectedCropId(null)}
                />
              </div>
            )}

            {/* Already-exported training crops for this chapter */}
            {exportedFiles.length > 0 && (
              <div className="border-t p-2 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground">{exportedFiles.length} exported to crops_training/</span>
                  <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 text-destructive" onClick={handleClearExports}>
                    Clear exports
                  </Button>
                </div>
                <div className="grid grid-cols-4 gap-1 max-h-24 overflow-y-auto">
                  {exportedFiles.map(f => (
                    <a key={f.filename} href={f.url} target="_blank" rel="noreferrer">
                      <img src={f.url} alt={f.filename} className="w-full h-12 object-cover rounded border" />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Paste JSON dialog */}
      <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Paste crop JSON</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" checked={pasteMode === 'append'} onChange={() => setPasteMode('append')} />
                Append to existing crops
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" checked={pasteMode === 'replace'} onChange={() => setPasteMode('replace')} />
                Replace existing crops
              </label>
            </div>
            <Textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder='{"crops": [{"id":"crop-01","reason":"dialogue_bubble_top","crop":{"mode":"rectangle","points":[{"id":"P1","x":0,"y":0.01},{"id":"P2","x":1,"y":0.01},{"id":"P3","x":1,"y":0.05},{"id":"P4","x":0,"y":0.05}]}}]}'
              className="font-mono text-xs h-64"
            />
            <p className="text-[11px] text-muted-foreground">
              Accepts this app's usual four-point-crop JSON (crop.points, normalized 0–1 — e.g. from
              crop_points.json or a pasted AI reply), or plain canvas-pixel rects
              (canvasX/canvasY/canvasW/canvasH).
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasteOpen(false)}>Cancel</Button>
            <Button onClick={handlePasteLoad} disabled={!pasteText.trim()}>Load</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ============ Resizable crop overlay (mirrors ClipperWorkspace's CropOverlayDiv) ============

interface CropOverlayDivProps {
  crop: LocalCrop
  zoom: number
  sequence: number
  color: string
  isSelected: boolean
  onSelect: () => void
  onMove: (e: React.MouseEvent) => void
  onResize: (e: React.MouseEvent, handle: string) => void
  onDelete: () => void
}

function CropOverlayDiv({ crop, zoom, sequence, color, isSelected, onSelect, onMove, onResize, onDelete }: CropOverlayDivProps) {
  if (!crop.visible) return null
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

  return (
    <div
      data-crop-overlay
      style={{
        position: 'absolute',
        left: crop.canvasX * zoom,
        top: crop.canvasY * zoom,
        width: crop.canvasW * zoom,
        height: crop.canvasH * zoom,
        border: `2px solid ${isSelected ? color : 'rgba(255,255,255,0.6)'}`,
        background: isSelected ? `${color}1a` : 'rgba(255,255,255,0.05)',
        cursor: 'move',
        zIndex: isSelected ? 20 : 10
      }}
      onMouseDown={(e) => { e.stopPropagation(); onSelect(); onMove(e) }}
    >
      <div
        style={{
          position: 'absolute', top: 4, left: 4,
          background: isSelected ? color : 'rgba(0,0,0,0.7)', color: 'white',
          fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
          pointerEvents: 'none', userSelect: 'none'
        }}
      >
        {sequence}
      </div>

      {isSelected && (
        <button
          style={{
            position: 'absolute', top: 4, right: 4,
            background: '#ef4444', color: 'white', border: 'none', borderRadius: 4,
            width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', fontSize: 12
          }}
          onMouseDown={(e) => { e.stopPropagation(); onDelete() }}
        >
          ×
        </button>
      )}

      {isSelected && handles.map(h => (
        <div
          key={h}
          style={{
            position: 'absolute', width: handleSize, height: handleSize,
            background: color, border: '1px solid white', borderRadius: 2,
            ...handlePositions[h]
          }}
          onMouseDown={(e) => { e.stopPropagation(); onResize(e, h) }}
        />
      ))}
    </div>
  )
}

// ============ Inspector preview ============

function InspectorPreview({
  getImageUrl, manifest, crop, onClose
}: { getImageUrl: (filename: string) => string; manifest: ImageManifest; crop: LocalCrop; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    renderTrainingCropPreview(manifest, getImageUrl, crop, canvasRef.current)
      .catch(err => console.error('Error rendering training preview:', err))
  }, [getImageUrl, manifest, crop.canvasX, crop.canvasY, crop.canvasW, crop.canvasH])

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] text-muted-foreground flex items-center justify-between gap-2">
        <span className="truncate">{crop.id}</span>
        <span className="flex-shrink-0">{Math.round(crop.canvasW)} × {Math.round(crop.canvasH)}px</span>
        <Button size="sm" variant="ghost" className="h-5 w-5 p-0 flex-shrink-0" onClick={onClose} title="Close preview">
          <X className="h-3 w-3" />
        </Button>
      </div>
      {/* Fixed box regardless of the crop's own aspect ratio — an unconstrained
          canvas here would stretch to full width and grow however tall a
          narrow/tall crop's aspect ratio implies, overflowing the sidebar and
          blocking the crop list below it. */}
      <canvas ref={canvasRef} className="w-full h-40 object-contain border rounded bg-black/30" />
    </div>
  )
}
