import {canonicalJson,TaskConflict,cropTaskIdentity} from './managedTaskProtocol.js'
import type {ProductionJob} from './productionAutomationModel.js'
import type {ProductionHandoffIntent,ProductionHandoffReceipt} from './managedProductionHandoff.js'
import {parseDispositionIntent,parseDispositionReceipt,type DispositionIntent,type DispositionReceipt} from './recoveryDispositionProtocol.js'
import {parseHandoffStatus} from './accountHandoffProtocol.js'
import type {ProductionDispositionHistory} from './productionRecoveryDisposition.js'
import type {PilotAuthority,PilotInput} from './managedCropPilot.js'
import {managedCropBinding} from './managedCropProjection.js'
import {resolveManagedCropInput} from './managedArtifactImport.js'
import {parseRecoveryBudget,recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
export const PORTABLE_RECOVERY_SCHEMA='portable-recovery-journal/1'
export interface PortableRecoveryJournal {schema:typeof PORTABLE_RECOVERY_SCHEMA;sourceStatus:'failed'|'interrupted'|'cancelled';familyReceipts:DispositionReceipt[];pendingHandoff:ProductionHandoffIntent|null;handoffHistory:ProductionHandoffReceipt[];pendingRecoveryDisposition:DispositionIntent|null;recoveryDispositionHistory:ProductionDispositionHistory[]}
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v)
const exact=(v:any,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.sort().join(','))throw new TaskConflict('Exact bounded portable recovery journal fields required')}
const equal=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b)
function handoff(raw:any,receipt=false):ProductionHandoffIntent|ProductionHandoffReceipt {
 exact(raw,['eventId','newClaimEventId','claimEventId','taskId','attemptId','generation','fingerprint','stopCommandId','deviceId','profileId','createdAt',...('accountCandidateId' in raw?['accountCandidateId']:[]),...(receipt?['appliedAt','newAttemptId','newGeneration']:[])])
 if(![raw.eventId,raw.newClaimEventId,raw.claimEventId,raw.attemptId,raw.stopCommandId,raw.deviceId,raw.profileId].every(id)||raw.accountCandidateId!==undefined&&!id(raw.accountCandidateId)||!/^task:sha256:[a-f0-9]{64}$/.test(raw.taskId)||!(/^[a-f0-9]{64}$/).test(raw.fingerprint)||!Number.isSafeInteger(raw.generation)||raw.generation<1||!Number.isFinite(Date.parse(raw.createdAt))||raw.newClaimEventId===raw.claimEventId||raw.newClaimEventId===raw.eventId)throw new TaskConflict('Exact original portable handoff identities required')
 if(receipt&&(!id(raw.newAttemptId)||raw.newGeneration!==raw.generation+1||!Number.isFinite(Date.parse(raw.appliedAt))||Date.parse(raw.appliedAt)<Date.parse(raw.createdAt)))throw new TaskConflict('Exact archived handoff receipt required')
 return structuredClone(raw)
}
function dispositionPair(p:ProductionHandoffIntent,i:DispositionIntent,jobId?:string){
 if(!p.accountCandidateId||i.mode!=='close_unused'||i.reference?.ledger!=='managed_account_handoff_episodes'||i.reference.actionId!==p.eventId||!equal(i.reference.unit,i.unit)||i.unit.taskId!==p.taskId||i.unit.attemptId!==p.attemptId||i.unit.generation!==p.generation||i.unit.fingerprint!==p.fingerprint||!i.production||jobId!==undefined&&i.production.jobId!==jobId||i.production.claimEventId!==p.claimEventId||i.production.newClaimEventId!==p.newClaimEventId||i.production.candidateId!==p.accountCandidateId)throw new TaskConflict('Original pending handoff and disposition relationship required')
}
export function parsePortableRecoveryJournal(raw:any,jobId:string,command:NonNullable<ProductionJob['command']>):PortableRecoveryJournal {
 exact(raw,['schema','sourceStatus','familyReceipts','pendingHandoff','handoffHistory','pendingRecoveryDisposition','recoveryDispositionHistory'])
 if(raw.schema!==PORTABLE_RECOVERY_SCHEMA||!['failed','interrupted','cancelled'].includes(raw.sourceStatus)||!Array.isArray(raw.handoffHistory)||raw.handoffHistory.length>16||!Array.isArray(raw.recoveryDispositionHistory)||raw.recoveryDispositionHistory.length>16)throw new TaskConflict('Bounded retained recovery journal required')
 if((command.managedClaims?.length??0)>64||!Array.isArray(raw.familyReceipts)||raw.familyReceipts.length>128)throw new TaskConflict('Portable recovery journal requires bounded family scope')
 const familyEvents=new Set<string>();for(const receipt of raw.familyReceipts){parseDispositionReceipt(receipt);if(!command.managedTaskIds?.includes(receipt.intent.unit.taskId)||familyEvents.has(receipt.intent.eventId))throw new TaskConflict('Original family receipt scope or identity conflict');familyEvents.add(receipt.intent.eventId)}
 const taskIds=new Set(command.managedTaskIds),events=new Set<string>(),decisions=new Set<string>()
 if(raw.pendingHandoff!==null){const p=handoff(raw.pendingHandoff);if(!command.managedClaims?.some(c=>c.taskId===p.taskId&&c.claimEventId===p.claimEventId))throw new TaskConflict('Pending handoff must retain the original command claim')}
 for(const h of raw.handoffHistory){handoff(h,true);if(raw.pendingHandoff?.eventId===h.eventId)throw new TaskConflict('Committed handoff cannot remain a pending intent');if(!taskIds.has(h.taskId)||events.has(h.eventId))throw new TaskConflict('Archived handoff scope or identity conflict');events.add(h.eventId)}
 for(const h of raw.recoveryDispositionHistory){exact(h,['handoff','receipt']);const p=handoff(h.handoff),receipt=parseDispositionReceipt(h.receipt);dispositionPair(p,receipt.intent);if(!taskIds.has(p.taskId)||decisions.has(receipt.intent.eventId))throw new TaskConflict('Archived disposition scope or identity conflict');decisions.add(receipt.intent.eventId)}
 if(raw.pendingRecoveryDisposition!==null){const i=parseDispositionIntent(raw.pendingRecoveryDisposition);if(raw.pendingHandoff===null||raw.recoveryDispositionHistory.length>=16||decisions.has(i.eventId))throw new TaskConflict('Pending disposition cannot replace an archived decision');dispositionPair(raw.pendingHandoff,i,jobId)}
 return structuredClone(raw)
}
export function recoveryJournal(job:ProductionJob):PortableRecoveryJournal|null {
 if(!job.pendingHandoff&&!job.handoffHistory?.length&&!job.pendingRecoveryDisposition&&!job.recoveryDispositionHistory?.length&&!job.portableFamilyReceipts?.length)return null
 return parsePortableRecoveryJournal({schema:PORTABLE_RECOVERY_SCHEMA,sourceStatus:job.status,familyReceipts:job.portableFamilyReceipts??[],pendingHandoff:job.pendingHandoff??null,handoffHistory:job.handoffHistory??[],pendingRecoveryDisposition:job.pendingRecoveryDisposition??null,recoveryDispositionHistory:job.recoveryDispositionHistory??[]},job.id,job.command!)
}
export function journalFields(j:PortableRecoveryJournal):Partial<ProductionJob>{return {...(j.familyReceipts.length?{portableFamilyReceipts:j.familyReceipts}:{}),...(j.pendingHandoff?{pendingHandoff:j.pendingHandoff}:{}),...(j.handoffHistory.length?{handoffHistory:j.handoffHistory}:{}),...(j.pendingRecoveryDisposition?{pendingRecoveryDisposition:j.pendingRecoveryDisposition}:{}),...(j.recoveryDispositionHistory.length?{recoveryDispositionHistory:j.recoveryDispositionHistory}:{})}}
/** Read-only anchor checks; neither receipt lookup nor family inspection resolves a missing decision. */
export async function verifyPortableRecovery(job:ProductionJob,j:PortableRecoveryJournal,authority:PilotAuthority,inputs:PilotInput[],clock=Date.now,collect=false){
 if((job.command?.managedClaims?.length??0)>64)throw new TaskConflict('Portable recovery verification is bounded to 64 original claims')
 if(!authority.recoveryDisposition||!authority.claimReceipt)throw new TaskConflict('Compatible read-only recovery journal authority required')
 await authority.ready([PORTABLE_RECOVERY_SCHEMA]);const units=new Map<string,RecoveryUnit>(),sources=new Map<string,{input:PilotInput;fingerprint:string}>()
 for(const input of inputs){const identity=await cropTaskIdentity(input.identity,input.spec);if(sources.has(identity.taskId))throw new TaskConflict('Duplicate portable source scope');sources.set(identity.taskId,{input,fingerprint:identity.fingerprint})}
 const unitFor=(taskId:string,attemptId:string,generation:number,fingerprint:string)=>{const source=sources.get(taskId);if(!source||source.fingerprint!==fingerprint)throw new TaskConflict('Original portable input scope changed');const u={workspaceId:source.input.identity.workspaceId,taskId,attemptId,generation,fingerprint};units.set(recoveryUnitKey(u),u);return u}
 const evidence:any={claims:[],handoffs:[],dispositions:[],pending:[],families:[],sources:[]}
 for(const c of job.command!.managedClaims!){
  const source=sources.get(c.taskId);if(!source)throw new TaskConflict('Original portable input scope missing')
  const binding=await managedCropBinding(source.input.folder,source.input.filename)
  if(binding?.task.id!==c.taskId||binding.task.fingerprint!==source.fingerprint||binding.destination!==source.input.destination)throw new TaskConflict('Original portable source binding changed')
  const verified=await resolveManagedCropInput(source.input.identity,source.input.spec,source.input.sourceFile);evidence.sources.push({taskId:c.taskId,source:verified.source})
  const receipt=await authority.claimReceipt(c.taskId,c.claimEventId)
  if(receipt.taskId!==c.taskId||receipt.claimEventId!==c.claimEventId||!['recorded','blocked_before_claim'].includes(receipt.status))throw new TaskConflict('Original portable claim receipt is missing or changed')
  if(receipt.status==='recorded'){
   if(receipt.fingerprint!==source.fingerprint||receipt.deviceId!==c.deviceId||receipt.profileId!==c.profileId||!receipt.attemptId||!receipt.generation)throw new TaskConflict('Original portable claim does not match retained ownership')
   unitFor(c.taskId,receipt.attemptId,receipt.generation,receipt.fingerprint)
  }
  evidence.claims.push({receipt,current:await authority.timeline(c.taskId)})
 }
 for(const receipt of j.familyReceipts){const u=unitFor(receipt.intent.unit.taskId,receipt.intent.unit.attemptId,receipt.intent.unit.generation,receipt.intent.unit.fingerprint);if(!equal(u,receipt.intent.unit))throw new TaskConflict('Original family receipt workspace changed')}
 for(const h of j.handoffHistory){
  const source=await authority.claimReceipt(h.taskId,h.claimEventId),next=await authority.claimReceipt(h.taskId,h.newClaimEventId)
  if(source.status!=='recorded'||source.attemptId!==h.attemptId||source.generation!==h.generation||source.fingerprint!==h.fingerprint||next.status!=='recorded'||next.attemptId!==h.newAttemptId||next.generation!==h.newGeneration||next.fingerprint!==h.fingerprint||next.deviceId!==h.deviceId||next.profileId!==h.profileId)throw new TaskConflict('Original archived transfer claim receipts required')
  evidence.handoffs.push({source,next})
  unitFor(h.taskId,h.attemptId,h.generation,h.fingerprint);unitFor(h.taskId,h.newAttemptId,h.newGeneration,h.fingerprint)
 }
 for(const h of j.recoveryDispositionHistory){
  const i=h.receipt.intent,receipt=await authority.recoveryDisposition({action:'receipt',unit:i.unit,eventId:i.eventId})
  if(receipt===null||!equal(parseDispositionReceipt(receipt),h.receipt))throw new TaskConflict('Original relay disposition receipt missing or changed')
  const source=await authority.claimReceipt(h.handoff.taskId,h.handoff.claimEventId)
  if(source.status!=='recorded'||source.attemptId!==i.unit.attemptId||source.generation!==i.unit.generation||source.fingerprint!==i.unit.fingerprint)throw new TaskConflict('Original disposition source claim missing or changed')
  if(h.receipt.state==='applied'&&(await authority.claimReceipt(h.handoff.taskId,h.handoff.newClaimEventId)).status!=='blocked_before_claim')throw new TaskConflict('Original unused successor claim barrier missing')
  if(!equal(unitFor(i.unit.taskId,i.unit.attemptId,i.unit.generation,i.unit.fingerprint),i.unit))throw new TaskConflict('Original journal workspace changed')
  evidence.dispositions.push({receipt,source})
 }
 if(j.pendingRecoveryDisposition){const i=j.pendingRecoveryDisposition,r=await authority.recoveryDisposition({action:'receipt',unit:i.unit,eventId:i.eventId});if(r!==null&&!equal(parseDispositionReceipt(r).intent,i))throw new TaskConflict('Original pending disposition identity changed');if(!equal(unitFor(i.unit.taskId,i.unit.attemptId,i.unit.generation,i.unit.fingerprint),i.unit))throw new TaskConflict('Original journal workspace changed');evidence.pending.push(r)}
 if(j.pendingHandoff){
  const p=j.pendingHandoff,u=unitFor(p.taskId,p.attemptId,p.generation,p.fingerprint),source=await authority.claimReceipt(p.taskId,p.claimEventId)
  if(source.status!=='recorded'||source.attemptId!==p.attemptId||source.generation!==p.generation||source.fingerprint!==p.fingerprint)throw new TaskConflict('Original pending source claim changed')
  if(p.accountCandidateId){
   if(!authority.accountHandoff)throw new TaskConflict('Original candidate handoff status transport required')
   const status=parseHandoffStatus(await authority.accountHandoff({action:'status',unit:u}),u,clock()),action=status.actions.find((a:any)=>a.id===p.eventId)
   evidence.pending.push(action??null)
   if(action&&(action.candidate.id!==p.accountCandidateId||action.production?.jobId!==job.id||action.production.claimEventId!==p.claimEventId||action.production.newClaimEventId!==p.newClaimEventId||action.candidate.context.target.deviceId!==p.deviceId||action.candidate.context.target.profileId!==p.profileId))throw new TaskConflict('Original pending candidate handoff identity changed')
  }
 }
 // Validate every referenced unit against the retained original family. Counters remain at the relay; none are imported as authority.
 const groups=new Map<string,RecoveryUnit[]>()
 for(const u of units.values())groups.set(u.taskId,[...(groups.get(u.taskId)??[]),u])
 for(const members of groups.values()){
  const u=members[0],proof=await authority.recoveryDisposition({action:'proof',unit:u})
  exact(proof,['schema','unit','checkedAt','stateDigest','units','budget','receipts']);parseRecoveryBudget(proof.budget)
  if(proof.schema!=='portable-recovery-proof/1'||!equal(proof.unit,u)||!Number.isSafeInteger(proof.checkedAt)||proof.checkedAt>clock()||clock()-proof.checkedAt>=15000||!(/^[a-f0-9]{64}$/).test(proof.stateDigest)||!Array.isArray(proof.units)||proof.units.length<1||proof.units.length>16)throw new TaskConflict('Fresh original recovery family proof required')
  const keys=new Set(proof.units.map((v:any)=>recoveryUnitKey(v)));if(keys.size!==proof.units.length||members.some(v=>!keys.has(recoveryUnitKey(v))))throw new TaskConflict('Original recovery lineage references changed')
  if(!Array.isArray(proof.receipts)||proof.receipts.length>16)throw new TaskConflict('Bounded original family audit required')
  for(const receipt of proof.receipts)parseDispositionReceipt(receipt)
  const exported=j.familyReceipts.filter(r=>r.root.taskId===u.taskId)
  if(!collect&&!equal(exported,proof.receipts)||collect&&exported.some(r=>!proof.receipts.some((p:any)=>equal(r,p))))throw new TaskConflict('Original family disposition receipts omitted or changed')
  evidence.families.push({unit:u,stateDigest:proof.stateDigest,units:proof.units,budget:proof.budget,receipts:proof.receipts})
 }
 return JSON.parse(JSON.stringify(evidence))
}
export function assertImportedJournalRetained(job:ProductionJob,j:PortableRecoveryJournal){
 const prefix=(expected:any[],actual:any[])=>expected.every((v,n)=>actual[n]!==undefined&&equal(v,actual[n]))
 if(!prefix(j.familyReceipts,job.portableFamilyReceipts??[])||!prefix(j.handoffHistory,job.handoffHistory??[])||!prefix(j.recoveryDispositionHistory,job.recoveryDispositionHistory??[]))throw new TaskConflict('Original imported journal history was removed or changed')
 if(j.pendingRecoveryDisposition&&job.pendingRecoveryDisposition?.eventId===j.pendingRecoveryDisposition.eventId&&!equal(job.pendingRecoveryDisposition,j.pendingRecoveryDisposition))throw new TaskConflict('Original imported pending decision changed')
 if(j.pendingHandoff&&job.pendingHandoff?.eventId===j.pendingHandoff.eventId&&!equal(job.pendingHandoff,j.pendingHandoff))throw new TaskConflict('Original imported pending handoff changed')
 if(j.pendingRecoveryDisposition&&job.pendingRecoveryDisposition?.eventId!==j.pendingRecoveryDisposition.eventId&&!job.recoveryDispositionHistory?.some(h=>h.receipt.intent.eventId===j.pendingRecoveryDisposition!.eventId))throw new TaskConflict('Original imported pending decision was lost')
 if(j.pendingHandoff&&job.pendingHandoff?.eventId!==j.pendingHandoff.eventId&&!job.handoffHistory?.some(h=>h.eventId===j.pendingHandoff!.eventId)&&!job.recoveryDispositionHistory?.some(h=>h.handoff.eventId===j.pendingHandoff!.eventId&&h.receipt.state==='applied'))throw new TaskConflict('Original imported pending handoff was lost')
}
