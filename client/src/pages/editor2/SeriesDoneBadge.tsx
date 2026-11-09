import { useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { seriesApi, type Editor2Completion } from '@/lib/api'
import type { NarrationLanguage } from '@/lib/narrationLanguage'

export function SeriesDoneBadge({ completion }: { completion: Editor2Completion | null }) {
  if (!completion?.done) return null
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-800 dark:bg-green-900 dark:text-green-100"
      title={completion.doneAt ? `Marked done ${new Date(completion.doneAt).toLocaleString()}` : 'Marked done'}
    >
      <CheckCircle2 className="h-3 w-3" />
      Done
    </span>
  )
}

/** The manual series Done mark for one language. A compressed video does not set it. */
export function SeriesDoneToggle({ seriesId, language, completion, onChange }: {
  seriesId: string
  language: NarrationLanguage
  completion: Editor2Completion | null
  onChange: (completion: Editor2Completion) => void
}) {
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)
  if (!completion) return null
  const toggle = async () => {
    setSaving(true)
    try {
      const { done } = await seriesApi.markDone(seriesId, language, !completion.done)
      onChange({ done, doneAt: done ? new Date().toISOString() : null })
    } catch (e) {
      toast({ title: 'Could not update Done', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }
  return (
    <Button variant={completion.done ? 'ghost' : 'outline'} size="sm" className="h-6 px-2 text-xs" disabled={saving} onClick={toggle}>
      {saving
        ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        : !completion.done && <CheckCircle2 className="mr-1 h-3 w-3" />}
      {completion.done ? 'Undo done' : 'Mark series done'}
    </Button>
  )
}
