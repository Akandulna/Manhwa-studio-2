/**
 * Clipper2Workspace — Module 3 v2: Image Clipper 2.0
 *
 * The two-stage workspace for one chapter: the pointer overlay viewer, the raw
 * JSON artifact editor, and the deterministic apply step with its outputs.
 *
 * Two properties of the technique drive the whole layout:
 *  - crop_points.json is the contract between detect and apply AND a user-visible
 *    artifact, so the raw bytes are editable here and the viewer is only a reading
 *    of them — never a second source of truth.
 *  - apply cuts from the file on disk, not from the editor draft. Every action that
 *    would cut images therefore states what it is cutting, and an unsaved draft is
 *    called out rather than silently used or silently ignored.
 *
 * Pointer coordinates are normalized against the combined logical page (`ST-09`),
 * which is exactly the clipper manifest canvas — so overlays convert through
 * manifest.canvasWidth / canvasHeight, never through a single page's own size.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  ArrowLeft,
  Locate,
  Loader2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Download,
  Save,
  RotateCcw,
  Eye,
  Scissors,
  AlertTriangle,
  CheckCircle2,
  FileJson,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Cpu
} from 'lucide-react'
import { CopyPointerPromptButton, PointerJsonDrop } from '@/components/clipper2/PointerImport'
import { useSocket } from '@/lib/socket'
import { useToast } from '@/components/ui/use-toast'
import {
  clipperApi,
  clipper2Api,
  chaptersApi,
  type Chapter,
  type ImageManifest,
  type ManifestImage,
  type Clipper2Status,
  type Clipper2PointSet,
  type Clipper2CropEntry,
  type Clipper2Point,
  type Clipper2Issue,
  type Clipper2Validation,
  type Clipper2Output,
  type Clipper2Engine
} from '@/lib/api'

// ============ Constants ============

/** Pointer accent. Deliberately not v1's blue crops or amber AI suggestions. */
const ACCENT = '#a855f7'
const ACCENT_SELECTED = '#e9d5ff'

/** How many pixels above/below the viewport to keep decoded (matches v1). */
const BUFFER_PX = 2000

/** Side panel width, mirrored in the fit-zoom calculation. */
const PANEL_W = 420

/** Pointer dots stay this many CSS pixels across at any zoom — they are the concept. */
const DOT_PX = 11

/**
 * A crop is full-width only when its container truly reaches both page edges
 * (`IX-03`: x = 0.0 and x = 1.0 exactly). The epsilon absorbs JSON round-tripping
 * of those exact values, not genuine insets — `IX-04` insets are far larger.
 */
const EDGE_EPSILON = 1e-6

type PanelTab = 'pointers' | 'json'

// ============ Geometry (reading the artifact, never rewriting it) ============

interface NormBounds {
  left: number
  top: number
  right: number
  bottom: number
}

function isUsablePoint(point: Clipper2Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

/**
 * Bounds from the min/max of all four pointers rather than from P1/P3 alone.
 * A hand-edited file can carry a non-rectangular quad; apply treats the entry as a
 * rectangle (`AN-02`, `OUT-06`), so the overlay shows the rectangle that would be
 * cut while the P1..P4 dots stay at their real positions and expose the skew.
 */
function normBounds(entry: Clipper2CropEntry): NormBounds | null {
  const points = (entry.crop?.points ?? []).filter(isUsablePoint)
  if (points.length === 0) return null
  const xs = points.map(p => p.x)
  const ys = points.map(p => p.y)
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys)
  }
}

function isFullWidth(bounds: NormBounds): boolean {
  return bounds.left <= EDGE_EPSILON && bounds.right >= 1 - EDGE_EPSILON
}

/** Pointer label placement: each label sits on the outside of its own corner. */
const LABEL_OFFSET: Record<Clipper2Point['id'], React.CSSProperties> = {
  P1: { bottom: '100%', right: '100%' },
  P2: { bottom: '100%', left: '100%' },
  P3: { top: '100%', left: '100%' },
  P4: { top: '100%', right: '100%' }
}

// ============ Save (the one call that needs the raw 400 body) ============

type PutPointsResult =
  | { ok: true; set: Clipper2PointSet }
  | { ok: false; message: string; validation: Clipper2Validation | null }

/**
 * fetchApi() collapses a 400 into its message, but PUT /points answers an invalid
 * edit with the full validation report and the server keeps that message short
 * precisely because this editor renders the rule rows inline. So the save goes
 * through one local fetch. The URL is derived from the api module's own download
 * URL so no second copy of the API base path exists here.
 */
async function putPoints(chapterId: string, content: string): Promise<PutPointsResult> {
  const url = clipper2Api.getPointsDownloadUrl(chapterId).replace(/\/download$/, '')
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  })

  const payload = (await response.json().catch(() => null)) as
    | (Partial<Clipper2PointSet> & { error?: string; validation?: Clipper2Validation })
    | null

  if (response.ok) {
    if (!payload || typeof payload.content !== 'string') {
      return { ok: false, message: 'The server accepted the save but returned no artifact', validation: null }
    }
    return { ok: true, set: payload as Clipper2PointSet }
  }

  return {
    ok: false,
    message: payload?.error || `Save failed (HTTP ${response.status})`,
    validation: payload?.validation ?? null
  }
}

// ============ Component ============

export default function Clipper2Workspace() {
  const { id: chapterId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()
  const {
    clipper2DetectProgress,
    clipper2DetectComplete,
    clipper2ApplyProgress,
    clipper2ApplyComplete
  } = useSocket()

  const [manifest, setManifest] = useState<ImageManifest | null>(null)
  const [pointSet, setPointSet] = useState<Clipper2PointSet | null>(null)
  const [chapter, setChapter] = useState<Chapter | null>(null)
  const [status, setStatus] = useState<Clipper2Status | null>(null)
  const [outputs, setOutputs] = useState<Clipper2Output[]>([])
  const [exportDir, setExportDir] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [zoom, setZoom] = useState(0.3)
  const [selectedCropId, setSelectedCropId] = useState<string | null>(null)
  const [panelTab, setPanelTab] = useState<PanelTab>('pointers')

  /**
   * The import strip's disclosure state. `null` means "follow the chapter": open
   * when there are no pointers yet (the only thing worth doing), collapsed once
   * there are (reviewing them is). An explicit true/false pins it, so a user who
   * opens the strip to re-import keeps it open through the import that follows.
   */
  const [importOpen, setImportOpen] = useState<boolean | null>(null)

  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveIssues, setSaveIssues] = useState<Clipper2Issue[]>([])
  const [jsonRevealId, setJsonRevealId] = useState<string | null>(null)

  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [previewing, setPreviewing] = useState<Record<string, boolean>>({})

  const [isDetecting, setIsDetecting] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [register, setRegister] = useState(true)
  const [replaceExisting, setReplaceExisting] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const jsonRef = useRef<HTMLTextAreaElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  // An artifact that exists but does not parse has content and no `file`: that is the
  // case the validation report matters most in, so "is there a file" is a question
  // about the bytes, never about whether they parsed.
  const hasArtifact = (pointSet?.content ?? '').trim().length > 0
  const parsed = pointSet?.file ?? null
  const crops = parsed?.crops ?? []
  const validation = pointSet?.validation ?? null

  // ============ Load ============

  const fitZoom = useCallback((canvasWidth: number) => {
    if (canvasWidth <= 0) return 0.3
    const available = window.innerWidth - 64 - PANEL_W - 80
    return Math.max(0.05, Math.min(1, available / canvasWidth))
  }, [])

  /**
   * Re-read the artifact. `resetDraft` is false whenever the file on disk cannot
   * have changed (a failed detection, an apply — apply never rewrites the artifact),
   * because silently replacing a draft the user is still editing loses their work.
   */
  const reloadPoints = useCallback(async (resetDraft: boolean) => {
    if (!chapterId) return
    try {
      const set = await clipper2Api.getPoints(chapterId)
      setPointSet(set)
      if (resetDraft) {
        setDraft(set.content)
        setDirty(false)
        setSaveError(null)
        setSaveIssues([])
      }
    } catch (err) {
      toast({
        title: 'Could not reload crop points',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive'
      })
    }
  }, [chapterId])

  const reloadOutputs = useCallback(async () => {
    if (!chapterId) return
    try {
      const result = await clipper2Api.getOutputs(chapterId)
      setOutputs(result.files)
      setExportDir(result.exportDir)
    } catch {
      // Outputs are informational; a listing failure must not break the workspace.
    }
  }, [chapterId])

  useEffect(() => {
    if (!chapterId) return
    let cancelled = false
    setLoading(true)

    Promise.all([
      clipperApi.getManifest(chapterId),
      clipper2Api.getPoints(chapterId),
      chaptersApi.getById(chapterId).catch(() => null),
      clipper2Api.getStatus().catch(() => null),
      clipper2Api.getOutputs(chapterId).catch(() => ({ exportDir: null, files: [] as Clipper2Output[] }))
    ])
      .then(([manifestData, set, chapterData, statusData, outputData]) => {
        if (cancelled) return
        setManifest(manifestData)
        setPointSet(set)
        setDraft(set.content)
        setDirty(false)
        setChapter(chapterData)
        setStatus(statusData)
        setOutputs(outputData.files)
        setExportDir(outputData.exportDir)
        setZoom(fitZoom(manifestData.canvasWidth))
        // A run started elsewhere (or before a reload) is still in flight; the row is
        // the only durable record of that, since socket events are not replayed.
        if (set.status === 'detecting') setIsDetecting(true)
      })
      .catch(err => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : 'Failed to load the chapter')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [chapterId, fitZoom])

  // ============ Viewer virtualization ============

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    const handleScroll = () => setScrollTop(container.scrollTop)
    const observer = new ResizeObserver(() => setViewportHeight(container.clientHeight))

    container.addEventListener('scroll', handleScroll, { passive: true })
    observer.observe(container)
    setViewportHeight(container.clientHeight)

    return () => {
      container.removeEventListener('scroll', handleScroll)
      observer.disconnect()
    }
  }, [loading])

  const isImageVisible = useCallback((img: ManifestImage): boolean => {
    const scaledY = img.canvasY * zoom
    const scaledH = img.canvasHeight * zoom
    return scaledY + scaledH > scrollTop - BUFFER_PX && scaledY < scrollTop + viewportHeight + BUFFER_PX
  }, [scrollTop, viewportHeight, zoom])

  // ============ Socket ============

  // The socket context keeps the LAST event of each kind forever and is shared by
  // every page, so whatever is already present at mount describes a run that ended
  // before we arrived. Remembering the mount-time value stops a stale completion
  // from toasting and from refetching over a live draft; comparing by identity then
  // makes each later event handled exactly once.
  const handledDetect = useRef(clipper2DetectComplete)
  const handledApply = useRef(clipper2ApplyComplete)

  useEffect(() => {
    const event = clipper2DetectComplete
    if (!event || event === handledDetect.current) return
    handledDetect.current = event
    if (event.chapterId !== chapterId) return

    setIsDetecting(false)

    if (event.error) {
      toast({ title: 'Pointer detection failed', description: event.error, variant: 'destructive' })
      // The artifact was not rewritten, so the draft is still the user's own.
      reloadPoints(false)
      return
    }

    const warnings = event.warnings?.length ?? 0
    toast({
      title: 'Pointers detected',
      description: `${event.cropCount ?? 0} crop pointer set${event.cropCount === 1 ? '' : 's'} written${warnings > 0 ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.`
    })
    // Detection replaced crop_points.json wholesale; any earlier draft describes a
    // file that no longer exists.
    reloadPoints(true)
  }, [clipper2DetectComplete, chapterId, reloadPoints])

  useEffect(() => {
    const event = clipper2ApplyComplete
    if (!event || event === handledApply.current) return
    handledApply.current = event
    if (event.chapterId !== chapterId) return

    setIsApplying(false)

    if (event.error) {
      toast({ title: 'Apply failed', description: event.error, variant: 'destructive' })
    } else {
      const failed = event.failed ?? 0
      toast({
        title: failed > 0 ? 'Applied with failures' : 'Crops applied',
        description: `${event.exported ?? 0} exported${failed > 0 ? `, ${failed} failed` : ''}${event.registered ? ' · registered for the Video Editor' : ''}.`,
        variant: failed > 0 ? 'destructive' : undefined
      })
    }

    // Apply reads the artifact and never writes it, so the draft is left alone; the
    // index row's status/exportDir did change.
    reloadPoints(false)
    reloadOutputs()
  }, [clipper2ApplyComplete, chapterId, reloadPoints, reloadOutputs])

  const detectProgress = isDetecting && clipper2DetectProgress?.chapterId === chapterId
    ? clipper2DetectProgress
    : null

  const applyProgress = isApplying && clipper2ApplyProgress?.chapterId === chapterId
    ? clipper2ApplyProgress
    : null

  // ============ Actions ============

  const detectBlockedReason = isDetecting
    ? 'A detection run is already in progress for this chapter'
    : status && !status.geminiAvailable
      ? status.geminiError || 'GEMINI_API_KEY is not configured'
      : null

  // The offline engine needs no key, so the only thing that can block it is a
  // missing Python venv (or a run already in flight).
  const offlineBlockedReason = isDetecting
    ? 'A detection run is already in progress for this chapter'
    : status && !status.offlineAvailable
      ? status.offlineError || 'Offline detection is unavailable — run `npm run ml:setup`'
      : null

  async function startDetect(engine: Clipper2Engine = 'gemini') {
    if (!chapterId) return
    if (dirty && !window.confirm('Detection overwrites crop_points.json, discarding your unsaved JSON edits. Continue?')) return
    setIsDetecting(true)
    try {
      await clipper2Api.detect(chapterId, { engine })
    } catch (err) {
      setIsDetecting(false)
      toast({
        title: 'Could not start detection',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive'
      })
    }
  }

  async function cancelDetect() {
    if (!chapterId) return
    try {
      await clipper2Api.cancel(chapterId)
    } catch (err) {
      toast({
        title: 'Could not cancel',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive'
      })
    }
  }

  async function startApply() {
    if (!chapterId) return
    // Stage 2 cuts from the file on disk. An unsaved draft would be ignored, which
    // is the one outcome the user would never guess.
    if (dirty && !window.confirm('Your JSON edits are not saved. Apply cuts from the saved file on disk, not from your draft. Continue anyway?')) return
    setIsApplying(true)
    try {
      await clipper2Api.apply(chapterId, { register, replaceExisting })
    } catch (err) {
      setIsApplying(false)
      toast({
        title: 'Could not start apply',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive'
      })
    }
  }

  async function saveDraft() {
    if (!chapterId) return
    setSaving(true)
    setSaveError(null)
    setSaveIssues([])
    try {
      const result = await putPoints(chapterId, draft)
      if (!result.ok) {
        // The draft is never cleared on rejection: it is the only copy of the edit.
        setSaveError(result.message)
        setSaveIssues([...(result.validation?.errors ?? []), ...(result.validation?.warnings ?? [])])
        return
      }
      setPointSet(result.set)
      // The server writes canonical bytes (`OUT-15`), so what is now on disk may be
      // formatted differently from what was typed. Showing the saved bytes keeps the
      // editor honest about the file apply will read.
      setDraft(result.set.content)
      setDirty(false)
      toast({ title: 'Crop points saved', description: `${result.set.file?.crops.length ?? 0} pointer sets on disk.` })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  /**
   * A manual import replaces the file on disk outright, so the editor draft has to
   * follow it — otherwise the JSON tab would still be showing the previous set and
   * the "unsaved edits" badge would be describing an edit to a file that no longer
   * exists.
   */
  function handleImported(set: Clipper2PointSet) {
    setPointSet(set)
    setDraft(set.content)
    setDirty(false)
    setSaveError(null)
    setSaveIssues([])
    setSelectedCropId(null)
    setPreviews({})
    // Collapse back to reviewing: the import worked, so the pointers are now the
    // thing worth looking at.
    setImportOpen(false)
  }

  async function revertDraft() {
    if (dirty && !window.confirm('Discard your unsaved JSON edits and reload the file from disk?')) return
    await reloadPoints(true)
  }

  async function runPreview(cropId: string) {
    if (!chapterId) return
    setPreviewing(prev => ({ ...prev, [cropId]: true }))
    try {
      const { preview } = await clipper2Api.previewCrop(chapterId, cropId)
      setPreviews(prev => ({ ...prev, [cropId]: preview }))
    } catch (err) {
      toast({
        title: `Could not preview ${cropId}`,
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive'
      })
    } finally {
      setPreviewing(prev => ({ ...prev, [cropId]: false }))
    }
  }

  function locateInViewer(entry: Clipper2CropEntry) {
    setSelectedCropId(entry.id)
    const container = scrollRef.current
    const bounds = normBounds(entry)
    if (!container || !bounds || !manifest) return
    container.scrollTo({ top: Math.max(0, bounds.top * manifest.canvasHeight * zoom - 80), behavior: 'smooth' })
  }

  function selectFromViewer(entry: Clipper2CropEntry) {
    setSelectedCropId(entry.id)
    setPanelTab('json')
    setJsonRevealId(entry.id)
  }

  // Reveal runs from an effect, not from the click: the JSON tab's content is
  // unmounted while the Pointers tab is active, so the textarea ref only exists
  // after the tab switch has been committed.
  useEffect(() => {
    if (!jsonRevealId || panelTab !== 'json') return
    const textarea = jsonRef.current
    if (!textarea) return

    const needle = `"${jsonRevealId}"`
    const at = draft.indexOf(needle)
    setJsonRevealId(null)
    if (at < 0) return

    const line = draft.slice(0, at).split('\n').length - 1
    const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 16
    textarea.focus({ preventScroll: true })
    textarea.setSelectionRange(at, at + needle.length)
    textarea.scrollTop = Math.max(0, line * lineHeight - textarea.clientHeight / 3)
  }, [jsonRevealId, panelTab, draft])

  // A hand edit only exists in this component's state, so a reload or a tab close
  // would lose it without a native prompt.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function goBack() {
    if (dirty && !window.confirm('You have unsaved JSON edits. Leave without saving?')) return
    navigate('/clipper2')
  }

  // ============ Render ============

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!manifest || loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <AlertTriangle className="h-8 w-8 text-amber-500" />
        <p>{loadError || 'Failed to load this chapter'}</p>
        <Button variant="outline" size="sm" onClick={() => navigate('/clipper2')}>
          Back to Image Clipper 2.0
        </Button>
      </div>
    )
  }

  const canvasW = manifest.canvasWidth
  const canvasH = manifest.canvasHeight
  const scaledWidth = canvasW * zoom
  const scaledHeight = canvasH * zoom

  const chapterLabel = chapter
    ? `Chapter ${chapter.number}${chapter.title ? ` · ${chapter.title}` : ''}`
    : 'Chapter'

  // `null` follows the chapter; an explicit toggle pins it. See `importOpen`.
  const showImport = importOpen ?? crops.length === 0

  // The artifact records the logical page it was measured against (`ST-09`). If the
  // chapter's pages changed since, every overlay here is drawn against the current
  // canvas while apply resolves against the same current pages — the numbers in the
  // file are still the truth, but they no longer describe what is on screen 1:1.
  const measuredMismatch = parsed && (parsed.image.width !== canvasW || parsed.image.height !== canvasH)
    ? parsed.image
    : null

  return (
    <div className="flex flex-col h-full">
      {/* ============ Toolbar ============ */}
      <div className="border-b bg-card px-4 py-2 flex items-center gap-3 flex-shrink-0">
        <Button variant="ghost" size="sm" onClick={goBack}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>

        <Separator orientation="vertical" className="h-6" />

        <span className="text-sm font-medium truncate max-w-[220px]">{chapterLabel}</span>

        <Separator orientation="vertical" className="h-6" />

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setZoom(z => Math.max(0.05, z - 0.1))}
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
            title="Fit to width"
            onClick={() => setZoom(fitZoom(canvasW))}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        <Separator orientation="vertical" className="h-6" />

        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={startApply}
          disabled={isApplying || crops.length === 0}
          title={crops.length === 0 ? 'There are no crop pointers to apply yet' : 'Cut the images from the saved pointer file'}
        >
          {isApplying ? (
            <>
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              Applying…
            </>
          ) : (
            <>
              <Scissors className="h-3.5 w-3.5 mr-1" />
              Apply pointers
            </>
          )}
        </Button>

        <Badge variant="secondary" className="flex items-center gap-1">
          <Locate className="h-3 w-3" />
          {crops.length} pointer set{crops.length === 1 ? '' : 's'}
        </Badge>

        <div className="flex-1" />

        {dirty && <Badge variant="warning">Unsaved edits</Badge>}

        <a
          href={chapterId ? clipper2Api.getPointsDownloadUrl(chapterId) : '#'}
          download
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          title="Download crop_points.json"
        >
          <Download className="h-3.5 w-3.5" />
          crop_points.json
        </a>
      </div>

      {/* ============ Progress ============ */}
      {detectProgress && (
        <div className="border-b bg-card px-4 py-2 flex items-center gap-3">
          <span className="text-xs text-muted-foreground capitalize whitespace-nowrap">
            Detect: {detectProgress.phase}
          </span>
          <Progress value={detectProgress.percent} className="flex-1 h-2" />
          {detectProgress.message && (
            <span className="text-xs text-muted-foreground truncate max-w-[280px]">
              {detectProgress.message}
            </span>
          )}
        </div>
      )}

      {applyProgress && (
        <div className="border-b bg-card px-4 py-2 flex items-center gap-3">
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            Cutting {applyProgress.current}/{applyProgress.total}
          </span>
          <Progress
            value={applyProgress.total > 0 ? (applyProgress.current / applyProgress.total) * 100 : 0}
            className="flex-1 h-2"
          />
        </div>
      )}

      <div className="flex-1 flex overflow-hidden relative">
        {/* ============ Viewer ============ */}
        <div ref={scrollRef} className="flex-1 overflow-auto bg-neutral-950 relative">
          {/* Every overlay below is positioned against this box, so it carries a
              horizontal centring margin and no vertical one: a top margin would
              offset the page images and the pointers by different amounts. */}
          <div className="relative" style={{ width: scaledWidth, height: scaledHeight, margin: '0 auto' }}>
            {manifest.images.map(img => (
              <div
                key={img.filename}
                style={{
                  position: 'absolute',
                  top: img.canvasY * zoom,
                  left: 0,
                  width: img.width * zoom,
                  height: img.height * zoom
                }}
              >
                {isImageVisible(img) ? (
                  <img
                    src={clipperApi.getImageUrl(chapterId!, img.filename)}
                    alt={img.filename}
                    loading="lazy"
                    draggable={false}
                    style={{
                      width: '100%',
                      height: '100%',
                      display: 'block',
                      pointerEvents: 'none',
                      userSelect: 'none'
                    }}
                  />
                ) : (
                  <div style={{ width: '100%', height: '100%', background: '#1a1a1a' }} />
                )}
              </div>
            ))}

            {crops.map(entry => {
              const bounds = normBounds(entry)
              if (!bounds) return null
              const selected = entry.id === selectedCropId
              const confidence = pointSet?.confidenceById?.[entry.id]

              return (
                <div key={entry.id}>
                  <div
                    onClick={() => selectFromViewer(entry)}
                    title={`${entry.id} — ${entry.reason}`}
                    style={{
                      position: 'absolute',
                      left: bounds.left * canvasW * zoom,
                      top: bounds.top * canvasH * zoom,
                      width: Math.max(1, (bounds.right - bounds.left) * canvasW * zoom),
                      height: Math.max(1, (bounds.bottom - bounds.top) * canvasH * zoom),
                      border: `2px solid ${selected ? ACCENT_SELECTED : ACCENT}`,
                      background: selected ? `${ACCENT}33` : `${ACCENT}14`,
                      boxShadow: selected ? `0 0 0 1px ${ACCENT}` : undefined,
                      cursor: 'pointer',
                      zIndex: selected ? 30 : 20
                    }}
                  >
                    <div
                      className="absolute flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium text-white whitespace-nowrap"
                      style={{
                        top: 2,
                        left: 2,
                        maxWidth: 'calc(100% - 4px)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        background: selected ? ACCENT : 'rgba(24,24,27,0.82)',
                        border: `1px solid ${ACCENT}`,
                        pointerEvents: 'none'
                      }}
                    >
                      <span>{entry.id}</span>
                      <span className="opacity-80">{entry.reason}</span>
                      {typeof confidence === 'number' && (
                        <span className="opacity-70">· {Math.round(confidence * 100)}%</span>
                      )}
                    </div>
                  </div>

                  {/* The pointers themselves, at their real coordinates and at a fixed
                      screen size so they stay legible (and a skewed quad stays visible)
                      at any zoom. */}
                  {(entry.crop?.points ?? []).filter(isUsablePoint).map(point => (
                    <div
                      key={point.id}
                      style={{
                        position: 'absolute',
                        left: point.x * canvasW * zoom,
                        top: point.y * canvasH * zoom,
                        width: DOT_PX,
                        height: DOT_PX,
                        marginLeft: -DOT_PX / 2,
                        marginTop: -DOT_PX / 2,
                        background: selected ? ACCENT_SELECTED : ACCENT,
                        border: '1px solid #faf5ff',
                        pointerEvents: 'none',
                        zIndex: selected ? 32 : 22
                      }}
                    >
                      <span
                        className="absolute text-[9px] font-bold leading-none px-0.5"
                        style={{
                          ...LABEL_OFFSET[point.id],
                          color: '#faf5ff',
                          background: 'rgba(24,24,27,0.75)',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {point.id}
                      </span>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>

        {/* ============ Side panel ============
            Always-open docked column: pointer review stays available at all times. */}
        <div className="relative h-full w-[420px] border-l bg-card flex flex-col flex-shrink-0 z-20 overflow-y-auto">
          <div className="flex items-center gap-2 px-3 pt-3">
            <span className="text-sm font-semibold flex-1">Crop pointers</span>
          </div>

          {/* ============ Getting pointers ============
              The manual loop is the primary path — copy the guidelines into a chat that
              holds the pages, bring the JSON back — with in-app Gemini detection beside
              it as the automatic alternative. The section collapses once the chapter
              has pointers, because from then on the list below is the point. */}
          <div className="border-b flex-shrink-0 mt-2">
            <div className="px-3 py-2 flex items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Get crop pointers
              </span>

              <div className="flex-1" />

              {isDetecting && (
                <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Detecting…
                </span>
              )}

              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setImportOpen(!showImport)}
              >
                {showImport ? (
                  <>
                    <ChevronUp className="h-3.5 w-3.5 mr-1" />
                    Hide
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3.5 w-3.5 mr-1" />
                    {crops.length > 0 ? 'Replace pointers' : 'Show steps'}
                  </>
                )}
              </Button>
            </div>

            {!showImport && crops.length > 0 && (
              <p className="px-3 pb-2 text-xs text-muted-foreground flex items-center gap-1.5 truncate">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
                {crops.length} pointer set{crops.length === 1 ? '' : 's'} on file
                {pointSet?.sidecar?.model ? ` · ${pointSet.sidecar.model}` : ''}
              </p>
            )}

            {showImport && (
              <div className="px-3 pb-3 space-y-3">
                {/* ① */}
                <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground text-[11px]">
                      1
                    </span>
                    Copy the prompt
                  </div>
                  <CopyPointerPromptButton size="sm" />
                  <p className="text-xs text-muted-foreground">
                    Paste it into a chat that already holds this chapter's pages — the Narration
                    Studio's manual tab is where they get attached.
                  </p>
                </div>

                {/* ② */}
                <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground text-[11px]">
                      2
                    </span>
                    Bring the JSON back
                  </div>

                  {chapterId && (
                    <PointerJsonDrop
                      chapterId={chapterId}
                      compact
                      hasExistingPoints={crops.length > 0}
                      onImported={handleImported}
                    />
                  )}

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <span className="text-xs text-muted-foreground">or</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => startDetect('gemini')}
                      disabled={detectBlockedReason != null}
                      title={detectBlockedReason ?? 'Run detection in-app against Gemini'}
                    >
                      {isDetecting ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5 mr-1" />
                      )}
                      Detect with Gemini
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => startDetect('offline')}
                      disabled={offlineBlockedReason != null}
                      title={
                        offlineBlockedReason ??
                        'Detect on this machine — no API key, no quota, measures the source pixels'
                      }
                    >
                      {isDetecting ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <Cpu className="h-3.5 w-3.5 mr-1" />
                      )}
                      Detect offline
                    </Button>
                    {isDetecting && (
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={cancelDetect}>
                        Cancel
                      </Button>
                    )}
                  </div>
                  {detectBlockedReason && !isDetecting && (
                    <p className="text-xs text-amber-600">{detectBlockedReason}</p>
                  )}
                  {!isDetecting && (
                    <p className="text-xs text-muted-foreground">
                      Offline detection finds where the artwork is without reading it, so its
                      reasons describe shape rather than content — good for a fast first pass,
                      or when there is no API quota left.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          <Tabs
            value={panelTab}
            onValueChange={value => setPanelTab(value as PanelTab)}
            className="flex-1 flex flex-col min-h-0"
          >
            <div className="flex items-center gap-2 mx-3 mt-3">
              <TabsList className="grid grid-cols-2 flex-1">
                <TabsTrigger value="pointers">Pointers</TabsTrigger>
                <TabsTrigger value="json">JSON</TabsTrigger>
              </TabsList>
            </div>

            {/* ---- Pointers ---- */}
            <TabsContent value="pointers" className="flex-1 min-h-0 overflow-auto px-3 pb-3 space-y-3 bg-card data-[state=inactive]:hidden">
              <ValidationSummary validation={validation} hasArtifact={hasArtifact} />

              {measuredMismatch && (
                <div className="flex items-start gap-2 text-xs text-amber-600 bg-amber-500/10 rounded p-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  <span>
                    These pointers were measured against a {measuredMismatch.width}×{measuredMismatch.height}
                    {' '}logical page (<code>{measuredMismatch.filename}</code>), but the chapter now measures
                    {' '}{canvasW}×{canvasH}. Overlays are drawn against the current pages — re-detect if the
                    images changed.
                  </span>
                </div>
              )}

              {pointSet?.sidecar && (
                <p className="text-[11px] text-muted-foreground">
                  {pointSet.sidecar.source === 'ai' ? 'Detected' : 'Hand-authored'}
                  {pointSet.sidecar.model ? ` by ${pointSet.sidecar.model}` : ''}
                  {' · '}{new Date(pointSet.sidecar.detectedAt).toLocaleString()}
                  {pointSet.sidecar.guidelinesSha
                    ? ` · guidelines ${pointSet.sidecar.guidelinesSha.slice(0, 8)}`
                    : ''}
                </p>
              )}

              {crops.length === 0 && hasArtifact ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  <AlertTriangle className="h-10 w-10 mx-auto mb-2 text-amber-500 opacity-70" />
                  <p>There is a crop_points.json on disk, but it does not parse.</p>
                  <p className="text-xs mt-1">Fix it in the JSON tab — the errors above say what is wrong.</p>
                </div>
              ) : crops.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  <FileJson className="h-10 w-10 mx-auto mb-2 opacity-30" />
                  <p>No crop pointers yet.</p>
                  <p className="text-xs mt-1">Run “Detect pointers”, or paste an artifact into the JSON tab.</p>
                </div>
              ) : (
                crops.map(entry => {
                  const bounds = normBounds(entry)
                  const selected = entry.id === selectedCropId
                  const confidence = pointSet?.confidenceById?.[entry.id]

                  return (
                    <div
                      key={entry.id}
                      className={`rounded-md border p-2 space-y-2 ${selected ? 'border-primary bg-accent/40' : ''}`}
                      onClick={() => setSelectedCropId(entry.id)}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="h-3 w-3 rounded-sm flex-shrink-0"
                          style={{ background: ACCENT }}
                        />
                        <span className="text-xs font-semibold">{entry.id}</span>
                        <span className="text-xs text-muted-foreground truncate">{entry.reason}</span>
                        <div className="flex-1" />
                        {typeof confidence === 'number' && (
                          <Badge variant="outline" className="text-[10px]">
                            conf {Math.round(confidence * 100)}%
                          </Badge>
                        )}
                      </div>

                      {bounds ? (
                        <>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
                            {(entry.crop?.points ?? []).map(point => (
                              <span key={point.id}>
                                <span className="text-foreground">{point.id}</span>{' '}
                                {Number.isFinite(point.x) ? point.x.toFixed(6) : '—'},{' '}
                                {Number.isFinite(point.y) ? point.y.toFixed(6) : '—'}
                              </span>
                            ))}
                          </div>

                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            <Badge variant="outline" className="text-[10px]">
                              {isFullWidth(bounds) ? 'full-width' : 'inset'}
                            </Badge>
                            <span>{((bounds.bottom - bounds.top) * 100).toFixed(2)}% of page height</span>
                          </div>
                        </>
                      ) : (
                        <p className="text-[10px] text-destructive">
                          This entry has no usable pointer coordinates.
                        </p>
                      )}

                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-[10px] px-2"
                          onClick={() => runPreview(entry.id)}
                          disabled={previewing[entry.id]}
                        >
                          {previewing[entry.id] ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <Eye className="h-3 w-3 mr-1" />
                          )}
                          Preview
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-[10px] px-2"
                          onClick={() => locateInViewer(entry)}
                        >
                          <Locate className="h-3 w-3 mr-1" />
                          Locate
                        </Button>
                      </div>

                      {previews[entry.id] && (
                        <img
                          src={previews[entry.id]}
                          alt={`${entry.id} preview`}
                          className="w-full rounded border"
                          draggable={false}
                        />
                      )}
                    </div>
                  )
                })
              )}
            </TabsContent>

            {/* ---- JSON ---- */}
            <TabsContent value="json" className="flex-1 min-h-0 flex flex-col px-3 pb-3 gap-2 bg-card data-[state=inactive]:hidden">
              <p className="text-[11px] text-muted-foreground">
                The artifact exactly as it sits on disk. Stage 2 cuts from this file, so a save
                is a commit — invalid JSON is rejected and never written.
              </p>

              <Textarea
                ref={jsonRef}
                className="flex-1 min-h-0 font-mono text-xs resize-none"
                spellCheck={false}
                value={draft}
                placeholder="No crop_points.json yet — run detection, or paste a four-point-crop artifact here and save."
                onChange={e => {
                  setDraft(e.target.value)
                  setDirty(true)
                }}
              />

              <div className="flex items-center gap-2">
                <Button size="sm" className="h-7 text-xs" onClick={saveDraft} disabled={saving || draft.trim().length === 0}>
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5 mr-1" />
                  )}
                  Save
                </Button>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={revertDraft} disabled={saving}>
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                  Revert
                </Button>
                <div className="flex-1" />
                <span className="text-[10px] text-muted-foreground">
                  {draft.length.toLocaleString()} chars · {draft ? draft.split('\n').length : 0} lines
                </span>
              </div>

              {saveError && (
                <div className="space-y-1 rounded border border-destructive/40 bg-destructive/10 p-2">
                  <p className="text-xs text-destructive font-medium flex items-start gap-1">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                    {saveError}
                  </p>
                  {saveIssues.map((issue, i) => (
                    <IssueRow key={`${issue.code}-${i}`} issue={issue} />
                  ))}
                  <p className="text-[10px] text-muted-foreground">
                    Your draft is untouched — fix the JSON above and save again.
                  </p>
                </div>
              )}
            </TabsContent>
          </Tabs>

          {/* ---- Apply block ---- */}
          <div className="border-t p-3 space-y-2 flex-shrink-0">
            <div className="flex items-start gap-2">
              <Checkbox
                id="clipper2-register"
                checked={register}
                onCheckedChange={value => setRegister(value === true)}
              />
              <Label htmlFor="clipper2-register" className="text-xs leading-snug">
                Register crops for the Video Editor
                <span className="block text-[10px] font-normal text-muted-foreground">
                  Writes the cut regions into this chapter's crop session so Module 4 can use them.
                </span>
              </Label>
            </div>

            <div className="flex items-start gap-2">
              <Checkbox
                id="clipper2-replace"
                checked={replaceExisting}
                onCheckedChange={value => setReplaceExisting(value === true)}
              />
              <Label htmlFor="clipper2-replace" className="text-xs leading-snug">
                Replace existing crops
                <span className="block text-[10px] font-normal text-destructive/80">
                  Destructive: deletes the crops already in that session before registering these.
                </span>
              </Label>
            </div>

            <Button
              className="w-full h-8 text-xs"
              onClick={startApply}
              disabled={isApplying || crops.length === 0}
            >
              {isApplying ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  Cutting images…
                </>
              ) : (
                <>
                  <Scissors className="h-3.5 w-3.5 mr-1" />
                  Apply pointers &amp; cut images
                </>
              )}
            </Button>

            {outputs.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{outputs.length} exported image{outputs.length === 1 ? '' : 's'}</span>
                  {pointSet?.appliedAt && (
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(pointSet.appliedAt).toLocaleString()}
                    </span>
                  )}
                </div>
                {exportDir && (
                  <p className="text-[10px] text-muted-foreground font-mono truncate" title={exportDir}>
                    {exportDir}
                  </p>
                )}
                <div className="max-h-48 overflow-auto space-y-1 pr-1">
                  {outputs.map(file => (
                    <div key={file.filename} className="flex items-center gap-2 text-[10px]">
                      <img
                        src={clipper2Api.getOutputUrl(chapterId!, file.filename)}
                        alt={file.filename}
                        loading="lazy"
                        draggable={false}
                        className="h-10 w-10 object-cover rounded border flex-shrink-0"
                      />
                      <span className="truncate flex-1 font-mono">{file.filename}</span>
                      <span className="text-muted-foreground flex-shrink-0">
                        {Math.max(1, Math.round(file.bytes / 1024))} KB
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============ Validation summary ============

function IssueRow({ issue }: { issue: Clipper2Issue }) {
  return (
    <div className="flex items-start gap-1.5 text-[10px] leading-snug">
      <Badge
        variant={issue.severity === 'error' ? 'destructive' : 'warning'}
        className="text-[9px] px-1 py-0 flex-shrink-0"
      >
        {issue.rule || issue.code}
      </Badge>
      <span className={issue.severity === 'error' ? 'text-destructive' : 'text-amber-600'}>
        {issue.cropId ? <span className="font-mono">{issue.cropId}: </span> : null}
        {issue.message}
      </span>
    </div>
  )
}

/**
 * Errors and warnings are shown separately because they mean different things to
 * Stage 2: an error means apply will refuse the file, a warning means it will cut
 * anyway and the result may not match the guidelines.
 */
function ValidationSummary({ validation, hasArtifact }: {
  validation: Clipper2Validation | null
  hasArtifact: boolean
}) {
  if (!validation || !hasArtifact) return null

  const { errors, warnings } = validation

  if (errors.length === 0 && warnings.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-green-600">
        <CheckCircle2 className="h-4 w-4" />
        Valid — every pointer set passes the guideline checks.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      {errors.length > 0 && (
        <div className="rounded border border-destructive/40 bg-destructive/10 p-2 space-y-1">
          <p className="text-xs font-medium text-destructive">
            {errors.length} error{errors.length === 1 ? '' : 's'} — apply will refuse this file
          </p>
          {errors.map((issue, i) => <IssueRow key={`e-${issue.code}-${i}`} issue={issue} />)}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-1">
          <p className="text-xs font-medium text-amber-600">
            {warnings.length} warning{warnings.length === 1 ? '' : 's'}
          </p>
          {warnings.map((issue, i) => <IssueRow key={`w-${issue.code}-${i}`} issue={issue} />)}
        </div>
      )}
    </div>
  )
}
