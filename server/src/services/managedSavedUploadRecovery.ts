import {managedArtifactTransport} from './managedArtifactImport.js'
import {SAVED_UPLOAD_SCHEMA,parseSavedUploadRecord,type SavedUploadFence,type SavedUploadRecord} from './managedSavedUploadRecoveryProtocol.js'
import {parseRecoveryBudget,type RecoveryBudget,type RecoveryUnit,recoveryUnitKey} from './automationRecoveryPolicy.js'
import {canonicalJson,TaskConflict} from './managedTaskProtocol.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
export interface SavedUploadTransport {readonly singleAttempt:true;readonly globalEnabled:boolean;readonly budget:RecoveryBudget|null;call(action:string,fence:SavedUploadFence|RecoveryUnit,details:Record<string,unknown>):Promise<SavedUploadRecord|null>}
/** Studio admits one upload; original phone executes. No retry, provider, storage-write or dispatch fallback here. */
export function savedUploadRecoveryTransport(url:string,workspace:string,token:string,legacyToken:string|undefined,pause:RelayDeliveryPause):SavedUploadTransport {
 managedArtifactTransport(url,workspace,token,legacyToken,pause) // Same secure-origin/separate-token validation.
 let globalEnabled=false,budget:RecoveryBudget|null=null
 return {singleAttempt:true,get globalEnabled(){return globalEnabled},get budget(){return budget?structuredClone(budget):null},async call(action,fence,details){
  if(fence.workspaceId!==workspace)throw new TaskConflict('Foreign saved-upload workspace')
  await pause.beforeSend()
  const response=await fetch(new URL('/managed/recovery/saved-upload',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({schema:SAVED_UPLOAD_SCHEMA,action,fence,details})})
  if(response.status===429)await pause.record(response.headers.get('Retry-After'))
  if(!response.ok){await response.body?.cancel();throw new TaskConflict('Saved-upload authority unavailable; inspect original receipt')}
  const reader=response.body?.getReader();if(!reader)throw new TaskConflict('Saved-upload response missing')
  const chunks:Uint8Array[]=[];let size=0
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>32000){await reader.cancel();throw new TaskConflict('Saved-upload response exceeds bounds')}chunks.push(p.value)}}finally{reader.releaseLock()}
  const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))
  if(raw.schema!==SAVED_UPLOAD_SCHEMA)throw new TaskConflict('Incompatible saved-upload authority')
  budget=parseRecoveryBudget(raw.budget);globalEnabled=raw.globalEnabled===true
  if(raw.result===null){if(!['discover','inspect'].includes(action))throw new TaskConflict('Original recovery grant missing');return null}
  const result=parseSavedUploadRecord(raw.result),unit=(f:SavedUploadFence|RecoveryUnit)=>({workspaceId:f.workspaceId,taskId:f.taskId,attemptId:f.attemptId,generation:f.generation,fingerprint:f.fingerprint})
  if(recoveryUnitKey(unit(result.fence))!==recoveryUnitKey(unit(fence))||action!=='discover'&&canonicalJson(result.fence)!==canonicalJson(fence))throw new TaskConflict('Saved-upload response fence mismatch')
  return result
 }}
}
