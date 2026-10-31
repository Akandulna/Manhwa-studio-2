/**
 * Get chapters from phones: the chapters the Master phone (Sleeper-Cell's
 * Master tab) downloaded and sent to R2, brought into this library so Clipper 3,
 * Narration and Editor 2.0 have their pages here too. Everything new is ticked;
 * a chapter here with other pages ("changed") is offered unticked, as pulling it
 * replaces the pages on disk. Reads R2 only when opened.
 */

import { useEffect, useMemo, useState } from 'react'
import { Download, Loader2, Smartphone } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/components/ui/use-toast'
import { r2Api, type PhonePullOffer } from '@/lib/api'

const key = (folder: string, chapter: string) => `${folder}/${chapter}`

function size(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

export function PhonePullDialog({ open, onOpenChange, onPulled }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Chapters came in: the library reloads. */
  onPulled: () => void
}) {
  const { toast } = useToast()
  const [offer, setOffer] = useState<PhonePullOffer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [pulling, setPulling] = useState(false)

  useEffect(() => {
    if (!open) return
    setOffer(null)
    setError(null)
    r2Api.getPhonePull()
      .then(result => {
        setOffer(result)
        setPicked(new Set(result.series.flatMap(s => s.chapters.filter(c => c.state === 'new').map(c => key(s.folder, c.name)))))
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
  }, [open])

  const chosen = useMemo(() => (offer?.series ?? [])
    .map(s => ({ folder: s.folder, chapters: s.chapters.filter(c => picked.has(key(s.folder, c.name))) }))
    .filter(s => s.chapters.length > 0), [offer, picked])
  const bytes = chosen.reduce((sum, s) => sum + s.chapters.reduce((t, c) => t + c.bytes, 0), 0)

  const toggle = (k: string) => setPicked(prev => {
    const next = new Set(prev)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    return next
  })

  const pull = async () => {
    setPulling(true)
    try {
      const result = await r2Api.pullFromPhones(chosen.map(s => ({ folder: s.folder, chapters: s.chapters.map(c => c.name) })))
      toast({
        title: `${result.pulled.length} chapters brought in`,
        description: result.failed.length
          ? `${result.failed.length} failed: ${result.failed.slice(0, 3).map(f => `${f.folder} · ${f.chapter} (${f.reason})`).join('; ')}`
          : 'They’re in the library, and Send to phone knows the phones have them.',
        variant: result.failed.length && !result.pulled.length ? 'destructive' : undefined
      })
      if (result.pulled.length) onPulled()
      onOpenChange(false)
    } catch (e) {
      toast({ title: 'Could not get the chapters', description: e instanceof Error ? e.message : String(e), variant: 'destructive' })
    } finally {
      setPulling(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Smartphone className="h-5 w-5" /> Get chapters from phones</DialogTitle>
          <DialogDescription>
            Chapters the Master phone downloaded and sent to R2. They come into this library with their pages, ready for Clipper 3 and Narration.
          </DialogDescription>
        </DialogHeader>
        {error
          ? <p className="py-6 text-sm text-destructive">{error}</p>
          : !offer
          ? <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Looking in R2…</p>
          : !offer.configured
          ? <p className="py-6 text-sm text-muted-foreground">Set up Cloudflare R2 in Settings first.</p>
          : offer.series.length === 0
          ? <p className="py-6 text-sm text-muted-foreground">Nothing new from the phones: every chapter they sent is here already.</p>
          : (
            <ScrollArea className="h-96 rounded-lg border">
              <div className="space-y-4 p-3">
                {offer.series.map(s => (
                  <div key={s.folder}>
                    <p className="mb-1 flex items-center gap-2 font-medium">
                      {s.title}
                      {!s.seriesId && <Badge variant="secondary">new series</Badge>}
                    </p>
                    <div className="space-y-1">
                      {s.chapters.map(c => {
                        const k = key(s.folder, c.name)
                        return (
                          <label key={k} className="flex cursor-pointer items-center gap-3 rounded px-2 py-1 hover:bg-accent">
                            <Checkbox checked={picked.has(k)} onCheckedChange={() => toggle(k)} />
                            <span className="flex-1 text-sm">{c.name}</span>
                            {c.state === 'changed' && <Badge variant="outline" title="This chapter is here with other pages: getting it replaces them">changed</Badge>}
                            <span className="text-xs tabular-nums text-muted-foreground">{c.files} pages · {size(c.bytes)}</span>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={pull} disabled={pulling || chosen.length === 0}>
            {pulling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Get {chosen.reduce((n, s) => n + s.chapters.length, 0)} chapters{bytes ? ` (${size(bytes)})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
