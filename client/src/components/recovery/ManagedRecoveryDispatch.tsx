import {useState} from 'react'
import {Button} from '@/components/ui/button'
type Grant={kind:string;actionId:string;grantRevision:number;fenceSha256:string;deviceId:string;profileId:string}
type Ticket={id:string;kind:string;revision:number;phase:string;expiresAt:number;deviceId:string;profileId:string}
type View={globalEnabled:boolean;pageLabel:string;grants:Grant[];tickets:Ticket[]}
export default function ManagedRecoveryDispatch({pageId}:{pageId:string}){
 const [view,setView]=useState<View|null>(null),[selected,setSelected]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
 async function act(body:Record<string,unknown>){setBusy(true);setConfirmed(false);setError('');try{const r=await fetch('/api/managed-pilot/pages/'+encodeURIComponent(pageId)+'/recovery-dispatch',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error();setView(await r.json());setSelected('')}catch{setView(null);setError('Delivery receipt is unconfirmed. Inspect the original ticket before another action.')}finally{setBusy(false)}}
 const grant=view?.grants.find(g=>g.kind+':'+g.actionId===selected)
 return <section aria-label="Original phone recovery delivery" className="space-y-3 rounded border p-3 text-sm min-w-0">
  <Button variant="outline" disabled={busy} onClick={()=>void act({action:'inspect'})}>Inspect original phone delivery</Button>
  <p>Deliver one already approved recovery grant to its original phone and profile while foreground and idle. Enable delivery separately on that phone. Tickets expire within two minutes.</p>
  {error&&<p role="alert">{error}</p>}
  {view&&<><p>{view.pageLabel}. {view.globalEnabled?'Delivery gate is on.':'Delivery is off.'}</p>
   <label className="block">Existing grant<select aria-label="Existing recovery grant" className="block w-full min-w-0" disabled={busy||!view.globalEnabled} value={selected} onChange={e=>{setSelected(e.target.value);setConfirmed(false)}}><option value="">Choose an exact approved grant</option>{view.grants.map(g=><option key={g.kind+':'+g.actionId} value={g.kind+':'+g.actionId}>{g.kind} — {g.deviceId} / {g.profileId}</option>)}</select></label>
   {grant&&<p className="break-all">Grant {grant.actionId}, revision {grant.grantRevision}. Fence SHA-256: {grant.fenceSha256}.</p>}
   <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy||!grant||!view.globalEnabled} onChange={e=>setConfirmed(e.target.checked)}/>Deliver this exact existing grant once. Interrupted delivery requires inspection.</label>
   <Button disabled={busy||!confirmed||!grant||!view.globalEnabled} onClick={()=>grant&&void act({action:'queue',kind:grant.kind,actionId:grant.actionId,grantRevision:grant.grantRevision,fenceSha256:grant.fenceSha256})}>Queue original phone delivery</Button>
   {!view.grants.length&&<p>No eligible unstarted grants. Inspect the relevant recovery playbook.</p>}
   {view.tickets.map(t=><div key={t.id} className="rounded border p-2 break-words"><p>{t.kind}: {t.phase}. Phone {t.deviceId}, profile {t.profileId}. Expires {new Date(t.expiresAt).toISOString()}.</p><Button variant="outline" disabled={busy||!['queued','claimed'].includes(t.phase)} onClick={()=>void act({action:'cancel',ticketId:t.id,revision:t.revision})}>Cancel this delivery</Button></div>)}
   <p>Consumed records a one-use handoff. Actual repair and publication require their own verified playbook receipt. Delivery creates no recovery attempt and never repeats an executor after interruption.</p>
  </>}
 </section>
}
