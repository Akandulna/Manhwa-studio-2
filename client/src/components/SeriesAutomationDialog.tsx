import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, Smartphone } from 'lucide-react'
import { usePhoneOverview } from '@/hooks/usePhoneOverview'
import { usePhoneRelay } from '@/hooks/usePhoneRelay'
import { usePhoneScreens } from '@/hooks/usePhoneScreens'
import { r2Api, type PhoneAutomationOptions, type PhoneOverviewPhone, type Series } from '@/lib/api'
import { AUTOMATION_NAME, RunAutomationDialog, chapterRanges } from '@/pages/sleeper/RunAutomation'
import { onPhone, phoneActivity, phoneList, useNow } from '@/pages/sleeper/sleeperShared'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { useToast } from './ui/use-toast'

/** One shared launcher for the Library; phone receipts are read only when it opens. */
export function SeriesAutomationDialog({ series, onClose }: { series: Series; onClose: () => void }) {
  const { status: overview } = usePhoneOverview()
  const relay = usePhoneRelay()
  const screens = usePhoneScreens()
  const now = useNow(false)
  const { toast } = useToast()
  const [selected, setSelected] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const phones = phoneList(overview, relay)
  const several = phones.length > 1
  const phone = phones.find(p => (p.id || p.name) === selected)
  const startable = phones.filter(p => p.id && p.connected && p.automation?.remoteStart)

  const blocker = (target: PhoneOverviewPhone): string | null => {
    if (!relay?.configured) return 'Set up the phone relay in Settings → Cloudflare.'
    if (!relay.connected) return 'Manhwa Studio can’t reach the relay right now.'
    if (several && !target.id) return 'Update Sleeper-Cell to start this phone individually.'
    if (several && !target.connected) return 'Open Sleeper-Cell on this phone to start it.'
    if (!target.automation) return 'Open or update Sleeper-Cell, then refresh its status.'
    if (!target.automation.remoteStart) return 'Turn on “Start from Manhwa Studio” in the phone’s Automation settings.'
    if (phoneActivity(overview, target, several).busy) return 'A run is already in progress. Manage it in Phone Status.'
    return null
  }

  const start = async (options: PhoneAutomationOptions): Promise<boolean> => {
    if (!phone) return false
    const reason = blocker(phone)
    if (reason && !options.split) {
      toast({ title: 'Could not start the run', description: reason, variant: 'destructive' })
      return false
    }
    setSending(true)
    try {
      const sent = await r2Api.sendPhoneAutomation('start', {
        ...options,
        seriesId: series.id,
        // Always address the chosen phone when its build provides an id.
        ...(!options.split && phone.id ? { device: phone.id } : {})
      })
      const split = options.split && sent.targets?.length
      toast({
        title: `${AUTOMATION_NAME[options.kind ?? 'clipper']} sent to ${split ? `${sent.targets!.length} phones` : phone.name}`,
        description: split
          ? sent.targets!.map(t => `${t.name}: ${t.action === 'finish' ? 'finishes what it’s on' : chapterRanges(t.chapters ?? [], sent.numbers ?? {})}${t.reached ? '' : ' (not connected)'}`).join(' · ')
          : sent.phones ? `${series.title} · Follow the run in Sleeper Cells → Live Progress.`
          : 'The phone will act on this if it connects within 10 minutes.'
      })
      return true
    } catch (error) {
      toast({ title: 'Could not start the run', description: error instanceof Error ? error.message : String(error), variant: 'destructive' })
      return false
    } finally {
      setSending(false)
    }
  }

  if (phone && overview) return (
    <RunAutomationDialog
      key={phone.id || phone.name}
      open
      onOpenChange={open => { if (!open) onClose() }}
      phone={phone}
      overview={overview}
      several={several}
      startable={startable}
      profiles={overview.profiles.filter(p => onPhone(p, phone, several))}
      relay={relay}
      screen={screens.get(phone.id) ?? null}
      screens={screens}
      now={now}
      sending={sending}
      onStart={start}
      fixedSeries={series}
    />
  )

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Run Sleeper-Cell automation</DialogTitle>
          <DialogDescription>Choose a phone for {series.title}, then choose the automation to run.</DialogDescription>
        </DialogHeader>
        {!overview || !relay
          ? <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading phones…</p>
          : <div className="space-y-3">
            {!relay.configured && <p className="text-sm text-muted-foreground">Set up the phone relay in <Link to="/settings?tab=cloudflare" className="underline">Settings → Cloudflare</Link> to start automation.</p>}
            {relay.configured && !relay.connected && <p className="text-sm text-amber-500">Manhwa Studio can’t reach the phone relay right now.</p>}
            {!phones.length && <p className="py-3 text-sm text-muted-foreground">No phones have reported yet. Open Sleeper-Cell on a phone with “Start from Manhwa Studio” enabled.</p>}
            {phones.map(target => {
              const reason = blocker(target)
              return <Button key={target.id || target.name} variant="outline" className="h-auto w-full justify-start gap-3 whitespace-normal p-4 text-left" disabled={!!reason} onClick={() => setSelected(target.id || target.name)}>
                <Smartphone className="h-5 w-5 shrink-0" />
                <span><span className="block font-medium">{target.name}</span><span className="mt-1 block text-xs font-normal text-muted-foreground">{reason ?? (target.connected ? 'Ready · Choose automation' : 'Offline · Start waits up to 10 minutes')}</span></span>
              </Button>
            })}
          </div>}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button asChild variant="ghost"><Link to="/sleeper-cells">Phone Status</Link></Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
