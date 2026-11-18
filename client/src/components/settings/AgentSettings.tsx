import { useCallback, useEffect, useState } from 'react'
import { Bot, Loader2, RefreshCw, RotateCcw, Save } from 'lucide-react'
import { agentApi, type AgentEffort, type AgentEngineId, type AgentFile, type AgentSettings as Settings } from '@/lib/api'
import { notifyAgentChanged, useAgentStatus } from '@/hooks/useAgentStatus'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'

const EFFORTS: { id: AgentEffort; label: string }[] = [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra high' }, { id: 'max', label: 'Max' }]
const selectClass = 'h-9 rounded-md border border-input bg-background px-3 text-sm'

export default function AgentSettings() {
  const { toast } = useToast()
  const { status, refresh } = useAgentStatus()
  const [checking, setChecking] = useState(false)
  const [name, setName] = useState('')
  useEffect(() => { if (status) setName(n => n || status.settings.name) }, [status])
  const fail = (title: string) => (error: unknown) => toast({ title, description: error instanceof Error ? error.message : String(error), variant: 'destructive' })

  const save = async (patch: Parameters<typeof agentApi.saveSettings>[0]) => {
    try { await agentApi.saveSettings(patch); notifyAgentChanged() } catch (e) { fail('Could not save')(e) }
  }
  const recheck = async () => { setChecking(true); try { await refresh(true) } finally { setChecking(false) } }

  const settings: Settings | undefined = status?.settings
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Bot className="h-5 w-5" />{settings?.name ?? 'Studio Agent'}</CardTitle>
          <CardDescription>A chat assistant that knows your library and can do what you can do there. It runs on the AI engines already installed on this Mac — nothing is sent anywhere else.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {!settings ? <Loader2 className="h-5 w-5 animate-spin" /> : <>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Name</p>
                <p className="text-xs text-muted-foreground">Shown in the menu, the chat, and used by the agent itself.</p>
              </div>
              <div className="flex gap-2">
                <Input value={name} maxLength={40} onChange={e => setName(e.target.value)} className="h-9 w-48" />
                <Button size="sm" variant="outline" disabled={!name.trim() || name.trim() === settings.name} onClick={() => void save({ name: name.trim() })}>Rename</Button>
              </div>
            </div>

            <label className="flex items-center justify-between gap-4">
              <span className="text-sm font-medium">Agent is {settings.enabled ? 'on' : 'off'}</span>
              <Switch checked={settings.enabled} onCheckedChange={v => void save({ enabled: v })} />
            </label>

            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">AI engine</p>
                <p className="text-xs text-muted-foreground">Automatic uses the first ready engine (Claude, then ChatGPT, then Antigravity) and falls back if one fails.</p>
              </div>
              <select className={selectClass} value={settings.engine} onChange={e => void save({ engine: e.target.value as Settings['engine'] })}>
                <option value="auto">Automatic</option>
                {status!.engines.map(e => <option key={e.id} value={e.id}>{e.label}{e.available ? '' : ' (not ready)'}</option>)}
              </select>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Model and effort per engine</p>
                <Button variant="outline" size="sm" onClick={() => void recheck()} disabled={checking}>
                  {checking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}Check engines
                </Button>
              </div>
              {status!.engines.map(e => (
                <div key={e.id} className="flex items-center justify-between gap-4 rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <span className={`h-2 w-2 rounded-full ${e.available ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} />{e.label}
                      {status!.activeEngine === e.id && <span className="rounded bg-primary/10 px-1.5 text-xs text-primary">in use</span>}
                    </p>
                    <p className="truncate text-xs text-muted-foreground" title={e.detail}>{e.detail}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <select className={selectClass} disabled={!e.available} value={settings.models[e.id] ?? ''} title="Model"
                      onChange={e2 => void save({ models: { [e.id]: e2.target.value || null } as Partial<Record<AgentEngineId, string | null>> })}>
                      <option value="">Default model</option>
                      {settings.models[e.id] && !e.models.some(m => m.id === settings.models[e.id]) && <option value={settings.models[e.id]!}>{settings.models[e.id]}</option>}
                      {e.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                    <select className={selectClass} disabled={!e.available} value={settings.efforts[e.id] ?? ''} title="Reasoning effort"
                      onChange={e2 => void save({ efforts: { [e.id]: (e2.target.value || null) as AgentEffort | null } })}>
                      <option value="">Default effort</option>
                      {EFFORTS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          </>}
        </CardContent>
      </Card>

      <FileEditor kind="knowledge" title="Knowledge" description="What the agent knows about Manhwa Studio and how it should behave. Edit it to teach the agent your workflow; it reads this before every answer." onError={fail} />
      <FileEditor kind="memory" title="Memory" description="Short notes the agent saved itself when you asked it to remember something. Check, fix or clear them here." onError={fail} />
    </div>
  )
}

function FileEditor({ kind, title, description, onError }: { kind: 'knowledge' | 'memory'; title: string; description: string; onError: (title: string) => (e: unknown) => void }) {
  const { toast } = useToast()
  const [file, setFile] = useState<AgentFile | null>(null)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const load = useCallback(async () => {
    try { const f = await agentApi.file(kind); setFile(f); setText(f.text) } catch (e) { onError(`Could not read ${kind}`)(e) }
  }, [kind]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [load])
  const dirty = !!file && text !== file.text
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea value={text} onChange={e => setText(e.target.value)} rows={14} className="font-mono text-xs" spellCheck={false} />
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {file ? `${(file.bytes / 1024).toFixed(1)} KB · ${file.updatedAt ? `saved ${new Date(file.updatedAt).toLocaleString()}` : 'default (not saved yet)'}` : ''}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={async () => {
              if (!window.confirm(kind === 'memory' ? 'Clear everything the agent remembers?' : 'Replace the knowledge file with the built-in default?')) return
              try { const f = await agentApi.resetFile(kind); setFile(f); setText(f.text); toast({ title: kind === 'memory' ? 'Memory cleared' : 'Knowledge reset' }) } catch (e) { onError('Could not reset')(e) }
            }}>
              <RotateCcw className="mr-2 h-4 w-4" />{kind === 'memory' ? 'Clear' : 'Reset to default'}
            </Button>
            <Button size="sm" disabled={!dirty || saving} onClick={async () => {
              setSaving(true)
              try { const f = await agentApi.saveFile(kind, text); setFile(f); setText(f.text); toast({ title: `${title} saved` }) } catch (e) { onError('Could not save')(e) } finally { setSaving(false) }
            }}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
