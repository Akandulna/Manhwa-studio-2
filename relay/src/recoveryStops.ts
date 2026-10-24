import {parseHandoffRecord} from '../../server/src/services/accountHandoffProtocol'
import {parseAdoptionRecord} from '../../server/src/services/candidateAdoptionProtocol'
import {parseRetainedBindingRecord} from '../../server/src/services/retainedContextBindingProtocol'
import {parseDispatchTicket} from '../../server/src/services/recoveryDispatchProtocol'
import {parseConversationRecord} from '../../server/src/services/conversationRestorationProtocol'
import {parseCorrectionRecord} from '../../server/src/services/correctionRecoveryProtocol'
import {parseUiRepairRecord} from '../../server/src/services/knownUiRepairProtocol'
import {parseNavigationRecord} from '../../server/src/services/unsentNavigationProtocol'
import {parseRecoveryStopIntent,parseRecoveryStopReceipt,RECOVERY_STOP_SCHEMA,type RecoveryStopIntent,type RecoveryStopReceipt} from '../../server/src/services/recoveryStopProtocol'
import {recoveryUnitKey,type RecoveryUnit} from '../../server/src/services/automationRecoveryPolicy'
import {TaskConflict,canonicalJson,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import type {TaskAuthority,TaskSql} from './taskAuthority'
import type {AccountRecheckRecovery} from './accountRecheckRecovery'
import {parseSavedImportRecord} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {parseSavedUploadRecord} from '../../server/src/services/managedSavedUploadRecoveryProtocol'
import {parseAccountRecheckRecord} from '../../server/src/services/accountRecheckRecoveryProtocol'
import {initRecoveryBudget} from './recoveryBudget'
import {boundedBody} from './managedArtifactStorage'
/** Stop admission only. Original actions, unknown outcomes and resource ownership survive. */
export class RecoveryStops {
 constructor(private sql:TaskSql,private tx:<T>(work:()=>T)=>T,private authority:TaskAuthority,private accounts:AccountRecheckRecovery,private now=Date.now){initRecoveryBudget(sql)}
 apply(actor:TaskPrincipal,raw:unknown):RecoveryStopReceipt{
  if(actor.role!=='studio')throw new TaskConflict('Studio recovery stop authority required')
  const intent=parseRecoveryStopIntent(raw),unit=intent.unit,key=recoveryUnitKey(unit)
  return this.tx(()=>{
   this.authority.assertWorkspace(unit.taskId,unit.workspaceId)
   const row=this.sql.exec<{body:string}>('SELECT body FROM managed_attempts WHERE id = ?',unit.attemptId).toArray()[0],attempt=row?JSON.parse(row.body):null
   const task=JSON.parse(this.sql.exec<{body:string}>('SELECT body FROM managed_tasks WHERE id = ?',unit.taskId).toArray()[0].body)
   if(!attempt||attempt.taskId!==unit.taskId||attempt.generation!==unit.generation||task.fingerprint!==unit.fingerprint)throw new TaskConflict('Retained original unit required')
   const prior=this.sql.exec<{body:string}>('SELECT body FROM managed_recovery_stop_events WHERE id = ?',intent.eventId).toArray()[0]
   if(prior){const receipt=parseRecoveryStopReceipt(JSON.parse(prior.body));const {receivedAt,...original}=receipt;if(canonicalJson(original)!==canonicalJson(intent))throw new TaskConflict('Conflicting immutable stop intent');return receipt}
   const old=this.sql.exec<{body:string}>('SELECT body FROM managed_recovery_stops WHERE id = ?',key).toArray()[0],last=old?parseRecoveryStopReceipt(JSON.parse(old.body)):null
   if(intent.sequence<=(last?.sequence??0)||last?.mode==='cancel')throw new TaskConflict('Stop order changed or cancellation is permanent; retain original intent')
   if(intent.mode==='reinspect'){
    if(intent.sequence!==(last?.sequence??0)+1)throw new TaskConflict('Preparation must follow the exact acknowledged stop')
    if(intent.sequence>=126||this.sql.exec('SELECT id FROM managed_recovery_stop_events LIMIT 3841').toArray().length>=3840)throw new TaskConflict('Stop history reserves its final capacity for holding and cancellation')
    if(!last||last.mode==='reinspect')throw new TaskConflict('A confirmed previous stop is required')
    this.authority.artifactOwner(actor,unit.taskId,unit.attemptId,unit.generation,unit.fingerprint)
   }
   if(intent.sequence===128&&intent.mode!=='cancel')throw new TaskConflict('Final stop slot is reserved for cancellation')
   if(!old&&this.sql.exec('SELECT id FROM managed_recovery_stops LIMIT 129').toArray().length>=128||this.sql.exec('SELECT id FROM managed_recovery_stop_events LIMIT 4097').toArray().length>=4096)throw new TaskConflict('Stop receipt inventory full; preserve original records')
   // Freeze all enrolled playbooks even when preparing reinspection: removing the shared gate cannot resume them.
   for(const table of ['managed_recovery_episodes','managed_upload_recovery_episodes','managed_account_recovery_episodes','managed_navigation_recovery_episodes','managed_ui_recovery_episodes','managed_correction_recovery_episodes','managed_conversation_recovery_episodes','managed_retained_binding_episodes','managed_candidate_adoption_episodes','managed_account_handoff_episodes']){
    const r=this.sql.exec<{body:string}>('SELECT body FROM '+table+' WHERE id = ?',key).toArray()[0];if(!r)continue
    const record=table==='managed_recovery_episodes'?parseSavedImportRecord(JSON.parse(r.body)):table==='managed_upload_recovery_episodes'?parseSavedUploadRecord(JSON.parse(r.body)):table==='managed_account_recovery_episodes'?parseAccountRecheckRecord(JSON.parse(r.body)):table==='managed_navigation_recovery_episodes'?parseNavigationRecord(JSON.parse(r.body)):table==='managed_ui_recovery_episodes'?parseUiRepairRecord(JSON.parse(r.body)):table==='managed_correction_recovery_episodes'?parseCorrectionRecord(JSON.parse(r.body)):table==='managed_conversation_recovery_episodes'?parseConversationRecord(JSON.parse(r.body)):table==='managed_retained_binding_episodes'?parseRetainedBindingRecord(JSON.parse(r.body)):table==='managed_candidate_adoption_episodes'?parseAdoptionRecord(JSON.parse(r.body)):parseHandoffRecord(JSON.parse(r.body))
    record.enabled=false;record.paused=true;record.cancelled=record.cancelled||intent.mode==='cancel';record.revision++
    this.sql.exec('UPDATE '+table+' SET body = ? WHERE id = ?',JSON.stringify(record),key)
   }
   const deliveries=this.sql.exec<{body:string}>('SELECT body FROM managed_recovery_dispatch WHERE unit_id = ? LIMIT 17',key).toArray()
   if(deliveries.length>16)throw new TaskConflict('Retain conflicting dispatch history')
   for(const row of deliveries){const t=parseDispatchTicket(JSON.parse(row.body));if(recoveryUnitKey(t.unit)!==key)throw new TaskConflict('Dispatch stop unit mismatch');if(t.phase==='queued'||t.phase==='claimed'){t.phase='cancelled';t.finishedAt=this.now();t.revision++;this.sql.exec('UPDATE managed_recovery_dispatch SET body = ? WHERE id = ?',JSON.stringify(t),t.id)}}
   this.accounts.withdrawQueued(unit)
   const receipt:RecoveryStopReceipt={...intent,receivedAt:this.now()}
   this.sql.exec('INSERT INTO managed_recovery_stop_events (id,body) VALUES (?,?)',intent.eventId,JSON.stringify(receipt))
   this.sql.exec('INSERT INTO managed_recovery_stops (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',key,JSON.stringify(receipt));return receipt
  })
 }
}
export async function recoveryStopsApi(request:Request,actor:TaskPrincipal,stops:RecoveryStops,workspace:string){
 if(actor.role!=='studio')return Response.json({error:'Studio stop authority required'},{status:403})
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,8000)))}catch{throw new TaskConflict('Bounded stop intent required')}
 const intent=parseRecoveryStopIntent(raw);if(intent.unit.workspaceId!==workspace)throw new TaskConflict('Foreign stop workspace')
 return Response.json({schema:RECOVERY_STOP_SCHEMA,receipt:stops.apply(actor,intent)})
}
