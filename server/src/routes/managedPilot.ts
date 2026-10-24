import {recoveryAllowedWhileDisabled} from '../services/recoveryAdmission.js'
import {recoveryDispositionTransport} from '../services/recoveryDispositionBridge.js'
import {parseDispositionIntent,parseDispositionReceipt,parseDispositionSnapshot} from '../services/recoveryDispositionProtocol.js'
import {AccountHandoffStudioBridge,accountHandoffTransport} from '../services/accountHandoffBridge.js'
import {CandidateAdoptionStudioBridge,candidateAdoptionTransport,candidateAdoptionStatusTransport} from '../services/candidateAdoptionBridge.js'
import {TargetContextStudioBridge,targetContextTransport,targetContextStatusTransport} from '../services/targetContextBridge.js'
import {targetPackageStatusTransport} from '../services/targetPackageBridge.js'
import {targetInputStatusTransport} from '../services/targetInputBridge.js'
import {FallbackPreflightBridge,fallbackPreflightTransport} from '../services/fallbackPreflightBridge.js'
import {RetainedBindingApprovalBridge,retainedBindingApprovalTransport} from '../services/retainedBindingApprovalBridge.js'
import {RecoveryDispatchBridge,recoveryDispatchTransport} from '../services/recoveryDispatchBridge.js'
import {ConversationRestorationBridge,conversationRestorationTransport} from '../services/conversationRestorationBridge.js'
import {CorrectionRecoveryBridge,correctionRecoveryTransport} from '../services/correctionRecoveryBridge.js'
import {KnownUiRepairBridge,knownUiRepairTransport} from '../services/knownUiRepairBridge.js'
import {UnsentNavigationBridge,unsentNavigationTransport} from '../services/unsentNavigationBridge.js'
import {recoveryStopTransport} from '../services/recoveryStopTransport.js'
import {recoveryUnitKey} from '../services/automationRecoveryPolicy.js'
import {recoveryExact} from '../services/managedSavedImportRecoveryProtocol.js'
import {executorEvidenceTransport,inspectExecutorEvidence} from '../services/executorEvidenceBridge.js'
import {AccountRecheckRecoveryBridge} from '../services/accountRecheckRecoveryBridge.js'
import {accountRecheckTransport} from '../services/accountRecheckRecoveryTransport.js'
import {SavedUploadRecoveryBridge} from '../services/savedUploadRecoveryBridge.js'
import {savedUploadRecoveryTransport} from '../services/managedSavedUploadRecovery.js'
import {resolveManagedCropInput} from '../services/managedArtifactImport.js'
import {cropTaskIdentity,TaskConflict} from '../services/managedTaskProtocol.js'
import {automationRecoveryForDatabase} from '../services/automationRecoveryDatabase.js'
import {AutomationRecoveryBridge} from '../services/automationRecoveryBridge.js'
import {SavedCropRecoveryBridge,resolveSavedCropScope,currentSavedCropInput,type SavedCropTarget} from '../services/savedCropRecoveryBridge.js'
import {savedImportRecoveryTransport} from '../services/managedSavedImportRecovery.js'
import {managedCropBinding} from '../services/managedCropProjection.js'
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
 router.post('/accounts',async(req,res)=>{try{const a=authority();await a.ready(['managed-accounts/1']);const body=req.body;if(!body||typeof body!=='object'||Array.isArray(body)||JSON.stringify(body).length>30000||!['policy','confirm','quota','cadence','observe','audit_recheck'].includes(body.action)||['schema','workspaceId'].some(k=>k in body))throw new Error('Supported bounded account action required');res.json(await a.accounts!(body))}catch(error){res.status(409).json({error:error instanceof Error?error.message:'Account update unavailable'})}})
 router.post('/accounts/select',async(req,res)=>{try{const {taskId:id,targets,...extra}=req.body??{};if(Object.keys(extra).length||!taskId(id))throw new Error('Exact task required');const a=authority();await a.ready(['managed-accounts/1']);res.json(await a.selectAccount!(id,targets))}catch(error){res.status(409).json({error:error instanceof Error?error.message:'Selection unavailable'})}})

 router.use((req,res,next)=>{
  const endpoint=req.path.split('/').at(-1)??''
  const recovery=new Set(['recovery-disposition','recovery-retained','recovery-dispatch','account-handoff','candidate-adoption','target-context','fallback-preflight','retained-binding','conversation-restoration','correction-recovery','ui-repair','navigation-recovery','account-recovery','upload-recovery','recovery','automation-recovery'])
  if(req.method==='POST'&&recovery.has(endpoint)&&process.env.MANAGED_AUTOMATIC_RECOVERY!=='1'&&!recoveryAllowedWhileDisabled(req.body)){
   res.status(503).json({error:'Automatic recovery is off. Inspection, stop and retained receipt reconciliation remain available.'});return
  }
  next()
 })
 router.post('/recovery-disposition',async(req,res)=>{try{
  if(!configured()||Object.keys(req.query).length)throw new TaskConflict('Configured original recovery workspace required')
  const b=req.body
  if(b?.action==='inspect'){recoveryExact(b,['action','unit']);recoveryUnitKey(b.unit);if(b.unit.workspaceId!==process.env.MANAGED_WORKSPACE_ID)throw new TaskConflict('Original workspace required')}
  else {recoveryExact(b,['action','intent']);parseDispositionIntent(b.intent);if(!['apply','resolve'].includes(b.action)||b.intent.production!==null||b.intent.unit.workspaceId!==process.env.MANAGED_WORKSPACE_ID)throw new TaskConflict('Use the original production coordinator for a production disposition')}
  const call=recoveryDispositionTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db)),result=await call(b)
  if(b.action==='inspect')parseDispositionSnapshot(result,b.unit);else if(result!==null)parseDispositionReceipt(result)
  res.set('Cache-Control','no-store').json(result)
 }catch{res.status(409).json({error:'Recovery disposition is held or unconfirmed. Reconcile the original decision; charges and evidence remain retained.'})}})
 router.get('/recovery-retained',async(req,res)=>{try{
  if(Object.keys(req.query).length)throw new TaskConflict('No retained-recovery filters accepted')
  res.set('Cache-Control','no-store').json({items:await automationRecoveryForDatabase(db).retained(process.env.MANAGED_WORKSPACE_ID)})
 }catch{res.status(409).json({error:'Retained recovery records require inspection; no history was replaced.'})}})
 router.post('/recovery-retained',async(req,res)=>{try{
  if(Object.keys(req.query).length||JSON.stringify(req.body??null).length>8000)throw new TaskConflict('Bounded retained recovery action required')
  recoveryExact(req.body,['action','unit','expectedRevision']);const {action,unit,expectedRevision}=req.body
  recoveryUnitKey(unit)
  if(process.env.MANAGED_WORKSPACE_ID&&unit.workspaceId!==process.env.MANAGED_WORKSPACE_ID||!['pause','disable','cancel','reinspect','sync'].includes(action)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw new TaskConflict('Exact retained unit/action/revision required')
  const controller=automationRecoveryForDatabase(db),old=await controller.inspect(unit)
  if(!old||old.revision!==expectedRevision)throw new TaskConflict('Refresh retained recovery controls')
  if(action==='sync'){
   const row=(await controller.retained(unit.workspaceId)).find(r=>recoveryUnitKey(r.diagnosis.unit)===recoveryUnitKey(unit))
   if(!row?.stop)throw new TaskConflict('Original saved stop required')
   if(!row.stop.receipt){const receipt=await recoveryStopTransport(process.env.RELAY_URL??'',unit.workspaceId,process.env.MANAGED_STUDIO_TOKEN??'',process.env.RELAY_TOKEN,relayPauseForDatabase(db))(row.stop.intent);await controller.acknowledgeStop(receipt)}
  }else await controller.stop(unit,expectedRevision,action)
  res.set('Cache-Control','no-store').json({items:await controller.retained(process.env.MANAGED_WORKSPACE_ID)})
 }catch{res.status(409).json({error:'Relay confirmation or control is unconfirmed. Refresh retained records; a saved local hold remains in force.'})}})
 const input=(pageId:string)=>managedPilotInput(db,pageId)
 function recoveryBridge(){
  authority() // Enforce the existing separate managed configuration without exposing it to the browser.
  const transport=savedImportRecoveryTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db))
  return new SavedCropRecoveryBridge({transport,assertAdmission:(unit,operation)=>automationRecoveryForDatabase(db).assertAdmission(unit,operation),enabled:()=>process.env.MANAGED_AUTOMATIC_RECOVERY==='1'&&process.env.MANAGED_SAVED_IMPORT_RECOVERY==='1',async resolve(pageId){
   if(!identifier(pageId))throw new Error('Exact source page required')
   const source=await input(pageId),binding=await managedCropBinding(source.folder,source.filename)
   let target:SavedCropTarget
   const scope=await resolveSavedCropScope(source,binding,authority(),()=>currentSavedCropInput(()=>input(pageId),async()=>{const latest=await input(pageId);return managedCropBinding(latest.folder,latest.filename)},target))
   target=scope.target
   return scope
  }})
 }
 router.post('/pages/:pageId/recovery-dispatch',async(req,res)=>{try{
  if(!configured()||!identifier(req.params.pageId)||Object.keys(req.query).length)throw new TaskConflict('Exact configured page required')
  const bridge=new RecoveryDispatchBridge({call:recoveryDispatchTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db)),diagnoses:automationRecoveryForDatabase(db),enabled:()=>process.env.MANAGED_RECOVERY_DISPATCH==='1'&&process.env.MANAGED_AUTOMATIC_RECOVERY==='1',resolve:async()=>{
   const source=await input(req.params.pageId),binding=await managedCropBinding(source.folder,source.filename),expected=await cropTaskIdentity(source.identity,source.spec)
   if(!binding||binding.task.id!==expected.taskId||binding.destination!==source.destination)throw new TaskConflict('Current original source binding required')
   await resolveManagedCropInput(source.identity,source.spec,source.sourceFile);const {task,attempt}=await authority().timeline(expected.taskId)
   if(!attempt||task.fingerprint!==expected.fingerprint)throw new TaskConflict('Current original attempt required')
   return {unit:{workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:task.generation,fingerprint:task.fingerprint},pageLabel:source.filename}
  }})
  res.set('Cache-Control','no-store').json(await bridge.perform(req.body))
 }catch{res.status(409).json({error:'Original phone delivery is held. Inspect its exact grant and retained delivery receipt.'})}})
 router.post('/pages/:pageId/account-handoff',async(req,res)=>{try{
  if(req.body?.action==='approve')await automationRecoveryForDatabase(db).assertAdmission(req.body.unit,'handoff')
  if(!configured()||!identifier(req.params.pageId)||Object.keys(req.query).length)throw new TaskConflict('Exact configured page required')
  const bridge=new AccountHandoffStudioBridge({call:accountHandoffTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db)),enabled:()=>process.env.MANAGED_ACCOUNT_HANDOFF==='1'&&process.env.MANAGED_CANDIDATE_ADOPTION==='1'&&process.env.MANAGED_AUTOMATIC_RECOVERY==='1',resolve:async()=>{
   const source=await input(req.params.pageId),binding=await managedCropBinding(source.folder,source.filename),expected=await cropTaskIdentity(source.identity,source.spec)
   if(!binding||binding.task.id!==expected.taskId||binding.destination!==source.destination)throw new TaskConflict('Current original source binding required')
   const verified=await resolveManagedCropInput(source.identity,source.spec,source.sourceFile),{task,attempt}=await authority().timeline(expected.taskId)
   if(!attempt||task.fingerprint!==expected.fingerprint)throw new TaskConflict('Current original attempt required')
   return {unit:{workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:attempt.generation,fingerprint:task.fingerprint},source:verified.source}
  }})
  res.set('Cache-Control','no-store').json(await bridge.perform(req.body))
 }catch{res.status(409).json({error:'Account handoff is held or unconfirmed. Inspect the original handoff and current owner before further action.'})}})
 router.post('/pages/:pageId/candidate-adoption',async(req,res)=>{try{
  if(req.body?.action==='approve')await automationRecoveryForDatabase(db).assertAdmission(req.body.unit,'handoff')
  if(!configured()||!identifier(req.params.pageId)||Object.keys(req.query).length)throw new TaskConflict('Exact configured page required')
  const bridge=new CandidateAdoptionStudioBridge({call:candidateAdoptionTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db)),contexts:targetContextStatusTransport(targetContextTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db))),enabled:()=>process.env.MANAGED_CANDIDATE_ADOPTION==='1'&&process.env.MANAGED_AUTOMATIC_RECOVERY==='1',resolve:async()=>{
   const source=await input(req.params.pageId),binding=await managedCropBinding(source.folder,source.filename),expected=await cropTaskIdentity(source.identity,source.spec)
   if(!binding||binding.task.id!==expected.taskId||binding.destination!==source.destination)throw new TaskConflict('Current original source binding required')
   const verified=await resolveManagedCropInput(source.identity,source.spec,source.sourceFile),{task,attempt}=await authority().timeline(expected.taskId)
   if(!attempt||task.fingerprint!==expected.fingerprint)throw new TaskConflict('Current original attempt required')
   return {unit:{workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:attempt.generation,fingerprint:task.fingerprint},source:verified.source}
  }})
  res.set('Cache-Control','no-store').json(await bridge.perform(req.body))
 }catch{res.status(409).json({error:'Candidate retention approval is unconfirmed. Inspect its original action and budget; no ownership transfer or provider work was authorized.'})}})
 router.post('/pages/:pageId/target-context',async(req,res)=>{try{
  if(!configured()||!identifier(req.params.pageId)||Object.keys(req.query).length)throw new TaskConflict('Exact configured page required')
  const bridge=new TargetContextStudioBridge({call:targetContextTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db)),packages:targetPackageStatusTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db)),resolve:async()=>{
   const source=await input(req.params.pageId),binding=await managedCropBinding(source.folder,source.filename),expected=await cropTaskIdentity(source.identity,source.spec)
   if(!binding||binding.task.id!==expected.taskId||binding.destination!==source.destination)throw new TaskConflict('Current original source binding required')
   const verified=await resolveManagedCropInput(source.identity,source.spec,source.sourceFile),{task,attempt}=await authority().timeline(expected.taskId)
   if(!attempt||task.fingerprint!==expected.fingerprint)throw new TaskConflict('Current original attempt required')
   return {unit:{workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:attempt.generation,fingerprint:task.fingerprint},source:verified.source}
  }})
  res.set('Cache-Control','no-store').json(await bridge.perform(req.body))
 }catch{res.status(409).json({error:'Context review is unconfirmed. Inspect its original receipt; no view adoption or handoff was authorized.'})}})
 router.post('/pages/:pageId/fallback-preflight',async(req,res)=>{try{
  if(!configured()||!identifier(req.params.pageId)||Object.keys(req.query).length)throw new TaskConflict('Exact configured page required')
  const bridge=new FallbackPreflightBridge({adoptionChecks:candidateAdoptionStatusTransport(candidateAdoptionTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db))),contextChecks:targetContextStatusTransport(targetContextTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db))),packageChecks:targetPackageStatusTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db)),sourceChecks:targetInputStatusTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db)),call:fallbackPreflightTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db)),resolve:async()=>{
   const source=await input(req.params.pageId),binding=await managedCropBinding(source.folder,source.filename),expected=await cropTaskIdentity(source.identity,source.spec)
   if(!binding||binding.task.id!==expected.taskId||binding.destination!==source.destination)throw new TaskConflict('Current original source binding required')
   const verified=await resolveManagedCropInput(source.identity,source.spec,source.sourceFile);const {task,attempt}=await authority().timeline(expected.taskId)
   if(!attempt||task.fingerprint!==expected.fingerprint)throw new TaskConflict('Current original attempt required')
   return {unit:{workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:task.generation,fingerprint:task.fingerprint},pageLabel:source.filename,source:verified.source}
  }})
  res.set('Cache-Control','no-store').json(await bridge.inspect(req.body))
 }catch{res.status(409).json({error:'Fallback inspection unavailable. Preserve the original task and outcomes; no handoff or execution was authorized.'})}})
 router.post('/pages/:pageId/retained-binding',async(req,res)=>{try{
  if(!configured()||!identifier(req.params.pageId)||Object.keys(req.query).length)throw new TaskConflict('Exact configured page required')
  const bridge=new RetainedBindingApprovalBridge({call:retainedBindingApprovalTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db)),diagnoses:automationRecoveryForDatabase(db),enabled:()=>process.env.MANAGED_CONVERSATION_RESTORATION==='1'&&process.env.MANAGED_AUTOMATIC_RECOVERY==='1',resolve:async()=>{
   const source=await input(req.params.pageId),binding=await managedCropBinding(source.folder,source.filename),expected=await cropTaskIdentity(source.identity,source.spec)
   if(!binding||binding.task.id!==expected.taskId||binding.destination!==source.destination)throw new TaskConflict('Current original source binding required')
   await resolveManagedCropInput(source.identity,source.spec,source.sourceFile);const {task,attempt}=await authority().timeline(expected.taskId)
   if(!attempt||task.fingerprint!==expected.fingerprint)throw new TaskConflict('Current original attempt required')
   return {unit:{workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:task.generation,fingerprint:task.fingerprint},pageLabel:source.filename}
  }})
  res.set('Cache-Control','no-store').json(await bridge.perform(req.body))
 }catch{res.status(409).json({error:'Retained binding approval is unconfirmed. Inspect the exact original offer and receipt; no repeated association is authorized.'})}})
 router.post('/pages/:pageId/conversation-restoration',async(req,res)=>{try{
  if(!configured()||!identifier(req.params.pageId)||Object.keys(req.query).length)throw new TaskConflict('Exact configured page required')
  const bridge=new ConversationRestorationBridge({call:conversationRestorationTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db)),diagnoses:automationRecoveryForDatabase(db),enabled:()=>process.env.MANAGED_CONVERSATION_RESTORATION==='1'&&process.env.MANAGED_AUTOMATIC_RECOVERY==='1',resolve:async()=>{
   const source=await input(req.params.pageId),binding=await managedCropBinding(source.folder,source.filename),expected=await cropTaskIdentity(source.identity,source.spec)
   if(!binding||binding.task.id!==expected.taskId||binding.destination!==source.destination)throw new TaskConflict('Current original source binding required')
   await resolveManagedCropInput(source.identity,source.spec,source.sourceFile);const {task,attempt}=await authority().timeline(expected.taskId)
   if(!attempt||task.fingerprint!==expected.fingerprint)throw new TaskConflict('Current original attempt required')
   return {unit:{workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:task.generation,fingerprint:task.fingerprint},pageLabel:source.filename}
  }})
  res.set('Cache-Control','no-store').json(await bridge.perform(req.body))
 }catch{res.status(409).json({error:'Original conversation restoration is held. Preserve the original live view, private anchor and exact receipt.'})}})
 router.post('/pages/:pageId/correction-recovery',async(req,res)=>{try{
  if(!configured()||!identifier(req.params.pageId)||Object.keys(req.query).length)throw new TaskConflict('Exact configured page required')
  const bridge=new CorrectionRecoveryBridge({call:correctionRecoveryTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db)),diagnoses:automationRecoveryForDatabase(db),enabled:()=>process.env.MANAGED_CORRECTION_RECOVERY==='1'&&process.env.MANAGED_AUTOMATIC_RECOVERY==='1',resolve:async()=>{
   const source=await input(req.params.pageId),binding=await managedCropBinding(source.folder,source.filename),expected=await cropTaskIdentity(source.identity,source.spec)
   if(!binding||binding.task.id!==expected.taskId||binding.destination!==source.destination)throw new TaskConflict('Current original source binding required')
   await resolveManagedCropInput(source.identity,source.spec,source.sourceFile);const {task,attempt}=await authority().timeline(expected.taskId)
   if(!attempt||task.fingerprint!==expected.fingerprint)throw new TaskConflict('Current original attempt required')
   return {unit:{workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:task.generation,fingerprint:task.fingerprint},pageLabel:source.filename}
  }})
  res.set('Cache-Control','no-store').json(await bridge.perform(req.body))
 }catch{res.status(409).json({error:'Correction is held. Preserve the original draft, grant and checkpoint; inspect its exact receipt before continuing.'})}})
 router.post('/pages/:pageId/ui-repair',async(req,res)=>{try{
  if(!configured()||!identifier(req.params.pageId)||Object.keys(req.query).length)throw new TaskConflict('Exact configured page required')
  const bridge=new KnownUiRepairBridge({call:knownUiRepairTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db)),diagnoses:automationRecoveryForDatabase(db),enabled:()=>process.env.MANAGED_AUTOMATIC_RECOVERY==='1'&&process.env.MANAGED_KNOWN_UI_REPAIR==='1',resolve:async()=>{
   const source=await input(req.params.pageId),binding=await managedCropBinding(source.folder,source.filename),expected=await cropTaskIdentity(source.identity,source.spec)
   if(!binding||binding.task.id!==expected.taskId||binding.destination!==source.destination)throw new TaskConflict('Current original source binding required')
   await resolveManagedCropInput(source.identity,source.spec,source.sourceFile);const {task,attempt}=await authority().timeline(expected.taskId)
   if(!attempt||task.fingerprint!==expected.fingerprint)throw new TaskConflict('Current original attempt required')
   return {unit:{workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:task.generation,fingerprint:task.fingerprint},pageLabel:source.filename}
  }})
  res.set('Cache-Control','no-store').json(await bridge.perform(req.body))
 }catch{res.status(409).json({error:'Original known UI repair is held. Inspect the same original page and exact promotion; no generic dismissal or provider work is authorized.'})}})
 router.post('/pages/:pageId/navigation-recovery',async(req,res)=>{try{
  if(!configured()||!identifier(req.params.pageId)||Object.keys(req.query).length)throw new TaskConflict('Exact configured page required')
  const bridge=new UnsentNavigationBridge({call:unsentNavigationTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db)),diagnoses:automationRecoveryForDatabase(db),enabled:()=>process.env.MANAGED_AUTOMATIC_RECOVERY==='1'&&process.env.MANAGED_UNSENT_NAVIGATION_RECOVERY==='1',resolve:async()=>{
   const source=await input(req.params.pageId),binding=await managedCropBinding(source.folder,source.filename),expected=await cropTaskIdentity(source.identity,source.spec)
   if(!binding||binding.task.id!==expected.taskId||binding.destination!==source.destination)throw new TaskConflict('Current original source binding required')
   await resolveManagedCropInput(source.identity,source.spec,source.sourceFile);const {task,attempt}=await authority().timeline(expected.taskId)
   if(!attempt||task.fingerprint!==expected.fingerprint)throw new TaskConflict('Current original attempt required')
   return {unit:{workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:task.generation,fingerprint:task.fingerprint},pageLabel:source.filename}
  }})
  res.set('Cache-Control','no-store').json(await bridge.perform(req.body))
 }catch{res.status(409).json({error:'Original navigation is held. Inspect the same phone/view/grant; no replacement page or provider request was authorized.'})}})
 router.post('/pages/:pageId/executor-evidence',async(req,res)=>{try{
  if(!configured()||!identifier(req.params.pageId)||Object.keys(req.query).length||!req.body||Object.keys(req.body).length)throw new TaskConflict('Exact current page inspection required')
  const source=await input(req.params.pageId),binding=await managedCropBinding(source.folder,source.filename),expected=await cropTaskIdentity(source.identity,source.spec)
  if(!binding||binding.task.id!==expected.taskId||binding.destination!==source.destination)throw new TaskConflict('Current original source binding required')
  await resolveManagedCropInput(source.identity,source.spec,source.sourceFile)
  const {task,attempt}=await authority().timeline(expected.taskId)
  if(!attempt||task.fingerprint!==expected.fingerprint)throw new TaskConflict('Current original attempt required')
  const unit={workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:task.generation,fingerprint:task.fingerprint}
  const inventory=await executorEvidenceTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db))(unit)
  const current=await input(req.params.pageId);await resolveManagedCropInput(current.identity,current.spec,current.sourceFile)
  const currentBinding=await managedCropBinding(current.folder,current.filename),latest=await authority().timeline(expected.taskId)
  if((await cropTaskIdentity(current.identity,current.spec)).fingerprint!==unit.fingerprint||currentBinding?.task.id!==unit.taskId||currentBinding?.destination!==current.destination||latest.attempt?.id!==unit.attemptId||latest.task.generation!==unit.generation)throw new TaskConflict('Page/attempt changed while inspecting executor evidence')
  res.set('Cache-Control','no-store').json(await inspectExecutorEvidence(unit,inventory,automationRecoveryForDatabase(db)))
 }catch{res.status(409).json({error:'Executor diagnosis is held. Retained observations and original work remain unchanged.'})}})
 router.post('/pages/:pageId/account-recovery',async(req,res)=>{try{
  if(!configured()||!identifier(req.params.pageId)||Object.keys(req.query).length)throw new TaskConflict('Exact configured page required')
  const transport=accountRecheckTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db))
  const bridge=new AccountRecheckRecoveryBridge({transport,diagnoses:automationRecoveryForDatabase(db),enabled:()=>process.env.MANAGED_AUTOMATIC_RECOVERY==='1'&&process.env.MANAGED_ACCOUNT_RECHECK_RECOVERY==='1',resolve:async()=>{
   const source=await input(req.params.pageId),binding=await managedCropBinding(source.folder,source.filename),expected=await cropTaskIdentity(source.identity,source.spec)
   if(!binding||binding.task.id!==expected.taskId||binding.destination!==source.destination)throw new TaskConflict('Current original source binding required')
   await resolveManagedCropInput(source.identity,source.spec,source.sourceFile)
   const {task,attempt}=await authority().timeline(expected.taskId)
   if(!attempt||task.fingerprint!==expected.fingerprint)throw new TaskConflict('Original attempt required; queued selection remains under Accounts')
   return {unit:{workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:task.generation,fingerprint:task.fingerprint},outcome:attempt.submission,canonical:!!task.canonical,pageLabel:source.filename}
  }})
  res.set('Cache-Control','no-store').json(await bridge.perform(req.body))
 }catch{res.status(409).json({error:'Account recheck recovery is held. Inspect the original task/account/audit receipt; no readiness or capacity was inferred.'})}})
 router.post('/pages/:pageId/upload-recovery',async(req,res)=>{try{
  if(!configured()||!identifier(req.params.pageId)||Object.keys(req.query).length)throw new TaskConflict('Exact configured page required')
  const transport=savedUploadRecoveryTransport(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID!,process.env.MANAGED_STUDIO_TOKEN!,process.env.RELAY_TOKEN,relayPauseForDatabase(db))
  const bridge=new SavedUploadRecoveryBridge({transport,diagnoses:automationRecoveryForDatabase(db),enabled:()=>process.env.MANAGED_AUTOMATIC_RECOVERY==='1'&&process.env.MANAGED_SAVED_UPLOAD_RECOVERY==='1',resolve:async()=>{
   const source=await input(req.params.pageId),binding=await managedCropBinding(source.folder,source.filename),expected=await cropTaskIdentity(source.identity,source.spec)
   if(!binding||binding.task.id!==expected.taskId||binding.destination!==source.destination)throw new TaskConflict('Current original source binding required')
   await resolveManagedCropInput(source.identity,source.spec,source.sourceFile)
   const {task,attempt}=await authority().timeline(expected.taskId)
   if(!attempt||attempt.submission!=='saved'||!attempt.checkpointRef||task.fingerprint!==expected.fingerprint)throw new TaskConflict('Original saved checkpoint acknowledgment required')
   return {unit:{workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:task.generation,fingerprint:task.fingerprint},pageLabel:source.filename}
  }})
  res.set('Cache-Control','no-store').json(await bridge.perform(req.body))
 }catch{res.status(409).json({error:'Saved-upload recovery is held. Inspect the original phone checkpoint and current page; no replacement upload was granted.'})}})
 router.get('/pages/:pageId/recovery',async(req,res)=>{try{
  if(Object.keys(req.query).length)throw new Error('Unexpected recovery query')
  res.set('Cache-Control','no-store').json({targets:await recoveryBridge().targets(req.params.pageId)})
 }catch{res.status(409).json({error:'Saved crop recovery unavailable. Refresh the published page and its current binding.'})}})
 router.post('/pages/:pageId/recovery',async(req,res)=>{try{
  if(Object.keys(req.query).length||JSON.stringify(req.body??null).length>8000)throw new Error('Bounded recovery action required')
  res.set('Cache-Control','no-store').json(await recoveryBridge().perform(req.params.pageId,req.body))
 }catch{res.status(409).json({error:'Recovery outcome is unconfirmed. Inspect the original action before continuing.'})}})


 // Explicit inspection only. No browser-supplied failure, evidence or budget.
 router.post('/pages/:pageId/automation-recovery',async(req,res)=>{try{
  if(!configured()||!identifier(req.params.pageId)||Object.keys(req.query).length)throw new Error('Exact managed page required')
  const bridge=new AutomationRecoveryBridge({controller:automationRecoveryForDatabase(db),workspaceId:process.env.MANAGED_WORKSPACE_ID!,enabled:()=>process.env.MANAGED_AUTOMATIC_RECOVERY==='1',inspect:target=>recoveryBridge().perform(req.params.pageId,{action:'inspect',target,expectedRevision:0})})
  res.set('Cache-Control','no-store').json(await bridge.perform(req.body))
 }catch{res.status(409).json({error:'Automation recovery is held. Refresh the current page recovery inspection.'})}})

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
