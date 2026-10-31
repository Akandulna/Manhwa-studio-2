import {retainedInventory} from './retainedInventory'
import type {TaskSql} from './taskAuthority'
import {TaskConflict,canonicalJson,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {recoveryUnitKey} from '../../server/src/services/automationRecoveryPolicy'
import type {ConversationFence} from '../../server/src/services/conversationRestorationProtocol'
import {RETAINED_BINDING_SCHEMA,parseRetainedBindingRecord,retainedBindingProof,sameRetainedBindingOffer,type RetainedBindingRecord} from '../../server/src/services/retainedContextBindingProtocol'
import {recoveryId,recoveryExact} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {assertRecoveryControls,assertRecoveryReservation} from './recoveryBudget'
/** A distinct replacement binding, never an original-view proof, task transfer or provider submission grant. */
export class RetainedContextBinding {
 constructor(private sql:TaskSql,private tx:<T>(work:()=>T)=>T,private validate:(a:TaskPrincipal,f:ConversationFence,i:unknown,t:unknown)=>{checkedAt:number;validUntil:number},private now:()=>number){}
 get(f:ConversationFence){const row=this.sql.exec<{body:string}>('SELECT body FROM managed_retained_binding_episodes WHERE id = ?',recoveryUnitKey(f.unit)).toArray()[0];const r=row?parseRetainedBindingRecord(JSON.parse(row.body)):null;if(r&&canonicalJson(r.fence)!==canonicalJson(f))throw new TaskConflict('Original binding fence cannot change');return r}
 private put(r:RetainedBindingRecord){parseRetainedBindingRecord(r);this.sql.exec('INSERT INTO managed_retained_binding_episodes (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',recoveryUnitKey(r.fence.unit),JSON.stringify(r))}
 private phone(a:TaskPrincipal,f:ConversationFence){if(a.role!=='phone'||a.deviceId!==f.deviceId)throw new TaskConflict('Original binding executor required')}
 private studio(a:TaskPrincipal){if(a.role!=='studio')throw new TaskConflict('Explicit Studio binding approval required')}
 offer(actor:TaskPrincipal,f:ConversationFence,inspection:any,target:any,candidateId:string){this.phone(actor,f);return this.tx(()=>{
  if(!recoveryId(candidateId))throw new TaskConflict('Exact live candidate identity required')
  const old=this.get(f);if(old){if(!sameRetainedBindingOffer(old,f,inspection,target,candidateId))throw new TaskConflict('Original binding offer cannot be replaced or reset');return old}
  this.validate(actor,f,inspection,target);assertRecoveryControls(this.sql,f.unit)
  if(retainedInventory(this.sql,'managed_retained_binding_episodes',128)>=128)throw new TaskConflict('Retained binding inventory full')
  const r:RetainedBindingRecord={schema:RETAINED_BINDING_SCHEMA,fence:structuredClone(f),inspection:structuredClone(inspection),target:structuredClone(target),candidateId,offeredAt:this.now(),revision:1,enabled:false,paused:false,cancelled:false,nextEligibleAt:0,actions:[]};this.put(r);return r
 })}
 perform(actor:TaskPrincipal,f:ConversationFence,action:string,raw:unknown){return this.tx(()=>{
  const r=this.get(f);if(!r)throw new TaskConflict('Original retained binding offer required')
  if(action==='inspect-binding')return {record:r,permit:null}
  if(action==='control-binding'){
   this.studio(actor);recoveryExact(raw,['revision','enabled','paused','cancelled'])
   if(raw.revision!==r.revision||![raw.enabled,raw.paused,raw.cancelled].every(v=>typeof v==='boolean'))throw new TaskConflict('Exact binding control revision required')
   r.enabled=raw.enabled;r.paused=raw.paused;r.cancelled=r.cancelled||raw.cancelled;r.revision++;this.put(r)
   if(r.enabled&&!r.paused&&!r.cancelled){this.validate(actor,f,r.inspection,r.target);assertRecoveryControls(this.sql,f.unit)}
   return {record:r,permit:null}
  }
  if(action==='reserve-binding'){
   this.studio(actor);recoveryExact(raw,['revision','actionId'])
   if(raw.revision!==r.revision||!r.enabled||r.paused||r.cancelled||r.actions.length||!recoveryId(raw.actionId))throw new TaskConflict('Exact unused binding grant and approval required')
   this.validate(actor,f,r.inspection,r.target);assertRecoveryReservation(this.sql,f.unit,raw.actionId,this.now())
   r.actions.push({id:raw.actionId,phase:'reserved',at:this.now(),finishedAt:null,evidenceRef:null,before:null,after:null,effect:null});r.revision++;this.put(r);return {record:r,permit:null}
  }
  this.phone(actor,f)
  if(action==='start-binding'||action==='check-binding'){
   recoveryExact(raw,['actionId','proof']);const a=r.actions[0]
   if(!a||a.id!==raw.actionId||a.phase!==(action==='start-binding'?'reserved':'executing')||!r.enabled||r.paused||r.cancelled)throw new TaskConflict('Exact original binding action required; never repeat adoption')
   const fresh=this.validate(actor,f,r.inspection,r.target);assertRecoveryControls(this.sql,f.unit)
   const proof=retainedBindingProof(raw.proof,r,this.now());if(proof.observedAt<a.at||a.before&&proof.observedAt<a.before.observedAt)throw new TaskConflict('Sample after the original binding grant')
   if(action==='start-binding'){a.before=proof;a.phase='executing';a.effect='possible';r.revision++;this.put(r)}
   return {record:r,permit:action==='check-binding'?{schema:'retained-binding-effect-permit/1',actionId:a.id,candidateId:r.candidateId,bindingId:r.target.bindingId,anchorSha256:r.fence.anchorSha256,issuedAt:fresh.checkedAt,validUntil:fresh.validUntil,rebindAllowed:true,executionAllowed:false,resendAllowed:false,fallbackAllowed:false}:null}
  }
  if(action==='finish-binding'){
   recoveryExact(raw,['actionId','outcome','effect','proof']);const a=r.actions[0],outcome=raw.outcome,effect=raw.effect
   if(!a||a.id!==raw.actionId||!['verified','unknown','safe_failure'].includes(outcome)||a.phase==='reserved'&&outcome!=='safe_failure')throw new TaskConflict('Original binding outcome required')
   if(a.phase==='unknown'&&(outcome==='safe_failure'||effect==='not_touched'))throw new TaskConflict('Unknown binding effects cannot become untouched')
   const proof=outcome==='verified'?retainedBindingProof(raw.proof,r,raw.proof?.observedAt):null
   if(outcome!=='verified'&&raw.proof!==null||outcome==='verified'&&(!a.before||!proof||proof.observedAt<a.before.observedAt||effect!=='bound_retained_context')||outcome==='unknown'&&(!a.before||effect!=='possible')||outcome==='safe_failure'&&effect!=='not_touched')throw new TaskConflict('Binding physical effect and postcondition disagree')
   if(['verified','safe_failure'].includes(a.phase)){if(a.phase!==outcome||a.effect!==effect||canonicalJson(a.after)!==canonicalJson(proof))throw new TaskConflict('Immutable binding outcome conflict');return {record:r,permit:null}}
   if(a.phase===outcome&&a.effect===effect&&canonicalJson(a.after)===canonicalJson(proof))return {record:r,permit:null}
   if(proof)retainedBindingProof(proof,r,this.now())
   a.phase=outcome;a.effect=effect;a.after=proof;a.finishedAt=this.now();a.evidenceRef='binding/'+a.id;if(outcome==='safe_failure')r.nextEligibleAt=this.now()+30000;r.revision++;this.put(r);return {record:r,permit:null}
  }
  throw new TaskConflict('Exact binding operation required')
 })}
}
