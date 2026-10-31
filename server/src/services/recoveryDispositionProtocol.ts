import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryExact,recoveryId,recoveryHash} from './managedSavedImportRecoveryProtocol.js'
import {recoveryUnitKey,parseRecoveryBudget,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {RECOVERY_LEDGER_TABLES} from './recoveryLineageProtocol.js'
import {parseRecoveryStopReceipt} from './recoveryStopProtocol.js'
import {parseProductionCandidateHandoff,type ProductionCandidateHandoff} from './accountHandoffProtocol.js'
export const RECOVERY_DISPOSITION_SCHEMA='recovery-family-disposition/1'
export const RETAIN_HOLD_CONFIRMATION='Keep this recovery family held; preserve all charges, claims and uncertain outcomes. Do not resume or resend work.'
export const CLOSE_UNUSED_CONFIRMATION='Close only this unused recovery approval; preserve its charge and evidence. Do not resume or resend work.'
export const dispositionPermissions={ownershipChanged:false,executionAllowed:false,handoffAllowed:false,resendAllowed:false,budgetReset:false,automaticallyResumed:false} as const
export interface DispositionReference {unit:RecoveryUnit;ledger:typeof RECOVERY_LEDGER_TABLES[number];actionId:string}
export interface DispositionIntent {schema:typeof RECOVERY_DISPOSITION_SCHEMA;eventId:string;unit:RecoveryUnit;mode:'retain_hold'|'close_unused';reference:DispositionReference|null;production:(ProductionCandidateHandoff&{candidateId:string})|null;inspectedAt:number;inspectionToken:string;confirmation:string}
export interface DispositionReceipt {schema:typeof RECOVERY_DISPOSITION_SCHEMA;intent:DispositionIntent;root:RecoveryUnit;receivedAt:number;state:'applied'|'not_applied_expired';beforeBudget:any;afterBudget:any;closed:{fromPhase:string;toPhase:'safe_failure'|'missing'}|null;successorClaimBlocked:string|null;stop:any|null;ownershipChanged:false;executionAllowed:false;handoffAllowed:false;resendAllowed:false;budgetReset:false;automaticallyResumed:false}
export function parseDispositionIntent(raw:unknown):DispositionIntent {
 recoveryExact(raw,['schema','eventId','unit','mode','reference','production','inspectedAt','inspectionToken','confirmation']);recoveryUnitKey(raw.unit)
 if(raw.schema!==RECOVERY_DISPOSITION_SCHEMA||!recoveryId(raw.eventId)||raw.eventId.length>96||!Number.isSafeInteger(raw.inspectedAt)||raw.inspectedAt<=0||!recoveryHash(raw.inspectionToken)||!['retain_hold','close_unused'].includes(raw.mode)||raw.confirmation!==(raw.mode==='retain_hold'?RETAIN_HOLD_CONFIRMATION:CLOSE_UNUSED_CONFIRMATION))throw new TaskConflict('Exact inspected recovery disposition and explicit confirmation required')
 if(raw.mode==='retain_hold'){if(raw.reference!==null||raw.production!==null)throw new TaskConflict('Family hold never selects an effect outcome')}
 else {
  recoveryExact(raw.reference,['unit','ledger','actionId']);recoveryUnitKey(raw.reference.unit)
  if(raw.reference.unit.workspaceId!==raw.unit.workspaceId||raw.reference.unit.taskId!==raw.unit.taskId||raw.reference.unit.fingerprint!==raw.unit.fingerprint||!RECOVERY_LEDGER_TABLES.includes(raw.reference.ledger)||!recoveryId(raw.reference.actionId))throw new TaskConflict('Exact original disposition action required')
  if(raw.production!==null){recoveryExact(raw.production,['jobId','claimEventId','newClaimEventId','candidateId']);const {candidateId,...p}=raw.production;parseProductionCandidateHandoff(p);if(!recoveryId(candidateId))throw new TaskConflict('Original retained production candidate required')}
 }
 return structuredClone(raw) as DispositionIntent
}
export function parseDispositionReceipt(raw:unknown):DispositionReceipt {
 recoveryExact(raw,['schema','intent','root','receivedAt','state','beforeBudget','afterBudget','closed','successorClaimBlocked','stop',...Object.keys(dispositionPermissions)])
 const i=parseDispositionIntent(raw.intent);recoveryUnitKey(raw.root);parseRecoveryBudget(raw.beforeBudget);parseRecoveryBudget(raw.afterBudget)
 if(raw.schema!==RECOVERY_DISPOSITION_SCHEMA||!Number.isSafeInteger(raw.receivedAt)||raw.receivedAt<i.inspectedAt||!['applied','not_applied_expired'].includes(raw.state)||Object.keys(dispositionPermissions).some(k=>raw[k]!==false)||raw.root.taskId!==i.unit.taskId||raw.root.workspaceId!==i.unit.workspaceId||raw.root.fingerprint!==i.unit.fingerprint||raw.beforeBudget.used!==raw.afterBudget.used||raw.beforeBudget.uiUsed!==raw.afterBudget.uiUsed||raw.afterBudget.nextEligibleAt<raw.beforeBudget.nextEligibleAt)throw new TaskConflict('Disposition must retain original charges and authority')
 if(raw.closed!==null){recoveryExact(raw.closed,['fromPhase','toPhase']);if(!['reserved','prepared','safe_failure','missing'].includes(raw.closed.fromPhase)||!['safe_failure','missing'].includes(raw.closed.toPhase)||i.mode!=='close_unused'||raw.state!=='applied')throw new TaskConflict('Only unused approval closure is admitted')}
 if(raw.successorClaimBlocked!==null&&(!i.production||raw.successorClaimBlocked!==i.production.newClaimEventId||raw.state!=='applied'))throw new TaskConflict('Original unused successor claim barrier required')
 if(raw.state==='not_applied_expired'&&(raw.receivedAt<i.inspectedAt+15000||raw.closed!==null||raw.successorClaimBlocked!==null||raw.stop!==null||canonicalJson(raw.beforeBudget)!==canonicalJson(raw.afterBudget)))throw new TaskConflict('Expired unapplied decision cannot claim effects')
 if(raw.state==='applied'&&i.mode==='retain_hold'){const stop=parseRecoveryStopReceipt(raw.stop);if(recoveryUnitKey(stop.unit)!==recoveryUnitKey(raw.root)||stop.mode==='reinspect')throw new TaskConflict('Original family hold receipt required')}
 if(raw.state==='applied'&&i.mode==='close_unused'&&raw.stop!==null)throw new TaskConflict('Unused closure cannot claim a family stop')
 if(raw.state==='applied'&&i.mode==='close_unused'&&(!raw.closed||i.production&&raw.successorClaimBlocked!==i.production.newClaimEventId))throw new TaskConflict('Original close result and production barrier required')
 return structuredClone(raw) as DispositionReceipt
}
export function parseDispositionSnapshot(raw:unknown,unit:RecoveryUnit,now=Date.now()){
 recoveryExact(raw,['schema','unit','root','checkedAt','inspectionToken','units','actions','budget','history',...Object.keys(dispositionPermissions)])
 if(raw.schema!==RECOVERY_DISPOSITION_SCHEMA||recoveryUnitKey(raw.unit)!==recoveryUnitKey(unit)||!recoveryHash(raw.inspectionToken)||!Number.isSafeInteger(raw.checkedAt)||raw.checkedAt<=0||raw.checkedAt>now||now-raw.checkedAt>=15000||!Array.isArray(raw.units)||raw.units.length<1||raw.units.length>16||!Array.isArray(raw.actions)||raw.actions.length>3||!Array.isArray(raw.history)||raw.history.length>16||Object.keys(dispositionPermissions).some(k=>raw[k]!==false))throw new TaskConflict('Fresh bounded original-family inspection required')
 const keys=new Set(raw.units.map((u:any)=>recoveryUnitKey(u)));if(keys.size!==raw.units.length||!keys.has(recoveryUnitKey(unit))||recoveryUnitKey(raw.root)!==recoveryUnitKey(raw.units[0]))throw new TaskConflict('Exact original family required')
 parseRecoveryBudget(raw.budget)
 for(const a of raw.actions){recoveryExact(a,['reference','phase','expiresAt','unusedClosable','productionRequired']);recoveryExact(a.reference,['unit','ledger','actionId']);if(!keys.has(recoveryUnitKey(a.reference.unit))||!RECOVERY_LEDGER_TABLES.includes(a.reference.ledger)||!recoveryId(a.reference.actionId)||typeof a.phase!=='string'||typeof a.unusedClosable!=='boolean'||typeof a.productionRequired!=='boolean'||!(a.expiresAt===null||Number.isSafeInteger(a.expiresAt)&&a.expiresAt>0))throw new TaskConflict('Exact retained action summary required')}
 for(const receipt of raw.history){parseDispositionReceipt(receipt);if(recoveryUnitKey(receipt.root)!==recoveryUnitKey(raw.root)||!keys.has(recoveryUnitKey(receipt.intent.unit)))throw new TaskConflict('Original disposition history belongs to another family')}
 return structuredClone(raw)
}
