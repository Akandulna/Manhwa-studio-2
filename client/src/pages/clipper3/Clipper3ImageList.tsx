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
import { useSocket } from '@/lib/socket'
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
  ExternalLink
} from 'lucide-react'
import {
  clipperApi,
  clipper3Api,
  type Clipper3ChapterImages,
  type Clipper3Image
} from '@/lib/api'
import { parseCropJson, type ParsedCropItem } from '@/lib/cropJsonValidator'
import { validateMetadataJson } from '@/lib/metadataValidator'
import { CropPointerEditor } from '@/components/clipper3/CropPointerEditor'
import { seriesSlug, stemOf, exportedFilenameFor } from '@/lib/clipper3Naming'

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
    toast({
      title: failed > 0 ? 'Cropped with failures' : 'Crop sections saved',
      description:
        `${event.exported ?? 0} section${event.exported === 1 ? '' : 's'} from ` +
        `${event.images ?? 0} image${event.images === 1 ? '' : 's'}` +
        `${failed > 0 ? `, ${failed} failed` : ''}.`,
      variant: failed > 0 ? 'destructive' : undefined
    })
  }, [clipper3CropComplete, chapterId, toast])

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
      const response = await fetch(clipperApi.getImageUrl(chapterId, activeImage.filename))
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

      const validation = validateMetadataJson(content, expectedIds, expectedFilenames)
      if (!validation.isValid) {
        toast({
          title: 'Metadata verification failed',
          description: validation.errors.join(' '),
          variant: 'destructive'
        })
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

      <MurgaaDialog scope="clipper3" open={murgaaOpen} onOpenChange={setMurgaaOpen} />

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

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-2">
          {images.map((img, index) => {
            const isDone = img.status === 'done'
            return (
              <Card
                key={img.filename}
                className="cursor-pointer hover:border-primary transition-colors"
                onClick={() => setActiveIndex(index)}
              >
                <CardContent className="p-3 flex items-center gap-3">
                  <span className="text-xs text-muted-foreground w-8 text-right flex-shrink-0">
                    {index + 1}
                  </span>
                  <img
                    src={clipperApi.getImageUrl(chapterId!, img.filename)}
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
                src={clipperApi.getImageUrl(chapterId!, activeImage.filename)}
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
    </div>
  )
}
