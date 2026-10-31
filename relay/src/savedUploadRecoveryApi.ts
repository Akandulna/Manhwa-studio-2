import {recoveryUnitKey} from '../../server/src/services/automationRecoveryPolicy'
import {boundedBody,readManagedArtifact,storeManagedArtifact,type ManagedArtifactBucket} from './managedArtifactStorage'
import {artifactHash,validateManagedCrop} from '../../server/src/services/managedCropArtifact'
import {TaskConflict,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {SAVED_UPLOAD_SCHEMA,parseSavedUploadFence} from '../../server/src/services/managedSavedUploadRecoveryProtocol'
import {recoveryExact} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import type {SavedUploadRecovery} from './savedUploadRecovery'
export async function savedUploadRecoveryApi(request:Request,actor:TaskPrincipal,recovery:SavedUploadRecovery,workspace:string,bucket:ManagedArtifactBucket|undefined,enabled:()=>boolean,effectGate?:(fence:any,actionId:string)=>void):Promise<Response>{
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,2_100_000)))}catch{throw new TaskConflict('Bounded saved-upload JSON required')}
 recoveryExact(raw,['schema','action','fence','details'])
 if(raw.action==='discover'){
  recoveryExact(raw.details,[]);recoveryUnitKey(raw.fence)
  if(raw.schema!==SAVED_UPLOAD_SCHEMA||raw.fence.workspaceId!==workspace)throw new TaskConflict('Exact saved-upload workspace required')
  const result=recovery.discover(actor,raw.fence)
  return Response.json({schema:SAVED_UPLOAD_SCHEMA,globalEnabled:enabled(),budget:result?recovery.budget(result.fence):{used:0,uiUsed:0,nextEligibleAt:0,pending:false,exhausted:false},result})
 }
 const f=parseSavedUploadFence(raw.fence),d=raw.details
 if(raw.schema!==SAVED_UPLOAD_SCHEMA||f.workspaceId!==workspace)throw new TaskConflict('Exact saved-upload schema/workspace required')
 // Outcome reconciliation and stopping stay available while admission is off.
 const stopping=raw.action==='control'&&d&&typeof d==='object'&&(d.enabled===false||d.paused===true||d.cancelled===true)
 const transferRead=raw.action==='transfer'&&d?.mode==='read'
 if(!enabled()&&!['inspect','reconcile','close-transfer'].includes(raw.action)&&!stopping&&!transferRead)return Response.json({error:'Saved upload recovery is disabled'},{status:503})
 let result:unknown,transfer:unknown,terminal:unknown
 switch(raw.action){
 case 'close-transfer':{
  recoveryExact(d,['actionId','revision','bindingHash','accountId','policyRevision','byteLength'])
  if(actor.role!=='phone'||!bucket)throw new TaskConflict('Original phone and artifact storage required')
  recovery.context(actor,f)
  const c=recovery.artifact(f)
  const bytes=await readManagedArtifact(bucket,c.artifact,c.task,c.attempt)
  if(bytes.length!==d.byteLength)throw new TaskConflict('Original saved byte count differs')
  terminal=recovery.closeTransfer(actor,f,d);result=recovery.inspect(actor,f);break
 }
 case 'transfer':{
  recoveryExact(d,['mode','actionId','revision','bindingHash','accountId','policyRevision'])
  if(d.mode!=='read')effectGate?.(f,d.actionId)
  transfer=recovery.transfer(actor,f,d);result=recovery.inspect(actor,f);break
 }
 case 'inspect':recoveryExact(d,[]);result=recovery.inspect(actor,f);break
 case 'offer':recoveryExact(d,[]);result=recovery.offer(actor,f);break
 case 'control':recoveryExact(d,['revision','enabled','paused','cancelled']);result=recovery.control(actor,f,d.revision,d.enabled,d.paused,d.cancelled);break
 case 'reserve':recoveryExact(d,['revision','actionId']);result=recovery.reserve(actor,f,d.revision,d.actionId);break
 case 'upload':{
  recoveryExact(d,['actionId','document',...('bindingHash' in d?['bindingHash']:[])]);recovery.assertTransfer(actor,f,d.actionId,d.bindingHash);effectGate?.(f,d.actionId)
  if(actor.role!=='phone')return Response.json({error:'Original phone executor required'},{status:403})
  if(!bucket||typeof d.document!=='string')throw new TaskConflict('Original saved bytes and cloud storage required')
  const c=recovery.artifact(f);recovery.context(actor,f)
  const bytes=new TextEncoder().encode(d.document);validateManagedCrop(bytes,c.task,c.attempt)
  if(await artifactHash(bytes)!==f.sha256)throw new TaskConflict('Original checkpoint hash mismatch')
  if(!enabled())throw new TaskConflict('Saved upload recovery is disabled')
  recovery.start(actor,f,d.actionId)
  let effectStarted=false
  try{
   recovery.check(actor,f,d.actionId)
   // One immutable storage slot, not a second upload identity or a fresh task.
   // The existing storage ceiling remains authoritative.
   recovery.reserveStorage(actor,f,bytes.length)
   await storeManagedArtifact(bucket,c.artifact,bytes,()=>{
    if(!enabled())throw new TaskConflict('Saved upload recovery is disabled')
    effectGate?.(f,d.actionId);recovery.check(actor,f,d.actionId);recovery.assertNoOrdinaryIntent(f);effectStarted=true
   })
   if(!enabled())throw new TaskConflict('Saved upload recovery is disabled')
   effectGate?.(f,d.actionId);recovery.check(actor,f,d.actionId)
   recovery.stage(f,d.actionId);result=recovery.finish(actor,f,d.actionId,'verified')
  }catch(error){try{recovery.finish(actor,f,d.actionId,effectStarted?'unknown':'safe_failure')}catch{};throw error}
  break
 }
 case 'reconcile':{
  recoveryExact(d,['actionId']);const r=recovery.holdArmedTransfer(actor,f,d.actionId),last=r?.actions.at(-1)
  if(!last||last.id!==d.actionId||!['executing','unknown','verified'].includes(last.phase)||!bucket)throw new TaskConflict('Inspect the exact original started action')
  const c=recovery.artifact(f)
  // No put/reserve/start. A missing object proves nothing about an interrupted executor.
  await readManagedArtifact(bucket,c.artifact,c.task,c.attempt)
  recovery.stage(f,d.actionId);result=recovery.finish(actor,f,d.actionId,'verified');break
 }
 default:throw new TaskConflict('Unsupported saved-upload operation')
 }
 return Response.json({schema:SAVED_UPLOAD_SCHEMA,globalEnabled:enabled(),budget:recovery.budget(f),result,...(transfer?{transfer}:{}),...(terminal?{terminal}:{})})
}
