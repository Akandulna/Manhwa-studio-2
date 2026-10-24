import type {RecoveryUnit,RecoveryBudget,RecoveryOperation} from './automationRecoveryPolicy.js'
import {canonicalJson,cropTaskIdentity,TaskConflict} from './managedTaskProtocol.js'
import {artifactRef} from './managedCropArtifact.js'
import {ManagedArtifactDestination,resolveManagedCropInput,type ManagedCropInput} from './managedArtifactImport.js'
import {ManagedSavedImportRecovery,savedImportDestinationId,type SavedImportRecoveryTransport} from './managedSavedImportRecovery.js'
import {parseSavedImportFence,recoveryExact,recoveryId,type SavedImportFence,type SavedImportRecord} from './managedSavedImportRecoveryProtocol.js'
import type {PilotAuthority,PilotInput} from './managedCropPilot.js'

// Browser projections contain opaque references and labels, never credentials or filesystem paths.
export interface SavedCropTarget extends SavedImportFence {destinationId:string;chapterLabel:string;pageLabel:string;destinationLabel:string}
export interface SavedCropScope {target:SavedCropTarget;destination:ManagedArtifactDestination;current:()=>Promise<ManagedCropInput>}
export type SavedCropAction='inspect'|'enable'|'run'|'reconcile'|'pause'|'cancel'
export interface SavedCropInspection {budget?:RecoveryBudget;target:SavedCropTarget;observedAt:number;globalEnabled:boolean;canonical:boolean;sourceMatches:boolean;localState:'missing'|'verified'|'conflict'|'unknown';episode:(Omit<SavedImportRecord,'schema'|'fence'|'destinationId'|'actions'>&{actions:Omit<SavedImportRecord['actions'][number],'evidenceRef'>[]})|null}
export interface RecoveryBridgeDependencies {
 resolve(pageId:string):Promise<SavedCropScope>
 transport:SavedImportRecoveryTransport
 assertAdmission?(unit:RecoveryUnit,operation?:RecoveryOperation):Promise<void>
 enabled():boolean
 now?:()=>number
}
const actions=['inspect','enable','run','reconcile','pause','cancel']
function fenceOf(target:SavedCropTarget):SavedImportFence {const {workspaceId,taskId,attemptId,generation,fingerprint,artifactId,sha256}=target;return parseSavedImportFence({workspaceId,taskId,attemptId,generation,fingerprint,artifactId,sha256})}

/** Explicit operator actions only; every request re-resolves the approved page binding on the server. */
export class SavedCropRecoveryBridge {
 private recovery:ManagedSavedImportRecovery
 constructor(private deps:RecoveryBridgeDependencies){this.recovery=new ManagedSavedImportRecovery(deps.transport)}
 async targets(pageId:string){return [(await this.deps.resolve(pageId)).target]}
 private async inspect(scope:SavedCropScope):Promise<SavedCropInspection>{
  const {target,destination,current}=scope,fence=fenceOf(target)
  const episode=await this.deps.transport.call('inspect',fence,target.destinationId,{})
  const snapshot=await this.deps.transport.artifacts.load(target.artifactId)
  // Validate canonical bytes independently from the actual current source.
  await this.recovery.validateSnapshot(snapshot,fence)
  let sourceMatches=true
  try{await this.recovery.validateSnapshot(snapshot,fence,current)}catch{sourceMatches=false}
  const localState=await destination.inspectProjection(snapshot)
  return {...(this.deps.transport.budget?{budget:this.deps.transport.budget}:{}),target,observedAt:(this.deps.now??Date.now)(),globalEnabled:this.deps.enabled()&&this.deps.transport.globalEnabled===true,canonical:true,sourceMatches,localState,
   episode:episode?{revision:episode.revision,enabled:episode.enabled,paused:episode.paused,cancelled:episode.cancelled,nextEligibleAt:episode.nextEligibleAt,actions:episode.actions.map(({id,phase,at,finishedAt})=>({id,phase,at,finishedAt}))}:null}
 }
 async perform(pageId:string,body:unknown):Promise<SavedCropInspection>{
  if(!body||typeof body!=='object'||Array.isArray(body))throw new TaskConflict('Exact recovery action required')
  const raw=body as Record<string,unknown>
  recoveryExact(raw,'actionId' in raw?['action','target','expectedRevision','actionId']:['action','target','expectedRevision'])
  if(!actions.includes(raw.action as string)||!Number.isSafeInteger(raw.expectedRevision)||Number(raw.expectedRevision)<0||('actionId' in raw&&!recoveryId(raw.actionId)))throw new TaskConflict('Exact recovery action and revision required')
  if((raw.action==='run'&&!recoveryId(raw.actionId))||(!['run','reconcile'].includes(raw.action as string)&&'actionId' in raw))throw new TaskConflict('Exact original action required')
  const scope=await this.deps.resolve(pageId),{target,destination,current}=scope,fence=fenceOf(target)
  if(canonicalJson(raw.target)!==canonicalJson(target))throw new TaskConflict('Refresh the approved recovery target')
  const view=await this.inspect(scope),e=view.episode,last=e?.actions.at(-1),action=raw.action as SavedCropAction
  if(action==='inspect')return view
  if(action==='reconcile'){
   if(raw.actionId&&last?.id!==raw.actionId)throw new TaskConflict('Original action receipt is unresolved')
   await this.recovery.reconcile(fence,destination,current,new AbortController().signal)
   return this.inspect(scope)
  }
  if(!view.globalEnabled)throw new TaskConflict('Recovery remains disabled')
  if(raw.expectedRevision!==(e?.revision??0))throw new TaskConflict('Inspect the current recovery revision')
  if(action==='enable'||action==='run'){
   const unit={workspaceId:fence.workspaceId,taskId:fence.taskId,attemptId:fence.attemptId,generation:fence.generation,fingerprint:fence.fingerprint}
   await this.deps.assertAdmission?.(unit,action==='run'?'restore_local':undefined)
   if(view.budget?.pending||view.budget?.exhausted||(view.budget?.nextEligibleAt??0)>(this.deps.now??Date.now)()||!view.sourceMatches||view.localState!=='missing'||e?.cancelled||last&&last.phase!=='safe_failure'||(e?.actions.length??0)>=3||(e?.nextEligibleAt??0)>(this.deps.now??Date.now)())throw new TaskConflict('Recovery is held; inspect the original evidence')
   if(action==='run'){
    if(!e?.enabled||e.paused)throw new TaskConflict('Enable this inspected recovery first')
    await this.recovery.run(fence,raw.actionId as string,destination,async()=>{await this.deps.assertAdmission?.(unit,action==='run'?'restore_local':undefined);const source=await current();await this.deps.assertAdmission?.(unit,action==='run'?'restore_local':undefined);return source},new AbortController().signal,raw.expectedRevision as number)
   }else await this.deps.transport.call('control',fence,target.destinationId,{revision:raw.expectedRevision,enabled:true,paused:false,cancelled:false})
  }else{
   if(!e||e.cancelled||last?.phase==='verified')throw new TaskConflict('No active recovery controls')
   await this.deps.transport.call('control',fence,target.destinationId,{revision:raw.expectedRevision,enabled:e.enabled,paused:action==='pause'?true:e.paused,cancelled:action==='cancel'})
  }
  return this.inspect(scope)
 }
}

/** Resolve the canonical artifact using the private binding and authenticated task timeline. */
export async function resolveSavedCropScope(input:PilotInput,binding:{task:import('./managedTaskProtocol.js').CropTask;destination:string}|null,authority:Pick<PilotAuthority,'timeline'|'artifacts'>,current:()=>Promise<ManagedCropInput>):Promise<SavedCropScope>{
 if(!binding||binding.destination!==input.destination)throw new TaskConflict('Current managed page binding required')
 const {task,attempt}=await authority.timeline(binding.task.id)
 if(task.workspaceId!==input.identity.workspaceId||task.id!==binding.task.id||task.fingerprint!==binding.task.fingerprint||!attempt||task.state!=='verified_complete'||!task.canonical||attempt.phase!=='published'||attempt.submission!=='saved'||!attempt.checkpointRef)throw new TaskConflict('Select an already published managed crop')
 const artifactId=task.canonical.split('/').at(-1)!
 if(!recoveryId(artifactId)||artifactRef(task,attempt.id,artifactId)!==task.canonical)throw new TaskConflict('Canonical artifact reference required')
 const snapshot=await authority.artifacts.load(artifactId)
 const destination=new ManagedArtifactDestination(binding.destination)
 const target:SavedCropTarget={workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:task.generation,fingerprint:task.fingerprint,artifactId,sha256:snapshot.record.sha256,destinationId:await savedImportDestinationId(destination),chapterLabel:'Chapter '+task.chapterId,pageLabel:input.filename,destinationLabel:'Private local crop store'}
 fenceOf(target)
 return {target,destination,current}
}

/** Re-read the current input at every effect boundary, including source and binding changes during I/O. */
export async function currentSavedCropInput(input:()=>Promise<PilotInput>,binding:()=>Promise<{task:import('./managedTaskProtocol.js').CropTask;destination:string}|null>,target:SavedCropTarget){
 const fresh=await input(),bound=await binding(),expected=await cropTaskIdentity(fresh.identity,fresh.spec)
 if(!bound||bound.task.id!==target.taskId||bound.task.fingerprint!==target.fingerprint||expected.taskId!==target.taskId||expected.fingerprint!==target.fingerprint||await savedImportDestinationId(new ManagedArtifactDestination(bound.destination))!==target.destinationId||bound.destination!==fresh.destination)throw new TaskConflict('Page binding or source changed')
 return resolveManagedCropInput(fresh.identity,fresh.spec,fresh.sourceFile)
}
