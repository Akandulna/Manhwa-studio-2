import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {recoveryExact,recoveryHash,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {parseSavedUploadFence} from './managedSavedUploadRecoveryProtocol.js'
import {parseNavigationFence} from './unsentNavigationProtocol.js'
import {parseUiRepairFence} from './knownUiRepairProtocol.js'
import {parseCorrectionFence} from './correctionRecoveryProtocol.js'
import {parseConversationFence} from './conversationRestorationProtocol.js'
export const DISPATCH_SCHEMA='original-recovery-dispatch/1'
export const DISPATCH_KINDS=['saved_upload','navigate','known_ui','correct_output','restore_conversation'] as const
export type DispatchKind=typeof DISPATCH_KINDS[number]
export interface DispatchTicket {schema:typeof DISPATCH_SCHEMA;id:string;unit:RecoveryUnit;kind:DispatchKind;actionId:string;commandId:string;deviceId:string;profileId:string;fence:any;fenceSha256:string;grantRevision:number;revision:number;queuedAt:number;expiresAt:number;phase:'queued'|'claimed'|'consumed'|'held'|'cancelled';claimId:string|null;finishedAt:number|null}
export function dispatchFence(kind:DispatchKind,raw:unknown){
 const f=kind==='saved_upload'?parseSavedUploadFence(raw):kind==='navigate'?parseNavigationFence(raw):kind==='known_ui'?parseUiRepairFence(raw):kind==='correct_output'?parseCorrectionFence(raw):kind==='restore_conversation'?parseConversationFence(raw):null
 if(!f)throw new TaskConflict('Supported original-phone recovery kind required')
 const unit='unit'in f?f.unit:{workspaceId:f.workspaceId,taskId:f.taskId,attemptId:f.attemptId,generation:f.generation,fingerprint:f.fingerprint}
 return {fence:f,unit,commandId:f.commandId}
}
export function parseDispatchTicket(raw:unknown):DispatchTicket {
 recoveryExact(raw,['schema','id','unit','kind','actionId','commandId','deviceId','profileId','fence','fenceSha256','grantRevision','revision','queuedAt','expiresAt','phase','claimId','finishedAt']);recoveryUnitKey(raw.unit)
 if(raw.schema!==DISPATCH_SCHEMA||!DISPATCH_KINDS.includes(raw.kind)||![raw.id,raw.actionId,raw.commandId,raw.deviceId,raw.profileId].every(recoveryId)||!recoveryHash(raw.fenceSha256)||![raw.grantRevision,raw.revision].every(v=>Number.isSafeInteger(v)&&v>0)||!Number.isSafeInteger(raw.queuedAt)||raw.queuedAt<=0||!Number.isSafeInteger(raw.expiresAt)||raw.expiresAt<=raw.queuedAt||raw.expiresAt-raw.queuedAt>120000||!['queued','claimed','consumed','held','cancelled'].includes(raw.phase))throw new TaskConflict('Exact bounded original dispatch ticket required')
 const f=dispatchFence(raw.kind,raw.fence)
 if(recoveryUnitKey(f.unit)!==recoveryUnitKey(raw.unit)||f.commandId!==raw.commandId||'deviceId'in f.fence&&(f.fence.deviceId!==raw.deviceId||f.fence.profileId!==raw.profileId))throw new TaskConflict('Original dispatch fence/owner mismatch')
 if(raw.phase==='queued'?(raw.claimId!==null||raw.finishedAt!==null):raw.phase==='claimed'?(!recoveryId(raw.claimId)||raw.finishedAt!==null):(!Number.isSafeInteger(raw.finishedAt)||raw.finishedAt<raw.queuedAt||raw.phase!=='cancelled'&&!recoveryId(raw.claimId)||raw.phase==='cancelled'&&raw.claimId!==null&&!recoveryId(raw.claimId)))throw new TaskConflict('Retained delivery phase and original claim disagree')
 return structuredClone(raw) as DispatchTicket
}
export const sameDispatch=(a:DispatchTicket,b:DispatchTicket)=>canonicalJson({...a,phase:null,revision:0,claimId:null,finishedAt:null})===canonicalJson({...b,phase:null,revision:0,claimId:null,finishedAt:null})
