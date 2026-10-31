import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryExact,recoveryId,recoveryHash} from './managedSavedImportRecoveryProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {fallbackTargets,type FallbackTarget} from './fallbackPreflightProtocol.js'
export const TARGET_CONTEXT_SCHEMA='managed-target-context-check/1'
export const TARGET_CONTEXT_CAPABILITY='target-standalone-context/1'
export const STANDALONE_CONTEXT='reviewed-standalone-page/1'
export const CONTEXT_CONFIRMATION='Only this page, ordered attachments and exact prompt are required; no earlier conversation or external rules are required.'
export const contextPermissions={executionAllowed:false,handoffAllowed:false,resendAllowed:false,viewAdoptionAllowed:false,portableInputVerified:false} as const
export function emptyContextSession(raw:unknown){
 recoveryExact(raw,['documentKind','ready','composer','attachments','response','login','overlay','composerAccessible'])
 if(canonicalJson(raw)!==canonicalJson({documentKind:'chatgpt_home',ready:true,composer:'empty',attachments:'none',response:'none',login:'unknown',overlay:'none',composerAccessible:true}))throw new TaskConflict('Untouched visible empty target home required')
 return structuredClone(raw)
}
export function parseContextProof(raw:unknown){
 recoveryExact(raw,['id','reviewId','packageId','bindingId','observedAt','accountObservationAt','sourceSha256','manifestSha256','promptSha256','session'])
 if(![raw.id,raw.reviewId,raw.packageId,raw.bindingId].every(recoveryId)||![raw.sourceSha256,raw.manifestSha256,raw.promptSha256].every(recoveryHash)||![raw.observedAt,raw.accountObservationAt].every(v=>Number.isSafeInteger(v)&&v>0)||raw.accountObservationAt>raw.observedAt)throw new TaskConflict('Exact reviewed target context observation required')
 emptyContextSession(raw.session);return structuredClone(raw)
}
export function parseContextReceipt(raw:unknown,unit:RecoveryUnit,target:FallbackTarget,now=Date.now()){
 recoveryExact(raw,['schema','id','reviewId','packageId','unit','target','accountId','policyRevision','source','manifestSha256','promptSha256','bindingId','accountObservationAt','observedAt','receivedAt','validUntil','contextScope','declaredContextVerified','executionAllowed','handoffAllowed','resendAllowed','viewAdoptionAllowed','portableInputVerified'])
 recoveryUnitKey(raw.unit);fallbackTargets([raw.target]);recoveryExact(raw.source,['filename','sha256','width','height'])
 if(raw.schema!==TARGET_CONTEXT_SCHEMA||raw.contextScope!==STANDALONE_CONTEXT||raw.declaredContextVerified!==true||![raw.id,raw.reviewId,raw.packageId,raw.bindingId,raw.accountId].every(recoveryId)||recoveryUnitKey(raw.unit)!==recoveryUnitKey(unit)||canonicalJson(raw.target)!==canonicalJson(target)||![raw.policyRevision,raw.source.width,raw.source.height,raw.accountObservationAt,raw.observedAt,raw.receivedAt,raw.validUntil].every(v=>Number.isSafeInteger(v)&&v>0)||raw.source.width>16383||raw.source.width*raw.source.height>100000000||typeof raw.source.filename!=='string'||raw.source.filename.length<1||raw.source.filename.length>255||![raw.source.sha256,raw.manifestSha256,raw.promptSha256].every(recoveryHash)||raw.accountObservationAt>raw.observedAt||raw.observedAt>raw.receivedAt||raw.receivedAt>now||raw.validUntil<=now||raw.validUntil>raw.observedAt+15000||raw.validUntil>raw.accountObservationAt+120000||Object.keys(contextPermissions).some(k=>raw[k]!==false))throw new TaskConflict('Fresh scope-limited context receipt required; no execution or view adoption')
 return structuredClone(raw)
}
export function parseContextStatus(raw:unknown,unit:RecoveryUnit,target:FallbackTarget,now=Date.now()){
 recoveryExact(raw,['schema','unit','target','checkedAt','state','review','receipt','executionAllowed','handoffAllowed','resendAllowed','viewAdoptionAllowed','portableInputVerified'])
 recoveryUnitKey(raw.unit);fallbackTargets([raw.target])
 if(raw.schema!==TARGET_CONTEXT_SCHEMA||recoveryUnitKey(raw.unit)!==recoveryUnitKey(unit)||canonicalJson(raw.target)!==canonicalJson(target)||!Number.isSafeInteger(raw.checkedAt)||raw.checkedAt<=0||raw.checkedAt>now||now-raw.checkedAt>=15000||!['unreviewed','awaiting_target','verified_declared_context','expired','withdrawn','blocked'].includes(raw.state)||Object.keys(contextPermissions).some(k=>raw[k]!==false))throw new TaskConflict('Exact context status required')
 if(raw.review!==null){recoveryExact(raw.review,['id','packageId','contextScope','reviewedAt','withdrawnAt']);if(!recoveryId(raw.review.id)||!recoveryId(raw.review.packageId)||raw.review.contextScope!==STANDALONE_CONTEXT||!Number.isSafeInteger(raw.review.reviewedAt)||raw.review.reviewedAt<=0||raw.review.reviewedAt>raw.checkedAt||!(raw.review.withdrawnAt===null||Number.isSafeInteger(raw.review.withdrawnAt)&&raw.review.withdrawnAt>=raw.review.reviewedAt&&raw.review.withdrawnAt<=raw.checkedAt))throw new TaskConflict('Exact retained context review required')}
 if(raw.receipt!==null){if(!raw.review||raw.receipt.reviewId!==raw.review.id||raw.receipt.packageId!==raw.review.packageId||raw.receipt.receivedAt>raw.checkedAt)throw new TaskConflict('Uncorrelated context receipt');parseContextReceipt(raw.receipt,unit,target,raw.state==='verified_declared_context'?now:raw.receipt.receivedAt)}
 if(raw.state!=='unreviewed'&&raw.review===null||raw.state==='awaiting_target'&&raw.receipt!==null)throw new TaskConflict('Missing reviewed context requirements')
 if(raw.state==='verified_declared_context'&&(!raw.receipt||raw.review?.withdrawnAt!==null)||raw.state==='unreviewed'&&(raw.review!==null||raw.receipt!==null)||raw.state==='withdrawn'&&raw.review?.withdrawnAt===null)throw new TaskConflict('Context state contradicts review')
 return structuredClone(raw)
}

export function parseContextReview(raw:unknown,unit:RecoveryUnit,target:FallbackTarget,now=Date.now()){
 recoveryExact(raw,['schema','id','packageId','unit','target','accountId','policyRevision','source','manifestSha256','promptSha256','contextScope','reviewedAt','withdrawnAt','executionAllowed','handoffAllowed','resendAllowed','viewAdoptionAllowed','portableInputVerified'])
 recoveryUnitKey(raw.unit);fallbackTargets([raw.target]);recoveryExact(raw.source,['filename','sha256','width','height'])
 if(raw.schema!==TARGET_CONTEXT_SCHEMA||raw.contextScope!==STANDALONE_CONTEXT||![raw.id,raw.packageId,raw.accountId].every(recoveryId)||recoveryUnitKey(raw.unit)!==recoveryUnitKey(unit)||canonicalJson(raw.target)!==canonicalJson(target)||![raw.policyRevision,raw.reviewedAt,raw.source.width,raw.source.height].every(v=>Number.isSafeInteger(v)&&v>0)||raw.reviewedAt>now||!(raw.withdrawnAt===null||Number.isSafeInteger(raw.withdrawnAt)&&raw.withdrawnAt>=raw.reviewedAt&&raw.withdrawnAt<=now)||![raw.source.sha256,raw.manifestSha256,raw.promptSha256].every(recoveryHash)||Object.keys(contextPermissions).some(k=>raw[k]!==false))throw new TaskConflict('Exact non-executable context requirements review required')
 return structuredClone(raw)
}
