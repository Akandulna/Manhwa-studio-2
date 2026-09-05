/**
 * PartTimeline — the vertical, top-to-bottom story-order timeline. Groups parts
 * under chapter headers (outro as a final "End Card" group) and reveals the
 * groups sequentially so chapters visibly "compile" into the editor in turn.
 */

import { useEffect, useMemo, useState } from 'react'
import { type EditableChapter, type VideoProject, type VideoPart } from '@/lib/api'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader2, Film, Flag } from 'lucide-react'
import PartBlock from './PartBlock'
import { type PlaybackState } from './PreviewPlayer'

interface Group {
  key: string
  label: string
  parts: VideoPart[]
  isOutro?: boolean
}

interface Props {
  project: VideoProject
  chapters: EditableChapter[]
  focusedPartId: string | null
  selectedImageId: string | null
  onFocus: (partId: string) => void
  onSelectSlot: (partId: string, imageId: string) => void
  onDurationsCommit: (partId: string, durations: number[]) => void
  onRemoveSlot?: (partId: string, index: number) => void
  onReorderSlot?: (partId: string, from: number, to: number) => void
  aiAvailable?: boolean
  onSuggestImages?: (partId: string) => void
  onFitTiming?: (partId: string) => void
  suggestingPartId?: string | null
  fittingPartId?: string | null
  subscribePlayback?: (listener: (s: PlaybackState) => void) => () => void
  onScrub?: (partId: string, seconds: number) => void
  onTogglePlay?: () => void
}

export default function PartTimeline({
  project, chapters, focusedPartId, selectedImageId, onFocus, onSelectSlot, onDurationsCommit, onRemoveSlot, onReorderSlot,
  aiAvailable, onSuggestImages, onFitTiming, suggestingPartId, fittingPartId, subscribePlayback, onScrub, onTogglePlay
}: Props) {
  const groups = useMemo<Group[]>(() => {
    const chapterById = new Map(chapters.map(c => [c.id, c]))
    const out: Group[] = []
    for (const part of project.parts) {
      if (part.isOutro) {
        out.push({ key: 'outro', label: 'End Card', parts: [part], isOutro: true })
        continue
      }
      const last = out[out.length - 1]
      if (last && !last.isOutro && last.parts[0].chapterId === part.chapterId) {
        last.parts.push(part)
      } else {
        const ch = chapterById.get(part.chapterId)
        out.push({
          key: `${part.chapterId}-${out.length}`,
          label: ch ? `Chapter ${ch.number}${ch.title ? ` — ${ch.title}` : ''}` : 'Chapter',
          parts: [part]
        })
      }
    }
    return out
  }, [project.parts, chapters])

  // Sequential reveal of chapter groups.
  const [visible, setVisible] = useState(0)
  useEffect(() => {
    setVisible(0)
    let i = 0
    const timer = setInterval(() => {
      i++
      setVisible(i)
      if (i >= groups.length) clearInterval(timer)
    }, 450)
    return () => clearInterval(timer)
  }, [project.id, groups.length])

  const outroText = project.titleCardText || `${project.seriesTitle} · Thanks for watching`
  const stillCompiling = visible < groups.length

  return (
    <ScrollArea className="flex-1 min-w-0">
      <div className="p-6 space-y-5 max-w-3xl">
        {groups.slice(0, visible).map(group => (
          <div key={group.key}>
            <div className="flex items-center gap-2 mb-2">
              {group.isOutro ? <Flag className="h-4 w-4 text-primary" /> : <Film className="h-4 w-4 text-primary" />}
              <h2 className="font-semibold text-sm">{group.label}</h2>
              <span className="text-xs text-muted-foreground">
                {group.parts.length} part{group.parts.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="space-y-2">
              {group.parts.map(part => (
                <PartBlock
                  key={part.id}
                  part={part}
                  outroText={outroText}
                  isFocused={part.id === focusedPartId}
                  selectedImageId={selectedImageId}
                  onFocus={onFocus}
                  onSelectSlot={onSelectSlot}
                  onDurationsCommit={onDurationsCommit}
                  onRemoveSlot={onRemoveSlot}
                  onReorderSlot={onReorderSlot}
                  aiAvailable={aiAvailable}
                  onSuggestImages={onSuggestImages}
                  onFitTiming={onFitTiming}
                  isSuggesting={part.id === suggestingPartId}
                  isFitting={part.id === fittingPartId}
                  subscribePlayback={subscribePlayback}
                  onScrub={onScrub}
                  onTogglePlay={onTogglePlay}
                />
              ))}
            </div>
          </div>
        ))}

        {stillCompiling && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Compiling Chapter {visible + 1} of {groups.length}…
          </div>
        )}
      </div>
    </ScrollArea>
  )
}
