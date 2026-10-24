import {retainedInventory} from './retainedInventory'
import type {TaskSql,TaskAuthority} from './taskAuthority'
import type {TargetContextAuthority} from './targetContext'
import {TaskConflict,canonicalJson,type TaskPrincipal,type CoordinatorFence} from '../../server/src/services/managedTaskProtocol'
import {recoveryExact,recoveryId} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {recoveryUnitKey,type RecoveryUnit} from '../../server/src/services/automationRecoveryPolicy'
import {parseAdoptionRecord} from '../../server/src/services/candidateAdoptionProtocol'
import {parseContextProof} from '../../server/src/services/targetContextProtocol'
import {ACCOUNT_HANDOFF_SCHEMA,ACCOUNT_HANDOFF_CAPABILITY,PRODUCTION_CANDIDATE_HANDOFF_CAPABILITY,parseProductionCandidateHandoff,HANDOFF_CONFIRMATION,parseHandoffRecord,type HandoffRecord} from '../../server/src/services/accountHandoffProtocol'
import {assertRecoveryReservation,assertRecoveryControls,sharedRecoveryBudget} from './recoveryBudget'
import {boundedBody} from './managedArtifactStorage'
export class AccountHandoffAuthority {
 constructor(private sql:TaskSql,private tx:<T>(f:()=>T)=>T,private authority:TaskAuthority,private contexts:TargetContextAuthority,private enabled:()=>boolean,private now=Date.now){}
 private get(unit:RecoveryUnit){const row=this.sql.exec<{body:string}>('SELECT body FROM managed_account_handoff_episodes WHERE id = ?',recoveryUnitKey(unit)).toArray()[0];const r=row?parseHandoffRecord(JSON.parse(row.body)):null;if(r&&recoveryUnitKey(r.fence.unit)!==recoveryUnitKey(unit))throw new TaskConflict('Original handoff ledger mismatch');return r}
 private put(r:HandoffRecord){parseHandoffRecord(r);this.sql.exec('INSERT INTO managed_account_handoff_episodes (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',recoveryUnitKey(r.fence.unit),JSON.stringify(r))}
 private compatible(device:string,production=false){const row=this.sql.exec<{body:string}>('SELECT body FROM managed_peers WHERE id = ?',device).toArray()[0];if(!row||![ACCOUNT_HANDOFF_CAPABILITY,...(production?[PRODUCTION_CANDIDATE_HANDOFF_CAPABILITY]:[])].every(c=>JSON.parse(row.body).capabilities.includes(c)))throw new TaskConflict('Exact retained-candidate handoff consumer required')}
 approve(actor:TaskPrincipal,unit:RecoveryUnit,raw:any){
  if(actor.role!=='studio')throw new TaskConflict('Separate Studio handoff approval required');recoveryExact(raw,['actionId','candidateId','revision','confirmation',...(raw.production!==undefined?['production']:[])])
  let production:ReturnType<typeof parseProductionCandidateHandoff>|undefined,coordinator:CoordinatorFence|undefined
  if(raw.production!==undefined){recoveryExact(raw.production,['jobId','claimEventId','newClaimEventId','coordinatorId','coordinatorGeneration']);const {coordinatorId,coordinatorGeneration,...identity}=raw.production;production=parseProductionCandidateHandoff(identity);if(production.newClaimEventId===raw.actionId)throw new TaskConflict('Distinct successor claim and recovery action required');coordinator={coordinatorId,coordinatorGeneration};this.authority.assertAccountHandoffCoordinator(unit,coordinator)}
  if(!recoveryId(raw.actionId)||!recoveryId(raw.candidateId)||!Number.isSafeInteger(raw.revision)||raw.revision<0||raw.confirmation!==HANDOFF_CONFIRMATION)throw new TaskConflict('Explicit exact account handoff confirmation required')
  return this.tx(()=>{
   this.authority.assertWorkspace(unit.taskId,unit.workspaceId);const old=this.get(unit),prior=old?.actions.find(a=>a.id===raw.actionId)
   if(prior){if(prior.candidate.id!==raw.candidateId||canonicalJson(prior.production??null)!==canonicalJson(production??null))throw new TaskConflict('Immutable handoff approval conflict');return prior}
   this.authority.assertAccountHandoffScope(unit,production,coordinator)
   if(!this.enabled()||old&&(!old.enabled||old.paused||old.cancelled)||raw.revision!==(old?.revision??0))throw new TaskConflict('Handoff is off, held or changed')
   const row=this.sql.exec<{body:string}>('SELECT body FROM managed_candidate_adoption_episodes WHERE id = ?',recoveryUnitKey(unit)).toArray()[0],candidate=row?parseAdoptionRecord(JSON.parse(row.body)).actions.find(a=>a.id===raw.candidateId):null
   if(!candidate||candidate.phase!=='verified')throw new TaskConflict('Acknowledge the exact retained candidate first')
   this.compatible(candidate.context.target.deviceId,!!production);this.contexts.adoptionContext({role:'phone',deviceId:candidate.context.target.deviceId},candidate.context.id)
   assertRecoveryReservation(this.sql,unit,raw.actionId,this.now())
   if(!old&&retainedInventory(this.sql,'managed_account_handoff_episodes',128)>=128)throw new TaskConflict('Handoff history inventory full')
   const at=this.now(),a={id:raw.actionId,candidate,at,expiresAt:at+120000,phase:'reserved' as const,...(production?{production}:{}),proof:null,result:null,finishedAt:null},r=old??{schema:ACCOUNT_HANDOFF_SCHEMA,fence:{unit},revision:0,enabled:true,paused:false,cancelled:false,nextEligibleAt:0,actions:[]}
   r.actions.push(a);r.revision++;this.put(r);return a
  })
 }
 cancel(actor:TaskPrincipal,unit:RecoveryUnit,id:string,revision:number){return this.tx(()=>{
  if(actor.role!=='studio')throw new TaskConflict('Studio unused handoff cancellation required');this.authority.assertWorkspace(unit.taskId,unit.workspaceId);const r=this.get(unit),a=r?.actions.find(a=>a.id===id)
  if(!r||!a)throw new TaskConflict('Original approval required');if(a.phase==='safe_failure')return a;if(!['reserved','prepared'].includes(a.phase)||r.revision!==revision)throw new TaskConflict('Committed or changed handoff cannot be cancelled')
  a.phase='safe_failure';a.finishedAt=this.now();r.nextEligibleAt=this.now()+30000;r.revision++;this.put(r);return a
 })}
 private live(actor:TaskPrincipal,unit:RecoveryUnit,r:HandoffRecord,a:import('../../server/src/services/accountHandoffProtocol').HandoffAction,raw:unknown){
  const proof=parseContextProof(raw),c=a.candidate.context
  if(!this.enabled()||!r.enabled||r.paused||r.cancelled||this.now()>=a.expiresAt)throw new TaskConflict('Handoff approval is off, held or expired')
  assertRecoveryControls(this.sql,unit);this.compatible(c.target.deviceId,!!a.production)
  const current=this.contexts.adoptionContext(actor,c.id,a.id),now=this.now()
  if(canonicalJson(current.receipt)!==canonicalJson(c)||proof.id!==c.id||proof.packageId!==c.packageId||proof.reviewId!==c.reviewId||proof.bindingId!==c.bindingId||proof.sourceSha256!==c.source.sha256||proof.manifestSha256!==c.manifestSha256||proof.promptSha256!==c.promptSha256||proof.observedAt<a.at||proof.observedAt>now||now-proof.observedAt>=15000||proof.accountObservationAt<a.at)throw new TaskConflict('Fresh exact original retained-candidate view proof required')
  const profile=this.sql.exec<{body:string}>('SELECT body FROM managed_account_profiles WHERE id = ?',c.target.deviceId+'/'+c.target.profileId).toArray()[0]
  if(!profile||JSON.parse(profile.body).observation?.checkedAt!==proof.accountObservationAt||now-proof.accountObservationAt>=120000)throw new TaskConflict('Independent account observation changed')
  return proof
 }
 consume(actor:TaskPrincipal,unit:RecoveryUnit,id:string,raw:unknown){return this.tx(()=>{
  const r=this.get(unit),a=r?.actions.find(a=>a.id===id);this.authority.assertWorkspace(unit.taskId,unit.workspaceId)
  if(!r||!a||actor.role!=='phone'||actor.deviceId!==a.candidate.context.target.deviceId)throw new TaskConflict('Original authenticated target handoff required')
  const proof=parseContextProof(raw)
  if(['verified','prepared'].includes(a.phase)){if(canonicalJson(a.proof)!==canonicalJson(proof))throw new TaskConflict('Immutable handoff proof conflict');return a}
  if(a.phase!=='reserved')throw new TaskConflict('Original unused handoff required')
  this.live(actor,unit,r,a,proof)
  if(a.production){a.phase='prepared';a.proof=proof;r.revision++;this.put(r);return a}
  a.phase='executing';this.put(r)
  a.result=this.authority.allocateAccountHandoff(unit,a.id,a.candidate.context)
  a.phase='verified';a.proof=proof;a.finishedAt=this.now();r.revision++;this.put(r);return a
 })}
 finalize(actor:TaskPrincipal,unit:RecoveryUnit,id:string,coordinator:CoordinatorFence){return this.tx(()=>{
  if(actor.role!=='studio')throw new TaskConflict('Production coordinator Studio commit required')
  this.authority.assertAccountHandoffCoordinator(unit,coordinator)
  const r=this.get(unit),a=r?.actions.find(a=>a.id===id)
  if(!r||!a?.production)throw new TaskConflict('Original production handoff required')
  if(a.phase==='verified')return a
  if(a.phase!=='prepared')throw new TaskConflict('Target must retain its original fresh proof first')
  this.live({role:'phone',deviceId:a.candidate.context.target.deviceId},unit,r,a,a.proof)
  a.phase='executing';this.put(r)
  a.result=this.authority.allocateAccountHandoff(unit,a.id,a.candidate.context,{identity:a.production,coordinator})
  a.phase='verified';a.finishedAt=this.now();r.revision++;this.put(r);return a
 })}
 status(actor:TaskPrincipal,unit:RecoveryUnit){return this.tx(()=>{
  this.authority.assertWorkspace(unit.taskId,unit.workspaceId);const r=this.get(unit)
  const actions=(r?.actions??[]).filter(a=>actor.role==='studio'||a.candidate.context.target.deviceId===actor.deviceId)
  return {schema:ACCOUNT_HANDOFF_SCHEMA,unit,checkedAt:this.now(),globalEnabled:this.enabled(),revision:r?.revision??0,actions,budget:sharedRecoveryBudget(this.sql,unit)}
 })}
}
export async function accountHandoffApi(request:Request,actor:TaskPrincipal,owner:AccountHandoffAuthority,workspace:string){
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let b:any;try{b=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,16000)))}catch{throw new TaskConflict('Bounded handoff request required')}
 if(b.schema!==ACCOUNT_HANDOFF_SCHEMA||b.workspaceId!==workspace||b.unit?.workspaceId!==workspace)throw new TaskConflict('Exact handoff workspace required')
 let result:any
 if(b.action==='status'){recoveryExact(b,['schema','workspaceId','unit','action']);result=owner.status(actor,b.unit)}
 else if(b.action==='approve'){recoveryExact(b,['schema','workspaceId','unit','action','approval']);result=owner.approve(actor,b.unit,b.approval)}
 else if(b.action==='cancel'){recoveryExact(b,['schema','workspaceId','unit','action','actionId','revision']);result=owner.cancel(actor,b.unit,b.actionId,b.revision)}
 else if(b.action==='finalize'){recoveryExact(b,['schema','workspaceId','unit','action','actionId','coordinatorId','coordinatorGeneration']);result=owner.finalize(actor,b.unit,b.actionId,{coordinatorId:b.coordinatorId,coordinatorGeneration:b.coordinatorGeneration})}
 else if(b.action==='consume'){recoveryExact(b,['schema','workspaceId','unit','action','actionId','proof']);result=owner.consume(actor,b.unit,b.actionId,b.proof)}
 else throw new TaskConflict('Exact handoff operation required')
 return Response.json(result,{headers:{'Cache-Control':'no-store'}})
}
