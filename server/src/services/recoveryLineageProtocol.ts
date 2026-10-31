import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {TaskConflict} from './managedTaskProtocol.js'
export const RECOVERY_LINEAGE_SCHEMA='managed-recovery-lineage/1'
export const MAX_RECOVERY_FAMILY_UNITS=16
export const RECOVERY_LEDGER_TABLES=['managed_recovery_episodes','managed_upload_recovery_episodes','managed_account_recovery_episodes','managed_navigation_recovery_episodes','managed_ui_recovery_episodes','managed_correction_recovery_episodes','managed_conversation_recovery_episodes','managed_retained_binding_episodes','managed_candidate_adoption_episodes','managed_account_handoff_episodes'] as const
export interface RecoveryHistoryReference {table:typeof RECOVERY_LEDGER_TABLES[number];actionId:string}
export interface RecoveryLineage {schema:typeof RECOVERY_LINEAGE_SCHEMA;parent:RecoveryUnit;parentHistory:RecoveryHistoryReference[];successor:RecoveryUnit;transferEventId:string;stopCommandId:string;startCommandId:string;createdAt:number;kind:'confirmed_unsent_transfer'}
/** Normalize the unit from artifact/recovery fences without treating artifact changes as a new budget. */
export function recoveryLineageUnit(f:RecoveryUnit):RecoveryUnit {
 const u={workspaceId:f.workspaceId,taskId:f.taskId,attemptId:f.attemptId,generation:f.generation,fingerprint:f.fingerprint};recoveryUnitKey(u);return u
}
export function parseRecoveryLineage(raw:unknown):RecoveryLineage {
 recoveryExact(raw,['schema','parent','parentHistory','successor','transferEventId','stopCommandId','startCommandId','createdAt','kind']);recoveryUnitKey(raw.parent);recoveryUnitKey(raw.successor)
 if(!Array.isArray(raw.parentHistory)||raw.parentHistory.length>3)throw new TaskConflict('Bounded original recovery history required')
 const ids=new Set<string>()
 for(const item of raw.parentHistory){recoveryExact(item,['table','actionId']);if(!RECOVERY_LEDGER_TABLES.includes(item.table)||!recoveryId(item.actionId)||ids.has(item.actionId))throw new TaskConflict('Exact original recovery history required');ids.add(item.actionId)}
 if(raw.schema!==RECOVERY_LINEAGE_SCHEMA||raw.kind!=='confirmed_unsent_transfer'||![raw.transferEventId,raw.stopCommandId,raw.startCommandId].every(recoveryId)||!Number.isSafeInteger(raw.createdAt)||raw.createdAt<=0||raw.parent.workspaceId!==raw.successor.workspaceId||raw.parent.taskId!==raw.successor.taskId||raw.parent.fingerprint!==raw.successor.fingerprint||raw.successor.generation!==raw.parent.generation+1||raw.parent.attemptId===raw.successor.attemptId||raw.stopCommandId===raw.startCommandId)throw new TaskConflict('Exact adjacent recovery lineage required')
 return structuredClone(raw) as RecoveryLineage
}
