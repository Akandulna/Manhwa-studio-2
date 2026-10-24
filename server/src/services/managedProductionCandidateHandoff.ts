import {randomUUID} from 'node:crypto'
import type {PilotAuthority,PilotInput} from './managedCropPilot.js'
import type {ManagedProductionCoordinator} from './managedProductionCoordinator.js'
import type {ProductionJob} from './productionAutomationModel.js'
import {handoffConfig,handoffJob,type ProductionHandoffIntent} from './managedProductionHandoff.js'
import {TaskConflict,canonicalJson,cropTaskIdentity} from './managedTaskProtocol.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {ACCOUNT_HANDOFF_SCHEMA,HANDOFF_CONFIRMATION,parseHandoffRecord,parseHandoffStatus,PRODUCTION_CANDIDATE_HANDOFF_CAPABILITY} from './accountHandoffProtocol.js'
import {parseAdoptionStatus} from './candidateAdoptionProtocol.js'
import type {PackageSource} from './targetPackageProtocol.js'
export interface ProductionCandidateHandoffDependencies {
 load:()=>Promise<ProductionJob[]>;save:(job:ProductionJob,expected:{id:string;revision:number})=>Promise<void>
 authority:PilotAuthority;coordinator:ManagedProductionCoordinator;inputs:(job:ProductionJob)=>Promise<PilotInput[]>
 verify:(input:PilotInput)=>Promise<PackageSource>;validateTarget:(job:ProductionJob,intent:ProductionHandoffIntent,existing:boolean)=>Promise<void>
 enabled:()=>boolean;now?:()=>number;id?:()=>string
}
/** Persist original intent before reserving a recovery action. Native stages proof; only a current coordinator commits ownership. */
export async function productionCandidateHandoff(seriesId:string,value:unknown,deps:ProductionCandidateHandoffDependencies):Promise<ProductionJob>{
 const request=value as any
 if(request?.action==='approve'&&!request.intentId){
  recoveryExact(request,['action','jobId','revision','taskId','attemptId','generation','fingerprint','stopCommandId','deviceId','profileId','candidateId','confirmation'])
  if(request.confirmation!==HANDOFF_CONFIRMATION||![request.attemptId,request.stopCommandId,request.deviceId,request.profileId,request.candidateId].every(recoveryId)||!Number.isSafeInteger(request.generation)||request.generation<1||!(/^[a-f0-9]{64}$/).test(request.fingerprint))throw new TaskConflict('Explicit exact retained-candidate production approval required')
 }else {recoveryExact(request,['action','jobId','revision','intentId']);if(!['approve','finish'].includes(request.action)||!recoveryId(request.intentId))throw new TaskConflict('Exact persisted production candidate handoff required')}
 if(!recoveryId(request.jobId)||!Number.isSafeInteger(request.revision)||request.revision<0)throw new TaskConflict('Exact saved run revision required')
 let job=(await deps.load()).find(j=>j.seriesId===seriesId)
 if(!job?.config.managedCrop||!['failed','interrupted'].includes(job.status)||job.id!==request.jobId||(job.revision??0)!==request.revision)throw new TaskConflict('Pause scheduling and refresh the exact retained production run')
 if(job.pendingRecoveryDisposition)throw new TaskConflict('Reconcile the original recovery disposition before any handoff action')
 const originalVersion={id:job.id,revision:job.revision??0},existing=!!job.pendingHandoff
 let intent=job.pendingHandoff
 if(intent){if(!intent.accountCandidateId||request.intentId!==intent.eventId)throw new TaskConflict('Use the exact pending candidate handoff; legacy transfers cannot replace it')}
 else {
  if(request.action!=='approve'||request.intentId)throw new TaskConflict('Persist an approved production candidate first')
  const claim=job.command?.managedClaims?.find(c=>c.taskId===request.taskId)
  if(!claim)throw new TaskConflict('Exact original production claim required')
  const id=deps.id??randomUUID
  intent={eventId:id(),newClaimEventId:id(),claimEventId:claim.claimEventId,taskId:claim.taskId,attemptId:request.attemptId,generation:request.generation,fingerprint:request.fingerprint,stopCommandId:request.stopCommandId,deviceId:request.deviceId,profileId:request.profileId,accountCandidateId:request.candidateId,createdAt:new Date((deps.now??Date.now)()).toISOString()}
  handoffConfig(job.config,intent)
 }
 const pending=intent
 return deps.coordinator.withLease(deps.authority,async authority=>{
  if(!authority.accountHandoff||!authority.candidateAdoptionStatus||!authority.claimReceipt)throw new TaskConflict('Compatible production candidate handoff transport required')
  await authority.ready([PRODUCTION_CANDIDATE_HANDOFF_CAPABILITY])
  const inputs=await deps.inputs(job!),matches=await Promise.all(inputs.map(async input=>({input,id:(await cropTaskIdentity(input.identity,input.spec)).taskId}))),input=matches.find(r=>r.id===pending.taskId)?.input
  if(!input)throw new TaskConflict('Exact unchanged prepared source scope required')
  const expected=await cropTaskIdentity(input.identity,input.spec)
  if(expected.fingerprint!==pending.fingerprint)throw new TaskConflict('Prepared source fingerprint changed')
  const unit={workspaceId:input.identity.workspaceId,taskId:pending.taskId,attemptId:pending.attemptId,generation:pending.generation,fingerprint:pending.fingerprint},target={deviceId:pending.deviceId,profileId:pending.profileId},source=await deps.verify(input)
  await deps.validateTarget(job!,pending,existing)
  if(request.action==='approve'&&job!.adoptedFrom?.importedPendingHandoffId===pending.eventId){
   const status=parseHandoffStatus(await authority.accountHandoff({action:'status',unit}),unit,(deps.now??Date.now)()),original=status.actions.find((a:any)=>a.id===pending.eventId)
   if(!original||original.candidate.id!==pending.accountCandidateId||original.production?.jobId!==job!.id||original.production.claimEventId!==pending.claimEventId||original.production.newClaimEventId!==pending.newClaimEventId||canonicalJson(original.candidate.context.source)!==canonicalJson(source)||original.candidate.context.target.deviceId!==pending.deviceId||original.candidate.context.target.profileId!==pending.profileId)throw new TaskConflict('Imported handoff has no matching original relay approval; preserve or explicitly dispose its unused intent')
   if(canonicalJson((await deps.load()).find(j=>j.seriesId===seriesId)??null)!==canonicalJson(job!))throw new TaskConflict('Imported saved run changed during original approval inspection')
   return job!
  }
  if(request.action==='approve'){
   if(!deps.enabled())throw new TaskConflict('Production candidate handoff approval is off')
   const custody=parseAdoptionStatus(await authority.candidateAdoptionStatus(unit,target),unit,target,(deps.now??Date.now)()),candidate=custody.actions.find((a:any)=>a.id===pending.accountCandidateId)
   if(candidate?.phase!=='verified'||canonicalJson(candidate.context.source)!==canonicalJson(source))throw new TaskConflict('Acknowledged exact source candidate required')
   if(!existing){
    const timeline=await authority.timeline(pending.taskId),receipt=await authority.claimReceipt(pending.taskId,pending.claimEventId)
    if(timeline.task.state!=='paused'||timeline.attempt?.id!==pending.attemptId||timeline.task.generation!==pending.generation||timeline.attempt.phase!=='stop_confirmed'||timeline.attempt.submission!=='unsent'||timeline.attempt.checkpointRef||timeline.attempt.activeCommandId!==pending.stopCommandId||receipt.status!=='recorded'||receipt.attemptId!==pending.attemptId||receipt.generation!==pending.generation||receipt.fingerprint!==pending.fingerprint)throw new TaskConflict('Original exact confirmed-unsent production stop and receipt required')
    job={...job!,pendingHandoff:pending,revision:originalVersion.revision+1,updatedAt:new Date((deps.now??Date.now)()).toISOString(),message:'Candidate handoff intent retained. On the exact target, consume the approved handoff to retain its fresh proof, then finish in Studio.'}
    await deps.save(job,originalVersion)
   }
   const status=parseHandoffStatus(await authority.accountHandoff({action:'status',unit}),unit,(deps.now??Date.now)())
   const result=await authority.accountHandoff({action:'approve',unit,approval:{actionId:pending.eventId,candidateId:pending.accountCandidateId,revision:status.revision,confirmation:HANDOFF_CONFIRMATION,production:{jobId:job!.id,claimEventId:pending.claimEventId,newClaimEventId:pending.newClaimEventId}}})
   parseHandoffRecord({schema:ACCOUNT_HANDOFF_SCHEMA,fence:{unit},revision:1,enabled:true,paused:false,cancelled:false,nextEligibleAt:0,actions:[result]})
   if(result.id!==pending.eventId||result.candidate.id!==pending.accountCandidateId||canonicalJson(result.candidate.context.source)!==canonicalJson(source))throw new TaskConflict('Original candidate approval receipt changed')
   if(canonicalJson(await deps.verify(input))!==canonicalJson(source))throw new TaskConflict('Source changed around approval; retain the original charged intent')
   const current=(await deps.load()).find(j=>j.seriesId===seriesId)
   if(canonicalJson(current??null)!==canonicalJson(job!))throw new TaskConflict('Saved run changed around approval; reconcile its retained intent')
   return job!
  }
  const status=parseHandoffStatus(await authority.accountHandoff({action:'status',unit}),unit,(deps.now??Date.now)()),action=status.actions.find((a:any)=>a.id===pending.eventId)
  if(!action||action.candidate.id!==pending.accountCandidateId||action.production?.jobId!==job!.id||action.production?.claimEventId!==pending.claimEventId||action.production?.newClaimEventId!==pending.newClaimEventId||canonicalJson(action.candidate.context.source)!==canonicalJson(source))throw new TaskConflict('Exact original production candidate receipt required')
  if(!['prepared','verified'].includes(action.phase))throw new TaskConflict('Target must retain its original fresh proof before Studio commit')
  const before=(await deps.load()).find(j=>j.seriesId===seriesId)
  if(canonicalJson(before??null)!==canonicalJson(job!))throw new TaskConflict('Saved run changed before commit')
  const result=await authority.accountHandoff({action:'finalize',unit,actionId:pending.eventId})
  parseHandoffRecord({schema:ACCOUNT_HANDOFF_SCHEMA,fence:{unit},revision:1,enabled:true,paused:false,cancelled:false,nextEligibleAt:0,actions:[result]})
  if(result.phase!=='verified'||result.id!==pending.eventId||canonicalJson(result.production)!==canonicalJson(action.production))throw new TaskConflict('Original committed handoff receipt required')
  const receipt=await authority.claimReceipt(pending.taskId,pending.newClaimEventId)
  if(receipt.status!=='recorded'||receipt.attemptId!==result.result.attempt.id||receipt.generation!==pending.generation+1||receipt.deviceId!==pending.deviceId||receipt.profileId!==pending.profileId||receipt.accountId!==result.candidate.context.accountId)throw new TaskConflict('Exact successor claim and confirmed account required')
  if(canonicalJson(await deps.verify(input))!==canonicalJson(source))throw new TaskConflict('Source changed around commit; retain the original result')
  const current=(await deps.load()).find(j=>j.seriesId===seriesId)
  if(canonicalJson(current??null)!==canonicalJson(job!))throw new TaskConflict('Saved run changed after commit; reconcile its original pending intent')
  const applied=handoffJob(current!,pending,{attemptId:receipt.attemptId!,generation:receipt.generation!},(deps.now??Date.now)())
  await deps.save(applied,{id:current!.id,revision:current!.revision??0})
  return applied
 })
}
