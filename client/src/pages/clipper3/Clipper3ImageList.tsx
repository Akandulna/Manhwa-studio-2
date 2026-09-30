/**
 * Clipper3ImageList — Module 3 v3: Image Clipper 3.0
 *
 * Reached from Clipper3SeriesView by clicking a chapter. Lists every image in
 * the chapter, each with its own crop status.
 *
 * The 3.0 model, and the reason this page does not reuse 2.0's:
 *  - A chapter is NOT one stitched canvas. Every image is independent.
 *  - Each image gets its own crop JSON and its own metadata document, pasted
 *    separately, with coordinates normalized 0.0–1.0 against THAT IMAGE alone.
 *  - An image is Done only once BOTH have been received. Status is read from
 *    the server per image and is never inferred from geometry, so one image's
 *    crops can never mark another image done.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@/components/ui/collapsible'
import { useToast } from '@/components/ui/use-toast'
import { useSocket, type Clipper3UnresolvedPage } from '@/lib/socket'
import { MurgaaDialog } from '@/components/narration/MurgaaDialog'
import {
  ArrowLeft,
  Loader2,
  AlertTriangle,
  Images,
  CheckCircle2,
  Clock,
  ImageIcon,
  FileText,
  FileCode,
  ClipboardPaste,
  Zap,
  Eye,
  ChevronLeft,
  ChevronRight,
  ScanEye,
  Scissors,
  Trash2,
  Bird,
  Tags,
  ClipboardCopy,
  ChevronDown,
  ExternalLink,
  Rows3,
  Check,
  FolderOpen,
  PackageCheck,
  Bot
} from 'lucide-react'
import {
  clipper3Api,
  type Clipper3ChapterImages,
  type Clipper3Image,
  type Clipper3SliceResult,
  type Clipper3HandoffStatus,
  type Clipper3AnalysisStatus,
  type Clipper3ImportIssue,
  type Clipper3ReviewView,
  type Clipper3SliceFile
} from '@/lib/api'
import { parseCropJson, type ParsedCropItem } from '@/lib/cropJsonValidator'
import { validateMetadataJson } from '@/lib/metadataValidator'
import { CropPointerEditor } from '@/components/clipper3/CropPointerEditor'
import { CandidateOverlay } from '@/components/clipper3/CandidateOverlay'
import { ReviewWorkspace } from '@/components/clipper3/ReviewWorkspace'
import { AutoRunBadge, AutoRunDialog, AutoRunStrip, isActiveStep, useAutoRun } from '@/components/clipper3/AutoRun'
import { seriesSlug, stemOf, exportedFilenameFor } from '@/lib/clipper3Naming'
import { PhonePageBadge, PhoneWorkingBadge } from '@/components/PhoneSyncBadge'
import { usePhoneCrops } from '@/hooks/usePhoneCrops'
import { PhoneRefreshButton } from '@/components/PhoneRefreshButton'

export default function Clipper3ImageList() {
  const { id: chapterId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { toast } = useToast()
  const {
    clipper3CropProgress,
    clipper3CropComplete
  } = useSocket()

  const [data, setData] = useState<Clipper3ChapterImages | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isCropping, setIsCropping] = useState(false)

  // Pages whose metadata names crops the cut did not produce. Held in state
  // rather than shown only as a toast: this is the one moment the mismatch is
  // cheap to explain, and a toast is gone before the user can act on it.
  const [unresolvedPages, setUnresolvedPages] = useState<Clipper3UnresolvedPage[]>([])

  // The row popup: an index into images, so Next/Previous just walk it.
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  // Separate from activeIndex: this dialog is a quick visual check (and
  // optional drag-to-adjust) of one image's crop pointers, independent of the
  // paste/copy workflow the row-click dialog runs.
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [copyingImage, setCopyingImage] = useState(false)
  const [copyingPrompt, setCopyingPrompt] = useState(false)
  const [copyingActionPrompt, setCopyingActionPrompt] = useState(false)
  const [copyingMetadata, setCopyingMetadata] = useState(false)
  const [copyingContext, setCopyingContext] = useState(false)
  const [copyingAll, setCopyingAll] = useState(false)
  const [promptsOpen, setPromptsOpen] = useState(false)

  // Slicing: the tall page cut into parts on disk, so each piece can be pasted
  // at full resolution instead of one downscaled strip. The server does the
  // cutting and writes a folder — the clipboard holds a single decoded image,
  // so selecting all the files in the OS file explorer is the only way to copy
  // the whole set at once.
  const [sliceResult, setSliceResult] = useState<Clipper3SliceResult | null>(null)
  const [slicing, setSlicing] = useState(false)
  const [slicesOpen, setSlicesOpen] = useState(false)
  const [copiedSlice, setCopiedSlice] = useState<number | null>(null)
  const [openingFolder, setOpeningFolder] = useState(false)

  // The ChatGPT package: the same slices, verified pixel-exact against the
  // fingerprinted original, plus a prompt carrying the page's job id and hash
  // so the reply can later be matched to exactly this version of the page.
  const [handoff, setHandoff] = useState<Clipper3HandoffStatus | null>(null)
  const [buildingHandoff, setBuildingHandoff] = useState(false)
  const [copiedHandoffPrompt, setCopiedHandoffPrompt] = useState(false)

  // ChatGPT's reply to that package, checked against it and converted to
  // page-pixel candidates. A rejected paste keeps its errors on screen and
  // leaves the previous import untouched.
  const [analysis, setAnalysis] = useState<Clipper3AnalysisStatus | null>(null)
  const [importingReply, setImportingReply] = useState(false)
  const [importErrors, setImportErrors] = useState<Clipper3ImportIssue[] | null>(null)
  const [candidatesOpen, setCandidatesOpen] = useState(false)

  // The page's review: decisions, acknowledged flags and approved descriptions
  // on top of the imported (or existing) crops, re-audited on every save.
  const [review, setReview] = useState<Clipper3ReviewView | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [startingReview, setStartingReview] = useState(false)

  // ChatGPT doing the review round: copy a prompt listing the current crops and
  // checks, paste its reply back. Repeated until nothing is left open.
  const [copyingReviewPrompt, setCopyingReviewPrompt] = useState(false)
  const [applyingReview, setApplyingReview] = useState(false)
  const [reviewReplyErrors, setReviewReplyErrors] = useState<Clipper3ImportIssue[] | null>(null)
  const [exportingPage, setExportingPage] = useState(false)
  const [lastExport, setLastExport] = useState<{ crops: number; revision: number } | null>(null)
  const [pastingJson, setPastingJson] = useState(false)
  const [pastingMetadata, setPastingMetadata] = useState(false)

  // Stored artifact text + parse report per image, fetched lazily when a row is
  // opened. Keyed by filename, but only ever as a display cache — the server's
  // per-image status is the source of truth for Done.
  const [storedJsonByFile, setStoredJsonByFile] = useState<Record<string, string>>({})
  const [storedMetadataByFile, setStoredMetadataByFile] = useState<Record<string, string>>({})
  const [parsedByFile, setParsedByFile] = useState<Record<string, ParsedCropItem[]>>({})
  const [previewOpen, setPreviewOpen] = useState(false)
  const [metadataPreviewOpen, setMetadataPreviewOpen] = useState(false)
  const [murgaaOpen, setMurgaaOpen] = useState(false)

  const images = data?.images ?? []
  const doneCount = useMemo(() => images.filter(i => i.status === 'done').length, [images])

  // Crop pointers the Sleeper-Cell phone is making for this chapter, from its
  // R2 receipt: each page's state there, and the page its Auto-run is on. It is
  // only re-read when "Refresh from phone" asks, to save R2 operations.
  // Pages match by filename, which the R2 zip carries to the phone unchanged.
  const phoneCropsReceipt = usePhoneCrops(data?.seriesId, chapterId)
  const phoneCrops = phoneCropsReceipt.status
  const phoneChapter = chapterId ? phoneCrops?.chapters[chapterId] : undefined
  const phoneWorking = phoneCrops?.working?.chapterId === chapterId ? phoneCrops?.working ?? null : null
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  // The ChatGPT loop run through the OpenAI API (server-side background job).
  // When it finishes the list is reloaded, and `autoRunVersion` makes an open
  // page dialog re-read its package / import / review from disk.
  const [autoDialogOpen, setAutoDialogOpen] = useState(false)
  const [autoRunVersion, setAutoRunVersion] = useState(0)
  const autoRun = useAutoRun(chapterId, () => {
    if (!chapterId) return
    clipper3Api.getImages(chapterId).then(setData).catch(() => { /* the old list stays */ })
    setAutoRunVersion(v => v + 1)
  })
  useEffect(() => {
    if (!chapterId) return
    let cancelled = false
    setLoading(true)

    clipper3Api.getImages(chapterId)
      .then(fresh => { if (!cancelled) setData(fresh) })
      .catch(err => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load this chapter')
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [chapterId])

  // Deep link from Preview's "Edit" button: open the named row once, then
  // drop the param so re-closing/reopening the dialog doesn't re-trigger it.
  useEffect(() => {
    if (!data) return
    const file = searchParams.get('file')
    if (!file) return
    const index = data.images.findIndex(img => img.filename === file)
    if (index !== -1) setActiveIndex(index)
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('file')
      return next
    }, { replace: true })
  }, [data, searchParams, setSearchParams])

  const activeImage: Clipper3Image | null =
    activeIndex != null ? images[activeIndex] ?? null : null

  const previewImage: Clipper3Image | null =
    previewIndex != null ? images[previewIndex] ?? null : null

  // Whatever this image already has on disk, so reopening a row shows the JSON
  // that is actually stored rather than only what was pasted this session.
  useEffect(() => {
    if (!chapterId || !activeImage || !activeImage.hasPoints) return
    if (storedJsonByFile[activeImage.filename] !== undefined) return

    let cancelled = false
    clipper3Api.getImagePoints(chapterId, activeImage.filename)
      .then(result => {
        if (cancelled || !result.content) return
        setStoredJsonByFile(prev => ({ ...prev, [activeImage.filename]: result.content }))
      })
      .catch(() => {
        // Display-only; the row's status already came from the server.
      })

    return () => { cancelled = true }
  }, [chapterId, activeImage, storedJsonByFile])

  // Same for the metadata document.
  useEffect(() => {
    if (!chapterId || !activeImage || !activeImage.hasMetadata) return
    if (storedMetadataByFile[activeImage.filename] !== undefined) return

    let cancelled = false
    clipper3Api.getImageMetadata(chapterId, activeImage.filename)
      .then(result => {
        if (cancelled || !result.content) return
        setStoredMetadataByFile(prev => ({ ...prev, [activeImage.filename]: result.content }))
      })
      .catch(() => {
        // Display-only; the row's status already came from the server.
      })

    return () => { cancelled = true }
  }, [chapterId, activeImage, storedMetadataByFile])

  // Mount-time snapshot: the socket context keeps the last event of each kind
  // forever, so one already present describes a run that ended before this page
  // loaded and must not toast or reload here.
  const handledCrop = useRef(clipper3CropComplete)

  useEffect(() => {
    const event = clipper3CropComplete
    if (!event || event === handledCrop.current) return
    handledCrop.current = event
    if (event.chapterId !== chapterId) return

    setIsCropping(false)

    if (event.error) {
      toast({ title: 'Crop sections failed', description: event.error, variant: 'destructive' })
      return
    }

    const failed = event.failed ?? 0
    const unresolved = event.unresolved ?? []
    setUnresolvedPages(unresolved)

    const unresolvedCount = unresolved.reduce((n, page) => n + page.missing.length, 0)
    toast({
      title: failed > 0 ? 'Cropped with failures' : 'Crop sections saved',
      description:
        `${event.exported ?? 0} section${event.exported === 1 ? '' : 's'} from ` +
        `${event.images ?? 0} image${event.images === 1 ? '' : 's'}` +
        `${failed > 0 ? `, ${failed} failed` : ''}.` +
        // Named in the toast as well as the banner, so a run left unattended
        // still says something was wrong when the user comes back to it.
        (unresolvedCount > 0
          ? ` ${unresolvedCount} metadata name${unresolvedCount === 1 ? '' : 's'} on ` +
            `${unresolved.length} page${unresolved.length === 1 ? '' : 's'} match no file.`
          : ''),
      variant: failed > 0 || unresolvedCount > 0 ? 'destructive' : undefined
    })
  }, [clipper3CropComplete, chapterId, toast])

  const unresolvedNameCount = unresolvedPages.reduce((n, page) => n + page.missing.length, 0)

  const cropProgress = isCropping && clipper3CropProgress?.chapterId === chapterId
    ? clipper3CropProgress
    : null

  // ============ Actions ============

  /**
   * `navigator.clipboard.write` accepts only image/png — JPEG, WebP and GIF are
   * all refused. A PNG source copies its exact original bytes; anything else is
   * decoded and re-encoded as PNG purely to satisfy that (same pixels, different
   * container).
   */
  const toPngBlob = useCallback((sourceBlob: Blob): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(sourceBlob)
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          URL.revokeObjectURL(url)
          reject(new Error('Canvas is unavailable in this browser'))
          return
        }
        ctx.drawImage(img, 0, 0)
        canvas.toBlob(pngBlob => {
          URL.revokeObjectURL(url)
          if (!pngBlob) {
            reject(new Error('Could not re-encode the image as PNG'))
            return
          }
          resolve(pngBlob)
        }, 'image/png')
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('Could not decode the image for conversion'))
      }
      img.src = url
    })
  }, [])

  const copyImageToClipboard = useCallback(async () => {
    if (!chapterId || !activeImage) return
    setCopyingImage(true)
    try {
      const response = await fetch(clipper3Api.getImageUrl(chapterId, activeImage.filename))
      if (!response.ok) throw new Error(`Could not fetch the image (HTTP ${response.status})`)
      const blob = await response.blob()

      const needsConversion = blob.type !== 'image/png'
      const clipboardBlob = needsConversion ? await toPngBlob(blob) : blob
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': clipboardBlob })])

      toast({
        title: 'Image copied',
        description: needsConversion
          ? `${activeImage.filename} — converted to PNG (the clipboard only accepts PNG images)`
          : activeImage.filename
      })
    } catch (error) {
      toast({
        title: 'Copy failed',
        description: error instanceof Error ? error.message : 'Could not copy the image',
        variant: 'destructive'
      })
    } finally {
      setCopyingImage(false)
    }
  }, [chapterId, activeImage, toast, toPngBlob])

  /**
   * Cuts the active image into vertical parts, written to a folder on disk.
   *
   * sharp reads the true pixel dimensions off the file and extracts losslessly,
   * so the cut never touches the scaled-down preview shown above.
   */
  const sliceActiveImage = useCallback(async () => {
    if (!chapterId || !activeImage) return
    setSlicing(true)
    try {
      const result = await clipper3Api.sliceImage(chapterId, activeImage.filename)
      setSliceResult(result)
      setCopiedSlice(null)
      setSlicesOpen(true)
      toast({
        title: `Sliced into ${result.files.length} parts`,
        description: 'Open the folder, select all, and copy them together.'
      })
    } catch (error) {
      toast({
        title: 'Slicing failed',
        description: error instanceof Error ? error.message : 'Could not slice the image',
        variant: 'destructive'
      })
    } finally {
      setSlicing(false)
    }
  }, [chapterId, activeImage, toast])

  /**
   * Reveals the slice folder in Finder/Explorer.
   *
   * This is the "copy them all" path: the system clipboard holds only one
   * decoded image, but it holds any number of FILE references — so selecting
   * the files there and pressing copy puts all 18 on the clipboard at once,
   * which no web page can do on its own.
   */
  const openSliceFolder = useCallback(async () => {
    if (!chapterId || !activeImage) return
    setOpeningFolder(true)
    try {
      await clipper3Api.openSliceFolder(chapterId, activeImage.filename)
    } catch (error) {
      toast({
        title: 'Could not open the folder',
        description: error instanceof Error ? error.message : 'Failed to open the folder',
        variant: 'destructive'
      })
    } finally {
      setOpeningFolder(false)
    }
  }, [chapterId, activeImage, toast])

  /**
   * Puts ONE slice on the clipboard, for when only a single part is needed.
   * Fetched from disk rather than held in memory, so the browser never keeps
   * eighteen decoded pages alive at once.
   */
  const copySliceToClipboard = useCallback(async (slice: Clipper3SliceFile) => {
    if (!chapterId || !activeImage) return
    try {
      const response = await fetch(
        clipper3Api.getSliceUrl(chapterId, activeImage.filename, slice.filename)
      )
      if (!response.ok) throw new Error(`Could not fetch the slice (HTTP ${response.status})`)
      const blob = await response.blob()
      // Slices are WebP; the clipboard only takes PNG.
      const pngBlob = blob.type === 'image/png' ? blob : await toPngBlob(blob)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
      setCopiedSlice(slice.index)
    } catch (error) {
      toast({
        title: 'Copy failed',
        description: error instanceof Error ? error.message : 'Could not copy the slice',
        variant: 'destructive'
      })
    }
  }, [chapterId, activeImage, toast, toPngBlob])

  /**
   * Builds (or rebuilds) the active page's ChatGPT package and copies its
   * prompt. The slices it writes are the ones the panel above lists, so the
   * existing "Open folder" step is how they get attached.
   */
  const buildHandoffForActive = useCallback(async () => {
    if (!chapterId || !activeImage) return
    setBuildingHandoff(true)
    try {
      const result = await clipper3Api.buildHandoff(chapterId, activeImage.filename)
      setHandoff({ status: 'ready', staleReasons: [], manifest: result.manifest, prompt: result.prompt })
      setSliceResult(result.sliced)
      setCopiedSlice(null)
      setSlicesOpen(true)
      let copied = true
      try {
        await navigator.clipboard.writeText(result.prompt)
        setCopiedHandoffPrompt(true)
      } catch {
        copied = false
      }
      toast({
        title: `ChatGPT package ready — ${result.manifest.slices.length} verified slices`,
        description: copied
          ? 'Prompt copied. Open the folder, attach every slice in order, then paste the prompt.'
          : 'Use the copy button next to it for the prompt, then attach every slice in order.'
      })
    } catch (error) {
      toast({
        title: 'Could not build the ChatGPT package',
        description: error instanceof Error ? error.message : 'Packaging failed',
        variant: 'destructive'
      })
    } finally {
      setBuildingHandoff(false)
    }
  }, [chapterId, activeImage, toast])

  const copyHandoffPrompt = useCallback(async () => {
    if (!handoff?.prompt) return
    try {
      await navigator.clipboard.writeText(handoff.prompt)
      setCopiedHandoffPrompt(true)
    } catch (error) {
      toast({
        title: 'Copy failed',
        description: error instanceof Error ? error.message : 'Could not copy the prompt',
        variant: 'destructive'
      })
    }
  }, [handoff, toast])

  /**
   * Imports ChatGPT's reply from the clipboard. The server checks it against
   * this page's package (job id, hash, size, slice geometry) and only stores
   * it when every check passes.
   */
  const pasteChatGptReply = useCallback(async () => {
    if (!chapterId || !activeImage) return
    setImportingReply(true)
    try {
      const content = await navigator.clipboard.readText()
      if (!content.trim()) {
        toast({ title: 'Clipboard is empty', variant: 'destructive' })
        return
      }
      const outcome = await clipper3Api.importAnalysis(chapterId, activeImage.filename, content)
      if (!outcome.imported || !outcome.analysis) {
        setImportErrors(outcome.errors)
        toast({
          title: 'ChatGPT reply rejected',
          description: `${outcome.errors.length} problem${outcome.errors.length === 1 ? '' : 's'} — nothing was imported`,
          variant: 'destructive'
        })
        return
      }
      setImportErrors(null)
      setAnalysis({ analysis: outcome.analysis, stale: false, staleReasons: [] })
      // No review yet: start one from this reply straight away, so the next
      // step (review — by hand or by ChatGPT) is one click.
      if (!review?.state) {
        clipper3Api.startReview(chapterId, activeImage.filename, 'import', false)
          .then(setReview)
          .catch(() => { /* "Start review" stays available. */ })
      }
      const count = outcome.analysis.candidates.length
      toast({
        title: `Imported ${count} candidate${count === 1 ? '' : 's'}`,
        description: outcome.warnings.length > 0
          ? `${outcome.warnings.length} warning${outcome.warnings.length === 1 ? '' : 's'} to review — open "View on page".`
          : 'Open "View on page" to check the boxes line up.'
      })
    } catch (error) {
      toast({
        title: 'Import failed',
        description: error instanceof Error ? error.message : 'Could not import the reply',
        variant: 'destructive'
      })
    } finally {
      setImportingReply(false)
    }
  }, [chapterId, activeImage, toast])

  /**
   * Starts (or restarts) this page's review from the latest ChatGPT import or
   * from its existing pointers. Restarting keeps the old review in the page's
   * review-history, but its decisions stop applying, so it asks first.
   */
  const startReviewFor = useCallback(async (from: 'import' | 'pointers', replace = false) => {
    if (!chapterId || !activeImage) return
    if (replace && !window.confirm('Start the review over? Current decisions are kept in the review history but no longer apply.')) return
    setStartingReview(true)
    try {
      const view = await clipper3Api.startReview(chapterId, activeImage.filename, from, replace)
      setReview(view)
      setReviewOpen(true)
    } catch (error) {
      toast({
        title: 'Could not start the review',
        description: error instanceof Error ? error.message : 'Starting the review failed',
        variant: 'destructive'
      })
    } finally {
      setStartingReview(false)
    }
  }, [chapterId, activeImage, toast, review?.state])

  const copyReviewPrompt = useCallback(async () => {
    if (!chapterId || !activeImage) return
    setCopyingReviewPrompt(true)
    try {
      const { prompt, review_revision } = await clipper3Api.getReviewPrompt(chapterId, activeImage.filename)
      await navigator.clipboard.writeText(prompt)
      toast({
        title: `Review prompt copied (revision ${review_revision})`,
        description: 'Paste it into the same ChatGPT chat that has this page\'s slices, then paste its JSON back here.'
      })
    } catch (error) {
      toast({ title: 'Could not copy the review prompt', description: error instanceof Error ? error.message : 'Failed', variant: 'destructive' })
    } finally {
      setCopyingReviewPrompt(false)
    }
  }, [chapterId, activeImage, toast])

  const pasteChatGptReview = useCallback(async () => {
    if (!chapterId || !activeImage) return
    setApplyingReview(true)
    try {
      const content = await navigator.clipboard.readText()
      if (!content.trim()) {
        toast({ title: 'Clipboard is empty', variant: 'destructive' })
        return
      }
      const outcome = await clipper3Api.applyChatGptReview(chapterId, activeImage.filename, content)
      if (!outcome.applied || !outcome.view) {
        setReviewReplyErrors(outcome.errors)
        toast({ title: 'ChatGPT review rejected', description: `${outcome.errors.length} problem(s) — nothing was changed`, variant: 'destructive' })
        return
      }
      setReviewReplyErrors(null)
      setReview(outcome.view)
      const s = outcome.summary
      const changes = s ? [
        s.kept && `${s.kept} kept`, s.adjusted && `${s.adjusted} adjusted`, s.split && `${s.split} split parts`,
        s.merged && `${s.merged} merged`, s.added && `${s.added} added`, s.removed && `${s.removed} removed`
      ].filter(Boolean).join(', ') : ''
      const left = outcome.view.readiness.blockers.length
      toast({
        title: left === 0 ? 'ChatGPT review applied — ready to export' : `ChatGPT review applied — ${left} left`,
        description: left === 0
          ? changes
          : `${changes}. Copy the review prompt again for another round (changed boxes get fresh checks).`
      })
    } catch (error) {
      toast({ title: 'Review import failed', description: error instanceof Error ? error.message : 'Failed', variant: 'destructive' })
    } finally {
      setApplyingReview(false)
    }
  }, [chapterId, activeImage, toast])

  const exportFromPopup = useCallback(async () => {
    if (!chapterId || !activeImage) return
    setExportingPage(true)
    try {
      const report = await clipper3Api.exportPage(chapterId, activeImage.filename)
      setLastExport({ crops: report.crop_count, revision: report.review_revision })
      clipper3Api.getImages(chapterId).then(setData).catch(() => {})
      toast({
        title: `Exported ${report.crop_count} crop${report.crop_count === 1 ? '' : 's'}`,
        description: `PNGs in ${report.destinations.crops}, JSON in ${report.destinations.processed}.`
      })
    } catch (error) {
      toast({ title: 'Export failed', description: error instanceof Error ? error.message : 'Export failed', variant: 'destructive' })
    } finally {
      setExportingPage(false)
    }
  }, [chapterId, activeImage, toast])

  // A package describes one exact version of one page, so it — and the reply
  // imported against it — is re-read (and re-verified against the files on
  // disk) whenever the active row changes.
  useEffect(() => {
    setHandoff(null)
    setCopiedHandoffPrompt(false)
    setAnalysis(null)
    setImportErrors(null)
    setCandidatesOpen(false)
    setReview(null)
    setReviewOpen(false)
    setReviewReplyErrors(null)
    setLastExport(null)
    if (!chapterId || !activeImage) return
    let cancelled = false
    clipper3Api
      .getHandoff(chapterId, activeImage.filename)
      .then(status => { if (!cancelled) setHandoff(status) })
      .catch(() => { /* No package status is shown; building still works. */ })
    clipper3Api
      .getAnalysis(chapterId, activeImage.filename)
      .then(status => { if (!cancelled) setAnalysis(status) })
      .catch(() => { /* No import status is shown; importing still works. */ })
    clipper3Api
      .getReview(chapterId, activeImage.filename)
      .then(view => { if (!cancelled) setReview(view) })
      .catch(() => { /* No review status is shown; starting one still works. */ })
    return () => { cancelled = true }
  }, [chapterId, activeImage?.filename, autoRunVersion])

  // Slices belong to the image that produced them: moving to another row (or
  // closing the dialog) drops the panel back to its unsliced state. The files
  // stay on disk — re-slicing overwrites them.
  useEffect(() => {
    setSliceResult(null)
    setSlicesOpen(false)
    setCopiedSlice(null)
  }, [activeImage?.filename])

  /** The guideline file uploaded in Settings → Crop 3.0 → Guideline File (browser-local). */
  const copyPromptToClipboard = useCallback(async () => {
    setCopyingPrompt(true)
    try {
      const raw = localStorage.getItem('crop3.guidelineFile')
      const parsed = raw ? (JSON.parse(raw) as { name: string; content: string }) : null
      if (!parsed || !parsed.content.trim()) {
        toast({
          title: 'No guideline file saved',
          description: 'Upload one in Settings → Crop 3.0 → Guideline File first.',
          variant: 'destructive'
        })
        return
      }
      await navigator.clipboard.writeText(parsed.content)
      toast({ title: 'Guideline file copied', description: parsed.name })
    } catch (error) {
      toast({
        title: 'Copy failed',
        description: error instanceof Error ? error.message : 'Could not copy the guideline file',
        variant: 'destructive'
      })
    } finally {
      setCopyingPrompt(false)
    }
  }, [toast])

  /** The free-text prompt saved in Settings → Crop 3.0 → Prompt (browser-local). */
  const copyActionPromptToClipboard = useCallback(async () => {
    setCopyingActionPrompt(true)
    try {
      const raw = localStorage.getItem('crop3.prompt')
      const parsed = raw ? (JSON.parse(raw) as { content: string }) : null
      if (!parsed || !parsed.content.trim()) {
        toast({
          title: 'No prompt saved',
          description: 'Add one in Settings → Crop 3.0 → Prompt first.',
          variant: 'destructive'
        })
        return
      }
      await navigator.clipboard.writeText(parsed.content)
      toast({ title: 'Action prompt copied', description: `${parsed.content.length.toLocaleString()} characters` })
    } catch (error) {
      toast({
        title: 'Copy failed',
        description: error instanceof Error ? error.message : 'Could not copy the action prompt',
        variant: 'destructive'
      })
    } finally {
      setCopyingActionPrompt(false)
    }
  }, [toast])

  /** The metadata template uploaded in Settings → Crop 3.0 → Metadata Template (browser-local). */
  /**
   * The per-chapter half of the metadata prompt.
   *
   * The template in Settings is static, but series_slug and image_stem change
   * with every chapter and image — so an AI given only the template has no way
   * to know them and invents placeholders instead ("unknown_series", the upload
   * UUID). This block supplies them, plus the exact filenames the cutter will
   * write, so the AI fills in descriptions rather than deriving names.
   */
  const exportContext = useMemo(() => {
    if (!data || !activeImage) return null

    const slug = seriesSlug(data.seriesTitle)
    const stem = stemOf(activeImage.filename)

    // parsedByFile is only populated on paste, so a row reopened in a later
    // session would otherwise look like it had no crops. Fall back to parsing
    // the stored JSON, which is what the cutter will read anyway.
    const stored = storedJsonByFile[activeImage.filename]
    const parsed =
      parsedByFile[activeImage.filename] ??
      (stored ? parseCropJson(stored, undefined, activeImage.filename) : [])

    // Names are only exact when this image's crop JSON is already attached —
    // the count and the reason suffixes both come from it. Without it the block
    // still pins slug and stem (the two values that actually get hallucinated)
    // and says plainly that the list is not yet known.
    const crops = parsed.map((item, i) => ({
      id: item.id ?? `crop-${String(i + 1).padStart(2, '0')}`,
      exportedFilename: exportedFilenameFor(slug, stem, i, item.reason)
    }))

    const text = JSON.stringify({
      sourceContext: {
        series_title: data.seriesTitle,
        series_slug: slug,
        chapter_number: data.number,
        image_filename: activeImage.filename,
        image_stem: stem,
        crop_count: crops.length
      },
      namingPattern: '{series_slug}_{image_stem}_{crop_index}{_reason}.png',
      rules: [
        'Use series_slug and image_stem EXACTLY as given above. Never invent, guess, abbreviate or substitute them.',
        'crop_index is two-digit and 1-based, in the order the crops are listed.',
        'The _reason suffix comes from the crop JSON, not from you. Never add, remove or reword it.',
        'If exportedFilename is given for a crop, reproduce it character-for-character.',
        'If any value above is missing, stop and say so rather than emitting a placeholder.'
      ],
      crops: crops.length > 0
        ? crops
        : 'This image has no crop JSON attached yet — the exact filenames are not known. Paste the crop JSON first, then copy this block again.'
    }, null, 2)

    return { text, slug, stem, cropCount: crops.length }
  }, [data, activeImage, parsedByFile, storedJsonByFile])

  const copyExportContextToClipboard = useCallback(async () => {
    if (!exportContext) return
    setCopyingContext(true)
    try {
      await navigator.clipboard.writeText(exportContext.text)
      toast({
        title: 'Export context copied',
        description: exportContext.cropCount > 0
          ? `${exportContext.slug} / ${exportContext.stem} — ${exportContext.cropCount} filename${exportContext.cropCount === 1 ? '' : 's'}`
          : `${exportContext.slug} / ${exportContext.stem} — attach the crop JSON for exact filenames`
      })
    } catch (error) {
      toast({
        title: 'Copy failed',
        description: error instanceof Error ? error.message : 'Could not copy the export context',
        variant: 'destructive'
      })
    } finally {
      setCopyingContext(false)
    }
  }, [exportContext, toast])

  /**
   * All four prompt artifacts in one clipboard payload.
   *
   * Order: action prompt first (the instruction the AI should act on before
   * anything else), then guidelines, then the export context, then the
   * metadata template. The context must still precede the template — the
   * template's own namingRules are what the AI would otherwise follow, and it
   * can only override them if the concrete slug and stem are already in view.
   *
   * A missing artifact is reported rather than silently skipped: a bundle that
   * quietly dropped the export context would reintroduce exactly the
   * placeholder-filename bug this block exists to prevent.
   */
  const copyAllPromptsToClipboard = useCallback(async () => {
    if (!activeImage) return
    setCopyingAll(true)
    try {
      const readStored = (key: string): string | null => {
        try {
          const raw = localStorage.getItem(key)
          const parsed = raw ? (JSON.parse(raw) as { content?: string }) : null
          const content = parsed?.content
          return content && content.trim() ? content : null
        } catch {
          return null
        }
      }

      const parts: { label: string; body: string | null }[] = [
        { label: 'ACTION PROMPT', body: readStored('crop3.prompt') },
        { label: 'GUIDELINES', body: readStored('crop3.guidelineFile') },
        { label: 'EXPORT CONTEXT', body: exportContext?.text ?? null },
        { label: 'METADATA TEMPLATE', body: readStored('crop3.metadataTemplate') }
      ]

      const missing = parts.filter(p => !p.body).map(p => p.label)
      if (missing.length === parts.length) {
        toast({
          title: 'Nothing to copy',
          description: 'Add the prompts in Settings → Crop 3.0 first.',
          variant: 'destructive'
        })
        return
      }

      const bundle = parts
        .filter(p => p.body)
        .map(p => `===== ${p.label} =====\n\n${p.body}`)
        .join('\n\n')

      await navigator.clipboard.writeText(bundle)

      toast({
        title: missing.length > 0 ? 'Copied, some parts missing' : 'All prompts copied',
        description: missing.length > 0
          ? `Missing: ${missing.join(', ')}. Add them in Settings → Crop 3.0.`
          : `${parts.length} sections for ${activeImage.filename}`,
        variant: missing.length > 0 ? 'destructive' : undefined
      })
    } catch (error) {
      toast({
        title: 'Copy failed',
        description: error instanceof Error ? error.message : 'Could not copy the prompts',
        variant: 'destructive'
      })
    } finally {
      setCopyingAll(false)
    }
  }, [activeImage, exportContext, toast])

  const copyMetadataTemplateToClipboard = useCallback(async () => {
    setCopyingMetadata(true)
    try {
      const raw = localStorage.getItem('crop3.metadataTemplate')
      const parsed = raw ? (JSON.parse(raw) as { name: string; content: string }) : null
      if (!parsed || !parsed.content.trim()) {
        toast({
          title: 'No metadata template saved',
          description: 'Upload one in Settings → Crop 3.0 → Metadata Template first.',
          variant: 'destructive'
        })
        return
      }
      await navigator.clipboard.writeText(parsed.content)
      toast({ title: 'Metadata template copied', description: parsed.name })
    } catch (error) {
      toast({
        title: 'Copy failed',
        description: error instanceof Error ? error.message : 'Could not copy the metadata template',
        variant: 'destructive'
      })
    } finally {
      setCopyingMetadata(false)
    }
  }, [toast])

  /**
   * Stores the clipboard as THIS image's metadata document.
   *
   * The document is free-form, so it is kept verbatim and never parsed — the
   * only check is that it is not empty. Together with the crop JSON it is what
   * makes an image done, so the row's status comes back from the server rather
   * than being assumed here.
   */
  const pasteMetadataFromClipboard = useCallback(async () => {
    if (!chapterId || !activeImage) return
    const filename = activeImage.filename
    setPastingMetadata(true)
    try {
      const content = await navigator.clipboard.readText()
      if (!content.trim()) {
        toast({ title: 'Clipboard is empty', variant: 'destructive' })
        return
      }

      // Checked against THIS image's own crop ids before it ever reaches the
      // server: metadata whose ids don't match what the points file actually
      // has (or that isn't even the crops[] shape) is exactly what used to
      // get silently accepted and marked Done — see validateMetadataJson.
      const stored = storedJsonByFile[filename]
      const parsed = parsedByFile[filename] ?? (stored ? parseCropJson(stored, undefined, filename) : [])
      const expectedIds = parsed.map((item, i) => item.id ?? `crop-${String(i + 1).padStart(2, '0')}`)

      // Names, not just ids. Metadata that describes the right crops under
      // another page's filenames passes every id check but writes a document
      // that points at files this image will never produce.
      const expectedFilenames = data
        ? parsed.map((item, i) =>
            exportedFilenameFor(seriesSlug(data.seriesTitle), stemOf(filename), i, item.reason)
          )
        : undefined

      if (expectedIds.length === 0) {
        toast({
          title: 'Attach the crop JSON first',
          description: 'Metadata is validated against this image\'s own crop ids, which aren\'t known until the crop JSON is attached.',
          variant: 'destructive'
        })
        return
      }

      const validation = validateMetadataJson(
        content,
        expectedIds,
        expectedFilenames,
        data ? seriesSlug(data.seriesTitle) : undefined
      )
      if (!validation.isValid) {
        // A toast can't hold an unbounded error list: joining them all used to
        // truncate mid-filename, which hid the one character that differed and
        // made the message useless. Show the first two and say how many more.
        const [first, ...rest] = validation.errors
        const description =
          rest.length > 0
            ? `${[first, rest[0]].join(' ')}${rest.length > 1 ? ` (+${rest.length - 1} more)` : ''}`
            : first

        toast({
          title: 'Metadata verification failed',
          description,
          variant: 'destructive'
        })
        // The full list always goes to the console, so nothing is lost.
        console.warn(`[clipper3] metadata rejected for ${filename}:`, validation.errors)
        return
      }

      const result = await clipper3Api.putImageMetadata(chapterId, filename, content)
      setStoredMetadataByFile(prev => ({ ...prev, [filename]: result.content }))

      setData(prev => prev && {
        ...prev,
        images: prev.images.map(img =>
          img.filename === filename
            ? {
                ...img,
                hasMetadata: true,
                metadataValid: result.metadataValid,
                status: result.status ?? (img.hasPoints && img.cropCount > 0 ? 'done' : 'pending')
              }
            : img
        )
      })

      toast({
        title: 'Metadata saved',
        description: `${filename} · ${content.length.toLocaleString()} characters · marked done`
      })
    } catch (error) {
      toast({
        title: 'Paste failed',
        description: error instanceof Error ? error.message : 'Could not read the clipboard',
        variant: 'destructive'
      })
    } finally {
      setPastingMetadata(false)
    }
  }, [chapterId, activeImage, data, storedJsonByFile, parsedByFile, toast])

  /**
   * Pastes the clipboard as THIS image's crop JSON.
   *
   * Coordinates are taken as-is: they are normalized against this image and
   * stay that way — there is no stitched canvas in 3.0 and nothing is remapped.
   * The verification pass is a syntax/shape check on this one artifact, and the
   * store call is scoped to this image's own file, so a paste can only ever
   * change this row's status.
   */
  const pasteJsonFromClipboard = useCallback(async () => {
    if (!chapterId || !activeImage) return
    const filename = activeImage.filename
    setPastingJson(true)
    try {
      const content = await navigator.clipboard.readText()
      if (!content.trim()) {
        toast({ title: 'Clipboard is empty', variant: 'destructive' })
        return
      }

      setStoredJsonByFile(prev => ({ ...prev, [filename]: content }))

      // Verification: shape of this one image's artifact. No manifest is passed,
      // because passing one is what would trigger stitched-canvas remapping.
      const parsed = parseCropJson(content, undefined, filename)
      setParsedByFile(prev => ({ ...prev, [filename]: parsed }))

      const errorCount = parsed.reduce((n, item) => n + item.validation.errors.length, 0)
      const warningCount = parsed.reduce((n, item) => n + item.validation.warnings.length, 0)

      if (parsed.length === 0 || errorCount > 0) {
        toast({
          title: 'Verification failed',
          description: `${errorCount} error${errorCount === 1 ? '' : 's'} — see preview for details`,
          variant: 'destructive'
        })
        return
      }

      const stored = await clipper3Api.putImagePoints(chapterId, filename, content)
      setStoredJsonByFile(prev => ({ ...prev, [filename]: stored.content }))

      // Only this image's row changes — the server answers per image.
      setData(prev => prev && {
        ...prev,
        images: prev.images.map(img =>
          img.filename === filename
            ? {
                ...img,
                hasPoints: true,
                hasMetadata: stored.hasMetadata,
                cropCount: stored.cropCount,
                status: stored.status
              }
            : img
        )
      })

      // The row only turns Done when the metadata document is there too, so the
      // toast says which half is still missing rather than claiming completion.
      toast({
        title: 'Crop JSON verified',
        description:
          `${filename} · ${stored.cropCount} crop${stored.cropCount === 1 ? '' : 's'}` +
          `${warningCount > 0 ? ` · ${warningCount} warning${warningCount === 1 ? '' : 's'}` : ''}` +
          `${stored.status === 'done' ? ' · marked done' : ' — still needs metadata'}`
      })
    } catch (error) {
      toast({
        title: 'Paste failed',
        description: error instanceof Error ? error.message : 'Could not read the clipboard',
        variant: 'destructive'
      })
    } finally {
      setPastingJson(false)
    }
  }, [chapterId, activeImage, toast])

  /** Drops this image's artifact, returning just this row to Pending. */
  const clearImagePoints = useCallback(async () => {
    if (!chapterId || !activeImage) return
    const filename = activeImage.filename
    if (!window.confirm(`Remove the crop JSON for ${filename}? This row goes back to Pending.`)) return

    try {
      await clipper3Api.deleteImagePoints(chapterId, filename)
      setStoredJsonByFile(prev => {
        const next = { ...prev }
        delete next[filename]
        return next
      })
      setParsedByFile(prev => {
        const next = { ...prev }
        delete next[filename]
        return next
      })
      setData(prev => prev && {
        ...prev,
        images: prev.images.map(img =>
          img.filename === filename
            ? { ...img, hasPoints: false, cropCount: 0, status: 'pending' as const }
            : img
        )
      })
      toast({ title: 'Crop JSON removed', description: filename })
    } catch (error) {
      toast({
        title: 'Could not remove',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive'
      })
    }
  }, [chapterId, activeImage, toast])

  /** Drops this image's metadata, returning just this row to Pending. */
  const clearImageMetadata = useCallback(async () => {
    if (!chapterId || !activeImage) return
    const filename = activeImage.filename
    if (!window.confirm(`Remove the metadata for ${filename}? This row goes back to Pending.`)) return

    try {
      await clipper3Api.deleteImageMetadata(chapterId, filename)
      setStoredMetadataByFile(prev => {
        const next = { ...prev }
        delete next[filename]
        return next
      })
      setData(prev => prev && {
        ...prev,
        images: prev.images.map(img =>
          img.filename === filename
            ? { ...img, hasMetadata: false, status: 'pending' as const }
            : img
        )
      })
      toast({ title: 'Metadata removed', description: filename })
    } catch (error) {
      toast({
        title: 'Could not remove',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive'
      })
    }
  }, [chapterId, activeImage, toast])

  /** Cuts every Done image using its own page-local coordinates. */
  const startCropSections = useCallback(async () => {
    if (!chapterId) return
    setIsCropping(true)
    // The previous run's report describes a crops3/ that is about to be
    // rewritten, so it must not outlive the cut that produced it.
    setUnresolvedPages([])
    try {
      await clipper3Api.crop(chapterId)
    } catch (error) {
      setIsCropping(false)
      toast({
        title: 'Could not start cropping',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive'
      })
    }
  }, [chapterId, toast])

  const goToPrevious = useCallback(() => {
    setPreviewOpen(false)
    setMetadataPreviewOpen(false)
    setActiveIndex(i => (i == null || i <= 0 ? i : i - 1))
  }, [])

  const goToNext = useCallback(() => {
    setPreviewOpen(false)
    setMetadataPreviewOpen(false)
    setActiveIndex(i => (i == null || i >= images.length - 1 ? i : i + 1))
  }, [images.length])

  // ============ Render ============

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!data || loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <AlertTriangle className="h-8 w-8 text-amber-500" />
        <p>{loadError || 'Failed to load this chapter'}</p>
        <Button variant="outline" size="sm" onClick={() => navigate('/clipper3')}>
          Back to Image Clipper 3.0
        </Button>
      </div>
    )
  }

  const chapterLabel = `Chapter ${data.number}${data.title ? ` · ${data.title}` : ''}`

  return (
    <div className="flex flex-col h-full">
      <div className="border-b bg-card px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/clipper3/series/${data.seriesId}`)}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <span className="text-sm font-medium truncate">{chapterLabel}</span>
        <span className="text-xs text-muted-foreground flex items-center gap-1 ml-2">
          <Images className="h-3.5 w-3.5" />
          {images.length} file{images.length === 1 ? '' : 's'}
        </span>
        <span className="text-xs text-muted-foreground ml-auto">
          {doneCount}/{images.length} done
        </span>

        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`/clipper3/chapter/${chapterId}/preview`)}
          disabled={doneCount === 0}
          title={doneCount === 0 ? 'No image has crop pointers yet' : 'See every image with its own pointers'}
        >
          <ScanEye className="h-4 w-4 mr-1" />
          Preview
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={startCropSections}
          disabled={isCropping || doneCount === 0}
          title={doneCount === 0 ? 'No image has crop pointers yet' : 'Cut every Done image into its sections'}
        >
          {isCropping ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Scissors className="h-4 w-4 mr-1" />
          )}
          Crop Sections
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={() => setAutoDialogOpen(true)}
          disabled={autoRun.running}
          title={autoRun.running ? 'An API run is going for this chapter' : 'Run the ChatGPT crop flow through the OpenAI API'}
        >
          {autoRun.running ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Bot className="h-4 w-4 mr-1" />
          )}
          ChatGPT API
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open('https://chatgpt.com', '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink className="h-4 w-4 mr-1" />
          ChatGPT
        </Button>

        <Button variant="outline" size="sm" onClick={() => setMurgaaOpen(true)}>
          <Bird className="h-4 w-4 mr-1" />
          Murgaa
        </Button>
      </div>

      {/* The Sleeper-Cell phone's progress on this chapter, re-read only when
          asked. Tapping the Processing chip scrolls to the page it is on. */}
      {phoneCrops?.configured && (
        <div className="border-b bg-card px-4 py-2 flex flex-wrap items-center gap-3 flex-shrink-0">
          <PhoneRefreshButton receipt={phoneCropsReceipt} />
          {phoneChapter && (
            <span
              className="text-xs text-muted-foreground"
              title={phoneCrops.device ? `Sleeper-Cell on ${phoneCrops.device}` : 'Sleeper-Cell'}
            >
              {phoneChapter.done}/{phoneChapter.total} pages done on phone
            </span>
          )}
          {phoneWorking && (
            <button
              type="button"
              className="min-w-0"
              onClick={() => rowRefs.current.get(phoneWorking.page)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
            >
              <PhoneWorkingBadge page={phoneWorking.page} paused={phoneWorking.paused} device={phoneCrops.device} />
            </button>
          )}
        </div>
      )}

      <MurgaaDialog scope="clipper3" open={murgaaOpen} onOpenChange={setMurgaaOpen} />

      <AutoRunDialog
        open={autoDialogOpen}
        onOpenChange={setAutoDialogOpen}
        images={images}
        onStart={autoRun.start}
      />

      {autoRun.job && autoRun.visible && (
        <AutoRunStrip
          job={autoRun.job}
          onCancel={() => { autoRun.cancel().catch(() => { /* the next poll shows the state */ }) }}
          onDismiss={autoRun.dismiss}
        />
      )}

      {cropProgress && (
        <div className="border-b bg-card px-4 py-2 flex items-center gap-3 flex-shrink-0">
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            Cutting {cropProgress.current}/{cropProgress.total}
          </span>
          <Progress
            value={cropProgress.total > 0 ? (cropProgress.current / cropProgress.total) * 100 : 0}
            className="flex-1 h-2"
          />
          <span className="text-xs text-muted-foreground font-mono truncate max-w-[200px]">
            {cropProgress.filename}
          </span>
        </div>
      )}

      {unresolvedPages.length > 0 && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 flex-shrink-0">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-destructive">
                {unresolvedNameCount} metadata name{unresolvedNameCount === 1 ? '' : 's'} on{' '}
                {unresolvedPages.length} page{unresolvedPages.length === 1 ? '' : 's'} match no file in
                crops3/
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Re-paste the metadata for {unresolvedPages.length === 1 ? 'this page' : 'these pages'} — the
                names are rebuilt from the crop JSON on save. Left as they are, Editor 2.0 cannot resolve
                them.
              </p>
              <ul className="mt-1 space-y-0.5">
                {unresolvedPages.map(page => (
                  <li key={page.imageFilename} className="text-[11px] font-mono text-muted-foreground">
                    <span className="text-foreground">{page.imageFilename}</span>{' '}
                    <span className="text-destructive">
                      {page.missing.length}/{page.total}
                    </span>
                    {/* First one only: the whole list overflows the banner, and
                        one example is enough to recognise which cut is stale. */}
                    <span className="ml-1 truncate">— {page.missing[0]}</span>
                    {page.missing.length > 1 && <span> +{page.missing.length - 1} more</span>}
                  </li>
                ))}
              </ul>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] flex-shrink-0"
              onClick={() => setUnresolvedPages([])}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-2">
          {images.map((img, index) => {
            const isDone = img.status === 'done'
            const autoPage = autoRun.visible ? autoRun.pageStatus(img.filename) : null
            const phonePage = phoneCrops?.pages[img.filename]
            const phoneOnThis = phoneWorking?.page === img.filename
            return (
              <Card
                key={img.filename}
                ref={el => {
                  if (el) rowRefs.current.set(img.filename, el)
                  else rowRefs.current.delete(img.filename)
                }}
                className={`cursor-pointer hover:border-primary transition-colors ${
                  phoneOnThis ? 'border-sky-500 ring-2 ring-sky-500/40' : ''
                }`}
                onClick={() => setActiveIndex(index)}
              >
                <CardContent className="p-3 flex items-center gap-3">
                  {/* The phone's Auto-run points at the page it is on. */}
                  <span className="text-xs text-muted-foreground w-8 flex-shrink-0 flex items-center justify-end">
                    {phoneOnThis ? (
                      <ChevronRight
                        className={`h-5 w-5 text-sky-500 ${phoneWorking?.paused ? '' : 'animate-pulse'}`}
                        aria-label="The phone is on this page"
                      />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <img
                    src={clipper3Api.getImageUrl(chapterId!, img.filename)}
                    alt={img.filename}
                    loading="lazy"
                    draggable={false}
                    className="h-14 w-14 object-cover rounded border flex-shrink-0 bg-muted"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-mono truncate">{img.filename}</p>
                    <p className="text-xs text-muted-foreground truncate" title={img.metadataErrors.join(' ') || undefined}>
                      {img.width} × {img.height}px
                      {img.cropCount > 0 && ` · ${img.cropCount} crop${img.cropCount === 1 ? '' : 's'}`}
                      {/* A half-finished row says which piece it is still waiting on.
                          Invalid metadata shows the ACTUAL reason from the server
                          (e.g. which crop ids don't match) rather than a generic
                          "something's wrong" — that's the whole point of surfacing it. */}
                      {!isDone && img.hasPoints && !img.hasMetadata && ' · needs metadata'}
                      {!isDone && !img.hasPoints && img.hasMetadata && ' · needs crop JSON'}
                      {!isDone && img.hasPoints && img.hasMetadata && !img.metadataValid && (
                        img.metadataErrors.length > 0
                          ? ` · ${img.metadataErrors.join(' ')}`
                          : ' · metadata no longer matches these crops'
                      )}
                    </p>
                  </div>
                  {phoneOnThis && phoneWorking ? (
                    <PhoneWorkingBadge page={img.filename} paused={phoneWorking.paused} device={phoneCrops?.device ?? null} showPage={false} />
                  ) : phonePage && (
                    <PhonePageBadge state={phonePage} device={phoneCrops?.device ?? null} />
                  )}
                  {autoPage && autoPage.step !== 'queued' && <AutoRunBadge page={autoPage} />}
                  {isDone ? (
                    <Badge variant="success" className="flex items-center gap-1 flex-shrink-0">
                      <CheckCircle2 className="h-3 w-3" />
                      Done
                    </Badge>
                  ) : img.hasMetadata && !img.metadataValid ? (
                    <Badge
                      variant="destructive"
                      className="flex items-center gap-1 flex-shrink-0"
                      title={img.metadataErrors.join(' ') || 'Metadata no longer matches these crops'}
                    >
                      <AlertTriangle className="h-3 w-3" />
                      Invalid metadata
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="flex items-center gap-1 text-muted-foreground flex-shrink-0">
                      <Clock className="h-3 w-3" />
                      Pending
                    </Badge>
                  )}

                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7 flex-shrink-0"
                    title={img.cropCount > 0 ? "Preview this image's crop pointers" : 'No crop pointers to preview yet'}
                    disabled={img.cropCount === 0}
                    onClick={e => { e.stopPropagation(); setPreviewIndex(index) }}
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </ScrollArea>

      <Dialog open={activeIndex != null} onOpenChange={open => { if (!open) setActiveIndex(null) }}>
        <DialogContent className="sm:max-w-md">
          {activeImage && (
            <>
              <DialogHeader>
                <DialogTitle className="font-mono text-sm truncate">{activeImage.filename}</DialogTitle>
              </DialogHeader>

              <img
                src={clipper3Api.getImageUrl(chapterId!, activeImage.filename)}
                alt={activeImage.filename}
                draggable={false}
                className="w-full max-h-64 object-contain rounded border bg-muted"
              />

              <div className="grid grid-cols-1 gap-2">
                <Button variant="outline" onClick={copyImageToClipboard} disabled={copyingImage}>
                  {copyingImage ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <ImageIcon className="h-4 w-4 mr-2" />
                  )}
                  Copy image to clipboard
                </Button>

                {/* Tall pages get downscaled to mush when pasted whole, so the
                    page is cut into parts on disk first. Copying the whole set
                    happens in the file explorer, not here: the clipboard holds
                    one decoded image but any number of file references. */}
                <Collapsible open={slicesOpen} onOpenChange={setSlicesOpen}>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={sliceActiveImage}
                      disabled={slicing}
                    >
                      {slicing ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Rows3 className="h-4 w-4 mr-2" />
                      )}
                      {sliceResult
                        ? `Re-slice image (${sliceResult.files.length})`
                        : 'Slice image into parts'}
                    </Button>
                    {sliceResult && (
                      <CollapsibleTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          title={slicesOpen ? 'Hide slices' : 'Show slices'}
                        >
                          <ChevronDown
                            className={`h-4 w-4 transition-transform ${slicesOpen ? 'rotate-180' : ''}`}
                          />
                        </Button>
                      </CollapsibleTrigger>
                    )}
                  </div>

                  <CollapsibleContent className="pt-2 pl-3 border-l ml-1">
                    {sliceResult && sliceResult.files.length > 0 && (
                      <p className="text-xs text-muted-foreground mb-2">
                        {sliceResult.sourceWidth} × {sliceResult.sourceHeight} px →{' '}
                        {sliceResult.files.length}{' '}
                        {sliceResult.files.length === 1 ? 'part' : 'parts'} of{' '}
                        {sliceResult.files[0].width} × {sliceResult.files[0].height}
                        {sliceResult.files.length > 1 &&
                          sliceResult.files[sliceResult.files.length - 1].height !==
                            sliceResult.files[0].height &&
                          ` (last ${sliceResult.files[sliceResult.files.length - 1].height} px)`}
                        .
                      </p>
                    )}

                    {/* The real "copy all": the OS can put many FILES on the
                        clipboard at once, which a web page cannot do. */}
                    <Button
                      variant="secondary"
                      className="w-full"
                      onClick={openSliceFolder}
                      disabled={openingFolder}
                    >
                      {openingFolder ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <FolderOpen className="h-4 w-4 mr-2" />
                      )}
                      Open folder — select all &amp; copy
                    </Button>
                    <p className="text-xs text-muted-foreground mt-1 mb-2">
                      In the folder: ⌘A to select all, then ⌘C. That puts every part on the
                      clipboard together.
                    </p>

                    <div className="grid grid-cols-1 gap-2 max-h-56 overflow-y-auto pr-1">
                      {sliceResult?.files.map(slice => (
                        <Button
                          key={slice.index}
                          variant="outline"
                          className="justify-start h-auto py-2"
                          onClick={() => copySliceToClipboard(slice)}
                        >
                          <img
                            src={clipper3Api.getSliceUrl(
                              chapterId!,
                              activeImage.filename,
                              slice.filename
                            )}
                            alt={`Part ${slice.index}`}
                            loading="lazy"
                            draggable={false}
                            className="h-10 w-10 object-cover rounded border mr-3 flex-shrink-0"
                          />
                          <span className="flex-1 text-left min-w-0">
                            <span className="block text-sm">Part {slice.index}</span>
                            <span className="block text-xs text-muted-foreground font-mono truncate">
                              {slice.width} × {slice.height}
                            </span>
                          </span>
                          {copiedSlice === slice.index ? (
                            <Check className="h-4 w-4 ml-2 flex-shrink-0 text-green-500" />
                          ) : (
                            <ClipboardCopy className="h-4 w-4 ml-2 flex-shrink-0 opacity-50" />
                          )}
                        </Button>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                {/* The whole ChatGPT loop for just this page, through the API. */}
                {(() => {
                  const autoPage = autoRun.pageStatus(activeImage.filename)
                  const busy = !!autoPage && isActiveStep(autoPage.step)
                  return (
                    <div className="space-y-1">
                      <Button
                        className="w-full"
                        onClick={() => {
                          autoRun.start([activeImage.filename], true).catch(err => toast({
                            title: 'Could not start',
                            description: err instanceof Error ? err.message : 'Unknown error',
                            variant: 'destructive'
                          }))
                        }}
                        disabled={autoRun.running}
                        title={autoRun.running ? 'An API run is going for this chapter' : 'Package → ChatGPT → review → export, via the OpenAI API'}
                      >
                        {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Bot className="h-4 w-4 mr-2" />}
                        {busy ? autoPage!.message : 'Run this page via ChatGPT API'}
                      </Button>
                      {autoPage && !busy && autoPage.step !== 'queued' && (
                        <p
                          className={`text-xs ${autoPage.step === 'failed' ? 'text-destructive' : autoPage.step === 'needs_review' ? 'text-amber-500' : 'text-muted-foreground'}`}
                          title={autoPage.blockers.join('\n') || undefined}
                        >
                          API: {autoPage.message}
                        </p>
                      )}
                    </div>
                  )
                })()}

                {/* The verified package: same slices, plus a prompt that pins
                    the page's job id and hash for the later import. */}
                <div className="space-y-1">
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={buildHandoffForActive}
                      disabled={buildingHandoff}
                    >
                      {buildingHandoff ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <PackageCheck className="h-4 w-4 mr-2" />
                      )}
                      {handoff && handoff.status !== 'none'
                        ? 'Rebuild ChatGPT package'
                        : 'Build ChatGPT package'}
                    </Button>
                    {handoff?.status === 'ready' && handoff.prompt && (
                      <Button
                        variant="outline"
                        size="icon"
                        title="Copy the package prompt"
                        onClick={copyHandoffPrompt}
                      >
                        {copiedHandoffPrompt ? (
                          <Check className="h-4 w-4 text-green-500" />
                        ) : (
                          <ClipboardCopy className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                  </div>
                  {handoff?.status === 'ready' && handoff.manifest && (
                    <p
                      className="text-xs text-muted-foreground font-mono truncate"
                      title={handoff.manifest.job_id}
                    >
                      <CheckCircle2 className="inline h-3 w-3 mr-1 text-green-500" />
                      {handoff.manifest.slices.length} slices verified · {handoff.manifest.job_id}
                    </p>
                  )}
                  {handoff?.status === 'stale' && (
                    <p className="text-xs text-amber-500">
                      <AlertTriangle className="inline h-3 w-3 mr-1" />
                      Package out of date — {handoff.staleReasons.map(r => r.message).join('; ')}.
                      Rebuild before sending it to ChatGPT.
                    </p>
                  )}

                  {handoff && handoff.status !== 'none' && (
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={pasteChatGptReply}
                      disabled={importingReply}
                    >
                      {importingReply ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <ClipboardPaste className="h-4 w-4 mr-2" />
                      )}
                      {analysis?.analysis ? 'Paste a new ChatGPT reply' : 'Paste ChatGPT reply'}
                    </Button>
                  )}

                  {importErrors && importErrors.length > 0 && (
                    <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs space-y-1 max-h-44 overflow-y-auto">
                      <p className="font-medium text-destructive">
                        Reply rejected — nothing was imported
                        {analysis?.analysis ? '; the previous import is kept' : ''}.
                      </p>
                      {importErrors.slice(0, 12).map((issue, i) => (
                        <p key={i}>
                          {issue.field && !issue.message.startsWith(issue.field) && (
                            <span className="font-mono text-muted-foreground mr-1">{issue.field}</span>
                          )}
                          {issue.message}
                        </p>
                      ))}
                      {importErrors.length > 12 && (
                        <p className="text-muted-foreground">…and {importErrors.length - 12} more</p>
                      )}
                    </div>
                  )}

                  {analysis?.analysis && (
                    <div className="flex items-center gap-2">
                      <p className={`text-xs flex-1 min-w-0 ${analysis.stale ? 'text-amber-500' : 'text-muted-foreground'}`}>
                        {analysis.stale ? (
                          <>
                            <AlertTriangle className="inline h-3 w-3 mr-1" />
                            Imported reply is out of date — {analysis.staleReasons.join('; ')}.
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="inline h-3 w-3 mr-1 text-green-500" />
                            {analysis.analysis.candidates.length} candidates imported
                            {(() => {
                              const flagged = analysis.analysis.candidates.filter(
                                c => c.review_flags.length > 0 || c.unknown_flags.length > 0
                              ).length
                              return flagged > 0 ? ` · ${flagged} flagged` : ''
                            })()}
                            {analysis.analysis.warnings.length > 0 &&
                              ` · ${analysis.analysis.warnings.length} warning${analysis.analysis.warnings.length === 1 ? '' : 's'}`}
                          </>
                        )}
                      </p>
                      <Button variant="ghost" size="sm" onClick={() => setCandidatesOpen(true)}>
                        <Eye className="h-4 w-4 mr-1" />
                        View on page
                      </Button>
                    </div>
                  )}

                  {/* Review: open it when one exists; otherwise start one from
                      the import, or from the page's existing crops. */}
                  {review?.state ? (
                    <div className="flex items-center gap-2">
                      <p className={`text-xs flex-1 min-w-0 ${review.readiness.ready ? 'text-green-500' : review.stale ? 'text-amber-500' : 'text-muted-foreground'}`}>
                        {review.readiness.ready ? (
                          <><CheckCircle2 className="inline h-3 w-3 mr-1" />Review complete</>
                        ) : review.stale ? (
                          <><AlertTriangle className="inline h-3 w-3 mr-1" />Review out of date</>
                        ) : (
                          <>Review in progress · {review.readiness.blockers.length} left before export</>
                        )}
                      </p>
                      <Button variant="outline" size="sm" onClick={() => setReviewOpen(true)}>
                        <ScanEye className="h-4 w-4 mr-1" />
                        Open review
                      </Button>
                    </div>
                  ) : null}

                  {/* ChatGPT does the review round: prompt out, JSON back. */}
                  {review?.state && !review.stale && handoff?.status === 'ready' && (
                    <div className="flex gap-2">
                      <Button variant="outline" className="flex-1 min-w-0 px-2" onClick={copyReviewPrompt} disabled={copyingReviewPrompt}>
                        {copyingReviewPrompt ? <Loader2 className="h-4 w-4 mr-1.5 flex-shrink-0 animate-spin" /> : <ClipboardCopy className="h-4 w-4 mr-1.5 flex-shrink-0" />}
                        <span className="truncate">Copy review prompt</span>
                      </Button>
                      <Button variant="outline" className="flex-1 min-w-0 px-2" onClick={pasteChatGptReview} disabled={applyingReview}>
                        {applyingReview ? <Loader2 className="h-4 w-4 mr-1.5 flex-shrink-0 animate-spin" /> : <ClipboardPaste className="h-4 w-4 mr-1.5 flex-shrink-0" />}
                        <span className="truncate">Paste ChatGPT review</span>
                      </Button>
                    </div>
                  )}
                  {reviewReplyErrors && reviewReplyErrors.length > 0 && (
                    <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs space-y-1 max-h-44 overflow-y-auto">
                      <p className="font-medium text-destructive">Review reply rejected — nothing was changed.</p>
                      {reviewReplyErrors.slice(0, 12).map((issue, i) => (
                        <p key={i}>
                          {issue.field && !issue.message.startsWith(issue.field) && (
                            <span className="font-mono text-muted-foreground mr-1">{issue.field}</span>
                          )}
                          {issue.message}
                        </p>
                      ))}
                    </div>
                  )}
                  {review?.state && review.readiness.ready && (
                    <div className="flex items-center gap-2">
                      <Button className="flex-1" onClick={exportFromPopup} disabled={exportingPage}>
                        {exportingPage ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <PackageCheck className="h-4 w-4 mr-2" />}
                        Export page
                      </Button>
                      {lastExport && lastExport.revision === review.state.review_revision && (
                        <span className="text-xs text-green-500">
                          <CheckCircle2 className="inline h-3 w-3 mr-1" />{lastExport.crops} exported
                        </span>
                      )}
                    </div>
                  )}

                  {review?.state ? null : (
                    <div className="flex gap-2">
                      {analysis?.analysis && !analysis.stale && (
                        <Button
                          variant="outline"
                          className="flex-1"
                          onClick={() => startReviewFor('import')}
                          disabled={startingReview}
                        >
                          {startingReview ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ScanEye className="h-4 w-4 mr-2" />}
                          Start review
                        </Button>
                      )}
                      {activeImage.hasPoints && !(analysis?.analysis && !analysis.stale) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="flex-1 text-xs"
                          onClick={() => startReviewFor('pointers')}
                          disabled={startingReview}
                          title="Review this page's existing crop pointers with the same checks"
                        >
                          <ScanEye className="h-3 w-3 mr-1" />
                          Review existing crops
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                {/* One button copies all four in paste order; the arrow opens
                    the same four individually, for re-copying just one. */}
                <Collapsible open={promptsOpen} onOpenChange={setPromptsOpen}>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={copyAllPromptsToClipboard}
                      disabled={copyingAll}
                    >
                      {copyingAll ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <ClipboardCopy className="h-4 w-4 mr-2" />
                      )}
                      Copy all prompts
                    </Button>
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        title={promptsOpen ? 'Hide individual prompts' : 'Copy prompts individually'}
                      >
                        <ChevronDown
                          className={`h-4 w-4 transition-transform ${promptsOpen ? 'rotate-180' : ''}`}
                        />
                      </Button>
                    </CollapsibleTrigger>
                  </div>

                  <CollapsibleContent className="grid grid-cols-1 gap-2 pt-2 pl-3 border-l ml-1">
                    <Button variant="outline" onClick={copyPromptToClipboard} disabled={copyingPrompt}>
                      {copyingPrompt ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <FileText className="h-4 w-4 mr-2" />
                      )}
                      Copy prompt (MD) to clipboard
                    </Button>

                    <Button variant="outline" onClick={copyActionPromptToClipboard} disabled={copyingActionPrompt}>
                      {copyingActionPrompt ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Zap className="h-4 w-4 mr-2" />
                      )}
                      Copy action prompt
                    </Button>

                    {/* Copied BEFORE the template: the static template alone
                        leaves series_slug and image_stem unknown, which is what
                        the AI fills in with placeholders. */}
                    <Button variant="outline" onClick={copyExportContextToClipboard} disabled={copyingContext}>
                      {copyingContext ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Tags className="h-4 w-4 mr-2" />
                      )}
                      Copy export context
                    </Button>

                    <Button variant="outline" onClick={copyMetadataTemplateToClipboard} disabled={copyingMetadata}>
                      {copyingMetadata ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <FileCode className="h-4 w-4 mr-2" />
                      )}
                      Copy metadata document
                    </Button>
                  </CollapsibleContent>
                </Collapsible>

                {/* Each tick reflects its OWN artifact, not the row's overall
                    status — the row is Done only when both are present. */}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={pasteJsonFromClipboard}
                    disabled={pastingJson}
                  >
                    {pastingJson ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : activeImage.hasPoints ? (
                      <CheckCircle2 className="h-4 w-4 mr-2 text-green-500" />
                    ) : (
                      <ClipboardPaste className="h-4 w-4 mr-2" />
                    )}
                    {activeImage.hasPoints ? 'JSON attached' : 'Paste JSON file'}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    title="Preview this image's JSON"
                    onClick={() => setPreviewOpen(true)}
                    disabled={storedJsonByFile[activeImage.filename] === undefined}
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    title="Remove this image's crop JSON"
                    onClick={clearImagePoints}
                    disabled={!activeImage.hasPoints}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={pasteMetadataFromClipboard}
                    disabled={pastingMetadata}
                    title={
                      activeImage.hasMetadata && !activeImage.metadataValid
                        ? activeImage.metadataErrors.join(' ')
                        : undefined
                    }
                  >
                    {pastingMetadata ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : activeImage.hasMetadata && activeImage.metadataValid ? (
                      <CheckCircle2 className="h-4 w-4 mr-2 text-green-500" />
                    ) : activeImage.hasMetadata ? (
                      <AlertTriangle className="h-4 w-4 mr-2 text-destructive" />
                    ) : (
                      <ClipboardPaste className="h-4 w-4 mr-2" />
                    )}
                    {activeImage.hasMetadata && activeImage.metadataValid
                      ? 'Metadata attached'
                      : activeImage.hasMetadata
                        ? 'Metadata invalid — re-paste'
                        : 'Paste metadata'}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    title="Preview this image's metadata"
                    onClick={() => setMetadataPreviewOpen(true)}
                    disabled={storedMetadataByFile[activeImage.filename] === undefined}
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    title="Remove this image's metadata"
                    onClick={clearImageMetadata}
                    disabled={!activeImage.hasMetadata}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                {activeImage.hasMetadata && !activeImage.metadataValid && activeImage.metadataErrors.length > 0 && (
                  <div className="flex items-start gap-1.5 text-xs text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                    <p>{activeImage.metadataErrors.join(' ')}</p>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between pt-2">
                <Button variant="ghost" size="sm" onClick={goToPrevious} disabled={activeIndex === 0}>
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">
                  {(activeIndex ?? 0) + 1} / {images.length}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={goToNext}
                  disabled={activeIndex === images.length - 1}
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm truncate">
              {activeImage ? `Crop JSON — ${activeImage.filename}` : 'Crop JSON'}
            </DialogTitle>
          </DialogHeader>

          <Textarea
            value={activeImage ? storedJsonByFile[activeImage.filename] ?? '' : ''}
            readOnly
            rows={14}
            className="font-mono text-xs bg-muted/40"
          />

          {activeImage && (parsedByFile[activeImage.filename]?.length ?? 0) > 0 && (
            <div className="space-y-2 max-h-40 overflow-auto">
              {parsedByFile[activeImage.filename].map((item, i) => (
                <div key={i} className="rounded border p-2 space-y-1">
                  <div className="flex items-center gap-2 text-xs font-medium">
                    {item.validation.isValid ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
                    ) : (
                      <AlertTriangle className="h-3.5 w-3.5 text-destructive flex-shrink-0" />
                    )}
                    {item.name}
                    <Badge variant="outline" className="text-[10px] ml-auto">{item.mode}</Badge>
                  </div>
                  {item.validation.errors.map((e, j) => (
                    <p key={`e-${j}`} className="text-[11px] text-destructive pl-5">{e}</p>
                  ))}
                  {item.validation.warnings.map((w, j) => (
                    <p key={`w-${j}`} className="text-[11px] text-amber-600 pl-5">{w}</p>
                  ))}
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={metadataPreviewOpen} onOpenChange={setMetadataPreviewOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm truncate">
              {activeImage ? `Metadata — ${activeImage.filename}` : 'Metadata'}
            </DialogTitle>
          </DialogHeader>

          {/* Free-form: stored and shown verbatim, never parsed. */}
          <Textarea
            value={activeImage ? storedMetadataByFile[activeImage.filename] ?? '' : ''}
            readOnly
            rows={16}
            className="font-mono text-xs bg-muted/40"
          />
        </DialogContent>
      </Dialog>

      {/* One image's crop pointers, drawn and drag-adjustable — a quick visual
          check (or fix) without leaving the list, separate from the row
          dialog's paste/copy workflow above. */}
      <Dialog open={previewIndex != null} onOpenChange={open => { if (!open) setPreviewIndex(null) }}>
        <DialogContent className="w-[95vw] max-w-6xl h-[92vh] flex flex-col p-4 sm:p-6">
          {previewImage && (
            <>
              <DialogHeader className="flex-shrink-0">
                <DialogTitle className="font-mono text-sm truncate">{previewImage.filename}</DialogTitle>
              </DialogHeader>

              {/* Zoom is driven by WIDTH only, deliberately never clamped to
                  the dialog's height: source pages here run extremely tall
                  (800x10480 is typical), and fitting height as well would
                  crush the width down with it — the crop boxes becoming a
                  sliver too thin to read. Vertical overflow is exactly what
                  this container's own scrollbar is for. */}
              <div className="flex-1 min-h-0 overflow-auto">
                <CropPointerEditor
                  chapterId={chapterId!}
                  filename={previewImage.filename}
                  width={previewImage.width}
                  height={previewImage.height}
                  zoom={Math.min(1, (window.innerWidth * 0.95 - 64) / previewImage.width)}
                  seriesTitle={data.seriesTitle}
                  onSaved={stored => {
                    setData(prev => prev && {
                      ...prev,
                      images: prev.images.map(i =>
                        i.filename === previewImage.filename
                          ? { ...i, cropCount: stored.cropCount, status: stored.status, hasPoints: true }
                          : i
                      )
                    })
                  }}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* The page's review: decisions, flags and descriptions over its crops. */}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="w-[95vw] max-w-6xl h-[92vh] flex flex-col p-4 sm:p-6">
          {activeImage && review?.state && (
            <>
              <DialogHeader className="flex-shrink-0">
                <DialogTitle className="font-mono text-sm truncate">
                  {activeImage.filename} — review
                </DialogTitle>
              </DialogHeader>
              <div className="flex-1 min-h-0">
                <ReviewWorkspace
                  chapterId={chapterId!}
                  filename={activeImage.filename}
                  view={review as Clipper3ReviewView & { state: NonNullable<Clipper3ReviewView['state']> }}
                  onView={setReview}
                  onRestart={from => startReviewFor(from, true)}
                  pageWidth={Math.min(560, Math.round(window.innerWidth * 0.45))}
                  onExported={() => {
                    // The export rewrote this page's store entry: refresh its Done status.
                    clipper3Api.getImages(chapterId!).then(setData).catch(() => {})
                  }}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ChatGPT's imported candidates on the original page, read-only. */}
      <Dialog open={candidatesOpen} onOpenChange={setCandidatesOpen}>
        <DialogContent className="w-[95vw] max-w-6xl h-[92vh] flex flex-col p-4 sm:p-6">
          {activeImage && analysis?.analysis && (
            <>
              <DialogHeader className="flex-shrink-0">
                <DialogTitle className="font-mono text-sm truncate">
                  {activeImage.filename} — ChatGPT candidates
                </DialogTitle>
              </DialogHeader>
              <div className="flex-1 min-h-0">
                <CandidateOverlay
                  chapterId={chapterId!}
                  filename={activeImage.filename}
                  analysis={analysis.analysis}
                  pageWidth={Math.min(560, Math.round(window.innerWidth * 0.45))}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
