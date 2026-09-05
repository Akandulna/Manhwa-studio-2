/**
 * TitleCardEditor — the outro end-card controls. Editable text override (null =
 * auto "{series} · Thanks for watching") and a fixed card duration. Saved via
 * updateProject.
 */

import { useState } from 'react'
import { type VideoProject } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Flag, Loader2 } from 'lucide-react'

interface Props {
  project: VideoProject
  onSave: (patch: { titleCardText?: string | null; titleCardDuration?: number }) => Promise<void>
}

export default function TitleCardEditor({ project, onSave }: Props) {
  const [text, setText] = useState(project.titleCardText ?? '')
  const [duration, setDuration] = useState(String(project.titleCardDuration))
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      const d = parseFloat(duration)
      await onSave({
        titleCardText: text.trim() ? text : null,
        titleCardDuration: !isNaN(d) && d > 0 ? d : project.titleCardDuration
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b flex items-center gap-2">
        <Flag className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">End Title Card</h3>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        <div className="space-y-1.5">
          <Label className="text-xs">Card text</Label>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Auto: ${project.seriesTitle} · Thanks for watching`}
            className="min-h-[100px] text-sm"
          />
          <p className="text-[11px] text-muted-foreground">Leave blank to use the series title + closing line.</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Duration (seconds)</Label>
          <Input
            type="number"
            step="0.5"
            min="0.5"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            className="h-8"
          />
        </div>

        <p className="text-[11px] text-muted-foreground">
          Background music continues under the card.
        </p>
      </div>

      <div className="p-3 border-t">
        <Button className="w-full" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          Save card
        </Button>
      </div>
    </div>
  )
}
