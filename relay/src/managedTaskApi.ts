import {RecoveryDispositionAuthority,recoveryDispositionApi} from './recoveryDisposition'
import {AccountHandoffAuthority,accountHandoffApi} from './accountHandoff'
import {CandidateAdoptionAuthority,candidateAdoptionApi} from './candidateAdoption'
import {TargetContextAuthority,targetContextApi} from './targetContext'
import {TargetPackageAuthority,targetPackageApi} from './targetPackage'
import {TargetInputAuthority,targetInputApi} from './targetInput'
import {FallbackPreflightAuthority,fallbackPreflightApi} from './fallbackPreflight'
import {RecoveryDispatch} from './recoveryDispatch'
import {recoveryDispatchApi} from './recoveryDispatchApi'
import {ConversationRestoration} from './conversationRestoration'
import {conversationRestorationApi} from './conversationRestorationApi'
import {CorrectionRecovery} from './correctionRecovery'
import {correctionRecoveryApi} from './correctionRecoveryApi'
import {KnownUiRepair} from './knownUiRepair'
import {knownUiRepairApi} from './knownUiRepairApi'
import {UnsentNavigation} from './unsentNavigation'
import {unsentNavigationApi} from './unsentNavigationApi'
import {RecoveryStops,recoveryStopsApi} from './recoveryStops'
import {ExecutorEvidenceAuthority,executorEvidenceApi} from './executorEvidence'
import {AccountRecheckRecovery} from './accountRecheckRecovery'
import {accountRecheckRecoveryApi} from './accountRecheckRecoveryApi'
import {SavedUploadRecovery} from './savedUploadRecovery'
import {savedUploadRecoveryApi} from './savedUploadRecoveryApi'
import {SavedImportRecovery} from './savedImportRecovery'
import {savedImportRecoveryApi} from './savedImportRecoveryApi'
import {accountApi} from './accountApi'
import {AccountWaiting} from './accountAuthority'
import {exact,accountIdValid,ACCOUNTS_SCHEMA} from '../../server/src/services/managedAccountsProtocol'
import {parseManagedReconnect} from '../../server/src/services/managedReconnect'
import { TaskAuthority, type TaskSql } from './taskAuthority'
import { artifactHash, artifactRef, validateManagedCrop, type ManagedArtifactRecord } from '../../server/src/services/managedCropArtifact'
import { boundedBody, readManagedArtifact, storeManagedArtifact, type ManagedArtifactBucket } from './managedArtifactStorage'
import { parseManagedOperation, TaskConflict, MANAGED_CAPABILITIES, type TaskPrincipal } from '../../server/src/services/managedTaskProtocol'
import {DEFAULT_CROP_CAPABILITY,SLICED_CROP_CAPABILITY} from '../../server/src/services/managedCropPilotPolicy'

export interface ManagedTaskEnvironment {
  MANAGED_ACCOUNT_HANDOFF?: string
  MANAGED_CANDIDATE_ADOPTION?: string
  MANAGED_AUTOMATIC_RECOVERY?: string
  MANAGED_RECOVERY_DISPATCH?: string
  MANAGED_ARTIFACTS?: ManagedArtifactBucket
  RELAY_TOKEN?: string
  MANAGED_SAVED_IMPORT_RECOVERY?: string
  MANAGED_SAVED_UPLOAD_RECOVERY?: string
  MANAGED_ACCOUNT_RECHECK_RECOVERY?: string
  MANAGED_EXECUTOR_EVIDENCE?: string
  MANAGED_CONVERSATION_RESTORATION?: string
  MANAGED_CORRECTION_RECOVERY?: string
  MANAGED_KNOWN_UI_REPAIR?: string
  MANAGED_UNSENT_NAVIGATION_RECOVERY?: string
  MANAGED_CROP_PAGE?: string
  MANAGED_WORKSPACE_ID?: string
  MANAGED_STUDIO_TOKEN?: string
  /** Secret JSON object of registered device IDs to distinct device tokens. Never sent to clients. */
  MANAGED_DEVICE_TOKENS?: string
}
const deviceId=(v:string)=>/^[A-Za-z0-9_-]{1,128}$/.test(v)
const validToken=(v:unknown):v is string=>typeof v==='string'&&v.length>=32&&v.length<=256
export function managedEnabled(env:ManagedTaskEnvironment):boolean {
 return env.MANAGED_CROP_PAGE==='1'&&deviceId(env.MANAGED_WORKSPACE_ID??'')&&validToken(env.MANAGED_STUDIO_TOKEN)
}
/** Compare equal-length tokens without a data-dependent early exit. No credential is returned or logged. */
function equalToken(a:string,b:string):boolean {
 const enc=new TextEncoder(),left=enc.encode(a),right=enc.encode(b)
 let different=left.length^right.length
 for(let i=0;i<Math.max(left.length,right.length);i++)different|=(left[i]??0)^(right[i]??0)
 return different===0
}
export function managedPrincipal(request:Request,env:ManagedTaskEnvironment):TaskPrincipal|null {
 if(!managedEnabled(env)||env.MANAGED_STUDIO_TOKEN===env.RELAY_TOKEN)return null
 const match=/^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization')??'')
 if(!match || !validToken(match[1]))return null
 const token=match[1]
 let devices:Record<string,unknown>
 try {const parsed=JSON.parse(env.MANAGED_DEVICE_TOKENS??'{}');if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return null;devices=parsed} catch{return null}
 // Misconfiguration must fail closed, including a phone receiving the Studio key or duplicate keys.
 const values=Object.values(devices)
 if(Object.keys(devices).length>8||Object.keys(devices).some(k=>!deviceId(k))||values.some(v=>!validToken(v)||v===env.RELAY_TOKEN||equalToken(v,env.MANAGED_STUDIO_TOKEN!))||new Set(values).size!==values.length)return null
 if(equalToken(token,env.MANAGED_STUDIO_TOKEN!))return {role:'studio'}
 for(const [device,key] of Object.entries(devices))if(equalToken(token,key as string))return {role:'phone',deviceId:device}
 return null
}
export class ManagedTaskApi {
 private disposition:RecoveryDispositionAuthority
 private accountHandoff:AccountHandoffAuthority
 private candidateAdoption:CandidateAdoptionAuthority
 private targetContext:TargetContextAuthority
 private targetPackage:TargetPackageAuthority
 private targetInput:TargetInputAuthority
 private fallbackPreflight:FallbackPreflightAuthority
 private dispatch:RecoveryDispatch
 private executorEvidence:ExecutorEvidenceAuthority
 private recoveryStops:RecoveryStops
 private conversationRestoration:ConversationRestoration
 private correctionRecovery:CorrectionRecovery
 private uiRepairRecovery:KnownUiRepair
 private navigationRecovery:UnsentNavigation
 private authority:TaskAuthority
 private savedImportRecovery:SavedImportRecovery
 private savedUploadRecovery:SavedUploadRecovery
 private accountRecheckRecovery:AccountRecheckRecovery
 constructor(private sql:TaskSql,transaction:<T>(work:()=>T)=>T,private env:ManagedTaskEnvironment,private now=()=>new Date().toISOString()) {
  this.authority=new TaskAuthority(sql,transaction,now,()=>crypto.randomUUID(),()=>this.env.MANAGED_ACCOUNT_HANDOFF==='1'&&this.env.MANAGED_CANDIDATE_ADOPTION==='1'&&this.env.MANAGED_AUTOMATIC_RECOVERY==='1')
  this.fallbackPreflight=new FallbackPreflightAuthority(sql,transaction,this.authority,()=>Date.parse(now()))
  this.targetInput=new TargetInputAuthority(sql,transaction,this.authority,this.fallbackPreflight,()=>Date.parse(now()))
  this.targetPackage=new TargetPackageAuthority(sql,transaction,this.authority,this.targetInput,()=>Date.parse(now()))
  this.targetContext=new TargetContextAuthority(sql,transaction,this.authority,this.targetPackage,()=>Date.parse(now()))
  this.accountHandoff=new AccountHandoffAuthority(sql,transaction,this.authority,this.targetContext,()=>this.env.MANAGED_ACCOUNT_HANDOFF==='1'&&this.env.MANAGED_CANDIDATE_ADOPTION==='1'&&this.env.MANAGED_AUTOMATIC_RECOVERY==='1',()=>Date.parse(now()))
  this.candidateAdoption=new CandidateAdoptionAuthority(sql,transaction,this.authority,this.targetContext,()=>this.env.MANAGED_CANDIDATE_ADOPTION==='1'&&this.env.MANAGED_AUTOMATIC_RECOVERY==='1',()=>Date.parse(now()))
  this.conversationRestoration=new ConversationRestoration(sql,transaction,this.authority,()=>Date.parse(now()))
  this.correctionRecovery=new CorrectionRecovery(sql,transaction,this.authority,()=>Date.parse(now()))
  this.uiRepairRecovery=new KnownUiRepair(sql,transaction,this.authority,()=>Date.parse(now()))
  this.navigationRecovery=new UnsentNavigation(sql,transaction,this.authority,()=>Date.parse(now()))
  this.executorEvidence=new ExecutorEvidenceAuthority(sql,transaction,this.authority,()=>Date.parse(now()))
  this.accountRecheckRecovery=new AccountRecheckRecovery(sql,transaction,this.authority,()=>Date.parse(now()),()=>this.env.MANAGED_ACCOUNT_RECHECK_RECOVERY==='1')
  this.recoveryStops=new RecoveryStops(sql,transaction,this.authority,this.accountRecheckRecovery,()=>Date.parse(now()))
  this.disposition=new RecoveryDispositionAuthority(sql,transaction,this.authority,this.recoveryStops,this.accountHandoff,this.candidateAdoption,()=>Date.parse(now()))
  this.savedUploadRecovery=new SavedUploadRecovery(sql,transaction,this.authority,()=>Date.parse(now()))
  this.savedImportRecovery=new SavedImportRecovery(sql,transaction,this.authority,()=>Date.parse(now()))
  this.dispatch=new RecoveryDispatch(sql,transaction,this.authority,()=>this.env.MANAGED_RECOVERY_DISPATCH==='1',kind=>({saved_upload:this.env.MANAGED_SAVED_UPLOAD_RECOVERY,navigate:this.env.MANAGED_UNSENT_NAVIGATION_RECOVERY,known_ui:this.env.MANAGED_KNOWN_UI_REPAIR,correct_output:this.env.MANAGED_CORRECTION_RECOVERY,restore_conversation:this.env.MANAGED_CONVERSATION_RESTORATION})[kind]==='1',(actor,kind,f)=>{
   if(kind==='saved_upload'){const c=this.savedUploadRecovery.context(actor,f);return !c.task.canonical&&c.attempt.phase==='result_saved'}
   return kind==='navigate'?this.navigationRecovery.status(actor,f).admissionReady:kind==='known_ui'?this.uiRepairRecovery.status(actor,f).admissionReady:kind==='correct_output'?this.correctionRecovery.status(actor,f).admissionReady:this.conversationRestoration.status(actor,f).admissionReady
  },()=>Date.parse(now()))
 }
 async handle(request:Request):Promise<Response> {
  const actor=managedPrincipal(request,this.env)
  if(!actor)return Response.json({error:'Managed task authentication required'},{status:401})
  try {
   const url=new URL(request.url)
   if(url.pathname==='/managed/recovery/disposition')return await recoveryDispositionApi(request,actor,this.disposition,this.env.MANAGED_WORKSPACE_ID!)
   if(url.pathname==='/managed/recovery/account-handoff')return await accountHandoffApi(request,actor,this.accountHandoff,this.env.MANAGED_WORKSPACE_ID!)
   if(url.pathname==='/managed/recovery/saved-upload/compatibility') {
    if(request.method!=='GET'||url.search)return new Response('Not found',{status:404})
    return Response.json({schema:'saved-transfer-compatibility/1',workspaceId:this.env.MANAGED_WORKSPACE_ID,artifactStorageConfigured:!!this.env.MANAGED_ARTIFACTS,
     capabilities:['saved-transfer-authority/1','saved-transfer-terminal/1','saved-transfer-upload-fence/1']},{headers:{'Cache-Control':'no-store'}})
   }
   if(url.pathname==='/managed/recovery/candidate-adoption')return await candidateAdoptionApi(request,actor,this.candidateAdoption,this.env.MANAGED_WORKSPACE_ID!)
   if(url.pathname==='/managed/recovery/target-context')return await targetContextApi(request,actor,this.targetContext,this.env.MANAGED_WORKSPACE_ID!)
   if(url.pathname==='/managed/recovery/target-package')return await targetPackageApi(request,actor,this.targetPackage,this.env.MANAGED_WORKSPACE_ID!)
   if(url.pathname==='/managed/recovery/target-input')return await targetInputApi(request,actor,this.targetInput,this.env.MANAGED_WORKSPACE_ID!)
   if(url.pathname==='/managed/recovery/fallback-preflight')return await fallbackPreflightApi(request,actor,this.fallbackPreflight,this.env.MANAGED_WORKSPACE_ID!)
   if(url.pathname==='/managed/recovery/dispatch')return await recoveryDispatchApi(request,actor,this.dispatch,this.env.MANAGED_WORKSPACE_ID!,this.env.MANAGED_RECOVERY_DISPATCH==='1')
   if(url.pathname==='/managed/recovery/original-conversation')return await conversationRestorationApi(request,actor,this.conversationRestoration,this.env.MANAGED_WORKSPACE_ID!,this.env.MANAGED_CONVERSATION_RESTORATION==='1',(f,id)=>f.retained?this.dispatch.assertRetainedManualEffect(actor,f,id):this.dispatch.assertEffect(actor,'restore_conversation',f,id),{enabled:this.env.MANAGED_CORRECTION_RECOVERY==='1',effect:(f,id)=>this.dispatch.assertEffect(actor,'correct_output',f,id)})
   if(url.pathname==='/managed/recovery/correction')return await correctionRecoveryApi(request,actor,this.correctionRecovery,this.env.MANAGED_WORKSPACE_ID!,this.env.MANAGED_CORRECTION_RECOVERY==='1',(f,id)=>this.dispatch.assertEffect(actor,'correct_output',f,id))
   if(url.pathname==='/managed/recovery/known-ui-repair')return await knownUiRepairApi(request,actor,this.uiRepairRecovery,this.env.MANAGED_WORKSPACE_ID!,this.env.MANAGED_KNOWN_UI_REPAIR==='1',(f,id)=>this.dispatch.assertEffect(actor,'known_ui',f,id))
   if(url.pathname==='/managed/recovery/unsent-navigation')return await unsentNavigationApi(request,actor,this.navigationRecovery,this.env.MANAGED_WORKSPACE_ID!,this.env.MANAGED_UNSENT_NAVIGATION_RECOVERY==='1',(f,id)=>this.dispatch.assertEffect(actor,'navigate',f,id))
   if(url.pathname==='/managed/recovery/stop')return await recoveryStopsApi(request,actor,this.recoveryStops,this.env.MANAGED_WORKSPACE_ID!)
   if(url.pathname==='/managed/recovery/executor-evidence')return await executorEvidenceApi(request,actor,this.executorEvidence,this.env.MANAGED_WORKSPACE_ID!,this.env.MANAGED_EXECUTOR_EVIDENCE==='1')
   if(url.pathname==='/managed/recovery/account-recheck')return await accountRecheckRecoveryApi(request,actor,this.accountRecheckRecovery,this.env.MANAGED_WORKSPACE_ID!,this.env.MANAGED_ACCOUNT_RECHECK_RECOVERY==='1')
   if(url.pathname==='/managed/recovery/saved-upload')return await savedUploadRecoveryApi(request,actor,this.savedUploadRecovery,this.env.MANAGED_WORKSPACE_ID!,this.env.MANAGED_ARTIFACTS,()=>this.env.MANAGED_SAVED_UPLOAD_RECOVERY==='1',(f,id)=>this.dispatch.assertEffect(actor,'saved_upload',f,id))
   if(url.pathname==='/managed/recovery/saved-import'){
    return await savedImportRecoveryApi(request,actor,this.savedImportRecovery,this.env.MANAGED_WORKSPACE_ID!,this.env.MANAGED_ARTIFACTS,this.env.MANAGED_SAVED_IMPORT_RECOVERY==='1')
   }
   if(url.pathname.startsWith('/managed/accounts')) {
    if(request.method==='POST'&&url.pathname==='/managed/accounts/select') {
     if(actor.role!=='studio')return Response.json({error:'Studio authority required'},{status:403})
     if(url.search)throw new TaskConflict('Unexpected selection query')
     let body:any;try{body=JSON.parse(new TextDecoder().decode(await boundedBody(request.body,8000)))}catch{throw new TaskConflict('Bounded selection body required')}
     exact(body,['schema','workspaceId','taskId','targets'])
     if(body.schema!==ACCOUNTS_SCHEMA||body.workspaceId!==this.env.MANAGED_WORKSPACE_ID||typeof body.taskId!=='string'||!/^task:sha256:[a-f0-9]{64}$/.test(body.taskId)||!(body.targets===null||Array.isArray(body.targets)&&body.targets.length>0&&body.targets.length<=32))throw new TaskConflict('Exact task and candidate scope required')
     if(body.targets)for(const target of body.targets){exact(target,['deviceId','profileId']);if(!accountIdValid(target.deviceId)||!accountIdValid(target.profileId))throw new TaskConflict('Exact candidate required')}
     this.authority.assertWorkspace(body.taskId,this.env.MANAGED_WORKSPACE_ID!)
     return Response.json({schema:ACCOUNTS_SCHEMA,result:this.authority.selectAccount(actor,body.taskId,body.targets??undefined)})
    }
    return await accountApi(request,actor,this.authority.accounts,this.env.MANAGED_WORKSPACE_ID!,Date.parse(this.now()))
   }
   if(request.method==='GET'&&url.pathname==='/managed/readiness') {
    if(actor.role!=='studio')return Response.json({error:'Studio authority required'},{status:403})
    if(url.search)throw new TaskConflict('Unexpected readiness query')
    return Response.json({schema:'managed-task/1',result:{workspaceId:this.env.MANAGED_WORKSPACE_ID,artifactStorageConfigured:!!this.env.MANAGED_ARTIFACTS,capabilities:['managed-accounts/1','managed-artifact-status/1','worker-reconnect/1','unsent-transfer/1','production-claim-stop/1','production-coordinator/1','production-reconciliation/1','obsolete-unsent-stop/1','production-handoff/1','production-candidate-handoff/1','recovery-family-disposition/1','portable-recovery-journal/1',DEFAULT_CROP_CAPABILITY,SLICED_CROP_CAPABILITY,'expired-saved-recovery/1','upload-only-reconciliation/1','cancelled-submission-discard/1','cancelled-unknown-abandonment/1']}})
   }
   if(request.method==='GET'&&url.pathname==='/managed/coordinator'){if(actor.role!=='studio')return Response.json({error:'Studio authority required'},{status:403});if(url.search)throw new TaskConflict('Unexpected coordinator query');return Response.json({schema:'managed-task/1',result:this.authority.coordinator(actor,this.env.MANAGED_WORKSPACE_ID!)})}
   if(request.method==='GET'&&url.pathname.startsWith('/managed/production-claims/')){
    if(actor.role!=='studio')return Response.json({error:'Studio authority required'},{status:403})
    let segments:string[];try{segments=url.pathname.slice('/managed/production-claims/'.length).split('/').map(decodeURIComponent)}catch{throw new TaskConflict('Invalid encoded claim receipt path')}
    if(url.search||segments.length!==2||!/^task:sha256:[a-f0-9]{64}$/.test(segments[0])||!deviceId(segments[1]))throw new TaskConflict('Exact task and claim receipt path required')
    this.authority.assertWorkspace(segments[0],this.env.MANAGED_WORKSPACE_ID!)
    return Response.json({schema:'managed-task/1',result:this.authority.productionClaim(actor,segments[0],segments[1])})
   }
   if(request.method==='GET'&&url.pathname==='/managed/enrollment') {
    if(url.search)throw new TaskConflict('Unexpected query parameters')
    return Response.json({schema:'managed-task/1',result:this.authority.workerEnrollment(actor)})
   }
   if(request.method==='GET'&&url.pathname.startsWith('/managed/worker/')) {
    const key=decodeURIComponent(url.pathname.slice('/managed/worker/'.length))
    if(url.search||!/^task:sha256:[a-f0-9]{64}$/.test(key))throw new TaskConflict('Invalid worker task lookup')
    this.authority.assertWorkspace(key,this.env.MANAGED_WORKSPACE_ID!)
    return Response.json({schema:'managed-task/1',result:this.authority.workerTask(actor,key)})
   }
   if(request.method==='POST'&&url.pathname==='/managed/artifacts') {
    if(actor.role!=='phone')return Response.json({error:'Authenticated worker required'},{status:403})
    if(!this.env.MANAGED_ARTIFACTS)return Response.json({error:'Managed artifact storage is not configured'},{status:503})
    const bytes=await boundedBody(request.body,2_100_000)
    let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes))}catch{throw new TaskConflict('Invalid artifact upload JSON')}
    if(!raw||Object.keys(raw).sort().join(',')!=='document,operation'||typeof raw.document!=='string')throw new TaskConflict('Invalid artifact upload envelope')
    const op=parseManagedOperation(raw.operation)
    if(op.action!=='stage')throw new TaskConflict('Artifact upload requires a stage operation')
    if(op.workspaceId!==this.env.MANAGED_WORKSPACE_ID)throw new TaskConflict('Cross-workspace artifact rejected')
    this.authority.assertWorkspace(op.taskId,op.workspaceId)
    const owner=this.authority.artifactOwner(actor,op.taskId,op.attemptId,op.generation,op.fingerprint)
    if(this.savedUploadRecovery.enrolled(actor,{workspaceId:op.workspaceId,taskId:op.taskId,attemptId:op.attemptId,generation:op.generation,fingerprint:op.fingerprint}))throw new TaskConflict('This saved upload is enrolled in recovery; use its original action instead of ordinary upload')
    if(this.correctionRecovery.discover(actor,{workspaceId:op.workspaceId,taskId:op.taskId,attemptId:op.attemptId,generation:op.generation,fingerprint:op.fingerprint})&&this.env.MANAGED_CORRECTION_RECOVERY!=='1')throw new TaskConflict('Correction upload is off; retain the original saved checkpoint')
    const document=new TextEncoder().encode(raw.document)
    validateManagedCrop(document,owner.task,owner.attempt)
    if(owner.attempt.submission!=='saved'||!owner.attempt.checkpointRef||op.ref!==artifactRef(owner.task,op.attemptId,op.artifactId)||await artifactHash(document)!==op.contentHash)throw new TaskConflict('Saved artifact identity or checksum mismatch')
    const record:ManagedArtifactRecord={id:op.artifactId,taskId:op.taskId,attemptId:op.attemptId,generation:op.generation,fingerprint:op.fingerprint,ref:op.ref,sha256:op.contentHash,validated:false,validationRef:null}
    this.authority.reserveArtifact(actor,op.taskId,op.attemptId,op.generation,op.fingerprint,op.artifactId,op.ref,op.contentHash,document.length)
    await storeManagedArtifact(this.env.MANAGED_ARTIFACTS,record,document,()=>{
     this.authority.artifactOwner(actor,op.taskId,op.attemptId,op.generation,op.fingerprint)
     this.savedUploadRecovery.claimOrdinaryUpload(actor,{workspaceId:op.workspaceId,taskId:op.taskId,attemptId:op.attemptId,generation:op.generation,fingerprint:op.fingerprint})
    })
    // Ownership is checked again by the synchronous authority after R2 awaits. Late bytes stay historical.
    const result=this.authority.stage(actor,op.eventId,op.taskId,op.attemptId,op.generation,op.fingerprint,op.artifactId,op.ref,op.contentHash)
    return Response.json({schema:'managed-task/1',result})
   }
   if(request.method==='GET'&&url.pathname.startsWith('/managed/artifacts/')) {
    if(actor.role!=='studio')return Response.json({error:'Studio authority required'},{status:403})
    if(!this.env.MANAGED_ARTIFACTS)return Response.json({error:'Managed artifact storage is not configured'},{status:503})
    const id=url.pathname.slice('/managed/artifacts/'.length)
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)||url.search)throw new TaskConflict('Invalid artifact lookup')
    const record=this.authority.artifact(actor,id);this.authority.assertWorkspace(record.taskId,this.env.MANAGED_WORKSPACE_ID!)
    const owner=this.authority.artifactOwner(actor,record.taskId,record.attemptId,record.generation,record.fingerprint)
    const bytes=await readManagedArtifact(this.env.MANAGED_ARTIFACTS,record,owner.task,owner.attempt)
    return Response.json({schema:'managed-task/1',record,...owner,document:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)})
   }
   if(request.method==='GET'&&url.pathname==='/managed/inbox') {
    if(actor.role!=='phone')return Response.json({error:'Authenticated worker required'},{status:403})
    if(url.search)throw new TaskConflict('Managed identity cannot be supplied in query parameters')
    const assignments=this.authority.inbox(actor).filter(a=>a.task.workspaceId===this.env.MANAGED_WORKSPACE_ID)
    return Response.json({schema:'managed-task/1',assignments})
   }
   if(request.method==='GET'&&url.pathname.startsWith('/managed/tasks/')) {
    if(actor.role!=='studio')return Response.json({error:'Studio authority required'},{status:403})
    const key=decodeURIComponent(url.pathname.slice('/managed/tasks/'.length))
    if(!/^task:sha256:[a-f0-9]{64}$/.test(key))throw new TaskConflict('Invalid task identity')
    const result=this.authority.timeline(actor,key)
    if(result.task.workspaceId!==this.env.MANAGED_WORKSPACE_ID)return Response.json({error:'Wrong workspace'},{status:403})
    return Response.json({schema:'managed-task/1',...result})
   }
   if(request.method==='POST'&&url.pathname==='/managed/obsolete-stop') {
    if(actor.role!=='phone')return Response.json({error:'Authenticated original worker required'},{status:403})
    if(url.search)throw new TaskConflict('Unexpected obsolete-stop query')
    const text=await request.text();if(new TextEncoder().encode(text).length>2000)throw new TaskConflict('Obsolete-stop request too large')
    const raw=JSON.parse(text)
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='attemptId,fingerprint,generation,schema,stopCommandId,taskId,workspaceId'||raw.schema!=='managed-obsolete-stop/1'||raw.workspaceId!==this.env.MANAGED_WORKSPACE_ID||!/^task:sha256:[a-f0-9]{64}$/.test(raw.taskId)||!(/^[a-f0-9]{64}$/).test(raw.fingerprint)||![raw.attemptId,raw.stopCommandId].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v))||!Number.isSafeInteger(raw.generation)||raw.generation<1)throw new TaskConflict('Exact bounded obsolete-stop fence required')
    const {schema,...fence}=raw
    return Response.json({schema,result:this.authority.obsoleteStop(actor,fence)})
   }
   if(request.method==='POST'&&url.pathname==='/managed/reconnect') {
    if(actor.role!=='phone')return Response.json({error:'Authenticated worker required'},{status:403})
    if(url.search)throw new TaskConflict('Unexpected reconnect query')
    const text=await request.text();if(new TextEncoder().encode(text).length>8000)throw new TaskConflict('Reconnect inventory too large')
    const attempts=parseManagedReconnect(JSON.parse(text),this.env.MANAGED_WORKSPACE_ID!)
    return Response.json({schema:'managed-reconnect/1',observations:this.authority.reconnect(actor,attempts),assignments:this.authority.inbox(actor).filter(a=>a.task.workspaceId===this.env.MANAGED_WORKSPACE_ID)})
   }
   if(request.method!=='POST'||url.pathname!=='/managed/operation')return new Response('Not found',{status:404})
   const text=await request.text()
   if(new TextEncoder().encode(text).length>64_000)return new Response('Managed operation too large',{status:413})
   let raw:unknown;try{raw=JSON.parse(text)}catch{throw new TaskConflict('Invalid managed JSON')}
   const op=parseManagedOperation(raw)
   if(op.workspaceId!==this.env.MANAGED_WORKSPACE_ID)return Response.json({error:'Wrong workspace'},{status:403})
   const studioOperations=['transfer_production','pause_production_claim','coordinator_acquire','coordinator_renew','coordinator_release','claim_production','stop_production_claim','stop_production','publish_production','stop_claim','transfer_unsent','enroll','unenroll','plan','claim','stop','publish','publish_recovered','resolve_upload_only','resolve_cancelled_submission','resolve_cancelled_unknown']
   const phoneOperations=['hello','renew','checkpoint','stage','recover_saved','attest_upload_only','attest_cancelled_submission','attest_cancelled_unknown']
   if(actor.role==='phone'&&!phoneOperations.includes(op.action)||actor.role==='studio'&&!studioOperations.includes(op.action))return Response.json({error:'Operation is not authorized for this role'},{status:403})
   if('taskId' in op)this.authority.assertWorkspace(op.taskId,this.env.MANAGED_WORKSPACE_ID!)
   let result:unknown
   const coordinator='coordinatorGeneration' in op?{coordinatorId:op.coordinatorId,coordinatorGeneration:op.coordinatorGeneration}:undefined
   switch(op.action) {
    case 'coordinator_acquire':result=this.authority.acquireCoordinator(actor,op.eventId,op.workspaceId,op.coordinatorId,op.expectedGeneration);break
    case 'coordinator_renew':
    case 'coordinator_release':result=this.authority.updateCoordinator(actor,op.eventId,op.workspaceId,coordinator!,op.action==='coordinator_release');break
    case 'unenroll':result=this.authority.unenroll(actor,op.eventId,op.deviceId);break
    case 'hello': {
     if(actor.role!=='phone')throw new TaskConflict('Authenticated worker required')
     // A handshake advertises compatibility only; it cannot enroll itself or grant an execution lease.
     const peer=this.authority.registerPeer(actor,op.eventId,op.profileIds,op.capabilities,op.apkVersion)
     result={peer,executionReady:MANAGED_CAPABILITIES.every(c=>peer.capabilities.includes(c))};break
    }
    case 'enroll': {
     const row=this.sql.exec<{body:string}>('SELECT body FROM managed_peers WHERE id = ?',op.deviceId).toArray()[0]
     const peer=row?JSON.parse(row.body) as {profileIds:string[];capabilities:string[];receivedAt:string}:null
     if(!peer||!peer.profileIds.includes(op.profileId)||Date.parse(this.now())-Date.parse(peer.receivedAt)>15*60_000)throw new TaskConflict('A fresh authenticated worker handshake is required')
     result=this.authority.enroll(actor,op.eventId,op.deviceId,op.profileId,peer.capabilities);break
    }
    case 'plan':result=await this.authority.plan(actor,op.eventId,op.identity,op.spec);break
    case 'transfer_production':result=this.authority.transfer(actor,op.eventId,op.taskId,op.attemptId,op.generation,op.fingerprint,op.stopCommandId,op.deviceId,op.profileId,{coordinator:coordinator!,claimEventId:op.claimEventId,newClaimEventId:op.newClaimEventId});break
    case 'transfer_unsent':result=this.authority.transfer(actor,op.eventId,op.taskId,op.attemptId,op.generation,op.fingerprint,op.stopCommandId,op.deviceId,op.profileId);break
    case 'claim_production':
    case 'claim':result=this.authority.claim(actor,op.eventId,op.taskId,op.deviceId,op.profileId,op.accountId,coordinator);break
    case 'recover_saved':result=this.authority.recoverSaved(actor,op.eventId,op.taskId,op.attemptId,op.generation,op.fingerprint,op.checkpointRef,op.commandId);break
    case 'attest_cancelled_unknown': {const {schema,workspaceId,eventId,action,...evidence}=op;result=this.authority.attestCancelledUnknown(actor,eventId,evidence);break}
    case 'resolve_cancelled_unknown':result=this.authority.resolveCancelledUnknown(actor,op.eventId,op.taskId,op.attemptId,op.generation,op.fingerprint,op.reportId,op.stopCommandId,op.confirmAbandon);break
    case 'attest_cancelled_submission': {const {schema,workspaceId,eventId,action,...evidence}=op;result=this.authority.attestCancelledSubmission(actor,eventId,evidence);break}
    case 'resolve_cancelled_submission':result=this.authority.resolveCancelledSubmission(actor,op.eventId,op.taskId,op.attemptId,op.generation,op.fingerprint,op.reportId,op.stopCommandId,op.confirmDiscard);break
    case 'attest_upload_only': {const {schema,workspaceId,eventId,action,...evidence}=op;result=this.authority.attestUploadOnly(actor,eventId,evidence);break}
    case 'resolve_upload_only':result=this.authority.resolveUploadOnly(actor,op.eventId,op.taskId,op.attemptId,op.generation,op.fingerprint,op.reportId,op.stopCommandId,op.confirmUploadOnly);break
    case 'renew':result=this.authority.renew(actor,op.eventId,op.taskId,op.attemptId,op.generation,op.fingerprint);break
    case 'checkpoint':result=this.authority.checkpoint(actor,op.eventId,op.taskId,op.attemptId,op.generation,op.fingerprint,op.phase,op.checkpointRef,op.commandId);break
    case 'pause_production_claim':
    case 'stop_production_claim':
    case 'stop_claim':result=this.authority.stopClaim(actor,op.eventId,op.taskId,op.claimEventId,coordinator,op.action!=='pause_production_claim');break
    case 'stop_production':
    case 'stop':result=this.authority.stop(actor,op.eventId,op.taskId,op.cancel,coordinator);break
    case 'stage':throw new TaskConflict('Upload and verify artifact bytes through /managed/artifacts first')
    case 'publish_production':
    case 'publish_recovered':
    case 'publish': {
     if(!this.env.MANAGED_ARTIFACTS)return Response.json({error:'Managed artifact storage is not configured'},{status:503})
     const record=this.authority.artifact(actor,op.artifactId)
     if(record.taskId!==op.taskId||record.attemptId!==op.attemptId||record.generation!==op.generation||record.fingerprint!==op.fingerprint||record.sha256!==op.contentHash)throw new TaskConflict('Publication artifact fence mismatch')
     const owner=this.authority.artifactOwner(actor,op.taskId,op.attemptId,op.generation,op.fingerprint)
     if(this.correctionRecovery.discover(actor,{workspaceId:op.workspaceId,taskId:op.taskId,attemptId:op.attemptId,generation:op.generation,fingerprint:op.fingerprint})&&this.env.MANAGED_CORRECTION_RECOVERY!=='1')throw new TaskConflict('Correction publication is off; retain the staged artifact')
     await readManagedArtifact(this.env.MANAGED_ARTIFACTS,record,owner.task,owner.attempt)
     result=this.authority.publish(actor,op.eventId,op.taskId,op.attemptId,op.generation,op.fingerprint,op.artifactId,op.contentHash,op.validationRef,op.action==='publish_recovered'||op.action==='publish_production'&&op.recovered,coordinator);break
    }
   }
   return Response.json({schema:'managed-task/1',result})
  }catch(error){if(error instanceof AccountWaiting)return Response.json({schema:'managed-task/1',result:{waiting:error.selection}},{status:200});if(error instanceof TaskConflict)return Response.json({error:error.message},{status:409});throw error}
 }
}
