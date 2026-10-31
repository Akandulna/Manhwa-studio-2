import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {recoveryExact,recoveryHash,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {parseCorrectionContext,type CorrectionContextEvidence} from './managedCorrectionContextProtocol.js'
export const CORRECTION_SCHEMA='managed-correction-recovery/1'
export interface CorrectionPreview {schema:'managed-correction-preview/1';originalReplySha256:string;proposalSha256:string;artifactSha256:string;manifestSha256:string;lockedDigest:string;lockedCandidates:number;failedCandidates:number;changedFields:number;changeDigest:string;executable:false;portable:false}
export interface CorrectionFence {unit:RecoveryUnit;commandId:string;deviceId:string;profileId:string;context:CorrectionContextEvidence;preview:CorrectionPreview}
export interface CorrectionAction {id:string;at:number;phase:'reserved'|'executing'|'unknown'|'safe_failure'|'verified';finishedAt:number|null;evidenceRef:string|null;checkpointRef:string|null;eventId:string|null;artifactHash:string|null}
export interface CorrectionRecord {schema:typeof CORRECTION_SCHEMA;fence:CorrectionFence;revision:number;enabled:boolean;paused:boolean;cancelled:boolean;nextEligibleAt:number;actions:CorrectionAction[]}
export function parseCorrectionFence(raw:unknown):CorrectionFence {
 recoveryExact(raw,['unit','commandId','deviceId','profileId','context','preview']);recoveryUnitKey(raw.unit)
 if(![raw.commandId,raw.deviceId,raw.profileId].every(recoveryId))throw new TaskConflict('Original correction owner required')
 const c=parseCorrectionContext(raw.context,{observedAt:raw.context?.capturedAt,failure:'malformed_output',phase:'submitted',outcome:'submitted'}),p=raw.preview
 recoveryExact(p,['schema','originalReplySha256','proposalSha256','artifactSha256','manifestSha256','lockedDigest','lockedCandidates','failedCandidates','changedFields','changeDigest','executable','portable'])
 if(c.state!=='scoped'||p.schema!=='managed-correction-preview/1'||![p.originalReplySha256,p.proposalSha256,p.artifactSha256,p.manifestSha256,p.lockedDigest,p.changeDigest].every(recoveryHash)||p.originalReplySha256!==c.replySha256||p.manifestSha256!==c.manifestSha256||p.lockedDigest!==c.lockedDigest||p.lockedCandidates!==c.lockedCandidates||p.failedCandidates!==c.failedCandidates||!Number.isSafeInteger(p.changedFields)||p.changedFields<1||p.changedFields>10000||p.executable!==false||p.portable!==false)throw new TaskConflict('Exact private validated proposal and preserved valid rows required')
 return structuredClone(raw) as CorrectionFence
}
export const sameCorrectionFence=(a:CorrectionFence,b:CorrectionFence)=>canonicalJson(a)===canonicalJson(b)
export function parseCorrectionRecord(raw:unknown):CorrectionRecord {
 recoveryExact(raw,['schema','fence','revision','enabled','paused','cancelled','nextEligibleAt','actions']);parseCorrectionFence(raw.fence)
 if(raw.schema!==CORRECTION_SCHEMA||!Number.isSafeInteger(raw.revision)||raw.revision<1||![raw.enabled,raw.paused,raw.cancelled].every(x=>typeof x==='boolean')||!Number.isSafeInteger(raw.nextEligibleAt)||raw.nextEligibleAt<0||!Array.isArray(raw.actions)||raw.actions.length>3)throw new TaskConflict('Invalid retained correction ledger')
 const ids=new Set<string>()
 for(const [i,a] of raw.actions.entries()){
  recoveryExact(a,['id','at','phase','finishedAt','evidenceRef','checkpointRef','eventId','artifactHash'])
  if(!recoveryId(a.id)||ids.has(a.id)||!Number.isSafeInteger(a.at)||a.at<=0||!['reserved','executing','unknown','safe_failure','verified'].includes(a.phase)||i<raw.actions.length-1&&a.phase!=='safe_failure')throw new TaskConflict('Invalid correction action history')
  ids.add(a.id)
  if(['reserved','executing'].includes(a.phase)?a.finishedAt!==null||a.evidenceRef!==null:!Number.isSafeInteger(a.finishedAt)||a.finishedAt<a.at||a.evidenceRef!=='correction/'+a.id)throw new TaskConflict('Correction receipt state mismatch')
  if(a.phase==='verified'?typeof a.checkpointRef!=='string'||!/^checkpoint\/[A-Za-z0-9_-]{1,128}$/.test(a.checkpointRef)||!recoveryId(a.eventId)||!recoveryHash(a.artifactHash):a.checkpointRef!==null||a.eventId!==null||a.artifactHash!==null)throw new TaskConflict('Exact durable correction checkpoint required')
 }
 return structuredClone(raw) as CorrectionRecord
}
