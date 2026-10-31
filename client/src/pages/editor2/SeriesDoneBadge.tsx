import { CheckCircle2 } from 'lucide-react'
import type { Editor2Completion } from '@/lib/api'

export function SeriesDoneBadge({ completion }: { completion: Editor2Completion | null }) {
  if (!completion?.done) return null
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-800 dark:bg-green-900 dark:text-green-100"
      title={`Compressed video saved:\n${completion.compressedVideos.join('\n')}`}
    >
      <CheckCircle2 className="h-3 w-3" />
      Done
    </span>
  )
}
