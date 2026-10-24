import type {ProductionJob} from './productionAutomationModel.js'
import type {PilotAuthority} from './managedCropPilot.js'
import type {ManagedProductionCoordinator} from './managedProductionCoordinator.js'
import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {RECOVERY_DISPOSITION_SCHEMA,CLOSE_UNUSED_CONFIRMATION,parseDispositionIntent,parseDispositionReceipt,parseDispositionSnapshot,type DispositionIntent,type DispositionReceipt} from './recoveryDispositionProtocol.js'
import {randomUUID} from 'node:crypto'
export interface ProductionDispositionHistory {handoff:NonNullable<ProductionJob['pendingHandoff']>;receipt:DispositionReceipt}
function match(job:ProductionJob,i:DispositionIntent){
 const p=job.pendingHandoff
 if(!p?.accountCandidateId||i.mode!=='close_unused'||i.reference?.ledger!=='managed_account_handoff_episodes'||i.reference.actionId!==p.eventId||i.unit.taskId!==p.taskId||i.unit.attemptId!==p.attemptId||i.unit.generation!==p.generation||i.unit.fingerprint!==p.fingerprint||canonicalJson(i.reference.unit)!==canonicalJson(i.unit)||i.production?.jobId!==job.id||i.production.claimEventId!==p.claimEventId||i.production.newClaimEventId!==p.newClaimEventId||i.production.candidateId!==p.accountCandidateId)throw new TaskConflict('Exact original pending production disposition required')
}
export function prepareDispositionJob(job:ProductionJob,raw:unknown):ProductionJob {
 const intent=parseDispositionIntent(raw);match(job,intent)
 if(!job.config.managedCrop||!['failed','interrupted','cancelled'].includes(job.status)||job.pendingRecoveryDisposition||(job.recoveryDispositionHistory?.length??0)>=16)throw new TaskConflict('Retain the exact stopped job and bounded disposition history')
 return {...structuredClone(job),revision:(job.revision??0)+1,pendingRecoveryDisposition:intent,message:'Unused handoff disposition intent retained. Reconcile this original decision before choosing another target.'}
}
export function disposedProductionJob(job:ProductionJob,raw:unknown):ProductionJob {
 const receipt=parseDispositionReceipt(raw),intent=job.pendingRecoveryDisposition
 if(!intent||canonicalJson(receipt.intent)!==canonicalJson(intent))throw new TaskConflict('Original persisted disposition receipt required');match(job,intent)
 if(receipt.state==='applied'&&(receipt.closed===null||receipt.successorClaimBlocked!==job.pendingHandoff!.newClaimEventId))throw new TaskConflict('Unused successor claim must be blocked before clearing the pending handoff')
 return {...structuredClone(job),revision:(job.revision??0)+1,pendingRecoveryDisposition:undefined,...(receipt.state==='applied'?{pendingHandoff:undefined}:{}),recoveryDispositionHistory:[...(job.recoveryDispositionHistory??[]),{handoff:structuredClone(job.pendingHandoff!),receipt}],message:receipt.state==='applied'?'Unused handoff closed. Original claim, stopped run, recovery charges and evidence retained. Fresh inspection is required before any new action.':'Original disposition expired without applying. Pending handoff and charges remain; inspect afresh before another decision.'}
}
const equal=(a:unknown,b:unknown)=>JSON.stringify(JSON.parse(JSON.stringify(a)))===JSON.stringify(JSON.parse(JSON.stringify(b)))
export function validDispositionPreparation(old:ProductionJob,next:ProductionJob){try{return !!next.pendingRecoveryDisposition&&equal(prepareDispositionJob(old,next.pendingRecoveryDisposition),next)}catch{return false}}
export function validDispositionCompletion(old:ProductionJob,next:ProductionJob){try{const receipt=next.recoveryDispositionHistory?.at(-1)?.receipt;return !!receipt&&equal(disposedProductionJob(old,receipt),next)}catch{return false}}
export interface ProductionDispositionDependencies {load:()=>Promise<ProductionJob[]>;save:(job:ProductionJob,expected:{id:string;revision:number})=>Promise<void>;authority:PilotAuthority;coordinator:ManagedProductionCoordinator;now?:()=>number;id?:()=>string}
export async function productionRecoveryDisposition(seriesId:string,value:unknown,deps:ProductionDispositionDependencies){
 const b=value as any
 if(b?.action==='dispose')recoveryExact(b,['action','jobId','revision','inspectedAt','inspectionToken','confirmation'])
 else {recoveryExact(b,['action','jobId','revision']);if(!['inspect','reconcile'].includes(b.action))throw new TaskConflict('Exact production hold disposition action required')}
 if(!recoveryId(b.jobId)||!Number.isSafeInteger(b.revision)||b.revision<0)throw new TaskConflict('Exact stopped run revision required')
 let job=(await deps.load()).find(j=>j.seriesId===seriesId)
 if(!job?.config.managedCrop||!['failed','interrupted','cancelled'].includes(job.status)||job.id!==b.jobId||(job.revision??0)!==b.revision||!job.pendingHandoff?.accountCandidateId)throw new TaskConflict('Refresh the retained candidate handoff and stopped run')
 return deps.coordinator.withLease(deps.authority,async authority=>{
  if(!authority.recoveryDisposition)throw new TaskConflict('Compatible recovery disposition transport required');await authority.ready([RECOVERY_DISPOSITION_SCHEMA])
  const pending=job!.pendingHandoff!,timeline=await authority.timeline(pending.taskId),unit={workspaceId:timeline.task.workspaceId,taskId:pending.taskId,attemptId:pending.attemptId,generation:pending.generation,fingerprint:pending.fingerprint}
  if(b.action==='inspect'){
   if(job!.pendingRecoveryDisposition)throw new TaskConflict('Reconcile the original saved disposition first')
   const snapshot=parseDispositionSnapshot(await authority.recoveryDisposition({action:'inspect',unit}),unit,(deps.now??Date.now)())
   if(canonicalJson((await deps.load()).find(j=>j.seriesId===seriesId)??null)!==canonicalJson(job!))throw new TaskConflict('Saved run changed during disposition inspection')
   return {job,snapshot}
  }
  if(b.action==='dispose'){
   if(job!.pendingRecoveryDisposition||b.confirmation!==CLOSE_UNUSED_CONFIRMATION)throw new TaskConflict('Explicit unused approval disposition confirmation required')
   const intent:DispositionIntent={schema:RECOVERY_DISPOSITION_SCHEMA,eventId:(deps.id??randomUUID)(),unit,mode:'close_unused',reference:{unit,ledger:'managed_account_handoff_episodes',actionId:pending.eventId},production:{jobId:job!.id,claimEventId:pending.claimEventId,newClaimEventId:pending.newClaimEventId,candidateId:pending.accountCandidateId!},inspectedAt:b.inspectedAt,inspectionToken:b.inspectionToken,confirmation:b.confirmation}
   const next=prepareDispositionJob(job!,intent);await deps.save(next,{id:job!.id,revision:job!.revision??0});job=next
  }else if(!job!.pendingRecoveryDisposition)throw new TaskConflict('No original pending disposition to reconcile')
  const intent=job!.pendingRecoveryDisposition!
  let receipt=await authority.recoveryDisposition({action:'resolve',intent})
  if(receipt===null&&job!.adoptedFrom?.importedPendingDecisionId===intent.eventId)throw new TaskConflict('Imported decision is unacknowledged. Preserve it until the original receipt or an expired no-effect fence is available; never replay imported approval')
  if(receipt===null)receipt=await authority.recoveryDisposition({action:'apply',intent})
  parseDispositionReceipt(receipt)
  const current=(await deps.load()).find(j=>j.seriesId===seriesId)
  if(canonicalJson(current??null)!==canonicalJson(job!))throw new TaskConflict('Saved run changed; retain the original disposition receipt')
  const next=disposedProductionJob(job!,receipt);await deps.save(next,{id:job!.id,revision:job!.revision??0});return {job:next,snapshot:null}
 })
}
