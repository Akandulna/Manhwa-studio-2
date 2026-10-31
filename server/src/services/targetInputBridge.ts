import {managedArtifactTransport} from './managedArtifactImport.js'
import {TARGET_INPUT_SCHEMA,parseTargetInputStatus} from './targetInputProtocol.js'
import {fallbackTargets,type FallbackTarget} from './fallbackPreflightProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {TaskConflict} from './managedTaskProtocol.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
export function targetInputStatusTransport(url:string,workspace:string,token:string,legacy:string|undefined,pause:RelayDeliveryPause){
 managedArtifactTransport(url,workspace,token,legacy,pause)
 return async(unit:RecoveryUnit,rawTargets:FallbackTarget[])=>{
  recoveryUnitKey(unit);const targets=fallbackTargets(rawTargets)
  if(unit.workspaceId!==workspace)throw new TaskConflict('Foreign target source status')
  const statuses=[]
  for(const target of targets){
   await pause.beforeSend()
   const response=await fetch(new URL('/managed/recovery/target-input',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({schema:TARGET_INPUT_SCHEMA,workspaceId:workspace,action:'status',unit,target})})
   if(response.status===429)await pause.record(response.headers.get('Retry-After'))
   if(!response.ok){await response.body?.cancel();throw new TaskConflict('Target source inspection unavailable')}
   const reader=response.body?.getReader();if(!reader)throw new TaskConflict('Missing target source status');let length=0;const chunks:Uint8Array[]=[]
   try{while(true){const p=await reader.read();if(p.done)break;length+=p.value.length;if(length>16000){await reader.cancel();throw new TaskConflict('Target source status exceeds bounds')}chunks.push(p.value)}}finally{reader.releaseLock()}
   statuses.push(parseTargetInputStatus(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),unit,target))
  }
  return statuses
 }
}
