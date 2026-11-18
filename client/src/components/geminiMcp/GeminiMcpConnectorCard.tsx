/**
 * Settings → Gemini MCP: the connector the Gemini Mac app runs (docs/PRD-gemini-app-narration.md).
 * Install/repair it into ~/.local, copy the command into Gemini's "Add custom connected app" form,
 * test it end to end, and see when Gemini last called it.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, Loader2, PlugZap, RefreshCw, Wrench, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import { geminiMcpApi, type GeminiMcpConnectorStatus, type GeminiMcpSelfTest } from '@/lib/api'

const STATE: Record<GeminiMcpConnectorStatus['state'], { label: string; variant: 'success' | 'warning' | 'outline' }> = {
  not_installed: { label: 'Not installed', variant: 'outline' },
  needs_repair: { label: 'Needs repair', variant: 'warning' },
  installed: { label: 'Installed', variant: 'success' }
}

const GEMINI_STEPS = [
  'Open the Gemini app → Settings → Customize → Connectors, and add a custom connected app.',
  'Choose Local MCP. Server Name: Manhwa Studio.',
  'Paste the command above into Command. Leave Sandbox settings as they are.',
  'Click Next and allow the connection.',
  'In a new Gemini chat, type @Manhwa Studio to use it.'
]

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : null)

export default function GeminiMcpConnectorCard() {
  const { toast } = useToast()
  const [status, setStatus] = useState<GeminiMcpConnectorStatus | null>(null)
  const [busy, setBusy] = useState<'load' | 'install' | 'test' | 'readded' | null>('load')
  const [test, setTest] = useState<GeminiMcpSelfTest | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (kind: 'load' | 'install' | 'test' | 'readded') => {
    setBusy(kind); setError(null)
    try {
      if (kind === 'test') { setTest(await geminiMcpApi.test()); setStatus(await geminiMcpApi.connector()) }
      else setStatus(await (kind === 'install' ? geminiMcpApi.install() : kind === 'readded' ? geminiMcpApi.readded() : geminiMcpApi.connector()))
      if (kind === 'install') setTest(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(null) }
  }, [])
  useEffect(() => { void run('load') }, [run])

  const copy = async () => {
    if (!status?.command) return
    await navigator.clipboard.writeText(status.command)
    toast({ title: 'Command copied', description: 'Paste it into the Command field in Gemini.' })
  }

  const state = status ? STATE[status.state] : null
  const lastCall = status?.lastCall

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2"><PlugZap className="h-5 w-5" /> Gemini app connector</CardTitle>
          <p className="text-sm text-muted-foreground">
            The Gemini Mac app runs this small local program to talk to Studio. It only passes messages on; Studio does the work and the checks.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {state && <Badge variant={state.variant}>{state.label}</Badge>}
          <Button variant="ghost" size="icon" onClick={() => run('load')} disabled={!!busy} title="Refresh">
            <RefreshCw className={`h-4 w-4 ${busy === 'load' ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {status?.state === 'not_installed' && (
          <div className="space-y-3">
            <p className="text-sm">Install it into <code className="text-xs">{status.dir}</code>. Gemini can only run programs from folders like this one, not from Documents.</p>
            <Button onClick={() => run('install')} disabled={!!busy}>
              {busy === 'install' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <PlugZap className="h-4 w-4 mr-2" />}Install connector
            </Button>
          </div>
        )}

        {status?.state === 'needs_repair' && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
            <p className="text-sm font-medium flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" /> The connector needs a repair</p>
            <ul className="text-sm list-disc pl-5">{status.problems.map(p => <li key={p}>{p}</li>)}</ul>
            <p className="text-xs text-muted-foreground">Repair keeps the same command, so you don't need to change anything in Gemini.</p>
            <Button size="sm" onClick={() => run('install')} disabled={!!busy}>
              {busy === 'install' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Wrench className="h-4 w-4 mr-2" />}Repair
            </Button>
          </div>
        )}

        {status?.readdNeeded && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
            <p className="text-sm font-medium flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" /> Re-add the connector in Gemini</p>
            <p className="text-sm">This Studio version changed the connector's tools. Gemini only reads them when the connector is added, so remove Manhwa Studio in Gemini's Connectors and add it again with the same command.</p>
            <Button size="sm" variant="outline" onClick={() => run('readded')} disabled={!!busy}>I've re-added it</Button>
          </div>
        )}

        {status?.command && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Command for Gemini</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate rounded-md border bg-muted px-3 py-2 text-xs" title={status.command}>{status.command}</code>
              <Button variant="outline" size="sm" onClick={copy}><Copy className="h-4 w-4 mr-2" />Copy</Button>
            </div>
            <ol className="text-sm text-muted-foreground list-decimal pl-5 space-y-1">{GEMINI_STEPS.map(s => <li key={s}>{s}</li>)}</ol>
          </div>
        )}

        {status && status.state !== 'not_installed' && (
          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            <Button variant="outline" size="sm" onClick={() => run('test')} disabled={!!busy}>
              {busy === 'test' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <PlugZap className="h-4 w-4 mr-2" />}Test connection
            </Button>
            {status.state === 'installed' && (
              <Button variant="ghost" size="sm" onClick={() => run('install')} disabled={!!busy}><Wrench className="h-4 w-4 mr-2" />Reinstall</Button>
            )}
            {test && (test.ok
              ? <span className="text-sm flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" /> Connector works: {test.tools.join(', ')}</span>
              : <span className="text-sm flex items-center gap-1.5 text-destructive"><XCircle className="h-4 w-4" /> {test.error}</span>)}
          </div>
        )}

        {status && status.state !== 'not_installed' && (
          <p className="text-sm text-muted-foreground">
            {lastCall
              ? <>Gemini last called <span className="font-medium text-foreground">{lastCall.tool}</span> at {when(lastCall.at)}{lastCall.job ? ` (job ${lastCall.job})` : ''}.</>
              : 'Gemini has not called the connector yet. After adding it, ask Gemini in a new chat: "@Manhwa Studio get the next job".'}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
