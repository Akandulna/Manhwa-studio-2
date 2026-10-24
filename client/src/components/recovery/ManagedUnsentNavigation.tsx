import {useState} from 'react'
import {Button} from '@/components/ui/button'
interface View {globalEnabled:boolean;admissionReady:boolean;pageLabel:string;observedAt:number;budget:{used:number;pending:boolean;exhausted:boolean;nextEligibleAt:number};record:{fence:unknown;revision:number;enabled:boolean;paused:boolean;cancelled:boolean;offer:{observedAt:number};actions:{id:string;phase:string;effect:string|null;after:{observedAt:number}|null}[]}|null}
export default function ManagedUnsentNavigation({pageId}:{pageId:string}){
 const [view,setView]=useState<View|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
 async function act(action:string){setBusy(true);setConfirmed(false);setError('');try{const r=await fetch('/api/managed-pilot/pages/'+encodeURIComponent(pageId)+'/navigation-recovery',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,fence:view?.record?.fence??null,expectedRevision:view?.record?.revision??0,...(action==='reserve'?{actionId:crypto.randomUUID()}:{})})});if(!r.ok)throw new Error();setView(await r.json())}catch{setView(null);setError('Reload grant/outcome is unconfirmed. Inspect the original receipt before another action.')}finally{setBusy(false)}}
 const r=view?.record,a=r?.actions.at(-1),blocked=busy||!confirmed||!view?.globalEnabled||!view.admissionReady||!r||r.cancelled||view.budget.pending||view.budget.exhausted||view.budget.nextEligibleAt>Date.now()||Date.now()-r.offer.observedAt>=120000||a?.phase==='verified'
 return <section aria-label="Original page navigation recovery" className="space-y-3 rounded border p-3 text-sm">
  <Button variant="outline" disabled={busy} onClick={()=>void act('inspect')}>Inspect original page reload</Button>
  <p>Reloads only the same untouched, empty ChatGPT home view after incomplete navigation. It cannot open a chat, sign in, upload or send a prompt.</p>
  {error&&<p role="alert">{error}</p>}
  {view&&<><p>{view.pageLabel}. Shared attempts: {view.budget.used}/3.</p>
   {!view.globalEnabled&&<p>Original-page reload recovery is off.</p>}
   {!r&&<p>On the original phone, inspect its original-page reload grant. An already-ready page needs no reload or budget.</p>}
   {r&&<>
    <p>Original phone offer: {new Date(r.offer.observedAt).toISOString()}. {view.admissionReady?'Original account, quota, lease and ownership checks passed.':'Fresh original-view/account/ownership evidence is required.'}</p>
    {a&&<p>Original action: {a.phase}. {a.effect==='possible'?'A reload may have happened; never repeat it.':''}</p>}
    {a?.after&&<p>Verified page source time: {new Date(a.after.observedAt).toISOString()}. Normal work requires a separate explicit action.</p>}
    <label className="flex items-start gap-2"><input type="checkbox" disabled={busy||!view.globalEnabled||r.cancelled} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I confirm one reload of this original empty home view. No provider submission is permitted.</label>
    <div className="flex flex-wrap gap-2">
     <Button disabled={!!blocked} onClick={()=>void act('enable')}>Enable original-page reload</Button>
     <Button disabled={!!blocked||!r.enabled||r.paused} onClick={()=>void act('reserve')}>Grant one original-page reload</Button>
     <Button variant="outline" disabled={busy||r.cancelled||r.paused} onClick={()=>void act('pause')}>Pause page reload recovery</Button>
     <Button variant="outline" disabled={busy||r.cancelled} onClick={()=>void act('cancel')}>Cancel page reload recovery</Button>
    </div>
    <p>Execute the saved grant on the same phone and original live view. Interrupted or uncertain outcomes need inspection/reconciliation; no replacement view is adopted.</p>
   </>}
  </>}
 </section>
}
