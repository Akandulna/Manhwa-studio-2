/**
 * PhoneRefreshButton — "Refresh from phone": asks Sleeper-Cell to send all its
 * receipts again (see usePhoneReceipt), with when the phone last reported
 * beside it. With the phone relay the markers also update live on their own,
 * and a dot shows whether Sleeper-Cell is open; without it this button is the
 * only way they change, since nothing polls R2.
 */

import { Loader2, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import type { PhoneReceipt } from '@/hooks/usePhoneReceipt'
import { usePhoneRelay } from '@/hooks/usePhoneRelay'

function formatReported(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function PhoneRefreshButton<T extends { configured: boolean; reportedAt: string | null; device: string | null }>({
  receipt,
  size = 'sm'
}: {
  receipt: PhoneReceipt<T>
  size?: 'sm' | 'default'
}) {
  const { toast } = useToast()
  const relay = usePhoneRelay()
  const { status, refreshing, refresh } = receipt
  if (!status?.configured) return null
  const reported = formatReported(status.reportedAt)
  const phone = status.device ? `Sleeper-Cell (${status.device})` : 'Sleeper-Cell'
  const live = !!relay?.configured

  const onClick = async () => {
    try {
      const outcome = await refresh()
      if (outcome === 'answered') {
        toast({ title: 'Updated from phone', description: `${phone} sent its latest progress.` })
      } else if (live) {
        toast({
          title: 'The phone did not answer',
          description: 'Open Sleeper-Cell on the phone. The relay keeps the request, so the phone answers as soon as it opens, and the markers here update by themselves.',
          variant: 'destructive'
        })
      } else {
        toast({
          title: 'The phone did not answer',
          description: 'Open Sleeper-Cell on the phone: it checks for requests every 30 s while it is open. The request stays there, so it answers as soon as it is opened. Click again to look.',
          variant: 'destructive'
        })
      }
    } catch (error) {
      toast({
        title: 'Could not ask the phone',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive'
      })
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size={size}
        onClick={onClick}
        disabled={refreshing}
        title={live
          ? `Ask ${phone} to send all its progress again. It also sends each change by itself through the phone relay.`
          : `Ask ${phone} to send its progress. Sleeper-Cell only reports when asked, to save R2 operations.`}
      >
        {refreshing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Smartphone className="h-4 w-4 mr-2" />}
        {refreshing ? 'Waiting for phone…' : 'Refresh from phone'}
      </Button>
      {live && relay && <RelayDot connected={relay.connected} phones={relay.phones} />}
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {reported ? `as of ${reported}` : 'never reported'}
      </span>
    </div>
  )
}

/** Live: green while Sleeper-Cell is open, grey while it's closed, amber while the relay is unreachable. */
function RelayDot({ connected, phones }: { connected: boolean; phones: number }) {
  const [color, label, hint] = !connected
    ? ['bg-amber-500', 'Relay offline', 'Manhwa Studio cannot reach the phone relay; it keeps retrying. Settings → Cloudflare shows why.']
    : phones > 0
      ? ['bg-emerald-500', 'Phone open', 'Sleeper-Cell is open: its progress shows up here as it happens.']
      : ['bg-muted-foreground/50', 'Phone closed', 'Sleeper-Cell is closed. Its next changes show up here the moment it opens.']
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap" title={hint}>
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {label}
    </span>
  )
}
