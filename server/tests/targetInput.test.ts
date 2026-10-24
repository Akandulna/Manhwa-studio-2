import {mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {TargetInputAuthority} from '../../relay/src/targetInput.js'
import {TARGET_INPUT_SCHEMA,parseTargetInputStatus,parseTargetInputReceipt} from '../src/services/targetInputProtocol.js'
import {targetInputStatusTransport} from '../src/services/targetInputBridge.js'
import {createRequire} from 'node:module'
import {afterEach,describe,it,expect,vi} from 'vitest'
import {TaskAuthority} from '../../relay/src/taskAuthority.js'
import {ManagedTaskApi,type ManagedTaskEnvironment} from '../../relay/src/managedTaskApi.js'
import {FallbackPreflightAuthority} from '../../relay/src/fallbackPreflight.js'
import {FallbackPreflightBridge,fallbackPreflightTransport} from '../src/services/fallbackPreflightBridge.js'
import {FALLBACK_PREFLIGHT_SCHEMA,EXECUTION_BLOCKERS,parseFallbackPreflight} from '../src/services/fallbackPreflightProtocol.js'
import {accountObservation,profileKey,type AccountPolicy} from '../src/services/managedAccountsProtocol.js'
import {DEFAULT_CROP_PROMPT} from '../src/services/managedCropPilotPolicy.js'
const temporary:string[]=[]
afterEach(()=>{for(const dir of temporary.splice(0))rmSync(dir,{recursive:true,force:true})})
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite'),opened:any[]=[]
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();for(const db of opened.splice(0))db.close()})
const studio={role:'studio'} as const,phone=(deviceId='one')=>({role:'phone',deviceId} as const)
const CAPS=['target-source-check/1','managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','account-audit/1','account-selection/1']
const spec={version:'crop-page/1' as const,provider:'chatgpt' as const,product:'chatgpt-web',model:'provider-default',settings:{mode:null,effort:null},pageRevision:'r1',promptVersion:DEFAULT_CROP_PROMPT,validatorVersion:'managed-crop-validator/1',dependencies:[{id:'page',revision:'r1',sha256:'a'.repeat(64)}]}
async function setup(outcome='unsent',released=true,file=':memory:'){
 const db=new DatabaseSync(file);opened.push(db);let now=1792714000000,seq=0
 const sql:any={exec:(q:string,...args:any[])=>{const rows=db.prepare(q).all(...args);return {toArray:()=>rows}}}
 const tx=<T>(work:()=>T):T=>{const id='tx'+(++seq);db.exec('SAVEPOINT '+id);try{const r=work();db.exec('RELEASE '+id);return r}catch(error){db.exec('ROLLBACK TO '+id);db.exec('RELEASE '+id);throw error}}
 const a=new TaskAuthority(sql,tx,()=>new Date(now).toISOString(),()=> 'id_'+(++seq)),event=()=> 'event_'+(++seq)
 for(const device of ['one','two']){a.registerPeer(phone(device),event(),['profile'],CAPS,'fixture');a.enroll(studio,event(),device,'profile',CAPS)}
 const policy:AccountPolicy={revision:1,stage:'crop_json',enabled:true,auditsEnabled:true,allowed:[{provider:'chatgpt',product:'chatgpt-web',model:'provider-default',mode:null,effort:null}],preferredProfiles:['two/profile'],allowUnknownQuota:false,allowEstimatedQuota:false,criticalMaxAgeHours:24,contextPortable:true}
 a.accounts.setPolicy(studio,event(),policy)
 for(const [device,account] of [['one','original'],['two','alternative']]){
  const observation=await accountObservation({checkedAt:new Date(now).toISOString(),chatGpt:{signedIn:true,email:account+'@example.com',plan:'Plus'},gemini:{signedIn:false}},now)
  const p=a.accounts.observe(phone(device),event(),device,'profile',observation);a.accounts.confirm(studio,event(),device,'profile','chatgpt',p.observation!.sites.chatgpt.candidate!,account,1)
  for(const feature of ['crop_json','uploads'])a.accounts.quota(studio,event(),null,{accountId:account,scope:{provider:'openai',product:'chatgpt',model:'*',project:null,feature},state:'available',evidence:'owner_supplied',observedAt:now,recheckAt:null})
 }
 const task=await a.plan(studio,event(),{workspaceId:'workspace',seriesId:'series',chapterId:'chapter',pageId:'page'},spec),claim=a.claim(studio,event(),task.id,'one','profile',null)
 for(const phase of ['accepted','started'] as const)a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,phase,null,claim.command.id)
 if(outcome!=='unsent')a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,'submission_intent',null,claim.command.id)
 if(['submitted','saved'].includes(outcome))a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,'submitted',null,claim.command.id)
 if(outcome==='saved')a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,'result_saved','checkpoint/saved',claim.command.id)
 if(released){const stopped=a.stop(studio,event(),task.id,false);a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,'stop_confirmed',null,stopped.command!.id)}
 const unit={workspaceId:'workspace',taskId:task.id,attemptId:claim.attempt.id,generation:claim.attempt.generation,fingerprint:task.fingerprint},targets=[{deviceId:'two',profileId:'profile'}]
 const env:ManagedTaskEnvironment={MANAGED_CROP_PAGE:'1',MANAGED_WORKSPACE_ID:'workspace',MANAGED_STUDIO_TOKEN:'s'.repeat(40),MANAGED_DEVICE_TOKENS:JSON.stringify({one:'o'.repeat(40),two:'t'.repeat(40)})}
 const api=new ManagedTaskApi(sql,tx,env,()=>new Date(now).toISOString()),authority=new FallbackPreflightAuthority(sql,tx,a,()=>now)
 const inspect=()=>authority.inspect(studio,unit,targets)
 const call=(body:any={schema:FALLBACK_PREFLIGHT_SCHEMA,unit,targets},token='s'.repeat(40))=>api.handle(new Request('https://fixture/managed/recovery/fallback-preflight',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(body)}))
 const dump=()=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((x:any)=>[x.name,db.prepare('SELECT * FROM '+x.name+' ORDER BY rowid').all()])
 const mutate=(table:string,id:string,work:(r:any)=>void)=>{const r=JSON.parse(db.prepare('SELECT body FROM '+table+' WHERE id=?').get(id).body);work(r);db.prepare('UPDATE '+table+' SET body=? WHERE id=?').run(JSON.stringify(r),id)}
 const checks=new TargetInputAuthority(sql,tx,a,authority,()=>now)
 const begin=(id='request_one',actor:any=phone('two'))=>checks.begin(actor,id,task.id,'workspace','profile')
 const proof=(c:any)=>({challengeId:c.id,observedAt:now,sourceSha256:c.sourceSha256,sourceBytes:123,specFingerprint:c.unit.fingerprint})
 return {a,db,sql,tx,unit,targets,env,authority,inspect,call,dump,mutate,event,now:()=>now,advance:(ms:number)=>now+=ms,claim,checks,begin,proof}
}

describe('target-authenticated pinned page cache checks',()=>{
 it('retains a bounded challenge and immutable source-only receipt without task effects',async()=>{
  const e=await setup(),before=e.dump(),c=e.begin(),p=e.proof(c)
  expect(c).toMatchObject({target:e.targets[0],sourceSha256:spec.dependencies[0].sha256,executionAllowed:false,portableInputVerified:false})
  const r=e.checks.report(phone('two'),p);expect(r).toMatchObject({sourceVerified:true,sourceBytes:123,executionAllowed:false,handoffAllowed:false,resendAllowed:false,portableInputVerified:false})
  const after=e.dump();expect(after.filter(([name]:any)=>name!=='managed_target_input_checks')).toEqual(before.filter(([name]:any)=>name!=='managed_target_input_checks'))
  expect(e.checks.status(studio,e.unit,e.targets[0])).toMatchObject({state:'verified_source_only',receipt:r});expect(e.dump()).toEqual(after)
  expect(e.checks.report(phone('two'),p)).toEqual(r);expect(e.dump()).toEqual(after)
  expect(e.inspect().executionBlockers).toContain('portable_target_input_not_verified')
  expect(JSON.stringify(r)).not.toMatch(/example.com|candidate|prompt|Bearer/)
 })
 it('shows missing and awaiting-target states without refreshing evidence',async()=>{
  const e=await setup(),before=e.dump();expect(e.checks.status(studio,e.unit,e.targets[0]).state).toBe('missing');expect(e.dump()).toEqual(before)
  const c=e.begin(),after=e.dump();expect(e.begin()).toEqual(c);expect(e.checks.status(studio,e.unit,e.targets[0]).state).toBe('awaiting_target');expect(e.dump()).toEqual(after)
 })
 it.each(['unknown','submitted','saved'])('does not begin for stopped %s original work',async outcome=>{
  const e=await setup(outcome),before=e.dump();expect(()=>e.begin()).toThrow();expect(e.dump()).toEqual(before)
 })
 it('rejects foreign principals, targets, units, IDs and capability claims',async()=>{
  const e=await setup(),before=e.dump()
  for(const actor of [studio,phone('one'),phone('foreign')])expect(()=>e.begin('request',actor)).toThrow()
  expect(()=>e.checks.begin(phone('two'),'bad id',e.unit.taskId,'workspace','profile')).toThrow()
  expect(()=>e.checks.begin(phone('two'),'request',e.unit.taskId,'foreign','profile')).toThrow()
  expect(()=>e.checks.begin(phone('two'),'request',e.unit.taskId,'workspace','other')).toThrow()
  expect(()=>e.checks.status(phone('two'),e.unit,e.targets[0])).toThrow();expect(e.dump()).toEqual(before)
  e.mutate('managed_peers','two',r=>{r.capabilities=r.capabilities.filter((c:string)=>c!=='target-source-check/1')});expect(()=>e.begin()).toThrow('capability')
 })
 it.each(['hash','fingerprint','future','early','size','extra','actor'])('rejects %s observations without any receipt write',async kind=>{
  const e=await setup(),c=e.begin(),p:any=e.proof(c)
  if(kind==='hash')p.sourceSha256='b'.repeat(64);if(kind==='fingerprint')p.specFingerprint='c'.repeat(64);if(kind==='future')p.observedAt++;if(kind==='early')p.observedAt--;if(kind==='size')p.sourceBytes=64000001;if(kind==='extra')p.portableInputVerified=true
  const before=e.dump();expect(()=>e.checks.report(kind==='actor'?phone('one'):phone('two'),p)).toThrow();expect(e.dump()).toEqual(before)
 })
 it.each(['account','policy','stop','reservation','quota','shared_stop','unknown'])('rechecks changed %s evidence at report time',async kind=>{
  const e=await setup(),c=e.begin(),p=e.proof(c)
  if(kind==='account')e.mutate('managed_account_profiles','two/profile',r=>{r.links.chatgpt.accountId='different'})
  if(kind==='policy')e.mutate('managed_account_policies','crop_json',r=>{r.revision++})
  if(kind==='stop')e.mutate('managed_attempts',e.unit.attemptId,r=>{r.activeCommandId='different'})
  if(kind==='reservation')e.db.prepare('INSERT INTO managed_reservations (resource,attempt_id) VALUES (?,?)').run('device:two','other')
  if(kind==='quota')e.db.prepare("DELETE FROM managed_account_quotas WHERE json_extract(body,'$.accountId')='alternative'").run()
  if(kind==='shared_stop')e.db.prepare('INSERT INTO managed_recovery_stops (id,body) VALUES (?,?)').run(JSON.stringify([e.unit.workspaceId,e.unit.taskId,e.unit.attemptId,e.unit.generation,e.unit.fingerprint]),JSON.stringify({schema:'recovery-stop/1',unit:e.unit,eventId:'hold',sequence:1,mode:'pause',receivedAt:e.now()}))
  if(kind==='unknown')e.mutate('managed_attempts',e.unit.attemptId,r=>{r.submission='unknown'})
  const before=e.dump();expect(()=>e.checks.report(phone('two'),p)).toThrow();expect(e.dump()).toEqual(before);expect(e.checks.status(studio,e.unit,e.targets[0]).state).toBe('blocked')
 })
 it('expires exactly and never refreshes replayed observations or permits changed proof',async()=>{
  const e=await setup(),c=e.begin(),p=e.proof(c),r=e.checks.report(phone('two'),p),before=e.dump()
  e.advance(c.validUntil-e.now());expect(e.checks.status(studio,e.unit,e.targets[0]).state).toBe('expired');expect(e.checks.report(phone('two'),p)).toEqual(r)
  expect(()=>e.checks.report(phone('two'),{...p,observedAt:e.now()})).toThrow('Immutable');expect(()=>parseTargetInputReceipt(r,e.unit,e.targets[0],e.now())).toThrow();expect(e.dump()).toEqual(before)
  const e2=await setup(),c2=e2.begin(),p2=e2.proof(c2);e2.advance(c2.validUntil-e2.now());const before2=e2.dump();expect(()=>e2.checks.report(phone('two'),p2)).toThrow('expired');expect(e2.dump()).toEqual(before2)
 })
 it('rolls back failed receipt persistence while preserving the original challenge',async()=>{
  const e=await setup(),c=e.begin();e.db.exec("CREATE TRIGGER fail_input BEFORE UPDATE ON managed_target_input_checks BEGIN SELECT RAISE(ABORT,'disk failure'); END;")
  const before=e.dump();expect(()=>e.checks.report(phone('two'),e.proof(c))).toThrow('disk failure');expect(e.dump()).toEqual(before)
 })
 it('retains the exact original receipt across a file-backed database reopen',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'target-input-'));temporary.push(dir);const file=path.join(dir,'authority.db'),e=await setup('unsent',true,file),c=e.begin(),p=e.proof(c),receipt=e.checks.report(phone('two'),p)
  const before=e.db.prepare('SELECT body FROM managed_target_input_checks WHERE id=?').get(c.id).body
  opened.splice(opened.indexOf(e.db),1);e.db.close();const db=new DatabaseSync(file);opened.push(db)
  const sql:any={exec:(q:string,...args:any[])=>({toArray:()=>db.prepare(q).all(...args)})},tx=<T>(work:()=>T):T=>{db.exec('SAVEPOINT reopen');try{const r=work();db.exec('RELEASE reopen');return r}catch(error){db.exec('ROLLBACK TO reopen');db.exec('RELEASE reopen');throw error}}
  const a=new TaskAuthority(sql,tx,()=>new Date(e.now()).toISOString()),checks=new TargetInputAuthority(sql,tx,a,new FallbackPreflightAuthority(sql,tx,a,e.now),e.now)
  expect(checks.status(studio,e.unit,e.targets[0])).toMatchObject({state:'verified_source_only',receipt});expect(checks.report(phone('two'),p)).toEqual(receipt)
  expect(db.prepare('SELECT body FROM managed_target_input_checks WHERE id=?').get(c.id).body).toBe(before)
 })
 it('bounds inventory without pruning history',async()=>{
  const e=await setup();for(let n=0;n<128;n++)e.begin('request_'+n)
  const before=e.dump();expect(()=>e.begin('overflow')).toThrow('inventory');expect(e.dump()).toEqual(before);expect(e.begin('request_0').id).toBe('request_0')
 })
 it('routes strict phone and Studio operations with no-store and workspace fencing',async()=>{
  const e=await setup(),api=new ManagedTaskApi(e.sql,e.tx,e.env,()=>new Date(e.now()).toISOString())
  const call=(body:any,token='t'.repeat(40))=>api.handle(new Request('https://fixture/managed/recovery/target-input',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({schema:TARGET_INPUT_SCHEMA,workspaceId:'workspace',...body})}))
  const begin=await call({action:'begin',id:'via_api',taskId:e.unit.taskId,profileId:'profile'});expect(begin!.status).toBe(200);expect(begin!.headers.get('Cache-Control')).toBe('no-store')
  const c=await begin!.json();expect((await call({action:'report',proof:e.proof(c)}))!.status).toBe(200)
  expect((await call({action:'status',unit:e.unit,target:e.targets[0]},'s'.repeat(40)))!.status).toBe(200)
  for(const body of [{action:'status',unit:e.unit,target:e.targets[0]},{action:'begin',id:'extra',taskId:e.unit.taskId,profileId:'profile',executionAllowed:true},{action:'begin',workspaceId:'foreign',id:'wrong',taskId:e.unit.taskId,profileId:'profile'}])expect((await call(body))!.status).toBe(409)
 })
 it('rejects promoted, mismatched and stale status receipts',async()=>{
  const e=await setup(),c=e.begin();e.checks.report(phone('two'),e.proof(c));const s=e.checks.status(studio,e.unit,e.targets[0])
  expect(parseTargetInputStatus(s,e.unit,e.targets[0],e.now())).toEqual(s)
  for(const patch of [{executionAllowed:true},{portableInputVerified:true},{target:{...e.targets[0],deviceId:'other'}},{checkedAt:e.now()-15000},{receipt:null},{receipt:{...s.receipt!,receivedAt:e.now()+1}}])expect(()=>parseTargetInputStatus({...s,...patch},e.unit,e.targets[0],e.now())).toThrow()
 })
 it('uses one bounded authenticated status request, respects 429 and never retries',async()=>{
  const e=await setup(),s=e.checks.status(studio,e.unit,e.targets[0]);vi.spyOn(Date,'now').mockReturnValue(e.now())
  const pause={beforeSend:vi.fn(async()=>{}),record:vi.fn(async()=>{})};const fetcher=vi.fn(async(_url:any,options:any)=>{expect(JSON.parse(options.body).action).toBe('status');expect(options.redirect).toBe('error');return Response.json(s)})
  vi.stubGlobal('fetch',fetcher);const transport=targetInputStatusTransport('https://fixture.test','workspace','s'.repeat(40),undefined,pause as any)
  expect(await transport(e.unit,e.targets)).toEqual([s]);expect(fetcher).toHaveBeenCalledTimes(1)
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:429,headers:{'Retry-After':'30'}})));await expect(transport(e.unit,e.targets)).rejects.toThrow();expect(pause.record).toHaveBeenCalledWith('30')
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('x'.repeat(16001))));await expect(transport(e.unit,e.targets)).rejects.toThrow('bounds')
 })
 it('rechecks the source after both preflight and source-cache inspection',async()=>{
  const e=await setup();const sources=[{unit:e.unit,pageLabel:'page'},{unit:{...e.unit,generation:2},pageLabel:'page'}]
  const bridge=new FallbackPreflightBridge({resolve:async()=>sources.shift()!,call:async()=>e.inspect(),sourceChecks:async()=>[e.checks.status(studio,e.unit,e.targets[0])],now:e.now})
  await expect(bridge.inspect({targets:e.targets})).rejects.toThrow('changed')
 })
})
