import {canonicalJson,TaskConflict} from './managedTaskProtocol.js'
import {parseConversationFence,type ConversationFence} from './conversationRestorationProtocol.js'
import {retainedContextInspection,retainedContextTarget} from './retainedContextAuthorityProtocol.js'
import {recoveryExact,recoveryHash,recoveryId,type SavedImportAction} from './managedSavedImportRecoveryProtocol.js'
export const RETAINED_BINDING_SCHEMA='retained-context-binding/1'
export interface RetainedBindingProof {schema:'retained-binding-proof/1';observedAt:number;candidateId:string;bindingId:string;anchorSha256:string;originalBindingId:string;contextMatched:true;currentProfile:true;cachedSourceVerified:true;originalView:false;resendAllowed:false;portable:false}
export interface RetainedBindingAction extends SavedImportAction {before:RetainedBindingProof|null;after:RetainedBindingProof|null;effect:null|'not_touched'|'possible'|'bound_retained_context'}
export interface RetainedBindingRecord {schema:typeof RETAINED_BINDING_SCHEMA;fence:ConversationFence;inspection:ReturnType<typeof retainedContextInspection>;target:ReturnType<typeof retainedContextTarget>;candidateId:string;offeredAt:number;revision:number;enabled:boolean;paused:boolean;cancelled:boolean;nextEligibleAt:number;actions:RetainedBindingAction[]}
export function retainedBindingProof(raw:unknown,r:RetainedBindingRecord,now:number):RetainedBindingProof {
 recoveryExact(raw,['schema','observedAt','candidateId','bindingId','anchorSha256','originalBindingId','contextMatched','currentProfile','cachedSourceVerified','originalView','resendAllowed','portable'])
 if(raw.schema!=='retained-binding-proof/1'||!Number.isSafeInteger(raw.observedAt)||raw.observedAt<r.offeredAt||raw.observedAt>now||now-raw.observedAt>=120000||raw.candidateId!==r.candidateId||raw.bindingId!==r.target.bindingId||raw.anchorSha256!==r.fence.anchorSha256||raw.originalBindingId!==r.fence.context.bindingId||['contextMatched','currentProfile','cachedSourceVerified'].some(k=>raw[k]!==true)||['originalView','resendAllowed','portable'].some(k=>raw[k]!==false))throw new TaskConflict('Fresh distinct-view retained binding proof required; never an original-view proof')
 return structuredClone(raw) as RetainedBindingProof
}
export function parseRetainedBindingRecord(raw:unknown):RetainedBindingRecord {
 recoveryExact(raw,['schema','fence','inspection','target','candidateId','offeredAt','revision','enabled','paused','cancelled','nextEligibleAt','actions'])
 const f=parseConversationFence(raw.fence),i=retainedContextInspection(raw.inspection,f,raw.inspection?.observedAt);retainedContextTarget(raw.target,f,i)
 if(raw.schema!==RETAINED_BINDING_SCHEMA||!recoveryId(raw.candidateId)||!Number.isSafeInteger(raw.offeredAt)||raw.offeredAt<i.observedAt||raw.offeredAt<raw.target.accountObservationAt||!Number.isSafeInteger(raw.revision)||raw.revision<1||![raw.enabled,raw.paused,raw.cancelled].every(v=>typeof v==='boolean')||!Number.isSafeInteger(raw.nextEligibleAt)||raw.nextEligibleAt<0||!Array.isArray(raw.actions)||raw.actions.length>1)throw new TaskConflict('Invalid immutable retained binding ledger')
 const r=raw as RetainedBindingRecord
 for(const a of r.actions){
  recoveryExact(a,['id','phase','at','finishedAt','evidenceRef','before','after','effect'])
  if(!recoveryId(a.id)||!Number.isSafeInteger(a.at)||a.at<r.offeredAt||!['reserved','executing','safe_failure','unknown','verified'].includes(a.phase))throw new TaskConflict('Invalid one-use retained binding grant')
  if(a.before!==null){retainedBindingProof(a.before,r,a.before.observedAt);if(a.before.observedAt<a.at)throw new TaskConflict('Binding precondition predates its grant')}
  if(a.after!==null){retainedBindingProof(a.after,r,a.after.observedAt);if(!a.before||a.after.observedAt<a.before.observedAt)throw new TaskConflict('Binding postcondition predates its precondition')}
  const pending=['reserved','executing'].includes(a.phase)
  if(pending?a.finishedAt!==null||a.evidenceRef!==null:!Number.isSafeInteger(a.finishedAt)||Number(a.finishedAt)<a.at||a.evidenceRef!=='binding/'+a.id)throw new TaskConflict('Invalid binding outcome timing')
  if(a.phase==='reserved'?(a.before!==null||a.after!==null||a.effect!==null):a.phase==='executing'?(a.before===null||a.after!==null||a.effect!=='possible'):a.phase==='verified'?(a.before===null||a.after===null||a.effect!=='bound_retained_context'):a.phase==='unknown'?(a.before===null||a.after!==null||a.effect!=='possible'):(a.after!==null||a.effect!=='not_touched'))throw new TaskConflict('Binding phase and physical effect disagree')
  if(a.after&&a.after.observedAt>Number(a.finishedAt))throw new TaskConflict('Binding postcondition follows outcome receipt')
 }
 return structuredClone(r)
}
export const sameRetainedBindingOffer=(r:RetainedBindingRecord,f:ConversationFence,i:unknown,t:unknown,candidate:string)=>canonicalJson([r.fence,r.inspection,r.target,r.candidateId])===canonicalJson([f,i,t,candidate])
