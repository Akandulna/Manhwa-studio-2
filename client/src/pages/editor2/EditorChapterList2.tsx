/**
 * EditorChapterList2 — Module 4v2: Editor 2.0
 *
 * A series' chapters, each with its four-item readiness checklist: voiceover
 * audio, alignment, timeline JSON and cropped images. The timeline JSON is
 * made here — Copy All → ChatGPT → Paste, or Send to phone / Fetch from phone
 * through R2 — and Check Images repairs its crop names. Preview and Export
 * stay disabled until all four items pass; Copy All and Paste never wait for
 * the JSON, since they are how it arrives.
 *
 * English and Hindi tabs: each chapter is edited and exported once per
 * narration language — its own script, voice, timeline paste and MP4 — over
 * the same crops.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  seriesApi,
  videoApi2,
  type CropRepairResult,
  type Editable2Chapter,
  type Editor2ChecklistItem,
  type Editor2ChecklistKey,
  type Export2Job,
  type Exported2Chapter
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import {
  ArrowLeft,
  Clapperboard,
  Loader2,
  AlertTriangle,
  Scissors,
  Mic,
  Clock,
  FileJson,
  CheckCircle2,
  XCircle,
  Copy,
  Check,
  ClipboardPaste,
  Play,
  Eye,
  X,
  Film,
  Ban,
  ChevronRight,
  Coffee,
  Moon,
  ImageOff,
  Wrench,
  FileCheck2,
  Smartphone,
  Download
} from 'lucide-react'

import { useWakeLock } from '@/hooks/useWakeLock'
import { usePublishedChapters } from '@/hooks/usePublishedChapters'
import { CompletedBadge, completedRowClass } from '@/components/PublishedBadge'
import { chapterList, phoneEditorApi, readSavedEditorPrompt as readSavedPrompt } from './phoneEditor'
import { LanguageTabs } from '@/components/LanguageTabs'
import { LANGUAGE_LABEL, useNarrationLanguage, withLang, type NarrationLanguage } from '@/lib/narrationLanguage'
import {
  clearTimeline,
  collectProcessed,
  getExpanded,
  getScrollTop,
  getTimelineJson,
  isProcessed,
  markProcessed,
  saveExpanded,
  saveScrollTop,
  setTimelineJson,
  syncChapterTimeline,
  syncSeriesTimelines
} from './timelineHandoff'

/** An export's size, for the Exported tooltip. */
function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** When an export was written, relative — "3h ago" reads faster than a date. */
function formatWhen(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(ms).toLocaleDateString()
}

/** The checklist, in order: its label, row icon and where a missing item is fixed. */
const CHECKLIST: {
  key: Editor2ChecklistKey
  label: string
  icon: typeof Mic
  fix: (chapter: { id: string; seriesId: string }, lang: NarrationLanguage) => { to: string; label: string } | null
}[] = [
  {
    key: 'audio',
    label: 'Voiceover audio',
    icon: Mic,
    fix: (ch, lang) => ({ to: withLang(`/narration/series/${ch.seriesId}`, lang), label: 'Open Narration' })
  },
  {
    key: 'alignment',
    label: 'Alignment',
    icon: Clock,
    fix: (ch, lang) => ({ to: withLang(`/narration/series/${ch.seriesId}`, lang), label: 'Open Narration' })
  },
  // Made on this screen, so there is nowhere else to send the user.
  { key: 'timeline', label: 'Timeline JSON', icon: FileJson, fix: () => null },
  {
    key: 'crops',
    label: 'Cropped images',
    icon: Scissors,
    fix: ch => ({ to: `/clipper3/chapter/${ch.id}`, label: 'Open Image Clipper' })
  }
]

/**
 * A chapter's checklist with the timeline item read from this browser.
 *
 * The server answered from its Editor2Timeline row, but a paste reaches that
 * row on a short debounce, and a Clear or a Paste here has to unlock or lock
 * Preview at once — so the local paste decides the timeline item.
 */
function liveChecklist(ch: Editable2Chapter, pastedJson: string): {
  checklist: Record<Editor2ChecklistKey, Editor2ChecklistItem>
  missing: string[]
  ready: boolean
} {
  const checklist = {
    ...ch.checklist,
    timeline: pastedJson.trim()
      ? { ok: true, detail: `Timeline JSON stored — ${pastedJson.length.toLocaleString()} characters` }
      : { ok: false, detail: 'No timeline JSON yet — Copy All → ChatGPT → Paste, or Fetch from phone' }
  }
  const missing = CHECKLIST.filter(item => !checklist[item.key].ok).map(item => item.label)
  return { checklist, missing, ready: missing.length === 0 }
}

/**
 * One checklist item, as a single icon.
 *
 * The list shows four of these per row, so they carry their meaning in the
 * tooltip rather than a visible label — a row has to stay one line tall.
 */
function ChecklistDot({ ok, icon: Icon, label, detail }: { ok: boolean; icon: typeof Mic; label: string; detail: string }) {
  return (
    <span
      className={ok ? 'text-green-600' : 'text-muted-foreground/30'}
      title={`${label}: ${ok ? '✓' : 'missing'} — ${detail}`}
    >
      <Icon className="h-3 w-3" />
    </span>
  )
}

export default function EditorChapterList2() {
  const { seriesId } = useParams<{ seriesId: string }>()
  // Chapters of a completed Part: files deleted on the Storage page, nothing to edit.
  const { completedPart } = usePublishedChapters(seriesId)
  const navigate = useNavigate()
  const { toast } = useToast()
  const [language, setLanguage] = useNarrationLanguage('editor2')

  const [seriesTitle, setSeriesTitle] = useState('')
  const [chapters, setChapters] = useState<Editable2Chapter[]>([])
  const [loading, setLoading] = useState(true)

  // Keyed by chapter id so each card's button tracks its own state and two
  // chapters' buttons never share a spinner.
  const [copying, setCopying] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // Pasted clipboard content per chapter. A chapter's entry exists only once
  // something has actually been pasted, which is what gates Start Processing.
  const [pasted, setPasted] = useState<Record<string, string>>({})
  const [pasting, setPasting] = useState<string | null>(null)

  // Bumped to re-read the "already processed" markers, which live in
  // localStorage and change while the preview screen is open.
  const [processedTick, setProcessedTick] = useState(0)

  // The running batch export, polled while it renders. Null when idle.
  const [exportJob, setExportJob] = useState<Export2Job | null>(null)
  const [starting, setStarting] = useState(false)

  // Process All — how many chapters are left and which one is in flight right
  // now, while the run is going. Null overall means no run is in progress.
  const [processingAll, setProcessingAll] = useState<{ total: number; done: number; chapterNumber: number } | null>(null)

  // Chapters that already have an MP4 on disk, keyed by chapter id. Server
  // truth rather than a local flag: the record is the series' _video2 folder,
  // so this survives a cleared browser and is right on a second machine.
  const [exported, setExported] = useState<Record<string, Exported2Chapter>>({})

  // The crop-name scan: its result while the confirmation is open, and the
  // two in-flight flags. Null means no scan has been run or it was dismissed.
  const [cropScan, setCropScan] = useState<CropRepairResult | null>(null)
  const [scanningNames, setScanningNames] = useState(false)
  const [repairingNames, setRepairingNames] = useState(false)

  // Send to phone / Fetch from phone, while one is in flight.
  const [phoneBusy, setPhoneBusy] = useState<'send' | 'fetch' | null>(null)

  // Which chapter's detail is open. Only one at a time: the list is the view,
  // and the detail is what you drop into for the chapter you are working on.
  const [expanded, setExpanded] = useState<string | null>(() =>
    seriesId ? getExpanded(seriesId) : null
  )

  // The ScrollArea's viewport, so the scroll offset can be saved on the way
  // out and restored on the way back.
  const scrollRootRef = useRef<HTMLDivElement | null>(null)

  /**
   * The scrolling element. A plain overflow container rather than the shared
   * ScrollArea: Radix wraps its content in a `display: table` wrapper whose
   * height collapses on a list this long, which caps scrollHeight and leaves
   * most of the chapters unreachable.
   */
  function viewport(): HTMLElement | null {
    return scrollRootRef.current
  }

  function toggleExpanded(chapterId: string) {
    setExpanded(prev => {
      const next = prev === chapterId ? null : chapterId
      if (seriesId) saveExpanded(seriesId, next)
      return next
    })
  }

  /**
   * Copy everything for one chapter in a single action: the Editor 2.0 prompt,
   * the chapter's full script with timeline (all sections joined), and its
   * full Clipper 3.0 crop metadata (all images joined) — one clipboard write,
   * so nothing has to be gathered section by section, file by file, or
   * button by button.
   */
  async function copyAll(ch: Editable2Chapter) {
    if (!ch.canCopy) return
    setCopying(ch.id)
    try {
      const [timeline, metadata] = await Promise.all([
        videoApi2.getTimelineBundle(ch.id, language),
        videoApi2.getCropMetadataBundle(ch.id)
      ])
      const prompt = readSavedPrompt()

      const sections: string[] = []
      if (prompt) sections.push(`# Prompt\n\n${prompt}`)
      if (timeline.text) sections.push(`# Script with Timeline\n\n${timeline.text}`)
      if (metadata.text) sections.push(`# Crop Metadata\n\n${metadata.text}`)

      if (sections.length === 0) {
        toast({
          title: 'Nothing to copy',
          description: 'No prompt, script with timeline, or crop metadata is available for this chapter yet.',
          variant: 'destructive'
        })
        return
      }

      await navigator.clipboard.writeText(sections.join('\n\n'))
      setCopied(ch.id)
      setTimeout(() => setCopied(prev => (prev === ch.id ? null : prev)), 1500)

      const missing: string[] = []
      if (!prompt) missing.push('prompt')
      if (!timeline.text) missing.push('script with timeline')
      if (!metadata.text) missing.push('crop metadata')
      toast({
        title: 'Copied',
        description: missing.length === 0
          ? `Prompt, script with timeline (${timeline.includedCount}/${timeline.sectionCount} sections) and crop metadata (${metadata.includedCount}/${metadata.imageCount} images) copied.`
          : `Copied what's available — missing: ${missing.join(', ')}.`
      })
    } catch (err) {
      toast({
        title: 'Copy Failed',
        description: err instanceof Error ? err.message : 'Could not copy',
        variant: 'destructive'
      })
    } finally {
      setCopying(prev => (prev === ch.id ? null : prev))
    }
  }

  /**
   * Paste from Clipboard — pulls everything on the clipboard into this
   * chapter's content area. Whatever arrives is kept verbatim; nothing is
   * parsed here, since what the content means is the processing step's
   * business, not this one's.
   */
  async function pasteFromClipboard(ch: Editable2Chapter) {
    setPasting(ch.id)
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) {
        toast({
          title: 'Clipboard Empty',
          description: 'There is nothing on the clipboard to paste.',
          variant: 'destructive'
        })
        return
      }
      setPasted(prev => ({ ...prev, [ch.id]: text }))
      // A fresh paste has not been processed yet, so this drops any previous
      // result and sends the button back to Start Processing.
      setTimelineJson(ch.id, language, text)
      setProcessedTick(t => t + 1)
      toast({
        title: 'Pasted',
        description: `${text.length.toLocaleString()} characters added — you can now start processing.`
      })
    } catch {
      toast({
        title: 'Paste Failed',
        description: 'Clipboard access was blocked. Paste manually with Cmd/Ctrl+V into the box.',
        variant: 'destructive'
      })
    } finally {
      setPasting(prev => (prev === ch.id ? null : prev))
    }
  }

  /**
   * Send to phone — hands the Copy All text of every chapter that has all but
   * its timeline JSON (audio, alignment, crops) to the Sleeper-Cell phone, whose Editor 2.0 run makes
   * the timeline JSON in ChatGPT (GPT-6 Astra). Fetch from phone brings the
   * results back as pastes.
   */
  async function sendToPhone() {
    if (!seriesId) return
    const prompt = readSavedPrompt()
    if (!prompt) {
      toast({
        title: 'No Editor 2.0 prompt',
        description: 'Save the prompt in Settings → Editor 2.0 first: the phone pastes it with each chapter.',
        variant: 'destructive'
      })
      return
    }
    const ids = chapters
      .filter(ch => ch.inputsReady && completedPart(ch.id) === null && !getTimelineJson(ch.id, language)?.trim())
      .map(ch => ch.id)
    if (ids.length === 0) {
      toast({
        title: 'Nothing to send',
        description: 'Every chapter with voiceover audio, alignment and cropped images already has a timeline JSON.'
      })
      return
    }
    setPhoneBusy('send')
    try {
      const result = await phoneEditorApi.send(seriesId, language, ids, prompt)
      const skipped = result.skipped.length > 0
        ? ` Skipped ${result.skipped.map(s => `${s.number} (${s.reason})`).join(', ')}.`
        : ''
      toast({
        title: result.sent.length > 0 ? `Sent ${result.sent.length} chapter${result.sent.length === 1 ? '' : 's'} to the phone` : 'Nothing sent',
        description:
          (result.sent.length > 0
            ? `${chapterList(result.sent.map(s => s.number))} — ` +
              (result.phoneNotified ? 'the phone picks them up now if it is open' : 'tap Check for new uploads on the phone') +
              ', then run Auto-run in its Editor 2.0.'
            : '') + skipped,
        variant: result.sent.length === 0 ? 'destructive' : undefined
      })
    } catch (err) {
      toast({
        title: 'Could not send to the phone',
        description: err instanceof Error ? err.message : 'The send failed',
        variant: 'destructive'
      })
    } finally {
      setPhoneBusy(null)
    }
  }

  /** Fetch from phone — stores the phone's timelines as pastes, then pulls them into this list. */
  async function fetchFromPhone() {
    if (!seriesId) return
    setPhoneBusy('fetch')
    try {
      const result = await phoneEditorApi.fetch(seriesId, language)
      if (!result.configured) {
        toast({ title: 'Cloudflare R2 is not set up', variant: 'destructive' })
        return
      }
      await syncSeriesTimelines(seriesId, language, chapters.map(ch => ch.id))
      const restored: Record<string, string> = {}
      for (const ch of chapters) {
        const json = getTimelineJson(ch.id, language)
        if (json) restored[ch.id] = json
      }
      setPasted(restored)
      setProcessedTick(t => t + 1)

      const parts: string[] = []
      if (result.imported.length > 0) {
        const review = result.imported.filter(i => i.review > 0)
        parts.push(`${chapterList(result.imported.map(i => i.number))} pasted — Start Processing to preview.`)
        if (review.length > 0) parts.push(`${chapterList(review.map(i => i.number))} still had issues on the phone; check the preview.`)
      }
      if (result.upToDate > 0) parts.push(`${result.upToDate} already up to date.`)
      if (result.kept.length > 0) parts.push(`${chapterList(result.kept.map(k => k.number))} kept: pasted here after the phone made it.`)
      if (result.unmatched.length > 0) parts.push(`No chapter here for ${result.unmatched.join(', ')}.`)
      if (result.failed.length > 0) parts.push(`${result.failed.length} could not be read: ${result.failed[0].error}.`)
      toast({
        title: result.found === 0
          ? 'No timelines from the phone yet'
          : `Fetched ${result.imported.length} timeline${result.imported.length === 1 ? '' : 's'}`,
        description: parts.join(' ') || 'Send chapters to the phone and run Editor 2.0 there first.',
        variant: result.failed.length > 0 ? 'destructive' : undefined
      })
    } catch (err) {
      toast({
        title: 'Could not fetch from the phone',
        description: err instanceof Error ? err.message : 'The fetch failed',
        variant: 'destructive'
      })
    } finally {
      setPhoneBusy(null)
    }
  }

  /** Drop this chapter's pasted content, disabling Start Processing again. */
  function clearPasted(chapterId: string) {
    setPasted(prev => {
      const next = { ...prev }
      delete next[chapterId]
      return next
    })
    clearTimeline(chapterId, language)
    setProcessedTick(t => t + 1)
  }

  /**
   * Start Processing — hand the pasted timeline JSON to the preview screen,
   * which processes it and plays the result back.
   *
   * The JSON travels through localStorage rather than the URL or a store:
   * it is far too large for a query string, and this keeps the preview
   * reloadable without re-pasting, even after the tab is closed.
   */
  function startProcessing(ch: Editable2Chapter) {
    const content = pasted[ch.id]?.trim()
    if (!content || !liveChecklist(ch, content).ready) return
    if (!setTimelineJson(ch.id, language, content)) {
      toast({
        title: 'Could not start',
        description: 'Browser storage is unavailable, so the timeline could not be handed over.',
        variant: 'destructive'
      })
      return
    }
    // Remember where the list was before leaving, so coming back from the
    // preview lands on this row rather than at the top.
    rememberPosition()
    navigate(withLang(`/editor2/chapter/${ch.id}/preview`, language))
  }

  /**
   * Process All — run every ready-but-unprocessed chapter's pasted JSON
   * through the same build the preview screen does, without opening it for
   * each one. The preview's own effect is just sync → read the paste → POST
   * process-timeline → markProcessed; none of that depends on being mounted,
   * so this repeats it here chapter by chapter and leaves the browsing
   * screen in front the whole time.
   *
   * One at a time, not in parallel: these hit the same render-adjacent
   * server work the single preview does, and a failure on one chapter should
   * not race ahead into the next five before the user sees it.
   */
  async function processAll() {
    const targets = chapters.filter(ch => {
      if (completedPart(ch.id) !== null) return false
      const content = pasted[ch.id]?.trim() ?? ''
      if (!content || !liveChecklist(ch, content).ready) return false
      return !isProcessed(ch.id, language, content)
    })
    if (targets.length === 0) return

    setProcessingAll({ total: targets.length, done: 0, chapterNumber: targets[0].number })
    let failed = 0
    let lastError = ''
    try {
      for (let i = 0; i < targets.length; i++) {
        const ch = targets[i]
        setProcessingAll({ total: targets.length, done: i, chapterNumber: ch.number })
        const content = pasted[ch.id]?.trim() ?? ''
        try {
          await syncChapterTimeline(ch.id, language)
          const json = getTimelineJson(ch.id, language) ?? content
          await videoApi2.processTimeline(ch.id, language, json)
          markProcessed(ch.id, language, json)
          setProcessedTick(t => t + 1)
        } catch (err) {
          failed++
          lastError = err instanceof Error ? err.message : 'Processing failed'
        }
      }
    } finally {
      setProcessingAll(null)
    }

    const okCount = targets.length - failed
    toast({
      title: failed === 0
        ? `Processed ${okCount} chapter${okCount === 1 ? '' : 's'}`
        : `Processed ${okCount} of ${targets.length} chapters`,
      description: failed > 0 ? `${failed} failed — ${lastError}` : 'All ready, pasted chapters are now previewable.',
      variant: failed > 0 ? 'destructive' : undefined
    })
  }

  /**
   * Export All — render every not-yet-exported chapter to its own MP4 in one
   * background job.
   *
   * Chapters that already have an MP4 in the series' _video2 folder are left
   * out: pressing Export again means "finish the rest", not "re-encode hours
   * of finished video". The server enforces the same rule, so a chapter
   * exported by another session is skipped there even if this list has not
   * re-scanned yet. `force` re-renders everything, for when the crops, audio
   * or timeline have genuinely changed.
   *
   * Each chapter's pasted JSON goes with the request: Editor 2.0 keeps it in
   * the browser, and re-processing it server-side is what makes the exported
   * video match the preview.
   */
  async function exportAll(force = false) {
    if (!seriesId) return
    const all = collectProcessed(readyIds(), language)
    const inputs = force ? all : all.filter(i => !exported[i.chapterId])
    if (inputs.length === 0) return

    setStarting(true)
    try {
      const { jobId } = await videoApi2.exportAll(seriesId, language, inputs, force ? { force: true } : undefined)
      setExportJob({
        id: jobId,
        seriesId,
        status: 'running',
        percent: 0,
        chapters: [],
        startedAt: Date.now(),
        finishedAt: null,
        error: null
      })
      const skipped = all.length - inputs.length
      toast({
        title: 'Export started',
        description:
          `Rendering ${inputs.length} chapter${inputs.length === 1 ? '' : 's'}` +
          (skipped > 0 ? ` — ${skipped} already exported and skipped` : '') +
          ' — you can keep working while it runs.'
      })
    } catch (err) {
      toast({
        title: 'Could not start the export',
        description: err instanceof Error ? err.message : 'Export failed to start',
        variant: 'destructive'
      })
    } finally {
      setStarting(false)
    }
  }

  /** Chapters whose checklist is complete right now — the only ones Preview and Export take. */
  function readyIds(): string[] {
    return chapters
      .filter(ch => completedPart(ch.id) === null && liveChecklist(ch, pasted[ch.id] ?? '').ready)
      .map(ch => ch.id)
  }

  async function cancelExport() {
    if (!exportJob) return
    try {
      await videoApi2.cancelExport(exportJob.id)
    } catch {
      // A job that already finished cannot be cancelled — the poll below will
      // show its real state in a moment either way.
    }
  }

  /**
   * Check Images — find every pasted image reference that names no file in its
   * chapter's crops3.
   *
   * This is the cause of the preview's "N image references could not be found
   * on disk". The timeline JSON is AI-authored, and the names it writes drift
   * from the cutter's: a reason suffix carried over from a neighbouring crop
   * (`_11_full_width_tall_scene` where the file is `_11_full_width_wide_scene`),
   * or a name lifted from a DIFFERENT chapter's page 1 — which is the worse
   * case, since it is a real file and only the chapter is wrong.
   *
   * The page and index never drift, and within a chapter they identify the
   * crop, so the repair matches on those and replaces the whole name.
   *
   * Every pasted chapter is checked, not only the processed ones: a paste that
   * has not been previewed yet is exactly where a bad name is still cheap to
   * fix. The scan writes nothing — the corrected JSON comes back with it and
   * is saved only if the user confirms.
   */
  async function checkImageRefs() {
    if (!seriesId) return
    const inputs = chapters
      .map(ch => ({ chapterId: ch.id, json: getTimelineJson(ch.id, language) ?? '' }))
      .filter(i => i.json.trim().length > 0)

    if (inputs.length === 0) {
      toast({
        title: 'Nothing to check',
        description: 'No chapter has a pasted timeline yet — paste one first.'
      })
      return
    }

    setScanningNames(true)
    try {
      const result = await videoApi2.checkImageRefs(seriesId, inputs)
      if (result.repairedCount === 0 && result.unfixableCount === 0) {
        // A clean series should cost one click, not a dialog to dismiss.
        toast({
          title: 'All image references resolve',
          description: `Checked ${result.chaptersChecked} chapter${
            result.chaptersChecked === 1 ? '' : 's'
          } — every reference points at a crop on disk.`
        })
        return
      }
      setCropScan(result)
    } catch (err) {
      toast({
        title: 'Could not check the image references',
        description: err instanceof Error ? err.message : 'The scan failed',
        variant: 'destructive'
      })
    } finally {
      setScanningNames(false)
    }
  }

  /**
   * Keep the corrected pastes the scan already produced.
   *
   * Saved straight from the scan result rather than re-requested: the fix IS
   * what the dialog listed, line by line, so re-running it could only produce
   * something the user did not agree to.
   *
   * Saving a paste clears its "processed" marker (setTimelineJson does this by
   * content), which is right — the corrected JSON has not been previewed, and
   * the chapter correctly returns to needing Start Processing before it can be
   * exported.
   */
  function applyImageRefRepair() {
    if (!cropScan) return
    setRepairingNames(true)
    try {
      let saved = 0
      for (const chapter of cropScan.chapters) {
        if (!chapter.correctedJson) continue
        setTimelineJson(chapter.chapterId, language, chapter.correctedJson)
        setPasted(prev =>
          // Only chapters whose box is actually open hold an entry here; the
          // rest read their paste back from storage when they are opened.
          chapter.chapterId in prev
            ? { ...prev, [chapter.chapterId]: chapter.correctedJson! }
            : prev
        )
        saved++
      }
      setProcessedTick(t => t + 1)
      setCropScan(null)

      toast({
        title: `Repaired ${cropScan.repairedCount} reference${
          cropScan.repairedCount === 1 ? '' : 's'
        }`,
        description:
          `Corrected in ${saved} chapter${saved === 1 ? '' : 's'} — re-run Start Processing` +
          (cropScan.unfixableCount > 0
            ? `. ${cropScan.unfixableCount} reference${
                cropScan.unfixableCount === 1 ? '' : 's'
              } still name a crop that was never cut — re-cut those pages in Image Clipper 3.0.`
            : '.')
      })
    } finally {
      setRepairingNames(false)
    }
  }

  // Follow a running job. Polling rather than a socket subscription: the job
  // is short-lived and this view is the only thing watching it, so a one-second
  // poll is simpler than threading another event through the socket context.
  useEffect(() => {
    if (!exportJob || exportJob.status !== 'running') return
    let cancelled = false

    const id = setInterval(async () => {
      try {
        const job = await videoApi2.getExportJob(exportJob.id)
        if (cancelled) return
        setExportJob(job)
        if (job.status !== 'running') {
          const done = job.chapters.filter(c => c.status === 'done').length
          const skipped = job.chapters.filter(c => c.status === 'skipped').length
          const failed = job.chapters.filter(c => c.status === 'failed')
          // Whatever just rendered is now on disk, so re-scan: the rows keep
          // their Exported badge after this job is forgotten.
          if (seriesId) void refreshExported(seriesId)
          const skipNote = skipped > 0 ? ` ${skipped} already exported.` : ''
          if (job.status === 'cancelled') {
            toast({ title: 'Export cancelled', description: `${done} chapter${done === 1 ? '' : 's'} finished before it stopped.${skipNote}` })
          } else if (failed.length > 0) {
            toast({
              title: 'Export finished with errors',
              description: `${done} exported, ${failed.length} failed — ${failed[0].error ?? 'see the server log'}`,
              variant: 'destructive'
            })
          } else {
            toast({
              title: 'Export complete',
              description: done > 0
                ? `${done} chapter${done === 1 ? '' : 's'} rendered to the series ${language === 'hi' ? '_video2_hi' : '_video2'} folder.${skipNote}`
                : 'Every chapter was already exported — nothing to render.'
            })
          }
        }
      } catch {
        // A failed poll is not worth interrupting the user over — the next
        // tick will usually succeed.
      }
    }, 1000)

    return () => { cancelled = true; clearInterval(id) }
  }, [exportJob?.id, exportJob?.status, seriesId, toast])

  /** Save the list's scroll offset for this series. */
  function rememberPosition() {
    const el = viewport()
    if (el && seriesId) saveScrollTop(seriesId, el.scrollTop)
  }

  /**
   * Restore the scroll offset once the chapters are on screen.
   *
   * useLayoutEffect rather than useEffect so the jump happens before the
   * browser paints — restoring after paint shows the top of the list for a
   * frame, which reads as a flicker back to the start.
   */
  useLayoutEffect(() => {
    if (loading || !seriesId || chapters.length === 0) return
    const el = viewport()
    if (!el) return
    const top = getScrollTop(seriesId)
    if (top > 0) el.scrollTop = top
  }, [loading, seriesId, chapters.length])

  // Keep the saved offset current while scrolling, so any route away from
  // here — not just Start Processing — comes back to the right place.
  useEffect(() => {
    const el = viewport()
    if (!el || !seriesId) return
    let frame = 0
    const onScroll = () => {
      // Coalesce to one write per frame: the scroll event fires far more
      // often than localStorage should be touched.
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        saveScrollTop(seriesId, el.scrollTop)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [seriesId, loading, chapters.length])

  /**
   * Re-scan which chapters have an MP4 on disk.
   *
   * Called on load and again when an export job ends, so rows flip to
   * "Exported" for good rather than only for the life of the finished job.
   */
  async function refreshExported(id: string) {
    try {
      const rows = await videoApi2.getExportedChapters(id, language)
      setExported(Object.fromEntries(rows.map(r => [r.chapterId, r])))
    } catch {
      // A failed scan just means the badges stay as they are; nothing here is
      // worth interrupting the user over.
    }
  }

  useEffect(() => {
    if (!seriesId) return
    setLoading(true)
    // The scan dialog and any finished job describe the other tab's videos.
    setCropScan(null)
    setExportJob(null)
    Promise.all([
      seriesApi.getById(seriesId),
      videoApi2.getEditableChapters(seriesId, language),
      videoApi2.getExportedChapters(seriesId, language).catch(() => [] as Exported2Chapter[])
    ])
      .then(async ([s, chs, exportedRows]) => {
        // Pull in what was pasted or processed in another browser (or the
        // desktop app) before reading the local cache below.
        await syncSeriesTimelines(seriesId, language, chs.map(ch => ch.id))
        setSeriesTitle(s.title)
        setChapters(chs)
        setExported(Object.fromEntries(exportedRows.map(r => [r.chapterId, r])))
        // Bring back anything already handed over for these chapters, so
        // returning from the preview does not look like the paste was lost.
        const restored: Record<string, string> = {}
        for (const ch of chs) {
          const json = getTimelineJson(ch.id, language)
          if (json) restored[ch.id] = json
        }
        setPasted(restored)
      })
      .catch(err => console.error(err))
      .finally(() => setLoading(false))
  }, [seriesId, language])

  // The preview screen records "processed" while this list is still mounted
  // behind it, so re-read those markers whenever this view is shown again.
  useEffect(() => {
    const refresh = () => setProcessedTick(t => t + 1)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  const exporting = exportJob?.status === 'running'

  // Keep the display awake for the length of the render. A batch export runs
  // for minutes with no input, so the screen would otherwise sleep — and on a
  // laptop the machine can follow it down mid-encode. Called before the
  // loading guard below because hooks cannot sit behind an early return.
  const wakeLock = useWakeLock(exporting)

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  // How much of the series is ready to export. Read through processedTick so
  // this recomputes after a paste, a clear, or a return from the preview —
  // the markers live in localStorage, which React cannot subscribe to.
  void processedTick
  // Only chapters with a complete checklist can be previewed, so they are the
  // pool Export All draws from. Whatever is processed (previewed) right now is
  // exportable — the rest of the series is allowed to lag behind, and a
  // chapter that has not been through the pipeline yet simply waits its turn.
  const readySet = new Set(readyIds())
  const readyChapters = chapters.filter(ch => readySet.has(ch.id))
  const processedInputs = collectProcessed(readyChapters.map(ch => ch.id), language)
  const processedCount = processedInputs.length
  const allProcessed = readyChapters.length > 0 && processedCount === readyChapters.length

  // Ready, pasted, and not yet processed — exactly what Process All would do.
  const pendingProcessCount = readyChapters.filter(ch => {
    const content = pasted[ch.id]?.trim() ?? ''
    return content.length > 0 && !isProcessed(ch.id, language, content)
  }).length

  // Of the processed chapters, how many still need rendering. This — not the
  // processed count — is what Export All would actually do, so it is what the
  // button counts and what decides whether it has anything to do at all.
  const pendingExport = processedInputs.filter(i => !exported[i.chapterId]).length
  const exportedCount = readyChapters.filter(ch => exported[ch.id]).length
  // Nothing left to render: every chapter processed so far is already out.
  // Pressing the button then means re-render those, not wait for the others.
  const everythingExported = processedCount > 0 && pendingExport === 0

  const currentlyRendering = exportJob?.chapters.find(c => c.status === 'rendering') ?? null

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(withLang('/editor2', language))}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <Clapperboard className="h-5 w-5 text-primary" />
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">{seriesTitle}</h1>
          <p className="text-xs text-muted-foreground">
            Editor 2.0 — {LANGUAGE_LABEL[language]} · {readyChapters.length}/{chapters.filter(ch => completedPart(ch.id) === null).length} ready to edit
          </p>
        </div>

        {/* Locked while rendering: the job and its badges belong to this tab */}
        <LanguageTabs
          value={language}
          onChange={setLanguage}
          disabled={exporting || starting}
          className="flex-shrink-0"
        />

        {/* The phone makes timelines in ChatGPT: send it the chapters still
            without one, then fetch what it made. */}
        <Button
          variant="outline"
          size="sm"
          className="h-8 flex-shrink-0"
          onClick={sendToPhone}
          disabled={phoneBusy !== null}
          title="Send every chapter with voiceover audio, alignment and cropped images but no timeline JSON to the Sleeper-Cell phone, which makes the JSON in ChatGPT"
        >
          {phoneBusy === 'send' ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Smartphone className="h-3 w-3 mr-1" />}
          Send to phone
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 flex-shrink-0"
          onClick={fetchFromPhone}
          disabled={phoneBusy !== null}
          title="Import the timeline JSON the phone made (from R2) into its chapters"
        >
          {phoneBusy === 'fetch' ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Download className="h-3 w-3 mr-1" />}
          Fetch from phone
        </Button>

        {/* Export All — every processed chapter in one action. It does not
            wait for the whole series: whatever is ready now gets rendered,
            and the chapters processed later are picked up next time. */}
        {exporting ? (
          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="text-right">
              <p className="text-xs font-medium flex items-center justify-end gap-1">
                Exporting {exportJob!.percent}%
                {currentlyRendering && (
                  <span className="text-muted-foreground font-normal">
                    · Chapter {currentlyRendering.chapterNumber}
                  </span>
                )}
                {/* Says plainly whether the screen is being held awake — and
                    stays quiet when it is, so the icon only draws the eye if
                    the lock was refused or is unavailable. */}
                {wakeLock.active ? (
                  <span title="Screen kept awake while this export runs">
                    <Coffee className="h-3 w-3 text-muted-foreground" />
                  </span>
                ) : (
                  <span
                    title={
                      wakeLock.supported
                        ? 'The screen may sleep — the browser did not grant a wake lock (this tab must stay visible).'
                        : 'This browser cannot keep the screen awake. The export still finishes on the server.'
                    }
                  >
                    <Moon className="h-3 w-3 text-yellow-600" />
                  </span>
                )}
              </p>
              <div className="h-1.5 w-40 bg-secondary rounded-full mt-1 overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${exportJob!.percent}%` }}
                />
              </div>
            </div>
            <Button variant="outline" size="sm" className="h-8" onClick={cancelExport}>
              <Ban className="h-3 w-3 mr-1" />
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* How much of the series is already rendered, so the state is
                readable without counting badges down the list. */}
            {exportedCount > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {exportedCount}/{readyChapters.length} exported
              </span>
            )}

            {/* Process All — every pasted, ready chapter still showing
                Process rather than Preview, run one by one without opening
                each. Sits before Check Images: processing is what turns a
                paste into something Export All can pick up at all. */}
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={processAll}
              disabled={processingAll !== null || pendingProcessCount === 0}
              title={
                pendingProcessCount === 0
                  ? 'Nothing to process — every ready, pasted chapter has already been processed'
                  : `Process the ${pendingProcessCount} ready chapter${pendingProcessCount === 1 ? '' : 's'} with a paste still waiting on Process`
              }
            >
              {processingAll ? (
                <>
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  Processing {processingAll.done + 1}/{processingAll.total} · Ch {processingAll.chapterNumber}
                </>
              ) : (
                <>
                  <Play className="h-3 w-3 mr-1" />
                  Process All{pendingProcessCount > 0 ? ` (${pendingProcessCount})` : ''}
                </>
              )}
            </Button>

            {/* Check Images — sits beside Export because a broken reference is
                only ever noticed here, as a missing image in the preview or a
                gap in a finished render. Before the export is the cheap moment
                to fix it; after, the video is already wrong. */}
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={checkImageRefs}
              disabled={scanningNames || chapters.length === 0}
              title="Find pasted image references that name no crop on disk — the cause of “image references could not be found on disk” — and correct them"
            >
              {scanningNames ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <ImageOff className="h-3 w-3 mr-1" />
              )}
              Check Images
            </Button>

            <Button
              size="sm"
              variant={everythingExported ? 'outline' : 'default'}
              className="h-8"
              onClick={() => exportAll(everythingExported)}
              disabled={processedCount === 0 || starting || processingAll !== null}
              title={
                readyChapters.length === 0
                  ? 'No chapter is ready yet — every checklist item (voiceover audio, alignment, timeline JSON, cropped images) has to pass first'
                  : processedCount === 0
                    ? 'No ready chapter has been previewed yet — preview one to export it'
                    : everythingExported
                      ? `Every processed chapter is already exported — re-render all ${processedCount} from scratch`
                      : `Render the ${pendingExport} processed chapter${pendingExport === 1 ? '' : 's'} that have not been exported yet` +
                        (allProcessed
                          ? ''
                          : ` — ${readyChapters.length - processedCount} ready chapter${
                              readyChapters.length - processedCount === 1 ? '' : 's'
                            } not processed yet and left out`)
              }
            >
              {starting ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Film className="h-3 w-3 mr-1" />
              )}
              {/* "All" only when the whole ready series is processed —
                  otherwise this press covers just the processed part, and
                  the count says how many chapters that is. */}
              {everythingExported
                ? allProcessed
                  ? 'Re-export All'
                  : 'Re-export Ready'
                : allProcessed
                  ? 'Export All'
                  : 'Export Ready'}
              {(allProcessed ? !everythingExported && exportedCount > 0 : true) && (
                <span className="ml-1 opacity-70">
                  ({everythingExported ? processedCount : pendingExport})
                </span>
              )}
            </Button>
          </div>
        )}
      </div>

      <div ref={scrollRootRef} className="flex-1 overflow-y-auto">
        <div className="divide-y">
          {chapters.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Clapperboard className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p>No chapters found for this series.</p>
            </div>
          )}

          {chapters.map(ch => {
            const completed = completedPart(ch.id)
            if (completed !== null) {
              return (
                <div
                  key={ch.id}
                  data-chapter-row={ch.id}
                  className={`flex items-center gap-3 px-4 py-2 ${completedRowClass}`}
                >
                  <span className="w-4 flex-shrink-0" />
                  <span className="font-semibold text-sm tabular-nums w-14 flex-shrink-0">
                    Ch {ch.number}
                  </span>
                  <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
                    {ch.title || <span className="opacity-50">Untitled</span>}
                  </span>
                  <CompletedBadge part={completed} label={`Part ${completed} done`} />
                </div>
              )
            }
            const content = pasted[ch.id]?.trim() ?? ''
            const done = content.length > 0 && isProcessed(ch.id, language, content)
            const isOpen = expanded === ch.id
            const rowExport = exportJob?.chapters.find(c => c.chapterId === ch.id)
            const exportedRow = exported[ch.id]
            const live = liveChecklist(ch, content)
            const missingText = `Missing: ${live.missing.join(', ')}`

            return (
              <div key={ch.id} data-chapter-row={ch.id}>
                {/* The row itself: one line per chapter, so a long series
                    scans as a list rather than a stack of tall cards. */}
                <div
                  className={`flex items-center gap-3 px-4 py-2 cursor-pointer hover:bg-muted/50 transition-colors ${
                    isOpen ? 'bg-muted/40' : ''
                  }`}
                  onClick={() => toggleExpanded(ch.id)}
                >
                  <ChevronRight
                    className={`h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform ${
                      isOpen ? 'rotate-90' : ''
                    }`}
                  />

                  <span className="font-semibold text-sm tabular-nums w-14 flex-shrink-0">
                    Ch {ch.number}
                  </span>

                  <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
                    {ch.title || <span className="opacity-50">Untitled</span>}
                  </span>

                  {/* The checklist compressed to a row of icons, so the
                      state reads at a glance without opening anything. */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {CHECKLIST.map(item => (
                      <ChecklistDot
                        key={item.key}
                        ok={live.checklist[item.key].ok}
                        icon={item.icon}
                        label={item.label}
                        detail={live.checklist[item.key].detail}
                      />
                    ))}
                  </div>

                  {/* Status: where this chapter stands in the paste → process
                      → export run, which is what the user is actually tracking. */}
                  <div className="w-28 flex-shrink-0 flex justify-end">
                    {rowExport && rowExport.status !== 'pending' ? (
                      <span className="text-xs flex items-center gap-1">
                        {rowExport.status === 'rendering' && (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin text-primary" />
                            <span className="text-primary tabular-nums">{Math.round(rowExport.percent)}%</span>
                          </>
                        )}
                        {rowExport.status === 'done' && (
                          <><Film className="h-3 w-3 text-green-600" /><span className="text-green-600">Exported</span></>
                        )}
                        {/* Skipped reads as Exported, because that is what it
                            means to the user: the MP4 is there. The tooltip
                            carries the distinction. */}
                        {rowExport.status === 'skipped' && (
                          <span
                            className="text-green-600 flex items-center gap-1"
                            title="Already exported — left alone by this run"
                          >
                            <Film className="h-3 w-3" /> Exported
                          </span>
                        )}
                        {rowExport.status === 'failed' && (
                          <span className="text-destructive flex items-center gap-1" title={rowExport.error ?? undefined}>
                            <AlertTriangle className="h-3 w-3" /> Failed
                          </span>
                        )}
                        {rowExport.status === 'cancelled' && (
                          <span className="text-muted-foreground">Cancelled</span>
                        )}
                      </span>
                    ) : exportedRow ? (
                      /* No job running — the standing state from the folder
                         scan, which is what makes "Exported" survive a reload
                         rather than living only inside a finished job. */
                      <span
                        className="text-xs text-green-600 flex items-center gap-1"
                        title={`${exportedRow.fileName} · ${formatSize(exportedRow.size)} · exported ${formatWhen(exportedRow.modifiedAt)}`}
                      >
                        <Film className="h-3 w-3" /> Exported
                      </span>
                    ) : done ? (
                      <span className="text-xs text-green-600 flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Processed
                      </span>
                    ) : content ? (
                      <span className="text-xs text-blue-500 flex items-center gap-1">
                        <ClipboardPaste className="h-3 w-3" /> Pasted
                      </span>
                    ) : ch.inputsReady ? (
                      <span className="text-xs text-muted-foreground" title="Everything but the timeline JSON is there">
                        Needs JSON
                      </span>
                    ) : (
                      <span className="text-xs text-yellow-600 flex items-center gap-1" title={missingText}>
                        <AlertTriangle className="h-3 w-3" /> Incomplete
                      </span>
                    )}
                  </div>

                  {/* The actions, inline. Copy and Paste are the two steps a
                      chapter still needs, so an unprocessed row offers them
                      here rather than only behind an expand — going through
                      a hundred chapters otherwise means opening every one. A
                      processed row has finished with them and shows only
                      Preview, which keeps the common case quiet. */}
                  <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                    {!done && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => copyAll(ch)}
                          disabled={copying === ch.id || !ch.canCopy}
                          title={ch.copyBlockedReason ?? 'Copy All — prompt, script with timeline and crop metadata'}
                        >
                          {copying === ch.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : copied === ch.id ? (
                            <Check className="h-3.5 w-3.5 text-green-500" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => pasteFromClipboard(ch)}
                          disabled={pasting === ch.id}
                          title="Paste the timeline JSON from the clipboard"
                        >
                          {pasting === ch.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ClipboardPaste className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </>
                    )}

                    {/* Disabled until the whole checklist passes, and says why. */}
                    <Button
                      size="sm"
                      variant={done ? 'outline' : 'default'}
                      className="h-7 w-28"
                      onClick={() => startProcessing(ch)}
                      disabled={!live.ready}
                      title={
                        !live.ready
                          ? missingText
                          : done
                            ? 'Play the processed timeline back'
                            : 'Process the timeline JSON and play it back'
                      }
                    >
                      {done ? (
                        <><Eye className="h-3 w-3 mr-1" /> Preview</>
                      ) : (
                        <><Play className="h-3 w-3 mr-1" /> Process</>
                      )}
                    </Button>
                  </div>
                </div>

                {/* Expanded detail: everything the old card showed, revealed
                    only for the chapter being worked on. */}
                {isOpen && (
                  <div className="px-4 pb-3 pl-11 space-y-2 bg-muted/20">
                    {/* The checklist in full: what each item found, and where
                        a missing one is fixed. */}
                    <ul className="space-y-1 pt-2">
                      {CHECKLIST.map(item => {
                        const state = live.checklist[item.key]
                        const fix = state.ok || !seriesId ? null : item.fix({ id: ch.id, seriesId }, language)
                        return (
                          <li key={item.key} className="flex items-start gap-2 text-xs">
                            {state.ok ? (
                              <CheckCircle2 className="h-3.5 w-3.5 mt-px flex-shrink-0 text-green-600" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5 mt-px flex-shrink-0 text-destructive" />
                            )}
                            <span className="font-medium w-28 flex-shrink-0">{item.label}</span>
                            <span className="text-muted-foreground min-w-0">{state.detail}</span>
                            {fix && (
                              <Link to={fix.to} className="text-primary hover:underline flex-shrink-0">
                                {fix.label}
                              </Link>
                            )}
                          </li>
                        )
                      })}
                    </ul>

                    {/* An unprocessed row carries Copy and Paste inline, so
                        the detail repeats them only for a processed chapter —
                        which has none on its row, and would otherwise have no
                        way back to re-copying or re-pasting. */}
                    {done && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7"
                          onClick={() => copyAll(ch)}
                          disabled={copying === ch.id || !ch.canCopy}
                          title={ch.copyBlockedReason ?? undefined}
                        >
                          {copying === ch.id ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : copied === ch.id ? (
                            <Check className="h-3 w-3 mr-1 text-green-500" />
                          ) : (
                            <Copy className="h-3 w-3 mr-1" />
                          )}
                          {copied === ch.id ? 'Copied' : 'Copy All (Prompt + Timeline + Crop Metadata)'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7"
                          onClick={() => pasteFromClipboard(ch)}
                          disabled={pasting === ch.id}
                        >
                          {pasting === ch.id ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <ClipboardPaste className="h-3 w-3 mr-1" />
                          )}
                          Paste from Clipboard
                        </Button>
                      </div>
                    )}

                    {pasted[ch.id] && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-green-600 flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          {pasted[ch.id].length.toLocaleString()} characters ready
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-muted-foreground"
                          onClick={() => clearPasted(ch.id)}
                        >
                          <X className="h-3 w-3 mr-1" />
                          Clear
                        </Button>
                      </div>
                    )}

                    {rowExport?.status === 'failed' && rowExport.error && (
                      <p className="text-xs text-destructive">{rowExport.error}</p>
                    )}
                    {rowExport?.status === 'done' && rowExport.outputPath && (
                      <p className="text-xs text-muted-foreground font-mono break-all">
                        {rowExport.outputPath}
                      </p>
                    )}

                    {pasted[ch.id] !== undefined && (
                      <div className="space-y-1">
                        <Label htmlFor={`pasted-${ch.id}`} className="text-xs text-muted-foreground">
                          Pasted content
                        </Label>
                        <Textarea
                          id={`pasted-${ch.id}`}
                          value={pasted[ch.id]}
                          onChange={(e) => {
                            const value = e.target.value
                            setPasted(prev => ({ ...prev, [ch.id]: value }))
                            // Editing the JSON by hand also counts as a new
                            // paste, so the result has to be rebuilt.
                            setTimelineJson(ch.id, language, value)
                            setProcessedTick(t => t + 1)
                          }}
                          rows={6}
                          className="font-mono text-xs"
                          spellCheck={false}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* The scan result, before anything is saved.
          Every reference is listed with the name it will become rather than
          just counted: the point of confirming is seeing WHICH crop each
          broken ref resolves to, so a wrong match is caught here and not in
          the finished video. References no rename can fix are listed in their
          own block — they need a re-cut, and saying so is the honest outcome. */}
      <Dialog open={cropScan !== null} onOpenChange={open => !open && setCropScan(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {cropScan && cropScan.repairedCount > 0
                ? `Correct ${cropScan.repairedCount} image reference${
                    cropScan.repairedCount === 1 ? '' : 's'
                  }?`
                : 'Nothing can be corrected automatically'}
            </DialogTitle>
            <DialogDescription>
              {cropScan && cropScan.repairedCount > 0 ? (
                <>
                  Found across {cropScan.chapters.length} chapter
                  {cropScan.chapters.length === 1 ? '' : 's'}. Each reference is matched to
                  the crop its page and index name, which is what the cutter actually
                  wrote. The corrected chapters go back to needing Start Processing.
                  {cropScan.unfixableCount > 0 && (
                    <>
                      {' '}
                      {cropScan.unfixableCount} reference
                      {cropScan.unfixableCount === 1 ? '' : 's'} cannot be fixed this way.
                    </>
                  )}
                </>
              ) : (
                <>
                  {cropScan?.unfixableCount ?? 0} reference
                  {(cropScan?.unfixableCount ?? 0) === 1 ? '' : 's'} name a crop that was
                  never cut. Re-cut those pages in Image Clipper 3.0 — no rename can
                  produce a file that does not exist.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[50vh] pr-3">
            <div className="space-y-4">
              {(cropScan?.chapters ?? []).map(chapter => (
                <div key={chapter.chapterId}>
                  <p className="text-sm font-medium mb-1">
                    Chapter {chapter.chapterNumber}
                    {chapter.chapterTitle ? ` — ${chapter.chapterTitle}` : ''}
                  </p>

                  {chapter.error ? (
                    <div className="text-xs rounded p-2 flex items-start gap-2 bg-destructive/10">
                      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-destructive" />
                      <span className="min-w-0">{chapter.error}</span>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {chapter.repaired.map((ref, i) => (
                        <div
                          key={`${chapter.chapterId}-fix-${i}`}
                          className="text-xs rounded p-2 flex items-start gap-2 bg-muted"
                        >
                          <FileCheck2 className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-green-500" />
                          <span className="min-w-0 break-all">
                            <span className="font-mono line-through text-muted-foreground">
                              {ref.was}
                            </span>
                            <span className="font-mono"> → {ref.now}</span>
                            <span className="text-muted-foreground"> — {ref.where}</span>
                          </span>
                        </div>
                      ))}

                      {/* Separated from the rewrites above because the action
                          they need is different: a re-cut, not a rename. */}
                      {chapter.unfixable.map((ref, i) => (
                        <div
                          key={`${chapter.chapterId}-miss-${i}`}
                          className="text-xs rounded p-2 flex items-start gap-2 bg-destructive/10"
                        >
                          <ImageOff className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-destructive" />
                          <span className="min-w-0 break-all">
                            <span className="font-mono">{ref.ref}</span>
                            <span className="text-muted-foreground">
                              {' '}— {ref.reason} ({ref.where})
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setCropScan(null)} disabled={repairingNames}>
              {cropScan && cropScan.repairedCount > 0 ? 'Cancel' : 'Close'}
            </Button>
            {cropScan && cropScan.repairedCount > 0 && (
              <Button onClick={applyImageRefRepair} disabled={repairingNames}>
                {repairingNames ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Wrench className="h-4 w-4 mr-2" />
                )}
                Correct
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  )
}
