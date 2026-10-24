import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
export const RECOVERY_FAILURES=['generation_quota','upload_allowance','unsupported_attachment','signed_out','missing_control','network_timeout','executor_stopped','malformed_output','cloud_transfer','local_import','device_unavailable','unknown'] as const
export type RecoveryFailure=typeof RECOVERY_FAILURES[number]
export type RecoveryOutcome='unsent'|'rejected'|'unknown'|'submitted'|'saved'|'verified'
export type RecoveryOperation='inspect'|'wait'|'account_recheck'|'restore_local'|'upload_saved'|'navigate'|'ui_repair'|'correct_output'|'handoff'
export interface RecoveryUnit {workspaceId:string;taskId:string;attemptId:string;generation:number;fingerprint:string}
export interface RecoveryEvidence {
 transferVerified?:boolean;reference:string;observedAt:number;failure:RecoveryFailure;outcome:RecoveryOutcome
 inputCurrent:boolean;reviewRequired:boolean;canonical:boolean;localState:'missing'|'verified'|'conflict'|'unknown';savedCheckpoint:boolean
 login:'signed_in'|'signed_out'|'unknown';quota:'available'|'blocked'|'unknown';quotaScope:string|null;recheckAt:number|null
 pageExpected:boolean;profileExpected:boolean;loading:boolean;precedingActionReconciled:boolean;knownRepair:boolean
 uiChangeId:string|null;adapterScope:string;contextVerified:boolean;contextPortable:boolean;policyAllowsAlternative:boolean
 correctionAllowed:boolean;acceptedUnitsPreserved:boolean;safeReleaseVerified:boolean;deviceReachable:boolean
}
export interface RecoveryBudget {used:number;uiUsed:number;nextEligibleAt:number;pending:boolean;exhausted:boolean}
export interface RecoveryDecision {state:'ready'|'waiting'|'held'|'owner_action'|'verified';operation:RecoveryOperation;reason:string;recheckAt:number|null;incident:{cause:string;resource:string};requiredPostcondition:string}
const opaque=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9_-][A-Za-z0-9_./:-]{0,255}$/.test(x)&&!x.includes('://')
export function recoveryUnitKey(u:RecoveryUnit):string{
 if(!u||Object.keys(u).sort().join(',')!=='attemptId,fingerprint,generation,taskId,workspaceId'||!opaque(u.workspaceId)||!/^task:sha256:[a-f0-9]{64}$/.test(u.taskId)||!opaque(u.attemptId)||!Number.isSafeInteger(u.generation)||u.generation<1||!/^[a-f0-9]{64}$/.test(u.fingerprint))throw new TaskConflict('Exact recovery unit required')
 return canonicalJson([u.workspaceId,u.taskId,u.attemptId,u.generation,u.fingerprint])
}
export function validateRecoveryEvidence(e:RecoveryEvidence,now:number){
 if(!e||Object.keys(e).filter(k=>k!=='transferVerified').sort().join(',')!==['reference','observedAt','failure','outcome','inputCurrent','reviewRequired','canonical','localState','savedCheckpoint','login','quota','quotaScope','recheckAt','pageExpected','profileExpected','loading','precedingActionReconciled','knownRepair','uiChangeId','adapterScope','contextVerified','contextPortable','policyAllowsAlternative','correctionAllowed','acceptedUnitsPreserved','safeReleaseVerified','deviceReachable'].sort().join(',')||!opaque(e.reference)||!opaque(e.adapterScope)||!RECOVERY_FAILURES.includes(e.failure)||!['unsent','rejected','unknown','submitted','saved','verified'].includes(e.outcome)||!Number.isSafeInteger(e.observedAt)||e.observedAt<=0||e.observedAt>now||now-e.observedAt>=120000||!['missing','verified','conflict','unknown'].includes(e.localState)||!['signed_in','signed_out','unknown'].includes(e.login)||!['available','blocked','unknown'].includes(e.quota)||!(e.quotaScope===null||opaque(e.quotaScope))||!(e.uiChangeId===null||opaque(e.uiChangeId)&&e.uiChangeId.length<=240)||!(e.recheckAt===null||Number.isSafeInteger(e.recheckAt)&&e.recheckAt>0))throw new TaskConflict('Fresh structured recovery evidence required')
 if(e.transferVerified!==undefined&&typeof e.transferVerified!=='boolean')throw new TaskConflict('Explicit transfer verification required')
 for(const k of ['inputCurrent','reviewRequired','canonical','savedCheckpoint','pageExpected','profileExpected','loading','precedingActionReconciled','knownRepair','contextVerified','contextPortable','policyAllowsAlternative','correctionAllowed','acceptedUnitsPreserved','safeReleaseVerified','deviceReachable'] as const)if(typeof e[k]!=='boolean')throw new TaskConflict('Explicit recovery evidence flags required')
}
export function parseRecoveryBudget(raw:unknown):RecoveryBudget {
 const b=raw as RecoveryBudget
 if(!b||Object.keys(b).sort().join(',')!=='exhausted,nextEligibleAt,pending,uiUsed,used'||!Number.isSafeInteger(b.used)||b.used<0||b.used>3||!Number.isSafeInteger(b.uiUsed)||b.uiUsed<0||b.uiUsed>2||b.uiUsed>b.used||!Number.isSafeInteger(b.nextEligibleAt)||b.nextEligibleAt<0||typeof b.pending!=='boolean'||b.exhausted!==(b.used>=3))throw new TaskConflict('Exact shared recovery budget required')
 return structuredClone(b)
}
/** Every REC-02 row is explicit. Error strings, plan labels and reset clocks confer no execution permission. */
export function diagnoseRecovery(unit:RecoveryUnit,e:RecoveryEvidence,b:RecoveryBudget,controls:{enabled:boolean;paused:boolean;cancelled:boolean},now:number,enrolled:ReadonlySet<RecoveryOperation>):RecoveryDecision{
 recoveryUnitKey(unit);validateRecoveryEvidence(e,now)
 b=parseRecoveryBudget(b)
 if(!controls||Object.keys(controls).sort().join(',')!=='cancelled,enabled,paused'||Object.values(controls).some(v=>typeof v!=='boolean'))throw new TaskConflict('Exact recovery controls required')
 const incident=e.failure==='missing_control'&&e.uiChangeId?{cause:'website_ui',resource:'ui-change/'+e.uiChangeId}:{cause:'recovery_'+e.failure,resource:unit.taskId+'/'+unit.generation}
 const result=(state:RecoveryDecision['state'],operation:RecoveryOperation,reason:string,requiredPostcondition:string,recheckAt:number|null=null):RecoveryDecision=>({state,operation,reason,recheckAt,incident,requiredPostcondition})
 const hold=(reason:string)=>result('held','inspect',reason,'exact original outcome and current input')
 const owner=(reason:string)=>result('owner_action','inspect',reason,'owner-reviewed evidence and current source')
 const wait=(reason:string,at:number|null=null)=>result('waiting','wait',reason,'fresh readiness evidence',at)
 const ready=(operation:RecoveryOperation,reason:string,postcondition:string)=>!controls.enabled?hold('Recovery is disabled'):!enrolled.has(operation)?owner('No verified runtime adapter for '+operation):result('ready',operation,reason,postcondition)
 if(controls.cancelled)return hold('Recovery was cancelled; retained evidence is immutable')
 if(controls.paused)return hold('Recovery is paused')
 if(!e.inputCurrent)return hold('Input revision changed')
 if(e.reviewRequired)return owner('Human review is required')
 if(b.pending)return hold('Original action needs reconciliation')
 if(e.outcome==='unknown'||e.outcome==='submitted')return hold('External request outcome is unresolved; never resend')
 if(e.canonical&&e.localState==='verified'&&['local_import','cloud_transfer'].includes(e.failure))return result('verified','inspect','Local canonical output is verified','exact canonical artifact, source and destination')
 if(e.failure==='cloud_transfer'&&e.outcome==='saved'&&e.savedCheckpoint&&e.transferVerified===true)return result('verified','inspect','Original cloud upload is verified; canonical import remains separate','exact saved checkpoint/hash and authority stage acknowledgment')
 if(b.exhausted||b.used>=3)return owner('Shared three-attempt recovery budget exhausted')
 if(b.nextEligibleAt>now)return wait('Recovery cooldown remains active',b.nextEligibleAt)
 if(e.canonical&&['local_import','cloud_transfer'].includes(e.failure)){
  if(e.localState==='conflict')return owner('Keep conflicting immutable local files for review')
  if(e.localState==='missing')return ready('restore_local','Restore already published bytes only','exact artifact checksum, source revision and local publication readback')
  return hold('Canonical local state is unknown')
 }
 if(e.outcome==='saved'&&['local_import','cloud_transfer'].includes(e.failure))return e.savedCheckpoint?ready('upload_saved','Transfer the original saved checkpoint only','same checkpoint/hash uploaded and authority acknowledgment'):hold('Saved output lacks a verified checkpoint')
 switch(e.failure){
 case 'generation_quota':case 'upload_allowance':
  if(!e.quotaScope||e.quota!=='blocked')return owner('Verify affected provider/product/model/feature quota; plan is not capacity')
  // A reset deadline means recheck, never inferred availability or automatic switching.
  if(e.recheckAt!==null&&e.recheckAt<=now)return ready('account_recheck','Reset estimate elapsed; request idle evidence refresh','original account audit completion; quota still requires affirmative evidence')
  if(e.policyAllowsAlternative&&e.contextPortable&&e.contextVerified&&e.safeReleaseVerified)return ready('handoff','Inspect an approved independent account after safe release','exact released owner, approved account capacity, restored context and pinned configuration')
  return e.recheckAt!==null?wait('Wait for scoped quota recheck',e.recheckAt):owner('No reliable quota reset or approved context-preserving alternative')
 case 'unsupported_attachment':return owner('Input is unsupported or oversized; quota retries cannot repair it')
 case 'signed_out':
  if(e.login!=='signed_out')return hold('Sign-out is not established by current evidence')
  return e.policyAllowsAlternative&&e.contextPortable&&e.contextVerified&&e.safeReleaseVerified?ready('handoff','Use only a policy-approved restored context','verified eligible profile, exact release and unchanged pinned work'):owner('Sign in or repair this original session; no authorized automatic login mechanism')
 case 'missing_control':
  if(!e.pageExpected||!e.profileExpected)return owner('Expected page/profile is unverified')
  if(e.loading)return wait('Wait for loading/streaming to finish')
  if(e.login!=='signed_in'||e.quota==='blocked')return owner('Resolve sign-in/quota overlay before UI repair')
  if(!e.precedingActionReconciled)return hold('Reconcile the preceding action before navigation or dismissal')
  if(!e.knownRepair)return owner('Unknown or ambiguous control; adapter update required')
  if(b.uiUsed>=2)return owner('Two UI-repair cycles exhausted within shared budget')
  return ready('ui_repair','Apply one known semantic alternative or noncritical overlay repair','expected page/profile/control and unchanged submission/attachment state')
 case 'network_timeout':
  return e.precedingActionReconciled&&e.pageExpected&&e.profileExpected?ready('navigate','Retry a confirmed incomplete navigation only','actual expected page/profile; no provider submission'):hold('Timeout is not proof that an external action failed')
 case 'executor_stopped':
  return e.contextVerified&&e.precedingActionReconciled?ready('navigate','Restore the inspected known session','exact context/checkpoint and current owner acknowledgment'):owner('Inspect the original session and durable checkpoint')
 case 'malformed_output':
  return e.correctionAllowed&&e.acceptedUnitsPreserved&&e.contextVerified?ready('correct_output','Correct only failed fields under pinned workflow policy','schema validation, preserved accepted units and review gate'):owner('No bounded correction policy or verified original context')
 case 'cloud_transfer':case 'local_import':return owner('Verify local/cloud/destination versions; only the missing saved step may run')
 case 'device_unavailable':return e.safeReleaseVerified&&e.contextVerified&&e.contextPortable&&e.policyAllowsAlternative?ready('handoff','Continue healthy devices; transfer only confirmed released work','exact released attempt and verified target context'):hold('Reachability loss does not prove stopped execution; healthy independent work may continue')
 default:return owner('Collect typed evidence; do not infer failure from raw error text')
 }
}
