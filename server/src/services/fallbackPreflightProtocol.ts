import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {recoveryUnitKey,parseRecoveryBudget,type RecoveryUnit,type RecoveryBudget} from './automationRecoveryPolicy.js'
export const FALLBACK_PREFLIGHT_SCHEMA='managed-fallback-preflight/1'
export const SOURCE_BLOCKERS=['original_outcome_unresolved','original_output_retained','confirmed_unsent_stop_required','original_reservations_retained','managed_account_pin_required','current_portable_policy_required','pinned_policy_changed','pinned_configuration_changed','workflow_not_supported','shared_recovery_stopped','shared_recovery_pending','shared_budget_exhausted','shared_cooldown_active'] as const
export const TARGET_BLOCKERS=['original_profile','not_independent_account','profile_not_enrolled','target_profile_evidence_missing','target_capability_missing','target_peer_stale','target_login_unverified','target_account_evidence_stale','target_identity_unconfirmed','target_resource_reserved','target_account_capacity_reserved','target_quota_missing','target_quota_blocked','target_quota_unconfirmed','target_quota_stale','target_quota_recheck_required','configuration_not_allowed'] as const
export const EXECUTION_BLOCKERS=['portable_target_input_not_verified','recovery_budget_lineage_not_enrolled','account_handoff_executor_not_enrolled'] as const
export interface FallbackTarget {deviceId:string;profileId:string}
export interface FallbackPreflight {
 schema:typeof FALLBACK_PREFLIGHT_SCHEMA;unit:RecoveryUnit;checkedAt:number;validUntil:number;state:'source_blocked'|'target_waiting'|'prerequisites_only';policyRevision:number|null;
 source:{deviceId:string;profileId:string;accountId:string|null;submission:string;stopCommandId:string|null;reasons:typeof SOURCE_BLOCKERS[number][]};
 targets:(FallbackTarget&{accountId:string|null;authorityEligible:boolean;peerObservedAt:number|null;accountObservedAt:number|null;reasons:typeof TARGET_BLOCKERS[number][]})[];
 budget:RecoveryBudget;executionBlockers:typeof EXECUTION_BLOCKERS[number][];handoffAllowed:false;executionAllowed:false;resendAllowed:false;ownershipChanged:false
}
export function fallbackTargets(raw:unknown):FallbackTarget[]{
 if(!Array.isArray(raw)||raw.length<1||raw.length>8)throw new TaskConflict('Choose one to eight exact target profiles')
 const keys=new Set<string>()
 for(const t of raw){recoveryExact(t,['deviceId','profileId']);if(!recoveryId(t.deviceId)||!recoveryId(t.profileId)||keys.has(canonicalJson(t)))throw new TaskConflict('Distinct exact target profiles required');keys.add(canonicalJson(t))}
 return structuredClone(raw)
}
export function parseFallbackPreflight(raw:unknown,unit:RecoveryUnit,targets:FallbackTarget[],now=Date.now()):FallbackPreflight {
 recoveryExact(raw,['schema','unit','checkedAt','validUntil','state','policyRevision','source','targets','budget','executionBlockers','handoffAllowed','executionAllowed','resendAllowed','ownershipChanged'])
 recoveryUnitKey(raw.unit);if(recoveryUnitKey(raw.unit)!==recoveryUnitKey(unit)||raw.schema!==FALLBACK_PREFLIGHT_SCHEMA||![raw.checkedAt,raw.validUntil].every(Number.isSafeInteger)||raw.checkedAt<=0||raw.checkedAt>now||raw.validUntil<=now||raw.validUntil>raw.checkedAt+15000||!(raw.policyRevision===null||Number.isSafeInteger(raw.policyRevision)&&raw.policyRevision>0))throw new TaskConflict('Fresh exact fallback preflight required')
 for(const k of ['handoffAllowed','executionAllowed','resendAllowed','ownershipChanged'])if(raw[k]!==false)throw new TaskConflict('Preflight grants no execution or ownership permission')
 const reasons=(r:unknown,allowed:readonly string[])=>{if(!Array.isArray(r)||r.some(x=>!allowed.includes(x))||new Set(r).size!==r.length)throw new TaskConflict('Exact bounded fallback blockers required')}
 if(canonicalJson(raw.executionBlockers)!==canonicalJson(EXECUTION_BLOCKERS))throw new TaskConflict('Missing non-enrolled execution boundaries')
 recoveryExact(raw.source,['deviceId','profileId','accountId','submission','stopCommandId','reasons'])
 if(![raw.source.deviceId,raw.source.profileId].every(recoveryId)||!(raw.source.accountId===null||recoveryId(raw.source.accountId))||!['unsent','unknown','submitted','saved'].includes(raw.source.submission)||!(raw.source.stopCommandId===null||recoveryId(raw.source.stopCommandId)))throw new TaskConflict('Exact source disposition required')
 reasons(raw.source.reasons,SOURCE_BLOCKERS);parseRecoveryBudget(raw.budget)
 if(raw.source.accountId===null&&!raw.source.reasons.includes('managed_account_pin_required')||raw.policyRevision===null&&!raw.source.reasons.includes('current_portable_policy_required')||raw.budget.nextEligibleAt>raw.checkedAt&&!raw.source.reasons.includes('shared_cooldown_active'))throw new TaskConflict('Missing source prerequisite blocker')
 if(['unknown','submitted'].includes(raw.source.submission)&&!raw.source.reasons.includes('original_outcome_unresolved')||raw.source.submission==='saved'&&!raw.source.reasons.includes('original_output_retained')||raw.source.stopCommandId===null&&!raw.source.reasons.includes('confirmed_unsent_stop_required')||raw.budget.pending&&!raw.source.reasons.includes('shared_recovery_pending')||raw.budget.exhausted&&!raw.source.reasons.includes('shared_budget_exhausted'))throw new TaskConflict('Source blockers contradict retained authority')
 if(!Array.isArray(raw.targets)||raw.targets.length!==targets.length)throw new TaskConflict('Exact requested target inventory required')
 for(const [n,t] of raw.targets.entries()){
  recoveryExact(t,['deviceId','profileId','accountId','authorityEligible','peerObservedAt','accountObservedAt','reasons'])
  if(t.deviceId!==targets[n].deviceId||t.profileId!==targets[n].profileId||!(t.accountId===null||recoveryId(t.accountId))||t.authorityEligible!==(t.reasons.length===0)||![t.peerObservedAt,t.accountObservedAt].every(x=>x===null||Number.isSafeInteger(x)&&x>0))throw new TaskConflict('Target receipt identity or eligibility mismatch')
  reasons(t.reasons,TARGET_BLOCKERS)
  if(t.authorityEligible&&(t.accountId===null||t.accountId===raw.source.accountId||t.deviceId===raw.source.deviceId&&t.profileId===raw.source.profileId||t.peerObservedAt===null||t.peerObservedAt>raw.checkedAt||raw.checkedAt-t.peerObservedAt>=900000||t.accountObservedAt===null||t.accountObservedAt>raw.checkedAt||raw.checkedAt-t.accountObservedAt>=120000))throw new TaskConflict('Target authority contradicts source identity or freshness')
 }
 const state=raw.source.reasons.length?'source_blocked':raw.targets.some((t:any)=>t.authorityEligible)?'prerequisites_only':'target_waiting'
 if(raw.state!==state)throw new TaskConflict('Fallback state contradicts its evidence')
 return structuredClone(raw) as FallbackPreflight
}
