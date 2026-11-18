/**
 * ClearScriptsDialog — Studio's side of Sleeper-Cell's "Clear scripts only".
 * Ticked chapters lose their English and Hinglish scripts, voiceovers,
 * alignment and Editor timelines (all backed up in the chapter folder first),
 * so the phones' regenerated scripts come in as new. Phone copies saved before
 * the clear are ignored from then on. Pages, crops and Metadata stay.
 *
 * Chapters no phone has a script for any more are ticked to begin with.
 */

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { narrationApi, type ClearableScriptChapter } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'

interface Props {
  seriesId: string
  onClose: () => void
  onCleared: () => void
}

/** What the phones have for a chapter, in words. */
function phoneState(c: ClearableScriptChapter): { text: string; missing: boolean } {
  if (c.phoneEn === null || c.phoneHi === null) return { text: 'phones unknown', missing: false }
  const has = [c.phoneEn && 'English', c.phoneHi && 'Hinglish'].filter(Boolean)
  return has.length === 0 ? { text: 'not on the phones', missing: true } : { text: `phones: ${has.join(' + ')}`, missing: false }
}

export function ClearScriptsDialog({ seriesId, onClose, onCleared }: Props) {
  const { toast } = useToast()
  const [chapters, setChapters] = useState<ClearableScriptChapter[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    narrationApi.getClearableScripts(seriesId).then(
      result => {
        setChapters(result.chapters)
        setTicked(new Set(result.chapters.filter(c => phoneState(c).missing && !c.published).map(c => c.chapterId)))
      },
      e => setError(e instanceof Error ? e.message : String(e))
    )
  }, [seriesId])

  const chosen = useMemo(() => chapters?.filter(c => ticked.has(c.chapterId)) ?? [], [chapters, ticked])
  const toggle = (id: string) => setTicked(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const clear = async () => {
    setClearing(true)
    try {
      const result = await narrationApi.clearScripts(seriesId, chosen.map(c => c.chapterId))
      toast({
        title: `Cleared ${result.cleared.length} chapter${result.cleared.length === 1 ? '' : 's'}`,
        description: `Chapter ${result.cleared.map(c => c.number).join(', ')}. Backups are in each chapter's .script-replacements folder.`
      })
      onCleared()
      onClose()
    } catch (e) {
      toast({ title: 'Could not clear the scripts', description: e instanceof Error ? e.message : String(e), variant: 'destructive' })
    } finally {
      setClearing(false)
    }
  }

  return (
    <Dialog open onOpenChange={open => !open && !clearing && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Clear scripts in Studio</DialogTitle>
          <DialogDescription>
            Removes the ticked chapters' English and Hinglish scripts, voiceovers, alignment and Editor timelines, after
            copying them to the chapter's .script-replacements folder. Pages, crops and Metadata stay. Scripts a phone
            saved before now are ignored for these chapters; newly generated ones come in as usual.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !chapters ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Looking at Studio and the phones…</p>
        ) : chapters.length === 0 ? (
          <p className="text-sm text-muted-foreground">No chapter has a script in Studio.</p>
        ) : (
          <div className="max-h-[55vh] space-y-1 overflow-auto rounded-md border p-2">
            {chapters.map(c => {
              const phone = phoneState(c)
              return (
                <label key={c.chapterId} className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-muted/50">
                  <Checkbox checked={ticked.has(c.chapterId)} onCheckedChange={() => toggle(c.chapterId)} disabled={clearing} />
                  <span className="w-24 shrink-0 font-medium">Chapter {c.number}</span>
                  <span className="w-36 shrink-0 text-muted-foreground">
                    Studio: {[c.en && 'English', c.hi && 'Hinglish'].filter(Boolean).join(' + ')}
                  </span>
                  <span className={phone.missing ? 'text-amber-600' : 'text-muted-foreground'}>{phone.text}</span>
                  {c.voiceoverSections > 0 && <span className="text-xs text-muted-foreground">· voiceover</span>}
                  {c.published && <span className="text-xs font-medium text-amber-600">· rendered</span>}
                </label>
              )
            })}
          </div>
        )}

        {chosen.some(c => c.published) && (
          <p className="flex items-center gap-2 text-sm text-amber-600">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            A ticked chapter was already rendered; its video stays, but its script and voiceover go.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={clearing}>Cancel</Button>
          <Button variant="destructive" onClick={clear} disabled={clearing || chosen.length === 0}>
            {clearing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Clear {chosen.length} chapter{chosen.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
