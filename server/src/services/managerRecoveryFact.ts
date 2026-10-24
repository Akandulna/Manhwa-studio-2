import {createHash} from 'node:crypto'
import type {RecoveryDiagnosis} from './automationRecovery.js'
import type {ManagerFact} from './managerProtocol.js'
/** Observations only: shares the monitor incident key but cannot clear other managers' active impacts. */
export function managerRecoveryFact(d:RecoveryDiagnosis):ManagerFact {
 const verified=d.decision.state==='verified'
 return {key:'recovery/'+createHash('sha256').update(JSON.stringify(d.unit)).digest('hex'),scope:{seriesId:null,chapterId:null,profileId:null},stage:'presence',workState:verified?'verified_complete':d.decision.state==='waiting'?'waiting':'uncertain',inputRevision:d.unit.fingerprint,compatibility:d.evidence.inputCurrent?'current':'outdated',identity:'mapped',availability:[{destination:d.evidence.adapterScope==='original-known-ui-repair'?'original-ui-readiness':d.evidence.adapterScope==='original-unsent-navigation'?'original-page-readiness':d.evidence.adapterScope==='phone-executor-observation'?'executor-readiness':d.evidence.adapterScope==='saved-crop-upload'?'cloud-saved-upload':d.evidence.adapterScope==='account-idle-recheck'?'account-readiness':'local-recovery',state:verified?'validated':'unknown',evidenceRef:d.evidence.reference}],override:false,done:null,total:null,condition:{...d.decision.incident,state:verified?'resolved':d.decision.state==='waiting'?'waiting':'action_required',severity:'warning',summary:d.decision.reason,nextAction:verified?'Verified; retain the original recovery history.':d.decision.requiredPostcondition}}
}
