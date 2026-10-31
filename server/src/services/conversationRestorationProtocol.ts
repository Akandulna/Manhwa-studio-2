import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {recoveryExact,recoveryHash,recoveryId,type SavedImportAction} from './managedSavedImportRecoveryProtocol.js'
import {parseCorrectionContext,type CorrectionContextEvidence} from './managedCorrectionContextProtocol.js'
export const CONVERSATION_SCHEMA='original-conversation-restoration/1'
export interface ConversationFence {unit:RecoveryUnit;commandId:string;deviceId:string;profileId:string;context:CorrectionContextEvidence;anchorSha256:string}
export interface RetainedRestorationRef {schema:'retained-restoration-binding/1';bindingActionId:string;candidateId:string;bindingId:string}
export type RestorationFence=ConversationFence&{retained?:RetainedRestorationRef}
export const RETAINED_RESTORATION_CAPABILITY='retained-conversation-restoration/1'
export interface ConversationProof {schema:'original-conversation-proof/1'|'retained-conversation-proof/1';observedAt:number;anchorSha256:string;bindingId:string;commandId:string;profileId:string;fingerprint:string;sourceSha256:string;state:'empty_home'|'original_conversation';promptMatched:boolean;replyMatched:boolean;exactView:boolean;originalView?:false;bindingActionId?:string;candidateId?:string;originalBindingId?:string;currentProfile:true;cachedSourceVerified:true;portable:false;resendAllowed:false}
export interface ConversationAction extends SavedImportAction {before:ConversationProof|null;after:ConversationProof|null;effect:'not_touched'|'possible'|'opened_original'|null}
export interface ConversationRecord {schema:typeof CONVERSATION_SCHEMA;fence:RestorationFence;revision:number;enabled:boolean;paused:boolean;cancelled:boolean;nextEligibleAt:number;offer:ConversationProof;actions:ConversationAction[]}
export function parseConversationFence(raw:unknown):ConversationFence {
 recoveryExact(raw,['unit','commandId','deviceId','profileId','context','anchorSha256']);recoveryUnitKey(raw.unit)
 if(![raw.commandId,raw.deviceId,raw.profileId].every(recoveryId)||!recoveryHash(raw.anchorSha256))throw new TaskConflict('Exact original conversation owner and private anchor required')
 parseCorrectionContext(raw.context,{observedAt:raw.context?.capturedAt,failure:'malformed_output',phase:'submitted',outcome:'submitted'})
 return structuredClone(raw) as ConversationFence
}
export function parseRestorationFence(raw:unknown):RestorationFence {
 if(!raw||typeof raw!=='object'||!('retained'in raw))return parseConversationFence(raw)
 recoveryExact(raw,['unit','commandId','deviceId','profileId','context','anchorSha256','retained'])
 const {retained,...original}=raw as RestorationFence
 const base=parseConversationFence(original)
 recoveryExact(retained,['schema','bindingActionId','candidateId','bindingId'])
 if(retained.schema!=='retained-restoration-binding/1'||![retained.bindingActionId,retained.candidateId,retained.bindingId].every(recoveryId)||retained.bindingId===base.context.bindingId)throw new TaskConflict('Distinct verified retained restoration binding required')
 return {...base,retained:structuredClone(retained)}
}
export function baseConversationFence(f:RestorationFence):ConversationFence {const {retained,...base}=parseRestorationFence(f);return base}
export function conversationProof(raw:unknown,f:RestorationFence,now:number,restored:boolean):ConversationProof {
 recoveryExact(raw,['schema','observedAt','anchorSha256','bindingId','commandId','profileId','fingerprint','sourceSha256','state','promptMatched','replyMatched','exactView','currentProfile','cachedSourceVerified','portable','resendAllowed',...(f.retained?['originalView','bindingActionId','candidateId','originalBindingId']:[])])
 const ref=f.retained
 if(ref&&(raw.originalView!==false||raw.bindingActionId!==ref.bindingActionId||raw.candidateId!==ref.candidateId||raw.originalBindingId!==f.context.bindingId))throw new TaskConflict('Retained proof cannot claim the original view')
 if(raw.schema!==(ref?'retained-conversation-proof/1':'original-conversation-proof/1')||!Number.isSafeInteger(raw.observedAt)||raw.observedAt<f.context.capturedAt||raw.observedAt>now||now-raw.observedAt>=120000||raw.anchorSha256!==f.anchorSha256||raw.bindingId!==(ref?.bindingId??f.context.bindingId)||raw.commandId!==f.commandId||raw.profileId!==f.profileId||raw.fingerprint!==f.unit.fingerprint||raw.sourceSha256!==f.context.sourceSha256||raw.state!==(restored?'original_conversation':'empty_home')||raw.promptMatched!==restored||raw.replyMatched!==restored||raw.exactView!==!ref||raw.currentProfile!==true||raw.cachedSourceVerified!==true||raw.portable!==false||raw.resendAllowed!==false)throw new TaskConflict('Fresh original empty-page precondition or exact original conversation postcondition required')
 return structuredClone(raw) as ConversationProof
}
export function parseConversationRecord(raw:unknown):ConversationRecord {
 recoveryExact(raw,['schema','fence','revision','enabled','paused','cancelled','nextEligibleAt','offer','actions']);const f=parseRestorationFence(raw.fence)
 if(raw.schema!==CONVERSATION_SCHEMA||!Number.isSafeInteger(raw.revision)||raw.revision<1||![raw.enabled,raw.paused,raw.cancelled].every(v=>typeof v==='boolean')||!Number.isSafeInteger(raw.nextEligibleAt)||raw.nextEligibleAt<0||!Array.isArray(raw.actions)||raw.actions.length>(f.retained?1:3))throw new TaskConflict('Invalid retained original conversation ledger')
 conversationProof(raw.offer,f,raw.offer?.observedAt,false);const ids=new Set<string>()
 for(const [index,a] of raw.actions.entries()){
  recoveryExact(a,['id','phase','at','finishedAt','evidenceRef','before','after','effect'])
  if(!recoveryId(a.id)||ids.has(a.id)||!Number.isSafeInteger(a.at)||a.at<=0||!['reserved','executing','unknown','verified','safe_failure'].includes(a.phase)||index<raw.actions.length-1&&a.phase!=='safe_failure'||![null,'not_touched','possible','opened_original'].includes(a.effect))throw new TaskConflict('Invalid original restoration action history')
  ids.add(a.id)
  if(a.before!==null){conversationProof(a.before,f,a.before.observedAt,false);if(a.before.observedAt<a.at)throw new TaskConflict('Original precondition predates restoration grant')}
  if(a.after!==null)conversationProof(a.after,f,a.after.observedAt,true)
  if(['reserved','executing'].includes(a.phase)?a.finishedAt!==null||a.evidenceRef!==null:!Number.isSafeInteger(a.finishedAt)||a.finishedAt<a.at||a.evidenceRef!=='conversation/'+a.id)throw new TaskConflict('Original restoration outcome timing mismatch')
  if(a.phase==='reserved'?(a.before!==null||a.after!==null||a.effect!==null):a.phase==='executing'?(a.before===null||a.after!==null||a.effect!=='possible'):a.phase==='verified'?(a.before===null||a.after===null||a.after.observedAt<a.before.observedAt||!['not_touched','opened_original'].includes(a.effect)):a.phase==='unknown'?(a.before===null||a.after!==null||a.effect!=='possible'):(a.after!==null||a.effect!=='not_touched'))throw new TaskConflict('Original restoration phase and physical effect disagree')
 }
 return structuredClone(raw) as ConversationRecord
}
export const conversationKey=(f:ConversationFence)=>recoveryUnitKey(f.unit)
export const sameConversationFence=(a:ConversationFence,b:ConversationFence)=>canonicalJson(a)===canonicalJson(b)
