import {parseHandoffRecord} from '../../server/src/services/accountHandoffProtocol'
import {parseAdoptionRecord} from '../../server/src/services/candidateAdoptionProtocol'
import {initRecoveryLineage,recoveryFamilyUnits,RECOVERY_LEDGER_TABLES} from './recoveryLineage'
import {recoveryLineageUnit} from '../../server/src/services/recoveryLineageProtocol'
import {parseRetainedBindingRecord} from '../../server/src/services/retainedContextBindingProtocol'
import {parseConversationRecord} from '../../server/src/services/conversationRestorationProtocol'
import {parseCorrectionRecord} from '../../server/src/services/correctionRecoveryProtocol'
import {parseUiRepairRecord} from '../../server/src/services/knownUiRepairProtocol'
import {parseNavigationRecord} from '../../server/src/services/unsentNavigationProtocol'
import {parseRecoveryStopReceipt} from '../../server/src/services/recoveryStopProtocol'
import {parseAccountRecheckRecord} from '../../server/src/services/accountRecheckRecoveryProtocol'
import type {TaskSql} from './taskAuthority'
import {TaskConflict} from '../../server/src/services/managedTaskProtocol'
import {parseSavedImportRecord,savedImportKey,type SavedImportFence} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {parseSavedUploadRecord} from '../../server/src/services/managedSavedUploadRecoveryProtocol'
export function initRecoveryBudget(sql:TaskSql){
 initRecoveryLineage(sql)
 sql.exec('CREATE TABLE IF NOT EXISTS managed_account_handoff_episodes (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
 sql.exec('CREATE TABLE IF NOT EXISTS managed_candidate_adoption_episodes (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
 sql.exec('CREATE TABLE IF NOT EXISTS managed_recovery_dispatch (id TEXT PRIMARY KEY, unit_id TEXT NOT NULL, device_id TEXT NOT NULL, body TEXT NOT NULL)')
 sql.exec('CREATE TABLE IF NOT EXISTS managed_retained_binding_episodes (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
 sql.exec('CREATE TABLE IF NOT EXISTS managed_conversation_recovery_episodes (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
 sql.exec('CREATE TABLE IF NOT EXISTS managed_correction_recovery_episodes (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
 sql.exec('CREATE TABLE IF NOT EXISTS managed_ui_recovery_episodes (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
 sql.exec('CREATE TABLE IF NOT EXISTS managed_navigation_recovery_episodes (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
 sql.exec('CREATE TABLE IF NOT EXISTS managed_recovery_stops (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
 sql.exec('CREATE TABLE IF NOT EXISTS managed_recovery_stop_events (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
 sql.exec('CREATE TABLE IF NOT EXISTS managed_recovery_episodes (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
 sql.exec('CREATE TABLE IF NOT EXISTS managed_upload_recovery_episodes (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
 sql.exec('CREATE TABLE IF NOT EXISTS managed_account_recovery_episodes (id TEXT PRIMARY KEY, target TEXT NOT NULL, body TEXT NOT NULL)')
}
/** Called inside the same task Durable Object transaction as reservation. An adapter change never resets a unit. */
function localRecoveryBudget(sql:TaskSql,f:Pick<SavedImportFence,'workspaceId'|'taskId'|'attemptId'|'generation'|'fingerprint'>){
 const key=savedImportKey(f),a=sql.exec<{body:string}>('SELECT body FROM managed_recovery_episodes WHERE id = ?',key).toArray()[0],b=sql.exec<{body:string}>('SELECT body FROM managed_upload_recovery_episodes WHERE id = ?',key).toArray()[0]
 const c=sql.exec<{body:string}>('SELECT body FROM managed_account_recovery_episodes WHERE id = ?',key).toArray()[0]
 const n=sql.exec<{body:string}>('SELECT body FROM managed_navigation_recovery_episodes WHERE id = ?',key).toArray()[0],navigation=n?parseNavigationRecord(JSON.parse(n.body)):null
 if(navigation&&savedImportKey(navigation.fence.unit)!==key)throw new TaskConflict('Navigation recovery ledger key mismatch')
 const uiRow=sql.exec<{body:string}>('SELECT body FROM managed_ui_recovery_episodes WHERE id = ?',key).toArray()[0],ui=uiRow?parseUiRepairRecord(JSON.parse(uiRow.body)):null
 if(ui&&savedImportKey(ui.fence.unit)!==key)throw new TaskConflict('UI recovery ledger key mismatch')
 const account=c?parseAccountRecheckRecord(JSON.parse(c.body)):null
 const records=[a?parseSavedImportRecord(JSON.parse(a.body)):null,b?parseSavedUploadRecord(JSON.parse(b.body)):null].filter(x=>x!==null)
 if(account&&savedImportKey(account.fence.unit)!==key)throw new TaskConflict('Account recovery ledger key mismatch')
 if(records.some(r=>savedImportKey(r.fence)!==key))throw new TaskConflict('Recovery ledger key mismatch; preserve for review')
 const correctionRow=sql.exec<{body:string}>('SELECT body FROM managed_correction_recovery_episodes WHERE id = ?',key).toArray()[0],correction=correctionRow?parseCorrectionRecord(JSON.parse(correctionRow.body)):null
 if(correction&&savedImportKey(correction.fence.unit)!==key)throw new TaskConflict('Correction recovery ledger key mismatch')
 const conversationRow=sql.exec<{body:string}>('SELECT body FROM managed_conversation_recovery_episodes WHERE id = ?',key).toArray()[0],conversation=conversationRow?parseConversationRecord(JSON.parse(conversationRow.body)):null
 if(conversation&&savedImportKey(conversation.fence.unit)!==key)throw new TaskConflict('Conversation recovery ledger key mismatch')
 const bindingRow=sql.exec<{body:string}>('SELECT body FROM managed_retained_binding_episodes WHERE id = ?',key).toArray()[0],binding=bindingRow?parseRetainedBindingRecord(JSON.parse(bindingRow.body)):null
 if(binding&&savedImportKey(binding.fence.unit)!==key)throw new TaskConflict('Retained binding ledger key mismatch')
 const adoptionRow=sql.exec<{body:string}>('SELECT body FROM managed_candidate_adoption_episodes WHERE id = ?',key).toArray()[0],adoption=adoptionRow?parseAdoptionRecord(JSON.parse(adoptionRow.body)):null
 if(adoption&&savedImportKey(adoption.fence.unit)!==key)throw new TaskConflict('Candidate adoption ledger key mismatch')
 const handoffRow=sql.exec<{body:string}>('SELECT body FROM managed_account_handoff_episodes WHERE id = ?',key).toArray()[0],handoff=handoffRow?parseHandoffRecord(JSON.parse(handoffRow.body)):null
 if(handoff&&savedImportKey(handoff.fence.unit)!==key)throw new TaskConflict('Handoff ledger key mismatch')
 const actions=[...(handoff?.actions??[]),...(adoption?.actions??[]),...(binding?.actions??[]),...(conversation?.actions??[]),...(correction?.actions??[]),...records.flatMap(r=>r.actions),...(account?.actions??[]),...(navigation?.actions??[]),...(ui?.actions??[])],used=actions.length
 if(used>3||new Set(actions.map(a=>a.id)).size!==used)throw new TaskConflict('Conflicting shared recovery ledger; preserve for review')
 return {actions,used,uiUsed:ui?.actions.length??0,nextEligibleAt:Math.max(0,handoff?.nextEligibleAt??0,adoption?.nextEligibleAt??0,binding?.nextEligibleAt??0,conversation?.nextEligibleAt??0,correction?.nextEligibleAt??0,ui?.nextEligibleAt??0,navigation?.nextEligibleAt??0,account?.nextEligibleAt??0,...records.map(r=>r.nextEligibleAt)),pending:actions.some(a=>['reserved','prepared','executing','unknown'].includes(a.phase)),exhausted:used>=3}
}
export function sharedRecoveryBudget(sql:TaskSql,f:Pick<SavedImportFence,'workspaceId'|'taskId'|'attemptId'|'generation'|'fingerprint'>){
 const budgets=recoveryFamilyUnits(sql,recoveryLineageUnit(f)).map(u=>localRecoveryBudget(sql,u)),actions=budgets.flatMap(b=>b.actions),used=actions.length,uiUsed=budgets.reduce((n,b)=>n+b.uiUsed,0)
 if(used>3||uiUsed>2||new Set(actions.map(a=>a.id)).size!==used)throw new TaskConflict('Conflicting shared recovery lineage budget; preserve for review')
 return {used,uiUsed,nextEligibleAt:Math.max(0,...budgets.map(b=>b.nextEligibleAt)),pending:budgets.some(b=>b.pending),exhausted:used>=3}
}
export function assertRecoveryReservation(sql:TaskSql,f:Pick<SavedImportFence,'workspaceId'|'taskId'|'attemptId'|'generation'|'fingerprint'>,actionId:string,now:number){
 assertRecoveryControls(sql,f)
 const budget=sharedRecoveryBudget(sql,f)
 if(budget.pending)throw new TaskConflict('Original recovery action needs reconciliation')
 if(budget.exhausted)throw new TaskConflict('Shared recovery budget exhausted')
 if(budget.nextEligibleAt>now)throw new TaskConflict('Shared recovery cooldown remains active')
 for(const unit of recoveryFamilyUnits(sql,recoveryLineageUnit(f)))for(const table of RECOVERY_LEDGER_TABLES){
  const row=sql.exec<{body:string}>('SELECT body FROM '+table+' WHERE id = ?',savedImportKey(unit)).toArray()[0]
  if(row&&JSON.parse(row.body).actions.some((a:{id:string})=>a.id===actionId))throw new TaskConflict('Original action identity cannot be reused')
 }
 return budget
}

/** A pause/cancel in either enrolled operation fences subsequent effects of the same unit. */
function localRecoveryControls(sql:TaskSql,f:Pick<SavedImportFence,'workspaceId'|'taskId'|'attemptId'|'generation'|'fingerprint'>){
 const stop=sql.exec<{body:string}>('SELECT body FROM managed_recovery_stops WHERE id = ?',savedImportKey(f)).toArray()[0]
 if(stop){const receipt=parseRecoveryStopReceipt(JSON.parse(stop.body));if(savedImportKey(receipt.unit)!==savedImportKey(f))throw new TaskConflict('Retained stop key mismatch');if(receipt.mode!=='reinspect')throw new TaskConflict('Retained recovery stop is active')}
 for(const table of ['managed_recovery_episodes','managed_upload_recovery_episodes','managed_account_recovery_episodes','managed_navigation_recovery_episodes','managed_ui_recovery_episodes','managed_correction_recovery_episodes','managed_conversation_recovery_episodes','managed_retained_binding_episodes','managed_candidate_adoption_episodes','managed_account_handoff_episodes']){
  const row=sql.exec<{body:string}>('SELECT body FROM '+table+' WHERE id = ?',savedImportKey(f)).toArray()[0]
  if(row){const r=table==='managed_recovery_episodes'?parseSavedImportRecord(JSON.parse(row.body)):table==='managed_upload_recovery_episodes'?parseSavedUploadRecord(JSON.parse(row.body)):table==='managed_account_recovery_episodes'?parseAccountRecheckRecord(JSON.parse(row.body)):table==='managed_navigation_recovery_episodes'?parseNavigationRecord(JSON.parse(row.body)):table==='managed_ui_recovery_episodes'?parseUiRepairRecord(JSON.parse(row.body)):table==='managed_correction_recovery_episodes'?parseCorrectionRecord(JSON.parse(row.body)):table==='managed_conversation_recovery_episodes'?parseConversationRecord(JSON.parse(row.body)):table==='managed_retained_binding_episodes'?parseRetainedBindingRecord(JSON.parse(row.body)):table==='managed_candidate_adoption_episodes'?parseAdoptionRecord(JSON.parse(row.body)):parseHandoffRecord(JSON.parse(row.body));if(r.paused||r.cancelled)throw new TaskConflict('Shared recovery is paused or cancelled')}
 }
}

/** Every linked pause/cancel continues fencing the family. Reinspection never silently clears an ancestor. */
export function assertRecoveryControls(sql:TaskSql,f:Pick<SavedImportFence,'workspaceId'|'taskId'|'attemptId'|'generation'|'fingerprint'>){
 for(const unit of recoveryFamilyUnits(sql,recoveryLineageUnit(f)))localRecoveryControls(sql,unit)
}

export function readRecoveryLedger(sql:TaskSql,table:typeof RECOVERY_LEDGER_TABLES[number],unit:import('../../server/src/services/automationRecoveryPolicy').RecoveryUnit):any|null {
 const row=sql.exec<{body:string}>('SELECT body FROM '+table+' WHERE id = ?',savedImportKey(unit)).toArray()[0];if(!row)return null
 const v=JSON.parse(row.body),r=table==='managed_recovery_episodes'?parseSavedImportRecord(v):table==='managed_upload_recovery_episodes'?parseSavedUploadRecord(v):table==='managed_account_recovery_episodes'?parseAccountRecheckRecord(v):table==='managed_navigation_recovery_episodes'?parseNavigationRecord(v):table==='managed_ui_recovery_episodes'?parseUiRepairRecord(v):table==='managed_correction_recovery_episodes'?parseCorrectionRecord(v):table==='managed_conversation_recovery_episodes'?parseConversationRecord(v):table==='managed_retained_binding_episodes'?parseRetainedBindingRecord(v):table==='managed_candidate_adoption_episodes'?parseAdoptionRecord(v):parseHandoffRecord(v)
 if(savedImportKey(recoveryLineageUnit('unit' in r.fence?r.fence.unit:r.fence))!==savedImportKey(unit))throw new TaskConflict('Original ledger unit mismatch')
 return r
}
