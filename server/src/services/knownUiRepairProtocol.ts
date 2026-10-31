import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {recoveryExact,recoveryId,recoveryHash,type SavedImportAction} from './managedSavedImportRecoveryProtocol.js'
import {parseManagedSessionEvidence,type ManagedSessionEvidence} from './managedSessionEvidenceProtocol.js'
import {parseNavigationFence,navigationProof} from './unsentNavigationProtocol.js'
export const UI_REPAIR_SCHEMA='known-ui-repair/1'
export interface UiRepairFence {unit:RecoveryUnit;commandId:string;deviceId:string;profileId:string;bindingId:string;sourceSha256:string;accountId:string;policyRevision:number;repairId:'email-connector-not-now/1';uiChangeId:string|null;uiObservedAt:number|null}
export interface UiRepairProof {schema:'known-ui-repair-proof/1';observedAt:number;session:ManagedSessionEvidence;repairId:'email-connector-not-now/1';overlay:'present'|'absent';control:'unique_enabled'|'absent';composerAccessible:boolean}
export interface UiRepairAction extends SavedImportAction {before:UiRepairProof|null;after:UiRepairProof|null;effect:'not_touched'|'possible'|'dismissed'|null}
export interface UiRepairRecord {schema:typeof UI_REPAIR_SCHEMA;fence:UiRepairFence;revision:number;enabled:boolean;paused:boolean;cancelled:boolean;nextEligibleAt:number;offer:UiRepairProof;actions:UiRepairAction[]}
export function parseUiRepairFence(raw:unknown):UiRepairFence{
 recoveryExact(raw,['unit','commandId','deviceId','profileId','bindingId','sourceSha256','accountId','policyRevision','repairId','uiChangeId','uiObservedAt'])
 const {repairId,uiChangeId,uiObservedAt,...base}=raw;parseNavigationFence(base)
 if(repairId!=='email-connector-not-now/1'||(uiChangeId===null?uiObservedAt!==null:!recoveryHash(uiChangeId)||!Number.isSafeInteger(uiObservedAt)||uiObservedAt<=0))throw new TaskConflict('Exact known repair and original optional UI incident required')
 return structuredClone(raw) as UiRepairFence
}
export function uiRepairProof(raw:unknown,f:UiRepairFence,now:number,ready:boolean){
 recoveryExact(raw,['schema','observedAt','session','repairId','overlay','control','composerAccessible'])
 const {repairId,uiChangeId,uiObservedAt,...base}=f
 const session=navigationProof(raw.session,base,now,true)
 if(raw.schema!=='known-ui-repair-proof/1'||raw.repairId!==repairId||!Number.isSafeInteger(raw.observedAt)||raw.observedAt<session.observedAt||raw.observedAt-session.observedAt>2000||raw.observedAt>now||now-raw.observedAt>=120000||raw.overlay!==(ready?'absent':'present')||raw.control!==(ready?'absent':'unique_enabled')||typeof raw.composerAccessible!=='boolean'||ready&&!raw.composerAccessible)throw new TaskConflict('Exact original known promotion precondition or accessible empty-page postcondition required')
 return structuredClone(raw) as UiRepairProof
}
export function parseUiRepairRecord(raw:unknown):UiRepairRecord{
 recoveryExact(raw,['schema','fence','revision','enabled','paused','cancelled','nextEligibleAt','offer','actions']);const f=parseUiRepairFence(raw.fence)
 if(raw.schema!==UI_REPAIR_SCHEMA||!Number.isSafeInteger(raw.revision)||raw.revision<1||![raw.enabled,raw.paused,raw.cancelled].every(x=>typeof x==='boolean')||!Number.isSafeInteger(raw.nextEligibleAt)||raw.nextEligibleAt<0||!Array.isArray(raw.actions)||raw.actions.length>2)throw new TaskConflict('Retain invalid original uiRepair history for inspection')
 uiRepairProof(raw.offer,f,raw.offer?.observedAt,false)
 const ids=new Set<string>()
 for(const [index,a] of raw.actions.entries()){
  recoveryExact(a,['id','phase','at','finishedAt','evidenceRef','before','after','effect'])
  if(!recoveryId(a.id)||ids.has(a.id)||!['reserved','executing','unknown','verified','safe_failure'].includes(a.phase)||!Number.isSafeInteger(a.at)||a.at<=0||index<raw.actions.length-1&&a.phase!=='safe_failure'||![null,'not_touched','possible','dismissed'].includes(a.effect))throw new TaskConflict('Invalid retained uiRepair action')
  ids.add(a.id)
  if(a.before!==null){uiRepairProof(a.before,f,a.before.observedAt,false);if(a.before.observedAt<a.at)throw new TaskConflict('Original precondition predates grant')}
  if(a.after!==null)uiRepairProof(a.after,f,a.after.observedAt,true)
  if(a.phase==='reserved'?(a.before!==null||a.after!==null||a.effect!==null||a.finishedAt!==null||a.evidenceRef!==null):a.phase==='executing'?(a.before===null||a.effect!=='possible'||a.after!==null||a.finishedAt!==null||a.evidenceRef!==null):!Number.isSafeInteger(a.finishedAt)||a.finishedAt<a.at||a.evidenceRef!=='ui-repair/'+a.id||a.phase==='verified'&&(a.after===null||a.before===null||a.after.observedAt<a.before.observedAt||!['not_touched','dismissed'].includes(a.effect))||a.phase==='safe_failure'&&(a.effect!=='not_touched'||a.after!==null)||a.phase==='unknown'&&(a.effect!=='possible'||a.before===null||a.after!==null))throw new TaskConflict('Original uiRepair phase/outcome evidence must agree')
 }
 return structuredClone(raw) as UiRepairRecord
}
export const uiRepairKey=(f:UiRepairFence)=>recoveryUnitKey(f.unit)
export const sameUiRepairFence=(a:UiRepairFence,b:UiRepairFence)=>canonicalJson(a)===canonicalJson(b)
