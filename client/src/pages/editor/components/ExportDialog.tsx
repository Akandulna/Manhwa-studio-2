/**
 * ExportDialog — pick resolution + quality preset, see a rough size estimate,
 * and start the render.
 */

import { useState } from 'react'
import { type VideoProject } from '@/lib/api'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select'
import { Download } from 'lucide-react'

const RESOLUTIONS = [
  { value: '1920x1080', label: '1080p (1920×1080)', vbrMbps: 8 },
  { value: '1280x720', label: '720p (1280×720)', vbrMbps: 4 },
  { value: '854x480', label: '480p (854×480)', vbrMbps: 1.5 }
]
const PRESETS = [
  { value: 'fast', label: 'Fast (larger, quicker)' },
  { value: 'medium', label: 'Medium (balanced)' },
  { value: 'slow', label: 'Slow (smaller, slower)' }
]
const FRAME_RATES = [
  { value: '30', label: '30 fps (standard)' },
  { value: '60', label: '60 fps (smoothest motion, slower render)' },
  { value: '24', label: '24 fps (cinematic)' }
]

interface Props {
  project: VideoProject
  open: boolean
  onOpenChange: (open: boolean) => void
  onExport: (resolution: string, preset: string, fps: number) => void
}

export default function ExportDialog({ project, open, onOpenChange, onExport }: Props) {
  const [resolution, setResolution] = useState('1920x1080')
  const [preset, setPreset] = useState('medium')
  const [fps, setFps] = useState('30')

  const totalDuration = project.parts.reduce((s, p) => s + p.audioDuration, 0)
  const vbr = RESOLUTIONS.find(r => r.value === resolution)?.vbrMbps ?? 8
  const estMb = Math.round(((vbr + 0.192) * totalDuration) / 8)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export video</DialogTitle>
          <DialogDescription>16:9 MP4 · ~{Math.round(totalDuration)}s · est. {estMb} MB</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Resolution</Label>
            <Select value={resolution} onValueChange={setResolution}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {RESOLUTIONS.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Quality preset</Label>
            <Select value={preset} onValueChange={setPreset}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {PRESETS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Frame rate</Label>
            <Select value={fps} onValueChange={setFps}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {FRAME_RATES.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => onExport(resolution, preset, Number(fps))}>
            <Download className="h-4 w-4 mr-2" /> Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
