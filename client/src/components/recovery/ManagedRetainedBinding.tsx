import {useState} from 'react'
import {Button} from '@/components/ui/button'
interface Binding {candidateId:string;offeredAt:number;fence:{deviceId:string;profileId:string;anchorSha256:string;context:{capturedAt:number}};target:{bindingId:string;accountObservationAt:number};revision:number;enabled:boolean;paused:boolean;cancelled:boolean;actions:{id:string;phase:string;after:{observedAt:number}|null}[]}
interface View {pageLabel:string;globalEnabled:boolean;admissionReady:boolean;binding:Binding|null;budget:{used:number;pending:boolean;exhausted:boolean;nextEligibleAt:number}}
export default function ManagedRetainedBinding({pageId}:{pageId:string}){
 const [view,setView]=useState<View|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
 async function act(action:string){
  setBusy(true);setConfirmed(false);setError('')
  try{
   const response=await fetch('/api/managed-pilot/pages/'+encodeURIComponent(pageId)+'/retained-binding',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,fence:view?.binding?.fence??null,candidateId:view?.binding?.candidateId??null,expectedRevision:view?.binding?.revision??0,...(action==='reserve'?{actionId:crypto.randomUUID()}:{})})})
   if(!response.ok)throw new Error()
   setView(await response.json())
  }catch{setView(null);setError('Binding approval is unconfirmed. Inspect the original offer and grant before continuing.')}finally{setBusy(false)}
 }
 const r=view?.binding,a=r?.actions[0]
 const unavailable=busy||!confirmed||!view?.globalEnabled||!r||r.cancelled||!!a
 const enableBlocked=unavailable||!view?.admissionReady&&!r?.paused
 const blocked=unavailable||!view?.admissionReady||view.budget.pending||view.budget.exhausted||view.budget.nextEligibleAt>Date.now()
 return <section aria-label="Retained conversation binding" className="space-y-3 rounded border p-3 text-sm min-w-0">
  <Button variant="outline" disabled={busy} onClick={()=>void act('inspect')}>Inspect retained conversation binding</Button>
  <p>Associate the privately verified original conversation with one replacement view on the original phone and profile.</p>
  {error&&<p role="alert">{error}</p>}
  {view&&<><p>{view.pageLabel}. Shared recovery attempts: {view.budget.used}/3.</p>
   {!view.globalEnabled&&<p>Retained conversation binding is off.</p>}
   {!r&&<p>Prepare a retained binding offer on the original phone after inspecting the conversation and checking target readiness.</p>}
   {r&&<>
    <p className="break-all">Phone: {r.fence.deviceId}. Profile: {r.fence.profileId}. Candidate: {r.candidateId}.</p>
    <p className="break-all">Original anchor SHA-256: {r.fence.anchorSha256}</p>
    <p>Original context captured: {new Date(r.fence.context.capturedAt).toISOString()}. Target account checked: {new Date(r.target.accountObservationAt).toISOString()}.</p>
    <p>Binding controls: {r.cancelled?'cancelled':r.paused?'paused':r.enabled?'enabled':'disabled'}.</p>
    {!view.admissionReady&&!a&&<p>The original offer is not ready for approval. Inspect current phone, account and task evidence.</p>}
    {a&&<p>Original binding action: {a.phase}. {['unknown','executing'].includes(a.phase)?'Reconcile its original receipt on the same still-live candidate. Do not repeat the association.':a.phase==='reserved'?'On the original phone, use its approved retained binding control.':'This one-use grant cannot be repeated.'}</p>}
    {a?.after&&<p>Association verified: {new Date(a.after.observedAt).toISOString()}. This historical receipt does not establish current execution readiness.</p>}
    <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy||!view.globalEnabled||!view.admissionReady&&!r.paused||r.cancelled||!!a} onChange={e=>setConfirmed(e.target.checked)}/>I approve one association with this exact retained conversation and replacement view. This uses one shared recovery attempt.</label>
    <div className="flex flex-wrap gap-2">
     <Button disabled={!!enableBlocked||r.enabled&&!r.paused} onClick={()=>void act('enable')}>Enable retained binding</Button>
     <Button disabled={!!blocked||!r.enabled||r.paused} onClick={()=>void act('reserve')}>Grant one retained binding</Button>
     <Button variant="outline" disabled={busy||r.paused||r.cancelled} onClick={()=>void act('pause')}>Pause retained binding</Button>
     <Button variant="outline" disabled={busy||!r.enabled||r.cancelled} onClick={()=>void act('disable')}>Disable retained binding</Button>
     <Button variant="outline" disabled={busy||r.cancelled} onClick={()=>void act('cancel')}>Cancel retained binding</Button>
    </div>
    <p>This approval permits only the context association. Provider submission, correction, task transfer and account/provider fallback require separate authority. A lost candidate stays held.</p>
   </>}
  </>}
 </section>
}
