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
async function setup(submission='unknown',expired=true,promptVersion=LEGACY_CROP_PROMPT) {
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
 const report={action:'attest_cancelled_unknown',eventId:'upload-report',...fence,startCommandId:claimed.command.id,stopCommandId:stopped.command.id,deviceId:'phone',profileId:'profile',originalPhase:'submission_intent',uploadRecorded:true,submitRecorded:true,completedReplyRetained:false,evidenceDigest:'b'.repeat(64),checkpointCount:0}
 const resolve={action:'resolve_cancelled_unknown',eventId:'review',...fence,reportId:'upload-report',stopCommandId:stopped.command.id,confirmAbandon:true}
 const reservations=()=>db.prepare('SELECT * FROM managed_reservations').all()
 const timeline=async(token=studio)=>{const r=await api().handle(new Request('https://relay.invalid'+(token===studio?'/managed/tasks/':'/managed/worker/')+encodeURIComponent(task.id),{headers:{Authorization:'Bearer '+token}}));expect(r.status).toBe(200);return r.json()}
 return {authority:()=>new TaskAuthority(sql,tx,()=>new Date(now).toISOString()),db,send,ok,report,resolve,reservations,timeline,identity,spec,task,checkpoint}
}
describe('explicit abandonment of a cancelled unknown outcome',()=>{
 const policy=(revision:number,enabled:boolean)=>({revision,stage:'crop_json',enabled,auditsEnabled:true,allowed:[{provider:'chatgpt',product:'chatgpt-web',model:'provider-default',mode:null,effort:null}],preferredProfiles:[],allowUnknownQuota:false,allowEstimatedQuota:false,criticalMaxAgeHours:24,contextPortable:false})
 it('enables account routing after reviewed abandonment without releasing or reinterpreting the original page',async()=>{
  const s=await setup();s.authority().accounts.setPolicy({role:'studio'},'policy_initial',policy(1,false))
  await s.ok(s.report,phone)
  expect(()=>s.authority().accounts.setPolicy({role:'studio'},'policy_early',policy(2,true))).toThrow('Reconcile existing reservations')
  await s.ok(s.resolve)
  const before=await s.timeline(),reservations=s.reservations()
  expect(s.authority().accounts.setPolicy({role:'studio'},'policy_enable',policy(2,true)).enabled).toBe(true)
  expect(await s.timeline()).toEqual(before);expect(s.reservations()).toEqual(reservations)
  expect((await s.send({action:'claim',taskId:s.task.id,deviceId:'phone',profileId:'profile',accountId:null})).status).toBe(409)
  expect((await s.send({action:'plan',identity:s.identity,spec:{...s.spec,pageRevision:'r2'}})).status).toBe(409)
  const next=await s.ok({action:'plan',identity:{...s.identity,pageId:'other'},spec:s.spec});expect(next.state).toBe('queued')
 })
 it.each(['device:other','browser:other','profile:other:profile','account:other:0','page:workspace:orphan'])('keeps %s blocking routing beside a reviewed quarantine',async resource=>{
  const s=await setup();await s.ok(s.report,phone);await s.ok(s.resolve)
  s.db.prepare('INSERT INTO managed_reservations (resource,attempt_id) VALUES (?,?)').run(resource,'unresolved')
  const before=s.reservations()
  expect(()=>s.authority().accounts.setPolicy({role:'studio'},'policy_enable',policy(1,true))).toThrow('Reconcile existing reservations')
  expect(s.authority().accounts.policy()).toBeNull();expect(s.reservations()).toEqual(before)
 })
 it('rejects a page-only hold whose worker evidence has not received owner review',async()=>{
  const s=await setup();await s.ok(s.report,phone)
  s.db.prepare("DELETE FROM managed_reservations WHERE resource NOT LIKE 'page:%'").run()
  expect(s.reservations()).toHaveLength(1)
  expect(()=>s.authority().accounts.setPolicy({role:'studio'},'policy_enable',policy(1,true))).toThrow('Reconcile existing reservations')
  expect(s.authority().accounts.policy()).toBeNull();expect(s.reservations()).toHaveLength(1)
 })
 it.each([{resolutionEventId:null},{resolvedAt:null},{resolvedAt:'invalid'},{resolvedAt:'2099-01-01T00:00:00Z'},{workspaceId:'other'},{generation:2},{fingerprint:'c'.repeat(64)},{stopCommandId:'other'}])('rejects incomplete or stale reviewed quarantine evidence %j',async change=>{
  const s=await setup();await s.ok(s.report,phone);await s.ok(s.resolve)
  const row=s.db.prepare('SELECT body FROM managed_cancelled_unknown_reports WHERE id = ?').get(s.report.attemptId)
  s.db.prepare('UPDATE managed_cancelled_unknown_reports SET body = ? WHERE id = ?').run(JSON.stringify({...JSON.parse(row.body),...change}),s.report.attemptId)
  const before=s.reservations()
  expect(()=>s.authority().accounts.setPolicy({role:'studio'},'policy_enable',policy(1,true))).toThrow('Reconcile existing reservations')
  expect(s.reservations()).toEqual(before)
 })
 it.each(['artifact','upload','changed_stop','wrong_page'])('rechecks %s before allowing routing over a reviewed quarantine',async change=>{
  const s=await setup();await s.ok(s.report,phone);await s.ok(s.resolve)
  if(change==='artifact')s.db.prepare('INSERT INTO managed_artifacts (id,body) VALUES (?,?)').run('late',JSON.stringify({attemptId:s.report.attemptId}))
  if(change==='upload')s.db.prepare('INSERT INTO managed_uploads (id,body) VALUES (?,?)').run(s.task.id,JSON.stringify({attemptId:s.report.attemptId}))
  if(change==='changed_stop')s.db.prepare('UPDATE managed_commands SET body = json_set(body,\'$.phase\',\'stop_requested\') WHERE id = ?').run(s.report.stopCommandId)
  if(change==='wrong_page')s.db.prepare('UPDATE managed_reservations SET resource = ? WHERE attempt_id = ?').run('page:workspace:other',s.report.attemptId)
  const before=s.reservations()
  expect(()=>s.authority().accounts.setPolicy({role:'studio'},'policy_enable',policy(1,true))).toThrow('Reconcile existing reservations')
  expect(s.reservations()).toEqual(before)
 })
 it('requires exact worker evidence and separate owner review, releases only capacity and keeps the page quarantined',async()=>{
  const s=await setup(),before=await s.timeline();expect(s.reservations()).toHaveLength(4)
  expect((await s.send(s.resolve)).status).toBe(409)
  await s.ok(s.report,phone);expect(s.reservations()).toHaveLength(4)
  const reviewed=await s.ok(s.resolve);expect(s.reservations()).toHaveLength(1)
  expect(reviewed.task).toEqual(before.task);expect(reviewed.attempt).toEqual(before.attempt)
  expect(reviewed.task.state).toBe('cancelled');expect(reviewed.attempt.submission).toBe('unknown')
  expect((await s.timeline()).commands).toEqual(before.commands)
  expect((await s.timeline(phone)).result.cancelledUnknownReport).toEqual(reviewed.cancelledUnknownReport)
  await s.ok(s.resolve);expect(s.reservations()).toHaveLength(1)
  expect((await s.send({action:'claim',taskId:s.task.id,deviceId:'phone',profileId:'profile',accountId:null})).status).toBe(409)
  expect((await s.send({action:'plan',identity:s.identity,spec:{...s.spec,pageRevision:'r2'}})).status).toBe(409)
  expect((await s.send({...s.checkpoint('result_saved'),checkpointRef:'checkpoint/late'},phone)).status).toBe(409)
  expect(()=>s.authority().publish({role:'studio'},'late',s.task.id,s.report.attemptId,1,s.task.fingerprint,'output','a'.repeat(64),'validation/late')).toThrow()
  const next=await s.ok({action:'plan',identity:{...s.identity,pageId:'other'},spec:s.spec});await s.ok({action:'claim',taskId:next.id,deviceId:'phone',profileId:'profile',accountId:null})
  await s.ok(s.resolve);expect(s.reservations()).toHaveLength(5) // Reviewed receipt cannot release later work.
 })
 it('separates authentication roles and never accepts a foreign worker',async()=>{
  const s=await setup();expect((await s.send(s.report)).status).toBe(403);expect((await s.send(s.report,foreign)).status).toBe(409)
  await s.ok(s.report,phone);expect((await s.send(s.resolve,phone)).status).toBe(403);expect(s.reservations()).toHaveLength(4)
 })
 it.each(['submitted','saved'])('cannot abandon %s evidence through this zero-output path',async submission=>{
  const s=await setup(submission);expect((await s.send(s.report,phone)).status).toBe(409)
 })
 it('refuses active leases, changed evidence, missing confirmation and stale fences',async()=>{
  const live=await setup('unknown',false);expect((await live.send(live.report,phone)).status).toBe(409)
  const s=await setup();for(const change of [{generation:2},{fingerprint:'c'.repeat(64)},{attemptId:'other'},{stopCommandId:'other'},{startCommandId:s.report.stopCommandId},{profileId:'other'},{deviceId:'foreign'}])expect((await s.send({...s.report,...change,eventId:crypto.randomUUID()},phone)).status).toBe(409)
  await s.ok(s.report,phone)
  for(const change of [{confirmAbandon:false},{reportId:'other'},{stopCommandId:'other'},{generation:2}])expect((await s.send({...s.resolve,...change})).status).toBe(409)
  expect(s.reservations()).toHaveLength(4)
 })
 it('rechecks uploads, artifacts and capacity ownership at review',async()=>{
  const s=await setup();await s.ok(s.report,phone)
  s.db.prepare('INSERT INTO managed_artifacts (id,body) VALUES (?,?)').run('late',JSON.stringify({attemptId:s.report.attemptId}))
  expect((await s.send(s.resolve)).status).toBe(409);s.db.prepare('DELETE FROM managed_artifacts WHERE id = ?').run('late')
  s.db.prepare('UPDATE managed_reservations SET attempt_id = ? WHERE resource = ?').run('other','profile:phone:profile')
  expect((await s.send(s.resolve)).status).toBe(409);expect(s.reservations()).toHaveLength(4)
 })
 it('strictly rejects ambiguous, coercible and output-bearing reports',async()=>{
  const s=await setup();const envelope={schema:'managed-task/1',workspaceId:'workspace',...s.report}
  for(const change of [{submitRecorded:false},{submitRecorded:'true'},{uploadRecorded:false},{checkpointCount:1},{completedReplyRetained:true},{originalPhase:'submitted'},{evidenceDigest:'bad'},{completedReplyHash:'a'.repeat(64)},{extra:'ignored'}])expect(()=>parseManagedOperation({...envelope,...change})).toThrow()
 })
})
