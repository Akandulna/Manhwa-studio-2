import {applyManagedBoundaryFeedback} from '../services/managedCropReview.js'
import {readManagedBoundaryFeedback,saveManagedBoundaryFeedback} from '../services/managedCropReview.js'
import {managedProductionCoordinator} from '../services/managedProductionCoordinator.js'
import {managedPilotInput} from '../services/managedPilotInput.js'
import {readManagedCropReview,setManagedCropReview,cutReviewedManagedCrop,reviewedManagedCropFile} from '../services/managedCropReview.js'
import {Router} from 'express'
import type {PrismaClient} from '@prisma/client'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {ManagedCropPilot,pilotAuthority,type PilotInput} from '../services/managedCropPilot.js'
import {DEFAULT_CROP_PROMPT} from '../services/managedCropPilotPolicy.js'
import {MANAGED_CROP_VALIDATOR} from '../services/managedCropArtifact.js'
import {canonicalJson} from '../services/managedTaskProtocol.js'
import {relayPauseForDatabase} from '../services/relayDeliveryPause.js'
import {managerChapterIdentity,managerCanDeclareRevision} from '../services/managerReporting.js'
import {getPhoneOverview} from '../services/r2Service.js'
import {productionAutomation} from '../services/productionAutomation.js'
import {productionDevices} from '../services/productionAutomationModel.js'
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v)
const taskId=(v:unknown):v is string=>typeof v==='string'&&/^task:sha256:[a-f0-9]{64}$/.test(v)
export function initManagedPilotRoutes(db:PrismaClient):Router {
 const router=Router()
 function configured(){return process.env.MANAGED_PILOT==='1'&&identifier(process.env.MANAGED_WORKSPACE_ID)&&!!process.env.MANAGED_STUDIO_TOKEN}
 function authority(){
  if(!configured())throw new Error('Managed pilot is disabled. Configure its separate credentials and relay storage before pairing.')
  return pilotAuthority(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db))
 }
 const service=()=>new ManagedCropPilot(authority())
 router.get('/accounts',async(_req,res)=>{try{const a=authority();await a.ready(['managed-accounts/1']);res.set('Cache-Control','no-store').json(await a.accounts!())}catch(error){res.status(409).json({error:error instanceof Error?error.message:'Managed accounts unavailable'})}})
 router.post('/accounts',async(req,res)=>{try{const a=authority();await a.ready(['managed-accounts/1']);const body=req.body;if(!body||typeof body!=='object'||Array.isArray(body)||JSON.stringify(body).length>30000||!['policy','confirm','quota','cadence','observe'].includes(body.action)||['schema','workspaceId'].some(k=>k in body))throw new Error('Supported bounded account action required');res.json(await a.accounts!(body))}catch(error){res.status(409).json({error:error instanceof Error?error.message:'Account update unavailable'})}})
 router.post('/accounts/select',async(req,res)=>{try{const {taskId:id,targets,...extra}=req.body??{};if(Object.keys(extra).length||!taskId(id))throw new Error('Exact task required');const a=authority();await a.ready(['managed-accounts/1']);res.json(await a.selectAccount!(id,targets))}catch(error){res.status(409).json({error:error instanceof Error?error.message:'Selection unavailable'})}})

 const input=(pageId:string)=>managedPilotInput(db,pageId)
 async function reviewPage(pageId:string) {
  if(!identifier(pageId))throw new Error('Choose an exact source page')
  const source=await input(pageId)
  const page=await db.page.findUnique({where:{id:pageId},select:{chapterId:true}})
  if(!page)throw new Error('Source page unavailable')
  return {source,chapterId:page.chapterId}
 }
 router.get('/pages/:pageId/review',async(req,res)=>{try{
  if(Object.keys(req.query).length)throw new Error('Unexpected review query')
  const {source,chapterId}=await reviewPage(req.params.pageId)
  const review=await readManagedCropReview(source.folder,source.filename)
  res.json({...review,chapterId,filename:source.filename})
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Managed review unavailable'})}})
 router.get('/pages/:pageId/boundary-feedback',async(req,res)=>{try{
  if(Object.keys(req.query).length)throw new Error('Unexpected boundary feedback query')
  const {source}=await reviewPage(req.params.pageId)
  res.set('Cache-Control','no-store').json(await readManagedBoundaryFeedback(source.folder,source.filename))
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Boundary feedback unavailable'})}})
 router.post('/pages/:pageId/boundary-feedback',async(req,res)=>{try{
  const {taskId:id,expectedRevision,expectedFeedbackId,bounds,note,...extra}=req.body??{}
  if(Object.keys(extra).length||!taskId(id)||typeof expectedRevision!=='string'||!(expectedFeedbackId===null||typeof expectedFeedbackId==='string'))throw new Error('Choose the exact source revision and saved feedback version')
  const {source}=await reviewPage(req.params.pageId)
  res.json(await saveManagedBoundaryFeedback(source.folder,source.filename,id,expectedRevision,expectedFeedbackId,bounds,note))
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Boundary feedback not saved'})}})
 router.post('/pages/:pageId/apply-boundaries',async(req,res)=>{try{
  const {taskId:id,expectedRevision,feedbackId,...extra}=req.body??{}
  if(Object.keys(extra).length||!taskId(id)||typeof expectedRevision!=='string'||!identifier(feedbackId))throw new Error('Choose the exact saved boundary feedback')
  const {source,chapterId}=await reviewPage(req.params.pageId)
  res.json({...await applyManagedBoundaryFeedback(source.folder,source.filename,id,expectedRevision,feedbackId),chapterId,filename:source.filename})
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Boundary application failed'})}})
 router.post('/pages/:pageId/review',async(req,res)=>{try{
  const {taskId:id,expectedRevision,reviewed,...extra}=req.body??{}
  if(Object.keys(extra).length||!taskId(id)||typeof expectedRevision!=='string'||typeof reviewed!=='boolean')throw new Error('Choose the exact reviewed crop revision')
  const {source,chapterId}=await reviewPage(req.params.pageId)
  const before=await readManagedCropReview(source.folder,source.filename)
  if(before.taskId!==id)throw new Error('Task changed; reopen review')
  res.json({...await setManagedCropReview(source.folder,source.filename,expectedRevision,reviewed),chapterId,filename:source.filename})
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Managed review not saved'})}})
 router.post('/pages/:pageId/cut',async(req,res)=>{try{
  const {taskId:id,expectedRevision,...extra}=req.body??{}
  if(Object.keys(extra).length||!taskId(id)||typeof expectedRevision!=='string')throw new Error('Choose the exact reviewed crop revision')
  const {source,chapterId}=await reviewPage(req.params.pageId)
  const before=await readManagedCropReview(source.folder,source.filename)
  if(before.taskId!==id)throw new Error('Task changed; reopen review')
  res.json({...await cutReviewedManagedCrop(source.folder,source.filename,expectedRevision),chapterId,filename:source.filename})
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Managed cut unavailable'})}})
 router.get('/pages/:pageId/cut/:filename',async(req,res)=>{try{
  if(Object.keys(req.query).join(',')!=='revision'||typeof req.query.revision!=='string')throw new Error('Exact crop revision required')
  const {source}=await reviewPage(req.params.pageId)
  const bytes=await reviewedManagedCropFile(source.folder,source.filename,req.query.revision,req.params.filename)
  res.type('image/png').set('Cache-Control','no-store').send(bytes)
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Managed cut output unavailable'})}})
 router.post('/pages/:pageId/rebind',async(req,res)=>{try{
  const {expectedPreviousTaskId,...extra}=req.body??{}
  if(Object.keys(extra).length||!identifier(req.params.pageId)||!taskId(expectedPreviousTaskId))throw new Error('Exact prior task and source page required')
  const source=await input(req.params.pageId)
  res.json(await service().rebind(source,expectedPreviousTaskId))
 }catch(error){res.status(409).json({error:(error as Error).message})}})
 router.get('/options',async(_req,res)=>{try{
  const overview=await getPhoneOverview(null)
  const series=await db.series.findMany({select:{id:true,title:true},orderBy:{title:'asc'},take:1000})
  res.json({enabled:configured(),workspaceId:process.env.MANAGED_WORKSPACE_ID??null,series,profiles:overview.profiles.map(p=>({device:p.device,deviceName:p.phone,id:p.profileId,name:p.name})),policy:'ChatGPT default model; no model or effort selection. One page, no automatic retry or fallback.'})
 }catch{res.status(503).json({error:'Pilot options unavailable'})}})
 router.get('/tasks/:taskId',async(req,res)=>{try{
  if(!taskId(req.params.taskId))throw new Error('Invalid task')
  res.json(await authority().timeline(req.params.taskId))
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Task unavailable'})}})
 router.post('/start',async(req,res)=>{try{
  const {pageId,deviceId,profileId,...extra}=req.body??{}
  if(Object.keys(extra).length||![pageId,deviceId,profileId].every(identifier))throw new Error('Choose one page and an existing phone/profile')
  const pilot=service(),overview=await getPhoneOverview(null)
  if(!overview.profiles.some(p=>p.device===deviceId&&p.profileId===profileId))throw new Error('Choose a known phone/profile')
  if(overview.runs.some(r=>r.device===deviceId)||overview.working.some(w=>w.device===deviceId)||(await productionAutomation.list()).some(j=>j.status==='running'&&productionDevices(j.config).some(d=>d.device===deviceId)))throw new Error('Stop existing production work before enrolling this phone')
  const page=await input(pageId)
  await pilot.enroll(deviceId,profileId)
  res.json(await pilot.start(page,deviceId,profileId))
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Pilot could not start'})}})
 router.post(['/import','/import-recovered'],async(req,res)=>{try{
  const {pageId,taskId:id,...extra}=req.body??{}
  if(Object.keys(extra).length||!identifier(pageId)||!taskId(id))throw new Error('Choose the current page/task')
  const source=await input(pageId);const imported=await managedProductionCoordinator.withLease(authority(),async fenced=>new ManagedCropPilot(fenced).import(source,id,req.path==='/import-recovered'))
  res.json({task:imported.task})
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Saved output not ready for import'})}})
 router.post('/pages/:pageId/transfer-unsent',async(req,res)=>{try{
  const {taskId:id,attemptId,generation,fingerprint,stopCommandId,deviceId,profileId,...extra}=req.body??{}
  if(Object.keys(extra).length||!taskId(id)||![attemptId,stopCommandId,deviceId,profileId].every(identifier)||!Number.isSafeInteger(generation)||generation<1||!(/^[a-f0-9]{64}$/).test(fingerprint))throw new Error('Refresh the exact stopped attempt and choose a different paired target')
  const source=await input(req.params.pageId)
  const jobs=await productionAutomation.list()
  if(jobs.some(j=>j.config.managedCrop&&j.command?.managedTaskIds?.includes(id)))throw new Error('Use the production card to pause and hand off this exact saved run. This control transfers only standalone pilot tasks.')
  const overview=await getPhoneOverview(null)
  if(!overview.profiles.some(p=>p.device===deviceId&&p.profileId===profileId))throw new Error('Choose a known paired target')
  if(overview.runs.some(r=>r.device===deviceId)||overview.working.some(w=>w.device===deviceId)||jobs.some(j=>j.status==='running'&&productionDevices(j.config).some(d=>d.device===deviceId)))throw new Error('Stop existing target production before transfer')
  res.json(await service().transfer(source,{taskId:id,attemptId,generation,fingerprint,stopCommandId},deviceId,profileId))
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Transfer unavailable; retain the current task'})}})
 router.post('/stop',async(req,res)=>{try{
  const {taskId:id,cancel,...extra}=req.body??{}
  if(Object.keys(extra).length||!taskId(id)||typeof cancel!=='boolean')throw new Error('Choose the task and stop intent')
  res.json(await managedProductionCoordinator.withLease(authority(),fenced=>new ManagedCropPilot(fenced).stop(id,cancel)))
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Stop not recorded'})}})
 router.post('/resolve-upload-only',async(req,res)=>{try{
  const {taskId:id,reportId,confirmUploadOnly,...extra}=req.body??{}
  if(Object.keys(extra).length||!taskId(id)||!identifier(reportId)||confirmUploadOnly!==true)throw new Error('Review the exact upload-only worker report first')
  const a=authority(),current=await a.timeline(id)
  const report=(current as typeof current & {uploadOnlyReport?:{id:string;stopCommandId:string}}).uploadOnlyReport
  if(!current.attempt||!report||report.id!==reportId)throw new Error('Refresh the current worker evidence')
  res.json(await a.operation({action:'resolve_upload_only',taskId:id,attemptId:current.attempt.id,generation:current.task.generation,fingerprint:current.task.fingerprint,reportId,stopCommandId:report.stopCommandId,confirmUploadOnly:true}))
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Upload-only reconciliation unavailable'})}})
 router.post('/resolve-cancelled-submission',async(req,res)=>{try{
  const {taskId:id,reportId,confirmDiscard,...extra}=req.body??{}
  if(Object.keys(extra).length||!taskId(id)||!identifier(reportId)||confirmDiscard!==true)throw new Error('Review the exact cancelled submitted reply discard worker report first')
  const a=authority(),current=await a.timeline(id)
  const report=(current as typeof current & {cancelledSubmissionReport?:{id:string;stopCommandId:string}}).cancelledSubmissionReport
  if(!current.attempt||!report||report.id!==reportId)throw new Error('Refresh the current worker evidence')
  res.json(await a.operation({action:'resolve_cancelled_submission',taskId:id,attemptId:current.attempt.id,generation:current.task.generation,fingerprint:current.task.fingerprint,reportId,stopCommandId:report.stopCommandId,confirmDiscard:true}))
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Cancelled reply discard review unavailable'})}})
 router.post('/resolve-cancelled-unknown',async(req,res)=>{try{
  const {taskId:id,reportId,confirmAbandon,...extra}=req.body??{}
  if(Object.keys(extra).length||!taskId(id)||!identifier(reportId)||confirmAbandon!==true)throw new Error('Review the exact cancelled unknown abandonment worker report first')
  const a=authority(),current=await a.timeline(id)
  const report=(current as typeof current & {cancelledUnknownReport?:{id:string;stopCommandId:string}}).cancelledUnknownReport
  if(!current.attempt||!report||report.id!==reportId)throw new Error('Refresh the current worker evidence')
  res.json(await a.operation({action:'resolve_cancelled_unknown',taskId:id,attemptId:current.attempt.id,generation:current.task.generation,fingerprint:current.task.fingerprint,reportId,stopCommandId:report.stopCommandId,confirmAbandon:true}))
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Cancelled unknown abandonment unavailable'})}})
 router.post('/unpair',async(req,res)=>{try{
  const {deviceId,...extra}=req.body??{};if(Object.keys(extra).length||!identifier(deviceId))throw new Error('Choose the paired phone')
  res.json(await service().unpair(deviceId))
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Reconcile the phone before unpairing'})}})
 return router
}
