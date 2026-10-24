import {managedArtifactTransport} from './managedArtifactImport.js'
import {CONVERSATION_SCHEMA,type ConversationFence} from './conversationRestorationProtocol.js'
import {parseRetainedBindingRecord,sameRetainedBindingOffer,type RetainedBindingRecord} from './retainedContextBindingProtocol.js'
import {parseRecoveryBudget,recoveryUnitKey,type RecoveryUnit,type RecoveryBudget} from './automationRecoveryPolicy.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {canonicalJson,TaskConflict} from './managedTaskProtocol.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
import type {AutomationRecovery} from './automationRecovery.js'
export interface RetainedBindingView {binding:RetainedBindingRecord|null;budget:RecoveryBudget;globalEnabled:boolean;admissionReady:boolean}
export function parseRetainedBindingView(raw:unknown,unit:RecoveryUnit,fence?:ConversationFence):RetainedBindingView {
 recoveryExact(raw,raw&&typeof raw==='object'&&'admissionReady'in raw?['schema','globalEnabled','binding','permit','budget','admissionReady']:['schema','globalEnabled','binding','permit','budget'])
 const v=raw as Record<string,any>
 if(!v||v.schema!==CONVERSATION_SCHEMA||typeof v.globalEnabled!=='boolean'||v.permit!==null||'admissionReady'in v&&typeof v.admissionReady!=='boolean')throw new TaskConflict('Compatible non-executable binding receipt required')
 const binding=v.binding===null?null:parseRetainedBindingRecord(v.binding)
 if(binding&&(recoveryUnitKey(binding.fence.unit)!==recoveryUnitKey(unit)||fence&&canonicalJson(binding.fence)!==canonicalJson(fence)))throw new TaskConflict('Original binding receipt mismatch')
 return {binding,budget:parseRecoveryBudget(v.budget),globalEnabled:v.globalEnabled,admissionReady:v.admissionReady===true}
}
/** One HTTP transmission, no admission retry and no provider/execution permit consumption. */
export function retainedBindingApprovalTransport(url:string,workspace:string,token:string,legacy:string|undefined,pause:RelayDeliveryPause){
 managedArtifactTransport(url,workspace,token,legacy,pause)
 return async(action:string,fence:RecoveryUnit|ConversationFence,details:Record<string,unknown>):Promise<RetainedBindingView>=>{
  if(!['discover-binding','control-binding','reserve-binding'].includes(action))throw new TaskConflict('Studio binding approval operations only')
  const unit='unit'in fence?fence.unit:fence;recoveryUnitKey(unit)
  if(unit.workspaceId!==workspace)throw new TaskConflict('Foreign binding workspace')
  await pause.beforeSend()
  const response=await fetch(new URL('/managed/recovery/original-conversation',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({schema:CONVERSATION_SCHEMA,action,fence,details})})
  if(response.status===429)await pause.record(response.headers.get('Retry-After'))
  if(!response.ok){await response.body?.cancel();throw new TaskConflict('Binding receipt is unconfirmed; inspect the original action')}
  const reader=response.body?.getReader();if(!reader)throw new TaskConflict('Missing binding receipt')
  let size=0;const chunks:Uint8Array[]=[]
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>64000){await reader.cancel();throw new TaskConflict('Binding receipt exceeds bounds')}chunks.push(p.value)}}finally{reader.releaseLock()}
  const view=parseRetainedBindingView(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),unit,'unit'in fence?fence:undefined)
  if(action==='discover-binding'&&view.binding===null&&view.admissionReady)throw new TaskConflict('Missing ready binding')
  return view
 }
}
export class RetainedBindingApprovalBridge {
 constructor(private deps:{resolve:()=>Promise<{unit:RecoveryUnit;pageLabel:string}>;call:ReturnType<typeof retainedBindingApprovalTransport>;diagnoses:Pick<AutomationRecovery,'assertAdmission'>;enabled:()=>boolean}){}
 async perform(raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||JSON.stringify(raw).length>12000)throw new TaskConflict('Bounded exact binding approval required')
  const b=structuredClone(raw) as Record<string,any>
  recoveryExact(b,'actionId'in b?['action','fence','candidateId','expectedRevision','actionId']:['action','fence','candidateId','expectedRevision'])
  if(!['inspect','enable','reserve','pause','disable','cancel'].includes(b.action)||!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<0||b.action==='reserve'&&!recoveryId(b.actionId)||'actionId'in b&&b.action!=='reserve')throw new TaskConflict('Exact binding action required')
  const source=await this.deps.resolve();let view=await this.deps.call('discover-binding',source.unit,{})
  const sameSource=async()=>{const current=await this.deps.resolve();if(recoveryUnitKey(current.unit)!==recoveryUnitKey(source.unit))throw new TaskConflict('Original page or attempt changed')}
  // Inspections and stop controls are available while admission is off, but never target another offer.
  if(b.action!=='inspect'){
   const r=view.binding
   if(!r||canonicalJson(r.fence)!==canonicalJson(b.fence)||r.candidateId!==b.candidateId||r.revision!==b.expectedRevision)throw new TaskConflict('Inspect this exact retained binding offer and revision')
   await sameSource()
   if(['enable','reserve'].includes(b.action)){
    if(!this.deps.enabled()||!view.globalEnabled||!view.admissionReady&&!(b.action==='enable'&&r.paused&&!r.cancelled&&!r.actions.length))throw new TaskConflict('Retained binding admission is off or not ready')
    await this.deps.diagnoses.assertAdmission(source.unit);await sameSource();await this.deps.diagnoses.assertAdmission(source.unit)
   }
   const changed=await this.deps.call(b.action==='reserve'?'reserve-binding':'control-binding',r.fence,b.action==='reserve'?{revision:r.revision,actionId:b.actionId}:{revision:r.revision,enabled:b.action==='enable'?true:['disable','cancel'].includes(b.action)?false:r.enabled,paused:b.action==='pause'?true:b.action==='enable'?false:r.paused,cancelled:b.action==='cancel'||r.cancelled})
   const updated=changed.binding
   if(!updated||!sameRetainedBindingOffer(updated,r.fence,r.inspection,r.target,r.candidateId)||updated.revision<=r.revision)throw new TaskConflict('Binding approval receipt changed its immutable offer or revision')
   if(b.action==='reserve'?updated.actions[0]?.id!==b.actionId||updated.actions[0]?.phase!=='reserved':b.action==='enable'?!updated.enabled||updated.paused||updated.cancelled:b.action==='pause'?!updated.paused:b.action==='disable'?updated.enabled:!updated.cancelled||updated.enabled)throw new TaskConflict('Binding approval outcome is unconfirmed')
   // Read back after a mutation; a lost receipt never triggers another mutation.
   view=await this.deps.call('discover-binding',source.unit,{})
   if(!view.binding||!sameRetainedBindingOffer(view.binding,r.fence,r.inspection,r.target,r.candidateId))throw new TaskConflict('Inspect the original binding receipt')
  }
  await sameSource()
  return {...view,pageLabel:source.pageLabel,globalEnabled:this.deps.enabled()&&view.globalEnabled}
 }
}
