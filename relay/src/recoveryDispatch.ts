import {retainedInventory} from './retainedInventory'
import {parseRestorationFence} from '../../server/src/services/conversationRestorationProtocol'
import {DISPATCH_SCHEMA,DISPATCH_KINDS,parseDispatchTicket,dispatchFence,type DispatchKind,type DispatchTicket} from '../../server/src/services/recoveryDispatchProtocol'
import {parseSavedUploadRecord} from '../../server/src/services/managedSavedUploadRecoveryProtocol'
import {parseNavigationRecord} from '../../server/src/services/unsentNavigationProtocol'
import {parseUiRepairRecord} from '../../server/src/services/knownUiRepairProtocol'
import {parseCorrectionRecord} from '../../server/src/services/correctionRecoveryProtocol'
import {parseConversationRecord} from '../../server/src/services/conversationRestorationProtocol'
import {recoveryUnitKey,type RecoveryUnit} from '../../server/src/services/automationRecoveryPolicy'
import {recoveryId} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {canonicalJson,TaskConflict,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {artifactHash} from '../../server/src/services/managedCropArtifact'
import {initRecoveryBudget,assertRecoveryControls} from './recoveryBudget'
import type {TaskAuthority,TaskSql} from './taskAuthority'
const tables={saved_upload:'managed_upload_recovery_episodes',navigate:'managed_navigation_recovery_episodes',known_ui:'managed_ui_recovery_episodes',correct_output:'managed_correction_recovery_episodes',restore_conversation:'managed_conversation_recovery_episodes'} as const
const parsers={saved_upload:parseSavedUploadRecord,navigate:parseNavigationRecord,known_ui:parseUiRepairRecord,correct_output:parseCorrectionRecord,restore_conversation:parseConversationRecord}
/** Delivery consumes an existing grant once. It creates no task, recovery action, lease or provider permission. */
export class RecoveryDispatch {
 constructor(private sql:TaskSql,private tx:<T>(work:()=>T)=>T,private authority:TaskAuthority,private enabled:()=>boolean,private kindEnabled:(kind:DispatchKind)=>boolean,private ready:(actor:TaskPrincipal,kind:DispatchKind,fence:any)=>boolean,private now=Date.now){initRecoveryBudget(sql)}
 private row<T>(table:string,id:string):T|null{const row=this.sql.exec<{body:string}>('SELECT body FROM '+table+' WHERE id = ?',id).toArray()[0];return row?JSON.parse(row.body):null}
 private get(id:string){const r=this.row('managed_recovery_dispatch',id);return r?parseDispatchTicket(r):null}
 private put(t:DispatchTicket){parseDispatchTicket(t);this.sql.exec('INSERT INTO managed_recovery_dispatch (id,unit_id,device_id,body) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',t.id,recoveryUnitKey(t.unit),t.deviceId,JSON.stringify(t))}
 private owner(actor:TaskPrincipal,u:RecoveryUnit){recoveryUnitKey(u);this.authority.assertWorkspace(u.taskId,u.workspaceId);return this.authority.artifactOwner(actor,u.taskId,u.attemptId,u.generation,u.fingerprint)}
 private grant(actor:TaskPrincipal,u:RecoveryUnit,kind:DispatchKind){
  if(!DISPATCH_KINDS.includes(kind)||!this.enabled()||!this.kindEnabled(kind))throw new TaskConflict('Original recovery dispatch is off')
  const {task,attempt}=this.owner(actor,u),raw=this.row(tables[kind],recoveryUnitKey(u)),record=raw?parsers[kind](raw):null
  if(!record||!record.enabled||record.paused||record.cancelled||!['running','uncertain'].includes(task.state)||task.canonical||!Number.isFinite(Date.parse(attempt.leaseExpiresAt))||Date.parse(attempt.leaseExpiresAt)<=this.now()+30000)throw new TaskConflict('Current enabled original grant and lease required')
  const f=dispatchFence(kind,record.fence),last=record.actions.at(-1)
  if(recoveryUnitKey(f.unit)!==recoveryUnitKey(u)||f.commandId!==attempt.activeCommandId||!last||last.phase!=='reserved'||!this.ready(actor,kind,record.fence))throw new TaskConflict('Only the current original unstarted grant may be dispatched')
  const peer=this.row<{receivedAt:string;capabilities:string[]}>('managed_peers',attempt.deviceId),enrolled=this.row<{profileId:string}>('managed_enrollment',attempt.deviceId)
  if(!peer?.capabilities.includes(DISPATCH_SCHEMA)||!Number.isFinite(Date.parse(peer.receivedAt))||Date.parse(peer.receivedAt)>this.now()||this.now()-Date.parse(peer.receivedAt)>15*60000||enrolled?.profileId!==attempt.profileId||task.spec.provider!=='chatgpt'||task.spec.product!=='chatgpt-web')throw new TaskConflict('Compatible current original enrolled phone required')
  for(const resource of ['device:'+attempt.deviceId,'browser:'+attempt.deviceId,'profile:'+attempt.deviceId+':'+attempt.profileId])if(this.sql.exec<{attempt_id:string}>('SELECT attempt_id FROM managed_reservations WHERE resource = ?',resource).toArray()[0]?.attempt_id!==attempt.id)throw new TaskConflict('Original dispatch reservations required')
  assertRecoveryControls(this.sql,u)
  return {record,last,attempt}
 }
 async inspect(actor:TaskPrincipal,u:RecoveryUnit){if(actor.role!=='studio')throw new TaskConflict('Studio dispatch inspection required');this.owner(actor,u);const grants=[]
  for(const kind of DISPATCH_KINDS){try{const g=this.grant(actor,u,kind);grants.push({kind,actionId:g.last.id,grantRevision:g.record.revision,fenceSha256:await artifactHash(new TextEncoder().encode(canonicalJson(g.record.fence))),deviceId:g.attempt.deviceId,profileId:g.attempt.profileId})}catch{}}
  const rows=this.sql.exec<{body:string}>('SELECT body FROM managed_recovery_dispatch WHERE unit_id = ? LIMIT 17',recoveryUnitKey(u)).toArray();if(rows.length>16)throw new TaskConflict('Dispatch history is held for inspection')
  const tickets=rows.map(r=>parseDispatchTicket(JSON.parse(r.body)));return {grants:grants.filter(g=>!tickets.some(t=>t.kind===g.kind&&t.actionId===g.actionId)),tickets}
 }
 async queue(actor:TaskPrincipal,u:RecoveryUnit,kind:DispatchKind,actionId:string,grantRevision:number,fenceSha256:string){
  if(actor.role!=='studio'||!recoveryId(actionId))throw new TaskConflict('Studio exact original grant delivery required')
  const id='dispatch_'+await artifactHash(new TextEncoder().encode(canonicalJson([recoveryUnitKey(u),kind,actionId])))
  const replay=this.get(id);if(replay){if(replay.grantRevision!==grantRevision||replay.fenceSha256!==fenceSha256)throw new TaskConflict('Conflicting immutable dispatch intent');return replay}
  const initial=this.grant(actor,u,kind),hash=await artifactHash(new TextEncoder().encode(canonicalJson(initial.record.fence)))
  return this.tx(()=>{const old=this.get(id);if(old){if(old.grantRevision!==grantRevision||old.fenceSha256!==fenceSha256)throw new TaskConflict('Conflicting immutable dispatch intent');return old}
   const g=this.grant(actor,u,kind)
   if(g.last.id!==actionId||g.record.revision!==grantRevision||hash!==fenceSha256||canonicalJson(g.record.fence)!==canonicalJson(initial.record.fence))throw new TaskConflict('Inspect the exact original grant before dispatch')
   if(retainedInventory(this.sql,'managed_recovery_dispatch',512)>=512)throw new TaskConflict('Dispatch receipt inventory full')
   const at=this.now(),t:DispatchTicket={schema:DISPATCH_SCHEMA,id,unit:structuredClone(u),kind,actionId,commandId:g.attempt.activeCommandId,deviceId:g.attempt.deviceId,profileId:g.attempt.profileId,fence:structuredClone(g.record.fence),fenceSha256,grantRevision,revision:1,queuedAt:at,expiresAt:Math.min(at+120000,Date.parse(g.attempt.leaseExpiresAt)-30000),phase:'queued',claimId:null,finishedAt:null};this.put(t);return t
  })
 }
 ticket(actor:TaskPrincipal,id:string){if(!recoveryId(id))throw new TaskConflict('Exact retained dispatch identity required');const t=this.get(id);if(!t||actor.role==='phone'&&actor.deviceId!==t.deviceId)throw new TaskConflict('Original dispatch receipt owner required');return t}
 private current(actor:TaskPrincipal,t:DispatchTicket){if(actor.role!=='phone'||actor.deviceId!==t.deviceId||this.now()>=t.expiresAt)throw new TaskConflict('Original unexpired phone dispatch required');const g=this.grant(actor,t.unit,t.kind);if(g.attempt.activeCommandId!==t.commandId||g.attempt.profileId!==t.profileId||g.record.revision!==t.grantRevision||g.last.id!==t.actionId||canonicalJson(g.record.fence)!==canonicalJson(t.fence))throw new TaskConflict('Original dispatch grant changed');return g}
 next(actor:TaskPrincipal,u:RecoveryUnit,commandId:string,profileId:string){if(actor.role!=='phone')throw new TaskConflict('Original phone dispatch inbox required');const owner=this.owner(actor,u);if(owner.attempt.activeCommandId!==commandId||owner.attempt.profileId!==profileId)throw new TaskConflict('Original current command/profile required');if(!this.enabled())return null
  const rows=this.sql.exec<{body:string}>('SELECT body FROM managed_recovery_dispatch WHERE unit_id = ? LIMIT 17',recoveryUnitKey(u)).toArray();if(rows.length>16)throw new TaskConflict('Retain dispatch history for inspection')
  const eligible=rows.map(r=>parseDispatchTicket(JSON.parse(r.body))).filter(t=>{if(t.phase!=='queued')return false;try{this.current(actor,t);return true}catch{return false}})
  if(eligible.length>1)throw new TaskConflict('Conflicting deliveries require owner inspection');return eligible[0]??null
 }
 claim(actor:TaskPrincipal,id:string,claimId:string){if(!recoveryId(claimId))throw new TaskConflict('Original durable phone claim required');return this.tx(()=>{const t=this.ticket(actor,id);if(actor.role!=='phone')throw new TaskConflict('Original phone claim required');if(t.claimId!==null){if(t.claimId!==claimId)throw new TaskConflict('Original dispatch claim cannot be replaced');return t}this.current(actor,t);if(t.phase!=='queued')throw new TaskConflict('Dispatch cannot be restarted');t.claimId=claimId;t.phase='claimed';t.revision++;this.put(t);return t})}
 check(actor:TaskPrincipal,id:string,claimId:string){const t=this.ticket(actor,id);this.current(actor,t);if(t.phase!=='claimed'||t.claimId!==claimId)throw new TaskConflict('Exact original claimed delivery required');return t}
 complete(actor:TaskPrincipal,id:string,claimId:string,outcome:'consumed'|'held'){if(!['consumed','held'].includes(outcome))throw new TaskConflict('Exact delivery outcome required');return this.tx(()=>{const t=this.ticket(actor,id);if(actor.role!=='phone'||!recoveryId(claimId))throw new TaskConflict('Original dispatch claim required');if(t.phase==='cancelled')return t;if(t.phase==='queued'&&outcome==='held'){t.claimId=claimId;t.phase='held';t.finishedAt=this.now();t.revision++;this.put(t);return t}if(t.claimId!==claimId)throw new TaskConflict('Original dispatch claim required');if(t.phase==='consumed'||t.phase==='held'){if(t.phase!==outcome)throw new TaskConflict('Conflicting immutable delivery outcome');return t}if(t.phase!=='claimed')throw new TaskConflict('Original claimed delivery required');t.phase=outcome;t.finishedAt=this.now();t.revision++;this.put(t);return t})}
 cancel(actor:TaskPrincipal,id:string,revision:number){if(actor.role!=='studio')throw new TaskConflict('Studio delivery stop required');return this.tx(()=>{const t=this.ticket(actor,id);if(t.revision!==revision)throw new TaskConflict('Inspect the original delivery revision');if(t.phase==='queued'||t.phase==='claimed'){t.phase='cancelled';t.finishedAt=this.now();t.revision++;this.put(t)}return t})}
 /** Enrolled effects cannot bypass dispatch off/stops through the ordinary manual grant endpoint. Facts remain replayable. */
 /** Retained restoration is explicit-only; no legacy delivery ticket can confer its authority. */
 assertRetainedManualEffect(actor:TaskPrincipal,raw:unknown,actionId:string){
  const f=parseRestorationFence(raw)
  if(!f.retained||actor.role!=='phone'||actor.deviceId!==f.deviceId)throw new TaskConflict('Explicit original retained executor required')
  this.owner(actor,f.unit);assertRecoveryControls(this.sql,f.unit)
  const rows=this.sql.exec<{body:string}>('SELECT body FROM managed_recovery_dispatch WHERE unit_id = ? LIMIT 17',recoveryUnitKey(f.unit)).toArray()
  if(rows.length>16||rows.some(r=>parseDispatchTicket(JSON.parse(r.body)).kind==='restore_conversation'))throw new TaskConflict('Legacy restoration delivery must remain separate')
  const rawRecord=this.row('managed_conversation_recovery_episodes',recoveryUnitKey(f.unit)),record=rawRecord?parseConversationRecord(rawRecord):null,a=record?.actions.at(-1)
  if(!record||canonicalJson(record.fence)!==canonicalJson(f)||!record.enabled||record.paused||record.cancelled||a?.id!==actionId||!['reserved','executing'].includes(a.phase))throw new TaskConflict('Exact explicit retained restoration action required')
 }
 assertEffect(actor:TaskPrincipal,kind:DispatchKind,fence:any,actionId:string){const f=dispatchFence(kind,fence),rows=this.sql.exec<{body:string}>('SELECT body FROM managed_recovery_dispatch WHERE unit_id = ? LIMIT 17',recoveryUnitKey(f.unit)).toArray();if(rows.length>16)throw new TaskConflict('Retained dispatch inventory conflict')
  const matches=rows.map(r=>parseDispatchTicket(JSON.parse(r.body))).filter(t=>t.kind===kind&&t.actionId===actionId);if(!matches.length)return;if(matches.length!==1)throw new TaskConflict('Conflicting original delivery')
  const t=matches[0];if(actor.role!=='phone'||actor.deviceId!==t.deviceId||t.phase!=='consumed'||!this.enabled()||!this.kindEnabled(kind)||this.now()>=t.expiresAt||canonicalJson(t.fence)!==canonicalJson(fence))throw new TaskConflict('Original dispatch effect is off, held, expired or unconsumed')
  const owner=this.owner(actor,t.unit);if(owner.attempt.activeCommandId!==t.commandId||owner.attempt.profileId!==t.profileId)throw new TaskConflict('Original dispatch owner changed');assertRecoveryControls(this.sql,t.unit)
  const raw=this.row(tables[kind],recoveryUnitKey(t.unit)),r=raw?parsers[kind](raw):null,a=r?.actions.at(-1)
  if(!r||!r.enabled||r.paused||r.cancelled||a?.id!==actionId||!['reserved','executing','unknown'].includes(a.phase)||a.phase==='reserved'&&r.revision!==t.grantRevision)throw new TaskConflict('Original dispatched grant changed')
 }
}
