/**
 * Reject one AntiGravity result (POST /antigravity/jobs/:id/reject). Uses
 * Clipper's own page rejection: the page's pointers are backed up and removed,
 * and phones are told the old result is void. Optionally runs the page again
 * at once in a new conversation.
 */

import { useState } from 'react'
import { Loader2, ThumbsDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { antigravityJobsApi, type AntigravityJobView } from '@/lib/api'
import { cn } from '@/lib/utils'

export const REJECTABLE = new Set(['ready_for_human_review', 'publish_failed'])
export const canReject = (job?: AntigravityJobView | null) => !!job && REJECTABLE.has(job.stage) && job.importState === 'imported'

export function RejectJobButton({ job, compact, onChanged }: { job: AntigravityJobView; compact?: boolean; onChanged(): void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<null | 'rerun' | 'only'>(null)
  const [note, setNote] = useState('')
  const { toast } = useToast()

  const reject = async (rerun: boolean) => {
    setBusy(rerun ? 'rerun' : 'only')
    try {
      const after = await antigravityJobsApi.reject(job.id, { rerun, note: note.trim() || undefined })
      toast({
        title: rerun ? `${job.filename} rejected · processing again` : `${job.filename} rejected`,
        description: after.lastError?.includes('Phones not told')
          ? after.lastError
          : rerun ? 'A new attempt starts in a new conversation from the same Drive slices.' : 'Its pointers were backed up and removed. Process again (or select it and Start process) runs it again; a phone can also redo it.'
      })
      setOpen(false)
      setNote('')
      onChanged()
    } catch (e) {
      toast({ title: 'Could not reject', description: (e as Error).message, variant: 'destructive' })
    } finally { setBusy(null) }
  }

  return (
    <>
      <Button size="sm" variant="ghost" className={cn(compact && 'h-6 px-1.5 text-xs')} title="This result isn't acceptable: remove it and optionally run the page again" onClick={() => setOpen(true)}>
        <ThumbsDown className={cn('mr-1', compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} /> Reject
      </Button>
      <Dialog open={open} onOpenChange={value => !busy && setOpen(value)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject {job.filename}?</DialogTitle>
            <DialogDescription>
              This page's crop pointers (and any crops rendered from them) are backed up, then removed from Clipper. Phones are told this
              result is void, so the page no longer counts as done anywhere. Other pages are not affected.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label htmlFor={`reject-note-${job.id}`} className="text-sm font-medium">What was wrong? (optional)</label>
            <Textarea id={`reject-note-${job.id}`} value={note} maxLength={300} rows={2} placeholder="e.g. merged two panels, cut off a speech bubble" onChange={e => setNote(e.target.value)} />
            <p className="text-xs text-muted-foreground">Kept in the run's log for your reference. It isn't sent to the model.</p>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" disabled={!!busy} onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="outline" disabled={!!busy} onClick={() => void reject(false)}>
              {busy === 'only' && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Reject only
            </Button>
            <Button variant="destructive" disabled={!!busy} onClick={() => void reject(true)}>
              {busy === 'rerun' && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Reject &amp; process again
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
