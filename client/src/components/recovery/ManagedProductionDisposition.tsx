import {useEffect,useRef,useState} from 'react'
import {Button} from '@/components/ui/button'
import {productionApi,type ProductionJob} from '@/lib/api'
const confirmation='Close only this unused recovery approval; preserve its charge and evidence. Do not resume or resend work.'
export default function ManagedProductionDisposition({seriesId,job,disabled,onResult}:{seriesId:string;job:ProductionJob;disabled:boolean;onResult:(job:ProductionJob)=>void}){
 const [snapshot,setSnapshot]=useState<any>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),mounted=useRef(true)
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 const pending=job.pendingHandoff,action=snapshot?.actions.find((a:any)=>a.reference.actionId===pending?.eventId),closable=!!snapshot&&(!action||['reserved','prepared','safe_failure'].includes(action.phase))
 async function perform(kind:'inspect'|'dispose'|'reconcile'){
  if(busy||disabled||kind==='dispose'&&(!confirmed||!closable))return
  setBusy(true);setConfirmed(false)
  try{
   const request={action:kind,jobId:job.id,revision:job.revision??0,...(kind==='dispose'?{inspectedAt:snapshot.checkedAt,inspectionToken:snapshot.inspectionToken,confirmation}:{})}
   const result=await productionApi.recoveryDisposition(seriesId,request)
   if(mounted.current){if(kind==='inspect'){setSnapshot(result.snapshot);setMessage('')}else {setSnapshot(null);onResult(result.job)}}
  }catch{if(mounted.current){setSnapshot(null);setMessage('Disposition is held or unconfirmed. Refresh the production run, then reconcile its original saved decision. Committed or unknown effects remain held.')}}finally{if(mounted.current)setBusy(false)}
 }
 if(!pending?.accountCandidateId)return null
 return <section aria-label="Unused production handoff disposition" className="space-y-2 border-t pt-3">
  <p>Expired or cancelled unused handoff? Retain its charge and evidence, block the unused successor claim, then clear only this original pending intent. The run stays stopped.</p>
  {job.pendingRecoveryDisposition?<Button variant="outline" disabled={disabled||busy} onClick={()=>void perform('reconcile')}>Reconcile original production disposition</Button>:<>
   <Button variant="outline" disabled={disabled||busy} onClick={()=>void perform('inspect')}>Inspect unused production handoff</Button>
   {snapshot&&<><p>{snapshot.budget.used}/3 original recovery actions charged. Original handoff: {action?.phase??'no issued approval recorded'}.</p>
    {!closable&&<p>This outcome cannot be closed as unused. Reconcile its original committed or uncertain effect.</p>}
    <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy||!closable} onChange={e=>setConfirmed(e.target.checked)}/><span>{confirmation}</span></label>
    <Button variant="outline" disabled={disabled||busy||!closable||!confirmed} onClick={()=>void perform('dispose')}>Dispose exact unused production handoff</Button>
   </>}
  </>}
  {message&&<p role="status">{message}</p>}
 </section>
}
