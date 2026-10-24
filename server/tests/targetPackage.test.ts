import {targetPackageStatusTransport} from '../src/services/targetPackageBridge.js'
import {readFileSync} from 'node:fs'
import {TargetPackageAuthority} from '../../relay/src/targetPackage.js'
import {TARGET_PACKAGE_SCHEMA,packageHash,targetPackagePrompt,verifyTargetPackage,parseTargetPackageStatus} from '../src/services/targetPackageProtocol.js'
const fixture=JSON.parse(readFileSync(new URL('./fixtures/target-package.json',import.meta.url),'utf8'))
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
const CAPS=['target-package-check/1','target-source-check/1','managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','account-audit/1','account-selection/1']
const spec=fixture.original.spec
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
 const task=await a.plan(studio,event(),fixture.original.scope,spec),claim=a.claim(studio,event(),task.id,'one','profile',null)
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
 const packages=new TargetPackageAuthority(sql,tx,a,checks,()=>now)
 const prepare=async(id='package_check')=>{
  const source=begin('source_check');checks.report(phone('two'),proof(source));const challenge=packages.begin(phone('two'),id,source.id)
  const m=structuredClone(fixture.proof.manifest),title='Managed '+unit.attemptId,slug=title.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,40)
  m.source.series_title=title;m.source.series_slug=slug;m.job_id=slug.replace(/[^a-z0-9._]+/g,'-')+'-ch001-page-'+source.sourceSha256.slice(0,12);m.created_at=new Date(now-1).toISOString();m.verification.verified_at=m.created_at
  delete m.manifest_sha256;m.manifest_sha256=await packageHash(JSON.stringify(m))
  const p={id,sourceCheckId:source.id,observedAt:now,manifest:m,promptSha256:await packageHash(targetPackagePrompt(m)),attachmentBytes:fixture.proof.attachmentBytes}
  return {source,challenge,p}
 }
 return {a,db,sql,tx,unit,targets,env,authority,inspect,call,dump,mutate,event,now:()=>now,advance:(ms:number)=>now+=ms,claim,checks,begin,proof,packages,prepare}
}


describe('exact offline target package contract and authority',()=>{
 it('matches the independent native fixture, exact manifest and prompt',async()=>{
  const f=fixture,verified=await verifyTargetPackage(f.proof,'original',f.original.sourceSha256,f.original.scope.pageId,f.original.scope,4700)
  expect(verified.promptSha256).toBe(f.receipt.promptSha256);expect(targetPackagePrompt(f.proof.manifest)).toBe(f.prompt);expect(verified.source).toEqual(f.receipt.source)
 })
 it.each(['prompt','order','geometry','hash','filename','source','identity','whole_page','extra','bytes','timestamp'])('rejects changed %s evidence',async kind=>{
  const f=structuredClone(fixture),p=f.proof,m=p.manifest
  if(kind==='prompt')p.promptSha256='f'.repeat(64)
  if(kind==='order')m.slices.reverse()
  if(kind==='geometry')m.slices[1].y0++
  if(kind==='hash')m.manifest_sha256='f'.repeat(64)
  if(kind==='filename')m.source.original_filename='other.png'
  if(kind==='source')m.source.sha256='b'.repeat(64)
  if(kind==='identity')m.source.series_title='Foreign'
  if(kind==='whole_page')m.slicing.mode='whole_page'
  if(kind==='extra')p.executionAllowed=true
  if(kind==='bytes')p.attachmentBytes=[64000001,1]
  if(kind==='timestamp')m.created_at=new Date(5000).toISOString()
  await expect(verifyTargetPackage(p,'original',f.original.sourceSha256,f.original.scope.pageId,f.original.scope,4700)).rejects.toThrow()
 })
 it('records only its candidate evidence, replays exactly and keeps every execution blocker',async()=>{
  const e=await setup(),{challenge,p}=await e.prepare(),before=e.dump(),r=await e.packages.report(phone('two'),p)
  expect(r).toMatchObject({id:p.id,manifestSha256:p.manifest.manifest_sha256,promptSha256:p.promptSha256,packageVerified:true,contextVerified:false,portableInputVerified:false,executionAllowed:false,handoffAllowed:false,resendAllowed:false})
  expect(e.dump().filter(([name]:any)=>name!=='managed_target_package_checks')).toEqual(before.filter(([name]:any)=>name!=='managed_target_package_checks'))
  const after=e.dump();expect(await e.packages.report(phone('two'),p)).toEqual(r);expect(e.dump()).toEqual(after)
  expect(e.packages.status(studio,e.unit,e.targets[0])).toMatchObject({state:'verified_package_only',receipt:r});expect(e.dump()).toEqual(after)
  expect(e.inspect().executionBlockers).toContain('portable_target_input_not_verified');expect(r.validUntil).toBe(challenge.validUntil)
 })
 it('requires acknowledged source evidence, exact target authentication and capability',async()=>{
  const e=await setup(),before=e.dump();expect(()=>e.packages.begin(phone('two'),'package_check','missing')).toThrow();expect(()=>e.packages.begin(studio,'package_check','missing')).toThrow();expect(e.dump()).toEqual(before)
  const {p}=await e.prepare();await expect(e.packages.report(phone('one'),p)).rejects.toThrow();expect(()=>e.packages.status(phone('two'),e.unit,e.targets[0])).toThrow()
  e.mutate('managed_peers','two',r=>{r.capabilities=r.capabilities.filter((v:string)=>v!=='target-package-check/1')});await expect(e.packages.report(phone('two'),p)).rejects.toThrow('Compatible')
 })
 it.each(['policy','account','reservation','stop','unknown','quota'])('holds changed %s authority without a receipt',async kind=>{
  const e=await setup(),{p}=await e.prepare()
  if(kind==='policy')e.mutate('managed_account_policies','crop_json',r=>{r.revision++})
  if(kind==='account')e.mutate('managed_account_profiles','two/profile',r=>{r.observation.sites.chatgpt.login='signed_out'})
  if(kind==='reservation')e.db.prepare('INSERT INTO managed_reservations (resource,attempt_id) VALUES (?,?)').run('device:two','other')
  if(kind==='stop')e.mutate('managed_attempts',e.unit.attemptId,r=>{r.activeCommandId='other'})
  if(kind==='unknown')e.mutate('managed_attempts',e.unit.attemptId,r=>{r.submission='unknown'})
  if(kind==='quota')e.db.prepare("DELETE FROM managed_account_quotas WHERE json_extract(body,'$.accountId')='alternative'").run()
  const before=e.dump();await expect(e.packages.report(phone('two'),p)).rejects.toThrow();expect(e.dump()).toEqual(before);expect(e.packages.status(studio,e.unit,e.targets[0]).state).toBe('blocked')
 })
 it('rechecks after asynchronous hashing and refuses refreshed or mismatched observations',async()=>{
  const e=await setup(),{p}=await e.prepare(),pending=e.packages.report(phone('two'),p)
  e.db.prepare('INSERT INTO managed_reservations (resource,attempt_id) VALUES (?,?)').run('browser:two','other');const before=e.dump();await expect(pending).rejects.toThrow();expect(e.dump()).toEqual(before)
  const other=await setup(),v=await other.prepare();await expect(other.packages.report(phone('two'),{...v.p,sourceCheckId:'foreign'})).rejects.toThrow();await expect(other.packages.report(phone('two'),{...v.p,observedAt:other.now()+1})).rejects.toThrow()
 })
 it('keeps historical receipt times and rejects expiry or changed proof',async()=>{
  const e=await setup(),{p,challenge}=await e.prepare(),r=await e.packages.report(phone('two'),p),before=e.dump();e.advance(challenge.validUntil-e.now())
  expect(e.packages.status(studio,e.unit,e.targets[0]).state).toBe('expired');expect(await e.packages.report(phone('two'),p)).toEqual(r);await expect(e.packages.report(phone('two'),{...p,promptSha256:'f'.repeat(64)})).rejects.toThrow('Immutable');expect(e.dump()).toEqual(before)
  const e2=await setup(),v=await e2.prepare();e2.advance(15000);await expect(e2.packages.report(phone('two'),v.p)).rejects.toThrow('expired')
 })
 it('rolls back receipt write failure and retains the challenge',async()=>{
  const e=await setup(),{p}=await e.prepare();e.db.exec("CREATE TRIGGER fail_package BEFORE UPDATE ON managed_target_package_checks BEGIN SELECT RAISE(ABORT,'disk failure'); END;")
  const before=e.dump();await expect(e.packages.report(phone('two'),p)).rejects.toThrow('disk failure');expect(e.dump()).toEqual(before)
 })
 it('bounds inventory and preserves idempotent original challenge identity',async()=>{
  const e=await setup(),{source,challenge}=await e.prepare();expect(e.packages.begin(phone('two'),challenge.id,source.id)).toEqual(challenge)
  for(let i=1;i<128;i++)e.packages.begin(phone('two'),'package_'+i,source.id)
  const before=e.dump();expect(()=>e.packages.begin(phone('two'),'overflow',source.id)).toThrow('inventory');expect(e.dump()).toEqual(before)
 })
 it('retains exact receipts across a file-backed database reopen',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'target-package-'));temporary.push(dir);const file=path.join(dir,'authority.db'),e=await setup('unsent',true,file),{p}=await e.prepare(),receipt=await e.packages.report(phone('two'),p),before=e.db.prepare('SELECT body FROM managed_target_package_checks WHERE id=?').get(p.id).body
  opened.splice(opened.indexOf(e.db),1);e.db.close();const db=new DatabaseSync(file);opened.push(db)
  const sql:any={exec:(q:string,...args:any[])=>({toArray:()=>db.prepare(q).all(...args)})},tx=<T>(work:()=>T):T=>{db.exec('SAVEPOINT reopen');try{const r=work();db.exec('RELEASE reopen');return r}catch(error){db.exec('ROLLBACK TO reopen');db.exec('RELEASE reopen');throw error}}
  const a=new TaskAuthority(sql,tx,()=>new Date(e.now()).toISOString()),source=new TargetInputAuthority(sql,tx,a,new FallbackPreflightAuthority(sql,tx,a,e.now),e.now),checks=new TargetPackageAuthority(sql,tx,a,source,e.now)
  expect(checks.status(studio,e.unit,e.targets[0])).toMatchObject({state:'verified_package_only',receipt});expect(await checks.report(phone('two'),p)).toEqual(receipt)
  expect(db.prepare('SELECT body FROM managed_target_package_checks WHERE id=?').get(p.id).body).toBe(before)
 })
 it('uses a single bounded Studio status request and preserves budget pauses',async()=>{
  const e=await setup(),s=e.packages.status(studio,e.unit,e.targets[0]);vi.spyOn(Date,'now').mockReturnValue(e.now())
  const pause={beforeSend:vi.fn(async()=>{}),record:vi.fn(async()=>{})},fetcher=vi.fn(async(_url:any,options:any)=>{expect(options.redirect).toBe('error');expect(JSON.parse(options.body)).toMatchObject({schema:TARGET_PACKAGE_SCHEMA,action:'status',target:e.targets[0]});return Response.json(s)})
  vi.stubGlobal('fetch',fetcher);const call=targetPackageStatusTransport('https://fixture.test','workspace','s'.repeat(40),undefined,pause as any)
  expect(await call(e.unit,e.targets)).toEqual([s]);expect(fetcher).toHaveBeenCalledTimes(1)
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:429,headers:{'Retry-After':'30'}})));await expect(call(e.unit,e.targets)).rejects.toThrow();expect(pause.record).toHaveBeenCalledWith('30')
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('x'.repeat(16001))));await expect(call(e.unit,e.targets)).rejects.toThrow('bounds')
 })
 it('strictly decodes package-only status and rejects promoted permissions or future evidence',async()=>{
  const e=await setup(),{p}=await e.prepare();await e.packages.report(phone('two'),p);const s=e.packages.status(studio,e.unit,e.targets[0])
  expect(parseTargetPackageStatus(s,e.unit,e.targets[0],e.now())).toEqual(s)
  for(const patch of [{executionAllowed:true},{contextVerified:true},{portableInputVerified:true},{receipt:null},{receipt:{...s.receipt,receivedAt:e.now()+1}},{unit:{...e.unit,generation:2}}])expect(()=>parseTargetPackageStatus({...s,...patch},e.unit,e.targets[0],e.now())).toThrow()
 })
 it('routes bounded authenticated package operations with no-store and exact workspace',async()=>{
  const e=await setup(),{p}=await e.prepare(),api=new ManagedTaskApi(e.sql,e.tx,e.env,()=>new Date(e.now()).toISOString())
  const call=(body:any,token='t'.repeat(40))=>api.handle(new Request('https://fixture/managed/recovery/target-package',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({schema:TARGET_PACKAGE_SCHEMA,workspaceId:'workspace',...body})}))
  expect((await call({action:'report',proof:p}))!.status).toBe(200)
  const response=await call({action:'status',unit:e.unit,target:e.targets[0]},'s'.repeat(40));expect(response!.status).toBe(200);expect(response!.headers.get('Cache-Control')).toBe('no-store')
  expect((await call({action:'status',unit:e.unit,target:e.targets[0]}))!.status).toBe(409);expect((await call({action:'begin',id:'extra',sourceCheckId:'source_check',executionAllowed:true}))!.status).toBe(409)
 })
 it('requires the actual current Studio source to match before displaying package verification',async()=>{
  const e=await setup(),{p}=await e.prepare();await e.packages.report(phone('two'),p);const packageStatus=e.packages.status(studio,e.unit,e.targets[0]),source=packageStatus.receipt.source
  const bridge=(actual:any)=>new FallbackPreflightBridge({resolve:async()=>({unit:e.unit,pageLabel:'page.png',source:actual}),call:async()=>e.inspect(),packageChecks:async()=>[packageStatus],now:e.now})
  expect((await bridge(source).inspect({targets:e.targets})).targetPackageChecks[0].state).toBe('verified_package_only')
  await expect(bridge({...source,height:source.height+1}).inspect({targets:e.targets})).rejects.toThrow('actual Studio source')
 })
})
