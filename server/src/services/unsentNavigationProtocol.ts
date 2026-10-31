import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {recoveryExact,recoveryId,recoveryHash,type SavedImportAction} from './managedSavedImportRecoveryProtocol.js'
import {parseManagedSessionEvidence,type ManagedSessionEvidence} from './managedSessionEvidenceProtocol.js'
export const NAVIGATION_SCHEMA='unsent-navigation-recovery/1'
export interface NavigationFence {unit:RecoveryUnit;commandId:string;deviceId:string;profileId:string;bindingId:string;sourceSha256:string;accountId:string;policyRevision:number}
export interface NavigationAction extends SavedImportAction {before:ManagedSessionEvidence|null;after:ManagedSessionEvidence|null;effect:'not_touched'|'possible'|'reloaded'|null}
export interface NavigationRecord {schema:typeof NAVIGATION_SCHEMA;fence:NavigationFence;revision:number;enabled:boolean;paused:boolean;cancelled:boolean;nextEligibleAt:number;offer:ManagedSessionEvidence;actions:NavigationAction[]}
export function parseNavigationFence(raw:unknown):NavigationFence{
 recoveryExact(raw,['unit','commandId','deviceId','profileId','bindingId','sourceSha256','accountId','policyRevision']);recoveryUnitKey(raw.unit)
 if(![raw.commandId,raw.deviceId,raw.profileId,raw.bindingId,raw.accountId].every(recoveryId)||!recoveryHash(raw.sourceSha256)||!Number.isSafeInteger(raw.policyRevision)||raw.policyRevision<1)throw new TaskConflict('Exact original view/account/input fence required')
 return structuredClone(raw) as NavigationFence
}
export function navigationProof(raw:unknown,f:NavigationFence,now:number,ready:boolean){
 const p=parseManagedSessionEvidence(raw,{commandId:f.commandId,profileId:f.profileId,unit:f.unit,observedAt:now,outcome:'unsent',phase:'started'})
 if(p.bindingId!==f.bindingId||p.cachedSourceSha256!==f.sourceSha256||!p.exactView||!p.currentProfile||!p.cachedSourceVerified||!p.untouched||p.ready!==ready||p.documentKind!=='chatgpt_home'||p.composer!=='empty'||p.attachments!=='none'||p.response!=='none'||p.login!=='unknown')throw new TaskConflict('Original untouched empty home view and exact navigation state required')
 return p
}
export function parseNavigationRecord(raw:unknown):NavigationRecord{
 recoveryExact(raw,['schema','fence','revision','enabled','paused','cancelled','nextEligibleAt','offer','actions']);const f=parseNavigationFence(raw.fence)
 if(raw.schema!==NAVIGATION_SCHEMA||!Number.isSafeInteger(raw.revision)||raw.revision<1||![raw.enabled,raw.paused,raw.cancelled].every(x=>typeof x==='boolean')||!Number.isSafeInteger(raw.nextEligibleAt)||raw.nextEligibleAt<0||!Array.isArray(raw.actions)||raw.actions.length>3)throw new TaskConflict('Retain invalid original navigation history for inspection')
 navigationProof(raw.offer,f,raw.offer?.observedAt,false)
 const ids=new Set<string>()
 for(const [index,a] of raw.actions.entries()){
  recoveryExact(a,['id','phase','at','finishedAt','evidenceRef','before','after','effect'])
  if(!recoveryId(a.id)||ids.has(a.id)||!['reserved','executing','unknown','verified','safe_failure'].includes(a.phase)||!Number.isSafeInteger(a.at)||a.at<=0||index<raw.actions.length-1&&a.phase!=='safe_failure'||![null,'not_touched','possible','reloaded'].includes(a.effect))throw new TaskConflict('Invalid retained navigation action')
  ids.add(a.id)
  if(a.before!==null){navigationProof(a.before,f,a.before.observedAt,false);if(a.before.observedAt<a.at)throw new TaskConflict('Original precondition predates grant')}
  if(a.after!==null)navigationProof(a.after,f,a.after.observedAt,true)
  if(a.phase==='reserved'?(a.before!==null||a.after!==null||a.effect!==null||a.finishedAt!==null||a.evidenceRef!==null):a.phase==='executing'?(a.before===null||a.effect!=='possible'||a.after!==null||a.finishedAt!==null||a.evidenceRef!==null):!Number.isSafeInteger(a.finishedAt)||a.finishedAt<a.at||a.evidenceRef!=='navigation/'+a.id||a.phase==='verified'&&(a.after===null||a.before===null||a.after.observedAt<a.before.observedAt||!['not_touched','reloaded'].includes(a.effect))||a.phase==='safe_failure'&&(a.effect!=='not_touched'||a.after!==null)||a.phase==='unknown'&&(a.effect!=='possible'||a.before===null||a.after!==null))throw new TaskConflict('Original navigation phase/outcome evidence must agree')
 }
 return structuredClone(raw) as NavigationRecord
}
export const navigationKey=(f:NavigationFence)=>recoveryUnitKey(f.unit)
export const sameNavigationFence=(a:NavigationFence,b:NavigationFence)=>canonicalJson(a)===canonicalJson(b)
