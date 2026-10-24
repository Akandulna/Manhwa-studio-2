import {TargetContextAuthority} from '../../relay/src/targetContext.js'
import {TARGET_CONTEXT_SCHEMA,CONTEXT_CONFIRMATION,parseContextStatus} from '../src/services/targetContextProtocol.js'
import {TargetContextStudioBridge,targetContextTransport} from '../src/services/targetContextBridge.js'
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
const CAPS=['target-standalone-context/1','target-package-check/1','target-source-check/1','managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','account-audit/1','account-selection/1']
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
 const contexts=new TargetContextAuthority(sql,tx,a,packages,()=>now)
 const prepareContext=async()=>{
  const v=await prepare(),receipt=await packages.report(phone('two'),v.p)
  const review=contexts.review(studio,'review',unit,targets[0],v.p.id,CONTEXT_CONFIRMATION),challenge=contexts.begin(phone('two'),'context_check',v.p.id)
  const contextProof={id:challenge.id,reviewId:review.id,packageId:v.p.id,bindingId:'target_view',observedAt:now,accountObservationAt:now,sourceSha256:receipt.source.sha256,manifestSha256:receipt.manifestSha256,promptSha256:receipt.promptSha256,session:{documentKind:'chatgpt_home',ready:true,composer:'empty',attachments:'none',response:'none',login:'unknown',overlay:'none',composerAccessible:true}}
  return {...v,receipt,review,contextChallenge:challenge,contextProof}
 }
 return {a,db,sql,tx,unit,targets,env,authority,inspect,call,dump,mutate,event,now:()=>now,advance:(ms:number)=>now+=ms,claim,checks,begin,proof,packages,prepare,contexts,prepareContext}
}



describe('reviewed standalone target context',()=>{
 it('requires an explicit exact review, preserves it and verifies only the declared scope',async()=>{
  const e=await setup(),before=e.dump(),v=await e.prepareContext(),r=e.contexts.report(phone('two'),v.contextProof)
  expect(r).toMatchObject({declaredContextVerified:true,contextScope:'reviewed-standalone-page/1',reviewId:'review',bindingId:'target_view',executionAllowed:false,handoffAllowed:false,resendAllowed:false,viewAdoptionAllowed:false,portableInputVerified:false})
  const after=e.dump();expect(e.contexts.report(phone('two'),v.contextProof)).toEqual(r);expect(e.dump()).toEqual(after)
  expect(e.contexts.status(studio,e.unit,e.targets[0])).toMatchObject({state:'verified_declared_context',receipt:r});expect(e.dump()).toEqual(after)
  for(const table of ['managed_tasks','managed_attempts','managed_commands','managed_reservations','managed_account_profiles','managed_events'])expect(after.find(([name]:any)=>name===table)).toEqual(before.find(([name]:any)=>name===table))
  expect(e.inspect().executionBlockers).toContain('portable_target_input_not_verified');expect(JSON.stringify(r)).not.toMatch(/email|Bearer|candidate|example.com/)
 })
 it('never infers a standalone requirement from a package, empty page or policy alone',async()=>{
  const e=await setup(),v=await e.prepare();await e.packages.report(phone('two'),v.p);const before=e.dump()
  expect(e.contexts.status(studio,e.unit,e.targets[0]).state).toBe('unreviewed')
  expect(()=>e.contexts.begin(phone('two'),'context',v.p.id)).toThrow('Review')
  for(const confirmation of ['',true,'none','Earlier conversation is required'])expect(()=>e.contexts.review(studio,'review',e.unit,e.targets[0],v.p.id,confirmation)).toThrow()
  expect(e.dump()).toEqual(before)
 })
 it('fences reviewers, target principals, selected units and candidates',async()=>{
  const e=await setup(),v=await e.prepareContext(),before=e.dump()
  expect(()=>e.contexts.review(phone('two'),'foreign',e.unit,e.targets[0],v.p.id,CONTEXT_CONFIRMATION)).toThrow()
  expect(()=>e.contexts.review(studio,'foreign',{...e.unit,workspaceId:'other'},e.targets[0],v.p.id,CONTEXT_CONFIRMATION)).toThrow()
  expect(()=>e.contexts.begin(phone('one'),'foreign',v.p.id)).toThrow();expect(()=>e.contexts.status(phone('two'),e.unit,e.targets[0])).toThrow();expect(()=>e.contexts.report(phone('one'),v.contextProof)).toThrow()
  expect(()=>e.contexts.withdraw(studio,'review',{...e.unit,workspaceId:'other'},e.targets[0])).toThrow();expect(e.dump()).toEqual(before)
 })
 it.each(['draft','attachment','conversation','overlay','covered','response','login','extra'])('refuses %s context samples',async kind=>{
  const e=await setup(),v=await e.prepareContext(),p=structuredClone(v.contextProof)
  if(kind==='draft')p.session.composer='nonempty';if(kind==='attachment')p.session.attachments='present';if(kind==='conversation')p.session.documentKind='chatgpt_conversation';if(kind==='overlay')p.session.overlay='present';if(kind==='covered')p.session.composerAccessible=false;if(kind==='response')p.session.response='active';if(kind==='login')p.session.login='signed_out';if(kind==='extra')(p.session as any).rawText='private'
  const before=e.dump();expect(()=>e.contexts.report(phone('two'),p)).toThrow();expect(e.dump()).toEqual(before)
 })
 it.each(['package','digest','review','account_time','future','capability','reservation','quota','policy','account'])('holds changed %s evidence',async kind=>{
  const e=await setup(),v=await e.prepareContext(),p={...v.contextProof}
  if(kind==='package')p.packageId='other';if(kind==='digest')p.manifestSha256='f'.repeat(64);if(kind==='review')p.reviewId='other';if(kind==='account_time')p.accountObservationAt--;if(kind==='future')p.observedAt++
  if(kind==='capability')e.mutate('managed_peers','two',r=>{r.capabilities=r.capabilities.filter((c:string)=>c!=='target-standalone-context/1')})
  if(kind==='reservation')e.db.prepare('INSERT INTO managed_reservations (resource,attempt_id) VALUES (?,?)').run('browser:two','other')
  if(kind==='quota')e.db.prepare("DELETE FROM managed_account_quotas WHERE json_extract(body,'$.accountId')='alternative'").run()
  if(kind==='policy')e.mutate('managed_account_policies','crop_json',r=>{r.revision++})
  if(kind==='account')e.mutate('managed_account_profiles','two/profile',r=>{r.links.chatgpt.accountId='other'})
  const before=e.dump();expect(()=>e.contexts.report(phone('two'),p)).toThrow();expect(e.dump()).toEqual(before)
 })
 it('withdraws requirements without deleting proof, refreshing time or resurrecting an older review',async()=>{
  const e=await setup(),v=await e.prepareContext(),r=e.contexts.report(phone('two'),v.contextProof),withdrawn=e.contexts.withdraw(studio,v.review.id,e.unit,e.targets[0]),before=e.dump()
  expect(withdrawn.withdrawnAt).toBe(e.now());expect(e.contexts.withdraw(studio,v.review.id,e.unit,e.targets[0])).toEqual(withdrawn)
  expect(e.contexts.report(phone('two'),v.contextProof)).toEqual(r);expect(e.contexts.status(studio,e.unit,e.targets[0]).state).toBe('withdrawn');expect(()=>e.contexts.begin(phone('two'),'new',v.p.id)).toThrow()
  expect(e.contexts.review(studio,v.review.id,e.unit,e.targets[0],v.p.id,CONTEXT_CONFIRMATION).withdrawnAt).toBe(e.now());expect(e.dump()).toEqual(before)
 })
 it('holds in-flight checks when requirements are withdrawn or superseded',async()=>{
  for(const kind of ['withdraw','supersede']){
   const e=await setup(),v=await e.prepareContext()
   if(kind==='withdraw')e.contexts.withdraw(studio,v.review.id,e.unit,e.targets[0]);else e.contexts.review(studio,'new_review',e.unit,e.targets[0],v.p.id,CONTEXT_CONFIRMATION)
   const before=e.dump();expect(()=>e.contexts.report(phone('two'),v.contextProof)).toThrow();expect(e.dump()).toEqual(before)
  }
 })
 it('preserves exact historical receipt replay after expiry without creating fresh readiness',async()=>{
  const e=await setup(),v=await e.prepareContext(),r=e.contexts.report(phone('two'),v.contextProof),before=e.dump();e.advance(15000)
  expect(e.contexts.report(phone('two'),v.contextProof)).toEqual(r);expect(e.contexts.status(studio,e.unit,e.targets[0]).state).toBe('expired');expect(()=>e.contexts.report(phone('two'),{...v.contextProof,bindingId:'other'})).toThrow('Immutable');expect(e.dump()).toEqual(before)
  const e2=await setup(),v2=await e2.prepareContext();e2.advance(15000);expect(()=>e2.contexts.report(phone('two'),v2.contextProof)).toThrow()
 })
 it('rolls back receipt persistence failure and retains original intent',async()=>{
  const e=await setup(),v=await e.prepareContext();e.db.exec("CREATE TRIGGER fail_context BEFORE UPDATE ON managed_target_context_checks BEGIN SELECT RAISE(ABORT,'disk failure'); END;")
  const before=e.dump();expect(()=>e.contexts.report(phone('two'),v.contextProof)).toThrow('disk failure');expect(e.dump()).toEqual(before)
 })
 it('bounds both review and check inventories without pruning evidence',async()=>{
  const e=await setup(),v=await e.prepareContext()
  for(let i=1;i<128;i++)e.contexts.begin(phone('two'),'context_'+i,v.p.id)
  expect(()=>e.contexts.begin(phone('two'),'overflow',v.p.id)).toThrow('inventory')
  for(let i=1;i<128;i++)e.contexts.review(studio,'review_'+i,e.unit,e.targets[0],v.p.id,CONTEXT_CONFIRMATION)
  const before=e.dump();expect(()=>e.contexts.review(studio,'overflow',e.unit,e.targets[0],v.p.id,CONTEXT_CONFIRMATION)).toThrow('inventory');expect(e.dump()).toEqual(before)
 })
 it('retains exact reviews and proof across a file-backed authority reopen',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'target-context-'));temporary.push(dir);const file=path.join(dir,'authority.db'),e=await setup('unsent',true,file),v=await e.prepareContext(),receipt=e.contexts.report(phone('two'),v.contextProof),before=e.db.prepare('SELECT body FROM managed_target_context_checks WHERE id=?').get(v.contextProof.id).body
  opened.splice(opened.indexOf(e.db),1);e.db.close();const db=new DatabaseSync(file);opened.push(db)
  const sql:any={exec:(q:string,...args:any[])=>({toArray:()=>db.prepare(q).all(...args)})},tx=<T>(work:()=>T):T=>{db.exec('SAVEPOINT reopen');try{const r=work();db.exec('RELEASE reopen');return r}catch(error){db.exec('ROLLBACK TO reopen');db.exec('RELEASE reopen');throw error}}
  const a=new TaskAuthority(sql,tx,()=>new Date(e.now()).toISOString()),source=new TargetInputAuthority(sql,tx,a,new FallbackPreflightAuthority(sql,tx,a,e.now),e.now),packages=new TargetPackageAuthority(sql,tx,a,source,e.now),checks=new TargetContextAuthority(sql,tx,a,packages,e.now)
  expect(checks.status(studio,e.unit,e.targets[0])).toMatchObject({state:'verified_declared_context',receipt});expect(checks.report(phone('two'),v.contextProof)).toEqual(receipt);expect(db.prepare('SELECT body FROM managed_target_context_checks WHERE id=?').get(v.contextProof.id).body).toBe(before)
 })
 it('rejects promoted, foreign, future and inconsistent context statuses',async()=>{
  const e=await setup(),v=await e.prepareContext();e.contexts.report(phone('two'),v.contextProof);const s=e.contexts.status(studio,e.unit,e.targets[0]);expect(parseContextStatus(s,e.unit,e.targets[0],e.now())).toEqual(s)
  for(const patch of [{executionAllowed:true},{viewAdoptionAllowed:true},{portableInputVerified:true},{receipt:null},{review:null},{receipt:{...s.receipt,receivedAt:e.now()+1}},{state:'unreviewed'}])expect(()=>parseContextStatus({...s,...patch},e.unit,e.targets[0],e.now())).toThrow()
 })
 it('routes exact Studio review and phone proof roles without changing original authority',async()=>{
  const e=await setup(),v=await e.prepareContext(),api=new ManagedTaskApi(e.sql,e.tx,e.env,()=>new Date(e.now()).toISOString())
  const call=(body:any,token='t'.repeat(40))=>api.handle(new Request('https://fixture/managed/recovery/target-context',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({schema:TARGET_CONTEXT_SCHEMA,workspaceId:'workspace',...body})}))
  expect((await call({action:'report',proof:v.contextProof}))!.status).toBe(200)
  expect((await call({action:'review',id:'review2',unit:e.unit,target:e.targets[0],packageId:v.p.id,confirmation:CONTEXT_CONFIRMATION}))!.status).toBe(409)
  const status=await call({action:'status',unit:e.unit,target:e.targets[0]},'s'.repeat(40));expect(status!.status).toBe(200);expect(status!.headers.get('Cache-Control')).toBe('no-store')
  expect((await call({action:'withdraw',id:v.review.id,unit:{...e.unit,workspaceId:'other'},target:e.targets[0]},'s'.repeat(40)))!.status).toBe(409)
 })
 it('checks real source and selected unit before reviewing requirements and rechecks afterward',async()=>{
  const e=await setup(),v=await e.prepare(),receipt=await e.packages.report(phone('two'),v.p);let calls=0
  const source=receipt.source,call=async(op:any)=>{calls++;if(op.action==='review')return e.contexts.review(studio,op.id,op.unit,op.target,op.packageId,op.confirmation);return e.contexts.status(studio,op.unit,op.target)}
  const bridge=(actual:any)=>new TargetContextStudioBridge({resolve:async()=>({unit:e.unit,source:actual}),packages:async()=>[e.packages.status(studio,e.unit,e.targets[0])],call,now:e.now})
  const op={action:'review',id:'bridge_review',unit:e.unit,target:e.targets[0],packageId:v.p.id,confirmation:CONTEXT_CONFIRMATION}
  await expect(bridge({...source,width:source.width+1}).perform(op)).rejects.toThrow('actual source');expect(calls).toBe(0)
  expect((await bridge(source).perform(op)).state).toBe('awaiting_target')
  const sources=[{unit:e.unit,source},{unit:{...e.unit,generation:2},source}],changed=new TargetContextStudioBridge({resolve:async()=>sources.shift()!,packages:async()=>[e.packages.status(studio,e.unit,e.targets[0])],call,now:e.now})
  await expect(changed.perform({...op,id:'bridge_changed'})).rejects.toThrow('Source changed')
 })
 it('uses one bounded authenticated transport call with no retries and retained 429 pause',async()=>{
  const e=await setup(),pause={beforeSend:vi.fn(async()=>{}),record:vi.fn(async()=>{})},fetcher=vi.fn(async(_url:any,options:any)=>{expect(options.redirect).toBe('error');expect(JSON.parse(options.body).workspaceId).toBe('workspace');return Response.json(e.contexts.status(studio,e.unit,e.targets[0]))})
  vi.stubGlobal('fetch',fetcher);const call=targetContextTransport('https://fixture.test','workspace','s'.repeat(40),undefined,pause as any)
  await call({action:'status',unit:e.unit,target:e.targets[0]});expect(fetcher).toHaveBeenCalledTimes(1)
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:429,headers:{'Retry-After':'30'}})));await expect(call({action:'status'})).rejects.toThrow();expect(pause.record).toHaveBeenCalledWith('30')
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('x'.repeat(16001))));await expect(call({action:'status'})).rejects.toThrow('bounds')
 })
})
