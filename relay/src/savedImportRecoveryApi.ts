import {boundedBody,readManagedArtifact,type ManagedArtifactBucket} from './managedArtifactStorage'
import {TaskConflict,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {SAVED_IMPORT_SCHEMA,parseSavedImportFence,recoveryExact} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import type {SavedImportRecovery} from './savedImportRecovery'
export async function savedImportRecoveryApi(request:Request,actor:TaskPrincipal,recovery:SavedImportRecovery,workspace:string,bucket?:ManagedArtifactBucket,enabled=false):Promise<Response>{
 if(actor.role!=='studio')return Response.json({error:'Studio recovery owner required'},{status:403})
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,8000)))}catch{throw new TaskConflict('Bounded recovery JSON required')}
 recoveryExact(raw,['schema','action','fence','destinationId','details'])
 const f=parseSavedImportFence(raw.fence)
 if(raw.schema!==SAVED_IMPORT_SCHEMA||f.workspaceId!==workspace)throw new TaskConflict('Exact recovery schema/workspace required')
 const d=raw.details;let result:unknown
 if(!enabled&&!['inspect','finish'].includes(raw.action))return Response.json({error:'Saved import recovery is disabled'},{status:503})
 switch(raw.action){
 case 'inspect':recoveryExact(d,[]);result=recovery.inspect(actor,f,raw.destinationId);break
 case 'control':recoveryExact(d,['revision','enabled','paused','cancelled']);result=recovery.control(actor,f,raw.destinationId,d.revision,d.enabled,d.paused,d.cancelled);break
 case 'reserve':recoveryExact(d,['actionId']);result=recovery.reserve(actor,f,raw.destinationId,d.actionId);break
 case 'start': {
  recoveryExact(d,['actionId'])
  if(!bucket)throw new TaskConflict('Artifact storage unavailable')
  const p=recovery.publication(actor,f)
  await readManagedArtifact(bucket,p.artifact,p.task,p.attempt)
  // Recheck task/input/publication and controls transactionally after the asynchronous object read.
  result=recovery.start(actor,f,raw.destinationId,d.actionId);break
 }
 case 'check':recoveryExact(d,['actionId']);result=recovery.check(actor,f,raw.destinationId,d.actionId);break
 case 'finish':recoveryExact(d,['actionId','outcome','evidenceRef']);result=recovery.finish(actor,f,raw.destinationId,d.actionId,d.outcome,d.evidenceRef);break
 default:throw new TaskConflict('Unsupported recovery operation')
 }
 if(!enabled&&raw.action==='inspect'&&result===null)return Response.json({error:'Saved import recovery is disabled'},{status:503})
 return Response.json({schema:SAVED_IMPORT_SCHEMA,result})
}
