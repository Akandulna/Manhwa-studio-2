/**
 * Editor2Preview — Module 4v2: Editor 2.0 processing + preview.
 *
 * Opened by "Start Processing" on a chapter card. It processes the pasted
 * timeline JSON (loading screen), then plays the result back: images swap on
 * schedule above a scrubbable timeline while each section's own voiceover
 * plays in sync.
 *
 * Playback is driven by the section audio rather than a timer, because the
 * audio is the master clock the timeline was authored against — following it
 * keeps images on the words they were chosen for even if decoding drifts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { videoApi2, type PlanImage, type TimelinePlan } from '@/lib/api'
import { getTimelineJson, markProcessed } from './timelineHandoff'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  AlertTriangle,
  ArrowLeft,
  Clapperboard,
  ImageOff,
  Loader2,
  Move,
  Pause,
  Play,
  RotateCcw
} from 'lucide-react'

/** Where the motion toggle's state is remembered between visits. */
const MOTION_PREF_KEY = 'editor2:preview-motion'

/** Format seconds as M:SS for the readouts. */
function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * CSS transform approximating one image's Ken Burns motion at a given
 * progress (0..1) through its slot.
 *
 * Deliberately the same formulas as Editor 1.0's PreviewPlayer, so what the
 * two editors show for the same effect and intensity matches — including the
 * ×3 amplification, which exists because the render-time intensity is far too
 * subtle to read on a small preview.
 */
function motionStyle(image: PlanImage, progress: number, enabled: boolean): React.CSSProperties {
  if (!enabled) {
    return { maxHeight: '100%', maxWidth: '100%', objectFit: 'contain' }
  }

  const k = (image.motionIntensity || 0.04) * 3
  let scale = 1
  let panX = 0
  let panY = 0

  switch (image.motionEffect) {
    case 'zoom-out': scale = 1 + k * (1 - progress); break
    case 'pan-left': scale = 1 + k; panX = k * 30 * (1 - progress); break
    case 'pan-right': scale = 1 + k; panX = -k * 30 * progress; break
    case 'pan-up': scale = 1 + k; panY = k * 30 * (1 - progress); break
    case 'pan-down': scale = 1 + k; panY = -k * 30 * progress; break
    default: scale = 1 + k * progress // zoom-in
  }

  return {
    maxHeight: '100%',
    maxWidth: '100%',
    objectFit: 'contain',
    transform: `translate(${panX}%, ${panY}%) scale(${scale})`,
    transformOrigin: '50% 50%',
    // No CSS transition: the transform is recomputed every animation frame,
    // so easing here would fight the playhead and lag behind the audio.
    willChange: 'transform'
  }
}

export default function Editor2Preview() {
  const { chapterId } = useParams<{ chapterId: string }>()
  const navigate = useNavigate()

  const [plan, setPlan] = useState<TimelinePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(true)

  // Absolute playhead across the whole chapter.
  const [elapsed, setElapsed] = useState(0)
  const [playing, setPlaying] = useState(false)

  // Ken Burns motion, on by default to match Editor 1.0. Remembered locally
  // because it is a viewing preference, not part of the timeline.
  const [motion, setMotion] = useState(() => {
    try {
      return localStorage.getItem(MOTION_PREF_KEY) !== 'off'
    } catch {
      return true
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(MOTION_PREF_KEY, motion ? 'on' : 'off')
    } catch {
      // A preference that cannot be saved still applies for this visit.
    }
  }, [motion])

  // One <audio> per section, kept in a ref so playback control never waits on
  // a re-render.
  const audioRefs = useRef<(HTMLAudioElement | null)[]>([])
  const rafRef = useRef<number | null>(null)

  // ---------- Processing ----------

  useEffect(() => {
    if (!chapterId) return
    const json = getTimelineJson(chapterId)
    if (!json) {
      setProcessing(false)
      setError('No timeline JSON was handed over. Go back and paste it on the chapter card, then press Start Processing.')
      return
    }
    let cancelled = false
    setProcessing(true)
    videoApi2.processTimeline(chapterId, json)
      .then(result => {
        if (cancelled) return
        setPlan(result)
        // Only a successful build counts as processed — that is what lets the
        // chapter card offer Preview instead of Start Processing.
        markProcessed(chapterId, json)
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Processing failed') })
      .finally(() => { if (!cancelled) setProcessing(false) })
    return () => { cancelled = true }
  }, [chapterId])

  // ---------- Derived timeline ----------

  /** Every image in playback order, so the current frame is a lookup. */
  const allImages = useMemo<PlanImage[]>(
    () => plan?.sections.flatMap(s => s.slots.flatMap(slot => slot.images)) ?? [],
    [plan]
  )

  const currentImage = useMemo(() => {
    if (allImages.length === 0) return null
    // Last image whose start has passed — cheaper than a range scan and
    // correct even where rounding leaves a hairline gap between slots.
    let found: PlanImage | null = null
    for (const img of allImages) {
      if (img.startTime <= elapsed + 1e-6) found = img
      else break
    }
    return found ?? allImages[0]
  }, [allImages, elapsed])

  /** How far through its own slot the current image is, 0..1. */
  const imageProgress = useMemo(() => {
    if (!currentImage || currentImage.duration <= 0) return 0
    const through = (elapsed - currentImage.startTime) / currentImage.duration
    return Math.max(0, Math.min(1, through))
  }, [currentImage, elapsed])

  const activeSectionIdx = useMemo(() => {
    if (!plan) return 0
    let idx = 0
    plan.sections.forEach((s, i) => { if (s.startTime <= elapsed + 1e-6) idx = i })
    return idx
  }, [plan, elapsed])

  // ---------- Playback ----------

  /** Pause every section's audio. Used before any seek or section switch. */
  const pauseAll = useCallback(() => {
    audioRefs.current.forEach(a => { if (a && !a.paused) a.pause() })
  }, [])

  /** Move the playhead, putting the owning section's audio at the right spot. */
  const seekTo = useCallback((absolute: number, resume: boolean) => {
    if (!plan) return
    const clamped = Math.max(0, Math.min(absolute, plan.totalDuration))
    let idx = 0
    plan.sections.forEach((s, i) => { if (s.startTime <= clamped + 1e-6) idx = i })
    const section = plan.sections[idx]
    const offset = Math.max(0, clamped - section.startTime)

    pauseAll()
    setElapsed(clamped)
    const audio = audioRefs.current[idx]
    if (audio) {
      try { audio.currentTime = Math.min(offset, Math.max(0, (audio.duration || section.audioDuration) - 0.05)) } catch { /* not seekable yet */ }
      if (resume) void audio.play().catch(() => {})
    }
    setPlaying(resume)
  }, [plan, pauseAll])

  /**
   * Advance the playhead from whichever section is currently sounding.
   *
   * Sections without audio have no clock of their own, so they are stepped by
   * wall time instead — otherwise a silent section would freeze the preview.
   */
  useEffect(() => {
    if (!playing || !plan) return
    let last = performance.now()

    const tick = () => {
      const now = performance.now()
      const delta = (now - last) / 1000
      last = now

      const section = plan.sections[activeSectionIdx]
      const audio = audioRefs.current[activeSectionIdx]
      let next: number

      if (audio && !audio.paused && Number.isFinite(audio.currentTime)) {
        next = section.startTime + audio.currentTime
      } else {
        next = elapsedRef.current + delta
      }

      // Roll into the following section once this one is spent.
      const sectionEnd = section.startTime + section.audioDuration
      if (next >= sectionEnd - 0.02) {
        const nextIdx = activeSectionIdx + 1
        if (nextIdx >= plan.sections.length) {
          setElapsed(plan.totalDuration)
          setPlaying(false)
          pauseAll()
          return
        }
        pauseAll()
        setElapsed(plan.sections[nextIdx].startTime)
        const nextAudio = audioRefs.current[nextIdx]
        if (nextAudio) {
          try { nextAudio.currentTime = 0 } catch { /* ignore */ }
          void nextAudio.play().catch(() => {})
        }
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      setElapsed(next)
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [playing, plan, activeSectionIdx, pauseAll])

  // The rAF loop needs the live playhead without re-subscribing every frame.
  const elapsedRef = useRef(0)
  useEffect(() => { elapsedRef.current = elapsed }, [elapsed])

  const togglePlay = () => {
    if (!plan) return
    if (playing) {
      pauseAll()
      setPlaying(false)
      return
    }
    if (elapsed >= plan.totalDuration - 0.05) {
      seekTo(0, true)
      return
    }
    seekTo(elapsed, true)
  }

  useEffect(() => () => pauseAll(), [pauseAll])

  // Spacebar toggles playback, except while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      togglePlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---------- Render ----------

  if (processing) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
        <p className="text-sm font-medium">Processing timeline…</p>
        <p className="text-xs text-muted-foreground">
          Matching crops to their time slots and locating the section audio.
        </p>
      </div>
    )
  }

  if (error || !plan) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-6 text-center">
        <AlertTriangle className="h-10 w-10 text-destructive" />
        <div>
          <p className="font-medium">Could not build the preview</p>
          <p className="text-sm text-muted-foreground max-w-lg mt-1">{error}</p>
        </div>
        <Button variant="outline" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back
        </Button>
      </div>
    )
  }

  const progress = plan.totalDuration > 0 ? (elapsed / plan.totalDuration) * 100 : 0

  return (
    <div className="flex flex-col h-full">
      {/* Hidden per-section audio elements: the preview's master clock. */}
      {plan.sections.map((s, i) => (
        s.audioUrl ? (
          <audio
            key={`${s.label}-${i}`}
            ref={el => { audioRefs.current[i] = el }}
            src={s.audioUrl}
            preload="auto"
          />
        ) : null
      ))}

      <div className="p-4 border-b flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <Clapperboard className="h-5 w-5 text-primary" />
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">
            Chapter {plan.chapterNumber}
            {plan.chapterTitle ? ` — ${plan.chapterTitle}` : ''}
          </h1>
          <p className="text-xs text-muted-foreground">
            {plan.seriesTitle} · {plan.sections.length} sections · {plan.imageCount} images · {fmt(plan.totalDuration)}
          </p>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6 space-y-4 max-w-5xl">
          {(plan.missingRefs.length > 0 || plan.warnings.length > 0) && (
            <Card className="border-yellow-500/40 bg-yellow-500/5">
              <CardContent className="p-3 space-y-2">
                {plan.missingRefs.length > 0 && (
                  <div>
                    <p className="text-xs font-medium flex items-center gap-1 text-yellow-700">
                      <ImageOff className="h-3 w-3" />
                      {plan.missingRefs.length} image reference
                      {plan.missingRefs.length !== 1 ? 's' : ''} could not be found on disk
                    </p>
                    <p className="text-xs text-muted-foreground mt-1 font-mono break-all">
                      {plan.missingRefs.slice(0, 8).join(', ')}
                      {plan.missingRefs.length > 8 ? ` … +${plan.missingRefs.length - 8} more` : ''}
                    </p>
                  </div>
                )}
                {plan.warnings.map((w, i) => (
                  <p key={i} className="text-xs text-yellow-700 flex items-start gap-1">
                    <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                    {w}
                  </p>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Player */}
          <div className="bg-black rounded-lg overflow-hidden flex items-center justify-center aspect-video relative">
            {currentImage?.url ? (
              <>
                {/* Blurred, darkened fill behind the image — same treatment as
                    Editor 1.0, so tall crops sit on a soft backdrop rather
                    than hard black bars. */}
                <img
                  src={currentImage.url}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                  style={{ filter: 'blur(20px) brightness(0.8)', transform: 'scale(1.15)' }}
                  draggable={false}
                />
                <div className="absolute inset-0 bg-black/20" />
                <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
                  <img
                    key={currentImage.url}
                    src={currentImage.url}
                    alt={currentImage.ref}
                    style={motionStyle(currentImage, imageProgress, motion)}
                    draggable={false}
                  />
                </div>
              </>
            ) : (
              <div className="text-center text-muted-foreground p-6">
                <ImageOff className="h-10 w-10 mx-auto mb-2 opacity-40" />
                <p className="text-xs font-mono">{currentImage?.ref ?? 'No image'}</p>
                <p className="text-xs mt-1">not found in this chapter's crops</p>
              </div>
            )}
          </div>

          {/* Transport */}
          <div className="flex items-center gap-3">
            <Button size="icon" onClick={togglePlay}>
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
            <Button variant="outline" size="icon" onClick={() => seekTo(0, false)} title="Back to start">
              <RotateCcw className="h-4 w-4" />
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums w-24">
              {fmt(elapsed)} / {fmt(plan.totalDuration)}
            </span>
            <div
              className="flex-1 h-2 bg-secondary rounded-full cursor-pointer relative"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                const ratio = (e.clientX - rect.left) / rect.width
                seekTo(ratio * plan.totalDuration, playing)
              }}
            >
              <div className="h-full bg-primary rounded-full" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-xs text-muted-foreground w-28 truncate">
              {plan.sections[activeSectionIdx]?.label}
            </span>
            <Button
              variant={motion ? 'default' : 'outline'}
              size="sm"
              className="h-8 flex-shrink-0"
              onClick={() => setMotion(m => !m)}
              title={
                motion
                  ? 'Zoom / pan motion is on — click to see the images still'
                  : 'Zoom / pan motion is off — click to turn it on'
              }
            >
              <Move className="h-3 w-3 mr-1" />
              Motion {motion ? 'on' : 'off'}
            </Button>
          </div>

          {motion && currentImage && (
            <p className="text-xs text-muted-foreground">
              Current effect: <span className="font-mono">{currentImage.motionEffect}</span>
              {' · '}intensity {currentImage.motionIntensity}
              {' · '}the same gentle set Editor 1.0 applies at render time
            </p>
          )}

          {/* Timeline: one row per section, each slot proportional to its length */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Timeline</p>
            {plan.sections.map((section, si) => (
              <div key={`${section.label}-${si}`} className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className={`text-xs ${si === activeSectionIdx ? 'font-semibold text-primary' : 'text-muted-foreground'}`}>
                    {section.label}
                    {!section.audioUrl && <span className="ml-1 text-yellow-600">(no audio)</span>}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {fmt(section.startTime)} · {section.audioDuration.toFixed(2)}s
                  </span>
                </div>
                <div className="flex gap-0.5 h-12 rounded overflow-hidden bg-muted">
                  {section.slots.flatMap(slot => slot.images).map((img, ii) => {
                    const isNow = currentImage?.startTime === img.startTime
                    const width = section.audioDuration > 0
                      ? (img.duration / section.audioDuration) * 100
                      : 100
                    return (
                      <button
                        key={`${img.ref}-${ii}`}
                        onClick={() => seekTo(img.startTime, playing)}
                        title={`${img.ref} · ${img.duration.toFixed(2)}s`}
                        style={{ width: `${width}%` }}
                        className={`relative flex-shrink-0 overflow-hidden transition-all ${
                          isNow ? 'ring-2 ring-primary z-10' : 'opacity-70 hover:opacity-100'
                        } ${img.url ? '' : 'bg-destructive/20'}`}
                      >
                        {img.url ? (
                          <img src={img.url} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <ImageOff className="h-3 w-3 mx-auto text-destructive" />
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
