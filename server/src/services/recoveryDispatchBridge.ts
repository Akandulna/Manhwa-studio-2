import {DISPATCH_SCHEMA,DISPATCH_KINDS,parseDispatchTicket,type DispatchTicket} from './recoveryDispatchProtocol.js'
import {managedArtifactTransport} from './managedArtifactImport.js'
import {recoveryExact,recoveryId,recoveryHash} from './managedSavedImportRecoveryProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {TaskConflict} from './managedTaskProtocol.js'
import type {AutomationRecovery} from './automationRecovery.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
export interface DispatchGrant {kind:string;actionId:string;grantRevision:number;fenceSha256:string;deviceId:string;profileId:string}
export interface DispatchView {grants:DispatchGrant[];tickets:DispatchTicket[]}
export function recoveryDispatchTransport(url:string,workspace:string,token:string,legacy:string|undefined,pause:RelayDeliveryPause){
 managedArtifactTransport(url,workspace,token,legacy,pause)
 return async(action:string,unit:RecoveryUnit,details:Record<string,unknown>)=>{
  recoveryUnitKey(unit);if(unit.workspaceId!==workspace)throw new TaskConflict('Original dispatch workspace required');await pause.beforeSend()
  const r=await fetch(new URL('/managed/recovery/dispatch',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({schema:DISPATCH_SCHEMA,action,unit,details})})
  if(r.status===429)await pause.record(r.headers.get('Retry-After'))
  if(!r.ok){await r.body?.cancel();throw new TaskConflict('Dispatch receipt unconfirmed; inspect original intent')}
  const reader=r.body?.getReader();if(!reader)throw new TaskConflict('Missing dispatch receipt');let size=0;const chunks:Uint8Array[]=[]
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>256000){await reader.cancel();throw new TaskConflict('Bounded dispatch receipt required')}chunks.push(p.value)}}finally{reader.releaseLock()}
  const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));recoveryExact(v,['schema','globalEnabled','ticket','view'])
  if(v.schema!==DISPATCH_SCHEMA||typeof v.globalEnabled!=='boolean')throw new TaskConflict('Compatible dispatch receipt required')
  const ticket=v.ticket===null?null:parseDispatchTicket(v.ticket)
  let view:DispatchView|null=null
  if(v.view!==null){recoveryExact(v.view,['grants','tickets']);if(!Array.isArray(v.view.grants)||v.view.grants.length>5||!Array.isArray(v.view.tickets)||v.view.tickets.length>16)throw new TaskConflict('Bounded dispatch inventory required')
   for(const g of v.view.grants){recoveryExact(g,['kind','actionId','grantRevision','fenceSha256','deviceId','profileId']);if(!DISPATCH_KINDS.includes(g.kind)||![g.actionId,g.deviceId,g.profileId].every(recoveryId)||!recoveryHash(g.fenceSha256)||!Number.isSafeInteger(g.grantRevision)||g.grantRevision<1)throw new TaskConflict('Exact dispatch grant required')}
   view={grants:v.view.grants,tickets:v.view.tickets.map(parseDispatchTicket)}
  }
  for(const t of [...(ticket?[ticket]:[]),...(view?.tickets??[])])if(recoveryUnitKey(t.unit)!==recoveryUnitKey(unit))throw new TaskConflict('Foreign original dispatch receipt')
  if(action==='inspect'?!view||ticket!==null:!ticket||view!==null)throw new TaskConflict('Original dispatch response shape required')
  return {globalEnabled:v.globalEnabled as boolean,ticket,view}
 }
}
export class RecoveryDispatchBridge {
 constructor(private deps:{resolve:()=>Promise<{unit:RecoveryUnit;pageLabel:string}>;call:ReturnType<typeof recoveryDispatchTransport>;diagnoses:AutomationRecovery;enabled:()=>boolean}){}
 async perform(raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||JSON.stringify(raw).length>2000)throw new TaskConflict('Bounded dispatch intent required')
  const b=raw as Record<string,any>
  recoveryExact(b,b.action==='queue'?['action','kind','actionId','grantRevision','fenceSha256']:b.action==='cancel'?['action','ticketId','revision']:['action'])
  if(!['inspect','queue','cancel'].includes(b.action))throw new TaskConflict('Explicit dispatch action required')
  const source=await this.deps.resolve();let result=await this.deps.call('inspect',source.unit,{})
  if(b.action==='queue'){
   if(!this.deps.enabled()||!result.globalEnabled)throw new TaskConflict('Original phone dispatch is off')
   const g=result.view?.grants.find(g=>g.kind===b.kind&&g.actionId===b.actionId&&g.grantRevision===b.grantRevision&&g.fenceSha256===b.fenceSha256)
   if(!g)throw new TaskConflict('Inspect the exact unstarted approved grant')
   await this.deps.diagnoses.assertAdmission(source.unit)
   const current=await this.deps.resolve();if(recoveryUnitKey(current.unit)!==recoveryUnitKey(source.unit))throw new TaskConflict('Original source changed')
   await this.deps.diagnoses.assertAdmission(source.unit)
   await this.deps.call('queue',source.unit,{kind:g.kind,actionId:g.actionId,grantRevision:g.grantRevision,fenceSha256:g.fenceSha256})
   result=await this.deps.call('inspect',source.unit,{})
  }else if(b.action==='cancel'){
   if(!recoveryId(b.ticketId)||!Number.isSafeInteger(b.revision)||b.revision<1||!result.view?.tickets.some(t=>t.id===b.ticketId&&t.revision===b.revision))throw new TaskConflict('Inspect the original delivery revision')
   await this.deps.call('cancel',source.unit,{ticketId:b.ticketId,revision:b.revision});result=await this.deps.call('inspect',source.unit,{})
  }
  // Browser controls never need private grant fences.
  return {globalEnabled:this.deps.enabled()&&result.globalEnabled,pageLabel:source.pageLabel,grants:result.view!.grants,tickets:result.view!.tickets.map(({id,kind,actionId,deviceId,profileId,revision,queuedAt,expiresAt,phase})=>({id,kind,actionId,deviceId,profileId,revision,queuedAt,expiresAt,phase}))}
 }
}
