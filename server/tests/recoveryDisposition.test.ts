import {RecoveryDispositionAuthority,recoveryDispositionApi} from '../../relay/src/recoveryDisposition.js'
import {productionRecoveryDisposition,validDispositionCompletion} from '../src/services/productionRecoveryDisposition.js'
import {RECOVERY_DISPOSITION_SCHEMA,RETAIN_HOLD_CONFIRMATION,CLOSE_UNUSED_CONFIRMATION} from '../src/services/recoveryDispositionProtocol.js'
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

function disposition(e:any){return new RecoveryDispositionAuthority(e.sql,e.tx,e.a,new RecoveryStops(e.sql,e.tx,e.a,new AccountRecheckRecovery(e.sql,e.tx,e.a,e.now),e.now),e.handoff??new AccountHandoffAuthority(e.sql,e.tx,e.a,e.contexts,()=>false,e.now),e.adoption,e.now)}
function decision(snapshot:any,reference:any=null,production:any=null,id='decision_one'){return {schema:RECOVERY_DISPOSITION_SCHEMA,eventId:id,unit:snapshot.unit,mode:reference?'close_unused':'retain_hold',reference,production,inspectedAt:snapshot.checkedAt,inspectionToken:snapshot.inspectionToken,confirmation:reference?CLOSE_UNUSED_CONFIRMATION:RETAIN_HOLD_CONFIRMATION}}
async function productionDispositionSetup(){const e=await productionSetup(),owner=disposition(e);e.authority.recoveryDisposition=async(op:any)=>op.action==='inspect'?owner.inspect(studio,op.unit):op.action==='resolve'?owner.resolve(studio,op.intent):owner.apply(studio,op.intent,op.coordinator);const deps={...e.deps},request=(action:string,extra:any={})=>({action,jobId:e.job().id,revision:e.job().revision,...extra});return {...e,owner,deps,dispositionRequest:request,inspectDisposition:()=>productionRecoveryDisposition('series',request('inspect'),deps)}}
describe('explicit recovery-family disposition',()=>{
 it('inspects without mutation and records a family hold without changing original ownership or charges',async()=>{
  const e=await retained(),owner=disposition(e),before=e.dump(),snapshot=await owner.inspect(studio,e.unit);expect(e.dump()).toEqual(before);expect(snapshot.budget.used).toBe(1)
  const intent=decision(snapshot),receipt=await owner.apply(studio,intent);expect(receipt).toMatchObject({state:'applied',beforeBudget:{used:1},afterBudget:{used:1},ownershipChanged:false,budgetReset:false,automaticallyResumed:false});expect(()=>assertRecoveryControls(e.sql,e.unit)).toThrow();expect(e.a.timeline(studio,e.unit.taskId).task.generation).toBe(1)
  e.advance(20000);expect(await owner.apply(studio,intent)).toEqual(receipt);expect(owner.resolve(studio,intent)).toEqual(receipt)
 })
 it('closes only an original unused custody approval even off/expired and preserves its charge',async()=>{
  const e=await setup(),v=await e.prepareAdoption();e.adoption.approve(studio,e.unit,e.targets[0],v.approval);e.setEnabled(false);e.advance(120000)
  const owner=disposition(e),snapshot=await owner.inspect(studio,e.unit),ref=snapshot.actions.find(a=>a.reference.actionId==='adopt_one')!.reference
  const receipt=await owner.apply(studio,decision(snapshot,ref));expect(receipt.closed).toEqual({fromPhase:'reserved',toPhase:'safe_failure'});expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:1,pending:false,nextEligibleAt:e.now()+30000});expect(()=>e.adoption.start(phone('two'),e.unit,'adopt_one','late_start',v.contextProof)).toThrow()
 })
 it('keeps an original unknown custody outcome unchanged through hold, and rejects unused relabeling',async()=>{
  const e=await setup(),v=await e.prepareAdoption();e.adoption.approve(studio,e.unit,e.targets[0],v.approval);e.adoption.start(phone('two'),e.unit,'adopt_one','start',v.contextProof);e.adoption.check(phone('two'),e.unit,'adopt_one',v.contextProof);const unknown=e.adoption.unknown(phone('two'),e.unit,'adopt_one').action
  const owner=disposition(e),snapshot=await owner.inspect(studio,e.unit),ref=snapshot.actions[0].reference;expect(snapshot.actions[0].unusedClosable).toBe(false)
  await expect(owner.apply(studio,decision(snapshot,ref))).rejects.toThrow('unknown');const held=await owner.apply(studio,decision(snapshot));expect(held.afterBudget.pending).toBe(true);const actual=e.adoption.status(studio,e.unit,e.targets[0]).actions[0];expect(actual).toEqual(unknown)
 })
 it('retains exhausted allowance and cannot turn closing unused approval into a fresh budget',async()=>{
  const e=await productionDispositionSetup();e.seedOther(['earlier']);await e.approve();e.prepare();const snapshot=await e.owner.inspect(studio,e.unit),a=snapshot.actions.find(a=>a.reference.actionId===e.job().pendingHandoff.eventId)!,p=e.job().pendingHandoff
  const i=decision(snapshot,a.reference,{jobId:e.job().id,claimEventId:p.claimEventId,newClaimEventId:p.newClaimEventId,candidateId:p.accountCandidateId})
  const receipt=await e.deps.coordinator.withLease(e.authority,(f:any)=>f.recoveryDisposition({action:'apply',intent:i}));expect(receipt.afterBudget).toMatchObject({used:3,exhausted:true,pending:false})
 })
 it('rejects stale family snapshots and conflicting immutable decisions',async()=>{
  const e=await retained(),owner=disposition(e),snapshot=await owner.inspect(studio,e.unit);e.stopRecovery('pause');await expect(owner.apply(studio,decision(snapshot))).rejects.toThrow('changed')
  const current=await owner.inspect(studio,e.unit),i=decision(current);await owner.apply(studio,i);await expect(owner.apply(studio,{...i,inspectionToken:'f'.repeat(64)})).rejects.toThrow('identity')
 })
 it('terminally fences an unapplied expired decision, without clearing the original pending effect',async()=>{
  const e=await setup(),v=await e.prepareAdoption();e.adoption.approve(studio,e.unit,e.targets[0],v.approval);const owner=disposition(e),snapshot=await owner.inspect(studio,e.unit),intent=decision(snapshot,snapshot.actions[0].reference)
  expect(owner.resolve(studio,intent)).toBeNull();e.advance(15000);await expect(owner.apply(studio,intent)).rejects.toThrow('expired');const receipt=owner.resolve(studio,intent)!;expect(receipt.state).toBe('not_applied_expired');expect(receipt.afterBudget).toMatchObject({used:1,pending:true});expect(await owner.apply(studio,intent)).toEqual(receipt);expect(e.adoption.status(studio,e.unit,e.targets[0]).actions[0].phase).toBe('reserved')
 })
 it('rolls back hold gates if saving the audit receipt fails',async()=>{
  const e=await retained(),owner=disposition(e),snapshot=await owner.inspect(studio,e.unit);e.db.exec("CREATE TRIGGER fail_disposition BEFORE INSERT ON managed_recovery_disposition_events BEGIN SELECT RAISE(ABORT,'audit failed'); END")
  const before=e.dump();await expect(owner.apply(studio,decision(snapshot))).rejects.toThrow('audit failed');expect(e.dump()).toEqual(before)
 })
 it('rejects phone roles, malformed bodies, foreign workspaces and action promotion fields',async()=>{
  const e=await retained(),owner=disposition(e),s=await owner.inspect(studio,e.unit);await expect(owner.inspect(phone('two'),e.unit)).rejects.toThrow('Studio');await expect(owner.apply(phone('two'),decision(s))).rejects.toThrow('Studio');await expect(owner.apply(studio,{...decision(s),resume:true})).rejects.toThrow()
  await expect(recoveryDispositionApi(new Request('https://relay/managed/recovery/disposition',{method:'POST',body:JSON.stringify({schema:RECOVERY_DISPOSITION_SCHEMA,workspaceId:'other',action:'inspect',unit:e.unit})}),studio,owner,'workspace')).rejects.toThrow('workspace')
 })
 it('refuses to close another family or unenrolled playbook as unused',async()=>{
  const e=await retained(),owner=disposition(e);e.seedOther(['original_transfer'],'unknown');const s=await owner.inspect(studio,e.unit),ref=s.actions.find(a=>a.reference.actionId==='original_transfer')!.reference
  await expect(owner.apply(studio,decision(s,ref))).rejects.toThrow('unenrolled');await expect(owner.apply(studio,decision(s,{...ref,unit:{...e.unit,attemptId:'other'}}))).rejects.toThrow('another')
 })
})
describe('production unused handoff disposition and original job CAS',()=>{
 it('blocks the unused successor before clearing a prepared pending intent, preserving proof and charges while off',async()=>{
  const e=await productionDispositionSetup();await e.approve();e.prepare();e.off();const original=structuredClone(e.job()),p=original.pendingHandoff,{snapshot}=await e.inspectDisposition()
  let decisionJob:any=null;const save=e.deps.save;e.deps.save=async(next:any,expected:any)=>{if(next.pendingRecoveryDisposition)decisionJob=structuredClone(next);return save(next,expected)}
  const result=await productionRecoveryDisposition('series',e.dispositionRequest('dispose',{inspectedAt:snapshot.checkedAt,inspectionToken:snapshot.inspectionToken,confirmation:CLOSE_UNUSED_CONFIRMATION}),e.deps)
  writeFileSync('/tmp/recovery-disposition/production-fixture.json',JSON.stringify({before:decisionJob,after:result.job},null,2));expect(result.job.pendingHandoff).toBeUndefined();expect(result.job.pendingRecoveryDisposition).toBeUndefined();expect(result.job.command).toEqual(original.command);expect(result.job.config).toEqual(original.config);expect(result.job.status).toBe('interrupted');expect(result.job.recoveryDispositionHistory).toHaveLength(1)
  expect(e.a.productionClaim(studio,e.unit.taskId,p.newClaimEventId).status).toBe('blocked_before_claim');expect(e.handoff.status(studio,e.unit).actions[0]).toMatchObject({phase:'safe_failure',proof:e.v.contextProof});expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:2,pending:false});expect(e.a.timeline(studio,e.unit.taskId).task.generation).toBe(1)
 })
 it('blocks an unissued pending approval before clearing its original local intent',async()=>{
  const e=await productionDispositionSetup();const original=e.authority.accountHandoff;e.authority.accountHandoff=async(op:any)=>{if(op.action==='approve')throw Error('request never sent');return original(op)};await expect(e.approve()).rejects.toThrow('never sent');e.authority.accountHandoff=original
  const p=structuredClone(e.job().pendingHandoff),{snapshot}=await e.inspectDisposition();await productionRecoveryDisposition('series',e.dispositionRequest('dispose',{inspectedAt:snapshot.checkedAt,inspectionToken:snapshot.inspectionToken,confirmation:CLOSE_UNUSED_CONFIRMATION}),e.deps)
  expect(e.job().pendingHandoff).toBeUndefined();expect(sharedRecoveryBudget(e.sql,e.unit).used).toBe(1);expect(e.a.productionClaim(studio,e.unit.taskId,p.newClaimEventId).status).toBe('blocked_before_claim')
  await expect(e.deps.coordinator.withLease(e.authority,(f:any)=>f.accountHandoff({action:'approve',unit:e.unit,approval:{actionId:p.eventId,candidateId:p.accountCandidateId,revision:0,confirmation:HANDOFF_CONFIRMATION,production:{jobId:'original_job',claimEventId:p.claimEventId,newClaimEventId:p.newClaimEventId}}}))).rejects.toThrow('unused')
 })
 it('reconciles a lost disposition response using the original event, without another charge or replacement intent',async()=>{
  const e=await productionDispositionSetup();await e.approve();e.prepare();const {snapshot}=await e.inspectDisposition(),send=e.authority.recoveryDisposition;let lose=true
  e.authority.recoveryDisposition=async(op:any)=>{const v=await send(op);if(op.action==='apply'&&lose){lose=false;throw Error('lost reply')}return v}
  await expect(productionRecoveryDisposition('series',e.dispositionRequest('dispose',{inspectedAt:snapshot.checkedAt,inspectionToken:snapshot.inspectionToken,confirmation:CLOSE_UNUSED_CONFIRMATION}),e.deps)).rejects.toThrow('lost reply');const i=structuredClone(e.job().pendingRecoveryDisposition);e.advance(20000)
  await productionRecoveryDisposition('series',e.dispositionRequest('reconcile'),e.deps);expect(e.job().recoveryDispositionHistory[0].receipt.intent).toEqual(i);expect(sharedRecoveryBudget(e.sql,e.unit).used).toBe(2)
 })
 it('retains pending handoff when the saved disposition expired without applying',async()=>{
  const e=await productionDispositionSetup();await e.approve();const {snapshot}=await e.inspectDisposition(),send=e.authority.recoveryDisposition
  e.authority.recoveryDisposition=async(op:any)=>{if(op.action==='apply')throw Error('not delivered');return send(op)}
  await expect(productionRecoveryDisposition('series',e.dispositionRequest('dispose',{inspectedAt:snapshot.checkedAt,inspectionToken:snapshot.inspectionToken,confirmation:CLOSE_UNUSED_CONFIRMATION}),e.deps)).rejects.toThrow('not delivered');const p=structuredClone(e.job().pendingHandoff);e.advance(15000);e.authority.recoveryDisposition=send
  await productionRecoveryDisposition('series',e.dispositionRequest('reconcile'),e.deps);expect(e.job().pendingHandoff).toEqual(p);expect(e.job().pendingRecoveryDisposition).toBeUndefined();expect(e.job().recoveryDispositionHistory[0].receipt.state).toBe('not_applied_expired');expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:2,pending:true})
 })
 it('never clears a committed handoff as unused after a lost local save',async()=>{
  const e=await productionDispositionSetup();await e.approve();e.prepare();e.failSave();await expect(e.finish()).rejects.toThrow('CAS');e.failSave(false);const p=structuredClone(e.job().pendingHandoff),{snapshot}=await e.inspectDisposition()
  await expect(productionRecoveryDisposition('series',e.dispositionRequest('dispose',{inspectedAt:snapshot.checkedAt,inspectionToken:snapshot.inspectionToken,confirmation:CLOSE_UNUSED_CONFIRMATION}),e.deps)).rejects.toThrow('committed');expect(e.job().pendingHandoff).toEqual(p);expect(e.a.timeline(studio,e.unit.taskId).task.generation).toBe(2)
 })
 it('rolls back action closure and successor claim barrier when audit write fails',async()=>{
  const e=await productionDispositionSetup();await e.approve();e.prepare();const p=e.job().pendingHandoff,{snapshot}=await e.inspectDisposition();e.db.exec("CREATE TRIGGER audit_failure BEFORE INSERT ON managed_recovery_disposition_events BEGIN SELECT RAISE(ABORT,'audit failed'); END")
  await expect(productionRecoveryDisposition('series',e.dispositionRequest('dispose',{inspectedAt:snapshot.checkedAt,inspectionToken:snapshot.inspectionToken,confirmation:CLOSE_UNUSED_CONFIRMATION}),e.deps)).rejects.toThrow('audit failed');expect(e.a.productionClaim(studio,e.unit.taskId,p.newClaimEventId).status).toBe('missing');expect(e.handoff.status(studio,e.unit).actions[0].phase).toBe('prepared');expect(e.job().pendingHandoff).toEqual(p)
 })
 it('requires a current coordinator and exact production metadata, including for already cancelled approvals',async()=>{
  const e=await productionDispositionSetup();await e.approve();e.prepare();const p=e.job().pendingHandoff,s=await e.owner.inspect(studio,e.unit),ref=s.actions.find(a=>a.reference.actionId===p.eventId)!.reference,i=decision(s,ref,{jobId:e.job().id,claimEventId:p.claimEventId,newClaimEventId:p.newClaimEventId,candidateId:p.accountCandidateId})
  await expect(e.owner.apply(studio,i)).rejects.toThrow('coordinator');await expect(e.owner.apply(studio,i,{coordinatorId:'stale',coordinatorGeneration:2})).rejects.toThrow('coordinator')
 })
})

describe('durable disposition receipts and original stop history',()=>{
 it('retains the original decision, family hold and charge after SQLite close/reopen',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'family-disposition-'));temporary.push(dir);const file=path.join(dir,'authority.sqlite'),e=await setup('unsent',true,file),v=await e.prepareAdoption();e.adoption.approve(studio,e.unit,e.targets[0],v.approval)
  const owner=disposition(e),snapshot=await owner.inspect(studio,e.unit),intent=decision(snapshot),receipt=await owner.apply(studio,intent);e.db.close();opened.splice(opened.indexOf(e.db),1)
  const db=new DatabaseSync(file);opened.push(db);const sql:any={exec:(q:string,...args:any[])=>({toArray:()=>db.prepare(q).all(...args)})},tx=<T>(f:()=>T)=>{db.exec('SAVEPOINT disposition');try{const value=f();db.exec('RELEASE disposition');return value}catch(error){db.exec('ROLLBACK TO disposition');db.exec('RELEASE disposition');throw error}},a=new TaskAuthority(sql,tx,()=>new Date(e.now()).toISOString()),reopened=new RecoveryDispositionAuthority(sql,tx,a,new RecoveryStops(sql,tx,a,new AccountRecheckRecovery(sql,tx,a,e.now),e.now),new AccountHandoffAuthority(sql,tx,a,e.contexts,()=>false,e.now),e.adoption,e.now)
  expect(reopened.resolve(studio,intent)).toEqual(receipt);expect(await reopened.apply(studio,intent)).toEqual(receipt);expect(sharedRecoveryBudget(sql,e.unit)).toMatchObject({used:1,pending:true});expect(()=>assertRecoveryControls(sql,e.unit)).toThrow()
 })
 it('retains family cancellation without replacing it with a resumable pause',async()=>{
  const e=await retained();e.stopRecovery('cancel');const owner=disposition(e),snapshot=await owner.inspect(studio,e.unit),receipt=await owner.apply(studio,decision(snapshot));expect(receipt.stop.mode).toBe('cancel');expect(()=>assertRecoveryControls(e.sql,e.unit)).toThrow();expect(receipt.afterBudget.used).toBe(1)
 })
})

describe('disposition across successor lineage',()=>{
 it('holds the original family after handoff without changing successor ownership or reservations',async()=>{
  const e=await productionDispositionSetup();await e.approve();e.prepare();await e.finish();const current=e.a.timeline(studio,e.unit.taskId),unit={...e.unit,attemptId:current.attempt!.id,generation:2},before=e.db.prepare('SELECT resource,attempt_id FROM managed_reservations ORDER BY resource').all()
  const snapshot=await e.owner.inspect(studio,unit);expect(snapshot.units).toHaveLength(2);expect(snapshot.root).toEqual(e.unit);const receipt=await e.owner.apply(studio,decision(snapshot));expect(receipt.afterBudget.used).toBe(2);expect(e.a.timeline(studio,e.unit.taskId).attempt!.id).toBe(unit.attemptId);expect(e.db.prepare('SELECT resource,attempt_id FROM managed_reservations ORDER BY resource').all()).toEqual(before);expect(()=>assertRecoveryControls(e.sql,unit)).toThrow()
 })
 it('rejects an unused production disposition with another original job identity under a current lease',async()=>{
  const e=await productionDispositionSetup();await e.approve();const p=e.job().pendingHandoff,s=await e.owner.inspect(studio,e.unit),ref=s.actions.find(a=>a.reference.actionId===p.eventId)!.reference,intent=decision(s,ref,{jobId:'other_job',claimEventId:p.claimEventId,newClaimEventId:p.newClaimEventId,candidateId:p.accountCandidateId})
  await expect(e.deps.coordinator.withLease(e.authority,(f:any)=>f.recoveryDisposition({action:'apply',intent}))).rejects.toThrow('identity');expect(e.a.productionClaim(studio,e.unit.taskId,p.newClaimEventId).status).toBe('missing');expect(e.handoff.status(studio,e.unit).actions[0].phase).toBe('reserved')
 })
})
