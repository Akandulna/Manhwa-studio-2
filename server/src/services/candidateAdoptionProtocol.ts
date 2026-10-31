import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {recoveryUnitKey,parseRecoveryBudget,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {fallbackTargets,type FallbackTarget} from './fallbackPreflightProtocol.js'
import {parseContextReceipt,parseContextProof} from './targetContextProtocol.js'
export const CANDIDATE_ADOPTION_SCHEMA='managed-candidate-adoption/1'
export const CANDIDATE_ADOPTION_CAPABILITY='target-candidate-retention/1'
export const ADOPTION_CONFIRMATION='Approve retention of this exact candidate only; no ownership transfer, browser adoption, upload or prompt is authorized.'
export const adoptionPermissions={executionAllowed:false,handoffAllowed:false,resendAllowed:false,viewAdoptionAllowed:false,ownershipChanged:false} as const
export interface AdoptionAction {id:string;context:any;at:number;expiresAt:number;phase:'reserved'|'executing'|'unknown'|'verified'|'safe_failure';startEventId:string|null;startedAt:number|null;before:any|null;permit:any|null;unknownAt:number|null;finishedAt:number|null;receipt:any|null}
export interface AdoptionRecord {schema:typeof CANDIDATE_ADOPTION_SCHEMA;fence:{unit:RecoveryUnit};revision:number;enabled:boolean;paused:boolean;cancelled:boolean;nextEligibleAt:number;actions:AdoptionAction[]}
const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0
export function parseAdoptionPermit(raw:unknown,a:AdoptionAction,now=Date.now()){
 recoveryExact(raw,['schema','actionId','contextId','packageId','reviewId','unit','target','bindingId','sourceSha256','manifestSha256','promptSha256','issuedAt','validUntil','localCandidateAdoptionAllowed','executionAllowed','handoffAllowed','resendAllowed','viewAdoptionAllowed','ownershipChanged'])
 const c=a.context
 if(raw.schema!=='candidate-adoption-effect-permit/1'||raw.actionId!==a.id||raw.contextId!==c.id||raw.packageId!==c.packageId||raw.reviewId!==c.reviewId||recoveryUnitKey(raw.unit)!==recoveryUnitKey(c.unit)||canonicalJson(raw.target)!==canonicalJson(c.target)||raw.bindingId!==c.bindingId||raw.sourceSha256!==c.source.sha256||raw.manifestSha256!==c.manifestSha256||raw.promptSha256!==c.promptSha256||![raw.issuedAt,raw.validUntil].every(positive)||raw.issuedAt<a.at||a.startedAt!==null&&raw.issuedAt<a.startedAt||raw.issuedAt>now||raw.validUntil<=now||raw.validUntil>raw.issuedAt+15000||raw.validUntil>a.expiresAt||raw.localCandidateAdoptionAllowed!==true||Object.keys(adoptionPermissions).some(k=>raw[k]!==false))throw new TaskConflict('Exact short-lived local retention permit required')
 return structuredClone(raw)
}
export function parseLocalAdoptionReceipt(raw:unknown,a:AdoptionAction,now=Date.now()){
 recoveryExact(raw,['schema','actionId','contextId','packageId','reviewId','bindingId','sourceSha256','manifestSha256','promptSha256','adoptedAt','permitIssuedAt','permitValidUntil'])
 const c=a.context,p=a.permit
 if(!p||raw.schema!=='candidate-adoption-local-receipt/1'||raw.actionId!==a.id||raw.contextId!==c.id||raw.packageId!==c.packageId||raw.reviewId!==c.reviewId||raw.bindingId!==c.bindingId||raw.sourceSha256!==c.source.sha256||raw.manifestSha256!==c.manifestSha256||raw.promptSha256!==c.promptSha256||raw.permitIssuedAt!==p.issuedAt||raw.permitValidUntil!==p.validUntil||!positive(raw.adoptedAt)||raw.adoptedAt<p.issuedAt||raw.adoptedAt>=p.validUntil||raw.adoptedAt>now)throw new TaskConflict('Original exact native candidate retention receipt required')
 return structuredClone(raw)
}
export function parseAdoptionRecord(raw:unknown):AdoptionRecord {
 recoveryExact(raw,['schema','fence','revision','enabled','paused','cancelled','nextEligibleAt','actions']);recoveryExact(raw.fence,['unit']);recoveryUnitKey(raw.fence.unit)
 if(raw.schema!==CANDIDATE_ADOPTION_SCHEMA||!positive(raw.revision)||![raw.enabled,raw.paused,raw.cancelled].every(v=>typeof v==='boolean')||!Number.isSafeInteger(raw.nextEligibleAt)||raw.nextEligibleAt<0||!Array.isArray(raw.actions)||raw.actions.length<1||raw.actions.length>3)throw new TaskConflict('Bounded retained candidate adoption ledger required')
 const ids=new Set<string>()
 for(const a of raw.actions){
  recoveryExact(a,['id','context','at','expiresAt','phase','startEventId','startedAt','before','permit','unknownAt','finishedAt','receipt'])
  if(!recoveryId(a.id)||ids.has(a.id)||!positive(a.at)||!positive(a.expiresAt)||a.expiresAt<=a.at||a.expiresAt>a.at+120000||!['reserved','executing','unknown','verified','safe_failure'].includes(a.phase))throw new TaskConflict('Invalid original candidate adoption action');ids.add(a.id)
  parseContextReceipt(a.context,raw.fence.unit,a.context?.target,a.context?.receivedAt)
  if(a.context.validUntil<=a.at||a.context.receivedAt>a.at)throw new TaskConflict('Adoption approval must use fresh original context')
  const started=['executing','unknown','verified'].includes(a.phase)
  if(started){if(!recoveryId(a.startEventId)||!positive(a.startedAt)||a.startedAt<a.at||!a.before)throw new TaskConflict('Original one-use retention start required');parseContextProof(a.before);if(a.permit)parseAdoptionPermit(a.permit,a as unknown as AdoptionAction,a.permit.issuedAt);if(a.before.id!==a.context.id||a.before.bindingId!==a.context.bindingId||a.before.packageId!==a.context.packageId||a.before.reviewId!==a.context.reviewId||a.before.sourceSha256!==a.context.source.sha256||a.before.manifestSha256!==a.context.manifestSha256||a.before.promptSha256!==a.context.promptSha256||a.before.observedAt<a.at||a.before.observedAt>a.startedAt||a.before.accountObservationAt<a.at)throw new TaskConflict('Original retention start proof mismatch')}
  else if(a.startEventId!==null||a.startedAt!==null||a.before!==null||a.permit!==null)throw new TaskConflict('Unstarted approval cannot contain an effect permit')
  if(a.unknownAt!==null&&(!positive(a.unknownAt)||a.unknownAt<a.at||a.startedAt!==null&&a.unknownAt<a.startedAt||a.finishedAt!==null&&a.unknownAt>a.finishedAt||!['unknown','verified'].includes(a.phase))||a.phase==='unknown'&&a.unknownAt===null)throw new TaskConflict('Original unknown retention history required')
  if(['verified','safe_failure'].includes(a.phase)){if(!positive(a.finishedAt)||a.finishedAt<a.at)throw new TaskConflict('Original terminal retention time required')}else if(a.finishedAt!==null)throw new TaskConflict('Pending retention cannot be marked complete')
  if(a.phase==='verified'){parseLocalAdoptionReceipt(a.receipt,a as unknown as AdoptionAction,a.finishedAt);if(a.finishedAt<a.receipt.adoptedAt)throw new TaskConflict('Retention receipt timeline mismatch')}else if(a.receipt!==null)throw new TaskConflict('Only verified retention has a native receipt')
 }
 if(raw.actions.slice(0,-1).some((a:any)=>['reserved','executing','unknown'].includes(a.phase)))throw new TaskConflict('Original retention action still needs reconciliation')
 return structuredClone(raw) as AdoptionRecord
}
export function parseAdoptionStatus(raw:unknown,unit:RecoveryUnit,target:FallbackTarget,now=Date.now()){
 recoveryExact(raw,['schema','unit','target','checkedAt','globalEnabled','revision','actions','budget','executionAllowed','handoffAllowed','resendAllowed','viewAdoptionAllowed','ownershipChanged'])
 recoveryUnitKey(raw.unit);fallbackTargets([raw.target])
 if(raw.schema!==CANDIDATE_ADOPTION_SCHEMA||recoveryUnitKey(raw.unit)!==recoveryUnitKey(unit)||canonicalJson(raw.target)!==canonicalJson(target)||!positive(raw.checkedAt)||raw.checkedAt>now||now-raw.checkedAt>=15000||typeof raw.globalEnabled!=='boolean'||!Number.isSafeInteger(raw.revision)||raw.revision<0||raw.revision<(raw.actions?.length??0)||!Array.isArray(raw.actions)||raw.actions.length>3||Object.keys(adoptionPermissions).some(k=>raw[k]!==false))throw new TaskConflict('Exact candidate retention status required')
 parseRecoveryBudget(raw.budget);if(raw.actions.length>raw.budget.used)throw new TaskConflict('Retention status exceeds shared budget')
 if(raw.actions.length){parseAdoptionRecord({schema:CANDIDATE_ADOPTION_SCHEMA,fence:{unit},revision:Math.max(1,raw.revision),enabled:true,paused:false,cancelled:false,nextEligibleAt:0,actions:raw.actions});if(raw.actions.some((a:any)=>canonicalJson(a.context.target)!==canonicalJson(target)))throw new TaskConflict('Foreign candidate retention action')}
 return structuredClone(raw)
}

export function parseAdoptionOperation(raw:unknown,unit:RecoveryUnit,target:FallbackTarget,id:string){
 recoveryExact(raw,['action','globalEnabled','executionAllowed','handoffAllowed','resendAllowed','viewAdoptionAllowed','ownershipChanged'])
 if(typeof raw.globalEnabled!=='boolean'||Object.keys(adoptionPermissions).some(k=>raw[k]!==false))throw new TaskConflict('Candidate retention response grants no execution')
 const record=parseAdoptionRecord({schema:CANDIDATE_ADOPTION_SCHEMA,fence:{unit},revision:1,enabled:true,paused:false,cancelled:false,nextEligibleAt:0,actions:[raw.action]})
 if(record.actions[0].id!==id||canonicalJson(record.actions[0].context.target)!==canonicalJson(target))throw new TaskConflict('Original candidate approval response mismatch')
 return structuredClone(raw)
}
