import {managedArtifactTransport} from './managedArtifactImport.js'
import {RECOVERY_STOP_SCHEMA,parseRecoveryStopIntent,parseRecoveryStopReceipt,type RecoveryStopIntent} from './recoveryStopProtocol.js'
import {canonicalJson,TaskConflict} from './managedTaskProtocol.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
/** Explicit immutable intent delivery. Never retries, adopts a remote revision or enables a playbook. */
export function recoveryStopTransport(url:string,workspace:string,token:string,legacy:string|undefined,pause:RelayDeliveryPause){
 managedArtifactTransport(url,workspace,token,legacy,pause)
 return async(raw:RecoveryStopIntent)=>{
  const intent=parseRecoveryStopIntent(raw);if(intent.unit.workspaceId!==workspace)throw new TaskConflict('Foreign stop workspace')
  await pause.beforeSend()
  const response=await fetch(new URL('/managed/recovery/stop',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(intent)})
  if(response.status===429)await pause.record(response.headers.get('Retry-After'))
  if(!response.ok){await response.body?.cancel();throw new TaskConflict('Relay stop is unconfirmed; local hold and original intent remain saved')}
  const reader=response.body?.getReader();if(!reader)throw new TaskConflict('Missing relay stop receipt')
  const chunks:Uint8Array[]=[];let size=0
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>16000){await reader.cancel();throw new TaskConflict('Relay stop receipt exceeds bounds')}chunks.push(p.value)}}finally{reader.releaseLock()}
  const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(v.schema!==RECOVERY_STOP_SCHEMA)throw new TaskConflict('Incompatible relay stop receipt')
  const receipt=parseRecoveryStopReceipt(v.receipt),{receivedAt,...original}=receipt
  if(canonicalJson(intent)!==canonicalJson(original))throw new TaskConflict('Original stop receipt mismatch')
  return receipt
 }
}
