/**
 * EditorWorkspace — Module 4: Video Editor
 *
 * Two phases:
 *  1. Select — choose which ready chapters to compile (ordered by chapter number);
 *     not-ready chapters are disabled with a reason + link to the right module.
 *  2. Editing — a left timeline (parts compile in sequentially, chapter by chapter)
 *     and a right context panel (crop selection / per-image inspector / end-card
 *     editor). Every edit persists via the bulk part-images endpoint and logs a
 *     VideoEditEvent.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  videoApi,
  seriesApi,
  type EditableChapter,
  type VideoProject,
  type VideoPart,
  type VideoPartImage,
  type ChapterCrop,
  type IncomingPartImage,
  type SeriesProjectSummary
} from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Progress } from '@/components/ui/progress'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/lib/socket'
import { ArrowLeft, Film, Loader2, AlertTriangle, Scissors, Mic, Play, Video, X, ChevronDown, Pencil, Trash2 } from 'lucide-react'
import { Volume2, Download, FolderOpen, Ban, CheckCircle2 } from 'lucide-react'
import PartTimeline from './components/PartTimeline'
import ImageSelectionPanel from './components/ImageSelectionPanel'
import ImageInspector, { type ImagePatch } from './components/ImageInspector'
import TitleCardEditor from './components/TitleCardEditor'
import PreviewPlayer, { type PreviewPlayerHandle, type PlaybackState } from './components/PreviewPlayer'
import ExportDialog from './components/ExportDialog'
import AudioSettings from './components/AudioSettings'

const MIN_SLOT = 0.3

/** Format a project's chapter numbers into a compact label, e.g. "Ch 1–10, 12". */
function formatChapters(numbers: (number | null)[]): string {
  const nums = numbers.filter((n): n is number => typeof n === 'number').sort((a, b) => a - b)
  if (nums.length === 0) return 'No chapters'
  const ranges: string[] = []
  let start = nums[0]
  let prev = nums[0]
  for (let i = 1; i <= nums.length; i++) {
    if (i < nums.length && nums[i] === prev + 1) {
      prev = nums[i]
      continue
    }
    ranges.push(start === prev ? `${start}` : `${start}–${prev}`)
    if (i < nums.length) { start = nums[i]; prev = nums[i] }
  }
  return `Ch ${ranges.join(', ')}`
}

export default function EditorWorkspace() {
  const { seriesId } = useParams<{ seriesId: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()
  const { videoPreviewProgress, videoPreviewResult, videoRenderProgress, videoRenderResult } = useSocket()

  const [seriesTitle, setSeriesTitle] = useState('')
  const [chapters, setChapters] = useState<EditableChapter[]>([])
  const [loading, setLoading] = useState(true)
  const [compilingPartId, setCompilingPartId] = useState<number | null>(null)

  const [project, setProject] = useState<VideoProject | null>(null)
  const [focusedPartId, setFocusedPartId] = useState<string | null>(null)
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null)

  // Existing video projects ("parts") for this series, shown as resumable
  // accordions on the Select screen so the user can pick up where they left off.
  const [existingProjects, setExistingProjects] = useState<SeriesProjectSummary[]>([])
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null)
  const [continuingId, setContinuingId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SeriesProjectSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Resizable right panel (Live preview + Crop Pool). Width persists locally and
  // is capped to a fraction of the editing area so it never overlaps the timeline.
  const PANEL_WIDTH_KEY = 'editorPanelWidth'
  const editAreaRef = useRef<HTMLDivElement>(null)
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY))
    return Number.isFinite(saved) && saved >= 320 ? saved : 480
  })
  const [resizing, setResizing] = useState(false)

  useEffect(() => {
    localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(panelWidth)))
  }, [panelWidth])

  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      const rect = editAreaRef.current?.getBoundingClientRect()
      if (!rect) return
      const raw = e.clientX - rect.left // panel sits on the left; drag its right edge
      const max = Math.min(760, Math.max(360, rect.width - 360)) // leave room for the timeline
      setPanelWidth(Math.min(Math.max(raw, 320), max))
    }
    const onUp = () => setResizing(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [resizing])

  // AI assist
  const [aiAvailable, setAiAvailable] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [suggestingAnchor, setSuggestingAnchor] = useState(false)
  const [suggestion, setSuggestion] = useState<{ partId: string; cropIds: string[]; range: { start: number; end: number } | null } | null>(null)
  const [suggestingPartId, setSuggestingPartId] = useState<string | null>(null)
  const [fittingPartId, setFittingPartId] = useState<string | null>(null)

  useEffect(() => {
    videoApi.getCapabilities().then(c => setAiAvailable(!!c.aiAssist)).catch(() => {})
  }, [])

  // Preview
  const [showLivePreview, setShowLivePreview] = useState(false)
  const [renderedOpen, setRenderedOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewBust, setPreviewBust] = useState(0)

  // Embedded preview playback bus: the player reports its playhead through a
  // ref-based pub/sub so the under-strip scrubber can track it without
  // re-rendering the whole timeline on every animation frame.
  const previewRef = useRef<PreviewPlayerHandle>(null)
  const playbackState = useRef<PlaybackState>({ elapsed: 0, total: 0, playing: false })
  const playbackListeners = useRef(new Set<(s: PlaybackState) => void>())
  const emitPlayback = useCallback((s: PlaybackState) => {
    playbackState.current = s
    playbackListeners.current.forEach(l => l(s))
  }, [])
  const subscribePlayback = useCallback((listener: (s: PlaybackState) => void) => {
    playbackListeners.current.add(listener)
    listener(playbackState.current)
    return () => { playbackListeners.current.delete(listener) }
  }, [])
  const onScrub = useCallback((_partId: string, seconds: number) => {
    previewRef.current?.seek(seconds)
  }, [])
  const togglePlay = useCallback(() => {
    if (!previewRef.current) return
    if (playbackState.current.playing) previewRef.current.pause()
    else previewRef.current.play()
  }, [])

  // Spacebar toggles play/pause of the embedded preview, except while typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code !== 'Space' && e.key !== ' ') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable)) return
      if (!previewRef.current) return
      e.preventDefault()
      togglePlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay])

  // React to proxy-preview completion.
  useEffect(() => {
    if (!project || !videoPreviewResult || videoPreviewResult.projectId !== project.id) return
    setPreviewLoading(false)
    if (videoPreviewResult.success) {
      setPreviewBust(Date.now())
      setRenderedOpen(true)
    } else {
      toast({ title: 'Preview failed', description: videoPreviewResult.error, variant: 'destructive' })
    }
  }, [videoPreviewResult])

  // Export
  const [exportOpen, setExportOpen] = useState(false)
  const [audioOpen, setAudioOpen] = useState(false)
  const [exportId, setExportId] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)
  const [renderPercent, setRenderPercent] = useState(0)
  const [doneExportId, setDoneExportId] = useState<string | null>(null)

  useEffect(() => {
    if (!project || !videoRenderProgress || videoRenderProgress.projectId !== project.id) return
    setRenderPercent(videoRenderProgress.percent)
  }, [videoRenderProgress])

  useEffect(() => {
    if (!project || !videoRenderResult || videoRenderResult.projectId !== project.id) return
    setRendering(false)
    if (videoRenderResult.status === 'done') {
      setDoneExportId(videoRenderResult.exportId ?? exportId)
      toast({ title: 'Export complete', description: 'Your video is ready.' })
    } else if (videoRenderResult.status === 'cancelled') {
      toast({ title: 'Export cancelled' })
    } else {
      toast({ title: 'Export failed', description: videoRenderResult.error, variant: 'destructive' })
    }
  }, [videoRenderResult])

  // Load series + editable chapters + existing video projects.
  useEffect(() => {
    if (!seriesId) return
    setLoading(true)
    Promise.all([
      seriesApi.getById(seriesId),
      videoApi.getEditableChapters(seriesId),
      videoApi.listSeriesProjects(seriesId)
    ])
      .then(([s, chs, projects]) => {
        setSeriesTitle(s.title)
        setChapters(chs)
        setExistingProjects(projects)
        // Open the most-recently-edited project's accordion by default.
        setExpandedProjectId(projects[0]?.id ?? null)
      })
      .catch(err => {
        console.error(err)
        toast({ title: 'Error', description: 'Failed to load chapters', variant: 'destructive' })
      })
      .finally(() => setLoading(false))
  }, [seriesId])

  /** Resume an existing project: load its full tree and enter the editing phase. */
  async function continueProject(id: string) {
    setContinuingId(id)
    try {
      const proj = await videoApi.getProject(id)
      setProject(proj)
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to open project', variant: 'destructive' })
    } finally {
      setContinuingId(null)
    }
  }

  /** Delete a saved project ("part") after confirmation. */
  async function confirmDelete() {
    if (!pendingDelete) return
    const id = pendingDelete.id
    setDeleting(true)
    try {
      await videoApi.deleteProject(id)
      setExistingProjects(prev => prev.filter(p => p.id !== id))
      setExpandedProjectId(prev => (prev === id ? null : prev))
      setPendingDelete(null)
      toast({ title: 'Part deleted', description: 'The video part and its edits were removed.' })
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to delete part', variant: 'destructive' })
    } finally {
      setDeleting(false)
    }
  }

  // Chapters already committed to an existing video part (accordion). A chapter
  // belongs to a single accordion only, so these are excluded from new parts.
  const usedChapterIds = useMemo(
    () => new Set(existingProjects.flatMap(p => p.chapterIds)),
    [existingProjects]
  )

  // Group chapters into the same narration "Parts" used in the Narration Library:
  // a Part is a run of consecutive chapters ending at one flagged `isPartEnd`.
  // Each part carries readiness so the user can compile a whole part at once.
  const partGroups = useMemo(() => {
    const groups: { partNumber: number; chapters: EditableChapter[] }[] = []
    let current: EditableChapter[] = []
    let partNumber = 1
    for (const ch of chapters) {
      current.push(ch)
      if (ch.isPartEnd) {
        groups.push({ partNumber, chapters: current })
        current = []
        partNumber++
      }
    }
    if (current.length > 0) groups.push({ partNumber, chapters: current })
    return groups
  }, [chapters])

  // Parts still available to compile: those with at least one chapter not yet
  // used by an existing accordion. Fully-compiled parts drop off the list.
  const availableParts = useMemo(
    () => partGroups
      .map(g => ({ ...g, chapters: g.chapters.filter(c => !usedChapterIds.has(c.id)) }))
      .filter(g => g.chapters.length > 0),
    [partGroups, usedChapterIds]
  )

  /** Compile a whole narration part: its ready, not-yet-used chapters in order. */
  async function compilePart(part: { partNumber: number; chapters: EditableChapter[] }) {
    if (!seriesId) return
    const chapterIds = part.chapters.filter(c => c.ready).map(c => c.id)
    if (chapterIds.length === 0) return
    setCompilingPartId(part.partNumber)
    try {
      const proj = await videoApi.initProject({
        seriesId,
        chapterIds,
        name: `${seriesTitle} — Part ${part.partNumber}`
      })
      setProject(proj)
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to compile', variant: 'destructive' })
    } finally {
      setCompilingPartId(null)
    }
  }


  // ---------- Editing helpers ----------

  const focusedPart: VideoPart | null = useMemo(
    () => (project && focusedPartId ? project.parts.find(p => p.id === focusedPartId) ?? null : null),
    [project, focusedPartId]
  )

  const selectedImage: VideoPartImage | null = useMemo(
    () => (focusedPart && selectedImageId ? focusedPart.images.find(im => im.id === selectedImageId) ?? null : null),
    [focusedPart, selectedImageId]
  )

  /** Build the bulk payload from a part's current images (optionally keeping durations). */
  function payloadFrom(part: VideoPart, keepDurations: boolean): IncomingPartImage[] {
    return part.images.map(im => ({
      cropId: im.cropId,
      isFiller: im.isFiller,
      ...(keepDurations ? { duration: im.duration } : {}),
      motionMode: im.motionMode,
      motionEffect: im.motionEffect,
      motionIntensity: im.motionIntensity,
      anchorX: im.anchorX,
      anchorY: im.anchorY,
      scale: im.scale,
      offsetX: im.offsetX,
      offsetY: im.offsetY,
      source: im.source
    }))
  }

  async function saveImages(partId: string, images: IncomingPartImage[], event: { eventType: string; payload?: unknown }) {
    try {
      const updated = await videoApi.setPartImages(partId, images, event)
      setProject(prev => prev
        ? { ...prev, parts: prev.parts.map(p => (p.id === partId ? { ...p, images: updated.images } : p)) }
        : prev)
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save', variant: 'destructive' })
    }
  }

  function toggleCrop(crop: ChapterCrop) {
    if (!focusedPart) return
    const exists = focusedPart.images.some(im => im.cropId === crop.id)
    const base = payloadFrom(focusedPart, false) // add/remove re-splits durations
    const next = exists
      ? base.filter(p => p.cropId !== crop.id)
      : [...base, { cropId: crop.id, isFiller: false, source: 'manual' }]
    saveImages(focusedPart.id, next, {
      eventType: exists ? 'image_deselected' : 'image_selected',
      payload: { cropId: crop.id, sequence: crop.sequence }
    })
  }

  function addFiller() {
    if (!focusedPart) return
    const next = [...payloadFrom(focusedPart, false), { isFiller: true, source: 'manual' }]
    saveImages(focusedPart.id, next, { eventType: 'filler_used' })
  }

  function removeImage(index: number) {
    if (focusedPart) removeImageAt(focusedPart.id, index)
  }

  /** Reorder a part's images via drag-and-drop on the slot strip. */
  function reorderImagesAt(partId: string, from: number, to: number) {
    const part = project?.parts.find(p => p.id === partId)
    if (!part || from === to) return
    const next = payloadFrom(part, true) // keep each image's duration as it moves
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    saveImages(part.id, next, { eventType: 'image_reordered', payload: { from, to } })
    setSelectedImageId(null)
  }

  /** Remove a slot from any part (used by the hover delete on the slot strip). */
  function removeImageAt(partId: string, index: number) {
    const part = project?.parts.find(p => p.id === partId)
    if (!part) return
    const next = payloadFrom(part, false).filter((_, i) => i !== index)
    if (next.length === 0) {
      toast({ title: 'Cannot remove', description: 'A part needs at least one image or a filler.', variant: 'destructive' })
      return
    }
    saveImages(part.id, next, { eventType: 'image_deselected', payload: { slotIndex: index } })
    if (selectedImageId && part.images[index]?.id === selectedImageId) setSelectedImageId(null)
  }

  function updateImage(index: number, patch: ImagePatch, eventType: string) {
    if (!focusedPart) return
    const base = payloadFrom(focusedPart, true)
    base[index] = { ...base[index], ...patch }
    saveImages(focusedPart.id, base, { eventType, payload: { slotIndex: index, ...patch } })
  }

  /** Set one slot's duration; the others redistribute to keep the part locked. */
  function setSlotDuration(index: number, seconds: number) {
    if (!focusedPart) return
    const durs = focusedPart.images.map(im => im.duration)
    const total = focusedPart.audioDuration
    const n = durs.length
    const clamped = Math.max(MIN_SLOT, Math.min(seconds, total - MIN_SLOT * (n - 1)))
    const remaining = total - clamped
    const oldOthers = durs.reduce((s, d, i) => (i === index ? s : s + d), 0)
    const next = durs.map((d, i) =>
      i === index ? clamped : oldOthers > 0 ? (d / oldOthers) * remaining : remaining / (n - 1)
    )
    commitDurations(focusedPart, next, { slotIndex: index, duration: clamped })
  }

  function commitDurations(part: VideoPart, durations: number[], payload?: unknown) {
    const base = payloadFrom(part, true)
    durations.forEach((d, i) => { base[i].duration = d })
    saveImages(part.id, base, { eventType: 'duration_adjusted', payload })
  }

  async function suggestImagesForPart(partId: string) {
    // Focus the part so the Accept/Reject prompt shows in the context panel.
    setFocusedPartId(partId)
    setSelectedImageId(null)
    setSuggesting(true)
    setSuggestingPartId(partId)
    try {
      const { suggested, range } = await videoApi.suggestImages(partId)
      if (suggested.length === 0) {
        toast({ title: 'No suggestion', description: 'The AI found no matching crops.' })
        return
      }
      setSuggestion({ partId, cropIds: suggested.map(c => c.id), range })
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to suggest images', variant: 'destructive' })
    } finally {
      setSuggesting(false)
      setSuggestingPartId(null)
    }
  }

  function suggestImagesForFocused() {
    if (focusedPart) suggestImagesForPart(focusedPart.id)
  }

  /** AI: split a part's audio time across its images to track the narration. */
  async function fitTimingForPart(partId: string) {
    const part = project?.parts.find(p => p.id === partId)
    if (!part) return
    if (part.images.length < 2) {
      toast({ title: 'Nothing to fit', description: 'Add at least two images to a part first.' })
      return
    }
    setFittingPartId(partId)
    try {
      const { durations } = await videoApi.suggestDurations(partId)
      if (durations.length !== part.images.length) {
        toast({ title: 'Timing unavailable', description: 'The image list changed — try again.', variant: 'destructive' })
        return
      }
      commitDurations(part, durations, { source: 'ai-fit-timing' })
      toast({ title: 'Timing fitted', description: 'Image durations adjusted to the narration.' })
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to fit timing', variant: 'destructive' })
    } finally {
      setFittingPartId(null)
    }
  }

  function acceptSuggestion() {
    if (!suggestion || !focusedPart) return
    const images: IncomingPartImage[] = suggestion.cropIds.map(id => ({ cropId: id, isFiller: false, source: 'ai-suggested-accepted' }))
    saveImages(focusedPart.id, images, { eventType: 'suggestion_accepted', payload: { range: suggestion.range } })
    setSuggestion(null)
  }

  function rejectSuggestion() {
    if (!suggestion) return
    videoApi.logPartEvent(suggestion.partId, 'suggestion_rejected', { range: suggestion.range }).catch(() => {})
    setSuggestion(null)
  }

  async function suggestAnchorFor(index: number) {
    if (!focusedPart) return
    const img = focusedPart.images[index]
    if (!img) return
    setSuggestingAnchor(true)
    try {
      const { anchorX, anchorY } = await videoApi.suggestAnchor(img.id)
      updateImage(index, { motionMode: 'focus', anchorX, anchorY }, 'anchor_set')
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to suggest anchor', variant: 'destructive' })
    } finally {
      setSuggestingAnchor(false)
    }
  }

  async function startExport(resolution: string, preset: string, fps: number) {
    if (!project) return
    setExportOpen(false)
    setDoneExportId(null)
    setRenderPercent(0)
    try {
      const { exportId: id } = await videoApi.render(project.id, { resolution, preset, fps })
      setExportId(id)
      setRendering(true)
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to start export', variant: 'destructive' })
    }
  }

  async function cancelExport() {
    if (!exportId) return
    await videoApi.cancelRender(exportId).catch(() => {})
  }

  async function openExportFolder() {
    const id = doneExportId ?? exportId
    if (id) await videoApi.openExport(id).catch(() => {})
  }

  async function startRenderPreview() {
    if (!project) return
    setPreviewLoading(true)
    try {
      await videoApi.renderPreview(project.id, 'project')
    } catch (err) {
      setPreviewLoading(false)
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to start preview', variant: 'destructive' })
    }
  }

  async function saveTitleCard(patch: { titleCardText?: string | null; titleCardDuration?: number }) {
    if (!project) return
    try {
      const updated = await videoApi.updateProject(project.id, patch)
      setProject(updated)
      toast({ title: 'Saved', description: 'End card updated' })
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save', variant: 'destructive' })
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  // ---------- Editing phase ----------
  if (project) {
    const selectedCropIds = new Set(
      focusedPart ? focusedPart.images.filter(i => i.cropId).map(i => i.cropId as string) : []
    )
    const selectedIndex = focusedPart && selectedImage
      ? focusedPart.images.findIndex(im => im.id === selectedImage.id)
      : -1

    return (
      <div className="flex flex-col h-full">
        <div className="p-4 border-b flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/editor')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <Film className="h-5 w-5 text-primary" />
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold truncate">{project.name}</h1>
            <p className="text-xs text-muted-foreground">{seriesTitle}</p>
          </div>
          {rendering ? (
            <div className="flex items-center gap-2">
              <div className="w-32 h-1.5 bg-secondary rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${renderPercent}%` }} />
              </div>
              <span className="text-xs text-muted-foreground w-9">{renderPercent}%</span>
              <Button variant="ghost" size="sm" onClick={cancelExport}>
                <Ban className="h-4 w-4 mr-1" /> Cancel
              </Button>
            </div>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => setAudioOpen(true)} title="Audio & music">
                <Volume2 className="h-4 w-4 mr-1" /> Audio
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowLivePreview(true)}>
                <Play className="h-4 w-4 mr-1" /> Live
              </Button>
              <Button variant="outline" size="sm" onClick={startRenderPreview} disabled={previewLoading}>
                {previewLoading
                  ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />{videoPreviewProgress ? `${videoPreviewProgress.percent}%` : 'Rendering…'}</>
                  : <><Video className="h-4 w-4 mr-1" /> Preview</>}
              </Button>
              {doneExportId ? (
                <>
                  <Badge variant="success" className="flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Exported
                  </Badge>
                  <Button variant="outline" size="sm" onClick={openExportFolder}>
                    <FolderOpen className="h-4 w-4 mr-1" /> Open folder
                  </Button>
                </>
              ) : (
                <Button size="sm" onClick={() => setExportOpen(true)}>
                  <Download className="h-4 w-4 mr-1" /> Export
                </Button>
              )}
            </>
          )}
        </div>

        <div ref={editAreaRef} className={`flex-1 flex overflow-hidden ${resizing ? 'select-none cursor-col-resize' : ''}`}>
          {/* Left: context panel (Live preview + Crop Pool). Resizable, and
              capped to 70% of the editing area so it can't overlap the timeline
              when the sidebar menu opens. */}
          <div
            style={{ width: panelWidth, maxWidth: '70%' }}
            className="border-r flex flex-col flex-shrink-0 min-h-0"
          >
            {!focusedPart ? (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground text-center p-6">
                Select a part on the right to choose its images and motion.
              </div>
            ) : focusedPart.isOutro ? (
              <TitleCardEditor project={project} onSave={saveTitleCard} />
            ) : selectedImage && selectedIndex >= 0 ? (
              <ImageInspector
                image={selectedImage}
                slotNumber={selectedIndex + 1}
                onUpdate={(patch, eventType) => updateImage(selectedIndex, patch, eventType)}
                onDurationChange={(sec) => setSlotDuration(selectedIndex, sec)}
                onRemove={() => removeImage(selectedIndex)}
                onBack={() => setSelectedImageId(null)}
                onSuggestAnchor={() => suggestAnchorFor(selectedIndex)}
                suggestingAnchor={suggestingAnchor}
                aiAvailable={aiAvailable}
              />
            ) : (
              <div className="flex flex-col h-full min-h-0">
                {suggestion && suggestion.partId === focusedPart.id && (
                  <div className="p-3 border-b bg-amber-500/10">
                    <p className="text-xs font-medium mb-2">
                      AI suggests {suggestion.cropIds.length} crop{suggestion.cropIds.length !== 1 ? 's' : ''}
                      {suggestion.range ? ` (#${suggestion.range.start}–#${suggestion.range.end})` : ''}.
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={acceptSuggestion}>Accept</Button>
                      <Button size="sm" variant="ghost" onClick={rejectSuggestion}>Reject</Button>
                    </div>
                  </div>
                )}
                <div className="flex-1 min-h-0">
                  <ImageSelectionPanel
                    chapterId={focusedPart.chapterId}
                    selectedCropIds={selectedCropIds}
                    onToggleCrop={toggleCrop}
                    onAddFiller={addFiller}
                    onSuggest={suggestImagesForFocused}
                    suggesting={suggesting}
                    aiAvailable={aiAvailable}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Drag handle: resize the left panel by its right edge. */}
          <div
            onMouseDown={(e) => { e.preventDefault(); setResizing(true) }}
            onDoubleClick={() => setPanelWidth(480)}
            title="Drag to resize · double-click to reset"
            className="w-1.5 flex-shrink-0 cursor-col-resize bg-border hover:bg-primary/50 transition-colors"
          />

          {/* Right: live preview above the chapter parts timeline */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            {focusedPart && !focusedPart.isOutro && (
              <div className="p-4 pb-0 flex-shrink-0">
                <div className="max-w-lg">
                  <PreviewPlayer
                    ref={previewRef}
                    project={project}
                    scopePartId={focusedPart.id}
                    embedded
                    showControls={false}
                    onProgress={emitPlayback}
                  />
                </div>
              </div>
            )}
            <PartTimeline
              project={project}
              chapters={chapters}
              focusedPartId={focusedPartId}
              selectedImageId={selectedImageId}
              onFocus={(id) => { setFocusedPartId(id); setSelectedImageId(null); setSuggestion(null) }}
              onSelectSlot={(partId, imageId) => { setFocusedPartId(partId); setSelectedImageId(imageId) }}
              onDurationsCommit={(partId, durations) => {
                const part = project.parts.find(p => p.id === partId)
                if (part) commitDurations(part, durations)
              }}
              onRemoveSlot={removeImageAt}
              onReorderSlot={reorderImagesAt}
              aiAvailable={aiAvailable}
              onSuggestImages={suggestImagesForPart}
              onFitTiming={fitTimingForPart}
              suggestingPartId={suggestingPartId}
              fittingPartId={fittingPartId}
              subscribePlayback={subscribePlayback}
              onScrub={onScrub}
              onTogglePlay={togglePlay}
            />
          </div>
        </div>

        <ExportDialog project={project} open={exportOpen} onOpenChange={setExportOpen} onExport={startExport} />
        <AudioSettings
          project={project}
          open={audioOpen}
          onOpenChange={setAudioOpen}
          onSave={async (patch) => {
            const updated = await videoApi.updateProject(project.id, patch)
            setProject(updated)
          }}
        />

        {showLivePreview && (
          <PreviewPlayer project={project} onClose={() => setShowLivePreview(false)} />
        )}

        {renderedOpen && (
          <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6" onClick={() => setRenderedOpen(false)}>
            <div className="bg-card rounded-lg overflow-hidden w-full max-w-4xl" onClick={e => e.stopPropagation()}>
              <video controls autoPlay className="w-full aspect-video bg-black" src={`${videoApi.previewFileUrl(project.id)}?t=${previewBust}`} />
              <div className="flex items-center justify-between p-2 border-t">
                <span className="text-xs text-muted-foreground px-2">Rendered draft preview (640×360)</span>
                <Button size="icon" variant="ghost" onClick={() => setRenderedOpen(false)}><X className="h-4 w-4" /></Button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ---------- Select phase ----------

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/editor')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <Film className="h-5 w-5 text-primary" />
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">{seriesTitle}</h1>
          <p className="text-xs text-muted-foreground">
            Compile each narration part into its own video
          </p>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6 max-w-3xl space-y-6">
          {/* Resume: existing video projects ("parts") for this series, each an
              accordion showing its editing progress + a Continue button. */}
          {existingProjects.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Continue editing</h2>
                <span className="text-xs text-muted-foreground">
                  {existingProjects.length} saved part{existingProjects.length !== 1 ? 's' : ''}
                </span>
              </div>

              {existingProjects.map(proj => {
                const open = expandedProjectId === proj.id
                return (
                  <Collapsible
                    key={proj.id}
                    open={open}
                    onOpenChange={o => setExpandedProjectId(o ? proj.id : null)}
                  >
                    <Card>
                      <CollapsibleTrigger className="w-full text-left">
                        <div className="p-3 flex items-center gap-3">
                          <ChevronDown
                            className={`h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm truncate">{proj.name}</span>
                              {proj.hasExport && (
                                <Badge variant="success" className="flex items-center gap-1 flex-shrink-0">
                                  <CheckCircle2 className="h-3 w-3" /> Exported
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate">
                              {formatChapters(proj.chapters.map(c => c.number))}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0 w-40">
                            <Progress value={proj.progress} className="h-2 flex-1" />
                            <span className="text-xs text-muted-foreground w-9 text-right">{proj.progress}%</span>
                          </div>
                          <Button
                            size="sm"
                            className="flex-shrink-0"
                            disabled={continuingId !== null}
                            onClick={e => { e.stopPropagation(); continueProject(proj.id) }}
                          >
                            {continuingId === proj.id
                              ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                              : <Pencil className="h-4 w-4 mr-1" />}
                            Continue editing
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="flex-shrink-0 text-muted-foreground hover:text-destructive"
                            title="Delete this part"
                            onClick={e => { e.stopPropagation(); setPendingDelete(proj) }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </CollapsibleTrigger>

                      <CollapsibleContent>
                        <div className="px-3 pb-3 pt-0 border-t space-y-1.5">
                          <p className="text-xs text-muted-foreground pt-2">
                            {proj.editedParts} of {proj.totalParts} part{proj.totalParts !== 1 ? 's' : ''} edited
                            {' · '}saved automatically on this device
                          </p>
                          {proj.chapters.map(c => {
                            const pct = c.totalParts > 0 ? Math.round((c.editedParts / c.totalParts) * 100) : 0
                            return (
                              <div key={c.chapterId} className="flex items-center gap-2">
                                <span className="text-xs w-20 flex-shrink-0">
                                  Chapter {c.number ?? '?'}
                                </span>
                                <Progress value={pct} className="h-1.5 flex-1" />
                                <span className="text-xs text-muted-foreground w-16 text-right">
                                  {c.editedParts}/{c.totalParts}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </CollapsibleContent>
                    </Card>
                  </Collapsible>
                )
              })}
            </div>
          )}

          <h2 className="text-sm font-semibold">Compile a new part</h2>

          {chapters.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Film className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p>No chapters found for this series.</p>
            </div>
          )}

          {chapters.length > 0 && availableParts.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <CheckCircle2 className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p>Every narration part has already been compiled.</p>
              <p className="text-xs mt-1">Delete a part above to recompile its chapters.</p>
            </div>
          )}

          <div className="space-y-3">
          {availableParts.map(part => {
            const readyChapters = part.chapters.filter(c => c.ready)
            const allReady = readyChapters.length === part.chapters.length
            const compilingThis = compilingPartId === part.partNumber
            return (
              <Card key={part.partNumber}>
                <CardContent className="p-3 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">Part {part.partNumber}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatChapters(part.chapters.map(c => c.number))}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {readyChapters.length} of {part.chapters.length} chapter{part.chapters.length !== 1 ? 's' : ''} ready
                      </p>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => compilePart(part)}
                      disabled={readyChapters.length === 0 || compilingPartId !== null}
                      title={readyChapters.length === 0 ? 'No chapters in this part are ready yet' : undefined}
                    >
                      {compilingThis ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Film className="h-4 w-4 mr-2" />}
                      Compile Part {part.partNumber}
                    </Button>
                  </div>

                  {!allReady && readyChapters.length > 0 && (
                    <p className="flex items-center gap-1 text-xs text-yellow-600">
                      <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                      Not-ready chapters will be skipped — finish them to include them.
                    </p>
                  )}

                  <div className="space-y-1.5 border-t pt-2">
                    {part.chapters.map(ch => (
                      <div key={ch.id} className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">Chapter {ch.number}</span>
                            {ch.title && <span className="text-xs text-muted-foreground truncate">— {ch.title}</span>}
                          </div>
                          {!ch.ready && ch.reason && (
                            <p className="flex items-center gap-1 text-xs text-yellow-600 mt-0.5">
                              <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                              {ch.reason}
                            </p>
                          )}
                        </div>

                        {ch.ready ? (
                          <div className="flex items-center gap-2 text-xs text-muted-foreground flex-shrink-0">
                            <span className="flex items-center gap-1"><Scissors className="h-3 w-3" />{ch.cropCount}</span>
                            <span className="flex items-center gap-1"><Mic className="h-3 w-3" />{ch.sectionCount}</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {!ch.hasFinalizedCrops && (
                              <Link to="/clipper" className="text-xs text-primary hover:underline flex items-center gap-1">
                                <Scissors className="h-3 w-3" /> Clip
                              </Link>
                            )}
                            {!ch.hasSectionAudio && (
                              <Link to="/narration" className="text-xs text-primary hover:underline flex items-center gap-1">
                                <Mic className="h-3 w-3" /> Voice
                              </Link>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )
          })}
          </div>
        </div>
      </ScrollArea>

      <Dialog open={!!pendingDelete} onOpenChange={o => { if (!o && !deleting) setPendingDelete(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete this part?
            </DialogTitle>
            <DialogDescription>
              {pendingDelete && (
                <>
                  This permanently deletes <span className="font-medium text-foreground">{pendingDelete.name}</span>
                  {' '}({formatChapters(pendingDelete.chapters.map(c => c.number))}) and all of its editing progress
                  {pendingDelete.editedParts > 0 && ` — ${pendingDelete.editedParts} edited part${pendingDelete.editedParts !== 1 ? 's' : ''}`}
                  {pendingDelete.hasExport && ', including its exported video file'}.
                  {' '}This cannot be undone.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
              Delete part
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
