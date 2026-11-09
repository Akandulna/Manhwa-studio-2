/**
 * AntiGravity → one page, view only: the source page with its saved crop
 * boxes drawn over it (Image Clipper 3.0's own pointer file, page-local
 * 0–1 coordinates). Nothing here edits; pointer changes belong to the
 * chapter Preview. Previous / Next (and ← / →) walk the chapter's pages.
 */

import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { clipper3Api, type Clipper3Image, type Clipper3ImageCropFile } from '@/lib/api'

const COLORS = ['#3b82f6', '#f97316', '#22c55e', '#e11d48', '#a855f7', '#eab308']

type Loaded = { filename: string; file: Clipper3ImageCropFile | null } | { filename: string; error: string }

export function PagePreviewDialog({ chapterId, images, index, onIndex, onClose }: {
  chapterId: string
  images: Clipper3Image[]
  index: number | null
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const image = index !== null ? images[index] ?? null : null
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!image) return
    if (!image.hasPoints) { setLoaded({ filename: image.filename, file: null }); return }
    let cancelled = false
    clipper3Api.getImagePoints(chapterId, image.filename)
      .then(points => { if (!cancelled) setLoaded({ filename: image.filename, file: points.file }) })
      .catch(error => { if (!cancelled) setLoaded({ filename: image.filename, error: (error as Error).message }) })
    return () => { cancelled = true }
  }, [chapterId, image])

  useEffect(() => {
    if (index === null) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
      if (event.key === 'ArrowRight' && index < images.length - 1) onIndex(index + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, images.length, onIndex])

  const current = loaded && image && loaded.filename === image.filename ? loaded : null
  const crops = current && 'file' in current ? current.file?.crops ?? [] : []

  return (
    <Dialog open={image !== null} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="flex h-[92vh] w-[95vw] max-w-5xl flex-col p-4 sm:p-6">
        {image && index !== null && (
          <>
            <DialogHeader className="flex-shrink-0">
              <DialogTitle className="flex flex-wrap items-center gap-2 pr-8 text-sm">
                <span className="font-mono">{image.filename}</span>
                <span className="font-normal text-muted-foreground">page {index + 1} of {images.length} · {image.width}×{image.height}</span>
                {current && 'file' in current && <Badge variant={crops.length ? 'success' : 'outline'}>{crops.length ? `${crops.length} crop${crops.length === 1 ? '' : 's'}` : 'No pointers yet'}</Badge>}
                <span className="ml-auto flex gap-1">
                  <Button variant="outline" size="sm" disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
                  <Button variant="outline" size="sm" disabled={index >= images.length - 1} onClick={() => onIndex(index + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
                </span>
              </DialogTitle>
            </DialogHeader>
            {!current && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading pointers…</div>}
            {current && 'error' in current && <div className="text-sm text-destructive">{current.error}</div>}
            {/* Width-driven, never fit to height: these pages run very tall and must stay readable. */}
            <div className="min-h-0 flex-1 overflow-auto rounded bg-neutral-950">
              <div className="relative mx-auto" style={{ maxWidth: image.width }}>
                <img src={clipper3Api.getImageUrl(chapterId, image.filename)} alt={image.filename} className="block w-full select-none" draggable={false} />
                <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
                  {crops.map((crop, i) => (
                    <polygon
                      key={crop.id}
                      points={crop.crop.points.map(p => `${p.x},${p.y}`).join(' ')}
                      fill={COLORS[i % COLORS.length]}
                      fillOpacity={0.08}
                      stroke={COLORS[i % COLORS.length]}
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </svg>
                {crops.map((crop, i) => {
                  const left = Math.min(...crop.crop.points.map(p => p.x))
                  const top = Math.min(...crop.crop.points.map(p => p.y))
                  return (
                    <span
                      key={crop.id}
                      className="pointer-events-none absolute rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold text-neutral-950"
                      style={{ left: `${left * 100}%`, top: `${top * 100}%`, background: COLORS[i % COLORS.length] }}
                      title={crop.reason}
                    >
                      {crop.id}
                    </span>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
