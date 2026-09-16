/**
 * CropPointerEditor — shared crop-box drag/resize editor for Image Clipper 3.0.
 *
 * Used by both Clipper3Preview (the whole chapter stacked) and
 * Clipper3ImageList's single-image dialog. Pulled out so the two call sites
 * share one drag/resize/save implementation rather than maintaining copies
 * that could drift.
 *
 * Editing is deliberately a plain axis-aligned rectangle drag/resize, never a
 * per-point skew: the cutter (perImageCrop.ts entryPixelRect) always cuts the
 * bounding box of a crop's 4 points regardless of stored `mode`, so a
 * rectangle editor can only ever produce exactly what would be cut anyway.
 *
 * This component owns the fetch of the image's own crop file and the PUT on
 * save — a caller only needs an image's filename/width/height and a chapter
 * id. `onSaved` lets the caller refresh its own row/status state after a
 * successful save.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2, Pencil, Save, X } from 'lucide-react'
import { clipperApi, clipper3Api, type Clipper3CropEntry, type Clipper3ImageCropFile, type Clipper3ImagePoints } from '@/lib/api'
import { useToast } from '@/components/ui/use-toast'
import { seriesSlug, stemOf, exportedFilenameFor } from '@/lib/clipper3Naming'

const ACCENT = '#a855f7'
const SELECTED_ACCENT = '#facc15'
const DOT_PX = 10
const HANDLE_PX = 10

const LABEL_OFFSET: Record<string, React.CSSProperties> = {
  P1: { bottom: '100%', right: '100%' },
  P2: { bottom: '100%', left: '100%' },
  P3: { top: '100%', left: '100%' },
  P4: { top: '100%', right: '100%' }
}

interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

function entryBounds(entry: Clipper3CropEntry): Bounds | null {
  const points = (entry.crop?.points ?? []).filter(
    p => Number.isFinite(p.x) && Number.isFinite(p.y)
  )
  if (points.length === 0) return null
  const xs = points.map(p => p.x)
  const ys = points.map(p => p.y)
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys)
  }
}

function boundsToEntry(entry: Clipper3CropEntry, bounds: Bounds): Clipper3CropEntry {
  const ids = entry.crop.points.map(p => p.id)
  const corners: Record<string, { x: number; y: number }> = {
    P1: { x: bounds.left, y: bounds.top },
    P2: { x: bounds.right, y: bounds.top },
    P3: { x: bounds.right, y: bounds.bottom },
    P4: { x: bounds.left, y: bounds.bottom }
  }
  return {
    ...entry,
    crop: {
      ...entry.crop,
      mode: 'rectangle',
      points: ids.map((id, i) => ({ ...(corners[id ?? `P${i + 1}`] ?? corners[`P${i + 1}`]), id: id ?? `P${i + 1}` }))
    }
  }
}

/**
 * Drops one crop's entry from a metadata document and renumbers what's left.
 *
 * The store treats this document as opaque text (it is written by whatever
 * template Settings holds), so this is best-effort by design: it only rewrites
 * a document that actually parses as JSON with a `crops` array, and returns
 * null for anything else rather than mangling it. A null result means the
 * caller leaves the metadata file untouched and says so.
 *
 * Renumbering matters because `exportedFilename` encodes a 1-based position
 * that the cutter regenerates from array order — after a removal, every later
 * entry's stored name would otherwise point at a file that never gets written.
 * Ids are deliberately NOT renumbered: they are the join key back to the crop
 * points file, and rewriting them would break that pairing.
 */
export function removeCropFromMetadata(
  metadataText: string,
  removedCropId: string,
  remainingCrops: Clipper3CropEntry[],
  opts: { seriesTitle: string; imageFilename: string }
): string | null {
  let parsed: any
  try {
    parsed = JSON.parse(metadataText)
  } catch {
    return null
  }
  if (!parsed || !Array.isArray(parsed.crops)) return null

  const slug = seriesSlug(opts.seriesTitle)
  const stem = stemOf(opts.imageFilename)

  const kept = parsed.crops.filter((entry: any) => entry?.id !== removedCropId)

  // Reason strings live in the POINTS file, not here, so the new filename is
  // rebuilt from the surviving crop entries in their post-removal order.
  const reasonById = new Map(remainingCrops.map(c => [c.id, c.reason]))
  const renumbered = kept.map((entry: any, index: number) => {
    if (typeof entry?.exportedFilename !== 'string') return entry
    return {
      ...entry,
      exportedFilename: exportedFilenameFor(slug, stem, index, reasonById.get(entry?.id))
    }
  })

  return JSON.stringify({ ...parsed, crops: renumbered }, null, 2)
}

type DragMode =
  | { kind: 'move'; startX: number; startY: number; origin: Bounds }
  | { kind: 'resize'; handle: 'nw' | 'ne' | 'sw' | 'se'; startX: number; startY: number; origin: Bounds }

const CLAMP01 = (n: number) => Math.min(1, Math.max(0, n))
const MIN_SIZE = 0.01

export interface CropPointerEditorProps {
  chapterId: string
  filename: string
  width: number
  height: number
  zoom: number
  /**
   * The series title, used to rebuild `exportedFilename` values in the
   * metadata document after a crop is removed. Without it, removal still drops
   * the crop but leaves the metadata file alone (and says so).
   */
  seriesTitle?: string
  /** Preloaded file, if the caller already has it (skips the initial fetch). */
  initialFile?: Clipper3ImageCropFile | null
  /** Fired after a successful save, with the server's canonical response. */
  onSaved?: (result: Clipper3ImagePoints) => void
  /** Ring/label color when this image is not being edited. Defaults to purple. */
  idleAccent?: string
  /** Fired whenever this image enters/exits edit mode, so a caller stacking
   *  several editors (Clipper3Preview) can dim the ones not being edited. */
  onEditingChange?: (editing: boolean) => void
  /**
   * Once editing starts, renders Save/Cancel as a fixed panel pinned to the
   * viewport's right edge instead of inline above the image. Needed on
   * Clipper3Preview: cards are stacked and can run taller than the viewport,
   * so an inline Save button scrolls out of reach mid-drag. The "Adjust
   * pointers" trigger itself stays inline either way — it's only ever shown
   * on one card at a time before editing starts, so it never needs to float.
   * A caller with a short, non-scrolling container (the image-list dialog)
   * should leave this off.
   */
  floatingControls?: boolean
}

export function CropPointerEditor({
  chapterId,
  filename,
  width,
  height,
  zoom,
  seriesTitle,
  initialFile,
  onSaved,
  idleAccent = '#3b82f6',
  onEditingChange,
  floatingControls = false
}: CropPointerEditorProps) {
  const { toast } = useToast()
  const [file, setFile] = useState<Clipper3ImageCropFile | null>(initialFile ?? null)
  const [loading, setLoading] = useState(initialFile === undefined)
  const [editing, setEditing] = useState(false)
  const [selectedCropId, setSelectedCropId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // Crops removed this editing session, oldest first. Staged rather than
  // written immediately so Cancel can discard them like any other edit; on
  // Save each one is also dropped from the metadata document.
  const [removedCropIds, setRemovedCropIds] = useState<string[]>([])

  const dragRef = useRef<DragMode | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (initialFile !== undefined) return
    let cancelled = false
    setLoading(true)
    clipper3Api.getImagePoints(chapterId, filename)
      .then(points => { if (!cancelled) setFile(points.file) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [chapterId, filename, initialFile])

  const reload = useCallback(() => {
    setLoading(true)
    clipper3Api.getImagePoints(chapterId, filename)
      .then(points => setFile(points.file))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [chapterId, filename])

  const startEditing = useCallback(() => {
    setEditing(true)
    setSelectedCropId(null)
    setDirty(false)
    setRemovedCropIds([])
    onEditingChange?.(true)
  }, [onEditingChange])

  const cancelEditing = useCallback(() => {
    if (dirty && !window.confirm('Discard unsaved pointer changes for this image?')) return
    reload()
    setEditing(false)
    setSelectedCropId(null)
    setDirty(false)
    setRemovedCropIds([])
    onEditingChange?.(false)
  }, [dirty, reload, onEditingChange])

  /**
   * Stages one crop for removal. The server refuses a points file with zero
   * usable crops (it would make the image un-cuttable while still claiming to
   * be done), so the last remaining crop cannot be removed here — clearing an
   * image entirely is what the row dialog's "remove crop JSON" is for.
   */
  const removeCrop = useCallback((cropId: string) => {
    const remaining = (file?.crops ?? []).filter(c => c.id !== cropId)
    if (remaining.length === 0) {
      toast({
        title: 'Cannot remove the last crop',
        description: 'An image needs at least one crop. Use "Remove this image\'s crop JSON" in the image list to clear it entirely.',
        variant: 'destructive'
      })
      return
    }

    setFile(prev => (prev ? { ...prev, crops: prev.crops.filter(c => c.id !== cropId) } : prev))
    setRemovedCropIds(prev => [...prev, cropId])
    setSelectedCropId(null)
    setDirty(true)
  }, [file, toast])

  const updateCropBounds = useCallback((cropId: string, bounds: Bounds) => {
    setFile(prev => {
      if (!prev) return prev
      return {
        ...prev,
        crops: prev.crops.map(entry => (entry.id === cropId ? boundsToEntry(entry, bounds) : entry))
      }
    })
    setDirty(true)
  }, [])

  const beginDrag = useCallback((
    e: React.MouseEvent,
    entry: Clipper3CropEntry,
    mode: DragMode['kind'],
    handle?: 'nw' | 'ne' | 'sw' | 'se'
  ) => {
    e.stopPropagation()
    e.preventDefault()
    const bounds = entryBounds(entry)
    if (!bounds || !boxRef.current) return
    setSelectedCropId(entry.id)

    const rect = boxRef.current.getBoundingClientRect()
    dragRef.current = mode === 'move'
      ? { kind: 'move', startX: e.clientX, startY: e.clientY, origin: bounds }
      : { kind: 'resize', handle: handle!, startX: e.clientX, startY: e.clientY, origin: bounds }

    const onMouseMove = (ev: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const dxFrac = (ev.clientX - drag.startX) / rect.width
      const dyFrac = (ev.clientY - drag.startY) / rect.height

      let next: Bounds
      if (drag.kind === 'move') {
        const w = drag.origin.right - drag.origin.left
        const h = drag.origin.bottom - drag.origin.top
        const left = Math.min(Math.max(0, drag.origin.left + dxFrac), 1 - w)
        const top = Math.min(Math.max(0, drag.origin.top + dyFrac), 1 - h)
        next = { left, top, right: left + w, bottom: top + h }
      } else {
        next = { ...drag.origin }
        if (drag.handle === 'nw') { next.left = CLAMP01(drag.origin.left + dxFrac); next.top = CLAMP01(drag.origin.top + dyFrac) }
        if (drag.handle === 'ne') { next.right = CLAMP01(drag.origin.right + dxFrac); next.top = CLAMP01(drag.origin.top + dyFrac) }
        if (drag.handle === 'sw') { next.left = CLAMP01(drag.origin.left + dxFrac); next.bottom = CLAMP01(drag.origin.bottom + dyFrac) }
        if (drag.handle === 'se') { next.right = CLAMP01(drag.origin.right + dxFrac); next.bottom = CLAMP01(drag.origin.bottom + dyFrac) }

        if (next.right - next.left < MIN_SIZE) {
          if (drag.handle === 'nw' || drag.handle === 'sw') next.left = next.right - MIN_SIZE
          else next.right = next.left + MIN_SIZE
        }
        if (next.bottom - next.top < MIN_SIZE) {
          if (drag.handle === 'nw' || drag.handle === 'ne') next.top = next.bottom - MIN_SIZE
          else next.bottom = next.top + MIN_SIZE
        }
      }

      updateCropBounds(entry.id, next)
    }

    const onMouseUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [updateCropBounds])

  const saveEdits = useCallback(async () => {
    if (!file) return
    setSaving(true)
    try {
      const content = JSON.stringify(file, null, 2)
      const stored = await clipper3Api.putImagePoints(chapterId, filename, content)

      // Points are the source of truth and are written first: if the metadata
      // rewrite below fails, the crop is still gone from what gets cut, and
      // the toast says the description was left behind rather than implying
      // the whole removal failed.
      let metadataNote = ''
      if (removedCropIds.length > 0) {
        if (!seriesTitle) {
          metadataNote = ' · metadata left unchanged'
        } else {
          try {
            const current = await clipper3Api.getImageMetadata(chapterId, filename)
            let text = current.content
            let rewrote = text.trim().length > 0
            for (const removedId of removedCropIds) {
              const next = rewrote
                ? removeCropFromMetadata(text, removedId, stored.file?.crops ?? [], {
                    seriesTitle,
                    imageFilename: filename
                  })
                : null
              if (next == null) { rewrote = false; break }
              text = next
            }
            if (rewrote) {
              await clipper3Api.putImageMetadata(chapterId, filename, text)
              metadataNote = ' · metadata updated'
            } else {
              metadataNote = ' · metadata not in the expected format, left unchanged'
            }
          } catch {
            metadataNote = ' · metadata could not be updated'
          }
        }
      }

      setFile(stored.file)
      setDirty(false)
      setEditing(false)
      setSelectedCropId(null)
      setRemovedCropIds([])
      onEditingChange?.(false)
      toast({
        title: 'Pointers saved',
        description: `${filename} · ${stored.cropCount} crop${stored.cropCount === 1 ? '' : 's'}${metadataNote}`
      })
      onSaved?.(stored)
    } catch (error) {
      toast({
        title: 'Could not save pointers',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }, [chapterId, file, filename, removedCropIds, seriesTitle, onSaved, onEditingChange, toast])

  const crops = file?.crops ?? []

  // The trigger stays inline always: it's only ever shown on the one
  // not-yet-editing card, so there's nothing to scroll away from.
  const adjustTrigger = !editing && crops.length > 0 && (
    <Button variant="outline" size="sm" className="h-7 ml-auto" onClick={startEditing}>
      <Pencil className="h-3.5 w-3.5 mr-1" />
      Adjust pointers
    </Button>
  )

  // Save/Cancel, inline above the image — used unless floatingControls asks
  // for the fixed panel below instead.
  const inlineSaveCancel = editing && (
    <>
      <span className="text-xs text-amber-500 flex items-center gap-1">
        <Pencil className="h-3 w-3" />
        Editing pointers{dirty ? ' · unsaved' : ''}
      </span>
      <div className="flex items-center gap-1 ml-auto">
        <Button variant="outline" size="sm" className="h-7" onClick={cancelEditing} disabled={saving}>
          <X className="h-3.5 w-3.5 mr-1" />
          Cancel
        </Button>
        <Button size="sm" className="h-7" onClick={saveEdits} disabled={saving || !dirty}>
          {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1" />}
          Save pointers
        </Button>
      </div>
    </>
  )

  // Floating: pinned to the viewport's right edge so Save/Cancel stay
  // reachable regardless of scroll position when cards are stacked taller
  // than the viewport (Clipper3Preview). Fixed positioning is deliberate —
  // this sits outside any single card's box and must not scroll with it.
  // Only rendered by the card currently being edited (editing is true here),
  // so there is never more than one on screen at once.
  const floatingSaveCancel = floatingControls && editing && (
    <div
      className="fixed z-50 flex flex-col items-stretch gap-2 rounded-lg border bg-card p-2 shadow-lg"
      style={{ top: '50%', right: 16, transform: 'translateY(-50%)' }}
    >
      <span className="text-xs text-amber-500 flex items-center gap-1 justify-center">
        <Pencil className="h-3 w-3" />
        {dirty ? 'Unsaved changes' : 'Editing pointers'}
      </span>
      <Button size="sm" onClick={saveEdits} disabled={saving || !dirty}>
        {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1" />}
        Save pointers
      </Button>
      <Button variant="outline" size="sm" onClick={cancelEditing} disabled={saving}>
        <X className="h-3.5 w-3.5 mr-1" />
        Cancel
      </Button>
    </div>
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {adjustTrigger}
        {!floatingControls && inlineSaveCancel}
      </div>
      {floatingSaveCancel}

      <div
        ref={boxRef}
        className="relative bg-neutral-950 rounded-sm overflow-hidden mx-auto"
        style={{ width: width * zoom, height: height * zoom }}
        onMouseDown={() => { if (editing) setSelectedCropId(null) }}
      >
        <img
          src={clipperApi.getImageUrl(chapterId, filename)}
          alt={filename}
          draggable={false}
          style={{ width: '100%', height: '100%', display: 'block', pointerEvents: 'none', userSelect: 'none' }}
        />

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <Loader2 className="h-5 w-5 animate-spin text-white" />
          </div>
        )}

        {crops.map(entry => {
          const bounds = entryBounds(entry)
          if (!bounds) return null
          const isSelected = editing && selectedCropId === entry.id
          const color = isSelected ? SELECTED_ACCENT : (editing ? ACCENT : idleAccent)

          return (
            <div key={entry.id}>
              <div
                title={`${entry.id} — ${entry.reason}`}
                style={{
                  position: 'absolute',
                  left: `${bounds.left * 100}%`,
                  top: `${bounds.top * 100}%`,
                  width: `${(bounds.right - bounds.left) * 100}%`,
                  height: `${(bounds.bottom - bounds.top) * 100}%`,
                  border: `2px solid ${color}`,
                  background: `${color}1f`,
                  pointerEvents: editing ? 'auto' : 'none',
                  cursor: editing ? 'move' : undefined,
                  zIndex: isSelected ? 25 : 20
                }}
                onMouseDown={editing ? (e) => beginDrag(e, entry, 'move') : undefined}
              >
                <div
                  className="absolute flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium text-white whitespace-nowrap"
                  style={{
                    top: 2,
                    left: 2,
                    maxWidth: 'calc(100% - 4px)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    background: 'rgba(24,24,27,0.82)',
                    border: `1px solid ${color}`,
                    pointerEvents: 'none'
                  }}
                >
                  <span>{entry.id}</span>
                  {entry.reason && <span className="opacity-80">{entry.reason}</span>}
                </div>

                {/* Removes this crop. Sits inside the box so it is always
                    beside what it deletes, and stops propagation so the
                    click cannot start a move drag on the way out. */}
                {isSelected && (
                  <button
                    title={`Remove ${entry.id}`}
                    onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                    onClick={(e) => { e.stopPropagation(); removeCrop(entry.id) }}
                    style={{
                      position: 'absolute',
                      top: 2,
                      right: 2,
                      width: 18,
                      height: 18,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: '#ef4444',
                      color: 'white',
                      border: '1px solid #0a0a0a',
                      borderRadius: 3,
                      cursor: 'pointer',
                      zIndex: 31,
                      lineHeight: 1
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}

                {isSelected && (['nw', 'ne', 'sw', 'se'] as const).map(handle => (
                  <div
                    key={handle}
                    onMouseDown={(e) => beginDrag(e, entry, 'resize', handle)}
                    style={{
                      position: 'absolute',
                      width: HANDLE_PX,
                      height: HANDLE_PX,
                      background: SELECTED_ACCENT,
                      border: '1px solid #0a0a0a',
                      borderRadius: 2,
                      zIndex: 30,
                      top: handle.startsWith('n') ? -HANDLE_PX / 2 : undefined,
                      bottom: handle.startsWith('s') ? -HANDLE_PX / 2 : undefined,
                      left: handle.endsWith('w') ? -HANDLE_PX / 2 : undefined,
                      right: handle.endsWith('e') ? -HANDLE_PX / 2 : undefined,
                      cursor: handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize'
                    }}
                  />
                ))}
              </div>

              {!isSelected && (entry.crop?.points ?? [])
                .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
                .map(point => (
                  <div
                    key={point.id}
                    onMouseDown={editing ? (e) => { e.stopPropagation(); setSelectedCropId(entry.id) } : undefined}
                    style={{
                      position: 'absolute',
                      left: `${point.x * 100}%`,
                      top: `${point.y * 100}%`,
                      width: DOT_PX,
                      height: DOT_PX,
                      marginLeft: -DOT_PX / 2,
                      marginTop: -DOT_PX / 2,
                      background: color,
                      border: '1px solid #faf5ff',
                      pointerEvents: editing ? 'auto' : 'none',
                      cursor: editing ? 'pointer' : undefined,
                      zIndex: 22
                    }}
                  >
                    <span
                      className="absolute text-[9px] font-bold leading-none px-0.5"
                      style={{
                        ...(LABEL_OFFSET[point.id] ?? LABEL_OFFSET.P1),
                        color: '#faf5ff',
                        background: 'rgba(24,24,27,0.75)',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {point.id}
                    </span>
                  </div>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
