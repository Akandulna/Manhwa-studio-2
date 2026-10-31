import {parseHandoffRecord} from '../../server/src/services/accountHandoffProtocol'
import {parseAdoptionRecord} from '../../server/src/services/candidateAdoptionProtocol'
import {recoveryFamilyUnits,RECOVERY_LEDGER_TABLES} from './recoveryLineage'
import type {TaskSql,TaskAuthority} from './taskAuthority'
import {TaskConflict,canonicalJson,type TaskPrincipal,type CropAttempt} from '../../server/src/services/managedTaskProtocol'
import {parseAccountPolicy,parseAccountQuota,profileKey,scopeMatches,taskScope,type ManagedAccountProfile,type ManagedAccount,type AccountQuota} from '../../server/src/services/managedAccountsProtocol'
import {isDefaultCropPilot,SLICED_CROP_CAPABILITY} from '../../server/src/services/managedCropPilotPolicy'
import {recoveryUnitKey,type RecoveryUnit} from '../../server/src/services/automationRecoveryPolicy'
import {FALLBACK_PREFLIGHT_SCHEMA,EXECUTION_BLOCKERS,fallbackTargets,parseFallbackPreflight,type FallbackPreflight,type SOURCE_BLOCKERS,type TARGET_BLOCKERS} from '../../server/src/services/fallbackPreflightProtocol'
import {assertRecoveryControls,sharedRecoveryBudget} from './recoveryBudget'
import {boundedBody} from './managedArtifactStorage'
import {recoveryExact} from '../../server/src/services/managedSavedImportRecoveryProtocol'
/** Inspection reads actual records only. It must not call selection/snapshot helpers that create rows or schedule audits. */
export class FallbackPreflightAuthority {
 constructor(private sql:TaskSql,private tx:<T>(work:()=>T)=>T,private authority:TaskAuthority,private now=Date.now){}
 /** Internal continuation of exactly one already charged retention action. Public preflight stays unchanged. */
 originalAdoptionContinuation(unit:RecoveryUnit,target:{deviceId:string;profileId:string},actionId:string):FallbackPreflight {
  const snapshot=this.inspect({role:'studio'},unit,[target]),adoptionRow=this.sql.exec<{body:string}>('SELECT body FROM managed_candidate_adoption_episodes WHERE id = ?',recoveryUnitKey(unit)).toArray()[0],handoffRow=this.sql.exec<{body:string}>('SELECT body FROM managed_account_handoff_episodes WHERE id = ?',recoveryUnitKey(unit)).toArray()[0],isHandoff=!!handoffRow&&parseHandoffRecord(JSON.parse(handoffRow.body)).actions.some(a=>a.id===actionId),row=isHandoff?handoffRow:adoptionRow
  if(!row)throw new TaskConflict('Original charged retention action required')
  const record=isHandoff?parseHandoffRecord(JSON.parse(row.body)):parseAdoptionRecord(JSON.parse(row.body)),action=record.actions.find(a=>a.id===actionId) as any
  if(recoveryUnitKey(record.fence.unit)!==recoveryUnitKey(unit)||!record.enabled||record.paused||record.cancelled||!action||!['reserved','prepared','executing'].includes(action.phase)||canonicalJson((isHandoff?action.candidate.context:action.context).target)!==canonicalJson(target))throw new TaskConflict('Exact active retention continuation required')
  for(const member of recoveryFamilyUnits(this.sql,unit))for(const table of RECOVERY_LEDGER_TABLES){const row=this.sql.exec<{body:string}>('SELECT body FROM '+table+' WHERE id = ?',recoveryUnitKey(member)).toArray()[0];if(row&&JSON.parse(row.body).actions.some((a:any)=>['reserved','prepared','executing','unknown'].includes(a.phase)&&a.id!==actionId))throw new TaskConflict('Another original action requires reconciliation')}
  if(snapshot.source.reasons.some(r=>!['shared_recovery_pending','shared_budget_exhausted'].includes(r))||!snapshot.targets[0].authorityEligible)throw new TaskConflict('Original release and target prerequisites changed')
  // Counts, pending and exhausted remain truthful. Only this internal caller may finish the charged action.
  return snapshot
 }
 inspect(actor:TaskPrincipal,unit:RecoveryUnit,rawTargets:unknown):FallbackPreflight {
  if(actor.role!=='studio')throw new TaskConflict('Studio fallback inspection required')
  recoveryUnitKey(unit);const targets=fallbackTargets(rawTargets)
  return this.tx(()=>{
   this.authority.assertWorkspace(unit.taskId,unit.workspaceId)
   const {task,attempt}=this.authority.artifactOwner(actor,unit.taskId,unit.attemptId,unit.generation,unit.fingerprint)
   const read=<T>(table:string,id:string):T|null=>{const r=this.sql.exec<{body:string}>('SELECT body FROM '+table+' WHERE id = ?',id).toArray()[0];return r?JSON.parse(r.body):null}
   const now=this.now(),rawPolicy=read<unknown>('managed_account_policies','crop_json'),policy=rawPolicy?parseAccountPolicy(rawPolicy):null,pin=attempt.accountSelection
   const sourceReasons:typeof SOURCE_BLOCKERS[number][]=[]
   if(['unknown','submitted'].includes(attempt.submission))sourceReasons.push('original_outcome_unresolved')
   if(task.canonical||attempt.checkpointRef||attempt.submission==='saved'||this.sql.exec("SELECT id FROM managed_artifacts WHERE json_extract(body,'$.taskId') = ? LIMIT 1",task.id).toArray().length||read('managed_uploads',task.id))sourceReasons.push('original_output_retained')
   const stop=read<any>('managed_commands',attempt.activeCommandId)
   const released=task.state==='paused'&&attempt.phase==='stop_confirmed'&&attempt.submission==='unsent'&&attempt.checkpointRef===null&&stop?.action==='stop'&&stop.phase==='stop_confirmed'&&stop.id===attempt.activeCommandId&&stop.taskId===task.id&&stop.attemptId===attempt.id&&stop.generation===attempt.generation&&stop.fingerprint===task.fingerprint
   if(!released)sourceReasons.push('confirmed_unsent_stop_required')
   if(this.sql.exec('SELECT resource FROM managed_reservations WHERE attempt_id = ? LIMIT 1',attempt.id).toArray().length)sourceReasons.push('original_reservations_retained')
   if(!pin||!attempt.accountId||pin.accountId!==attempt.accountId)sourceReasons.push('managed_account_pin_required')
   if(!policy?.enabled||!policy.contextPortable)sourceReasons.push('current_portable_policy_required')
   if(pin&&(!policy||canonicalJson(parseAccountPolicy(pin.policy))!==canonicalJson(policy)))sourceReasons.push('pinned_policy_changed')
   if(pin&&canonicalJson(pin.configuration)!==canonicalJson(task.spec))sourceReasons.push('pinned_configuration_changed')
   if(!isDefaultCropPilot(task.spec))sourceReasons.push('workflow_not_supported')
   const budget=sharedRecoveryBudget(this.sql,unit)
   try{assertRecoveryControls(this.sql,unit)}catch{sourceReasons.push('shared_recovery_stopped')}
   if(budget.pending)sourceReasons.push('shared_recovery_pending');if(budget.exhausted)sourceReasons.push('shared_budget_exhausted');if(budget.nextEligibleAt>now)sourceReasons.push('shared_cooldown_active')
   const rows=this.sql.exec<{body:string}>('SELECT body FROM managed_account_quotas ORDER BY id LIMIT 1001').toArray()
   if(rows.length>1000)throw new TaskConflict('Quota inventory requires pagination')
   const rawQuotas=rows.map(r=>JSON.parse(r.body)),scope=taskScope(task.spec)
   const eligibleDeadlines:number[]=[]
   const inspected=targets.map(target=>{
    const reasons:typeof TARGET_BLOCKERS[number][]=[]
    const enrollment=read<{profileId:string}>('managed_enrollment',target.deviceId),peer=read<{receivedAt:string;profileIds:string[];capabilities:string[]}>('managed_peers',target.deviceId),profile=read<ManagedAccountProfile>('managed_account_profiles',profileKey(target.deviceId,target.profileId))
    const site=profile?.observation?.sites.chatgpt,link=profile?.links.chatgpt,account=link?read<ManagedAccount>('managed_account_accounts',link.accountId):null
    const peerAt=peer?Date.parse(peer.receivedAt):NaN,observed=profile?.observation?.checkedAt??null,maxAge=Math.min(120000,(policy?.criticalMaxAgeHours??24)*3600000)
    if(target.deviceId===attempt.deviceId&&target.profileId===attempt.profileId)reasons.push('original_profile')
    if(enrollment?.profileId!==target.profileId)reasons.push('profile_not_enrolled')
    if(!profile||profile.deviceId!==target.deviceId||profile.profileId!==target.profileId)reasons.push('target_profile_evidence_missing')
    if(!peer||!['managed-task/1','attempt-fencing/1','command-journal/1','worker-reconnect/1','account-selection/1',SLICED_CROP_CAPABILITY].every(c=>peer.capabilities.includes(c)))reasons.push('target_capability_missing')
    if(!Number.isSafeInteger(peerAt)||peerAt>now||now-peerAt>=900000||!peer?.profileIds.includes(target.profileId))reasons.push('target_peer_stale')
    if(site?.login!=='signed_in')reasons.push('target_login_unverified')
    if(!Number.isSafeInteger(observed)||Number(observed)>now||now-Number(observed)>=maxAge)reasons.push('target_account_evidence_stale')
    if(!account||account.id!==link?.accountId||account.provider!=='openai'||!site?.candidate||site.candidate!==link?.candidate||account.candidate!==link.candidate||!Number.isSafeInteger(account.maxConcurrent)||account.maxConcurrent<1)reasons.push('target_identity_unconfirmed')
    if(account?.id===attempt.accountId)reasons.push('not_independent_account')
    if(['device:'+target.deviceId,'browser:'+target.deviceId,'profile:'+target.deviceId+':'+target.profileId].some(r=>this.sql.exec('SELECT resource FROM managed_reservations WHERE resource = ?',r).toArray().length))reasons.push('target_resource_reserved')
    if(account){const prefix='account:'+account.id+':',slots=this.sql.exec<{resource:string}>('SELECT resource FROM managed_reservations WHERE substr(resource,1,?) = ?',prefix.length,prefix).toArray();if(slots.some(s=>!/^\d+$/.test(s.resource.slice(prefix.length)))||slots.length>=account.maxConcurrent)reasons.push('target_account_capacity_reserved')}
    if(!policy?.allowed.some(c=>c.provider===task.spec.provider&&c.product===task.spec.product&&c.model===task.spec.model&&c.mode===task.spec.settings.mode&&c.effort===task.spec.settings.effort))reasons.push('configuration_not_allowed')
    const quotas:AccountQuota[]=account?rawQuotas.filter(q=>q.accountId===account.id).map(q=>parseAccountQuota({accountId:q.accountId,scope:q.scope,state:q.state,evidence:q.evidence,observedAt:q.observedAt,recheckAt:q.recheckAt},now)).filter(q=>scopeMatches(q.scope,scope)||scopeMatches(q.scope,{...scope,feature:'uploads'})):[]
    if(![scope,{...scope,feature:'uploads'}].every(s=>quotas.some(q=>scopeMatches(q.scope,s))))reasons.push('target_quota_missing')
    for(const q of quotas){
     if(q.state==='blocked')reasons.push('target_quota_blocked')
     if(q.state!=='available'||!['observed','owner_supplied'].includes(q.evidence))reasons.push('target_quota_unconfirmed')
     if(q.observedAt>now||now-q.observedAt>=(policy?.criticalMaxAgeHours??24)*3600000)reasons.push('target_quota_stale')
     if(q.recheckAt!==null&&q.recheckAt<=now)reasons.push('target_quota_recheck_required')
    }
    const unique=[...new Set(reasons)]
    if(!unique.length)eligibleDeadlines.push(Number(observed)+maxAge,peerAt+900000,...quotas.flatMap(q=>[q.observedAt+(policy?.criticalMaxAgeHours??24)*3600000,q.recheckAt??Number.MAX_SAFE_INTEGER]))
    return {...target,accountId:account?.id??null,authorityEligible:!unique.length,peerObservedAt:Number.isSafeInteger(peerAt)&&peerAt>0?peerAt:null,accountObservedAt:Number.isSafeInteger(observed)&&Number(observed)>0?observed:null,reasons:unique}
   })
   return parseFallbackPreflight({schema:FALLBACK_PREFLIGHT_SCHEMA,unit,checkedAt:now,validUntil:Math.min(now+15000,...eligibleDeadlines),state:sourceReasons.length?'source_blocked':inspected.some(t=>t.authorityEligible)?'prerequisites_only':'target_waiting',policyRevision:policy?.revision??null,source:{deviceId:attempt.deviceId,profileId:attempt.profileId,accountId:attempt.accountId,submission:attempt.submission,stopCommandId:released?attempt.activeCommandId:null,reasons:sourceReasons},targets:inspected,budget,executionBlockers:[...EXECUTION_BLOCKERS],handoffAllowed:false,executionAllowed:false,resendAllowed:false,ownershipChanged:false},unit,targets,now)
  })
 }
}
export async function fallbackPreflightApi(request:Request,actor:TaskPrincipal,preflight:FallbackPreflightAuthority,workspace:string){
 if(actor.role!=='studio')return Response.json({error:'Studio inspection required'},{status:403})
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,8000)))}catch{throw new TaskConflict('Bounded fallback inspection required')}
 recoveryExact(raw,['schema','unit','targets']);if(raw.schema!==FALLBACK_PREFLIGHT_SCHEMA||raw.unit?.workspaceId!==workspace)throw new TaskConflict('Exact current workspace required')
 return Response.json(preflight.inspect(actor,raw.unit,raw.targets),{headers:{'Cache-Control':'no-store'}})
}
