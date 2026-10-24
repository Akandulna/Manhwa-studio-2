import type {TaskSql,TaskAuthority} from './taskAuthority'
import type {TargetPackageAuthority} from './targetPackage'
import {TaskConflict,canonicalJson,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {recoveryExact,recoveryId} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {recoveryUnitKey,type RecoveryUnit} from '../../server/src/services/automationRecoveryPolicy'
import {fallbackTargets} from '../../server/src/services/fallbackPreflightProtocol'
import {parseTargetPackageReceipt} from '../../server/src/services/targetPackageProtocol'
import {TARGET_CONTEXT_SCHEMA,TARGET_CONTEXT_CAPABILITY,STANDALONE_CONTEXT,CONTEXT_CONFIRMATION,contextPermissions,parseContextProof,parseContextReceipt} from '../../server/src/services/targetContextProtocol'
import {boundedBody} from './managedArtifactStorage'
export class TargetContextAuthority {
 constructor(private sql:TaskSql,private tx:<T>(work:()=>T)=>T,private authority:TaskAuthority,private packages:TargetPackageAuthority,private now=Date.now){
  for(const table of ['reviews','checks'])sql.exec('CREATE TABLE IF NOT EXISTS managed_target_context_'+table+' (id TEXT PRIMARY KEY, target_key TEXT NOT NULL, body TEXT NOT NULL)')
 }
 private key(unit:RecoveryUnit,target:unknown){return canonicalJson([recoveryUnitKey(unit),target])}
 private read(table:'reviews'|'checks',id:string){const row=this.sql.exec<{target_key:string;body:string}>('SELECT target_key,body FROM managed_target_context_'+table+' WHERE id = ?',id).toArray()[0];if(!row)return null;const r=JSON.parse(row.body),f=table==='reviews'?r:r.challenge;if(f.id!==id||this.key(f.unit,f.target)!==row.target_key)throw new TaskConflict('Context evidence identity mismatch');return r}
 private candidate(actor:TaskPrincipal,id:string,continuationActionId?:string){
  const c=this.packages.contextCandidate(actor,id,continuationActionId),r=c.receipt;parseTargetPackageReceipt(r,r.unit,r.target,r.receivedAt)
  return c
 }
 private compatible(deviceId:string){const row=this.sql.exec<{body:string}>('SELECT body FROM managed_peers WHERE id = ?',deviceId).toArray()[0];if(!row||!JSON.parse(row.body).capabilities.includes(TARGET_CONTEXT_CAPABILITY))throw new TaskConflict('Target context inspection capability required')}
 private matches(review:any,candidate:ReturnType<TargetContextAuthority['candidate']>){const p=candidate.receipt;if(review.packageId!==p.id||recoveryUnitKey(review.unit)!==recoveryUnitKey(p.unit)||canonicalJson(review.target)!==canonicalJson(p.target)||review.accountId!==p.accountId||review.policyRevision!==p.policyRevision||canonicalJson(review.source)!==canonicalJson(p.source)||review.manifestSha256!==p.manifestSha256||review.promptSha256!==p.promptSha256||review.contextScope!==STANDALONE_CONTEXT)throw new TaskConflict('Reviewed context candidate changed')}
 review(actor:TaskPrincipal,id:string,unit:RecoveryUnit,rawTarget:unknown,packageId:string,confirmation:unknown){
  if(actor.role!=='studio'||!recoveryId(id)||!recoveryId(packageId)||confirmation!==CONTEXT_CONFIRMATION)throw new TaskConflict('Explicit standalone context requirements review required')
  recoveryUnitKey(unit);const target=fallbackTargets([rawTarget])[0]
  return this.tx(()=>{
   this.authority.assertWorkspace(unit.taskId,unit.workspaceId);this.authority.artifactOwner(actor,unit.taskId,unit.attemptId,unit.generation,unit.fingerprint)
   const c=this.candidate({role:'phone',deviceId:target.deviceId},packageId),p=c.receipt
   if(recoveryUnitKey(p.unit)!==recoveryUnitKey(unit)||canonicalJson(p.target)!==canonicalJson(target))throw new TaskConflict('Exact selected candidate required')
   const old=this.read('reviews',id)
   if(old){this.matches(old,c);return old}
   if(this.sql.exec('SELECT id FROM managed_target_context_reviews LIMIT 129').toArray().length>=128)throw new TaskConflict('Context review inventory full; preserve history')
   const review={schema:TARGET_CONTEXT_SCHEMA,id,packageId,unit,target,accountId:p.accountId,policyRevision:p.policyRevision,source:p.source,manifestSha256:p.manifestSha256,promptSha256:p.promptSha256,contextScope:STANDALONE_CONTEXT,reviewedAt:this.now(),withdrawnAt:null,...contextPermissions}
   this.sql.exec('INSERT INTO managed_target_context_reviews (id,target_key,body) VALUES (?,?,?)',id,this.key(unit,target),JSON.stringify(review));return review
  })
 }
 withdraw(actor:TaskPrincipal,id:string,unit:RecoveryUnit,rawTarget:unknown){
  if(actor.role!=='studio'||!recoveryId(id))throw new TaskConflict('Studio context withdrawal required')
  recoveryUnitKey(unit);const target=fallbackTargets([rawTarget])[0]
  return this.tx(()=>{const r=this.read('reviews',id);if(!r||recoveryUnitKey(r.unit)!==recoveryUnitKey(unit)||canonicalJson(r.target)!==canonicalJson(target))throw new TaskConflict('Original context review required');this.authority.assertWorkspace(r.unit.taskId,r.unit.workspaceId);this.authority.artifactOwner(actor,r.unit.taskId,r.unit.attemptId,r.unit.generation,r.unit.fingerprint);if(r.withdrawnAt===null){r.withdrawnAt=this.now();this.sql.exec('UPDATE managed_target_context_reviews SET body = ? WHERE id = ?',JSON.stringify(r),id)}return r})
 }
 begin(actor:TaskPrincipal,id:string,packageId:string){
  if(actor.role!=='phone'||!recoveryId(id)||!recoveryId(packageId))throw new TaskConflict('Authenticated context inspection required')
  return this.tx(()=>{
   const c=this.candidate(actor,packageId),p=c.receipt,row=this.sql.exec<{body:string}>('SELECT body FROM managed_target_context_reviews WHERE target_key = ? ORDER BY rowid DESC LIMIT 1',this.key(p.unit,p.target)).toArray()[0],review=row?JSON.parse(row.body):null
   if(!review||review.packageId!==packageId||review.withdrawnAt!==null)throw new TaskConflict('Review this exact standalone candidate in Studio first');this.matches(review,c)
   const peer=this.sql.exec<{body:string}>('SELECT body FROM managed_peers WHERE id = ?',actor.deviceId).toArray()[0];if(!peer||!JSON.parse(peer.body).capabilities.includes(TARGET_CONTEXT_CAPABILITY))throw new TaskConflict('Target context inspection capability required')
   const old=this.read('checks',id);if(old){if(old.challenge.reviewId!==review.id||old.challenge.packageId!==packageId)throw new TaskConflict('Immutable context request conflict');return old.challenge}
   if(this.sql.exec('SELECT id FROM managed_target_context_checks LIMIT 129').toArray().length>=128)throw new TaskConflict('Context inspection inventory full; preserve history')
   const now=this.now(),challenge={schema:TARGET_CONTEXT_SCHEMA,id,reviewId:review.id,packageId,unit:p.unit,target:p.target,accountId:p.accountId,policyRevision:p.policyRevision,source:p.source,manifestSha256:p.manifestSha256,promptSha256:p.promptSha256,contextScope:STANDALONE_CONTEXT,issuedAt:now,validUntil:Math.min(now+15000,c.validUntil),...contextPermissions}
   this.sql.exec('INSERT INTO managed_target_context_checks (id,target_key,body) VALUES (?,?,?)',id,this.key(p.unit,p.target),JSON.stringify({challenge,proof:null,receipt:null}));return challenge
  })
 }
 report(actor:TaskPrincipal,raw:unknown){
  const proof=parseContextProof(raw)
  return this.tx(()=>{
   const r=this.read('checks',proof.id);if(!r||actor.role!=='phone'||actor.deviceId!==r.challenge.target.deviceId)throw new TaskConflict('Original authenticated target required')
   const c=r.challenge
   if(r.proof){if(canonicalJson(r.proof)!==canonicalJson(proof))throw new TaskConflict('Immutable context observation conflict');return r.receipt}
   this.compatible(actor.deviceId)
   const review=this.read('reviews',c.reviewId),current=this.candidate(actor,c.packageId),now=this.now()
   if(!review||review.withdrawnAt!==null)throw new TaskConflict('Reviewed context was withdrawn');this.matches(review,current)
   const latest=this.sql.exec<{id:string}>('SELECT id FROM managed_target_context_reviews WHERE target_key = ? ORDER BY rowid DESC LIMIT 1',this.key(c.unit,c.target)).toArray()[0]
   const profile=this.sql.exec<{body:string}>('SELECT body FROM managed_account_profiles WHERE id = ?',actor.deviceId+'/'+c.target.profileId).toArray()[0],accountAt=profile?JSON.parse(profile.body).observation?.checkedAt:null
   if(latest?.id!==c.reviewId||proof.reviewId!==c.reviewId||proof.packageId!==c.packageId||proof.sourceSha256!==c.source.sha256||proof.manifestSha256!==c.manifestSha256||proof.promptSha256!==c.promptSha256||proof.observedAt<c.issuedAt||proof.observedAt>now||now>=c.validUntil||proof.accountObservationAt!==accountAt||now-proof.accountObservationAt>=120000)throw new TaskConflict('Exact fresh reviewed context and independent account observation required')
   const receipt=parseContextReceipt({schema:TARGET_CONTEXT_SCHEMA,id:c.id,reviewId:c.reviewId,packageId:c.packageId,unit:c.unit,target:c.target,accountId:c.accountId,policyRevision:c.policyRevision,source:c.source,manifestSha256:c.manifestSha256,promptSha256:c.promptSha256,bindingId:proof.bindingId,accountObservationAt:proof.accountObservationAt,observedAt:proof.observedAt,receivedAt:now,validUntil:Math.min(c.validUntil,current.validUntil,proof.accountObservationAt+120000),contextScope:STANDALONE_CONTEXT,declaredContextVerified:true,...contextPermissions},c.unit,c.target,now)
   this.sql.exec('UPDATE managed_target_context_checks SET body = ? WHERE id = ?',JSON.stringify({...r,proof,receipt}),c.id);return receipt
  })
 }
 /** Immutable context basis plus current prerequisites; never fresh context or view-adoption authority. */
 adoptionContext(actor:TaskPrincipal,id:string,continuationActionId?:string){
  const r=this.read('checks',id)
  if(!r?.receipt||actor.role!=='phone'||r.challenge.target.deviceId!==actor.deviceId)throw new TaskConflict('Original acknowledged target context required')
  const c=r.challenge,review=this.read('reviews',c.reviewId),current=this.candidate(actor,c.packageId,continuationActionId)
  this.compatible(actor.deviceId)
  const latest=this.sql.exec<{id:string}>('SELECT id FROM managed_target_context_reviews WHERE target_key = ? ORDER BY rowid DESC LIMIT 1',this.key(c.unit,c.target)).toArray()[0]
  if(!review||review.withdrawnAt!==null||latest?.id!==c.reviewId)throw new TaskConflict('Original requirements review changed or was withdrawn')
  this.matches(review,current);parseContextReceipt(r.receipt,c.unit,c.target,r.receipt.receivedAt)
  return {receipt:structuredClone(r.receipt),validUntil:current.validUntil}
 }
 status(actor:TaskPrincipal,unit:RecoveryUnit,rawTarget:unknown){
  if(actor.role!=='studio')throw new TaskConflict('Studio context inspection required');recoveryUnitKey(unit);const target=fallbackTargets([rawTarget])[0]
  return this.tx(()=>{
   this.authority.assertWorkspace(unit.taskId,unit.workspaceId);this.authority.artifactOwner(actor,unit.taskId,unit.attemptId,unit.generation,unit.fingerprint)
   const row=this.sql.exec<{body:string}>('SELECT body FROM managed_target_context_reviews WHERE target_key = ? ORDER BY rowid DESC LIMIT 1',this.key(unit,target)).toArray()[0],review=row?JSON.parse(row.body):null,now=this.now()
   const check=review?this.sql.exec<{body:string}>('SELECT body FROM managed_target_context_checks WHERE target_key = ? ORDER BY rowid DESC LIMIT 1',this.key(unit,target)).toArray()[0]:null,r=check?JSON.parse(check.body):null,receipt=r?.challenge.reviewId===review?.id?r?.receipt??null:null
   let state=review?'awaiting_target':'unreviewed'
   if(review){try{this.compatible(target.deviceId);this.matches(review,this.candidate({role:'phone',deviceId:target.deviceId},review.packageId));state=review.withdrawnAt!==null?'withdrawn':receipt?now>=receipt.validUntil?'expired':'verified_declared_context':r?.challenge.reviewId===review.id&&now>=r.challenge.validUntil?'expired':'awaiting_target'}catch{state='blocked'}}
   return {schema:TARGET_CONTEXT_SCHEMA,unit,target,checkedAt:now,state,review:review?{id:review.id,packageId:review.packageId,contextScope:review.contextScope,reviewedAt:review.reviewedAt,withdrawnAt:review.withdrawnAt}:null,receipt,...contextPermissions}
  })
 }
}
export async function targetContextApi(request:Request,actor:TaskPrincipal,checks:TargetContextAuthority,workspace:string){
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,12000)))}catch{throw new TaskConflict('Bounded context request required')}
 if(!raw||raw.schema!==TARGET_CONTEXT_SCHEMA||raw.workspaceId!==workspace)throw new TaskConflict('Exact context workspace required')
 let result:any
 if(raw.action==='review'){recoveryExact(raw,['schema','workspaceId','action','id','unit','target','packageId','confirmation']);if(raw.unit?.workspaceId!==workspace)throw new TaskConflict('Foreign context unit');result=checks.review(actor,raw.id,raw.unit,raw.target,raw.packageId,raw.confirmation)}
 else if(raw.action==='withdraw'){recoveryExact(raw,['schema','workspaceId','action','id','unit','target']);if(raw.unit?.workspaceId!==workspace)throw new TaskConflict('Foreign context unit');result=checks.withdraw(actor,raw.id,raw.unit,raw.target)}
 else if(raw.action==='begin'){recoveryExact(raw,['schema','workspaceId','action','id','packageId']);result=checks.begin(actor,raw.id,raw.packageId)}
 else if(raw.action==='report'){recoveryExact(raw,['schema','workspaceId','action','proof']);result=checks.report(actor,raw.proof)}
 else if(raw.action==='status'){recoveryExact(raw,['schema','workspaceId','action','unit','target']);if(raw.unit?.workspaceId!==workspace)throw new TaskConflict('Foreign context unit');result=checks.status(actor,raw.unit,raw.target)}
 else throw new TaskConflict('Explicit context operation required')
 return Response.json(result,{headers:{'Cache-Control':'no-store'}})
}
