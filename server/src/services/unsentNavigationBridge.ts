import {managedArtifactTransport} from './managedArtifactImport.js'
import {NAVIGATION_SCHEMA,parseNavigationRecord,type NavigationRecord,type NavigationFence} from './unsentNavigationProtocol.js'
import {parseRecoveryBudget,recoveryUnitKey,type RecoveryUnit,type RecoveryBudget} from './automationRecoveryPolicy.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {canonicalJson,TaskConflict} from './managedTaskProtocol.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
import type {AutomationRecovery} from './automationRecovery.js'
export interface NavigationView {record:NavigationRecord|null;budget:RecoveryBudget;globalEnabled:boolean;admissionReady:boolean}
export function unsentNavigationTransport(url:string,workspace:string,token:string,legacy:string|undefined,pause:RelayDeliveryPause){
 managedArtifactTransport(url,workspace,token,legacy,pause)
 return async(action:string,fence:RecoveryUnit|NavigationFence,details:Record<string,unknown>):Promise<NavigationView>=>{
  const unit='unit' in fence?fence.unit:fence;recoveryUnitKey(unit);if(unit.workspaceId!==workspace)throw new TaskConflict('Foreign navigation workspace')
  await pause.beforeSend()
  const r=await fetch(new URL('/managed/recovery/unsent-navigation',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({schema:NAVIGATION_SCHEMA,action,fence,details})})
  if(r.status===429)await pause.record(r.headers.get('Retry-After'))
  if(!r.ok){await r.body?.cancel();throw new TaskConflict('Original navigation authority unavailable; original grants remain retained')}
  const reader=r.body?.getReader();if(!reader)throw new TaskConflict('Missing navigation receipt');let size=0;const chunks:Uint8Array[]=[]
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>64000){await reader.cancel();throw new TaskConflict('Navigation receipt exceeds bounds')}chunks.push(p.value)}}finally{reader.releaseLock()}
  const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))
  if(v.schema!==NAVIGATION_SCHEMA||typeof v.globalEnabled!=='boolean'||typeof v.admissionReady!=='boolean')throw new TaskConflict('Compatible navigation response required')
  const record=v.record===null?null:parseNavigationRecord(v.record)
  if(record&&(recoveryUnitKey(record.fence.unit)!==recoveryUnitKey(unit)||action!=='discover'&&canonicalJson(record.fence)!==canonicalJson(fence)))throw new TaskConflict('Original view/attempt receipt mismatch')
  return {record,budget:parseRecoveryBudget(v.budget),globalEnabled:v.globalEnabled,admissionReady:v.admissionReady}
 }
}
export class UnsentNavigationBridge {
 constructor(private deps:{resolve:()=>Promise<{unit:RecoveryUnit;pageLabel:string}>;call:ReturnType<typeof unsentNavigationTransport>;diagnoses:AutomationRecovery;enabled:()=>boolean;now?:()=>number}){}
 async perform(raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||JSON.stringify(raw).length>8000)throw new TaskConflict('Bounded original navigation controls required')
  const b=raw as Record<string,any>;recoveryExact(b,'actionId'in b?['action','fence','expectedRevision','actionId']:['action','fence','expectedRevision'])
  if(!['inspect','enable','reserve','pause','cancel'].includes(b.action)||!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<0||b.action==='reserve'&&!recoveryId(b.actionId)||'actionId'in b&&b.action!=='reserve')throw new TaskConflict('Exact navigation action required')
  const source=await this.deps.resolve();let view=await this.deps.call('discover',source.unit,{})
  if(b.action!=='inspect'){
   const r=view.record;if(!r||canonicalJson(r.fence)!==canonicalJson(b.fence)||r.revision!==b.expectedRevision)throw new TaskConflict('Inspect the original phone navigation offer')
   if(['enable','reserve'].includes(b.action)){
    if(!this.deps.enabled()||!view.globalEnabled)throw new TaskConflict('Original navigation recovery is off')
    await this.deps.diagnoses.assertAdmission(source.unit,b.action==='reserve'?'navigate':undefined)
    const current=await this.deps.resolve();if(recoveryUnitKey(current.unit)!==recoveryUnitKey(source.unit))throw new TaskConflict('Input/owner changed before navigation grant')
   }
   if(b.action==='reserve'){
    const d=await this.deps.diagnoses.inspect(source.unit);if(!d?.enabled||d.paused||d.cancelled)throw new TaskConflict('Explicit Automation admission required')
    await this.deps.diagnoses.assertAdmission(source.unit,b.action==='reserve'?'navigate':undefined)
    view=await this.deps.call('reserve',r.fence,{revision:r.revision,actionId:b.actionId})
   }else view=await this.deps.call('control',r.fence,{revision:r.revision,enabled:b.action==='enable'?true:r.enabled,paused:b.action==='pause'?true:b.action==='enable'?false:r.paused,cancelled:b.action==='cancel'})
  }
  if(view.record){view=await this.deps.call('inspect',view.record.fence,{})}
  const r=view.record,now=(this.deps.now??Date.now)();let diagnosis=null
  if(r){
   const last=r.actions.at(-1),known=view.admissionReady
   diagnosis=await this.deps.diagnoses.observeInspection(source.unit,{reference:'unsent-navigation/inspection',observedAt:now,failure:'executor_stopped',outcome:'unsent',inputCurrent:true,reviewRequired:last?.phase==='verified'||!known&&!view.budget.pending,canonical:false,localState:'unknown',savedCheckpoint:false,login:known?'signed_in':'unknown',quota:known?'available':'unknown',quotaScope:null,recheckAt:null,pageExpected:known,profileExpected:known,loading:false,precedingActionReconciled:known,knownRepair:false,uiChangeId:null,adapterScope:'original-unsent-navigation',contextVerified:known,contextPortable:false,policyAllowsAlternative:false,correctionAllowed:false,acceptedUnitsPreserved:true,safeReleaseVerified:false,deviceReachable:false},view.budget)
   if(['enable','pause','cancel'].includes(b.action))diagnosis=await this.deps.diagnoses.control(source.unit,diagnosis.revision,{enabled:b.action==='enable'?true:diagnosis.enabled,paused:b.action==='pause'?true:b.action==='enable'?false:diagnosis.paused,cancelled:b.action==='cancel'})
  }
  return {...view,diagnosis,pageLabel:source.pageLabel,observedAt:now,globalEnabled:this.deps.enabled()&&view.globalEnabled}
 }
}
