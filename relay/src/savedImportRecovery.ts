import type {TaskSql,TaskAuthority} from './taskAuthority'
import {TaskConflict,canonicalJson,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {SAVED_IMPORT_SCHEMA,savedImportKey,recoveryId,recoveryHash,parseSavedImportRecord,type SavedImportFence,type SavedImportRecord} from '../../server/src/services/managedSavedImportRecoveryProtocol'

/** Same Durable Object transaction as task authority; only restores an already canonical local projection. */
export class SavedImportRecovery {
 constructor(private sql:TaskSql,private transaction:<T>(work:()=>T)=>T,private authority:TaskAuthority,private now=()=>Date.now(),private jitter=()=>Math.random()){
  sql.exec('CREATE TABLE IF NOT EXISTS managed_recovery_episodes (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
 }
 private get(f:SavedImportFence):SavedImportRecord|null {const r=this.sql.exec<{body:string}>('SELECT body FROM managed_recovery_episodes WHERE id = ?',savedImportKey(f)).toArray()[0];return r?parseSavedImportRecord(JSON.parse(r.body)):null}
 private put(r:SavedImportRecord){parseSavedImportRecord(r);this.sql.exec('INSERT INTO managed_recovery_episodes (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',savedImportKey(r.fence),JSON.stringify(r))}
 publication(actor:TaskPrincipal,f:SavedImportFence){
  if(actor.role!=='studio')throw new TaskConflict('Studio recovery owner required')
  this.authority.assertWorkspace(f.taskId,f.workspaceId)
  const {task,attempt}=this.authority.artifactOwner(actor,f.taskId,f.attemptId,f.generation,f.fingerprint),artifact=this.authority.artifact(actor,f.artifactId)
  if(task.state!=='verified_complete'||attempt.phase!=='published'||attempt.submission!=='saved'||!attempt.checkpointRef||!artifact.validated||!artifact.validationRef||artifact.taskId!==task.id||artifact.attemptId!==attempt.id||artifact.generation!==attempt.generation||artifact.fingerprint!==task.fingerprint||artifact.sha256!==f.sha256||task.canonical!==artifact.ref)throw new TaskConflict('Only the exact already verified saved crop may be imported')
  return {task,attempt,artifact}
 }
 private current(actor:TaskPrincipal,f:SavedImportFence,destinationId:string){
  this.publication(actor,f)
  if(!recoveryHash(destinationId))throw new TaskConflict('Pinned destination hash required')
  const r=this.get(f)
  if(r&&(canonicalJson(r.fence)!==canonicalJson(f)||r.destinationId!==destinationId))throw new TaskConflict('Recovery artifact or destination changed; retain the original budget')
  return r
 }
 inspect(actor:TaskPrincipal,f:SavedImportFence,destinationId:string){return this.transaction(()=>this.current(actor,f,destinationId))}
 control(actor:TaskPrincipal,f:SavedImportFence,destinationId:string,revision:number,enabled:boolean,paused:boolean,cancelled:boolean){return this.transaction(()=>{
  const old=this.current(actor,f,destinationId)
  if(!Number.isSafeInteger(revision)||revision!==(old?.revision??0)||![enabled,paused,cancelled].every(v=>typeof v==='boolean'))throw new TaskConflict('Current recovery controls required')
  if(!old&&this.sql.exec('SELECT id FROM managed_recovery_episodes LIMIT 129').toArray().length>=128)throw new TaskConflict('Recovery inventory bound reached')
  const r:SavedImportRecord=old??{schema:SAVED_IMPORT_SCHEMA,fence:structuredClone(f),destinationId,revision:0,enabled:false,paused:false,cancelled:false,nextEligibleAt:0,actions:[]}
  r.revision++;r.enabled=enabled;r.paused=paused;r.cancelled=r.cancelled||cancelled;this.put(r);return r
 })}
 private ready(r:SavedImportRecord|null):asserts r is SavedImportRecord {
  if(!r||!r.enabled||r.paused||r.cancelled)throw new TaskConflict('Recovery is disabled, paused or cancelled')
 }
 reserve(actor:TaskPrincipal,f:SavedImportFence,destinationId:string,actionId:string){return this.transaction(()=>{
  const r=this.current(actor,f,destinationId);this.ready(r)
  if(!recoveryId(actionId))throw new TaskConflict('Stable recovery action ID required')
  // Event replay is a read/reconcile requirement, never another execution grant.
  if(r.actions.some(a=>a.id===actionId)||r.actions.some(a=>a.phase!=='safe_failure'))throw new TaskConflict('Inspect and reconcile the retained action; do not replay it')
  if(r.actions.length>=3)throw new TaskConflict('Shared recovery budget exhausted')
  if(this.now()<r.nextEligibleAt)throw new TaskConflict('Recovery cooldown remains active')
  r.actions.push({id:actionId,phase:'reserved',at:this.now(),finishedAt:null,evidenceRef:null});r.revision++;this.put(r);return r
 })}
 start(actor:TaskPrincipal,f:SavedImportFence,destinationId:string,actionId:string){return this.transaction(()=>{
  const r=this.current(actor,f,destinationId);this.ready(r)
  const a=r.actions.at(-1)
  if(a?.id!==actionId||a.phase!=='reserved')throw new TaskConflict('Exact unstarted recovery action required; reconcile instead of replaying')
  a.phase='executing';r.revision++;this.put(r);return r
 })}
 check(actor:TaskPrincipal,f:SavedImportFence,destinationId:string,actionId:string){return this.transaction(()=>{
  const r=this.current(actor,f,destinationId);this.ready(r)
  const a=r.actions.at(-1)
  if(a?.id!==actionId||a.phase!=='executing')throw new TaskConflict('Exact executing action required')
  return r
 })}
 finish(actor:TaskPrincipal,f:SavedImportFence,destinationId:string,actionId:string,outcome:'verified'|'safe_failure'|'unknown',evidenceRef:string){return this.transaction(()=>{
  const r=this.current(actor,f,destinationId)
  if(!r||!['verified','safe_failure','unknown'].includes(outcome)||typeof evidenceRef!=='string'||! /^(validation\/[a-f0-9]{64}|evidence\/[A-Za-z0-9_-]{1,128})$/.test(evidenceRef))throw new TaskConflict('Exact recovery outcome evidence required')
  const a=r.actions.at(-1),publication=this.publication(actor,f)
  if(a?.id!==actionId)throw new TaskConflict('Exact original recovery action required')
  if(outcome==='verified'&&evidenceRef!==publication.artifact.validationRef)throw new TaskConflict('Verified local destination receipt required')
  if(a.phase===outcome&&a.evidenceRef===evidenceRef)return r
  if(a.phase==='verified'||a.phase==='safe_failure'){
   if(a.phase!==outcome||a.evidenceRef!==evidenceRef)throw new TaskConflict('Conflicting recovery outcome')
   return r
  }
  if(a.phase!=='executing'&&!(a.phase==='unknown'&&outcome==='verified'))throw new TaskConflict('Reconcile the exact started action')
  a.phase=outcome;a.finishedAt=this.now();a.evidenceRef=evidenceRef
  if(outcome==='safe_failure'){const jitter=this.jitter();if(!Number.isFinite(jitter)||jitter<0||jitter>1)throw new TaskConflict('Bounded recovery jitter required');r.nextEligibleAt=this.now()+Math.floor(2000*(2**(r.actions.length-1))*(0.75+jitter*0.25))}
  r.revision++;this.put(r);return r
 })}
}
