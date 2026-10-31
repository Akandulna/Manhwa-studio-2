import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {parseRecoveryBudget,recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {parseContextProof} from './targetContextProtocol.js'
import {parseAdoptionRecord,type AdoptionAction} from './candidateAdoptionProtocol.js'
export const ACCOUNT_HANDOFF_SCHEMA='managed-account-handoff/1'
export const ACCOUNT_HANDOFF_CAPABILITY='retained-candidate-handoff/1'
export const HANDOFF_CONFIRMATION='Approve transfer of this exact retained candidate to the confirmed independent account and one managed execution on its original inspected target view.'
export const PRODUCTION_CANDIDATE_HANDOFF_CAPABILITY='production-candidate-handoff/1'
export interface ProductionCandidateHandoff {jobId:string;claimEventId:string;newClaimEventId:string}
export function parseProductionCandidateHandoff(raw:unknown):ProductionCandidateHandoff {
 recoveryExact(raw,['jobId','claimEventId','newClaimEventId'])
 if(![raw.jobId,raw.claimEventId,raw.newClaimEventId].every(recoveryId)||raw.claimEventId===raw.newClaimEventId)throw new TaskConflict('Exact immutable production handoff identities required')
 return structuredClone(raw) as ProductionCandidateHandoff
}
export interface HandoffAction {id:string;candidate:AdoptionAction;at:number;expiresAt:number;phase:'reserved'|'prepared'|'executing'|'verified'|'safe_failure';production?:ProductionCandidateHandoff;proof:any|null;result:any|null;finishedAt:number|null}
export interface HandoffRecord {schema:typeof ACCOUNT_HANDOFF_SCHEMA;fence:{unit:RecoveryUnit};revision:number;enabled:boolean;paused:boolean;cancelled:boolean;nextEligibleAt:number;actions:HandoffAction[]}
export function parseHandoffRecord(raw:unknown):HandoffRecord {
 recoveryExact(raw,['schema','fence','revision','enabled','paused','cancelled','nextEligibleAt','actions']);recoveryExact(raw.fence,['unit']);recoveryUnitKey(raw.fence.unit)
 if(raw.schema!==ACCOUNT_HANDOFF_SCHEMA||!Number.isSafeInteger(raw.revision)||raw.revision<1||![raw.enabled,raw.paused,raw.cancelled].every(v=>typeof v==='boolean')||!Number.isSafeInteger(raw.nextEligibleAt)||raw.nextEligibleAt<0||!Array.isArray(raw.actions)||raw.actions.length<1||raw.actions.length>3)throw new TaskConflict('Bounded original handoff ledger required')
 const ids=new Set<string>()
 for(const a of raw.actions){
  recoveryExact(a,['id','candidate','at','expiresAt','phase','proof','result','finishedAt',...(a.production!==undefined?['production']:[])])
  if(a.production!==undefined)parseProductionCandidateHandoff(a.production)
  if(!recoveryId(a.id)||ids.has(a.id)||!Number.isSafeInteger(a.at)||a.at<=0||!Number.isSafeInteger(a.expiresAt)||a.expiresAt<=a.at||a.expiresAt>a.at+120000||!['reserved','prepared','executing','verified','safe_failure'].includes(a.phase))throw new TaskConflict('Exact handoff action required');ids.add(a.id)
  parseAdoptionRecord({schema:'managed-candidate-adoption/1',fence:raw.fence,revision:1,enabled:true,paused:false,cancelled:false,nextEligibleAt:0,actions:[a.candidate]})
  if(a.candidate.phase!=='verified'||a.candidate.finishedAt>a.at)throw new TaskConflict('Acknowledged original candidate required')
  if(a.proof!==null){
   const p=parseContextProof(a.proof),c=a.candidate.context
   if(p.id!==c.id||p.reviewId!==c.reviewId||p.packageId!==c.packageId||p.bindingId!==c.bindingId||p.sourceSha256!==c.source.sha256||p.manifestSha256!==c.manifestSha256||p.promptSha256!==c.promptSha256||p.observedAt<a.at||p.observedAt>=a.expiresAt||p.accountObservationAt<a.at||a.finishedAt!==null&&p.observedAt>a.finishedAt)throw new TaskConflict('Immutable exact candidate handoff proof required')
  }
  if(a.phase==='prepared'&&(!a.production||a.proof===null)||a.phase==='reserved'&&a.proof!==null)throw new TaskConflict('Only production handoff can prepare a target proof')
  if(a.phase==='verified'){
   const r=a.result,c=a.candidate.context
   if(!r||r.task.id!==raw.fence.unit.taskId||r.task.fingerprint!==raw.fence.unit.fingerprint||r.task.attemptId!==r.attempt.id||r.task.generation!==raw.fence.unit.generation+1||r.attempt.generation!==r.task.generation||r.attempt.deviceId!==c.target.deviceId||r.attempt.profileId!==c.target.profileId||r.attempt.accountId!==c.accountId||r.attempt.activeCommandId!==r.command.id||r.command.attemptId!==r.attempt.id||r.command.taskId!==r.task.id||r.command.fingerprint!==r.task.fingerprint||r.command.action!=='start'||r.command.handoff?.actionId!==a.id||canonicalJson(r.command.handoff.context)!==canonicalJson(c)||!a.proof||!Number.isSafeInteger(a.finishedAt)||a.finishedAt<a.at)throw new TaskConflict('Exact atomic handoff result required')
  }else if(a.result!==null||a.proof!==null&&!a.production||a.phase==='safe_failure'&&(!Number.isSafeInteger(a.finishedAt)||a.finishedAt<a.at)||a.phase!=='safe_failure'&&a.finishedAt!==null)throw new TaskConflict('Uncommitted handoff cannot claim a successor')
 }
 if(raw.actions.slice(0,-1).some((a:any)=>['reserved','prepared','executing'].includes(a.phase)))throw new TaskConflict('Original handoff remains pending')
 return structuredClone(raw) as HandoffRecord
}

export function parseHandoffStatus(raw:unknown,unit:RecoveryUnit,now=Date.now()){
 recoveryExact(raw,['schema','unit','checkedAt','globalEnabled','revision','actions','budget'])
 if(raw.schema!==ACCOUNT_HANDOFF_SCHEMA||recoveryUnitKey(raw.unit)!==recoveryUnitKey(unit)||!Number.isSafeInteger(raw.checkedAt)||raw.checkedAt<=0||raw.checkedAt>now||now-raw.checkedAt>=15000||typeof raw.globalEnabled!=='boolean'||!Number.isSafeInteger(raw.revision)||raw.revision<0||!Array.isArray(raw.actions)||raw.actions.length>3)throw new TaskConflict('Fresh exact handoff status required')
 parseRecoveryBudget(raw.budget)
 if(raw.actions.length){parseHandoffRecord({schema:ACCOUNT_HANDOFF_SCHEMA,fence:{unit},revision:Math.max(1,raw.revision),enabled:true,paused:false,cancelled:false,nextEligibleAt:0,actions:raw.actions});if(raw.actions.length>raw.budget.used)throw new TaskConflict('Original handoff budget mismatch')}
 return structuredClone(raw)
}
