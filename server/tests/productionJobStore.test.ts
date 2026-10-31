import {readFileSync} from 'node:fs'
const dispositionFixture=JSON.parse(readFileSync(new URL('./fixtures/recovery-disposition-job.json',import.meta.url),'utf8'))
import {prepareDispositionJob,disposedProductionJob} from '../src/services/productionRecoveryDisposition.js'
import {handoffJob,type ProductionHandoffIntent} from '../src/services/managedProductionHandoff.js'
import {afterEach,describe,expect,it,vi} from 'vitest'
import {PrismaClient} from '@prisma/client'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {ProductionJobStore,ProductionOwnershipConflict,PRODUCTION_JOB_PREFIX} from '../src/services/productionJobStore.js'
import {productionJobDatabase} from '../src/services/productionJobDatabase.js'
import {ProductionRunner} from '../src/services/productionRunner.js'
import type {ProductionConfig,ProductionJob} from '../src/services/productionAutomationModel.js'
import {buildProcessSeries,emptyStages} from '../src/services/seriesProcessModel.js'
const config:ProductionConfig={managedCrop:true,device:'phone',profileId:'profile',clipper:{ai:'chatgpt',flow:'classic',tabs:1,chatGpt:{mode:null,model:null,effort:null}}}
const roots:string[]=[],clients:PrismaClient[]=[],stores:ProductionJobStore[]=[]
afterEach(async()=>{for(const s of stores.splice(0))s.close();await Promise.all(clients.splice(0).map(c=>c.$disconnect()));for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
async function setup(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'production-store-'));roots.push(root)
 const url='file:'+path.join(root,'fixture.db')
 const client=()=>{const c=new PrismaClient({datasources:{db:{url}}});clients.push(c);return c}
 const db=client();await db.$executeRawUnsafe('CREATE TABLE Setting (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)')
 let clock=Date.parse('2026-10-21T00:00:00Z')
 const store=(c=db)=>{const s=new ProductionJobStore(productionJobDatabase(()=>c),()=>clock,45_000,0);stores.push(s);return s}
 const job=(id='job',seriesId='series',device='phone'):ProductionJob=>({id,seriesId,config:{...config,device},revision:1,status:'running',step:'clipping',message:'waiting',createdAt:'now',updatedAt:'now',command:{kind:'clipper',sentAt:'now',managedTaskIds:['task'],managedClaims:[{taskId:'task',claimEventId:'original-claim',deviceId:device,profileId:'profile'}]}})
 return {db,client,store,job,advance:(ms=45_001)=>clock+=ms}
}
describe('production scheduler against real Prisma SQLite transactions',()=>{
 it('acquires one shared scheduler and rejects another process without interrupting its jobs',async()=>{
  const e=await setup(),a=e.store(),b=e.store(e.client());await a.activate();await a.save(e.job(),null)
  const before=await a.load()
  await expect(b.activate()).rejects.toBeInstanceOf(ProductionOwnershipConflict)
  expect(await b.load()).toEqual(before)
  expect((await b.load())[0].status).toBe('running')
 })
 it('recovers expired ownership after restart, preserves receipts, and fences every old writer and heartbeat',async()=>{
  const e=await setup(),a=e.store();await a.activate();await a.save(e.job(),null)
  e.advance();const b=e.store(e.client());await b.activate()
  const recovered=(await b.load())[0]
  expect(recovered).toMatchObject({status:'interrupted',revision:2,command:e.job().command})
  await expect(a.save({...e.job(),revision:2,message:'stale overwrite'},{id:'job',revision:1})).rejects.toBeInstanceOf(ProductionOwnershipConflict)
  await expect(a.heartbeat()).rejects.toBeInstanceOf(ProductionOwnershipConflict)
  await expect(a.activate()).rejects.toBeInstanceOf(ProductionOwnershipConflict)
  expect((await b.load())[0]).toEqual(recovered)
 })
 it('renewal prevents takeover, while expired owners cannot resurrect their lease',async()=>{
  const e=await setup(),a=e.store(),b=e.store(e.client());await a.activate();e.advance(30_000);await a.heartbeat();e.advance(30_000)
  await expect(b.activate()).rejects.toBeInstanceOf(ProductionOwnershipConflict)
  e.advance();await expect(a.heartbeat()).rejects.toBeInstanceOf(ProductionOwnershipConflict)
  await b.activate();await expect(a.activate()).rejects.toBeInstanceOf(ProductionOwnershipConflict)
 })
 it('atomically compares job ID and revision and retains exactly one competing save',async()=>{
  const e=await setup(),a=e.store();await a.activate();await a.save(e.job(),null)
  const outcomes=await Promise.allSettled([a.save({...e.job(),revision:2,message:'one'},{id:'job',revision:1}),a.save({...e.job(),revision:2,message:'two'},{id:'job',revision:1})])
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1)
  expect((await a.load())[0].revision).toBe(2)
  await expect(a.save({...e.job('replacement'),revision:3},{id:'foreign',revision:2})).rejects.toBeInstanceOf(ProductionOwnershipConflict)
 })
 it('rejects configuration mutation and reopening a terminal job even with its current revision',async()=>{
  const e=await setup(),a=e.store();await a.activate();await a.save(e.job(),null)
  await expect(a.save({...e.job(),revision:2,config:{...config,device:'other'}},{id:'job',revision:1})).rejects.toBeInstanceOf(ProductionOwnershipConflict)
  await a.save({...e.job(),revision:2,status:'cancelled'},{id:'job',revision:1})
  await expect(a.save({...e.job(),revision:3},{id:'job',revision:2})).rejects.toBeInstanceOf(ProductionOwnershipConflict)
  expect((await a.load())[0]).toMatchObject({status:'cancelled',revision:2})
 })
 it('does not overwrite old task-ID-only records and normalizes their first recovered revision',async()=>{
  const e=await setup(),old=e.job();delete old.revision;delete old.command!.managedClaims
  await e.db.setting.create({data:{key:PRODUCTION_JOB_PREFIX+old.seriesId,value:JSON.stringify(old)}})
  const a=e.store();await a.activate();const recovered=(await a.load())[0]
  expect(recovered).toMatchObject({status:'interrupted',revision:1,command:{managedTaskIds:['task']}})
  expect(recovered.command?.managedClaims).toBeUndefined()
 })
 it('enforces persisted device/series exclusion, including additional phones',async()=>{
  const e=await setup(),a=e.store();await a.activate()
  const first=e.job();first.config={...first.config,parallelDevices:[{device:'second',profileId:'p'}]};await a.save(first,null)
  await expect(a.save(e.job('other','other-series','second'),null)).rejects.toBeInstanceOf(ProductionOwnershipConflict)
  await expect(a.save({...e.job('replace'),revision:2},{id:'job',revision:1})).rejects.toBeInstanceOf(ProductionOwnershipConflict)
  await a.save(e.job('distinct','distinct-series','free'),null)
  expect(await a.load()).toHaveLength(2)
 })
 it('fails closed on corrupt retained jobs rather than hiding reservations during recovery',async()=>{
  const e=await setup();await e.db.setting.create({data:{key:PRODUCTION_JOB_PREFIX+'broken',value:'not json'}})
  const a=e.store();await expect(a.activate()).rejects.toThrow();await expect(a.load()).rejects.toThrow()
  // The acquisition transaction rolled back with the invalid record.
  expect(await e.db.setting.findUnique({where:{key:'productionScheduler:lease/1'}})).toBeNull()
 })
 it('requires and preserves the exact durable inspected resume decision before replacing an interrupted managed job',async()=>{
  const e=await setup(),a=e.store();await a.activate();await a.save(e.job(),null);e.advance()
  const b=e.store(e.client());await b.activate();const old=(await b.load())[0],version={id:old.id,revision:old.revision??0}
  const resumed={...old,id:'resumed-job',revision:version.revision+1,status:'running' as const}
  await expect(b.save(resumed,version)).rejects.toThrow('Explicit inspected resume')
  const approved={...resumed,resumedFrom:{jobId:old.id,revision:version.revision,scopeDigest:'a'.repeat(64),checkedAt:'2026-10-22T00:00:00Z',preparedTaskIds:[]}}
  await expect(b.save({...approved,command:undefined},version)).rejects.toThrow('exact saved configuration')
  await b.save(approved,version)
  expect((await b.load())[0]).toEqual(approved)
  await expect(b.save({...approved,revision:approved.revision+1,resumedFrom:{...approved.resumedFrom,scopeDigest:'b'.repeat(64)}},{id:approved.id,revision:approved.revision})).rejects.toThrow('immutable')
 })
 it('persists handoff intent before applying an exactly derived target receipt and rejects forged replacement',async()=>{
  const e=await setup(),a=e.store();await a.activate();await a.save(e.job(),null);e.advance()
  const b=e.store(e.client());await b.activate();const old=(await b.load())[0]
  const intent:ProductionHandoffIntent={eventId:'transfer-event',newClaimEventId:'target-claim',claimEventId:'original-claim',taskId:'task',attemptId:'old-attempt',generation:1,fingerprint:'a'.repeat(64),stopCommandId:'stop',deviceId:'second-phone',profileId:'profile',createdAt:'2026-10-22T00:00:00Z'}
  const pending={...old,revision:(old.revision??0)+1,pendingHandoff:intent}
  await b.save(pending,{id:old.id,revision:old.revision??0})
  const next=handoffJob(pending,intent,{attemptId:'target-attempt',generation:2},Date.parse('2026-10-22T00:00:01Z'))
  await expect(b.save({...next,config:{...next.config,device:'forged'}},{id:pending.id,revision:pending.revision})).rejects.toThrow()
  await b.save(next,{id:pending.id,revision:pending.revision})
  const retained=(await b.load())[0]
  expect(retained.command!.managedClaims![0]).toMatchObject({claimEventId:'target-claim',deviceId:'second-phone'})
  expect(retained.handoffHistory).toHaveLength(1);expect(retained.pendingHandoff).toBeUndefined()
  await expect(b.save(next,{id:pending.id,revision:pending.revision})).rejects.toThrow('replaced or changed')
 })
 it('preserves candidate handoff identities across scheduler takeover and derived claim replacement',async()=>{
  const e=await setup(),a=e.store();await a.activate();await a.save(e.job(),null);e.advance();const b=e.store(e.client());await b.activate();const old=(await b.load())[0]
  const intent:ProductionHandoffIntent={accountCandidateId:'retained-candidate',eventId:'candidate-action',newClaimEventId:'independent-claim',claimEventId:'original-claim',taskId:'task',attemptId:'original-attempt',generation:1,fingerprint:'a'.repeat(64),stopCommandId:'stop',deviceId:'second-phone',profileId:'profile',createdAt:'2026-10-24T00:00:00Z'}
  const pending={...old,revision:(old.revision??0)+1,pendingHandoff:intent};await b.save(pending,{id:old.id,revision:old.revision??0});e.advance();const c=e.store(e.client());await c.activate();const retained=(await c.load())[0]
  expect(retained.pendingHandoff).toEqual(intent)
  await expect(c.save({...retained,revision:(retained.revision??0)+1,pendingHandoff:{...intent,accountCandidateId:'other'}},{id:retained.id,revision:retained.revision??0})).rejects.toThrow('Pending handoff')
  const next=handoffJob(retained,intent,{attemptId:'independent-attempt',generation:2},Date.parse('2026-10-24T00:00:01Z'));await c.save(next,{id:retained.id,revision:retained.revision??0})
  const applied=(await c.load())[0];expect(applied.handoffHistory![0].accountCandidateId).toBe('retained-candidate');expect(applied.command!.managedClaims![0].claimEventId).toBe('independent-claim')
 })
 it('requires the original disposition receipt before clearing a pending handoff and preserves history across takeover',async()=>{
  const e=await setup(),a=e.store();await a.activate()
  const original:ProductionJob=structuredClone(dispositionFixture.original),receipt=structuredClone(dispositionFixture.receipt)
  await a.save(original,null);const prepared=prepareDispositionJob(original,receipt.intent);await a.save(prepared,{id:original.id,revision:1})
  await expect(a.save({...prepared,revision:3,pendingHandoff:undefined,pendingRecoveryDisposition:undefined},{id:prepared.id,revision:2})).rejects.toThrow()
  e.advance();const b=e.store(e.client());await b.activate();const retained=(await b.load())[0];expect(retained.pendingRecoveryDisposition).toEqual(receipt.intent)
  const next=disposedProductionJob(retained,receipt);await b.save(next,{id:retained.id,revision:retained.revision??0});const saved=(await b.load())[0]
  expect(saved.pendingHandoff).toBeUndefined();expect(saved.command).toEqual(original.command);expect(saved.status).toBe('interrupted');expect(saved.recoveryDispositionHistory).toHaveLength(1)
  await expect(b.save({...saved,revision:4,recoveryDispositionHistory:[]},{id:saved.id,revision:3})).rejects.toThrow('immutable')
 })
 it('applies an expired-unreceived decision receipt without clearing the original pending handoff',async()=>{
  const e=await setup(),a=e.store();await a.activate();const original:ProductionJob=structuredClone(dispositionFixture.original),applied=structuredClone(dispositionFixture.receipt)
  const receipt={...applied,state:'not_applied_expired' as const,receivedAt:applied.intent.inspectedAt+15000,closed:null,successorClaimBlocked:null,stop:null,afterBudget:applied.beforeBudget}
  await a.save(original,null);const pending=prepareDispositionJob(original,receipt.intent);await a.save(pending,{id:original.id,revision:1});const next=disposedProductionJob(pending,receipt);await a.save(next,{id:pending.id,revision:2});const saved=(await a.load())[0]
  expect(saved.pendingHandoff).toEqual(original.pendingHandoff);expect(saved.pendingRecoveryDisposition).toBeUndefined();expect(saved.recoveryDispositionHistory![0].receipt.state).toBe('not_applied_expired')
 })
 it('retains cancellation across a lost handoff reply and rejects the delayed local apply',async()=>{
  const e=await setup(),a=e.store();await a.activate();await a.save(e.job(),null);e.advance()
  const b=e.store(e.client());await b.activate();const old=(await b.load())[0]
  const intent:ProductionHandoffIntent={eventId:'transfer-event',newClaimEventId:'target-claim',claimEventId:'original-claim',taskId:'task',attemptId:'old-attempt',generation:1,fingerprint:'a'.repeat(64),stopCommandId:'stop',deviceId:'second-phone',profileId:'profile',createdAt:'2026-10-22T00:00:00Z'}
  const pending={...old,revision:(old.revision??0)+1,pendingHandoff:intent}
  await b.save(pending,{id:old.id,revision:old.revision??0})
  const next=handoffJob(pending,intent,{attemptId:'target-attempt',generation:2},Date.parse('2026-10-22T00:00:01Z'))
  const cancelled={...pending,revision:pending.revision+1,status:'cancelled' as const}
  await b.save(cancelled,{id:pending.id,revision:pending.revision})
  await expect(b.save(next,{id:pending.id,revision:pending.revision})).rejects.toThrow()
  const forged={...next,revision:cancelled.revision+1}
  await expect(b.save(forged,{id:cancelled.id,revision:cancelled.revision})).rejects.toThrow()
  expect((await b.load())[0]).toEqual(cancelled)
 })
 it('admits at most one scheduler when two independent Prisma clients acquire concurrently',async()=>{
  const e=await setup(),a=e.store(),b=e.store(e.client())
  const outcomes=await Promise.allSettled([a.activate(),b.activate()])
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1)
  expect(outcomes.find(r=>r.status==='rejected')).toMatchObject({reason:expect.any(ProductionOwnershipConflict)})
  const winner=outcomes[0].status==='fulfilled'?a:b;await winner.save(e.job(),null)
  expect(await winner.load()).toHaveLength(1)
 },15_000)
})
function series(){const stages=emptyStages();for(const key of ['download','cleanup','stitch'] as const)stages[key]={state:'done'};return buildProcessSeries({id:'series',title:'Diagnostic',rootFolder:'Diagnostic'},[{id:'chapter',number:1,name:'Chapter 1',stages}])}
describe('ProductionRunner durable ownership',()=>{
 it('does not let a second reader interrupt a live owner and rejects its start and Stop',async()=>{
  const e=await setup(),a=e.store(),b=e.store(e.client()),perform=vi.fn(async()=>new Promise<void>(()=>{})),stop=vi.fn(async()=>{})
  const runner=(store:ProductionJobStore)=>new ProductionRunner({activate:()=>store.activate(),load:()=>store.load(),save:(j,v)=>store.save(j,v),series:async()=>series(),validate:async()=>{},perform,stop,emit:()=>{}})
  const first=runner(a),second=runner(b);const started=await first.start('series',config)
  await vi.waitFor(()=>expect(perform).toHaveBeenCalledOnce())
  expect((await second.get('series')).job).toMatchObject({id:started.id,status:'running'})
  await expect(second.start('series',config)).rejects.toBeInstanceOf(ProductionOwnershipConflict)
  await expect(second.cancel('series')).rejects.toBeInstanceOf(ProductionOwnershipConflict)
  expect(stop).not.toHaveBeenCalled();expect((await first.get('series')).job?.status).toBe('running')
 })
 it('fences stale reports and cancellation after a new process recovers and replaces the job',async()=>{
  const e=await setup(),a=e.store(),b=e.store(e.client());let reportOld:any,finishOld!:()=>void
  const stop=vi.fn(async()=>{}),events:ProductionJob[]=[]
  const old=new ProductionRunner({activate:()=>a.activate(),load:()=>a.load(),save:(j,v)=>a.save(j,v),series:async()=>series(),validate:async()=>{},perform:async(_s,_j,_signal,report)=>{reportOld=report;await new Promise<void>(resolve=>{finishOld=resolve})},stop,emit:j=>events.push(j)})
  const started=await old.start('series',config);await vi.waitFor(()=>expect(reportOld).toBeTypeOf('function'))
  e.advance();await b.activate();const recovered=(await b.load())[0]
  const replacement={...recovered,id:'new-job',revision:(recovered.revision??0)+1,status:'running' as const,resumedFrom:{jobId:recovered.id,revision:recovered.revision??0,scopeDigest:'a'.repeat(64),checkedAt:'2026-10-22T00:00:00Z',preparedTaskIds:[]}}
  await b.save(replacement,{id:recovered.id,revision:recovered.revision??0})
  await expect(reportOld('stale report')).rejects.toBeInstanceOf(ProductionOwnershipConflict)
  await expect(old.cancel('series')).rejects.toBeInstanceOf(ProductionOwnershipConflict)
  expect(stop).not.toHaveBeenCalled();expect((await b.load())[0]).toEqual(replacement)
  finishOld();await new Promise(resolve=>setTimeout(resolve,0))
  expect(events.at(-1)?.id).toBe(started.id);expect((await b.load())[0]).toEqual(replacement)
 })
})

describe('scheduler recovery regressions',()=>{
 it('reacquires its own expired lease without restarting and retains original claim IDs',async()=>{
  const e=await setup(),a=e.store();await a.activate();await a.save(e.job(),null)
  const lost=vi.fn(),recovered=vi.fn(async()=>{});a.setOwnershipHandlers(lost,recovered)
  e.advance();await a.activate()
  expect(lost).toHaveBeenCalledOnce();expect(recovered).toHaveBeenCalledWith([expect.objectContaining({status:'interrupted',command:e.job().command})])
  const saved=(await a.load())[0];await a.save({...saved,status:'cancelled',revision:3},{id:saved.id,revision:2})
 })
 it('recovers after a transient heartbeat database failure on the next heartbeat',async()=>{
  const e=await setup(),base=productionJobDatabase(()=>e.db);let fail=false
  const a=new ProductionJobStore({transaction:work=>fail?Promise.reject(new Error('SQLITE_BUSY')):base.transaction(work)},Date.now,45000,0);stores.push(a)
  await a.activate();await a.save(e.job(),null);fail=true
  await expect(a.heartbeat()).rejects.toThrow('SQLITE_BUSY');fail=false
  await a.heartbeat();expect((await a.load())[0]).toMatchObject({status:'interrupted',command:e.job().command})
  await a.heartbeat()
 })
 it('releases on shutdown immediately without releasing a different live owner',async()=>{
  const e=await setup(),a=e.store(),b=e.store(e.client());await a.activate();await a.release();await b.activate()
  await a.release();await b.heartbeat();await expect(a.activate()).rejects.toThrow('shutting down')
 })
 it('retries initialization after a corrupt job is repaired',async()=>{
  const e=await setup(),a=e.store(),row={key:PRODUCTION_JOB_PREFIX+'broken',value:'broken'};await e.db.setting.create({data:row})
  const runner=new ProductionRunner({activate:()=>a.activate(),load:()=>a.load(),save:(j,v)=>a.save(j,v),series:async()=>{throw Error('Unused')},validate:async()=>{},perform:async()=>{},stop:async()=>{},emit:()=>{}})
  await expect(runner.init()).rejects.toThrow();await e.db.setting.delete({where:{key:row.key}})
  await expect(runner.init()).resolves.toBeUndefined()
 })
 it('aborts active work on loss and stops its original receipts after ownership is recovered',async()=>{
  const e=await setup(),a=e.store(),stop=vi.fn(async()=>{});let signal:AbortSignal|undefined
  const runner=new ProductionRunner({activate:()=>a.activate(),load:()=>a.load(),save:(j,v)=>a.save(j,v),series:async()=>series(),validate:async()=>{},perform:async(_step,_job,s,report)=>{signal=s;await report('Claim retained',{kind:'clipper',sentAt:'now',managedClaims:e.job().command!.managedClaims});await new Promise<void>(resolve=>s.addEventListener('abort',()=>resolve(),{once:true}))},stop,emit:()=>{}})
  a.setOwnershipHandlers(()=>runner.ownershipLost(),jobs=>runner.reconcileInterrupted(jobs))
  await runner.start('series',config);await vi.waitFor(()=>expect(signal).toBeDefined())
  e.advance();await expect(a.heartbeat()).rejects.toBeInstanceOf(ProductionOwnershipConflict)
  expect(signal!.aborted).toBe(true);await a.activate()
  expect(stop).toHaveBeenCalledWith(expect.objectContaining({status:'interrupted',command:expect.objectContaining({managedClaims:e.job().command!.managedClaims})}))
  expect((await a.load())[0].status).toBe('interrupted')
 })
})

it('allows Stop for an interrupted legacy job after scheduler recovery',async()=>{
 const e=await setup(),a=e.store(),legacy=e.job();delete legacy.config.managedCrop
 await a.activate();await a.save(legacy,null);e.advance();await a.activate()
 const stop=vi.fn(async()=>{}),runner=new ProductionRunner({activate:()=>a.activate(),load:()=>a.load(),save:(j,v)=>a.save(j,v),series:async()=>series(),validate:async()=>{},perform:async()=>{},stop,emit:()=>{}})
 expect((await runner.cancel('series')).status).toBe('cancelled');expect(stop).toHaveBeenCalledOnce()
})
it('persists interrupted state and stops the original phone before shutdown release',async()=>{
 const e=await setup(),a=e.store(),stop=vi.fn(async()=>{});let started=false
 const runner=new ProductionRunner({activate:()=>a.activate(),load:()=>a.load(),save:(j,v)=>a.save(j,v),series:async()=>series(),validate:async()=>{},perform:async(_step,_job,signal)=>{started=true;await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))},stop,emit:()=>{}})
 await runner.start('series',config);await vi.waitFor(()=>expect(started).toBe(true));await runner.shutdown();await a.release()
 expect(stop).toHaveBeenCalledOnce();expect((await a.load())[0].status).toBe('interrupted')
 const b=e.store(e.client());await b.activate()
})

it('refuses new starts and validation already in flight once shutdown begins',async()=>{
 const e=await setup(),a=e.store(),perform=vi.fn(async()=>{});let unblock!:()=>void,validating=false
 const runner=new ProductionRunner({activate:()=>a.activate(),load:()=>a.load(),save:(j,v)=>a.save(j,v),series:async()=>series(),validate:async()=>{validating=true;await new Promise<void>(resolve=>{unblock=resolve})},perform,stop:async()=>{},emit:()=>{}})
 const starting=runner.start('series',config),rejected=expect(starting).rejects.toThrow('shutting down')
 await vi.waitFor(()=>expect(validating).toBe(true));await runner.shutdown();unblock();await rejected
 await expect(runner.start('series',config)).rejects.toThrow('shutting down')
 expect(perform).not.toHaveBeenCalled();expect(await a.load()).toHaveLength(0)
})
