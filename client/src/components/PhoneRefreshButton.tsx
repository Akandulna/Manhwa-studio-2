/**
 * PhoneRefreshButton — "Refresh from phone": asks Sleeper-Cell for fresh
 * receipts (see usePhoneReceipt), with when the phone last reported beside it.
 * The only way the phone markers change, since nothing polls R2.
 */

import { Loader2, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import type { PhoneReceipt } from '@/hooks/usePhoneReceipt'

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
  const { status, refreshing, refresh } = receipt
  if (!status?.configured) return null
  const reported = formatReported(status.reportedAt)
  const phone = status.device ? `Sleeper-Cell (${status.device})` : 'Sleeper-Cell'

  const onClick = async () => {
    try {
      const outcome = await refresh()
      if (outcome === 'answered') {
        toast({ title: 'Updated from phone', description: `${phone} sent its latest progress.` })
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
        title={`Ask ${phone} to send its progress. Sleeper-Cell only reports when asked, to save R2 operations.`}
      >
        {refreshing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Smartphone className="h-4 w-4 mr-2" />}
        {refreshing ? 'Waiting for phone…' : 'Refresh from phone'}
      </Button>
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {reported ? `as of ${reported}` : 'never reported'}
      </span>
    </div>
  )
}
