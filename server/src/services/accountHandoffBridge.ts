import {managedArtifactTransport} from './managedArtifactImport.js'
import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {ACCOUNT_HANDOFF_SCHEMA,HANDOFF_CONFIRMATION,parseHandoffRecord,parseHandoffStatus} from './accountHandoffProtocol.js'
import type {PackageSource} from './targetPackageProtocol.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
export function accountHandoffTransport(url:string,workspace:string,token:string,legacy:string|undefined,pause:RelayDeliveryPause){
 managedArtifactTransport(url,workspace,token,legacy,pause)
 return async(operation:Record<string,unknown>)=>{
  await pause.beforeSend()
  const response=await fetch(new URL('/managed/recovery/account-handoff',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({...operation,schema:ACCOUNT_HANDOFF_SCHEMA,workspaceId:workspace})})
  if(response.status===429)await pause.record(response.headers.get('Retry-After'))
  if(!response.ok){await response.body?.cancel();throw new TaskConflict('Handoff outcome is unconfirmed; inspect the original action')}
  const reader=response.body?.getReader();if(!reader)throw new TaskConflict('Missing retention response');let size=0;const chunks:Uint8Array[]=[]
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>64000){await reader.cancel();throw new TaskConflict('Retention response exceeds bounds')}chunks.push(p.value)}}finally{reader.releaseLock()}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))
 }
}

export class AccountHandoffStudioBridge {
 constructor(private deps:{resolve:()=>Promise<{unit:RecoveryUnit;source:PackageSource}>;call:ReturnType<typeof accountHandoffTransport>;enabled:()=>boolean}){}
 async perform(raw:unknown){
  const b=raw as any
  if(b?.action==='approve'){recoveryExact(b,['action','unit','approval']);recoveryExact(b.approval,['actionId','candidateId','revision','confirmation']);if(!this.deps.enabled()||b.approval.confirmation!==HANDOFF_CONFIRMATION)throw new TaskConflict('Separate handoff approval is off or unconfirmed')}
  else if(b?.action==='status')recoveryExact(b,['action','unit'])
  else if(b?.action==='cancel'){recoveryExact(b,['action','unit','actionId','revision']);if(!recoveryId(b.actionId)||!Number.isSafeInteger(b.revision))throw new TaskConflict('Exact original cancellation required')}
  else throw new TaskConflict('Explicit handoff operation required')
  recoveryUnitKey(b.unit);const before=await this.deps.resolve();if(recoveryUnitKey(b.unit)!==recoveryUnitKey(before.unit))throw new TaskConflict('Original selected attempt changed')
  const result=await this.deps.call(b),after=await this.deps.resolve()
  // A target may commit while Studio awaits. Keep this response unconfirmed if the current owner changed.
  if(recoveryUnitKey(before.unit)!==recoveryUnitKey(after.unit)||canonicalJson(before.source)!==canonicalJson(after.source))throw new TaskConflict('Source or owner changed; inspect the original handoff')
  if(b.action==='status')parseHandoffStatus(result,b.unit)
  const actions=b.action==='status'?result.actions:[result]
  if(!Array.isArray(actions)||actions.length>3)throw new TaskConflict('Bounded handoff receipt required')
  if(actions.length)parseHandoffRecord({schema:ACCOUNT_HANDOFF_SCHEMA,fence:{unit:b.unit},revision:1,enabled:true,paused:false,cancelled:false,nextEligibleAt:0,actions})
  if(actions.some((a:any)=>canonicalJson(a.candidate.context.source)!==canonicalJson(before.source)))throw new TaskConflict('Handoff candidate source mismatch')
  return b.action==='status'?result:parseHandoffStatus(await this.deps.call({action:'status',unit:b.unit}),b.unit)
 }
}
