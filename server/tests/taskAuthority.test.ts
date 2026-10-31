import { createRequire } from 'node:module'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
import { afterEach,describe,expect,it } from 'vitest'
import { TaskAuthority,canonicalJson,cropTaskIdentity,type CropIdentity,type CropSpec,type TaskSql } from '../../relay/src/taskAuthority.js'
const identity:CropIdentity={workspaceId:'workspace',seriesId:'series',chapterId:'chapter',pageId:'page'}
const spec:CropSpec={version:'crop-page/1',provider:'chatgpt',product:'chatgpt-web',model:'owner-explicit-model',settings:{mode:'Chat',effort:null},pageRevision:'page-r1',promptVersion:'prompt-1',validatorVersion:'crop-1',dependencies:[{id:'page',revision:'page-r1',sha256:'a'.repeat(64)}]}
const studio={role:'studio'} as const,phone={role:'phone',deviceId:'phone-1'} as const
const caps=['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1']
const databases:InstanceType<typeof DatabaseSync>[]=[]
afterEach(()=>{for(const db of databases.splice(0))db.close()})
function setup() {
 const db=new DatabaseSync(':memory:');databases.push(db)
 const sql:TaskSql={exec(query,...bindings){const statement=db.prepare(query),rows=statement.all(...bindings as any[]);return {toArray:()=>rows as any}}}
 const tx=<T>(work:()=>T):T=>{db.exec('BEGIN IMMEDIATE');try{const value=work();db.exec('COMMIT');return value}catch(e){db.exec('ROLLBACK');throw e}}
 let ms=Date.parse('2026-10-19T00:00:00Z'),n=0
 const authority=()=>new TaskAuthority(sql,tx,()=>new Date(ms).toISOString(),()=>`id-${++n}`)
 const first=authority();first.enroll(studio,'enroll-1','phone-1','profile',caps);first.enroll(studio,'enroll-2','phone-2','profile',caps)
 return {first,authority,db,advance:(value:number)=>{ms+=value}}
}
async function assigned() {
 const env=setup(),task=await env.first.plan(studio,'plan',identity,spec)
 const claim=env.first.claim(studio,'claim',task.id,'phone-1','profile',null)
 const checkpoint=(event:string,phase:Parameters<TaskAuthority['checkpoint']>[6],ref:string|null=null)=>env.first.checkpoint(phone,event,task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,phase,ref,env.first.timeline(studio,task.id).attempt!.activeCommandId)
 return {...env,task,claim,checkpoint}
}
describe('Phase 3 authority against real SQLite transactions',()=>{
 it('uses canonical ordered specifications and excludes run identity',async()=>{
  const a=await cropTaskIdentity(identity,spec),b=await cropTaskIdentity({...identity},JSON.parse(JSON.stringify(spec)))
  expect(a).toEqual(b)
  expect(await cropTaskIdentity(identity,{...spec,pageRevision:'r2'})).not.toEqual(a)
  expect(()=>canonicalJson({bad:undefined})).toThrow()
  await expect(cropTaskIdentity(identity,{...spec,model:''})).rejects.toThrow('resolved')
 })
 it('deduplicates planning across Studio instances and admits exactly one concurrent claim',async()=>{
  const env=setup(),other=env.authority()
  const [a,b]=await Promise.all([env.first.plan(studio,'plan-a',identity,spec),other.plan(studio,'plan-b',identity,spec)])
  expect(a.id).toBe(b.id)
  const outcomes=await Promise.allSettled([Promise.resolve().then(()=>env.first.claim(studio,'claim-a',a.id,'phone-1','profile',null)),Promise.resolve().then(()=>other.claim(studio,'claim-b',a.id,'phone-2','profile',null))])
  expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1)
  expect(env.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(1)
  expect(env.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(4)
 })
 it('retains accepted command IDs over restart/lost acknowledgments and rejects conflicting event reuse',async()=>{
  const env=await assigned(),restored=env.authority()
  expect(restored.claim(studio,'claim',env.task.id,'phone-1','profile',null)).toEqual(env.claim)
  expect(()=>restored.claim(studio,'claim',env.task.id,'phone-2','profile',null)).toThrow('Conflicting')
  expect(restored.timeline(studio,env.task.id).commands).toHaveLength(1)
 })
 it('rolls back an entire conflicting resource claim without leaving reservations or commands',async()=>{
  const env=await assigned(),task=await env.first.plan(studio,'other-page',{...identity,pageId:'page-2'},spec)
  expect(()=>env.first.claim(studio,'other-claim',task.id,'phone-1','profile',null)).toThrow('reserved')
  expect(env.first.timeline(studio,task.id).task.attemptId).toBeNull()
  expect(env.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(4)
 })
 it('rejects legacy capabilities, forged workers and invalid generation/fingerprint',async()=>{
  const env=await assigned()
  expect(()=>env.first.enroll(studio,'legacy','phone-3','profile',[])).toThrow('Compatible')
  expect(()=>env.first.checkpoint({role:'phone',deviceId:'phone-2'},'forged',env.task.id,env.claim.attempt.id,1,env.task.fingerprint,'accepted',null,env.claim.command.id)).toThrow('another authenticated phone')
  expect(()=>env.first.checkpoint(phone,'stale',env.task.id,env.claim.attempt.id,2,env.task.fingerprint,'accepted',null,env.claim.command.id)).toThrow('Stale')
  expect(()=>env.first.checkpoint(phone,'wrong-command',env.task.id,env.claim.attempt.id,1,env.task.fingerprint,'accepted',null,'other-command')).toThrow('exact command')
  expect(()=>env.first.publish(phone,'forged-publish',env.task.id,env.claim.attempt.id,1,env.task.fingerprint,'artifact','b'.repeat(64),'validation/one')).toThrow('Studio')
 })
 it('expires to uncertainty and retains all reservations instead of granting another owner',async()=>{
  const env=await assigned();env.advance(300001)
  const result=env.first.renew(phone,'late',env.task.id,env.claim.attempt.id,1,env.task.fingerprint)
  expect(result.permitted).toBe(false);expect(result.task.state).toBe('uncertain')
  expect(()=>env.first.claim(studio,'steal',env.task.id,'phone-2','profile',null)).toThrow('owned')
  expect(env.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(4)
 })
 it('journals the unknown submission boundary, forbids blind resubmission and reuses saved checkpoints after restart',async()=>{
  const env=await assigned();env.checkpoint('accept','accepted');env.checkpoint('start','started')
  const intent=env.checkpoint('intent','submission_intent');expect(intent.attempt.submission).toBe('unknown')
  expect(()=>env.checkpoint('intent-again','submission_intent')).toThrow('Invalid checkpoint')
  env.checkpoint('saved','result_saved','checkpoint/raw-reply')
  expect(env.authority().timeline(studio,env.task.id).attempt?.checkpointRef).toBe('checkpoint/raw-reply')
  expect(env.checkpoint('saved','result_saved','checkpoint/raw-reply').attempt.submission).toBe('saved')
 })
 it.each([false,true])('owner pause/cancel wins over delayed actions and canonical publication (%s)',async cancel=>{
  const env=await assigned();env.checkpoint('accept','accepted');env.checkpoint('start','started')
  env.first.stop(studio,'stop',env.task.id,cancel)
  const renewed=env.first.renew(phone,'renew',env.task.id,env.claim.attempt.id,1,env.task.fingerprint)
  expect(renewed.permitted).toBe(false);expect(renewed.task.state).toBe(cancel?'cancelled':'paused')
  expect(()=>env.first.publish(studio,'publish',env.task.id,env.claim.attempt.id,1,env.task.fingerprint,'artifact','b'.repeat(64),'validation/one')).toThrow('fence')
  env.checkpoint('stopped','stop_confirmed')
  expect(env.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(0)
 })
 it('retains resource uncertainty after a local stop with an unresolved provider submission',async()=>{
  const env=await assigned();env.checkpoint('accept','accepted');env.checkpoint('start','started');env.checkpoint('intent','submission_intent')
  env.first.stop(studio,'stop',env.task.id,true);env.checkpoint('stopped','stop_confirmed')
  expect(env.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(4)
 })
 it('commits only a matching staged result with trusted validation and current ownership',async()=>{
  const env=await assigned();env.checkpoint('accept','accepted');env.checkpoint('start','started');env.checkpoint('intent','submission_intent');env.checkpoint('saved','result_saved','checkpoint/reply')
  const ref=`managed/workspace/${env.task.id.slice(12)}/${env.claim.attempt.id}/artifact`
  expect(()=>env.first.stage(phone,'bad-ref',env.task.id,env.claim.attempt.id,1,env.task.fingerprint,'artifact','canonical/page','b'.repeat(64))).toThrow('attempt-scoped')
  env.first.stage(phone,'stage',env.task.id,env.claim.attempt.id,1,env.task.fingerprint,'artifact',ref,'b'.repeat(64))
  expect(()=>env.first.publish(studio,'bad-hash',env.task.id,env.claim.attempt.id,1,env.task.fingerprint,'artifact','c'.repeat(64),'validation/destination')).toThrow('fence')
  const result=env.first.publish(studio,'publish',env.task.id,env.claim.attempt.id,1,env.task.fingerprint,'artifact','b'.repeat(64),'validation/destination')
  expect(result.task.state).toBe('verified_complete');expect(result.task.canonical).toBe(ref)
  expect(env.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(0)
  expect(env.authority().publish(studio,'publish',env.task.id,env.claim.attempt.id,1,env.task.fingerprint,'artifact','b'.repeat(64),'validation/destination')).toEqual(result)
 })
 it('refuses a changed page revision while an earlier attempt remains active or uncertain',async()=>{
  const env=await assigned()
  await expect(env.first.plan(studio,'new-input',identity,{...spec,pageRevision:'r2'})).rejects.toThrow('Reconcile')
 })
})

describe('durable production claim cancellation',()=>{
 it('tombstones a delayed claim across authority restart without cancelling a different claim',async()=>{
  const e=setup(),task=await e.first.plan(studio,'plan',identity,spec)
  const stopped=e.first.stopClaim(studio,'stop-intent',task.id,'late-claim')
  expect(stopped).toMatchObject({blockedBeforeClaim:true})
  const restarted=e.authority()
  expect(restarted.stopClaim(studio,'stop-intent',task.id,'late-claim')).toEqual(stopped)
  expect(()=>restarted.claim(studio,'late-claim',task.id,'phone-1','profile',null)).toThrow('stopped before dispatch')
  restarted.claim(studio,'different-job',task.id,'phone-2','profile',null)
  expect(restarted.timeline(studio,task.id).attempt?.deviceId).toBe('phone-2')
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(1)
 })
 it('uses the original lost-reply receipt and replays a single stop command after restart',async()=>{
  const e=await assigned(),stopped=e.authority().stopClaim(studio,'stop-original',e.task.id,'claim')
  expect(stopped).toMatchObject({task:{state:'cancelled'},command:{attemptId:e.claim.attempt.id,generation:1}})
  expect(e.authority().stopClaim(studio,'stop-original',e.task.id,'claim')).toEqual(stopped)
  e.first.stopClaim(studio,'second-stop',e.task.id,'claim')
  expect(e.first.timeline(studio,e.task.id).commands).toHaveLength(2)
 })
 it('rejects worker callers, wrong-task receipts, and non-claim event receipts without writes',async()=>{
  const e=await assigned(),other=await e.first.plan(studio,'plan-other',{...identity,pageId:'other'},spec),before=e.first.timeline(studio,e.task.id)
  expect(()=>e.first.stopClaim(phone,'forged',e.task.id,'claim')).toThrow('Studio')
  expect(()=>e.first.stopClaim(studio,'non-claim',e.task.id,'plan')).toThrow('Exact Studio claim')
  expect(()=>e.first.stopClaim(studio,'wrong-task',other.id,'claim')).toThrow('Exact Studio claim')
  expect(e.first.timeline(studio,e.task.id)).toEqual(before)
 })
})

describe('expired saved-result evidence reconciliation',()=>{
 async function pending() {
  const e=await assigned();e.checkpoint('accept','accepted');e.checkpoint('start','started');e.checkpoint('intent','submission_intent');e.checkpoint('submitted','submitted');e.advance(300001)
  const recover=(event='recover',ref='checkpoint/retained')=>e.first.recoverSaved(phone,event,e.task.id,e.claim.attempt.id,1,e.task.fingerprint,ref,e.claim.command.id)
  return {...e,recover}
 }
 it('retains the same attempt and lease across restart, without browser authority',async()=>{
  const e=await pending(),r=e.recover()
  expect(r.recoveryOnly).toBe(true);expect(r.attempt.leaseExpiresAt).toBe(e.claim.attempt.leaseExpiresAt);expect(r.task.state).toBe('uncertain')
  expect(e.authority().recoverSaved(phone,'recover',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,'checkpoint/retained',e.claim.command.id)).toEqual(r)
  expect(e.first.renew(phone,'renew-after-recovery',e.task.id,e.claim.attempt.id,1,e.task.fingerprint).permitted).toBe(false)
  expect(()=>e.checkpoint('resend','submission_intent')).toThrow()
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(1)
  expect(e.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(4)
  expect(()=>e.recover('different','checkpoint/changed')).toThrow('immutable')
 })
 it.each([false,true])('rejects recovery and publication after owner stop (%s)',async cancel=>{
  const e=await pending();e.first.stop(studio,'stop',e.task.id,cancel)
  expect(()=>e.recover()).toThrow('original current start')
  expect(()=>e.first.publish(studio,'publish',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,'artifact','b'.repeat(64),'validation/one',true)).toThrow('fence')
 })
 it('rejects wrong roles, live leases, foreign owners, stale generations and commands',async()=>{
  const e=await assigned();e.checkpoint('accept','accepted');e.checkpoint('start','started');e.checkpoint('intent','submission_intent')
  const args=[e.task.id,e.claim.attempt.id,1,e.task.fingerprint,'checkpoint/retained',e.claim.command.id] as const
  expect(()=>e.first.recoverSaved(studio,'studio',...args)).toThrow('Authenticated')
  expect(()=>e.first.recoverSaved({role:'phone',deviceId:'phone-2'},'foreign',...args)).toThrow('another authenticated')
  expect(()=>e.first.recoverSaved(phone,'live',...args)).toThrow('expired')
  e.advance(300001)
  expect(()=>e.first.recoverSaved(phone,'stale',e.task.id,e.claim.attempt.id,2,e.task.fingerprint,'checkpoint/retained',e.claim.command.id)).toThrow('Stale')
  expect(()=>e.first.recoverSaved(phone,'wrong-command',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,'checkpoint/retained','wrong')).toThrow('original current')
 })
 it('publishes only through separate recovered validation; normal publication stays fenced',async()=>{
  const e=await pending();e.recover()
  const ref=`managed/workspace/${e.task.id.slice(12)}/${e.claim.attempt.id}/artifact`
  e.first.stage(phone,'stage',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,'artifact',ref,'b'.repeat(64))
  expect(()=>e.first.publish(studio,'normal',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,'artifact','b'.repeat(64),'validation/destination')).toThrow('fence')
  const published=e.first.publish(studio,'recovered',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,'artifact','b'.repeat(64),'validation/destination',true)
  expect(published.task.state).toBe('verified_complete');expect(e.first.timeline(studio,e.task.id).attempt?.leaseExpiresAt).toBe(e.claim.attempt.leaseExpiresAt)
  expect(e.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(0)
  expect(e.authority().publish(studio,'recovered',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,'artifact','b'.repeat(64),'validation/destination',true)).toEqual(published)
 })
 it('rejects recovered publication without an explicit saved recovery record',async()=>{
  const e=await assigned();e.checkpoint('accept','accepted');e.checkpoint('start','started');e.checkpoint('intent','submission_intent');e.checkpoint('saved','result_saved','checkpoint/reply');e.advance(300001)
  const ref=`managed/workspace/${e.task.id.slice(12)}/${e.claim.attempt.id}/artifact`
  e.first.stage(phone,'stage',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,'artifact',ref,'b'.repeat(64))
  expect(()=>e.first.publish(studio,'bypass',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,'artifact','b'.repeat(64),'validation/destination',true)).toThrow('fence')
 })
})

describe('page reservation across preplanned revisions',()=>{
 it('grants one page owner when two Studio sessions preplan different revisions',async()=>{
  const e=setup(),a=await e.first.plan(studio,'revision-a',identity,spec),b=await e.authority().plan(studio,'revision-b',identity,{...spec,pageRevision:'r2',dependencies:[{id:'page',revision:'r2',sha256:'b'.repeat(64)}]})
  const outcomes=await Promise.allSettled([Promise.resolve().then(()=>e.first.claim(studio,'owner-a',a.id,'phone-1','profile',null)),Promise.resolve().then(()=>e.authority().claim(studio,'owner-b',b.id,'phone-2','profile',null))])
  expect(outcomes.filter(value=>value.status==='fulfilled')).toHaveLength(1)
  expect(e.db.prepare('SELECT id FROM managed_attempts').all()).toHaveLength(1)
  expect(e.db.prepare('SELECT resource FROM managed_reservations').all()).toHaveLength(4)
 })
 it('protects older three-row reservations and permits a different revision only after real unsent stop acknowledgment',async()=>{
  const e=setup(),a=await e.first.plan(studio,'revision-a',identity,spec),b=await e.first.plan(studio,'revision-b',identity,{...spec,pageRevision:'r2'})
  const owner=e.first.claim(studio,'owner-a',a.id,'phone-1','profile',null)
  // Simulates an existing reservation from the previously deployed three-resource release.
  e.db.prepare('DELETE FROM managed_reservations WHERE resource = ?').run('page:workspace:page')
  expect(()=>e.authority().claim(studio,'owner-b',b.id,'phone-2','profile',null)).toThrow('Page revision remains reserved')
  e.first.checkpoint(phone,'accept-a',a.id,owner.attempt.id,1,a.fingerprint,'accepted',null,owner.command.id)
  const stop=e.first.stop(studio,'stop-a',a.id,true)
  expect(()=>e.authority().claim(studio,'still-held',b.id,'phone-2','profile',null)).toThrow('reserved')
  e.first.checkpoint(phone,'stopped-a',a.id,owner.attempt.id,1,a.fingerprint,'stop_confirmed',null,stop.command!.id)
  expect(e.authority().claim(studio,'released-b',b.id,'phone-2','profile',null).task.id).toBe(b.id)
  expect(e.authority().renew(phone,'old-worker',a.id,owner.attempt.id,1,a.fingerprint)).toMatchObject({permitted:false})
 })
})

describe('Phase 4 confirmed-unsent transfer',()=>{
 async function transferable() {
  const e=await assigned(),native=[...caps,'worker-reconnect/1']
  for(const device of ['phone-1','phone-2']) {
   e.first.registerPeer({role:'phone',deviceId:device},'native-hello-'+device,['profile'],native,'1.0.999')
   e.first.enroll(studio,'native-enroll-'+device,device,'profile',native)
  }
  e.checkpoint('accepted','accepted');e.checkpoint('started','started')
  const stop=e.first.stop(studio,'pause',e.task.id,false)
  e.checkpoint('stopped','stop_confirmed')
  const transfer=(event='transfer',device='phone-2',authority=e.first)=>authority.transfer(studio,event,e.task.id,e.claim.attempt.id,1,e.task.fingerprint,stop.command!.id,device,'profile')
  return {...e,transfer,stop}
 }
 it('retains history, advances generation, survives lost reply/restart and fences the returning phone',async()=>{
  const e=await transferable(),old=e.first.timeline(studio,e.task.id),next=e.transfer()
  expect(next.task.id).toBe(old.task.id);expect(next.task.fingerprint).toBe(old.task.fingerprint)
  expect(next.task.generation).toBe(2);expect(next.attempt.deviceId).toBe('phone-2')
  expect(e.authority().transfer(studio,'transfer',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,e.stop.command!.id,'phone-2','profile')).toEqual(next)
  expect(()=>e.transfer('competing')).toThrow('Stale')
  expect(()=>e.first.renew(phone,'old-renew',e.task.id,e.claim.attempt.id,1,e.task.fingerprint)).toThrow('Stale')
  expect(()=>e.checkpoint('late-start','started')).toThrow('Stale')
  expect(e.first.inbox(phone)).toEqual([])
  expect(e.first.reconnect(phone,[{taskId:e.task.id,attemptId:e.claim.attempt.id,generation:1,fingerprint:e.task.fingerprint,phase:'stop_confirmed',submission:'unsent',checkpointRef:null}])[0].status).toBe('obsolete')
  expect(e.db.prepare('SELECT body FROM managed_attempts WHERE id=?').get(e.claim.attempt.id)).toEqual({body:JSON.stringify(old.attempt)})
  expect(e.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(4)
  expect(e.first.timeline(studio,e.task.id).commands).toHaveLength(3)
 })
 it('rejects an old job stop after transfer and after transfer back to the same original phone',async()=>{
  const e=await transferable(),next=e.transfer(),second={role:'phone',deviceId:'phone-2'} as const
  const before=e.first.timeline(studio,e.task.id)
  expect(()=>e.authority().stopClaim(studio,'stale-stop',e.task.id,'claim')).toThrow('Stale')
  expect(e.first.timeline(studio,e.task.id)).toEqual(before)
  const stop=e.first.stop(studio,'pause-return',e.task.id,false)
  e.first.checkpoint(second,'ack-return',e.task.id,next.attempt.id,2,e.task.fingerprint,'stop_confirmed',null,stop.command!.id)
  e.first.transfer(studio,'return-for-fence',e.task.id,next.attempt.id,2,e.task.fingerprint,stop.command!.id,'phone-1','profile')
  const returned=e.first.timeline(studio,e.task.id)
  expect(returned.attempt).toMatchObject({deviceId:'phone-1',generation:3})
  expect(()=>e.authority().stopClaim(studio,'stale-stop-return',e.task.id,'claim')).toThrow('Stale')
  expect(e.first.timeline(studio,e.task.id)).toEqual(returned)
 })
 it('proves only an original device obsolete acknowledged unsent stop without writes or new owner details',async()=>{
  const e=await transferable(),request={workspaceId:'workspace',taskId:e.task.id,attemptId:e.claim.attempt.id,generation:1,fingerprint:e.task.fingerprint,stopCommandId:e.stop.command!.id}
  expect(()=>e.first.obsoleteStop(phone,request)).toThrow()
  e.transfer();const before=e.db.prepare('SELECT total_changes() AS n').get().n
  const proof=e.authority().obsoleteStop(phone,request)
  expect(proof).toEqual({...request,currentGeneration:2,confirmedUnsentStop:true})
  expect(JSON.stringify(proof)).not.toContain('phone-2')
  expect(e.db.prepare('SELECT total_changes() AS n').get().n).toBe(before)
  for(const actor of [studio,{role:'phone',deviceId:'phone-2'}] as const)expect(()=>e.first.obsoleteStop(actor,request)).toThrow()
  for(const edit of [{generation:2},{fingerprint:'b'.repeat(64)},{stopCommandId:'wrong'},{workspaceId:'foreign'},{attemptId:'wrong'}])expect(()=>e.first.obsoleteStop(phone,{...request,...edit})).toThrow()
 })
 it('cancellation upgrades a confirmed paused production claim and blocks delayed handoff',async()=>{
  const e=await transferable(),lease=e.first.acquireCoordinator(studio,'coordinator','workspace','studio-a',0),coordinator={coordinatorId:lease.coordinatorId,coordinatorGeneration:1}
  const stopped=e.first.stopClaim(studio,'cancel-paused-production',e.task.id,'claim',coordinator)
  expect(stopped.task.state).toBe('cancelled');expect(stopped.command).toBeNull()
  expect(()=>e.first.transfer(studio,'delayed-handoff',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,e.stop.command!.id,'phone-2','profile',{coordinator,claimEventId:'claim',newClaimEventId:'target-claim'})).toThrow()
  expect(e.first.productionClaim(studio,e.task.id,'target-claim').status).toBe('missing')
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(1)
 })
 it('atomically hands off production with an independently replayable new claim and fences both old worker and old job',async()=>{
  const e=await transferable(),lease=e.first.acquireCoordinator(studio,'coordinator','workspace','studio-a',0),coordinator={coordinatorId:lease.coordinatorId,coordinatorGeneration:1}
  const production={coordinator,claimEventId:'claim',newClaimEventId:'handoff-claim'}
  const result=e.first.transfer(studio,'production-transfer',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,e.stop.command!.id,'phone-2','profile',production)
  expect(result.attempt).toMatchObject({generation:2,deviceId:'phone-2'})
  expect(e.first.productionClaim(studio,e.task.id,'handoff-claim')).toMatchObject({status:'recorded',attemptId:result.attempt.id,generation:2})
  expect(e.authority().claim(studio,'handoff-claim',e.task.id,'phone-2','profile',null,coordinator)).toEqual(result)
  expect(e.authority().transfer(studio,'production-transfer',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,e.stop.command!.id,'phone-2','profile',production)).toEqual(result)
  expect(()=>e.first.stopClaim(studio,'old-job-stop',e.task.id,'claim',coordinator)).toThrow('Stale')
  expect(()=>e.first.renew(phone,'return-old-worker',e.task.id,e.claim.attempt.id,1,e.task.fingerprint)).toThrow('Stale')
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(2)
  expect(e.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(4)
 })
 it('rolls back production handoff receipts and generation if the target is busy or its future claim was cancelled',async()=>{
  const e=await transferable(),lease=e.first.acquireCoordinator(studio,'coordinator','workspace','studio-a',0),coordinator={coordinatorId:lease.coordinatorId,coordinatorGeneration:lease.coordinatorGeneration}
  e.first.stopClaim(studio,'cancel-future',e.task.id,'blocked-handoff',coordinator)
  const before=e.first.timeline(studio,e.task.id)
  expect(()=>e.first.transfer(studio,'blocked-transfer',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,e.stop.command!.id,'phone-2','profile',{coordinator,claimEventId:'claim',newClaimEventId:'blocked-handoff'})).toThrow('unused target claim')
  const other=await e.first.plan(studio,'other-plan',{...identity,pageId:'other'},spec)
  e.first.claim(studio,'busy-phone',other.id,'phone-2','profile',null,coordinator)
  expect(()=>e.first.transfer(studio,'busy-production-transfer',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,e.stop.command!.id,'phone-2','profile',{coordinator,claimEventId:'claim',newClaimEventId:'new-handoff'})).toThrow('reserved')
  expect(e.first.productionClaim(studio,e.task.id,'new-handoff').status).toBe('missing')
  expect(e.first.timeline(studio,e.task.id)).toEqual(before)
 })
 it('supports an exact production transfer back while prior claim receipts remain obsolete',async()=>{
  const e=await transferable(),lease=e.first.acquireCoordinator(studio,'coordinator','workspace','studio-a',0),coordinator={coordinatorId:lease.coordinatorId,coordinatorGeneration:1}
  const second=e.first.transfer(studio,'outbound',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,e.stop.command!.id,'phone-2','profile',{coordinator,claimEventId:'claim',newClaimEventId:'second-claim'})
  const pause=e.first.stopClaim(studio,'pause-second',e.task.id,'second-claim',coordinator,false)
  e.first.checkpoint({role:'phone',deviceId:'phone-2'},'ack-second',e.task.id,second.attempt.id,2,e.task.fingerprint,'stop_confirmed',null,pause.command!.id)
  const returned=e.first.transfer(studio,'return',e.task.id,second.attempt.id,2,e.task.fingerprint,pause.command!.id,'phone-1','profile',{coordinator,claimEventId:'second-claim',newClaimEventId:'returned-claim'})
  expect(returned.attempt).toMatchObject({generation:3,deviceId:'phone-1'})
  expect(()=>e.first.stopClaim(studio,'old-origin-stop',e.task.id,'claim',coordinator)).toThrow('Stale')
  expect(()=>e.first.stopClaim(studio,'old-second-stop',e.task.id,'second-claim',coordinator)).toThrow('Stale')
  expect(e.first.claim(studio,'returned-claim',e.task.id,'phone-1','profile',null,coordinator)).toEqual(returned)
 })
 it('can transfer back only after the second phone acknowledges another unsent pause',async()=>{
  const e=await transferable(),next=e.transfer(),second={role:'phone',deviceId:'phone-2'} as const
  e.first.checkpoint(second,'second-accept',e.task.id,next.attempt.id,2,e.task.fingerprint,'accepted',null,next.command.id)
  const stop=e.first.stop(studio,'second-pause',e.task.id,false)
  expect(()=>e.first.transfer(studio,'too-early',e.task.id,next.attempt.id,2,e.task.fingerprint,stop.command!.id,'phone-1','profile')).toThrow('acknowledged')
  e.first.checkpoint(second,'second-stop',e.task.id,next.attempt.id,2,e.task.fingerprint,'stop_confirmed',null,stop.command!.id)
  const returned=e.first.transfer(studio,'return',e.task.id,next.attempt.id,2,e.task.fingerprint,stop.command!.id,'phone-1','profile')
  expect(returned.task.generation).toBe(3);expect(returned.attempt.deviceId).toBe('phone-1')
  expect(e.first.inbox(second)).toEqual([])
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(3)
 })
 it('rolls back generation, new commands and page reservation if the target is occupied',async()=>{
  const e=await transferable(),task=await e.first.plan(studio,'other-plan',{...identity,pageId:'other'},spec)
  e.first.claim(studio,'busy-target',task.id,'phone-2','profile',null)
  const before=e.first.timeline(studio,e.task.id),count=e.db.prepare('SELECT * FROM managed_commands').all().length
  expect(()=>e.transfer()).toThrow('reserved')
  expect(e.first.timeline(studio,e.task.id)).toEqual(before)
  expect(e.db.prepare('SELECT * FROM managed_commands').all()).toHaveLength(count)
  expect(e.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(4)
 })
 it.each(['unknown','submitted','saved'])('never transfers %s outcomes even after stop confirmation',async submission=>{
  const e=await transferable()
  const a=e.first.timeline(studio,e.task.id).attempt!;a.submission=submission as any;if(submission==='saved')a.checkpointRef='checkpoint/original'
  e.db.prepare('UPDATE managed_attempts SET body=? WHERE id=?').run(JSON.stringify(a),a.id)
  expect(()=>e.transfer()).toThrow('unsent')
 })
 it('rejects cancelled work, same-phone selection and stale stop fences',async()=>{
  const e=await transferable()
  expect(()=>e.transfer('same-phone','phone-1')).toThrow('different')
  expect(()=>e.first.transfer(studio,'wrong-stop',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,'other-stop','phone-2','profile')).toThrow('acknowledged')
  const task=e.first.timeline(studio,e.task.id).task;task.state='cancelled'
  e.db.prepare('UPDATE managed_tasks SET body=? WHERE id=?').run(JSON.stringify(task),task.id)
  expect(()=>e.transfer()).toThrow('acknowledged')
 })
 it('requires native-capable pairing and a fresh target handshake',async()=>{
  const e=await transferable()
  e.advance(16*60_000);expect(()=>e.transfer()).toThrow('fresh')
  e.first.registerPeer({role:'phone',deviceId:'phone-2'},'refresh-target',['profile'],[...caps,'worker-reconnect/1'],'1.0.999')
  e.first.enroll(studio,'legacy-target','phone-2','profile',caps)
  expect(()=>e.transfer()).toThrow('reconnect support')
 })
 it('forbids a worker from transferring its own assignment',async()=>{
  const e=await transferable()
  expect(()=>e.first.transfer(phone,'forged-transfer',e.task.id,e.claim.attempt.id,1,e.task.fingerprint,e.stop.command!.id,'phone-2','profile')).toThrow('Studio')
 })
})


describe('authority production coordinator epochs',()=>{
 const cf=(lease:any)=>({coordinatorId:lease.coordinatorId,coordinatorGeneration:lease.coordinatorGeneration})
 it('gives racing Studio instances one coordinator and preserves its lease across authority restart',async()=>{
  const e=setup(),other=e.authority()
  const outcomes=await Promise.allSettled([Promise.resolve().then(()=>e.first.acquireCoordinator(studio,'one','workspace','studio-a',0)),Promise.resolve().then(()=>other.acquireCoordinator(studio,'two','workspace','studio-b',0))])
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1)
  expect(e.authority().coordinator(studio,'workspace')).toMatchObject({coordinatorGeneration:1,state:'held'})
 })
 it('does not resurrect an expired coordinator, including replay of a prior renewal',()=>{
  const e=setup(),lease=e.first.acquireCoordinator(studio,'acquire','workspace','studio-a',0)
  e.first.updateCoordinator(studio,'renew','workspace',cf(lease),false);e.advance(60_001)
  expect(()=>e.first.updateCoordinator(studio,'renew','workspace',cf(lease),false)).toThrow('Stale')
  const next=e.authority().acquireCoordinator(studio,'next','workspace','studio-b',1)
  expect(next.coordinatorGeneration).toBe(2)
  expect(()=>e.first.updateCoordinator(studio,'renew','workspace',cf(lease),false)).toThrow('Stale')
 })
 it('replays a release only within its current epoch and fences return to the same coordinator ID',()=>{
  const e=setup(),first=e.first.acquireCoordinator(studio,'acquire','workspace','studio-a',0)
  const release=e.first.updateCoordinator(studio,'release','workspace',cf(first),true)
  expect(e.authority().updateCoordinator(studio,'release','workspace',cf(first),true)).toEqual(release)
  const second=e.first.acquireCoordinator(studio,'second','workspace','studio-a',1)
  expect(second.coordinatorGeneration).toBe(2)
  expect(()=>e.first.updateCoordinator(studio,'release','workspace',cf(first),true)).toThrow('Stale')
 })
 it('keeps expired coordinator ownership held against legacy claims until explicit reconciliation',async()=>{
  const e=setup(),task=await e.first.plan(studio,'plan',identity,spec)
  e.first.acquireCoordinator(studio,'acquire','workspace','studio-a',0);e.advance(60_001)
  expect(()=>e.first.claim(studio,'legacy-claim',task.id,'phone-1','profile',null)).toThrow('current production coordinator')
  const second=e.first.acquireCoordinator(studio,'second','workspace','studio-b',1)
  e.first.claim(studio,'production-claim',task.id,'phone-1','profile',null,cf(second))
  expect(e.first.timeline(studio,task.id).task.generation).toBe(1)
 })
 it('tombstones a delayed production claim under the exact live coordinator',async()=>{
  const e=setup(),task=await e.first.plan(studio,'plan',identity,spec),lease=e.first.acquireCoordinator(studio,'acquire','workspace','studio-a',0)
  expect(e.first.stopClaim(studio,'stop',task.id,'delayed-claim',cf(lease))).toMatchObject({blockedBeforeClaim:true})
  expect(()=>e.first.claim(studio,'delayed-claim',task.id,'phone-1','profile',null,cf(lease))).toThrow('stopped before dispatch')
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(0)
 })
 it('fails closed on malformed retained coordinator metadata instead of replacing it',()=>{
  const e=setup();e.db.prepare('INSERT INTO managed_coordinators(id,body) VALUES (?,?)').run('workspace',JSON.stringify({workspaceId:'workspace',coordinatorId:'old',coordinatorGeneration:1,state:'held',leaseExpiresAt:'invalid'}))
  expect(()=>e.first.acquireCoordinator(studio,'new','workspace','studio-b',1)).toThrow('Invalid retained')
  expect(e.db.prepare('SELECT * FROM managed_events WHERE id=?').all('new')).toHaveLength(0)
 })
})
