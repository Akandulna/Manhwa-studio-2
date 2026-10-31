import { useState } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { clipper3Api, type PageRedoRequest } from '@/lib/api'
import { useToast } from '@/components/ui/use-toast'

export function RejectPageButton({ chapterId, filename, redo, disabled, onChanged }: {
  chapterId: string; filename: string; redo?: PageRedoRequest | null; disabled?: boolean; onChanged(): void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()
  const pending = redo?.status === 'pending'
  async function reject() {
    setBusy(true)
    try {
      const result = await clipper3Api.rejectPage(chapterId, filename)
      toast({ title: result.deliveryError ? 'Page rejected; delivery needs retry' : 'Page redo requested',
        description: result.deliveryError ?? 'Sleeper Cell will regenerate this page. Review it on the phone or in Studio, then Sync JSON.',
        variant: result.deliveryError ? 'destructive' : undefined })
      setOpen(false); onChanged()
    } catch (error) {
      toast({ title: 'Could not request redo', description: error instanceof Error ? error.message : String(error), variant: 'destructive' })
    } finally { setBusy(false) }
  }
  return <span onClick={event => event.stopPropagation()} className="inline-flex items-center gap-2">
    {pending && <span className="text-xs text-muted-foreground">Awaiting regenerated JSON</span>}
    <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => setOpen(true)}>
      {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1 h-3.5 w-3.5" />}
      {pending ? 'Resend redo request' : 'Reject JSON / Request redo'}
    </Button>
    <Dialog open={open} onOpenChange={value => !busy && setOpen(value)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{pending ? 'Resend page redo request?' : `Reject ${filename}?`}</DialogTitle>
          <DialogDescription>
            {pending ? 'Resend the existing request. Work already regenerated for it will be preserved.' :
              'Back up this page’s crop JSON and rendered crops, then ask Sleeper Cell to detect fresh crops and generate new JSON for this page. Other pages keep their saved crops.'}
            {' '}You can review the result in Sleeper Cell or Studio. Use Sync JSON after the phone uploads it.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">An offline phone receives the request when it reconnects. Automatic regeneration uses Start from Manhwa Studio; you can also run Image Clipper manually.</p>
        {redo?.deliveryError && <p className="text-sm text-destructive">{redo.deliveryError}</p>}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={reject}>{busy ? 'Sending…' : pending ? 'Resend request' : 'Reject and request redo'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </span>
}
