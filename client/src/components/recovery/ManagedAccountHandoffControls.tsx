import {useEffect,useRef,useState} from 'react'
import {Button} from '@/components/ui/button'
const confirmation='Approve transfer of this exact retained candidate to the confirmed independent account and one managed execution on its original inspected target view.'
export default function ManagedAccountHandoffControls({pageId,unit,candidateId,onBudget}:{pageId:string;unit:object;candidateId:string;onBudget:(budget:any)=>void}){
 const [status,setStatus]=useState<any>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),mounted=useRef(true)
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 async function perform(action:'status'|'approve'|'cancel',id?:string){
  if(busy||action==='approve'&&(!confirmed||!status?.globalEnabled||status.budget.pending||status.budget.exhausted||status.budget.nextEligibleAt>Date.now()))return
  setBusy(true);setConfirmed(false)
  try{
   const body=action==='approve'?{action,unit,approval:{actionId:crypto.randomUUID(),candidateId,revision:status.revision,confirmation}}:action==='cancel'?{action,unit,actionId:id,revision:status.revision}:{action,unit}
   const response=await fetch('/api/managed-pilot/pages/'+encodeURIComponent(pageId)+'/account-handoff',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
   if(!response.ok)throw new Error();const value=await response.json()
   if(mounted.current){setStatus(value);onBudget(value.budget);if(action!=='status')setMessage('Original handoff action recorded. Inspect its status before another approval.') }
  }catch{if(mounted.current){setStatus(null);setMessage('Handoff is held or unconfirmed. Inspect its original action and current owner; do not issue another approval.')}}finally{if(mounted.current)setBusy(false)}
 }
 return <div role="region" aria-label="Separate account handoff approval" className="space-y-2 border-t pt-2">
  <Button variant="outline" disabled={busy} onClick={()=>void perform('status')}>Inspect handoff for retained candidate</Button>
  {message&&<p>{message}</p>}
  {status&&<><p>Account handoff {status.globalEnabled?'available for separate approval':'is off'}. {status.budget.used}/3 original recovery actions charged.</p>
   {status.actions.map((a:any)=><div key={a.id}><p className="break-all">Handoff {a.id}: {a.phase}</p>{['reserved','prepared'].includes(a.phase)&&<Button variant="outline" disabled={busy} onClick={()=>void perform('cancel',a.id)}>Cancel unused handoff</Button>}</div>)}
   <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy||!status.globalEnabled||status.budget.pending||status.budget.exhausted||status.budget.nextEligibleAt>Date.now()} onChange={e=>setConfirmed(e.target.checked)}/><span>{confirmation}</span></label>
   <Button variant="outline" disabled={busy||!confirmed||!status.globalEnabled||status.budget.pending||status.budget.exhausted||status.budget.nextEligibleAt>Date.now()} onClick={()=>void perform('approve')}>Approve exact account handoff</Button>
  </>}
  <p>Approval charges one original recovery action. The target must explicitly consume it with its original view and fresh account evidence.</p>
 </div>
}
