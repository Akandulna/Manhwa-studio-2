/**
 * Settings → AntiGravity → ChatGPT (Codex): the second AntiGravity engine.
 *
 * Shows the Codex CLI (bundled with the ChatGPT desktop app), its ChatGPT
 * sign-in, the models Codex offers with their reasoning levels, the plan's
 * Codex usage windows, and the explicit compatibility test (real image through
 * Studio's MCP tool + same-thread second turn). Studio never sees the ChatGPT
 * credentials; sign-in happens in `codex login`.
 */

import { useCallback, useEffect, useState } from 'react'
import { Bot, CheckCircle2, Circle, Gauge, Loader2, LogIn, RefreshCw, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { codexApi, type CodexConnection, type CodexRateLimits, type CodexSettings, type CompatibilityReport } from '@/lib/api'
import { cn } from '@/lib/utils'
import CodexAccounts from './CodexAccounts'

const CHECK_LABELS: Record<keyof CompatibilityReport['checks'], string> = {
  mcpLoaded: 'Studio MCP tool loaded and called',
  imageSeen: 'Model read the image delivered through MCP',
  conversationIdReturned: 'Thread ID returned',
  resumedSameConversation: 'Second turn resumed the same thread',
  contextRetained: 'Context kept across turns'
}

const EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

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

function UsageBar({ label, window }: { label: string; window: CodexRateLimits['primary'] }) {
  if (!window) return null
  const used = Math.max(0, Math.min(100, Math.round(window.usedPercent)))
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span>{label}</span>
        <span className={cn(used >= 90 ? 'text-destructive' : used >= 70 ? 'text-yellow-600 dark:text-yellow-400' : 'text-muted-foreground')}>
          {used}% used{window.resetsAt ? ` · resets ${new Date(window.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-muted">
        <div className={cn('h-full', used >= 90 ? 'bg-destructive' : used >= 70 ? 'bg-yellow-500' : 'bg-primary')} style={{ width: `${used}%` }} />
      </div>
    </div>
  )
}

export default function CodexCard({ onChange }: { onChange?: () => void }) {
  const { toast } = useToast()
  const [data, setData] = useState<CodexConnection | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await codexApi.connection())
    } catch (error) {
      toast({ title: 'Could not read Codex status', description: (error as Error).message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { void load() }, [load])

  const save = async (patch: Partial<CodexSettings>) => {
    setBusy('save')
    try {
      const settings = await codexApi.saveSettings(patch)
      setData(d => (d ? { ...d, settings } : d))
      void load()
      onChange?.()
    } catch (error) {
      toast({ title: 'Settings not saved', description: (error as Error).message, variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const check = async () => {
    setBusy('check')
    try {
      const report = await codexApi.check()
      toast(report.ok
        ? { title: 'Codex compatibility test passed', description: `${report.model} saw the MCP image and resumed the same thread.` }
        : { title: 'Codex compatibility test failed', description: report.error ?? 'See the checks below.', variant: 'destructive' })
    } catch (error) {
      toast({ title: 'Codex compatibility test', description: (error as Error).message, variant: 'destructive' })
    } finally {
      setBusy(null)
      void load()
      onChange?.()
    }
  }

  const signIn = async () => {
    try {
      const result = await codexApi.signIn()
      toast({ title: result.opened ? 'Terminal opened' : 'Sign in to Codex', description: result.instructions })
    } catch (error) {
      toast({ title: 'Sign in', description: (error as Error).message, variant: 'destructive' })
    }
  }

  if (!data) {
    return <Card><CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking the Codex CLI…</CardContent></Card>
  }

  const { installation, account, settings, report, models, modelsError, rateLimits } = data
  const model = models?.find(m => m.id === settings.model) ?? null
  const signedOut = account ? !account.signedIn : false
  const badge = !installation.path ? { label: 'Not installed', variant: 'destructive' as const }
    : signedOut ? { label: 'Sign-in required', variant: 'warning' as const }
    : data.proofValid ? { label: 'Verified', variant: 'success' as const }
    : { label: 'Not verified', variant: 'secondary' as const }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-lg"><Bot className="h-5 w-5" /> ChatGPT (Codex)</CardTitle>
          <p className="text-sm text-muted-foreground">
            The Codex CLI that ships with the ChatGPT desktop app runs on this Mac with your ChatGPT sign-in. Work counts against the plan's Codex limits (Plus and above), not the API. Each turn runs locked down: no user config or plugins, read-only sandbox, no shell, web or computer use, only Studio's tools.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={badge.variant}>{badge.label}</Badge>
          <Button variant="ghost" size="icon" aria-label="Refresh" disabled={loading || !!busy} onClick={() => void load()}>
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
            <div className="text-muted-foreground">Sign-in</div>
            {!installation.path ? <div className="text-muted-foreground">—</div>
              : signedOut || !account ? (
                <div className="space-y-2">
                  <div>{account?.detail ?? 'Unknown'}</div>
                  <Button size="sm" onClick={signIn}><LogIn className="mr-2 h-4 w-4" /> Sign in with ChatGPT</Button>
                </div>
              ) : (
                <div className={cn(account.mode === 'api_key' && 'text-yellow-600 dark:text-yellow-400')}>{account.detail}{rateLimits?.planType ? ` Plan: ${rateLimits.planType}.` : ''}</div>
              )}
          </div>
        </section>

        {rateLimits && (rateLimits.primary || rateLimits.secondary) && (
          <section className="space-y-2 rounded-md border p-3">
            <div className="flex items-center gap-2 text-sm font-medium"><Gauge className="h-4 w-4" /> Codex usage{data.accounts.accounts.length > 1 && (() => { const next = data.accounts.accounts.find(a => a.enabled && !a.limited); return next ? ` — ${next.label}` : '' })()} <span className="text-xs font-normal text-muted-foreground">as Codex last recorded it, {new Date(rateLimits.at).toLocaleString()}</span></div>
            <UsageBar label="5-hour window" window={rateLimits.primary} />
            <UsageBar label="Weekly window" window={rateLimits.secondary} />
            {rateLimits.reached && <div className="text-xs text-destructive">Limit reached ({rateLimits.reached}). Runs pause until it resets.</div>}
          </section>
        )}

        {installation.path && <CodexAccounts data={data.accounts} onChange={() => void load()} />}

        <section className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="cx-model">Model (analysis and review)</label>
            <Select
              value={settings.model ?? undefined}
              disabled={!models || !!busy}
              onValueChange={id => {
                const m = models?.find(x => x.id === id)
                void save({ model: id, modelLabel: m?.label ?? null, effort: (settings.effort && m?.efforts.includes(settings.effort) ? settings.effort : m?.defaultEffort ?? null) as CodexSettings['effort'] })
              }}
            >
              <SelectTrigger id="cx-model"><SelectValue placeholder={models ? 'Choose a model' : 'No models'} /></SelectTrigger>
              <SelectContent>
                {(models ?? []).map(m => <SelectItem key={m.id} value={m.id} disabled={!m.image}>{m.label}{m.image ? '' : ' — text only, cannot see pages'}</SelectItem>)}
              </SelectContent>
            </Select>
            {modelsError && <p className="text-xs text-destructive">{modelsError.message}</p>}
            {settings.model && models && !model && (
              <p className="text-xs text-destructive">The saved model {settings.model} is no longer offered. Choose another; Studio never switches silently.</p>
            )}
            <p className="text-xs text-muted-foreground">From Codex's own model list. Each attempt records the requested model and the model Codex's session file reports.</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="cx-effort">Reasoning level</label>
            <Select value={settings.effort ?? undefined} disabled={!model || !!busy} onValueChange={v => void save({ effort: v as CodexSettings['effort'] })}>
              <SelectTrigger id="cx-effort"><SelectValue placeholder={model ? 'Model default' : 'Choose a model first'} /></SelectTrigger>
              <SelectContent>
                {(model?.efforts ?? []).map(e => <SelectItem key={e} value={e}>{EFFORT_LABELS[e] ?? e}{e === model?.defaultEffort ? ' (default)' : ''}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Higher levels measure more carefully but use more of the plan's limits. Parallel pages and the page deadline are shared with Antigravity (Local Antigravity card).</p>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Compatibility test</h3>
            <Button size="sm" disabled={!settings.model || !models || signedOut || !!busy} onClick={check}>
              {busy === 'check' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {busy === 'check' ? 'Running (≈1 min)…' : 'Run compatibility test'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Two real turns on the selected model (uses a little Codex usage): the model must read a freshly generated image served by Studio's MCP tool, then answer from memory when Studio resumes that exact thread.
          </p>
          {data.proofNote && busy !== 'check' && <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm">{data.proofNote}</div>}
          {busy === 'check' && <div className="rounded-md border px-3 py-2 text-sm">Testing {settings.modelLabel ?? settings.model}… the result below is the previous test.</div>}
          {report && (
            <div className={cn('space-y-2 rounded-md border p-3', busy === 'check' && 'opacity-50')}>
              <div className="text-xs text-muted-foreground">
                {busy === 'check' && 'Previous test · '}{new Date(report.at).toLocaleString()} · codex {report.cliVersion ?? '?'} · {report.model}{report.effort ? ` (${report.effort})` : ''}{report.observedModel !== 'unknown' ? ` · session model ${report.observedModel}` : ''} · {(report.durationMs / 1000).toFixed(0)} s
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
