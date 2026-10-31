import type {TaskSql} from './taskAuthority'
import {TaskConflict,canonicalJson,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {parseConversationFence,type ConversationFence} from '../../server/src/services/conversationRestorationProtocol'
import {parseRetainedBindingRecord,retainedBindingProof} from '../../server/src/services/retainedContextBindingProtocol'
import {parseCorrectionFence,parseCorrectionRecord} from '../../server/src/services/correctionRecoveryProtocol'
import {recoveryExact,recoveryId} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {recoveryUnitKey} from '../../server/src/services/automationRecoveryPolicy'
import {artifactHash} from '../../server/src/services/managedCropArtifact'
import {assertRecoveryControls,sharedRecoveryBudget} from './recoveryBudget'
/** Read-only, purpose-specific permission to save already-approved local bytes. Never provider execution. */
export class RetainedCorrectionConsumer {
 constructor(private sql:TaskSql,private tx:<T>(work:()=>T)=>T,private current:(actor:TaskPrincipal,f:ConversationFence)=>number,private now=Date.now){}
 async check(actor:TaskPrincipal,rawFence:ConversationFence,raw:unknown){
  const f=parseConversationFence(rawFence)
  recoveryExact(raw,['bindingActionId','correctionFence','correctionActionId','proof'])
  const d=structuredClone(raw),cf=parseCorrectionFence(d.correctionFence)
  if(actor.role!=='phone'||actor.deviceId!==f.deviceId||!recoveryId(d.bindingActionId)||!recoveryId(d.correctionActionId)||canonicalJson([cf.unit,cf.commandId,cf.deviceId,cf.profileId,cf.context])!==canonicalJson([f.unit,f.commandId,f.deviceId,f.profileId,f.context]))throw new TaskConflict('Exact original local correction and distinct binding required')
  const correctionFenceSha256=await artifactHash(new TextEncoder().encode(canonicalJson(cf)))
  return this.tx(()=>{
   const deadline=this.current(actor,f),key=recoveryUnitKey(f.unit)
   const read=(table:string)=>{const r=this.sql.exec<{body:string}>('SELECT body FROM '+table+' WHERE id = ?',key).toArray()[0];if(!r)throw new TaskConflict('Original grant ledger required');return JSON.parse(r.body)}
   const binding=parseRetainedBindingRecord(read('managed_retained_binding_episodes')),b=binding.actions[0]
   if(canonicalJson(binding.fence)!==canonicalJson(f)||!binding.enabled||binding.paused||binding.cancelled||!b||b.id!==d.bindingActionId||b.phase!=='verified')throw new TaskConflict('Verified enabled original retained association required')
   const proof=retainedBindingProof(d.proof,binding,this.now())
   if(proof.observedAt<Number(b.finishedAt)||this.now()-proof.observedAt>=15000)throw new TaskConflict('Fresh still-live bound context required')
   const correction=parseCorrectionRecord(read('managed_correction_recovery_episodes')),a=correction.actions.at(-1)
   if(canonicalJson(correction.fence)!==canonicalJson(cf)||!correction.enabled||correction.paused||correction.cancelled||!a||a.id!==d.correctionActionId||a.phase!=='executing'||proof.observedAt<a.at)throw new TaskConflict('Separate exact executing correction grant required')
   assertRecoveryControls(this.sql,f.unit);const budget=sharedRecoveryBudget(this.sql,f.unit)
   // Only the exact correction may be pending. The verified association adds no independent allowance.
   for(const table of ['managed_recovery_episodes','managed_upload_recovery_episodes','managed_account_recovery_episodes','managed_navigation_recovery_episodes','managed_ui_recovery_episodes','managed_conversation_recovery_episodes']){
    const row=this.sql.exec<{body:string}>('SELECT body FROM '+table+' WHERE id = ?',key).toArray()[0]
    if(row&&JSON.parse(row.body).actions.some((x:{phase:string})=>['reserved','executing','unknown'].includes(x.phase)))throw new TaskConflict('Reconcile competing recovery first')
   }
   if(!budget.pending)throw new TaskConflict('Original correction reservation required')
   const issuedAt=this.now(),validUntil=Math.min(issuedAt+15000,proof.observedAt+15000,deadline)
   if(!Number.isSafeInteger(validUntil)||validUntil<=issuedAt)throw new TaskConflict('Current correction authority expired')
   return {schema:'retained-binding-local-correction-permit/1',bindingActionId:b.id,correctionActionId:a.id,candidateId:binding.candidateId,bindingId:binding.target.bindingId,anchorSha256:f.anchorSha256,correctionFenceSha256,artifactSha256:cf.preview.artifactSha256,issuedAt,validUntil,localCheckpointAllowed:true,originalView:false,providerExecutionAllowed:false,rebindAllowed:false,resendAllowed:false,fallbackAllowed:false}
  })
 }
}
