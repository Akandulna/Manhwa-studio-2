import {managedArtifactTransport} from './managedArtifactImport.js'
import {CONVERSATION_SCHEMA,parseConversationRecord,type ConversationRecord,type RestorationFence} from './conversationRestorationProtocol.js'
import {parseRecoveryBudget,recoveryUnitKey,type RecoveryUnit,type RecoveryBudget} from './automationRecoveryPolicy.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {canonicalJson,TaskConflict} from './managedTaskProtocol.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
import type {AutomationRecovery} from './automationRecovery.js'
export interface ConversationView {record:ConversationRecord|null;budget:RecoveryBudget;globalEnabled:boolean;admissionReady:boolean}
export function conversationRestorationTransport(url:string,workspace:string,token:string,legacy:string|undefined,pause:RelayDeliveryPause){
 managedArtifactTransport(url,workspace,token,legacy,pause)
 return async(action:string,fence:RecoveryUnit|RestorationFence,details:Record<string,unknown>):Promise<ConversationView>=>{
  const unit='unit' in fence?fence.unit:fence;recoveryUnitKey(unit);if(unit.workspaceId!==workspace)throw new TaskConflict('Foreign conversation restoration workspace')
  await pause.beforeSend()
  const r=await fetch(new URL('/managed/recovery/original-conversation',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({schema:CONVERSATION_SCHEMA,action,fence,details})})
  if(r.status===429)await pause.record(r.headers.get('Retry-After'))
  if(!r.ok){await r.body?.cancel();throw new TaskConflict('Original conversation restoration authority unavailable; original grants remain retained')}
  const reader=r.body?.getReader();if(!reader)throw new TaskConflict('Missing conversation restoration receipt');let size=0;const chunks:Uint8Array[]=[]
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>64000){await reader.cancel();throw new TaskConflict('Correction receipt exceeds bounds')}chunks.push(p.value)}}finally{reader.releaseLock()}
  const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))
  if(v.schema!==CONVERSATION_SCHEMA||typeof v.globalEnabled!=='boolean'||typeof v.admissionReady!=='boolean')throw new TaskConflict('Compatible conversation restoration response required')
  const record=v.record===null?null:parseConversationRecord(v.record)
  if(record&&(recoveryUnitKey(record.fence.unit)!==recoveryUnitKey(unit)||action!=='discover'&&canonicalJson(record.fence)!==canonicalJson(fence)))throw new TaskConflict('Original view/attempt receipt mismatch')
  return {record,budget:parseRecoveryBudget(v.budget),globalEnabled:v.globalEnabled,admissionReady:v.admissionReady}
 }
}
export class ConversationRestorationBridge {
 constructor(private deps:{resolve:()=>Promise<{unit:RecoveryUnit;pageLabel:string}>;call:ReturnType<typeof conversationRestorationTransport>;diagnoses:AutomationRecovery;enabled:()=>boolean}){}
 async perform(raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||JSON.stringify(raw).length>12000)throw new TaskConflict('Bounded exact conversation restoration approval required')
  const b=raw as Record<string,any>;recoveryExact(b,'actionId'in b?['action','fence','expectedRevision','actionId']:['action','fence','expectedRevision'])
  if(!['inspect','enable','reserve','pause','cancel'].includes(b.action)||!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<0||b.action==='reserve'&&!recoveryId(b.actionId)||'actionId'in b&&b.action!=='reserve')throw new TaskConflict('Exact conversation restoration action required')
  const source=await this.deps.resolve();let view=await this.deps.call('discover',source.unit,{})
  if(b.action!=='inspect'){
   const r=view.record;if(!r||canonicalJson(r.fence)!==canonicalJson(b.fence)||r.revision!==b.expectedRevision)throw new TaskConflict('Inspect the exact original private conversation anchor before approving')
   if(['enable','reserve'].includes(b.action)){
    if(!this.deps.enabled()||!view.globalEnabled)throw new TaskConflict('Correction recovery is off')
    await this.deps.diagnoses.assertAdmission(source.unit)
    const current=await this.deps.resolve();if(recoveryUnitKey(current.unit)!==recoveryUnitKey(source.unit))throw new TaskConflict('Original input or owner changed')
    await this.deps.diagnoses.assertAdmission(source.unit)
   }
   view=b.action==='reserve'?await this.deps.call('reserve',r.fence,{revision:r.revision,actionId:b.actionId}):await this.deps.call('control',r.fence,{revision:r.revision,enabled:b.action==='enable'?true:b.action==='cancel'?false:r.enabled,paused:b.action==='pause'?true:b.action==='enable'?false:r.paused,cancelled:b.action==='cancel'})
  }
  return {...view,pageLabel:source.pageLabel,globalEnabled:this.deps.enabled()&&view.globalEnabled}
 }
}
