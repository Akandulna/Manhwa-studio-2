/**
 * ImageSlotStrip — the horizontal strip of a part's selected images, each sized
 * proportional to its duration, with draggable boundaries. The sum is always
 * locked to the part's audio duration: dragging a boundary transfers time
 * between the two adjacent slots only. Commits on release.
 */

import { useEffect, useRef, useState } from 'react'
import { videoApi, type VideoPart } from '@/lib/api'
import { Image as ImageIcon, X } from 'lucide-react'

const MIN_SLOT = 0.3 // seconds

interface Props {
  part: VideoPart
  selectedImageId: string | null
  onSelectSlot: (imageId: string) => void
  onDurationsCommit: (durations: number[]) => void
  onRemoveSlot?: (index: number) => void
  onReorder?: (from: number, to: number) => void
}

export default function ImageSlotStrip({ part, selectedImageId, onSelectSlot, onDurationsCommit, onRemoveSlot, onReorder }: Props) {
  const total = part.audioDuration
  const containerRef = useRef<HTMLDivElement>(null)
  const [durations, setDurations] = useState<number[]>(part.images.map(i => i.duration))
  const [drag, setDrag] = useState<{ index: number; startX: number; start: number[] } | null>(null)
  // Drag-to-reorder (HTML5 DnD) state.
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  // Re-sync when the part's images change (selection/save round-trips).
  useEffect(() => {
    setDurations(part.images.map(i => i.duration))
  }, [part.images])

  useEffect(() => {
    if (!drag) return
    const onMove = (e: MouseEvent) => {
      const width = containerRef.current?.clientWidth || 1
      const deltaSec = ((e.clientX - drag.startX) / width) * total
      const next = [...drag.start]
      const i = drag.index
      let d = deltaSec
      // Clamp so neither adjacent slot drops below MIN_SLOT.
      d = Math.max(d, MIN_SLOT - drag.start[i])
      d = Math.min(d, drag.start[i + 1] - MIN_SLOT)
      next[i] = drag.start[i] + d
      next[i + 1] = drag.start[i + 1] - d
      setDurations(next)
    }
    const onUp = () => {
      setDrag(null)
      onDurationsCommit(durations)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag, durations, total, onDurationsCommit])

  if (part.images.length === 0) {
    return (
      <div className="h-16 rounded border border-dashed flex items-center justify-center text-xs text-muted-foreground">
        No images — select crops on the right, or add a black filler
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex h-20 w-full rounded overflow-hidden border bg-neutral-950 select-none">
      {part.images.map((img, i) => {
        // durations state resyncs in an effect after render, so fall back to the
        // image's own duration for the first paint after the image list changes.
        const d = durations[i] ?? img.duration ?? 0
        const widthPct = total > 0 ? (d / total) * 100 : 100 / part.images.length
        const isSelected = img.id === selectedImageId
        const canReorder = !!onReorder && part.images.length > 1
        return (
          <div
            key={img.id}
            className={`relative flex-shrink-0 h-full group ${
              overIndex === i && dragIndex !== null && dragIndex !== i ? 'ring-2 ring-primary ring-inset' : ''
            } ${dragIndex === i ? 'opacity-40' : ''}`}
            style={{ width: `${widthPct}%` }}
            onDragOver={(e) => {
              if (dragIndex === null) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (overIndex !== i) setOverIndex(i)
            }}
            onDrop={(e) => {
              if (dragIndex === null) return
              e.preventDefault()
              if (dragIndex !== i && onReorder) onReorder(dragIndex, i)
              setDragIndex(null)
              setOverIndex(null)
            }}
          >
            <button
              onClick={(e) => { e.stopPropagation(); onSelectSlot(img.id) }}
              draggable={canReorder}
              onDragStart={(e) => {
                if (!canReorder) return
                e.stopPropagation()
                e.dataTransfer.effectAllowed = 'move'
                try { e.dataTransfer.setData('text/plain', String(i)) } catch { /* some browsers require this */ }
                setDragIndex(i)
              }}
              onDragEnd={() => { setDragIndex(null); setOverIndex(null) }}
              title={canReorder ? 'Drag to reorder · click to edit' : undefined}
              className={`w-full h-full overflow-hidden ${canReorder ? 'cursor-grab active:cursor-grabbing' : ''} ${isSelected ? 'ring-2 ring-primary ring-inset' : ''}`}
            >
              {img.isFiller || !img.cropId ? (
                <div className="w-full h-full bg-black flex items-center justify-center text-[10px] text-white/50">
                  filler
                </div>
              ) : (
                <img
                  src={videoApi.cropImageUrl(img.cropId)}
                  alt={`Slot ${i + 1}`}
                  className="w-full h-full object-cover"
                  draggable={false}
                />
              )}
              {/* Slot index + duration */}
              <span className="absolute top-0.5 left-0.5 bg-black/70 text-white text-[10px] px-1 rounded flex items-center gap-0.5">
                <ImageIcon className="h-2.5 w-2.5" />{i + 1}
              </span>
              <span className="absolute bottom-0.5 right-0.5 bg-black/70 text-white text-[10px] px-1 rounded">
                {d.toFixed(1)}s
              </span>
            </button>

            {/* Hover delete: remove this image from the part. */}
            {onRemoveSlot && part.images.length > 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); onRemoveSlot(i) }}
                title="Remove this image"
                className="absolute top-0.5 right-0.5 z-20 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity hover:bg-destructive group-hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            )}

            {/* Drag handle on the right edge (between this slot and the next) */}
            {i < part.images.length - 1 && (
              <div
                onMouseDown={(e) => {
                  e.preventDefault()
                  setDrag({ index: i, startX: e.clientX, start: [...durations] })
                }}
                className="absolute top-0 right-0 h-full w-1.5 -mr-0.75 cursor-col-resize bg-primary/0 hover:bg-primary/60 z-10"
                title="Drag to adjust duration"
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
