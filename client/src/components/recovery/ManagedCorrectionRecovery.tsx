import {useState} from 'react'
import {Button} from '@/components/ui/button'
interface View {globalEnabled:boolean;admissionReady:boolean;pageLabel:string;budget:{used:number;pending:boolean;exhausted:boolean;nextEligibleAt:number};record:{fence:{preview:{proposalSha256:string;lockedCandidates:number;changedFields:number};context:{capturedAt:number}};revision:number;enabled:boolean;paused:boolean;cancelled:boolean;actions:{id:string;phase:string;checkpointRef:string|null}[]}|null}
export default function ManagedCorrectionRecovery({pageId}:{pageId:string}){
 const [view,setView]=useState<View|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
 async function act(action:string){setBusy(true);setConfirmed(false);setError('');try{const response=await fetch('/api/managed-pilot/pages/'+encodeURIComponent(pageId)+'/correction-recovery',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,fence:view?.record?.fence??null,expectedRevision:view?.record?.revision??0,...(action==='reserve'?{actionId:crypto.randomUUID()}:{})})});if(!response.ok)throw new Error();setView(await response.json())}catch{setView(null);setError('Correction receipt is unconfirmed. Inspect its original grant before another action.')}finally{setBusy(false)}}
 const r=view?.record,a=r?.actions.at(-1),enableBlocked=busy||!confirmed||!view?.globalEnabled||!view.admissionReady||!r||r.cancelled,blocked=enableBlocked||view?.budget.pending||view?.budget.exhausted||(view?.budget.nextEligibleAt??0)>Date.now()||a?.phase==='verified'
 return <section aria-label="Validated correction" className="space-y-3 rounded border p-3 text-sm min-w-0">
  <Button variant="outline" disabled={busy} onClick={()=>void act('inspect')}>Inspect validated correction</Button>
  <p>Approve the exact private draft validated on the original phone. Saving keeps valid candidates locked. Upload, destination validation and human review remain separate.</p>
  {error&&<p role="alert">{error}</p>}
  {view&&<><p>{view.pageLabel}. Shared recovery attempts: {view.budget.used}/3.</p>
   {!view.globalEnabled&&<p>Correction recovery is off.</p>}
   {!r&&<p>Validate a private draft on the original phone, then offer it for Studio approval.</p>}
   {r&&<><p className="break-all">Proposal SHA-256: {r.fence.preview.proposalSha256}</p>
    <p>{r.fence.preview.lockedCandidates} valid candidates locked; {r.fence.preview.changedFields} failed fields changed. Original context: {new Date(r.fence.context.capturedAt).toISOString()}.</p>
    {a&&<p>Original correction action: {a.phase}. {['unknown','executing'].includes(a.phase)?'Reconcile the original saved receipt; do not create another correction.':''}</p>}
    <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy||!view.globalEnabled||r.cancelled} onChange={e=>setConfirmed(e.target.checked)}/>I reviewed this draft on the original phone and approve only this exact proposal hash.</label>
    <div className="flex flex-wrap gap-2">
     <Button disabled={!!enableBlocked} onClick={()=>void act('enable')}>Enable correction</Button>
     <Button disabled={!!blocked||!r.enabled||r.paused} onClick={()=>void act('reserve')}>Grant one correction save</Button>
     <Button variant="outline" disabled={busy||r.paused||r.cancelled} onClick={()=>void act('pause')}>Pause correction</Button>
     <Button variant="outline" disabled={busy||r.cancelled} onClick={()=>void act('cancel')}>Cancel correction</Button>
    </div>
    <p>Use Save approved correction on the same phone. A lost acknowledgment replays the original saved checkpoint. No provider request or conversation restoration is granted.</p>
   </>}
  </>}
 </section>
}
