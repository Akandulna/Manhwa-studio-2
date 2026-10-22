import type {TaskSql} from './taskAuthority'
import {TaskConflict,canonicalJson,type CropTask,type CropAttempt,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {isDefaultCropPilot,SLICED_CROP_CAPABILITY} from '../../server/src/services/managedCropPilotPolicy'
import {accountIdValid as id,profileKey,scopeKey,scopeMatches,taskScope,parseAccountPolicy,type AccountPolicy,type AccountObservation,type AccountQuota,type AccountQuotaRecord,type AccountSelection,type AccountSelectionPin,type ManagedAccount,type ManagedAccountProfile,type AccountProduct} from '../../server/src/services/managedAccountsProtocol'

export class AccountWaiting extends TaskConflict {constructor(public selection:AccountSelection){super('No eligible account/profile; waiting')}}
/** Shares the task authority's SQLite transaction and reservation table. No timers or provider requests here. */
export class AccountAuthority {
 constructor(private sql:TaskSql,private transaction:<T>(work:()=>T)=>T,private clock=()=>Date.now()) {
  for(const name of ['profiles','accounts','quotas','policies','audits','events','waiting','issues'])sql.exec(`CREATE TABLE IF NOT EXISTS managed_account_${name} (id TEXT PRIMARY KEY, body TEXT NOT NULL)`)
 }
 private get<T>(table:string,key:string):T|null {const r=this.sql.exec<{body:string}>(`SELECT body FROM managed_account_${table} WHERE id = ?`,key).toArray()[0];return r?JSON.parse(r.body):null}
 private put(table:string,key:string,value:unknown){this.sql.exec(`INSERT INTO managed_account_${table} (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`,key,JSON.stringify(value))}
 private rows<T>(table:string):T[]{const rows=this.sql.exec<{body:string}>(`SELECT body FROM managed_account_${table} ORDER BY id LIMIT 1001`).toArray();if(rows.length>1000)throw new TaskConflict('Account inventory requires pagination');return rows.map(r=>JSON.parse(r.body))}
 private managed<T>(table:string,key:string):T|null {const r=this.sql.exec<{body:string}>(`SELECT body FROM managed_${table} WHERE id = ?`,key).toArray()[0];return r?JSON.parse(r.body):null}
 private studio(actor:TaskPrincipal){if(actor.role!=='studio')throw new TaskConflict('Studio authority required')}
 private once<T>(actor:TaskPrincipal,eventId:string,payload:unknown,work:()=>T):T {
  if(!id(eventId))throw new TaskConflict('Immutable account event ID required')
  return this.transaction(()=>{const prior=this.get<{payload:string;result:T}>('events',eventId),encoded=canonicalJson([actor,payload]);if(prior){if(prior.payload!==encoded)throw new TaskConflict('Conflicting account event ID');return prior.result}const result=work();this.put('events',eventId,{payload:encoded,result});return result})
 }
 private profile(device:string,profile:string):ManagedAccountProfile {
  if(!id(device)||!id(profile))throw new TaskConflict('Exact device/profile required')
  const key=profileKey(device,profile),old=this.get<ManagedAccountProfile>('profiles',key)
  if(old)return old
  const enrollment=this.managed<{profileId:string}>('enrollment',device)
  if(enrollment?.profileId!==profile)throw new TaskConflict('Enroll this device/profile first')
  const fresh:ManagedAccountProfile={id:key,deviceId:device,profileId:profile,observation:null,links:{},audit:{cadenceHours:24,dueAt:this.clock(),lastSuccessfulAt:null,state:'due',reason:null,nextCheckAt:this.clock(),retryNotBefore:null,claimId:null}}
  if(this.rows('profiles').length>=128)throw new TaskConflict('Account profile bound reached')
  this.put('profiles',key,fresh);return fresh
 }
 policy():AccountPolicy|null{return this.get('policies','crop_json')}
 setPolicy(actor:TaskPrincipal,eventId:string,value:unknown){this.studio(actor);const policy=parseAccountPolicy(value);return this.once(actor,eventId,{policy},()=>{const old=this.policy();if(policy.revision!==(old?.revision??0)+1)throw new TaskConflict('Policy revision changed; reload before editing');if(policy.enabled&&!old?.enabled&&this.sql.exec('SELECT resource FROM managed_reservations LIMIT 1').toArray().length)throw new TaskConflict('Reconcile existing reservations before enabling account routing');this.put('policies','crop_json',policy);if(policy.enabled)this.put('policies','routing-established',{enabled:true});return policy})}
 private issue(p:ManagedAccountProfile,product:AccountProduct,reason:string|null){const key=p.id+'/'+product;const old=this.get<any>('issues',key);if(reason)this.put('issues',key,{id:key,deviceId:p.deviceId,profileId:p.profileId,product,reason,firstSeenAt:old?.firstSeenAt??this.clock(),lastSeenAt:this.clock(),resolvedAt:null});else if(old&&!old.resolvedAt)this.put('issues',key,{...old,resolvedAt:this.clock()})}
 observe(actor:TaskPrincipal,eventId:string,device:string,profile:string,observation:AccountObservation){if(actor.role==='phone'&&actor.deviceId!==device)throw new TaskConflict('Foreign account observation');return this.once(actor,eventId,{device,profile,observation},()=>this.saveObservation(device,profile,observation))}
 private saveObservation(device:string,profile:string,observation:AccountObservation){
  const p=this.profile(device,profile),old=p.observation
  if(old&&old.checkedAt>observation.checkedAt)return p
  if(old&&old.checkedAt===observation.checkedAt){if(canonicalJson(old)!==canonicalJson(observation))throw new TaskConflict('Conflicting account observation timestamp');return p}
  p.observation=structuredClone(observation)
  for(const product of ['chatgpt','gemini_apps'] as const){const s=observation.sites[product];this.issue(p,product,s.login==='signed_out'?'Sign in on this phone':s.login==='unknown'?'Account check failed; readiness is unknown':!s.candidate||p.links[product]?.candidate!==s.candidate?'Confirm this account relationship in Accounts':null)}
  this.put('profiles',p.id,p);return p
 }
 confirm(actor:TaskPrincipal,eventId:string,device:string,profile:string,product:AccountProduct,candidate:string,accountId:string,maxConcurrent:number){
  this.studio(actor);if(!['chatgpt','gemini_apps'].includes(product)||!id(accountId)||!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>8)throw new TaskConflict('Exact account relationship and concurrency limit required')
  return this.once(actor,eventId,{device,profile,product,candidate,accountId,maxConcurrent},()=>{
   const p=this.profile(device,profile),s=p.observation?.sites[product as 'chatgpt'|'gemini_apps'];if(!s?.candidate||s.login!=='signed_in'||s.candidate!==candidate)throw new TaskConflict('Current observed identity changed; audit before confirming')
   // Identity edits cannot reinterpret an outstanding reservation, even on a second phone.
   const accounts=this.rows<ManagedAccount>('accounts'),existing=accounts.find(a=>a.candidate===candidate),byId=this.get<ManagedAccount>('accounts',accountId)
   if(existing&&existing.id!==accountId||byId&&byId.candidate!==candidate)throw new TaskConflict('Candidate already belongs to a different confirmed account')
   const previous=p.links[product]
   if(previous?.accountId!==accountId&&this.reserved(`device:${device}`))throw new TaskConflict('Reconcile active profile ownership before changing identity')
   if(byId&&byId.maxConcurrent!==maxConcurrent&&this.accountReservations(accountId).length)throw new TaskConflict('Reconcile account reservations before changing capacity')
   const account:ManagedAccount={id:accountId,provider:product==='chatgpt'?'openai':'google',candidate,maxConcurrent}
   this.put('accounts',accountId,account);p.links[product]={accountId,candidate};this.put('profiles',p.id,p);this.issue(p,product,null);return {profile:p,account}
  })
 }
 quota(actor:TaskPrincipal,eventId:string,profile:string|null,value:AccountQuota){
  if(actor.role==='phone'){
   if(profile===null||value.evidence!=='observed')throw new TaskConflict('Phone quota must be observed in an exact profile')
   const p=this.profile(actor.deviceId,profile),link=p.links[value.scope.product]
   if(link?.accountId!==value.accountId||p.observation?.sites[value.scope.product as 'chatgpt'|'gemini_apps']?.candidate!==link.candidate)throw new TaskConflict('Confirm current scoped account before reporting quota')
  }else if(value.evidence!=='owner_supplied'&&value.evidence!=='unknown')throw new TaskConflict('Owner quota updates must be labelled owner supplied or unknown')
  return this.once(actor,eventId,{profile,value},()=>{
   const account=this.get<ManagedAccount>('accounts',value.accountId);if(!account||account.provider!==value.scope.provider)throw new TaskConflict('Unknown account or wrong provider')
   const key=value.accountId+'/'+scopeKey(value.scope),old=this.get<AccountQuotaRecord>('quotas',key)
   const sourceId=actor.role==='phone'?profileKey(actor.deviceId,profile!):'owner'
   // Device clocks are not a shared ordering authority. A new observed blocker wins
   // conservatively; another profile's positive/unknown report cannot clear it.
   if(old?.state==='blocked'&&value.state!=='blocked'){
    if(value.state==='unknown')throw new TaskConflict('Known exhaustion requires an affirmative recheck before clearing it')
    if(actor.role==='phone'&&(old.sourceId!==sourceId||value.observedAt<=old.observedAt))return old
   }
   if(old&&old.sourceId===sourceId&&old.observedAt>value.observedAt&&value.state!=='blocked')return old
   if(old&&old.sourceId===sourceId&&old.observedAt===value.observedAt){
    const {sourceId:_,receivedAt:__,...prior}=old
    if(canonicalJson(prior)!==canonicalJson(value))throw new TaskConflict('Conflicting quota evidence timestamp')
    return old
   }
   const stored:AccountQuotaRecord={...value,sourceId,receivedAt:this.clock()}
   this.put('quotas',key,stored);return stored
  })
 }
 cadence(actor:TaskPrincipal,eventId:string,device:string,profile:string,hours:24|48){this.studio(actor);if(hours!==24&&hours!==48)throw new TaskConflict('Audit cadence must be 24 or 48 hours');return this.once(actor,eventId,{device,profile,hours},()=>{const p=this.profile(device,profile);p.audit.cadenceHours=hours;p.audit.dueAt=p.audit.lastSuccessfulAt===null?this.clock():p.audit.lastSuccessfulAt+hours*3_600_000;p.audit.nextCheckAt=Math.min(p.audit.nextCheckAt,p.audit.dueAt);this.put('profiles',p.id,p);return p})}
 private reserved(resource:string){return this.sql.exec('SELECT attempt_id FROM managed_reservations WHERE resource = ?',resource).toArray().length>0}
 private accountReservations(account:string){return this.sql.exec<{resource:string;attempt_id:string}>("SELECT resource,attempt_id FROM managed_reservations WHERE substr(resource,1,?) = ?",('account:'+account+':').length,'account:'+account+':').toArray()}
 private peer(device:string){return this.managed<{receivedAt:string;capabilities:string[];profileIds:string[]}>('peers',device)}
 private auditReason(p:ManagedAccountProfile):string|null {
  if(this.reserved('device:'+p.deviceId)||this.reserved('browser:'+p.deviceId))return 'busy'
  const peer=this.peer(p.deviceId),enrolled=this.managed<{profileId:string}>('enrollment',p.deviceId)
  if(enrolled?.profileId!==p.profileId)return 'not_enrolled'
  if(!peer||this.clock()-Date.parse(peer.receivedAt)>15*60_000)return 'offline'
  if(!peer.capabilities.includes('account-audit/1'))return 'update_phone_for_audits'
  return null
 }
 private refresh(){
  for(const row of this.sql.exec<{id:string;body:string}>('SELECT id,body FROM managed_enrollment LIMIT 129').toArray()){const e=JSON.parse(row.body);this.profile(row.id,e.profileId)}
  for(const p of this.rows<ManagedAccountProfile>('profiles')){
   if(p.audit.claimId||p.audit.dueAt>this.clock())continue
   const reason=this.auditReason(p)
   p.audit.state=reason?'deferred':p.audit.state==='failed'&&p.audit.nextCheckAt>this.clock()?'failed':'due';p.audit.reason=reason??(p.audit.state==='failed'?'check_failed':null)
   this.put('profiles',p.id,p)
  }
 }
 snapshot(actor:TaskPrincipal){this.studio(actor);return this.transaction(()=>{this.refresh();return {schema:'managed-accounts/1',policy:this.policy(),profiles:this.rows<ManagedAccountProfile>('profiles'),accounts:this.rows<ManagedAccount>('accounts'),quotas:this.rows<AccountQuota>('quotas'),waiting:this.rows('waiting'),issues:this.rows('issues'),reservations:this.sql.exec<{resource:string;attempt_id:string}>('SELECT resource,attempt_id FROM managed_reservations ORDER BY resource LIMIT 1001').toArray()}})}
 auditClaim(actor:TaskPrincipal,eventId:string,profile:string){
  if(actor.role!=='phone')throw new TaskConflict('Authenticated auditing phone required')
  return this.transaction(()=>{
   const p=this.profile(actor.deviceId,profile),prior=this.get<any>('audits',eventId)
   if(prior){if(prior.deviceId!==actor.deviceId||prior.profileId!==profile)throw new TaskConflict('Foreign audit receipt');return prior}
   const reason=!this.policy()?.auditsEnabled?'audits_disabled':p.audit.claimId?'audit_in_progress':p.audit.dueAt>this.clock()?'not_due':Math.max(p.audit.nextCheckAt,p.audit.retryNotBefore??0)>this.clock()?'retry_delay':this.auditReason(p)
   if(reason){if(!['not_due','audits_disabled','audit_in_progress'].includes(reason)){p.audit.state='deferred';p.audit.reason=reason;this.put('profiles',p.id,p)}return {state:'deferred',reason,dueAt:p.audit.dueAt}}
   if(!id(eventId))throw new TaskConflict('Exact audit ID required')
   const audit={id:eventId,deviceId:actor.deviceId,profileId:profile,state:'running',startedAt:this.clock(),finishedAt:null}
   for(const resource of ['device:'+actor.deviceId,'browser:'+actor.deviceId,'profile:'+actor.deviceId+':'+profile])this.sql.exec('INSERT INTO managed_reservations (resource,attempt_id) VALUES (?,?)',resource,'audit:'+eventId)
   p.audit.claimId=eventId;p.audit.state='running';p.audit.reason=null;this.put('profiles',p.id,p);this.put('audits',eventId,audit);return audit
  })
 }
 auditDefer(actor:TaskPrincipal,eventId:string,profile:string,reason:'busy'|'interrupted'){
  if(actor.role!=='phone')throw new TaskConflict('Authenticated phone required')
  if(!this.policy()?.auditsEnabled)return {state:'disabled'}
  return this.once(actor,eventId,{profile,reason},()=>{const p=this.profile(actor.deviceId,profile);if(!p.audit.claimId&&p.audit.dueAt<=this.clock()){p.audit.state='deferred';p.audit.reason=reason;this.put('profiles',p.id,p)}return p.audit})
 }
 auditFinish(actor:TaskPrincipal,eventId:string,auditId:string,observation:AccountObservation|null){
  if(actor.role!=='phone')throw new TaskConflict('Authenticated auditing phone required')
  return this.once(actor,eventId,{auditId,observation},()=>{
   const audit=this.get<any>('audits',auditId)
   if(!audit||audit.deviceId!==actor.deviceId||audit.state!=='running')throw new TaskConflict('Current original audit required')
   let p=this.profile(actor.deviceId,audit.profileId)
   if(p.audit.claimId!==auditId)throw new TaskConflict('Audit ownership changed')
   if(observation){if(observation.checkedAt<audit.startedAt-300_000||observation.checkedAt>this.clock()+300_000)throw new TaskConflict('Fresh audit observation required');p=this.saveObservation(actor.deviceId,audit.profileId,observation)}
   if(!observation){p.observation={checkedAt:Math.max(this.clock(),p.observation?.checkedAt??0),sites:{chatgpt:{login:'unknown',email:null,candidate:null,plan:null},gemini_apps:{login:'unknown',email:null,candidate:null,plan:null}}};this.issue(p,'chatgpt','Account check failed; readiness is unknown');this.issue(p,'gemini_apps','Account check failed; readiness is unknown')}
   const success=!!observation&&Object.values(observation.sites).every(s=>s.login!=='unknown')
   p.audit.claimId=null;p.audit.state=success?'success':'failed';p.audit.reason=success?null:'check_failed'
   if(success){p.audit.lastSuccessfulAt=observation!.checkedAt;p.audit.dueAt=observation!.checkedAt+p.audit.cadenceHours*3_600_000}
   p.audit.retryNotBefore=success?null:this.clock()+15*60_000
   p.audit.nextCheckAt=success?p.audit.dueAt:p.audit.retryNotBefore!
   this.put('profiles',p.id,p);audit.state=success?'success':'failed';audit.finishedAt=this.clock();this.put('audits',auditId,audit)
   // No expiry-based release: only the authenticated original worker acknowledges stopping its WebView.
   this.sql.exec('DELETE FROM managed_reservations WHERE attempt_id = ?','audit:'+auditId)
   return {audit,profile:p}
  })
 }
 select(actor:TaskPrincipal,task:CropTask,targets?:{deviceId:string;profileId:string}[]):AccountSelection {
  this.studio(actor);const policy=this.policy(),scope=taskScope(task.spec),now=this.clock(),quotas=this.rows<AccountQuota>('quotas')
  const enrolled=this.sql.exec<{id:string;body:string}>('SELECT id,body FROM managed_enrollment LIMIT 129').toArray()
  const candidates=(targets??enrolled.map(e=>({deviceId:e.id,profileId:JSON.parse(e.body).profileId}))).map(target=>{
   const reasons:string[]=[],p=this.profile(target.deviceId,target.profileId),site=p.observation?.sites[scope.product as 'chatgpt'|'gemini_apps'],link=p.links[scope.product],account=link?this.get<ManagedAccount>('accounts',link.accountId):null,peer=this.peer(target.deviceId),enrollment=this.managed<{profileId:string}>('enrollment',target.deviceId)
   if(!policy?.enabled)reasons.push('account_routing_disabled')
   if(task.state!=='queued'||task.attemptId)reasons.push('task_already_owned_or_held')
   if(enrollment?.profileId!==target.profileId)reasons.push('profile_not_enrolled')
   if(!policy?.allowed.some(c=>c.provider===task.spec.provider&&c.product===task.spec.product&&c.model===task.spec.model&&c.mode===task.spec.settings.mode&&c.effort===task.spec.settings.effort))reasons.push('configuration_not_allowed_by_policy')
   if(!isDefaultCropPilot(task.spec)||(!peer?.capabilities.includes(SLICED_CROP_CAPABILITY)||!peer.capabilities.includes('account-selection/1')))reasons.push('required_capability_unverified')
   if(!peer||now-Date.parse(peer.receivedAt)>15*60_000||!peer.profileIds.includes(target.profileId))reasons.push('device_offline_or_stale')
   if(!site||site.login==='unknown')reasons.push('login_unknown_audit_required');else if(site.login==='signed_out')reasons.push('sign_in_required')
   if(!p.observation||now-p.observation.checkedAt>(policy?.criticalMaxAgeHours??24)*3_600_000)reasons.push('critical_evidence_stale_audit_required')
   if(!account||!site?.candidate||link?.candidate!==site.candidate)reasons.push('account_identity_confirmation_required')
   if(['device:'+p.deviceId,'browser:'+p.deviceId,'profile:'+p.deviceId+':'+p.profileId].some(r=>this.reserved(r)))reasons.push('device_browser_or_profile_reserved')
   const matching=quotas.filter(q=>q.accountId===account?.id&&(scopeMatches(q.scope,scope)||scopeMatches(q.scope,{...scope,feature:'uploads'})))
   if(!matching.length&&!policy?.allowUnknownQuota)reasons.push('quota_unknown')
   for(const q of matching){if(q.state==='blocked')reasons.push(q.recheckAt!==null&&q.recheckAt<=now?'quota_reset_requires_recheck':'quota_exhausted');else if(q.state==='unknown'&&!policy?.allowUnknownQuota)reasons.push('quota_unknown');if(q.state==='available'&&(q.recheckAt!==null&&q.recheckAt<=now||now-q.observedAt>(policy?.criticalMaxAgeHours??24)*3_600_000))reasons.push('quota_evidence_requires_recheck');if(['estimated','locally_counted'].includes(q.evidence)&&!policy?.allowEstimatedQuota)reasons.push('estimated_quota_not_permitted')}
   const used=account?this.accountReservations(account.id).length:0
   if(account&&used>=account.maxConcurrent)reasons.push('shared_account_capacity_reserved')
   const preference=policy?.preferredProfiles.indexOf(p.id)??-1
   return {...target,accountId:account?.id??null,reasons:[...new Set(reasons)],rank:(preference<0?1000:preference)*100+used}
  }).sort((a,b)=>a.rank-b.rank||(profileKey(a.deviceId,a.profileId)<profileKey(b.deviceId,b.profileId)?-1:profileKey(a.deviceId,a.profileId)>profileKey(b.deviceId,b.profileId)?1:0))
  const selected=candidates.find(c=>!c.reasons.length),times=quotas.map(q=>q.recheckAt).filter((t):t is number=>t!==null&&t>now)
  return {routingRequired:!!this.get('policies','routing-established'),state:selected?'eligible':'waiting',selected:selected?{deviceId:selected.deviceId,profileId:selected.profileId,accountId:selected.accountId!}:null,candidates,nextCheckAt:times.length?Math.min(...times):null,policyRevision:policy?.revision??null}
 }
 /** Called only inside TaskAuthority.claim's transaction. All reservations and the pin commit together. */
 reserve(task:CropTask,attempt:CropAttempt):AccountSelectionPin|null {
  if(!this.policy()?.enabled){if(this.get('policies','routing-established'))throw new AccountWaiting(this.select({role:'studio'},task,[{deviceId:attempt.deviceId,profileId:attempt.profileId}]));return null}
  const selection=this.select({role:'studio'},task,[{deviceId:attempt.deviceId,profileId:attempt.profileId}])
  if(!selection.selected)throw new AccountWaiting(selection)
  const account=this.get<ManagedAccount>('accounts',selection.selected.accountId)!,p=this.profile(attempt.deviceId,attempt.profileId)
  let slot=0;while(slot<account.maxConcurrent&&this.reserved('account:'+account.id+':'+slot))slot++
  if(slot===account.maxConcurrent)throw new AccountWaiting(selection)
  this.sql.exec('INSERT INTO managed_reservations (resource,attempt_id) VALUES (?,?)','account:'+account.id+':'+slot,attempt.id)
  if(attempt.accountId!==null&&attempt.accountId!==account.id)throw new TaskConflict('Requested account does not match confirmed identity')
  attempt.accountId=account.id
  this.sql.exec('DELETE FROM managed_account_waiting WHERE id = ?',task.id)
  return {policy:this.policy()!,selectedAt:this.clock(),accountId:account.id,observationAt:p.observation!.checkedAt,quotaEvidence:this.rows<AccountQuota>('quotas').filter(q=>q.accountId===account.id&&(scopeMatches(q.scope,taskScope(task.spec))||scopeMatches(q.scope,{...taskScope(task.spec),feature:'uploads'}))),configuration:structuredClone(task.spec),reason:'Fresh signed-in identity, approved configuration, scoped quota policy and atomic shared capacity'}
 }
 clearWaiting(taskId:string){this.sql.exec('DELETE FROM managed_account_waiting WHERE id = ?',taskId)}
 waiting(taskId:string,selection:AccountSelection){
  this.transaction(()=>{
   this.put('waiting',taskId,{taskId,observedAt:this.clock(),...selection})
   for(const c of selection.candidates){
    const p=this.profile(c.deviceId,c.profileId)
    const quotaRecheck=c.reasons.some(r=>['quota_reset_requires_recheck','quota_evidence_requires_recheck'].includes(r))&&this.rows<AccountQuota>('quotas').some(q=>q.accountId===c.accountId&&(q.recheckAt??(q.observedAt+(this.policy()?.criticalMaxAgeHours??24)*3_600_000))<=this.clock()&&(p.audit.lastSuccessfulAt??0)<(q.recheckAt??(q.observedAt+(this.policy()?.criticalMaxAgeHours??24)*3_600_000)))
    if(!p.audit.claimId&&(quotaRecheck||c.reasons.some(r=>r.includes('audit_required')))){
     p.audit.dueAt=Math.min(p.audit.dueAt,this.clock());p.audit.nextCheckAt=Math.min(p.audit.nextCheckAt,this.clock())
     // retryNotBefore remains independent: repeated preflights cannot defeat a failed-check cooldown.
     this.put('profiles',p.id,p)
    }
   }
  })
 }
}
