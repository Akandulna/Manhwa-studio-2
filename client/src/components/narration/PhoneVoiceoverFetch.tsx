/**
 * PhoneVoiceoverFetch — "Fetch voiceover from phone" on a series' chapter list.
 *
 * Sleeper-Cell splits each chapter's script on the phone (the same way
 * Auto-Split does), voices the splits in AI Studio, and uploads every fully
 * voiced chapter to R2 by itself. Clicking the button downloads the chapters
 * not fetched yet (or re-uploaded since) and attaches them straight away: the
 * phone's splits become the chapter's English sections and its audio their
 * audio, aligned like generated audio. Nothing runs on a timer.
 */

import { useState } from 'react'
import { AlertTriangle, CheckCircle, DownloadCloud, Loader2, Smartphone } from 'lucide-react'
import { voiceoverApi, PhoneVoiceoverFetch as FetchResult } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'

const chapters = (n: number) => `${n} chapter${n === 1 ? '' : 's'}`

function Summary({ result }: { result: FetchResult }) {
  const { found, fetched, upToDate, unmatched, failed } = result
  const resplit = fetched.filter(c => c.resplit)
  const otherScript = fetched.filter(c => c.scriptMatches === false)
  return (
    <div className="w-full space-y-1 text-sm">
      <p className="flex items-center gap-2">
        {fetched.length > 0 && <CheckCircle className="h-4 w-4 text-emerald-600" />}
        {found === 0
          ? 'No voiced chapters from the phone in R2 yet'
          : fetched.length > 0
            ? `Attached ${chapters(fetched.length)} (chapter ${fetched.map(c => c.chapterNumber).join(', ')})` +
              (upToDate > 0 ? `; ${chapters(upToDate)} already up to date` : '')
            : `Nothing new from the phone (${chapters(upToDate)} already attached)`}
      </p>
      {resplit.length > 0 && (
        <p className="text-muted-foreground">
          Re-split to the phone's splits: chapter {resplit.map(c => c.chapterNumber).join(', ')}
        </p>
      )}
      {otherScript.length > 0 && (
        <p className="flex items-center gap-1 text-amber-600">
          <AlertTriangle className="h-4 w-4" />
          The phone voiced a different script than this one for chapter {otherScript.map(c => c.chapterNumber).join(', ')} —
          import the phone's scripts to match
        </p>
      )}
      {unmatched.length > 0 && (
        <p className="text-xs text-muted-foreground">Not matched to a chapter here (skipped): {unmatched.join(', ')}</p>
      )}
      {failed.map(f => (
        <p key={f.folder} className="flex items-center gap-1 text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {f.folder}: {f.reason}
        </p>
      ))}
    </div>
  )
}

interface Props {
  seriesId: string
  onFetched: () => void
}

export function PhoneVoiceoverFetch({ seriesId, onFetched }: Props) {
  const { toast } = useToast()
  const [fetching, setFetching] = useState(false)
  const [result, setResult] = useState<FetchResult | null>(null)

  const handleFetch = async () => {
    setFetching(true)
    try {
      const next = await voiceoverApi.fetchPhoneVoiceover(seriesId)
      if (!next.configured) {
        toast({ title: 'R2 is not set up', description: 'Fill in the R2 settings first.', variant: 'destructive' })
        return
      }
      setResult(next)
      if (next.fetched.length > 0) onFetched()
    } catch (err) {
      toast({
        title: 'Could not fetch the voiceover',
        description: err instanceof Error ? err.message : 'Failed to reach R2',
        variant: 'destructive'
      })
    } finally {
      setFetching(false)
    }
  }

  return (
    <Card className="mb-6">
      <CardContent className="py-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">Phone voiceover:</span>
          </div>

          <Button
            size="sm"
            variant="outline"
            onClick={handleFetch}
            disabled={fetching}
            title="Download the chapters the phone has voiced and attach their audio to the sections"
          >
            {fetching ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <DownloadCloud className="h-4 w-4 mr-2" />}
            Fetch from phone
          </Button>

          {!result && (
            <span className="text-sm text-muted-foreground">
              The phone uploads each chapter once all its splits are voiced
            </span>
          )}
          {result && <Summary result={result} />}
        </div>
      </CardContent>
    </Card>
  )
}
