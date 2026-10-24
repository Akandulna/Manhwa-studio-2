import {retainedInventory} from './retainedInventory'
import {CORRECTION_SCHEMA,parseCorrectionFence,parseCorrectionRecord,sameCorrectionFence,type CorrectionFence,type CorrectionRecord} from '../../server/src/services/correctionRecoveryProtocol'
import {TaskConflict,canonicalJson,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {recoveryUnitKey,type RecoveryUnit} from '../../server/src/services/automationRecoveryPolicy'
import {recoveryId,recoveryExact} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {type AccountPolicy} from '../../server/src/services/managedAccountsProtocol'
import {validateManagedCrop,artifactHash} from '../../server/src/services/managedCropArtifact'
import {initRecoveryBudget,sharedRecoveryBudget,assertRecoveryReservation,assertRecoveryControls} from './recoveryBudget'
import type {TaskSql,TaskAuthority} from './taskAuthority'
/** Local validated correction only. Never grants browser/provider/fallback work or bypasses artifact review. */
export class CorrectionRecovery {
 constructor(private sql:TaskSql,private tx:<T>(work:()=>T)=>T,private authority:TaskAuthority,private now=Date.now){initRecoveryBudget(sql)}
 private row<T>(table:string,id:string):T|null{const r=this.sql.exec<{body:string}>('SELECT body FROM '+table+' WHERE id = ?',id).toArray()[0];return r?JSON.parse(r.body):null}
 private get(f:CorrectionFence){const r=this.row('managed_correction_recovery_episodes',recoveryUnitKey(f.unit));return r?parseCorrectionRecord(r):null}
 private put(r:CorrectionRecord){parseCorrectionRecord(r);this.sql.exec('INSERT INTO managed_correction_recovery_episodes (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',recoveryUnitKey(r.fence.unit),JSON.stringify(r))}
 private context(actor:TaskPrincipal,f:CorrectionFence,admit=false,allowSaved=false){
  parseCorrectionFence(f);const u=f.unit;this.authority.assertWorkspace(u.taskId,u.workspaceId)
  const owner=this.authority.artifactOwner(actor,u.taskId,u.attemptId,u.generation,u.fingerprint),a=owner.attempt,t=owner.task,r=this.get(f)
  if(a.deviceId!==f.deviceId||a.profileId!==f.profileId||a.activeCommandId!==f.commandId||r&&!sameCorrectionFence(r.fence,f))throw new TaskConflict('Exact original correction owner and proposal required')
  if(admit){
   const p=a.accountSelection,policy=this.row<AccountPolicy>('managed_account_policies','crop_json'),peer=this.row<{capabilities:string[];receivedAt:string}>('managed_peers',f.deviceId),enrolled=this.row<{profileId:string}>('managed_enrollment',f.deviceId)
   const last=r?.actions.at(-1),saved=allowSaved&&last?.phase==='verified'&&a.phase==='result_saved'&&a.submission==='saved'&&a.checkpointRef===last.checkpointRef
   if(t.canonical||(saved?!['running','uncertain'].includes(t.state):t.state!=='running'||a.phase!=='submitted'||a.submission!=='submitted'||a.checkpointRef!==null||Date.parse(a.leaseExpiresAt)<=this.now()+30000))throw new TaskConflict('Original acknowledged submitted owner and current lease required')
   if(!p||a.accountId!==f.context.accountId||p.accountId!==a.accountId||p.policy.revision!==f.context.policyRevision||policy?.revision!==f.context.policyRevision||!policy.enabled||canonicalJson(p.configuration)!==canonicalJson(t.spec)||!policy.allowed.some(c=>c.provider===t.spec.provider&&c.product===t.spec.product&&c.model===t.spec.model&&c.mode===t.spec.settings.mode&&c.effort===t.spec.settings.effort))throw new TaskConflict('Current original pinned correction policy required')
   if(t.spec.provider!=='chatgpt'||t.spec.product!=='chatgpt-web'||!t.spec.dependencies.some(d=>d.id===t.pageId&&d.revision===t.spec.pageRevision&&d.sha256===f.context.sourceSha256)||enrolled?.profileId!==f.profileId||!peer?.capabilities.includes(CORRECTION_SCHEMA)||Date.parse(peer.receivedAt)>this.now()||this.now()-Date.parse(peer.receivedAt)>15*60000||f.context.capturedAt>this.now())throw new TaskConflict('Current original input and compatible correction phone required')
   for(const resource of ['device:'+f.deviceId,'browser:'+f.deviceId,'profile:'+f.deviceId+':'+f.profileId])if(this.sql.exec<{attempt_id:string}>('SELECT attempt_id FROM managed_reservations WHERE resource = ?',resource).toArray()[0]?.attempt_id!==a.id)throw new TaskConflict('Original correction reservations required')
   const prefix='account:'+a.accountId+':';if(!this.sql.exec<{attempt_id:string}>('SELECT attempt_id FROM managed_reservations WHERE substr(resource,1,?) = ?',prefix.length,prefix).toArray().some(s=>s.attempt_id===a.id))throw new TaskConflict('Original account reservation required')
   if(!saved&&this.sql.exec("SELECT id FROM managed_artifacts WHERE json_extract(body,'$.attemptId') = ? LIMIT 1",a.id).toArray().length)throw new TaskConflict('Preserve existing accepted or staged artifacts')
  }
  return {...owner,record:r}
 }
 discover(actor:TaskPrincipal,u:RecoveryUnit){recoveryUnitKey(u);this.authority.assertWorkspace(u.taskId,u.workspaceId);this.authority.artifactOwner(actor,u.taskId,u.attemptId,u.generation,u.fingerprint);const r=this.row('managed_correction_recovery_episodes',recoveryUnitKey(u));return r?parseCorrectionRecord(r):null}
 offer(actor:TaskPrincipal,f:CorrectionFence){if(actor.role!=='phone'||actor.deviceId!==f.deviceId)throw new TaskConflict('Original private preview owner required');return this.tx(()=>{const c=this.context(actor,f,true);if(c.record)return c.record;if(retainedInventory(this.sql,'managed_correction_recovery_episodes',128)>=128)throw new TaskConflict('Correction inventory full');const r:CorrectionRecord={schema:CORRECTION_SCHEMA,fence:structuredClone(f),revision:1,enabled:false,paused:false,cancelled:false,nextEligibleAt:0,actions:[]};this.put(r);return r})}
 control(actor:TaskPrincipal,f:CorrectionFence,revision:number,enabled:boolean,paused:boolean,cancelled:boolean){if(actor.role!=='studio')throw new TaskConflict('Studio correction approval required');return this.tx(()=>{const r=this.context(actor,f,enabled&&!paused&&!cancelled,true).record;if(!r||r.revision!==revision||![enabled,paused,cancelled].every(x=>typeof x==='boolean'))throw new TaskConflict('Exact correction controls required');r.enabled=enabled;r.paused=paused;r.cancelled=r.cancelled||cancelled;r.revision++;this.put(r);return r})}
 private ready(r:CorrectionRecord|null):asserts r is CorrectionRecord{if(!r||!r.enabled||r.paused||r.cancelled)throw new TaskConflict('Correction is disabled, paused or cancelled')}
 reserve(actor:TaskPrincipal,f:CorrectionFence,revision:number,id:string){if(actor.role!=='studio')throw new TaskConflict('Exact Studio proposal grant required');return this.tx(()=>{const r=this.context(actor,f,true).record;this.ready(r);if(r.revision!==revision||!recoveryId(id)||r.actions.some(a=>a.phase!=='safe_failure'))throw new TaskConflict('Inspect the exact original correction proposal');assertRecoveryReservation(this.sql,f.unit,id,this.now());r.actions.push({id,at:this.now(),phase:'reserved',finishedAt:null,evidenceRef:null,checkpointRef:null,eventId:null,artifactHash:null});r.revision++;this.put(r);return r})}
 start(actor:TaskPrincipal,f:CorrectionFence,id:string){if(actor.role!=='phone'||actor.deviceId!==f.deviceId)throw new TaskConflict('Original correction executor required');return this.tx(()=>{const r=this.context(actor,f,true).record;this.ready(r);assertRecoveryControls(this.sql,f.unit);const a=r.actions.at(-1);if(a?.id!==id||a.phase!=='reserved')throw new TaskConflict('Original unused correction grant required');a.phase='executing';r.revision++;this.put(r);return r})}
 finish(actor:TaskPrincipal,f:CorrectionFence,id:string,outcome:'unknown'|'safe_failure'){
  if(actor.role!=='phone'||actor.deviceId!==f.deviceId)throw new TaskConflict('Original correction outcome required')
  return this.tx(()=>{const r=this.get(f);if(!r||!sameCorrectionFence(r.fence,f))throw new TaskConflict('Original correction ledger required');const a=r.actions.find(x=>x.id===id);if(!a||!['unknown','safe_failure'].includes(outcome))throw new TaskConflict('Original correction outcome required');if(a.phase===outcome)return r;if(outcome==='safe_failure'?a.phase!=='reserved':a.phase!=='executing')throw new TaskConflict('Uncertain correction cannot become untouched');a.phase=outcome;a.finishedAt=this.now();a.evidenceRef='correction/'+id;if(outcome==='safe_failure')r.nextEligibleAt=this.now()+30000;r.revision++;this.put(r);return r})
 }
 async commit(actor:TaskPrincipal,f:CorrectionFence,id:string,eventId:string,checkpointRef:string,output:string,enabled:boolean,beforeCommit?:()=>void){
  if(actor.role!=='phone'||actor.deviceId!==f.deviceId||!recoveryId(eventId)||typeof checkpointRef!=='string'||!/^checkpoint\/[A-Za-z0-9_-]{1,128}$/.test(checkpointRef)||typeof output!=='string')throw new TaskConflict('Original durable correction checkpoint required')
  const bytes=new TextEncoder().encode(output);if(bytes.length>1000000||await artifactHash(bytes)!==f.preview.artifactSha256)throw new TaskConflict('Corrected checkpoint hash differs from the approved preview')
  let content:any;try{content=JSON.parse(output)}catch{throw new TaskConflict('Corrected output must be JSON')};recoveryExact(content,['pointers','metadata'])
  const original=this.context(actor,f),u=f.unit
  const document=new TextEncoder().encode(canonicalJson({schema:'managed-crop-page/1',taskId:u.taskId,attemptId:u.attemptId,generation:u.generation,fingerprint:u.fingerprint,checkpointRef,pageRevision:original.task.spec.pageRevision,validatorVersion:original.task.spec.validatorVersion,...content}))
  const documentHash=await artifactHash(document)
  return this.tx(()=>{
   const c=this.context(actor,f),r=c.record;const a=r?.actions.find(x=>x.id===id);if(!r||!a)throw new TaskConflict('Original granted correction required')
   const u=f.unit
   if(a.phase==='verified'){
    if(a.checkpointRef!==checkpointRef||a.eventId!==eventId||a.artifactHash!==documentHash)throw new TaskConflict('Conflicting immutable correction checkpoint')
    return {record:r,result:this.authority.checkpoint(actor,eventId,u.taskId,u.attemptId,u.generation,u.fingerprint,'result_saved',checkpointRef,f.commandId,true)}
   }
   beforeCommit?.()
   if(!enabled)throw new TaskConflict('Correction admission is off; retain the original saved bytes')
   this.context(actor,f,true);this.ready(r);assertRecoveryControls(this.sql,u)
   if(a!==r.actions.at(-1)||!['executing','unknown'].includes(a.phase))throw new TaskConflict('Reconcile the original executing correction')
   validateManagedCrop(document,c.task,{...c.attempt,checkpointRef})
   const result=this.authority.checkpoint(actor,eventId,u.taskId,u.attemptId,u.generation,u.fingerprint,'result_saved',checkpointRef,f.commandId,true)
   if(!result.permitted)throw new TaskConflict('Correction checkpoint was fenced')
   a.phase='verified';a.checkpointRef=checkpointRef;a.eventId=eventId;a.artifactHash=documentHash;a.finishedAt=this.now();a.evidenceRef='correction/'+id;r.revision++;this.put(r);return {record:r,result}
  })
 }
 status(actor:TaskPrincipal,f:CorrectionFence){const c=this.context(actor,f);let admissionReady=false;try{this.context(actor,f,true,true);admissionReady=true}catch{}return {record:c.record,admissionReady,budget:sharedRecoveryBudget(this.sql,f.unit)}}
 budget(u:RecoveryUnit){return sharedRecoveryBudget(this.sql,u)}
}
