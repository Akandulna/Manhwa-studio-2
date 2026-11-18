/**
 * Settings → AntiGravity → Claude (Claude Code): the third AntiGravity engine.
 *
 * Shows the local Claude Code CLI, its claude.ai sign-in, the Claude models
 * with their reasoning levels, the plan's usage windows as Claude Code last
 * reported them in a Studio turn, and the explicit compatibility test (real
 * image through Studio's MCP tool + same-session second turn). Studio never
 * sees the Claude credentials; sign-in happens in `claude auth login`.
 */

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Circle, Gauge, Loader2, LogIn, RefreshCw, Sparkles, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { claudeApi, type ClaudeConnection, type ClaudeRateLimit, type ClaudeSettings, type CompatibilityReport } from '@/lib/api'
import { cn } from '@/lib/utils'

const CHECK_LABELS: Record<keyof CompatibilityReport['checks'], string> = {
  mcpLoaded: 'Studio MCP tool loaded and called',
  imageSeen: 'Model read the image delivered through MCP',
  conversationIdReturned: 'Session ID returned',
  resumedSameConversation: 'Second turn resumed the same session',
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

function UsageBar({ label, usedPercent, resetsAt }: { label: string; usedPercent: number; resetsAt: string | null }) {
  const used = Math.max(0, Math.min(100, Math.round(usedPercent)))
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span>{label}</span>
        <span className={cn(used >= 90 ? 'text-destructive' : used >= 70 ? 'text-yellow-600 dark:text-yellow-400' : 'text-muted-foreground')}>
          {used}% used{resetsAt ? ` · resets ${new Date(resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-muted">
        <div className={cn('h-full', used >= 90 ? 'bg-destructive' : used >= 70 ? 'bg-yellow-500' : 'bg-primary')} style={{ width: `${used}%` }} />
      </div>
    </div>
  )
}

/** "five_hour" → "5-hour window" etc.; unknown names are shown as Claude Code reports them. */
export function claudeWindowLabel(type: string) {
  const known: Record<string, string> = { five_hour: '5-hour window', seven_day: 'Weekly window', seven_day_opus: 'Weekly window (Opus)', seven_day_sonnet: 'Weekly window (Sonnet)' }
  return known[type] ?? type.replace(/_/g, ' ')
}

/** Claude Code reports a status per window (and a percentage only near a limit). */
export function claudeLimitText(l: ClaudeRateLimit) {
  const state = l.status === 'rejected' ? 'limit reached' : l.status === 'allowed_warning' ? 'nearly used up' : 'available'
  const used = l.utilization !== null ? ` · ${Math.round(l.utilization * 100)}% used` : ''
  const reset = l.resetsAt ? ` · resets ${new Date(l.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''
  return `${state}${used}${reset}`
}

export default function ClaudeCard({ onChange }: { onChange?: () => void }) {
  const { toast } = useToast()
  const [data, setData] = useState<ClaudeConnection | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await claudeApi.connection())
    } catch (error) {
      toast({ title: 'Could not read Claude Code status', description: (error as Error).message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { void load() }, [load])

  const save = async (patch: Partial<ClaudeSettings>) => {
    setBusy('save')
    try {
      const settings = await claudeApi.saveSettings(patch)
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
      const report = await claudeApi.check()
      toast(report.ok
        ? { title: 'Claude compatibility test passed', description: `${report.model} saw the MCP image and resumed the same session.` }
        : { title: 'Claude compatibility test failed', description: report.error ?? 'See the checks below.', variant: 'destructive' })
    } catch (error) {
      toast({ title: 'Claude compatibility test', description: (error as Error).message, variant: 'destructive' })
    } finally {
      setBusy(null)
      void load()
      onChange?.()
    }
  }

  const signIn = async () => {
    try {
      const result = await claudeApi.signIn()
      toast({ title: result.opened ? 'Terminal opened' : 'Sign in to Claude Code', description: result.instructions })
    } catch (error) {
      toast({ title: 'Sign in', description: (error as Error).message, variant: 'destructive' })
    }
  }

  if (!data) {
    return <Card><CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking Claude Code…</CardContent></Card>
  }

  const { installation, account, settings, report, models, rateLimits, usage, usageError } = data
  const refused = rateLimits.filter(l => l.status === 'rejected' && (!l.resetsAt || Date.parse(l.resetsAt) > Date.now()))
  const model = models.find(m => m.id === settings.model) ?? null
  const signedOut = account ? !account.signedIn : false
  const badge = !installation.path ? { label: 'Not installed', variant: 'destructive' as const }
    : signedOut ? { label: 'Sign-in required', variant: 'warning' as const }
    : data.proofValid ? { label: 'Verified', variant: 'success' as const }
    : { label: 'Not verified', variant: 'secondary' as const }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-lg"><Sparkles className="h-5 w-5" /> Claude (Claude Code)</CardTitle>
          <p className="text-sm text-muted-foreground">
            Claude Code runs on this Mac with your Claude sign-in. Work counts against the Claude plan's usage limits (Pro or Max), not an API bill. Each turn runs locked down: none of your Claude Code settings, hooks or plugins, no shell, files or web, only Studio's tools.
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
                  <Button size="sm" onClick={signIn}><LogIn className="mr-2 h-4 w-4" /> Sign in with Claude</Button>
                </div>
              ) : (
                <div className={cn(account.method !== 'claude.ai' && 'text-yellow-600 dark:text-yellow-400')}>{account.detail}</div>
              )}
          </div>
        </section>

        {(usage || usageError || refused.length > 0) && (
          <section className="space-y-2 rounded-md border p-3">
            <div className="flex items-center gap-2 text-sm font-medium"><Gauge className="h-4 w-4" /> Claude usage {usage && <span className="text-xs font-normal text-muted-foreground">from Claude Code's /usage, {new Date(usage.at).toLocaleString()}</span>}</div>
            {usage?.windows.map(w => <UsageBar key={w.label} label={w.label} usedPercent={w.usedPercent} resetsAt={w.resetsAt} />)}
            {usageError && <div className="text-xs text-destructive">{usageError}</div>}
            {refused.map(l => <div key={l.type} className="text-xs text-destructive">{claudeWindowLabel(l.type)}: {claudeLimitText(l)}. Runs pause until it resets.</div>)}
          </section>
        )}

        <section className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="cl-model">Model (analysis and review)</label>
            <Select
              value={settings.model ?? undefined}
              disabled={!installation.path || !!busy}
              onValueChange={id => {
                const m = models.find(x => x.id === id)
                void save({ model: id, modelLabel: m?.label ?? null, effort: (settings.effort && m?.efforts.includes(settings.effort) ? settings.effort : m?.defaultEffort ?? null) as ClaudeSettings['effort'] })
              }}
            >
              <SelectTrigger id="cl-model"><SelectValue placeholder="Choose a model" /></SelectTrigger>
              <SelectContent>
                {models.map(m => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {settings.model && !model && (
              <p className="text-xs text-destructive">The saved model {settings.model} is no longer in the list. Choose another; Studio never switches silently.</p>
            )}
            <p className="text-xs text-muted-foreground">Which of these your plan can use is proven by the compatibility test. Each attempt records the requested model and the model Claude Code reports serving.</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="cl-effort">Reasoning level</label>
            <Select value={settings.effort ?? 'default'} disabled={!model || !!busy} onValueChange={v => void save({ effort: (v === 'default' ? null : v) as ClaudeSettings['effort'] })}>
              <SelectTrigger id="cl-effort"><SelectValue placeholder={model ? 'Model default' : 'Choose a model first'} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Model default</SelectItem>
                {(model?.efforts ?? []).map(e => <SelectItem key={e} value={e}>{EFFORT_LABELS[e] ?? e}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Higher levels measure more carefully but use more of the plan's limits. Parallel pages and the page deadline are shared with the other engines (Local Antigravity card).</p>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Compatibility test</h3>
            <Button size="sm" disabled={!settings.model || !installation.path || signedOut || !!busy} onClick={check}>
              {busy === 'check' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {busy === 'check' ? 'Running (≈1 min)…' : 'Run compatibility test'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Two real turns on the selected model (uses a little of the Claude plan's usage): the model must read a freshly generated image served by Studio's MCP tool, then answer from memory when Studio resumes that exact session. A new Claude Code minor version (for example 2.1 → 2.2) needs the test again; patch updates don't.
          </p>
          {data.proofNote && busy !== 'check' && <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm">{data.proofNote}</div>}
          {busy === 'check' && <div className="rounded-md border px-3 py-2 text-sm">Testing {settings.modelLabel ?? settings.model}… the result below is the previous test.</div>}
          {report && (
            <div className={cn('space-y-2 rounded-md border p-3', busy === 'check' && 'opacity-50')}>
              <div className="text-xs text-muted-foreground">
                {busy === 'check' && 'Previous test · '}{new Date(report.at).toLocaleString()} · claude {report.cliVersion ?? '?'} · {report.model}{report.effort ? ` (${report.effort})` : ''}{report.observedModel !== 'unknown' ? ` · served ${report.observedModel}` : ''}{report.account ? ` · ${report.account}` : ''} · {(report.durationMs / 1000).toFixed(0)} s
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
