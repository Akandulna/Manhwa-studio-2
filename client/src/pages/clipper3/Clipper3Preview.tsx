/**
 * Clipper3Preview — Module 3 v3: Image Clipper 3.0
 *
 * The whole chapter shown together, but drawn the way 3.0 actually works: the
 * images are simply stacked one after another, and each image's pointers are
 * drawn against ITS OWN 0.0–1.0 box.
 *
 * This is the visible difference from 2.0's viewer, which normalizes every
 * pointer against one stitched canvas. Here a crop's `y: 0` means the top of
 * its own image, not the top of the chapter — so each overlay is positioned
 * inside its own image's frame and nothing is offset by what came before it.
 *
 * Pointer editing is delegated to CropPointerEditor (shared with the
 * per-image dialog in Clipper3ImageList) — this page just stacks one per
 * image, tracks which one is currently being edited so the rest can dim, and
 * keeps its own crop count in sync after a save.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ArrowLeft, Loader2, AlertTriangle, ZoomIn, ZoomOut, Pencil, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { clipperApi, clipper3Api, type Clipper3ChapterImages, type Clipper3ImageCropFile } from '@/lib/api'
import { CropPointerEditor } from '@/components/clipper3/CropPointerEditor'

export default function Clipper3Preview() {
  const { id: chapterId } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [data, setData] = useState<Clipper3ChapterImages | null>(null)
  const [filesByFile, setFilesByFile] = useState<Record<string, Clipper3ImageCropFile | null>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(0.4)
  const [editingFile, setEditingFile] = useState<string | null>(null)
  const [navOpen, setNavOpen] = useState(true)

  // Which image is currently in view, so the nav panel can highlight it.
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const scrollToImage = useCallback((filename: string) => {
    const el = cardRefs.current[filename]
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveFile(filename)
  }, [])

  useEffect(() => {
    if (!chapterId) return
    let cancelled = false
    setLoading(true)

    clipper3Api.getImages(chapterId)
      .then(async fresh => {
        if (cancelled) return
        setData(fresh)

        // Each image's own artifact, fetched independently — there is no
        // chapter-wide file to read here.
        const done = fresh.images.filter(img => img.status === 'done')
        const entries = await Promise.all(
          done.map(async img => {
            try {
              const points = await clipper3Api.getImagePoints(chapterId, img.filename)
              return [img.filename, points.file] as const
            } catch {
              return [img.filename, null] as const
            }
          })
        )
        if (!cancelled) setFilesByFile(Object.fromEntries(entries))
      })
      .catch(err => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load this chapter')
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [chapterId])

  // Highlight whichever card is nearest the top of the viewport as the user
  // scrolls by hand, so the nav panel reflects where they actually are rather
  // than only where they last clicked.
  useEffect(() => {
    if (!data) return
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (visible) {
          const filename = (visible.target as HTMLElement).dataset.filename
          if (filename) setActiveFile(filename)
        }
      },
      { rootMargin: '-10% 0px -80% 0px', threshold: 0 }
    )
    Object.values(cardRefs.current).forEach(el => { if (el) observer.observe(el) })
    return () => observer.disconnect()
  }, [data])

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

  const totalCrops = Object.values(filesByFile).reduce((n, file) => n + (file?.crops.length ?? 0), 0)
  const chapterLabel = `Chapter ${data.number}${data.title ? ` · ${data.title}` : ''}`

  return (
    <div className="flex flex-col h-full">
      <div className="border-b bg-card px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/clipper3/chapter/${chapterId}`)}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setNavOpen(o => !o)}
          title={navOpen ? 'Hide image list' : 'Show image list'}
        >
          {navOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
        </Button>
        <span className="text-sm font-medium truncate">{chapterLabel}</span>
        <Badge variant="secondary" className="flex-shrink-0">
          {totalCrops} crop{totalCrops === 1 ? '' : 's'}
        </Badge>

        {editingFile && (
          <span className="text-xs text-amber-500 flex items-center gap-1">
            <Pencil className="h-3 w-3" />
            Editing {editingFile}
          </span>
        )}

        {!editingFile && (
          <div className="flex items-center gap-1 ml-auto">
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => setZoom(z => Math.max(0.1, z - 0.1))}
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
              onClick={() => setZoom(z => Math.min(1.5, z + 0.1))}
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Jump-to-image panel. Thumbnails rather than filenames alone: at 14+
            near-identical page names, the picture is what the user actually
            recognises. */}
        {navOpen && (
          <div className="w-56 flex-shrink-0 border-r bg-card flex flex-col min-h-0">
            <div className="px-3 py-2 border-b flex-shrink-0">
              <p className="text-xs font-medium text-muted-foreground">
                {data.images.length} image{data.images.length === 1 ? '' : 's'}
              </p>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-1">
                {data.images.map((img, index) => {
                  const file = filesByFile[img.filename]
                  const cropCount = file?.crops.length ?? 0
                  const isActive = activeFile === img.filename
                  const isEditingThis = editingFile === img.filename
                  return (
                    <button
                      key={img.filename}
                      onClick={() => scrollToImage(img.filename)}
                      className={`w-full flex items-center gap-2 rounded p-1.5 text-left transition-colors ${
                        isActive ? 'bg-primary/15 ring-1 ring-primary' : 'hover:bg-muted'
                      }`}
                      title={img.filename}
                    >
                      <span className="text-[10px] text-muted-foreground w-5 text-right flex-shrink-0">
                        {index + 1}
                      </span>
                      <img
                        src={clipperApi.getImageUrl(chapterId!, img.filename)}
                        alt={img.filename}
                        loading="lazy"
                        draggable={false}
                        className="h-10 w-10 object-cover rounded border flex-shrink-0 bg-muted"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11px] font-mono truncate">{img.filename}</span>
                        <span className="block text-[10px] text-muted-foreground">
                          {cropCount > 0 ? `${cropCount} crop${cropCount === 1 ? '' : 's'}` : 'no crops'}
                          {isEditingThis && ' · editing'}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </ScrollArea>
          </div>
        )}

        <ScrollArea className="flex-1 bg-neutral-950">
        {/* Images stacked in order. Each one is its own positioning context, so
            its pointers are placed against its own box — never a chapter-wide
            canvas. A ring + alternating tint + gap between cards makes clear
            where one image ends and the next begins. */}
        <div className="flex flex-col items-center gap-6 py-6">
          {data.images.map((img, index) => {
            const file = filesByFile[img.filename]
            const isEven = index % 2 === 0
            const isEditingThis = editingFile === img.filename
            const isOtherEditing = editingFile != null && !isEditingThis
            if (!file) return null

            return (
              <div
                key={img.filename}
                ref={el => { cardRefs.current[img.filename] = el }}
                data-filename={img.filename}
                className="relative ring-2 ring-offset-4 ring-offset-neutral-950 rounded-sm p-0 scroll-mt-4"
                style={{
                  opacity: isOtherEditing ? 0.35 : 1,
                  // @ts-expect-error CSS custom property for the ring color
                  '--tw-ring-color': isEditingThis ? '#facc15' : (isEven ? '#3b82f6' : '#f97316')
                }}
              >
                <span
                  className="absolute text-[11px] font-mono px-1.5 py-0.5 rounded font-semibold"
                  style={{
                    top: 4,
                    left: 4,
                    background: isEditingThis ? '#facc15' : (isEven ? '#3b82f6' : '#f97316'),
                    color: '#0a0a0a',
                    pointerEvents: 'none',
                    zIndex: 40
                  }}
                >
                  #{index + 1} · {img.filename}
                  {file.crops.length > 0 ? ` · ${file.crops.length} crop${file.crops.length === 1 ? '' : 's'}` : ''}
                </span>

                {(editingFile == null || isEditingThis) && file.crops.length === 0 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="absolute h-6 px-2 text-[11px]"
                    style={{ top: 4, right: 4, zIndex: 40 }}
                    onClick={() => navigate(`/clipper3/chapter/${chapterId}?file=${encodeURIComponent(img.filename)}`)}
                    title="Paste this image's crop pointer JSON"
                  >
                    <Pencil className="h-3 w-3 mr-1" />
                    Edit
                  </Button>
                )}

                <div className="pt-8">
                  <CropPointerEditor
                    chapterId={chapterId!}
                    filename={img.filename}
                    width={img.width}
                    height={img.height}
                    zoom={zoom}
                    seriesTitle={data.seriesTitle}
                    initialFile={file}
                    idleAccent={isEven ? '#3b82f6' : '#f97316'}
                    floatingControls
                    onEditingChange={isNowEditing => setEditingFile(isNowEditing ? img.filename : null)}
                    onSaved={stored => {
                      setFilesByFile(prev => ({ ...prev, [img.filename]: stored.file }))
                      setData(prev => prev && {
                        ...prev,
                        images: prev.images.map(i =>
                          i.filename === img.filename
                            ? { ...i, cropCount: stored.cropCount, status: stored.status, hasPoints: true }
                            : i
                        )
                      })
                      setEditingFile(null)
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
        </ScrollArea>
      </div>
    </div>
  )
}
