import type {TaskSql} from './taskAuthority'
import {TaskConflict,canonicalJson,type CropTask,type CropAttempt} from '../../server/src/services/managedTaskProtocol'
import {recoveryUnitKey,type RecoveryUnit} from '../../server/src/services/automationRecoveryPolicy'
import {RECOVERY_LINEAGE_SCHEMA,MAX_RECOVERY_FAMILY_UNITS,RECOVERY_LEDGER_TABLES,parseRecoveryLineage,recoveryLineageUnit,type RecoveryLineage} from '../../server/src/services/recoveryLineageProtocol'
export {RECOVERY_LEDGER_TABLES} from '../../server/src/services/recoveryLineageProtocol'
type EdgeRow={id:string;parent_id:string;event_id:string;body:string}
export function initRecoveryLineage(sql:TaskSql){
 sql.exec('CREATE TABLE IF NOT EXISTS managed_recovery_lineage (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL)')
}
function read<T>(sql:TaskSql,table:string,id:string):T|null {const row=sql.exec<{body:string}>('SELECT body FROM '+table+' WHERE id = ?',id).toArray()[0];return row?JSON.parse(row.body):null}
// Retain identities rather than copying mutable outcomes or granting an allowance.
function parentHistory(sql:TaskSql,u:RecoveryUnit){
 const result:{table:typeof RECOVERY_LEDGER_TABLES[number];actionId:string}[]=[]
 for(const table of RECOVERY_LEDGER_TABLES){const row=read<{actions:{id:string}[]}>(sql,table,recoveryUnitKey(u));for(const action of row?.actions??[])result.push({table,actionId:action.id})}
 return result.sort((a,b)=>a.table.localeCompare(b.table)||a.actionId.localeCompare(b.actionId))
}
function checkedEdge(sql:TaskSql,row:EdgeRow):RecoveryLineage {
 const edge=parseRecoveryLineage(JSON.parse(row.body)),p=edge.parent,c=edge.successor
 if(row.id!==recoveryUnitKey(c)||row.parent_id!==recoveryUnitKey(p)||row.event_id!==edge.transferEventId)throw new TaskConflict('Recovery lineage key mismatch')
 for(const reference of edge.parentHistory){const record=read<{actions:{id:string}[]}>(sql,reference.table,recoveryUnitKey(p));if(!record?.actions?.some(a=>a.id===reference.actionId))throw new TaskConflict('Original recovery action history is missing or changed')}
 const task=read<CropTask>(sql,'managed_tasks',p.taskId),parent=read<CropAttempt>(sql,'managed_attempts',p.attemptId),child=read<CropAttempt>(sql,'managed_attempts',c.attemptId),stop=read<any>(sql,'managed_commands',edge.stopCommandId),start=read<any>(sql,'managed_commands',edge.startCommandId)
 if(!task||task.id!==p.taskId||task.workspaceId!==p.workspaceId||task.fingerprint!==p.fingerprint||!parent||!child||parent.id!==p.attemptId||child.id!==c.attemptId||parent.taskId!==p.taskId||child.taskId!==c.taskId||parent.generation!==p.generation||child.generation!==c.generation||parent.phase!=='stop_confirmed'||parent.submission!=='unsent'||parent.checkpointRef!==null||parent.activeCommandId!==edge.stopCommandId)throw new TaskConflict('Original released attempt history is missing or changed')
 const exact=(command:any,u:RecoveryUnit,id:string,action:string)=>command&&command.id===id&&command.action===action&&command.taskId===u.taskId&&command.attemptId===u.attemptId&&command.generation===u.generation&&command.fingerprint===u.fingerprint
 if(!exact(stop,p,edge.stopCommandId,'stop')||stop.phase!=='stop_confirmed'||!exact(start,c,edge.startCommandId,'start'))throw new TaskConflict('Original lineage command evidence is missing or changed')
 return edge
}
function parentEdge(sql:TaskSql,u:RecoveryUnit){const row=sql.exec<EdgeRow>('SELECT id,parent_id,event_id,body FROM managed_recovery_lineage WHERE id = ?',recoveryUnitKey(u)).toArray()[0];return row?checkedEdge(sql,row):null}
function childEdge(sql:TaskSql,u:RecoveryUnit){const rows=sql.exec<EdgeRow>('SELECT id,parent_id,event_id,body FROM managed_recovery_lineage WHERE parent_id = ? LIMIT 2',recoveryUnitKey(u)).toArray();if(rows.length>1)throw new TaskConflict('Forked recovery lineage requires inspection');return rows[0]?checkedEdge(sql,rows[0]):null}
function family(sql:TaskSql,raw:RecoveryUnit,provisional?:RecoveryUnit):RecoveryUnit[]{
 const requested=recoveryLineageUnit(raw),seen=new Set<string>();let root=requested
 for(let n=0;;n++){
  if(n>=MAX_RECOVERY_FAMILY_UNITS||seen.has(recoveryUnitKey(root)))throw new TaskConflict('Recovery lineage is cyclic or exceeds its bound')
  seen.add(recoveryUnitKey(root));const edge=parentEdge(sql,root)
  if(!edge){if(root.generation!==1)throw new TaskConflict('Missing recovery lineage for successor attempt; preserve original history');break}
  root=edge.parent
 }
 const units:RecoveryUnit[]=[];seen.clear();let unit=root
 for(;;){
  if(units.length>=MAX_RECOVERY_FAMILY_UNITS||seen.has(recoveryUnitKey(unit)))throw new TaskConflict('Recovery family is cyclic or exceeds its bound')
  seen.add(recoveryUnitKey(unit));units.push(unit);const edge=childEdge(sql,unit);if(!edge)break;unit=edge.successor
 }
 if(!seen.has(recoveryUnitKey(requested)))throw new TaskConflict('Disconnected recovery lineage')
 // A missing final link must not make an existing successor look like a fresh root.
 const task=read<CropTask>(sql,'managed_tasks',root.taskId),last=units[units.length-1],expected=provisional??last
 if((task||units.length>1)&&(!task||task.id!==root.taskId||task.workspaceId!==root.workspaceId||task.fingerprint!==root.fingerprint||task.attemptId!==expected.attemptId||task.generation!==expected.generation))throw new TaskConflict('Current owner is missing its recovery lineage')
 if(provisional&&recoveryUnitKey(last)!==recoveryUnitKey(requested))throw new TaskConflict('Only the current lineage head can acquire a successor')
 return units.map(u=>structuredClone(u))
}
/** Effective family, including descendants when inspecting an old unit. No counter copies or writes. */
export function recoveryFamilyUnits(sql:TaskSql,unit:RecoveryUnit){return family(sql,unit)}
/** Called only inside the same authority transaction that allocated an unstarted exact successor.
 * This records restrictive ancestry; it grants no task/account/recovery permission and charges no action. */
export function recordReleasedRecoveryLineage(sql:TaskSql,parent:RecoveryUnit,successor:RecoveryUnit,transferEventId:string,stopCommandId:string,startCommandId:string,createdAt:number){
 const value=parseRecoveryLineage({schema:RECOVERY_LINEAGE_SCHEMA,parent:recoveryLineageUnit(parent),parentHistory:parentHistory(sql,recoveryLineageUnit(parent)),successor:recoveryLineageUnit(successor),transferEventId,stopCommandId,startCommandId,createdAt,kind:'confirmed_unsent_transfer'}),key=recoveryUnitKey(value.successor)
 const old=sql.exec<EdgeRow>('SELECT id,parent_id,event_id,body FROM managed_recovery_lineage WHERE id = ?',key).toArray()[0]
 if(old){const edge=checkedEdge(sql,old);if(canonicalJson({...edge,createdAt:0})!==canonicalJson({...value,createdAt:0}))throw new TaskConflict('Immutable recovery lineage conflict');family(sql,successor);return edge}
 const ancestors=family(sql,parent,successor)
 if(ancestors.length>=MAX_RECOVERY_FAMILY_UNITS||childEdge(sql,parent))throw new TaskConflict('Recovery lineage cannot fork or exceed its bound')
 const task=read<CropTask>(sql,'managed_tasks',successor.taskId),child=read<CropAttempt>(sql,'managed_attempts',successor.attemptId),start=read<any>(sql,'managed_commands',startCommandId)
 if(!task||task.attemptId!==successor.attemptId||task.generation!==successor.generation||task.canonical||child?.phase!=='assigned'||child.submission!=='unsent'||child.checkpointRef!==null||child.activeCommandId!==startCommandId||start?.phase!=='queued')throw new TaskConflict('Lineage must commit with an unstarted allocated successor')
 const row={id:key,parent_id:recoveryUnitKey(value.parent),event_id:transferEventId,body:JSON.stringify(value)};checkedEdge(sql,row)
 if(sql.exec('SELECT resource FROM managed_reservations WHERE attempt_id = ? LIMIT 1',parent.attemptId).toArray().length)throw new TaskConflict('Original reservations remain held')
 for(const table of [...RECOVERY_LEDGER_TABLES,'managed_recovery_stops'])if(sql.exec('SELECT id FROM '+table+' WHERE id = ?',key).toArray().length)throw new TaskConflict('Successor already has independent recovery history')
 if(sql.exec('SELECT id FROM managed_recovery_dispatch WHERE unit_id = ? LIMIT 1',key).toArray().length)throw new TaskConflict('Successor already has delivery history')
 if(sql.exec('SELECT id FROM managed_recovery_lineage WHERE event_id = ?',transferEventId).toArray().length)throw new TaskConflict('Lineage event identity cannot be reused')
 if(sql.exec('SELECT id FROM managed_recovery_lineage LIMIT 129').toArray().length>=128)throw new TaskConflict('Recovery lineage inventory full; preserve history')
 sql.exec('INSERT INTO managed_recovery_lineage (id,parent_id,event_id,body) VALUES (?,?,?,?)',row.id,row.parent_id,row.event_id,row.body)
 family(sql,successor);return value
}
