import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { pagePreviewApi, stitchApi, ChapterPagesState, StitchPage } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Slider } from '@/components/ui/slider'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import ChapterSwitcher from '@/components/ChapterSwitcher'
import {
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Images,
  Loader2,
  RotateCcw,
  Trash2
} from 'lucide-react'

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

export default function ChapterPreview() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()

  const [state, setState] = useState<ChapterPagesState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [columnWidth, setColumnWidth] = useState(160)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [viewing, setViewing] = useState<number | null>(null)

  // Switching chapter keeps this component mounted: drop the old chapter's state.
  useEffect(() => {
    setState(null)
    setLoading(true)
    setSelected(new Set())
    setViewing(null)
  }, [id])

  const load = useCallback(async () => {
    if (!id) return
    try {
      setState(await pagePreviewApi.getChapter(id))
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

  const pages = state?.pages ?? []
  const locked = (state?.blockers.length ?? 0) > 0

  // Arrow keys step through pages in the full-size viewer.
  useEffect(() => {
    if (viewing === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setViewing(v => (v === null ? v : Math.min(pages.length - 1, v + 1)))
      if (e.key === 'ArrowLeft') setViewing(v => (v === null ? v : Math.max(0, v - 1)))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewing, pages.length])

  const toggle = (filename: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(filename)) next.delete(filename)
      else next.add(filename)
      return next
    })
  }

  const act = async (run: () => Promise<string>, failure: string) => {
    setBusy(true)
    try {
      toast({ title: await run() })
      await load()
    } catch (error) {
      toast({
        title: failure,
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive'
      })
    } finally {
      setBusy(false)
    }
  }

  const deletePages = (filenames: string[]) => {
    if (!id || filenames.length === 0) return
    act(async () => {
      const { deleted } = await pagePreviewApi.deletePages(id, filenames)
      setSelected(prev => new Set([...prev].filter(name => !filenames.includes(name))))
      // Stay on the same position in the viewer, now showing the next page.
      setViewing(v => (v === null ? v : pages.length - deleted <= 0 ? null : Math.min(v, pages.length - deleted - 1)))
      return `Deleted ${deleted} page${deleted === 1 ? '' : 's'}`
    }, 'Delete failed')
  }

  const restorePages = (filenames: string[]) => {
    if (!id) return
    act(async () => {
      const { restored } = await pagePreviewApi.restorePages(id, filenames)
      return `Restored ${restored} page${restored === 1 ? '' : 's'}`
    }, 'Restore failed')
  }

  const emptyBin = () => {
    if (!id || !state) return
    if (!confirm(`Permanently delete the ${state.deleted.length} page(s) in the bin? This cannot be undone.`)) return
    act(async () => {
      const { removed } = await pagePreviewApi.emptyBin(id)
      return `Permanently deleted ${removed} page${removed === 1 ? '' : 's'}`
    }, 'Could not empty the bin')
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
        <Button variant="link" onClick={() => navigate('/')}>
          Back to Library
        </Button>
      </div>
    )
  }

  const thumb = (p: StitchPage) => stitchApi.thumbUrl(id, p.filename, String(p.bytes))
  const viewed = viewing !== null ? pages[viewing] : null

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-start gap-4 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/series/${state.seriesId}`)}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <Images className="h-7 w-7 text-primary" />
            Preview pages
          </h1>
          <p className="text-muted-foreground truncate">
            {state.seriesTitle} · Chapter {state.number}
            {state.title ? ` — ${state.title}` : ''}
          </p>
        </div>
        <ChapterSwitcher neighbours={state.neighbours} to={chapterId => `/chapter/${chapterId}/preview`} />
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

      {/* Toolbar */}
      <Card className="mb-4">
        <CardContent className="py-4 flex flex-wrap items-end gap-6">
          <div className="w-48">
            <label className="text-sm font-medium">Preview size</label>
            <Slider
              className="mt-3"
              min={80}
              max={400}
              step={10}
              value={[columnWidth]}
              onValueChange={([v]) => setColumnWidth(v)}
            />
          </div>

          <div className="flex-1 min-w-[12rem] text-sm">
            <div className="font-medium">
              {pages.length} page{pages.length === 1 ? '' : 's'}
              {selected.size > 0 && ` · ${selected.size} selected`}
            </div>
            <div className="text-muted-foreground">
              Tick the pages that don’t belong (credits, ads), or open one to check it at full size.
            </div>
          </div>

          {selected.size > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          )}
          <Button
            variant="destructive"
            disabled={busy || locked || selected.size === 0}
            onClick={() => deletePages([...selected])}
          >
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
            Delete {selected.size > 0 ? selected.size : ''} page{selected.size === 1 ? '' : 's'}
          </Button>
        </CardContent>
      </Card>

      {/* Pages, in reading order */}
      <div className="flex gap-4 overflow-x-auto pb-4 items-start">
        {pages.map((p, i) => {
          const isSelected = selected.has(p.filename)
          return (
            <div key={p.filename} className="shrink-0" style={{ width: columnWidth }}>
              <div className="mb-2 flex items-center gap-2 text-xs">
                <Checkbox
                  checked={isSelected}
                  disabled={locked}
                  onCheckedChange={() => toggle(p.filename)}
                  aria-label={`Select page ${i + 1}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium">Page {i + 1}</div>
                  <div className="truncate text-muted-foreground" title={p.filename}>
                    {p.height.toLocaleString()} px · {formatBytes(p.bytes)}
                  </div>
                </div>
              </div>
              <div
                className={`relative rounded overflow-hidden border bg-white group/page cursor-zoom-in ${
                  isSelected ? 'border-destructive ring-2 ring-destructive' : 'border-border'
                }`}
                style={{ height: Math.max(1, Math.round((columnWidth * p.height) / p.width)) }}
                onClick={() => setViewing(i)}
              >
                <img
                  src={thumb(p)}
                  alt={p.filename}
                  loading="lazy"
                  draggable={false}
                  className={`block w-full h-full ${isSelected ? 'opacity-40' : ''}`}
                />
                {!locked && (
                  <button
                    className="absolute top-1 right-1 rounded bg-black/60 p-1 text-white opacity-0 group-hover/page:opacity-100 hover:bg-destructive"
                    title="Delete this page"
                    disabled={busy}
                    onClick={e => {
                      e.stopPropagation()
                      deletePages([p.filename])
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Bin */}
      {state.deleted.length > 0 && (
        <Card className="mt-4">
          <CardContent className="py-4">
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <div className="flex-1 min-w-[12rem]">
                <p className="font-medium">Deleted pages ({state.deleted.length})</p>
                <p className="text-sm text-muted-foreground">
                  Kept in a hidden bin inside the chapter folder until you empty it. If this chapter is already on R2,
                  upload it again so the phone gets the change.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || locked}
                onClick={() => restorePages(state.deleted.map(d => d.filename))}
              >
                <RotateCcw className="h-4 w-4 mr-2" />
                Restore all
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={busy}
                onClick={emptyBin}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Empty bin
              </Button>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-2 items-start">
              {state.deleted.map(d => (
                <div key={d.filename} className="shrink-0 w-24">
                  <div className="h-32 rounded overflow-hidden border bg-white">
                    <img
                      src={pagePreviewApi.binThumbUrl(id, d.filename)}
                      alt={d.filename}
                      loading="lazy"
                      className="block w-full h-full object-cover object-top opacity-60"
                    />
                  </div>
                  <div className="mt-1 truncate text-[11px] text-muted-foreground" title={d.filename}>
                    {d.filename}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-full px-1 text-xs"
                    disabled={busy || locked}
                    onClick={() => restorePages([d.filename])}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Full-size viewer */}
      <Dialog open={viewed !== null} onOpenChange={open => !open && setViewing(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
          {viewed && viewing !== null && (
            <>
              <DialogHeader>
                <DialogTitle>
                  Page {viewing + 1} of {pages.length}
                </DialogTitle>
                <DialogDescription>
                  {viewed.filename} · {viewed.width} × {viewed.height.toLocaleString()} px · ← → to move between pages
                </DialogDescription>
              </DialogHeader>
              <div className="overflow-y-auto -mx-6 px-6 flex-1 min-h-0">
                <img
                  key={viewed.filename}
                  src={stitchApi.imageUrl(id, viewed.filename, String(viewed.bytes))}
                  alt={viewed.filename}
                  className="block w-full bg-white"
                  style={{ aspectRatio: `${viewed.width} / ${viewed.height}` }}
                />
              </div>
              <div className="flex items-center gap-2 pt-2">
                <Button variant="outline" size="sm" disabled={viewing === 0} onClick={() => setViewing(viewing - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={viewing === pages.length - 1}
                  onClick={() => setViewing(viewing + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <div className="flex-1" />
                <Button variant="outline" size="sm" disabled={locked} onClick={() => toggle(viewed.filename)}>
                  {selected.has(viewed.filename) ? 'Unselect' : 'Select'}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy || locked}
                  onClick={() => deletePages([viewed.filename])}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete page
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
