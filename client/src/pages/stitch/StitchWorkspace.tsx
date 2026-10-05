import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, MouseEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { stitchApi, StitchChapterState, StitchPage } from '@/lib/api'
import {
  DropTarget,
  Groups,
  autoGroups,
  joinWithPrevious,
  moveImages,
  outOfOrderGroups,
  outputGroups,
  splitGroup,
  stitchedSize
} from '@/lib/stitchPlan'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import ChapterSwitcher from '@/components/ChapterSwitcher'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRightToLine,
  CheckCircle,
  Eye,
  EyeOff,
  Layers,
  Loader2,
  Plus,
  RotateCcw,
  Scissors,
  Trash2,
  Undo2,
  Wand2,
  X
} from 'lucide-react'

/** Default output height: normal chapter pages run ~10–15k px. */
const DEFAULT_TARGET = 12000

/** Layout edits kept for Undo. */
const HISTORY_LIMIT = 50

interface Layout {
  groups: Groups
  excluded: Set<string>
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export default function StitchWorkspace() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()

  const [state, setState] = useState<StitchChapterState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'stitch' | 'undo' | 'discard' | null>(null)

  const [target, setTarget] = useState(String(DEFAULT_TARGET))
  const [columnWidth, setColumnWidth] = useState(140)
  const [layout, setLayout] = useState<Layout>({ groups: [], excluded: new Set() })
  const [history, setHistory] = useState<Layout[]>([])
  const [previewGroup, setPreviewGroup] = useState<number | null>(null)

  // Selection: page indices, with an anchor for Shift-click ranges.
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const anchor = useRef<number | null>(null)

  // Drag and drop. Refs carry the values into the drop handler; state drives the styling.
  const [dragging, setDragging] = useState<number[] | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const dragRef = useRef<number[] | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const dropRef = useRef<DropTarget | null>(null)

  const { groups, excluded } = layout

  // Switching chapter keeps this component mounted: drop the old chapter's state.
  useEffect(() => {
    setState(null)
    setLoading(true)
    setPreviewGroup(null)
  }, [id])

  const load = useCallback(async () => {
    if (!id) return
    try {
      const data = await stitchApi.getChapter(id)
      setState(data)
      setLayout({ groups: autoGroups(data.pages, new Set(), DEFAULT_TARGET), excluded: new Set() })
      setHistory([])
      setSelected(new Set())
      setTarget(String(DEFAULT_TARGET))
    } catch (error) {
      toast({
        title: 'Could not load the chapter',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }, [id, toast])

  useEffect(() => {
    load()
  }, [load])

  /** Apply a layout edit, keeping the previous layout for Undo. */
  const commit = (next: Partial<Layout>) => {
    const merged = { ...layout, ...next }
    if (JSON.stringify(merged.groups) === JSON.stringify(layout.groups) && merged.excluded === layout.excluded) return
    setHistory(h => [...h.slice(-(HISTORY_LIMIT - 1)), layout])
    setLayout(merged)
  }

  const undoLayout = useCallback(() => {
    if (history.length === 0) return
    setLayout(history[history.length - 1])
    setHistory(history.slice(0, -1))
  }, [history])

  // ⌘Z / Ctrl+Z undoes a layout edit; Escape clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if (typing) return
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undoLayout()
      } else if (e.key === 'Escape') {
        setSelected(new Set())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoLayout])

  const pages = state?.pages ?? []
  const maxHeight = state?.maxHeight ?? 16383
  const flat = useMemo(() => groups.flat(), [groups])
  const outputs = useMemo(
    () =>
      groups.map(group => {
        const kept = group.map(i => pages[i]).filter(p => p && !excluded.has(p.filename))
        const size = stitchedSize(kept)
        return { kept, ...size, overLimit: kept.length > 1 && size.height > maxHeight }
      }),
    [groups, pages, excluded, maxHeight]
  )
  const outputNumbers = useMemo(() => {
    let n = 0
    return outputs.map(o => (o.kept.length > 0 ? ++n : 0))
  }, [outputs])
  const unordered = useMemo(
    () => outOfOrderGroups(groups, i => excluded.has(pages[i]?.filename)),
    [groups, excluded, pages]
  )
  const outputCount = outputNumbers.filter(n => n > 0).length
  const overLimit = outputs.filter(o => o.overLimit).length
  const tallest = Math.max(0, ...outputs.map(o => o.height))

  const applyAuto = () => {
    const value = Number(target)
    if (!Number.isFinite(value) || value < 500) {
      toast({ title: 'Enter a target height of at least 500 px', variant: 'destructive' })
      return
    }
    commit({ groups: autoGroups(pages, excluded, Math.min(value, maxHeight)) })
  }

  const toggleExcluded = (filename: string) => {
    const next = new Set(excluded)
    if (next.has(filename)) next.delete(filename)
    else next.add(filename)
    commit({ excluded: next })
  }

  // ---- Selection ----

  const handleThumbClick = (index: number, e: MouseEvent) => {
    if (e.shiftKey && anchor.current !== null) {
      const a = flat.indexOf(anchor.current)
      const b = flat.indexOf(index)
      const [from, to] = a < b ? [a, b] : [b, a]
      setSelected(new Set(flat.slice(from, to + 1)))
      return
    }
    anchor.current = index
    if (e.metaKey || e.ctrlKey) {
      setSelected(prev => {
        const next = new Set(prev)
        if (next.has(index)) next.delete(index)
        else next.add(index)
        return next
      })
    } else {
      setSelected(prev => (prev.size === 1 && prev.has(index) ? new Set() : new Set([index])))
    }
  }

  // ---- Drag and drop ----

  const setDrop = (next: DropTarget | null) => {
    if (sameTarget(dropRef.current, next)) return
    dropRef.current = next
    setDropTarget(next)
  }

  const handleDragStart = (index: number, e: DragEvent) => {
    const moving = selected.has(index) ? flat.filter(i => selected.has(i)) : [index]
    if (!selected.has(index)) setSelected(new Set([index]))
    dragRef.current = moving
    setDragging(moving)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', `${moving.length} images`)

    if (moving.length > 1) {
      // A small label instead of the browser's ghost of one thumbnail.
      const ghost = document.createElement('div')
      ghost.textContent = `${moving.length} images`
      ghost.style.cssText =
        'position:fixed;top:-100px;left:-100px;padding:4px 10px;border-radius:9999px;background:#7c3aed;color:#fff;font:600 12px system-ui'
      document.body.appendChild(ghost)
      e.dataTransfer.setDragImage(ghost, 10, 10)
      setTimeout(() => ghost.remove(), 0)
    }
  }

  // While dragging, holding the pointer near an edge scrolls: the column strip
  // sideways, the page up or down. dragover only reports where the pointer
  // is; a frame loop does the scrolling so it continues while the pointer rests.
  useEffect(() => {
    if (!dragging) return
    const strip = stripRef.current
    let page: HTMLElement | null = strip?.parentElement ?? null
    while (page && !/(auto|scroll)/.test(getComputedStyle(page).overflowY)) page = page.parentElement
    const EDGE = 80
    const step = (distance: number) => Math.ceil(((EDGE - Math.max(0, distance)) / EDGE) * 18)

    let pointer: { x: number; y: number } | null = null
    const onDragOver = (e: globalThis.DragEvent) => {
      const overDock = (e.target as Element | null)?.closest?.('[data-drop-dock]')
      pointer = overDock ? null : { x: e.clientX, y: e.clientY }
    }

    let frame = requestAnimationFrame(function tick() {
      if (pointer) {
        const { x, y } = pointer
        if (strip) {
          const r = strip.getBoundingClientRect()
          if (y >= r.top && y <= r.bottom) {
            if (x > r.right - EDGE) strip.scrollLeft += step(r.right - x)
            else if (x < r.left + EDGE) strip.scrollLeft -= step(x - r.left)
          }
        }
        if (page) {
          const r = page.getBoundingClientRect()
          if (y > r.bottom - EDGE) page.scrollTop += step(r.bottom - y)
          else if (y < r.top + EDGE) page.scrollTop -= step(y - r.top)
        }
      }
      frame = requestAnimationFrame(tick)
    })

    // Capture phase: the drop zones stop propagation, which would hide the event from a bubbling listener.
    window.addEventListener('dragover', onDragOver, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('dragover', onDragOver, true)
    }
  }, [dragging])

  const endDrag = () => {
    dragRef.current = null
    setDragging(null)
    setDrop(null)
  }

  /** Over a thumbnail: before it in its top half, after it in its bottom half. */
  const handleThumbDragOver = (group: number, position: number, e: DragEvent) => {
    if (!dragRef.current) return
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const after = e.clientY > rect.top + rect.height / 2
    setDrop({ group, index: position + (after ? 1 : 0) })
  }

  const handleZoneDragOver = (next: DropTarget, e: DragEvent) => {
    if (!dragRef.current) return
    e.preventDefault()
    e.stopPropagation()
    setDrop(next)
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    const moving = dragRef.current
    const to = dropRef.current
    endDrag()
    if (!moving || !to) return
    commit({ groups: moveImages(groups, moving, to) })
  }

  // ---- Server actions ----

  const run = async (kind: 'stitch' | 'undo' | 'discard') => {
    if (!id) return
    setBusy(kind)
    try {
      if (kind === 'stitch') {
        const result = await stitchApi.stitch(id, outputGroups(pages, groups, excluded))
        toast({
          title: 'Chapter stitched',
          description: `${result.originalPages} pages → ${result.stitchedPages} pages. The originals are backed up until you delete them.`
        })
      } else if (kind === 'undo') {
        await stitchApi.undo(id)
        toast({ title: 'Stitch undone', description: 'The original pages are back.' })
      } else {
        await stitchApi.discardBackup(id)
        toast({ title: 'Originals deleted', description: 'The stitched pages are now the chapter’s pages.' })
      }
      await load()
    } catch (error) {
      toast({
        title: kind === 'stitch' ? 'Stitch failed' : kind === 'undo' ? 'Undo failed' : 'Delete failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive'
      })
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!state || !id) {
    return (
      <div className="p-6 text-center">
        <h2 className="text-xl font-semibold">Chapter not found</h2>
        <Button variant="link" onClick={() => navigate('/stitch')}>
          Back to Page Stitcher
        </Button>
      </div>
    )
  }

  const record = state.record
  const thumb = (p: StitchPage) => stitchApi.thumbUrl(id, p.filename, String(p.bytes))
  const movingSet = new Set(dragging ?? [])

  /** A thin drop slot between columns that starts a new page there. */
  const gapSlot = (at: number) => {
    const active = dropTarget !== null && 'newGroupAt' in dropTarget && dropTarget.newGroupAt === at
    return (
      <div
        key={`gap-${at}`}
        className={`shrink-0 self-stretch rounded transition-all ${
          active ? 'w-10 bg-primary/20 border-2 border-dashed border-primary' : dragging ? 'w-6' : 'w-4'
        }`}
        title="Drop here to start a new page"
        onDragOver={e => handleZoneDragOver({ newGroupAt: at }, e)}
      />
    )
  }

  const dropLine = (
    <div className="relative h-0 z-20 pointer-events-none">
      <div className="absolute inset-x-0 -top-[3px] h-1.5 rounded-full bg-primary shadow-[0_0_0_2px_rgba(255,255,255,0.8)]" />
    </div>
  )

  return (
    <div
      className="p-6"
      onDragOver={e => {
        if (!dragRef.current) return
        e.preventDefault()
        // Drop zones stop propagation, so anything reaching here is not a target.
        setDrop(null)
      }}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="flex items-start gap-4 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate('/stitch')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <Layers className="h-7 w-7 text-primary" />
            Stitch pages
          </h1>
          <p className="text-muted-foreground truncate">
            {state.seriesTitle} · Chapter {state.number}
            {state.title ? ` — ${state.title}` : ''}
          </p>
        </div>
        <ChapterSwitcher
          neighbours={state.neighbours}
          to={chapterId => `/stitch/chapter/${chapterId}`}
          canLeave={() => history.length === 0 || confirm('Leave this chapter? Your unstitched layout changes will be lost.')}
        />
      </div>

      {state.blockers.length > 0 && (
        <Card className="mb-4 border-amber-500/50 bg-amber-500/10">
          <CardContent className="py-3 space-y-1">
            {state.blockers.map(b => (
              <p key={b} className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                {b}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      {record ? (
        <>
          {/* Already stitched: show the result and the backup actions */}
          <Card className="mb-6 border-emerald-500/40 bg-emerald-500/5">
            <CardContent className="py-4 flex flex-wrap items-center gap-4">
              <CheckCircle className="h-6 w-6 text-emerald-500 shrink-0" />
              <div className="flex-1 min-w-[16rem]">
                <p className="font-medium">
                  Stitched {record.originals.length} pages into {record.outputs.length}
                  {record.excluded.length > 0 && ` (${record.excluded.length} dropped)`}
                </p>
                <p className="text-sm text-muted-foreground">
                  {new Date(record.stitchedAt).toLocaleString()} · The originals ({formatBytes(state.backupBytes)}) are
                  kept in a hidden backup inside the chapter folder until you delete them.
                </p>
              </div>
              <Button variant="outline" onClick={() => run('undo')} disabled={busy !== null}>
                {busy === 'undo' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-2" />}
                Undo stitch
              </Button>
              <Button
                variant="outline"
                className="text-destructive hover:text-destructive"
                disabled={busy !== null}
                onClick={() => {
                  if (confirm(`Delete the ${record.originals.length} original pages? The stitch can no longer be undone.`)) {
                    run('discard')
                  }
                }}
              >
                {busy === 'discard' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
                Delete originals
              </Button>
            </CardContent>
          </Card>

          <ZoomControl value={columnWidth} onChange={setColumnWidth} />
          <div className="flex gap-4 overflow-x-auto pb-4 items-start">
            {pages.map((p, i) => (
              <div key={p.filename} className="shrink-0" style={{ width: columnWidth }}>
                <div className="mb-2 text-xs">
                  <div className="font-medium">Page {i + 1}</div>
                  <div className="text-muted-foreground">
                    {p.height.toLocaleString()} px · {record.outputs[i]?.sources.length ?? 1} img
                  </div>
                </div>
                <PageThumb src={thumb(p)} page={p} width={columnWidth} />
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          {/* Toolbar */}
          <Card className="mb-4 sticky top-0 z-30">
            <CardContent className="py-4 flex flex-wrap items-end gap-6">
              <div>
                <label className="text-sm font-medium">Target height per page</label>
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    type="number"
                    className="w-28 h-9"
                    value={target}
                    min={500}
                    max={maxHeight}
                    step={500}
                    onChange={e => setTarget(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && applyAuto()}
                  />
                  <span className="text-sm text-muted-foreground">px</span>
                  <Button variant="outline" size="sm" onClick={applyAuto} title="Regroup every page in reading order">
                    <Wand2 className="h-4 w-4 mr-2" />
                    Auto group
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={undoLayout}
                    disabled={history.length === 0}
                    title="Undo the last layout change (⌘Z)"
                  >
                    <Undo2 className="h-4 w-4 mr-2" />
                    Undo
                  </Button>
                </div>
              </div>

              <ZoomControl value={columnWidth} onChange={setColumnWidth} inline />

              <div className="flex-1 min-w-[12rem] text-sm">
                <div className="font-medium">
                  {pages.length} pages → {outputCount} page{outputCount === 1 ? '' : 's'}
                </div>
                <div className="text-muted-foreground">
                  Tallest {tallest.toLocaleString()} px (max {maxHeight.toLocaleString()})
                  {excluded.size > 0 && ` · ${excluded.size} dropped`}
                </div>
                {selected.size > 0 && (
                  <div className="flex items-center gap-1 text-primary">
                    {selected.size} selected — drag to move
                    <button
                      className="p-0.5 rounded hover:bg-accent"
                      title="Clear selection (Esc)"
                      onClick={() => setSelected(new Set())}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>

              <Button
                onClick={() => run('stitch')}
                disabled={busy !== null || overLimit > 0 || outputCount === 0 || state.blockers.length > 0}
              >
                {busy === 'stitch' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Layers className="h-4 w-4 mr-2" />}
                {busy === 'stitch' ? 'Stitching…' : `Stitch into ${outputCount} pages`}
              </Button>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground mb-3">
            Each column is one output page. <strong>Drag</strong> an image to any spot in any page, or into the gap
            between pages to start a new one. Click to select, ⌘/Ctrl-click to add, Shift-click for a range, then drag
            them together. Hover between two images and click <Scissors className="inline h-3 w-3" /> to cut, or{' '}
            use <ArrowLeftToLine className="inline h-3 w-3" /> / <ArrowRightToLine className="inline h-3 w-3" /> on a
            page to add all of it to the previous / next page. Nothing changes on disk until you
            stitch, and a stitch can be undone.
          </p>

          {overLimit > 0 && (
            <p className="flex items-center gap-2 text-sm text-destructive mb-3">
              <AlertTriangle className="h-4 w-4" />
              {overLimit} page{overLimit === 1 ? ' is' : 's are'} taller than {maxHeight.toLocaleString()} px. Cut or
              move images out of {overLimit === 1 ? 'it' : 'them'} before stitching.
            </p>
          )}

          {/* Output columns */}
          <div ref={stripRef} className="flex overflow-x-auto pb-4 items-start">
            {groups.map((group, g) => {
              const out = outputs[g]
              const lineAt = dropTarget && 'group' in dropTarget && dropTarget.group === g ? dropTarget.index : -1
              return (
                <Fragment key={group[0]}>
                  {(g > 0 || dragging) && gapSlot(g)}
                  <div
                    className="shrink-0"
                    style={{ width: columnWidth }}
                    // Anywhere else on the column: the end of this page.
                    onDragOver={e => handleZoneDragOver({ group: g, index: group.length }, e)}
                  >
                    <div
                      className="mb-2 text-xs"
                      onDragOver={e => handleZoneDragOver({ group: g, index: 0 }, e)}
                    >
                      <div className="flex items-center gap-1">
                        <div className={`flex-1 min-w-0 truncate font-medium ${out.overLimit ? 'text-destructive' : ''}`}>
                          {outputNumbers[g] > 0 ? `Page ${outputNumbers[g]}` : 'Dropped'}
                        </div>
                        <button
                          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
                          title="Add this whole page to the end of the previous page"
                          disabled={g === 0}
                          onClick={() => commit({ groups: joinWithPrevious(groups, g) })}
                        >
                          <ArrowLeftToLine className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
                          title="Add this whole page to the start of the next page"
                          disabled={g === groups.length - 1}
                          // Joining the next page onto this one puts this page's images first.
                          onClick={() => commit({ groups: joinWithPrevious(groups, g + 1) })}
                        >
                          <ArrowRightToLine className="h-3.5 w-3.5" />
                        </button>
                        {out.kept.length > 0 && (
                          <button
                            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                            title="Preview at full size"
                            onClick={() => setPreviewGroup(g)}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      <div className={`truncate ${out.overLimit ? 'text-destructive' : 'text-muted-foreground'}`}>
                        {out.kept.length} img · {out.height.toLocaleString()} px
                      </div>
                      {unordered.has(g) && (
                        <div
                          className="flex items-center gap-1 text-amber-600 dark:text-amber-400"
                          title="An image here comes earlier in the chapter than the one before it"
                        >
                          <AlertTriangle className="h-3 w-3 shrink-0" />
                          <span className="truncate">Out of reading order</span>
                        </div>
                      )}
                    </div>

                    <div
                      className={`rounded overflow-hidden border ${
                        out.overLimit ? 'border-destructive ring-1 ring-destructive' : 'border-border'
                      }`}
                    >
                      {group.map((pageIndex, k) => {
                        const p = pages[pageIndex]
                        return (
                          <Fragment key={p.filename}>
                            {lineAt === k && dropLine}
                            {k > 0 && !dragging && (
                              // Zero-height seam so the stack previews without gaps.
                              <div className="relative h-0 z-10 group/seam">
                                <button
                                  className="absolute inset-x-0 -top-2 h-4 flex items-center justify-center"
                                  title="Cut here: start a new page"
                                  onClick={() => commit({ groups: splitGroup(groups, g, k) })}
                                >
                                  <span className="absolute inset-x-0 top-1/2 border-t-2 border-dashed border-primary opacity-0 group-hover/seam:opacity-100" />
                                  <span className="relative rounded-full bg-primary text-primary-foreground p-0.5 opacity-0 group-hover/seam:opacity-100 shadow">
                                    <Scissors className="h-3 w-3" />
                                  </span>
                                </button>
                              </div>
                            )}
                            <PageThumb
                              src={thumb(p)}
                              page={p}
                              width={columnWidth}
                              label={`${pageIndex + 1}`}
                              excluded={excluded.has(p.filename)}
                              selected={selected.has(pageIndex)}
                              moving={movingSet.has(pageIndex)}
                              onToggleExcluded={() => toggleExcluded(p.filename)}
                              onClick={e => handleThumbClick(pageIndex, e)}
                              onDragStart={e => handleDragStart(pageIndex, e)}
                              onDragEnd={endDrag}
                              onDragOver={e => handleThumbDragOver(g, k, e)}
                            />
                          </Fragment>
                        )
                      })}
                      {lineAt === group.length && (
                        <div className="relative">
                          <div className="absolute inset-x-0 -top-[3px] h-1.5 rounded-full bg-primary pointer-events-none" />
                        </div>
                      )}
                    </div>
                  </div>
                </Fragment>
              )
            })}

            {dragging && gapSlot(groups.length)}
          </div>
        </>
      )}

      {/* While dragging: new-page targets that are always on screen */}
      {dragging && !record && (
        <div
          data-drop-dock
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex gap-3 rounded-xl border bg-background/95 p-2 shadow-2xl backdrop-blur"
        >
          {[
            { at: 0, label: 'New first page' },
            { at: groups.length, label: 'New last page' }
          ].map(({ at, label }) => {
            const active = dropTarget !== null && 'newGroupAt' in dropTarget && dropTarget.newGroupAt === at
            return (
              <div
                key={label}
                className={`flex items-center gap-2 rounded-lg border-2 border-dashed px-5 py-3 text-sm ${
                  active ? 'border-primary bg-primary/15 text-primary' : 'border-muted-foreground/40 text-muted-foreground'
                }`}
                onDragOver={e => handleZoneDragOver({ newGroupAt: at }, e)}
              >
                <Plus className="h-4 w-4" />
                {label}
              </div>
            )
          })}
          <div className="self-center px-2 text-xs text-muted-foreground">
            Moving {dragging.length} image{dragging.length === 1 ? '' : 's'}
          </div>
        </div>
      )}

      {/* Full-size preview of one output page */}
      <Dialog open={previewGroup !== null} onOpenChange={open => !open && setPreviewGroup(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
          {previewGroup !== null && outputs[previewGroup] && (
            <>
              <DialogHeader>
                <DialogTitle>Preview</DialogTitle>
                <DialogDescription>
                  {outputs[previewGroup].kept.length} images · {outputs[previewGroup].width} ×{' '}
                  {outputs[previewGroup].height.toLocaleString()} px
                </DialogDescription>
              </DialogHeader>
              <div className="overflow-y-auto -mx-6 px-6 flex-1 min-h-0">
                {outputs[previewGroup].kept.map(p => (
                  <img
                    key={p.filename}
                    src={stitchApi.imageUrl(id, p.filename, String(p.bytes))}
                    alt={p.filename}
                    loading="lazy"
                    className="block w-full"
                    style={{ aspectRatio: `${p.width} / ${p.height}` }}
                  />
                ))}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ZoomControl({ value, onChange, inline }: { value: number; onChange: (v: number) => void; inline?: boolean }) {
  return (
    <div className={inline ? 'w-48' : 'w-48 mb-4'}>
      <label className="text-sm font-medium">Preview size</label>
      <Slider
        className="mt-3"
        min={70}
        max={320}
        step={10}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  )
}

function PageThumb({
  src,
  page,
  width,
  label,
  excluded,
  selected,
  moving,
  onToggleExcluded,
  onClick,
  onDragStart,
  onDragEnd,
  onDragOver
}: {
  src: string
  page: StitchPage
  width: number
  label?: string
  excluded?: boolean
  selected?: boolean
  moving?: boolean
  onToggleExcluded?: () => void
  onClick?: (e: MouseEvent) => void
  onDragStart?: (e: DragEvent) => void
  onDragEnd?: () => void
  onDragOver?: (e: DragEvent) => void
}) {
  const interactive = !!onDragStart
  return (
    <div
      className={`relative bg-white group/page ${interactive ? 'cursor-grab active:cursor-grabbing' : ''} ${
        moving ? 'opacity-40' : ''
      }`}
      // Every image is shown at the column width, as the stitch scales it.
      style={{ height: Math.max(1, Math.round((width * page.height) / page.width)) }}
      draggable={interactive}
      onClick={onClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
    >
      <img
        src={src}
        alt={page.filename}
        loading="lazy"
        draggable={false}
        className={`block w-full h-full select-none ${excluded ? 'opacity-20 grayscale' : ''}`}
      />
      {selected && <div className="absolute inset-0 bg-primary/15 ring-2 ring-inset ring-primary pointer-events-none" />}
      {excluded && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Badge variant="outline" className="bg-background/90 text-[10px]">Dropped</Badge>
        </div>
      )}
      {label && (
        <span
          className={`absolute top-1 left-1 rounded px-1 text-[10px] text-white pointer-events-none ${
            selected ? 'bg-primary opacity-100' : 'bg-black/60 opacity-0 group-hover/page:opacity-100'
          }`}
        >
          {label}
        </span>
      )}
      {onToggleExcluded && (
        <button
          className="absolute top-1 right-1 rounded bg-black/60 p-0.5 text-white opacity-0 group-hover/page:opacity-100 hover:bg-black/80"
          title={excluded ? 'Keep this image' : 'Drop this image from the chapter'}
          draggable={false}
          onClick={e => {
            e.stopPropagation()
            onToggleExcluded()
          }}
        >
          {excluded ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
        </button>
      )}
    </div>
  )
}
