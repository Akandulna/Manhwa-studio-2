/** Shared managed-task/1 records and strict codecs. No execution side effects. */
export type TaskPrincipal = {role:'studio'} | {role:'phone';deviceId:string}
export interface CropSpec {
  version:'crop-page/1';provider:'chatgpt'|'gemini'|'aistudio';product:string;model:string
  settings:{mode:string|null;effort:string|null};pageRevision:string;promptVersion:string;validatorVersion:string
  dependencies:{id:string;revision:string;sha256:string}[]
}
export interface CropIdentity {workspaceId:string;seriesId:string;chapterId:string;pageId:string}
export type TaskState = 'queued'|'assigned'|'running'|'uncertain'|'paused'|'cancelled'|'superseded'|'verified_complete'
export interface CropTask extends CropIdentity {id:string;fingerprint:string;spec:CropSpec;state:TaskState;generation:number;attemptId:string|null;canonical:string|null}
export interface CropAttempt {
  id:string;taskId:string;generation:number;deviceId:string;profileId:string;accountId:string|null;activeCommandId:string
  leaseExpiresAt:string;phase:'assigned'|'accepted'|'started'|'submission_intent'|'submitted'|'result_saved'|'stop_requested'|'stop_confirmed'|'published'
  submission:'unsent'|'unknown'|'submitted'|'saved';checkpointRef:string|null
  accountSelection?:import('./managedAccountsProtocol.js').AccountSelectionPin
}
export class TaskConflict extends Error {}
export function canonicalJson(value:unknown):string {
  if(value===null || typeof value==='string' || typeof value==='boolean') return JSON.stringify(value)
  if(typeof value==='number' && Number.isFinite(value)) return JSON.stringify(value)
  if(Array.isArray(value)) return '['+value.map(canonicalJson).join(',')+']'
  if(value && typeof value==='object' && Object.getPrototypeOf(value)===Object.prototype) return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalJson((value as Record<string,unknown>)[k])).join(',')+'}'
  throw new TaskConflict('Execution specifications must be finite canonical JSON')
}
const id=(v:unknown):v is string=>typeof v==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)
const digest=(v:unknown):v is string=>typeof v==='string' && /^[a-f0-9]{64}$/.test(v)
const text=(v:unknown):v is string=>typeof v==='string' && !!v.trim() && v.length<=128
async function sha(value:string):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('')}
export async function cropTaskIdentity(identity:CropIdentity,spec:CropSpec):Promise<{taskId:string;fingerprint:string}> {
  if(!Object.values(identity).every(id) || Object.keys(identity).sort().join(',')!=='chapterId,pageId,seriesId,workspaceId') throw new TaskConflict('Stable shared entity identifiers are required')
  if(Object.keys(spec).sort().join(',')!=='dependencies,model,pageRevision,product,promptVersion,provider,settings,validatorVersion,version' || spec.version!=='crop-page/1' || !['chatgpt','gemini','aistudio'].includes(spec.provider) || ![spec.product,spec.model,spec.pageRevision,spec.promptVersion,spec.validatorVersion].every(text)) throw new TaskConflict('Choose a fully resolved versioned crop specification')
  if(!spec.settings || Object.keys(spec.settings).sort().join(',')!=='effort,mode' || ![spec.settings.mode,spec.settings.effort].every(v=>v===null || text(v))) throw new TaskConflict('Resolve model settings explicitly')
  if(!Array.isArray(spec.dependencies) || !spec.dependencies.length || spec.dependencies.length>100 || spec.dependencies.some(d=>Object.keys(d).sort().join(',')!=='id,revision,sha256' || !id(d.id) || !text(d.revision) || !digest(d.sha256))) throw new TaskConflict('Ordered immutable dependency revisions and hashes are required')
  const fingerprint=await sha(canonicalJson(spec))
  return {fingerprint,taskId:'task:sha256:'+await sha(JSON.stringify([identity.workspaceId,identity.seriesId,identity.chapterId,'crop_json',null,'page',identity.pageId,fingerprint]))}
}

export const MANAGED_CAPABILITIES = ['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1'] as const
export const MANAGED_KNOWN_CAPABILITIES = [...MANAGED_CAPABILITIES,'managed-transport/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','worker-reconnect/1','account-audit/1','account-selection/1','unsent-navigation-recovery/1','known-ui-repair/1','correction-preflight/1'] as const
interface Envelope {schema:'managed-task/1';workspaceId:string;eventId:string}
export interface ProductionClaimReceipt {taskId:string;claimEventId:string;status:'missing'|'blocked_before_claim'|'recorded';fingerprint?:string;attemptId?:string;generation?:number;deviceId?:string;profileId?:string;accountId?:string|null}
export interface CoordinatorFence {coordinatorId:string;coordinatorGeneration:number}
export interface CoordinatorLease {workspaceId:string;coordinatorId:string;coordinatorGeneration:number;state:'held'|'released';leaseExpiresAt:string}
interface Fence {taskId:string;attemptId:string;generation:number;fingerprint:string}
export interface UploadOnlyEvidence extends Fence {
 startCommandId:string;stopCommandId:string;deviceId:string;profileId:string
 originalPhase:'submission_intent';uploadRecorded:true;submitRecorded:false;checkpointCount:0
}
export interface UploadOnlyReport extends UploadOnlyEvidence {
 id:string;workspaceId:string;reportedAt:string;resolvedAt:string|null;resolutionEventId:string|null
}
export interface CancelledSubmissionEvidence extends Fence {
 startCommandId:string;stopCommandId:string;deviceId:string;profileId:string
 originalPhase:'submitted';uploadRecorded:true;submitRecorded:true;completedReplyRetained:true
 checkpointCount:number;completedReplyHash:string;evidenceDigest:string
}
export interface CancelledSubmissionReport extends CancelledSubmissionEvidence {
 id:string;workspaceId:string;reportedAt:string;resolvedAt:string|null;resolutionEventId:string|null
}
export interface CancelledUnknownEvidence extends Fence {
 startCommandId:string;stopCommandId:string;deviceId:string;profileId:string
 originalPhase:'submission_intent';uploadRecorded:true;submitRecorded:true;completedReplyRetained:false
 checkpointCount:0;evidenceDigest:string
}
export interface CancelledUnknownReport extends CancelledUnknownEvidence {
 id:string;workspaceId:string;reportedAt:string;resolvedAt:string|null;resolutionEventId:string|null
}
export type ManagedOperation = Envelope & (
 | {action:'hello';capabilities:string[];profileIds:string[];apkVersion:string}
 | {action:'enroll';deviceId:string;profileId:string}
 | {action:'unenroll';deviceId:string}
 | {action:'plan';identity:CropIdentity;spec:CropSpec}
 | {action:'coordinator_acquire';coordinatorId:string;expectedGeneration:number}
 | ({action:'coordinator_renew'|'coordinator_release'} & CoordinatorFence)
 | ({action:'claim_production';taskId:string;deviceId:string;profileId:string;accountId:string|null} & CoordinatorFence)
 | ({action:'stop_production_claim'|'pause_production_claim';taskId:string;claimEventId:string} & CoordinatorFence)
 | ({action:'stop_production';taskId:string;cancel:boolean} & CoordinatorFence)
 | ({action:'publish_production';artifactId:string;contentHash:string;validationRef:string;recovered:boolean} & Fence & CoordinatorFence)
 | {action:'claim';taskId:string;deviceId:string;profileId:string;accountId:string|null}
 | ({action:'renew'} & Fence)
 | ({action:'attest_cancelled_unknown'} & CancelledUnknownEvidence)
 | ({action:'resolve_cancelled_unknown';reportId:string;stopCommandId:string;confirmAbandon:true} & Fence)
 | ({action:'attest_cancelled_submission'} & CancelledSubmissionEvidence)
 | ({action:'resolve_cancelled_submission';reportId:string;stopCommandId:string;confirmDiscard:true} & Fence)
 | ({action:'attest_upload_only'} & UploadOnlyEvidence)
 | ({action:'resolve_upload_only';reportId:string;stopCommandId:string;confirmUploadOnly:true} & Fence)
 | ({action:'recover_saved';checkpointRef:string;commandId:string} & Fence)
 | ({action:'checkpoint';phase:'accepted'|'started'|'submission_intent'|'submitted'|'result_saved'|'stop_confirmed';checkpointRef:string|null;commandId:string} & Fence)
 | {action:'stop';taskId:string;cancel:boolean}
 | {action:'stop_claim';taskId:string;claimEventId:string}
 | ({action:'transfer_production';claimEventId:string;newClaimEventId:string;stopCommandId:string;deviceId:string;profileId:string} & Fence & CoordinatorFence)
 | ({action:'transfer_unsent';stopCommandId:string;deviceId:string;profileId:string} & Fence)
 | ({action:'stage';artifactId:string;ref:string;contentHash:string} & Fence)
 | ({action:'publish'|'publish_recovered';artifactId:string;contentHash:string;validationRef:string} & Fence)
)
function object(value:unknown):Record<string,unknown> {
 if(!value || typeof value!=='object' || Array.isArray(value) || Object.getPrototypeOf(value)!==Object.prototype)throw new TaskConflict('Expected a managed operation object')
 return value as Record<string,unknown>
}
function exact(raw:Record<string,unknown>,keys:string[]):void{if(Object.keys(raw).sort().join(',')!==keys.sort().join(','))throw new TaskConflict('Unexpected or missing managed protocol fields')}
function identifiers(values:unknown[]):void{if(!values.every(id))throw new TaskConflict('Invalid managed identifier')}
const taskKey=(value:unknown)=>typeof value==='string' && /^task:sha256:[a-f0-9]{64}$/.test(value)
export function parseManagedOperation(value:unknown):ManagedOperation {
 const raw=object(value)
 if(raw.schema!=='managed-task/1')throw new TaskConflict('Unsupported managed protocol version')
 identifiers([raw.workspaceId,raw.eventId])
 const base=['schema','workspaceId','eventId','action']
 const coordinator=['coordinatorId','coordinatorGeneration']
 if(['transfer_production','pause_production_claim','coordinator_renew','coordinator_release','claim_production','stop_production_claim','stop_production','publish_production'].includes(String(raw.action))){identifiers([raw.coordinatorId]);if(!Number.isSafeInteger(raw.coordinatorGeneration)||Number(raw.coordinatorGeneration)<1)throw new TaskConflict('Invalid coordinator fence')}
 const fence=['taskId','attemptId','generation','fingerprint']
 if(['transfer_production','publish_production','transfer_unsent','renew','checkpoint','stage','publish','recover_saved','publish_recovered','attest_upload_only','resolve_upload_only','attest_cancelled_submission','resolve_cancelled_submission','attest_cancelled_unknown','resolve_cancelled_unknown'].includes(String(raw.action))) {
  if(!taskKey(raw.taskId)||!id(raw.attemptId)||!Number.isSafeInteger(raw.generation)||Number(raw.generation)<1||!digest(raw.fingerprint))throw new TaskConflict('Invalid attempt fence')
 }
 switch(raw.action) {
  case 'hello':
   exact(raw,[...base,'capabilities','profileIds','apkVersion'])
   if(!Array.isArray(raw.capabilities)||raw.capabilities.length>16||!raw.capabilities.every(c=>(MANAGED_KNOWN_CAPABILITIES as readonly unknown[]).includes(c))||new Set(raw.capabilities).size!==raw.capabilities.length)throw new TaskConflict('Unsupported capability set')
   if(!Array.isArray(raw.profileIds)||!raw.profileIds.length||raw.profileIds.length>32||!raw.profileIds.every(id)||new Set(raw.profileIds).size!==raw.profileIds.length||typeof raw.apkVersion!=='string'||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(raw.apkVersion)||raw.apkVersion.length>64)throw new TaskConflict('Invalid worker handshake')
   break
  case 'enroll':exact(raw,[...base,'deviceId','profileId']);identifiers([raw.deviceId,raw.profileId]);break
  case 'unenroll':exact(raw,[...base,'deviceId']);identifiers([raw.deviceId]);break
  case 'plan': {
   exact(raw,[...base,'identity','spec']);const identity=object(raw.identity),spec=object(raw.spec)
   exact(identity,['workspaceId','seriesId','chapterId','pageId']);identifiers(Object.values(identity))
   if(identity.workspaceId!==raw.workspaceId)throw new TaskConflict('Cross-workspace plan rejected')
   exact(spec,['version','provider','product','model','settings','pageRevision','promptVersion','validatorVersion','dependencies'])
   // Full semantic validation/hash derivation occurs before the authority transaction.
   canonicalJson(spec);break
  }
  case 'coordinator_acquire':exact(raw,[...base,'coordinatorId','expectedGeneration']);identifiers([raw.coordinatorId]);if(!Number.isSafeInteger(raw.expectedGeneration)||Number(raw.expectedGeneration)<0)throw new TaskConflict('Invalid expected coordinator generation');break
  case 'coordinator_renew':
  case 'coordinator_release':exact(raw,[...base,...coordinator]);break
  case 'claim_production':
  case 'claim':exact(raw,[...base,...(raw.action==='claim_production'?coordinator:[]),'taskId','deviceId','profileId','accountId']);identifiers([raw.deviceId,raw.profileId]);if(!taskKey(raw.taskId)||!(raw.accountId===null||id(raw.accountId)))throw new TaskConflict('Invalid claim');break
  case 'recover_saved':exact(raw,[...base,...fence,'checkpointRef','commandId']);identifiers([raw.commandId]);if(typeof raw.checkpointRef!=='string'||!/^checkpoint\/[A-Za-z0-9_-]{1,128}$/.test(raw.checkpointRef))throw new TaskConflict('Durable checkpoint reference required');break
  case 'attest_upload_only':
   exact(raw,[...base,...fence,'startCommandId','stopCommandId','deviceId','profileId','originalPhase','uploadRecorded','submitRecorded','checkpointCount'])
   identifiers([raw.startCommandId,raw.stopCommandId,raw.deviceId,raw.profileId])
   if(raw.startCommandId===raw.stopCommandId||raw.originalPhase!=='submission_intent'||raw.uploadRecorded!==true||raw.submitRecorded!==false||raw.checkpointCount!==0)throw new TaskConflict('Exact upload-only evidence required')
   break
  case 'resolve_upload_only':
   exact(raw,[...base,...fence,'reportId','stopCommandId','confirmUploadOnly']);identifiers([raw.reportId,raw.stopCommandId])
   if(raw.confirmUploadOnly!==true)throw new TaskConflict('Explicit upload-only review required')
   break
  case 'attest_cancelled_unknown':
   exact(raw,[...base,...fence,'startCommandId','stopCommandId','deviceId','profileId','originalPhase','uploadRecorded','submitRecorded','completedReplyRetained','checkpointCount','evidenceDigest'])
   identifiers([raw.startCommandId,raw.stopCommandId,raw.deviceId,raw.profileId])
   if(raw.startCommandId===raw.stopCommandId||raw.originalPhase!=='submission_intent'||raw.uploadRecorded!==true||raw.submitRecorded!==true||raw.completedReplyRetained!==false||raw.checkpointCount!==0||!digest(raw.evidenceDigest))throw new TaskConflict('Exact cancelled unknown evidence required')
   break
  case 'resolve_cancelled_unknown':
   exact(raw,[...base,...fence,'reportId','stopCommandId','confirmAbandon']);identifiers([raw.reportId,raw.stopCommandId])
   if(raw.confirmAbandon!==true)throw new TaskConflict('Explicit abandonment of unknown outcome required')
   break
  case 'attest_cancelled_submission':
   exact(raw,[...base,...fence,'startCommandId','stopCommandId','deviceId','profileId','originalPhase','uploadRecorded','submitRecorded','completedReplyRetained','checkpointCount','completedReplyHash','evidenceDigest'])
   identifiers([raw.startCommandId,raw.stopCommandId,raw.deviceId,raw.profileId])
   if(raw.startCommandId===raw.stopCommandId||raw.originalPhase!=='submitted'||raw.uploadRecorded!==true||raw.submitRecorded!==true||raw.completedReplyRetained!==true||!Number.isSafeInteger(raw.checkpointCount)||Number(raw.checkpointCount)<1||Number(raw.checkpointCount)>32||!digest(raw.completedReplyHash)||!digest(raw.evidenceDigest))throw new TaskConflict('Completed cancelled reply evidence required')
   break
  case 'resolve_cancelled_submission':
   exact(raw,[...base,...fence,'reportId','stopCommandId','confirmDiscard']);identifiers([raw.reportId,raw.stopCommandId])
   if(raw.confirmDiscard!==true)throw new TaskConflict('Explicit cancelled reply discard review required')
   break
  case 'renew':exact(raw,[...base,...fence]);break
  case 'checkpoint':exact(raw,[...base,...fence,'phase','checkpointRef','commandId']);identifiers([raw.commandId]);if(!['accepted','started','submission_intent','submitted','result_saved','stop_confirmed'].includes(String(raw.phase))||!(raw.checkpointRef===null||typeof raw.checkpointRef==='string'&&/^checkpoint\/[A-Za-z0-9_-]{1,128}$/.test(raw.checkpointRef)))throw new TaskConflict('Invalid checkpoint');break
  case 'transfer_production':exact(raw,[...base,...fence,...coordinator,'claimEventId','newClaimEventId','stopCommandId','deviceId','profileId']);identifiers([raw.claimEventId,raw.newClaimEventId,raw.stopCommandId,raw.deviceId,raw.profileId]);if(raw.claimEventId===raw.newClaimEventId)throw new TaskConflict('A new handoff claim receipt is required');break
  case 'transfer_unsent':exact(raw,[...base,...fence,'stopCommandId','deviceId','profileId']);identifiers([raw.stopCommandId,raw.deviceId,raw.profileId]);break
  case 'pause_production_claim':
  case 'stop_production_claim':
  case 'stop_claim':exact(raw,[...base,...(raw.action==='stop_production_claim'||raw.action==='pause_production_claim'?coordinator:[]),'taskId','claimEventId']);identifiers([raw.claimEventId]);if(!taskKey(raw.taskId))throw new TaskConflict('Invalid claim stop');break
  case 'stop_production':
  case 'stop':exact(raw,[...base,...(raw.action==='stop_production'?coordinator:[]),'taskId','cancel']);if(!taskKey(raw.taskId)||typeof raw.cancel!=='boolean')throw new TaskConflict('Invalid stop intent');break
  case 'stage':exact(raw,[...base,...fence,'artifactId','ref','contentHash']);identifiers([raw.artifactId]);if(!digest(raw.contentHash)||typeof raw.ref!=='string'||raw.ref.length>512||!/^managed\/[A-Za-z0-9_/-]+$/.test(raw.ref))throw new TaskConflict('Invalid artifact staging');break
  case 'publish_production':
  case 'publish_recovered':
  case 'publish':exact(raw,[...base,...fence,...(raw.action==='publish_production'?[...coordinator,'recovered']:[]),'artifactId','contentHash','validationRef']);if(raw.action==='publish_production'&&typeof raw.recovered!=='boolean')throw new TaskConflict('Explicit publication recovery flag required');identifiers([raw.artifactId]);if(!digest(raw.contentHash)||typeof raw.validationRef!=='string'||!/^validation\/[A-Za-z0-9_-]{1,128}$/.test(raw.validationRef))throw new TaskConflict('Invalid publication receipt');break
  default:throw new TaskConflict('Unsupported managed operation')
 }
 return raw as unknown as ManagedOperation
}

/** Legacy controls cannot mutate an enrolled device's browser or run state. */
export const LEGACY_BROWSER_ACTIONS = new Set([
  'clipper_start', 'narration_start', 'editor_start', 'voiceover_start',
  'clipper_stop', 'run_stop', 'run_finish', 'profile_select', 'chatgpt_options',
])
