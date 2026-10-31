import ManagedFamilyDispositionControls from './ManagedFamilyDispositionControls'
import {useState} from 'react'
import {Button} from '@/components/ui/button'
interface Item {diagnosis:{unit:{workspaceId:string;taskId:string;attemptId:string;generation:number;fingerprint:string};revision:number;enabled:boolean;paused:boolean;cancelled:boolean;evidence:{observedAt:number;failure:string};budget:{used:number;pending:boolean};decision:{state:string;reason:string}};stop:{intent:{sequence:number;mode:string};receipt:{receivedAt:number}|null}|null}
const modeLabel:Record<string,string>={pause:'recovery pause',disable:'recovery disabled',cancel:'recovery cancellation',reinspect:'preparation for fresh inspection'}
/** Local durable controls remain available without a current page or relay connection. */
export default function RetainedRecoveryControls(){
 const [items,setItems]=useState<Item[]|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
 async function act(action?:string,item?:Item){setBusy(true);setError('');try{const r=await fetch('/api/managed-pilot/recovery-retained',{cache:'no-store',...(action&&item?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,unit:item.diagnosis.unit,expectedRevision:item.diagnosis.revision})}:{})});if(!r.ok)throw new Error();setItems((await r.json()).items)}catch{setError('Control or relay confirmation is unconfirmed. Refresh retained controls to see the saved local state.')}finally{setBusy(false)}}
 return <section aria-label="Retained recovery controls" className="space-y-3 rounded border p-3 text-sm">
  <h2 className="font-semibold">Retained recovery controls</h2>
  <p>Local holds do not require the original page or relay. A phone action already admitted may continue until the relay receives the stop; original claims and unknown outcomes remain retained.</p>
  <Button variant="outline" disabled={busy} onClick={()=>void act()}>Refresh retained recovery controls</Button>
  {error&&<p role="alert">{error}</p>}
  {items?.length===0&&<p>No retained recovery diagnosis is available.</p>}
  {items?.map(item=>{const d=item.diagnosis,s=item.stop,held=!!s&&(!s.receipt||s.intent.mode!=='reinspect');return <article key={JSON.stringify(d.unit)} className="space-y-2 rounded border p-3">
   <p className="break-all">Attempt {d.unit.attemptId} · generation {d.unit.generation} · workspace {d.unit.workspaceId}</p>
   <p>{d.evidence.failure.replace(/_/g,' ')} · source {new Date(d.evidence.observedAt).toISOString()} · last saved shared attempts {d.budget.used}/3.</p>
   <p>{held?'Local recovery hold saved.':d.cancelled?'Recovery cancelled.':'Fresh adapter inspection is required before admission.'}</p>
   {s&&<p>{s.receipt?'Relay confirmed '+modeLabel[s.intent.mode]+' at '+new Date(s.receipt.receivedAt).toISOString()+'.':'Relay confirmation pending. Remote work has not been confirmed stopped.'}</p>}
   {d.budget.pending&&<p>The last saved diagnosis has an unresolved action. These controls do not release or replace it.</p>}
   <div className="flex flex-wrap gap-2">
    <Button variant="outline" disabled={busy||d.cancelled} onClick={()=>void act('pause',item)}>Save local recovery pause</Button>
    <Button variant="outline" disabled={busy||d.cancelled} onClick={()=>void act('disable',item)}>Disable local recovery</Button>
    <Button variant="outline" disabled={busy||d.cancelled} onClick={()=>void act('cancel',item)}>Cancel recovery for this unit</Button>
    <Button variant="outline" disabled={busy||!s||!!s.receipt} onClick={()=>void act('sync',item)}>Send saved intent to relay</Button>
    <Button variant="outline" disabled={busy||d.cancelled||!s?.receipt||s.intent.mode==='reinspect'} onClick={()=>void act('reinspect',item)}>Prepare fresh inspection</Button>
   </div>
   {s?.intent.mode==='reinspect'&&<p>Preparation never resumes an action. Relay confirmation, fresh evidence and explicit playbook admission are still required.</p>}
   <ManagedFamilyDispositionControls key={JSON.stringify(d.unit)} unit={d.unit}/>
   <details><summary>Original unit</summary><p className="break-all">{d.unit.taskId}<br/>{d.unit.fingerprint}</p></details>
  </article>})}
 </section>
}
