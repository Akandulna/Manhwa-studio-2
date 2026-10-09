/**
 * ReviewCanvas — the page viewer of the Crop Studio review, with box editing.
 *
 * Draws the original page, every crop and every uncovered stretch, and turns
 * pointer input into edits in integer page pixels:
 *
 *  - select tool: click to select (shift/⌘-click to add to the selection),
 *    drag a box to move it, drag one of its 8 handles to resize it;
 *  - draw tool: drag on the page to add a crop;
 *  - split tools: click inside the selected box to cut it along the guide.
 *
 * It owns no review data. During a drag it reports previews (`onPreview`) and
 * on release a single final change (`onCommit`), so a drag is one save and one
 * undo step. All geometry goes through lib/reviewEdits.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { clipper3Api, type Clipper3ReviewCrop } from '@/lib/api'
import {
  HANDLES,
  drawnBox,
  moveBox,
  resizeBox,
  splitBox,
  type Handle,
  type PxBox
} from '@/lib/reviewEdits'

export type ReviewTool = 'select' | 'draw' | 'split-h' | 'split-v'

export const BOX_COLORS = {
  idle: '#a855f7',
  open: '#f59e0b',
  done: '#22c55e',
  selected: '#facc15'
} as const

/** Uncovered stretches inked at least this much may hold artwork and are striped. Keep in step with GAP_ARTWORK_INK in the server's auditRules.ts. */
const GAP_ARTWORK_INK = 0.2
const HANDLE_PX = 10
/** How close to the viewer's top/bottom a drag starts auto-scrolling. */
const AUTOSCROLL_ZONE = 48

interface ReviewCanvasProps {
  chapterId: string
  filename: string
  W: number
  H: number
  crops: Clipper3ReviewCrop[]
  gaps: { y0: number; y1: number; inkShare: number | null }[]
  colorFor: (crop: Clipper3ReviewCrop) => string
  selected: string[]
  onSelect: (keys: string[]) => void
  tool: ReviewTool
  /** Displayed page width in CSS px. */
  displayWidth: number
  showOverlay: boolean
  locked: boolean
  onPreview: (key: string, bounds: PxBox | null) => void
  onCommitBounds: (key: string, bounds: PxBox) => void
  onDraw: (bounds: PxBox) => void
  onSplit: (key: string, axis: 'h' | 'v', at: number) => void
  /** Lets the parent scroll the viewer to a page y. */
  viewerRef: React.RefObject<HTMLDivElement>
}

type Drag =
  | { kind: 'move' | 'resize'; key: string; handle?: Handle; start: { x: number; y: number }; origin: PxBox; last: PxBox }
  | { kind: 'draw'; start: { x: number; y: number }; current: { x: number; y: number } }

const HANDLE_POS: Record<Handle, { left: string; top: string; cursor: string }> = {
  nw: { left: '0%', top: '0%', cursor: 'nwse-resize' },
  n: { left: '50%', top: '0%', cursor: 'ns-resize' },
  ne: { left: '100%', top: '0%', cursor: 'nesw-resize' },
  e: { left: '100%', top: '50%', cursor: 'ew-resize' },
  se: { left: '100%', top: '100%', cursor: 'nwse-resize' },
  s: { left: '50%', top: '100%', cursor: 'ns-resize' },
  sw: { left: '0%', top: '100%', cursor: 'nesw-resize' },
  w: { left: '0%', top: '50%', cursor: 'ew-resize' }
}

export function ReviewCanvas(props: ReviewCanvasProps) {
  const { chapterId, filename, W, H, crops, gaps, colorFor, selected, onSelect, tool, displayWidth, showOverlay, locked, viewerRef } = props
  const scale = displayWidth / W
  const displayHeight = H * scale
  const pageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [drawPreview, setDrawPreview] = useState<PxBox | null>(null)
  const [guide, setGuide] = useState<number | null>(null)

  // Latest callbacks for the window listeners, which are attached once per drag.
  const propsRef = useRef(props)
  propsRef.current = props

  /** Pointer position in page pixels (unrounded; reviewEdits rounds). */
  const toPage = useCallback((clientX: number, clientY: number) => {
    const rect = pageRef.current!.getBoundingClientRect()
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale }
  }, [scale])

  const autoScroll = (clientY: number) => {
    const viewer = viewerRef.current
    if (!viewer) return
    const rect = viewer.getBoundingClientRect()
    if (clientY > rect.bottom - AUTOSCROLL_ZONE) viewer.scrollTop += 24
    else if (clientY < rect.top + AUTOSCROLL_ZONE) viewer.scrollTop -= 24
  }

  const onMove = useCallback((e: MouseEvent) => {
    const drag = dragRef.current
    if (!drag) return
    autoScroll(e.clientY)
    const p = toPage(e.clientX, e.clientY)
    if (drag.kind === 'draw') {
      drag.current = p
      setDrawPreview(drawnBox(drag.start.x, drag.start.y, p.x, p.y, W, H))
      return
    }
    const dx = p.x - drag.start.x
    const dy = p.y - drag.start.y
    drag.last = drag.kind === 'move'
      ? moveBox(drag.origin, dx, dy, W, H)
      : resizeBox(drag.origin, drag.handle!, dx, dy, W, H)
    propsRef.current.onPreview(drag.key, drag.last)
  }, [toPage, W, H]) // eslint-disable-line react-hooks/exhaustive-deps

  const onUp = useCallback(() => {
    const drag = dragRef.current
    dragRef.current = null
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    if (!drag) return
    const { onCommitBounds, onPreview, onDraw } = propsRef.current
    if (drag.kind === 'draw') {
      const box = drawnBox(drag.start.x, drag.start.y, drag.current.x, drag.current.y, W, H)
      setDrawPreview(null)
      if (box) onDraw(box)
      return
    }
    const o = drag.origin
    const l = drag.last
    if (o.x0 === l.x0 && o.y0 === l.y0 && o.x1 === l.x1 && o.y1 === l.y1) onPreview(drag.key, null)
    else onCommitBounds(drag.key, l)
  }, [onMove, W, H])

  useEffect(() => () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }, [onMove, onUp])

  const startDrag = (drag: Drag) => {
    dragRef.current = drag
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const onBoxDown = (e: React.MouseEvent, crop: Clipper3ReviewCrop) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    if (tool === 'split-h' || tool === 'split-v') {
      if (!locked && selected.includes(crop.key)) {
        const p = toPage(e.clientX, e.clientY)
        props.onSplit(crop.key, tool === 'split-h' ? 'h' : 'v', tool === 'split-h' ? p.y : p.x)
      } else {
        onSelect([crop.key])
      }
      return
    }
    if (tool === 'draw') return onPageDown(e)
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      onSelect(selected.includes(crop.key) ? selected.filter(k => k !== crop.key) : [...selected, crop.key])
      return
    }
    onSelect([crop.key])
    if (locked) return
    startDrag({ kind: 'move', key: crop.key, start: toPage(e.clientX, e.clientY), origin: crop.bounds, last: crop.bounds })
  }

  const onHandleDown = (e: React.MouseEvent, crop: Clipper3ReviewCrop, handle: Handle) => {
    if (e.button !== 0 || locked) return
    e.stopPropagation()
    e.preventDefault()
    startDrag({ kind: 'resize', key: crop.key, handle, start: toPage(e.clientX, e.clientY), origin: crop.bounds, last: crop.bounds })
  }

  const onPageDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    if (tool === 'draw' && !locked) {
      const p = toPage(e.clientX, e.clientY)
      startDrag({ kind: 'draw', start: p, current: p })
      return
    }
    if (tool === 'select') onSelect([])
  }

  const onPageHover = (e: React.MouseEvent) => {
    if (tool !== 'split-h' && tool !== 'split-v') return
    const p = toPage(e.clientX, e.clientY)
    setGuide(Math.round(tool === 'split-h' ? p.y : p.x))
  }

  useEffect(() => { setGuide(null) }, [tool])

  const single = selected.length === 1 ? crops.find(c => c.key === selected[0]) : undefined
  const splitTarget = single && (tool === 'split-h' || tool === 'split-v') ? single : undefined
  const splitValid = splitTarget && guide !== null
    ? !!splitBox(splitTarget.bounds, tool === 'split-h' ? 'h' : 'v', guide)
    : false

  const px = (value: number) => value * scale

  return (
    <div ref={viewerRef} className="flex-1 min-h-0 overflow-auto rounded border bg-neutral-900">
      <div
        ref={pageRef}
        className="relative select-none"
        style={{
          width: displayWidth,
          height: displayHeight,
          cursor: tool === 'draw' ? 'crosshair' : tool === 'select' ? 'default' : 'copy'
        }}
        onMouseDown={onPageDown}
        onMouseMove={onPageHover}
        onMouseLeave={() => setGuide(null)}
      >
        <img
          src={clipper3Api.getImageUrl(chapterId, filename)}
          alt={filename}
          draggable={false}
          className="absolute inset-0 w-full h-full pointer-events-none"
        />

        {showOverlay && gaps.map(gap => {
          const busy = gap.inkShare === null || gap.inkShare >= GAP_ARTWORK_INK
          return (
            <div
              key={`gap-${gap.y0}`}
              className="absolute left-0 right-0 pointer-events-none"
              style={{
                top: px(gap.y0),
                height: px(gap.y1 - gap.y0),
                background: busy
                  ? 'repeating-linear-gradient(135deg, rgba(239,68,68,0.18) 0 8px, transparent 8px 16px)'
                  : 'rgba(115,115,115,0.10)',
                borderLeft: busy ? '4px solid rgba(239,68,68,0.8)' : undefined
              }}
            />
          )
        })}

        {showOverlay && crops.map((crop, i) => {
          const isSelected = selected.includes(crop.key)
          const color = isSelected ? BOX_COLORS.selected : colorFor(crop)
          const b = crop.bounds
          return (
            <div
              key={crop.key}
              onMouseDown={e => onBoxDown(e, crop)}
              className="absolute"
              style={{
                left: px(b.x0),
                top: px(b.y0),
                width: px(b.x1 - b.x0),
                height: px(b.y1 - b.y0),
                border: `2px solid ${color}`,
                background: isSelected ? 'rgba(250, 204, 21, 0.10)' : 'transparent',
                cursor: tool === 'select' ? (locked ? 'default' : 'move') : undefined
              }}
            >
              <span className="absolute left-0 top-0 px-1 text-[11px] font-mono font-semibold text-black pointer-events-none" style={{ background: color }}>
                {i + 1}
              </span>
              {single?.key === crop.key && tool === 'select' && !locked && HANDLES.map(handle => (
                <div
                  key={handle}
                  onMouseDown={e => onHandleDown(e, crop, handle)}
                  className="absolute border border-black"
                  style={{
                    left: HANDLE_POS[handle].left,
                    top: HANDLE_POS[handle].top,
                    width: HANDLE_PX,
                    height: HANDLE_PX,
                    marginLeft: -HANDLE_PX / 2,
                    marginTop: -HANDLE_PX / 2,
                    background: BOX_COLORS.selected,
                    cursor: HANDLE_POS[handle].cursor
                  }}
                />
              ))}
            </div>
          )
        })}

        {splitTarget && guide !== null && (
          <div
            className="absolute pointer-events-none"
            style={tool === 'split-h'
              ? { left: px(splitTarget.bounds.x0), width: px(splitTarget.bounds.x1 - splitTarget.bounds.x0), top: px(guide) - 1, height: 2, background: splitValid ? '#facc15' : '#ef4444' }
              : { top: px(splitTarget.bounds.y0), height: px(splitTarget.bounds.y1 - splitTarget.bounds.y0), left: px(guide) - 1, width: 2, background: splitValid ? '#facc15' : '#ef4444' }}
          />
        )}

        {drawPreview && (
          <div
            className="absolute pointer-events-none"
            style={{
              left: px(drawPreview.x0),
              top: px(drawPreview.y0),
              width: px(drawPreview.x1 - drawPreview.x0),
              height: px(drawPreview.y1 - drawPreview.y0),
              border: `2px dashed ${BOX_COLORS.selected}`
            }}
          />
        )}
      </div>
    </div>
  )
}
