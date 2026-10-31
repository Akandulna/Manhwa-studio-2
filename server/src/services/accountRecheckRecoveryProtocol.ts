import {canonicalJson,TaskConflict} from './managedTaskProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {parseAccountScope,accountIdValid,type AccountScope} from './managedAccountsProtocol.js'
import {recoveryExact,recoveryId,type SavedImportAction} from './managedSavedImportRecoveryProtocol.js'
export const ACCOUNT_RECHECK_SCHEMA='account-recheck-recovery/1'
export interface AccountRecheckFence {unit:RecoveryUnit;deviceId:string;profileId:string;accountId:string;candidate:string;scope:AccountScope;quotaObservedAt:number;recheckAt:number;policyRevision:number}
export interface AccountRecheckAction extends SavedImportAction {auditId:string|null;checkedAt:number|null;result:'identity_checked'|'signed_out'|'identity_changed'|'quota_blocked'|'unknown'|'withdrawn'|null}
export interface AccountRecheckRecord {schema:typeof ACCOUNT_RECHECK_SCHEMA;fence:AccountRecheckFence;revision:number;enabled:boolean;paused:boolean;cancelled:boolean;nextEligibleAt:number;actions:AccountRecheckAction[]}
export function parseAccountRecheckFence(raw:unknown):AccountRecheckFence {
 recoveryExact(raw,['unit','deviceId','profileId','accountId','candidate','scope','quotaObservedAt','recheckAt','policyRevision']);recoveryUnitKey(raw.unit);parseAccountScope(raw.scope)
 if(![raw.deviceId,raw.profileId,raw.accountId].every(accountIdValid)||typeof raw.candidate!=='string'||!/^(openai|google):[a-f0-9]{64}$/.test(raw.candidate)||raw.scope.product==='aistudio'||![raw.quotaObservedAt,raw.recheckAt,raw.policyRevision].every(n=>Number.isSafeInteger(n)&&n>0))throw new TaskConflict('Pinned confirmed account, scoped reset evidence and audit policy required')
 return structuredClone(raw) as AccountRecheckFence
}
export function parseAccountRecheckRecord(raw:unknown):AccountRecheckRecord {
 recoveryExact(raw,['schema','fence','revision','enabled','paused','cancelled','nextEligibleAt','actions']);parseAccountRecheckFence(raw.fence)
 if(raw.schema!==ACCOUNT_RECHECK_SCHEMA||!Number.isSafeInteger(raw.revision)||raw.revision<1||![raw.enabled,raw.paused,raw.cancelled].every(x=>typeof x==='boolean')||!Number.isSafeInteger(raw.nextEligibleAt)||raw.nextEligibleAt<0||!Array.isArray(raw.actions)||raw.actions.length>3)throw new TaskConflict('Invalid retained account recovery; preserve history')
 const ids=new Set<string>()
 for(const [i,a] of raw.actions.entries()){
  recoveryExact(a,['id','phase','at','finishedAt','evidenceRef','auditId','checkedAt','result'])
  if(!recoveryId(a.id)||ids.has(a.id)||!['executing','verified','safe_failure'].includes(a.phase)||!Number.isSafeInteger(a.at)||a.at<0||i<raw.actions.length-1&&a.phase!=='safe_failure'||!(a.auditId===null||recoveryId(a.auditId))||!(a.checkedAt===null||Number.isSafeInteger(a.checkedAt)&&a.checkedAt>0)||![null,'identity_checked','signed_out','identity_changed','quota_blocked','unknown','withdrawn'].includes(a.result))throw new TaskConflict('Invalid account recovery action')
  if(a.phase==='executing'&&a.checkedAt!==null||a.phase==='verified'&&(!['identity_checked','signed_out','identity_changed','quota_blocked'].includes(a.result)||a.checkedAt===null||a.checkedAt<a.at||a.checkedAt>a.finishedAt)||a.phase==='safe_failure'&&!['unknown','withdrawn'].includes(a.result))throw new TaskConflict('Audit phase and source-time evidence must agree')
  ids.add(a.id)
  if(a.phase==='executing'?(a.finishedAt!==null||a.evidenceRef!==null||a.result!==null):!Number.isSafeInteger(a.finishedAt)||a.finishedAt<a.at||typeof a.evidenceRef!=='string'||!/^(audit\/[A-Za-z0-9_-]{1,128}|request\/[A-Za-z0-9_-]{1,96})$/.test(a.evidenceRef)||(a.result==='withdrawn'?(a.auditId!==null||a.checkedAt!==null||a.phase!=='safe_failure'||a.evidenceRef!=='request/'+a.id):(a.auditId===null||a.result===null||a.evidenceRef!=='audit/'+a.auditId)))throw new TaskConflict('Exact original audit outcome required')
 }
 return structuredClone(raw) as AccountRecheckRecord
}
export const accountRecheckKey=(f:AccountRecheckFence)=>recoveryUnitKey(f.unit)
export const sameRecheckFence=(a:AccountRecheckFence,b:AccountRecheckFence)=>canonicalJson(a)===canonicalJson(b)
