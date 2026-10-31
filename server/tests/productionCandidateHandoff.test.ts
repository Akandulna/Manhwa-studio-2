import {ManagedProductionCoordinator} from '../src/services/managedProductionCoordinator.js'
import {productionCandidateHandoff} from '../src/services/managedProductionCandidateHandoff.js'
import {validHandoffReplacement} from '../src/services/managedProductionHandoff.js'
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
const CAPS=['production-candidate-handoff/1','retained-candidate-handoff/1','target-candidate-retention/1','target-standalone-context/1','target-package-check/1','target-source-check/1','managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','account-audit/1','account-selection/1']
const spec=fixture.original.spec
async function setup(outcome='unsent',released=true,file=':memory:',initialEnabled=true,production=false){
 const db=new DatabaseSync(file);opened.push(db);let now=1792714000000,seq=0
 const sql:any={exec:(q:string,...args:any[])=>{const rows=db.prepare(q).all(...args);return {toArray:()=>rows}}}
 const tx=<T>(work:()=>T):T=>{const id='tx'+(++seq);db.exec('SAVEPOINT '+id);try{const r=work();db.exec('RELEASE '+id);return r}catch(error){db.exec('ROLLBACK TO '+id);db.exec('RELEASE '+id);throw error}}
 const a=new TaskAuthority(sql,tx,()=>new Date(now).toISOString(),()=> 'id_'+(++seq),()=>true),event=()=> 'event_'+(++seq)
 const coordinator=production?a.acquireCoordinator(studio,event(),'workspace','initial_coordinator',0):null
 for(const device of ['one','two']){a.registerPeer(phone(device),event(),['profile'],CAPS,'fixture');a.enroll(studio,event(),device,'profile',CAPS)}
 const policy:AccountPolicy={revision:1,stage:'crop_json',enabled:true,auditsEnabled:true,allowed:[{provider:'chatgpt',product:'chatgpt-web',model:'provider-default',mode:null,effort:null}],preferredProfiles:['two/profile'],allowUnknownQuota:false,allowEstimatedQuota:false,criticalMaxAgeHours:24,contextPortable:true}
 a.accounts.setPolicy(studio,event(),policy)
 for(const [device,account] of [['one','original'],['two','alternative']]){
  const observation=await accountObservation({checkedAt:new Date(now).toISOString(),chatGpt:{signedIn:true,email:account+'@example.com',plan:'Plus'},gemini:{signedIn:false}},now)
  const p=a.accounts.observe(phone(device),event(),device,'profile',observation);a.accounts.confirm(studio,event(),device,'profile','chatgpt',p.observation!.sites.chatgpt.candidate!,account,1)
  for(const feature of ['crop_json','uploads'])a.accounts.quota(studio,event(),null,{accountId:account,scope:{provider:'openai',product:'chatgpt',model:'*',project:null,feature},state:'available',evidence:'owner_supplied',observedAt:now,recheckAt:null})
 }
 const task=await a.plan(studio,event(),fixture.original.scope,spec),claimEventId=event(),claim=a.claim(studio,claimEventId,task.id,'one','profile',null,coordinator?{coordinatorId:coordinator.coordinatorId,coordinatorGeneration:coordinator.coordinatorGeneration}:undefined)
 for(const phase of ['accepted','started'] as const)a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,phase,null,claim.command.id)
 if(outcome!=='unsent')a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,'submission_intent',null,claim.command.id)
 if(['submitted','saved'].includes(outcome))a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,'submitted',null,claim.command.id)
 if(outcome==='saved')a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,'result_saved','checkpoint/saved',claim.command.id)
 if(released){const stopped=a.stop(studio,event(),task.id,false,coordinator?{coordinatorId:coordinator.coordinatorId,coordinatorGeneration:coordinator.coordinatorGeneration}:undefined);a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,'stop_confirmed',null,stopped.command!.id)}
 const unit={workspaceId:'workspace',taskId:task.id,attemptId:claim.attempt.id,generation:claim.attempt.generation,fingerprint:task.fingerprint},targets=[{deviceId:'two',profileId:'profile'}]
 const env:ManagedTaskEnvironment={MANAGED_AUTOMATIC_RECOVERY:'1',MANAGED_CROP_PAGE:'1',MANAGED_WORKSPACE_ID:'workspace',MANAGED_STUDIO_TOKEN:'s'.repeat(40),MANAGED_DEVICE_TOKENS:JSON.stringify({one:'o'.repeat(40),two:'t'.repeat(40)})}
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
 if(coordinator)a.updateCoordinator(studio,event(),'workspace',{coordinatorId:coordinator.coordinatorId,coordinatorGeneration:coordinator.coordinatorGeneration},true)
 return {claimEventId,a,db,sql,tx,unit,targets,env,authority,inspect,call,dump,mutate,event,now:()=>now,advance:(ms:number)=>now+=ms,claim,checks,begin,proof,packages,prepare,contexts,prepareContext,adoption,prepareAdoption,nativeReceipt,seedOther,stopRecovery,setEnabled:(v:boolean)=>enabled=v}
}




async function retained(){
 const e=await setup('unsent',true,':memory:',true,true),v=await e.prepareAdoption();e.adoption.approve(studio,e.unit,e.targets[0],v.approval);e.adoption.start(phone('two'),e.unit,'adopt_one','start_one',v.contextProof);const checked=e.adoption.check(phone('two'),e.unit,'adopt_one',v.contextProof);e.adoption.finish(phone('two'),e.unit,'adopt_one',e.nativeReceipt(checked.action))
 let enabled=true;const handoff=new AccountHandoffAuthority(e.sql,e.tx,e.a,e.contexts,()=>enabled,e.now),approval={actionId:'handoff_one',candidateId:'adopt_one',revision:0,confirmation:HANDOFF_CONFIRMATION}
 return {...e,v,handoff,approval,off:()=>enabled=false}
}

async function productionSetup(){
 const e=await retained();let seq=0,enabled=true,failSave=false,loseFinalize=false,loseApprove=false
 const input={identity:fixture.original.scope,spec,sourceFile:'/synthetic/source.png',folder:'/synthetic',filename:e.v.context.source.filename,destination:'/synthetic/crop.json'}
 let job:any={id:'original_job',revision:2,seriesId:'series',config:{managedCrop:true,device:'one',profileId:'profile',clipper:{ai:'chatgpt',flow:'classic',tabs:1,chatGpt:{mode:null,model:null,effort:null}}},status:'interrupted',step:'clipping',message:'paused',createdAt:new Date(e.now()).toISOString(),updatedAt:new Date(e.now()).toISOString(),command:{kind:'clipper',sentAt:new Date(e.now()).toISOString(),managedTaskIds:[e.unit.taskId],managedClaims:[{taskId:e.unit.taskId,claimEventId:e.claimEventId,deviceId:'one',profileId:'profile'}]}}
 const original=structuredClone(job),calls:any[]=[]
 const authority:any={
  ready:async()=>{},coordinator:async()=>e.a.coordinator(studio,'workspace'),timeline:async(id:string)=>e.a.timeline(studio,id),claimReceipt:async(id:string,event:string)=>e.a.productionClaim(studio,id,event),artifacts:{load:async()=>{},publish:async()=>{}},
  candidateAdoptionStatus:async(unit:any,target:any)=>e.adoption.status(studio,unit,target),
  operation:async(op:any)=>{
   const event=e.event()
   if(op.action==='coordinator_acquire')return e.a.acquireCoordinator(studio,event,'workspace',op.coordinatorId,op.expectedGeneration)
   if(op.action==='coordinator_renew'||op.action==='coordinator_release')return e.a.updateCoordinator(studio,event,'workspace',{coordinatorId:op.coordinatorId,coordinatorGeneration:op.coordinatorGeneration},op.action==='coordinator_release')
   throw Error('Unexpected authority operation '+op.action)
  },
  accountHandoff:async(op:any)=>{calls.push(structuredClone(op));
   if(op.action==='status')return e.handoff.status(studio,op.unit)
   if(op.action==='approve'){const value=e.handoff.approve(studio,op.unit,op.approval);if(loseApprove){loseApprove=false;throw Error('lost approval reply')}return value}
   if(op.action==='finalize'){const value=e.handoff.finalize(studio,op.unit,op.actionId,{coordinatorId:op.coordinatorId,coordinatorGeneration:op.coordinatorGeneration});if(loseFinalize){loseFinalize=false;throw Error('lost commit reply')}return value}
   throw Error('Unexpected handoff action')
  }
 }
 const deps:any={authority,coordinator:new ManagedProductionCoordinator(e.now),load:async()=>[structuredClone(job)],save:async(next:any,expected:any)=>{if(failSave)throw Error('CAS failure');expect(job.id).toBe(expected.id);expect(job.revision).toBe(expected.revision);job=structuredClone(next)},inputs:async()=>[input],verify:async()=>e.v.context.source,validateTarget:async()=>{},enabled:()=>enabled,now:e.now,id:()=> 'production_id_'+(++seq)}
 const request={action:'approve',jobId:job.id,revision:job.revision,taskId:e.unit.taskId,attemptId:e.unit.attemptId,generation:e.unit.generation,fingerprint:e.unit.fingerprint,stopCommandId:e.a.timeline(studio,e.unit.taskId).attempt!.activeCommandId,deviceId:'two',profileId:'profile',candidateId:'adopt_one',confirmation:HANDOFF_CONFIRMATION}
 const pendingRequest=(action='finish')=>({action,jobId:job.id,revision:job.revision,intentId:job.pendingHandoff.eventId})
 const approve=()=>productionCandidateHandoff('series',request,deps),finish=()=>productionCandidateHandoff('series',pendingRequest(),deps)
 const prepare=()=>e.handoff.consume(phone('two'),e.unit,job.pendingHandoff.eventId,e.v.contextProof)
 return {...e,original,authority,deps,calls,request,approve,finish,prepare,pendingRequest,job:()=>job,setJob:(j:any)=>job=j,failSave:(v=true)=>failSave=v,loseFinalize:()=>loseFinalize=true,loseApprove:()=>loseApprove=true,disable:()=>enabled=false}
}
describe('production candidate handoff coordinator and durable intent',()=>{
 it('stages proof without ownership, then atomically records successor claim under a fresh lease',async()=>{
  const e=await productionSetup();await e.approve();const pending=structuredClone(e.job()),id=pending.pendingHandoff.eventId
  expect(e.calls.find(c=>c.action==='approve').approval.production.coordinatorGeneration).toBe(2)
  expect(e.a.timeline(studio,e.unit.taskId).attempt!.id).toBe(e.unit.attemptId);expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:2,pending:true})
  const staged=e.prepare();expect(staged.phase).toBe('prepared');expect(staged.result).toBeNull();expect(e.a.coordinator(studio,'workspace')!.state).toBe('released');expect(e.a.timeline(studio,e.unit.taskId).attempt!.id).toBe(e.unit.attemptId)
  const applied=await e.finish(),result=e.handoff.status(studio,e.unit).actions[0]
  expect(applied.command!.managedClaims![0].claimEventId).toBe(pending.pendingHandoff.newClaimEventId);expect(applied.pendingHandoff).toBeUndefined();expect(validHandoffReplacement(pending,applied)).toBe(true)
  expect(e.a.productionClaim(studio,e.unit.taskId,pending.pendingHandoff.newClaimEventId)).toMatchObject({status:'recorded',accountId:'alternative',generation:2,attemptId:result.result.attempt.id})
  expect(e.db.prepare('SELECT body FROM managed_production_attempts WHERE id = ?').get(result.result.attempt.id)).toBeTruthy();expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:2,pending:false});expect(e.calls.find(c=>c.action==='finalize').coordinatorGeneration).toBe(3)
  writeFileSync('/tmp/production-candidate-handoff/fixture.json',JSON.stringify({grant:result,prepared:staged,proof:e.v.contextProof,assignment:result.result},null,2))
 })
 it('reconciles a lost commit reply with the same claim/action and one ownership change',async()=>{
  const e=await productionSetup();await e.approve();e.prepare();e.loseFinalize();await expect(e.finish()).rejects.toThrow('lost commit');const original=e.handoff.status(studio,e.unit).actions[0].result
  e.off();e.advance(180000);const applied=await e.finish();expect(applied.handoffHistory![0].newAttemptId).toBe(original.attempt.id);expect(e.a.timeline(studio,e.unit.taskId).task.generation).toBe(2);expect(sharedRecoveryBudget(e.sql,e.unit).used).toBe(2)
 })
 it('retains pending IDs before a lost approval response and does not double-charge on explicit replay',async()=>{
  const e=await productionSetup();e.loseApprove();await expect(e.approve()).rejects.toThrow('lost approval');const original=structuredClone(e.job().pendingHandoff)
  await productionCandidateHandoff('series',e.pendingRequest('approve'),e.deps);expect(e.job().pendingHandoff).toEqual(original);expect(sharedRecoveryBudget(e.sql,e.unit).used).toBe(2)
 })
 it('retains committed authority and original intent when local CAS save fails',async()=>{
  const e=await productionSetup();await e.approve();e.prepare();e.failSave();await expect(e.finish()).rejects.toThrow('CAS');expect(e.job().pendingHandoff).toBeTruthy();const before=e.a.timeline(studio,e.unit.taskId).attempt!.id;e.failSave(false);await e.finish();expect(e.a.timeline(studio,e.unit.taskId).attempt!.id).toBe(before)
 })
 it('requires an explicit new matching target proof before coordinator commit',async()=>{const e=await productionSetup();await e.approve();await expect(e.finish()).rejects.toThrow('fresh proof');expect(e.a.timeline(studio,e.unit.taskId).task.generation).toBe(1)})
 for(const reason of ['expiredProof','quota','account','review','stop','off','claimStop','source','cancelledJob','changedRevision'])it('holds '+reason+' before ownership mutation',async()=>{
  const e=await productionSetup();await e.approve();e.prepare()
  if(reason==='expiredProof')e.advance(15000);if(reason==='quota')e.db.prepare("UPDATE managed_account_quotas SET body = json_set(body,'$.state','blocked') WHERE json_extract(body,'$.accountId') = 'alternative'").run();if(reason==='account')e.mutate('managed_account_profiles','two/profile',(p:any)=>p.observation.checkedAt--);if(reason==='review')e.contexts.withdraw(studio,e.v.review.id,e.unit,e.targets[0]);if(reason==='stop')e.stopRecovery('pause');if(reason==='off')e.off();if(reason==='claimStop')e.db.prepare('INSERT INTO managed_claim_stops VALUES (?,?)').run(e.job().pendingHandoff.newClaimEventId,JSON.stringify({taskId:e.unit.taskId}));if(reason==='source')e.deps.verify=async()=>({...e.v.context.source,sha256:'f'.repeat(64)});if(reason==='cancelledJob')e.setJob({...e.job(),status:'cancelled'});if(reason==='changedRevision')e.setJob({...e.job(),pendingHandoff:{...e.job().pendingHandoff,newClaimEventId:'different'}})
  await expect(e.finish()).rejects.toThrow();expect(e.a.timeline(studio,e.unit.taskId).task.generation).toBe(1)
 })
 it('does not persist or reserve a new approval with flags off',async()=>{const e=await productionSetup();e.disable();await expect(e.approve()).rejects.toThrow('off');expect(e.job()).toEqual(e.original);expect(sharedRecoveryBudget(e.sql,e.unit).used).toBe(1)})
 it('rejects forged source claim receipts and changed target/candidate references',async()=>{const e=await productionSetup();const bad={...e.request,candidateId:'different'};await expect(productionCandidateHandoff('series',bad,e.deps)).rejects.toThrow('candidate');expect(sharedRecoveryBudget(e.sql,e.unit).used).toBe(1)})
 it('cannot reserve a grant when the local intent save fails',async()=>{const e=await productionSetup();e.failSave();await expect(e.approve()).rejects.toThrow('CAS');expect(e.calls.filter(c=>c.action==='approve')).toHaveLength(0);expect(sharedRecoveryBudget(e.sql,e.unit).used).toBe(1)})
})
describe('production candidate relay lease and proof fences',()=>{
 it('rejects target-side ownership transfer and stale/released coordinator commits',async()=>{
  const e=await productionSetup();await e.approve();const a=e.prepare(),before=e.a.timeline(studio,e.unit.taskId)
  expect(e.handoff.consume(phone('two'),e.unit,a.id,e.v.contextProof).phase).toBe('prepared');expect(e.a.timeline(studio,e.unit.taskId)).toEqual(before)
  expect(()=>e.handoff.finalize(studio,e.unit,a.id,{coordinatorId:'stale',coordinatorGeneration:2})).toThrow('coordinator')
  expect(()=>e.handoff.finalize(phone('two'),e.unit,a.id,{coordinatorId:'stale',coordinatorGeneration:2})).toThrow('Studio')
 })
 it('preserves immutable prepared proof and original charge when cancelling before commit while off',async()=>{
  const e=await productionSetup();await e.approve();const a=e.prepare();expect(()=>e.handoff.consume(phone('two'),e.unit,a.id,{...e.v.contextProof,bindingId:'other'})).toThrow('Immutable');e.off()
  const cancelled=e.handoff.cancel(studio,e.unit,a.id,2);expect(cancelled.proof).toEqual(a.proof);expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:2,pending:false,nextEligibleAt:e.now()+30000})
 })
 it('requires the production-aware native capability before charging',async()=>{const e=await productionSetup();e.mutate('managed_peers','two',(p:any)=>p.capabilities=p.capabilities.filter((c:string)=>c!=='production-candidate-handoff/1'));await expect(e.approve()).rejects.toThrow('consumer');expect(sharedRecoveryBudget(e.sql,e.unit).used).toBe(1)})
})

describe('production candidate budget, lease expiry and transaction rollback',()=>{
 it('finishes a charged third action without resetting the successor allowance',async()=>{
  const e=await productionSetup();e.seedOther(['earlier']);await e.approve();e.prepare();expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:3,pending:true,exhausted:true});await e.finish();const a=e.handoff.status(studio,e.unit).actions[0];expect(sharedRecoveryBudget(e.sql,{...e.unit,attemptId:a.result.attempt.id,generation:2})).toMatchObject({used:3,pending:false,exhausted:true})
 })
 it('requires the actual current live coordinator generation, including lease expiry',async()=>{
  const e=await productionSetup();await e.approve();e.prepare();const current=e.a.coordinator(studio,'workspace')!,lease=e.a.acquireCoordinator(studio,e.event(),'workspace','new_owner',current.coordinatorGeneration)
  e.advance(60000);expect(()=>e.handoff.finalize(studio,e.unit,e.job().pendingHandoff.eventId,{coordinatorId:lease.coordinatorId,coordinatorGeneration:lease.coordinatorGeneration})).toThrow('expired');expect(e.a.timeline(studio,e.unit.taskId).task.generation).toBe(1)
 })
 it('rolls back the new claim event, registration, reservations and lineage on final write failure',async()=>{
  const e=await productionSetup();await e.approve();e.prepare();const id=e.job().pendingHandoff.newClaimEventId
  e.db.exec("CREATE TRIGGER fail_production_commit BEFORE UPDATE ON managed_account_handoff_episodes WHEN json_extract(NEW.body,'$.actions[0].phase') = 'verified' BEGIN SELECT RAISE(ABORT,'injected commit failure'); END")
  await expect(e.finish()).rejects.toThrow('injected');expect(e.a.timeline(studio,e.unit.taskId).task.generation).toBe(1);expect(e.a.productionClaim(studio,e.unit.taskId,id).status).toBe('missing');expect(e.db.prepare('SELECT resource FROM managed_reservations').all()).toHaveLength(0);expect(e.db.prepare('SELECT id FROM managed_recovery_lineage').all()).toHaveLength(0);expect(e.handoff.status(studio,e.unit).actions[0].phase).toBe('prepared')
 })
 it('refuses collision between the recovery action and successor claim identities',async()=>{
  const e=await productionSetup();e.deps.id=()=> 'same_id';await expect(e.approve()).rejects.toThrow('Distinct');expect(sharedRecoveryBudget(e.sql,e.unit).used).toBe(1)
 })
})
