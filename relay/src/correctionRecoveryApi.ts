import {boundedBody} from './managedArtifactStorage'
import {TaskConflict,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {CORRECTION_SCHEMA,parseCorrectionFence} from '../../server/src/services/correctionRecoveryProtocol'
import {recoveryExact} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {recoveryUnitKey} from '../../server/src/services/automationRecoveryPolicy'
import type {CorrectionRecovery} from './correctionRecovery'
export async function correctionRecoveryApi(request:Request,actor:TaskPrincipal,recovery:CorrectionRecovery,workspace:string,enabled:boolean,effectGate?:(fence:any,actionId:string)=>void){
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,2100000)))}catch{throw new TaskConflict('Bounded correction request required')}
 recoveryExact(raw,['schema','action','fence','details']);if(raw.schema!==CORRECTION_SCHEMA)throw new TaskConflict('Exact correction schema required');const d=raw.details
 if(raw.action==='discover'){recoveryExact(d,[]);recoveryUnitKey(raw.fence);if(raw.fence.workspaceId!==workspace)throw new TaskConflict('Foreign correction workspace');return Response.json({schema:CORRECTION_SCHEMA,globalEnabled:enabled,admissionReady:false,record:recovery.discover(actor,raw.fence),budget:recovery.budget(raw.fence)})}
 const f=parseCorrectionFence(raw.fence);if(f.unit.workspaceId!==workspace)throw new TaskConflict('Foreign correction workspace')
 const stopping=raw.action==='control'&&d&&(d.enabled===false||d.paused===true||d.cancelled===true)
 if(!enabled&&!['inspect','commit','finish'].includes(raw.action)&&!stopping)return Response.json({error:'Correction recovery is off'},{status:503})
 if(raw.action==='start'||raw.action==='commit'&&recovery.discover(actor,f.unit)?.actions.find(a=>a.id===d?.actionId)?.phase!=='verified')effectGate?.(f,d?.actionId)
 switch(raw.action){
 case 'inspect':recoveryExact(d,[]);break
 case 'offer':recoveryExact(d,[]);recovery.offer(actor,f);break
 case 'control':recoveryExact(d,['revision','enabled','paused','cancelled']);recovery.control(actor,f,d.revision,d.enabled,d.paused,d.cancelled);break
 case 'reserve':recoveryExact(d,['revision','actionId']);recovery.reserve(actor,f,d.revision,d.actionId);break
 case 'start':recoveryExact(d,['actionId']);recovery.start(actor,f,d.actionId);break
 case 'finish':recoveryExact(d,['actionId','outcome']);recovery.finish(actor,f,d.actionId,d.outcome);break
 case 'commit':{recoveryExact(d,['actionId','eventId','checkpointRef','output']);const receipt=await recovery.commit(actor,f,d.actionId,d.eventId,d.checkpointRef,d.output,enabled,()=>effectGate?.(f,d.actionId));return Response.json({schema:CORRECTION_SCHEMA,globalEnabled:enabled,admissionReady:false,...receipt,budget:recovery.budget(f.unit)})}
 default:throw new TaskConflict('Exact correction action required')
 }
 return Response.json({schema:CORRECTION_SCHEMA,globalEnabled:enabled,...recovery.status(actor,f)})
}
