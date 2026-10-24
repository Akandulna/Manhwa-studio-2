import type {SavedCropInspection} from './savedCropRecoveryBridge.js'
import type {AutomationRecovery} from './automationRecovery.js'
import type {RecoveryEvidence,RecoveryUnit} from './automationRecoveryPolicy.js'
export const savedCropRecoveryUnit=(view:SavedCropInspection):RecoveryUnit=>{
 const {workspaceId,taskId,attemptId,generation,fingerprint}=view.target
 return {workspaceId,taskId,attemptId,generation,fingerprint}
}
/** Only authenticated server-side inspection can supply the evidence; browsers cannot assert postconditions. */
export function observeSavedCropRecovery(controller:AutomationRecovery,view:SavedCropInspection){
 const e=view.episode,last=e?.actions.at(-1)
 const evidence:RecoveryEvidence={reference:'projection/inspection',observedAt:view.observedAt,failure:'local_import',outcome:'verified',inputCurrent:view.sourceMatches,reviewRequired:false,canonical:view.canonical,localState:view.localState,savedCheckpoint:true,login:'unknown',quota:'unknown',quotaScope:null,recheckAt:null,pageExpected:false,profileExpected:false,loading:false,precedingActionReconciled:true,knownRepair:false,uiChangeId:null,adapterScope:'saved-crop-import',contextVerified:view.sourceMatches,contextPortable:false,policyAllowsAlternative:false,correctionAllowed:false,acceptedUnitsPreserved:true,safeReleaseVerified:false,deviceReachable:false}
 return controller.observeInspection(savedCropRecoveryUnit(view),evidence,view.budget??{used:e?.actions.length??0,uiUsed:0,nextEligibleAt:e?.nextEligibleAt??0,pending:!!last&&['reserved','executing','unknown'].includes(last.phase),exhausted:(e?.actions.length??0)>=3})
}
