import {managedArtifactTransport} from './managedArtifactImport.js'
import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {fallbackTargets,type FallbackTarget} from './fallbackPreflightProtocol.js'
import {CANDIDATE_ADOPTION_SCHEMA,ADOPTION_CONFIRMATION,parseAdoptionStatus,parseAdoptionOperation} from './candidateAdoptionProtocol.js'
import type {targetContextStatusTransport} from './targetContextBridge.js'
import type {PackageSource} from './targetPackageProtocol.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
export function candidateAdoptionTransport(url:string,workspace:string,token:string,legacy:string|undefined,pause:RelayDeliveryPause){
 managedArtifactTransport(url,workspace,token,legacy,pause)
 return async(operation:Record<string,unknown>)=>{
  await pause.beforeSend()
  const response=await fetch(new URL('/managed/recovery/candidate-adoption',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({...operation,schema:CANDIDATE_ADOPTION_SCHEMA,workspaceId:workspace})})
  if(response.status===429)await pause.record(response.headers.get('Retry-After'))
  if(!response.ok){await response.body?.cancel();throw new TaskConflict('Candidate retention approval is unconfirmed; inspect the original action')}
  const reader=response.body?.getReader();if(!reader)throw new TaskConflict('Missing retention response');let size=0;const chunks:Uint8Array[]=[]
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>64000){await reader.cancel();throw new TaskConflict('Retention response exceeds bounds')}chunks.push(p.value)}}finally{reader.releaseLock()}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))
 }
}
export function candidateAdoptionStatusTransport(call:ReturnType<typeof candidateAdoptionTransport>){return async(unit:RecoveryUnit,targets:FallbackTarget[])=>{
 recoveryUnitKey(unit);const results=[];for(const target of fallbackTargets(targets))results.push(parseAdoptionStatus(await call({action:'status',unit,target}),unit,target));return results
}}
export class CandidateAdoptionStudioBridge {
 constructor(private deps:{resolve:()=>Promise<{unit:RecoveryUnit;source:PackageSource}>;contexts:ReturnType<typeof targetContextStatusTransport>;call:ReturnType<typeof candidateAdoptionTransport>;enabled:()=>boolean;now?:()=>number}){}
 async perform(raw:unknown){
  if(!raw||typeof raw!=='object')throw new TaskConflict('Explicit candidate retention action required')
  const b=raw as any
  if(b.action==='approve'){recoveryExact(b,['action','unit','target','actionId','contextId','revision','confirmation']);if(!this.deps.enabled()||!recoveryId(b.contextId)||b.confirmation!==ADOPTION_CONFIRMATION)throw new TaskConflict('Separate exact retention approval is off or unconfirmed')}
  else if(b.action==='cancel')recoveryExact(b,['action','unit','target','actionId','revision'])
  else throw new TaskConflict('Exact candidate approval operation required')
  if(!recoveryId(b.actionId)||!Number.isSafeInteger(b.revision)||b.revision<0)throw new TaskConflict('Original approval identity and revision required')
  recoveryUnitKey(b.unit);const target=fallbackTargets([b.target])[0],before=await this.deps.resolve();if(recoveryUnitKey(b.unit)!==recoveryUnitKey(before.unit))throw new TaskConflict('Selected original task changed')
  if(b.action==='approve'){const [context]=await this.deps.contexts(before.unit,[target]);if(context.state!=='verified_declared_context'||context.receipt?.id!==b.contextId||canonicalJson(context.receipt.source)!==canonicalJson(before.source))throw new TaskConflict('Fresh exact context and real source required')}
  const operation=b.action==='approve'?{action:'approve',unit:before.unit,target,approval:{actionId:b.actionId,contextId:b.contextId,revision:b.revision,confirmation:b.confirmation}}:{action:'cancel',unit:before.unit,target,actionId:b.actionId,revision:b.revision}
  const result=parseAdoptionOperation(await this.deps.call(operation),before.unit,target,b.actionId),after=await this.deps.resolve()
  if(canonicalJson(result.action.context.source)!==canonicalJson(before.source)||recoveryUnitKey(after.unit)!==recoveryUnitKey(before.unit)||canonicalJson(after.source)!==canonicalJson(before.source))throw new TaskConflict('Source changed around approval; inspect the original charged action')
  return parseAdoptionStatus(await this.deps.call({action:'status',unit:before.unit,target}),before.unit,target,this.deps.now?.()??Date.now())
 }
}
