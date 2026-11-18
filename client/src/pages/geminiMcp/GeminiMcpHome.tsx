/**
 * PROCESSOR → Gemini MCP (docs/PRD-gemini-app-narration.md §5): the connector's state and the list of series.
 * A series opens its workflow graph; only Narration Studio is enabled for now.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, BookOpen, CheckCircle2, Loader2, Settings as SettingsIcon, Sparkles, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { geminiMcpApi, type GeminiMcpConnectorStatus, type GeminiSeriesRow } from '@/lib/api'
import { useSeriesOrder } from '@/hooks/useSeriesOrder'
import { useToast } from '@/components/ui/use-toast'

export default function GeminiMcpHome() {
  const [status, setStatus] = useState<GeminiMcpConnectorStatus | null>(null)
  const [series, setSeries] = useState<GeminiSeriesRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ordered = useSeriesOrder(series ?? [])
  const { toast } = useToast()
  const [cleaning, setCleaning] = useState(false)
  const cleanup = async () => {
    if (!window.confirm('Delete every folder in Google Drive › Manhwa Studio › gemini-narration that no current Gemini job uses? Folders of chapters still being written are kept.')) return
    setCleaning(true)
    try {
      const { kept, deleted } = await geminiMcpApi.cleanupDrive()
      toast({ title: deleted.length ? `Deleted ${deleted.length} Drive folder${deleted.length === 1 ? '' : 's'}` : 'Nothing to delete', description: `${kept} folder${kept === 1 ? '' : 's'} in use kept.` })
    } catch (e) { toast({ title: 'Drive cleanup failed', description: (e as Error).message, variant: 'destructive' }) } finally { setCleaning(false) }
  }
  useEffect(() => {
    geminiMcpApi.connector().then(setStatus).catch(e => setError((e as Error).message))
    geminiMcpApi.series().then(r => setSeries(r.series)).catch(e => setError((e as Error).message))
  }, [])

  const ready = status?.state === 'installed' && !status.readdNeeded
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold"><Sparkles className="h-7 w-7" /> Gemini MCP</h1>
          <p className="text-muted-foreground">Write narration scripts in the Gemini Mac app. Studio prepares the pages, checks every step and saves the scripts.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={cleanup} disabled={cleaning} title="Delete Drive folders no current job uses">
            {cleaning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}Clean up Drive
          </Button>
          <Button asChild variant="outline"><Link to="/settings?tab=gemini-mcp"><SettingsIcon className="mr-2 h-4 w-4" />Connector settings</Link></Button>
        </div>
      </div>

      <Card>
        <CardContent className="flex items-center gap-3 py-4 text-sm">
          {!status && !error && <><Loader2 className="h-4 w-4 animate-spin" /> Checking the connector…</>}
          {status && ready && <><CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <span>Connector installed.{status.lastCall ? ` Gemini last called it at ${new Date(status.lastCall.at).toLocaleString()}.` : ' Gemini has not called it yet.'}</span></>}
          {status && !ready && <><AlertTriangle className="h-4 w-4 text-amber-500" />
            <span>{status.state === 'not_installed' ? 'The connector is not installed yet.' : status.readdNeeded ? 'Re-add the connector in Gemini.' : 'The connector needs a repair.'}{' '}
              <Link className="underline" to="/settings?tab=gemini-mcp">Open Settings → Gemini MCP</Link></span></>}
          {error && <span className="text-destructive">{error}</span>}
        </CardContent>
      </Card>

      {!series && !error && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading the library…</div>}
      {series?.length === 0 && (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No series with downloaded chapters or English scripts yet. Add a series from the Library first.</CardContent></Card>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ordered.map(s => (
          <Link key={s.id} to={`/gemini-mcp/series/${s.id}`} className="group rounded-lg border bg-card p-4 transition-colors hover:border-primary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted"><BookOpen className="h-5 w-5 text-muted-foreground" /></div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium group-hover:text-primary">{s.title}</div>
                <div className="text-xs text-muted-foreground">{s.chapters} chapter{s.chapters === 1 ? '' : 's'}</div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  <span className={s.english === s.chapters ? 'text-green-600 dark:text-green-400' : ''}>English {s.english}/{s.chapters}</span>
                  <span className={s.hinglish === s.chapters ? 'text-green-600 dark:text-green-400' : ''}>Hinglish {s.hinglish}/{s.chapters}</span>
                  {s.activeJobs > 0 && <Badge variant="warning">{s.activeJobs} with Gemini</Badge>}
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
