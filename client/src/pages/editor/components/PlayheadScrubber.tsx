/**
 * PlayheadScrubber — a thin seek track rendered directly beneath a focused
 * part's ImageSlotStrip. It mirrors the strip's per-image segments (so the
 * playhead lines up with the image you're timing) and drives the embedded
 * PreviewPlayer via onScrub. Position updates arrive through a ref-based
 * subscription so 60fps playback never re-renders the whole timeline.
 */

import { useEffect, useRef, useState } from 'react'
import { type VideoPart } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Play, Pause } from 'lucide-react'
import { type PlaybackState } from './PreviewPlayer'

interface Props {
  part: VideoPart
  /** Subscribe to playhead updates; returns an unsubscribe fn. */
  subscribe: (listener: (s: PlaybackState) => void) => () => void
  /** Seek the player to a position (seconds) within this part. */
  onScrub: (seconds: number) => void
  /** Toggle play/pause on the embedded player. */
  onTogglePlay: () => void
}

export default function PlayheadScrubber({ part, subscribe, onScrub, onTogglePlay }: Props) {
  const total = part.audioDuration
  const trackRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<PlaybackState>({ elapsed: 0, total, playing: false })
  const [scrubbing, setScrubbing] = useState(false)

  useEffect(() => subscribe(setState), [subscribe])

  const pct = total > 0 ? Math.min(100, (state.elapsed / total) * 100) : 0

  function seekFromClientX(clientX: number) {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    onScrub(ratio * total)
  }

  useEffect(() => {
    if (!scrubbing) return
    const onMove = (e: MouseEvent) => seekFromClientX(e.clientX)
    const onUp = () => setScrubbing(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [scrubbing, total])

  return (
    <div className="mt-1 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <Button
        size="icon"
        variant="outline"
        className="h-7 w-7 flex-shrink-0"
        onClick={onTogglePlay}
        title={state.playing ? 'Pause (Space)' : 'Play (Space)'}
      >
        {state.playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      </Button>
      <div
        ref={trackRef}
        onMouseDown={(e) => { e.preventDefault(); setScrubbing(true); seekFromClientX(e.clientX) }}
        title="Click or drag to scrub — the playhead lines up with the images above"
        className="relative h-3 flex-1 min-w-0 rounded bg-neutral-800 cursor-pointer select-none overflow-hidden"
      >
        {/* Segment boundaries that match the image strip above. */}
        <div className="flex h-full w-full">
          {part.images.map((img, i) => {
            const w = total > 0 ? (img.duration / total) * 100 : 100 / part.images.length
            return (
              <div
                key={img.id}
                className={`h-full ${i > 0 ? 'border-l border-neutral-950' : ''}`}
                style={{ width: `${w}%` }}
              />
            )
          })}
        </div>
        {/* Played-region shade + playhead line. */}
        <div className="absolute inset-y-0 left-0 bg-primary/30 pointer-events-none" style={{ width: `${pct}%` }} />
        <div className="absolute inset-y-0 w-0.5 bg-primary shadow pointer-events-none" style={{ left: `${pct}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-muted-foreground flex-shrink-0 w-16 text-right">
        {state.elapsed.toFixed(1)}s / {total.toFixed(1)}s
      </span>
    </div>
  )
}
