import type {TaskSql,TaskAuthority} from './taskAuthority'
import type {TargetInputAuthority} from './targetInput'
import {TaskConflict,canonicalJson,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {recoveryExact,recoveryId} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {recoveryUnitKey,type RecoveryUnit} from '../../server/src/services/automationRecoveryPolicy'
import {fallbackTargets} from '../../server/src/services/fallbackPreflightProtocol'
import {TARGET_PACKAGE_SCHEMA,TARGET_PACKAGE_CAPABILITY,verifyTargetPackage,type PackageEvidence} from '../../server/src/services/targetPackageProtocol'
import {DEFAULT_CROP_PROMPT} from '../../server/src/services/managedCropPilotPolicy'
import {boundedBody} from './managedArtifactStorage'
const permissions={executionAllowed:false,handoffAllowed:false,resendAllowed:false,portableInputVerified:false,contextVerified:false} as const
export class TargetPackageAuthority {
 constructor(private sql:TaskSql,private tx:<T>(work:()=>T)=>T,private authority:TaskAuthority,private source:TargetInputAuthority,private now=Date.now){sql.exec('CREATE TABLE IF NOT EXISTS managed_target_package_checks (id TEXT PRIMARY KEY, target_key TEXT NOT NULL, body TEXT NOT NULL)')}
 private key(unit:RecoveryUnit,target:unknown){return canonicalJson([recoveryUnitKey(unit),target])}
 private read(id:string){const row=this.sql.exec<{target_key:string;body:string}>('SELECT target_key,body FROM managed_target_package_checks WHERE id = ?',id).toArray()[0];if(!row)return null;const r=JSON.parse(row.body);if(r.challenge.id!==id||row.target_key!==this.key(r.challenge.unit,r.challenge.target))throw new TaskConflict('Target package evidence key mismatch');return r}
 private context(actor:TaskPrincipal,sourceCheckId:string,continuationActionId?:string){
  const c=this.source.packageContext(actor,sourceCheckId,continuationActionId),peer=this.sql.exec<{body:string}>('SELECT body FROM managed_peers WHERE id = ?',c.challenge.target.deviceId).toArray()[0]
  if(c.challenge.spec.promptVersion!==DEFAULT_CROP_PROMPT||!peer||!JSON.parse(peer.body).capabilities.includes(TARGET_PACKAGE_CAPABILITY))throw new TaskConflict('Compatible sliced package inspector required')
  return c
 }
 private same(c:any,current:ReturnType<TargetPackageAuthority['context']>){const s=current.challenge;if(recoveryUnitKey(c.unit)!==recoveryUnitKey(s.unit)||canonicalJson(c.target)!==canonicalJson(s.target)||c.accountId!==s.accountId||c.policyRevision!==s.policyRevision||c.stopCommandId!==s.stopCommandId||c.sourceObservedAt!==current.receipt.observedAt)throw new TaskConflict('Original package source context changed')}
 begin(actor:TaskPrincipal,id:string,sourceCheckId:string){
  if(actor.role!=='phone'||!recoveryId(id)||!recoveryId(sourceCheckId))throw new TaskConflict('Explicit authenticated package check required')
  return this.tx(()=>{
   const current=this.context(actor,sourceCheckId),s=current.challenge,old=this.read(id)
   if(old){if(old.challenge.sourceCheckId!==sourceCheckId)throw new TaskConflict('Immutable package request conflict');this.same(old.challenge,current);return old.challenge}
   if(this.sql.exec('SELECT id FROM managed_target_package_checks LIMIT 129').toArray().length>=128)throw new TaskConflict('Package evidence inventory full; preserve history')
   const now=this.now(),challenge={schema:TARGET_PACKAGE_SCHEMA,id,sourceCheckId,unit:s.unit,target:s.target,accountId:s.accountId,policyRevision:s.policyRevision,stopCommandId:s.stopCommandId,sourceObservedAt:current.receipt.observedAt,issuedAt:now,validUntil:Math.min(now+15000,current.validUntil),...permissions}
   this.sql.exec('INSERT INTO managed_target_package_checks (id,target_key,body) VALUES (?,?,?)',id,this.key(s.unit,s.target),JSON.stringify({challenge,proof:null,receipt:null}));return challenge
  })
 }
 async report(actor:TaskPrincipal,raw:any){
  if(actor.role!=='phone'||!recoveryId(raw?.id))throw new TaskConflict('Authenticated target package observation required')
  const initial=this.read(raw.id);if(!initial||initial.challenge.target.deviceId!==actor.deviceId)throw new TaskConflict('Original target package challenge required')
  if(initial.proof){if(canonicalJson(initial.proof)!==canonicalJson(raw))throw new TaskConflict('Immutable package observation conflict');return initial.receipt}
  const source=this.context(actor,initial.challenge.sourceCheckId).challenge
  const verified=await verifyTargetPackage(raw,source.unit.attemptId,source.sourceSha256,source.scope.pageId,source.scope,this.now())
  // Hashing is asynchronous. Recheck all authority inside the final transaction before retaining a receipt.
  return this.tx(()=>{
   const r=this.read(raw.id);if(!r||canonicalJson(r.challenge)!==canonicalJson(initial.challenge))throw new TaskConflict('Package challenge changed during verification')
   if(r.proof){if(canonicalJson(r.proof)!==canonicalJson(raw))throw new TaskConflict('Immutable package observation conflict');return r.receipt}
   const current=this.context(actor,r.challenge.sourceCheckId),c=r.challenge,now=this.now();this.same(c,current)
   if(raw.sourceCheckId!==c.sourceCheckId||raw.observedAt<c.issuedAt||raw.observedAt>now||now>=c.validUntil)throw new TaskConflict('Package observation expired or mismatched')
   const receipt={schema:TARGET_PACKAGE_SCHEMA,id:c.id,sourceCheckId:c.sourceCheckId,unit:c.unit,target:c.target,accountId:c.accountId,policyRevision:c.policyRevision,sourceObservedAt:c.sourceObservedAt,source:verified.source,manifestSha256:verified.manifestSha256,promptSha256:verified.promptSha256,attachmentCount:verified.proof.attachmentBytes.length,totalBytes:verified.totalBytes,observedAt:raw.observedAt,receivedAt:now,validUntil:Math.min(c.validUntil,current.validUntil),packageVerified:true,...permissions}
   this.sql.exec('UPDATE managed_target_package_checks SET body = ? WHERE id = ?',JSON.stringify({...r,proof:verified.proof,receipt}),c.id);return receipt
  })
 }
 /** Current prerequisites with immutable historical package evidence, never a fresh execution grant. */
 contextCandidate(actor:TaskPrincipal,id:string,continuationActionId?:string){
  const r=this.read(id)
  if(!r?.receipt||actor.role!=='phone'||r.challenge.target.deviceId!==actor.deviceId)throw new TaskConflict('Acknowledged target candidate required')
  const current=this.context(actor,r.challenge.sourceCheckId,continuationActionId);this.same(r.challenge,current)
  return {receipt:structuredClone(r.receipt),validUntil:current.validUntil}
 }
 status(actor:TaskPrincipal,unit:RecoveryUnit,rawTarget:unknown){
  if(actor.role!=='studio')throw new TaskConflict('Studio package inspection required')
  recoveryUnitKey(unit);const target=fallbackTargets([rawTarget])[0]
  return this.tx(()=>{
   this.authority.assertWorkspace(unit.taskId,unit.workspaceId);this.authority.artifactOwner(actor,unit.taskId,unit.attemptId,unit.generation,unit.fingerprint)
   const row=this.sql.exec<{body:string}>('SELECT body FROM managed_target_package_checks WHERE target_key = ? ORDER BY rowid DESC LIMIT 1',this.key(unit,target)).toArray()[0],r=row?JSON.parse(row.body):null,now=this.now()
   let state=r?'awaiting_package':'missing'
   if(r){try{const current=this.context({role:'phone',deviceId:target.deviceId},r.challenge.sourceCheckId);this.same(r.challenge,current);state=now>=r.challenge.validUntil?'expired':r.receipt?'verified_package_only':'awaiting_package'}catch{state='blocked'}}
   return {schema:TARGET_PACKAGE_SCHEMA,unit,target,checkedAt:now,state,receipt:r?.receipt??null,...permissions}
  })
 }
}
export async function targetPackageApi(request:Request,actor:TaskPrincipal,checks:TargetPackageAuthority,workspace:string){
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,72000)))}catch{throw new TaskConflict('Bounded package inspection required')}
 if(!raw||raw.schema!==TARGET_PACKAGE_SCHEMA||raw.workspaceId!==workspace)throw new TaskConflict('Exact workspace required')
 let result:unknown
 if(raw.action==='begin'){recoveryExact(raw,['schema','workspaceId','action','id','sourceCheckId']);result=checks.begin(actor,raw.id,raw.sourceCheckId)}
 else if(raw.action==='report'){recoveryExact(raw,['schema','workspaceId','action','proof']);result=await checks.report(actor,raw.proof)}
 else if(raw.action==='status'){recoveryExact(raw,['schema','workspaceId','action','unit','target']);if(raw.unit?.workspaceId!==workspace)throw new TaskConflict('Foreign package unit');result=checks.status(actor,raw.unit,raw.target)}
 else throw new TaskConflict('Explicit package inspection operation required')
 return Response.json(result,{headers:{'Cache-Control':'no-store'}})
}
