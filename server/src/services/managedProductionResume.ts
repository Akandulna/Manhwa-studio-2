import {ManagedProductionCoordinator} from './managedProductionCoordinator.js'
import {inspectManagedProduction} from './managedProductionReconciliation.js'
import type {PilotAuthority,PilotInput} from './managedCropPilot.js'
import {TaskConflict} from './managedTaskProtocol.js'
import type {ProductionJob} from './productionAutomationModel.js'
import type {ProductionReconciliation} from './managedProductionReconciliation.js'
export interface ProductionResumeRequest {jobId:string;revision:number;scopeDigest:string}
export interface ProductionResumeApproval extends ProductionResumeRequest {checkedAt:string;preparedTaskIds:string[]}
export function parseProductionResume(value:unknown):ProductionResumeRequest {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new TaskConflict('Inspect the exact saved run before resuming')
 const raw=value as Record<string,unknown>
 if(Object.keys(raw).sort().join(',')!=='jobId,revision,scopeDigest'||typeof raw.jobId!=='string'||!raw.jobId||raw.jobId.length>128||!Number.isSafeInteger(raw.revision)||Number(raw.revision)<0||typeof raw.scopeDigest!=='string'||!(/^[a-f0-9]{64}$/).test(raw.scopeDigest))throw new TaskConflict('Exact saved job, revision and inspection digest required')
 return raw as unknown as ProductionResumeRequest
}
/** A matching observation is required again under coordinator ownership; cancelled runs never resume. */
export function approveProductionResume(job:ProductionJob,request:ProductionResumeRequest,report:ProductionReconciliation):ProductionResumeApproval {
 if(!job.config.managedCrop||!['failed','interrupted'].includes(job.status))throw new TaskConflict('Only an interrupted or failed managed run can resume. Cancelled work stays cancelled')
 if(job.id!==request.jobId||(job.revision??0)!==request.revision||report.jobId!==job.id||report.seriesId!==job.seriesId||report.revision!==request.revision||report.scopeDigest!==request.scopeDigest)throw new TaskConflict('Saved run or authority evidence changed. Inspect it again before resuming')
 if(report.requiresAttention||report.observations.some(row=>!['current_unsent','waiting_original_reply','ready_original_saved','verified_complete'].includes(row.state)))throw new TaskConflict('Retained work needs reconciliation. Missing, obsolete, cancelled or uncertain attempts cannot resume')
 const ids=new Set([...(job.command?.managedTaskIds??[]),...(job.command?.managedClaims??[]).map(c=>c.taskId)])
 if(report.observations.length!==ids.size||report.observations.some(row=>!ids.has(row.taskId))||new Set(report.observations.map(row=>row.taskId)).size!==ids.size)throw new TaskConflict('Inspection does not cover the exact saved task scope')
 if(!Array.isArray(report.preparedTaskIds)||report.preparedTaskIds.length>1000||new Set(report.preparedTaskIds).size!==report.preparedTaskIds.length||report.preparedTaskIds.some(id=>!/^task:sha256:[a-f0-9]{64}$/.test(id))||[...ids].some(id=>!report.preparedTaskIds.includes(id)))throw new TaskConflict('Inspection does not match the exact prepared source scope')
 return {...request,checkedAt:report.checkedAt,preparedTaskIds:[...report.preparedTaskIds]}
}


export interface ManagedResumeDependencies {
 load:()=>Promise<ProductionJob[]>
 authority:PilotAuthority
 coordinator:ManagedProductionCoordinator
 inputs:(job:ProductionJob)=>Promise<PilotInput[]>
 launch:(job:ProductionJob,approval:ProductionResumeApproval)=>Promise<ProductionJob>
 now?:()=>number
}
/** Recheck the inspected snapshot under current coordinator ownership before the runner's durable CAS. */
export async function resumeInspectedManagedProduction(seriesId:string,value:unknown,deps:ManagedResumeDependencies):Promise<ProductionJob> {
 const request=parseProductionResume(value)
 const job=(await deps.load()).find(j=>j.seriesId===seriesId)
 if(!job||job.id!==request.jobId||(job.revision??0)!==request.revision||!job.config.managedCrop||!['failed','interrupted'].includes(job.status))throw new TaskConflict('Refresh an interrupted or failed managed run before resuming')
 const before=JSON.stringify(job)
 return deps.coordinator.withLease(deps.authority,async authority=>{
  const report=await inspectManagedProduction(job,authority,await deps.inputs(job),(deps.now??Date.now)())
  const approval=approveProductionResume(job,request,report)
  const current=(await deps.load()).find(j=>j.seriesId===seriesId)
  if(JSON.stringify(current)!==before)throw new TaskConflict('Saved run changed during reconciliation. Inspect it again')
  return deps.launch(job,approval)
 })
}
