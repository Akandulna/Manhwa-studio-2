import {retainedInventory} from './retainedInventory'
import {EXECUTOR_EVIDENCE_SCHEMA,parseExecutorEvidence,type ExecutorEvidence} from '../../server/src/services/managedExecutorEvidenceProtocol'
import {recoveryUnitKey,type RecoveryUnit} from '../../server/src/services/automationRecoveryPolicy'
import {TaskConflict,canonicalJson,type TaskPrincipal} from '../../server/src/services/managedTaskProtocol'
import {recoveryExact} from '../../server/src/services/managedSavedImportRecoveryProtocol'
import {sharedRecoveryBudget,initRecoveryBudget} from './recoveryBudget'
import {boundedBody} from './managedArtifactStorage'
import type {TaskSql,TaskAuthority} from './taskAuthority'
/** Observation receipts only. Cannot acknowledge work, clear quota, reserve repair or release original resources. */
export class ExecutorEvidenceAuthority {
 constructor(private sql:TaskSql,private tx:<T>(work:()=>T)=>T,private authority:TaskAuthority,private now=Date.now){
  sql.exec('CREATE TABLE IF NOT EXISTS managed_executor_evidence (id TEXT PRIMARY KEY, unit TEXT NOT NULL, body TEXT NOT NULL, received_at INTEGER NOT NULL)');initRecoveryBudget(sql)
 }
 private owner(actor:TaskPrincipal,u:RecoveryUnit){recoveryUnitKey(u);this.authority.assertWorkspace(u.taskId,u.workspaceId);return this.authority.artifactOwner(actor,u.taskId,u.attemptId,u.generation,u.fingerprint)}
 report(actor:TaskPrincipal,raw:unknown){
  if(actor.role!=='phone')throw new TaskConflict('Authenticated original executor required')
  const e=parseExecutorEvidence(raw)
  return this.tx(()=>{
   const {task,attempt}=this.owner(actor,e.unit)
   if(e.deviceId!==actor.deviceId||e.deviceId!==attempt.deviceId||e.profileId!==attempt.profileId||e.observedAt>this.now())throw new TaskConflict('Original executor profile and true source time required')
   if(e.session?.cachedSourceVerified&&!task.spec.dependencies.some(d=>d.id===task.pageId&&d.revision===task.spec.pageRevision&&d.sha256===e.session!.cachedSourceSha256))throw new TaskConflict('Session cache must match the original planned input')
   if(e.correctionContext){
    const c=e.correctionContext,p=attempt.accountSelection
    if(!p||attempt.accountId!==c.accountId||p.accountId!==c.accountId||p.policy.revision!==c.policyRevision||!task.spec.dependencies.some(d=>d.id===task.pageId&&d.revision===task.spec.pageRevision&&d.sha256===c.sourceSha256))throw new TaskConflict('Correction context must retain the original input/account/policy pin')
   }
   const command=this.sql.exec<{body:string}>('SELECT body FROM managed_commands WHERE id = ?',e.commandId).toArray()[0]
   if(!command)throw new TaskConflict('Original command required')
   const c=JSON.parse(command.body)
   if(c.attemptId!==e.unit.attemptId||c.taskId!==e.unit.taskId||c.generation!==e.unit.generation||c.fingerprint!==e.unit.fingerprint||c.action!=='start')throw new TaskConflict('Original start command fence required')
   const old=this.sql.exec<{body:string;received_at:number}>('SELECT body,received_at FROM managed_executor_evidence WHERE id = ?',e.id).toArray()[0]
   if(old){if(canonicalJson(JSON.parse(old.body))!==canonicalJson(e))throw new TaskConflict('Conflicting immutable executor observation');return {id:e.id,receivedAt:old.received_at}}
   if(retainedInventory(this.sql,'managed_executor_evidence',4096)>=4096||this.sql.exec('SELECT id FROM managed_executor_evidence WHERE unit = ? LIMIT 33',recoveryUnitKey(e.unit)).toArray().length>=32)throw new TaskConflict('Executor evidence inventory full; retain original history')
   const receivedAt=this.now();this.sql.exec('INSERT INTO managed_executor_evidence (id,unit,body,received_at) VALUES (?,?,?,?)',e.id,recoveryUnitKey(e.unit),JSON.stringify(e),receivedAt);return {id:e.id,receivedAt}
  })
 }
 inspect(actor:TaskPrincipal,u:RecoveryUnit){if(actor.role!=='studio')throw new TaskConflict('Studio diagnosis inspection required');return this.tx(()=>{const {attempt}=this.owner(actor,u);return {evidence:this.sql.exec<{body:string;received_at:number}>('SELECT body,received_at FROM managed_executor_evidence WHERE unit = ? ORDER BY received_at,id LIMIT 33',recoveryUnitKey(u)).toArray().map(r=>({observation:parseExecutorEvidence(JSON.parse(r.body)),receivedAt:r.received_at})),outcome:attempt.submission,budget:sharedRecoveryBudget(this.sql,u)}})}
}
export async function executorEvidenceApi(request:Request,actor:TaskPrincipal,authority:ExecutorEvidenceAuthority,workspace:string,enabled:boolean){
 if(request.method!=='POST'||new URL(request.url).search)return new Response('Not found',{status:404})
 let raw:any;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await boundedBody(request.body,12000)))}catch{throw new TaskConflict('Bounded executor evidence required')}
 recoveryExact(raw,['schema','action','value']);if(raw.schema!==EXECUTOR_EVIDENCE_SCHEMA)throw new TaskConflict('Exact executor evidence schema required')
 const unit=raw.action==='report'?parseExecutorEvidence(raw.value).unit:raw.value;recoveryUnitKey(unit)
 if(unit.workspaceId!==workspace)throw new TaskConflict('Foreign executor evidence workspace')
 if(raw.action==='report'){if(!enabled)return Response.json({error:'Executor evidence intake is disabled'},{status:503});return Response.json({schema:EXECUTOR_EVIDENCE_SCHEMA,receipt:authority.report(actor,raw.value)})}
 if(raw.action!=='inspect')throw new TaskConflict('Observation or inspection only')
 return Response.json({schema:EXECUTOR_EVIDENCE_SCHEMA,...authority.inspect(actor,unit)})
}
