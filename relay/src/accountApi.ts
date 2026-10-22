import {AccountAuthority} from './accountAuthority'
import {boundedBody} from './managedArtifactStorage'
import {TaskConflict,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {ACCOUNTS_SCHEMA,exact,accountIdValid as id,accountObservation,parseAccountQuota} from '../../server/src/services/managedAccountsProtocol'
export async function accountApi(request:Request,actor:TaskPrincipal,authority:AccountAuthority,workspace:string,now:number):Promise<Response> {
 const url=new URL(request.url)
 if(url.search)throw new TaskConflict('Unexpected account query')
 if(request.method==='GET'&&url.pathname==='/managed/accounts'){if(actor.role!=='studio')return Response.json({error:'Studio authority required'},{status:403});return Response.json({schema:ACCOUNTS_SCHEMA,result:authority.snapshot(actor)})}
 if(request.method!=='POST'||url.pathname!=='/managed/accounts/operation')return new Response('Not found',{status:404})
 let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,32_000)))}catch{throw new TaskConflict('Bounded account JSON required')}
 if(!raw||raw.schema!==ACCOUNTS_SCHEMA||raw.workspaceId!==workspace||!id(raw.eventId))throw new TaskConflict('Exact account schema, workspace and event required')
 const {schema,workspaceId,eventId,action,...fields}=raw
 const studio=['policy','confirm','quota','cadence','observe','select','audit_recheck'],phone=['audit_claim','audit_finish','audit_defer','observe','quota']
 if(!(actor.role==='studio'?studio:phone).includes(action))return Response.json({error:'Account operation not authorized'},{status:403})
 let result:unknown
 switch(action){
 case 'policy':exact(fields,['policy']);result=authority.setPolicy(actor,eventId,fields.policy);break
 case 'confirm':exact(fields,['deviceId','profileId','product','candidate','accountId','maxConcurrent']);if(typeof fields.candidate!=='string'||fields.candidate.length>80)throw new TaskConflict('Exact candidate required');result=authority.confirm(actor,eventId,fields.deviceId,fields.profileId,fields.product,fields.candidate,fields.accountId,fields.maxConcurrent);break
 case 'cadence':exact(fields,['deviceId','profileId','hours']);result=authority.cadence(actor,eventId,fields.deviceId,fields.profileId,fields.hours);break
 case 'audit_recheck':exact(fields,['deviceId','profileId']);result=authority.requestAudit(actor,eventId,fields.deviceId,fields.profileId);break
 case 'observe':exact(fields,['deviceId','profileId','check']);result=authority.observe(actor,eventId,fields.deviceId,fields.profileId,await accountObservation(fields.check,now));break
 case 'quota':exact(fields,['profileId','quota']);if(!(fields.profileId===null||id(fields.profileId)))throw new TaskConflict('Exact quota profile required');result=authority.quota(actor,eventId,fields.profileId,parseAccountQuota(fields.quota,now));break
 case 'audit_claim':exact(fields,['profileId']);result=authority.auditClaim(actor,eventId,fields.profileId);break
 case 'audit_defer':exact(fields,['profileId','reason']);if(!['busy','interrupted'].includes(fields.reason))throw new TaskConflict('Known audit deferral required');result=authority.auditDefer(actor,eventId,fields.profileId,fields.reason);break
 case 'audit_finish':exact(fields,['auditId','check']);if(!id(fields.auditId))throw new TaskConflict('Exact audit ID required');result=authority.auditFinish(actor,eventId,fields.auditId,fields.check===null?null:await accountObservation(fields.check,now));break
 // Selection needs a real immutable task. The caller injects it below, never a browser-provided spec.
 default:throw new TaskConflict('Unsupported account action')
 }
 return Response.json({schema:ACCOUNTS_SCHEMA,result})
}
