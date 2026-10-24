import type {TaskSql,TaskAuthority} from './taskAuthority'
import {TaskConflict,canonicalJson,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {recoveryExact,recoveryId} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {recoveryUnitKey,type RecoveryUnit} from '../../server/src/services/automationRecoveryPolicy'
import {fallbackTargets,type FallbackTarget} from '../../server/src/services/fallbackPreflightProtocol'
import {TARGET_INPUT_SCHEMA,TARGET_INPUT_CAPABILITY,TARGET_INPUT_MAX_AGE,parseTargetInputProof,parseTargetInputReceipt,type TargetInputChallenge,type TargetInputReceipt} from '../../server/src/services/targetInputProtocol'
import type {FallbackPreflightAuthority} from './fallbackPreflight'
import {boundedBody} from './managedArtifactStorage'
type RecordBody={challenge:TargetInputChallenge;proof:ReturnType<typeof parseTargetInputProof>|null;receipt:TargetInputReceipt|null}
export class TargetInputAuthority {
 constructor(private sql:TaskSql,private tx:<T>(work:()=>T)=>T,private authority:TaskAuthority,private preflight:FallbackPreflightAuthority,private now=Date.now){
  sql.exec('CREATE TABLE IF NOT EXISTS managed_target_input_checks (id TEXT PRIMARY KEY, target_key TEXT NOT NULL, body TEXT NOT NULL)')
 }
 private key(unit:RecoveryUnit,target:FallbackTarget){return canonicalJson([recoveryUnitKey(unit),target])}
 private read(id:string):RecordBody|null{const r=this.sql.exec<{body:string;target_key:string}>('SELECT body,target_key FROM managed_target_input_checks WHERE id = ?',id).toArray()[0];if(!r)return null;const record=JSON.parse(r.body) as RecordBody;if(record.challenge.id!==id||r.target_key!==this.key(record.challenge.unit,record.challenge.target))throw new TaskConflict('Target source evidence key mismatch');return record}
 private context(unit:RecoveryUnit,target:FallbackTarget,continuationActionId?:string){
  const snapshot=continuationActionId?this.preflight.originalAdoptionContinuation(unit,target,continuationActionId):this.preflight.inspect({role:'studio'},unit,[target]),t=snapshot.targets[0]
  if(!continuationActionId&&snapshot.source.reasons.length||!t.authorityEligible||!t.accountId||!snapshot.policyRevision||!snapshot.source.stopCommandId)throw new TaskConflict('Original release and target account prerequisites must still match')
  const peer=this.sql.exec<{body:string}>('SELECT body FROM managed_peers WHERE id = ?',target.deviceId).toArray()[0]
  if(!peer||!JSON.parse(peer.body).capabilities.includes(TARGET_INPUT_CAPABILITY))throw new TaskConflict('Target source-check capability required')
  return {snapshot,target:t,task:this.authority.artifactOwner({role:'studio'},unit.taskId,unit.attemptId,unit.generation,unit.fingerprint).task}
 }
 private unchanged(c:TargetInputChallenge,current:ReturnType<TargetInputAuthority['context']>){
  const t=current.task
  if(c.schema!==TARGET_INPUT_SCHEMA||c.accountId!==current.target.accountId||c.policyRevision!==current.snapshot.policyRevision||c.stopCommandId!==current.snapshot.source.stopCommandId||canonicalJson(c.spec)!==canonicalJson(t.spec)||canonicalJson(c.scope)!==canonicalJson({workspaceId:t.workspaceId,seriesId:t.seriesId,chapterId:t.chapterId,pageId:t.pageId})||c.sourceSha256!==t.spec.dependencies[0].sha256||![c.issuedAt,c.validUntil].every(Number.isSafeInteger)||c.issuedAt<=0||c.issuedAt>this.now()||c.validUntil>c.issuedAt+TARGET_INPUT_MAX_AGE||c.validUntil<=c.issuedAt||['executionAllowed','handoffAllowed','resendAllowed','portableInputVerified'].some(k=>(c as any)[k]!==false))throw new TaskConflict('Original target source challenge changed')
 }
 begin(actor:TaskPrincipal,id:string,taskId:string,workspace:string,profileId:string){
  if(actor.role!=='phone'||!recoveryId(id)||!recoveryId(profileId)||!/^task:sha256:[a-f0-9]{64}$/.test(taskId)||!recoveryId(workspace))throw new TaskConflict('Authenticated target source check required')
  return this.tx(()=>{
   this.authority.assertWorkspace(taskId,workspace)
   const {task,attempt}=this.authority.timeline({role:'studio'},taskId);if(!attempt)throw new TaskConflict('Current original attempt required')
   const unit={workspaceId:workspace,taskId,attemptId:attempt.id,generation:attempt.generation,fingerprint:task.fingerprint},target={deviceId:actor.deviceId,profileId},old=this.read(id)
   if(old){if(this.key(old.challenge.unit,old.challenge.target)!==this.key(unit,target))throw new TaskConflict('Immutable target source request conflict');this.unchanged(old.challenge,this.context(unit,target));return old.challenge}
   const c=this.context(unit,target),now=this.now(),dependency=task.spec.dependencies[0]
   if(dependency.id!==task.pageId||dependency.revision!==task.spec.pageRevision)throw new TaskConflict('Exact page dependency required')
   if(this.sql.exec('SELECT id FROM managed_target_input_checks LIMIT 129').toArray().length>=128)throw new TaskConflict('Target source evidence inventory full; preserve history')
   const challenge:TargetInputChallenge={schema:TARGET_INPUT_SCHEMA,id,unit,target,accountId:c.target.accountId!,policyRevision:c.snapshot.policyRevision!,stopCommandId:c.snapshot.source.stopCommandId!,scope:{workspaceId:workspace,seriesId:task.seriesId,chapterId:task.chapterId,pageId:task.pageId},spec:structuredClone(task.spec),sourceSha256:dependency.sha256,issuedAt:now,validUntil:Math.min(now+TARGET_INPUT_MAX_AGE,c.snapshot.validUntil),executionAllowed:false,handoffAllowed:false,resendAllowed:false,portableInputVerified:false}
   this.sql.exec('INSERT INTO managed_target_input_checks (id,target_key,body) VALUES (?,?,?)',id,this.key(unit,target),JSON.stringify({challenge,proof:null,receipt:null}))
   return challenge
  })
 }
 report(actor:TaskPrincipal,raw:unknown){
  const proof=parseTargetInputProof(raw)
  return this.tx(()=>{
   const record=this.read(proof.challengeId);if(!record||actor.role!=='phone'||actor.deviceId!==record.challenge.target.deviceId)throw new TaskConflict('Original authenticated target required')
   const c=record.challenge
   if(record.proof){if(canonicalJson(record.proof)!==canonicalJson(proof))throw new TaskConflict('Immutable target source observation conflict');return record.receipt!}
   const current=this.context(c.unit,c.target),now=this.now()
   this.unchanged(c,current)
   if(c.accountId!==current.target.accountId||c.policyRevision!==current.snapshot.policyRevision||c.stopCommandId!==current.snapshot.source.stopCommandId||canonicalJson(c.spec)!==canonicalJson(current.task.spec)||now>=c.validUntil||proof.observedAt<c.issuedAt||proof.observedAt>now||proof.sourceSha256!==c.sourceSha256||proof.specFingerprint!==c.unit.fingerprint)throw new TaskConflict('Target source check expired or original evidence changed')
   const receipt=parseTargetInputReceipt({schema:TARGET_INPUT_SCHEMA,challengeId:c.id,unit:c.unit,target:c.target,accountId:c.accountId,policyRevision:c.policyRevision,sourceSha256:proof.sourceSha256,sourceBytes:proof.sourceBytes,observedAt:proof.observedAt,receivedAt:now,validUntil:Math.min(c.validUntil,current.snapshot.validUntil,proof.observedAt+TARGET_INPUT_MAX_AGE),sourceVerified:true,portableInputVerified:false,executionAllowed:false,handoffAllowed:false,resendAllowed:false},c.unit,c.target,now)
   this.sql.exec('UPDATE managed_target_input_checks SET body = ? WHERE id = ?',JSON.stringify({...record,proof,receipt}),c.id)
   return receipt
  })
 }
 /** Read-only prerequisite for a distinct offline candidate check; source timestamps are never refreshed. */
 packageContext(actor:TaskPrincipal,id:string,continuationActionId?:string){
  const record=this.read(id)
  if(!record?.receipt||actor.role!=='phone'||actor.deviceId!==record.challenge.target.deviceId)throw new TaskConflict('Acknowledged original target source check required')
  const current=this.context(record.challenge.unit,record.challenge.target,continuationActionId);this.unchanged(record.challenge,current)
  parseTargetInputReceipt(record.receipt,record.challenge.unit,record.challenge.target,record.receipt.receivedAt)
  return {challenge:structuredClone(record.challenge),receipt:structuredClone(record.receipt),validUntil:current.snapshot.validUntil}
 }
 status(actor:TaskPrincipal,unit:RecoveryUnit,rawTarget:unknown){
  if(actor.role!=='studio')throw new TaskConflict('Studio target source inspection required')
  recoveryUnitKey(unit);const target=fallbackTargets([rawTarget])[0]
  return this.tx(()=>{
   this.authority.assertWorkspace(unit.taskId,unit.workspaceId);this.authority.artifactOwner(actor,unit.taskId,unit.attemptId,unit.generation,unit.fingerprint)
   const row=this.sql.exec<{body:string}>('SELECT body FROM managed_target_input_checks WHERE target_key = ? ORDER BY rowid DESC LIMIT 1',this.key(unit,target)).toArray()[0],record:RecordBody|null=row?JSON.parse(row.body):null,now=this.now()
   let state:'missing'|'awaiting_target'|'verified_source_only'|'expired'|'blocked'=record?'awaiting_target':'missing'
   if(record){try{const current=this.context(unit,target);this.unchanged(record.challenge,current);if(record.challenge.accountId!==current.target.accountId||record.challenge.policyRevision!==current.snapshot.policyRevision||record.challenge.stopCommandId!==current.snapshot.source.stopCommandId)throw new TaskConflict('Changed target context');if(now>=record.challenge.validUntil)state='expired';else if(record.receipt){parseTargetInputReceipt(record.receipt,unit,target,now);state='verified_source_only'}}catch{state='blocked'}}
   return {schema:TARGET_INPUT_SCHEMA,unit,target,checkedAt:now,state,receipt:record?.receipt??null,executionAllowed:false,handoffAllowed:false,resendAllowed:false,portableInputVerified:false}
  })
 }
}
export async function targetInputApi(request:Request,actor:TaskPrincipal,checks:TargetInputAuthority,workspace:string){
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,8000)))}catch{throw new TaskConflict('Bounded target source check required')}
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.schema!==TARGET_INPUT_SCHEMA||raw.workspaceId!==workspace)throw new TaskConflict('Exact workspace required')
 let result:unknown
 if(raw.action==='begin'){recoveryExact(raw,['schema','workspaceId','action','id','taskId','profileId']);result=checks.begin(actor,raw.id,raw.taskId,workspace,raw.profileId)}
 else if(raw.action==='report'){recoveryExact(raw,['schema','workspaceId','action','proof']);result=checks.report(actor,raw.proof)}
 else if(raw.action==='status'){recoveryExact(raw,['schema','workspaceId','action','unit','target']);if(raw.unit?.workspaceId!==workspace)throw new TaskConflict('Foreign source unit');result=checks.status(actor,raw.unit,raw.target)}
 else throw new TaskConflict('Explicit target source operation required')
 return Response.json(result,{headers:{'Cache-Control':'no-store'}})
}
