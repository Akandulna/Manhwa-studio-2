/**
 * PhoneVersionsDialog — chapters where a phone finished a different script than
 * Studio has. Studio fetches the phones' finished scripts by itself only where
 * it has none, so these wait here for a choice:
 *
 *   Use phone's version — imports it; whatever Studio made from its own script
 *     (listed per chapter) then needs redoing, as after any replaced script.
 *   Keep Studio's version — nothing changes, and this exact phone version isn't
 *     offered again (a newer one from a phone is).
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { narrationApi, type PhoneScriptConflict } from '@/lib/api'
import { LANGUAGE_LABEL, type NarrationLanguage } from '@/lib/narrationLanguage'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'

function formatWhen(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** What switching to the phone's script would need redone, in words. */
function affected(conflict: PhoneScriptConflict): string[] {
  const a = conflict.affects
  const lines: string[] = []
  if (a.metadataPages > 0) lines.push(`Metadata for ${a.metadataPages} page${a.metadataPages === 1 ? '' : 's'} — will need running again`)
  if (a.voiceoverSections > 0) lines.push(`Voiceover (${a.voiceoverSections} section${a.voiceoverSections === 1 ? '' : 's'}) was recorded from Studio's text`)
  if (a.alignedSections > 0) lines.push(`Alignment of ${a.alignedSections} section${a.alignedSections === 1 ? '' : 's'}`)
  if (a.hinglish) lines.push('The Hinglish script was converted from Studio\'s English')
  if (a.timeline) lines.push('The Editor timeline was built from Studio\'s script')
  return lines
}

interface Props {
  seriesId: string
  language: NarrationLanguage
  conflicts: PhoneScriptConflict[]
  open: boolean
  onClose: () => void
  /** After a choice: reload the list and the chapters. */
  onResolved: () => void
}

export function PhoneVersionsDialog({ seriesId, language, conflicts, open, onClose, onResolved }: Props) {
  const { toast } = useToast()
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState<'phone' | 'studio' | null>(null)

  useEffect(() => {
    if (!conflicts.some(c => c.chapterId === selected)) setSelected(conflicts[0]?.chapterId ?? null)
  }, [conflicts, selected])

  const conflict = conflicts.find(c => c.chapterId === selected) ?? null

  const choose = async (choice: 'phone' | 'studio') => {
    if (!conflict) return
    setBusy(choice)
    try {
      await narrationApi.resolvePhoneConflict(seriesId, language, { chapterId: conflict.chapterId, phoneSha256: conflict.phoneSha256, choice })
      toast({
        title: choice === 'phone' ? `Chapter ${conflict.number}: phone's version imported` : `Chapter ${conflict.number}: Studio's version kept`,
        description: choice === 'phone' && affected(conflict).length > 0 ? 'Redo what was made from the old script when you\'re ready.' : undefined
      })
      onResolved()
    } catch (error) {
      toast({ title: 'Could not apply your choice', description: error instanceof Error ? error.message : String(error), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => !next && !busy && onClose()}>
      <DialogContent className="max-w-6xl">
        <DialogHeader>
          <DialogTitle>Phone has a different {LANGUAGE_LABEL[language]} version</DialogTitle>
          <DialogDescription>
            Studio fetches finished scripts by itself only for chapters it has none for. These chapters already have a
            script here, so nothing changes until you choose.
          </DialogDescription>
        </DialogHeader>

        {conflicts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing left to decide.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {conflicts.map(c => (
                <Button key={c.chapterId} size="sm" variant={c.chapterId === selected ? 'default' : 'outline'} onClick={() => setSelected(c.chapterId)} disabled={!!busy}>
                  Chapter {c.number}
                </Button>
              ))}
            </div>

            {conflict && (
              <>
                {affected(conflict).length > 0 && (
                  <div className="rounded-md border border-amber-500/60 p-3 text-sm">
                    <p className="flex items-center gap-2 font-medium text-amber-600">
                      <AlertTriangle className="h-4 w-4" />
                      Made from Studio's script — would need redoing with the phone's
                    </p>
                    <ul className="mt-1 list-disc pl-6 text-muted-foreground">
                      {affected(conflict).map(line => <li key={line}>{line}</li>)}
                    </ul>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  {([
                    ['Studio', conflict.studioScript, conflict.studioStatus === 'edited' ? 'edited in Studio' : null],
                    ['Phone', conflict.phoneScript, [conflict.device, formatWhen(conflict.phoneSavedAt)].filter(Boolean).join(' · ') || null]
                  ] as const).map(([label, text, note]) => (
                    <div key={label} className="min-w-0">
                      <p className="mb-1 text-xs font-medium text-muted-foreground">
                        {label}{note ? ` · ${note}` : ''}
                      </p>
                      <pre className={cn('max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-md border p-3 text-xs leading-relaxed')}>
                        {text || '—'}
                      </pre>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={!!busy}>Close</Button>
          {conflict && (
            <>
              <Button variant="outline" onClick={() => choose('studio')} disabled={!!busy}>
                {busy === 'studio' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Keep Studio's version
              </Button>
              <Button onClick={() => choose('phone')} disabled={!!busy}>
                {busy === 'phone' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Use phone's version
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
