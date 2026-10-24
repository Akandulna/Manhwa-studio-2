import {useEffect,useSyncExternalStore} from 'react'
import {Button} from '@/components/ui/button'
import {Card,CardContent,CardHeader,CardTitle} from '@/components/ui/card'
import {SavedCropRecoverySession,targetKey,type RecoveryPanelAction,type RecoveryTarget} from './savedCropRecoverySession'

export interface SavedCropRecoveryPanelProps { session: SavedCropRecoverySession; targets: RecoveryTarget[] }
const phaseLabel = { reserved: 'Reserved — inspect the original action', executing: 'Action started — check its saved outcome',
  safe_failure: 'Stopped before local writes', unknown: 'Outcome uncertain — inspection required', verified: 'Local copy verified' }
const date = (value: number) => new Date(value).toLocaleString()

/** Standalone component only. No navigation integration, implicit inspection or built-in live transport. */
export default function SavedCropRecoveryPanel({session,targets}: SavedCropRecoveryPanelProps) {
  const state = useSyncExternalStore(session.subscribe,session.getSnapshot,session.getSnapshot)
  const {target,inspection,pending} = state, episode = inspection?.episode, last = episode ? episode.actions[episode.actions.length - 1] : undefined
  useEffect(() => {
    if (!inspection || !state.current) return
    const timer = setTimeout(() => session.expireInspection(),Math.max(0,inspection.observedAt + 120_000 - Date.now()))
    return () => clearTimeout(timer)
  },[session,inspection,state.current])
  const action = (kind: RecoveryPanelAction,label: string,variant: 'default' | 'outline' | 'destructive' = 'outline') => {
    const gate = session.gate(kind)
    return <Button type="button" variant={variant} disabled={!gate.allowed} title={gate.allowed ? undefined : gate.reason}
      onClick={() => void session.perform(kind)}>{pending === kind ? 'Working…' : label}</Button>
  }
  const runGate = session.gate('run')
  return <Card className="min-w-0 max-w-full"><CardHeader><CardTitle>Restore a saved crop result</CardTitle></CardHeader>
    <CardContent className="space-y-4 break-words [overflow-wrap:anywhere]">
      <p className="text-sm text-muted-foreground">Restore the verified cloud result to its selected local destination. Human crop review and cutting remain separate steps.</p>
      {!session.connected && <p className="text-sm">Recovery controls are not connected. Live recovery remains disabled.</p>}
      <label className="block text-sm">Saved result and destination
        <select className="mt-1 w-full min-w-0 rounded border bg-background p-2" value={target ? targetKey(target) : ''}
          disabled={!!pending && pending !== 'inspect'} onChange={event => session.select(targets.find(t => targetKey(t) === event.target.value) ?? null)}>
          <option value="">Select a saved result…</option>
          {targets.map(t => <option key={targetKey(t)} value={targetKey(t)}>{t.chapterLabel} / {t.pageLabel} → {t.destinationLabel}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">{action('inspect','Inspect saved result')}{action('reconcile','Check saved outcome')}</div>
      {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      <div role="status" aria-live="polite" className="space-y-1 rounded border p-3 text-sm">
        {!inspection ? <p>No inspection loaded. Recovery stays unavailable until this exact scope is checked.</p> : <>
          <p>{inspection.globalEnabled ? 'Recovery is available for this inspected scope.' : 'Recovery is off. Pending outcomes can still be checked.'}</p>
          <p>{state.current ? 'Observed' : 'Last known'} {date(inspection.observedAt)}</p>
          <p>Source: {inspection.sourceMatches ? 'matches current input' : 'changed or unverified'} · Cloud result: {inspection.canonical ? 'verified' : 'unverified'}</p>
          <p>Local copy: {({ missing: 'missing', verified: 'verified', conflict: 'conflicting files — review required', unknown: 'unknown' })[inspection.localState]}</p>
          {episode && <p>{episode.cancelled ? 'Cancelled; history retained.' : episode.paused ? 'Paused.' : episode.enabled ? 'Enabled for this scope.' : 'Disabled for this scope.'} Attempts used: {inspection?.budget?.used??episode.actions.length}/3.</p>}
          {last && <p>{phaseLabel[last.phase]}</p>}
          {episode && episode.nextEligibleAt > Date.now() && <p>Next eligible time: {date(episode.nextEligibleAt)}. Inspect again before restoring.</p>}
        </>}
      </div>
      {target && <div className="space-y-2 rounded border p-3 text-sm">
        <p><strong>{target.chapterLabel} / {target.pageLabel}</strong><br/>Destination: {target.destinationLabel}</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={state.confirmed} disabled={!!pending}
          onChange={event => session.confirm(event.target.checked)}/><span>I confirm this saved result and local destination.</span></label>
        <div className="flex flex-wrap gap-2">{action('enable',episode?.paused ? 'Resume this recovery' : 'Enable this recovery')}{action('run','Restore local copy','default')}</div>
        {!runGate.allowed && <p className="text-muted-foreground">{runGate.reason}</p>}
      </div>}
      <div className="flex flex-wrap gap-2">{action('pause','Pause recovery')}{action('cancel','Cancel recovery','destructive')}</div>
      {target && <details className="text-xs"><summary>Saved result identity</summary><dl className="mt-2 space-y-1">
        <dt>Task</dt><dd>{target.taskId}</dd><dt>Attempt / generation</dt><dd>{target.attemptId} / {target.generation}</dd>
        <dt>Artifact</dt><dd>{target.artifactId}</dd><dt>Input fingerprint</dt><dd>{target.fingerprint}</dd>
        <dt>Artifact checksum</dt><dd>{target.sha256}</dd><dt>Destination reference</dt><dd>{target.destinationId}</dd>
      </dl></details>}
      {!!episode?.actions.length && <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="text-left font-medium">Recovery history</caption>
        <thead><tr><th className="whitespace-nowrap p-2">Attempt</th><th className="p-2">State</th><th className="p-2">Recorded</th></tr></thead><tbody>
          {episode.actions.map((a,index) => <tr key={a.id} className="border-t"><td className="p-2">{index+1}</td><td className="p-2">{phaseLabel[a.phase]}</td><td className="p-2">{date(a.at)}</td></tr>)}
        </tbody></table></div>}
    </CardContent>
  </Card>
}
