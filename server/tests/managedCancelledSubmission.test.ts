import {createRequire} from 'node:module'
import {afterEach,describe,expect,it} from 'vitest'
import {ManagedTaskApi,type ManagedTaskEnvironment} from '../../relay/src/managedTaskApi.js'
import {MANAGED_CAPABILITIES,parseManagedOperation} from '../src/services/managedTaskProtocol.js'
import {DEFAULT_CROP_PROMPT,DEFAULT_CROP_CAPABILITY,LEGACY_CROP_PROMPT,SLICED_CROP_CAPABILITY} from '../src/services/managedCropPilotPolicy.js'
import {MANAGED_CROP_VALIDATOR} from '../src/services/managedCropArtifact.js'
import {TaskAuthority,type TaskSql} from '../../relay/src/taskAuthority.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite')
const studio='s'.repeat(40),phone='p'.repeat(40),foreign='f'.repeat(40)
const opened:InstanceType<typeof DatabaseSync>[]=[]
afterEach(()=>{for(const db of opened.splice(0))db.close()})
async function setup(submission='submitted',expired=true,promptVersion=LEGACY_CROP_PROMPT) {
 const db=new DatabaseSync(':memory:');opened.push(db)
 const sql:TaskSql={exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows}}}
 const tx=<T>(work:()=>T)=>{db.exec('BEGIN IMMEDIATE');try{const value=work();db.exec('COMMIT');return value}catch(e){db.exec('ROLLBACK');throw e}}
 const env:ManagedTaskEnvironment={MANAGED_AUTOMATIC_RECOVERY:'1',MANAGED_CROP_PAGE:'1',MANAGED_WORKSPACE_ID:'workspace',MANAGED_STUDIO_TOKEN:studio,MANAGED_DEVICE_TOKENS:JSON.stringify({phone,foreign})}
 let now=Date.parse('2026-10-20T00:00:00Z')
 const api=()=>new ManagedTaskApi(sql,tx,env,()=>new Date(now).toISOString())
 async function send(body:Record<string,unknown>,token=studio){return api().handle(new Request('https://relay.invalid/managed/operation',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({schema:'managed-task/1',workspaceId:'workspace',eventId:crypto.randomUUID(),...body})}))}
 async function ok(body:Record<string,unknown>,token=studio){const r=await send(body,token),d=await r.json();expect(r.status,JSON.stringify(d)).toBe(200);return d.result}
 await ok({action:'hello',profileIds:['profile'],capabilities:[...MANAGED_CAPABILITIES,DEFAULT_CROP_CAPABILITY,...(promptVersion===DEFAULT_CROP_PROMPT?[SLICED_CROP_CAPABILITY]:[])],apkVersion:'1.0.999'},phone)
 await ok({action:'enroll',deviceId:'phone',profileId:'profile'})
 const identity={workspaceId:'workspace',seriesId:'series',chapterId:'chapter',pageId:'page'}
 const spec={version:'crop-page/1',provider:'chatgpt',product:'chatgpt-web',model:'provider-default',settings:{mode:null,effort:null},pageRevision:'r1',promptVersion,validatorVersion:MANAGED_CROP_VALIDATOR,dependencies:[{id:'page',revision:'r1',sha256:'a'.repeat(64)}]}
 const task=await ok({action:'plan',identity,spec})
 const claimed=await ok({action:'claim',taskId:task.id,deviceId:'phone',profileId:'profile',accountId:null})
 const fence={taskId:task.id,attemptId:claimed.attempt.id,generation:1,fingerprint:task.fingerprint}
 const checkpoint=(phase:string,commandId=claimed.command.id)=>({action:'checkpoint',...fence,commandId,phase,checkpointRef:phase==='result_saved'?'checkpoint/output':null})
 for(const phase of ['accepted','started','submission_intent'])await ok(checkpoint(phase),phone)
 if(submission==='submitted'||submission==='saved')await ok(checkpoint('submitted'),phone)
 if(submission==='saved')await ok(checkpoint('result_saved'),phone)
 const stopped=await ok({action:'stop',taskId:task.id,cancel:true})
 await ok(checkpoint('stop_confirmed',stopped.command.id),phone)
 if(expired)now+=300001
 const report={action:'attest_cancelled_submission',eventId:'upload-report',...fence,startCommandId:claimed.command.id,stopCommandId:stopped.command.id,deviceId:'phone',profileId:'profile',originalPhase:'submitted',uploadRecorded:true,submitRecorded:true,completedReplyRetained:true,completedReplyHash:'a'.repeat(64),evidenceDigest:'b'.repeat(64),checkpointCount:1}
 const resolve={action:'resolve_cancelled_submission',eventId:'review',...fence,reportId:'upload-report',stopCommandId:stopped.command.id,confirmDiscard:true}
 const reservations=()=>db.prepare('SELECT * FROM managed_reservations').all()
 const timeline=async(token=studio)=>{const r=await api().handle(new Request('https://relay.invalid'+(token===studio?'/managed/tasks/':'/managed/worker/')+encodeURIComponent(task.id),{headers:{Authorization:'Bearer '+token}}));expect(r.status).toBe(200);return r.json()}
 return {authority:()=>new TaskAuthority(sql,tx,()=>new Date(now).toISOString()),db,send,ok,report,resolve,reservations,timeline,identity,spec,task,checkpoint}
}
describe('reviewed cancelled submitted reply reconciliation',()=>{
 it('also retains sliced-policy evidence until the same explicit owner review',async()=>{
  const s=await setup('submitted',true,DEFAULT_CROP_PROMPT)
  expect(s.spec.promptVersion).toBe(DEFAULT_CROP_PROMPT)
  await s.ok(s.report,phone);expect(s.reservations()).toHaveLength(4)
  const reviewed=await s.ok(s.resolve);expect(s.reservations()).toHaveLength(0)
  expect(reviewed.task.state).toBe('cancelled');expect(reviewed.attempt.submission).toBe('submitted')
 })
 it('requires worker evidence and separate Studio review, preserving all task history',async()=>{
  const s=await setup();expect(s.reservations()).toHaveLength(4)
  expect((await s.send(s.resolve)).status).toBe(409)
  await s.ok(s.report,phone);expect(s.reservations()).toHaveLength(4)
  expect((await s.timeline(phone)).result.cancelledSubmissionReport.resolvedAt).toBeNull()
  const reviewed=await s.ok(s.resolve);expect(s.reservations()).toHaveLength(0)
  expect(reviewed.task.state).toBe('cancelled');expect(reviewed.task.canonical).toBeNull()
  expect(reviewed.attempt.phase).toBe('stop_confirmed');expect(reviewed.attempt.submission).toBe('submitted')
  expect(reviewed.cancelledSubmissionReport.resolutionEventId).toBe('review')
  expect((await s.timeline(phone)).result.cancelledSubmissionReport).toEqual(reviewed.cancelledSubmissionReport)
  expect((await s.ok(s.resolve))).toEqual(reviewed)
  const {action,eventId,...fence}=s.resolve
  expect((await s.ok({action:'renew',taskId:fence.taskId,attemptId:fence.attemptId,generation:fence.generation,fingerprint:fence.fingerprint},phone)).permitted).toBe(false)
  const next=await s.ok({action:'plan',identity:{...s.identity,pageId:'next'},spec:s.spec})
  await s.ok({action:'claim',taskId:next.id,deviceId:'phone',profileId:'profile',accountId:null})
  await s.ok(s.resolve);expect(s.reservations()).toHaveLength(4) // Cached review cannot release a later attempt.
 })
 it('separates roles and rejects foreign devices',async()=>{
  const s=await setup()
  expect((await s.send(s.report)).status).toBe(403)
  expect((await s.send(s.report,foreign)).status).toBe(409)
  await s.ok(s.report,phone)
  expect((await s.send(s.resolve,phone)).status).toBe(403)
  expect(s.reservations()).toHaveLength(4)
 })
 it.each(['unknown','saved'])('never resolves %s outcomes through the cancelled submitted reply path',async submission=>{
  const s=await setup(submission)
  expect((await s.send(s.report,phone)).status).toBe(409)
  expect(s.reservations()).toHaveLength(0+(submission==='saved'?0:4))
 })
 it('rejects changed fences, commands, profile and missing owner confirmation',async()=>{
  const s=await setup()
  for(const changed of [{generation:2},{fingerprint:'b'.repeat(64)},{attemptId:'other'},{startCommandId:s.report.stopCommandId},{stopCommandId:'other'},{profileId:'other'},{deviceId:'foreign'}]) {
   expect((await s.send({...s.report,...changed,eventId:crypto.randomUUID()},phone)).status).toBe(409)
  }
  await s.ok(s.report,phone)
  for(const changed of [{reportId:'other'},{stopCommandId:'other'},{generation:2},{confirmDiscard:false}])expect((await s.send({...s.resolve,...changed})).status).toBe(409)
  expect(s.reservations()).toHaveLength(4)
 })
 it('rechecks artifacts and reservation ownership at owner review',async()=>{
  const s=await setup();await s.ok(s.report,phone)
  s.db.prepare('INSERT INTO managed_artifacts (id,body) VALUES (?,?)').run('late',JSON.stringify({attemptId:s.report.attemptId}))
  expect((await s.send(s.resolve)).status).toBe(409)
  s.db.prepare('DELETE FROM managed_artifacts WHERE id = ?').run('late')
  s.db.prepare('UPDATE managed_reservations SET attempt_id = ? WHERE resource = ?').run('new-owner','device:phone')
  expect((await s.send(s.resolve)).status).toBe(409)
  expect((await s.timeline(phone)).result.cancelledSubmissionReport.resolvedAt).toBeNull()
  expect(s.reservations()).toHaveLength(4)
 })
 it('strictly validates evidence rather than coercing action markers',async()=>{
  const s=await setup()
  const envelope={schema:'managed-task/1',workspaceId:'workspace',...s.report}
  for(const change of [{uploadRecorded:false},{submitRecorded:false},{submitRecorded:'true'},{checkpointCount:0},{checkpointCount:33},{completedReplyRetained:false},{completedReplyHash:'bad'},{evidenceDigest:'bad'},{originalPhase:'submission_intent'},{extra:'ignored'}])expect(()=>parseManagedOperation({...envelope,...change})).toThrow()
  expect(s.reservations()).toHaveLength(4)
 })
 it('requires expiry even after a complete stop and refuses publication after review',async()=>{
  const live=await setup('submitted',false)
  expect((await live.send(live.report,phone)).status).toBe(409)
  expect(live.reservations()).toHaveLength(4)
  const s=await setup();await s.ok(s.report,phone);await s.ok(s.resolve)
  expect((await s.send({...s.checkpoint('result_saved'),checkpointRef:'checkpoint/late'},phone)).status).toBe(409)
  expect(()=>s.authority().publish({role:'studio'},'late-publish',s.task.id,s.report.attemptId,1,s.task.fingerprint,'late','a'.repeat(64),'validation/late')).toThrow('fence')
 })

})
