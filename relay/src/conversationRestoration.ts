import {RetainedCorrectionConsumer} from './retainedCorrectionConsumer'
import {RetainedContextBinding} from './retainedContextBinding'
import {artifactHash} from '../../server/src/services/managedCropArtifact'
import {retainedContextInspection,retainedContextTarget,RETAINED_TARGET_READINESS_SCHEMA,RETAINED_CONTEXT_AUTHORITY_SCHEMA} from '../../server/src/services/retainedContextAuthorityProtocol'
import type {TaskSql,TaskAuthority} from './taskAuthority'
import {TaskConflict,canonicalJson,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {CONVERSATION_SCHEMA,parseConversationFence,parseRestorationFence,baseConversationFence,RETAINED_RESTORATION_CAPABILITY,type RestorationFence,parseConversationRecord,conversationProof,conversationKey,sameConversationFence,type ConversationFence,type ConversationRecord} from '../../server/src/services/conversationRestorationProtocol'
import {recoveryUnitKey,type RecoveryUnit} from '../../server/src/services/automationRecoveryPolicy'
import {profileKey,taskScope,scopeMatches,parseAccountQuota,type AccountQuota,type ManagedAccountProfile,type AccountPolicy,type ManagedAccount} from '../../server/src/services/managedAccountsProtocol'
import {recoveryId} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {initRecoveryBudget,sharedRecoveryBudget,assertRecoveryReservation,assertRecoveryControls} from './recoveryBudget'
/** Opens only the privately retained original completed conversation in the same live owner view. No provider resend or handoff. */
export class ConversationRestoration {
 constructor(private sql:TaskSql,private tx:<T>(work:()=>T)=>T,private authority:TaskAuthority,private now=Date.now){initRecoveryBudget(sql)}
 private row<T>(table:string,id:string):T|null{const r=this.sql.exec<{body:string}>('SELECT body FROM '+table+' WHERE id = ?',id).toArray()[0];return r?JSON.parse(r.body):null}
 private get(f:ConversationFence){const r=this.row<unknown>('managed_conversation_recovery_episodes',conversationKey(f));return r?parseConversationRecord(r):null}
 private put(r:ConversationRecord){parseConversationRecord(r);this.sql.exec('INSERT INTO managed_conversation_recovery_episodes (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',conversationKey(r.fence),JSON.stringify(r))}
 private context(actor:TaskPrincipal,f:ConversationFence,admit=false){
  parseConversationFence(f);const u=f.unit;this.authority.assertWorkspace(u.taskId,u.workspaceId)
  const owner=this.authority.artifactOwner(actor,u.taskId,u.attemptId,u.generation,u.fingerprint),a=owner.attempt,t=owner.task,r=this.get(f)
  if(a.deviceId!==f.deviceId||a.profileId!==f.profileId||a.activeCommandId!==f.commandId||r&&!sameConversationFence(baseConversationFence(r.fence),f))throw new TaskConflict('Exact original conversation owner and private anchor required')
  if(admit){
   const p=a.accountSelection,policy=this.row<AccountPolicy>('managed_account_policies','crop_json'),peer=this.row<{capabilities:string[];receivedAt:string}>('managed_peers',f.deviceId),enrolled=this.row<{profileId:string}>('managed_enrollment',f.deviceId),profile=this.row<ManagedAccountProfile>('managed_account_profiles',profileKey(f.deviceId,f.profileId)),site=profile?.observation?.sites.chatgpt,link=profile?.links.chatgpt
   if(t.canonical||t.state!=='running'||a.phase!=='submitted'||a.submission!=='submitted'||a.checkpointRef!==null||!Number.isFinite(Date.parse(a.leaseExpiresAt))||Date.parse(a.leaseExpiresAt)<=this.now()+30000)throw new TaskConflict('Original acknowledged submitted hold and current original lease required')
   if(!p||a.accountId!==f.context.accountId||p.accountId!==a.accountId||p.policy.revision!==f.context.policyRevision||policy?.revision!==f.context.policyRevision||!policy.enabled||canonicalJson(p.configuration)!==canonicalJson(t.spec)||!policy.allowed.some(c=>c.provider===t.spec.provider&&c.product===t.spec.product&&c.model===t.spec.model&&c.mode===t.spec.settings.mode&&c.effort===t.spec.settings.effort))throw new TaskConflict('Current original pinned conversation policy required')
   if(t.spec.provider!=='chatgpt'||t.spec.product!=='chatgpt-web'||!t.spec.dependencies.some(d=>d.id===t.pageId&&d.revision===t.spec.pageRevision&&d.sha256===f.context.sourceSha256)||enrolled?.profileId!==f.profileId||!peer?.capabilities.includes(CONVERSATION_SCHEMA)||!Number.isFinite(Date.parse(peer.receivedAt))||Date.parse(peer.receivedAt)>this.now()||this.now()-Date.parse(peer.receivedAt)>15*60000||f.context.capturedAt>this.now())throw new TaskConflict('Current original input and compatible original phone required')
   const account=this.row<ManagedAccount>('managed_account_accounts',f.context.accountId)
   if(!profile?.observation||site?.login!=='signed_in'||!link||site.candidate!==link.candidate||link.accountId!==f.context.accountId||profile.observation.checkedAt>this.now()||this.now()-profile.observation.checkedAt>policy.criticalMaxAgeHours*3600000||!account||account.provider!=='openai'||account.candidate!==link.candidate||!Number.isSafeInteger(account.maxConcurrent)||account.maxConcurrent<1)throw new TaskConflict('Fresh confirmed original identity is required; no automatic login or account switch')
   for(const resource of ['device:'+f.deviceId,'browser:'+f.deviceId,'profile:'+f.deviceId+':'+f.profileId])if(this.sql.exec<{attempt_id:string}>('SELECT attempt_id FROM managed_reservations WHERE resource = ?',resource).toArray()[0]?.attempt_id!==a.id)throw new TaskConflict('Original conversation reservations required')
   const prefix='account:'+a.accountId+':',slots=this.sql.exec<{attempt_id:string;resource:string}>('SELECT attempt_id,resource FROM managed_reservations WHERE substr(resource,1,?) = ?',prefix.length,prefix).toArray()
   if(slots.length>account.maxConcurrent||!slots.some(s=>s.attempt_id===a.id&&/^\d+$/.test(s.resource.slice(prefix.length))&&Number(s.resource.slice(prefix.length))<account.maxConcurrent))throw new TaskConflict('Original confirmed account capacity required')
  }
  return {...owner,record:r}
 }
 private restorationContext(actor:TaskPrincipal,raw:RestorationFence,admit=false){
  const f=parseRestorationFence(raw),c=this.context(actor,baseConversationFence(f),admit)
  if(c.record&&!sameConversationFence(c.record.fence,f))throw new TaskConflict('Original restoration mode and fence are immutable')
  if(admit&&f.retained){
   const b=this.bindings().get(baseConversationFence(f)),a=b?.actions[0],ref=f.retained
   if(!b||!b.enabled||b.paused||b.cancelled||!a||a.phase!=='verified'||a.id!==ref.bindingActionId||b.candidateId!==ref.candidateId||b.target.bindingId!==ref.bindingId)throw new TaskConflict('Verified original retained association required')
   const peer=this.row<{capabilities:string[]}>('managed_peers',f.deviceId)
   if(!peer?.capabilities.includes(RETAINED_RESTORATION_CAPABILITY))throw new TaskConflict('Compatible retained restoration consumer required')
  }
  return c
 }
 discover(actor:TaskPrincipal,u:RecoveryUnit){recoveryUnitKey(u);this.authority.assertWorkspace(u.taskId,u.workspaceId);this.authority.artifactOwner(actor,u.taskId,u.attemptId,u.generation,u.fingerprint);const r=this.row<unknown>('managed_conversation_recovery_episodes',recoveryUnitKey(u));return r?parseConversationRecord(r):null}
 offer(actor:TaskPrincipal,f:RestorationFence,raw:unknown){if(actor.role!=='phone'||actor.deviceId!==f.deviceId)throw new TaskConflict('Original phone offer required');return this.tx(()=>{const c=this.restorationContext(actor,f,true),proof=conversationProof(raw,f,this.now(),false),old=c.record
  if(old?.actions.some(a=>a.phase!=='safe_failure'))return old
  if(!old&&this.sql.exec('SELECT id FROM managed_conversation_recovery_episodes LIMIT 129').toArray().length>=128)throw new TaskConflict('Conversation restoration inventory full')
  const r:ConversationRecord=old??{schema:CONVERSATION_SCHEMA,fence:structuredClone(f),revision:0,enabled:false,paused:false,cancelled:false,nextEligibleAt:0,offer:proof,actions:[]};if(proof.observedAt<r.offer.observedAt)throw new TaskConflict('Original offer cannot move backward');r.offer=proof;r.revision++;this.put(r);return r})}
 control(actor:TaskPrincipal,f:RestorationFence,revision:number,enabled:boolean,paused:boolean,cancelled:boolean){if(actor.role!=='studio')throw new TaskConflict('Studio admission required');return this.tx(()=>{const r=this.restorationContext(actor,f,enabled&&!paused&&!cancelled).record;if(!r||r.revision!==revision||![enabled,paused,cancelled].every(x=>typeof x==='boolean'))throw new TaskConflict('Exact conversation controls required');r.enabled=enabled;r.paused=paused;r.cancelled=r.cancelled||cancelled;r.revision++;this.put(r);return r})}
 reserve(actor:TaskPrincipal,f:RestorationFence,revision:number,id:string){if(actor.role!=='studio')throw new TaskConflict('Studio grant required');return this.tx(()=>{const r=this.restorationContext(actor,f,true).record;this.ready(r);if(r.revision!==revision||!recoveryId(id)||(f.retained?r.actions.length>0:r.actions.some(a=>a.phase!=='safe_failure')))throw new TaskConflict('Exact original bounded conversation grant required');conversationProof(r.offer,f,this.now(),false);assertRecoveryReservation(this.sql,f.unit,id,this.now());r.actions.push({id,at:this.now(),phase:'reserved',finishedAt:null,evidenceRef:null,before:null,after:null,effect:null});r.revision++;this.put(r);return r})}
 private ready(r:ConversationRecord|null):asserts r is ConversationRecord{if(!r||!r.enabled||r.paused||r.cancelled)throw new TaskConflict('Conversation restoration is disabled, paused or cancelled')}
 start(actor:TaskPrincipal,f:RestorationFence,id:string,raw:unknown){if(actor.role!=='phone'||actor.deviceId!==f.deviceId)throw new TaskConflict('Original executor required');return this.tx(()=>{const r=this.restorationContext(actor,f,true).record;this.ready(r);assertRecoveryControls(this.sql,f.unit);const a=r.actions.at(-1);if(a?.id!==id||a.phase!=='reserved')throw new TaskConflict('Original unstarted grant required; never repeat conversation');a.before=conversationProof(raw,f,this.now(),false);if(a.before.observedAt<a.at)throw new TaskConflict('Sample the original view after its grant');a.phase='executing';a.effect='possible';r.revision++;this.put(r);return r})}
 check(actor:TaskPrincipal,f:RestorationFence,id:string,raw:unknown){if(actor.role!=='phone'||actor.deviceId!==f.deviceId)throw new TaskConflict('Original executor required');return this.tx(()=>{const r=this.restorationContext(actor,f,true).record;this.ready(r);assertRecoveryControls(this.sql,f.unit);if(r.actions.at(-1)?.id!==id||r.actions.at(-1)?.phase!=='executing')throw new TaskConflict('Exact original executing grant required');const proof=conversationProof(raw,f,this.now(),false);if(proof.observedAt<(r.actions.at(-1)?.before?.observedAt??0))throw new TaskConflict('Current original pre-action sample required');return r})}
 finish(actor:TaskPrincipal,f:RestorationFence,id:string,outcome:'verified'|'unknown'|'safe_failure',effect:'not_touched'|'possible'|'opened_original',raw:unknown){
  if(actor.role!=='phone'||actor.deviceId!==f.deviceId)throw new TaskConflict('Original executor outcome required')
  return this.tx(()=>{const r=this.get(f);if(!r||!sameConversationFence(r.fence,f))throw new TaskConflict('Original conversation ledger required');const a=r.actions.find(action=>action.id===id)
   if(a?.id!==id||!['reserved','executing','unknown','verified','safe_failure'].includes(a.phase))throw new TaskConflict('Original started action outcome required')
   if(a.phase==='reserved'&&outcome!=='safe_failure')throw new TaskConflict('Only the original untouched reservation can be withdrawn')
   if(a.phase==='unknown'&&(outcome==='safe_failure'||effect==='not_touched'))throw new TaskConflict('An uncertain physical effect cannot become untouched')
   const after=outcome==='verified'?conversationProof(raw,f,(raw as {observedAt:number})?.observedAt,true):null
   if(outcome!=='verified'&&raw!==null)throw new TaskConflict('No fabricated postcondition for an uncertain or untouched result')
   if(!['verified','unknown','safe_failure'].includes(outcome)||!['not_touched','possible','opened_original'].includes(effect)||outcome==='verified'&&(!['not_touched','opened_original'].includes(effect)||!a.before||!after||after.observedAt<a.before.observedAt)||outcome==='safe_failure'&&effect!=='not_touched'||outcome==='unknown'&&effect!=='possible')throw new TaskConflict('Exact physical-effect and postcondition evidence required')
   if(a.phase==='verified'||a.phase==='safe_failure'){if(a.phase!==outcome||a.effect!==effect||canonicalJson(a.after)!==canonicalJson(after))throw new TaskConflict('Conflicting immutable conversation outcome');return r}
   if(a.phase===outcome&&a.effect===effect&&canonicalJson(a.after)===canonicalJson(after))return r
   if(after)conversationProof(after,f,this.now(),true)
   a.phase=outcome;a.effect=effect;a.after=after;a.finishedAt=this.now();a.evidenceRef='conversation/'+id;if(outcome==='safe_failure')r.nextEligibleAt=this.now()+30000;r.revision++;this.put(r);return r
  })
 }
 retainedNavigationPermit(actor:TaskPrincipal,f:RestorationFence,id:string,raw:unknown){
  if(!f.retained)throw new TaskConflict('Distinct retained navigation permit only')
  this.check(actor,f,id,raw)
  const c=this.restorationContext(actor,f,true),p=conversationProof(raw,f,this.now(),false)
  const peer=this.row<{receivedAt:string}>('managed_peers',f.deviceId)!,profile=this.row<ManagedAccountProfile>('managed_account_profiles',profileKey(f.deviceId,f.profileId))!,policy=this.row<AccountPolicy>('managed_account_policies','crop_json')!
  const issuedAt=this.now(),validUntil=Math.min(issuedAt+15000,p.observedAt+15000,Date.parse(c.attempt.leaseExpiresAt)-30000,Date.parse(peer.receivedAt)+15*60000,profile.observation!.checkedAt+policy.criticalMaxAgeHours*3600000)
  if(!Number.isSafeInteger(validUntil)||validUntil<=issuedAt)throw new TaskConflict('Retained navigation authority expired')
  return {schema:'retained-conversation-navigation-permit/1',actionId:id,bindingActionId:f.retained.bindingActionId,candidateId:f.retained.candidateId,bindingId:f.retained.bindingId,anchorSha256:f.anchorSha256,issuedAt,validUntil,navigationAllowed:true,providerExecutionAllowed:false,resendAllowed:false,fallbackAllowed:false,originalView:false}
 }
 /** Read-only current authority. This is not a lease, reservation, grant, view adoption or outcome receipt. */
 async verifyRetainedContext(actor:TaskPrincipal,f:ConversationFence,raw:unknown){
  if(actor.role!=='phone'||actor.deviceId!==f.deviceId)throw new TaskConflict('Original phone observation required')
  parseConversationFence(f)
  const pinned=structuredClone(f),inspection=retainedContextInspection(raw,pinned,this.now())
  const [fenceSha256,inspectionSha256]=await Promise.all([artifactHash(new TextEncoder().encode(canonicalJson(pinned))),artifactHash(new TextEncoder().encode(canonicalJson(inspection)))])
  return this.tx(()=>{
   const c=this.context(actor,pinned,true),checkedAt=this.now()
   retainedContextInspection(inspection,pinned,checkedAt);assertRecoveryControls(this.sql,pinned.unit)
   if(sharedRecoveryBudget(this.sql,pinned.unit).pending)throw new TaskConflict('Original recovery action still needs reconciliation; no view may be adopted')
   const policy=this.row<AccountPolicy>('managed_account_policies','crop_json')!,profile=this.row<ManagedAccountProfile>('managed_account_profiles',profileKey(pinned.deviceId,pinned.profileId))!,peer=this.row<{receivedAt:string}>('managed_peers',pinned.deviceId)!
   const validUntil=Math.min(checkedAt+15000,inspection.observedAt+120000,Date.parse(c.attempt.leaseExpiresAt)-30000,profile.observation!.checkedAt+policy.criticalMaxAgeHours*3600000,Date.parse(peer.receivedAt)+15*60000)
   if(!Number.isSafeInteger(checkedAt)||!Number.isSafeInteger(validUntil)||validUntil<=checkedAt)throw new TaskConflict('Current authority evidence expired; inspect again')
   return {schema:RETAINED_CONTEXT_AUTHORITY_SCHEMA,workspaceId:pinned.unit.workspaceId,fenceSha256,inspectionSha256,checkedAt,validUntil,authorityCurrent:true,executionAllowed:false,rebindAllowed:false,fallbackAllowed:false,resendAllowed:false}
  })
 }
 /** Snapshot for a replacement view in the original profile; never releases or transfers ownership. */
 async verifyRetainedTarget(actor:TaskPrincipal,f:ConversationFence,rawInspection:unknown,rawTarget:unknown){
  if(actor.role!=='phone'||actor.deviceId!==f.deviceId)throw new TaskConflict('Original phone target observation required')
  parseConversationFence(f)
  const pinned=structuredClone(f),inspection=retainedContextInspection(rawInspection,pinned,this.now()),target=retainedContextTarget(rawTarget,pinned,inspection)
  const hash=(v:unknown)=>artifactHash(new TextEncoder().encode(canonicalJson(v)))
  const [fenceSha256,inspectionSha256,targetSha256]=await Promise.all([hash(pinned),hash(inspection),hash(target)])
  return this.tx(()=>{const {checkedAt,validUntil}=this.targetContext(actor,pinned,inspection,target);return {schema:RETAINED_TARGET_READINESS_SCHEMA,workspaceId:pinned.unit.workspaceId,fenceSha256,inspectionSha256,targetSha256,checkedAt,validUntil,accountObservationAt:target.accountObservationAt,targetReady:true,executionAllowed:false,rebindAllowed:false,fallbackAllowed:false,resendAllowed:false}})
 }
 private targetContext(actor:TaskPrincipal,pinned:ConversationFence,rawInspection:unknown,rawTarget:unknown,allowOwnBinding=false){
  const inspection=retainedContextInspection(rawInspection,pinned,this.now()),target=retainedContextTarget(rawTarget,pinned,inspection)
   const c=this.context(actor,pinned,true),checkedAt=this.now()
   retainedContextInspection(inspection,pinned,checkedAt);retainedContextTarget(target,pinned,inspection);assertRecoveryControls(this.sql,pinned.unit)
   if(sharedRecoveryBudget(this.sql,pinned.unit).pending){
    const own=this.bindings().get(pinned),ownPending=own?.actions.some(a=>['reserved','executing','unknown'].includes(a.phase))
    const otherPending=['managed_recovery_episodes','managed_upload_recovery_episodes','managed_account_recovery_episodes','managed_navigation_recovery_episodes','managed_ui_recovery_episodes','managed_correction_recovery_episodes','managed_conversation_recovery_episodes'].some(table=>{const row=this.sql.exec<{body:string}>('SELECT body FROM '+table+' WHERE id = ?',recoveryUnitKey(pinned.unit)).toArray()[0];return row&&JSON.parse(row.body).actions.some((a:{phase:string})=>['reserved','executing','unknown'].includes(a.phase))})
    if(!allowOwnBinding||!ownPending||otherPending)throw new TaskConflict('Reconcile the original pending recovery before target readiness')
   }
   if(canonicalJson(target.configuration)!==canonicalJson(c.task.spec))throw new TaskConflict('Target configuration must preserve the exact original pinned task')
   const policy=this.row<AccountPolicy>('managed_account_policies','crop_json')!,profile=this.row<ManagedAccountProfile>('managed_account_profiles',profileKey(pinned.deviceId,pinned.profileId))!,peer=this.row<{receivedAt:string;profileIds:string[];capabilities:string[]}>('managed_peers',pinned.deviceId)!
   if(!peer.profileIds.includes(pinned.profileId)||!peer.capabilities.includes('account-selection/1'))throw new TaskConflict('Current target profile capability required')
   const observedAt=profile.observation!.checkedAt
   if(observedAt!==target.accountObservationAt||!Number.isSafeInteger(observedAt)||observedAt>checkedAt||checkedAt-observedAt>=120000)throw new TaskConflict('Fresh independent target account observation required')
   // Inspect retained rows without refreshing, selecting, reserving or mutating an owned task.
   const rows=this.sql.exec<{body:string}>('SELECT body FROM managed_account_quotas ORDER BY id LIMIT 1001').toArray()
   if(rows.length>1000)throw new TaskConflict('Quota inventory requires pagination')
   const scope=taskScope(c.task.spec),quotas:AccountQuota[]=[]
   for(const row of rows){const q=JSON.parse(row.body);if(q.accountId===target.accountId){const parsed=parseAccountQuota({accountId:q.accountId,scope:q.scope,state:q.state,evidence:q.evidence,observedAt:q.observedAt,recheckAt:q.recheckAt},checkedAt);if(scopeMatches(parsed.scope,scope))quotas.push(parsed)}}
   if(!quotas.length||quotas.some(q=>q.state!=='available'||!['observed','owner_supplied'].includes(q.evidence)||q.observedAt>checkedAt||checkedAt-q.observedAt>=policy.criticalMaxAgeHours*3600000||q.recheckAt!==null&&q.recheckAt<=checkedAt))throw new TaskConflict('Current independently supported generation quota required; blocked or unknown limits stay held')
   const validUntil=Math.min(checkedAt+15000,inspection.observedAt+120000,observedAt+120000,Date.parse(c.attempt.leaseExpiresAt)-30000,Date.parse(peer.receivedAt)+15*60000,...quotas.map(q=>Math.min(q.observedAt+policy.criticalMaxAgeHours*3600000,q.recheckAt??Number.MAX_SAFE_INTEGER)))
   if(!Number.isSafeInteger(checkedAt)||!Number.isSafeInteger(validUntil)||validUntil<=checkedAt)throw new TaskConflict('Target readiness evidence expired')
   return {checkedAt,validUntil}
 }
 private bindings():RetainedContextBinding{return new RetainedContextBinding(this.sql,this.tx,(actor,f,i,t)=>{const peer=this.row<{capabilities:string[]}>('managed_peers',f.deviceId);if(!peer?.capabilities.includes('retained-context-binding/1'))throw new TaskConflict('Compatible retained binding executor required');return this.targetContext(actor,f,i,t,true)},this.now)}
 binding(actor:TaskPrincipal,f:ConversationFence,action:string,details:unknown){
  if(action!=='finish-binding')this.context(actor,f)
  return this.bindings().perform(actor,f,action,details)
 }
 offerBinding(actor:TaskPrincipal,f:ConversationFence,inspection:unknown,target:unknown,candidateId:string){
  // All admission checks and the immutable offer commit synchronously in the same authority transaction.
  return this.bindings().offer(actor,f,inspection,target,candidateId)
 }

 /** Discover the distinct binding even when no legacy same-view restoration offer exists. */
 bindingStatus(actor:TaskPrincipal,u:RecoveryUnit){
  recoveryUnitKey(u);this.authority.assertWorkspace(u.taskId,u.workspaceId);this.authority.artifactOwner(actor,u.taskId,u.attemptId,u.generation,u.fingerprint)
  const raw=this.row<any>('managed_retained_binding_episodes',recoveryUnitKey(u))
  const binding=raw?this.bindings().get(parseConversationFence(raw.fence)):null
  if(binding&&recoveryUnitKey(binding.fence.unit)!==recoveryUnitKey(u))throw new TaskConflict('Original retained binding unit required')
  let admissionReady=false
  if(binding&&!binding.actions.length&&!binding.cancelled){try{
   const peer=this.row<{capabilities:string[]}>('managed_peers',binding.fence.deviceId)
   if(!peer?.capabilities.includes('retained-context-binding/1'))throw new TaskConflict('Compatible binding executor required')
   this.targetContext(actor,binding.fence,binding.inspection,binding.target);admissionReady=true
  }catch{}}
  return {binding,permit:null,admissionReady,budget:sharedRecoveryBudget(this.sql,u)}
 }
 /** Consume a verified replacement association only for a separate local correction save grant. */
 checkRetainedCorrection(actor:TaskPrincipal,f:ConversationFence,details:unknown){
  return new RetainedCorrectionConsumer(this.sql,this.tx,(a,pinned)=>{
   const c=this.context(a,pinned,true),peer=this.row<{capabilities:string[];receivedAt:string}>('managed_peers',pinned.deviceId)!
   if(!peer.capabilities.includes('retained-binding-local-correction/1')||!peer.capabilities.includes('managed-correction-recovery/1'))throw new TaskConflict('Compatible local correction consumer required')
   const policy=this.row<AccountPolicy>('managed_account_policies','crop_json')!,profile=this.row<ManagedAccountProfile>('managed_account_profiles',profileKey(pinned.deviceId,pinned.profileId))!
   return Math.min(Date.parse(c.attempt.leaseExpiresAt)-30000,Date.parse(peer.receivedAt)+15*60000,profile.observation!.checkedAt+policy.criticalMaxAgeHours*3600000)
  },this.now).check(actor,f,details)
 }
 budget(unit:RecoveryUnit){return sharedRecoveryBudget(this.sql,unit)}
 status(actor:TaskPrincipal,f:RestorationFence){const c=this.restorationContext(actor,f);let admissionReady=false;try{this.restorationContext(actor,f,true);if(c.record){if(!c.record.actions.some(a=>['reserved','executing','unknown'].includes(a.phase)))conversationProof(c.record.offer,f,this.now(),false);admissionReady=true}}catch{}return {record:c.record,admissionReady,budget:sharedRecoveryBudget(this.sql,f.unit)}}
}
