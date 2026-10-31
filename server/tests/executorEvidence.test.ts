import {RelayDeliveryPause} from '../src/services/relayDeliveryPause.js'
import {createRequire} from 'node:module'
import {afterEach,describe,it,expect,vi} from 'vitest'
import {TaskAuthority} from '../../relay/src/taskAuthority.js'
import {ExecutorEvidenceAuthority} from '../../relay/src/executorEvidence.js'
import {ManagedTaskApi,type ManagedTaskEnvironment} from '../../relay/src/managedTaskApi.js'
import {EXECUTOR_EVIDENCE_SCHEMA,parseExecutorEvidence,EXECUTOR_FAILURES} from '../src/services/managedExecutorEvidenceProtocol.js'
import {DEFAULT_CROP_PROMPT} from '../src/services/managedCropPilotPolicy.js'
import {AutomationRecovery} from '../src/services/automationRecovery.js'
import {inspectExecutorEvidence,parseExecutorInventory,executorEvidenceTransport} from '../src/services/executorEvidenceBridge.js'
import {managerRecoveryFact} from '../src/services/managerRecoveryFact.js'
import {applyManagerReport,emptyManagerProjection} from '../src/services/managerProtocol.js'
import type {ProductionStoreDatabase} from '../src/services/productionJobStore.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite'),open:any[]=[],now=1792714000000
const studio={role:'studio'} as const,phone={role:'phone',deviceId:'original'} as const
const spec={version:'crop-page/1' as const,provider:'chatgpt' as const,product:'chatgpt-web',model:'provider-default',settings:{mode:null,effort:null},pageRevision:'r1',promptVersion:DEFAULT_CROP_PROMPT,validatorVersion:'managed-crop-validator/1',dependencies:[{id:'page',revision:'r1',sha256:'a'.repeat(64)}]}
async function fixture(){
 const db=new DatabaseSync(':memory:');open.push(db);let seq=0
 const sql:any={exec:(q:string,...args:any[])=>{const rows=db.prepare(q).all(...args);return {toArray:()=>rows}}},tx=<T>(work:()=>T)=>{const n='tx'+(++seq);db.exec('SAVEPOINT '+n);try{const r=work();db.exec('RELEASE '+n);return r}catch(e){db.exec('ROLLBACK TO '+n);db.exec('RELEASE '+n);throw e}}
 const a=new TaskAuthority(sql,tx,()=>new Date(now).toISOString(),()=> 'id_'+(++seq)),caps=['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1']
 a.registerPeer(phone,'hello',['profile'],caps,'fixture');a.enroll(studio,'enroll','original','profile',caps)
 const task=await a.plan(studio,'plan',{workspaceId:'workspace',seriesId:'series',chapterId:'chapter',pageId:'page'},spec),claim=a.claim(studio,'claim',task.id,'original','profile',null)
 const unit={workspaceId:'workspace',taskId:task.id,attemptId:claim.attempt.id,generation:claim.attempt.generation,fingerprint:task.fingerprint}
 const observation={schema:EXECUTOR_EVIDENCE_SCHEMA,id:'event',unit,commandId:claim.command.id,deviceId:'original',profileId:'profile',observedAt:now-1000,failure:'missing_control' as const,outcome:'unsent' as const,phase:'accepted',uiChangeId:'b'.repeat(64),uiObservedAt:now-2000}
 const authority=new ExecutorEvidenceAuthority(sql,tx,a,()=>now),snapshot=()=>({timeline:a.timeline(studio,task.id),reservations:db.prepare('SELECT * FROM managed_reservations ORDER BY resource').all()})
 const env:ManagedTaskEnvironment={MANAGED_AUTOMATIC_RECOVERY:'1',MANAGED_CROP_PAGE:'1',MANAGED_WORKSPACE_ID:'workspace',MANAGED_STUDIO_TOKEN:'s'.repeat(40),MANAGED_DEVICE_TOKENS:JSON.stringify({original:'p'.repeat(40)})}
 const api=(action:string,value:unknown=observation,token='p'.repeat(40))=>new ManagedTaskApi(sql,tx,env,()=>new Date(now).toISOString()).handle(new Request('https://fixture/managed/recovery/executor-evidence',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({schema:EXECUTOR_EVIDENCE_SCHEMA,action,value})}))
 const rows=new Map<string,string>(),memory:ProductionStoreDatabase={transaction:async work=>work({get:async k=>rows.get(k)??null,list:async p=>[...rows].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value})),insert:async(k,v)=>{rows.set(k,v)},replace:async(k,old,v)=>{if(rows.get(k)!==old)return false;rows.set(k,v);return true}})}
 return {a,sql,tx,unit,observation,authority,snapshot,env,api,diagnoses:new AutomationRecovery(memory,()=>now)}
}
afterEach(()=>{vi.unstubAllGlobals();for(const db of open.splice(0))db.close()})
describe('immutable original executor observations',()=>{
 it('replays receipts across restarts without changing work/resources and rejects conflicting content',async()=>{
  const e=await fixture(),before=e.snapshot(),r=e.authority.report(phone,e.observation)
  expect(new ExecutorEvidenceAuthority(e.sql,e.tx,e.a,()=>now+1).report(phone,e.observation)).toEqual(r)
  expect(e.authority.inspect(studio,e.unit).evidence).toHaveLength(1);expect(e.snapshot()).toEqual(before)
  expect(()=>e.authority.report(phone,{...e.observation,failure:'unknown',uiChangeId:null,uiObservedAt:null})).toThrow('Conflicting')
 })
 it('rejects foreign phones, profiles, commands, units and future source times',async()=>{
  const e=await fixture();expect(()=>e.authority.report({role:'phone',deviceId:'foreign'},e.observation)).toThrow();expect(()=>e.authority.report(studio,e.observation)).toThrow()
  for(const patch of [{profileId:'foreign'},{commandId:'invented'},{observedAt:now+1},{unit:{...e.unit,generation:2}}])expect(()=>e.authority.report(phone,{...e.observation,...patch})).toThrow()
  expect(()=>e.authority.inspect(phone,e.unit)).toThrow()
 })
 it('defaults intake off, allows off-switch inspection and retains a bounded immutable history',async()=>{
  const e=await fixture();expect((await e.api('report')).status).toBe(503);e.env.MANAGED_EXECUTOR_EVIDENCE='1'
  expect((await e.api('report')).status).toBe(200);expect((await e.api('report',e.observation,'s'.repeat(40))).status).toBe(409)
  delete e.env.MANAGED_EXECUTOR_EVIDENCE;expect((await e.api('inspect',e.unit,'s'.repeat(40))).status).toBe(200)
  for(let i=1;i<32;i++)e.authority.report(phone,{...e.observation,id:'event_'+i})
  expect(()=>e.authority.report(phone,{...e.observation,id:'overflow'})).toThrow('inventory full');expect(e.authority.inspect(studio,e.unit).evidence).toHaveLength(32)
 })
 it('accepts only typed facts and recent monitor correlations, without provider text',async()=>{
  const e=await fixture();for(const failure of EXECUTOR_FAILURES)expect(parseExecutorEvidence({...e.observation,failure,uiChangeId:null,uiObservedAt:null}).failure).toBe(failure)
  for(const patch of [{message:'raw text'},{failure:'guess'},{uiObservedAt:now},{uiObservedAt:now-121000},{failure:'signed_out'}])expect(()=>parseExecutorEvidence({...e.observation,...patch})).toThrow()
 })
 it('never refreshes stale source times or schedules a repair',async()=>{
  const e=await fixture();e.authority.report(phone,{...e.observation,observedAt:now-120001,uiChangeId:null,uiObservedAt:null})
  expect(await inspectExecutorEvidence(e.unit,e.authority.inspect(studio,e.unit),e.diagnoses,now)).toMatchObject({stale:true,diagnosis:null});expect(await e.diagnoses.list()).toEqual([])
 })
 it('shares the monitor incident without clearing its device impact or trusting a conflicting unsent assertion',async()=>{
  const e=await fixture(),before=e.snapshot();e.authority.report(phone,{...e.observation,outcome:'unknown'})
  const inventory=e.authority.inspect(studio,e.unit),result=await inspectExecutorEvidence(e.unit,inventory,e.diagnoses,now)
  expect(result.diagnosis).toMatchObject({enabled:false,evidence:{outcome:'unknown',observedAt:now-1000,knownRepair:false},decision:{state:'held'}})
  const state=emptyManagerProjection(),fact=managerRecoveryFact(result.diagnosis!),at=new Date(now-1000).toISOString()
  const base={schema:'manager-report/1' as const,observedAt:at,eventId:'device',source:{id:'device',deviceId:'original',manager:'device_clipping' as const,sequence:1},facts:[{...fact,key:'original-monitor'}]}
  applyManagerReport(state,base);applyManagerReport(state,{...base,eventId:'automation',source:{id:'automation',deviceId:'mac',manager:'automation',sequence:1},facts:[fact]})
  expect(Object.keys(state.incidents)).toHaveLength(1);expect(e.snapshot()).toEqual(before)
  expect((await inspectExecutorEvidence(e.unit,inventory,e.diagnoses,now)).diagnosis?.revision).toBe(result.diagnosis!.revision)
 })
 it('rejects malformed inventories, duplicate events and foreign receipt units',async()=>{
  const e=await fixture();e.authority.report(phone,e.observation);const v={schema:EXECUTOR_EVIDENCE_SCHEMA,...e.authority.inspect(studio,e.unit)}
  expect(parseExecutorInventory(v,e.unit).evidence).toHaveLength(1)
  for(const patch of [{evidence:[...v.evidence,...v.evidence]},{evidence:[{...v.evidence[0],receivedAt:0}]},{outcome:'available'}])expect(()=>parseExecutorInventory({...v,...patch},e.unit)).toThrow()
  expect(()=>parseExecutorInventory(v,{...e.unit,generation:2})).toThrow()
 })
})

describe('single-attempt executor evidence transport',()=>{
 it('persists relay backoff and never retries or bypasses a paused delivery',async()=>{
  const e=await fixture();let saved:string|null=null
  const pause=new RelayDeliveryPause({load:async()=>saved,save:async v=>{saved=v}},()=>now),fetcher=vi.fn(async()=>new Response('',{status:429,headers:{'Retry-After':'3600'}}))
  vi.stubGlobal('fetch',fetcher);const call=executorEvidenceTransport('https://relay.example','workspace','s'.repeat(40),undefined,pause)
  await expect(call(e.unit)).rejects.toThrow('unavailable');await expect(call(e.unit)).rejects.toThrow('paused');expect(fetcher).toHaveBeenCalledTimes(1);expect(saved).toBe(String(now+3600000))
 })
 it('rejects oversized inventory bytes without accepting a partial receipt',async()=>{
  const e=await fixture(),pause=new RelayDeliveryPause({load:async()=>null,save:async()=>{}},()=>now)
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('x'.repeat(128001))))
  await expect(executorEvidenceTransport('https://relay.example','workspace','s'.repeat(40),undefined,pause)(e.unit)).rejects.toThrow('bounds')
 })
})
function session(e:Awaited<ReturnType<typeof fixture>>,patch:Record<string,unknown>={}){
 return {schema:'managed-session-evidence/1',bindingId:'original_view_binding',commandId:e.observation.commandId,profileId:e.observation.profileId,fingerprint:e.unit.fingerprint,cachedSourceSha256:'a'.repeat(64),observedAt:now-1500,documentKind:'chatgpt_home',ready:true,composer:'empty',attachments:'none',response:'none',login:'unknown',exactView:true,currentProfile:true,cachedSourceVerified:true,untouched:true,context:'empty_unsent',...patch}
}
describe('original-session shape evidence without navigation permission',()=>{
 it('preserves true source time and exact original binding without enabling an adapter or changing work',async()=>{
  const e=await fixture(),before=e.snapshot(),observation={...e.observation,session:session(e)}
  const receipt=e.authority.report(phone,observation);expect(e.authority.report(phone,observation)).toEqual(receipt)
  const inventory=e.authority.inspect(studio,e.unit);expect(inventory.evidence[0].observation.session?.observedAt).toBe(now-1500)
  const result=await inspectExecutorEvidence(e.unit,inventory,e.diagnoses,now)
  expect(result.diagnosis).toMatchObject({enabled:false,evidence:{contextVerified:false,login:'unknown',quota:'unknown'},decision:{state:'owner_action',operation:'inspect'}})
  expect(e.snapshot()).toEqual(before)
 })
 it('rejects foreign command/profile/input, impossible source times and mismatched original cached bytes',async()=>{
  const e=await fixture()
  for(const patch of [{commandId:'foreign'},{profileId:'foreign'},{fingerprint:'e'.repeat(64)},{observedAt:now},{observedAt:now-122000}])expect(()=>parseExecutorEvidence({...e.observation,session:session(e,patch)})).toThrow()
  expect(()=>e.authority.report(phone,{...e.observation,session:session(e,{cachedSourceSha256:'f'.repeat(64)})})).toThrow('planned input')
 })
 it('cannot describe uncertain/touched work or conflicting page facts as an empty context',async()=>{
  const e=await fixture()
  for(const patch of [{composer:'nonempty'},{attachments:'present'},{response:'active'},{login:'signed_out'},{documentKind:'chatgpt_conversation'},{ready:false},{exactView:false},{currentProfile:false},{cachedSourceVerified:false},{untouched:false}])expect(()=>parseExecutorEvidence({...e.observation,session:session(e,patch)})).toThrow()
  for(const outcome of ['unknown','submitted','saved'])expect(()=>parseExecutorEvidence({...e.observation,outcome,session:session(e)})).toThrow()
  expect(parseExecutorEvidence({...e.observation,outcome:'unknown',session:session(e,{untouched:false,context:'held'})}).session?.context).toBe('held')
 })
 it('keeps old records compatible and rejects raw/additional data or changed immutable session facts',async()=>{
  const e=await fixture();expect(parseExecutorEvidence(e.observation)).toEqual(e.observation)
  expect(()=>parseExecutorEvidence({...e.observation,session:{...session(e),text:'private'}})).toThrow()
  expect(()=>parseExecutorEvidence({...e.observation,session:session(e,{login:'signed_in'})})).toThrow()
  e.authority.report(phone,{...e.observation,session:session(e)})
  expect(()=>e.authority.report(phone,{...e.observation,session:session(e,{bindingId:'different_binding'})})).toThrow('Conflicting')
 })
 it('retains a historical empty checkpoint without adopting it after the original attempt progresses',async()=>{
  const e=await fixture()
  for(const phase of ['accepted','started','submission_intent'] as const)e.a.checkpoint(phone,'phase_'+phase,e.unit.taskId,e.unit.attemptId,e.unit.generation,e.unit.fingerprint,phase,null,e.observation.commandId)
  e.authority.report(phone,{...e.observation,session:session(e)})
  const result=await inspectExecutorEvidence(e.unit,e.authority.inspect(studio,e.unit),e.diagnoses,now)
  expect(result.outcome).toBe('unknown');expect(result.evidence[0].observation.session?.context).toBe('empty_unsent')
  expect(result.diagnosis).toMatchObject({enabled:false,evidence:{outcome:'unknown',contextVerified:false},decision:{state:'held',operation:'inspect'}})
 })
 it('never refreshes a stale session by inspecting its relay receipt again',async()=>{
  const e=await fixture(),observedAt=now-120001,proof=session(e,{observedAt:observedAt-500})
  e.authority.report(phone,{...e.observation,observedAt,uiChangeId:null,uiObservedAt:null,session:proof})
  const result=await inspectExecutorEvidence(e.unit,e.authority.inspect(studio,e.unit),e.diagnoses,now)
  expect(result).toMatchObject({stale:true,diagnosis:null});expect(result.evidence[0].observation.session?.observedAt).toBe(proof.observedAt)
 })
})
