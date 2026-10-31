import {useState} from 'react'
import {Button} from '@/components/ui/button'
interface View {globalEnabled:boolean;admissionReady:boolean;pageLabel:string;budget:{used:number;pending:boolean;exhausted:boolean;nextEligibleAt:number};record:{fence:{retained?:{candidateId:string;bindingId:string;bindingActionId:string};anchorSha256:string;context:{capturedAt:number;replySha256:string}};revision:number;enabled:boolean;paused:boolean;cancelled:boolean;actions:{id:string;phase:string;after:{observedAt:number}|null}[]}|null}
export default function ManagedConversationRestoration({pageId}:{pageId:string}){
 const [view,setView]=useState<View|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
 async function act(action:string){setBusy(true);setConfirmed(false);setError('');try{const response=await fetch('/api/managed-pilot/pages/'+encodeURIComponent(pageId)+'/conversation-restoration',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,fence:view?.record?.fence??null,expectedRevision:view?.record?.revision??0,...(action==='reserve'?{actionId:crypto.randomUUID()}:{})})});if(!response.ok)throw new Error();setView(await response.json())}catch{setView(null);setError('Restoration receipt is unconfirmed. Inspect its original grant before another action.')}finally{setBusy(false)}}
 const r=view?.record,a=r?.actions.at(-1),enableBlocked=busy||!confirmed||!view?.globalEnabled||!view.admissionReady||!r||r.cancelled,blocked=enableBlocked||view?.budget.pending||view?.budget.exhausted||(view?.budget.nextEligibleAt??0)>Date.now()||a?.phase==='verified'
 return <section aria-label="Original conversation restoration" className="space-y-3 rounded border p-3 text-sm min-w-0">
  <Button variant="outline" disabled={busy} onClick={()=>void act('inspect')}>Inspect original conversation restoration</Button>
  <p>Reopen the privately verified original conversation from an empty home page on its approved view. The original prompt and completed reply must match afterward.</p>
  {error&&<p role="alert">{error}</p>}
  {view&&<><p>{view.pageLabel}. Shared recovery attempts: {view.budget.used}/3.</p>
   {!view.globalEnabled&&<p>Original conversation restoration is off.</p>}
   {!r&&<p>On the original phone, inspect its restoration grant. A lost live view, missing anchor or changed conversation stays held.</p>}
   {r&&<><p className="break-all">Private anchor SHA-256: {r.fence.anchorSha256}</p>
    {r.fence.retained&&<p className="break-all">Retained-view restoration. Candidate: {r.fence.retained.candidateId}. Binding: {r.fence.retained.bindingId}. This is a distinct associated view.</p>}
    <p>Original context captured: {new Date(r.fence.context.capturedAt).toISOString()}.</p>
    {a&&<p>Original restoration action: {a.phase}. {['unknown','executing'].includes(a.phase)?(r.fence.retained?'Inspect the same retained view and receipt; do not repeat the navigation.':'Inspect the same original view and receipt; do not repeat the navigation.'):''}</p>}
    {a?.after&&<p>Actual conversation verification: {new Date(a.after.observedAt).toISOString()}.</p>}
    <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy||!view.globalEnabled||r.cancelled} onChange={e=>setConfirmed(e.target.checked)}/>I approve one navigation to this exact original conversation on the original phone{r.fence.retained?' using this exact retained association':''}. No prompt resend or account switch is allowed.</label>
    <div className="flex flex-wrap gap-2">
     <Button disabled={!!enableBlocked} onClick={()=>void act('enable')}>Enable conversation restoration</Button>
     <Button disabled={!!blocked||!r.enabled||r.paused} onClick={()=>void act('reserve')}>Grant one conversation restoration</Button>
     <Button variant="outline" disabled={busy||r.paused||r.cancelled} onClick={()=>void act('pause')}>Pause conversation restoration</Button>
     <Button variant="outline" disabled={busy||r.cancelled} onClick={()=>void act('cancel')}>Cancel conversation restoration</Button>
    </div>
    <p>Use the saved grant on the same live view. Restoring context does not mark task success, restore a lost process, approve correction or permit fallback.</p>
   </>}
  </>}
 </section>
}
