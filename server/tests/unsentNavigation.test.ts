import {UnsentNavigation} from '../../relay/src/unsentNavigation.js'
import {NAVIGATION_SCHEMA,navigationProof,parseNavigationRecord} from '../src/services/unsentNavigationProtocol.js'
import {assertRecoveryReservation} from '../../relay/src/recoveryBudget.js'
import {RecoveryStops} from '../../relay/src/recoveryStops.js'
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
const CAPS=['unsent-navigation-recovery/1','managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','account-audit/1','account-selection/1']
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
 now+=1000;a.accounts.quota(studio,event(),null,{accountId:'shared',scope:{...scope,feature:'uploads'},state:'available',evidence:'owner_supplied',observedAt:now,recheckAt:null})
 for(const phase of ['accepted','started'] as const)a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,phase,null,claim.command.id)

 const unit={workspaceId:'workspace',taskId:task.id,attemptId:claim.attempt.id,generation:claim.attempt.generation,fingerprint:task.fingerprint}
 const fence={unit,commandId:claim.command.id,deviceId:'one',profileId:'profile',bindingId:'original_view',sourceSha256:'a'.repeat(64),accountId:'shared',policyRevision:1}
 const recovery=new UnsentNavigation(sql,tx,a,()=>now)
 const proof=(ready=false)=>({schema:'managed-session-evidence/1',bindingId:fence.bindingId,commandId:fence.commandId,profileId:fence.profileId,fingerprint:unit.fingerprint,cachedSourceSha256:fence.sourceSha256,observedAt:now,documentKind:'chatgpt_home',ready,composer:'empty',attachments:'none',response:'none',login:'unknown',exactView:true,currentProfile:true,cachedSourceVerified:true,untouched:true,context:ready?'empty_unsent':'held'})
 const env:ManagedTaskEnvironment={MANAGED_AUTOMATIC_RECOVERY:'1',MANAGED_CROP_PAGE:'1',MANAGED_UNSENT_NAVIGATION_RECOVERY:'1',MANAGED_WORKSPACE_ID:'workspace',MANAGED_STUDIO_TOKEN:'s'.repeat(40),MANAGED_DEVICE_TOKENS:JSON.stringify({one:'o'.repeat(40),two:'t'.repeat(40)})}
 const api=(action:string,details:Record<string,unknown>={},f:unknown=fence,token='o'.repeat(40))=>new ManagedTaskApi(sql,tx,env,()=>new Date(now).toISOString()).handle(new Request('https://fixture/managed/recovery/unsent-navigation',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({schema:NAVIGATION_SCHEMA,action,fence:f,details})}))
 const record=()=>recovery.discover(studio,unit)!,offer=()=>recovery.offer(phone(),fence,proof()),enable=()=>recovery.control(studio,fence,record().revision,true,false,false),reserve=(id='original_reload')=>recovery.reserve(studio,fence,record().revision,id),start=(id='original_reload')=>recovery.start(phone(),fence,id,proof())
 const snapshot=()=>({task:a.timeline(studio,task.id),reservations:db.prepare('SELECT * FROM managed_reservations ORDER BY resource').all(),quota:db.prepare('SELECT * FROM managed_account_quotas ORDER BY id').all(),policy:db.prepare("SELECT * FROM managed_account_policies WHERE id='crop_json'").all()})
 const mutate=(table:string,id:string,work:(r:any)=>void)=>{const r=JSON.parse(db.prepare('SELECT body FROM '+table+' WHERE id=?').get(id).body);work(r);db.prepare('UPDATE '+table+' SET body=? WHERE id=?').run(JSON.stringify(r),id)}
 return {a,db,sql,tx,event,policy,claim,recovery,unit,fence,env,api,record,offer,enable,reserve,start,proof,snapshot,mutate,advance:(ms=1)=>now+=ms,now:()=>now}
}
describe('one original empty-home reload',()=>{
 it('charges exactly once, verifies the actual original postcondition and changes no task resources',async()=>{
  const e=await setup(),before=e.snapshot();e.offer();expect(e.record().enabled).toBe(false);e.enable();e.reserve();e.start()
  expect(()=>e.start()).toThrow();expect(e.recovery.budget(e.unit)).toMatchObject({used:1,pending:true})
  e.advance();const after=e.proof(true);e.recovery.finish(phone(),e.fence,'original_reload','verified','reloaded',after)
  expect(e.record().actions[0]).toMatchObject({phase:'verified',effect:'reloaded',after});expect(e.snapshot()).toEqual(before)
  const saved=e.record();e.advance(180000);expect(e.recovery.finish(phone(),e.fence,'original_reload','verified','reloaded',after)).toEqual(saved)
  expect(()=>e.reserve('again')).toThrow();expect(e.recovery.budget(e.unit)).toMatchObject({used:1,pending:false})
 })
 it('retains unknown across restart and only reconciles the same actual view without another grant',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start();e.recovery.finish(phone(),e.fence,'original_reload','unknown','possible',null)
  expect(()=>e.recovery.finish(phone(),e.fence,'original_reload','safe_failure','not_touched',null)).toThrow('uncertain');expect(()=>e.recovery.finish(phone(),e.fence,'original_reload','verified','not_touched',e.proof(true))).toThrow('uncertain')
  const restart=new UnsentNavigation(e.sql,e.tx,e.a,e.now);expect(()=>e.reserve('again')).toThrow();expect(()=>assertRecoveryReservation(e.sql,e.unit,'other_adapter',e.now())).toThrow('reconciliation')
  e.advance();restart.finish(phone(),e.fence,'original_reload','verified','reloaded',e.proof(true));expect(e.record().actions[0].phase).toBe('verified')
 })
 it('accepts exact outcomes while off/cancelled/expired, without renewing or releasing original ownership',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start();e.recovery.control(studio,e.fence,e.record().revision,false,true,true);e.env.MANAGED_UNSENT_NAVIGATION_RECOVERY='0';e.advance(3600000)
  const before=e.snapshot(),response=await e.api('finish',{actionId:'original_reload',outcome:'verified',effect:'reloaded',proof:e.proof(true)})
  expect(response!.status).toBe(200);expect(e.record()).toMatchObject({cancelled:true,actions:[{phase:'verified'}]});expect(e.snapshot()).toEqual(before)
 })
 it('withdraws an unused grant with its spent budget and cooldown, including while globally off',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.env.MANAGED_UNSENT_NAVIGATION_RECOVERY='0'
  expect((await e.api('finish',{actionId:'original_reload',outcome:'safe_failure',effect:'not_touched',proof:null}))!.status).toBe(200)
  expect(e.recovery.budget(e.unit)).toMatchObject({used:1,pending:false,nextEligibleAt:e.now()+30000});expect(()=>e.reserve('early')).toThrow('cooldown')
  e.advance(30000);e.reserve('second');expect(e.record().actions).toHaveLength(2)
  const saved=e.record();expect(e.recovery.finish(phone(),e.fence,'original_reload','safe_failure','not_touched',null)).toEqual(saved)
 })
 it('does no work for an already-ready page and rejects invented readiness or changed context',async()=>{
  const e=await setup();expect(()=>e.recovery.offer(phone(),e.fence,e.proof(true))).toThrow();expect(e.recovery.discover(studio,e.unit)).toBeNull()
  e.offer();e.enable();e.reserve();e.start()
  for(const patch of [{ready:false,context:'held'},{bindingId:'new_view'},{documentKind:'chatgpt_conversation'},{composer:'nonempty'},{attachments:'present'},{response:'active'},{login:'signed_out'},{observedAt:e.now()+1},{untouched:false},{currentProfile:false}])expect(()=>e.recovery.finish(phone(),e.fence,'original_reload','verified','reloaded',{...e.proof(true),...patch})).toThrow()
  expect(()=>e.recovery.finish(phone(),e.fence,'original_reload','unknown','not_touched',null)).toThrow();expect(e.record().actions[0].phase).toBe('executing')
 })
 it.each(['policy','quota','identity','lease','capability','reservation','capacity','future_time'])('holds changed %s at the immediate pre-action check',async kind=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start()
  if(kind==='policy')e.mutate('managed_account_policies','crop_json',r=>r.allowUnknownQuota=true)
  if(kind==='quota'){const id=e.db.prepare('SELECT id FROM managed_account_quotas LIMIT 1').get().id;e.mutate('managed_account_quotas',id,r=>r.state='unknown')}
  if(kind==='identity'||kind==='future_time'){const id=e.db.prepare('SELECT id FROM managed_account_profiles WHERE body LIKE ?').get('%"deviceId":"one"%').id;e.mutate('managed_account_profiles',id,r=>kind==='identity'?r.links.chatgpt.accountId='foreign':r.observation.checkedAt=e.now()+1)}
  if(kind==='lease')e.advance(3600000)
  if(kind==='capability')e.mutate('managed_peers','one',r=>r.capabilities=[])
  if(kind==='reservation')e.db.prepare('DELETE FROM managed_reservations WHERE resource=?').run('browser:one')
  if(kind==='capacity')e.mutate('managed_account_accounts','shared',r=>r.maxConcurrent=0)
  expect(()=>e.recovery.check(phone(),e.fence,'original_reload',e.proof())).toThrow();expect(e.record().actions[0].phase).toBe('executing')
 })
 it('keeps the shared three-action ceiling and cooldown after known no-touch failures',async()=>{
  const e=await setup();e.offer();e.enable()
  for(let n=0;n<3;n++){e.reserve('grant_'+n);e.recovery.finish(phone(),e.fence,'grant_'+n,'safe_failure','not_touched',null);e.advance(30000)}
  expect(e.recovery.budget(e.unit)).toMatchObject({used:3,exhausted:true});expect(()=>e.reserve('fourth')).toThrow('exhausted')
 })
 it('freezes navigation on retained stop and preparation never resumes its old executing grant',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start();const before=e.snapshot(),stops=new RecoveryStops(e.sql,e.tx,e.a,new AccountRecheckRecovery(e.sql,e.tx,e.a,e.now),e.now)
  const intent={schema:'recovery-stop/1',unit:e.unit,eventId:'stop_navigation',sequence:1,mode:'pause'}
  stops.apply(studio,intent);expect(e.record()).toMatchObject({enabled:false,paused:true,actions:[{phase:'executing'}]});expect(()=>e.recovery.check(phone(),e.fence,'original_reload',e.proof())).toThrow()
  stops.apply(studio,{...intent,eventId:'prepare_navigation',sequence:2,mode:'reinspect'});expect(e.record()).toMatchObject({enabled:false,paused:true});expect(e.snapshot()).toEqual(before)
 })
 it('enforces default-off, actor, exact fence and bounded request fields at the API',async()=>{
  const e=await setup();delete e.env.MANAGED_UNSENT_NAVIGATION_RECOVERY
  expect((await e.api('discover',{},e.unit))!.status).toBe(200);expect((await e.api('offer',{proof:e.proof()}))!.status).toBe(503)
  e.env.MANAGED_UNSENT_NAVIGATION_RECOVERY='1';e.offer();e.enable();e.reserve()
  expect((await e.api('start',{actionId:'original_reload',proof:e.proof()},e.fence,'t'.repeat(40)))!.status).toBe(409)
  expect((await e.api('start',{actionId:'original_reload',proof:e.proof(),force:true}))!.status).toBe(409)
  expect((await e.api('start',{actionId:'original_reload',proof:e.proof()},{...e.fence,bindingId:'replacement'}))!.status).toBe(409)
 })
})
