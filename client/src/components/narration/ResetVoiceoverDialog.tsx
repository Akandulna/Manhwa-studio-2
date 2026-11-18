/**
 * Reset voiceover · one chapter, one language — removes the voiceover here
 * (backed up in the chapter folder), deletes the phone's zip from R2 and leaves
 * a reset marker there, which each Sleeper-Cell applies the next time it checks
 * (before a voiceover run, on its Voiceover screens, on sync). The script stays,
 * so the chapter can be voiced again. See voiceoverReset.ts.
 */

import { useState } from 'react'
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react'
import { narrationApi, type NarrationChapter } from '@/lib/api'
import { LANGUAGE_LABEL, type NarrationLanguage } from '@/lib/narrationLanguage'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'

export function ResetVoiceoverDialog({ chapter, language, onClose, onReset }: {
  chapter: NarrationChapter
  language: NarrationLanguage
  onClose: () => void
  onReset: () => void
}) {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await narrationApi.resetVoiceover(chapter.id, language)
      toast({
        title: `Chapter ${chapter.number}'s ${LANGUAGE_LABEL[language]} voiceover reset`,
        description: !result.r2
          ? 'Removed here. R2 is not set up, so the phones keep their copies.'
          : result.phonesAsked
            ? 'Removed here and from R2. Open phones drop their copy now; the others before their next voiceover run.'
            : 'Removed here and from R2. Phones drop their copy before their next voiceover run.'
      })
      onReset()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reset the voiceover')
    } finally {
      setBusy(false)
    }
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Reset voiceover · Chapter {chapter.number}</DialogTitle>
        <DialogDescription>
          {LANGUAGE_LABEL[language]}. Removes this chapter’s voiceover everywhere so it can be voiced again. The script stays.
        </DialogDescription>
      </DialogHeader>

      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li><span className="font-medium">Studio:</span> its sections and audio ({chapter.withAudio}/{chapter.sections}), alignment,
          alignment document and Editor 2.0 timeline in {LANGUAGE_LABEL[language]}. Moved to the chapter’s
          .voiceover-resets folder, not deleted.</li>
        <li><span className="font-medium">R2:</span> the phone’s voiceover zip and its “voiced” marker.</li>
        <li><span className="font-medium">Phones:</span> each Sleeper-Cell sets its copy aside the next time it checks (open phones
          right away, the others before their next voiceover run), then voices the chapter again.</li>
      </ul>

      <p className="flex items-start gap-2 text-sm text-amber-600">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
        Phones on a Sleeper-Cell build from before Reset voiceover keep their copy (they don’t send it again), so install the
        new build on each phone.
      </p>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button variant="destructive" disabled={busy} onClick={() => void reset()}>
          {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
          Reset voiceover
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
