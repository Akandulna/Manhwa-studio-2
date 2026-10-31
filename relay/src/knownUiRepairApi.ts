import {boundedBody} from './managedArtifactStorage'
import {TaskConflict,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {UI_REPAIR_SCHEMA,parseUiRepairFence} from '../../server/src/services/knownUiRepairProtocol'
import {recoveryExact} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {recoveryUnitKey} from '../../server/src/services/automationRecoveryPolicy'
import type {KnownUiRepair} from './knownUiRepair'
export async function knownUiRepairApi(request:Request,actor:TaskPrincipal,recovery:KnownUiRepair,workspace:string,enabled:boolean,effectGate?:(fence:any,actionId:string)=>void){
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,12000)))}catch{throw new TaskConflict('Bounded original uiRepair request required')}
 recoveryExact(raw,['schema','action','fence','details']);if(raw.schema!==UI_REPAIR_SCHEMA)throw new TaskConflict('Exact uiRepair schema required');const d=raw.details
 if(raw.action==='discover'){recoveryExact(d,[]);recoveryUnitKey(raw.fence);if(raw.fence.workspaceId!==workspace)throw new TaskConflict('Foreign workspace');return Response.json({schema:UI_REPAIR_SCHEMA,globalEnabled:enabled,admissionReady:false,record:recovery.discover(actor,raw.fence),budget:recovery.budget(raw.fence)})}
 const f=parseUiRepairFence(raw.fence);if(f.unit.workspaceId!==workspace)throw new TaskConflict('Foreign workspace')
 const stopping=raw.action==='control'&&d&&(d.enabled===false||d.paused===true||d.cancelled===true)
 if(!enabled&&!['inspect','finish'].includes(raw.action)&&!stopping)return Response.json({error:'Original uiRepair recovery is disabled'},{status:503})
 if(['start','check'].includes(raw.action))effectGate?.(f,d?.actionId)
 switch(raw.action){
 case 'inspect':recoveryExact(d,[]);break
 case 'offer':recoveryExact(d,['proof']);recovery.offer(actor,f,d.proof);break
 case 'control':recoveryExact(d,['revision','enabled','paused','cancelled']);recovery.control(actor,f,d.revision,d.enabled,d.paused,d.cancelled);break
 case 'reserve':recoveryExact(d,['revision','actionId']);recovery.reserve(actor,f,d.revision,d.actionId);break
 case 'start':recoveryExact(d,['actionId','proof']);recovery.start(actor,f,d.actionId,d.proof);break
 case 'check':recoveryExact(d,['actionId','proof']);recovery.check(actor,f,d.actionId,d.proof);break
 case 'finish':{recoveryExact(d,['actionId','outcome','effect','proof']);const record=recovery.finish(actor,f,d.actionId,d.outcome,d.effect,d.proof);return Response.json({schema:UI_REPAIR_SCHEMA,globalEnabled:enabled,admissionReady:false,record,budget:recovery.budget(f.unit)})}
 default:throw new TaskConflict('Original uiRepair operation required')
 }
 return Response.json({schema:UI_REPAIR_SCHEMA,globalEnabled:enabled,...recovery.status(actor,f)})
}
