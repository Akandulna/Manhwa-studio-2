import {canonicalJson,TaskConflict} from './managedTaskProtocol.js'
import type {RecoveryUnit} from './automationRecoveryPolicy.js'
import type {SavedUploadTransport} from './managedSavedUploadRecovery.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import type {AutomationRecovery} from './automationRecovery.js'
/** The page resolver verifies actual current source/binding and authority; browser evidence cannot confer permission. */
export class SavedUploadRecoveryBridge {
 constructor(private deps:{resolve:()=>Promise<{unit:RecoveryUnit;pageLabel:string}>;transport:SavedUploadTransport;diagnoses:AutomationRecovery;enabled:()=>boolean;now?:()=>number}){}
 async perform(raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||JSON.stringify(raw).length>8000)throw new TaskConflict('Bounded saved-upload controls required')
  const body=raw as Record<string,any>;recoveryExact(body,'actionId' in body?['action','fence','expectedRevision','actionId']:['action','fence','expectedRevision'])
  if(!['inspect','enable','reserve','pause','cancel','reconcile'].includes(body.action)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||('actionId' in body&&!recoveryId(body.actionId))||body.action==='reserve'&&!recoveryId(body.actionId))throw new TaskConflict('Exact saved-upload action required')
  const {unit,pageLabel}=await this.deps.resolve(),transport=this.deps.transport
  let episode=await transport.call('discover',unit,{})
  if(body.action!=='inspect'){
   if(!episode||canonicalJson(body.fence)!==canonicalJson(episode.fence)||body.expectedRevision!==episode.revision)throw new TaskConflict('Inspect the exact current saved-upload offer')
   if(['enable','reserve'].includes(body.action))await this.deps.diagnoses.assertAdmission(unit,body.action==='reserve'?'upload_saved':undefined)
   const enabled=this.deps.enabled()&&transport.globalEnabled
   if(!['pause','cancel','reconcile'].includes(body.action)&&!enabled)throw new TaskConflict('Saved upload recovery remains disabled')
   if(body.action==='reconcile'){
    const last=episode.actions.at(-1);if(!last||body.actionId&&body.actionId!==last.id)throw new TaskConflict('Original started upload required')
    episode=await transport.call('reconcile',episode.fence,{actionId:last.id})
   }else if(body.action==='reserve'){
    const admission=await this.deps.diagnoses.inspect(unit)
    if(!admission?.enabled||admission.paused||admission.cancelled)throw new TaskConflict('Explicit current Automation admission required')
    await this.deps.diagnoses.assertAdmission(unit,body.action==='reserve'?'upload_saved':undefined)
    episode=await transport.call('reserve',episode.fence,{revision:episode.revision,actionId:body.actionId})
   }
   else episode=await transport.call('control',episode.fence,{revision:episode.revision,enabled:body.action==='enable'?true:episode.enabled,paused:body.action==='pause'?true:body.action==='enable'?false:episode.paused,cancelled:body.action==='cancel'})
  }
  let diagnosis=null
  if(episode&&transport.budget){
   const verified=episode.actions.at(-1)?.phase==='verified',now=(this.deps.now??Date.now)()
   diagnosis=await this.deps.diagnoses.observeInspection(unit,{transferVerified:verified,reference:'saved-upload/inspection',observedAt:now,failure:'cloud_transfer',outcome:'saved',inputCurrent:true,reviewRequired:false,canonical:false,localState:'missing',savedCheckpoint:true,login:'unknown',quota:'unknown',quotaScope:null,recheckAt:null,pageExpected:false,profileExpected:false,loading:false,precedingActionReconciled:true,knownRepair:false,uiChangeId:null,adapterScope:'saved-crop-upload',contextVerified:true,contextPortable:false,policyAllowsAlternative:false,correctionAllowed:false,acceptedUnitsPreserved:true,safeReleaseVerified:false,deviceReachable:false},transport.budget)
   // Mirror explicit controls, not inspection, into local admission. Relay remains the execution authority.
   if(['enable','pause','cancel'].includes(body.action))diagnosis=await this.deps.diagnoses.control(unit,diagnosis.revision,{enabled:body.action==='enable'?true:diagnosis.enabled,paused:body.action==='pause'?true:body.action==='enable'?false:diagnosis.paused,cancelled:body.action==='cancel'})

  }
  return {pageLabel,observedAt:(this.deps.now??Date.now)(),globalEnabled:this.deps.enabled()&&transport.globalEnabled,budget:transport.budget,episode,diagnosis}
 }
}
