import {TaskConflict} from './managedTaskProtocol.js'
import {parseSavedImportFence,recoveryExact,recoveryId,type SavedImportFence,type SavedImportAction} from './managedSavedImportRecoveryProtocol.js'
export const SAVED_UPLOAD_SCHEMA='saved-crop-upload-recovery/1'
export interface SavedUploadFence extends SavedImportFence {commandId:string;checkpointRef:string}
export interface SavedUploadRecord {schema:typeof SAVED_UPLOAD_SCHEMA;fence:SavedUploadFence;revision:number;enabled:boolean;paused:boolean;cancelled:boolean;nextEligibleAt:number;actions:SavedImportAction[]}
export function parseSavedUploadFence(raw:unknown):SavedUploadFence {
 recoveryExact(raw,['workspaceId','taskId','attemptId','generation','fingerprint','artifactId','sha256','commandId','checkpointRef'])
 const {commandId,checkpointRef,...f}=raw;parseSavedImportFence(f)
 if(!recoveryId(commandId)||typeof checkpointRef!=='string'||!/^checkpoint\/[A-Za-z0-9_./:-]{1,240}$/.test(checkpointRef)||checkpointRef.includes('://'))throw new TaskConflict('Exact original saved checkpoint and command required')
 return structuredClone(raw) as SavedUploadFence
}
export function parseSavedUploadRecord(raw:unknown):SavedUploadRecord {
 recoveryExact(raw,['schema','fence','revision','enabled','paused','cancelled','nextEligibleAt','actions']);parseSavedUploadFence(raw.fence)
 const time=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0
 if(raw.schema!==SAVED_UPLOAD_SCHEMA||!Number.isSafeInteger(raw.revision)||raw.revision<1||![raw.enabled,raw.paused,raw.cancelled].every(x=>typeof x==='boolean')||!time(raw.nextEligibleAt)||!Array.isArray(raw.actions)||raw.actions.length>3)throw new TaskConflict('Invalid retained saved upload recovery')
 const ids=new Set<string>()
 for(const [i,a] of raw.actions.entries()){
  recoveryExact(a,['id','phase','at','finishedAt','evidenceRef'])
  if(!recoveryId(a.id)||ids.has(a.id)||!['reserved','executing','unknown','safe_failure','verified'].includes(a.phase)||!time(a.at)||i<raw.actions.length-1&&a.phase!=='safe_failure')throw new TaskConflict('Invalid saved upload recovery history')
  ids.add(a.id)
  if(['reserved','executing'].includes(a.phase)?a.finishedAt!==null||a.evidenceRef!==null:!time(a.finishedAt)||a.finishedAt<a.at||typeof a.evidenceRef!=='string'||!/^(artifact\/[a-f0-9]{64}|evidence\/[A-Za-z0-9_-]{1,128})$/.test(a.evidenceRef))throw new TaskConflict('Invalid saved upload outcome')
 }
 return structuredClone(raw) as SavedUploadRecord
}
