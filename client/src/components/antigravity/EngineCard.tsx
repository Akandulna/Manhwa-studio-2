/**
 * Settings → AntiGravity → AI engine: which local CLI new runs use.
 * Antigravity (agy), ChatGPT through the Codex CLI, or Claude through Claude
 * Code. Everything else — Drive slices, Studio's MCP tools, prompts, review,
 * Clipper import, phones — is the same for all. A run keeps the engine it started with.
 */

import { useCallback, useEffect, useState } from 'react'
import { Bot, Cpu, Loader2, Sparkles, Workflow } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import { antigravityApi, claudeApi, codexApi, ENGINE_LABELS, type AiEngine, type AntigravityConnection, type ClaudeConnection, type CodexConnection } from '@/lib/api'
import { cn } from '@/lib/utils'

export default function EngineCard({ refreshKey = 0, onEngineChange }: { refreshKey?: number; onEngineChange?: (engine: AiEngine) => void }) {
  const { toast } = useToast()
  const [ag, setAg] = useState<AntigravityConnection | null>(null)
  const [codex, setCodex] = useState<CodexConnection | null>(null)
  const [claude, setClaude] = useState<ClaudeConnection | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    antigravityApi.connection().then(setAg).catch(() => setAg(null))
    codexApi.connection().then(setCodex).catch(() => setCodex(null))
    claudeApi.connection().then(setClaude).catch(() => setClaude(null))
  }, [])
  useEffect(() => { load() }, [load, refreshKey])

  const choose = async (engine: AiEngine) => {
    if (!ag || ag.settings.engine === engine) return
    setSaving(true)
    try {
      const settings = await antigravityApi.saveSettings({ engine })
      setAg(a => (a ? { ...a, settings } : a))
      toast({ title: `New runs use ${ENGINE_LABELS[engine]}`, description: 'Runs already started keep their engine.' })
    } catch (error) {
      toast({ title: 'Engine not changed', description: (error as Error).message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const options: { engine: AiEngine; title: string; icon: typeof Cpu; ready: boolean | null; detail: string }[] = [
    {
      engine: 'antigravity', title: 'Antigravity', icon: Cpu,
      ready: ag ? ag.proofValid : null,
      detail: ag ? `${ag.settings.modelLabel ?? ag.settings.model ?? 'No model chosen'}${ag.proofValid ? '' : ` — ${ag.proofNote ?? 'not verified'}`}` : 'Checking…'
    },
    {
      engine: 'codex', title: 'ChatGPT (Codex)', icon: Bot,
      ready: codex ? codex.proofValid : null,
      detail: codex ? `${codex.settings.modelLabel ?? codex.settings.model ?? 'No model chosen'}${codex.settings.effort ? ` · ${codex.settings.effort}` : ''}${codex.proofValid ? '' : ` — ${codex.proofNote ?? 'not verified'}`}` : 'Checking…'
    },
    {
      engine: 'claude', title: 'Claude (Claude Code)', icon: Sparkles,
      ready: claude ? claude.proofValid : null,
      detail: claude ? `${claude.settings.modelLabel ?? claude.settings.model ?? 'No model chosen'}${claude.settings.effort ? ` · ${claude.settings.effort}` : ''}${claude.proofValid ? '' : ` — ${claude.proofNote ?? 'not verified'}`}` : 'Checking…'
    }
  ]
  const current = ag?.settings.engine ?? 'antigravity'
  useEffect(() => { if (ag) onEngineChange?.(current) }, [ag, current, onEngineChange])

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-lg"><Workflow className="h-5 w-5" /> AI engine</CardTitle>
        <p className="text-sm text-muted-foreground">
          Which local CLI processes pages for new runs. Slicing, Google Drive, Studio's tools, the prompts, the review rounds, Clipper import and phone sharing are the same for all three. A run keeps the engine it started with.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="AI engine">
          {options.map(o => (
            <button
              key={o.engine}
              type="button"
              role="radio"
              aria-checked={current === o.engine}
              disabled={!ag || saving}
              onClick={() => void choose(o.engine)}
              className={cn('flex items-start gap-3 rounded-md border p-3 text-left transition-colors', current === o.engine ? 'border-primary bg-primary/5' : 'hover:bg-muted/50')}
            >
              <o.icon className="mt-0.5 h-5 w-5 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {o.title}
                  {current === o.engine && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">New runs</Badge>}
                  {o.ready === true && <Badge variant="success" className="px-1.5 py-0 text-[10px]">Verified</Badge>}
                  {o.ready === false && <Badge variant="outline" className="px-1.5 py-0 text-[10px]">Not ready</Badge>}
                  {saving && current !== o.engine && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                </div>
                <div className="text-xs text-muted-foreground">{o.detail}</div>
              </div>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
