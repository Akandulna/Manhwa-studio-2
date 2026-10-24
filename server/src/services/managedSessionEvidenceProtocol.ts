import {TaskConflict} from './managedTaskProtocol.js'
import {recoveryExact,recoveryId,recoveryHash} from './managedSavedImportRecoveryProtocol.js'
export interface ManagedSessionEvidence {
 schema:'managed-session-evidence/1';bindingId:string;commandId:string;profileId:string;fingerprint:string;cachedSourceSha256:string;observedAt:number
 documentKind:'chatgpt_home'|'chatgpt_conversation'|'unexpected';ready:boolean;composer:'empty'|'nonempty'|'unavailable';attachments:'none'|'present';response:'none'|'present'|'active';login:'unknown'|'signed_out'
 exactView:boolean;currentProfile:boolean;cachedSourceVerified:boolean;untouched:boolean;context:'empty_unsent'|'held'
}
export function parseManagedSessionEvidence(raw:unknown,envelope:{commandId:string;profileId:string;unit:{fingerprint:string};observedAt:number;outcome:string;phase:string}):ManagedSessionEvidence {
 recoveryExact(raw,['schema','bindingId','commandId','profileId','fingerprint','cachedSourceSha256','observedAt','documentKind','ready','composer','attachments','response','login','exactView','currentProfile','cachedSourceVerified','untouched','context'])
 if(raw.schema!=='managed-session-evidence/1'||!recoveryId(raw.bindingId)||raw.commandId!==envelope.commandId||raw.profileId!==envelope.profileId||raw.fingerprint!==envelope.unit.fingerprint||!recoveryHash(raw.cachedSourceSha256)||!Number.isSafeInteger(raw.observedAt)||raw.observedAt<=0||raw.observedAt>envelope.observedAt||envelope.observedAt-raw.observedAt>=120000||!['chatgpt_home','chatgpt_conversation','unexpected'].includes(raw.documentKind)||!['empty','nonempty','unavailable'].includes(raw.composer)||!['none','present'].includes(raw.attachments)||!['none','present','active'].includes(raw.response)||!['unknown','signed_out'].includes(raw.login)||![raw.ready,raw.exactView,raw.currentProfile,raw.cachedSourceVerified,raw.untouched].every(x=>typeof x==='boolean'))throw new TaskConflict('Exact recent original-view session checkpoint required')
 if(raw.untouched&&(envelope.outcome!=='unsent'||!['accepted','started'].includes(envelope.phase)))throw new TaskConflict('A submitted/unknown/saved outcome cannot be an untouched session')
 const empty=raw.untouched&&raw.exactView&&raw.currentProfile&&raw.cachedSourceVerified&&raw.ready&&raw.documentKind==='chatgpt_home'&&raw.composer==='empty'&&raw.attachments==='none'&&raw.response==='none'&&raw.login==='unknown'
 if(raw.context!==(empty?'empty_unsent':'held'))throw new TaskConflict('Session shape cannot confer a false empty-context result')
 return structuredClone(raw) as ManagedSessionEvidence
}
