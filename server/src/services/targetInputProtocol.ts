import {TaskConflict,canonicalJson,type CropSpec,type CropIdentity} from './managedTaskProtocol.js'
import {recoveryExact,recoveryHash,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {fallbackTargets,type FallbackTarget} from './fallbackPreflightProtocol.js'
export const TARGET_INPUT_SCHEMA='managed-target-source-check/1'
export const TARGET_INPUT_CAPABILITY='target-source-check/1'
export const TARGET_INPUT_MAX_AGE=120000
export interface TargetInputChallenge {
 schema:typeof TARGET_INPUT_SCHEMA;id:string;unit:RecoveryUnit;target:FallbackTarget;accountId:string;policyRevision:number;stopCommandId:string;
 scope:CropIdentity;spec:CropSpec;sourceSha256:string;issuedAt:number;validUntil:number;
 executionAllowed:false;handoffAllowed:false;resendAllowed:false;portableInputVerified:false
}
export interface TargetInputProof {challengeId:string;observedAt:number;sourceSha256:string;sourceBytes:number;specFingerprint:string}
export interface TargetInputReceipt {schema:typeof TARGET_INPUT_SCHEMA;challengeId:string;unit:RecoveryUnit;target:FallbackTarget;accountId:string;policyRevision:number;sourceSha256:string;sourceBytes:number;observedAt:number;receivedAt:number;validUntil:number;sourceVerified:true;portableInputVerified:false;executionAllowed:false;handoffAllowed:false;resendAllowed:false}
export function parseTargetInputProof(raw:unknown):TargetInputProof {
 recoveryExact(raw,['challengeId','observedAt','sourceSha256','sourceBytes','specFingerprint'])
 if(!recoveryId(raw.challengeId)||!recoveryHash(raw.sourceSha256)||!recoveryHash(raw.specFingerprint)||!Number.isSafeInteger(raw.observedAt)||raw.observedAt<=0||!Number.isSafeInteger(raw.sourceBytes)||raw.sourceBytes<1||raw.sourceBytes>64000000)throw new TaskConflict('Exact bounded target source observation required')
 return structuredClone(raw) as TargetInputProof
}
export function parseTargetInputReceipt(raw:unknown,unit:RecoveryUnit,target:FallbackTarget,now=Date.now()):TargetInputReceipt {
 recoveryExact(raw,['schema','challengeId','unit','target','accountId','policyRevision','sourceSha256','sourceBytes','observedAt','receivedAt','validUntil','sourceVerified','portableInputVerified','executionAllowed','handoffAllowed','resendAllowed'])
 recoveryUnitKey(raw.unit);fallbackTargets([raw.target])
 if(raw.schema!==TARGET_INPUT_SCHEMA||!recoveryId(raw.challengeId)||recoveryUnitKey(raw.unit)!==recoveryUnitKey(unit)||canonicalJson(raw.target)!==canonicalJson(target)||!recoveryId(raw.accountId)||!Number.isSafeInteger(raw.policyRevision)||raw.policyRevision<1||!recoveryHash(raw.sourceSha256)||!Number.isSafeInteger(raw.sourceBytes)||raw.sourceBytes<1||raw.sourceBytes>64000000||![raw.observedAt,raw.receivedAt,raw.validUntil].every(Number.isSafeInteger)||raw.observedAt<=0||raw.observedAt>raw.receivedAt||raw.receivedAt>now||raw.validUntil<=now||raw.validUntil>raw.observedAt+TARGET_INPUT_MAX_AGE||raw.sourceVerified!==true||['portableInputVerified','executionAllowed','handoffAllowed','resendAllowed'].some(k=>raw[k]!==false))throw new TaskConflict('Fresh target source receipt required; no portable execution permission')
 return structuredClone(raw) as TargetInputReceipt
}

export function parseTargetInputStatus(raw:unknown,unit:RecoveryUnit,target:FallbackTarget,now=Date.now()){
 recoveryExact(raw,['schema','unit','target','checkedAt','state','receipt','executionAllowed','handoffAllowed','resendAllowed','portableInputVerified'])
 recoveryUnitKey(raw.unit);fallbackTargets([raw.target])
 if(raw.schema!==TARGET_INPUT_SCHEMA||recoveryUnitKey(raw.unit)!==recoveryUnitKey(unit)||canonicalJson(raw.target)!==canonicalJson(target)||!Number.isSafeInteger(raw.checkedAt)||raw.checkedAt<=0||raw.checkedAt>now||now-raw.checkedAt>=15000||!['missing','awaiting_target','verified_source_only','expired','blocked'].includes(raw.state)||['executionAllowed','handoffAllowed','resendAllowed','portableInputVerified'].some(k=>raw[k]!==false))throw new TaskConflict('Exact non-executable target source status required')
 if(raw.receipt!==null&&(!Number.isSafeInteger(raw.receipt.receivedAt)||raw.receipt.receivedAt>raw.checkedAt))throw new TaskConflict('Target source evidence is future dated')
 if(raw.receipt!==null)parseTargetInputReceipt(raw.receipt,unit,target,raw.state==='verified_source_only'?now:raw.receipt.receivedAt)
 if(raw.state==='verified_source_only'&&raw.receipt===null||['missing','awaiting_target'].includes(raw.state)&&raw.receipt!==null)throw new TaskConflict('Contradictory target source status')
 return structuredClone(raw)
}
