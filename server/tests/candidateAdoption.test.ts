import {CandidateAdoptionStudioBridge,candidateAdoptionTransport} from '../src/services/candidateAdoptionBridge.js'
import {CandidateAdoptionAuthority} from '../../relay/src/candidateAdoption.js'
import {CANDIDATE_ADOPTION_SCHEMA,ADOPTION_CONFIRMATION,parseAdoptionStatus} from '../src/services/candidateAdoptionProtocol.js'
import {sharedRecoveryBudget,assertRecoveryReservation,assertRecoveryControls} from '../../relay/src/recoveryBudget.js'
import {RecoveryStops} from '../../relay/src/recoveryStops.js'
import {AccountRecheckRecovery} from '../../relay/src/accountRecheckRecovery.js'
import {recoveryUnitKey} from '../src/services/automationRecoveryPolicy.js'
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
const CAPS=['target-candidate-retention/1','target-standalone-context/1','target-package-check/1','target-source-check/1','managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','account-audit/1','account-selection/1']
const spec=fixture.original.spec
async function setup(outcome='unsent',released=true,file=':memory:',initialEnabled=true){
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
 let enabled=initialEnabled
 const adoption=new CandidateAdoptionAuthority(sql,tx,a,contexts,()=>enabled,()=>now)
 const prepareAdoption=async()=>{
  const v=await prepareContext(),context=contexts.report(phone('two'),v.contextProof)
  const approval={actionId:'adopt_one',contextId:context.id,revision:0,confirmation:ADOPTION_CONFIRMATION}
  return {...v,context,approval}
 }
 const nativeReceipt=(action:any)=>({schema:'candidate-adoption-local-receipt/1',actionId:action.id,contextId:action.context.id,packageId:action.context.packageId,reviewId:action.context.reviewId,bindingId:action.context.bindingId,sourceSha256:action.context.source.sha256,manifestSha256:action.context.manifestSha256,promptSha256:action.context.promptSha256,adoptedAt:now,permitIssuedAt:action.permit.issuedAt,permitValidUntil:action.permit.validUntil})
 const seedOther=(ids:string[],phase='safe_failure',cooldown=0)=>{
  const r={schema:'saved-crop-import-recovery/1',fence:{...unit,artifactId:'saved_original',sha256:'a'.repeat(64)},destinationId:'b'.repeat(64),revision:1,enabled:true,paused:false,cancelled:false,nextEligibleAt:cooldown,actions:ids.map(id=>({id,phase,at:now,finishedAt:['reserved','executing'].includes(phase)?null:now,evidenceRef:['reserved','executing'].includes(phase)?null:'evidence/'+id}))}
  db.prepare('INSERT INTO managed_recovery_episodes (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(recoveryUnitKey(unit),JSON.stringify(r))
 }
 const stopRecovery=(mode:'pause'|'cancel'|'disable'|'reinspect',sequence=1)=>new RecoveryStops(sql,tx,a,new AccountRecheckRecovery(sql,tx,a,()=>now),()=>now).apply(studio,{schema:'recovery-stop/1',unit,eventId:event(),sequence,mode})
 return {a,db,sql,tx,unit,targets,env,authority,inspect,call,dump,mutate,event,now:()=>now,advance:(ms:number)=>now+=ms,claim,checks,begin,proof,packages,prepare,contexts,prepareContext,adoption,prepareAdoption,nativeReceipt,seedOther,stopRecovery,setEnabled:(v:boolean)=>enabled=v}
}




describe('separate one-use candidate retention approval',()=>{
 it('charges the original shared budget once and retains exact candidate custody only',async()=>{
  const e=await setup(),v=await e.prepareAdoption(),before=e.dump(),approved=e.adoption.approve(studio,e.unit,e.targets[0],v.approval)
  expect(approved.action.phase).toBe('reserved');expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:1,pending:true});expect(()=>assertRecoveryReservation(e.sql,e.unit,'other',e.now())).toThrow('reconciliation')
  expect(e.adoption.approve(studio,e.unit,e.targets[0],v.approval)).toEqual(approved)
  const start=e.adoption.start(phone('two'),e.unit,'adopt_one','start_one',v.contextProof);expect(start.permit).toBeNull();expect(start.action.phase).toBe('executing')
  const checked=e.adoption.check(phone('two'),e.unit,'adopt_one',v.contextProof);expect(checked.permit.localCandidateAdoptionAllowed).toBe(true)
  expect(checked.permit).toMatchObject({executionAllowed:false,handoffAllowed:false,resendAllowed:false,viewAdoptionAllowed:false,ownershipChanged:false})
  const native=e.nativeReceipt(checked.action),finished=e.adoption.finish(phone('two'),e.unit,'adopt_one',native),after=e.dump()
  expect(finished.action.phase).toBe('verified');expect(e.adoption.finish(phone('two'),e.unit,'adopt_one',native)).toEqual(finished);expect(e.dump()).toEqual(after)
  expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:1,pending:false});expect(e.inspect().executionBlockers).toContain('account_handoff_executor_not_enrolled')
  for(const table of ['managed_tasks','managed_attempts','managed_commands','managed_reservations','managed_account_profiles','managed_events'])expect(after.find(([name]:any)=>name===table)).toEqual(before.find(([name]:any)=>name===table))
 })
 it('continues the charged third action without concealing an exhausted or pending budget',async()=>{
  const e=await setup(),v=await e.prepareAdoption();e.seedOther(['one','two'])
  e.adoption.approve(studio,e.unit,e.targets[0],v.approval);expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:3,pending:true,exhausted:true})
  const ordinary=e.inspect();expect(ordinary.source.reasons).toContain('shared_recovery_pending');expect(ordinary.source.reasons).toContain('shared_budget_exhausted')
  e.adoption.start(phone('two'),e.unit,'adopt_one','start_one',v.contextProof);const checked=e.adoption.check(phone('two'),e.unit,'adopt_one',v.contextProof)
  e.adoption.finish(phone('two'),e.unit,'adopt_one',e.nativeReceipt(checked.action));expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:3,pending:false,exhausted:true});expect(()=>assertRecoveryReservation(e.sql,e.unit,'fourth',e.now())).toThrow('exhausted')
 })
 it.each(['pending','exhausted','cooldown','duplicate'])('cannot reserve across existing %s history',async kind=>{
  const e=await setup(),v=await e.prepareAdoption()
  if(kind==='pending')e.seedOther(['prior'],'unknown');if(kind==='exhausted')e.seedOther(['one','two','three']);if(kind==='cooldown')e.seedOther(['prior'],'safe_failure',e.now()+30000);if(kind==='duplicate')e.seedOther(['adopt_one'])
  const before=e.dump();expect(()=>e.adoption.approve(studio,e.unit,e.targets[0],v.approval)).toThrow();expect(e.dump()).toEqual(before)
 })
 it('requires explicit Studio approval, exact revision, fresh context and compatible target',async()=>{
  const e=await setup(),v=await e.prepareAdoption(),before=e.dump()
  for(const approval of [{...v.approval,confirmation:''},{...v.approval,revision:1},{...v.approval,contextId:'foreign'}])expect(()=>e.adoption.approve(studio,e.unit,e.targets[0],approval)).toThrow()
  expect(()=>e.adoption.approve(phone('two'),e.unit,e.targets[0],v.approval)).toThrow();expect(()=>e.adoption.approve(studio,{...e.unit,workspaceId:'other'},e.targets[0],v.approval)).toThrow();expect(e.dump()).toEqual(before)
  e.advance(15000);expect(()=>e.adoption.approve(studio,e.unit,e.targets[0],v.approval)).toThrow()
 })
 it.each(['approve','start','check'])('kill switch holds new %s admission',async stage=>{
  const e=await setup(),v=await e.prepareAdoption()
  if(stage!=='approve')e.adoption.approve(studio,e.unit,e.targets[0],v.approval)
  if(stage==='check')e.adoption.start(phone('two'),e.unit,'adopt_one','start_one',v.contextProof)
  e.setEnabled(false);const before=e.dump()
  expect(()=>stage==='approve'?e.adoption.approve(studio,e.unit,e.targets[0],v.approval):stage==='start'?e.adoption.start(phone('two'),e.unit,'adopt_one','start_one',v.contextProof):e.adoption.check(phone('two'),e.unit,'adopt_one',v.contextProof)).toThrow();expect(e.dump()).toEqual(before)
 })
 it.each(['withdraw','supersede','account','reservation','quota','policy','capability','binding','digest','future'])('refuses changed %s before local effect',async kind=>{
  const e=await setup(),v=await e.prepareAdoption();e.adoption.approve(studio,e.unit,e.targets[0],v.approval);e.adoption.start(phone('two'),e.unit,'adopt_one','start_one',v.contextProof)
  const proof={...v.contextProof}
  if(kind==='withdraw')e.contexts.withdraw(studio,v.review.id,e.unit,e.targets[0])
  if(kind==='supersede')e.mutate('managed_target_context_reviews',v.review.id,r=>{r.contextScope='different'})
  if(kind==='account')e.mutate('managed_account_profiles','two/profile',r=>{r.links.chatgpt.accountId='other'})
  if(kind==='reservation')e.db.prepare('INSERT INTO managed_reservations (resource,attempt_id) VALUES (?,?)').run('profile:two:profile','other')
  if(kind==='quota')e.db.prepare("DELETE FROM managed_account_quotas WHERE json_extract(body,'$.accountId')='alternative'").run()
  if(kind==='policy')e.mutate('managed_account_policies','crop_json',r=>{r.revision++})
  if(kind==='capability')e.mutate('managed_peers','two',r=>{r.capabilities=r.capabilities.filter((c:string)=>c!=='target-candidate-retention/1')})
  if(kind==='binding')proof.bindingId='replacement';if(kind==='digest')proof.promptSha256='f'.repeat(64);if(kind==='future')proof.observedAt++
  const before=e.dump();expect(()=>e.adoption.check(phone('two'),e.unit,'adopt_one',proof)).toThrow();expect(e.dump()).toEqual(before)
 })
 it.each(['pause','disable','cancel'] as const)('shares retained %s controls, even after reinspection',async mode=>{
  const e=await setup(),v=await e.prepareAdoption();e.adoption.approve(studio,e.unit,e.targets[0],v.approval);e.stopRecovery(mode)
  expect(()=>assertRecoveryControls(e.sql,e.unit)).toThrow();expect(()=>e.adoption.start(phone('two'),e.unit,'adopt_one','start_one',v.contextProof)).toThrow()
  const r=JSON.parse(e.db.prepare('SELECT body FROM managed_candidate_adoption_episodes').get().body);expect(r.enabled).toBe(false);expect(r.paused).toBe(true)
  if(mode!=='cancel'){e.stopRecovery('reinspect',2);expect(()=>assertRecoveryControls(e.sql,e.unit)).toThrow()}
  expect(sharedRecoveryBudget(e.sql,e.unit).used).toBe(1)
 })
 it('cancels only unused approvals and retains charge/cooldown without silently resuming',async()=>{
  const e=await setup(),v=await e.prepareAdoption();e.adoption.approve(studio,e.unit,e.targets[0],v.approval);const cancelled=e.adoption.cancel(studio,e.unit,e.targets[0],'adopt_one',1)
  expect(cancelled.action.phase).toBe('safe_failure');expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:1,pending:false,nextEligibleAt:e.now()+30000});expect(e.adoption.cancel(studio,e.unit,e.targets[0],'adopt_one',1)).toEqual(cancelled)
  const other=await setup(),ov=await other.prepareAdoption();other.adoption.approve(studio,other.unit,other.targets[0],ov.approval);other.adoption.start(phone('two'),other.unit,'adopt_one','start_one',ov.contextProof);expect(()=>other.adoption.cancel(studio,other.unit,other.targets[0],'adopt_one',2)).toThrow('reconciliation')
 })
 it('never refreshes a consumed effect permit or repeats a completed start',async()=>{
  const e=await setup(),v=await e.prepareAdoption();e.adoption.approve(studio,e.unit,e.targets[0],v.approval);const started=e.adoption.start(phone('two'),e.unit,'adopt_one','start_one',v.contextProof)
  expect(e.adoption.start(phone('two'),e.unit,'adopt_one','start_one',v.contextProof)).toEqual(started)
  const checked=e.adoption.check(phone('two'),e.unit,'adopt_one',v.contextProof);expect(e.adoption.check(phone('two'),e.unit,'adopt_one',v.contextProof).permit).toEqual(checked.permit)
  e.advance(15000);expect(()=>e.adoption.check(phone('two'),e.unit,'adopt_one',v.contextProof)).toThrow();expect(e.adoption.status(studio,e.unit,e.targets[0]).actions[0].permit).toEqual(checked.permit)
 })
 it('preserves unknown effects and acknowledges their original receipt after off/withdrawal/expiry',async()=>{
  const e=await setup(),v=await e.prepareAdoption();e.adoption.approve(studio,e.unit,e.targets[0],v.approval);e.adoption.start(phone('two'),e.unit,'adopt_one','start_one',v.contextProof);const checked=e.adoption.check(phone('two'),e.unit,'adopt_one',v.contextProof),native=e.nativeReceipt(checked.action)
  const unknown=e.adoption.unknown(phone('two'),e.unit,'adopt_one');expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({pending:true,used:1})
  e.contexts.withdraw(studio,v.review.id,e.unit,e.targets[0]);e.setEnabled(false);e.advance(20000)
  const finished=e.adoption.finish(phone('two'),e.unit,'adopt_one',native);expect(finished.action.unknownAt).toBe(unknown.action.unknownAt);expect(finished.action.phase).toBe('verified');expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:1,pending:false})
  expect(()=>e.adoption.start(phone('two'),e.unit,'adopt_one','new_start',v.contextProof)).toThrow();expect(()=>e.adoption.finish(phone('two'),e.unit,'adopt_one',{...native,bindingId:'other'})).toThrow()
 })
 it('does not allow own-action continuation to bypass another unresolved playbook',async()=>{
  const e=await setup(),v=await e.prepareAdoption();e.adoption.approve(studio,e.unit,e.targets[0],v.approval);e.seedOther(['late_unknown'],'unknown');const before=e.dump()
  expect(()=>e.adoption.start(phone('two'),e.unit,'adopt_one','start_one',v.contextProof)).toThrow();expect(e.dump()).toEqual(before)
  expect(()=>e.authority.originalAdoptionContinuation(e.unit,e.targets[0],'not_original')).toThrow()
 })
 it('rolls back failed approval writes without changing budget or original authority',async()=>{
  const e=await setup(),v=await e.prepareAdoption();e.db.exec("CREATE TRIGGER fail_adoption BEFORE INSERT ON managed_candidate_adoption_episodes BEGIN SELECT RAISE(ABORT,'disk failure'); END;")
  const before=e.dump();expect(()=>e.adoption.approve(studio,e.unit,e.targets[0],v.approval)).toThrow('disk failure');expect(e.dump()).toEqual(before);expect(sharedRecoveryBudget(e.sql,e.unit).used).toBe(0)
 })
 it('keeps the charged original action across a file-backed reopen',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'candidate-adoption-'));temporary.push(dir);const file=path.join(dir,'authority.db'),e=await setup('unsent',true,file),v=await e.prepareAdoption();e.adoption.approve(studio,e.unit,e.targets[0],v.approval);e.adoption.start(phone('two'),e.unit,'adopt_one','start_one',v.contextProof);const checked=e.adoption.check(phone('two'),e.unit,'adopt_one',v.contextProof),native=e.nativeReceipt(checked.action),before=e.db.prepare('SELECT body FROM managed_candidate_adoption_episodes').get().body
  opened.splice(opened.indexOf(e.db),1);e.db.close();const db=new DatabaseSync(file);opened.push(db)
  const sql:any={exec:(q:string,...args:any[])=>({toArray:()=>db.prepare(q).all(...args)})},tx=<T>(work:()=>T):T=>{db.exec('SAVEPOINT reopen');try{const r=work();db.exec('RELEASE reopen');return r}catch(error){db.exec('ROLLBACK TO reopen');db.exec('RELEASE reopen');throw error}}
  const a=new TaskAuthority(sql,tx,()=>new Date(e.now()).toISOString()),source=new TargetInputAuthority(sql,tx,a,new FallbackPreflightAuthority(sql,tx,a,e.now),e.now),packages=new TargetPackageAuthority(sql,tx,a,source,e.now),contexts=new TargetContextAuthority(sql,tx,a,packages,e.now),adoption=new CandidateAdoptionAuthority(sql,tx,a,contexts,()=>false,e.now)
  expect(db.prepare('SELECT body FROM managed_candidate_adoption_episodes').get().body).toBe(before);expect(sharedRecoveryBudget(sql,e.unit)).toMatchObject({used:1,pending:true});expect(adoption.finish(phone('two'),e.unit,'adopt_one',native).action.phase).toBe('verified')
 })
 it('checks exact context and actual source around Studio approval and keeps off-state cancellation',async()=>{
  const e=await setup(),v=await e.prepareAdoption();let calls=0
  const call=async(op:any)=>{calls++;if(op.action==='approve')return e.adoption.approve(studio,op.unit,op.target,op.approval);if(op.action==='cancel')return e.adoption.cancel(studio,op.unit,op.target,op.actionId,op.revision);return e.adoption.status(studio,op.unit,op.target)}
  const bridge=(source:any,enabled=true)=>new CandidateAdoptionStudioBridge({resolve:async()=>({unit:e.unit,source}),contexts:async()=>[e.contexts.status(studio,e.unit,e.targets[0])],call,enabled:()=>enabled,now:e.now})
  const op={action:'approve',unit:e.unit,target:e.targets[0],...v.approval}
  await expect(bridge(v.context.source,false).perform(op)).rejects.toThrow('off');await expect(bridge({...v.context.source,width:999}).perform(op)).rejects.toThrow('real source');expect(calls).toBe(0)
  expect((await bridge(v.context.source).perform(op)).budget).toMatchObject({used:1,pending:true})
  expect((await bridge(v.context.source,false).perform({action:'cancel',unit:e.unit,target:e.targets[0],actionId:'adopt_one',revision:1})).actions[0].phase).toBe('safe_failure')
 })
 it('bounds Studio transport, preserves 429 ownership and never retries an approval',async()=>{
  const e=await setup(),v=await e.prepareAdoption(),result=e.adoption.approve(studio,e.unit,e.targets[0],v.approval),pause={beforeSend:vi.fn(async()=>{}),record:vi.fn(async()=>{})},fetcher=vi.fn(async(_url:any,options:any)=>{expect(options.redirect).toBe('error');expect(JSON.parse(options.body).action).toBe('approve');return Response.json(result)})
  vi.stubGlobal('fetch',fetcher);const call=candidateAdoptionTransport('https://fixture.test','workspace','s'.repeat(40),undefined,pause as any)
  await call({action:'approve',unit:e.unit,target:e.targets[0],approval:v.approval});expect(fetcher).toHaveBeenCalledTimes(1)
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:429,headers:{'Retry-After':'30'}})));await expect(call({action:'status'})).rejects.toThrow();expect(pause.record).toHaveBeenCalledWith('30')
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('x'.repeat(64001))));await expect(call({action:'status'})).rejects.toThrow('bounds')
 })
 it('enforces endpoint roles, exact workspace and off defaults without exposing execution permission',async()=>{
  const e=await setup(),v=await e.prepareAdoption(),env={...e.env,MANAGED_CANDIDATE_ADOPTION:'1',MANAGED_AUTOMATIC_RECOVERY:'1'},api=new ManagedTaskApi(e.sql,e.tx,env,()=>new Date(e.now()).toISOString())
  const call=(body:any,token='s'.repeat(40))=>api.handle(new Request('https://fixture/managed/recovery/candidate-adoption',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({schema:CANDIDATE_ADOPTION_SCHEMA,workspaceId:'workspace',unit:e.unit,...body})}))
  expect((await call({action:'approve',target:e.targets[0],approval:v.approval},'t'.repeat(40)))!.status).toBe(409)
  expect((await call({action:'approve',target:e.targets[0],approval:v.approval}))!.status).toBe(200)
  const status=await call({action:'status',target:e.targets[0]},'t'.repeat(40));expect(status!.headers.get('Cache-Control')).toBe('no-store');const value=await status!.json();expect(parseAdoptionStatus(value,e.unit,e.targets[0],e.now()).budget.used).toBe(1)
  expect((await call({action:'start',actionId:'adopt_one',eventId:'start',proof:v.contextProof}))!.status).toBe(409)
  expect((await call({action:'status',unit:{...e.unit,workspaceId:'other'},target:e.targets[0]}))!.status).toBe(409)
 })
})
