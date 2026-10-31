import {managedArtifactTransport} from './managedArtifactImport.js'
import {ACCOUNT_RECHECK_SCHEMA,parseAccountRecheckFence,parseAccountRecheckRecord,type AccountRecheckFence,type AccountRecheckRecord} from './accountRecheckRecoveryProtocol.js'
import {parseRecoveryBudget,recoveryUnitKey,type RecoveryUnit,type RecoveryBudget} from './automationRecoveryPolicy.js'
import {canonicalJson,TaskConflict} from './managedTaskProtocol.js'
import type {ManagedAccountProfile} from './managedAccountsProtocol.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
export interface AccountRecheckView {globalEnabled:boolean;targets?:AccountRecheckFence[];record:AccountRecheckRecord|null;budget?:RecoveryBudget;profileAudit?:ManagedAccountProfile['audit']|null;quotaState?:'available'|'blocked'|'unknown'}
export interface AccountRecheckTransport {readonly singleAttempt:true;call(action:string,fence:RecoveryUnit|AccountRecheckFence,details:Record<string,unknown>):Promise<AccountRecheckView>}
export function accountRecheckTransport(url:string,workspace:string,token:string,legacy:string|undefined,pause:RelayDeliveryPause):AccountRecheckTransport {
 managedArtifactTransport(url,workspace,token,legacy,pause)
 return {singleAttempt:true,async call(action,fence,details){
  const unit='unit' in fence?fence.unit:fence
  if(unit.workspaceId!==workspace)throw new TaskConflict('Foreign account recheck workspace')
  await pause.beforeSend()
  const response=await fetch(new URL('/managed/recovery/account-recheck',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({schema:ACCOUNT_RECHECK_SCHEMA,action,fence,details})})
  if(response.status===429)await pause.record(response.headers.get('Retry-After'))
  if(!response.ok){await response.body?.cancel();throw new TaskConflict('Account recheck authority unavailable; original requests are retained')}
  const reader=response.body?.getReader();if(!reader)throw new TaskConflict('Missing account recheck response')
  const chunks:Uint8Array[]=[];let size=0
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>128000){await reader.cancel();throw new TaskConflict('Account recheck inventory exceeds bounds')}chunks.push(part.value)}}finally{reader.releaseLock()}
  const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))
  if(v.schema!==ACCOUNT_RECHECK_SCHEMA||typeof v.globalEnabled!=='boolean')throw new TaskConflict('Incompatible account recheck response')
  const record=v.record===null?null:parseAccountRecheckRecord(v.record)
  if(record&&(recoveryUnitKey(record.fence.unit)!==recoveryUnitKey(unit)||action!=='discover'&&canonicalJson(record.fence)!==canonicalJson(fence)))throw new TaskConflict('Account recheck response fence mismatch')
  if(action==='discover'){
   if(!Array.isArray(v.targets)||v.targets.length>128)throw new TaskConflict('Bounded approved recheck targets required')
   const targets=v.targets.map(parseAccountRecheckFence)
   if(targets.some((f:AccountRecheckFence)=>recoveryUnitKey(f.unit)!==recoveryUnitKey(unit)))throw new TaskConflict('Foreign account recheck target')
   return {globalEnabled:v.globalEnabled,record,targets}
  }
  if(!['available','blocked','unknown'].includes(v.quotaState)||!(v.profileAudit===null||v.profileAudit&&['due','deferred','running','success','failed'].includes(v.profileAudit.state)&&Number.isSafeInteger(v.profileAudit.dueAt)&&Number.isSafeInteger(v.profileAudit.nextCheckAt)))throw new TaskConflict('Current audit disposition required')
  return {globalEnabled:v.globalEnabled,record,budget:parseRecoveryBudget(v.budget),profileAudit:v.profileAudit,quotaState:v.quotaState}
 }}
}
