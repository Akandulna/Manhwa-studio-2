import {describe,it,expect} from 'vitest'
import {parseProductionResume,approveProductionResume} from '../src/services/managedProductionResume.js'
import type {ProductionJob} from '../src/services/productionAutomationModel.js'
import type {ProductionReconciliation,ProductionObservationState} from '../src/services/managedProductionReconciliation.js'
const taskId='task:sha256:'+'a'.repeat(64)
const job:ProductionJob={id:'saved',revision:3,seriesId:'series',status:'interrupted',step:'clipping',message:'retained',createdAt:'fixture',updatedAt:'fixture',config:{managedCrop:true,device:'phone',profileId:'profile',clipper:{ai:'chatgpt',flow:'classic',tabs:1,chatGpt:{mode:null,model:null,effort:null}}},command:{kind:'clipper',sentAt:'fixture',managedTaskIds:[taskId],managedClaims:[{taskId,claimEventId:'original',deviceId:'phone',profileId:'profile'}]}}
const request={jobId:'saved',revision:3,scopeDigest:'b'.repeat(64)}
const report:ProductionReconciliation={schema:'managed-production-reconciliation/1',jobId:'saved',revision:3,seriesId:'series',checkedAt:'2026-10-22T00:00:00Z',scopeDigest:request.scopeDigest,observations:[{taskId,claimEventId:'original',state:'current_unsent',message:'fixture'}],preparedTaskIds:[taskId],unassignedPages:0,requiresAttention:false,readOnly:true}
describe('explicit production resume decision',()=>{
 it('strictly accepts an exact job/revision/inspection digest',()=>{
  expect(parseProductionResume(request)).toEqual(request)
  for(const value of [null,[],{}, {...request,revision:-1},{...request,revision:Infinity},{...request,scopeDigest:'invalid'},{...request,unexpected:true},{...request,jobId:''}])expect(()=>parseProductionResume(value)).toThrow()
 })
 it.each(['current_unsent','waiting_original_reply','ready_original_saved','verified_complete'] as ProductionObservationState[])('permits exact original evidence %s without changing it',state=>{
  const before=JSON.stringify(job),observed={...report,observations:[{...report.observations[0],state}]}
  expect(approveProductionResume(job,request,observed)).toEqual({...request,checkedAt:report.checkedAt,preparedTaskIds:[taskId]})
  expect(JSON.stringify(job)).toBe(before)
 })
 it.each(['needs_reconciliation','obsolete_claim','missing_receipt','claim_blocked','legacy_task_only','input_changed'] as ProductionObservationState[])('rejects retained evidence %s even if a client falsely clears attention',state=>{
  expect(()=>approveProductionResume(job,request,{...report,observations:[{...report.observations[0],state}]})).toThrow('needs reconciliation')
 })
 it('rejects cancellation, running/review jobs, changed revisions/digests and incomplete task coverage',()=>{
  for(const status of ['cancelled','running','review'] as const)expect(()=>approveProductionResume({...job,status},request,report)).toThrow('Only an interrupted')
  expect(()=>approveProductionResume({...job,revision:4},request,report)).toThrow('changed')
  expect(()=>approveProductionResume(job,{...request,scopeDigest:'c'.repeat(64)},report)).toThrow('changed')
  expect(()=>approveProductionResume(job,request,{...report,requiresAttention:true})).toThrow('needs reconciliation')
  expect(()=>approveProductionResume(job,request,{...report,observations:[]})).toThrow('exact saved task scope')
  expect(()=>approveProductionResume(job,request,{...report,observations:[report.observations[0],report.observations[0]]})).toThrow('exact saved task scope')
 })
})
