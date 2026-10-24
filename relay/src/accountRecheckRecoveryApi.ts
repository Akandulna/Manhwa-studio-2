import type {TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {TaskConflict} from '../../server/src/services/managedTaskProtocol'
import {recoveryUnitKey} from '../../server/src/services/automationRecoveryPolicy'
import {recoveryExact} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {ACCOUNT_RECHECK_SCHEMA,parseAccountRecheckFence} from '../../server/src/services/accountRecheckRecoveryProtocol'
import {boundedBody} from './managedArtifactStorage'
import type {AccountRecheckRecovery} from './accountRecheckRecovery'
export async function accountRecheckRecoveryApi(request:Request,actor:TaskPrincipal,recovery:AccountRecheckRecovery,workspace:string,enabled:boolean){
 if(actor.role!=='studio')return Response.json({error:'Automation Manager authority required'},{status:403})
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,12000)))}catch{throw new TaskConflict('Bounded account recheck request required')}
 recoveryExact(raw,['schema','action','fence','details']);const d=raw.details
 if(raw.schema!==ACCOUNT_RECHECK_SCHEMA)throw new TaskConflict('Exact account recheck schema required')
 if(raw.action==='discover'){
  recoveryExact(d,[]);recoveryUnitKey(raw.fence)
  if(raw.fence.workspaceId!==workspace)throw new TaskConflict('Foreign account recovery workspace')
  return Response.json({schema:ACCOUNT_RECHECK_SCHEMA,globalEnabled:enabled,...recovery.discover(actor,raw.fence)})
 }
 const f=parseAccountRecheckFence(raw.fence)
 if(f.unit.workspaceId!==workspace)throw new TaskConflict('Foreign account recovery workspace')
 const stop=raw.action==='control'&&d&&(d.enabled===false||d.paused===true||d.cancelled===true)
 if(!enabled&&!['inspect'].includes(raw.action)&&!stop)return Response.json({error:'Account recheck recovery is disabled'},{status:503})
 switch(raw.action){
 case 'inspect':recoveryExact(d,[]);break
 case 'control':recoveryExact(d,['revision','enabled','paused','cancelled']);recovery.control(actor,f,d.revision,d.enabled,d.paused,d.cancelled);break
 case 'request':recoveryExact(d,['revision','actionId']);recovery.request(actor,f,d.revision,d.actionId);break
 default:throw new TaskConflict('Unsupported account recovery operation')
 }
 return Response.json({schema:ACCOUNT_RECHECK_SCHEMA,globalEnabled:enabled,...recovery.status(actor,f)})
}
