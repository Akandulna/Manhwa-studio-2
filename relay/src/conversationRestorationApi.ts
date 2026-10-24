import {boundedBody} from './managedArtifactStorage'
import {TaskConflict,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {CONVERSATION_SCHEMA,parseConversationFence,parseRestorationFence} from '../../server/src/services/conversationRestorationProtocol'
import {recoveryExact} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {recoveryUnitKey} from '../../server/src/services/automationRecoveryPolicy'
import type {ConversationRestoration} from './conversationRestoration'
export async function conversationRestorationApi(request:Request,actor:TaskPrincipal,recovery:ConversationRestoration,workspace:string,enabled:boolean,effectGate?:(fence:any,actionId:string)=>void,localCorrection?:{enabled:boolean;effect:(fence:any,actionId:string)=>void}){
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,12000)))}catch{throw new TaskConflict('Bounded original conversation request required')}
 recoveryExact(raw,['schema','action','fence','details']);if(raw.schema!==CONVERSATION_SCHEMA)throw new TaskConflict('Exact conversation schema required');const d=raw.details
 if(raw.action==='discover-binding'){recoveryExact(d,[]);recoveryUnitKey(raw.fence);if(raw.fence.workspaceId!==workspace)throw new TaskConflict('Foreign workspace');return Response.json({schema:CONVERSATION_SCHEMA,globalEnabled:enabled,...recovery.bindingStatus(actor,raw.fence)},{headers:{'Cache-Control':'no-store'}})}
 if(raw.action==='discover'){recoveryExact(d,[]);recoveryUnitKey(raw.fence);if(raw.fence.workspaceId!==workspace)throw new TaskConflict('Foreign workspace');const record=recovery.discover(actor,raw.fence);return Response.json({schema:CONVERSATION_SCHEMA,globalEnabled:enabled,...(record?recovery.status(actor,record.fence):{admissionReady:false,record:null,budget:recovery.budget(raw.fence)})},{headers:{'Cache-Control':'no-store'}})}
 const f=parseRestorationFence(raw.fence);if(f.unit.workspaceId!==workspace)throw new TaskConflict('Foreign workspace')
 if(f.retained&&!['inspect','offer','control','reserve','start','check','finish'].includes(raw.action))throw new TaskConflict('Retained restoration fence cannot authorize another operation')
 const stopping=['control','control-binding'].includes(raw.action)&&d&&(d.enabled===false||d.paused===true||d.cancelled===true)
 if(!enabled&&!['inspect','finish','verify-retained-context','verify-retained-target','offer-binding','inspect-binding','finish-binding'].includes(raw.action)&&!stopping)return Response.json({error:'Original conversation recovery is disabled'},{status:503})
 if(['start','check'].includes(raw.action))effectGate?.(f,d?.actionId)
 switch(raw.action){
 case 'check-binding-correction':{
  if(!localCorrection?.enabled)return Response.json({error:'Local correction consumer is off'},{status:503})
  recoveryExact(d,['bindingActionId','correctionFence','correctionActionId','proof'])
  localCorrection.effect(d.correctionFence,d.correctionActionId)
  const permit=await recovery.checkRetainedCorrection(actor,f,d)
  localCorrection.effect(d.correctionFence,d.correctionActionId)
  return Response.json({schema:CONVERSATION_SCHEMA,consumer:'retained-binding-local-correction/1',permit},{headers:{'Cache-Control':'no-store'}})
 }
 case 'offer-binding':{recoveryExact(d,['inspection','target','candidateId']);const record=recovery.offerBinding(actor,f,d.inspection,d.target,d.candidateId);return Response.json({schema:CONVERSATION_SCHEMA,globalEnabled:enabled,binding:record,permit:null,budget:recovery.budget(f.unit)},{headers:{'Cache-Control':'no-store'}})}
 case 'inspect-binding':case 'control-binding':case 'reserve-binding':case 'start-binding':case 'check-binding':case 'finish-binding':{
  if(raw.action==='inspect-binding')recoveryExact(d,[])
  const result=recovery.binding(actor,f,raw.action,d);return Response.json({schema:CONVERSATION_SCHEMA,globalEnabled:enabled,binding:result.record,permit:result.permit,budget:recovery.budget(f.unit)},{headers:{'Cache-Control':'no-store'}})
 }
 case 'verify-retained-target':{recoveryExact(d,['inspection','target']);const verification=await recovery.verifyRetainedTarget(actor,f,d.inspection,d.target);return Response.json({schema:CONVERSATION_SCHEMA,globalEnabled:enabled,verification},{headers:{'Cache-Control':'no-store'}})}
 case 'verify-retained-context':{recoveryExact(d,['inspection']);const verification=await recovery.verifyRetainedContext(actor,f,d.inspection);return Response.json({schema:CONVERSATION_SCHEMA,globalEnabled:enabled,verification},{headers:{'Cache-Control':'no-store'}})}
 case 'inspect':recoveryExact(d,[]);break
 case 'offer':recoveryExact(d,['proof']);recovery.offer(actor,f,d.proof);break
 case 'control':recoveryExact(d,['revision','enabled','paused','cancelled']);recovery.control(actor,f,d.revision,d.enabled,d.paused,d.cancelled);break
 case 'reserve':recoveryExact(d,['revision','actionId']);recovery.reserve(actor,f,d.revision,d.actionId);break
 case 'start':recoveryExact(d,['actionId','proof']);recovery.start(actor,f,d.actionId,d.proof);break
 case 'check':{recoveryExact(d,['actionId','proof']);if(f.retained){const navigationPermit=recovery.retainedNavigationPermit(actor,f,d.actionId,d.proof);return Response.json({schema:CONVERSATION_SCHEMA,globalEnabled:enabled,...recovery.status(actor,f),navigationPermit},{headers:{'Cache-Control':'no-store'}})}recovery.check(actor,f,d.actionId,d.proof);break}
 case 'finish':{recoveryExact(d,['actionId','outcome','effect','proof']);const record=recovery.finish(actor,f,d.actionId,d.outcome,d.effect,d.proof);return Response.json({schema:CONVERSATION_SCHEMA,globalEnabled:enabled,admissionReady:false,record,budget:recovery.budget(f.unit)})}
 default:throw new TaskConflict('Original conversation operation required')
 }
 return Response.json({schema:CONVERSATION_SCHEMA,globalEnabled:enabled,...recovery.status(actor,f)})
}
