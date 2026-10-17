import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { NarrationLanguage } from '@/lib/narrationLanguage'

interface Session {
  task: { id: string; stage: string; label: string; prompt: string; fingerprint: string } | null
  completed: number; warnings: string[]; json: string | null; revision: string; error: string | null
  counts: { beats: number; crops: number; visualGroups: number }
  rejection?: { reply: string; error: string; repairPrompt: string } | null
}

const STAGE_LABELS: Record<string, string> = {
  index: 'Index visuals', route: 'Match narration', select: 'Choose images', review: 'Review selections', repair: 'Correct flagged matches'
}

export function StagedTimelineDialog({ chapter, language, close, onUse }: {
  chapter: { id: string; number: number }; language: NarrationLanguage; close: () => void; onUse: (json: string) => void
}) {
  const [session, setSession] = useState<Session | null>(null)
  const [reply, setReply] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false)
  const [repairPrompt, setRepairPrompt] = useState('')
  const endpoint = `/api/video2/chapters/${chapter.id}/staged-timeline?lang=${language}`
  async function request(body?: unknown) {
    setBusy(true); setError(''); setCopied(false)
    try {
      const response = await fetch(endpoint, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const value = await response.json()
      if (!response.ok) { setRepairPrompt(value.repairPrompt ?? ''); throw new Error(value.error ?? 'Could not load batch') }
      setSession(value); setReply(value.rejection?.reply ?? ''); setError(value.rejection?.error ?? ''); setRepairPrompt(value.rejection?.repairPrompt ?? '')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  useEffect(() => { void request() }, [endpoint])
  const task = session?.task
  async function useTimeline() {
    setBusy(true); setError('')
    try {
      const response = await fetch(endpoint)
      const latest = await response.json() as Session
      if (!response.ok) throw new Error(latest.error ?? 'Could not recheck chapter inputs')
      if (!latest.json || latest.json !== session?.json) {
        setSession(latest); throw new Error('Chapter inputs or checkpoints changed. Continue from the current batch.')
      }
      onUse(latest.json); close()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open) close() }}>
    <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Chapter {chapter.number} · Small timeline batches</DialogTitle>
        <DialogDescription>Copy each prompt into a fresh AI chat, paste its JSON response, then validate and continue. Progress is saved on this computer. These stages include their own instructions; Settings’ prompt applies to one-shot. Sleeper-Cell can automate the batches after sending a staged package.</DialogDescription>
      </DialogHeader>
      {session && <p className="text-sm text-muted-foreground">{session.counts.beats} beats · {session.counts.crops} crops · {session.completed} batches accepted</p>}
      {(error || session?.error) && <p role="alert" className="text-sm text-destructive">{error || session?.error}</p>}
      {task && <>
        <p className="text-sm font-medium">Next: batch {session!.completed + 1} · {STAGE_LABELS[task.stage] ?? task.stage} · {(repairPrompt || task.prompt).length.toLocaleString()} / 6,000 characters</p>
        <p className="text-xs text-muted-foreground">{task.stage === 'route' ? 'Match every listed beat to visual groups. This batch is a step toward the final timeline JSON.' : 'Submit the response for this batch only; the full timeline is assembled after all stages pass.'}</p>
        <Textarea aria-label="Current batch prompt" readOnly value={repairPrompt || task.prompt} className="h-48 text-xs font-mono" />
        <Button variant="outline" disabled={busy} onClick={async () => {
          try { await navigator.clipboard.writeText(repairPrompt || task.prompt); setCopied(true) } catch { setError('Could not copy. Select the prompt above and copy it manually.') }
        }}>{copied ? 'Copied — open a fresh AI chat' : repairPrompt ? 'Copy correction prompt' : 'Copy batch prompt'}</Button>
        <Textarea aria-label="AI batch JSON response" placeholder="Paste this batch’s JSON response…" value={reply} onChange={e => setReply(e.target.value)} className="h-36 font-mono text-xs" />
        <Button disabled={busy || !reply.trim()} onClick={() => request({ taskId: task.id, fingerprint: task.fingerprint, reply })}>{busy ? 'Checking…' : 'Validate & continue'}</Button>
      </>}
      {session?.json && <>
        <p className="text-sm">All beats passed selection and semantic review. Original times and crop filenames have been restored.</p>
        {session.warnings.length > 0 && <details className="text-sm"><summary>{session.warnings.length} reading-order/repetition checks</summary><ul className="pl-5 list-disc">{session.warnings.map(w => <li key={w}>{w}</li>)}</ul></details>}
        <Button disabled={busy} onClick={useTimeline}>Use timeline JSON (replaces this chapter’s paste)</Button>
      </>}
      <div className="flex justify-between gap-2">
        <Button variant="ghost" onClick={close}>Close — resume later</Button>
        <Button variant="ghost" disabled={busy} onClick={() => request()}>Reload current batch</Button>
        {session && <Button variant="outline" disabled={busy || session.completed === 0} onClick={() => request({ reset: session.revision })}>Restart matching (keep visual index)</Button>}
      </div>
    </DialogContent>
  </Dialog>
}
