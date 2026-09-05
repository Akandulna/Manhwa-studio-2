/**
 * PreviewPlayer — instant client-side "Live preview (approximate)". Renders the
 * blurred+darkened background + centered foreground with CSS transforms that
 * approximate the drift/focus motion, instant cuts between images, synced to
 * each part's AudioSection audio. Plays the whole selection end-to-end, or a
 * single part. This is an approximation; use "Render preview" for pixel-accuracy.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { videoApi, type VideoProject, type VideoPart, type VideoPartImage } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Play, Pause, X } from 'lucide-react'

/** Playback position reported to parents (e.g. the under-strip scrubber). */
export interface PlaybackState {
  elapsed: number
  total: number
  playing: boolean
}

/** Imperative controls exposed via ref so an external scrubber can drive playback. */
export interface PreviewPlayerHandle {
  seek: (seconds: number) => void
  play: () => void
  pause: () => void
}

interface Props {
  project: VideoProject
  scopePartId?: string | null
  /** When provided, renders a close affordance / backdrop dismiss. */
  onClose?: () => void
  /** Inline (non-modal) variant that fits its parent — used above the crop pool. */
  embedded?: boolean
  /** Hide the built-in seek timeline (the editor shows it under the image strip). */
  showSeekBar?: boolean
  /** Hide the whole controls row (play/pause/seek/time) — the editor relocates
   *  these under the image strip. The audio element stays mounted. */
  showControls?: boolean
  /** Stream the current playhead position/state to a parent. */
  onProgress?: (state: PlaybackState) => void
}

// m:ss timestamp for the seek bar.
function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// CSS transform approximating a slot's motion at a given progress (0..1).
function fgStyle(image: VideoPartImage, progress: number): React.CSSProperties {
  const k = (image.motionIntensity || 0.04) * 3 // amplify so it reads on screen
  const base = image.scale ?? 1
  const ox = (image.offsetX ?? 0) * 100
  const oy = (image.offsetY ?? 0) * 100
  let scale = base
  let origin = '50% 50%'
  let panX = 0
  let panY = 0

  if (image.motionMode === 'focus') {
    origin = `${(image.anchorX ?? 0.5) * 100}% ${(image.anchorY ?? 0.5) * 100}%`
    scale = base * (image.motionEffect === 'zoom-out' ? 1 + k - k * progress : 1 + k * progress)
  } else {
    switch (image.motionEffect) {
      case 'zoom-out': scale = base * (1 + k * (1 - progress)); break
      case 'pan-left': scale = base * (1 + k); panX = k * 30 * (1 - progress); break
      case 'pan-right': scale = base * (1 + k); panX = -k * 30 * progress; break
      case 'pan-up': scale = base * (1 + k); panY = k * 30 * (1 - progress); break
      case 'pan-down': scale = base * (1 + k); panY = -k * 30 * progress; break
      default: scale = base * (1 + k * progress) // zoom-in
    }
  }

  return {
    height: '100%',
    width: 'auto',
    transform: `translate(${ox + panX}%, ${oy + panY}%) scale(${scale})`,
    transformOrigin: origin
  }
}

function PreviewPlayer(
  { project, scopePartId, onClose, embedded, showSeekBar = true, showControls = true, onProgress }: Props,
  ref: React.Ref<PreviewPlayerHandle>
) {
  const parts: VideoPart[] = scopePartId
    ? project.parts.filter(p => p.id === scopePartId)
    : project.parts

  const [partIdx, setPartIdx] = useState(0)
  const [slotIdx, setSlotIdx] = useState(0)
  const [progress, setProgress] = useState(0)
  const [playing, setPlaying] = useState(false)
  // Elapsed seconds within the current part — drives the seek bar playhead.
  const [elapsed, setElapsed] = useState(0)

  const audioRef = useRef<HTMLAudioElement>(null)
  const rafRef = useRef<number | null>(null)
  const partStartRef = useRef<number>(0)      // wall-clock origin for silent parts
  const playingRef = useRef(false)
  const partIdxRef = useRef(0)
  const loadedRef = useRef<string | null>(null) // partId currently loaded into <audio>
  const pausedElapsedRef = useRef(0)            // resume point for silent parts
  const timelineRef = useRef<HTMLDivElement>(null)
  const [scrubbing, setScrubbing] = useState(false)

  const outroText = project.titleCardText || `${project.seriesTitle} · Thanks for watching`

  /** Push the current position/state to any parent (the under-strip scrubber). */
  function reportProgress(e: number, isPlaying = playingRef.current) {
    const p = parts[partIdxRef.current]
    onProgress?.({ elapsed: e, total: p?.audioDuration ?? 0, playing: isPlaying })
  }

  /** Seconds elapsed in the given part right now (audio clock or wall clock). */
  function currentElapsed(part: VideoPart): number {
    if (!part.isOutro && part.audioSectionId && audioRef.current && loadedRef.current === part.id) {
      return audioRef.current.currentTime
    }
    return (performance.now() - partStartRef.current) / 1000
  }

  /** Reflect a position within a part into slot index + motion progress + playhead. */
  function applyElapsed(part: VideoPart, e: number) {
    setElapsed(e)
    reportProgress(e)
    if (!part.isOutro && part.images.length > 0) {
      let acc = 0
      let si = 0
      for (let i = 0; i < part.images.length; i++) {
        if (e < acc + part.images[i].duration) { si = i; break }
        acc += part.images[i].duration
        si = i
      }
      const dur = part.images[si].duration || 1
      setSlotIdx(si)
      setProgress(Math.min(1, (e - acc) / dur))
    } else {
      setProgress(Math.min(1, e / part.audioDuration))
    }
  }

  // Drive playback with requestAnimationFrame, reading audio time (or a wall
  // clock for the silent outro) to pick the current slot + motion progress.
  function tick() {
    if (!playingRef.current) return
    const part = parts[partIdxRef.current]
    if (!part) { stop(); return }

    const e = currentElapsed(part)
    if (e >= part.audioDuration - 0.02) {
      const next = partIdxRef.current + 1
      if (next >= parts.length) { stop(); return }
      startPart(next)
      rafRef.current = requestAnimationFrame(tick)
      return
    }

    applyElapsed(part, e)
    rafRef.current = requestAnimationFrame(tick)
  }

  /** Load a part from its start (used when stepping to the next part). */
  function startPart(i: number) {
    partIdxRef.current = i
    setPartIdx(i)
    setSlotIdx(0)
    setProgress(0)
    setElapsed(0)
    pausedElapsedRef.current = 0
    const part = parts[i]
    partStartRef.current = performance.now()
    const audio = audioRef.current
    if (audio) {
      if (!part.isOutro && part.audioSectionId) {
        audio.src = videoApi.partAudioUrl(part.id)
        loadedRef.current = part.id
        audio.currentTime = 0
        if (playingRef.current) audio.play().catch(() => {})
      } else {
        audio.pause()
        audio.removeAttribute('src')
        loadedRef.current = null
      }
    }
  }

  /** Resume from the current position rather than restarting. */
  function play() {
    if (parts.length === 0) return
    playingRef.current = true
    setPlaying(true)
    reportProgress(pausedElapsedRef.current, true)
    const part = parts[partIdxRef.current]
    const audio = audioRef.current
    if (audio && part && !part.isOutro && part.audioSectionId) {
      if (loadedRef.current !== part.id) {
        audio.src = videoApi.partAudioUrl(part.id)
        loadedRef.current = part.id
        audio.currentTime = pausedElapsedRef.current
      }
      audio.play().catch(() => {})
    } else {
      // Silent part: anchor the wall clock so it resumes from the paused point.
      partStartRef.current = performance.now() - pausedElapsedRef.current * 1000
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  function pause() {
    const part = parts[partIdxRef.current]
    if (part) pausedElapsedRef.current = currentElapsed(part)
    playingRef.current = false
    setPlaying(false)
    audioRef.current?.pause()
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    reportProgress(pausedElapsedRef.current, false)
  }

  function stop() {
    playingRef.current = false
    setPlaying(false)
    audioRef.current?.pause()
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    partIdxRef.current = 0
    pausedElapsedRef.current = 0
    setPartIdx(0)
    setSlotIdx(0)
    setProgress(0)
    setElapsed(0)
    reportProgress(0, false)
  }

  /** Jump to a position (seconds) within the current part — keeps play state. */
  function seek(seconds: number) {
    const part = parts[partIdxRef.current]
    if (!part) return
    const clamped = Math.max(0, Math.min(seconds, part.audioDuration - 0.05))
    const audio = audioRef.current
    if (audio && !part.isOutro && part.audioSectionId) {
      if (loadedRef.current !== part.id) {
        audio.src = videoApi.partAudioUrl(part.id)
        loadedRef.current = part.id
      }
      audio.currentTime = clamped
    }
    partStartRef.current = performance.now() - clamped * 1000
    pausedElapsedRef.current = clamped
    applyElapsed(part, clamped)
  }

  /** Map a pointer x-position over the seek bar to a position in the part. */
  function seekFromClientX(clientX: number) {
    const part = parts[partIdxRef.current]
    const rect = timelineRef.current?.getBoundingClientRect()
    if (!part || !rect || rect.width === 0) return
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    seek(ratio * part.audioDuration)
  }

  // Drag-to-scrub on the seek bar.
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
  }, [scrubbing])

  // When the scoped part changes (focusing a different part), reset to a clean
  // stopped state so the seek bar and audio track the newly-focused part.
  useEffect(() => {
    playingRef.current = false
    setPlaying(false)
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    const audio = audioRef.current
    if (audio) { audio.pause(); audio.removeAttribute('src') }
    loadedRef.current = null
    pausedElapsedRef.current = 0
    partIdxRef.current = 0
    partStartRef.current = performance.now()
    setPartIdx(0)
    setSlotIdx(0)
    setProgress(0)
    setElapsed(0)
    onProgress?.({ elapsed: 0, total: parts[0]?.audioDuration ?? 0, playing: false })
  }, [scopePartId])

  useEffect(() => {
    return () => {
      playingRef.current = false
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // External scrubber (under the image strip) drives playback through this handle.
  useImperativeHandle(ref, () => ({ seek, play, pause }))

  const part = parts[partIdx]
  const image = part && !part.isOutro ? part.images[slotIdx] : null
  const isFiller = !image || image.isFiller || !image.cropId
  const total = part?.audioDuration || 0
  const playheadPct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0

  const body = (
    <>
      {/* Stage (16:9) */}
      <div className="relative w-full aspect-video bg-black overflow-hidden">
          {part?.isOutro || !part ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8" style={{ background: '#0B0B12' }}>
              <p className="text-white text-2xl font-bold whitespace-pre-line">{outroText}</p>
            </div>
          ) : isFiller ? (
            <div className="absolute inset-0 bg-black" />
          ) : (
            <>
              {/* Blurred + darkened background */}
              <img
                src={videoApi.cropImageUrl(image!.cropId!)}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
                style={{ filter: 'blur(20px) brightness(0.8)', transform: 'scale(1.15)' }}
                draggable={false}
              />
              <div className="absolute inset-0 bg-black/20" />
              {/* Foreground */}
              <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
                <img
                  src={videoApi.cropImageUrl(image!.cropId!)}
                  alt=""
                  style={fgStyle(image!, progress)}
                  draggable={false}
                />
              </div>
            </>
          )}

          <span className="absolute top-2 left-2 bg-black/70 text-white text-xs px-2 py-0.5 rounded">
            Live preview (approximate)
          </span>
        </div>

        {/* Controls — play/pause, seek bar and duration on one compact row.
            Hidden in the editor, where these live under the image strip. */}
        {showControls && (
        <div className="flex items-center gap-2 p-2 border-t">
          <Button size="icon" variant="outline" className="h-8 w-8 flex-shrink-0" onClick={playing ? pause : play}>
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>

          {/* Seekable timeline — click or drag anywhere to jump there. Each
              segment is one selected image, sized by its duration. Hidden in the
              editor, where the scrubber lives under the image strip instead. */}
          {showSeekBar ? (
            <div
              ref={timelineRef}
              onMouseDown={(e) => { e.preventDefault(); setScrubbing(true); seekFromClientX(e.clientX) }}
              title="Click or drag to seek"
              className="relative h-8 flex-1 min-w-0 rounded overflow-hidden border bg-neutral-950 cursor-pointer select-none"
            >
              <div className="flex h-full w-full">
                {part && !part.isOutro && part.images.length > 0 ? (
                  part.images.map((img, i) => {
                    const w = total > 0 ? (img.duration / total) * 100 : 100 / part.images.length
                    return (
                      <div
                        key={img.id}
                        className={`relative h-full ${i > 0 ? 'border-l border-black/70' : ''}`}
                        style={{ width: `${w}%` }}
                      >
                        {img.isFiller || !img.cropId ? (
                          <div className="w-full h-full bg-black" />
                        ) : (
                          <img
                            src={videoApi.cropImageUrl(img.cropId)}
                            alt=""
                            className={`w-full h-full object-cover ${i === slotIdx ? 'opacity-100' : 'opacity-60'}`}
                            draggable={false}
                          />
                        )}
                        <span className="absolute top-0 left-0 bg-black/70 text-white text-[9px] px-1 rounded-br">{i + 1}</span>
                      </div>
                    )
                  })
                ) : (
                  <div className="w-full h-full bg-neutral-800" />
                )}
              </div>
              {/* Played-region shade + playhead */}
              <div className="absolute inset-y-0 left-0 bg-primary/25 pointer-events-none" style={{ width: `${playheadPct}%` }} />
              <div className="absolute inset-y-0 w-0.5 bg-primary shadow pointer-events-none" style={{ left: `${playheadPct}%` }} />
            </div>
          ) : (
            <div className="flex-1 min-w-0" />
          )}

          <span className="text-[11px] tabular-nums text-muted-foreground flex-shrink-0">
            {fmtTime(elapsed)} / {fmtTime(total)}
          </span>
          {onClose && (
            <Button size="icon" variant="ghost" className="h-8 w-8 flex-shrink-0" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        )}

        <audio ref={audioRef} className="hidden" />
    </>
  )

  // Inline variant: sits above the crop pool inside the context panel.
  if (embedded) {
    return (
      <div className="bg-card border rounded-lg overflow-hidden">
        {body}
      </div>
    )
  }

  // Modal variant: full-screen overlay launched from the "Live" button.
  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-card rounded-lg overflow-hidden w-full max-w-4xl" onClick={e => e.stopPropagation()}>
        {body}
      </div>
    </div>
  )
}

export default forwardRef(PreviewPlayer)
