import {parseCorrectionContext,type CorrectionContextEvidence} from './managedCorrectionContextProtocol.js'
import {parseManagedSessionEvidence,type ManagedSessionEvidence} from './managedSessionEvidenceProtocol.js'
import {TaskConflict} from './managedTaskProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
export const EXECUTOR_EVIDENCE_SCHEMA='managed-executor-evidence/1'
export const EXECUTOR_FAILURES=['generation_quota','upload_allowance','unsupported_attachment','signed_out','missing_control','network_timeout','executor_stopped','malformed_output','cloud_transfer','unknown'] as const
export interface ExecutorEvidence {correctionContext?:CorrectionContextEvidence;session?:ManagedSessionEvidence;schema:typeof EXECUTOR_EVIDENCE_SCHEMA;id:string;unit:RecoveryUnit;commandId:string;deviceId:string;profileId:string;observedAt:number;failure:typeof EXECUTOR_FAILURES[number];outcome:'unsent'|'unknown'|'submitted'|'saved';phase:string;uiChangeId:string|null;uiObservedAt:number|null}
export function parseExecutorEvidence(raw:unknown):ExecutorEvidence{
 recoveryExact(raw,['schema','id','unit','commandId','deviceId','profileId','observedAt','failure','outcome','phase','uiChangeId','uiObservedAt',...(raw&&typeof raw==='object'&&'session' in raw?['session']:[]),...(raw&&typeof raw==='object'&&'correctionContext' in raw?['correctionContext']:[])]);recoveryUnitKey(raw.unit)
 if(raw.schema!==EXECUTOR_EVIDENCE_SCHEMA||![raw.id,raw.commandId,raw.deviceId,raw.profileId].every(recoveryId)||!Number.isSafeInteger(raw.observedAt)||raw.observedAt<=0||!EXECUTOR_FAILURES.includes(raw.failure)||!['unsent','unknown','submitted','saved'].includes(raw.outcome)||!['accepted','started','submission_intent','submitted','result_saved','stop_requested','stop_confirmed'].includes(raw.phase))throw new TaskConflict('Exact typed original-executor evidence required')
 if(raw.uiChangeId===null?raw.uiObservedAt!==null:raw.failure!=='missing_control'||typeof raw.uiChangeId!=='string'||!/^[a-f0-9]{64}$/.test(raw.uiChangeId)||!Number.isSafeInteger(raw.uiObservedAt)||raw.uiObservedAt>raw.observedAt||raw.observedAt-raw.uiObservedAt>=120000)throw new TaskConflict('Recent exact-profile UI incident evidence required')
 if('correctionContext' in raw)parseCorrectionContext(raw.correctionContext,raw as ExecutorEvidence)
 if('session' in raw)parseManagedSessionEvidence(raw.session,raw as ExecutorEvidence)
 return structuredClone(raw) as ExecutorEvidence
}
