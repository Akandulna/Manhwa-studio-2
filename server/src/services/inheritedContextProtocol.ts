import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryExact,recoveryId,recoveryHash} from './managedSavedImportRecoveryProtocol.js'
import {recoveryUnitKey} from './automationRecoveryPolicy.js'
import {fallbackTargets} from './fallbackPreflightProtocol.js'
export const INHERITED_CONTEXT_SCHEMA='managed-inherited-context-review/1'
export const INHERITED_CONFIRMATION='I reviewed every required earlier message and external rule for this original task. This exact ordered text inventory is complete; hidden state, non-text attachments and provider settings remain unsupported.'
export const inheritedPermissions={executionAllowed:false,handoffAllowed:false,resendAllowed:false,viewAdoptionAllowed:false,portableInputVerified:false,requiredContextVerified:false,ownershipChanged:false,budgetReset:false} as const
export interface ContextEntry {id:string;kind:'user_message'|'assistant_message'|'external_rule';sourceId:string;revision:string;sha256:string;bytes:number}
export function contextBinding(raw:unknown){
 recoveryExact(raw,['unit','target','accountId','policyRevision','packageId','sourceSha256','manifestSha256','promptSha256']);recoveryUnitKey(raw.unit);fallbackTargets([raw.target])
 if(!recoveryId(raw.unit.workspaceId)||!recoveryId(raw.unit.attemptId)||!recoveryId(raw.accountId)||!recoveryId(raw.packageId)||!Number.isSafeInteger(raw.policyRevision)||raw.policyRevision<=0||![raw.sourceSha256,raw.manifestSha256,raw.promptSha256].every(recoveryHash))throw new TaskConflict('Exact inherited context binding required')
 return structuredClone(raw)
}
export function contextInventory(raw:unknown):ContextEntry[]{
 if(!Array.isArray(raw)||raw.length<1||raw.length>64)throw new TaskConflict('Bounded complete required text inventory required')
 const seen=new Set<string>();let total=0
 for(const e of raw){
  recoveryExact(e,['id','kind','sourceId','revision','sha256','bytes'])
  if(![e.id,e.sourceId,e.revision].every(recoveryId)||seen.has(e.id)||!['user_message','assistant_message','external_rule'].includes(e.kind)||!recoveryHash(e.sha256)||!Number.isSafeInteger(e.bytes)||e.bytes<1||e.bytes>64000)throw new TaskConflict('Exact original text entry identity required')
  seen.add(e.id);total+=e.bytes
 }
 if(total>256000)throw new TaskConflict('Required text exceeds bounds; retain all original entries')
 return structuredClone(raw)
}
export function parseInheritedRequest(raw:unknown){
 recoveryExact(raw,['id','binding','packetId','requiredEntries','supersedesId','confirmation']);contextBinding(raw.binding);contextInventory(raw.requiredEntries)
 if(!recoveryId(raw.id)||typeof raw.packetId!=='string'||!/^context_[a-f0-9]{64}$/.test(raw.packetId)||!(raw.supersedesId===null||recoveryId(raw.supersedesId))||raw.id===raw.supersedesId||raw.confirmation!==INHERITED_CONFIRMATION)throw new TaskConflict('Explicit original packet requirements review required')
 return structuredClone(raw)
}
export function parseInheritedReview(raw:unknown){
 recoveryExact(raw,['schema','request','reviewedAt','withdrawnAt',...Object.keys(inheritedPermissions)]);parseInheritedRequest(raw.request)
 if(raw.schema!==INHERITED_CONTEXT_SCHEMA||!Number.isSafeInteger(raw.reviewedAt)||raw.reviewedAt<=0||!(raw.withdrawnAt===null||Number.isSafeInteger(raw.withdrawnAt)&&raw.withdrawnAt>=raw.reviewedAt)||Object.keys(inheritedPermissions).some(k=>raw[k]!==false))throw new TaskConflict('Retained requirements receipt required; no execution authority')
 return structuredClone(raw)
}
export function parseInheritedStatus(raw:unknown,binding:unknown,now=Date.now()){
 recoveryExact(raw,['schema','binding','checkedAt','state','review',...Object.keys(inheritedPermissions)]);contextBinding(raw.binding);contextBinding(binding)
 if(raw.schema!==INHERITED_CONTEXT_SCHEMA||canonicalJson(raw.binding)!==canonicalJson(binding)||!Number.isSafeInteger(raw.checkedAt)||raw.checkedAt<=0||raw.checkedAt>now||now-raw.checkedAt>=15000||!['unreviewed','reviewed_text_only','withdrawn','blocked','candidate_changed'].includes(raw.state)||Object.keys(inheritedPermissions).some(k=>raw[k]!==false))throw new TaskConflict('Current inherited requirements status required')
 if(raw.review!==null){const r=parseInheritedReview(raw.review);if(r.reviewedAt>raw.checkedAt||r.withdrawnAt!==null&&r.withdrawnAt>raw.checkedAt||recoveryUnitKey(r.request.binding.unit)!==recoveryUnitKey(raw.binding.unit)||canonicalJson(r.request.binding.target)!==canonicalJson(raw.binding.target))throw new TaskConflict('Uncorrelated inherited requirements')}
 if(raw.state==='unreviewed'&&raw.review!==null||raw.state!=='unreviewed'&&raw.review===null||raw.state==='withdrawn'&&raw.review.withdrawnAt===null||raw.state==='reviewed_text_only'&&(raw.review.withdrawnAt!==null||canonicalJson(raw.review.request.binding)!==canonicalJson(binding)))throw new TaskConflict('Requirements state contradicts original review')
 return structuredClone(raw)
}
