import {createRequire} from 'node:module'
import {afterEach,describe,expect,it} from 'vitest'
import {ManagedTaskApi,managedEnabled,managedPrincipal,type ManagedTaskEnvironment} from '../../relay/src/managedTaskApi.js'
import {MANAGED_CAPABILITIES,parseManagedOperation} from '../src/services/managedTaskProtocol.js'
import type {TaskSql} from '../../relay/src/taskAuthority.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite')
const studio='s'.repeat(40),phone='p'.repeat(40),other='o'.repeat(40),legacy='r'.repeat(40)
const env:ManagedTaskEnvironment={MANAGED_CROP_PAGE:'1',MANAGED_WORKSPACE_ID:'workspace',MANAGED_STUDIO_TOKEN:studio,MANAGED_DEVICE_TOKENS:JSON.stringify({'phone-1':phone,'phone-2':other}),RELAY_TOKEN:legacy}
const spec={version:'crop-page/1',provider:'chatgpt',product:'web',model:'chosen-model',settings:{mode:'Chat',effort:null},pageRevision:'r1',promptVersion:'p1',validatorVersion:'v1',dependencies:[{id:'page',revision:'r1',sha256:'a'.repeat(64)}]}
const identity={workspaceId:'workspace',seriesId:'series',chapterId:'chapter',pageId:'page'}
const opened:InstanceType<typeof DatabaseSync>[]=[]
afterEach(()=>{for(const db of opened.splice(0))db.close()})
function setup(){
 const db=new DatabaseSync(':memory:');opened.push(db)
 const sql:TaskSql={exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows}}}
 const tx=<T>(work:()=>T)=>{db.exec('BEGIN IMMEDIATE');try{const r=work();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}
 let now=Date.parse('2026-10-19T00:00:00Z')
 const api=()=>new ManagedTaskApi(sql,tx,env,()=>new Date(now).toISOString())
 const first=api()
 async function send(action:Record<string,unknown>,token=studio,instance=first){return instance.handle(new Request('https://relay.invalid/managed/operation',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({schema:'managed-task/1',workspaceId:'workspace',eventId:crypto.randomUUID(),...action})}))}
 async function handshake(token=phone,eventId='hello'){return send({action:'hello',eventId,profileIds:['profile'],capabilities:[...MANAGED_CAPABILITIES],apkVersion:'1.0.999'},token)}
 return {db,api,first,send,handshake,advance:(ms:number)=>now+=ms}
}
describe('managed task authenticated transport',()=>{
 it('authenticates a bounded read-only obsolete-stop proof and rejects invented ownership or transport fields',async()=>{
  const s=setup(),caps=[...MANAGED_CAPABILITIES,'worker-reconnect/1']
  for(const [device,token] of [['phone-1',phone],['phone-2',other]]){
   await s.send({action:'hello',profileIds:['profile'],capabilities:caps,apkVersion:'1.0.999'},token)
   await s.send({action:'enroll',deviceId:device,profileId:'profile'})
  }
  const task=(await(await s.send({action:'plan',identity,spec})).json()).result
  const assigned=(await(await s.send({action:'claim',taskId:task.id,deviceId:'phone-1',profileId:'profile',accountId:null})).json()).result
  const fence={taskId:task.id,attemptId:assigned.attempt.id,generation:1,fingerprint:task.fingerprint}
  const stop=(await(await s.send({action:'stop',taskId:task.id,cancel:false})).json()).result
  const proof={schema:'managed-obsolete-stop/1',workspaceId:'workspace',...fence,stopCommandId:stop.command.id}
  const read=(body:any=proof,token=phone,query='')=>s.first.handle(new Request('https://relay.invalid/managed/obsolete-stop'+query,{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(body)}))
  expect((await read()).status).toBe(409)
  expect((await s.send({action:'checkpoint',...fence,phase:'stop_confirmed',checkpointRef:null,commandId:stop.command.id},phone)).status).toBe(200)
  expect((await s.send({action:'transfer_unsent',...fence,stopCommandId:stop.command.id,deviceId:'phone-2',profileId:'profile'})).status).toBe(200)
  const before=s.db.prepare('SELECT total_changes() AS n').get().n
  expect((await read()).status).toBe(200)
  const {schema,...expected}=proof
  expect((await(await read()).json()).result).toEqual({...expected,currentGeneration:2,confirmedUnsentStop:true})
  expect(s.db.prepare('SELECT total_changes() AS n').get().n).toBe(before)
  expect((await read(proof,studio)).status).toBe(403);expect((await read(proof,other)).status).toBe(409)
  for(const body of [null,[],{...proof,extra:true},{...proof,generation:1.5},{...proof,workspaceId:'foreign'},{...proof,stopCommandId:'foreign'},{...proof,fingerprint:'wrong'}])expect((await read(body)).status).toBe(409)
  expect((await read(proof,phone,'?token=foreign')).status).toBe(409)
 })
 it('defaults off and rejects shared observation tokens, query credentials and body principals',async()=>{
  expect(managedEnabled({})).toBe(false)
  const request=(token:string)=>new Request('https://relay.invalid/managed/operation',{headers:{Authorization:'Bearer '+token}})
  expect(managedPrincipal(request(legacy),env)).toBeNull()
  expect(managedPrincipal(new Request('https://relay.invalid/managed/operation?token='+studio),env)).toBeNull()
  expect(managedPrincipal(request(phone),env)).toEqual({role:'phone',deviceId:'phone-1'})
  const s=setup()
  expect((await s.send({action:'hello',profileIds:['profile'],capabilities:[],apkVersion:'1.0.130',actor:{role:'studio'}},phone)).status).toBe(409)
 })
 it.each([
  {MANAGED_STUDIO_TOKEN:legacy},
  {MANAGED_DEVICE_TOKENS:JSON.stringify({'phone-1':studio})},
  {MANAGED_DEVICE_TOKENS:JSON.stringify({'phone-1':phone,'phone-2':phone})},
  {MANAGED_DEVICE_TOKENS:'not json'},
 ])('fails closed for ambiguous or shared key configuration',change=>{
  expect(managedPrincipal(new Request('https://relay.invalid',{headers:{Authorization:'Bearer '+studio}}),{...env,...change})).toBeNull()
 })
 it('never lets a phone enroll itself or use Studio control/read operations',async()=>{
  const s=setup();await s.handshake()
  expect((await s.send({action:'enroll',deviceId:'phone-1',profileId:'profile'},phone)).status).toBe(403)
  expect((await s.send({action:'plan',identity,spec},phone)).status).toBe(403)
  expect((await s.first.handle(new Request('https://relay.invalid/managed/tasks/task:sha256:'+'a'.repeat(64),{headers:{Authorization:'Bearer '+phone}}))).status).toBe(403)
 })
 it('authenticates and strictly decodes receipt cancellation, fencing a later claim after restart',async()=>{
  const s=setup();await s.handshake();await s.send({action:'enroll',deviceId:'phone-1',profileId:'profile'})
  const task=(await(await s.send({action:'plan',identity,spec})).json()).result
  const stop={action:'stop_claim',eventId:'stop-claim',taskId:task.id,claimEventId:'delayed-claim'}
  expect((await s.send(stop,phone)).status).toBe(403)
  for(const change of [{claimEventId:''},{claimEventId:'invalid/event'},{cancel:true},{taskId:'invalid'}])expect((await s.send({...stop,...change})).status).toBe(409)
  const result=await(await s.send(stop)).json()
  expect(result.result.blockedBeforeClaim).toBe(true)
  expect(await(await s.send(stop,studio,s.api())).json()).toEqual(result)
  expect((await s.send({action:'claim',eventId:'delayed-claim',taskId:task.id,deviceId:'phone-1',profileId:'profile',accountId:null},studio,s.api())).status).toBe(409)
  expect(s.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(0)
 })
 it('keeps coordinator status Studio-only and strictly validates every coordinator mutation',async()=>{
  const s=setup(),status=(token=studio,query='')=>s.first.handle(new Request('https://relay.invalid/managed/coordinator'+query,{headers:{Authorization:'Bearer '+token}}))
  expect((await status(phone)).status).toBe(403);expect((await status(studio,'?workspaceId=foreign')).status).toBe(409)
  expect((await(await status()).json()).result).toBeNull()
  const acquire={action:'coordinator_acquire',coordinatorId:'studio-a',expectedGeneration:0}
  expect((await s.send(acquire,phone)).status).toBe(403)
  for(const change of [{expectedGeneration:-1},{expectedGeneration:1.5},{coordinatorId:''},{unexpected:true}])expect((await s.send({...acquire,...change})).status).toBe(409)
  expect((await s.send({...acquire,workspaceId:'foreign'})).status).toBe(403)
  const lease=(await(await s.send(acquire)).json()).result
  for(const action of ['coordinator_renew','coordinator_release']){
   expect((await s.send({action,coordinatorId:'studio-a',coordinatorGeneration:lease.coordinatorGeneration},phone)).status).toBe(403)
   expect((await s.send({action,coordinatorId:'studio-a',coordinatorGeneration:0})).status).toBe(409)
   expect((await s.send({action,coordinatorId:'studio-a',coordinatorGeneration:1,taskId:'invented'})).status).toBe(409)
  }
  expect((await(await status()).json()).result).toEqual(lease)
 })
 it('rejects worker calls and malformed production coordinator fences on all protected operations',async()=>{
  const s=setup(),fence={coordinatorId:'studio',coordinatorGeneration:1},taskId='task:sha256:'+'a'.repeat(64)
  const operations=[{action:'claim_production',taskId,deviceId:'phone-1',profileId:'profile',accountId:null}, {action:'stop_production_claim',taskId,claimEventId:'claim'}, {action:'stop_production',taskId,cancel:true}, {action:'publish_production',taskId,attemptId:'attempt',generation:1,fingerprint:'b'.repeat(64),artifactId:'artifact',contentHash:'c'.repeat(64),validationRef:'validation/output',recovered:false}]
  for(const op of operations){
   expect((await s.send({...op,...fence},phone)).status).toBe(403)
   expect((await s.send({...op,...fence,coordinatorGeneration:Infinity})).status).toBe(409)
   expect((await s.send({...op,...fence,coordinatorId:'bad/id'})).status).toBe(409)
  }
  expect(s.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(0)
 })
 it('exposes original claim receipts as Studio-only read-only observations with strict task/workspace correlation',async()=>{
  const s=setup();await s.handshake();await s.send({action:'enroll',deviceId:'phone-1',profileId:'profile'})
  const task=(await(await s.send({action:'plan',identity,spec})).json()).result
  const lookup=(event='original',token=studio,suffix='')=>s.first.handle(new Request('https://relay.invalid/managed/production-claims/'+encodeURIComponent(task.id)+'/'+event+suffix,{headers:{Authorization:'Bearer '+token}}))
  expect((await lookup('original',phone)).status).toBe(403)
  expect((await lookup('original',studio,'?owner=other')).status).toBe(409)
  expect((await lookup('%ZZ')).status).toBe(409)
  expect((await lookup('bad%2Fid')).status).toBe(409)
  expect((await lookup('original/extra')).status).toBe(409)
  const before=s.db.prepare('SELECT total_changes() AS n').get().n
  expect((await(await lookup()).json()).result).toEqual({taskId:task.id,claimEventId:'original',status:'missing'})
  expect(s.db.prepare('SELECT total_changes() AS n').get().n).toBe(before)
  const claim=(await(await s.send({action:'claim',eventId:'original',taskId:task.id,deviceId:'phone-1',profileId:'profile',accountId:null})).json()).result
  const count=s.db.prepare('SELECT total_changes() AS n').get().n
  const result=(await(await lookup()).json()).result
  expect(result).toMatchObject({status:'recorded',taskId:task.id,attemptId:claim.attempt.id,generation:1,deviceId:'phone-1',profileId:'profile',accountId:null,fingerprint:task.fingerprint})
  expect((await(await lookup()).json()).result).toEqual(result)
  expect(s.db.prepare('SELECT total_changes() AS n').get().n).toBe(count)
  const another=(await(await s.send({action:'plan',eventId:'other-plan',identity:{...identity,pageId:'other'},spec})).json()).result
  const wrong=new Request('https://relay.invalid/managed/production-claims/'+encodeURIComponent(another.id)+'/original',{headers:{Authorization:'Bearer '+studio}})
  expect((await s.first.handle(wrong)).status).toBe(409)
  expect((await lookup('other-plan')).status).toBe(409)
 })
 it('keeps production pause/handoff Studio-only and requires exact coordinator and receipt fields',async()=>{
  const s=setup(),taskId='task:sha256:'+'a'.repeat(64),coordinator={coordinatorId:'studio',coordinatorGeneration:1}
  const pause={action:'pause_production_claim',taskId,claimEventId:'original',...coordinator}
  const transfer={action:'transfer_production',taskId,claimEventId:'original',newClaimEventId:'target-claim',attemptId:'attempt',generation:1,fingerprint:'b'.repeat(64),stopCommandId:'stop',deviceId:'phone-2',profileId:'profile',...coordinator}
  for(const op of [pause,transfer]){
   expect((await s.send(op,phone)).status).toBe(403)
   expect((await s.send({...op,coordinatorGeneration:0})).status).toBe(409)
   expect((await s.send({...op,extra:true})).status).toBe(409)
  }
  expect((await s.send({...transfer,newClaimEventId:'original'})).status).toBe(409)
  expect(s.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(0)
 })
 it('requires fresh handshake evidence and does not freshen replayed hello events',async()=>{
  const s=setup()
  expect((await s.send({action:'enroll',deviceId:'phone-1',profileId:'profile'})).status).toBe(409)
  const hello=await (await s.handshake()).json();s.advance(16*60_000)
  const replay=await (await s.handshake()).json();expect(replay).toEqual(hello)
  expect((await s.send({action:'enroll',deviceId:'phone-1',profileId:'profile'})).status).toBe(409)
  await s.handshake(phone,'fresh-hello')
  expect((await s.send({action:'enroll',deviceId:'phone-1',profileId:'profile'})).status).toBe(200)
  expect((await s.send({action:'enroll',deviceId:'phone-1',profileId:'different-profile'})).status).toBe(409)
 })
 it('negotiates partial journal support without granting managed execution enrollment',async()=>{
  const s=setup()
  const response=await (await s.send({action:'hello',profileIds:['profile'],capabilities:['command-journal/1','managed-transport/1'],apkVersion:'1.0.999'},phone)).json()
  expect(response.result.executionReady).toBe(false)
  expect((await s.send({action:'enroll',deviceId:'phone-1',profileId:'profile'})).status).toBe(409)
 })
 it('plans, atomically claims once, enforces worker identity and replays the exact claim across re-instantiation',async()=>{
  const s=setup();await s.handshake();await s.handshake(other,'hello-other')
  await s.send({action:'enroll',deviceId:'phone-1',profileId:'profile'});await s.send({action:'enroll',deviceId:'phone-2',profileId:'profile'})
  const task=(await (await s.send({action:'plan',identity,spec})).json()).result
  const op={action:'claim',eventId:'claim',taskId:task.id,deviceId:'phone-1',profileId:'profile',accountId:null}
  const claim=(await (await s.send(op)).json()).result
  expect((await s.send({...op,eventId:'competing',deviceId:'phone-2'})).status).toBe(409)
  expect((await (await s.send(op,studio,s.api())).json()).result).toEqual(claim)
  const checkpoint={action:'checkpoint',taskId:task.id,attemptId:claim.attempt.id,generation:1,fingerprint:task.fingerprint,commandId:claim.command.id,phase:'accepted',checkpointRef:null}
  expect((await s.send(checkpoint,other)).status).toBe(409)
  expect((await s.send(checkpoint,phone)).status).toBe(200)
  expect((await s.send({...checkpoint,actor:{deviceId:'phone-1'}},other)).status).toBe(409)
 })
 it('rejects cross-workspace operations before creating task rows',async()=>{
  const s=setup();expect((await s.send({action:'plan',workspaceId:'elsewhere',identity:{...identity,workspaceId:'elsewhere'},spec})).status).toBe(403)
  expect(s.db.prepare('SELECT * FROM managed_tasks').all()).toHaveLength(0)
 })
 it('strictly rejects unsupported versions, unknown fields, nonfinite fences and missing fields',()=>{
  const valid={schema:'managed-task/1',workspaceId:'workspace',eventId:'event',action:'renew',taskId:'task:sha256:'+'a'.repeat(64),attemptId:'attempt',generation:1,fingerprint:'b'.repeat(64)}
  expect(parseManagedOperation(valid)).toEqual(valid)
  for(const change of [{schema:'managed-task/2'},{receivedAt:'invented'},{generation:Infinity},{fingerprint:'bad'},{source:{role:'studio'}}])expect(()=>parseManagedOperation({...valid,...change})).toThrow()
  const {generation,...missing}=valid;expect(()=>parseManagedOperation(missing)).toThrow()
 })
})

describe('native reconnect capability and transfer authorization',()=>{
 it('accepts explicit native reconnect capability without granting a lease',async()=>{
  const s=setup()
  const reply=await s.send({action:'hello',profileIds:['profile'],capabilities:[...MANAGED_CAPABILITIES,'worker-reconnect/1'],apkVersion:'1.0.999'},phone)
  expect(reply.status).toBe(200)
  expect((await reply.json()).result.peer.capabilities).toContain('worker-reconnect/1')
  expect(s.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(0)
 })
 it('strictly parses the exact transfer fence and forbids phone-issued transfer',async()=>{
  const s=setup(),op={schema:'managed-task/1',workspaceId:'workspace',eventId:'transfer',action:'transfer_unsent',taskId:'task:sha256:'+'a'.repeat(64),attemptId:'attempt',generation:1,fingerprint:'b'.repeat(64),stopCommandId:'stop',deviceId:'phone-2',profileId:'profile'}
  expect(parseManagedOperation(op)).toEqual(op)
  for(const change of [{generation:1.5},{generation:Infinity},{confirm:true},{stopCommandId:''},{deviceId:'bad device'}])expect(()=>parseManagedOperation({...op,...change})).toThrow()
  expect((await s.send(op,phone)).status).toBe(403)
 })
})
