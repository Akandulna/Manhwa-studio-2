/**
 * ImageInspector — per-slot controls: duration, motion mode (drift/focus),
 * drift effect + intensity, focus anchor placement, and manual scale/offset.
 * Every change is sent up with an event type for VideoEditEvent logging.
 */

import { useState } from 'react'
import { videoApi, type VideoPartImage } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ArrowLeft, Trash2, Move, Crosshair, RotateCcw, Sparkles, Loader2 } from 'lucide-react'

const GENTLE_EFFECTS = [
  { value: 'zoom-in', label: 'Zoom in' },
  { value: 'zoom-out', label: 'Zoom out' },
  { value: 'pan-left', label: 'Pan ←' },
  { value: 'pan-right', label: 'Pan →' },
  { value: 'pan-up', label: 'Pan ↑' },
  { value: 'pan-down', label: 'Pan ↓' }
]

export type ImagePatch = Partial<Pick<VideoPartImage,
  'motionMode' | 'motionEffect' | 'motionIntensity' | 'anchorX' | 'anchorY' | 'scale' | 'offsetX' | 'offsetY'>>

interface Props {
  image: VideoPartImage
  slotNumber: number
  onUpdate: (patch: ImagePatch, eventType: string) => void
  onDurationChange: (seconds: number) => void
  onRemove: () => void
  onBack: () => void
  onSuggestAnchor?: () => void
  suggestingAnchor?: boolean
  aiAvailable?: boolean
}

export default function ImageInspector({ image, slotNumber, onUpdate, onDurationChange, onRemove, onBack, onSuggestAnchor, suggestingAnchor, aiAvailable }: Props) {
  const [durationText, setDurationText] = useState(image.duration.toFixed(1))
  const isFocus = image.motionMode === 'focus'

  function placeAnchor(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    const had = image.anchorX != null
    onUpdate({ anchorX: x, anchorY: y }, had ? 'anchor_moved' : 'anchor_set')
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b flex items-center gap-2">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h3 className="text-sm font-semibold flex-1">Slot #{slotNumber}{image.isFiller ? ' (filler)' : ''}</h3>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRemove} title="Remove from part">
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-5">
        {/* Duration */}
        <div className="space-y-1.5">
          <Label className="text-xs">Duration (seconds)</Label>
          <Input
            type="number"
            step="0.1"
            min="0.3"
            value={durationText}
            onChange={(e) => setDurationText(e.target.value)}
            onBlur={() => {
              const v = parseFloat(durationText)
              if (!isNaN(v) && v > 0) onDurationChange(v)
              else setDurationText(image.duration.toFixed(1))
            }}
            className="h-8"
          />
          <p className="text-[11px] text-muted-foreground">Other slots redistribute to keep the part locked to its audio.</p>
        </div>

        {/* Motion mode */}
        <div className="space-y-1.5">
          <Label className="text-xs">Motion</Label>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant={!isFocus ? 'default' : 'outline'}
              size="sm"
              onClick={() => onUpdate({ motionMode: 'drift' }, 'motion_changed')}
            >
              <Move className="h-3.5 w-3.5 mr-1" /> Drift
            </Button>
            <Button
              variant={isFocus ? 'default' : 'outline'}
              size="sm"
              disabled={image.isFiller}
              onClick={() => onUpdate(
                { motionMode: 'focus', anchorX: image.anchorX ?? 0.5, anchorY: image.anchorY ?? 0.5 },
                'motion_changed'
              )}
            >
              <Crosshair className="h-3.5 w-3.5 mr-1" /> Focus
            </Button>
          </div>
        </div>

        {/* Drift effect */}
        {!isFocus && (
          <div className="space-y-1.5">
            <Label className="text-xs">Effect</Label>
            <div className="grid grid-cols-3 gap-1.5">
              {GENTLE_EFFECTS.map(ef => (
                <Button
                  key={ef.value}
                  variant={image.motionEffect === ef.value ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-xs px-1"
                  onClick={() => onUpdate({ motionEffect: ef.value }, 'motion_changed')}
                >
                  {ef.label}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Focus anchor placement */}
        {isFocus && !image.isFiller && image.cropId && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Anchor — click the point to focus on</Label>
              {aiAvailable && onSuggestAnchor && (
                <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={onSuggestAnchor} disabled={suggestingAnchor}>
                  {suggestingAnchor ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Sparkles className="h-3 w-3 mr-1" />}
                  Suggest
                </Button>
              )}
            </div>
            <div
              className="relative w-full rounded overflow-hidden border cursor-crosshair"
              onClick={placeAnchor}
            >
              <img src={videoApi.cropImageUrl(image.cropId)} alt="anchor target" className="w-full max-h-48 object-contain bg-neutral-900" draggable={false} />
              {image.anchorX != null && image.anchorY != null && (
                <div
                  className="absolute w-4 h-4 -ml-2 -mt-2 rounded-full border-2 border-primary bg-primary/40 pointer-events-none"
                  style={{ left: `${image.anchorX * 100}%`, top: `${image.anchorY * 100}%` }}
                />
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1">
              <Button
                variant={image.motionEffect !== 'zoom-out' ? 'default' : 'outline'}
                size="sm"
                onClick={() => onUpdate({ motionEffect: 'zoom-in' }, 'motion_changed')}
              >Zoom in</Button>
              <Button
                variant={image.motionEffect === 'zoom-out' ? 'default' : 'outline'}
                size="sm"
                onClick={() => onUpdate({ motionEffect: 'zoom-out' }, 'motion_changed')}
              >Zoom out</Button>
            </div>
          </div>
        )}

        {/* Intensity */}
        {!image.isFiller && (
          <div className="space-y-1.5">
            <div className="flex justify-between">
              <Label className="text-xs">Motion intensity</Label>
              <span className="text-xs text-muted-foreground">{Math.round(image.motionIntensity * 100)}%</span>
            </div>
            <Slider
              min={0.01}
              max={0.15}
              step={0.005}
              value={[image.motionIntensity]}
              onValueChange={([v]) => onUpdate({ motionIntensity: v }, 'motion_changed')}
            />
          </div>
        )}

        {/* Manual transform */}
        {!image.isFiller && (
          <div className="space-y-2 border-t pt-4">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Manual transform</Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={() => onUpdate({ scale: null, offsetX: null, offsetY: null }, 'image_transformed')}
              >
                <RotateCcw className="h-3 w-3 mr-1" /> Reset
              </Button>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Scale</span><span>{(image.scale ?? 1).toFixed(2)}×</span>
              </div>
              <Slider min={0.5} max={3} step={0.05} value={[image.scale ?? 1]}
                onValueChange={([v]) => onUpdate({ scale: v }, 'image_transformed')} />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Offset X</span><span>{Math.round((image.offsetX ?? 0) * 100)}%</span>
              </div>
              <Slider min={-0.5} max={0.5} step={0.01} value={[image.offsetX ?? 0]}
                onValueChange={([v]) => onUpdate({ offsetX: v }, 'image_transformed')} />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Offset Y</span><span>{Math.round((image.offsetY ?? 0) * 100)}%</span>
              </div>
              <Slider min={-0.5} max={0.5} step={0.01} value={[image.offsetY ?? 0]}
                onValueChange={([v]) => onUpdate({ offsetY: v }, 'image_transformed')} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
