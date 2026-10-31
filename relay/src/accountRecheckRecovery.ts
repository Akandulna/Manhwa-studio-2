import {retainedInventory} from './retainedInventory'
import type {TaskSql,TaskAuthority} from './taskAuthority'
import {canonicalJson,TaskConflict,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {recoveryUnitKey,type RecoveryUnit} from '../../server/src/services/automationRecoveryPolicy'
import {scopeMatches,taskScope,profileKey,scopeKey,type ManagedAccountProfile,type ManagedAccount,type AccountPolicy,type AccountQuotaRecord} from '../../server/src/services/managedAccountsProtocol'
import {ACCOUNT_RECHECK_SCHEMA,parseAccountRecheckFence,parseAccountRecheckRecord,accountRecheckKey,sameRecheckFence,type AccountRecheckFence,type AccountRecheckRecord} from '../../server/src/services/accountRecheckRecoveryProtocol'
import {recoveryId} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {initRecoveryBudget,sharedRecoveryBudget,assertRecoveryReservation} from './recoveryBudget'
/** Requests one existing idle-owner audit. Never navigates, updates quota, releases a task or changes policy. */
export class AccountRecheckRecovery {
 constructor(private sql:TaskSql,private transaction:<T>(work:()=>T)=>T,private authority:TaskAuthority,private now=Date.now,private enabled=()=>true){
  initRecoveryBudget(sql)
  authority.accounts.recoveryAuditHooks={beforeClaim:(d,p)=>this.beforeClaim(d,p),claimed:a=>this.claimed(a),finished:(a,p)=>this.finished(a,p)}
 }
 private row<T>(table:string,id:string):T|null {const r=this.sql.exec<{body:string}>('SELECT body FROM '+table+' WHERE id = ?',id).toArray()[0];return r?JSON.parse(r.body):null}
 private get(f:AccountRecheckFence){const raw=this.row<unknown>('managed_account_recovery_episodes',accountRecheckKey(f));return raw?parseAccountRecheckRecord(raw):null}
 private put(r:AccountRecheckRecord){parseAccountRecheckRecord(r);this.sql.exec('INSERT INTO managed_account_recovery_episodes (id,target,body) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',accountRecheckKey(r.fence),profileKey(r.fence.deviceId,r.fence.profileId),JSON.stringify(r))}
 private pending(device:string,profile:string){
  const rows=this.sql.exec<{body:string}>("SELECT body FROM managed_account_recovery_episodes WHERE target = ? AND EXISTS (SELECT 1 FROM json_each(body,'$.actions') a WHERE json_extract(a.value,'$.phase') = 'executing') LIMIT 129",profileKey(device,profile)).toArray()
  if(rows.length>128)throw new TaskConflict('Account recheck inventory exceeded; preserve receipts')
  return rows.map(row=>{const r=parseAccountRecheckRecord(JSON.parse(row.body));if(r.fence.deviceId!==device||r.fence.profileId!==profile)throw new TaskConflict('Retained audit target mismatch');return r}).filter(r=>r.actions.at(-1)?.phase==='executing')
 }
 private context(f:AccountRecheckFence,admit=false){
  parseAccountRecheckFence(f);this.authority.assertWorkspace(f.unit.taskId,f.unit.workspaceId)
  const owner=this.authority.artifactOwner({role:'studio'},f.unit.taskId,f.unit.attemptId,f.unit.generation,f.unit.fingerprint)
  const old=this.get(f);if(old&&!sameRecheckFence(old.fence,f))throw new TaskConflict('Original account/reset/profile fence cannot change or reset its budget')
  const profile=this.row<ManagedAccountProfile>('managed_account_profiles',profileKey(f.deviceId,f.profileId))
  const policy=this.row<AccountPolicy>('managed_account_policies','crop_json'),quota=this.row<AccountQuotaRecord>('managed_account_quotas',f.accountId+'/'+scopeKey(f.scope))
  if(admit){
   const pin=owner.attempt.accountSelection,product=f.scope.product as 'chatgpt'|'gemini_apps',link=profile?.links[product],site=profile?.observation?.sites[product],scope={...taskScope(owner.task.spec),feature:f.scope.feature}
   if(!pin||owner.attempt.accountId!==f.accountId||pin.accountId!==f.accountId||canonicalJson(pin.configuration)!==canonicalJson(owner.task.spec)||!policy?.auditsEnabled||policy.revision!==f.policyRevision||pin.policy.revision!==f.policyRevision)throw new TaskConflict('Original pinned account/configuration and current idle-audit policy required')
   if(['cancelled','paused','superseded','uncertain'].includes(owner.task.state)||!['unsent','saved'].includes(owner.attempt.submission))throw new TaskConflict('Paused, cancelled or unresolved task cannot admit account recovery')
   if(!['uploads','crop_json'].includes(f.scope.feature)||!scopeMatches(f.scope,scope)||!quota||quota.state!=='blocked'||quota.observedAt!==f.quotaObservedAt||quota.recheckAt!==f.recheckAt||this.now()<f.recheckAt)throw new TaskConflict('Current scoped blocked quota and elapsed recheck deadline required; never infer availability')
   if(!profile||link?.accountId!==f.accountId||link.candidate!==f.candidate||!site||site.login==='signed_in'&&site.candidate!==f.candidate)throw new TaskConflict('Confirm the current same-account target identity before requesting an audit')
   const enrollment=this.row<{profileId:string}>('managed_enrollment',f.deviceId)
   if(enrollment?.profileId!==f.profileId)throw new TaskConflict('Original enrolled audit target required')
  }
  return {record:old,profile,quota,policy,...owner}
 }
 discover(actor:TaskPrincipal,unit:RecoveryUnit){
  if(actor.role!=='studio')throw new TaskConflict('Automation Manager inspection required');recoveryUnitKey(unit);this.authority.assertWorkspace(unit.taskId,unit.workspaceId)
  const {task,attempt}=this.authority.artifactOwner(actor,unit.taskId,unit.attemptId,unit.generation,unit.fingerprint)
  const policy=this.authority.accounts.policy(),pin=attempt.accountSelection
  const old=this.row<unknown>('managed_account_recovery_episodes',recoveryUnitKey(unit))
  if(old){const record=parseAccountRecheckRecord(old);return {targets:[record.fence],record}}
  if(!pin||!attempt.accountId||!policy||policy.revision!==pin.policy.revision)return {targets:[],record:null}
  const profiles=this.sql.exec<{body:string}>('SELECT body FROM managed_account_profiles ORDER BY id LIMIT 129').toArray(),quotas=this.sql.exec<{body:string}>('SELECT body FROM managed_account_quotas ORDER BY id LIMIT 1001').toArray()
  if(profiles.length>128||quotas.length>1000)throw new TaskConflict('Bounded account evidence required')
  const account=this.row<ManagedAccount>('managed_account_accounts',attempt.accountId)
  if(!account)return {targets:[],record:null}
  const targets:AccountRecheckFence[]=[]
  for(const row of profiles){const p=JSON.parse(row.body) as ManagedAccountProfile,product=taskScope(task.spec).product as 'chatgpt'|'gemini_apps',link=p.links[product]
   if(link?.accountId!==attempt.accountId||p.observation?.sites[product]?.login==='signed_in'&&p.observation.sites[product].candidate!==link.candidate)continue
   for(const row of quotas){const q=JSON.parse(row.body) as AccountQuotaRecord
    if(q.accountId!==attempt.accountId||q.state!=='blocked'||q.recheckAt===null||!['uploads','crop_json'].includes(q.scope.feature)||!scopeMatches(q.scope,{...taskScope(task.spec),feature:q.scope.feature}))continue
    targets.push(parseAccountRecheckFence({unit,deviceId:p.deviceId,profileId:p.profileId,accountId:q.accountId,candidate:link.candidate,scope:q.scope,quotaObservedAt:q.observedAt,recheckAt:q.recheckAt,policyRevision:policy.revision}))
   }
  }
  if(targets.length>128)throw new TaskConflict('Account recheck target inventory requires review')
  return {targets,record:null}
 }
 inspect(actor:TaskPrincipal,f:AccountRecheckFence){if(actor.role!=='studio')throw new TaskConflict('Studio inspection required');return this.transaction(()=>this.context(f).record)}
 control(actor:TaskPrincipal,f:AccountRecheckFence,revision:number,enabled:boolean,paused:boolean,cancelled:boolean){
  if(actor.role!=='studio')throw new TaskConflict('Automation Manager admission required')
  return this.transaction(()=>{
   const old=this.context(f).record
   if(!Number.isSafeInteger(revision)||revision!==(old?.revision??0)||![enabled,paused,cancelled].every(x=>typeof x==='boolean'))throw new TaskConflict('Current account recovery controls required')
   if(enabled&&!paused&&!cancelled)this.context(f,true)
   if(!old&&retainedInventory(this.sql,'managed_account_recovery_episodes',128)>=128)throw new TaskConflict('Account recovery inventory reached')
   const r:AccountRecheckRecord=old??{schema:ACCOUNT_RECHECK_SCHEMA,fence:structuredClone(f),revision:0,enabled:false,paused:false,cancelled:false,nextEligibleAt:0,actions:[]}
   if((!enabled||paused||cancelled)&&r.actions.at(-1)?.phase==='executing'&&r.actions.at(-1)?.auditId===null)this.withdraw(r)
   r.revision++;r.enabled=enabled;r.paused=paused;r.cancelled=r.cancelled||cancelled;this.put(r);return r
  })
 }
 request(actor:TaskPrincipal,f:AccountRecheckFence,revision:number,actionId:string){
  if(actor.role!=='studio')throw new TaskConflict('Automation Manager request required')
  return this.transaction(()=>{
   const r=this.context(f,true).record
   if(!r||revision!==r.revision||!r.enabled||r.paused||r.cancelled||!recoveryId(actionId)||actionId.length>96||r.actions.some(a=>a.phase!=='safe_failure'))throw new TaskConflict('Exact current bounded account recheck required')
   assertRecoveryReservation(this.sql,f.unit,actionId,this.now())
   if(this.pending(f.deviceId,f.profileId).length)throw new TaskConflict('An admitted recheck already owns this target; inspect its original receipt')
   // Scheduling and the spent action commit together. Only the existing audit owner can claim/navigation.
   this.authority.accounts.requestAudit(actor,'recovery_audit_'+actionId,f.deviceId,f.profileId)
   r.actions.push({id:actionId,phase:'executing',at:this.now(),finishedAt:null,evidenceRef:null,auditId:null,checkedAt:null,result:null});r.revision++;this.put(r);return r
  })
 }
 withdrawQueued(unit:RecoveryUnit){const raw=this.row<unknown>('managed_account_recovery_episodes',recoveryUnitKey(unit));if(raw){const r=parseAccountRecheckRecord(raw);if(recoveryUnitKey(r.fence.unit)!==recoveryUnitKey(unit))throw new TaskConflict('Retained account unit mismatch');if(r.actions.at(-1)?.phase==='executing'&&r.actions.at(-1)?.auditId===null)this.withdraw(r)}}
 private withdraw(r:AccountRecheckRecord){
  const a=r.actions.at(-1)!
  if(a.phase!=='executing'||a.auditId!==null)return
  this.authority.accounts.withdrawAuditRequest({role:'studio'},r.fence.deviceId,r.fence.profileId,'recovery_audit_'+a.id)
  a.phase='safe_failure';a.finishedAt=this.now();a.result='withdrawn';a.evidenceRef='request/'+a.id
  r.nextEligibleAt=Math.max(r.nextEligibleAt,a.at+15*60_000);r.revision++;this.put(r)
 }
 private beforeClaim(device:string,profile:string){
  for(const r of this.pending(device,profile)){
   if(r.actions.at(-1)!.auditId!==null)continue
   let current=true
   try{this.context(r.fence,true)}catch(error){if(!(error instanceof TaskConflict))throw error;current=false}
   if(!current||!this.enabled()||!r.enabled||r.paused||r.cancelled||!this.authority.accounts.auditRequestOwned(device,profile,'recovery_audit_'+r.actions.at(-1)!.id))this.withdraw(r)
  }
 }
 private claimed(audit:{id:string;deviceId:string;profileId:string;startedAt:number}){
  for(const r of this.pending(audit.deviceId,audit.profileId)){
   const a=r.actions.at(-1)!
   if(a.auditId!==null){if(a.auditId!==audit.id)throw new TaskConflict('Original account audit outcome is still unresolved');continue}
   if(audit.startedAt<a.at)throw new TaskConflict('Audit predates the admitted request')
   a.auditId=audit.id;r.revision++;this.put(r)
  }
 }
 private finished(audit:{id:string;deviceId:string;profileId:string;startedAt:number;finishedAt:number;state:string},profile:ManagedAccountProfile){
  for(const r of this.pending(audit.deviceId,audit.profileId)){
   const a=r.actions.at(-1)!
   if(a.auditId!==audit.id)throw new TaskConflict('Audit completion must match the exact original recheck')
   if(this.sql.exec('SELECT resource FROM managed_reservations WHERE attempt_id = ? LIMIT 1','audit:'+audit.id).toArray().length)throw new TaskConflict('Original audit cleanup is not yet acknowledged')
   const product=r.fence.scope.product as 'chatgpt'|'gemini_apps',observation=profile.observation,site=observation?.sites[product]
   const fresh=!!observation&&observation.checkedAt>=a.at&&observation.checkedAt>=audit.startedAt&&observation.checkedAt<=audit.finishedAt
   const quota=this.row<AccountQuotaRecord>('managed_account_quotas',r.fence.accountId+'/'+scopeKey(r.fence.scope))
   a.checkedAt=observation?.checkedAt??null
   const known=audit.state==='success'&&fresh&&site&&site.login!=='unknown'
   a.result=!known?'unknown':site.login==='signed_out'?'signed_out':site.candidate!==r.fence.candidate||profile.links[product]?.candidate!==r.fence.candidate||profile.links[product]?.accountId!==r.fence.accountId?'identity_changed':quota?.state==='blocked'?'quota_blocked':'identity_checked'
   a.phase=known?'verified':'safe_failure';a.finishedAt=audit.finishedAt;a.evidenceRef='audit/'+audit.id
   if(!known)r.nextEligibleAt=Math.max(profile.audit.retryNotBefore??0,this.now()+15*60_000)
   r.revision++;this.put(r)
  }
 }
 status(actor:TaskPrincipal,f:AccountRecheckFence){if(actor.role!=='studio')throw new TaskConflict('Studio inspection required');const c=this.context(f);return {record:c.record,profileAudit:c.profile?structuredClone(c.profile.audit):null,quotaState:c.quota?.state??'unknown',budget:sharedRecoveryBudget(this.sql,f.unit)}}
}
