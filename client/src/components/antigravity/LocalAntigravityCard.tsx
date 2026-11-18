/**
 * AntiGravity → Settings → Local Antigravity (docs/PRD-antigravity-studio.md §5.2).
 *
 * Shows the detected official CLI, lets the operator pick a model offered by
 * the signed-in installation, and runs the explicit compatibility test
 * (real image through Studio's MCP tool + same-conversation second turn).
 * Studio never asks for an Antigravity password; sign-in happens in agy.
 */

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Circle, Cpu, Loader2, LogIn, RefreshCw, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { antigravityApi, type AntigravityConnection, type AntigravitySettings, type CompatibilityReport } from '@/lib/api'
import { cn } from '@/lib/utils'

/** Models agy offers that have no image input (confirmed live: GPT-OSS 120B tried OCR instead of seeing the probe). */
const TEXT_ONLY = /^gpt-oss/i

const CHECK_LABELS: Record<keyof CompatibilityReport['checks'], string> = {
  mcpLoaded: 'Studio MCP tool loaded and called',
  imageSeen: 'Model read the image delivered through MCP',
  conversationIdReturned: 'Conversation ID returned',
  resumedSameConversation: 'Second turn resumed the same conversation',
  contextRetained: 'Context kept across turns'
}

function Indicator({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok === true ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" /> : ok === false ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
      <div>
        <div>{label}</div>
        {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
      </div>
    </li>
  )
}

export default function LocalAntigravityCard() {
  const { toast } = useToast()
  const [data, setData] = useState<AntigravityConnection | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async (refreshModels = false) => {
    setLoading(true)
    try {
      setData(await antigravityApi.connection(refreshModels))
    } catch (error) {
      toast({ title: 'Could not read Antigravity status', description: (error as Error).message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { void load() }, [load])

  const save = async (patch: Partial<AntigravitySettings>) => {
    setBusy('save')
    try {
      const settings = await antigravityApi.saveSettings(patch)
      setData(d => (d ? { ...d, settings } : d))
      void load()
    } catch (error) {
      toast({ title: 'Settings not saved', description: (error as Error).message, variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const check = async () => {
    setBusy('check')
    try {
      const report = await antigravityApi.check()
      toast(report.ok
        ? { title: 'Compatibility test passed', description: `${report.model} saw the MCP image and resumed the same conversation.` }
        : { title: 'Compatibility test failed', description: report.error ?? 'See the checks below.', variant: 'destructive' })
    } catch (error) {
      toast({ title: 'Compatibility test', description: (error as Error).message, variant: 'destructive' })
    } finally {
      setBusy(null)
      void load()
    }
  }

  const signIn = async () => {
    try {
      const result = await antigravityApi.signIn()
      toast({ title: result.opened ? 'Terminal opened' : 'Sign in to Antigravity', description: result.instructions })
    } catch (error) {
      toast({ title: 'Sign in', description: (error as Error).message, variant: 'destructive' })
    }
  }

  if (!data) {
    return <Card><CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking the local Antigravity CLI…</CardContent></Card>
  }

  const { installation, settings, report, models, modelsError } = data
  const authRequired = modelsError?.code === 'auth_required'
  /** Home-relative so it reads like what the operator types: ~/.local/bin/agy. */
  const agyCommand = installation.path?.replace(/^\/Users\/[^/]+(?=\/)/, '~') ?? '~/.local/bin/agy'
  const badge = !installation.path ? { label: 'Not installed', variant: 'destructive' as const }
    : authRequired ? { label: 'Sign-in required', variant: 'warning' as const }
    : data.proofValid ? { label: 'Verified', variant: 'success' as const }
    : { label: 'Not verified', variant: 'secondary' as const }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-lg"><Cpu className="h-5 w-5" /> Local Antigravity</CardTitle>
          <p className="text-sm text-muted-foreground">
            The official <code>agy</code> CLI runs on this Mac with its own sign-in. Model requests still go to Antigravity's online service, so the Mac must be awake and online and Studio's backend running.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={badge.variant}>{badge.label}</Badge>
          <Button variant="ghost" size="icon" aria-label="Refresh models" disabled={loading || !!busy} onClick={() => void load(true)}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <div className="text-muted-foreground">Executable</div>
            <div className="font-mono text-xs break-all">{installation.path ?? '—'}</div>
            <div>{installation.version ? `Version ${installation.version}` : installation.error}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Account</div>
            {authRequired ? (
              <div className="space-y-2">
                <div>{modelsError?.message}</div>
                <Button size="sm" onClick={signIn}><LogIn className="mr-2 h-4 w-4" /> Sign in with agy</Button>
              </div>
            ) : models ? (
              <div>Signed in — {models.length} models available</div>
            ) : (
              <div className="text-muted-foreground">{modelsError?.message ?? 'Unknown'}</div>
            )}
          </div>
        </section>

        <section className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Log in or log out</h3>
            {installation.path && (
              <Button size="sm" variant="outline" onClick={signIn}><LogIn className="mr-2 h-4 w-4" /> Open agy in Terminal</Button>
            )}
          </div>
          <p className="text-muted-foreground">Run this in Terminal:</p>
          <code className="block rounded bg-background px-2 py-1 font-mono text-xs">{agyCommand}</code>
          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
            <li>Type <code>/login</code> to sign in (finish the Google sign-in in the browser).</li>
            <li>Type <code>/logout</code> to sign out, then <code>/login</code> to switch to another account.</li>
            <li>Type <code>/quit</code> when done, then click Refresh models (↻) above.</li>
          </ul>
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="ag-model">Model (analysis and review)</label>
            <Select
              value={settings.model ?? undefined}
              disabled={!models || !!busy}
              onValueChange={id => void save({ model: id, modelLabel: models?.find(m => m.id === id)?.label ?? null })}
            >
              <SelectTrigger id="ag-model"><SelectValue placeholder={models ? 'Choose a model' : 'No models'} /></SelectTrigger>
              <SelectContent>
                {(models ?? []).map(m => <SelectItem key={m.id} value={m.id}>{m.label}{TEXT_ONLY.test(m.id) ? ' — text only, cannot see pages' : ''}</SelectItem>)}
              </SelectContent>
            </Select>
            {settings.model && models && !models.some(m => m.id === settings.model) && (
              <p className="text-xs text-destructive">The saved model {settings.model} is no longer offered. Choose another; Studio never switches silently.</p>
            )}
            <p className="text-xs text-muted-foreground">The model ID already includes its reasoning level. Each job records the requested model; the CLI does not report the served model, so it is recorded as unknown.</p>
            {/* Mirrors server stepsFlow.flowFor: Gemini 3.8 Flash gets the phone's four-step prompts. */}
            <p className="text-xs text-muted-foreground">
              {settings.model && /^gemini-3\.8-flash(?:$|-)/.test(settings.model)
                ? 'Prompts: 4 steps — find the shots, place the corners, inspect each crop, then review with the crops drawn on. Used for Gemini 3.8 Flash only.'
                : 'Prompts: one prompt, then review rounds. Gemini 3.8 Flash uses the 4-step prompts instead.'}
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="ag-concurrency">Parallel conversations</label>
            <Select value={String(settings.concurrency)} disabled={!!busy} onValueChange={v => void save({ concurrency: Number(v) })}>
              <SelectTrigger id="ag-concurrency"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1 (default)</SelectItem>
                {[2, 3, 4].map(n => <SelectItem key={n} value={String(n)}>{n} conversations at once</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Clipping uses one conversation per page. Narration reads batches of up to five whole pages in parallel, then combines their notes before writing.</p>
            <label className="mt-3 flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={settings.sandbox} disabled={!!busy} onChange={e => void save({ sandbox: e.target.checked })} />
              <span>Run agy with <code>--sandbox</code> (recommended: inherited command permissions cannot run shell commands)</span>
            </label>
            <div className="text-xs text-muted-foreground">Page deadline: {settings.pageTimeoutMinutes} minutes including review.</div>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Compatibility test</h3>
            <Button size="sm" disabled={!settings.model || !models || !!busy} onClick={check}>
              {busy === 'check' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {busy === 'check' ? 'Running (≈1 min)…' : 'Run compatibility test'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Two real turns on the selected model (uses a little Antigravity quota): the model must read a freshly generated image served by Studio's MCP tool, then answer from memory when Studio resumes that exact conversation.
          </p>
          {data.proofNote && busy !== 'check' && <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm">{data.proofNote}</div>}
          {busy === 'check' && <div className="rounded-md border px-3 py-2 text-sm">Testing {settings.modelLabel ?? settings.model}… the result below is the previous test.</div>}
          {report && (
            <div className={cn('space-y-2 rounded-md border p-3', busy === 'check' && 'opacity-50')}>
              <div className="text-xs text-muted-foreground">
                {busy === 'check' && 'Previous test · '}{new Date(report.at).toLocaleString()} · agy {report.cliVersion ?? '?'} · {report.model}{report.sandbox ? ' · sandbox' : ''} · {(report.durationMs / 1000).toFixed(0)} s
              </div>
              <ul className="space-y-1.5">
                {(Object.keys(CHECK_LABELS) as (keyof CompatibilityReport['checks'])[]).map(k => (
                  <Indicator key={k} ok={report.checks[k].ok} label={CHECK_LABELS[k]} detail={report.checks[k].detail} />
                ))}
              </ul>
              {report.error && <div className="text-sm text-destructive">{report.error}</div>}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  )
}
