import {recoveryUnitKey,type RecoveryUnit} from '../../server/src/services/automationRecoveryPolicy'
import type {TaskSql,TaskAuthority} from './taskAuthority'
import {TaskConflict,canonicalJson,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {artifactRef} from '../../server/src/services/managedCropArtifact'
import {recoveryId,savedImportKey} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {SAVED_UPLOAD_SCHEMA,parseSavedUploadRecord,type SavedUploadFence,type SavedUploadRecord} from '../../server/src/services/managedSavedUploadRecoveryProtocol'
import {initRecoveryBudget,sharedRecoveryBudget,assertRecoveryReservation,assertRecoveryControls} from './recoveryBudget'
export class SavedUploadRecovery {
 constructor(private sql:TaskSql,private transaction:<T>(work:()=>T)=>T,private authority:TaskAuthority,private now=Date.now,private jitter=Math.random){initRecoveryBudget(sql);sql.exec('CREATE TABLE IF NOT EXISTS managed_saved_transfer_terminals (id TEXT PRIMARY KEY, body TEXT NOT NULL)');sql.exec('CREATE TABLE IF NOT EXISTS managed_saved_transfer_bindings (id TEXT PRIMARY KEY, body TEXT NOT NULL)');sql.exec('CREATE TABLE IF NOT EXISTS managed_ordinary_upload_intents (id TEXT PRIMARY KEY)')}
 private put(r:SavedUploadRecord){parseSavedUploadRecord(r);this.sql.exec('INSERT INTO managed_upload_recovery_episodes (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',savedImportKey(r.fence),JSON.stringify(r))}
 private get(f:SavedUploadFence):SavedUploadRecord|null{const row=this.sql.exec<{body:string}>('SELECT body FROM managed_upload_recovery_episodes WHERE id = ?',savedImportKey(f)).toArray()[0];return row?parseSavedUploadRecord(JSON.parse(row.body)):null}
 context(actor:TaskPrincipal,f:SavedUploadFence){
  this.authority.assertWorkspace(f.taskId,f.workspaceId)
  const owner=this.authority.artifactOwner(actor,f.taskId,f.attemptId,f.generation,f.fingerprint)
  if(owner.attempt.activeCommandId!==f.commandId||owner.attempt.checkpointRef!==f.checkpointRef||owner.attempt.submission!=='saved')throw new TaskConflict('Exact original saved attempt/checkpoint required')
  const old=this.get(f);if(old&&canonicalJson(old.fence)!==canonicalJson(f))throw new TaskConflict('Pinned saved upload packet cannot change')
  return {...owner,record:old}
 }
 private eligible(actor:TaskPrincipal,f:SavedUploadFence){this.assertOpenTransfer(f);const c=this.context(actor,f);if(!['running','uncertain'].includes(c.task.state)||c.attempt.phase!=='result_saved'||c.task.canonical)throw new TaskConflict('Only the unfinished original saved upload may run');return c}
 discover(actor:TaskPrincipal,unit:RecoveryUnit){if(actor.role!=='studio')throw new TaskConflict('Studio inspection required');recoveryUnitKey(unit);this.authority.assertWorkspace(unit.taskId,unit.workspaceId);this.authority.artifactOwner(actor,unit.taskId,unit.attemptId,unit.generation,unit.fingerprint);const row=this.sql.exec<{body:string}>('SELECT body FROM managed_upload_recovery_episodes WHERE id = ?',savedImportKey(unit)).toArray()[0];return row?this.context(actor,parseSavedUploadRecord(JSON.parse(row.body)).fence).record:null}
 inspect(actor:TaskPrincipal,f:SavedUploadFence){return this.transaction(()=>this.context(actor,f).record)}
 /** A phone may offer metadata, never enable admission or allocate its own attempt. */
 offer(actor:TaskPrincipal,f:SavedUploadFence){if(actor.role!=='phone')throw new TaskConflict('Original phone offer required');return this.transaction(()=>{
  const c=this.eligible(actor,f);if(c.record)return c.record
  if(this.sql.exec('SELECT id FROM managed_upload_recovery_episodes LIMIT 129').toArray().length>=128)throw new TaskConflict('Recovery inventory bound reached')
  const r:SavedUploadRecord={schema:SAVED_UPLOAD_SCHEMA,fence:structuredClone(f),revision:1,enabled:false,paused:false,cancelled:false,nextEligibleAt:0,actions:[]};this.put(r);return r
 })}
 control(actor:TaskPrincipal,f:SavedUploadFence,revision:number,enabled:boolean,paused:boolean,cancelled:boolean){if(actor.role!=='studio')throw new TaskConflict('Automation Manager admission required');return this.transaction(()=>{
  const r=this.context(actor,f).record
  if(!r||revision!==r.revision||![enabled,paused,cancelled].every(v=>typeof v==='boolean'))throw new TaskConflict('Current saved upload controls required')
  if(enabled&&!paused&&!cancelled&&r.actions.at(-1)?.phase!=='verified')this.eligible(actor,f)
  r.revision++;r.enabled=enabled;r.paused=paused;r.cancelled=r.cancelled||cancelled;this.put(r);return r
 })}
 private ready(r:SavedUploadRecord|null):asserts r is SavedUploadRecord{if(!r||!r.enabled||r.paused||r.cancelled)throw new TaskConflict('Saved upload recovery is disabled, paused or cancelled')}
 reserve(actor:TaskPrincipal,f:SavedUploadFence,revision:number,actionId:string){if(actor.role!=='studio')throw new TaskConflict('Automation Manager reservation required');return this.transaction(()=>{
  const r=this.eligible(actor,f).record;this.ready(r)
  if(revision!==r.revision||(!recoveryId(actionId)||actionId.length>100)||r.actions.some(a=>a.phase!=='safe_failure'))throw new TaskConflict('Exact current recovery action required')
  assertRecoveryReservation(this.sql,f,actionId,this.now())
  r.actions.push({id:actionId,phase:'reserved',at:this.now(),finishedAt:null,evidenceRef:null});r.revision++;this.put(r);return r
 })}
 start(actor:TaskPrincipal,f:SavedUploadFence,actionId:string){if(actor.role!=='phone')throw new TaskConflict('Original phone executor required');return this.transaction(()=>{
  assertRecoveryControls(this.sql,f);const r=this.eligible(actor,f).record;this.ready(r);const a=r.actions.at(-1)
  if(a?.id!==actionId||a.phase!=='reserved')throw new TaskConflict('Exact unstarted upload required; reconcile instead of replaying')
  a.phase='executing';r.revision++;this.put(r);return r
 })}
 check(actor:TaskPrincipal,f:SavedUploadFence,actionId:string){return this.transaction(()=>{
  assertRecoveryControls(this.sql,f);const r=this.eligible(actor,f).record;this.ready(r);if(r.actions.at(-1)?.id!==actionId||r.actions.at(-1)?.phase!=='executing')throw new TaskConflict('Exact executing upload required');return r
 })}
 finish(actor:TaskPrincipal,f:SavedUploadFence,actionId:string,outcome:'verified'|'safe_failure'|'unknown'){return this.transaction(()=>{
  const r=this.context(actor,f).record,a=r?.actions.at(-1)
  if(!r||a?.id!==actionId||!['verified','safe_failure','unknown'].includes(outcome))throw new TaskConflict('Original started upload required')
  if(a.phase===outcome)return r
  if(!['executing','unknown'].includes(a.phase)||a.phase==='unknown'&&outcome!=='verified')throw new TaskConflict('Retained upload outcome cannot be replaced')
  if(outcome==='verified'){
   const artifact=this.authority.artifact({role:'studio'},f.artifactId)
   if(artifact.sha256!==f.sha256||artifact.taskId!==f.taskId||artifact.attemptId!==f.attemptId||artifact.generation!==f.generation||artifact.fingerprint!==f.fingerprint)throw new TaskConflict('Exact uploaded artifact acknowledgment required')
  }
  a.phase=outcome;a.finishedAt=this.now();a.evidenceRef=outcome==='verified'?'artifact/'+f.sha256:'evidence/'+actionId
  if(outcome==='safe_failure'){const j=this.jitter();if(j<0||j>1||!Number.isFinite(j))throw new TaskConflict('Bounded jitter required');r.nextEligibleAt=this.now()+Math.floor(2000*2**(sharedRecoveryBudget(this.sql,f).used-1)*(0.75+0.25*j))}
  r.revision++;this.put(r);return r
 })}
 enrolled(actor:TaskPrincipal,f:{taskId:string;attemptId:string;generation:number;fingerprint:string;workspaceId:string}){this.authority.assertWorkspace(f.taskId,f.workspaceId);this.authority.artifactOwner(actor,f.taskId,f.attemptId,f.generation,f.fingerprint);return !!this.sql.exec('SELECT id FROM managed_upload_recovery_episodes WHERE id = ?',savedImportKey(f as SavedUploadFence)).toArray().length||!!this.sql.exec('SELECT id FROM managed_saved_transfer_terminals WHERE id = ?',savedImportKey(f as SavedUploadFence)).toArray().length}
 artifact(f:SavedUploadFence){const c=this.context({role:'studio'},f);return {...c,artifact:{id:f.artifactId,taskId:f.taskId,attemptId:f.attemptId,generation:f.generation,fingerprint:f.fingerprint,ref:artifactRef(c.task,f.attemptId,f.artifactId),sha256:f.sha256,validated:false,validationRef:null}}}
 reserveStorage(actor:TaskPrincipal,f:SavedUploadFence,bytes:number){const c=this.artifact(f);return this.authority.reserveArtifact(actor,f.taskId,f.attemptId,f.generation,f.fingerprint,f.artifactId,c.artifact.ref,f.sha256,bytes)}
 stage(f:SavedUploadFence,actionId:string){
  const c=this.context({role:'studio'},f),last=c.record?.actions.at(-1);if(last?.id!==actionId||!['executing','unknown','verified'].includes(last.phase))throw new TaskConflict('Original started upload receipt required');const phone={role:'phone' as const,deviceId:c.attempt.deviceId}
  return this.authority.stage(phone,'recovery_upload_'+actionId,f.taskId,f.attemptId,f.generation,f.fingerprint,f.artifactId,artifactRef(c.task,f.attemptId,f.artifactId),f.sha256)
 }

 /** An ordinary upload that crossed its effect boundary can only be inspected, never replaced by recovery. */
 assertNoOrdinaryIntent(f:SavedUploadFence){
  if(this.sql.exec('SELECT id FROM managed_ordinary_upload_intents WHERE id = ?',savedImportKey(f)).toArray().length)throw new TaskConflict('An original ordinary upload may still be in flight; reconcile it without another write')
 }
 claimOrdinaryUpload(actor:TaskPrincipal,f:RecoveryUnit){return this.transaction(()=>{
  if(this.enrolled(actor,f))throw new TaskConflict('Recovery owns the saved upload')
  this.assertNoOrdinaryIntent(f as SavedUploadFence)
  this.sql.exec('INSERT INTO managed_ordinary_upload_intents (id) VALUES (?)',savedImportKey(f as SavedUploadFence))
 })}
 /** Binds the phone's private journal to the existing charged action. Never reserves another action. */
 transfer(actor:TaskPrincipal,f:SavedUploadFence,d:any){return this.transaction(()=>{
  if(actor.role!=='phone')throw new TaskConflict('Original phone transfer journal required')
  const c=this.context(actor,f),r=c.record,a=r?.actions.at(-1)
  if(!r||!a||a.id!==d.actionId||!recoveryId(d.actionId)||!Number.isSafeInteger(d.revision)||d.revision<1||!Number.isSafeInteger(d.policyRevision)||d.policyRevision<1||!recoveryId(d.accountId)||typeof d.bindingHash!=='string'||!(/^[a-f0-9]{64}$/).test(d.bindingHash)||!['prepare','arm','read'].includes(d.mode))throw new TaskConflict('Exact original transfer binding required')
  const pin=c.attempt.accountSelection
  if(!pin||pin.accountId!==d.accountId||c.attempt.accountId!==d.accountId||pin.policy.revision!==d.policyRevision)throw new TaskConflict('Original account/policy pin required')
  const key=savedImportKey(f),row=this.sql.exec<{body:string}>('SELECT body FROM managed_saved_transfer_bindings WHERE id = ?',key).toArray()[0]
  const binding={schema:'saved-transfer-authority/1',actionId:d.actionId,revision:d.revision,bindingHash:d.bindingHash,accountId:d.accountId,policyRevision:d.policyRevision}
  let old=row?JSON.parse(row.body):null
  if(row&&(!old||typeof old.armed!=='boolean'||canonicalJson(old)!==canonicalJson({...binding,armed:old.armed})))throw new TaskConflict('Original journal binding changed')
  if(d.mode==='read'){
   if(old?.armed!==true||!['reserved','executing','unknown','verified'].includes(a.phase))throw new TaskConflict('Original armed transfer required')
   return old
  }
  this.eligible(actor,f);this.ready(r);assertRecoveryControls(this.sql,f);this.assertNoOrdinaryIntent(f)
  const budget=sharedRecoveryBudget(this.sql,f)
  if(!budget.pending||budget.used<1||a.phase!=='reserved'||r.revision!==d.revision||old?.armed)throw new TaskConflict('Original transfer intent already consumed or grant changed; reconcile')
  if(d.mode==='arm'&&!old)throw new TaskConflict('Keep the original prepared journal binding')
  old={...binding,armed:d.mode==='arm'}
  this.sql.exec('INSERT INTO managed_saved_transfer_bindings (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',key,JSON.stringify(old))
  return old
 })}
 assertTransfer(actor:TaskPrincipal,f:SavedUploadFence,actionId:string,bindingHash?:string){
  const row=this.sql.exec<{body:string}>('SELECT body FROM managed_saved_transfer_bindings WHERE id = ?',savedImportKey(f)).toArray()[0]
  if(!row){if(bindingHash!==undefined)throw new TaskConflict('Original remote journal binding missing');return}
  const b=JSON.parse(row.body)
  this.transfer(actor,f,{mode:'read',actionId,revision:b.revision,bindingHash,accountId:b.accountId,policyRevision:b.policyRevision})
 }
 holdArmedTransfer(actor:TaskPrincipal,f:SavedUploadFence,actionId:string){return this.transaction(()=>{
  this.assertOpenTransfer(f)
  const r=this.context(actor,f).record,a=r?.actions.at(-1)
  const row=this.sql.exec<{body:string}>('SELECT body FROM managed_saved_transfer_bindings WHERE id = ?',savedImportKey(f)).toArray()[0]
  if(a?.id===actionId&&a.phase==='reserved'&&row&&JSON.parse(row.body).armed===true){
   a.phase='unknown';a.finishedAt=this.now();a.evidenceRef='evidence/'+actionId;r!.revision++;this.put(r!);return r
  }
  return r
 })}
 /** Terminal proof never releases/reset budgets, reservations, episode history or the remote arm. */
 assertOpenTransfer(f:SavedUploadFence){if(this.sql.exec('SELECT id FROM managed_saved_transfer_terminals WHERE id = ?',savedImportKey(f)).toArray().length)throw new TaskConflict('Terminal transfer remains fenced')}
 closeTransfer(actor:TaskPrincipal,f:SavedUploadFence,d:any){return this.transaction(()=>{
  assertRecoveryControls(this.sql,f)
  const c=this.context(actor,f),r=c.record,a=r?.actions.at(-1)
  const binding=this.transfer(actor,f,{mode:'read',actionId:d.actionId,revision:d.revision,bindingHash:d.bindingHash,accountId:d.accountId,policyRevision:d.policyRevision})
  const artifact=this.authority.artifact({role:'studio'},f.artifactId)
  if(!a||a.id!==d.actionId||a.phase!=='verified'||c.task.state!=='verified_complete'||c.attempt.phase!=='published'||c.task.canonical!==artifact.ref||!artifact.validated||!artifact.validationRef||!/^validation\/[A-Za-z0-9_-]{1,128}$/.test(artifact.validationRef)||artifact.sha256!==f.sha256||artifact.ref!==artifactRef(c.task,f.attemptId,f.artifactId))throw new TaskConflict('Exact verified and published transfer required before cleanup')
  const row=this.sql.exec<{body:string}>('SELECT body FROM managed_uploads WHERE id = ?',f.taskId).toArray()[0],slot=row?JSON.parse(row.body):null
  if(!Number.isSafeInteger(d.byteLength)||d.byteLength<1||d.byteLength>1000000||slot?.bytes!==d.byteLength||slot.sha256!==f.sha256||slot.ref!==artifact.ref||slot.attemptId!==f.attemptId||slot.generation!==f.generation||slot.fingerprint!==f.fingerprint||slot.artifactId!==f.artifactId)throw new TaskConflict('Original immutable saved byte count required')
  const key=savedImportKey(f),oldRow=this.sql.exec<{body:string}>('SELECT body FROM managed_saved_transfer_terminals WHERE id = ?',key).toArray()[0],old=oldRow?JSON.parse(oldRow.body):null
  const closedAt=old?old.closedAt:this.now()
  if(!Number.isSafeInteger(closedAt)||closedAt<0||closedAt>Number.MAX_SAFE_INTEGER)throw new TaskConflict('Invalid terminal source time')
  const receipt={schema:'saved-transfer-terminal/1',fence:structuredClone(f),actionId:d.actionId,grantRevision:binding.revision,bindingHash:binding.bindingHash,deviceId:c.attempt.deviceId,profileId:c.attempt.profileId,accountId:binding.accountId,policyRevision:binding.policyRevision,byteLength:d.byteLength,ref:artifact.ref,validationRef:artifact.validationRef,closedAt}
  if(old&&canonicalJson(old)!==canonicalJson(receipt))throw new TaskConflict('Terminal receipt changed; retain original history')
  if(!old)this.sql.exec('INSERT INTO managed_saved_transfer_terminals (id,body) VALUES (?,?)',key,JSON.stringify(receipt))
  return receipt
 })}
 budget(f:SavedUploadFence){return sharedRecoveryBudget(this.sql,f)}
}
