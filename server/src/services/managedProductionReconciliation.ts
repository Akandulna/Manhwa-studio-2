import {createHash} from 'node:crypto'
import {productionDevices,type ProductionJob} from './productionAutomationModel.js'
import type {ManagedProductionClaim} from './managedProduction.js'
import type {PilotAuthority,PilotInput} from './managedCropPilot.js'
import {canonicalJson,cropTaskIdentity,TaskConflict} from './managedTaskProtocol.js'
import {managedCropBinding} from './managedCropProjection.js'
import {resolveManagedCropInput} from './managedArtifactImport.js'
export type ProductionObservationState='current_unsent'|'waiting_original_reply'|'ready_original_saved'|'verified_complete'|'needs_reconciliation'|'obsolete_claim'|'missing_receipt'|'claim_blocked'|'legacy_task_only'|'input_changed'
export interface ProductionObservation {
 taskId:string;claimEventId:string|null;state:ProductionObservationState;message:string
 owner?:{attemptId:string;generation:number;deviceId:string;profileId:string;phase:string;submission:string;leaseExpiresAt:string}
}
export interface ProductionReconciliation {
 schema:'managed-production-reconciliation/1';jobId:string;revision:number;seriesId:string;checkedAt:string;scopeDigest:string
 preparedTaskIds:string[];observations:ProductionObservation[];unassignedPages:number;requiresAttention:boolean;readOnly:true
}
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest('hex')
export async function inspectManagedProduction(job:ProductionJob,authority:PilotAuthority,inputs:PilotInput[],now=Date.now()):Promise<ProductionReconciliation> {
 if(!job.config.managedCrop)throw new TaskConflict('Choose a saved managed crop production run')
 if(!authority.claimReceipt)throw new TaskConflict('Original claim receipt transport is required')
 await authority.ready(['production-reconciliation/1'])
 const claims=job.command?.managedClaims??[],ids=job.command?.managedTaskIds??[]
 if(inputs.length>1000||claims.length>1000||ids.length>1000)throw new TaskConflict('Production reconciliation scope exceeds 1000 pages')
 const claimMap=new Map<string,ManagedProductionClaim>(),events=new Set<string>()
 for(const claim of claims){
  if(claimMap.has(claim.taskId)||events.has(claim.claimEventId)||!/^task:sha256:[a-f0-9]{64}$/.test(claim.taskId)||!(/^[A-Za-z0-9_-]{1,128}$/).test(claim.claimEventId))throw new TaskConflict('Ambiguous saved production claim receipts; reconcile the stored job')
  claimMap.set(claim.taskId,claim);events.add(claim.claimEventId)
 }
 const sourceMap=new Map<string,PilotInput>()
 for(const input of inputs){const identity=await cropTaskIdentity(input.identity,input.spec);if(sourceMap.has(identity.taskId))throw new TaskConflict('Duplicate production page scope');sourceMap.set(identity.taskId,input)}
 const observations:ProductionObservation[]=[],evidence:unknown[]=[]
 // Inspect immutable job scope only. Pages with no persisted claim are never planned or assigned here.
 for(const taskId of new Set([...ids,...claimMap.keys()])) {
  if(!/^task:sha256:[a-f0-9]{64}$/.test(taskId))throw new TaskConflict('Invalid saved production task identity')
  const claim=claimMap.get(taskId),input=sourceMap.get(taskId)
  const row:ProductionObservation={taskId,claimEventId:claim?.claimEventId??null,state:'legacy_task_only',message:'This saved task has no original claim receipt. Inspect its exact page manually.'}
  if(!claim){observations.push(row);continue}
  if(!input||!productionDevices(job.config).some(d=>d.device===claim.deviceId&&d.profileId===claim.profileId)){row.state='input_changed';row.message='Saved source scope or phone/profile no longer matches this run.';observations.push(row);continue}
  try{
   const binding=await managedCropBinding(input.folder,input.filename),expected=await cropTaskIdentity(input.identity,input.spec)
   if(binding?.task.id!==taskId||binding.destination!==input.destination||binding.task.fingerprint!==expected.fingerprint)throw new TaskConflict('Current source binding differs')
   await resolveManagedCropInput(input.identity,input.spec,input.sourceFile)
  }catch {row.state='input_changed';row.message='Exact current source and binding could not be verified. No work was changed.';observations.push(row);continue}
  const receipt=await authority.claimReceipt(taskId,claim.claimEventId)
  if(receipt.taskId!==taskId||receipt.claimEventId!==claim.claimEventId||!['recorded','missing','blocked_before_claim'].includes(receipt.status))throw new TaskConflict('Mismatched original claim receipt response')
  if(receipt.status!=='recorded'){
   row.state=receipt.status==='missing'?'missing_receipt':'claim_blocked';row.message=receipt.status==='missing'?'The authority has no recorded receipt yet. A delayed claim may still arrive; do not adopt its current owner.':'Stop blocked this original claim before dispatch. No replacement was assigned.'
   if(digest(await authority.claimReceipt(taskId,claim.claimEventId))!==digest(receipt))throw new TaskConflict('Authority receipt changed during inspection. Refresh reconciliation')
   evidence.push(receipt);observations.push(row);continue
  }
  const current=await authority.timeline(taskId),a=current.attempt
  if(current.task.id!==taskId)throw new TaskConflict('Mismatched production timeline')
  evidence.push({receipt,current})
  if(a)row.owner={attemptId:a.id,generation:a.generation,deviceId:a.deviceId,profileId:a.profileId,phase:a.phase,submission:a.submission,leaseExpiresAt:a.leaseExpiresAt}
  const expected=await cropTaskIdentity(input.identity,input.spec)
  if(receipt.fingerprint!==expected.fingerprint||receipt.deviceId!==claim.deviceId||receipt.profileId!==claim.profileId||receipt.accountId!==null||!a||a.id!==receipt.attemptId||a.generation!==receipt.generation||current.task.attemptId!==a.id||current.task.generation!==a.generation||current.task.fingerprint!==receipt.fingerprint||a.deviceId!==receipt.deviceId||a.profileId!==receipt.profileId){row.state='obsolete_claim';row.message='The original claim no longer matches current ownership. This run cannot adopt the current attempt.'}
  else if(current.task.state==='verified_complete'&&current.task.canonical&&a.phase==='published'&&a.submission==='saved'&&a.checkpointRef){row.state='verified_complete';row.message='The original saved result is published. Page review remains a separate decision.'}
  else if(['cancelled','paused','uncertain','superseded','verified_complete'].includes(current.task.state)||!Number.isFinite(Date.parse(a.leaseExpiresAt))||Date.parse(a.leaseExpiresAt)<=now||a.submission==='unknown'||['stop_requested','stop_confirmed'].includes(a.phase)){row.state='needs_reconciliation';row.message='Retain this original attempt and reconcile its stop, lease or submission evidence. No provider retry is authorized.'}
  else if(a.submission==='saved'&&a.phase==='result_saved'&&a.checkpointRef&&current.artifactReady===true){row.state='ready_original_saved';row.message='Original saved bytes are available for explicit validation and import.'}
  else if(a.submission==='submitted'||a.submission==='saved'){row.state='waiting_original_reply';row.message='Wait for the original reply or saved upload. Do not send another request.'}
  else if(a.submission==='unsent'&&['assigned','accepted','started'].includes(a.phase)){row.state='current_unsent';row.message='The original current attempt is confirmed unsent. This observation does not grant execution or transfer permission.'}
  else {row.state='needs_reconciliation';row.message='Retained evidence is incomplete. Inspect the exact original attempt.'}
  // Do not call an earlier timeline a stable observation after a concurrent transfer/checkpoint.
  if(digest(await authority.timeline(taskId))!==digest(current)||digest(await authority.claimReceipt(taskId,claim.claimEventId))!==digest(receipt))throw new TaskConflict('Authority evidence changed during inspection. Refresh reconciliation before acting')
  observations.push(row)
 }
 const requiresAttention=observations.some(row=>!['current_unsent','waiting_original_reply','ready_original_saved','verified_complete'].includes(row.state))
 return {schema:'managed-production-reconciliation/1',jobId:job.id,revision:job.revision??0,seriesId:job.seriesId,checkedAt:new Date(now).toISOString(),scopeDigest:digest({job,observations,evidence,sources:[...sourceMap.keys()]}),observations,preparedTaskIds:[...sourceMap.keys()],unassignedPages:[...sourceMap.keys()].filter(id=>!ids.includes(id)&&!claimMap.has(id)).length,requiresAttention,readOnly:true}
}
