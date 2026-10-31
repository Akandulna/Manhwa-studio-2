import { Clock3, Loader2 } from 'lucide-react'
import type { NarrationAlignmentProgress } from '@/lib/api'

const phaseLabels = {
  loading: 'Loading voiceover',
  audio: 'Processing audio',
  matching: 'Matching script',
  saving: 'Saving timeline'
}

export function AlignmentProgressStatus({ progress, sections }: {
  progress?: NarrationAlignmentProgress | null
  sections: number
}) {
  if (!progress) return (
    <span className="flex w-36 items-center gap-1 text-xs text-muted-foreground">
      <Clock3 className="h-3.5 w-3.5" />Queued
    </span>
  )
  const percent = Math.max(0, Math.min(100, Math.floor(progress.percent)))
  const label = `${phaseLabels[progress.phase]}${sections > 1 ? ` · Section ${progress.sectionNumber}/${sections}` : ''}`
  return (
    <div className="w-36 shrink-0 space-y-1 text-xs text-primary" title={label}>
      <span className="flex items-center gap-1 tabular-nums">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />Aligning {percent}%
      </span>
      <div role="progressbar" aria-label="Voiceover alignment" aria-valuenow={percent}
        aria-valuemin={0} aria-valuemax={100} aria-valuetext={`${percent}% · ${label}`}
        className="h-1.5 overflow-hidden rounded-full bg-secondary">
        <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
      </div>
      <span className="block truncate text-[10px] text-muted-foreground">{label}</span>
    </div>
  )
}
