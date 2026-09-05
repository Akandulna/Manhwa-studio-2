/**
 * PartBlock — one script part in the timeline: its script text, audio duration,
 * and the image-slot strip. The outro part shows the end-card summary instead.
 */

import { type VideoPart } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Clock, Flag, Sparkles, Wand2, Loader2 } from 'lucide-react'
import ImageSlotStrip from './ImageSlotStrip'
import PlayheadScrubber from './PlayheadScrubber'
import { type PlaybackState } from './PreviewPlayer'

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s.toFixed(0)}s`
}

interface Props {
  part: VideoPart
  outroText: string
  isFocused: boolean
  selectedImageId: string | null
  onFocus: (partId: string) => void
  onSelectSlot: (partId: string, imageId: string) => void
  onDurationsCommit: (partId: string, durations: number[]) => void
  onRemoveSlot?: (partId: string, index: number) => void
  onReorderSlot?: (partId: string, from: number, to: number) => void
  aiAvailable?: boolean
  onSuggestImages?: (partId: string) => void
  onFitTiming?: (partId: string) => void
  isSuggesting?: boolean
  isFitting?: boolean
  /** Playback wiring for the under-strip scrubber (focused part only). */
  subscribePlayback?: (listener: (s: PlaybackState) => void) => () => void
  onScrub?: (partId: string, seconds: number) => void
  onTogglePlay?: () => void
}

export default function PartBlock({
  part, outroText, isFocused, selectedImageId, onFocus, onSelectSlot, onDurationsCommit, onRemoveSlot, onReorderSlot,
  aiAvailable, onSuggestImages, onFitTiming, isSuggesting, isFitting, subscribePlayback, onScrub, onTogglePlay
}: Props) {
  const canFitTiming = !part.isOutro && part.images.length >= 2 && !!onFitTiming
  const canSuggest = !part.isOutro && aiAvailable && !!onSuggestImages
  return (
    <div
      onClick={() => onFocus(part.id)}
      className={`rounded-lg border p-3 cursor-pointer transition-colors ${
        isFocused ? 'border-primary bg-primary/5' : 'hover:border-primary/40'
      }`}
    >
      <div className="flex items-start gap-3 mb-2">
        <div className="flex-1 min-w-0">
          {part.isOutro ? (
            <p className="text-sm italic flex items-center gap-1.5">
              <Flag className="h-3.5 w-3.5 text-primary" />
              {outroText}
            </p>
          ) : (
            <p className="text-sm whitespace-pre-wrap break-words">{part.scriptText || '(no script text)'}</p>
          )}
        </div>
        <Badge variant="secondary" className="flex items-center gap-1 flex-shrink-0">
          <Clock className="h-3 w-3" />
          {fmtDuration(part.audioDuration)}
        </Badge>
      </div>

      {(canSuggest || canFitTiming) && (
        <div className="flex items-center gap-1.5 mb-2">
          {canSuggest && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={isSuggesting}
              onClick={(e) => { e.stopPropagation(); onSuggestImages!(part.id) }}
              title="Suggest images for this part with AI"
            >
              {isSuggesting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
              Suggest
            </Button>
          )}
          {canFitTiming && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={isFitting}
              onClick={(e) => { e.stopPropagation(); onFitTiming!(part.id) }}
              title="Fit image durations to the narration with AI"
            >
              {isFitting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Wand2 className="h-3.5 w-3.5 mr-1" />}
              Fit timing
            </Button>
          )}
        </div>
      )}

      {!part.isOutro && (
        <ImageSlotStrip
          part={part}
          selectedImageId={isFocused ? selectedImageId : null}
          onSelectSlot={(imageId) => onSelectSlot(part.id, imageId)}
          onDurationsCommit={(durations) => onDurationsCommit(part.id, durations)}
          onRemoveSlot={onRemoveSlot ? (index) => onRemoveSlot(part.id, index) : undefined}
          onReorder={onReorderSlot ? (from, to) => onReorderSlot(part.id, from, to) : undefined}
        />
      )}

      {/* Playhead/scrubber lives right under the strip so the user can scrub
          while adjusting each image's timeframe. Focused part only. */}
      {!part.isOutro && isFocused && part.images.length > 0 && subscribePlayback && onScrub && onTogglePlay && (
        <PlayheadScrubber
          part={part}
          subscribe={subscribePlayback}
          onScrub={(seconds) => onScrub(part.id, seconds)}
          onTogglePlay={onTogglePlay}
        />
      )}
    </div>
  )
}
