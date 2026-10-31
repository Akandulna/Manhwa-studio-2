import {describe,it,expect} from 'vitest'
import {PrismaClient} from '@prisma/client'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {AutomationRecovery} from '../src/services/automationRecovery.js'
import {productionJobDatabase} from '../src/services/productionJobDatabase.js'
import {diagnoseRecovery,RECOVERY_FAILURES,type RecoveryEvidence,type RecoveryOperation} from '../src/services/automationRecoveryPolicy.js'
const now=1792714000000,unit={workspaceId:'fixture',taskId:'task:sha256:'+'a'.repeat(64),attemptId:'attempt',generation:1,fingerprint:'b'.repeat(64)}
const evidence=(patch:Partial<RecoveryEvidence>={}):RecoveryEvidence=>({reference:'evidence/1',observedAt:now,failure:'local_import',outcome:'unsent',inputCurrent:true,reviewRequired:false,canonical:false,localState:'missing',savedCheckpoint:false,login:'signed_in',quota:'available',quotaScope:null,recheckAt:null,pageExpected:true,profileExpected:true,loading:false,precedingActionReconciled:true,knownRepair:true,uiChangeId:null,adapterScope:'fixture',contextVerified:true,contextPortable:true,policyAllowsAlternative:true,correctionAllowed:true,acceptedUnitsPreserved:true,safeReleaseVerified:true,deviceReachable:true,...patch})
const budget={used:0,uiUsed:0,nextEligibleAt:0,pending:false,exhausted:false},controls={enabled:true,paused:false,cancelled:false}
const all=new Set<RecoveryOperation>(['restore_local','upload_saved','account_recheck','navigate','ui_repair','correct_output','handoff'])
const run=(patch:Partial<RecoveryEvidence>={},b={...budget},c={...controls},enrolled=all)=>diagnoseRecovery(unit,evidence(patch),b,c,now,enrolled)
describe('REC-02 typed diagnosis with conservative capability enrollment',()=>{
 it.each(RECOVERY_FAILURES)('holds unresolved requests for %s regardless of otherwise eligible repair',failure=>{
  for(const outcome of ['unknown','submitted'] as const)expect(run({failure,outcome}).state).toBe('held')
 })
 it('separates a verified saved checkpoint transfer from navigation and original generation',()=>{
  expect(run({failure:'cloud_transfer',outcome:'saved',savedCheckpoint:true}).operation).toBe('upload_saved')
  expect(run({outcome:'saved',savedCheckpoint:false}).state).toBe('held')
  expect(run({canonical:true}).operation).toBe('restore_local')
  expect(run({canonical:true,localState:'conflict'}).state).toBe('owner_action')
  expect(run({canonical:true,localState:'verified'}, {...budget,used:3,exhausted:true}).state).toBe('verified')
 })
 it.each(['generation_quota','upload_allowance'] as const)('uses scoped %s evidence without inventing reset availability',failure=>{
  expect(run({failure,quota:'blocked',quotaScope:'provider/model/uploads',recheckAt:now+1000,policyAllowsAlternative:false})).toMatchObject({state:'waiting',operation:'wait',recheckAt:now+1000})
  expect(run({failure,quota:'blocked',quotaScope:'provider/model/uploads',recheckAt:now-1}).operation).toBe('account_recheck')
  expect(run({failure,quota:'unknown'}).state).toBe('owner_action')
  expect(run({failure,quota:'blocked',quotaScope:'provider/model',contextVerified:false}).state).toBe('owner_action')
 })
 it.each(['generation_quota','upload_allowance'] as const)('keeps %s rechecks separate from already saved or canonical output',failure=>{
  for(const patch of [{outcome:'saved' as const,savedCheckpoint:true},{canonical:true}])expect(run({failure,quota:'blocked',quotaScope:'provider/model/uploads',recheckAt:now-1,...patch}).operation).toBe('account_recheck')
 })
 it('never retries unsupported inputs or infers sign-out from a missing button',()=>{
  expect(run({failure:'unsupported_attachment'}).state).toBe('owner_action')
  expect(run({failure:'signed_out',login:'unknown'}).state).toBe('held')
  expect(run({failure:'signed_out',login:'signed_out',policyAllowsAlternative:false}).state).toBe('owner_action')
 })
 it('correlates monitor and missing-control evidence without granting repair on unknown pages',()=>{
  expect(run({failure:'missing_control',uiChangeId:'change_1'})).toMatchObject({operation:'ui_repair',incident:{cause:'website_ui',resource:'ui-change/change_1'}})
  for(const patch of [{pageExpected:false},{profileExpected:false},{knownRepair:false},{login:'unknown' as const},{quota:'blocked' as const}])expect(run({failure:'missing_control',...patch}).state).not.toBe('ready')
  expect(run({failure:'missing_control',loading:true}).state).toBe('waiting')
  expect(run({failure:'missing_control',precedingActionReconciled:false}).state).toBe('held')
  expect(run({failure:'missing_control'},{...budget,used:2,uiUsed:2}).state).toBe('owner_action')
 })
 it('requires acknowledged context before navigation, restart, correction or ownership fallback',()=>{
  expect(run({failure:'network_timeout'}).operation).toBe('navigate')
  expect(run({failure:'network_timeout',precedingActionReconciled:false}).state).toBe('held')
  expect(run({failure:'executor_stopped',contextVerified:false}).state).toBe('owner_action')
  expect(run({failure:'malformed_output',acceptedUnitsPreserved:false}).state).toBe('owner_action')
  expect(run({failure:'malformed_output'}).operation).toBe('correct_output')
  expect(run({failure:'device_unavailable',safeReleaseVerified:false}).state).toBe('held')
  expect(run({failure:'device_unavailable'}).operation).toBe('handoff')
  expect(run({failure:'unknown'}).state).toBe('owner_action')
 })
 it.each(RECOVERY_FAILURES)('never executes an unenrolled %s adapter or bypasses stop/bounds',failure=>{
  expect(run({failure},budget,controls,new Set()).state).not.toBe('ready')
  expect(run({failure},budget,{...controls,paused:true}).state).toBe('held')
  expect(run({failure},budget,{...controls,cancelled:true}).state).toBe('held')
  expect(run({failure,inputCurrent:false}).state).toBe('held')
  expect(run({failure},{...budget,used:3,exhausted:true}).state).toBe('owner_action')
 })
 it('rejects contradictory exhaustion facts before diagnosis',()=>{
  for(const change of [{used:0,exhausted:true},{used:3,exhausted:false}]){
   expect(()=>run({}, {...budget,...change})).toThrow('Exact shared recovery budget')
   expect(()=>run({}, {...budget,...change},{...controls,enabled:false})).toThrow('Exact shared recovery budget')
  }
 })
 it('rejects stale/future/untyped evidence and malformed controls instead of guessing',()=>{
  for(const patch of [{observedAt:now-120000},{observedAt:now+1},{reference:'https://secret'},{quota:'plus' as any}])expect(()=>run(patch)).toThrow()
  expect(()=>run({},budget,{} as any)).toThrow()
  expect(()=>run({}, {...budget,uiUsed:1})).toThrow()
 })
})
describe('durable Automation Manager diagnosis in real SQLite settings transactions',()=>{
 it('survives restart, shares controls, uses CAS and preserves used budgets across failure changes',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'automation-recovery-'))
  const db=new PrismaClient({datasources:{db:{url:'file:'+path.join(root,'fixture.db')}}})
  let clock=now
  try{
   await db.$executeRawUnsafe('CREATE TABLE Setting (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)')
   const a=new AutomationRecovery(productionJobDatabase(()=>db),()=>clock),b=new AutomationRecovery(productionJobDatabase(()=>db),()=>clock)
   const first=await a.observe(unit,evidence({canonical:true}),budget);expect(first.enabled).toBe(false)
   const enabled=await b.control(unit,first.revision,controls);expect(enabled.decision.state).toBe('ready')
   await expect(a.control(unit,first.revision,{...controls,paused:true})).rejects.toThrow()
   const changed=await a.observe(unit,evidence({reference:'evidence/2',failure:'cloud_transfer'}),{...budget,used:1})
   await expect(b.observe(unit,evidence({reference:'evidence/3'}),budget)).rejects.toThrow('cannot reset')
   clock+=120001
   await expect(b.control(unit,changed.revision,controls)).rejects.toThrow('Fresh')
   const cancelled=await b.control(unit,changed.revision,{...controls,cancelled:true})
   expect((await a.inspect(unit))?.cancelled).toBe(true)
   const sticky=await a.control(unit,cancelled.revision,{...controls,enabled:false});expect(sticky.cancelled).toBe(true)
   expect(await b.list()).toHaveLength(1)
   const stored=(await db.setting.findMany({where:{key:{startsWith:'automationRecovery/1/'}}}))[0]!
   for(const change of [{used:0,exhausted:true},{used:3,exhausted:false}]){
    const invalid=JSON.parse(stored.value);Object.assign(invalid.budget,change)
    const encoded=JSON.stringify(invalid);await db.setting.update({where:{key:stored.key},data:{value:encoded}})
    await expect(a.inspect(unit)).rejects.toThrow('Exact shared recovery budget')
    await expect(a.list()).rejects.toThrow('Exact shared recovery budget')
    expect((await db.setting.findUnique({where:{key:stored.key}}))?.value).toBe(encoded)
    await db.setting.update({where:{key:stored.key},data:{value:stored.value}})
   }

   await db.setting.create({data:{key:'automationRecovery/1/corrupt',value:'{broken'}})
   await expect(a.list()).rejects.toThrow()
   expect((await db.setting.findUnique({where:{key:'automationRecovery/1/corrupt'}}))?.value).toBe('{broken')
  }finally{await db.$disconnect();await fs.rm(root,{recursive:true,force:true})}
 })
})
import {AutomationRecoveryBridge} from '../src/services/automationRecoveryBridge.js'
import type {ProductionStoreDatabase} from '../src/services/productionJobStore.js'
import type {SavedCropInspection} from '../src/services/savedCropRecoveryBridge.js'
import {managerRecoveryFact} from '../src/services/managerRecoveryFact.js'
import {parseManagerReport,applyManagerReport,emptyManagerProjection} from '../src/services/managerProtocol.js'
function memoryDatabase():ProductionStoreDatabase{
 const rows=new Map<string,string>();return {transaction:async work=>work({get:async key=>rows.get(key)??null,list:async prefix=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value})),insert:async(key,value)=>{if(rows.has(key))throw new Error('Conflict');rows.set(key,value)},replace:async(key,old,value)=>{if(rows.get(key)!==old)return false;rows.set(key,value);return true}})}
}
function bridgeFixture(){
 let clock=now,network=true,inspections=0
 const controller=new AutomationRecovery(memoryDatabase(),()=>clock)
 const target={...unit,artifactId:'artifact',sha256:'c'.repeat(64),destinationId:'d'.repeat(64),chapterLabel:'Chapter 1',pageLabel:'page.png',destinationLabel:'Local crop store'}
 const view:SavedCropInspection={target,observedAt:now,globalEnabled:true,canonical:true,sourceMatches:true,localState:'missing',episode:{revision:1,enabled:true,paused:false,cancelled:false,nextEligibleAt:0,actions:[]}}
 const bridge=new AutomationRecoveryBridge({controller,workspaceId:unit.workspaceId,enabled:()=>true,inspect:async chosen=>{inspections++;if(!network)throw new Error('Relay safety pause');expect(chosen).toEqual(target);return view}})
 const act=(action:string,expectedRevision=0)=>bridge.perform({action,target,expectedRevision})
 return {controller,view,bridge,act,target,pauseNetwork:()=>network=false,advance:()=>clock+=120001,inspections:()=>inspections}
}
describe('explicit Automation Manager bridge controls',()=>{
 it('rejects arbitrary budgets/evidence/foreign units and requires both switches plus the episode',async()=>{
  const e=bridgeFixture()
  for(const bad of [{action:'inspect',target:e.target,expectedRevision:0,budget:budget},{action:'inspect',target:{...e.target,workspaceId:'foreign'},expectedRevision:0},{action:'repair',target:e.target,expectedRevision:0}])await expect(e.bridge.perform(bad)).rejects.toThrow()
  const first=await e.act('inspect');expect(first.diagnosis.enabled).toBe(false)
  e.view.globalEnabled=false;await expect(e.act('enable',first.diagnosis.revision)).rejects.toThrow()
  e.view.globalEnabled=true;e.view.episode!.enabled=false;await expect(e.act('enable',first.diagnosis.revision)).rejects.toThrow()
  e.view.episode!.enabled=true;const enabled=await e.act('enable',first.diagnosis.revision);expect(enabled.diagnosis.decision.state).toBe('ready')
  await expect(e.act('enable',first.diagnosis.revision)).rejects.toThrow()
 })
 it('allows stop controls during a network pause with expired evidence; cancellation is sticky',async()=>{
  const e=bridgeFixture(),first=await e.act('inspect');e.advance();e.pauseNetwork()
  const paused=await e.act('pause',first.diagnosis.revision);expect(paused.diagnosis.paused).toBe(true)
  const cancelled=await e.act('cancel',paused.diagnosis.revision);expect(cancelled.diagnosis.cancelled).toBe(true)
  const disabled=await e.act('disable',cancelled.diagnosis.revision);expect(disabled.diagnosis.cancelled).toBe(true);expect(e.inspections()).toBe(1)
 })
 it('archives a long timeline while retaining enable, pause and sticky cancellation',async()=>{
  const e=bridgeFixture();let d=await e.controller.observe(unit,evidence({canonical:true}),budget)
  d=await e.controller.control(unit,d.revision,controls)
  for(let i=0;i<98;i++)d=await e.controller.observe(unit,evidence({canonical:true,reference:'evidence/'+(i+2)}),budget)
  expect(d.history.length).toBeLessThanOrEqual(64)
  const paused=await e.controller.control(unit,d.revision,{...controls,paused:true});expect(paused.paused).toBe(true);expect(paused.history.at(-1)?.state).toBe('controls')
  d=await e.controller.control(unit,paused.revision,controls);expect(d.enabled).toBe(true)
  const cancelled=await e.controller.control(unit,d.revision,{...controls,cancelled:true});expect(cancelled.cancelled).toBe(true)
 })
 it('joins an existing device UI incident without clearing the device manager impact',async()=>{
  const e=bridgeFixture(),d=await e.controller.observe(unit,evidence({failure:'missing_control',uiChangeId:'abcdef123456'}),budget)
  const fact=managerRecoveryFact(d),state=emptyManagerProjection(),at=new Date(now).toISOString()
  const report={schema:'manager-report/1',eventId:'device-evidence',source:{id:'device-clipping',deviceId:'phone',manager:'device_clipping',sequence:1},observedAt:at,facts:[{...fact,key:'device-missing-control'}]}
  expect(parseManagerReport(report)).not.toBeNull();applyManagerReport(state,report as any)
  const automation={...report,eventId:'automation-evidence',source:{id:'studio-automation',deviceId:'mac-fixture',manager:'automation',sequence:1},facts:[fact]}
  expect(parseManagerReport(automation)).not.toBeNull();applyManagerReport(state,automation as any)
  expect(Object.keys(state.incidents)).toHaveLength(1)
  expect(Object.values(Object.values(state.incidents)[0].impacts).filter(i=>i.active)).toHaveLength(2)
  const verified={...d,decision:{...d.decision,state:'verified' as const}}
  applyManagerReport(state,{...automation,eventId:'verified-local',source:{...automation.source,sequence:2},facts:[managerRecoveryFact(verified)]} as any)
  expect(Object.values(state.incidents)[0].state).toBe('action_required')
 })
})
it('records verified original cloud transfer without inferring canonical/local publication or granting another transfer',()=>{
 expect(run({failure:'cloud_transfer',outcome:'saved',savedCheckpoint:true,transferVerified:true},{...budget,used:3,exhausted:true})).toMatchObject({state:'verified',operation:'inspect'})
 expect(run({failure:'cloud_transfer',outcome:'saved',savedCheckpoint:true,transferVerified:true},{...budget,pending:true})).toMatchObject({state:'held',operation:'inspect'})
})

async function retainedFixture(work:(db:PrismaClient,a:AutomationRecovery,advance:()=>void)=>Promise<void>){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'recovery-retention-')),db=new PrismaClient({datasources:{db:{url:'file:'+path.join(root,'fixture.db')}}});let clock=now
 try{await db.$executeRawUnsafe('CREATE TABLE Setting (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');await work(db,new AutomationRecovery(productionJobDatabase(()=>db),()=>clock),()=>clock++)}finally{await db.$disconnect();await fs.rm(root,{recursive:true,force:true})}
}
describe('inspection idempotency and archival regressions',()=>{
 it('refreshes identical inspection evidence hundreds of times without consuming revisions or history',async()=>retainedFixture(async(_db,a,advance)=>{
  let d=await a.observeInspection(unit,evidence(),budget)
  for(let i=1;i<=250;i++){advance();d=await a.observeInspection(unit,evidence({reference:'random/'+i,observedAt:now+i}),budget)}
  expect(d.revision).toBe(1);expect(d.history).toHaveLength(1);expect(d.evidence.observedAt).toBe(now+250)
 }))
 it('archives inactive pages beyond 128 while preserving cancelled controls and spent budget',async()=>retainedFixture(async(db,a)=>{
  let first=await a.observeInspection(unit,evidence(),{...budget,used:1});first=await a.control(unit,first.revision,{enabled:false,paused:false,cancelled:true})
  for(let i=2;i<=140;i++)await a.observeInspection({...unit,taskId:'task:sha256:'+i.toString(16).padStart(64,'0')},evidence(),budget)
  expect(await a.list()).toHaveLength(128)
  expect(await db.setting.count({where:{key:{startsWith:'automationRecoveryArchive/1/'}}})).toBe(12)
  expect(await a.inspect(unit)).toMatchObject({cancelled:true,budget:{used:1}})
  await expect(a.observeInspection(unit,evidence(),budget)).rejects.toThrow('cannot reset')
  const restored=await a.observeInspection(unit,evidence(),{...budget,used:1});expect(restored.cancelled).toBe(true);expect(restored.budget.used).toBe(1)
 }))
 it('archives prior history chunks rather than permanently filling the unit',async()=>retainedFixture(async(db,a)=>{
  let d=await a.observe(unit,evidence(),budget)
  for(let i=1;i<=150;i++)d=await a.observe(unit,evidence({reference:'source/'+i}),budget)
  expect(d.history.length).toBeLessThanOrEqual(64)
  const chunks=await db.setting.findMany({where:{key:{startsWith:'automationRecoveryHistory/1/'}}})
  expect(chunks.flatMap(r=>JSON.parse(r.value)).length+d.history.length).toBe(151)
 }))
 it('does not evict pending work to admit another page',async()=>retainedFixture(async(_db,a)=>{
  for(let i=1;i<=128;i++)await a.observeInspection({...unit,taskId:'task:sha256:'+i.toString(16).padStart(64,'0')},evidence(),{...budget,pending:true})
  await expect(a.observeInspection({...unit,taskId:'task:sha256:'+'f'.repeat(64)},evidence(),budget)).rejects.toThrow('Active recovery inventory')
 }))
})

it('requires a fresh enrolled policy decision for every requested recovery operation',async()=>retainedFixture(async(db,a)=>{
 await expect(a.assertAdmission(unit,'correct_output')).rejects.toThrow('Fresh Automation Manager diagnosis')
 let d=await a.observe(unit,evidence({failure:'malformed_output'}),budget)
 d=await a.control(unit,d.revision,controls)
 await expect(a.assertAdmission(unit,'correct_output')).rejects.toThrow('No verified runtime adapter')
 d=await a.observe(unit,evidence({reference:'canonical/1',canonical:true}),budget)
 await expect(a.assertAdmission(unit,'restore_local')).resolves.toBeUndefined()
 await expect(a.assertAdmission(unit,'navigate')).rejects.toThrow('Recovery policy holds')
 const stale=new AutomationRecovery(productionJobDatabase(()=>db),()=>now+120001)
 await expect(stale.assertAdmission(unit,'restore_local')).rejects.toThrow('Fresh')
}))
