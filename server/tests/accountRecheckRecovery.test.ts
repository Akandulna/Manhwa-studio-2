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
describe('bounded account recheck through the existing idle audit owner',()=>{
 it('holds before the scoped reset deadline, then requests one audit without touching task, quotas, pins or reservations',async()=>{
  const e=await setup(),before=e.snapshot();expect(()=>e.enable()).toThrow('elapsed recheck')
  e.advance();const enabled=e.enable();expect(enabled.actions).toHaveLength(0)
  e.request();expect(e.record()!.actions[0]).toMatchObject({phase:'executing',auditId:null})
  expect(e.snapshot()).toEqual(before)
  expect(()=>e.request('duplicate')).toThrow('bounded')
 })
 it('uses the original scheduler claim and verifies source time, exact cleanup and still-blocked quota',async()=>{
  const e=await setup();e.advance();e.enable();e.request();const before=e.snapshot(),audit=e.event()
  e.a.accounts.auditClaim(phone('two'),audit,'profile');expect(e.record()!.actions[0].auditId).toBe(audit)
  expect(e.recovery.status(studio,e.fence).budget).toMatchObject({used:1,pending:true})
  await e.finish(audit);const action=e.record()!.actions[0]
  expect(action).toMatchObject({phase:'verified',auditId:audit,result:'quota_blocked',checkedAt:e.now()})
  expect(e.snapshot()).toEqual(before);expect(e.a.accounts.snapshot(studio).profiles.find(p=>p.deviceId==='two')!.audit.lastSuccessfulAt).toBe(action.checkedAt)
  expect(()=>e.request('again')).toThrow('bounded')
 })
 it('defers the original busy phone without stealing its browser, claim or account slot',async()=>{
  const e=await setup();e.advance();const fence=e.recovery.discover(studio,e.unit).targets.find(f=>f.deviceId==='one')!,before=e.snapshot()
  const r=e.recovery.control(studio,fence,0,true,false,false);e.recovery.request(studio,fence,r.revision,'busy_request')
  expect(e.a.accounts.auditClaim(phone(),e.event(),'profile')).toMatchObject({state:'deferred',reason:'busy'})
  expect(e.recovery.inspect(studio,fence)!.actions[0].auditId).toBeNull();expect(e.snapshot()).toEqual(before)
 })
 it('preserves failed-audit history/cooldown and never treats unknown as recovered capacity',async()=>{
  const e=await setup();e.advance();e.enable();e.request();const id=e.event();e.a.accounts.auditClaim(phone('two'),id,'profile')
  e.a.accounts.auditFinish(phone('two'),e.event(),id,null)
  expect(e.record()!.actions[0]).toMatchObject({phase:'safe_failure',result:'unknown'})
  expect(e.a.accounts.snapshot(studio).profiles.find(p=>p.deviceId==='two')!.audit.lastSuccessfulAt).toBeNull()
  expect(()=>e.request('early')).toThrow('cooldown');e.advance(15*60_000);e.touch();e.request('after_cooldown')
  expect(e.record()!.actions).toHaveLength(2);expect(e.snapshot().quota[0].body).toContain('blocked')
 })
 it.each(['signed_out','identity_changed'] as const)('records %s as an owner decision without changing links or quota',async outcome=>{
  const e=await setup();e.advance();e.enable();e.request();const id=e.event();e.a.accounts.auditClaim(phone('two'),id,'profile')
  await e.finish(id,outcome!=='signed_out',outcome==='identity_changed'?'different@example.com':'same@example.com')
  expect(e.record()!.actions[0]).toMatchObject({phase:'verified',result:outcome})
  const profile=e.a.accounts.snapshot(studio).profiles.find(p=>p.deviceId==='two')!;expect(profile.links.chatgpt!.accountId).toBe('shared')
  expect(e.snapshot().quota[0].body).toContain('blocked')
 })
 it('continues a running original audit outcome while admission is off or recovery is cancelled',async()=>{
  const e=await setup();e.advance();e.enable();e.request();const id=e.event();e.a.accounts.auditClaim(phone('two'),id,'profile');const old=e.record()!
  e.recovery.control(studio,e.fence,old.revision,true,false,true);e.env.MANAGED_ACCOUNT_RECHECK_RECOVERY='0'
  await e.finish(id)
  expect(e.record()!).toMatchObject({cancelled:true,actions:[{phase:'verified',result:'quota_blocked'}]})
  expect((await e.api('request',{revision:e.record()!.revision,actionId:'new'})).status).toBe(503)
 })
 it('retains an interrupted running audit across new handler instances without another claim or expiry cleanup',async()=>{
  const e=await setup();e.advance();e.enable();e.request();const id=e.event();e.a.accounts.auditClaim(phone('two'),id,'profile')
  new AccountRecheckRecovery(e.sql,e.tx,e.a,e.now);e.advance(60*60_000)
  expect(e.a.accounts.auditClaim(phone('two'),id,'profile').id).toBe(id)
  expect(e.record()!.actions[0].auditId).toBe(id)
  expect(e.a.accounts.snapshot(studio).reservations.filter(r=>r.attempt_id==='audit:'+id)).toHaveLength(3)
  e.a.accounts.auditFinish(phone('two'),e.event(),id,null);expect(e.record()!.actions[0].phase).toBe('safe_failure')
 })
 it('enforces the Studio role, default-off gate, exact scope/profile/policy pins and no force fields',async()=>{
  const e=await setup();delete e.env.MANAGED_ACCOUNT_RECHECK_RECOVERY
  expect((await e.api('discover',{},e.unit)).status).toBe(200)
  expect((await e.api('control',{revision:0,enabled:true,paused:false,cancelled:false})).status).toBe(503)
  expect((await e.api('inspect',{},e.fence,'t'.repeat(40))).status).toBe(403)
  e.env.MANAGED_ACCOUNT_RECHECK_RECOVERY='1';e.advance()
  for(const f of [{...e.fence,accountId:'other'},{...e.fence,policyRevision:2},{...e.fence,scope:{...e.fence.scope,feature:'voice'}},{...e.fence,candidate:'openai:'+'c'.repeat(64)}])expect((await e.api('control',{revision:0,enabled:true,paused:false,cancelled:false},f)).status).toBe(409)
  expect((await e.api('request',{revision:0,actionId:'force',force:true})).status).toBe(409)
  expect(e.record()).toBeNull()
 })
 it('never creates a fake attempt or recovery budget for pre-claim waiting tasks',async()=>{
  const e=await setup(),queued=await e.a.plan(studio,e.event(),{workspaceId:'workspace',seriesId:'series',chapterId:'chapter',pageId:'new_page'},spec)
  const unit={...e.unit,taskId:queued.id,fingerprint:queued.fingerprint,attemptId:'invented'}
  expect(()=>e.recovery.discover(studio,unit)).toThrow('Stale attempt');expect(e.record()).toBeNull()
 })
})
describe('queued withdrawal and shared recovery bounds',()=>{
 it('withdraws a cancelled queued request and restores the original successful cadence without creating an audit',async()=>{
  const e=await setup(),initial=e.event();e.a.accounts.auditClaim(phone('two'),initial,'profile');await e.finish(initial)
  e.a.accounts.cadence(studio,e.event(),'two','profile',48)
  const original=structuredClone(e.a.accounts.snapshot(studio).profiles.find(p=>p.deviceId==='two')!.audit)
  e.advance();e.enable();e.request();e.recovery.control(studio,e.fence,e.record()!.revision,true,false,true)
  expect(e.record()!.actions[0]).toMatchObject({phase:'safe_failure',auditId:null,result:'withdrawn'})
  expect(e.a.accounts.snapshot(studio).profiles.find(p=>p.deviceId==='two')!.audit).toEqual(original)
  expect(e.a.accounts.auditClaim(phone('two'),e.event(),'profile')).toMatchObject({state:'deferred',reason:'not_due'})
  expect(e.recovery.status(studio,e.fence).budget.used).toBe(1)
  expect(()=>e.a.accounts.requestAudit(studio,e.event(),'two','profile')).toThrow('once per 15 minutes')
 })
 it('withdraws queued recovery on the off switch before a new scheduler claim, preserving normal cadence',async()=>{
  const e=await setup(),initial=e.event();e.a.accounts.auditClaim(phone('two'),initial,'profile');await e.finish(initial)
  const original=e.a.accounts.snapshot(studio).profiles.find(p=>p.deviceId==='two')!.audit
  e.advance();e.enable();e.request();e.env.MANAGED_ACCOUNT_RECHECK_RECOVERY='0'
  const r=await new ManagedTaskApi(e.sql,e.tx,e.env,()=>new Date(e.now()).toISOString()).handle(new Request('https://fixture/managed/accounts/operation',{method:'POST',headers:{Authorization:'Bearer '+'t'.repeat(40)},body:JSON.stringify({schema:'managed-accounts/1',workspaceId:'workspace',action:'audit_claim',profileId:'profile',eventId:e.event()})}))
  expect((await r.json()).result).toMatchObject({state:'deferred',reason:'not_due'})
  expect(e.record()!.actions[0].result).toBe('withdrawn');expect(e.a.accounts.snapshot(studio).profiles.find(p=>p.deviceId==='two')!.audit).toEqual(original)
 })
 it('does not block an independently due normal audit or credit it to a withdrawn repair',async()=>{
  const e=await setup();e.advance();e.enable();e.request();e.recovery.control(studio,e.fence,e.record()!.revision,true,true,false)
  const id=e.event();expect(e.a.accounts.auditClaim(phone('two'),id,'profile').state).toBe('running');await e.finish(id)
  expect(e.record()!.actions[0]).toMatchObject({phase:'safe_failure',result:'withdrawn',auditId:null})
 })
 it('never rewinds a newer explicit owner scheduling edit when withdrawing its older request',async()=>{
  const e=await setup();e.advance();e.enable();e.request();e.advance(15*60_000);e.touch()
  e.a.accounts.cadence(studio,e.event(),'two','profile',48);const requested=e.a.accounts.requestAudit(studio,e.event(),'two','profile')
  e.recovery.control(studio,e.fence,e.record()!.revision,true,false,true)
  expect(e.a.accounts.snapshot(studio).profiles.find(p=>p.deviceId==='two')!.audit).toEqual(requested.audit)
  expect(e.record()!.actions[0].result).toBe('withdrawn')
 })
 it('keeps the three-action ceiling and failed-audit cooldown across recovery restarts',async()=>{
  const e=await setup();e.advance();e.enable()
  for(let i=1;i<=3;i++){
   e.request('request_'+i);const audit=e.event();e.a.accounts.auditClaim(phone('two'),audit,'profile');e.a.accounts.auditFinish(phone('two'),e.event(),audit,null)
   e.advance(15*60_000);e.touch();new AccountRecheckRecovery(e.sql,e.tx,e.a,e.now)
  }
  expect(e.recovery.status(studio,e.fence).budget).toMatchObject({used:3,exhausted:true,pending:false})
  expect(()=>e.request('fourth')).toThrow('budget exhausted')
  expect(e.a.accounts.snapshot(studio).reservations.some(r=>r.attempt_id.startsWith('audit:'))).toBe(false)
 })
})

describe('claim-time revalidation',()=>{
 it('withdraws the old recovery before a newer independent owner audit claims',async()=>{
  const e=await setup();e.advance();e.enable();e.request();e.advance(15*60_000);e.touch()
  e.a.accounts.requestAudit(studio,e.event(),'two','profile');const id=e.event()
  e.a.accounts.auditClaim(phone('two'),id,'profile');await e.finish(id)
  expect(e.record()!.actions[0]).toMatchObject({result:'withdrawn',auditId:null});expect(e.snapshot().quota[0].body).toContain('blocked')
 })
 it('withdraws a queued recovery after its pinned policy changes without mutating quota',async()=>{
  const e=await setup();e.advance();e.enable();e.request()
  e.a.accounts.setPolicy(studio,e.event(),{...e.policy,revision:2})
  e.a.accounts.auditClaim(phone('two'),e.event(),'profile')
  expect(e.record()!.actions[0]).toMatchObject({result:'withdrawn',auditId:null});expect(e.snapshot().quota[0].body).toContain('blocked')
 })
})

describe('one budget across all three enrolled operations',()=>{
 it('counts import/upload failures before admitting only the third account action',async()=>{
  const e=await setup();e.advance();const f={...e.unit,artifactId:'saved',sha256:'d'.repeat(64)},key=savedImportKey(f)
  const action=(id:string)=>({id,phase:'safe_failure',at:e.now(),finishedAt:e.now(),evidenceRef:'evidence/'+id})
  e.sql.exec('INSERT INTO managed_recovery_episodes (id,body) VALUES (?,?)',key,JSON.stringify({schema:'saved-crop-import-recovery/1',fence:f,destinationId:'e'.repeat(64),revision:1,enabled:true,paused:false,cancelled:false,nextEligibleAt:0,actions:[action('import_failed')]}))
  e.sql.exec('INSERT INTO managed_upload_recovery_episodes (id,body) VALUES (?,?)',key,JSON.stringify({schema:'saved-crop-upload-recovery/1',fence:{...f,commandId:'original',checkpointRef:'checkpoint/original'},revision:1,enabled:true,paused:false,cancelled:false,nextEligibleAt:0,actions:[action('upload_failed')]}))
  e.enable();e.request();expect(sharedRecoveryBudget(e.sql,e.unit)).toMatchObject({used:3,pending:true,exhausted:true})
  const id=e.event();e.a.accounts.auditClaim(phone('two'),id,'profile');e.a.accounts.auditFinish(phone('two'),e.event(),id,null)
  e.advance(15*60_000);e.touch();expect(()=>e.request('fourth')).toThrow('budget exhausted')
 })
})
