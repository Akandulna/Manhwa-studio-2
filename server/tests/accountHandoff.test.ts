import {AccountHandoffStudioBridge,accountHandoffTransport} from '../src/services/accountHandoffBridge.js'
import {writeFileSync} from 'node:fs'
import {AccountHandoffAuthority,accountHandoffApi} from '../../relay/src/accountHandoff.js'
import {HANDOFF_CONFIRMATION} from '../src/services/accountHandoffProtocol.js'
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
const CAPS=['retained-candidate-handoff/1','target-candidate-retention/1','target-standalone-context/1','target-package-check/1','target-source-check/1','managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','account-audit/1','account-selection/1']
const spec=fixture.original.spec
async function setup(outcome='unsent',released=true,file=':memory:',initialEnabled=true){
 const db=new DatabaseSync(file);opened.push(db);let now=1792714000000,seq=0
 const sql:any={exec:(q:string,...args:any[])=>{const rows=db.prepare(q).all(...args);return {toArray:()=>rows}}}
 const tx=<T>(work:()=>T):T=>{const id='tx'+(++seq);db.exec('SAVEPOINT '+id);try{const r=work();db.exec('RELEASE '+id);return r}catch(error){db.exec('ROLLBACK TO '+id);db.exec('RELEASE '+id);throw error}}
 const a=new TaskAuthority(sql,tx,()=>new Date(now).toISOString(),()=> 'id_'+(++seq),()=>true),event=()=> 'event_'+(++seq)
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




async function retained(){
 const e=await setup(),v=await e.prepareAdoption();e.adoption.approve(studio,e.unit,e.targets[0],v.approval);e.adoption.start(phone('two'),e.unit,'adopt_one','start_one',v.contextProof);const checked=e.adoption.check(phone('two'),e.unit,'adopt_one',v.contextProof);e.adoption.finish(phone('two'),e.unit,'adopt_one',e.nativeReceipt(checked.action))
 let enabled=true;const handoff=new AccountHandoffAuthority(e.sql,e.tx,e.a,e.contexts,()=>enabled,e.now),approval={actionId:'handoff_one',candidateId:'adopt_one',revision:0,confirmation:HANDOFF_CONFIRMATION}
 return {...e,v,handoff,approval,off:()=>enabled=false}
}
describe('atomic independent-account retained-candidate handoff',()=>{
 it('commits account pin, all reservations, exact candidate command and original lineage together',async()=>{
  const e=await retained();e.handoff.approve(studio,e.unit,e.approval);expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:2,pending:true})
  const result=e.handoff.consume(phone('two'),e.unit,'handoff_one',e.v.contextProof),next=result.result
  expect(next.attempt).toMatchObject({generation:2,deviceId:'two',profileId:'profile',accountId:'alternative',phase:'assigned',submission:'unsent'})
  expect(next.command.handoff).toMatchObject({candidateId:'adopt_one',actionId:'handoff_one',context:e.v.context})
  const resources=e.db.prepare('SELECT resource FROM managed_reservations WHERE attempt_id = ?').all(next.attempt.id).map((x:any)=>x.resource)
  expect(resources).toHaveLength(5);expect(resources).toContain('account:alternative:0')
  writeFileSync('/tmp/account-handoff/fixture.json',JSON.stringify({grant:e.handoff.status(studio,e.unit).actions[0],assignment:next,proof:e.v.contextProof},null,2))
  const unit={...e.unit,attemptId:next.attempt.id,generation:2};expect(sharedRecoveryBudget(e.sql,unit)).toMatchObject({used:2,pending:false});expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:2,pending:false})
  e.a.checkpoint(phone('two'),e.event(),e.unit.taskId,next.attempt.id,2,e.unit.fingerprint,'accepted',null,next.command.id)
  expect(e.a.renew(phone('two'),e.event(),e.unit.taskId,next.attempt.id,2,e.unit.fingerprint).permitted).toBe(true)
  e.off();e.advance(180000);expect(e.handoff.consume(phone('two'),e.unit,'handoff_one',e.v.contextProof)).toEqual(result)
  expect(()=>e.handoff.consume(phone('two'),e.unit,'handoff_one',{...e.v.contextProof,bindingId:'other'})).toThrow()
 })
 it('finishes a third already charged action without granting a fourth',async()=>{
  const e=await retained();e.seedOther(['old']);e.handoff.approve(studio,e.unit,e.approval);expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:3,pending:true,exhausted:true})
  const a=e.handoff.consume(phone('two'),e.unit,'handoff_one',e.v.contextProof);expect(sharedRecoveryBudget(e.sql,{...e.unit,attemptId:a.result.attempt.id,generation:2})).toMatchObject({used:3,exhausted:true,pending:false})
 })
 it('requires separate explicit approval and compatible target',async()=>{
  const e=await retained(),before=e.dump();expect(()=>e.handoff.approve(phone(),e.unit,e.approval)).toThrow();expect(()=>e.handoff.approve(studio,e.unit,{...e.approval,confirmation:ADOPTION_CONFIRMATION})).toThrow();expect(e.dump()).toEqual(before)
  e.mutate('managed_peers','two',(x:any)=>x.capabilities=x.capabilities.filter((c:string)=>c!=='retained-candidate-handoff/1'));expect(()=>e.handoff.approve(studio,e.unit,e.approval)).toThrow('consumer')
 })
 it('replays the original approval without a second charge and rejects changed identity',async()=>{const e=await retained(),a=e.handoff.approve(studio,e.unit,e.approval);expect(e.handoff.approve(studio,e.unit,e.approval)).toEqual(a);expect(()=>e.handoff.approve(studio,e.unit,{...e.approval,candidateId:'different'})).toThrow();expect(sharedRecoveryBudget(e.sql,e.unit).used).toBe(2)})
 it('retains charge and cooldown on unused cancellation, even off',async()=>{const e=await retained();e.handoff.approve(studio,e.unit,e.approval);e.off();e.handoff.cancel(studio,e.unit,'handoff_one',1);expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:2,pending:false,nextEligibleAt:e.now()+30000});expect(()=>e.handoff.consume(phone('two'),e.unit,'handoff_one',e.v.contextProof)).toThrow()})
 for(const mode of ['pause','disable','cancel','reinspect'] as const)it('honors family '+mode+' without moving ownership',async()=>{const e=await retained();e.handoff.approve(studio,e.unit,e.approval);e.stopRecovery('pause');if(mode!=='pause')e.stopRecovery(mode,2);const before=e.dump();expect(()=>e.handoff.consume(phone('two'),e.unit,'handoff_one',e.v.contextProof)).toThrow();expect(e.dump()).toEqual(before)})
 for(const reason of ['off','expired','review','account','policy','quota','reservation','otherPending','proof','role','capability','production'])it('holds changed '+reason+' before allocation',async()=>{
  const e=await retained();e.handoff.approve(studio,e.unit,e.approval);let actor=phone('two'),proof=e.v.contextProof
  if(reason==='off')e.off();if(reason==='expired')e.advance(120000);if(reason==='review')e.contexts.withdraw(studio,e.v.review.id,e.unit,e.targets[0]);if(reason==='account')e.mutate('managed_account_profiles','two/profile',(x:any)=>x.observation.checkedAt--);if(reason==='policy')e.mutate('managed_account_policies','crop_json',(x:any)=>x.revision++);if(reason==='quota')e.db.prepare("UPDATE managed_account_quotas SET body = json_set(body,'$.state','blocked') WHERE json_extract(body,'$.accountId') = 'alternative'").run();if(reason==='reservation')e.db.prepare('INSERT INTO managed_reservations VALUES (?,?)').run('device:two','another');if(reason==='otherPending')e.seedOther(['unknown'],'unknown');if(reason==='proof')proof={...proof,bindingId:'changed'};if(reason==='role')actor=phone('one');if(reason==='capability')e.mutate('managed_peers','two',(x:any)=>x.capabilities=[]);if(reason==='production')e.db.prepare('INSERT INTO managed_production_attempts VALUES (?,?)').run(e.unit.attemptId,JSON.stringify({taskId:e.unit.taskId,claimEventId:'production'}))
  const before=e.dump();expect(()=>e.handoff.consume(actor,e.unit,'handoff_one',proof)).toThrow();expect(e.dump()).toEqual(before)
 })
 it('rolls back ownership, account capacity, command and lineage if final ledger write fails',async()=>{
  const e=await retained();e.handoff.approve(studio,e.unit,e.approval);e.db.exec("CREATE TRIGGER fail_handoff BEFORE UPDATE ON managed_account_handoff_episodes WHEN json_extract(NEW.body,'$.actions[0].phase') = 'verified' BEGIN SELECT RAISE(ABORT,'injected final handoff failure'); END")
  const before=e.dump();expect(()=>e.handoff.consume(phone('two'),e.unit,'handoff_one',e.v.contextProof)).toThrow('injected');expect(e.dump()).toEqual(before)
 })
 it('rejects malformed and wrong-workspace API requests',async()=>{const e=await retained();await expect(accountHandoffApi(new Request('https://relay/managed/recovery/account-handoff',{method:'POST',body:JSON.stringify({schema:'managed-account-handoff/1',workspaceId:'other',unit:e.unit,action:'status'})}),studio,e.handoff,'workspace')).rejects.toThrow('workspace')})
})

describe('successor execution admission remains fenced',()=>{
 for(const reason of ['account','quota','review','policy','reservation','stop','pending','stale'])it('blocks successor execution after '+reason+' changes',async()=>{
  const e=await retained();e.handoff.approve(studio,e.unit,e.approval);const x=e.handoff.consume(phone('two'),e.unit,'handoff_one',e.v.contextProof).result
  if(reason==='account')e.mutate('managed_account_profiles','two/profile',(p:any)=>p.observation.sites.chatgpt.candidate='different');if(reason==='quota')e.db.prepare("UPDATE managed_account_quotas SET body = json_set(body,'$.state','blocked') WHERE json_extract(body,'$.accountId') = 'alternative'").run();if(reason==='review')e.db.prepare("UPDATE managed_target_context_reviews SET body = json_set(body,'$.withdrawnAt',?) WHERE id = ?").run(e.now(),e.v.review.id);if(reason==='policy')e.mutate('managed_account_policies','crop_json',(p:any)=>p.revision++);if(reason==='reservation')e.db.prepare("DELETE FROM managed_reservations WHERE resource = 'browser:two'").run();if(reason==='stop')e.stopRecovery('pause');if(reason==='pending')e.seedOther(['pending'],'unknown');if(reason==='stale')e.advance(120000)
  expect(()=>e.a.renew(phone('two'),e.event(),e.unit.taskId,x.attempt.id,2,e.unit.fingerprint)).toThrow()
 })
})

describe('handoff Studio and transport boundaries',()=>{
 it('rejects a source change around approval without retrying the action',async()=>{
  const e=await retained();let count=0,calls=0;const bridge=new AccountHandoffStudioBridge({enabled:()=>true,resolve:async()=>({unit:e.unit,source:++count===1?e.v.context.source:{...e.v.context.source,sha256:'f'.repeat(64)}}),call:async(op:any)=>{calls++;return e.handoff.approve(studio,e.unit,op.approval)}})
  await expect(bridge.perform({action:'approve',unit:e.unit,approval:e.approval})).rejects.toThrow('Source');expect(calls).toBe(1);expect(sharedRecoveryBudget(e.sql,e.unit).used).toBe(2)
 })
 it('holds unsupported production before charging approval',async()=>{const e=await retained();e.db.prepare('INSERT INTO managed_production_attempts VALUES (?,?)').run(e.unit.attemptId,JSON.stringify({taskId:e.unit.taskId,claimEventId:'production'}));const before=e.dump();expect(()=>e.handoff.approve(studio,e.unit,e.approval)).toThrow('production');expect(e.dump()).toEqual(before)})
 it('exposes the dedicated authenticated API without granting Studio phone consumption',async()=>{
  const e=await retained();e.handoff.approve(studio,e.unit,e.approval)
  await expect(accountHandoffApi(new Request('https://relay/managed/recovery/account-handoff',{method:'POST',body:JSON.stringify({schema:'managed-account-handoff/1',workspaceId:'workspace',unit:e.unit,action:'consume',actionId:'handoff_one',proof:e.v.contextProof})}),studio,e.handoff,'workspace')).rejects.toThrow('authenticated')
 })
 it('preserves the existing 429 pause and sends a single request',async()=>{
  let calls=0,pauses=0;vi.stubGlobal('fetch',vi.fn(async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'30'}})}))
  const send=accountHandoffTransport('https://relay.example','workspace','s'.repeat(32),undefined,{beforeSend:async()=>{},record:async()=>{pauses++}} as any)
  await expect(send({action:'status'})).rejects.toThrow('unconfirmed');expect(calls).toBe(1);expect(pauses).toBe(1)
 })
 it('bounds the response without retrying',async()=>{
  const fetch=vi.fn(async()=>new Response('x'.repeat(64001)));vi.stubGlobal('fetch',fetch)
  const send=accountHandoffTransport('https://relay.example','workspace','s'.repeat(32),undefined,{beforeSend:async()=>{},record:async()=>{}} as any)
  await expect(send({action:'status'})).rejects.toThrow('bounds');expect(fetch).toHaveBeenCalledTimes(1)
 })
})

describe('handoff persistence and runtime gate compatibility',()=>{
 it('retains the exact transaction and inherited charges after SQLite close/reopen',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'atomic-handoff-'));temporary.push(dir);const file=path.join(dir,'authority.sqlite'),e=await setup('unsent',true,file),v=await e.prepareAdoption()
  e.adoption.approve(studio,e.unit,e.targets[0],v.approval);e.adoption.start(phone('two'),e.unit,'adopt_one','start_one',v.contextProof);const checked=e.adoption.check(phone('two'),e.unit,'adopt_one',v.contextProof);e.adoption.finish(phone('two'),e.unit,'adopt_one',e.nativeReceipt(checked.action))
  const handoff=new AccountHandoffAuthority(e.sql,e.tx,e.a,e.contexts,()=>true,e.now);handoff.approve(studio,e.unit,{actionId:'handoff_one',candidateId:'adopt_one',revision:0,confirmation:HANDOFF_CONFIRMATION});const original=handoff.consume(phone('two'),e.unit,'handoff_one',v.contextProof)
  e.db.close();opened.splice(opened.indexOf(e.db),1);const reopened=new DatabaseSync(file);opened.push(reopened);const sql:any={exec:(q:string,...args:any[])=>({toArray:()=>reopened.prepare(q).all(...args)})},tx=<T>(f:()=>T)=>{reopened.exec('SAVEPOINT reopen');try{const value=f();reopened.exec('RELEASE reopen');return value}catch(error){reopened.exec('ROLLBACK TO reopen');reopened.exec('RELEASE reopen');throw error}}
  const authority=new TaskAuthority(sql,tx,()=>new Date(e.now()).toISOString()),owner=new AccountHandoffAuthority(sql,tx,authority,e.contexts,()=>false,e.now)
  expect(owner.consume(phone('two'),e.unit,'handoff_one',v.contextProof)).toEqual(original);expect(sharedRecoveryBudget(sql,{...e.unit,attemptId:original.result.attempt.id,generation:2})).toMatchObject({used:2,pending:false});expect(reopened.prepare('SELECT resource FROM managed_reservations').all()).toHaveLength(5)
 })
 it('keeps default-off or older authority from executing a retained-candidate command',async()=>{
  const e=await retained();e.handoff.approve(studio,e.unit,e.approval);const next=e.handoff.consume(phone('two'),e.unit,'handoff_one',e.v.contextProof).result
  const off=new TaskAuthority(e.sql,e.tx,()=>new Date(e.now()).toISOString());expect(()=>off.renew(phone('two'),e.event(),e.unit.taskId,next.attempt.id,2,e.unit.fingerprint)).toThrow('off or held')
 })
})
