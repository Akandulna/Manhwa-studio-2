import type {AccountSelection} from './managedAccountsProtocol.js'
import {recordManagedCropRevision,verifyManagedCropRevision} from './managedCropRevision.js'
import {createHash,randomUUID} from 'node:crypto'
import type {ProductionClaimReceipt,CoordinatorLease,CropIdentity,CropSpec,CropTask,CropAttempt,ManagedOperation} from './managedTaskProtocol.js'
import {TaskConflict,canonicalJson,cropTaskIdentity} from './managedTaskProtocol.js'
import {requireDefaultCropPilot,DEFAULT_CROP_CAPABILITY,DEFAULT_CROP_PROMPT,SLICED_CROP_CAPABILITY} from './managedCropPilotPolicy.js'
import {managedArtifactTransport,ManagedArtifactDestination,importManagedArtifact,resolveManagedCropInput,type ManagedArtifactTransport} from './managedArtifactImport.js'
import {bindManagedCrop,managedCropBinding,withManagedCropWorkspaceLock,withManagedChapterLock} from './managedCropProjection.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex')
export interface PilotInput {identity:CropIdentity;spec:CropSpec;sourceFile:string;folder:string;filename:string;destination:string}
export interface PilotTimeline {waiting?:AccountSelection;task:CropTask;attempt:CropAttempt|null;commands:unknown[];artifactReady?:boolean;uploadOnlyReport?:any;cancelledSubmissionReport?:any}
export interface PilotAuthority {
 accounts?(action?:Record<string,unknown>):Promise<any>
 selectAccount?(taskId:string,targets?:{deviceId:string;profileId:string}[]):Promise<AccountSelection>
 claimReceipt?(taskId:string,claimEventId:string):Promise<ProductionClaimReceipt>
 coordinator?():Promise<CoordinatorLease|null>
 ready(requiredCapabilities?:string[]):Promise<void>
 operation(operation:Record<string,unknown>):Promise<any>
 timeline(taskId:string):Promise<PilotTimeline>
 artifacts:ManagedArtifactTransport
}
/** Explicit calls only. No polling, fallback credentials, or retries of uncertain HTTP writes. */
export function pilotAuthority(url:string,workspaceId:string,token:string,legacyToken:string|undefined,pause:RelayDeliveryPause):PilotAuthority {
 const artifacts=managedArtifactTransport(url,workspaceId,token,legacyToken,pause) // Validates origin and separate credentials.
 async function call(route:string,body?:Record<string,unknown>,schema='managed-task/1'):Promise<any> {
  await pause.beforeSend()
  const response=await fetch(new URL(route,url),{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20_000),redirect:'error'})
  if(response.status===429)await pause.record(response.headers.get('Retry-After'))
  if(!response.ok){await response.body?.cancel();throw new TaskConflict(`Managed authority returned HTTP ${response.status}; retained work must be reconciled`)}
  const reader=response.body?.getReader();if(!reader)throw new TaskConflict('Missing managed response')
  const chunks:Uint8Array[]=[];let size=0
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>512_000){await reader.cancel();throw new TaskConflict('Managed response exceeds bound')}chunks.push(part.value)}}finally{reader.releaseLock()}
  const raw=JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if(raw.schema!==schema)throw new TaskConflict('Incompatible managed response')
  return raw
 }
 return {artifacts,accounts:async body=>(await call(body?'/managed/accounts/operation':'/managed/accounts',body?{schema:'managed-accounts/1',workspaceId,eventId:randomUUID(),...body}:undefined,'managed-accounts/1')).result,selectAccount:async(taskId,targets)=>(await call('/managed/accounts/select',{schema:'managed-accounts/1',workspaceId,taskId,targets:targets??null},'managed-accounts/1')).result,claimReceipt:async(taskId,claimEventId)=>{if(!/^task:sha256:[a-f0-9]{64}$/.test(taskId)||!(/^[A-Za-z0-9_-]{1,128}$/).test(claimEventId))throw new TaskConflict('Exact original claim receipt required');return (await call('/managed/production-claims/'+encodeURIComponent(taskId)+'/'+encodeURIComponent(claimEventId))).result},coordinator:async()=>(await call('/managed/coordinator')).result,ready:async(requiredCapabilities=[])=>{const {result}=await call('/managed/readiness');if(result?.workspaceId!==workspaceId||result.artifactStorageConfigured!==true||!result.capabilities?.includes(DEFAULT_CROP_CAPABILITY)||!requiredCapabilities.every(cap=>result.capabilities?.includes(cap)))throw new TaskConflict('Configure compatible relay artifact storage before dispatching a provider request')},operation:async body=>(await call('/managed/operation',{schema:'managed-task/1',workspaceId,eventId:randomUUID(),...body})).result,
  timeline:async taskId=>{if(!/^task:sha256:[a-f0-9]{64}$/.test(taskId))throw new TaskConflict('Invalid task ID');return call('/managed/tasks/'+encodeURIComponent(taskId))}}
}
/** Connects real page binding, dispatch and immutable import. Cloud authority remains the sole task owner. */
export class ManagedCropPilot {
 constructor(private authority:PilotAuthority) {}
 async enroll(deviceId:string,profileId:string):Promise<void> {await this.authority.ready();await this.authority.operation({action:'enroll',deviceId,profileId})}
 /** Plan and bind immutable inputs before ranking; this method cannot allocate or launch work. */
 async prepare(input:PilotInput):Promise<PilotTimeline> {
  requireDefaultCropPilot(input.spec)
  await this.authority.ready(['managed-accounts/1'])
  const expected=await cropTaskIdentity(input.identity,input.spec)
  return withManagedCropWorkspaceLock(()=>withManagedChapterLock(input.folder,async()=>{
   await resolveManagedCropInput(input.identity,input.spec,input.sourceFile)
   const planned=await this.authority.operation({action:'plan',eventId:'plan_'+expected.taskId.slice(12),identity:input.identity,spec:input.spec}) as CropTask
   if(planned.id!==expected.taskId||planned.fingerprint!==expected.fingerprint)throw new TaskConflict('Plan acknowledgment does not match selection input')
   const current=await this.authority.timeline(planned.id)
   if(['cancelled','paused','uncertain','superseded'].includes(current.task.state))throw new TaskConflict('Held work cannot be rerouted')
   await bindManagedCrop(input.folder,input.filename,current.task,input.destination)
   return current
  }))
 }
 async start(input:PilotInput,deviceId:string,profileId:string,beforeClaim?:()=>Promise<void>,claimEventId?:string):Promise<PilotTimeline> {
  requireDefaultCropPilot(input.spec)
  await this.authority.ready(input.spec.promptVersion===DEFAULT_CROP_PROMPT?[SLICED_CROP_CAPABILITY]:[])
  const expected=await cropTaskIdentity(input.identity,input.spec)
  return withManagedCropWorkspaceLock(()=>withManagedChapterLock(input.folder,async()=>{
   await resolveManagedCropInput(input.identity,input.spec,input.sourceFile)
   const planned=await this.authority.operation({action:'plan',eventId:'plan_'+expected.taskId.slice(12),identity:input.identity,spec:input.spec}) as CropTask
   if(planned.id!==expected.taskId||planned.fingerprint!==expected.fingerprint)throw new TaskConflict('Plan acknowledgment does not match the requested input')
   const current=await this.authority.timeline(planned.id)
   if(current.task.fingerprint!==expected.fingerprint)throw new TaskConflict('Authority input mismatch')
   if(['cancelled','paused','uncertain','superseded'].includes(current.task.state))throw new TaskConflict('Reconcile the existing task; do not start a replacement prompt')
   if(current.task.state!=='verified_complete'&&current.attempt&&(current.attempt.deviceId!==deviceId||current.attempt.profileId!==profileId))throw new TaskConflict('This page already belongs to another phone/profile')
   await bindManagedCrop(input.folder,input.filename,current.task,input.destination)
   await resolveManagedCropInput(input.identity,input.spec,input.sourceFile)
   await beforeClaim?.()
   let claimed:{attempt?:CropAttempt;waiting?:AccountSelection}|undefined
   if(current.task.state!=='verified_complete'&&(current.task.state==='queued'||claimEventId))claimed=await this.authority.operation({action:'claim',eventId:claimEventId??'claim_'+hash([planned.id,deviceId,profileId]),taskId:planned.id,deviceId,profileId,accountId:null})
   const latest=await this.authority.timeline(planned.id)
   if(claimed?.waiting)return {...latest,waiting:claimed.waiting}
   if(claimEventId&&claimed?.attempt&&(latest.attempt?.id!==claimed.attempt.id||latest.attempt.generation!==claimed.attempt.generation))throw new TaskConflict('Production claim belongs to an obsolete attempt; reconcile explicitly')
   return latest // Never return an old cached claim as current state.
  }))
 }
 /** A real changed source, exact prior binding and confirmed release are mandatory. Never a retry of cancellation. */
 async rebind(input:PilotInput,expectedPreviousTaskId:string):Promise<PilotTimeline> {
  requireDefaultCropPilot(input.spec)
  await this.authority.ready(input.spec.promptVersion===DEFAULT_CROP_PROMPT?[SLICED_CROP_CAPABILITY]:[])
  return withManagedCropWorkspaceLock(()=>withManagedChapterLock(input.folder,async()=>{
   const prior=await managedCropBinding(input.folder,input.filename)
   const expected=await cropTaskIdentity(input.identity,input.spec)
   if(prior?.task.id===expected.taskId&&prior.destination===input.destination&&expectedPreviousTaskId!==expected.taskId) {
    const previous=await this.authority.timeline(expectedPreviousTaskId)
    await verifyManagedCropRevision(input.folder,previous.task,prior.task)
    await resolveManagedCropInput(input.identity,input.spec,input.sourceFile)
    return this.authority.timeline(expected.taskId)
   }
   if(!prior||prior.task.id!==expectedPreviousTaskId||prior.destination!==input.destination)throw new TaskConflict('Exact prior managed binding required')
   const keys=['workspaceId','seriesId','chapterId','pageId'] as const
   if(keys.some(key=>prior.task[key]!==input.identity[key])||expected.taskId===prior.task.id||prior.task.spec.dependencies[0]?.sha256===input.spec.dependencies[0]?.sha256)throw new TaskConflict('A real changed source revision is required; cancelled work cannot be retried')
   await resolveManagedCropInput(input.identity,input.spec,input.sourceFile)
   const old=await this.authority.timeline(prior.task.id),attempt=old.attempt
   const released=old.task.state==='verified_complete'&&old.task.canonical&&attempt?.phase==='published' || old.task.state==='cancelled'&&(!attempt||attempt.phase==='stop_confirmed'&&(
    ['unsent','saved'].includes(attempt.submission)||attempt.submission==='unknown'&&old.uploadOnlyReport?.resolvedAt&&old.uploadOnlyReport.attemptId===attempt.id||attempt.submission==='submitted'&&old.cancelledSubmissionReport?.resolvedAt&&old.cancelledSubmissionReport.attemptId===attempt.id))
   if(!released)throw new TaskConflict('Stop and reconcile the old revision before rebinding; unknown submissions remain held')
   const planned=await this.authority.operation({action:'plan',eventId:'plan_'+expected.taskId.slice(12),identity:input.identity,spec:input.spec}) as CropTask
   if(planned.id!==expected.taskId||planned.fingerprint!==expected.fingerprint)throw new TaskConflict('Revision plan identity mismatch')
   await recordManagedCropRevision(input.folder,prior.task,planned)
   await bindManagedCrop(input.folder,input.filename,planned,input.destination,expectedPreviousTaskId)
   return this.authority.timeline(planned.id)
  }))
 }
 async transfer(input:PilotInput,fence:{taskId:string;attemptId:string;generation:number;fingerprint:string;stopCommandId:string},deviceId:string,profileId:string,receipt?:{claimEventId:string;newClaimEventId:string;eventId:string}):Promise<PilotTimeline> {
  requireDefaultCropPilot(input.spec)
  await this.authority.ready(input.spec.promptVersion===DEFAULT_CROP_PROMPT?[SLICED_CROP_CAPABILITY]:[])
  return withManagedCropWorkspaceLock(()=>withManagedChapterLock(input.folder,async()=>{
   const binding=await managedCropBinding(input.folder,input.filename),expected=await cropTaskIdentity(input.identity,input.spec)
   if(binding?.task.id!==fence.taskId||binding.destination!==input.destination||expected.taskId!==fence.taskId)throw new TaskConflict('Only the unchanged current page binding can transfer')
   await resolveManagedCropInput(input.identity,input.spec,input.sourceFile)
   await this.authority.operation({action:receipt?'transfer_production':'transfer_unsent',...fence,deviceId,profileId,...receipt})
   return this.authority.timeline(fence.taskId)
  }))
 }
 async stop(taskId:string,cancel:boolean):Promise<unknown> {return this.authority.operation({action:'stop',taskId,cancel})}
 async unpair(deviceId:string):Promise<unknown> {return this.authority.operation({action:'unenroll',deviceId})}
 async import(input:PilotInput,taskId:string,recovered=false,owner?:CropAttempt):Promise<{task:CropTask;path:string}> {
  const binding=await managedCropBinding(input.folder,input.filename)
  const expected=await cropTaskIdentity(input.identity,input.spec)
  if(!binding||binding.task.id!==taskId||taskId!==expected.taskId||binding.destination!==input.destination)throw new TaskConflict('Exact current pilot binding required')
  const current=await this.authority.timeline(taskId),attempt=current.attempt
  if(!attempt?.checkpointRef||attempt.submission!=='saved'||!['result_saved','published'].includes(attempt.phase)||!(recovered?['uncertain','verified_complete']:['running','verified_complete']).includes(current.task.state))throw new TaskConflict('A saved result with current ownership is required')
  if(owner&&(attempt.id!==owner.id||attempt.generation!==owner.generation))throw new TaskConflict('Production ownership changed before import')
  const artifactId='crop_'+hash([taskId,attempt.id,attempt.checkpointRef])
  const transport=recovered?{load:this.authority.artifacts.load,publish:(op:ManagedOperation)=>{if(op.action!=='publish')throw new TaskConflict('Expected trusted publication receipt');return this.authority.artifacts.publish({...op,action:'publish_recovered',eventId:'recover_'+op.eventId})}}:this.authority.artifacts
  return importManagedArtifact(transport,new ManagedArtifactDestination(input.destination),artifactId,()=>resolveManagedCropInput(input.identity,input.spec,input.sourceFile))
 }
}
