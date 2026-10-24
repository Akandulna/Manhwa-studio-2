import {TaskConflict} from './managedTaskProtocol.js'
import {recoveryExact,recoveryHash,recoveryId} from './managedSavedImportRecoveryProtocol.js'
export interface CorrectionContextEvidence {
 schema:'managed-correction-context/1';capturedAt:number;bindingId:string;sourceSha256:string;manifestSha256:string;promptSha256:string;replySha256:string;rawCheckpointRef:string
 accountId:string;policyRevision:number;state:'scoped'|'held';lockedCandidates:number;failedCandidates:number;lockedDigest:string|null;planDigest:string|null
 executable:false;portable:false;liveConversationVerified:false
}
/** Historical private-package provenance only. A scoped draft is never a correction, publication or fallback permit. */
export function parseCorrectionContext(raw:unknown,envelope:{observedAt:number;failure:string;phase:string;outcome:string}):CorrectionContextEvidence {
 recoveryExact(raw,['schema','capturedAt','bindingId','sourceSha256','manifestSha256','promptSha256','replySha256','rawCheckpointRef','accountId','policyRevision','state','lockedCandidates','failedCandidates','lockedDigest','planDigest','executable','portable','liveConversationVerified'])
 if(raw.schema!=='managed-correction-context/1'||envelope.failure!=='malformed_output'||envelope.phase!=='submitted'||envelope.outcome!=='submitted'||!Number.isSafeInteger(raw.capturedAt)||raw.capturedAt<=0||raw.capturedAt>envelope.observedAt||!recoveryId(raw.bindingId)||!recoveryId(raw.accountId)||![raw.sourceSha256,raw.manifestSha256,raw.promptSha256,raw.replySha256].every(recoveryHash)||typeof raw.rawCheckpointRef!=='string'||!/^checkpoint\/[A-Za-z0-9_-]{1,128}$/.test(raw.rawCheckpointRef)||!Number.isSafeInteger(raw.policyRevision)||raw.policyRevision<1||![raw.lockedCandidates,raw.failedCandidates].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=500)||raw.executable!==false||raw.portable!==false||raw.liveConversationVerified!==false)throw new TaskConflict('Exact historical correction-context provenance required; all execution permissions remain withheld')
 if(raw.state==='scoped'?(raw.failedCandidates<1||raw.lockedCandidates+raw.failedCandidates>500||!recoveryHash(raw.lockedDigest)||!recoveryHash(raw.planDigest)):(raw.state!=='held'||raw.lockedCandidates!==0||raw.failedCandidates!==0||raw.lockedDigest!==null||raw.planDigest!==null))throw new TaskConflict('Correction scope must preserve uncertainty and valid-unit locks')
 return structuredClone(raw) as CorrectionContextEvidence
}
