import {initTaskArchive} from './retainedInventory'
import {parseProductionCandidateHandoff,type ProductionCandidateHandoff,parseHandoffRecord} from '../../server/src/services/accountHandoffProtocol'
import {recordReleasedRecoveryLineage} from './recoveryLineage'
import {recoveryUnitKey} from '../../server/src/services/automationRecoveryPolicy'
import {parseCorrectionRecord} from '../../server/src/services/correctionRecoveryProtocol'
import {initRecoveryBudget,assertRecoveryControls,assertRecoveryReservation,sharedRecoveryBudget} from './recoveryBudget'
import {AccountAuthority,AccountWaiting} from './accountAuthority'
import type {LocalManagedAttempt} from '../../server/src/services/managedReconnect'
/** Phase 3 authority foundation. Transport must supply an authenticated principal; no socket-send means execution. */
export type TaskSqlValue = string | number | ArrayBuffer | null
export interface TaskSql {
  exec<T extends Record<string,TaskSqlValue> = Record<string,TaskSqlValue>>(query:string,...bindings:TaskSqlValue[]): {toArray():T[]}
}
import { TaskConflict, canonicalJson, cropTaskIdentity, type ProductionClaimReceipt,type CoordinatorFence,type CoordinatorLease,type TaskPrincipal, type CropSpec, type CropIdentity, type CropTask, type CropAttempt, type UploadOnlyEvidence, type UploadOnlyReport, type CancelledSubmissionEvidence, type CancelledSubmissionReport, type CancelledUnknownEvidence, type CancelledUnknownReport } from '../../server/src/services/managedTaskProtocol'
import {DEFAULT_CROP_CAPABILITY,DEFAULT_CROP_PROMPT,SLICED_CROP_CAPABILITY,requireDefaultCropPilot} from '../../server/src/services/managedCropPilotPolicy'
export * from '../../server/src/services/managedTaskProtocol'
const id=(v:unknown):v is string=>typeof v==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)
const digest=(v:unknown):v is string=>typeof v==='string' && /^[a-f0-9]{64}$/.test(v)
import type { ManagedArtifactRecord as Artifact } from '../../server/src/services/managedCropArtifact'
const CAPS=['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1']
export class TaskAuthority {
  readonly accounts:AccountAuthority
  constructor(private sql:TaskSql,private transaction:<T>(work:()=>T)=>T,private now=()=>new Date().toISOString(),private uuid=()=>crypto.randomUUID(),private handoffEnabled=()=>false) {
    initTaskArchive(sql)
    initRecoveryBudget(sql)
    for(const table of ['tasks','attempts','commands','artifacts','enrollment','peers','uploads','recoveries','upload_only_reports','cancelled_submission_reports','cancelled_unknown_reports','claim_stops','coordinators','production_attempts']) sql.exec(`CREATE TABLE IF NOT EXISTS managed_${table} (id TEXT PRIMARY KEY, body TEXT NOT NULL)`)
    sql.exec('CREATE TABLE IF NOT EXISTS managed_artifact_budget (id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL, slots INTEGER NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS managed_reservations (resource TEXT PRIMARY KEY, attempt_id TEXT NOT NULL)')
    sql.exec("CREATE INDEX IF NOT EXISTS managed_commands_task ON managed_commands(json_extract(body,'$.taskId'),id)")
    sql.exec("CREATE INDEX IF NOT EXISTS managed_attempts_device_phase ON managed_attempts(json_extract(body,'$.deviceId'),json_extract(body,'$.phase'))")
    sql.exec('CREATE INDEX IF NOT EXISTS managed_reservations_attempt ON managed_reservations(attempt_id)')
    sql.exec("CREATE INDEX IF NOT EXISTS managed_artifacts_task ON managed_artifacts(json_extract(body,'$.taskId'),json_extract(body,'$.attemptId'))")
    sql.exec("CREATE INDEX IF NOT EXISTS managed_tasks_page ON managed_tasks(json_extract(body,'$.workspaceId'),json_extract(body,'$.pageId'))")
    sql.exec('CREATE TABLE IF NOT EXISTS managed_events (id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL)')
    this.accounts=new AccountAuthority(sql,transaction,()=>Date.parse(this.now()),(resource,attemptId)=>this.reviewedPageQuarantine(resource,attemptId))
  }
  private get<T>(table:string,key:string):T|null {const row=this.sql.exec<{body:string}>(`SELECT body FROM managed_${table} WHERE id = ?`,key).toArray()[0];return row?JSON.parse(row.body):null}
  private put(table:string,key:string,value:unknown):void{this.sql.exec(`INSERT INTO managed_${table} (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`,key,JSON.stringify(value))}
  /** Called inside the authority transaction. Never retire unresolved or reserved work. */
  private archiveCompleted(){
    const rows=this.sql.exec<{id:string;body:string}>(`
      SELECT t.id,t.body FROM managed_tasks t
      LEFT JOIN managed_attempts a ON a.id=json_extract(t.body,'$.attemptId')
      WHERE t.id NOT IN (SELECT id FROM managed_task_archive)
      AND (
        (json_extract(t.body,'$.state')='verified_complete'
          AND json_extract(t.body,'$.canonical') IS NOT NULL
          AND json_extract(a.body,'$.phase')='published')
        OR (json_extract(t.body,'$.state') IN ('cancelled','superseded')
          AND (json_extract(t.body,'$.attemptId') IS NULL
            OR (json_extract(a.body,'$.phase')='stop_confirmed'
              AND json_extract(a.body,'$.submission')='unsent'
              AND json_extract(a.body,'$.checkpointRef') IS NULL)))
      )
      AND NOT EXISTS (
        SELECT 1 FROM managed_reservations r
        JOIN managed_attempts prior ON prior.id=r.attempt_id
        WHERE json_extract(prior.body,'$.taskId')=t.id
      ) LIMIT 64
    `).toArray()
    for(const row of rows){
      const task=JSON.parse(row.body) as CropTask,attempt=task.attemptId?this.get<CropAttempt>('attempts',task.attemptId):null
      const complete=task.state==='verified_complete'&&!!task.canonical&&attempt?.phase==='published'
      const stopped=task.state!=='verified_complete'&&(!task.attemptId||attempt?.phase==='stop_confirmed'&&attempt.submission==='unsent'&&!attempt.checkpointRef)
      if(!complete&&!stopped||this.sql.exec("SELECT r.resource FROM managed_reservations r JOIN managed_attempts a ON a.id=r.attempt_id WHERE json_extract(a.body,'$.taskId')=? LIMIT 1",task.id).toArray().length)continue
      this.sql.exec('INSERT INTO managed_task_archive (id,archived_at) VALUES (?,?)',task.id,this.now())
      const upload=this.get<{bytes:number}>('uploads',task.id)
      if(upload&&!this.sql.exec('SELECT id FROM managed_released_uploads WHERE id=?',task.id).toArray().length){
        const budget=this.sql.exec<{bytes:number;slots:number}>('SELECT bytes,slots FROM managed_artifact_budget WHERE id=1').toArray()[0]
        if(!budget||budget.bytes<upload.bytes||budget.slots<1)throw new TaskConflict('Retain inconsistent upload budget for reconciliation')
        this.sql.exec('UPDATE managed_artifact_budget SET bytes=bytes-?,slots=slots-1 WHERE id=1',upload.bytes)
        this.sql.exec('INSERT INTO managed_released_uploads (id,bytes) VALUES (?,?)',task.id,upload.bytes)
      }
    }
  }
  private studio(actor:TaskPrincipal):void{if(actor.role!=='studio') throw new TaskConflict('Studio authority required')}
  private once<T>(actor:TaskPrincipal,eventId:string,payload:unknown,work:()=>T,guard?:()=>void):T {
    if(!id(eventId)) throw new TaskConflict('Immutable event ID required')
    const encoded=canonicalJson([actor,payload])
    return this.transaction(()=>{
      guard?.() // Authorization is current even when immutable operation results replay.
      const prior=this.sql.exec<{payload:string;result:string}>('SELECT payload,result FROM managed_events WHERE id = ?',eventId).toArray()[0]
      if(prior){if(prior.payload!==encoded)throw new TaskConflict('Conflicting event ID');return JSON.parse(prior.result)}
      const result=work()
      this.sql.exec('INSERT INTO managed_events (id,payload,result,at) VALUES (?,?,?,?)',eventId,encoded,JSON.stringify(result),this.now())
      return result
    })
  }
  /** Read the immutable original receipt; never replay a claim or infer its owner from the current task. */
  productionClaim(actor:TaskPrincipal,taskId:string,claimEventId:string):ProductionClaimReceipt {
    this.studio(actor);this.task(taskId)
    if(!id(claimEventId))throw new TaskConflict('Exact claim event ID required')
    const receipt=this.sql.exec<{payload:string;result:string}>('SELECT payload,result FROM managed_events WHERE id = ?',claimEventId).toArray()[0]
    if(!receipt){
      const stop=this.get<{taskId:string}>('claim_stops',claimEventId)
      if(stop&&stop.taskId!==taskId)throw new TaskConflict('Claim stop belongs to another task')
      return {taskId,claimEventId,status:stop?'blocked_before_claim':'missing'}
    }
    const [principal,payload]=JSON.parse(receipt.payload)
    if(principal.role!=='studio'||payload.action!=='claim'||payload.taskId!==taskId)throw new TaskConflict('Exact Studio claim receipt required')
    const result=JSON.parse(receipt.result) as {task:CropTask;attempt:CropAttempt},attempt=result.attempt
    if(!attempt||attempt.taskId!==taskId||result.task.id!==taskId||attempt.generation!==result.task.generation||result.task.attemptId!==attempt.id)throw new TaskConflict('Invalid retained original claim receipt')
    return {taskId,claimEventId,status:'recorded',fingerprint:result.task.fingerprint,attemptId:attempt.id,generation:attempt.generation,deviceId:attempt.deviceId,profileId:attempt.profileId,accountId:attempt.accountId}
  }
  coordinator(actor:TaskPrincipal,workspaceId:string):CoordinatorLease|null {this.studio(actor);return this.coordinatorState(workspaceId)}
  private coordinatorState(workspaceId:string):CoordinatorLease|null {
    const lease=this.get<CoordinatorLease>('coordinators',workspaceId)
    if(lease&&(lease.workspaceId!==workspaceId||!id(lease.coordinatorId)||!Number.isSafeInteger(lease.coordinatorGeneration)||lease.coordinatorGeneration<1||!['held','released'].includes(lease.state)||!Number.isFinite(Date.parse(lease.leaseExpiresAt))))throw new TaskConflict('Invalid retained coordinator state; reconcile without replacing it')
    return lease
  }
  private requireCoordinator(workspaceId:string,fence:CoordinatorFence,allowExpired=false) {
    const lease=this.coordinatorState(workspaceId)
    if(!lease||lease.state!=='held'&&!(allowExpired&&lease.state==='released')||lease.coordinatorId!==fence.coordinatorId||lease.coordinatorGeneration!==fence.coordinatorGeneration||!allowExpired&&Date.parse(lease.leaseExpiresAt)<=Date.parse(this.now()))throw new TaskConflict('Stale or expired production coordinator')
    return lease
  }
  private requirePilotControl(taskId:string) {
    const task=this.task(taskId),lease=this.coordinatorState(task.workspaceId)
    if(lease?.state==='held'||task.attemptId&&this.get('production_attempts',task.attemptId))throw new TaskConflict('Use the current production coordinator; retained ownership cannot be bypassed')
  }
  acquireCoordinator(actor:TaskPrincipal,eventId:string,workspaceId:string,coordinatorId:string,expectedGeneration:number) {
    this.studio(actor)
    if(!id(workspaceId)||!id(coordinatorId)||!Number.isSafeInteger(expectedGeneration)||expectedGeneration<0)throw new TaskConflict('Exact coordinator identity and prior generation required')
    return this.once(actor,eventId,{action:'coordinator_acquire',workspaceId,coordinatorId,expectedGeneration},()=>{
      const prior=this.coordinatorState(workspaceId),generation=prior?.coordinatorGeneration??0
      if(expectedGeneration!==generation||prior?.state==='held'&&Date.parse(prior.leaseExpiresAt)>Date.parse(this.now()))throw new TaskConflict('Another coordinator owns production or its generation changed')
      if(!Number.isSafeInteger(generation+1))throw new TaskConflict('Coordinator generation exhausted')
      const lease:CoordinatorLease={workspaceId,coordinatorId,coordinatorGeneration:generation+1,state:'held',leaseExpiresAt:new Date(Date.parse(this.now())+60_000).toISOString()}
      this.put('coordinators',workspaceId,lease);return lease
    })
  }
  updateCoordinator(actor:TaskPrincipal,eventId:string,workspaceId:string,fence:CoordinatorFence,release:boolean) {
    this.studio(actor)
    return this.once(actor,eventId,{action:release?'coordinator_release':'coordinator_renew',workspaceId,...fence},()=>{
      const lease=this.requireCoordinator(workspaceId,fence,release)
      if(release)lease.state='released';else lease.leaseExpiresAt=new Date(Date.parse(this.now())+60_000).toISOString()
      this.put('coordinators',workspaceId,lease);return lease
    },()=>this.requireCoordinator(workspaceId,fence,release))
  }
  registerPeer(actor:TaskPrincipal,eventId:string,profileIds:string[],capabilities:string[],apkVersion:string) {
    if(actor.role!=='phone')throw new TaskConflict('Authenticated worker required')
    return this.once(actor,eventId,{action:'hello',profileIds,capabilities,apkVersion},()=>{
      const peer={deviceId:actor.deviceId,profileIds,capabilities,apkVersion,receivedAt:this.now()}
      this.put('peers',actor.deviceId,peer);return peer
    })
  }
  enroll(actor:TaskPrincipal,eventId:string,deviceId:string,profileId:string,capabilities:string[]) {
    this.studio(actor)
    if(!id(deviceId)||!id(profileId)||!Array.isArray(capabilities)||!CAPS.every(c=>capabilities.includes(c)))throw new TaskConflict('Compatible device and explicit profile required')
    return this.once(actor,eventId,{action:'enroll',deviceId,profileId,capabilities},()=>{const entry={deviceId,profileId,capabilities};this.put('enrollment',deviceId,entry);return entry})
  }
  async plan(actor:TaskPrincipal,eventId:string,identity:CropIdentity,spec:CropSpec):Promise<CropTask> {
    this.studio(actor);identity=structuredClone(identity);spec=structuredClone(spec);const computed=await cropTaskIdentity(identity,spec)
    return this.once(actor,eventId,{action:'plan',identity,spec},()=>{
      const old=this.get<CropTask>('tasks',computed.taskId);if(old)return old
      // One page cannot run two input revisions concurrently. Old output remains historical.
      this.archiveCompleted()
      const active=this.sql.exec<{body:string}>('SELECT body FROM managed_tasks WHERE id NOT IN (SELECT id FROM managed_task_archive) LIMIT 1001').toArray()
      if(active.length>=1000)throw new TaskConflict('Pilot task bound reached')
      if(active.some(r=>{
        const t=JSON.parse(r.body) as CropTask
        if(t.workspaceId!==identity.workspaceId||t.pageId!==identity.pageId||!t.attemptId)return false
        const attempt=this.get<CropAttempt>('attempts',t.attemptId)
        return !['verified_complete','cancelled','superseded'].includes(t.state)||!attempt||!['published','stop_confirmed'].includes(attempt.phase)||this.sql.exec('SELECT resource FROM managed_reservations WHERE attempt_id = ? LIMIT 1',t.attemptId).toArray().length>0
      }))throw new TaskConflict('Reconcile the prior page revision before planning another')
      const task:CropTask={...identity,id:computed.taskId,fingerprint:computed.fingerprint,spec,state:'queued',generation:0,attemptId:null,canonical:null}
      this.put('tasks',task.id,task);return task
    })
  }
  unenroll(actor:TaskPrincipal,eventId:string,deviceId:string) {
    this.studio(actor);if(!id(deviceId))throw new TaskConflict('Invalid device')
    return this.once(actor,eventId,{action:'unenroll',deviceId},()=>{
      const reserved=this.sql.exec('SELECT attempt_id FROM managed_reservations WHERE resource = ?',`device:${deviceId}`).toArray()
      const active=this.sql.exec("SELECT id FROM managed_attempts WHERE json_extract(body,'$.deviceId') = ? AND json_extract(body,'$.phase') NOT IN ('published','stop_confirmed') LIMIT 1",deviceId).toArray()
      if(reserved.length||active.length)throw new TaskConflict('Stop and reconcile managed work before unpairing')
      this.sql.exec('DELETE FROM managed_enrollment WHERE id = ?',deviceId)
      // Re-enrollment now requires a new phone handshake, which durably blocks legacy starts first.
      this.sql.exec('DELETE FROM managed_peers WHERE id = ?',deviceId)
      return {deviceId,enrolled:false}
    })
  }
  workerEnrollment(actor:TaskPrincipal) {
    if(actor.role!=='phone')throw new TaskConflict('Authenticated worker required')
    return {enrolled:!!this.get('enrollment',actor.deviceId),peerRegistered:!!this.get('peers',actor.deviceId),reserved:!!this.sql.exec('SELECT attempt_id FROM managed_reservations WHERE resource = ?',`device:${actor.deviceId}`).toArray().length}
  }
  workerTask(actor:TaskPrincipal,taskId:string) {
    if(actor.role!=='phone')throw new TaskConflict('Authenticated worker required')
    const task=this.task(taskId)
    if(!task.attemptId)throw new TaskConflict('No assignment for this worker')
    return {...this.owned(actor,taskId,task.attemptId,task.generation,task.fingerprint),uploadOnlyReport:this.get<UploadOnlyReport>('upload_only_reports',task.attemptId),cancelledUnknownReport:this.get<CancelledUnknownReport>('cancelled_unknown_reports',task.attemptId),cancelledSubmissionReport:this.get<CancelledSubmissionReport>('cancelled_submission_reports',task.attemptId)}
  }
  claim(actor:TaskPrincipal,eventId:string,taskId:string,deviceId:string,profileId:string,accountId:string|null,coordinator?:CoordinatorFence) {
    this.studio(actor);if(!id(deviceId)||!id(profileId)||!(accountId===null||id(accountId)))throw new TaskConflict('Invalid device/profile/account reference')
    try {return this.once(actor,eventId,{action:'claim',taskId,deviceId,profileId,accountId},()=>{
      if(this.get('claim_stops',eventId))throw new TaskConflict('Production claim was stopped before dispatch')
      const result=this.allocate(taskId,deviceId,profileId,accountId)
      if(coordinator)this.put('production_attempts',result.attempt.id,{taskId,claimEventId:eventId})
      return result
    },()=>coordinator?this.requireCoordinator(this.task(taskId).workspaceId,coordinator):this.requirePilotControl(taskId))
    }catch(error){if(error instanceof AccountWaiting)this.accounts.waiting(taskId,error.selection);throw error}
  }
  /** Both the stop acknowledgment and target are exact; never transfers unknown or saved work. */
  transfer(actor:TaskPrincipal,eventId:string,taskId:string,attemptId:string,generation:number,fingerprint:string,stopCommandId:string,deviceId:string,profileId:string,production?:{coordinator:CoordinatorFence;claimEventId:string;newClaimEventId:string}) {
    this.studio(actor)
    if(!id(stopCommandId)||!id(deviceId)||!id(profileId))throw new TaskConflict('Exact stopped attempt and target required')
    return this.once(actor,eventId,{action:production?'transfer_production':'transfer_unsent',taskId,attemptId,generation,fingerprint,stopCommandId,deviceId,profileId,...(production?{claimEventId:production.claimEventId,newClaimEventId:production.newClaimEventId}:{})},()=>{
      if(production){
       const receipt=this.productionClaim(actor,taskId,production.claimEventId)
       if(receipt.status!=='recorded'||receipt.attemptId!==attemptId||receipt.generation!==generation||receipt.fingerprint!==fingerprint||!id(production.newClaimEventId)||production.newClaimEventId===production.claimEventId||production.newClaimEventId===eventId||this.sql.exec('SELECT id FROM managed_events WHERE id = ?',production.newClaimEventId).toArray().length||this.get('claim_stops',production.newClaimEventId))throw new TaskConflict('Exact original production receipt and unused target claim event required')
      }
      const {task,attempt}=this.owned(actor,taskId,attemptId,generation,fingerprint)
      const stop=this.get<{taskId:string;attemptId:string;generation:number;fingerprint:string;action:string;phase:string}>('commands',stopCommandId)
      if(task.state!=='paused'||task.canonical||attempt.phase!=='stop_confirmed'||attempt.submission!=='unsent'||attempt.checkpointRef||attempt.accountId!==null||attempt.activeCommandId!==stopCommandId||!stop||stop.action!=='stop'||stop.phase!=='stop_confirmed'||stop.taskId!==taskId||stop.attemptId!==attemptId||stop.generation!==generation||stop.fingerprint!==fingerprint)throw new TaskConflict('Only an exact acknowledged paused unsent attempt can transfer')
      if(deviceId===attempt.deviceId)throw new TaskConflict('Choose a different enrolled phone explicitly')
      for(const device of [attempt.deviceId,deviceId]) {
        const enrollment=this.get<{profileId:string;capabilities:string[]}>('enrollment',device)
        const peer=this.get<{profileIds:string[];capabilities:string[];receivedAt:string}>('peers',device)
        if(!enrollment?.capabilities.includes('worker-reconnect/1')||!peer?.capabilities.includes('worker-reconnect/1')||!peer.profileIds.includes(enrollment.profileId)||device===deviceId&&(enrollment.profileId!==profileId||Date.parse(this.now())-Date.parse(peer.receivedAt)>15*60_000))throw new TaskConflict('Both phones need native reconnect support and the target needs a fresh paired handshake')
      }
      if(this.sql.exec('SELECT resource FROM managed_reservations WHERE attempt_id = ? LIMIT 1',attemptId).toArray().length||this.sql.exec("SELECT id FROM managed_artifacts WHERE json_extract(body,'$.taskId') = ? LIMIT 1",taskId).toArray().length||this.get('uploads',taskId))throw new TaskConflict('Retained reservations or output prevent transfer')
      const sourceUnit={workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:attempt.generation,fingerprint:task.fingerprint}
      assertRecoveryReservation(this.sql,sourceUnit,eventId,Date.parse(this.now()))
      // Same immutable task/spec, new generation. Old attempt/commands stay historical.
      task.state='queued';task.attemptId=null;this.put('tasks',task.id,task)
      const next=this.allocate(taskId,deviceId,profileId,null)
      recordReleasedRecoveryLineage(this.sql,sourceUnit,{...sourceUnit,attemptId:next.attempt.id,generation:next.attempt.generation},eventId,stopCommandId,next.command.id,Date.parse(this.now()))
      if(production){
       const claim={action:'claim',taskId,deviceId,profileId,accountId:null}
       this.sql.exec('INSERT INTO managed_events (id,payload,result,at) VALUES (?,?,?,?)',production.newClaimEventId,canonicalJson([actor,claim]),JSON.stringify(next),this.now())
       this.put('production_attempts',next.attempt.id,{taskId,claimEventId:production.newClaimEventId})
      }
      return next
    },()=>production?this.requireCoordinator(this.task(taskId).workspaceId,production.coordinator):this.requirePilotControl(taskId))
  }
  assertAccountHandoffCoordinator(unit:import('../../server/src/services/automationRecoveryPolicy').RecoveryUnit,fence:CoordinatorFence){
    this.assertWorkspace(unit.taskId,unit.workspaceId);this.requireCoordinator(unit.workspaceId,fence)
  }
  assertAccountHandoffScope(unit:import('../../server/src/services/automationRecoveryPolicy').RecoveryUnit,production?:ProductionCandidateHandoff,coordinator?:CoordinatorFence){
    this.assertWorkspace(unit.taskId,unit.workspaceId)
    if(!production)this.requirePilotControl(unit.taskId)
    else {
      parseProductionCandidateHandoff(production)
      if(!coordinator)throw new TaskConflict('Current production coordinator required')
      this.requireCoordinator(unit.workspaceId,coordinator)
      const registration=this.get<{taskId:string;claimEventId:string}>('production_attempts',unit.attemptId),receipt=this.productionClaim({role:'studio'},unit.taskId,production.claimEventId)
      if(registration?.taskId!==unit.taskId||registration.claimEventId!==production.claimEventId||receipt.status!=='recorded'||receipt.attemptId!==unit.attemptId||receipt.generation!==unit.generation||receipt.fingerprint!==unit.fingerprint||production.newClaimEventId===production.claimEventId||this.sql.exec('SELECT id FROM managed_events WHERE id = ?',production.newClaimEventId).toArray().length||this.get('claim_stops',production.newClaimEventId))throw new TaskConflict('Exact original production receipt and unused successor claim required')
    }
    this.owned({role:'studio'},unit.taskId,unit.attemptId,unit.generation,unit.fingerprint)
  }
  allocateAccountHandoff(unit:import('../../server/src/services/automationRecoveryPolicy').RecoveryUnit,actionId:string,context:any,production?:{identity:ProductionCandidateHandoff;coordinator:CoordinatorFence}) {
    const actor={role:'studio'} as const;this.assertAccountHandoffScope(unit,production?.identity,production?.coordinator)
    const {task,attempt}=this.owned(actor,unit.taskId,unit.attemptId,unit.generation,unit.fingerprint)
    const row=this.sql.exec<{body:string}>('SELECT body FROM managed_account_handoff_episodes WHERE id = ?',recoveryUnitKey(unit)).toArray()[0],r=row?parseHandoffRecord(JSON.parse(row.body)):null,a=r?.actions.find(a=>a.id===actionId)
    if(a?.production&&(!production||canonicalJson(a.production)!==canonicalJson(production.identity))||!a?.production&&production)throw new TaskConflict('Original handoff production mode mismatch')
    if(!a||a.phase!=='executing'||!r?.enabled||r.paused||r.cancelled||canonicalJson(a.candidate.context)!==canonicalJson(context)||Date.parse(this.now())>=a.expiresAt)throw new TaskConflict('Original executing handoff transaction required')
    const stop=this.get<any>('commands',attempt.activeCommandId)
    if(task.state!=='paused'||task.canonical||attempt.phase!=='stop_confirmed'||attempt.submission!=='unsent'||attempt.checkpointRef||!attempt.accountSelection||!attempt.accountId||attempt.accountId===context.accountId||stop?.action!=='stop'||stop.phase!=='stop_confirmed'||stop.taskId!==task.id||stop.attemptId!==attempt.id||stop.generation!==attempt.generation||stop.fingerprint!==task.fingerprint)throw new TaskConflict('Exact independent account and confirmed-unsent source release required')
    if(this.sql.exec('SELECT resource FROM managed_reservations WHERE attempt_id = ? LIMIT 1',attempt.id).toArray().length||this.sql.exec("SELECT id FROM managed_artifacts WHERE json_extract(body,'$.taskId') = ? LIMIT 1",task.id).toArray().length||this.get('uploads',task.id))throw new TaskConflict('Original output or reservation retained')
    assertRecoveryControls(this.sql,unit)
    task.state='queued';task.attemptId=null;this.put('tasks',task.id,task)
    const next=this.allocate(task.id,context.target.deviceId,context.target.profileId,context.accountId)
    const handoff={schema:'retained-candidate-command/1',actionId,candidateId:a.candidate.id,unit,context}
    const command={...next.command,handoff};this.put('commands',command.id,command)
    recordReleasedRecoveryLineage(this.sql,unit,{...unit,attemptId:next.attempt.id,generation:next.attempt.generation},actionId,stop.id,command.id,Date.parse(this.now()))
    const result={...next,command}
    if(production){
      const {newClaimEventId}=production.identity
      const claim={action:'claim',taskId:task.id,deviceId:context.target.deviceId,profileId:context.target.profileId,accountId:context.accountId}
      this.sql.exec('INSERT INTO managed_events (id,payload,result,at) VALUES (?,?,?,?)',newClaimEventId,canonicalJson([actor,claim]),JSON.stringify(result),this.now())
      this.put('production_attempts',next.attempt.id,{taskId:task.id,claimEventId:newClaimEventId})
    }
    return result
  }
  private allocate(taskId:string,deviceId:string,profileId:string,accountId:string|null) {
      const task=this.task(taskId),enrolled=this.get<{profileId:string;capabilities:string[]}>('enrollment',deviceId)
      if(!enrolled || enrolled.profileId!==profileId)throw new TaskConflict('Device/profile is not enrolled')
      if(enrolled.capabilities.includes(DEFAULT_CROP_CAPABILITY))requireDefaultCropPilot(task.spec)
      if(task.spec.promptVersion===DEFAULT_CROP_PROMPT&&!enrolled.capabilities.includes(SLICED_CROP_CAPABILITY))throw new TaskConflict('Update the phone for verified ChatGPT slices before assignment')
      if(task.state!=='queued'||task.attemptId)throw new TaskConflict('Task already owned or not eligible')
      // Two revisions may both have been planned before either claim. This check also covers retained reservations created by older releases without a page row.
      const priorPages=this.sql.exec<{body:string}>("SELECT body FROM managed_tasks WHERE json_extract(body,'$.workspaceId') = ? AND json_extract(body,'$.pageId') = ? AND id <> ? LIMIT 1001",task.workspaceId,task.pageId,task.id).toArray()
      if(priorPages.length>1000||priorPages.some(row=>{const prior=JSON.parse(row.body) as CropTask;return prior.attemptId&&this.sql.exec('SELECT resource FROM managed_reservations WHERE attempt_id = ? LIMIT 1',prior.attemptId).toArray().length>0}))throw new TaskConflict('Page revision remains reserved; reconcile its current owner')
      const attempt:CropAttempt={id:this.uuid(),activeCommandId:this.uuid(),taskId,generation:task.generation+1,deviceId,profileId,accountId,leaseExpiresAt:new Date(Date.parse(this.now())+300000).toISOString(),phase:'assigned',submission:'unsent',checkpointRef:null}
      const accountSelection=this.accounts.reserve(task,attempt)
      if(accountSelection)attempt.accountSelection=accountSelection
      for(const resource of [`page:${task.workspaceId}:${task.pageId}`,`device:${deviceId}`,`browser:${deviceId}`,`profile:${deviceId}:${profileId}`]) {
        if(this.sql.exec('SELECT attempt_id FROM managed_reservations WHERE resource = ?',resource).toArray().length)throw new TaskConflict('Device/browser/profile remains reserved')
        this.sql.exec('INSERT INTO managed_reservations (resource,attempt_id) VALUES (?,?)',resource,attempt.id)
      }
      task.attemptId=attempt.id;task.generation=attempt.generation;task.state='assigned'
      const command={id:attempt.activeCommandId,taskId,attemptId:attempt.id,generation:attempt.generation,fingerprint:task.fingerprint,action:'start',phase:'queued'}
      this.put('attempts',attempt.id,attempt);this.put('tasks',task.id,task);this.put('commands',command.id,command)
      return {task,attempt,command}
  }
  selectAccount(actor:TaskPrincipal,taskId:string,targets?:{deviceId:string;profileId:string}[]) {
    this.studio(actor)
    const selection=this.transaction(()=>this.accounts.select(actor,this.task(taskId),targets))
    if(selection.state==='waiting')this.accounts.waiting(taskId,selection)
    return selection
  }
  artifact(actor:TaskPrincipal,artifactId:string) {
    this.studio(actor);const artifact=this.get<Artifact>('artifacts',artifactId)
    if(!artifact)throw new TaskConflict('Unknown artifact')
    return artifact
  }
  artifactOwner(actor:TaskPrincipal,taskId:string,attemptId:string,generation:number,fingerprint:string) {
    return this.owned(actor,taskId,attemptId,generation,fingerprint)
  }
  private task(taskId:string):CropTask {const t=this.get<CropTask>('tasks',taskId);if(!t)throw new TaskConflict('Unknown task');return t}
  assertWorkspace(taskId:string,workspaceId:string):void { if(this.task(taskId).workspaceId!==workspaceId)throw new TaskConflict('Cross-workspace task rejected') }
  private owned(actor:TaskPrincipal,taskId:string,attemptId:string,generation:number,fingerprint:string) {
    const task=this.task(taskId),attempt=this.get<CropAttempt>('attempts',attemptId)
    if(!attempt||task.attemptId!==attemptId||task.generation!==generation||attempt.generation!==generation||attempt.taskId!==taskId||task.fingerprint!==fingerprint)throw new TaskConflict('Stale attempt or input fingerprint')
    if(actor.role==='phone'&&actor.deviceId!==attempt.deviceId)throw new TaskConflict('Attempt belongs to another authenticated phone')
    return {task,attempt}
  }
  /** Stop receipt plus exact worker evidence; this step never releases reservations. */
  attestUploadOnly(actor:TaskPrincipal,eventId:string,evidence:UploadOnlyEvidence) {
    if(actor.role!=='phone')throw new TaskConflict('Authenticated worker evidence required')
    return this.once(actor,eventId,{action:'attest_upload_only',...evidence},()=>{
      const {task}=this.uploadOnlyContext(actor,evidence)
      const prior=this.get<UploadOnlyReport>('upload_only_reports',evidence.attemptId)
      if(prior)throw new TaskConflict('Evidence already exists; read its current receipt')
      const report:UploadOnlyReport={...evidence,id:eventId,workspaceId:task.workspaceId,reportedAt:this.now(),resolvedAt:null,resolutionEventId:null}
      this.put('upload_only_reports',evidence.attemptId,report);return report
    })
  }
  private uploadOnlyContext(actor:TaskPrincipal,e:UploadOnlyEvidence) {
    const owner=this.owned(actor,e.taskId,e.attemptId,e.generation,e.fingerprint),{task,attempt}=owner
    requireDefaultCropPilot(task.spec)
    if(task.state!=='cancelled'||task.canonical!==null||attempt.phase!=='stop_confirmed'||attempt.submission!=='unknown'||attempt.checkpointRef!==null||attempt.activeCommandId!==e.stopCommandId||attempt.deviceId!==e.deviceId||attempt.profileId!==e.profileId||e.originalPhase!=='submission_intent'||e.uploadRecorded!==true||e.submitRecorded!==false||e.checkpointCount!==0)throw new TaskConflict('Only a stopped cancelled upload-only unknown attempt is eligible')
    for(const [key,action] of [[e.startCommandId,'start'],[e.stopCommandId,'stop']]) {
      const c=this.get<{taskId:string;attemptId:string;generation:number;fingerprint:string;action:string;phase:string}>('commands',key)
      if(!c||c.taskId!==task.id||c.attemptId!==attempt.id||c.generation!==e.generation||c.fingerprint!==e.fingerprint||c.action!==action||c.phase!==(action==='stop'?'stop_confirmed':'started'))throw new TaskConflict('Exact original start and acknowledged stop required')
    }
    if(this.get('uploads',task.id)||this.sql.exec("SELECT id FROM managed_artifacts WHERE json_extract(body,'$.attemptId') = ? LIMIT 1",attempt.id).toArray().length)throw new TaskConflict('Retained artifact evidence requires separate reconciliation')
    return owner
  }
  /** Reviewed page quarantines still fence their original page, but hold no reusable execution capacity. */
  private reviewedPageQuarantine(resource:string,attemptId:string):boolean {
    if(!resource.startsWith('page:'))return false
    try {
      const report=this.get<CancelledUnknownReport>('cancelled_unknown_reports',attemptId)
      if(!report||!id(report.id)||!id(report.resolutionEventId)||!Number.isFinite(Date.parse(report.resolvedAt??''))||!Number.isFinite(Date.parse(report.reportedAt))||Date.parse(report.resolvedAt!)<Date.parse(report.reportedAt)||Date.parse(report.resolvedAt!)>Date.parse(this.now()))return false
      const {task,attempt}=this.cancelledUnknownContext({role:'studio'},report)
      return attempt.id===attemptId&&report.workspaceId===task.workspaceId&&resource===`page:${task.workspaceId}:${task.pageId}`
    } catch { return false }
  }
  /** Explicit Studio review only. Historical unknown outcome and source binding remain unchanged. */
  resolveUploadOnly(actor:TaskPrincipal,eventId:string,taskId:string,attemptId:string,generation:number,fingerprint:string,reportId:string,stopCommandId:string,confirmUploadOnly:boolean) {
    this.studio(actor)
    if(confirmUploadOnly!==true)throw new TaskConflict('Explicit upload-only review required')
    return this.once(actor,eventId,{action:'resolve_upload_only',taskId,attemptId,generation,fingerprint,reportId,stopCommandId,confirmUploadOnly},()=>{
      const report=this.get<UploadOnlyReport>('upload_only_reports',attemptId)
      if(!report||report.id!==reportId||report.taskId!==taskId||report.generation!==generation||report.fingerprint!==fingerprint||report.stopCommandId!==stopCommandId||report.resolvedAt!==null||report.resolutionEventId!==null)throw new TaskConflict('Current unreviewed worker evidence required')
      const {task,attempt}=this.uploadOnlyContext(actor,report)
      for(const resource of [`device:${attempt.deviceId}`,`browser:${attempt.deviceId}`,`profile:${attempt.deviceId}:${attempt.profileId}`]) {
        const row=this.sql.exec<{attempt_id:string}>('SELECT attempt_id FROM managed_reservations WHERE resource = ?',resource).toArray()[0]
        if(row?.attempt_id!==attemptId)throw new TaskConflict('Reservation ownership changed; refresh reconciliation')
      }
      report.resolvedAt=this.now();report.resolutionEventId=eventId
      this.put('upload_only_reports',attemptId,report)
      this.sql.exec('DELETE FROM managed_reservations WHERE attempt_id = ?',attemptId)
      return {task,attempt,uploadOnlyReport:report}
    })
  }
  /** Stop receipt plus exact worker evidence; this step never releases reservations. */
  attestCancelledSubmission(actor:TaskPrincipal,eventId:string,evidence:CancelledSubmissionEvidence) {
    if(actor.role!=='phone')throw new TaskConflict('Authenticated worker evidence required')
    return this.once(actor,eventId,{action:'attest_cancelled_submission',...evidence},()=>{
      const {task}=this.cancelledSubmissionContext(actor,evidence)
      const prior=this.get<CancelledSubmissionReport>('cancelled_submission_reports',evidence.attemptId)
      if(prior)throw new TaskConflict('Evidence already exists; read its current receipt')
      const report:CancelledSubmissionReport={...evidence,id:eventId,workspaceId:task.workspaceId,reportedAt:this.now(),resolvedAt:null,resolutionEventId:null}
      this.put('cancelled_submission_reports',evidence.attemptId,report);return report
    })
  }
  private cancelledSubmissionContext(actor:TaskPrincipal,e:CancelledSubmissionEvidence) {
    const owner=this.owned(actor,e.taskId,e.attemptId,e.generation,e.fingerprint),{task,attempt}=owner
    requireDefaultCropPilot(task.spec)
    if(task.state!=='cancelled'||task.canonical!==null||attempt.phase!=='stop_confirmed'||attempt.submission!=='submitted'||attempt.checkpointRef!==null||attempt.activeCommandId!==e.stopCommandId||attempt.deviceId!==e.deviceId||attempt.profileId!==e.profileId||e.originalPhase!=='submitted'||e.uploadRecorded!==true||e.submitRecorded!==true||e.completedReplyRetained!==true||!Number.isSafeInteger(e.checkpointCount)||e.checkpointCount<1||e.checkpointCount>32||!digest(e.completedReplyHash)||!digest(e.evidenceDigest)||Date.parse(attempt.leaseExpiresAt)>Date.parse(this.now()))throw new TaskConflict('Only a stopped cancelled submitted reply with an expired lease attempt is eligible')
    for(const [key,action] of [[e.startCommandId,'start'],[e.stopCommandId,'stop']]) {
      const c=this.get<{taskId:string;attemptId:string;generation:number;fingerprint:string;action:string;phase:string}>('commands',key)
      if(!c||c.taskId!==task.id||c.attemptId!==attempt.id||c.generation!==e.generation||c.fingerprint!==e.fingerprint||c.action!==action||c.phase!==(action==='stop'?'stop_confirmed':'started'))throw new TaskConflict('Exact original start and acknowledged stop required')
    }
    if(this.get('uploads',task.id)||this.sql.exec("SELECT id FROM managed_artifacts WHERE json_extract(body,'$.attemptId') = ? LIMIT 1",attempt.id).toArray().length)throw new TaskConflict('Retained artifact evidence requires separate reconciliation')
    return owner
  }
  /** Explicit Studio review only. Historical submitted outcome and source binding remain unchanged. */
  resolveCancelledSubmission(actor:TaskPrincipal,eventId:string,taskId:string,attemptId:string,generation:number,fingerprint:string,reportId:string,stopCommandId:string,confirmDiscard:boolean) {
    this.studio(actor)
    if(confirmDiscard!==true)throw new TaskConflict('Explicit cancelled reply discard review required')
    return this.once(actor,eventId,{action:'resolve_cancelled_submission',taskId,attemptId,generation,fingerprint,reportId,stopCommandId,confirmDiscard},()=>{
      const report=this.get<CancelledSubmissionReport>('cancelled_submission_reports',attemptId)
      if(!report||report.id!==reportId||report.taskId!==taskId||report.generation!==generation||report.fingerprint!==fingerprint||report.stopCommandId!==stopCommandId||report.resolvedAt!==null||report.resolutionEventId!==null)throw new TaskConflict('Current unreviewed worker evidence required')
      const {task,attempt}=this.cancelledSubmissionContext(actor,report)
      for(const resource of [`device:${attempt.deviceId}`,`browser:${attempt.deviceId}`,`profile:${attempt.deviceId}:${attempt.profileId}`]) {
        const row=this.sql.exec<{attempt_id:string}>('SELECT attempt_id FROM managed_reservations WHERE resource = ?',resource).toArray()[0]
        if(row?.attempt_id!==attemptId)throw new TaskConflict('Reservation ownership changed; refresh reconciliation')
      }
      report.resolvedAt=this.now();report.resolutionEventId=eventId
      this.put('cancelled_submission_reports',attemptId,report)
      this.sql.exec('DELETE FROM managed_reservations WHERE attempt_id = ?',attemptId)
      return {task,attempt,cancelledSubmissionReport:report}
    })
  }
  /** Stop receipt plus exact worker evidence; this step never releases reservations. */
  attestCancelledUnknown(actor:TaskPrincipal,eventId:string,evidence:CancelledUnknownEvidence) {
    if(actor.role!=='phone')throw new TaskConflict('Authenticated worker evidence required')
    return this.once(actor,eventId,{action:'attest_cancelled_unknown',...evidence},()=>{
      const {task}=this.cancelledUnknownContext(actor,evidence)
      const prior=this.get<CancelledUnknownReport>('cancelled_unknown_reports',evidence.attemptId)
      if(prior)throw new TaskConflict('Evidence already exists; read its current receipt')
      const report:CancelledUnknownReport={...evidence,id:eventId,workspaceId:task.workspaceId,reportedAt:this.now(),resolvedAt:null,resolutionEventId:null}
      this.put('cancelled_unknown_reports',evidence.attemptId,report);return report
    })
  }
  private cancelledUnknownContext(actor:TaskPrincipal,e:CancelledUnknownEvidence) {
    const owner=this.owned(actor,e.taskId,e.attemptId,e.generation,e.fingerprint),{task,attempt}=owner
    requireDefaultCropPilot(task.spec)
    if(task.state!=='cancelled'||task.canonical!==null||attempt.phase!=='stop_confirmed'||attempt.submission!=='unknown'||attempt.checkpointRef!==null||attempt.activeCommandId!==e.stopCommandId||attempt.deviceId!==e.deviceId||attempt.profileId!==e.profileId||e.originalPhase!=='submission_intent'||e.uploadRecorded!==true||e.submitRecorded!==true||e.completedReplyRetained!==false||e.checkpointCount!==0||!digest(e.evidenceDigest)||Date.parse(attempt.leaseExpiresAt)>Date.parse(this.now()))throw new TaskConflict('Only a stopped cancelled unknown attempt without output and with an expired lease is eligible')
    for(const [key,action] of [[e.startCommandId,'start'],[e.stopCommandId,'stop']]) {
      const c=this.get<{taskId:string;attemptId:string;generation:number;fingerprint:string;action:string;phase:string}>('commands',key)
      if(!c||c.taskId!==task.id||c.attemptId!==attempt.id||c.generation!==e.generation||c.fingerprint!==e.fingerprint||c.action!==action||c.phase!==(action==='stop'?'stop_confirmed':'started'))throw new TaskConflict('Exact original start and acknowledged stop required')
    }
    if(this.get('uploads',task.id)||this.sql.exec("SELECT id FROM managed_artifacts WHERE json_extract(body,'$.attemptId') = ? LIMIT 1",attempt.id).toArray().length)throw new TaskConflict('Retained artifact evidence requires separate reconciliation')
    const page=this.sql.exec<{attempt_id:string}>('SELECT attempt_id FROM managed_reservations WHERE resource = ?',`page:${task.workspaceId}:${task.pageId}`).toArray()[0]
    if(page?.attempt_id!==attempt.id)throw new TaskConflict('Original page quarantine ownership changed')
    return owner
  }
  /** Explicit Studio review only. Historical unknown outcome and source binding remain unchanged. */
  resolveCancelledUnknown(actor:TaskPrincipal,eventId:string,taskId:string,attemptId:string,generation:number,fingerprint:string,reportId:string,stopCommandId:string,confirmAbandon:boolean) {
    this.studio(actor)
    if(confirmAbandon!==true)throw new TaskConflict('Explicit abandonment of unknown provider outcome required')
    return this.once(actor,eventId,{action:'resolve_cancelled_unknown',taskId,attemptId,generation,fingerprint,reportId,stopCommandId,confirmAbandon},()=>{
      const report=this.get<CancelledUnknownReport>('cancelled_unknown_reports',attemptId)
      if(!report||report.id!==reportId||report.taskId!==taskId||report.generation!==generation||report.fingerprint!==fingerprint||report.stopCommandId!==stopCommandId||report.resolvedAt!==null||report.resolutionEventId!==null)throw new TaskConflict('Current unreviewed worker evidence required')
      const {task,attempt}=this.cancelledUnknownContext(actor,report)
      for(const resource of [`device:${attempt.deviceId}`,`browser:${attempt.deviceId}`,`profile:${attempt.deviceId}:${attempt.profileId}`]) {
        const row=this.sql.exec<{attempt_id:string}>('SELECT attempt_id FROM managed_reservations WHERE resource = ?',resource).toArray()[0]
        if(row?.attempt_id!==attemptId)throw new TaskConflict('Reservation ownership changed; refresh reconciliation')
      }
      report.resolvedAt=this.now();report.resolutionEventId=eventId
      this.put('cancelled_unknown_reports',attemptId,report)
      this.sql.exec('DELETE FROM managed_reservations WHERE attempt_id = ? AND resource IN (?,?,?)',attemptId,`device:${attempt.deviceId}`,`browser:${attempt.deviceId}`,`profile:${attempt.deviceId}:${attempt.profileId}`)
      return {task,attempt,cancelledUnknownReport:report}
    })
  }
  checkpoint(actor:TaskPrincipal,eventId:string,taskId:string,attemptId:string,generation:number,fingerprint:string,phase:'accepted'|'started'|'submission_intent'|'submitted'|'result_saved'|'stop_confirmed',checkpointRef:string|null,commandId:string,correction=false) {
    if(actor.role!=='phone')throw new TaskConflict('Authenticated worker required')
    if(checkpointRef!==null && !/^checkpoint\/[A-Za-z0-9_-]{1,128}$/.test(checkpointRef))throw new TaskConflict('Opaque checkpoint reference required')
    return this.once(actor,eventId,{action:'checkpoint',taskId,attemptId,generation,fingerprint,phase,checkpointRef,commandId},()=>{
      const {task,attempt}=this.owned(actor,taskId,attemptId,generation,fingerprint)
      const command=this.get<{taskId:string;attemptId:string;generation:number;fingerprint:string;action:string;phase:string}>('commands',commandId)
      if(!command||commandId!==attempt.activeCommandId||command.taskId!==taskId||command.attemptId!==attemptId||command.generation!==generation||command.fingerprint!==fingerprint||(phase==='stop_confirmed'&&command.action!=='stop'))throw new TaskConflict('Checkpoint must acknowledge the current exact command')
      if(['started','submission_intent'].includes(phase))this.assertHandoffExecution(task,attempt)
      if(phase==='result_saved'&&!correction&&this.correctionRecord(task,attempt))throw new TaskConflict('Use the original budgeted correction checkpoint; ordinary completion cannot bypass enrollment')
      const allowed:Record<string,string[]>={assigned:['accepted'],accepted:['started','stop_confirmed'],started:['submission_intent','stop_confirmed'],submission_intent:['submitted','result_saved','stop_confirmed'],submitted:['result_saved','stop_confirmed'],result_saved:['stop_confirmed'],stop_requested:['stop_confirmed']}
      if(!allowed[attempt.phase]?.includes(phase))throw new TaskConflict('Invalid checkpoint transition; do not replay a submission')
      if(phase!=='stop_confirmed'&&(task.state==='paused'||task.state==='cancelled'||Date.parse(attempt.leaseExpiresAt)<=Date.parse(this.now()))) {
        if(task.state!=='paused'&&task.state!=='cancelled')task.state='uncertain'
        this.put('tasks',task.id,task);return {task,attempt,permitted:false}
      }
      // A local stop acknowledgment does not prove an external submission stopped. Hold capacity
      // while its outcome is unknown/submitted, even after the worker has stopped locally.
      if(phase==='stop_confirmed'&&attempt.phase!=='stop_requested'&&attempt.submission!=='unsent')throw new TaskConflict('Stop intent must be recorded first')
      if(phase==='result_saved'&&!checkpointRef)throw new TaskConflict('Durable saved checkpoint required')
      attempt.phase=phase;if(checkpointRef)attempt.checkpointRef=checkpointRef
      if(phase==='submission_intent')attempt.submission='unknown'
      if(phase==='submitted')attempt.submission='submitted'
      if(phase==='result_saved')attempt.submission='saved'
      if(phase==='started')task.state='running'
      if(phase==='stop_confirmed'&&['unsent','saved'].includes(attempt.submission))this.sql.exec('DELETE FROM managed_reservations WHERE attempt_id = ?',attemptId)
      if(['accepted','started','result_saved','stop_confirmed'].includes(phase))command.phase=phase
      this.put('commands',commandId,command)
      this.put('attempts',attempt.id,attempt);this.put('tasks',task.id,task)
      if(phase==='stop_confirmed')this.archiveCompleted()
      return {task,attempt,permitted:true}
    })
  }
  /** Evidence-only reconciliation. Does not renew a lease, grant browser work or allocate a new attempt. */
  recoverSaved(actor:TaskPrincipal,eventId:string,taskId:string,attemptId:string,generation:number,fingerprint:string,checkpointRef:string,commandId:string) {
    if(actor.role!=='phone'||!/^checkpoint\/[A-Za-z0-9_-]{1,128}$/.test(checkpointRef))throw new TaskConflict('Authenticated saved checkpoint required')
    return this.once(actor,eventId,{action:'recover_saved',taskId,attemptId,generation,fingerprint,checkpointRef,commandId},()=>{
      const {task,attempt}=this.owned(actor,taskId,attemptId,generation,fingerprint)
      const correction=this.correctionRecord(task,attempt),corrected=correction?.actions.at(-1)
      if(correction&&(corrected?.phase!=='verified'||corrected.checkpointRef!==checkpointRef))throw new TaskConflict('Reconcile the original budgeted correction; expired saved recovery cannot adopt another output')
      const command=this.get<{action:string;taskId:string;attemptId:string;generation:number;fingerprint:string}>('commands',commandId)
      if(!command||commandId!==attempt.activeCommandId||command.action!=='start'||command.taskId!==taskId||command.attemptId!==attemptId||command.generation!==generation||command.fingerprint!==fingerprint)throw new TaskConflict('Recovery requires the original current start command')
      if(!['running','uncertain'].includes(task.state)||task.canonical||Date.parse(attempt.leaseExpiresAt)>Date.parse(this.now())||!['submission_intent','submitted','result_saved'].includes(attempt.phase)||!['unknown','submitted','saved'].includes(attempt.submission))throw new TaskConflict('Only an expired current saved outcome can be reconciled')
      if(attempt.checkpointRef&&attempt.checkpointRef!==checkpointRef)throw new TaskConflict('Saved checkpoint is immutable')
      const recovery={taskId,attemptId,generation,fingerprint,checkpointRef,commandId}
      const prior=this.get<unknown>('recoveries',attemptId)
      if(prior&&canonicalJson(prior)!==canonicalJson(recovery))throw new TaskConflict('Conflicting saved recovery')
      this.put('recoveries',attemptId,recovery)
      attempt.phase='result_saved';attempt.submission='saved';attempt.checkpointRef=checkpointRef
      task.state='uncertain'
      this.put('attempts',attemptId,attempt);this.put('tasks',taskId,task)
      return {task,attempt,permitted:true,recoveryOnly:true}
    })
  }
  private assertHandoffExecution(task:CropTask,attempt:CropAttempt) {
    const command=this.get<any>('commands',attempt.activeCommandId),h=command?.handoff;if(!h)return
    const row=this.sql.exec<{body:string}>('SELECT body FROM managed_account_handoff_episodes WHERE id = ?',recoveryUnitKey(h.unit)).toArray()[0],r=row?parseHandoffRecord(JSON.parse(row.body)):null,a=r?.actions.find(a=>a.id===h.actionId),c=h.context
    if(!this.handoffEnabled()||!r?.enabled||r.paused||r.cancelled||a?.phase!=='verified'||a.result.attempt.id!==attempt.id||a.result.command.id!==command.id||canonicalJson(a.result.command.handoff)!==canonicalJson(h)||attempt.accountId!==c.accountId)throw new TaskConflict('Exact account handoff execution is off or held')
    this.accounts.assertRetainedHandoff(task,attempt)
    assertRecoveryControls(this.sql,h.unit)
    if(sharedRecoveryBudget(this.sql,h.unit).pending)throw new TaskConflict('Another original recovery outcome remains pending')
    const review=this.sql.exec<{body:string}>('SELECT body FROM managed_target_context_reviews WHERE id = ?',c.reviewId).toArray()[0],policy=this.sql.exec<{body:string}>("SELECT body FROM managed_account_policies WHERE id = 'crop_json'").toArray()[0]
    if(!review||JSON.parse(review.body).withdrawnAt!==null||!policy||canonicalJson(JSON.parse(policy.body))!==canonicalJson(attempt.accountSelection?.policy)||!attempt.accountSelection?.policy.contextPortable)throw new TaskConflict('Original requirements or pinned account policy changed')
    const latest=this.sql.exec<{id:string}>('SELECT id FROM managed_target_context_reviews WHERE target_key = (SELECT target_key FROM managed_target_context_reviews WHERE id = ?) ORDER BY rowid DESC LIMIT 1',c.reviewId).toArray()[0]
    if(latest?.id!==c.reviewId)throw new TaskConflict('Original context requirements were superseded')
  }
  renew(actor:TaskPrincipal,eventId:string,taskId:string,attemptId:string,generation:number,fingerprint:string) {
    if(actor.role!=='phone')throw new TaskConflict('Authenticated worker required')
    return this.once(actor,eventId,{action:'renew',taskId,attemptId,generation,fingerprint},()=>{
      const {task,attempt}=this.owned(actor,taskId,attemptId,generation,fingerprint)
      this.assertHandoffExecution(task,attempt)
      if(['paused','cancelled','superseded','verified_complete','uncertain'].includes(task.state)||Date.parse(attempt.leaseExpiresAt)<=Date.parse(this.now())) {
        if(!['paused','cancelled','superseded','verified_complete'].includes(task.state))task.state='uncertain'
        this.put('tasks',task.id,task);return {task,attempt,permitted:false}
      }
      attempt.leaseExpiresAt=new Date(Date.parse(this.now())+300000).toISOString();this.put('attempts',attempt.id,attempt)
      return {task,attempt,permitted:true}
    })
  }
  stop(actor:TaskPrincipal,eventId:string,taskId:string,cancel:boolean,coordinator?:CoordinatorFence) {
    this.studio(actor)
    return this.once(actor,eventId,{action:'stop',taskId,cancel},()=>{
      return this.applyStop(taskId,cancel)
    },()=>coordinator?this.requireCoordinator(this.task(taskId).workspaceId,coordinator):this.requirePilotControl(taskId))
  }
  /** Resolve the durable original claim, never whichever attempt owns the task now.
   * A missing receipt is tombstoned in the same transaction, fencing a delayed claim. */
  stopClaim(actor:TaskPrincipal,eventId:string,taskId:string,claimEventId:string,coordinator?:CoordinatorFence,cancel=true) {
    this.studio(actor);if(!id(claimEventId)||eventId===claimEventId)throw new TaskConflict('Distinct immutable claim receipt required')
    return this.once(actor,eventId,{action:'stop_claim',taskId,claimEventId,...(!cancel?{cancel:false}:{})},()=>{
      this.task(taskId)
      const receipt=this.sql.exec<{payload:string;result:string}>('SELECT payload,result FROM managed_events WHERE id = ?',claimEventId).toArray()[0]
      if(!receipt) {
        const prior=this.get<{taskId:string}>('claim_stops',claimEventId)
        if(prior&&prior.taskId!==taskId)throw new TaskConflict('Claim stop belongs to another task')
        this.accounts.clearWaiting(taskId)
        this.put('claim_stops',claimEventId,{taskId})
        return {taskId,claimEventId,blockedBeforeClaim:true}
      }
      const [principal,payload]=JSON.parse(receipt.payload)
      if(principal.role!=='studio'||payload.action!=='claim'||payload.taskId!==taskId)throw new TaskConflict('Exact Studio claim receipt required')
      const claimed=JSON.parse(receipt.result) as {task:CropTask;attempt:CropAttempt}
      const {task,attempt}=this.owned(actor,taskId,claimed.attempt.id,claimed.attempt.generation,claimed.task.fingerprint)
      if(!cancel&&task.state==='cancelled')throw new TaskConflict('Cancelled production work cannot be paused for handoff')
      if(task.state==='verified_complete')return {task,command:null}
      if(['stop_requested','stop_confirmed'].includes(attempt.phase)){
        if(cancel&&task.state!=='cancelled'){task.state='cancelled';this.put('tasks',task.id,task)}
        return {task,command:null}
      }
      return this.applyStop(taskId,cancel)
    },()=>coordinator?this.requireCoordinator(this.task(taskId).workspaceId,coordinator):this.requirePilotControl(taskId))
  }
  private applyStop(taskId:string,cancel:boolean) {
      const task=this.task(taskId);if(task.state==='cancelled'&&!cancel)throw new TaskConflict('Cancelled work cannot be resumed by a pause')
      if(task.state==='verified_complete')throw new TaskConflict('Verified result is already committed')
      this.accounts.clearWaiting(taskId)
      task.state=cancel?'cancelled':'paused';this.put('tasks',task.id,task)
      if(!task.attemptId)return {task,command:null}
      const attempt=this.get<CropAttempt>('attempts',task.attemptId)!
      attempt.phase='stop_requested';attempt.activeCommandId=this.uuid();this.put('attempts',attempt.id,attempt)
      const command={id:attempt.activeCommandId,taskId,attemptId:attempt.id,generation:attempt.generation,fingerprint:task.fingerprint,action:'stop',phase:'stop_requested'}
      this.put('commands',command.id,command);return {task,command}
  }
  /** Allocate one immutable upload slot per task before any asynchronous object writes. */
  private correctionRecord(task:CropTask,attempt:CropAttempt) {
    const key=recoveryUnitKey({workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:attempt.generation,fingerprint:task.fingerprint})
    const row=this.sql.exec<{body:string}>('SELECT body FROM managed_correction_recovery_episodes WHERE id = ?',key).toArray()[0]
    return row?parseCorrectionRecord(JSON.parse(row.body)):null
  }
  private correctionArtifact(task:CropTask,attempt:CropAttempt,hash:string) {
    const r=this.correctionRecord(task,attempt);if(!r)return
    const a=r.actions.at(-1)
    if(!r.enabled||r.paused||r.cancelled||a?.phase!=='verified'||a.checkpointRef!==attempt.checkpointRef||a.artifactHash!==hash)throw new TaskConflict('Exact approved correction artifact and active controls required')
    assertRecoveryControls(this.sql,r.fence.unit)
  }
  reserveArtifact(actor:TaskPrincipal,taskId:string,attemptId:string,generation:number,fingerprint:string,artifactId:string,ref:string,sha256:string,bytes:number) {
    if(actor.role!=='phone'||!id(artifactId)||!digest(sha256)||!Number.isSafeInteger(bytes)||bytes<1||bytes>1_000_000)throw new TaskConflict('Invalid immutable upload slot')
    return this.transaction(()=>{
      const {task,attempt}=this.owned(actor,taskId,attemptId,generation,fingerprint)
      this.correctionArtifact(task,attempt,sha256)
      if(attempt.submission!=='saved'||!attempt.checkpointRef||ref!==`managed/${task.workspaceId}/${task.id.slice(12)}/${attemptId}/${artifactId}`)throw new TaskConflict('Save a durable result before allocating its upload')
      const slot={taskId,attemptId,generation,fingerprint,artifactId,ref,sha256,bytes}
      const old=this.get<unknown>('uploads',taskId)
      if(old){if(canonicalJson(old)!==canonicalJson(slot))throw new TaskConflict('Task already has a different immutable upload');return}
      this.archiveCompleted()
      const budget=this.sql.exec<{bytes:number;slots:number}>('SELECT bytes,slots FROM managed_artifact_budget WHERE id=1').toArray()[0]??{bytes:0,slots:0}
      if(budget.slots>=256||budget.bytes+bytes>64_000_000)throw new TaskConflict('Managed artifact pilot storage budget reached')
      this.put('uploads',taskId,slot)
      this.sql.exec('INSERT INTO managed_artifact_budget (id,bytes,slots) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes,slots=excluded.slots',budget.bytes+bytes,budget.slots+1)
    })
  }
  stage(actor:TaskPrincipal,eventId:string,taskId:string,attemptId:string,generation:number,fingerprint:string,artifactId:string,ref:string,contentHash:string) {
    if(actor.role!=='phone'||!id(artifactId)||!digest(contentHash))throw new TaskConflict('Worker artifact identity/hash required')
    return this.once(actor,eventId,{action:'stage',taskId,attemptId,generation,fingerprint,artifactId,ref,contentHash},()=>{
      const {task,attempt}=this.owned(actor,taskId,attemptId,generation,fingerprint)
      if(attempt.submission!=='saved'||!attempt.checkpointRef)throw new TaskConflict('Save a durable checkpoint before staging')
      this.correctionArtifact(task,attempt,contentHash)
      const expected=`managed/${task.workspaceId}/${task.id.slice(12)}/${attemptId}/${artifactId}`
      if(ref!==expected)throw new TaskConflict('Immutable attempt-scoped artifact reference required')
      const artifact:Artifact={id:artifactId,taskId,attemptId,generation,fingerprint,ref,sha256:contentHash,validated:false,validationRef:null}
      const old=this.get<Artifact>('artifacts',artifactId);if(old&&canonicalJson(old)!==canonicalJson(artifact))throw new TaskConflict('Immutable artifact conflict')
      this.put('artifacts',artifactId,artifact);return artifact
    })
  }
  publish(actor:TaskPrincipal,eventId:string,taskId:string,attemptId:string,generation:number,fingerprint:string,artifactId:string,contentHash:string,validationRef:string,recovered=false,coordinator?:CoordinatorFence) {
    this.studio(actor)
    if(!/^validation\/[A-Za-z0-9_-]{1,128}$/.test(validationRef))throw new TaskConflict('Trusted destination validation receipt required')
    return this.once(actor,eventId,{action:recovered?'publish_recovered':'publish',taskId,attemptId,generation,fingerprint,artifactId,contentHash,validationRef},()=>{
      const {task,attempt}=this.owned(actor,taskId,attemptId,generation,fingerprint),artifact=this.get<Artifact>('artifacts',artifactId)
      this.correctionArtifact(task,attempt,contentHash)
      const recovery=this.get<{commandId:string;checkpointRef:string;taskId:string;generation:number;fingerprint:string}>('recoveries',attemptId)
      const validRecovery=recovered&&task.state==='uncertain'&&Date.parse(attempt.leaseExpiresAt)<=Date.parse(this.now())&&recovery?.commandId===attempt.activeCommandId&&recovery.checkpointRef===attempt.checkpointRef&&recovery.taskId===taskId&&recovery.generation===generation&&recovery.fingerprint===fingerprint
      if((recovered?!validRecovery:(['paused','cancelled','superseded','uncertain','verified_complete'].includes(task.state)||Date.parse(attempt.leaseExpiresAt)<=Date.parse(this.now())))||attempt.phase!=='result_saved'||!artifact||artifact.taskId!==taskId||artifact.attemptId!==attemptId||artifact.generation!==generation||artifact.fingerprint!==fingerprint||artifact.sha256!==contentHash)throw new TaskConflict('Publication fence rejected stale, unvalidated or cancelled work')
      artifact.validated=true;artifact.validationRef=validationRef;task.canonical=artifact.ref;task.state='verified_complete';attempt.phase='published'
      this.put('artifacts',artifactId,artifact);this.put('tasks',taskId,task);this.put('attempts',attemptId,attempt)
      this.sql.exec('DELETE FROM managed_reservations WHERE attempt_id = ?',attemptId)
      this.archiveCompleted()
      return {task,artifact}
    },()=>coordinator?this.requireCoordinator(this.task(taskId).workspaceId,coordinator):this.requirePilotControl(taskId))
  }
  inbox(actor:TaskPrincipal) {
    if(actor.role!=='phone')throw new TaskConflict('Authenticated worker required')
    const rows=this.sql.exec<{body:string}>("SELECT body FROM managed_attempts WHERE json_extract(body,'$.deviceId') = ? AND json_extract(body,'$.phase') IN ('assigned','accepted','started','submission_intent','submitted','result_saved','stop_requested') LIMIT 9",actor.deviceId).toArray()
    if(rows.length>8)throw new TaskConflict('Managed inbox safety bound reached')
    return rows.map(row=>{
      const attempt=JSON.parse(row.body) as CropAttempt
      return {task:this.task(attempt.taskId),attempt,command:this.get<Record<string,unknown>>('commands',attempt.activeCommandId)}
    })
  }
  /** Read-only proof for the original device's obsolete confirmed-unsent stop. No lease or new-owner details. */
  obsoleteStop(actor:TaskPrincipal,request:{workspaceId:string;taskId:string;attemptId:string;generation:number;fingerprint:string;stopCommandId:string}) {
    if(actor.role!=='phone')throw new TaskConflict('Authenticated original worker required')
    const task=this.task(request.taskId),prior=this.get<CropAttempt>('attempts',request.attemptId),command=this.get<any>('commands',request.stopCommandId)
    if(task.workspaceId!==request.workspaceId||!prior||prior.deviceId!==actor.deviceId||prior.taskId!==request.taskId||prior.generation!==request.generation||prior.activeCommandId!==request.stopCommandId||task.fingerprint!==request.fingerprint||task.generation<=prior.generation||task.attemptId===prior.id||prior.phase!=='stop_confirmed'||prior.submission!=='unsent'||prior.checkpointRef||prior.accountId!==null||!command||command.action!=='stop'||command.phase!=='stop_confirmed'||command.taskId!==task.id||command.attemptId!==prior.id||command.generation!==prior.generation||command.fingerprint!==request.fingerprint)throw new TaskConflict('Exact obsolete confirmed-unsent stop required; retain local evidence')
    return {...request,currentGeneration:task.generation,confirmedUnsentStop:true}
  }
  /** Phase 4 read-only reconnect foundation. Every action still needs an exact fresh renewal. */
  reconnect(actor:TaskPrincipal,local:LocalManagedAttempt[]) {
    if(actor.role!=='phone'||local.length>8)throw new TaskConflict('Authenticated bounded worker inventory required')
    return local.map(item=>{
      const prior=this.get<CropAttempt>('attempts',item.attemptId)
      const base={taskId:item.taskId,attemptId:item.attemptId,generation:item.generation}
      if(!prior||prior.deviceId!==actor.deviceId||prior.taskId!==item.taskId)return {...base,status:'unknown',nextAction:'retain_hold'}
      const task=this.task(item.taskId)
      if(task.attemptId!==item.attemptId||task.generation!==item.generation||task.fingerprint!==item.fingerprint)return {...base,status:'obsolete',nextAction:'skip_provider_work_keep_evidence'}
      if(task.state==='verified_complete')return {...base,status:'verified_complete',nextAction:'reconcile_verified_publication'}
      if(prior.phase==='stop_requested')return {...base,status:'stop_pending',nextAction:'stop_executor_then_acknowledge'}
      if(['cancelled','paused','superseded'].includes(task.state))return {...base,status:task.state,nextAction:'retain_evidence_reconcile_hold'}
      const expired=Date.parse(prior.leaseExpiresAt)<=Date.parse(this.now())
      if(task.state==='uncertain'||expired||item.submission==='unknown'||item.submission==='submitted'||prior.submission==='unknown'||prior.submission==='submitted')return {...base,status:'uncertain',nextAction:'retain_hold_no_resubmission',leaseExpired:expired}
      if(item.submission==='saved'||prior.submission==='saved')return {...base,status:'saved',nextAction:'validate_original_saved_checkpoint'}
      return {...base,status:'current_unsent',nextAction:'renew_exact_assignment_before_action',leaseExpiresAt:prior.leaseExpiresAt}
    })
  }
  timeline(actor:TaskPrincipal,taskId:string) {
    this.studio(actor);const task=this.task(taskId)
    const rows=this.sql.exec<{body:string}>("SELECT body FROM managed_commands WHERE json_extract(body,'$.taskId') = ? ORDER BY id LIMIT 1001",taskId).toArray()
    if(rows.length>1000)throw new TaskConflict('Pilot timeline requires pagination')
    const artifactReady=!!task.canonical||this.sql.exec("SELECT id FROM managed_artifacts WHERE json_extract(body,'$.taskId') = ? AND json_extract(body,'$.attemptId') = ? LIMIT 1",task.id,task.attemptId).toArray().length>0
    return {task,artifactReady,attempt:task.attemptId?this.get<CropAttempt>('attempts',task.attemptId):null,commands:rows.map(r=>JSON.parse(r.body)),uploadOnlyReport:task.attemptId?this.get<UploadOnlyReport>('upload_only_reports',task.attemptId):null,cancelledUnknownReport:task.attemptId?this.get<CancelledUnknownReport>('cancelled_unknown_reports',task.attemptId):null,cancelledSubmissionReport:task.attemptId?this.get<CancelledSubmissionReport>('cancelled_submission_reports',task.attemptId):null}
  }
}
