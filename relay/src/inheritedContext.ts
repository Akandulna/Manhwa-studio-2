import type {TaskSql,TaskAuthority} from './taskAuthority'
import type {TargetPackageAuthority} from './targetPackage'
import {retainedInventory} from './retainedInventory'
import {assertRecoveryControls} from './recoveryBudget'
import {TaskConflict,canonicalJson,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {recoveryExact,recoveryId} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {recoveryUnitKey} from '../../server/src/services/automationRecoveryPolicy'
import {contextBinding,parseInheritedRequest,parseInheritedReview,INHERITED_CONTEXT_SCHEMA,inheritedPermissions} from '../../server/src/services/inheritedContextProtocol'
import {boundedBody} from './managedArtifactStorage'
const key=(b:any)=>canonicalJson([recoveryUnitKey(b.unit),b.target])
export function assertStandaloneRequirements(sql:TaskSql,unit:unknown,target:unknown,newReview=false){
 const unitKey=recoveryUnitKey(unit as any),targetKey=canonicalJson([unitKey,target]),latestByTarget=new Map<string,any>()
 for(const row of sql.exec<{id:string;target_key:string;body:string}>('SELECT id,target_key,body FROM managed_inherited_context_reviews ORDER BY rowid').toArray()){
  const r=JSON.parse(row.body);parseInheritedReview(r.review)
  if(row.id!==r.review.request.id||row.target_key!==key(r.review.request.binding)||!Array.isArray(r.standaloneReviewIds)||r.standaloneReviewIds.some((id:unknown)=>!recoveryId(id)))throw new TaskConflict('Inherited requirements history is inconsistent')
  if(recoveryUnitKey(r.review.request.binding.unit)===unitKey)latestByTarget.set(row.target_key,r)
 }
 const reviews=[...latestByTarget.values()]
 if(reviews.some(r=>r.review.withdrawnAt===null))throw new TaskConflict('Inherited text requirements need their separate recovery consumer')
 if(newReview||!reviews.length)return
 const latest=sql.exec<{id:string}>('SELECT id FROM managed_target_context_reviews WHERE target_key = ? ORDER BY rowid DESC LIMIT 1',targetKey).toArray()[0]
 if(!latest||reviews.some(r=>r.standaloneReviewIds.includes(latest.id)))throw new TaskConflict('Review standalone requirements again after inherited text withdrawal')
}
export class InheritedContextAuthority {
 constructor(private sql:TaskSql,private tx:<T>(work:()=>T)=>T,private authority:TaskAuthority,private packages:TargetPackageAuthority,private now=Date.now){}
 private latest(b:any){const row=this.sql.exec<{id:string;target_key:string;body:string}>('SELECT id,target_key,body FROM managed_inherited_context_reviews WHERE target_key = ? ORDER BY rowid DESC LIMIT 1',key(b)).toArray()[0];if(!row)return null;const r=this.decode(row.body);if(row.id!==r.review.request.id||row.target_key!==key(r.review.request.binding))throw new TaskConflict('Inherited requirements identity mismatch');return r}
 private decode(body:string){const r=JSON.parse(body);parseInheritedReview(r.review);return r}
 private owner(actor:TaskPrincipal,b:any){if(actor.role!=='studio')throw new TaskConflict('Explicit Studio requirements review required');contextBinding(b);this.authority.assertWorkspace(b.unit.taskId,b.unit.workspaceId);this.authority.artifactOwner(actor,b.unit.taskId,b.unit.attemptId,b.unit.generation,b.unit.fingerprint)}
 private current(b:any){
  assertRecoveryControls(this.sql,b.unit)
  const c=this.packages.contextCandidate({role:'phone',deviceId:b.target.deviceId},b.packageId),p=c.receipt
  if(c.validUntil<=this.now()||canonicalJson(contextBinding({unit:p.unit,target:p.target,accountId:p.accountId,policyRevision:p.policyRevision,packageId:p.id,sourceSha256:p.source.sha256,manifestSha256:p.manifestSha256,promptSha256:p.promptSha256}))!==canonicalJson(b))throw new TaskConflict('Current exact original candidate, account and policy required')
 }
 review(actor:TaskPrincipal,raw:unknown){const request=parseInheritedRequest(raw),b=request.binding
  return this.tx(()=>{
   this.owner(actor,b)
   const old=this.sql.exec<{target_key:string;body:string}>('SELECT target_key,body FROM managed_inherited_context_reviews WHERE id = ?',request.id).toArray()[0]
   if(old){const r=this.decode(old.body);if(r.review.request.id!==request.id||old.target_key!==key(b)||canonicalJson(r.review.request)!==canonicalJson(request))throw new TaskConflict('Immutable inherited requirements request conflict');return r.review}
   this.current(b);const latest=this.latest(b)
   if((latest?.review.request.id??null)!==request.supersedesId)throw new TaskConflict('Inspect the latest requirements review before superseding it')
   if(retainedInventory(this.sql,'managed_inherited_context_reviews',128)>=128)throw new TaskConflict('Inherited requirements inventory full; preserve history')
   const standalone=this.sql.exec<{id:string;body:string}>('SELECT id,body FROM managed_target_context_reviews ORDER BY rowid').toArray().filter(row=>recoveryUnitKey(JSON.parse(row.body).unit)===recoveryUnitKey(b.unit)).map(row=>row.id)
   const review={schema:INHERITED_CONTEXT_SCHEMA,request,reviewedAt:this.now(),withdrawnAt:null,...inheritedPermissions}
   this.sql.exec('INSERT INTO managed_inherited_context_reviews (id,target_key,body) VALUES (?,?,?)',request.id,key(b),JSON.stringify({review,standaloneReviewIds:standalone}));return review
  })
 }
 withdraw(actor:TaskPrincipal,id:unknown,rawBinding:unknown){const b=contextBinding(rawBinding);if(!recoveryId(id))throw new TaskConflict('Original requirements review identity required')
  return this.tx(()=>{this.owner(actor,b);const row=this.sql.exec<{target_key:string;body:string}>('SELECT target_key,body FROM managed_inherited_context_reviews WHERE id = ?',id).toArray()[0]
   if(!row||row.target_key!==key(b))throw new TaskConflict('Original inherited requirements review required')
   const r=this.decode(row.body);if(r.review.request.id!==id||canonicalJson(r.review.request.binding)!==canonicalJson(b))throw new TaskConflict('Original requirements binding required')
   if(r.review.withdrawnAt===null){r.review.withdrawnAt=this.now();this.sql.exec('UPDATE managed_inherited_context_reviews SET body = ? WHERE id = ?',JSON.stringify(r),id)}return r.review
  })
 }
 status(actor:TaskPrincipal,rawBinding:unknown){const b=contextBinding(rawBinding)
  return this.tx(()=>{this.owner(actor,b);const r=this.latest(b);let state='unreviewed'
   if(r){state=r.review.withdrawnAt!==null?'withdrawn':'reviewed_text_only';if(canonicalJson(r.review.request.binding)!==canonicalJson(b))state='candidate_changed';else if(r.review.withdrawnAt===null)try{this.current(b)}catch{state='blocked'}}
   return {schema:INHERITED_CONTEXT_SCHEMA,binding:b,checkedAt:this.now(),state,review:r?.review??null,...inheritedPermissions}
  })
 }
}
export async function inheritedContextApi(request:Request,actor:TaskPrincipal,checks:InheritedContextAuthority,workspace:string){
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,64000)))}catch{throw new TaskConflict('Bounded metadata-only requirements request required')}
 if(raw?.schema!==INHERITED_CONTEXT_SCHEMA||raw.workspaceId!==workspace)throw new TaskConflict('Exact inherited requirements workspace required')
 let result:unknown
 if(raw.action==='review'){recoveryExact(raw,['schema','workspaceId','action','request']);if(raw.request?.binding?.unit?.workspaceId!==workspace)throw new TaskConflict('Foreign inherited unit');result=checks.review(actor,raw.request)}
 else if(raw.action==='withdraw'){recoveryExact(raw,['schema','workspaceId','action','id','binding']);if(raw.binding?.unit?.workspaceId!==workspace)throw new TaskConflict('Foreign inherited unit');result=checks.withdraw(actor,raw.id,raw.binding)}
 else if(raw.action==='status'){recoveryExact(raw,['schema','workspaceId','action','binding']);if(raw.binding?.unit?.workspaceId!==workspace)throw new TaskConflict('Foreign inherited unit');result=checks.status(actor,raw.binding)}
 else throw new TaskConflict('Explicit inherited requirements operation required')
 return Response.json(result,{headers:{'Cache-Control':'no-store'}})
}
