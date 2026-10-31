import {randomUUID} from 'node:crypto'
import {ManagedArtifactDestination,resolveManagedCropInput} from './managedArtifactImport.js'
import {ManagedSavedImportRecovery,savedImportDestinationId,type SavedImportRecoveryTransport} from './managedSavedImportRecovery.js'
import type {PilotInput,PilotAuthority} from './managedCropPilot.js'
import {managedCropBinding} from './managedCropProjection.js'
import {cropTaskIdentity,TaskConflict} from './managedTaskProtocol.js'
import type {AutomationRecovery} from './automationRecovery.js'
import type {RecoveryEvidence,RecoveryUnit} from './automationRecoveryPolicy.js'

/** Exact canonical output path used by Automation Manager. Existing local output never spends recovery budget. */
export async function restoreManagedProductionProjection(input:PilotInput,signal:AbortSignal,deps:{authority:PilotAuthority;transport:SavedImportRecoveryTransport;diagnoses:AutomationRecovery;enabled:()=>boolean;wait:(ms:number,signal:AbortSignal)=>Promise<void>;report:(message:string)=>Promise<void>;refreshInput?:()=>Promise<PilotInput>;now?:()=>number}){
 const now=deps.now??Date.now,expected=await cropTaskIdentity(input.identity,input.spec)
 signal.throwIfAborted()
 const timeline=await deps.authority.timeline(expected.taskId),{task,attempt}=timeline
 if(task.state!=='verified_complete'||!task.canonical||!attempt||attempt.phase!=='published'||attempt.submission!=='saved')throw new TaskConflict('Canonical saved task required; never retry a provider request')
 const artifactId=task.canonical.split('/').at(-1)!,snapshot=await deps.transport.artifacts.load(artifactId),destination=new ManagedArtifactDestination(input.destination),adapter=new ManagedSavedImportRecovery(deps.transport)
 const f={workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:task.generation,fingerprint:task.fingerprint,artifactId,sha256:snapshot.record.sha256},destinationId=await savedImportDestinationId(destination)
 const unit:RecoveryUnit={workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:task.generation,fingerprint:task.fingerprint}
 let executing=false
 const current=async()=>{
  signal.throwIfAborted();if(executing){await deps.diagnoses.assertAdmission(unit);const control=await deps.diagnoses.inspect(unit);if(!deps.enabled()||!control?.enabled||control.paused||control.cancelled)throw new TaskConflict('Automation recovery admission changed')}
  const fresh=deps.refreshInput?await deps.refreshInput():input,identity=await cropTaskIdentity(fresh.identity,fresh.spec)
  if(identity.taskId!==expected.taskId||identity.fingerprint!==expected.fingerprint||fresh.destination!==input.destination||fresh.folder!==input.folder||fresh.filename!==input.filename)throw new TaskConflict('Current production input changed')
  const binding=await managedCropBinding(fresh.folder,fresh.filename)
  if(binding?.task.id!==task.id||binding.task.fingerprint!==task.fingerprint||binding.destination!==input.destination)throw new TaskConflict('Current source binding changed')
  const source=await resolveManagedCropInput(fresh.identity,fresh.spec,fresh.sourceFile)
  if(executing){await deps.diagnoses.assertAdmission(unit);const control=await deps.diagnoses.inspect(unit);if(!deps.enabled()||!control?.enabled||control.paused||control.cancelled)throw new TaskConflict('Automation recovery admission changed')}
  return source
 }
 await adapter.validateSnapshot(snapshot,f,current)
 for(let checks=0;checks<5;checks++){
  signal.throwIfAborted();await adapter.validateSnapshot(snapshot,f,current)
  const episode=await deps.transport.call('inspect',f,destinationId,{}),last=episode?.actions.at(-1)
  const localState=await destination.inspectProjection(snapshot)
  if(localState==='verified'&&(!last||['verified','safe_failure'].includes(last.phase))){const old=await deps.diagnoses.inspect(unit);if(!old||old.decision.state==='verified')return}
  const evidence:RecoveryEvidence={reference:'projection/inspection',observedAt:now(),failure:'local_import',outcome:'verified',inputCurrent:true,reviewRequired:false,canonical:true,localState,savedCheckpoint:true,login:'unknown',quota:'unknown',quotaScope:null,recheckAt:null,pageExpected:false,profileExpected:false,loading:false,precedingActionReconciled:true,knownRepair:false,uiChangeId:null,adapterScope:'saved-crop-import',contextVerified:true,contextPortable:false,policyAllowsAlternative:false,correctionAllowed:false,acceptedUnitsPreserved:true,safeReleaseVerified:false,deviceReachable:false}
  const budget=deps.transport.budget??{used:episode?.actions.length??0,uiUsed:0,nextEligibleAt:episode?.nextEligibleAt??0,pending:!!last&&['reserved','executing','unknown'].includes(last.phase),exhausted:(episode?.actions.length??0)>=3}
  const diagnosis=await deps.diagnoses.observeInspection(unit,evidence,budget)
  if(last&&['executing','unknown'].includes(last.phase)&&localState==='verified'){
   const reconciled=await adapter.reconcile(f,destination,current,signal);if(reconciled.state!=='verified')throw new TaskConflict('Original recovery remains unresolved');continue
  }
  if(localState==='verified'){if(budget.pending)throw new TaskConflict('Original reserved action remains unresolved');return}
  if(!deps.enabled()||deps.transport.globalEnabled!==true||!diagnosis.enabled||diagnosis.paused||diagnosis.cancelled||!episode?.enabled||episode.paused||episode.cancelled)throw new TaskConflict('Missing canonical local copy; inspect and explicitly enable this exact recovery in Automation Manager and page recovery controls')
  if(diagnosis.decision.state==='waiting'&&diagnosis.decision.recheckAt!==null){await deps.report(diagnosis.decision.reason);await deps.wait(Math.min(60000,Math.max(1,diagnosis.decision.recheckAt-now())),signal);continue}
  if(diagnosis.decision.state!=='ready'||diagnosis.decision.operation!=='restore_local')throw new TaskConflict(diagnosis.decision.reason)
  // The sole execution authority/budget is still relay reserve/start/check, shared with the manual panel.
  await deps.report('Restoring the original verified local crop; no provider generation')
  executing=true
  try{await adapter.run(f,'automation_'+randomUUID(),destination,current,signal,episode.revision)}catch(error){
   signal.throwIfAborted();const after=await deps.transport.call('inspect',f,destinationId,{})
   if(after?.actions.at(-1)?.phase!=='safe_failure')throw error
   await deps.report('Safe local import failure; shared authority cooldown applies');continue
  }finally{executing=false}
  if(await destination.inspectProjection(snapshot)!=='verified')throw new TaskConflict('Recovery postcondition failed; retain original action')
  await deps.diagnoses.observeInspection(unit,{...evidence,reference:'projection/inspection',observedAt:now(),localState:'verified'},deps.transport.budget??{...budget,used:budget.used+1,pending:false,exhausted:budget.used+1>=3})
  return
 }
 throw new TaskConflict('Recovery inspection bound reached; original episode and budget retained')
}
