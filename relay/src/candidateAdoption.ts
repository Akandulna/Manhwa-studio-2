import type {TaskSql,TaskAuthority} from './taskAuthority'
import type {TargetContextAuthority} from './targetContext'
import {TaskConflict,canonicalJson,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {recoveryExact,recoveryId} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {recoveryUnitKey,type RecoveryUnit} from '../../server/src/services/automationRecoveryPolicy'
import {fallbackTargets} from '../../server/src/services/fallbackPreflightProtocol'
import {parseContextProof,parseContextReceipt} from '../../server/src/services/targetContextProtocol'
import {CANDIDATE_ADOPTION_SCHEMA,CANDIDATE_ADOPTION_CAPABILITY,ADOPTION_CONFIRMATION,adoptionPermissions,parseAdoptionRecord,parseLocalAdoptionReceipt,type AdoptionRecord,type AdoptionAction} from '../../server/src/services/candidateAdoptionProtocol'
import {assertRecoveryControls,assertRecoveryReservation,sharedRecoveryBudget} from './recoveryBudget'
import {boundedBody} from './managedArtifactStorage'
export class CandidateAdoptionAuthority {
 constructor(private sql:TaskSql,private tx:<T>(work:()=>T)=>T,private authority:TaskAuthority,private contexts:TargetContextAuthority,private enabled:()=>boolean,private now=Date.now){}
 private get(unit:RecoveryUnit):AdoptionRecord|null{const row=this.sql.exec<{body:string}>('SELECT body FROM managed_candidate_adoption_episodes WHERE id = ?',recoveryUnitKey(unit)).toArray()[0];if(!row)return null;const r=parseAdoptionRecord(JSON.parse(row.body));if(recoveryUnitKey(r.fence.unit)!==recoveryUnitKey(unit))throw new TaskConflict('Original retention ledger key mismatch');return r}
 private put(r:AdoptionRecord){parseAdoptionRecord(r);this.sql.exec('INSERT INTO managed_candidate_adoption_episodes (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',recoveryUnitKey(r.fence.unit),JSON.stringify(r))}
 private current(unit:RecoveryUnit){this.authority.assertWorkspace(unit.taskId,unit.workspaceId);this.authority.artifactOwner({role:'studio'},unit.taskId,unit.attemptId,unit.generation,unit.fingerprint)}
 private retained(unit:RecoveryUnit){
  this.authority.assertWorkspace(unit.taskId,unit.workspaceId)
  const taskRow=this.sql.exec<{body:string}>('SELECT body FROM managed_tasks WHERE id = ?',unit.taskId).toArray()[0],attemptRow=this.sql.exec<{body:string}>('SELECT body FROM managed_attempts WHERE id = ?',unit.attemptId).toArray()[0],task=taskRow?JSON.parse(taskRow.body):null,attempt=attemptRow?JSON.parse(attemptRow.body):null
  if(!task||task.id!==unit.taskId||task.fingerprint!==unit.fingerprint||!attempt||attempt.id!==unit.attemptId||attempt.taskId!==unit.taskId||attempt.generation!==unit.generation)throw new TaskConflict('Retained original unit history required')
 }
 private compatible(device:string){const p=this.sql.exec<{body:string}>('SELECT body FROM managed_peers WHERE id = ?',device).toArray()[0];if(!p||!JSON.parse(p.body).capabilities.includes(CANDIDATE_ADOPTION_CAPABILITY))throw new TaskConflict('Compatible target candidate retention required')}
 private original(actor:TaskPrincipal,unit:RecoveryUnit,id:string){const r=this.get(unit),a=r?.actions.find(a=>a.id===id);if(!r||!a||actor.role!=='phone'||actor.deviceId!==a.context.target.deviceId)throw new TaskConflict('Original authenticated target action required');this.authority.assertWorkspace(unit.taskId,unit.workspaceId);return {r,a}}
 private live(actor:TaskPrincipal,unit:RecoveryUnit,r:AdoptionRecord,a:AdoptionAction,raw:unknown){
  if(!this.enabled()||!r.enabled||r.paused||r.cancelled||this.now()>=a.expiresAt)throw new TaskConflict('Candidate retention is off, held or expired')
  this.current(unit);this.compatible(a.context.target.deviceId);assertRecoveryControls(this.sql,unit)
  const current=this.contexts.adoptionContext(actor,a.context.id,a.id),proof=parseContextProof(raw),now=this.now()
  if(canonicalJson(current.receipt)!==canonicalJson(a.context)||proof.id!==a.context.id||proof.reviewId!==a.context.reviewId||proof.packageId!==a.context.packageId||proof.bindingId!==a.context.bindingId||proof.sourceSha256!==a.context.source.sha256||proof.manifestSha256!==a.context.manifestSha256||proof.promptSha256!==a.context.promptSha256||proof.observedAt<a.at||proof.observedAt>now||now-proof.observedAt>=15000||proof.accountObservationAt<a.at)throw new TaskConflict('Fresh original target view and exact candidate proof required')
  const profile=this.sql.exec<{body:string}>('SELECT body FROM managed_account_profiles WHERE id = ?',a.context.target.deviceId+'/'+a.context.target.profileId).toArray()[0]
  if(!profile||JSON.parse(profile.body).observation?.checkedAt!==proof.accountObservationAt||now-proof.accountObservationAt>=120000)throw new TaskConflict('Independent target account observation changed')
  return {proof,validUntil:current.validUntil}
 }
 approve(actor:TaskPrincipal,unit:RecoveryUnit,rawTarget:unknown,raw:any){
  if(actor.role!=='studio')throw new TaskConflict('Separate Studio candidate approval required');recoveryExact(raw,['actionId','contextId','revision','confirmation']);const target=fallbackTargets([rawTarget])[0]
  if(![raw.actionId,raw.contextId].every(recoveryId)||raw.confirmation!==ADOPTION_CONFIRMATION||!Number.isSafeInteger(raw.revision)||raw.revision<0)throw new TaskConflict('Exact explicit candidate retention approval required')
  return this.tx(()=>{
   this.current(unit);let r=this.get(unit);const old=r?.actions.find(a=>a.id===raw.actionId)
   if(old){if(old.context.id!==raw.contextId||canonicalJson(old.context.target)!==canonicalJson(target))throw new TaskConflict('Immutable approval identity conflict');return {action:old,globalEnabled:this.enabled(),...adoptionPermissions}}
   if(!this.enabled()||r&&(!r.enabled||r.paused||r.cancelled)||raw.revision!==(r?.revision??0))throw new TaskConflict('Candidate approval is off, held or changed')
   this.compatible(target.deviceId)
   const current=this.contexts.adoptionContext({role:'phone',deviceId:target.deviceId},raw.contextId),context=parseContextReceipt(current.receipt,unit,target,this.now())
   if(r?.actions.some(a=>a.context.id===context.id&&a.phase==='verified'))throw new TaskConflict('This exact context candidate is already retained')
   assertRecoveryReservation(this.sql,unit,raw.actionId,this.now())
   if(!r&&this.sql.exec('SELECT id FROM managed_candidate_adoption_episodes LIMIT 129').toArray().length>=128)throw new TaskConflict('Candidate retention inventory full; preserve history')
   const now=this.now(),action:AdoptionAction={id:raw.actionId,context,at:now,expiresAt:now+120000,phase:'reserved',startEventId:null,startedAt:null,before:null,permit:null,unknownAt:null,finishedAt:null,receipt:null}
   r=r??{schema:CANDIDATE_ADOPTION_SCHEMA,fence:{unit},revision:0,enabled:true,paused:false,cancelled:false,nextEligibleAt:0,actions:[]}
   r.actions.push(action);r.revision++;this.put(r);return {action,globalEnabled:this.enabled(),...adoptionPermissions}
  })
 }
 cancel(actor:TaskPrincipal,unit:RecoveryUnit,rawTarget:unknown,id:string,revision:number){
  if(actor.role!=='studio')throw new TaskConflict('Studio unused approval cancellation required');const target=fallbackTargets([rawTarget])[0]
  return this.tx(()=>{this.current(unit);const r=this.get(unit),a=r?.actions.find(a=>a.id===id);if(!r||!a||canonicalJson(a.context.target)!==canonicalJson(target))throw new TaskConflict('Original unused target approval required');if(a.phase==='safe_failure')return {action:a,globalEnabled:this.enabled(),...adoptionPermissions};if(a.phase!=='reserved'||revision!==r.revision)throw new TaskConflict('Started or changed retention needs reconciliation');a.phase='safe_failure';a.finishedAt=this.now();r.nextEligibleAt=this.now()+30000;r.revision++;this.put(r);return {action:a,globalEnabled:this.enabled(),...adoptionPermissions}})
 }
 start(actor:TaskPrincipal,unit:RecoveryUnit,id:string,eventId:string,proof:unknown){
  if(!recoveryId(eventId))throw new TaskConflict('Stable original start identity required')
  return this.tx(()=>{
   const {r,a}=this.original(actor,unit,id),fresh=this.live(actor,unit,r,a,proof)
   if(a.phase==='executing'&&a.startEventId===eventId&&canonicalJson(a.before)===canonicalJson(fresh.proof))return {action:a,permit:null,globalEnabled:this.enabled(),...adoptionPermissions}
   if(a.phase!=='reserved')throw new TaskConflict('Original candidate start cannot be repeated')
   a.phase='executing';a.startEventId=eventId;a.startedAt=this.now();a.before=fresh.proof;r.revision++;this.put(r)
   return {action:a,permit:null,globalEnabled:this.enabled(),...adoptionPermissions}
  })
 }
 check(actor:TaskPrincipal,unit:RecoveryUnit,id:string,proof:unknown){
  return this.tx(()=>{
   const {r,a}=this.original(actor,unit,id);if(a.phase!=='executing')throw new TaskConflict('Exact pending retention start required');const fresh=this.live(actor,unit,r,a,proof)
   if(canonicalJson(fresh.proof)!==canonicalJson(a.before))throw new TaskConflict('Keep the original started proof; do not change its view or time')
   if(a.permit){if(this.now()>=a.permit.validUntil)throw new TaskConflict('Original effect permit expired; never refresh it');return {action:a,permit:a.permit,globalEnabled:this.enabled(),...adoptionPermissions}}
   const c=a.context,now=this.now();a.permit={schema:'candidate-adoption-effect-permit/1',actionId:a.id,contextId:c.id,packageId:c.packageId,reviewId:c.reviewId,unit,target:c.target,bindingId:c.bindingId,sourceSha256:c.source.sha256,manifestSha256:c.manifestSha256,promptSha256:c.promptSha256,issuedAt:now,validUntil:Math.min(now+15000,fresh.validUntil,a.expiresAt,a.before.accountObservationAt+120000),localCandidateAdoptionAllowed:true,...adoptionPermissions}
   r.revision++;this.put(r);return {action:a,permit:a.permit,globalEnabled:this.enabled(),...adoptionPermissions}
  })
 }
 unknown(actor:TaskPrincipal,unit:RecoveryUnit,id:string){return this.tx(()=>{const {r,a}=this.original(actor,unit,id);if(a.phase==='unknown'||a.phase==='verified')return {action:a,globalEnabled:this.enabled(),...adoptionPermissions};if(a.phase!=='executing')throw new TaskConflict('An unstarted approval cannot be marked as a possible effect');a.phase='unknown';a.unknownAt=this.now();r.revision++;this.put(r);return {action:a,globalEnabled:this.enabled(),...adoptionPermissions}})}
 finish(actor:TaskPrincipal,unit:RecoveryUnit,id:string,raw:unknown){
  return this.tx(()=>{
   const {r,a}=this.original(actor,unit,id),receipt=parseLocalAdoptionReceipt(raw,a,this.now())
   if(a.phase==='verified'){if(canonicalJson(a.receipt)!==canonicalJson(receipt))throw new TaskConflict('Immutable native retention receipt conflict');return {action:a,globalEnabled:this.enabled(),...adoptionPermissions}}
   if(!['executing','unknown'].includes(a.phase))throw new TaskConflict('Original authorized effect receipt required')
   // Reconciliation records the original effect even when admission/review/ownership later changes. It grants no future use.
   a.phase='verified';a.receipt=receipt;a.finishedAt=this.now();r.revision++;this.put(r);return {action:a,globalEnabled:this.enabled(),...adoptionPermissions}
  })
 }
 status(actor:TaskPrincipal,unit:RecoveryUnit,rawTarget:unknown){
  const target=fallbackTargets([rawTarget])[0];if(actor.role==='phone'&&actor.deviceId!==target.deviceId)throw new TaskConflict('Exact target status required')
  return this.tx(()=>{this.retained(unit);const r=this.get(unit);return {schema:CANDIDATE_ADOPTION_SCHEMA,unit,target,checkedAt:this.now(),globalEnabled:this.enabled(),revision:r?.revision??0,actions:r?.actions.filter(a=>canonicalJson(a.context.target)===canonicalJson(target))??[],budget:sharedRecoveryBudget(this.sql,unit),...adoptionPermissions}})
 }
}
export async function candidateAdoptionApi(request:Request,actor:TaskPrincipal,adoption:CandidateAdoptionAuthority,workspace:string){
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,16000)))}catch{throw new TaskConflict('Bounded candidate adoption request required')}
 if(!raw||raw.schema!==CANDIDATE_ADOPTION_SCHEMA||raw.workspaceId!==workspace||raw.unit?.workspaceId!==workspace)throw new TaskConflict('Exact original adoption workspace required')
 let result:any
 if(raw.action==='status'){recoveryExact(raw,['schema','workspaceId','unit','action','target']);result=adoption.status(actor,raw.unit,raw.target)}
 else if(raw.action==='approve'){recoveryExact(raw,['schema','workspaceId','unit','action','target','approval']);result=adoption.approve(actor,raw.unit,raw.target,raw.approval)}
 else if(raw.action==='cancel'){recoveryExact(raw,['schema','workspaceId','unit','action','target','actionId','revision']);result=adoption.cancel(actor,raw.unit,raw.target,raw.actionId,raw.revision)}
 else if(raw.action==='start'){recoveryExact(raw,['schema','workspaceId','unit','action','actionId','eventId','proof']);result=adoption.start(actor,raw.unit,raw.actionId,raw.eventId,raw.proof)}
 else if(raw.action==='check'){recoveryExact(raw,['schema','workspaceId','unit','action','actionId','proof']);result=adoption.check(actor,raw.unit,raw.actionId,raw.proof)}
 else if(raw.action==='unknown'){recoveryExact(raw,['schema','workspaceId','unit','action','actionId']);result=adoption.unknown(actor,raw.unit,raw.actionId)}
 else if(raw.action==='finish'){recoveryExact(raw,['schema','workspaceId','unit','action','actionId','receipt']);result=adoption.finish(actor,raw.unit,raw.actionId,raw.receipt)}
 else throw new TaskConflict('Exact candidate retention operation required')
 return Response.json(result,{headers:{'Cache-Control':'no-store'}})
}
