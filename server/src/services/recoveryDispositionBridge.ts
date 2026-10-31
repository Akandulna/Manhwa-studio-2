import {managedArtifactTransport} from './managedArtifactImport.js'
import {TaskConflict} from './managedTaskProtocol.js'
import {RECOVERY_DISPOSITION_SCHEMA} from './recoveryDispositionProtocol.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
export function recoveryDispositionTransport(url:string,workspace:string,token:string,legacy:string|undefined,pause:RelayDeliveryPause){
 managedArtifactTransport(url,workspace,token,legacy,pause)
 return async(operation:Record<string,unknown>)=>{
  await pause.beforeSend()
  const response=await fetch(new URL('/managed/recovery/disposition',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({...operation,schema:RECOVERY_DISPOSITION_SCHEMA,workspaceId:workspace})})
  if(response.status===429)await pause.record(response.headers.get('Retry-After'))
  if(!response.ok){await response.body?.cancel();throw new TaskConflict('Recovery disposition is unconfirmed; reconcile the original decision')}
  const reader=response.body?.getReader();if(!reader)throw new TaskConflict('Missing retention response');let size=0;const chunks:Uint8Array[]=[]
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>64000){await reader.cancel();throw new TaskConflict('Retention response exceeds bounds')}chunks.push(p.value)}}finally{reader.releaseLock()}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))
 }
}

