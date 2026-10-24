import {parseRecoveryBudget,type RecoveryBudget} from './automationRecoveryPolicy.js'
import path from 'node:path'
import {artifactHash,validateManagedCrop} from './managedCropArtifact.js'
import {cropTaskIdentity,TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {ManagedArtifactDestination,managedArtifactTransport,type ManagedArtifactSnapshot,type ManagedArtifactTransport,type ManagedCropInput} from './managedArtifactImport.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
import {SAVED_IMPORT_SCHEMA,parseSavedImportRecord,type SavedImportFence,type SavedImportRecord} from './managedSavedImportRecoveryProtocol.js'
export interface SavedImportRecoveryTransport {
 readonly singleAttempt:true
 readonly globalEnabled?:boolean
 readonly budget?:RecoveryBudget
 artifacts:ManagedArtifactTransport
 call(action:'inspect'|'control'|'reserve'|'start'|'check'|'finish',fence:SavedImportFence,destinationId:string,details:Record<string,unknown>):Promise<SavedImportRecord|null>
}
/** One fetch per call, no worker/SDK retry loop or publication fallback. No automatic scheduling. */
export function savedImportRecoveryTransport(url:string,workspace:string,token:string,legacyToken?:string,pause?:RelayDeliveryPause):SavedImportRecoveryTransport{
 const artifacts=managedArtifactTransport(url,workspace,token,legacyToken,pause)
 let globalEnabled=false,budget:RecoveryBudget|undefined
 return {singleAttempt:true,artifacts,get globalEnabled(){return globalEnabled},get budget(){return budget?structuredClone(budget):undefined},async call(action,fence,destinationId,details){
  if(fence.workspaceId!==workspace)throw new TaskConflict('Foreign recovery workspace')
  await pause?.beforeSend()
  const response=await fetch(new URL('/managed/recovery/saved-import',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20_000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({schema:SAVED_IMPORT_SCHEMA,action,fence,destinationId,details})})
  if(response.status===429)await pause?.record(response.headers.get('Retry-After'))
  if(!response.ok){await response.body?.cancel();throw new TaskConflict(`Saved import recovery returned HTTP ${response.status}; inspect retained action`)}
  const reader=response.body?.getReader();if(!reader)throw new TaskConflict('Missing recovery response')
  const chunks:Uint8Array[]=[];let size=0
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>32_000){await reader.cancel();throw new TaskConflict('Recovery response too large')}chunks.push(part.value)}}finally{reader.releaseLock()}
  const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length}
  const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
  budget=result.budget===undefined?undefined:parseRecoveryBudget(result.budget)
  globalEnabled=result.globalEnabled===true
  if(result.schema!==SAVED_IMPORT_SCHEMA)throw new TaskConflict('Incompatible recovery authority')
  if(result.result===null){if(action!=='inspect')throw new TaskConflict('Recovery grant missing');return null}
  const record=parseSavedImportRecord(result.result)
  if(canonicalJson(record.fence)!==canonicalJson(fence)||record.destinationId!==destinationId)throw new TaskConflict('Recovery response fence mismatch')
  return record
 }}
}
export async function savedImportDestinationId(destination:ManagedArtifactDestination):Promise<string>{return artifactHash(new TextEncoder().encode(path.resolve(destination.rootPath)))}

/** Explicit first playbook: restore the local copy of an already published crop. Never calls publish. */
export class ManagedSavedImportRecovery {
 constructor(private transport:SavedImportRecoveryTransport){if(transport.singleAttempt!==true)throw new TaskConflict('Disable nested transfer retries first')}
 async validateSnapshot(snapshot:ManagedArtifactSnapshot,f:SavedImportFence,current?:()=>Promise<ManagedCropInput>){
  const {task,attempt,record,bytes}=snapshot
  if(task.workspaceId!==f.workspaceId||task.id!==f.taskId||task.attemptId!==f.attemptId||task.generation!==f.generation||task.fingerprint!==f.fingerprint||attempt.id!==f.attemptId||attempt.taskId!==task.id||attempt.generation!==f.generation||record.id!==f.artifactId||record.taskId!==task.id||record.attemptId!==f.attemptId||record.generation!==f.generation||record.fingerprint!==f.fingerprint||record.sha256!==f.sha256||!record.validated||!record.validationRef||task.state!=='verified_complete'||task.canonical!==record.ref||await artifactHash(bytes)!==f.sha256)throw new TaskConflict('Exact canonical saved crop required')
  if(!current){validateManagedCrop(bytes,task,attempt);return}
  const input=await current(),identity=await cropTaskIdentity(input.identity,input.spec)
  if(identity.taskId!==f.taskId||identity.fingerprint!==f.fingerprint||!input.spec.dependencies.some(d=>d.id===input.identity.pageId&&d.revision===input.spec.pageRevision&&d.sha256===input.source.sha256))throw new TaskConflict('Current input changed; retain historical bytes')
  validateManagedCrop(bytes,task,attempt,input.source)
 }
 /** Read-only reconciliation after crash/lost acknowledgment. Missing files do not prove a stopped executor. */
 async reconcile(f:SavedImportFence,destination:ManagedArtifactDestination,current:()=>Promise<ManagedCropInput>,signal:AbortSignal){
  const destinationId=await savedImportDestinationId(destination)
  signal.throwIfAborted();const r=await this.transport.call('inspect',f,destinationId,{})
  const action=r?.actions.at(-1)
  if(!r||!action)return {state:'needs_reconciliation' as const}
  const snapshot=await this.transport.artifacts.load(f.artifactId);signal.throwIfAborted();await this.validateSnapshot(snapshot,f,current)
  const local=await destination.readPublished(snapshot.task)
  if(!local)return {state:'needs_reconciliation' as const}
  await this.validateSnapshot(local,f,current);signal.throwIfAborted()
  if(action.phase==='executing'||action.phase==='unknown')await this.transport.call('finish',f,destinationId,{actionId:action.id,outcome:'verified',evidenceRef:local.record.validationRef})
  else if(action.phase!=='verified')return {state:'needs_reconciliation' as const}
  return {state:'verified' as const}
 }
 async run(f:SavedImportFence,actionId:string,destination:ManagedArtifactDestination,current:()=>Promise<ManagedCropInput>,signal:AbortSignal,expectedRevision?:number){
  const destinationId=await savedImportDestinationId(destination)
  signal.throwIfAborted()
  await this.transport.call('reserve',f,destinationId,{actionId,...(expectedRevision===undefined?{}:{revision:expectedRevision})});signal.throwIfAborted()
  await this.transport.call('start',f,destinationId,{actionId})
  let localEffectStarted=false
  try {
   signal.throwIfAborted()
   const snapshot=await this.transport.artifacts.load(f.artifactId);signal.throwIfAborted()
   await this.validateSnapshot(snapshot,f,current);signal.throwIfAborted()
   await this.transport.call('check',f,destinationId,{actionId});signal.throwIfAborted();await this.validateSnapshot(snapshot,f,current);signal.throwIfAborted()
   localEffectStarted=true
   const staged=await destination.stage(snapshot)
   await this.validateSnapshot(snapshot,f,current);await staged.verify();signal.throwIfAborted()
   await this.transport.call('check',f,destinationId,{actionId});signal.throwIfAborted();await this.validateSnapshot(snapshot,f,current);signal.throwIfAborted()
   await destination.rememberPublication(snapshot,{task:snapshot.task,artifact:snapshot.record})
   const local=await destination.readPublished(snapshot.task)
   if(!local)throw new TaskConflict('Destination publication missing after import')
   await this.validateSnapshot(local,f,current);signal.throwIfAborted()
   await this.transport.call('finish',f,destinationId,{actionId,outcome:'verified',evidenceRef:local.record.validationRef})
   return {path:staged.path,task:local.task}
  }catch(error){
   // Read failures before stage are safe; once writes begin, retain uncertainty for read-only reconciliation.
   // Report best-effort without clearing the original error or sending another action.
   try{await this.transport.call('finish',f,destinationId,{actionId,outcome:localEffectStarted?'unknown':'safe_failure',evidenceRef:'evidence/'+actionId})}catch{}
   throw error
  }
 }
}
