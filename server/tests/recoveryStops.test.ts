import {RecoveryStops} from '../../relay/src/recoveryStops.js'
import {assertRecoveryControls} from '../../relay/src/recoveryBudget.js'
import {RECOVERY_STOP_SCHEMA,parseRecoveryStopRecord} from '../src/services/recoveryStopProtocol.js'
import {AutomationRecovery} from '../src/services/automationRecovery.js'
import {recoveryStopTransport} from '../src/services/recoveryStopTransport.js'
import {RelayDeliveryPause} from '../src/services/relayDeliveryPause.js'
import type {ProductionStoreDatabase} from '../src/services/productionJobStore.js'
import type {RecoveryEvidence} from '../src/services/automationRecoveryPolicy.js'
import {vi} from 'vitest'
import {savedImportKey} from '../src/services/managedSavedImportRecoveryProtocol.js'
import {sharedRecoveryBudget} from '../../relay/src/recoveryBudget.js'
import {createRequire} from 'node:module'
import {afterEach,describe,it,expect} from 'vitest'
import {TaskAuthority} from '../../relay/src/taskAuthority.js'
import {AccountRecheckRecovery} from '../../relay/src/accountRecheckRecovery.js'
import {ManagedTaskApi,type ManagedTaskEnvironment} from '../../relay/src/managedTaskApi.js'
import {accountObservation,type AccountPolicy} from '../src/services/managedAccountsProtocol.js'
import {ACCOUNT_RECHECK_SCHEMA,type AccountRecheckFence} from '../src/services/accountRecheckRecoveryProtocol.js'
import {DEFAULT_CROP_PROMPT} from '../src/services/managedCropPilotPolicy.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite'),opened:any[]=[]
afterEach(()=>{for(const db of opened.splice(0))db.close()})
const studio={role:'studio'} as const,phone=(deviceId='one')=>({role:'phone',deviceId} as const)
const CAPS=['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','account-audit/1','account-selection/1']
const spec={version:'crop-page/1' as const,provider:'chatgpt' as const,product:'chatgpt-web',model:'provider-default',settings:{mode:null,effort:null},pageRevision:'r1',promptVersion:DEFAULT_CROP_PROMPT,validatorVersion:'managed-crop-validator/1',dependencies:[{id:'page',revision:'r1',sha256:'a'.repeat(64)}]}
async function setup(){
 const db=new DatabaseSync(':memory:');opened.push(db);let now=1792714000000,seq=0
 const sql:any={exec:(q:string,...args:any[])=>{const rows=db.prepare(q).all(...args);return {toArray:()=>rows}}}
 const tx=<T>(work:()=>T):T=>{const id='tx'+(++seq);db.exec('SAVEPOINT '+id);try{const r=work();db.exec('RELEASE '+id);return r}catch(error){db.exec('ROLLBACK TO '+id);db.exec('RELEASE '+id);throw error}}
 const event=()=> 'event_'+(++seq),a=new TaskAuthority(sql,tx,()=>new Date(now).toISOString(),()=> 'id_'+(++seq))
 for(const device of ['one','two']){a.registerPeer(phone(device),event(),['profile'],CAPS,'fixture');a.enroll(studio,event(),device,'profile',CAPS)}
 const policy:AccountPolicy={revision:1,stage:'crop_json',enabled:true,auditsEnabled:true,allowed:[{provider:'chatgpt',product:'chatgpt-web',model:'provider-default',mode:null,effort:null}],preferredProfiles:['one/profile','two/profile'],allowUnknownQuota:false,allowEstimatedQuota:false,criticalMaxAgeHours:24,contextPortable:false}
 a.accounts.setPolicy(studio,event(),policy)
 const raw=(signedIn=true,email='same@example.com')=>({checkedAt:new Date(now).toISOString(),chatGpt:{signedIn,email:signedIn?email:null,plan:'Plus'},gemini:{signedIn:false}})
 for(const device of ['one','two']){const p=a.accounts.observe(phone(device),event(),device,'profile',await accountObservation(raw(),now));a.accounts.confirm(studio,event(),device,'profile','chatgpt',p.observation!.sites.chatgpt.candidate!,'shared',1)}
 const scope={provider:'openai' as const,product:'chatgpt' as const,model:'*',project:null,feature:'crop_json'}
 a.accounts.quota(studio,event(),null,{accountId:'shared',scope,state:'available',evidence:'owner_supplied',observedAt:now,recheckAt:null})
 const task=await a.plan(studio,event(),{workspaceId:'workspace',seriesId:'series',chapterId:'chapter',pageId:'page'},spec),claim=a.claim(studio,event(),task.id,'one','profile',null)
 now+=1000;a.accounts.quota(studio,event(),null,{accountId:'shared',scope,state:'blocked',evidence:'owner_supplied',observedAt:now,recheckAt:now+1000})
 const recovery=new AccountRecheckRecovery(sql,tx,a,()=>now),unit={workspaceId:'workspace',taskId:task.id,attemptId:claim.attempt.id,generation:claim.attempt.generation,fingerprint:task.fingerprint}
 const fences=recovery.discover(studio,unit).targets,fence=fences.find(f=>f.deviceId==='two')!
 const env:ManagedTaskEnvironment={MANAGED_AUTOMATIC_RECOVERY:'1',MANAGED_CROP_PAGE:'1',MANAGED_ACCOUNT_RECHECK_RECOVERY:'1',MANAGED_WORKSPACE_ID:'workspace',MANAGED_STUDIO_TOKEN:'s'.repeat(40),MANAGED_DEVICE_TOKENS:JSON.stringify({one:'o'.repeat(40),two:'t'.repeat(40)})}
 const api=(action:string,details:Record<string,unknown>={},f:unknown=fence,token='s'.repeat(40))=>new ManagedTaskApi(sql,tx,env,()=>new Date(now).toISOString()).handle(new Request('https://fixture/managed/recovery/account-recheck',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({schema:ACCOUNT_RECHECK_SCHEMA,action,fence:f,details})}))
 const record=()=>recovery.inspect(studio,fence),enable=()=>recovery.control(studio,fence,record()?.revision??0,true,false,false),request=(id='original_request')=>recovery.request(studio,fence,record()!.revision,id)
 const finish=async(auditId:string,signedIn=true,email='same@example.com')=>{now++;return a.accounts.auditFinish(phone('two'),event(),auditId,await accountObservation(raw(signedIn,email),now))}
 const snapshot=()=>({task:a.timeline(studio,task.id),reservations:db.prepare('SELECT * FROM managed_reservations ORDER BY resource').all(),quota:db.prepare('SELECT * FROM managed_account_quotas ORDER BY id').all(),policy:db.prepare("SELECT * FROM managed_account_policies WHERE id='crop_json'").all()})
 return {a,db,sql,tx,event,policy,claim,recovery,unit,fence,raw,env,api,record,enable,request,finish,snapshot,advance:(ms=1001)=>now+=ms,now:()=>now,touch:(device='two')=>a.registerPeer(phone(device),event(),['profile'],CAPS,'fixture')}
}
const intent=(e:Awaited<ReturnType<typeof setup>>,mode:'pause'|'cancel'|'disable'|'reinspect'='pause',sequence=1)=>({schema:RECOVERY_STOP_SCHEMA,unit:e.unit,eventId:'stop_'+sequence,sequence,mode})
const stops=(e:Awaited<ReturnType<typeof setup>>)=>new RecoveryStops(e.sql,e.tx,e.a,e.recovery,e.now)
afterEach(()=>vi.unstubAllGlobals())
describe('relay retained recovery stops',()=>{
 it('disables all enrolled operations and withdraws only queued audits without releasing work or resetting budgets',async()=>{
  const e=await setup();e.advance();e.enable();e.request();const original=e.snapshot(),f={...e.unit,artifactId:'saved',sha256:'d'.repeat(64)},key=savedImportKey(f)
  const action=(id:string,phase:string)=>({id,phase,at:e.now(),finishedAt:null,evidenceRef:null})
  e.sql.exec('INSERT INTO managed_recovery_episodes (id,body) VALUES (?,?)',key,JSON.stringify({schema:'saved-crop-import-recovery/1',fence:f,destinationId:'e'.repeat(64),revision:1,enabled:true,paused:false,cancelled:false,nextEligibleAt:123,actions:[action('restore','reserved')]}))
  e.sql.exec('INSERT INTO managed_upload_recovery_episodes (id,body) VALUES (?,?)',key,JSON.stringify({schema:'saved-crop-upload-recovery/1',fence:{...f,commandId:'original',checkpointRef:'checkpoint/original'},revision:1,enabled:true,paused:false,cancelled:false,nextEligibleAt:124,actions:[action('upload','executing')]}))
  const r=stops(e).apply(studio,intent(e));expect(r.receivedAt).toBe(e.now());expect(e.snapshot()).toEqual(original)
  expect(e.record()).toMatchObject({enabled:false,paused:true,actions:[{result:'withdrawn',auditId:null}]})
  expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:3,pending:true,exhausted:true})
  for(const table of ['managed_recovery_episodes','managed_upload_recovery_episodes']){const row=JSON.parse(e.sql.exec('SELECT body FROM '+table+' WHERE id = ?',key).toArray()[0].body);expect(row).toMatchObject({enabled:false,paused:true});expect(row.actions[0].phase).toBe(table==='managed_recovery_episodes'?'reserved':'executing')}
  expect(()=>assertRecoveryControls(e.sql,e.unit)).toThrow('stop is active')
  expect(()=>e.a.accounts.requestAudit(studio,e.event(),'two','profile')).toThrow('15 minutes')
 })
 it('retains a running original audit claim until normal acknowledged cleanup even after cancellation',async()=>{
  const e=await setup();e.advance();e.enable();e.request();const id=e.event();e.a.accounts.auditClaim(phone('two'),id,'profile')
  const before=e.snapshot();stops(e).apply(studio,intent(e,'cancel'));expect(e.snapshot()).toEqual(before)
  expect(e.record()).toMatchObject({cancelled:true,actions:[{auditId:id,phase:'executing'}]});await e.finish(id)
  expect(e.record()).toMatchObject({cancelled:true,actions:[{phase:'verified',result:'quota_blocked'}]})
  expect(e.snapshot().reservations.filter((r:any)=>r.attempt_id==='audit:'+id)).toEqual([])
 })
 it('replays immutable receipts, rejects old/out-of-order changes and keeps cancellation permanent',async()=>{
  const e=await setup(),s=stops(e),first=intent(e),receipt=s.apply(studio,first)
  expect(stops(e).apply(studio,first)).toEqual(receipt)
  expect(()=>s.apply(studio,{...first,mode:'disable'})).toThrow('Conflicting')
  expect(()=>s.apply(studio,intent(e,'reinspect',3))).toThrow('acknowledged stop')
  s.apply(studio,intent(e,'cancel',2));expect(s.apply(studio,first)).toEqual(receipt)
  expect(()=>s.apply(studio,intent(e,'reinspect',3))).toThrow('permanent');expect(()=>assertRecoveryControls(e.sql,e.unit)).toThrow()
 })
 it('preparation leaves playbooks disabled/paused and preserves every action/cooldown',async()=>{
  const e=await setup();e.advance();e.enable();e.request();const s=stops(e);s.apply(studio,intent(e))
  const record=e.record(),budget=sharedRecoveryBudget(e.sql,e.unit);s.apply(studio,intent(e,'reinspect',2))
  expect(e.record()).toMatchObject({enabled:false,paused:true,actions:record!.actions,nextEligibleAt:record!.nextEligibleAt})
  expect(sharedRecoveryBudget(e.sql,e.unit)).toEqual(budget);expect(()=>assertRecoveryControls(e.sql,e.unit)).toThrow('paused')
 })
 it('rejects phone authority and invented units and accepts stops while feature flags are off',async()=>{
  const e=await setup();expect(()=>stops(e).apply(phone(),intent(e))).toThrow();expect(()=>stops(e).apply(studio,{...intent(e),unit:{...e.unit,attemptId:'invented'}})).toThrow()
  const env={...e.env,MANAGED_ACCOUNT_RECHECK_RECOVERY:'0',MANAGED_SAVED_UPLOAD_RECOVERY:'0',MANAGED_SAVED_IMPORT_RECOVERY:'0'}
  const request=(token:string)=>new Request('https://fixture/managed/recovery/stop',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(intent(e))})
  expect((await new ManagedTaskApi(e.sql,e.tx,env,()=>new Date(e.now()).toISOString()).handle(request('t'.repeat(40)))).status).toBe(403)
  expect((await new ManagedTaskApi(e.sql,e.tx,env,()=>new Date(e.now()).toISOString()).handle(request('s'.repeat(40)))).status).toBe(200)
 })
})
function localFixture(){
 const rows=new Map<string,string>();const db:ProductionStoreDatabase={transaction:async work=>{const copy=new Map(rows);const value=await work({get:async k=>copy.get(k)??null,list:async p=>[...copy].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value})),insert:async(k,v)=>{if(copy.has(k))throw new Error('duplicate');copy.set(k,v)},replace:async(k,old,v)=>{if(copy.get(k)!==old)return false;copy.set(k,v);return true}});rows.clear();for(const [k,v]of copy)rows.set(k,v);return value}}
 let now=1792714000000
 return {controller:new AutomationRecovery(db,()=>now),restart:()=>new AutomationRecovery(db,()=>now),advance:()=>now+=120001,now:()=>now}
}
const evidence=(now:number):RecoveryEvidence=>({reference:'original/evidence',observedAt:now,failure:'unknown',outcome:'unknown',inputCurrent:true,reviewRequired:false,canonical:false,localState:'unknown',savedCheckpoint:false,login:'unknown',quota:'unknown',quotaScope:null,recheckAt:null,pageExpected:false,profileExpected:false,loading:false,precedingActionReconciled:false,knownRepair:false,uiChangeId:null,adapterScope:'fixture',contextVerified:false,contextPortable:false,policyAllowsAlternative:false,correctionAllowed:false,acceptedUnitsPreserved:true,safeReleaseVerified:false,deviceReachable:false})
const budget={used:2,uiUsed:0,nextEligibleAt:1792715000000,pending:true,exhausted:false}
describe('durable detached local stop admission',()=>{
 it('saves expired evidence holds across restart without page/relay configuration and blocks adapter enabling',async()=>{
  const e=await setup(),l=localFixture(),d=await l.controller.observe(e.unit,evidence(l.now()),budget);l.advance()
  const saved=await l.controller.stop(e.unit,d.revision,'pause');expect(saved.diagnosis).toMatchObject({enabled:false,paused:true,budget,evidence:{observedAt:1792714000000}})
  expect((await l.restart().retained())[0].stop).toEqual(saved.stop);await expect(l.controller.assertAdmission(e.unit)).rejects.toThrow('stop')
  await expect(l.controller.control(e.unit,saved.diagnosis.revision,{enabled:true,paused:false,cancelled:false})).rejects.toThrow('stop')
 })
 it('does not acknowledge a newer local cancellation with an older relay reply',async()=>{
  const e=await setup(),l=localFixture(),d=await l.controller.observe(e.unit,evidence(l.now()),budget),paused=await l.controller.stop(e.unit,d.revision,'pause')
  const cancelled=await l.controller.stop(e.unit,paused.diagnosis.revision,'cancel')
  expect(await l.controller.acknowledgeStop({...paused.stop.intent,receivedAt:l.now()})).toBe(false)
  expect((await l.controller.retained())[0].stop).toEqual(cancelled.stop)
  await l.controller.acknowledgeStop({...cancelled.stop.intent,receivedAt:l.now()});await expect(l.controller.stop(e.unit,cancelled.diagnosis.revision,'reinspect')).rejects.toThrow('permanent')
 })
 it('requires exact relay confirmation before preparation, then leaves all local admission disabled',async()=>{
  const e=await setup(),l=localFixture(),d=await l.controller.observe(e.unit,evidence(l.now()),budget),paused=await l.controller.stop(e.unit,d.revision,'disable')
  await expect(l.controller.stop(e.unit,paused.diagnosis.revision,'reinspect')).rejects.toThrow('Synchronize')
  await l.controller.acknowledgeStop({...paused.stop.intent,receivedAt:l.now()})
  const prepared=await l.controller.stop(e.unit,paused.diagnosis.revision,'reinspect');await expect(l.controller.assertAdmission(e.unit)).rejects.toThrow()
  await l.controller.acknowledgeStop({...prepared.stop.intent,receivedAt:l.now()});expect(await l.controller.inspect(e.unit)).toMatchObject({enabled:false,paused:false,budget})
  await l.controller.assertAdmission(e.unit);expect((await l.controller.retained())[0].stop?.receipt?.eventId).toBe(prepared.stop.intent.eventId)
 })
 it('keeps stopping possible at the full diagnosis history bound',async()=>{
  const e=await setup(),l=localFixture();let d=await l.controller.observe(e.unit,evidence(l.now()),budget)
  for(let i=1;i<100;i++)d=await l.controller.observe(e.unit,{...evidence(l.now()),reference:'evidence/'+i},budget)
  const saved=await l.controller.stop(e.unit,d.revision,'cancel');expect(saved.diagnosis.history.length).toBeLessThanOrEqual(64);expect(saved.diagnosis.history.at(-1)?.state).toBe('controls');expect(saved.diagnosis.cancelled).toBe(true)
 })
})
describe('single-attempt stop delivery',()=>{
 it('retains the exact intent after a lost response and replays its original receipt on explicit retry',async()=>{
  const e=await setup(),s=stops(e),pause=new RelayDeliveryPause({load:async()=>null,save:async()=>{}}),call=recoveryStopTransport('https://fixture','workspace','s'.repeat(40),undefined,pause),i=intent(e)
  const original=s.apply(studio,i)
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('lost')}));await expect(call(i)).rejects.toThrow('lost')
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({schema:RECOVERY_STOP_SCHEMA,receipt:s.apply(studio,i)})))
  expect(await call(i)).toEqual(original)
 })
 it('honors durable Retry-After and rejects foreign receipts without acknowledging anything',async()=>{
  const e=await setup();let saved:string|null=null
  const pause=new RelayDeliveryPause({load:async()=>saved,save:async v=>{saved=v}},e.now),fetcher=vi.fn(async()=>new Response('',{status:429,headers:{'Retry-After':'3600'}}));vi.stubGlobal('fetch',fetcher)
  const call=recoveryStopTransport('https://fixture','workspace','s'.repeat(40),undefined,pause)
  await expect(call(intent(e))).rejects.toThrow('unconfirmed');await expect(call(intent(e))).rejects.toThrow('paused');expect(fetcher).toHaveBeenCalledTimes(1)
  expect(()=>parseRecoveryStopRecord({intent:intent(e),receipt:{...intent(e),eventId:'foreign',receivedAt:e.now()}})).toThrow()
 })
})

describe('offline stop escalation ordering',()=>{
 it('accepts a newer cancellation even when the earlier local pause was never delivered',async()=>{
  const e=await setup(),l=localFixture(),d=await l.controller.observe(e.unit,evidence(l.now()),budget)
  const paused=await l.controller.stop(e.unit,d.revision,'pause'),cancelled=await l.controller.stop(e.unit,paused.diagnosis.revision,'cancel')
  const receipt=stops(e).apply(studio,cancelled.stop.intent);await l.controller.acknowledgeStop(receipt)
  expect((await l.controller.retained())[0].stop?.receipt?.mode).toBe('cancel');expect(()=>stops(e).apply(studio,paused.stop.intent)).toThrow('permanent')
 })
 it('reserves the final bounded sequence for stopping instead of another resume cycle',async()=>{
  const e=await setup(),s=stops(e);s.apply(studio,intent(e,'pause',125))
  expect(()=>s.apply(studio,intent(e,'reinspect',126))).toThrow('final capacity')
  expect(s.apply(studio,intent(e,'cancel',128)).mode).toBe('cancel')
 })
})

describe('real SQLite local stop transaction',()=>{
 it('rolls back diagnosis and intent together when the transaction fails after both writes',async()=>{
  const {PrismaClient}=await import('@prisma/client'),fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path')
  const {productionJobDatabase}=await import('../src/services/productionJobDatabase.js'),root=await fs.mkdtemp(path.join(os.tmpdir(),'recovery-stop-db-')),db=new PrismaClient({datasources:{db:{url:'file:'+path.join(root,'fixture.db')}}})
  let fail=false
  try{
   await db.$executeRawUnsafe('CREATE TABLE Setting (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)')
   const base=productionJobDatabase(()=>db),wrapped:ProductionStoreDatabase={transaction:work=>base.transaction(async tx=>{const result=await work(tx);if(fail)throw new Error('Injected transaction failure');return result})},controller=new AutomationRecovery(wrapped,()=>1792714000000),e=await setup()
   const d=await controller.observe(e.unit,evidence(1792714000000),budget);fail=true;await expect(controller.stop(e.unit,d.revision,'cancel')).rejects.toThrow('Injected')
   fail=false;expect((await controller.retained())[0]).toMatchObject({diagnosis:{revision:d.revision,cancelled:false},stop:null})
   expect((await controller.stop(e.unit,d.revision,'cancel')).diagnosis.cancelled).toBe(true)
  }finally{await db.$disconnect();await fs.rm(root,{recursive:true,force:true})}
 })
})
