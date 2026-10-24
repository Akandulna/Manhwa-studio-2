import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryExact,recoveryHash,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {recoveryUnitKey} from './automationRecoveryPolicy.js'
import type {ConversationFence} from './conversationRestorationProtocol.js'
export const RETAINED_CONTEXT_AUTHORITY_SCHEMA='retained-context-authority-check/1'
/** Authenticated phone observation only; never a restoration/execution proof. */
export function retainedContextInspection(raw:unknown,f:ConversationFence,now:number){
 recoveryExact(raw,['schema','unit','commandId','deviceId','profileId','originalBindingId','inspectionBindingId','anchorSha256','contextCapturedAt','anchorCapturedAt','observedAt','sourceSha256','promptSha256','replySha256','originalConversationMatched','currentProfile','cachedSourceVerified','exactOriginalView','authorityVerified','contextPortable','resendAllowed','executable'])
 const r=raw,c=f.context
 recoveryUnitKey(r.unit)
 if(new TextEncoder().encode(canonicalJson(r)).length>8000||r.schema!=='retained-conversation-inspection/1'||recoveryUnitKey(r.unit)!==recoveryUnitKey(f.unit)||r.commandId!==f.commandId||r.deviceId!==f.deviceId||r.profileId!==f.profileId||r.originalBindingId!==c.bindingId||!recoveryId(r.inspectionBindingId)||r.inspectionBindingId===r.originalBindingId||r.anchorSha256!==f.anchorSha256||!recoveryHash(r.anchorSha256)||r.contextCapturedAt!==c.capturedAt||r.sourceSha256!==c.sourceSha256||r.promptSha256!==c.promptSha256||r.replySha256!==c.replySha256)throw new TaskConflict('Exact retained original context observation required')
 if(![r.contextCapturedAt,r.anchorCapturedAt,r.observedAt].every(v=>Number.isSafeInteger(v)&&v>0)||r.contextCapturedAt>r.anchorCapturedAt||r.anchorCapturedAt>r.observedAt||r.observedAt>now||now-r.observedAt>=120000)throw new TaskConflict('Fresh retained context observation required')
 if(['originalConversationMatched','currentProfile','cachedSourceVerified'].some(k=>r[k]!==true)||['exactOriginalView','authorityVerified','contextPortable','resendAllowed','executable'].some(k=>r[k]!==false))throw new TaskConflict('Retained context observation grants no authority or browser action')
 return structuredClone(r)
}

export const RETAINED_TARGET_READINESS_SCHEMA='retained-target-readiness/1'
/** Same owner/profile only. Cross-account/provider portability needs separate authority. */
export function retainedContextTarget(raw:unknown,f:ConversationFence,inspection:ReturnType<typeof retainedContextInspection>){
 recoveryExact(raw,['deviceId','profileId','accountId','bindingId','policyRevision','accountObservationAt','configuration'])
 if(new TextEncoder().encode(canonicalJson(raw)).length>5000||raw.deviceId!==f.deviceId||raw.profileId!==f.profileId||raw.accountId!==f.context.accountId||raw.bindingId!==inspection.inspectionBindingId||raw.policyRevision!==f.context.policyRevision||!Number.isSafeInteger(raw.accountObservationAt)||raw.accountObservationAt<inspection.observedAt||!raw.configuration||typeof raw.configuration!=='object'||Array.isArray(raw.configuration))throw new TaskConflict('Exact same-owner target and independently current account observation required')
 return structuredClone(raw)
}
