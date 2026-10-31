import {DISPATCH_SCHEMA} from '../../server/src/services/recoveryDispatchProtocol'
import {recoveryExact} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {recoveryUnitKey} from '../../server/src/services/automationRecoveryPolicy'
import {TaskConflict,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {boundedBody} from './managedArtifactStorage'
import type {RecoveryDispatch} from './recoveryDispatch'
export async function recoveryDispatchApi(request:Request,actor:TaskPrincipal,dispatch:RecoveryDispatch,workspace:string,enabled:boolean){
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,8000)))}catch{throw new TaskConflict('Bounded original dispatch request required')}
 recoveryExact(raw,['schema','action','unit','details']);recoveryUnitKey(raw.unit);if(raw.schema!==DISPATCH_SCHEMA||raw.unit.workspaceId!==workspace)throw new TaskConflict('Exact dispatch schema/workspace required');const d=raw.details
 if(d&&typeof d==='object'&&'ticketId'in d&&recoveryUnitKey(dispatch.ticket(actor,d.ticketId).unit)!==recoveryUnitKey(raw.unit))throw new TaskConflict('Original dispatch unit mismatch')
 let ticket=null,view=null
 switch(raw.action){
 case 'inspect':recoveryExact(d,[]);view=await dispatch.inspect(actor,raw.unit);break
 case 'queue':recoveryExact(d,['kind','actionId','grantRevision','fenceSha256']);ticket=await dispatch.queue(actor,raw.unit,d.kind,d.actionId,d.grantRevision,d.fenceSha256);break
 case 'next':recoveryExact(d,['commandId','profileId']);ticket=dispatch.next(actor,raw.unit,d.commandId,d.profileId);break
 case 'receipt':recoveryExact(d,['ticketId']);ticket=dispatch.ticket(actor,d.ticketId);break
 case 'claim':recoveryExact(d,['ticketId','claimId']);ticket=dispatch.claim(actor,d.ticketId,d.claimId);break
 case 'check':recoveryExact(d,['ticketId','claimId']);ticket=dispatch.check(actor,d.ticketId,d.claimId);break
 case 'complete':recoveryExact(d,['ticketId','claimId','outcome']);ticket=dispatch.complete(actor,d.ticketId,d.claimId,d.outcome);break
 case 'cancel':recoveryExact(d,['ticketId','revision']);ticket=dispatch.cancel(actor,d.ticketId,d.revision);break
 default:throw new TaskConflict('Exact original delivery action required')
 }
 if(ticket&&recoveryUnitKey(ticket.unit)!==recoveryUnitKey(raw.unit))throw new TaskConflict('Original dispatch unit mismatch')
 return Response.json({schema:DISPATCH_SCHEMA,globalEnabled:enabled,ticket,view})
}
