import {retainedInventory} from './retainedInventory'
import type {TaskSql,TaskAuthority} from './taskAuthority'
import type {RecoveryStops} from './recoveryStops'
import type {AccountHandoffAuthority} from './accountHandoff'
import type {CandidateAdoptionAuthority} from './candidateAdoption'
import {TaskConflict,canonicalJson,type TaskPrincipal,type CoordinatorFence} from '../../server/src/services/managedTaskProtocol'
import {recoveryExact,recoveryId} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {recoveryUnitKey,type RecoveryUnit} from '../../server/src/services/automationRecoveryPolicy'
import {recoveryFamilyUnits,RECOVERY_LEDGER_TABLES} from './recoveryLineage'
import {readRecoveryLedger,sharedRecoveryBudget} from './recoveryBudget'
import {parseRecoveryStopReceipt} from '../../server/src/services/recoveryStopProtocol'
import {artifactHash} from '../../server/src/services/managedCropArtifact'
import {RECOVERY_DISPOSITION_SCHEMA,parseDispositionIntent,parseDispositionReceipt,dispositionPermissions,type DispositionIntent,type DispositionReceipt} from '../../server/src/services/recoveryDispositionProtocol'
import {boundedBody} from './managedArtifactStorage'
export class RecoveryDispositionAuthority {
 constructor(private sql:TaskSql,private tx:<T>(f:()=>T)=>T,private authority:TaskAuthority,private stops:RecoveryStops,private handoff:AccountHandoffAuthority,private adoption:CandidateAdoptionAuthority,private now=Date.now){
  sql.exec('CREATE TABLE IF NOT EXISTS managed_recovery_disposition_events (id TEXT PRIMARY KEY, root_id TEXT NOT NULL, body TEXT NOT NULL)')
 }
 private studio(actor:TaskPrincipal){if(actor.role!=='studio')throw new TaskConflict('Studio recovery disposition required')}
 private prior(i:DispositionIntent){const row=this.sql.exec<{body:string}>('SELECT body FROM managed_recovery_disposition_events WHERE id = ?',i.eventId).toArray()[0];if(!row)return null;const receipt=parseDispositionReceipt(JSON.parse(row.body));if(canonicalJson(receipt.intent)!==canonicalJson(i))throw new TaskConflict('Immutable original disposition identity conflict');return receipt}
 private capture(unit:RecoveryUnit){
  this.authority.assertWorkspace(unit.taskId,unit.workspaceId)
  const units=recoveryFamilyUnits(this.sql,unit),raw:any={units,records:[],stops:[],dispatch:[],attempts:[],commands:[]},actions:any[]=[]
  for(const member of units){
   const key=recoveryUnitKey(member)
   for(const table of RECOVERY_LEDGER_TABLES){const record=readRecoveryLedger(this.sql,table,member);if(!record)continue;raw.records.push({key,table,record});for(const a of record.actions)actions.push({reference:{unit:member,ledger:table,actionId:a.id},phase:a.phase,expiresAt:a.expiresAt??null,unusedClosable:table==='managed_candidate_adoption_episodes'&&a.phase==='reserved'||table==='managed_account_handoff_episodes'&&['reserved','prepared'].includes(a.phase),productionRequired:table==='managed_account_handoff_episodes'&&!!a.production})}
   const stop=this.sql.exec<{body:string}>('SELECT body FROM managed_recovery_stops WHERE id = ?',key).toArray()[0];if(stop)raw.stops.push(parseRecoveryStopReceipt(JSON.parse(stop.body)))
   const dispatch=this.sql.exec<{body:string}>('SELECT body FROM managed_recovery_dispatch WHERE unit_id = ? ORDER BY id LIMIT 17',key).toArray();if(dispatch.length>16)throw new TaskConflict('Preserve conflicting delivery inventory');raw.dispatch.push(...dispatch.map(r=>r.body))
   const attempt=this.sql.exec<{body:string}>('SELECT body FROM managed_attempts WHERE id = ?',member.attemptId).toArray()[0];if(!attempt)throw new TaskConflict('Original attempt history required');raw.attempts.push(attempt.body)
   const id=JSON.parse(attempt.body).activeCommandId,command=this.sql.exec<{body:string}>('SELECT body FROM managed_commands WHERE id = ?',id).toArray()[0];raw.commands.push(command?.body??null)
  }
  raw.task=this.sql.exec<{body:string}>('SELECT body FROM managed_tasks WHERE id = ?',unit.taskId).toArray()[0]?.body
  raw.reservations=this.sql.exec('SELECT resource,attempt_id FROM managed_reservations ORDER BY resource LIMIT 1001').toArray().map(r=>({resource:r.resource,attempt_id:r.attempt_id}));if(raw.reservations.length>1000)throw new TaskConflict('Reservation inventory requires pagination')
  const root=units[0],rows=this.sql.exec<{body:string}>('SELECT body FROM managed_recovery_disposition_events WHERE root_id = ? ORDER BY rowid LIMIT 17',recoveryUnitKey(root)).toArray();if(rows.length>16)throw new TaskConflict('Preserve disposition history')
  const history=rows.map(r=>parseDispositionReceipt(JSON.parse(r.body)));raw.history=history
  const budget=sharedRecoveryBudget(this.sql,unit),encoded=canonicalJson(raw);if(encoded.length>1000000)throw new TaskConflict('Family inventory exceeds inspection bound')
  return {units,root,raw,encoded,actions,budget,history}
 }
 private async token(encoded:string,checkedAt:number){return artifactHash(new TextEncoder().encode(canonicalJson([checkedAt,encoded])))}
 async inspect(actor:TaskPrincipal,unit:RecoveryUnit){this.studio(actor);const checkedAt=this.now(),c=this.tx(()=>this.capture(unit)),inspectionToken=await this.token(c.encoded,checkedAt);return {schema:RECOVERY_DISPOSITION_SCHEMA,unit,root:c.root,checkedAt,inspectionToken,units:c.units,actions:c.actions,budget:c.budget,history:c.history,...dispositionPermissions}}
 private save(receipt:DispositionReceipt){
  const count=retainedInventory(this.sql,'managed_recovery_disposition_events',4096),local=this.sql.exec('SELECT id FROM managed_recovery_disposition_events WHERE root_id = ? LIMIT 17',recoveryUnitKey(receipt.root)).toArray().length
  if(count>=4096||local>=16||receipt.intent.mode!=='retain_hold'&&(count>=3968||local>=15))throw new TaskConflict('Disposition inventory preserves its final hold capacity')
  parseDispositionReceipt(receipt);this.sql.exec('INSERT INTO managed_recovery_disposition_events (id,root_id,body) VALUES (?,?,?)',receipt.intent.eventId,recoveryUnitKey(receipt.root),JSON.stringify(receipt));return receipt
 }
 async apply(actor:TaskPrincipal,raw:unknown,coordinator?:CoordinatorFence):Promise<DispositionReceipt>{
  this.studio(actor);const i=parseDispositionIntent(raw);this.authority.assertWorkspace(i.unit.taskId,i.unit.workspaceId)
  if(i.production){if(!coordinator)throw new TaskConflict('Current production coordinator required');this.authority.assertAccountHandoffCoordinator(i.unit,coordinator)}
  const old=this.tx(()=>this.prior(i));if(old)return old
  if(this.now()<i.inspectedAt||this.now()-i.inspectedAt>=15000)throw new TaskConflict('Disposition inspection expired; reconcile the original decision before inspecting again')
  const c=this.tx(()=>this.capture(i.unit));if(await this.token(c.encoded,i.inspectedAt)!==i.inspectionToken)throw new TaskConflict('Recovery family changed; inspect its original state again')
  return this.tx(()=>{
   const prior=this.prior(i);if(prior)return prior
   if(this.now()-i.inspectedAt>=15000||this.now()<i.inspectedAt||this.capture(i.unit).encoded!==c.encoded)throw new TaskConflict('Recovery family or inspection changed before disposition')
   let closed:DispositionReceipt['closed']=null,stop:any=null,successorClaimBlocked:string|null=null
   if(i.mode==='retain_hold'){
    const last=c.raw.stops.find((s:any)=>recoveryUnitKey(s.unit)===recoveryUnitKey(c.root))
    stop=last&&last.mode!=='reinspect'?last:this.stops.apply(actor,{schema:'recovery-stop/1',unit:c.root,eventId:'hold_'+i.eventId,sequence:(last?.sequence??0)+1,mode:'pause'})
   }else {
    const ref=i.reference!;if(!c.units.some(u=>recoveryUnitKey(u)===recoveryUnitKey(ref.unit)))throw new TaskConflict('Action belongs to another recovery family')
    if(!['managed_candidate_adoption_episodes','managed_account_handoff_episodes'].includes(ref.ledger))throw new TaskConflict('Started or unenrolled outcomes require their original reconciliation')
    const record=readRecoveryLedger(this.sql,ref.ledger,ref.unit),action=record?.actions.find((a:any)=>a.id===ref.actionId)
    if(action&&!['reserved','prepared','safe_failure'].includes(action.phase)||ref.ledger==='managed_candidate_adoption_episodes'&&action?.phase==='prepared')throw new TaskConflict('Started, unknown or committed outcomes must remain held')
    if(!!action?.production!==!!i.production&&action||!action&&!i.production)throw new TaskConflict('Original production mode or unused approval required')
    if(i.production){
     if(ref.ledger!=='managed_account_handoff_episodes')throw new TaskConflict('Production disposition requires the original handoff')
     const {candidateId,...production}=i.production
     if(action&&(canonicalJson(action.production)!==canonicalJson(production)||action.candidate.id!==candidateId))throw new TaskConflict('Original pending production identity mismatch')
     const {task,attempt}=this.authority.artifactOwner(actor,ref.unit.taskId,ref.unit.attemptId,ref.unit.generation,ref.unit.fingerprint),source=this.authority.productionClaim(actor,ref.unit.taskId,production.claimEventId),next=this.authority.productionClaim(actor,ref.unit.taskId,production.newClaimEventId)
     if(!['paused','cancelled'].includes(task.state)||attempt.phase!=='stop_confirmed'||attempt.submission!=='unsent'||attempt.checkpointRef||source.status!=='recorded'||source.attemptId!==ref.unit.attemptId||source.generation!==ref.unit.generation||source.fingerprint!==ref.unit.fingerprint||!['missing','blocked_before_claim'].includes(next.status))throw new TaskConflict('Only the original unused stopped production claim can be disposed')
     const command=this.sql.exec<{body:string}>('SELECT body FROM managed_commands WHERE id = ?',attempt.activeCommandId).toArray()[0],stopCommand=command?JSON.parse(command.body):null
     if(stopCommand?.action!=='stop'||stopCommand.phase!=='stop_confirmed'||stopCommand.taskId!==ref.unit.taskId||stopCommand.attemptId!==ref.unit.attemptId||stopCommand.generation!==ref.unit.generation||stopCommand.fingerprint!==ref.unit.fingerprint)throw new TaskConflict('Exact acknowledged original stop command required')
     const blocked=this.authority.stopClaim(actor,'dispose_'+i.eventId,ref.unit.taskId,production.newClaimEventId,coordinator,true)
     if(!('blockedBeforeClaim' in blocked)||!blocked.blockedBeforeClaim)throw new TaskConflict('Unused successor claim barrier required')
     successorClaimBlocked=production.newClaimEventId
    }
    if(!action)closed={fromPhase:'missing',toPhase:'missing'}
    else {
     const phase=action.phase
     if(phase!=='safe_failure'){
      if(ref.ledger==='managed_account_handoff_episodes')this.handoff.cancel(actor,ref.unit,action.id,record.revision)
      else this.adoption.cancel(actor,ref.unit,action.context.target,action.id,record.revision)
     }
     closed={fromPhase:phase,toPhase:'safe_failure'}
    }
   }
   const after=this.capture(i.unit)
   if(c.raw.task!==after.raw.task||canonicalJson(c.raw.attempts)!==canonicalJson(after.raw.attempts)||canonicalJson(c.raw.reservations)!==canonicalJson(after.raw.reservations)||c.budget.used!==after.budget.used||c.budget.uiUsed!==after.budget.uiUsed)throw new TaskConflict('Disposition cannot change ownership, reservations or original charges')
   return this.save({schema:RECOVERY_DISPOSITION_SCHEMA,intent:i,root:c.root,receivedAt:this.now(),state:'applied',beforeBudget:c.budget,afterBudget:after.budget,closed,successorClaimBlocked,stop,...dispositionPermissions})
  })
 }
 async portableProof(actor:TaskPrincipal,unit:RecoveryUnit){
  this.studio(actor);const checkedAt=this.now(),c=this.tx(()=>this.capture(unit)),stateDigest=await artifactHash(new TextEncoder().encode(c.encoded))
  return {schema:'portable-recovery-proof/1',unit,checkedAt,stateDigest,units:c.units,budget:c.budget,receipts:c.history}
 }
 receipt(actor:TaskPrincipal,unit:RecoveryUnit,eventId:string):DispositionReceipt|null {
  this.studio(actor);recoveryUnitKey(unit);this.authority.assertWorkspace(unit.taskId,unit.workspaceId)
  if(!recoveryId(eventId)||eventId.length>96)throw new TaskConflict('Original disposition event required')
  return this.tx(()=>{const row=this.sql.exec<{body:string}>('SELECT body FROM managed_recovery_disposition_events WHERE id = ?',eventId).toArray()[0];if(!row)return null;const receipt=parseDispositionReceipt(JSON.parse(row.body));if(recoveryUnitKey(receipt.intent.unit)!==recoveryUnitKey(unit))throw new TaskConflict('Original disposition receipt unit mismatch');return receipt})
 }
 resolve(actor:TaskPrincipal,raw:unknown):DispositionReceipt|null {
  this.studio(actor);const i=parseDispositionIntent(raw);this.authority.assertWorkspace(i.unit.taskId,i.unit.workspaceId)
  return this.tx(()=>{const prior=this.prior(i);if(prior)return prior
   if(this.now()<i.inspectedAt+15000)return null
   // Terminal audit fence prevents any delayed original request from applying, even if the clock later changes.
   const c=this.capture(i.unit);return this.save({schema:RECOVERY_DISPOSITION_SCHEMA,intent:i,root:c.root,receivedAt:this.now(),state:'not_applied_expired',beforeBudget:c.budget,afterBudget:c.budget,closed:null,successorClaimBlocked:null,stop:null,...dispositionPermissions})
  })
 }
}
export async function recoveryDispositionApi(request:Request,actor:TaskPrincipal,owner:RecoveryDispositionAuthority,workspace:string){
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let b:any;try{b=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,16000)))}catch{throw new TaskConflict('Bounded recovery disposition request required')}
 if(b.schema!==RECOVERY_DISPOSITION_SCHEMA||b.workspaceId!==workspace)throw new TaskConflict('Exact disposition workspace required')
 let result:any
 if(b.action==='inspect'){recoveryExact(b,['schema','workspaceId','action','unit']);if(b.unit?.workspaceId!==workspace)throw new TaskConflict('Original workspace required');result=await owner.inspect(actor,b.unit)}
 else if(b.action==='apply'){recoveryExact(b,['schema','workspaceId','action','intent',...(b.coordinator!==undefined?['coordinator']:[])]);if(b.intent?.unit?.workspaceId!==workspace)throw new TaskConflict('Original workspace required');if(b.coordinator)recoveryExact(b.coordinator,['coordinatorId','coordinatorGeneration']);result=await owner.apply(actor,b.intent,b.coordinator)}
 else if(b.action==='proof'){recoveryExact(b,['schema','workspaceId','action','unit']);if(b.unit?.workspaceId!==workspace)throw new TaskConflict('Original workspace required');result=await owner.portableProof(actor,b.unit)}
 else if(b.action==='receipt'){recoveryExact(b,['schema','workspaceId','action','unit','eventId']);if(b.unit?.workspaceId!==workspace)throw new TaskConflict('Original workspace required');result=owner.receipt(actor,b.unit,b.eventId)}
 else if(b.action==='resolve'){recoveryExact(b,['schema','workspaceId','action','intent']);if(b.intent?.unit?.workspaceId!==workspace)throw new TaskConflict('Original workspace required');result=owner.resolve(actor,b.intent)}
 else throw new TaskConflict('Exact recovery disposition action required')
 return Response.json(result,{headers:{'Cache-Control':'no-store'}})
}
