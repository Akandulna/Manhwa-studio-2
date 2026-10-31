import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
export const SAVED_IMPORT_SCHEMA='saved-crop-import-recovery/1'
export interface SavedImportFence {workspaceId:string;taskId:string;attemptId:string;generation:number;fingerprint:string;artifactId:string;sha256:string}
export interface SavedImportAction {id:string;phase:'reserved'|'executing'|'safe_failure'|'unknown'|'verified';at:number;finishedAt:number|null;evidenceRef:string|null}
export interface SavedImportRecord {schema:typeof SAVED_IMPORT_SCHEMA;fence:SavedImportFence;destinationId:string;revision:number;enabled:boolean;paused:boolean;cancelled:boolean;nextEligibleAt:number;actions:SavedImportAction[]}
export const recoveryId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v)
export const recoveryHash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
export function recoveryExact(v:unknown,keys:string[]):asserts v is Record<string,any>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))throw new TaskConflict('Exact recovery fields required')}
export function parseSavedImportFence(v:unknown):SavedImportFence {
 recoveryExact(v,['workspaceId','taskId','attemptId','generation','fingerprint','artifactId','sha256'])
 if(!recoveryId(v.workspaceId)||!recoveryId(v.attemptId)||!recoveryId(v.artifactId)||!Number.isSafeInteger(v.generation)||v.generation<1||typeof v.taskId!=='string'||!/^task:sha256:[a-f0-9]{64}$/.test(v.taskId)||!recoveryHash(v.fingerprint)||!recoveryHash(v.sha256))throw new TaskConflict('Exact saved import fence required')
 return {...v} as SavedImportFence
}
// Resource/artifact/destination changes cannot create another budget for the same authoritative unit.
export const savedImportKey=(f:Pick<SavedImportFence,'workspaceId'|'taskId'|'attemptId'|'generation'|'fingerprint'>)=>canonicalJson([f.workspaceId,f.taskId,f.attemptId,f.generation,f.fingerprint])
export function parseSavedImportRecord(v:unknown):SavedImportRecord{
 recoveryExact(v,['schema','fence','destinationId','revision','enabled','paused','cancelled','nextEligibleAt','actions'])
 parseSavedImportFence(v.fence)
 const time=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0
 if(v.schema!==SAVED_IMPORT_SCHEMA||!recoveryHash(v.destinationId)||!Number.isSafeInteger(v.revision)||v.revision<1||![v.enabled,v.paused,v.cancelled].every(n=>typeof n==='boolean')||!time(v.nextEligibleAt)||!Array.isArray(v.actions)||v.actions.length>3)throw new TaskConflict('Invalid retained recovery state; reconcile without replacing it')
 const seen=new Set<string>()
 for(const [index,a] of v.actions.entries()){
  recoveryExact(a,['id','phase','at','finishedAt','evidenceRef'])
  if(!recoveryId(a.id)||seen.has(a.id)||!['reserved','executing','safe_failure','unknown','verified'].includes(a.phase)||!time(a.at))throw new TaskConflict('Invalid retained recovery action')
  seen.add(a.id)
  if(index<v.actions.length-1&&a.phase!=='safe_failure')throw new TaskConflict('Unresolved recovery history cannot be replaced')
  const pending=['reserved','executing'].includes(a.phase)
  if(pending?(a.finishedAt!==null||a.evidenceRef!==null):(!time(a.finishedAt)||a.finishedAt<a.at||typeof a.evidenceRef!=='string'||!/^(validation\/[a-f0-9]{64}|evidence\/[A-Za-z0-9_-]{1,128})$/.test(a.evidenceRef)))throw new TaskConflict('Invalid retained recovery outcome')
 }
 return structuredClone(v) as SavedImportRecord
}
