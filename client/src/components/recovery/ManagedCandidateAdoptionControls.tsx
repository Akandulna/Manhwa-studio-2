import ManagedAccountHandoffControls from './ManagedAccountHandoffControls'
import {useEffect,useRef,useState} from 'react'
import {Button} from '@/components/ui/button'
export interface CandidateAdoptionView {target:{deviceId:string;profileId:string};checkedAt:number;globalEnabled:boolean;revision:number;actions:{id:string;phase:string;context:{id:string;packageId:string};expiresAt:number}[];budget:{used:number;pending:boolean;exhausted:boolean;nextEligibleAt:number}}
const confirmation='Approve retention of this exact candidate only; no ownership transfer, browser adoption, upload or prompt is authorized.'
export default function ManagedCandidateAdoptionControls({pageId,unit,status,contextId,contextDeadline,contextVerified,onResult,onBusy,onError}:{pageId:string;unit:object;status:CandidateAdoptionView;contextId:string|null;contextDeadline:number|null;contextVerified:boolean;onResult:(s:CandidateAdoptionView)=>void;onBusy:(b:boolean)=>void;onError:(s:string)=>void}){
 const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),mounted=useRef(true)
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 const canApprove=status.globalEnabled&&contextVerified&&!!contextId&&!status.budget.pending&&!status.budget.exhausted&&status.budget.nextEligibleAt<=Date.now()&&!!contextDeadline&&contextDeadline>Date.now()
 async function perform(action:'approve'|'cancel',actionId?:string){
  if(action==='approve'&&(!confirmed||!canApprove))return
  setBusy(true);onBusy(true);setConfirmed(false)
  try{
   const body=action==='approve'?{action,unit,target:status.target,actionId:crypto.randomUUID(),contextId,revision:status.revision,confirmation}:{action,unit,target:status.target,actionId,revision:status.revision}
   const response=await fetch('/api/managed-pilot/pages/'+encodeURIComponent(pageId)+'/candidate-adoption',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
   if(!response.ok)throw new Error();const value=await response.json() as CandidateAdoptionView
   if(mounted.current)onResult(value)
  }catch{if(mounted.current)onError('Candidate retention approval is unconfirmed. Inspect its original charged action; no ownership or provider action was authorized.')}
  finally{if(mounted.current)setBusy(false);onBusy(false)}
 }
 return <div className="space-y-2 border-t pt-3" aria-label="Candidate retention approval">
  <p>Candidate retention: {status.budget.used}/3 shared recovery actions; {status.budget.pending?'an original action needs reconciliation':'no pending action'}.</p>
  {!status.globalEnabled&&<p>Local candidate retention is off. Original receipts remain available for reconciliation.</p>}
  {status.actions.map(a=><div key={a.id} className="space-y-1"><p className="break-all">Candidate {a.context.packageId}. Retention action {a.id}: {a.phase.replace(/_/g,' ')}.</p>{a.phase==='verified'&&<ManagedAccountHandoffControls key={pageId+'/'+a.id} pageId={pageId} unit={unit} candidateId={a.id} onBudget={budget=>onResult({...status,budget})}/>}
{a.phase==='reserved'&&<Button variant="outline" disabled={busy} onClick={()=>void perform('cancel',a.id)}>Cancel unused candidate approval</Button>}</div>)}
  {contextVerified&&contextId&&<>
   <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy||!canApprove} onChange={e=>setConfirmed(e.target.checked)}/><span>{confirmation}</span></label>
   <Button variant="outline" disabled={busy||!confirmed||!canApprove} onClick={()=>void perform('approve')}>Approve exact candidate retention</Button>
  </>}
  <p>One action is charged on approval. The target must consume it once on its original inspected view; other recovery remains held until its outcome is reconciled.</p>
 </div>
}
