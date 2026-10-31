import ManagedProductionDisposition from './ManagedProductionDisposition'
import {useEffect,useRef,useState} from 'react'
import {Button} from '@/components/ui/button'
import {productionApi,type ProductionJob} from '@/lib/api'
const confirmation='Approve transfer of this exact retained candidate to the confirmed independent account and one managed execution on its original inspected target view.'
interface Task {task:{id:string;generation:number;fingerprint:string;state:string};attempt:{id:string;activeCommandId:string;phase:string;submission:string;checkpointRef:string|null;accountSelection?:object|null}|null}
export default function ManagedProductionCandidateHandoff({seriesId,job,task,target,disabled,onResult}:{seriesId:string;job:ProductionJob;task:Task;target:{deviceId:string;profileId:string}|null;disabled:boolean;onResult:(job:ProductionJob)=>void}){
 const [candidateId,setCandidateId]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),mounted=useRef(true)
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 useEffect(()=>{setConfirmed(false);setCandidateId('')},[target?.deviceId,target?.profileId,job.id,job.revision,task.task.id])
 const pending=job.pendingHandoff,held=['failed','interrupted'].includes(job.status),ready=held&&!pending&&!!target&&!!task.attempt?.accountSelection&&task.task.state==='paused'&&task.attempt.phase==='stop_confirmed'&&task.attempt.submission==='unsent'&&task.attempt.checkpointRef===null
 async function perform(action:'approve'|'finish'){
  if(job.pendingRecoveryDisposition)return
  if(disabled||busy||!held||action==='approve'&&!pending&&(!ready||!confirmed||!(/^[A-Za-z0-9_-]{1,128}$/).test(candidateId)))return
  if(pending&&!pending.accountCandidateId)return
  const request=pending?{action,jobId:job.id,revision:job.revision??0,intentId:pending.eventId}:{action,jobId:job.id,revision:job.revision??0,taskId:task.task.id,attemptId:task.attempt!.id,generation:task.task.generation,fingerprint:task.task.fingerprint,stopCommandId:task.attempt!.activeCommandId,deviceId:target!.deviceId,profileId:target!.profileId,candidateId,confirmation}
  setBusy(true);setConfirmed(false)
  try{const value=await productionApi.accountHandoff(seriesId,request);if(mounted.current){onResult(value);setMessage(action==='approve'?'Original candidate approval recorded. On the target, retain its fresh handoff proof, then finish here within 15 seconds.':'Original successor claim recorded. Inspect the updated run before resuming; read its original receipt on the target.')}}
  catch{if(mounted.current)setMessage('Production candidate handoff is held or unconfirmed. Refresh the saved run and reconcile its original intent. A lost reply does not authorize another approval or target.')}
  finally{if(mounted.current)setBusy(false)}
 }
 return <section aria-label="Production retained candidate handoff" className="space-y-2 border-t pt-3">
  <p>Independent-account production handoff uses an acknowledged retained candidate, a fresh target proof and the current production coordinator.</p>
  {pending?.accountCandidateId?<>
   <p className="break-all">Original candidate {pending.accountCandidateId}; handoff {pending.eventId}. Target {pending.deviceId} / {pending.profileId}.</p>
   <Button variant="outline" disabled={disabled||busy||!held||!!job.pendingRecoveryDisposition} onClick={()=>void perform('approve')}>Reconcile original candidate approval</Button>
   <Button variant="outline" disabled={disabled||busy||!held||!!job.pendingRecoveryDisposition} onClick={()=>void perform('finish')}>Finish prepared candidate handoff</Button>
   <p>The target must first consume this exact approval on its original inspected view. Expired or changed proof stays held; refreshing does not renew it.</p>
  </>:!pending&&<>
   <label className="block">Acknowledged candidate retention action ID<input className="w-full rounded border px-3 py-2" value={candidateId} disabled={disabled||busy||!ready} onChange={e=>{setCandidateId(e.target.value.trim());setConfirmed(false)}}/></label>
   <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={disabled||busy||!ready||!candidateId} onChange={e=>setConfirmed(e.target.checked)}/><span>{confirmation}</span></label>
   <Button variant="outline" disabled={disabled||busy||!ready||!confirmed||!(/^[A-Za-z0-9_-]{1,128}$/).test(candidateId)} onClick={()=>void perform('approve')}>Approve retained-candidate production handoff</Button>
  </>}
  {message&&<p role="status">{message}</p>}
  <ManagedProductionDisposition key={job.id+'/'+job.revision} seriesId={seriesId} job={job} disabled={disabled||busy} onResult={onResult}/>
  <p>One original recovery action is charged on approval. This control keeps scheduling paused. Existing Stop managed production cancels the run and fences both claim IDs.</p>
 </section>
}
