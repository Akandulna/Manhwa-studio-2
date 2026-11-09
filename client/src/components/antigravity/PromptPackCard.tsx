/**
 * AntiGravity → Settings → Prompt pack (PRD §9.1). View, edit and save the
 * Crop Rules, Crop Pointer (analysis) and Review templates. Each save is a new
 * immutable version; runs pin the versions they started with.
 */

import { useCallback, useEffect, useState } from 'react'
import { FileText, History, Loader2, Save } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { antigravityJobsApi, type AntigravityPrompt, type AntigravityPromptKind } from '@/lib/api'
import { cn } from '@/lib/utils'

const LABELS: Record<AntigravityPromptKind, { title: string; help: string }> = {
  crop_rules: { title: 'Crop Rules', help: 'Sent ahead of the Crop Pointer prompt, like the phone\'s Prompt Library → Crop Rules. Paste the phone\'s saved text here if you edited it there.' },
  analysis: { title: 'Crop Pointer prompt', help: 'GeometryWorkflow.prompt(). {{PLACEHOLDERS}} are filled with the page\'s real identity and slices.' },
  review: { title: 'Review prompt', help: 'CropReview.geometryReviewPrompt() for the same conversation. Checks, sweep and current crops are filled in per round.' }
}

export default function PromptPackCard() {
  const { toast } = useToast()
  const [prompts, setPrompts] = useState<AntigravityPrompt[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<AntigravityPromptKind>('analysis')
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [history, setHistory] = useState<{ count: number; isDefault: boolean } | null>(null)

  const load = useCallback(async () => {
    try {
      const { kinds } = await antigravityJobsApi.prompts()
      setPrompts(kinds)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const current = prompts?.find(p => p.kind === active) ?? null
  useEffect(() => {
    if (!current) return
    setDraft(current.content)
    antigravityJobsApi.promptHistory(active).then(h => setHistory({ count: h.versions.length, isDefault: h.defaultSha256 === current.sha256 })).catch(() => setHistory(null))
  }, [current, active])

  const dirty = !!current && draft !== current.content
  const save = async () => {
    setSaving(true)
    try {
      const result = await antigravityJobsApi.savePrompt(active, draft)
      toast({ title: result.unchanged ? 'No change' : `${LABELS[active].title} saved`, description: result.unchanged ? undefined : 'New runs use this version; running jobs keep theirs.' })
      await load()
    } catch (e) {
      toast({ title: 'Prompt not saved', description: (e as Error).message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-lg"><FileText className="h-5 w-5" /> Prompt pack</CardTitle>
        <p className="text-sm text-muted-foreground">The phone's geometry-only Clipper prompts (Sleeper-Cell v2). Studio adds only how images arrive (MCP tools) and how JSON is submitted.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <div className="text-sm text-destructive">{error}</div>}
        {!prompts && !error && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading prompts…</div>}
        {prompts && (
          <>
            <div className="flex flex-wrap gap-2" role="tablist">
              {(Object.keys(LABELS) as AntigravityPromptKind[]).map(kind => (
                <button key={kind} role="tab" aria-selected={active === kind} type="button" onClick={() => setActive(kind)}
                  className={cn('rounded-md border px-3 py-1.5 text-sm', active === kind ? 'border-primary bg-primary/10' : 'hover:bg-accent')}>
                  {LABELS[kind].title}
                </button>
              ))}
            </div>
            {current && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">{current.origin}</Badge>
                  <span className="font-mono">sha256 {current.sha256.slice(0, 12)}…</span>
                  {history && <span className="flex items-center gap-1"><History className="h-3 w-3" /> {history.count} version{history.count === 1 ? '' : 's'}{history.isDefault ? ' · bundled default' : ' · edited'}</span>}
                </div>
                <p className="text-xs text-muted-foreground">{LABELS[active].help}</p>
                <Textarea value={draft} onChange={e => setDraft(e.target.value)} className="h-72 font-mono text-xs" spellCheck={false} aria-label={LABELS[active].title} />
                <div className="flex gap-2">
                  <Button size="sm" disabled={!dirty || saving} onClick={save}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />} Save as new version</Button>
                  <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(current.content)}>Discard changes</Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
