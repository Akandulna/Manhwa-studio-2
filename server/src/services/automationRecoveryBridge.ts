import type {AutomationRecovery} from './automationRecovery.js'
import type {SavedCropInspection} from './savedCropRecoveryBridge.js'
import {observeSavedCropRecovery,savedCropRecoveryUnit} from './savedCropRecoveryDiagnosis.js'
import {parseSavedImportFence,recoveryExact} from './managedSavedImportRecoveryProtocol.js'
import {TaskConflict} from './managedTaskProtocol.js'
/** Browser controls affect admission only. Stopping never depends on network availability. */
export class AutomationRecoveryBridge {
 constructor(private deps:{controller:AutomationRecovery;workspaceId:string;enabled:()=>boolean;inspect:(target:unknown)=>Promise<SavedCropInspection>}){}
 async perform(raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||JSON.stringify(raw).length>8000)throw new TaskConflict('Bounded recovery controls required')
  const body=raw as Record<string,any>;recoveryExact(body,['action','target','expectedRevision'])
  if(!['inspect','enable','pause','cancel','disable'].includes(body.action)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||!body.target||typeof body.target!=='object'||Array.isArray(body.target))throw new TaskConflict('Exact recovery controls required')
  recoveryExact(body.target,['workspaceId','taskId','attemptId','generation','fingerprint','artifactId','sha256','destinationId','chapterLabel','pageLabel','destinationLabel'])
  const {workspaceId,taskId,attemptId,generation,fingerprint,artifactId,sha256}=body.target
  parseSavedImportFence({workspaceId,taskId,attemptId,generation,fingerprint,artifactId,sha256})
  if(workspaceId!==this.deps.workspaceId)throw new TaskConflict('Exact configured workspace required')
  const unit={workspaceId,taskId,attemptId,generation,fingerprint},controller=this.deps.controller
  if(['pause','cancel','disable'].includes(body.action)){
   const old=await controller.inspect(unit)
   if(!old)throw new TaskConflict('Inspect retained diagnosis first')
   const diagnosis=await controller.control(unit,body.expectedRevision,{enabled:body.action==='disable'?false:old.enabled,paused:body.action==='pause'?true:old.paused,cancelled:body.action==='cancel'})
   return {diagnosis,globalEnabled:null}
  }
  const view=await this.deps.inspect(body.target),globalEnabled=this.deps.enabled()&&view.globalEnabled
  if(body.action==='inspect')return {diagnosis:await observeSavedCropRecovery(controller,view),globalEnabled}
  const old=await controller.inspect(savedCropRecoveryUnit(view)),last=view.episode?.actions.at(-1)
  if(!old||old.revision!==body.expectedRevision||!globalEnabled||view.budget?.pending||view.budget?.exhausted||!view.sourceMatches||view.localState!=='missing'||!view.episode?.enabled||view.episode.paused||view.episode.cancelled||last&&last.phase!=='safe_failure'||(view.episode?.actions.length??0)>=3)throw new TaskConflict('Inspect and enable the exact saved-import episode first')
  return {diagnosis:await controller.control(unit,body.expectedRevision,{enabled:true,paused:false,cancelled:false}),globalEnabled}
 }
}
