import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { narrationApi, type NarrationChapter } from '@/lib/api'
import { LANGUAGE_LABEL, type NarrationLanguage } from '@/lib/narrationLanguage'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'

type Section = Awaited<ReturnType<typeof narrationApi.getAlignmentSections>>[number]

export function ResetAlignmentDialog({ chapter, language, onClose, onStarted }: {
  chapter: NarrationChapter; language: NarrationLanguage; onClose: () => void; onStarted: () => void
}) {
  const [sections, setSections] = useState<Section[]>([])
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()
  useEffect(() => {
    let active = true
    narrationApi.getAlignmentSections(chapter.id, language).then(value => {
      if (!active) return
      setSections(value)
      setSelected(value.find(s => s.audioReady)?.id ?? '')
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'Could not load sections') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [chapter.id, language])
  const reset = async () => {
    setBusy(true)
    setError(null)
    try {
      await narrationApi.resetSectionAlignment(chapter.id, selected, language)
      toast({ title: 'Section alignment restarted', description: 'When alignment finishes, resend the chapter from Editor 2.0 and run its timeline automation again.' })
      onStarted()
      onClose()
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not reset alignment') }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Reset section alignment · Chapter {chapter.number}</DialogTitle>
        <DialogDescription>{LANGUAGE_LABEL[language]}. Choose the audio section whose timestamps need to be rebuilt.</DialogDescription>
      </DialogHeader>
      {loading ? <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading sections…</p> : <>
        <label className="grid gap-2 text-sm">Audio section
          <select className="rounded-md border bg-background p-2" value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}>
            <option value="" disabled>Choose a section</option>
            {sections.map(s => <option key={s.id} value={s.id} disabled={!s.audioReady}>Section {s.number} · {s.durationSec.toFixed(2)}s · {s.audioReady ? s.aligned ? 'Aligned' : 'Needs alignment' : 'Audio unavailable'}</option>)}
          </select>
        </label>
        <p className="text-sm text-muted-foreground">This backs up the existing alignment and this language’s Editor timeline, clears the selected section’s timestamps, and reruns alignment. Other sections’ timestamps, scripts, audio and videos are kept. The Editor timeline must be generated again.</p>
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={loading || busy || !selected} onClick={() => void reset()}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Reset & realign section</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
