import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, MouseEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { stitchApi, StitchChapterState, StitchEdges, StitchPage, StitchProfile } from '@/lib/api'
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
import {
  Cut,
  Dropped,
  StripPiece,
  anchoredCut,
  autoOptions,
  bandMiddle,
  blankBands,
  buildStrip,
  manualCut,
  outputPieces,
  piecesOf,
  planChapter,
  segments,
  toggleDropped,
  withCut,
  withoutCut
} from '@/lib/autoStitch'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
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
  Sparkles,
  Trash2,
  Undo2,
  Wand2,
  X
} from 'lucide-react'

/** Default output height: normal chapter pages run ~10–15k px. */
const DEFAULT_TARGET = 12000

/** Layout edits kept for Undo. */
const HISTORY_LIMIT = 50

/** Remembers the "Remove repeated intro / outro" switch per browser. */
const REMOVE_EDGES_KEY = 'stitch.removeIntroOutro'

function readRemoveEdges(): boolean {
  try {
    return localStorage.getItem(REMOVE_EDGES_KEY) !== 'false'
  } catch {
    return true
  }
}

interface Layout {
  groups: Groups
  excluded: Set<string>
  /** Set in Auto stitch view: the chapter is one strip cut at these strip px, kept sorted. */
  cuts: Cut[] | null
  /** Auto stitch pages left out of the stitch (repeated intro/outro, or deleted by hand). */
  dropped: Dropped[]
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
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const { toast } = useToast()

  const [state, setState] = useState<StitchChapterState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'stitch' | 'undo' | 'discard' | null>(null)
  const [restitching, setRestitching] = useState(false)

  const [target, setTarget] = useState(String(DEFAULT_TARGET))
  const [columnWidth, setColumnWidth] = useState(140)
  const [layout, setLayout] = useState<Layout>({ groups: [], excluded: new Set(), cuts: null, dropped: [] })
  const [profiles, setProfiles] = useState<StitchProfile[] | null>(null)
  const [edges, setEdges] = useState<StitchEdges | null>(null)
  const [removeEdges, setRemoveEdges] = useState(readRemoveEdges)
  const [measuring, setMeasuring] = useState(false)
  /** The target the current cuts were planned for; flags use it, not the box being typed in. */
  const [planTarget, setPlanTarget] = useState(DEFAULT_TARGET)
  const [history, setHistory] = useState<Layout[]>([])
  const [previewGroup, setPreviewGroup] = useState<number | null>(null)
  /** Manual slice mode: a click on a page image cuts it there. */
  const [slicing, setSlicing] = useState(false)

  // Selection: page indices, with an anchor for Shift-click ranges.
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const anchor = useRef<number | null>(null)

  // Drag and drop. Refs carry the values into the drop handler; state drives the styling.
  const [dragging, setDragging] = useState<number[] | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const dragRef = useRef<number[] | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const dropRef = useRef<DropTarget | null>(null)

  const { groups, excluded, cuts, dropped } = layout

  // Switching chapter keeps this component mounted: drop the old chapter's state.
  useEffect(() => {
    setState(null)
    setRestitching(false)
    setLoading(true)
    setPreviewGroup(null)
  }, [id])

  const load = useCallback(async () => {
    if (!id) return
    try {
      const data = await stitchApi.getChapter(id)
      setState(data)
      setRestitching(false)
      setSlicing(false)
      setProfiles(null)
      setEdges(null)
      setLayout({
        groups: autoGroups(data.pages, new Set(), DEFAULT_TARGET),
        excluded: new Set(),
        cuts: null,
        dropped: []
      })
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

  useEffect(() => {
    if (!state || state.chapterId !== id || searchParams.get('again') !== '1') return
    setRestitching(!!state.stitched)
    setSearchParams(previous => {
      const next = new URLSearchParams(previous)
      next.delete('again')
      return next
    }, { replace: true })
  }, [id, state, searchParams, setSearchParams])

  /** Apply a layout edit, keeping the previous layout for Undo. */
  const commit = (next: Partial<Layout>) => {
    const merged = { ...layout, ...next }
    if (
      JSON.stringify(merged.groups) === JSON.stringify(layout.groups) &&
      merged.excluded === layout.excluded &&
      JSON.stringify(merged.cuts) === JSON.stringify(layout.cuts) &&
      JSON.stringify(merged.dropped) === JSON.stringify(layout.dropped)
    ) {
      return
    }
    setHistory(h => [...h.slice(-(HISTORY_LIMIT - 1)), layout])
    setLayout(merged)
  }

  const undoLayout = useCallback(() => {
    if (history.length === 0) return
    setLayout(history[history.length - 1])
    setHistory(history.slice(0, -1))
  }, [history])

  // ⌘Z / Ctrl+Z undoes a layout edit; Escape clears the selection and leaves manual slice mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if (typing) return
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undoLayout()
      } else if (e.key === 'Escape') {
        setSelected(new Set())
        setSlicing(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoLayout])

  const pages = state?.pages ?? []
  const maxHeight = state?.maxHeight ?? 16383
  const flat = useMemo(() => groups.flat(), [groups])
  const pageByName = useMemo(() => new Map(pages.map(p => [p.filename, p])), [pages])
  const indexByName = useMemo(() => new Map(pages.map((p, i) => [p.filename, i])), [pages])
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

  // ---- Auto stitch: one strip, cut at blank rows ----

  const strip = useMemo(
    () => (cuts && profiles ? buildStrip(pages, profiles, excluded) : null),
    [cuts, profiles, pages, excluded]
  )
  const bands = useMemo(() => (strip ? blankBands(strip) : []), [strip])
  const autoPages = useMemo(() => {
    if (!strip || !cuts) return []
    const options = autoOptions(planTarget, maxHeight)
    const ranges = segments(strip, cuts)
    const lastKept = ranges.map(r => r.top).filter(top => !dropped.some(d => d.y === top)).pop()
    let number = 0
    return ranges.map((range, k) => {
      const height = range.bottom - range.top
      const drop = dropped.find(d => d.y === range.top) ?? null
      return {
        range,
        height,
        pieces: piecesOf(strip, range),
        cutAbove: k > 0 ? cuts[k - 1] : null,
        drop,
        /** Output page number, or 0 for a dropped page. */
        number: drop ? 0 : ++number,
        overLimit: !drop && height > maxHeight,
        offRange: !drop && ((height < options.min && range.top !== lastKept) || height > options.max)
      }
    })
  }, [strip, cuts, dropped, maxHeight, planTarget])

  const keptAutoPages = autoPages.filter(p => !p.drop)
  const outputCount = cuts ? keptAutoPages.length : outputNumbers.filter(n => n > 0).length
  const overLimit = cuts ? autoPages.filter(p => p.overLimit).length : outputs.filter(o => o.overLimit).length
  const tallest = Math.max(0, ...(cuts ? keptAutoPages : outputs).map(o => o.height))
  const forcedCuts = cuts ? cuts.filter(c => c.kind === 'forced').length : 0
  const manualCuts = cuts ? cuts.filter(c => c.kind === 'manual').length : 0
  const offRange = autoPages.filter(p => p.offRange).length

  const readTarget = (): number | null => {
    const value = Number(target)
    if (!Number.isFinite(value) || value < 500) {
      toast({ title: 'Enter a target height of at least 500 px', variant: 'destructive' })
      return null
    }
    return Math.min(value, maxHeight)
  }

  const applyAuto = () => {
    const value = readTarget()
    if (value !== null) commit({ groups: autoGroups(pages, excluded, value) })
  }

  /**
   * Plan the cuts for the kept pages, dropping the repeated intro/outro when
   * `withEdges`; fetches the row profiles (and edge marks) the first time.
   */
  const planAuto = async (nextExcluded: Set<string> = excluded, withEdges = removeEdges) => {
    const value = readTarget()
    if (value === null) return
    const measured = await ensureProfiles()
    if (!measured) return
    const { rows, marks } = measured
    const nextStrip = buildStrip(pages, rows, nextExcluded)
    // Manual slices follow their source row into the new strip; a slice on a dropped image goes with it.
    const manual = (cuts ?? []).filter(c => c.kind === 'manual').map(c => anchoredCut(nextStrip, c)).filter((c): c is Cut => c !== null)
    const plan = planChapter(nextStrip, blankBands(nextStrip), autoOptions(value, maxHeight), withEdges ? marks : null, manual)
    setPlanTarget(value)
    commit({ excluded: nextExcluded, ...plan })
  }

  /** Row profiles (and repeated intro/outro marks), measured once per chapter. */
  const ensureProfiles = async (): Promise<{ rows: StitchProfile[]; marks: StitchEdges | null } | null> => {
    if (profiles) return { rows: profiles, marks: edges }
    if (!id) return null
    setMeasuring(true)
    try {
      const data = await stitchApi.profiles(id)
      setProfiles(data.profiles)
      setEdges(data.edges)
      return { rows: data.profiles, marks: data.edges }
    } catch (error) {
      toast({
        title: 'Could not measure the pages',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive'
      })
      return null
    } finally {
      setMeasuring(false)
    }
  }

  /**
   * Turn on Manual slice. Outside Auto stitch view the current page breaks are kept as they
   * are — every page of a stitched chapter, or each group in Group view — so only your
   * slices change anything.
   */
  const startSlicing = async (everyPage: boolean) => {
    if (cuts) {
      setSlicing(on => !on)
      return
    }
    const measured = await ensureProfiles()
    if (!measured) return
    const nextStrip = buildStrip(pages, measured.rows, excluded)
    const starts = new Set(
      everyPage
        ? pages.map(p => p.filename)
        : groups.map(g => g.map(i => pages[i].filename).find(name => !excluded.has(name))).filter((n): n is string => !!n)
    )
    const breaks: Cut[] = nextStrip.pages.filter(p => p.top > 0 && starts.has(p.filename)).map(p => ({ y: p.top, kind: 'gap' }))
    setPlanTarget(readTarget() ?? DEFAULT_TARGET)
    commit({ cuts: breaks, dropped: [] })
    setSlicing(true)
  }

  const switchRemoveEdges = (on: boolean) => {
    setRemoveEdges(on)
    try {
      localStorage.setItem(REMOVE_EDGES_KEY, String(on))
    } catch {
      // Private mode: the switch just isn't remembered.
    }
    if (cuts) planAuto(excluded, on)
  }

  const toggleExcluded = (filename: string) => {
    const next = new Set(excluded)
    if (next.has(filename)) next.delete(filename)
    else next.add(filename)
    // In Auto stitch view the strip changes, so the cuts are planned again.
    if (cuts) planAuto(next)
    else commit({ excluded: next })
  }

  const addCut = (cut: Cut) => {
    if (cuts) commit(withCut(cuts, dropped, cut))
  }

  const removeCut = (y: number) => {
    if (cuts) commit(withoutCut(cuts, dropped, y))
  }

  /** Slice at strip `y`, anywhere in a page image (through artwork too). */
  const addManualCut = (y: number) => {
    if (!strip) return
    const cut = manualCut(strip, y)
    if (cut && !cuts?.some(c => c.y === cut.y)) addCut(cut)
  }

  /** Delete or restore one Auto stitch page. */
  const togglePage = (top: number) => commit({ dropped: toggleDropped(dropped, top) })

  /** Group view: drop every image of a page, or put them all back. */
  const toggleGroup = (g: number) => {
    const names = groups[g].map(i => pages[i].filename)
    const allOut = names.every(n => excluded.has(n))
    const next = new Set(excluded)
    for (const n of names) {
      if (allOut) next.delete(n)
      else next.add(n)
    }
    commit({ excluded: next })
  }

  // Opened with ?auto=1 (the library's Auto stitch button): plan straight away, once.
  const autoRequested = searchParams.get('auto') === '1'
  useEffect(() => {
    if (!autoRequested || !state || state.chapterId !== id || (state.stitched && !restitching) || state.pages.length === 0) return
    setSearchParams({}, { replace: true })
    planAuto()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRequested, id, state, restitching])

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
        const body = strip && cuts ? outputPieces(strip, cuts, dropped) : outputGroups(pages, groups, excluded)
        const result = await stitchApi.stitch(id, body, restitching)
        toast({
          title: 'Chapter stitched',
          description: `${result.originalPages} pages → ${result.stitchedPages} pages. The previous pages are backed up until you delete them.`
        })
      } else if (kind === 'undo') {
        await stitchApi.undo(id)
        toast({ title: 'Stitch undone', description: 'The previous pages are back.' })
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
  const stitched = state.stitched
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
        <Button variant="ghost" size="icon" onClick={() => navigate(`/stitch/series/${state.seriesId}`)}>
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

      {stitched && !restitching ? (
        <>
          {/* Already stitched: show the result and the backup actions */}
          <Card className="mb-6 border-emerald-500/40 bg-emerald-500/5">
            <CardContent className="py-4 flex flex-wrap items-center gap-4">
              <CheckCircle className="h-6 w-6 text-emerald-500 shrink-0" />
              <div className="flex-1 min-w-[16rem]">
                <p className="font-medium">
                  {stitched.originalPages === null
                    ? `Stitching complete · ${stitched.stitchedPages} pages`
                    : `Stitched ${stitched.originalPages} pages into ${stitched.stitchedPages}`}
                  {!!record?.excluded.length && ` (${record.excluded.length} dropped)`}
                </p>
                <p className="text-sm text-muted-foreground">
                  {stitched.stitchedAt && `${new Date(stitched.stitchedAt).toLocaleString()} · `}
                  {record
                    ? `The originals (${formatBytes(state.backupBytes)}) are kept in a hidden backup inside the chapter folder until you delete them.`
                    : 'Originals deleted. Stitching is complete; undo is no longer available.'}
                </p>
              </div>
              <Button
                onClick={() => { setRestitching(true); void planAuto() }}
                disabled={busy !== null || state.blockers.length > 0 || pages.length === 0}
              >
                <Sparkles className="h-4 w-4 mr-2" />
                Stitch again
              </Button>
              <Button
                variant="outline"
                onClick={() => { setRestitching(true); void startSlicing(true) }}
                disabled={busy !== null || measuring || state.blockers.length > 0 || pages.length === 0}
                title="Keep these pages as they are and slice any of them by hand, even through artwork"
              >
                <Scissors className="h-4 w-4 mr-2" />
                Manual slice
              </Button>
              {record && <>
              <Button variant="outline" onClick={() => run('undo')} disabled={busy !== null}>
                {busy === 'undo' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-2" />}
                Undo stitch
              </Button>
              <Button
                variant="outline"
                className="text-destructive hover:text-destructive"
                disabled={busy !== null}
                onClick={() => {
                  if (confirm(`Delete the ${record.originals.length} saved pages${record.previousStitch?.hasBackup ? ' and earlier stitch backups' : ''}? The stitch can no longer be undone.`)) {
                    run('discard')
                  }
                }}
              >
                {busy === 'discard' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
                Delete originals
              </Button>
              </>}
            </CardContent>
          </Card>

          <ZoomControl value={columnWidth} onChange={setColumnWidth} />
          <div className="flex gap-4 overflow-x-auto pb-4 items-start">
            {pages.map((p, i) => (
              <div key={p.filename} className="shrink-0" style={{ width: columnWidth }}>
                <div className="mb-2 text-xs">
                  <div className="font-medium">Page {i + 1}</div>
                  <div className="text-muted-foreground">
                    {p.height.toLocaleString()} px{record && ` · ${record.outputs[i]?.sources.length ?? 1} img`}
                  </div>
                </div>
                <PageThumb src={thumb(p)} page={p} width={columnWidth} />
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          {restitching && (
            <Card className="mb-4">
              <CardContent className="py-3 flex flex-wrap items-center gap-3">
                <p className="flex-1 text-sm">Stitching again from the current pages. Your saved chapter stays unchanged until you stitch. Earlier backups will be kept.</p>
                <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy !== null}>
                  Cancel
                </Button>
              </CardContent>
            </Card>
          )}
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
                    onKeyDown={e => e.key === 'Enter' && (cuts ? planAuto() : applyAuto())}
                  />
                  <span className="text-sm text-muted-foreground">px</span>
                  <Button
                    size="sm"
                    variant={cuts ? 'outline' : 'default'}
                    onClick={() => planAuto()}
                    disabled={measuring || pages.length === 0}
                    title="Re-cut the whole chapter into pages near the target height, cutting only across blank rows so no artwork is split"
                  >
                    {measuring ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
                    {measuring ? 'Measuring…' : cuts ? 'Re-plan cuts' : 'Auto stitch'}
                  </Button>
                  {cuts ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setSlicing(false); commit({ cuts: null }) }}
                      title="Back to joining whole images by hand"
                    >
                      <Layers className="h-4 w-4 mr-2" />
                      Group view
                    </Button>
                  ) : null}
                  <Button
                    variant={slicing ? 'default' : 'outline'}
                    size="sm"
                    className={slicing ? 'bg-violet-600 hover:bg-violet-700 text-white' : ''}
                    onClick={() => void startSlicing(false)}
                    disabled={measuring || pages.length === 0}
                    title={
                      cuts
                        ? 'Click anywhere on a page image to slice it there, even through artwork (Esc to stop)'
                        : 'Keep the current pages as they are and click anywhere on a page image to slice it there'
                    }
                  >
                    <Scissors className="h-4 w-4 mr-2" />
                    {slicing && cuts ? 'Slicing — click a page' : 'Manual slice'}
                  </Button>
                  {cuts ? null : (
                    <Button variant="outline" size="sm" onClick={applyAuto} title="Regroup whole images in reading order">
                      <Wand2 className="h-4 w-4 mr-2" />
                      Auto group
                    </Button>
                  )}
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
                <label
                  className="mt-2 flex items-center gap-2 text-xs text-muted-foreground cursor-pointer w-fit"
                  title="Auto stitch compares the start and end of this chapter with nearby chapters and deletes the credit art they share (scanlator banners, title and end cards)"
                >
                  <Switch checked={removeEdges} onCheckedChange={switchRemoveEdges} />
                  Auto stitch removes repeated intro / outro
                </label>
              </div>

              <ZoomControl value={columnWidth} onChange={setColumnWidth} inline />

              <div className="flex-1 min-w-[12rem] text-sm">
                <div className="font-medium">
                  {pages.length} pages → {outputCount} page{outputCount === 1 ? '' : 's'}
                </div>
                <div className="text-muted-foreground">
                  Tallest {tallest.toLocaleString()} px (max {maxHeight.toLocaleString()})
                  {excluded.size > 0 && ` · ${excluded.size} dropped`}
                  {cuts && dropped.length > 0 && ` · ${dropped.length} page${dropped.length === 1 ? '' : 's'} deleted`}
                  {manualCuts > 0 && ` · ${manualCuts} manual slice${manualCuts === 1 ? '' : 's'}`}
                </div>
                {cuts && (forcedCuts > 0 || offRange > 0) && (
                  <div className="text-amber-600 dark:text-amber-400">
                    {[
                      forcedCuts > 0 && `${forcedCuts} cut${forcedCuts === 1 ? '' : 's'} through artwork`,
                      offRange > 0 && `${offRange} page${offRange === 1 ? '' : 's'} outside ${autoOptions(planTarget, maxHeight).min.toLocaleString()}–${autoOptions(planTarget, maxHeight).max.toLocaleString()} px`
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                )}
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
                disabled={busy !== null || measuring || overLimit > 0 || outputCount === 0 || state.blockers.length > 0}
              >
                {busy === 'stitch' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Layers className="h-4 w-4 mr-2" />}
                {busy === 'stitch' ? 'Stitching…' : `Stitch into ${outputCount} pages`}
              </Button>
            </CardContent>
          </Card>

          {cuts ? (
            <p className="text-xs text-muted-foreground mb-3">
              Auto stitch treats the chapter as one long strip and cuts it only across blank rows, so a panel is never
              split between two pages. Each column is one output page. Faint dashed lines are other blank gaps: hover one
              and click <Scissors className="inline h-3 w-3" /> to cut there. Use{' '}
              <ArrowLeftToLine className="inline h-3 w-3" /> / <ArrowRightToLine className="inline h-3 w-3" /> to remove
              the cut above / below a page, <Trash2 className="inline h-3 w-3" /> to delete a whole page (repeated
              intro/outro art is deleted for you when the switch is on), or <EyeOff className="inline h-3 w-3" /> on an
              image to drop it (the cuts are planned again). <strong>Manual slice</strong>{' '}
              <Scissors className="inline h-3 w-3" /> lets you click anywhere on a page image to cut it there, even
              through artwork; a manual slice shows in violet above its page, and <X className="inline h-3 w-3" /> deletes
              it. Re-planning keeps your manual slices. Nothing changes on disk until you stitch, and a stitch can be
              undone.
            </p>
          ) : (
          <p className="text-xs text-muted-foreground mb-3">
            Each column is one output page. <strong>Drag</strong> an image to any spot in any page, or into the gap
            between pages to start a new one. Click to select, ⌘/Ctrl-click to add, Shift-click for a range, then drag
            them together. Hover between two images and click <Scissors className="inline h-3 w-3" /> to cut, or{' '}
            use <ArrowLeftToLine className="inline h-3 w-3" /> / <ArrowRightToLine className="inline h-3 w-3" /> on a
            page to add all of it to the previous / next page. Nothing changes on disk until you
            stitch, and a stitch can be undone.
          </p>
          )}

          {overLimit > 0 && (
            <p className="flex items-center gap-2 text-sm text-destructive mb-3">
              <AlertTriangle className="h-4 w-4" />
              {overLimit} page{overLimit === 1 ? ' is' : 's are'} taller than {maxHeight.toLocaleString()} px.{' '}
              {cuts
                ? `Add a cut inside ${overLimit === 1 ? 'it' : 'them'} before stitching.`
                : `Cut or move images out of ${overLimit === 1 ? 'it' : 'them'} before stitching.`}
            </p>
          )}

          {cuts && excluded.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs mb-3">
              <span className="text-muted-foreground">Dropped images:</span>
              {pages.map((p, i) =>
                excluded.has(p.filename) ? (
                  <button
                    key={p.filename}
                    className="flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-accent"
                    title="Put this image back (the cuts are planned again)"
                    onClick={() => toggleExcluded(p.filename)}
                  >
                    {i + 1}
                    <Eye className="h-3 w-3" />
                  </button>
                ) : null
              )}
            </div>
          )}

          {cuts ? (
            /* Auto stitch columns: strip ranges, cut at blank rows */
            <div className="flex gap-4 overflow-x-auto pb-4 items-start">
              {autoPages.map((out, k) => {
                const forced = out.cutAbove?.kind === 'forced'
                const manual = out.cutAbove?.kind === 'manual'
                const below = autoPages[k + 1]?.cutAbove
                const markers = bands.filter(b => {
                  const y = bandMiddle(b)
                  return y > out.range.top && y < out.range.bottom
                })
                return (
                  <div key={out.range.top} className="shrink-0" style={{ width: columnWidth }}>
                    <div className="mb-2 text-xs">
                      <div className="flex items-center gap-0.5">
                        <div
                          className={`flex-1 min-w-0 truncate font-medium ${
                            out.overLimit ? 'text-destructive' : out.drop ? 'text-muted-foreground line-through' : ''
                          }`}
                        >
                          {out.drop ? 'Deleted' : `Page ${out.number}`}
                        </div>
                        <button
                          className={`p-0.5 rounded hover:bg-accent ${
                            out.drop ? 'text-primary' : 'text-muted-foreground hover:text-destructive'
                          }`}
                          title={out.drop ? 'Restore this page' : 'Delete this page from the chapter'}
                          onClick={() => togglePage(out.range.top)}
                        >
                          {out.drop ? <RotateCcw className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </button>
                        <button
                          className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
                          title="Remove the cut above: join this page onto the previous one"
                          disabled={!out.cutAbove}
                          onClick={() => out.cutAbove && removeCut(out.cutAbove.y)}
                        >
                          <ArrowLeftToLine className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
                          title="Remove the cut below: join the next page onto this one"
                          disabled={!below}
                          onClick={() => below && removeCut(below.y)}
                        >
                          <ArrowRightToLine className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                          title="Preview at full size"
                          onClick={() => setPreviewGroup(k)}
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div
                        className={`truncate ${
                          out.overLimit
                            ? 'text-destructive'
                            : out.offRange
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-muted-foreground'
                        }`}
                      >
                        {out.height.toLocaleString()} px · {out.pieces.length} img
                      </div>
                      {out.drop?.reason && (
                        <div className="truncate text-primary" title={out.drop.reason}>
                          {out.drop.reason}
                        </div>
                      )}
                      {manual && (
                        <div className="flex items-center gap-1 text-violet-600 dark:text-violet-400">
                          <Scissors className="h-3 w-3 shrink-0" />
                          <span className="flex-1 min-w-0 truncate">Manual slice above</span>
                          <button
                            className="p-0.5 rounded hover:bg-accent hover:text-destructive"
                            title="Delete this manual slice: join this page back onto the previous one"
                            onClick={() => out.cutAbove && removeCut(out.cutAbove.y)}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                      {forced && (
                        <div
                          className="flex items-center gap-1 text-amber-600 dark:text-amber-400"
                          title="No blank row fitted near here, so the cut above this page crosses artwork. Click a dashed gap line to cut there instead, then remove this cut."
                        >
                          <AlertTriangle className="h-3 w-3 shrink-0" />
                          <span className="truncate">Cut through artwork</span>
                        </div>
                      )}
                    </div>

                    <div
                      className={`relative rounded overflow-hidden border ${
                        out.overLimit ? 'border-destructive ring-1 ring-destructive' : 'border-border'
                      } ${forced ? 'border-t-4 border-t-amber-500' : ''} ${manual ? 'border-t-4 border-t-violet-500' : ''} ${
                        out.drop ? 'opacity-30 grayscale' : ''
                      }`}
                    >
                      {slicing && (
                        <SliceOverlay top={out.range.top} height={out.height} onSlice={addManualCut} />
                      )}
                      {out.pieces.map(piece => (
                        <PieceImage
                          key={`${piece.page.filename}:${piece.top}`}
                          src={thumb(pageByName.get(piece.page.filename)!)}
                          piece={piece}
                          label={`${(indexByName.get(piece.page.filename) ?? 0) + 1}`}
                          onExclude={() => toggleExcluded(piece.page.filename)}
                        />
                      ))}
                      {markers.map(band => {
                        const y = bandMiddle(band)
                        return (
                          <div
                            key={y}
                            className="absolute inset-x-0 h-0 z-10 group/seam"
                            style={{ top: `${((y - out.range.top) / out.height) * 100}%` }}
                          >
                            <button
                              className="absolute inset-x-0 -top-2 h-4 flex items-center justify-center"
                              title={`Blank gap, ${band.bottom - band.top} px tall: cut here`}
                              onClick={() => addCut({ y, kind: 'gap', band })}
                            >
                              <span className="absolute inset-x-0 top-1/2 border-t border-dashed border-sky-500/70 group-hover/seam:border-t-2 group-hover/seam:border-primary" />
                              <span className="relative rounded-full bg-primary text-primary-foreground p-0.5 opacity-0 group-hover/seam:opacity-100 shadow">
                                <Scissors className="h-3 w-3" />
                              </span>
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
          /* Output columns */
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
                      <div className="flex items-center gap-0.5">
                        <div className={`flex-1 min-w-0 truncate font-medium ${out.overLimit ? 'text-destructive' : ''}`}>
                          {outputNumbers[g] > 0 ? `Page ${outputNumbers[g]}` : 'Dropped'}
                        </div>
                        <button
                          className={`p-0.5 rounded hover:bg-accent ${
                            out.kept.length === 0 ? 'text-primary' : 'text-muted-foreground hover:text-destructive'
                          }`}
                          title={out.kept.length === 0 ? 'Restore every image of this page' : 'Delete this page: drop all its images'}
                          onClick={() => toggleGroup(g)}
                        >
                          {out.kept.length === 0 ? <RotateCcw className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </button>
                        <button
                          className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
                          title="Add this whole page to the end of the previous page"
                          disabled={g === 0}
                          onClick={() => commit({ groups: joinWithPrevious(groups, g) })}
                        >
                          <ArrowLeftToLine className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
                          title="Add this whole page to the start of the next page"
                          disabled={g === groups.length - 1}
                          // Joining the next page onto this one puts this page's images first.
                          onClick={() => commit({ groups: joinWithPrevious(groups, g + 1) })}
                        >
                          <ArrowRightToLine className="h-3.5 w-3.5" />
                        </button>
                        {out.kept.length > 0 && (
                          <button
                            className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
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
          )}
        </>
      )}

      {/* While dragging: new-page targets that are always on screen */}
      {dragging && !stitched && (
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
          {previewGroup !== null && cuts && strip && autoPages[previewGroup] && (
            <>
              <DialogHeader>
                <DialogTitle>Preview</DialogTitle>
                <DialogDescription>
                  {autoPages[previewGroup].drop ? 'Deleted page' : `Page ${autoPages[previewGroup].number}`} ·{' '}
                  {autoPages[previewGroup].pieces.length} images · {strip.width} ×{' '}
                  {autoPages[previewGroup].height.toLocaleString()} px
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <Button
                  variant={slicing ? 'default' : 'outline'}
                  size="sm"
                  className={slicing ? 'bg-violet-600 hover:bg-violet-700 text-white' : ''}
                  onClick={() => setSlicing(on => !on)}
                  title="Click anywhere on this page to slice it there, even through artwork"
                >
                  <Scissors className="h-4 w-4 mr-2" />
                  {slicing ? 'Slicing — click the page' : 'Manual slice'}
                </Button>
                {autoPages[previewGroup].cutAbove?.kind === 'manual' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => autoPages[previewGroup].cutAbove && removeCut(autoPages[previewGroup].cutAbove!.y)}
                    title="Join this page back onto the previous one"
                  >
                    <X className="h-4 w-4 mr-2" />
                    Delete manual slice above
                  </Button>
                )}
              </div>
              <div className="overflow-y-auto -mx-6 px-6 flex-1 min-h-0">
                <div className="relative">
                  {autoPages[previewGroup].pieces.map(piece => {
                    const p = pageByName.get(piece.page.filename)!
                    return (
                      <PieceImage
                        key={`${piece.page.filename}:${piece.top}`}
                        src={stitchApi.imageUrl(id, p.filename, String(p.bytes))}
                        piece={piece}
                      />
                    )
                  })}
                  {slicing && (
                    <SliceOverlay
                      top={autoPages[previewGroup].range.top}
                      height={autoPages[previewGroup].height}
                      onSlice={addManualCut}
                    />
                  )}
                </div>
              </div>
            </>
          )}
          {previewGroup !== null && !cuts && outputs[previewGroup] && (
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

/** Manual slice mode over one output page: a violet line follows the pointer, a click cuts there. */
function SliceOverlay({ top, height, onSlice }: { top: number; height: number; onSlice: (y: number) => void }) {
  const [hover, setHover] = useState<number | null>(null)
  const fraction = (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    return Math.min(1, Math.max(0, (e.clientY - box.top) / box.height))
  }
  return (
    <div
      className="absolute inset-0 z-[15] cursor-crosshair"
      onMouseMove={e => setHover(fraction(e))}
      onMouseLeave={() => setHover(null)}
      onClick={e => {
        e.stopPropagation()
        onSlice(top + fraction(e) * height)
      }}
    >
      {hover !== null && (
        <div className="pointer-events-none absolute inset-x-0 h-0" style={{ top: `${hover * 100}%` }}>
          <span className="absolute inset-x-0 border-t-2 border-violet-500 shadow-[0_0_0_1px_rgba(255,255,255,0.6)]" />
          <span className="absolute right-1 -top-5 flex items-center gap-0.5 rounded bg-violet-600 px-1 text-[10px] text-white shadow tabular-nums">
            <Scissors className="h-2.5 w-2.5" />
            {Math.round(hover * height).toLocaleString()} px
          </span>
        </div>
      )}
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

/** Rows [top, bottom) of one page, at the width of its container. */
function PieceImage({
  src,
  piece,
  label,
  onExclude
}: {
  src: string
  piece: StripPiece
  label?: string
  onExclude?: () => void
}) {
  const rows = piece.bottom - piece.top
  return (
    <div
      className="relative overflow-hidden bg-white group/page"
      style={{ aspectRatio: `${piece.page.width} / ${rows}` }}
    >
      <img
        src={src}
        alt={piece.page.filename}
        loading="lazy"
        draggable={false}
        className="absolute left-0 w-full max-w-none select-none"
        // A percentage top is of this box's height, so the page's rows line up at any width.
        style={{ top: `${(-piece.top / rows) * 100}%` }}
      />
      {label && (
        <span className="absolute top-1 left-1 rounded px-1 text-[10px] text-white pointer-events-none bg-black/60 opacity-0 group-hover/page:opacity-100">
          {label}
        </span>
      )}
      {onExclude && (
        <button
          className="absolute top-1 right-1 z-20 rounded bg-black/60 p-0.5 text-white opacity-0 group-hover/page:opacity-100 hover:bg-black/80"
          title="Drop this image from the chapter (the cuts are planned again)"
          onClick={onExclude}
        >
          <EyeOff className="h-3 w-3" />
        </button>
      )}
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
