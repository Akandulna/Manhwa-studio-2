/**
 * ReviewWorkspace — the Crop Studio review of ONE page (PRD §6.5, §8, §9.3).
 *
 * Left: the page editor (ReviewCanvas) under a toolbar — select/move/resize,
 * draw, split, merge, delete, undo/redo, zoom and an overlay toggle, with the
 * selected box's exact pixel bounds. Right: what export is still waiting for,
 * the page sweep, and one card per crop — its reason, decision (keep /
 * unresolved), every system finding and ChatGPT flag to tick off, and its
 * description to edit and approve.
 *
 * Every change is one save against the revision it was made on; the server
 * bumps the revision, re-applies its rules (provenance, stale descriptions,
 * cleared acknowledgements) and hands back the re-audited page, so findings,
 * blockers and colours always show what is stored. A drag or a burst of arrow
 * nudges saves once, when it ends. Undo/redo replay earlier states as new
 * saves, so history is never rewritten.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import {
  AlertTriangle, CheckCircle2, Loader2, RotateCcw, HelpCircle, Check, MousePointer2, PlusSquare,
  SeparatorHorizontal, SeparatorVertical, Combine, Trash2, Undo2, Redo2, Eye, EyeOff, Keyboard,
  PackageCheck, FolderOpen
} from 'lucide-react'
import {
  clipper3Api,
  Clipper3ExportError,
  Clipper3ReviewSaveError,
  type Clipper3ExportStatus,
  type Clipper3ReviewCrop,
  type Clipper3ReviewState,
  type Clipper3ReviewView
} from '@/lib/api'
import {
  moveBox,
  readingOrder,
  withAdded,
  withBounds,
  withDeleted,
  withMerged,
  withSplit,
  type PxBox
} from '@/lib/reviewEdits'
import { BOX_COLORS, ReviewCanvas, type ReviewTool } from './ReviewCanvas'

interface ReviewWorkspaceProps {
  chapterId: string
  filename: string
  view: Clipper3ReviewView & { state: Clipper3ReviewState }
  onView: (view: Clipper3ReviewView) => void
  onRestart: (from: 'import' | 'pointers') => void
  /** Width the page is drawn at when fitted, in CSS px. */
  pageWidth: number
  /** After a successful export, so the caller can refresh the page's Done status. */
  onExported?: () => void
}

type Snapshot = Pick<Clipper3ReviewState, 'crops' | 'page'>
type Zoom = 'fit' | 1 | 2

const STATUS_STYLE: Record<Clipper3ReviewCrop['description_status'], string> = {
  approved: 'border-green-500 text-green-500',
  unreviewed: 'border-muted-foreground text-muted-foreground',
  stale: 'border-amber-500 text-amber-500',
  missing: 'border-destructive text-destructive'
}

const SHORTCUTS: [string, string][] = [
  ['V / D', 'select · draw a new crop'],
  ['H / ⇧H', 'split across · split down (click inside the selected box)'],
  ['M', 'merge the selected crops'],
  ['⌫', 'delete the selected crops'],
  ['J / K', 'next · previous crop'],
  ['arrows', 'nudge 1 px (⇧ 10 px)'],
  ['⌘Z / ⇧⌘Z', 'undo · redo'],
  ['O', 'hide / show boxes'],
  ['F / 1 / 2', 'fit · 100% · 200%'],
  ['Esc', 'back to select, clear selection']
]

/** Idle time after the last arrow-key nudge before it is saved. */
const NUDGE_SAVE_MS = 600

export function ReviewWorkspace({ chapterId, filename, view, onView, onRestart, pageWidth, onExported }: ReviewWorkspaceProps) {
  const { toast } = useToast()
  const { state, items, audit, readiness } = view
  const W = state.source_width
  const H = state.source_height

  const [selected, setSelected] = useState<string[]>([])
  const [tool, setTool] = useState<ReviewTool>('select')
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [showOverlay, setShowOverlay] = useState(true)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<Record<string, PxBox>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [reasonDrafts, setReasonDrafts] = useState<Record<string, string>>({})
  const [showBlockers, setShowBlockers] = useState(false)
  const [past, setPast] = useState<Snapshot[]>([])
  const [future, setFuture] = useState<Snapshot[]>([])
  const viewerRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [exportStatus, setExportStatus] = useState<Clipper3ExportStatus | null>(null)
  const [exporting, setExporting] = useState(false)

  // Re-read after every revision: "up to date" means the last export was made
  // from exactly the revision now stored.
  useEffect(() => {
    let cancelled = false
    clipper3Api.getExport(chapterId, filename)
      .then(status => { if (!cancelled) setExportStatus(status) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [chapterId, filename, state.review_revision])

  const runExport = async () => {
    setExporting(true)
    try {
      const report = await clipper3Api.exportPage(chapterId, filename)
      setExportStatus({ report, upToDate: true })
      onExported?.()
      toast({
        title: `Exported ${report.crop_count} crop${report.crop_count === 1 ? '' : 's'}`,
        description: `PNGs in ${report.destinations.crops}, JSON in ${report.destinations.processed} — every file verified against the original.`
      })
    } catch (error) {
      toast({
        title: 'Export failed',
        description: error instanceof Clipper3ExportError && (error.details.length > 0 || error.blockers.length > 0)
          ? [...error.details, ...error.blockers.map(b => b.message)].slice(0, 3).join('; ')
          : error instanceof Error ? error.message : 'Export failed',
        variant: 'destructive'
      })
    } finally {
      setExporting(false)
    }
  }

  const locked = saving || view.stale
  const displayWidth = zoom === 'fit' ? pageWidth : W * zoom
  const scale = displayWidth / W

  // The crops as drawn: stored geometry with any in-flight drag/nudge on top.
  const crops = useMemo(
    () => readingOrder(state.crops.map(c => (preview[c.key] ? { ...c, bounds: preview[c.key] } : c))),
    [state.crops, preview]
  )

  const itemsByKey = useMemo(() => {
    const map: Record<string, typeof items> = {}
    for (const item of items) (map[item.key] ??= []).push(item)
    return map
  }, [items])

  const cropDone = useCallback((crop: Clipper3ReviewCrop) =>
    crop.disposition !== 'unreviewed' &&
    crop.disposition !== 'unresolved' &&
    crop.description_status === 'approved' &&
    (itemsByKey[crop.key] ?? []).every(i => i.acknowledged), [itemsByKey])

  const colorFor = useCallback((crop: Clipper3ReviewCrop) => {
    if (cropDone(crop)) return BOX_COLORS.done
    return (itemsByKey[crop.key] ?? []).some(i => !i.acknowledged) ? BOX_COLORS.open : BOX_COLORS.idle
  }, [cropDone, itemsByKey])

  const doneCount = state.crops.filter(cropDone).length

  // Keep the selection to crops that still exist (after a delete, undo, merge…).
  useEffect(() => {
    setSelected(prev => {
      const next = prev.filter(k => state.crops.some(c => c.key === k))
      return next.length === prev.length ? prev : next
    })
  }, [state.crops])

  // ---- Saving

  /**
   * Saves a whole next state against the stored revision. `record` pushes the
   * state it replaces onto the undo stack (undo/redo pass false and manage the
   * stacks themselves).
   */
  const commit = useCallback(async (next: Snapshot, opts: { record?: boolean; after?: () => void } = {}) => {
    if (view.stale) return false
    const before: Snapshot = { crops: state.crops, page: state.page }
    setSaving(true)
    try {
      const saved = await clipper3Api.saveReview(chapterId, filename, { ...state, ...next }, state.review_revision)
      onView(saved)
      if (opts.record !== false) {
        setPast(prev => [...prev.slice(-99), before])
        setFuture([])
      }
      opts.after?.()
      return true
    } catch (error) {
      if (error instanceof Clipper3ReviewSaveError && error.current) onView(error.current)
      toast({
        title: error instanceof Clipper3ReviewSaveError && error.status === 409 ? 'Review changed elsewhere' : 'Not saved',
        description: error instanceof Clipper3ReviewSaveError && error.details.length > 0
          ? error.details.slice(0, 3).join('; ')
          : error instanceof Error ? error.message : 'Save failed',
        variant: 'destructive'
      })
      return false
    } finally {
      setPreview({})
      setSaving(false)
    }
  }, [chapterId, filename, state, view.stale, onView, toast])

  const mutateCrops = (change: (crops: Clipper3ReviewCrop[]) => Clipper3ReviewCrop[], after?: () => void) => {
    if (locked) return
    commit({ crops: change(state.crops), page: state.page }, { after })
  }

  const updateCrop = (key: string, change: (crop: Clipper3ReviewCrop) => Clipper3ReviewCrop, after?: () => void) =>
    mutateCrops(list => list.map(c => (c.key === key ? change(c) : c)), after)

  const setPage = (change: Partial<Clipper3ReviewState['page']>) => {
    if (locked) return
    commit({ crops: state.crops, page: { ...state.page, ...change } })
  }

  const undo = () => {
    if (locked || past.length === 0) return
    const target = past[past.length - 1]
    const current: Snapshot = { crops: state.crops, page: state.page }
    commit(target, { record: false }).then(ok => {
      if (!ok) return
      setPast(prev => prev.slice(0, -1))
      setFuture(prev => [...prev, current])
    })
  }

  const redo = () => {
    if (locked || future.length === 0) return
    const target = future[future.length - 1]
    const current: Snapshot = { crops: state.crops, page: state.page }
    commit(target, { record: false }).then(ok => {
      if (!ok) return
      setFuture(prev => prev.slice(0, -1))
      setPast(prev => [...prev, current])
    })
  }

  // ---- Box edits

  const select = (keys: string[], scrollCard = true) => {
    setSelected(keys)
    if (scrollCard && keys.length > 0) {
      cardRefs.current[keys[keys.length - 1]]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }

  /** Selects from the list and brings the box into view. */
  const focusCrop = (key: string) => {
    setSelected([key])
    const crop = state.crops.find(c => c.key === key)
    if (crop) viewerRef.current?.scrollTo({ top: Math.max(0, crop.bounds.y0 * scale - 40), behavior: 'smooth' })
  }

  const deleteSelected = () => {
    if (selected.length === 0) return
    mutateCrops(list => withDeleted(list, selected), () => setSelected([]))
  }

  const mergeSelected = () => {
    const result = withMerged(state.crops, selected)
    if (!result) return
    mutateCrops(() => result.crops, () => setSelected([result.key]))
  }

  const split = (key: string, axis: 'h' | 'v', at: number) => {
    const result = withSplit(state.crops, key, axis, at)
    if (!result) {
      toast({ title: 'Cannot split there', description: 'Both halves must be at least 8 px.', variant: 'destructive' })
      return
    }
    mutateCrops(() => result.crops, () => { setSelected([result.keys[0]]); setTool('select') })
  }

  const draw = (bounds: PxBox) => {
    const result = withAdded(state.crops, bounds)
    mutateCrops(() => result.crops, () => { setSelected([result.key]); setTool('select') })
  }

  const nudge = (dx: number, dy: number) => {
    if (locked || selected.length !== 1) return
    const key = selected[0]
    const crop = crops.find(c => c.key === key)
    if (!crop) return
    const moved = moveBox(crop.bounds, dx, dy, W, H)
    setPreview(prev => ({ ...prev, [key]: moved }))
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current)
    nudgeTimer.current = setTimeout(() => {
      nudgeTimer.current = null
      mutateCrops(list => withBounds(list, key, moved))
    }, NUDGE_SAVE_MS)
  }

  useEffect(() => () => { if (nudgeTimer.current) clearTimeout(nudgeTimer.current) }, [])

  // ---- Keyboard (PRD §9.3)

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {})
  keyHandler.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    const mod = e.metaKey || e.ctrlKey
    const key = e.key

    if (key === 'Escape') {
      // Swallowed before the dialog sees it only when there is something to cancel.
      if (tool !== 'select' || selected.length > 0) {
        e.preventDefault()
        e.stopPropagation()
        setTool('select')
        setSelected([])
      }
      return
    }
    if (mod && key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
    if (mod && key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
    if (mod) return

    const ordered = crops.map(c => c.key)
    const current = selected.length > 0 ? ordered.indexOf(selected[selected.length - 1]) : -1
    switch (key) {
      case 'j': case 'J': e.preventDefault(); if (ordered.length) focusCrop(ordered[Math.min(ordered.length - 1, current + 1)]); break
      case 'k': case 'K': e.preventDefault(); if (ordered.length) focusCrop(ordered[Math.max(0, current - 1)]); break
      case 'v': setTool('select'); break
      case 'd': setTool('draw'); break
      case 'h': setTool('split-h'); break
      case 'H': setTool('split-v'); break
      case 'm': case 'M': mergeSelected(); break
      case 'Delete': case 'Backspace': e.preventDefault(); deleteSelected(); break
      case 'o': case 'O': setShowOverlay(v => !v); break
      case 'f': case 'F': setZoom('fit'); break
      case '1': setZoom(1); break
      case '2': setZoom(2); break
      case 'ArrowUp': e.preventDefault(); nudge(0, e.shiftKey ? -10 : -1); break
      case 'ArrowDown': e.preventDefault(); nudge(0, e.shiftKey ? 10 : 1); break
      case 'ArrowLeft': e.preventDefault(); nudge(e.shiftKey ? -10 : -1, 0); break
      case 'ArrowRight': e.preventDefault(); nudge(e.shiftKey ? 10 : 1, 0); break
    }
  }

  useEffect(() => {
    // Capture phase on window runs before the dialog's own Escape handling.
    const listener = (e: KeyboardEvent) => keyHandler.current(e)
    window.addEventListener('keydown', listener, true)
    return () => window.removeEventListener('keydown', listener, true)
  }, [])

  const clearDraft = (setter: typeof setDrafts, key: string) => setter(prev => {
    const next = { ...prev }
    delete next[key]
    return next
  })

  const primary = selected.length === 1 ? crops.find(c => c.key === selected[0]) : undefined
  const toolButton = (value: ReviewTool, label: string, icon: React.ReactNode, hint: string) => (
    <Button
      size="sm"
      variant={tool === value ? 'default' : 'outline'}
      className="h-7 px-2 text-xs"
      title={hint}
      onClick={() => setTool(value)}
    >
      {icon}<span className="ml-1 hidden xl:inline">{label}</span>
    </Button>
  )

  return (
    <div className="flex gap-4 h-full min-h-0">
      {/* Editor column */}
      <div className="flex flex-col gap-2 min-h-0 flex-shrink-0" style={{ width: pageWidth + 18 }}>
        <div className="flex flex-wrap items-center gap-1">
          {toolButton('select', 'Select', <MousePointer2 className="h-3.5 w-3.5" />, 'Select, move and resize (V)')}
          {toolButton('draw', 'Draw', <PlusSquare className="h-3.5 w-3.5" />, 'Draw a new crop (D)')}
          {toolButton('split-h', 'Split', <SeparatorHorizontal className="h-3.5 w-3.5" />, 'Split the selected crop across — click inside it where to cut (H)')}
          {toolButton('split-v', 'Split', <SeparatorVertical className="h-3.5 w-3.5" />, 'Split the selected crop down — click inside it where to cut (⇧H)')}
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={locked || selected.length < 2} onClick={mergeSelected} title="Merge the selected crops (M); shift-click boxes to select several">
            <Combine className="h-3.5 w-3.5" /><span className="ml-1">{selected.length >= 2 ? selected.length : ''}</span>
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={locked || selected.length === 0} onClick={deleteSelected} title="Delete the selected crops (⌫)">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          <span className="w-px h-5 bg-border mx-1" />
          <Button size="sm" variant="outline" className="h-7 px-2" disabled={locked || past.length === 0} onClick={undo} title="Undo (⌘Z)">
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2" disabled={locked || future.length === 0} onClick={redo} title="Redo (⇧⌘Z)">
            <Redo2 className="h-3.5 w-3.5" />
          </Button>
          <span className="w-px h-5 bg-border mx-1" />
          {(['fit', 1, 2] as Zoom[]).map(z => (
            <Button key={String(z)} size="sm" variant={zoom === z ? 'default' : 'outline'} className="h-7 px-2 text-xs" onClick={() => setZoom(z)} title={z === 'fit' ? 'Fit width (F)' : `${z * 100}% — source pixels (${z})`}>
              {z === 'fit' ? 'Fit' : `${z * 100}%`}
            </Button>
          ))}
          <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setShowOverlay(v => !v)} title="Hide / show boxes (O)">
            {showOverlay ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </Button>
          <Button size="sm" variant={showShortcuts ? 'default' : 'ghost'} className="h-7 px-2" onClick={() => setShowShortcuts(v => !v)} title="Keyboard shortcuts">
            <Keyboard className="h-3.5 w-3.5" />
          </Button>
          {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground ml-1" />}
        </div>

        {showShortcuts && (
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] rounded border p-2">
            {SHORTCUTS.map(([keys, what]) => (
              <span key={keys} className="contents">
                <span className="font-mono text-muted-foreground">{keys}</span>
                <span>{what}</span>
              </span>
            ))}
          </div>
        )}

        <p className="font-mono text-[11px] text-muted-foreground h-4 truncate">
          {primary
            ? `${primary.key} · (${primary.bounds.x0}, ${primary.bounds.y0}) → (${primary.bounds.x1}, ${primary.bounds.y1}) · ${primary.bounds.x1 - primary.bounds.x0}×${primary.bounds.y1 - primary.bounds.y0} px`
            : selected.length > 1
              ? `${selected.length} crops selected — M to merge, ⌫ to delete`
              : tool === 'draw' ? 'Drag on the page to add a crop'
                : tool !== 'select' ? 'Select a crop, then click inside it where to cut'
                  : 'Click a box to select · shift-click to select several'}
        </p>

        <ReviewCanvas
          chapterId={chapterId}
          filename={filename}
          W={W}
          H={H}
          crops={crops}
          gaps={audit?.gaps ?? []}
          colorFor={colorFor}
          selected={selected}
          onSelect={keys => select(keys)}
          tool={tool}
          displayWidth={displayWidth}
          showOverlay={showOverlay}
          locked={locked}
          onPreview={(key, bounds) => setPreview(prev => {
            const next = { ...prev }
            if (bounds) next[key] = bounds
            else delete next[key]
            return next
          })}
          onCommitBounds={(key, bounds) => mutateCrops(list => withBounds(list, key, bounds))}
          onDraw={draw}
          onSplit={split}
          viewerRef={viewerRef}
        />
      </div>

      {/* Review panel */}
      <div className="flex-1 min-w-0 overflow-y-auto pr-1 space-y-3">
        {view.stale && (
          <div className="rounded border border-amber-500/60 bg-amber-500/10 p-2 text-xs space-y-2">
            <p className="text-amber-500">
              <AlertTriangle className="inline h-3 w-3 mr-1" />
              {view.staleReasons.join('; ')}. This review can no longer be edited.
            </p>
            <Button size="sm" variant="outline" onClick={() => onRestart(state.based_on.kind === 'chatgpt_import' ? 'import' : 'pointers')}>
              <RotateCcw className="h-3 w-3 mr-1" /> Restart review
            </Button>
          </div>
        )}
        {view.newerImportAvailable && !view.stale && (
          <div className="rounded border p-2 text-xs flex items-center gap-2">
            <span className="flex-1">A newer ChatGPT reply was imported after this review started.</span>
            <Button size="sm" variant="outline" onClick={() => onRestart('import')}>
              <RotateCcw className="h-3 w-3 mr-1" /> Restart from it
            </Button>
          </div>
        )}

        {/* What export is waiting for. */}
        <div className="rounded border p-2 space-y-2" data-review-summary>
          <div className="flex items-center gap-2">
            {readiness.ready ? (
              <p className="text-sm text-green-500 flex-1">
                <CheckCircle2 className="inline h-4 w-4 mr-1" /> Review complete — ready for export
              </p>
            ) : (
              <button type="button" className="text-sm text-left flex-1" onClick={() => setShowBlockers(v => !v)}>
                <AlertTriangle className="inline h-4 w-4 mr-1 text-amber-500" />
                {readiness.blockers.length} thing{readiness.blockers.length === 1 ? '' : 's'} before export ·{' '}
                {doneCount}/{state.crops.length} crops done
                <span className="text-xs text-muted-foreground ml-1">({showBlockers ? 'hide' : 'show'})</span>
              </button>
            )}
            <span className="font-mono text-[11px] text-muted-foreground">rev {state.review_revision}</span>
          </div>
          {readiness.ready && (
            <div className="flex items-center gap-2">
              <Button size="sm" className="h-8" disabled={locked || exporting} onClick={runExport}>
                {exporting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <PackageCheck className="h-4 w-4 mr-1" />}
                {exportStatus?.report ? 'Export again' : 'Export page'}
              </Button>
              {exportStatus?.report && (
                <Button size="sm" variant="outline" className="h-8" onClick={() => clipper3Api.openExportFolder(chapterId, filename).catch(() => {})}>
                  <FolderOpen className="h-4 w-4 mr-1" /> Open crops
                </Button>
              )}
            </div>
          )}
          {exportStatus?.report && (
            <p className={`text-[11px] ${exportStatus.upToDate ? 'text-muted-foreground' : 'text-amber-500'}`}>
              {exportStatus.upToDate ? (
                <><CheckCircle2 className="inline h-3 w-3 mr-1 text-green-500" />Exported this revision</>
              ) : (
                <><AlertTriangle className="inline h-3 w-3 mr-1" />Last export was revision {exportStatus.report.review_revision} — the review changed since; export again</>
              )}
              {' · '}{exportStatus.report.crop_count} crops · {new Date(exportStatus.report.exported_at).toLocaleString()}
            </p>
          )}
          {showBlockers && !readiness.ready && (
            <ul className="text-xs space-y-0.5 max-h-40 overflow-y-auto">
              {readiness.blockers.map((b, i) => (
                <li key={i}>
                  {b.key ? (
                    <button type="button" className="text-left hover:underline" onClick={() => focusCrop(b.key!)}>{b.message}</button>
                  ) : b.message}
                </li>
              ))}
            </ul>
          )}
          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <Checkbox
              checked={state.page.sweep_done}
              disabled={locked}
              onCheckedChange={checked => setPage({ sweep_done: checked === true })}
            />
            <span>
              I swept the whole page top to bottom — small inserts, grayscale, objects and effects shots, and every
              striped uncovered stretch.
            </span>
          </label>
          {state.crops.length === 0 && (
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <Checkbox
                checked={state.page.no_eligible_artwork_confirmed}
                disabled={locked}
                onCheckedChange={checked => setPage({ no_eligible_artwork_confirmed: checked === true })}
              />
              <span>This page has no artwork that should be cropped.</span>
            </label>
          )}
        </div>

        {/* Uncovered stretches: pointers for the sweep, never verdicts. */}
        {audit && audit.gaps.length > 0 && (
          <div className="text-xs space-y-1">
            <p className="text-muted-foreground">Stretches no crop covers (non-blank rows can be art, bubbles or SFX):</p>
            {audit.gaps.map(gap => (
              <button
                key={gap.y0}
                type="button"
                onClick={() => viewerRef.current?.scrollTo({ top: Math.max(0, gap.y0 * scale - 40), behavior: 'smooth' })}
                className="block font-mono text-[11px] hover:underline"
              >
                y {gap.y0}–{gap.y1} ({gap.y1 - gap.y0} px)
                {gap.nonBlankShare !== null && ` · ${Math.round(gap.nonBlankShare * 100)}% non-blank`}
              </button>
            ))}
          </div>
        )}

        {crops.map((crop, i) => {
          const cropItems = itemsByKey[crop.key] ?? []
          const draft = drafts[crop.key]
          const text = draft ?? crop.description
          const edited = draft !== undefined && draft.trim() !== crop.description
          const reasonDraft = reasonDrafts[crop.key]
          const isSelected = selected.includes(crop.key)
          const saveReason = () => {
            if (reasonDraft === undefined) return
            if (!reasonDraft.trim() || reasonDraft.trim() === crop.reason) return clearDraft(setReasonDrafts, crop.key)
            updateCrop(crop.key, c => ({ ...c, reason: reasonDraft.trim() }), () => clearDraft(setReasonDrafts, crop.key))
          }
          return (
            <div
              key={crop.key}
              ref={el => { cardRefs.current[crop.key] = el }}
              data-crop-card={crop.key}
              onClick={e => {
                if ((e.target as HTMLElement).closest('input, textarea, button, label')) return
                focusCrop(crop.key)
              }}
              className={`rounded border p-2 space-y-2 ${isSelected ? 'border-yellow-400 bg-yellow-400/5' : ''}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-xs font-semibold w-6 flex-shrink-0">{i + 1}</span>
                {cropDone(crop) && <Check className="h-3 w-3 text-green-500 flex-shrink-0" />}
                <Input
                  value={reasonDraft ?? crop.reason}
                  disabled={locked}
                  onChange={e => setReasonDrafts(prev => ({ ...prev, [crop.key]: e.target.value }))}
                  onBlur={saveReason}
                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  className="h-7 font-mono text-xs flex-1 min-w-0"
                  title="Reason — becomes the filename suffix at export"
                />
                <span className="font-mono text-[11px] text-muted-foreground flex-shrink-0">
                  {crop.bounds.x1 - crop.bounds.x0}×{crop.bounds.y1 - crop.bounds.y0}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 flex-shrink-0"
                  disabled={locked}
                  title="Delete this crop"
                  onClick={() => mutateCrops(list => withDeleted(list, [crop.key]))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-1">
                <Button
                  size="sm"
                  variant={crop.disposition === 'kept' ? 'default' : 'outline'}
                  className="h-7 text-xs"
                  disabled={locked}
                  onClick={() => updateCrop(crop.key, c => ({ ...c, disposition: 'kept' }))}
                  title="The box is right as it is — including a tall scene that should stay one continuous crop"
                >
                  Keep
                </Button>
                <Button
                  size="sm"
                  variant={crop.disposition === 'unresolved' ? 'default' : 'outline'}
                  className="h-7 text-xs"
                  disabled={locked}
                  onClick={() => updateCrop(crop.key, c => ({ ...c, disposition: 'unresolved' }))}
                  title="Needs more work before export"
                >
                  <HelpCircle className="h-3 w-3 mr-1" /> Unresolved
                </Button>
                {['adjusted', 'split', 'merged'].includes(crop.disposition) && (
                  <Badge variant="outline" className="text-[10px]" title="Edited in this review — counts as reviewed">
                    {crop.disposition}
                  </Badge>
                )}
                {/* Split halves and merges are operator keys too, but their
                    split/merged badge already says where they came from. */}
                {(crop.origin === 'existing_pointers' || (crop.origin === 'operator' && /^op-\d+/.test(crop.key))) && (
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">
                    {crop.origin === 'operator' ? 'drawn by you' : 'from existing pointers'}
                  </Badge>
                )}
                <span className="font-mono text-[10px] text-muted-foreground ml-auto">{crop.key}</span>
              </div>

              {cropItems.length > 0 && (
                <div className="space-y-1">
                  {cropItems.map(item => (
                    <label key={item.token} className="flex items-start gap-2 text-xs cursor-pointer">
                      <Checkbox
                        checked={item.acknowledged}
                        disabled={locked}
                        onCheckedChange={checked => updateCrop(crop.key, c => ({
                          ...c,
                          acknowledged: checked === true
                            ? [...new Set([...c.acknowledged, item.token])]
                            : c.acknowledged.filter(t => t !== item.token)
                        }))}
                      />
                      <span className={item.acknowledged ? 'text-muted-foreground line-through' : ''}>
                        <Badge variant="outline" className={`text-[9px] mr-1 px-1 py-0 ${item.source === 'chatgpt' ? 'border-sky-500 text-sky-500' : 'border-amber-500 text-amber-500'}`}>
                          {item.source === 'chatgpt' ? 'ChatGPT' : 'check'}
                        </Badge>
                        {item.message}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {crop.unknown_flags.length > 0 && (
                <p className="text-[11px] text-muted-foreground">ChatGPT notes: {crop.unknown_flags.join(', ')}</p>
              )}

              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={`text-[10px] ${STATUS_STYLE[crop.description_status]}`}>
                    description {crop.description_status}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground">
                    {text.trim() ? `${text.trim().split(/\s+/).length} words` : ''}
                  </span>
                </div>
                <Textarea
                  value={text}
                  disabled={locked}
                  rows={2}
                  className="text-xs min-h-0"
                  placeholder="One plain sentence, 12–35 words, describing only what is visible."
                  onChange={e => setDrafts(prev => ({ ...prev, [crop.key]: e.target.value }))}
                />
                <div className="flex gap-1">
                  {(edited || crop.description_status !== 'approved') && (
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      disabled={locked || !text.trim()}
                      onClick={() => updateCrop(crop.key, c => ({ ...c, description: text.trim(), description_status: 'approved' }), () => clearDraft(setDrafts, crop.key))}
                    >
                      {edited ? 'Save & approve' : 'Approve description'}
                    </Button>
                  )}
                  {edited && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={locked}
                      onClick={() => updateCrop(crop.key, c => ({ ...c, description: text.trim(), description_status: 'unreviewed' }), () => clearDraft(setDrafts, crop.key))}
                    >
                      Save draft
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
