import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {EXECUTOR_EVIDENCE_SCHEMA,parseExecutorEvidence,type ExecutorEvidence} from './managedExecutorEvidenceProtocol.js'
import {parseRecoveryBudget,recoveryUnitKey,type RecoveryUnit,type RecoveryBudget} from './automationRecoveryPolicy.js'
import type {AutomationRecovery} from './automationRecovery.js'
import {managedArtifactTransport} from './managedArtifactImport.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
export interface ExecutorInventory {evidence:{observation:ExecutorEvidence;receivedAt:number}[];budget:RecoveryBudget;outcome:'unsent'|'unknown'|'submitted'|'saved'}
export function parseExecutorInventory(raw:any,unit:RecoveryUnit):ExecutorInventory{
 if(raw.schema!==EXECUTOR_EVIDENCE_SCHEMA||!Array.isArray(raw.evidence)||raw.evidence.length>32||!['unsent','unknown','submitted','saved'].includes(raw.outcome))throw new TaskConflict('Bounded original executor observations required')
 const ids=new Set<string>()
 const evidence=raw.evidence.map((r:any)=>{const e=parseExecutorEvidence(r.observation);if(recoveryUnitKey(e.unit)!==recoveryUnitKey(unit)||ids.has(e.id)||!Number.isSafeInteger(r.receivedAt)||r.receivedAt<e.observedAt)throw new TaskConflict('Original immutable executor receipt required');ids.add(e.id);return {observation:e,receivedAt:r.receivedAt}})
 return {evidence,budget:parseRecoveryBudget(raw.budget),outcome:raw.outcome}
}
export function executorEvidenceTransport(url:string,workspace:string,token:string,legacy:string|undefined,pause:RelayDeliveryPause){
 managedArtifactTransport(url,workspace,token,legacy,pause)
 return async(unit:RecoveryUnit)=>{
  recoveryUnitKey(unit);if(unit.workspaceId!==workspace)throw new TaskConflict('Foreign executor workspace')
  await pause.beforeSend()
  const response=await fetch(new URL('/managed/recovery/executor-evidence',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({schema:EXECUTOR_EVIDENCE_SCHEMA,action:'inspect',value:unit})})
  if(response.status===429)await pause.record(response.headers.get('Retry-After'))
  if(!response.ok){await response.body?.cancel();throw new TaskConflict('Executor evidence authority unavailable')}
  const reader=response.body?.getReader();if(!reader)throw new TaskConflict('Missing executor receipt')
  const chunks:Uint8Array[]=[];let size=0
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>128000){await reader.cancel();throw new TaskConflict('Executor inventory exceeds bounds')}chunks.push(p.value)}}finally{reader.releaseLock()}
  return parseExecutorInventory(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),unit)
 }
}
/** Observation-only bridge. Never enables an adapter, requests a repair, acknowledges a command or clears another manager's incident. */
export async function inspectExecutorEvidence(unit:RecoveryUnit,inventory:ExecutorInventory,diagnoses:AutomationRecovery,now=Date.now()){
 const ordered=[...inventory.evidence].sort((a,b)=>a.observation.observedAt-b.observation.observedAt||a.observation.id.localeCompare(b.observation.id)),last=ordered.at(-1)?.observation
 if(!last)return {...inventory,diagnosis:null,stale:false}
 if(last.observedAt>now||now-last.observedAt>=120000)return {...inventory,diagnosis:null,stale:true}
 const outcome=last.outcome===inventory.outcome?last.outcome:'unknown',old=await diagnoses.inspect(unit)
 // A delayed observation cannot replace a newer authoritative diagnosis. Preserve its true source time.
 if(old&&last.observedAt<old.evidence.observedAt)return {...inventory,diagnosis:old,stale:true}
 const reference='executor/'+last.id
 const evidence={reference,observedAt:last.observedAt,failure:last.failure,outcome,inputCurrent:true,reviewRequired:outcome!=='unknown'&&outcome!=='submitted',canonical:false,localState:'unknown' as const,savedCheckpoint:outcome==='saved',login:last.failure==='signed_out'?'signed_out' as const:'unknown' as const,quota:'unknown' as const,quotaScope:null,recheckAt:null,pageExpected:false,profileExpected:false,loading:false,precedingActionReconciled:outcome==='unsent'||outcome==='saved',knownRepair:false,uiChangeId:last.uiChangeId,adapterScope:'phone-executor-observation',contextVerified:false,contextPortable:false,policyAllowsAlternative:false,correctionAllowed:false,acceptedUnitsPreserved:true,safeReleaseVerified:false,deviceReachable:false}
 // Avoid reusing a reference for a changed authority outcome. That needs a fresh source observation.
 if(old?.evidence.reference===reference&&canonicalJson(old.evidence)!==canonicalJson(evidence))return {...inventory,diagnosis:old,stale:true}
 return {...inventory,stale:false,diagnosis:await diagnoses.observe(unit,evidence,inventory.budget)}
}
