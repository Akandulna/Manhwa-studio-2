import {TaskConflict} from './managedTaskProtocol.js'
export interface LocalManagedAttempt {taskId:string;attemptId:string;generation:number;fingerprint:string;phase:string;submission:'unsent'|'unknown'|'submitted'|'saved';checkpointRef:string|null}
/** Read-only inventory. It never grants a lease, adopts bytes or clears a local hold. */
export function parseManagedReconnect(value:unknown,workspace:string):LocalManagedAttempt[] {
 const raw=value as any
 if(!raw||Object.keys(raw).sort().join(',')!=='attempts,schema,workspaceId'||raw.schema!=='managed-reconnect/1'||raw.workspaceId!==workspace||!Array.isArray(raw.attempts)||raw.attempts.length>8)throw new TaskConflict('Bounded current-workspace reconnect inventory required')
 const seen=new Set<string>()
 for(const item of raw.attempts) {
  if(!item||Object.keys(item).sort().join(',')!=='attemptId,checkpointRef,fingerprint,generation,phase,submission,taskId'||!/^task:sha256:[a-f0-9]{64}$/.test(item.taskId)||!/^[A-Za-z0-9_-]{1,128}$/.test(item.attemptId)||!/^[a-f0-9]{64}$/.test(item.fingerprint)||!Number.isSafeInteger(item.generation)||item.generation<1||!['assigned','accepted','started','submission_intent','submitted','result_saved','stop_requested','stop_confirmed','published'].includes(item.phase)||!['unsent','unknown','submitted','saved'].includes(item.submission)||!(item.checkpointRef===null||typeof item.checkpointRef==='string'&&/^checkpoint\/[A-Za-z0-9_-]{1,128}$/.test(item.checkpointRef))||seen.has(item.attemptId))throw new TaskConflict('Invalid or duplicate local attempt inventory')
  seen.add(item.attemptId)
 }
 return structuredClone(raw.attempts)
}
