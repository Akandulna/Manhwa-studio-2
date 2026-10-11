import { useEffect, useMemo, useState } from 'react'
import { r2Api, type PhoneChapterState, type PhoneSendPlan, type PhoneSendSeries } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { formatBytes } from '@/lib/utils'
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Smartphone } from 'lucide-react'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** A send is running; nothing can start until it ends. */
  busy: boolean
  /** Called with the chapters to send per series. */
  onSend: (series: { seriesId: string; chapterIds: string[] }[]) => Promise<void>
}

const STATE_LABEL: Record<PhoneChapterState, { label: string; className: string }> = {
  new: { label: 'New', className: 'border-transparent bg-sky-600 text-white hover:bg-sky-600' },
  changed: { label: 'Changed', className: 'border-transparent bg-amber-500 text-white hover:bg-amber-500' },
  sent: { label: 'In R2', className: 'border-transparent bg-muted text-muted-foreground hover:bg-muted' },
  downloading: { label: 'Downloading', className: 'border-transparent bg-sky-600/70 text-white hover:bg-sky-600/70' },
  on_phone: { label: 'On phone', className: 'border-transparent bg-emerald-600 text-white hover:bg-emerald-600' },
  cleared: { label: 'Cleared on phone', className: 'border-transparent bg-zinc-500 text-white hover:bg-zinc-500' }
}

/**
 * New and changed chapters go by default (as the server's isDefaultPick), except ones still to be stitched
 * and ones already done here, which leave the phone nothing to do. Either can be ticked by hand.
 */
function defaultPick(series: PhoneSendSeries): Set<string> {
  return new Set(
    series.chapters
      .filter(c => (c.state === 'new' || c.state === 'changed') && !c.needsStitch && !c.desktop.done)
      .map(c => c.chapterId)
  )
}

function summary(series: PhoneSendSeries): string {
  const parts: string[] = []
  const unsent = series.chapters.filter(c => c.state === 'new' || c.state === 'changed')
  const fresh = unsent.filter(c => c.state === 'new' && !c.desktop.done).length
  const changed = unsent.filter(c => c.state === 'changed' && !c.desktop.done).length
  const doneHere = unsent.filter(c => c.desktop.done).length
  if (fresh) parts.push(`${fresh} new`)
  if (changed) parts.push(`${changed} changed`)
  if (doneHere) parts.push(`${doneHere} done here, not sent`)
  if (series.onPhone) parts.push(`${series.onPhone} on phone`)
  if (series.waiting) parts.push(`${series.waiting} waiting for the phone`)
  if (series.cleared) parts.push(`${series.cleared} cleared`)
  return parts.join(' · ') || 'Nothing to send'
}

/**
 * "Send to phone": each series' chapters with what the phone has of them.
 * New and changed chapters are ticked; anything else can be ticked to send it
 * again (a chapter the phone cleared comes back only this way). Each series
 * also has its auto-send switch: send new chapters by themselves once
 * downloads finish.
 */
export function PhoneSendDialog({ open, onOpenChange, busy, onSend }: Props) {
  const { toast } = useToast()
  const [plan, setPlan] = useState<PhoneSendPlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<Map<string, Set<string>>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [starting, setStarting] = useState(false)
  const [updatingIndex, setUpdatingIndex] = useState(false)

  const load = (fresh = false) => {
    setLoading(true)
    r2Api
      .getSendPlan(fresh)
      .then(next => {
        setPlan(next)
        setPicked(new Map(next.series.map(s => [s.seriesId, defaultPick(s)])))
      })
      .catch(error => toast({ title: 'Could not work out what to send', description: error instanceof Error ? error.message : String(error), variant: 'destructive' }))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (open) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const totals = useMemo(() => {
    let chapters = 0
    let bytes = 0
    for (const s of plan?.series ?? []) {
      const ids = picked.get(s.seriesId)
      for (const c of s.chapters) {
        if (!ids?.has(c.chapterId)) continue
        chapters++
        bytes += c.bytes
      }
    }
    return { chapters, bytes }
  }, [plan, picked])

  const stale = plan?.series.filter(s => s.indexStale).length ?? 0

  const toggleChapter = (seriesId: string, chapterId: string) => {
    setPicked(prev => {
      const next = new Map(prev)
      const ids = new Set(next.get(seriesId))
      if (ids.has(chapterId)) ids.delete(chapterId)
      else ids.add(chapterId)
      next.set(seriesId, ids)
      return next
    })
  }

  const toggleSeries = (series: PhoneSendSeries) => {
    setPicked(prev => {
      const next = new Map(prev)
      const ids = next.get(series.seriesId)
      next.set(series.seriesId, ids && ids.size > 0 ? new Set() : defaultPick(series))
      return next
    })
  }

  const toggleExpanded = (seriesId: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(seriesId)) next.delete(seriesId)
      else next.add(seriesId)
      return next
    })
  }

  const setAuto = async (series: PhoneSendSeries, enabled: boolean) => {
    setPlan(prev => prev && { ...prev, series: prev.series.map(s => (s.seriesId === series.seriesId ? { ...s, autoSend: enabled } : s)) })
    try {
      await r2Api.setAutoSend(series.seriesId, enabled)
    } catch (error) {
      setPlan(prev => prev && { ...prev, series: prev.series.map(s => (s.seriesId === series.seriesId ? { ...s, autoSend: !enabled } : s)) })
      toast({ title: 'Could not save auto-send', description: error instanceof Error ? error.message : String(error), variant: 'destructive' })
    }
  }

  const handleSend = async () => {
    const series = [...picked]
      .filter(([, ids]) => ids.size > 0)
      .map(([seriesId, ids]) => ({ seriesId, chapterIds: [...ids] }))
    setStarting(true)
    try {
      await onSend(series)
      onOpenChange(false)
    } finally {
      setStarting(false)
    }
  }

  const handleUpdateIndex = async () => {
    setUpdatingIndex(true)
    try {
      const { written } = await r2Api.updatePhoneIndex()
      toast({
        title: written > 0 ? `Updated ${written} series on the phone` : 'The phone is up to date',
        description: 'Its “Clear done chapters” now ticks the chapters finished here.'
      })
      load()
    } catch (error) {
      toast({ title: 'Could not update the phone', description: error instanceof Error ? error.message : String(error), variant: 'destructive' })
    } finally {
      setUpdatingIndex(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5" />
            Send to phone
          </DialogTitle>
          <DialogDescription>
            Each chapter goes to Sleeper-Cell as its own zip and joins its series’ folder on the phone. Chapters the
            phone cleared once done aren’t sent again unless you tick them.
            {plan?.device && <> Phone: {plan.device}.</>}
          </DialogDescription>
        </DialogHeader>

        {loading && !plan ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="mr-3 h-6 w-6 animate-spin" />
            Looking at the chapters on disk…
          </div>
        ) : !plan ? null : !plan.configured ? (
          <p className="py-6 text-sm text-muted-foreground">
            Cloudflare R2 isn’t set up. Add it in Settings → Cloudflare (missing: {plan.missing.join(', ')}).
          </p>
        ) : plan.series.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">No series have unpublished chapters on disk.</p>
        ) : (
          <ScrollArea className="h-[26rem] rounded-lg border">
            <div className="divide-y">
              {plan.series.map(series => {
                const ids = picked.get(series.seriesId) ?? new Set<string>()
                const open = expanded.has(series.seriesId)
                return (
                  <div key={series.seriesId} className="p-3">
                    <div className="flex items-center gap-3">
                      <Checkbox
                        checked={ids.size > 0}
                        onCheckedChange={() => toggleSeries(series)}
                        aria-label={`Send ${series.title}`}
                      />
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => toggleExpanded(series.seriesId)}
                      >
                        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{series.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {summary(series)}
                            {ids.size > 0 && ` — sending ${ids.size}`}
                          </span>
                        </span>
                      </button>
                      <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground" title="Send new chapters by themselves once downloads finish">
                        Auto-send
                        <Switch checked={series.autoSend} onCheckedChange={checked => setAuto(series, checked)} />
                      </label>
                    </div>

                    {open && (
                      <div className="mt-2 space-y-1 pl-9">
                        {series.chapters.map(c => {
                          const state = STATE_LABEL[c.state]
                          return (
                            <label key={c.chapterId} className="flex cursor-pointer items-center gap-3 rounded px-2 py-1 text-sm hover:bg-accent">
                              <Checkbox
                                checked={ids.has(c.chapterId)}
                                disabled={c.pages === 0}
                                onCheckedChange={() => toggleChapter(series.seriesId, c.chapterId)}
                              />
                              <span className="w-32 shrink-0 truncate">{c.folder}</span>
                              <span className="w-28 shrink-0 text-xs text-muted-foreground tabular-nums">
                                {c.pages > 0 ? `${c.pages} pages · ${formatBytes(c.bytes)}` : 'no pages on disk'}
                              </span>
                              <Badge className={state.className}>{state.label}</Badge>
                              {c.needsStitch && (
                                <Badge variant="outline" title="Stitch it first; auto-send waits for that">Needs stitching</Badge>
                              )}
                              <span className="ml-auto text-xs text-muted-foreground">
                                {c.desktop.published ? 'Published' : c.desktop.done ? 'Done here' : [
                                  c.desktop.crops ? 'crops ✓' : null,
                                  c.desktop.script ? 'script ✓' : null
                                ].filter(Boolean).join(' · ')}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        )}

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Button variant="ghost" size="sm" onClick={() => load(true)} disabled={loading} title="Read the phone's status again">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            {stale > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleUpdateIndex}
                disabled={updatingIndex || busy}
                title="Chapters were finished here since the last send; tell the phone so it can clear them"
              >
                {updatingIndex && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Update phone’s done list ({stale})
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button onClick={handleSend} disabled={busy || starting || totals.chapters === 0}>
              {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Smartphone className="mr-2 h-4 w-4" />}
              {busy ? 'A send is running' : `Send ${totals.chapters} chapter${totals.chapters === 1 ? '' : 's'}`}
              {totals.chapters > 0 && !busy && ` · ${formatBytes(totals.bytes)}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
