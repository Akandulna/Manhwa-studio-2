import {CorrectionRecovery} from '../../relay/src/correctionRecovery.js'
import {RetainedBindingApprovalBridge,parseRetainedBindingView} from '../src/services/retainedBindingApprovalBridge.js'
import {ConversationRestorationBridge} from '../src/services/conversationRestorationBridge.js'
import {ConversationRestoration} from '../../relay/src/conversationRestoration.js'
import {CONVERSATION_SCHEMA,parseConversationRecord,conversationProof} from '../src/services/conversationRestorationProtocol.js'
import {canonicalJson} from '../src/services/managedTaskProtocol.js'
import {artifactHash} from '../src/services/managedCropArtifact.js'
import {assertRecoveryReservation} from '../../relay/src/recoveryBudget.js'
import {RecoveryStops} from '../../relay/src/recoveryStops.js'
import {savedImportKey} from '../src/services/managedSavedImportRecoveryProtocol.js'
import {sharedRecoveryBudget} from '../../relay/src/recoveryBudget.js'
import {createRequire} from 'node:module'
import {afterEach,describe,it,expect} from 'vitest'
import {TaskAuthority} from '../../relay/src/taskAuthority.js'
import {AccountRecheckRecovery} from '../../relay/src/accountRecheckRecovery.js'
import {ManagedTaskApi,type ManagedTaskEnvironment} from '../../relay/src/managedTaskApi.js'
import {accountObservation,profileKey,type AccountPolicy} from '../src/services/managedAccountsProtocol.js'
import {ACCOUNT_RECHECK_SCHEMA,type AccountRecheckFence} from '../src/services/accountRecheckRecoveryProtocol.js'
import {DEFAULT_CROP_PROMPT} from '../src/services/managedCropPilotPolicy.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite'),opened:any[]=[]
afterEach(()=>{for(const db of opened.splice(0))db.close()})
const studio={role:'studio'} as const,phone=(deviceId='one')=>({role:'phone',deviceId} as const)
const CAPS=['retained-conversation-restoration/1','retained-binding-local-correction/1','managed-correction-recovery/1','retained-context-binding/1','original-conversation-restoration/1','managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','account-audit/1','account-selection/1']
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
 for(const phase of ['accepted','started','submission_intent','submitted'] as const)a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,phase,null,claim.command.id)

 const unit={workspaceId:'workspace',taskId:task.id,attemptId:claim.attempt.id,generation:claim.attempt.generation,fingerprint:task.fingerprint}
 const context={schema:'managed-correction-context/1' as const,capturedAt:now,bindingId:'original_view',sourceSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),promptSha256:'c'.repeat(64),replySha256:'d'.repeat(64),rawCheckpointRef:'checkpoint/raw',accountId:'shared',policyRevision:1,state:'scoped' as const,lockedCandidates:1,failedCandidates:1,lockedDigest:'e'.repeat(64),planDigest:'f'.repeat(64),executable:false as const,portable:false as const,liveConversationVerified:false as const}
 const fence={unit,commandId:claim.command.id,deviceId:'one',profileId:'profile',context,anchorSha256:'1'.repeat(64)}
 const recovery=new ConversationRestoration(sql,tx,a,()=>now)
 const proof=(restored=false)=>({schema:'original-conversation-proof/1' as const,observedAt:now,anchorSha256:fence.anchorSha256,bindingId:context.bindingId,commandId:fence.commandId,profileId:fence.profileId,fingerprint:unit.fingerprint,sourceSha256:context.sourceSha256,state:restored?'original_conversation':'empty_home',promptMatched:restored,replyMatched:restored,exactView:true,currentProfile:true,cachedSourceVerified:true,portable:false,resendAllowed:false})
 const env:ManagedTaskEnvironment={MANAGED_AUTOMATIC_RECOVERY:'1',MANAGED_CROP_PAGE:'1',MANAGED_CONVERSATION_RESTORATION:'1',MANAGED_WORKSPACE_ID:'workspace',MANAGED_STUDIO_TOKEN:'s'.repeat(40),MANAGED_DEVICE_TOKENS:JSON.stringify({one:'o'.repeat(40),two:'t'.repeat(40)})}
 const api=(action:string,details:Record<string,unknown>={},f:unknown=fence,token='o'.repeat(40))=>new ManagedTaskApi(sql,tx,env,()=>new Date(now).toISOString()).handle(new Request('https://fixture/managed/recovery/original-conversation',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({schema:CONVERSATION_SCHEMA,action,fence:f,details})}))
 const record=()=>recovery.discover(studio,unit)!,offer=()=>recovery.offer(phone(),fence,proof()),enable=()=>recovery.control(studio,fence,record().revision,true,false,false),reserve=(id='original_restore')=>recovery.reserve(studio,fence,record().revision,id),start=(id='original_restore')=>recovery.start(phone(),fence,id,proof())
 const snapshot=()=>({task:a.timeline(studio,task.id),reservations:db.prepare('SELECT * FROM managed_reservations ORDER BY resource').all(),quota:db.prepare('SELECT * FROM managed_account_quotas ORDER BY id').all(),policy:db.prepare("SELECT * FROM managed_account_policies WHERE id='crop_json'").all()})
 const mutate=(table:string,id:string,work:(r:any)=>void)=>{const r=JSON.parse(db.prepare('SELECT body FROM '+table+' WHERE id=?').get(id).body);work(r);db.prepare('UPDATE '+table+' SET body=? WHERE id=?').run(JSON.stringify(r),id)}
 return {a,db,sql,tx,event,policy,claim,recovery,unit,fence,env,api,record,offer,enable,reserve,start,proof,snapshot,mutate,advance:(ms=1)=>now+=ms,now:()=>now}
}
describe('read-only current authority for retained conversation inspection',()=>{
 function inspection(e:Awaited<ReturnType<typeof setup>>){const f=e.fence;return {schema:'retained-conversation-inspection/1',unit:f.unit,commandId:f.commandId,deviceId:f.deviceId,profileId:f.profileId,originalBindingId:f.context.bindingId,inspectionBindingId:'replacement_view',anchorSha256:f.anchorSha256,contextCapturedAt:f.context.capturedAt,anchorCapturedAt:e.now(),observedAt:e.now(),sourceSha256:f.context.sourceSha256,promptSha256:f.context.promptSha256,replySha256:f.context.replySha256,originalConversationMatched:true,currentProfile:true,cachedSourceVerified:true,exactOriginalView:false,authorityVerified:false,contextPortable:false,resendAllowed:false,executable:false}}
 it('checks the original owner with admission off and no episode, grant, budget or reservation changes',async()=>{
  const e=await setup(),r=inspection(e);e.env.MANAGED_CONVERSATION_RESTORATION='0'
  const before=e.snapshot(),budget=e.recovery.budget(e.unit)
  const response=await e.api('verify-retained-context',{inspection:r});expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store')
  const body=await response.json();expect(body.globalEnabled).toBe(false)
  expect(body.verification).toMatchObject({schema:'retained-context-authority-check/1',workspaceId:'workspace',authorityCurrent:true,checkedAt:e.now(),validUntil:e.now()+15000,executionAllowed:false,rebindAllowed:false,fallbackAllowed:false,resendAllowed:false})
  expect(body.verification.inspectionSha256).toBe(await artifactHash(new TextEncoder().encode(canonicalJson(r))))
  expect(body.verification.fenceSha256).toBe(await artifactHash(new TextEncoder().encode(canonicalJson(e.fence))))
  expect(e.snapshot()).toEqual(before);expect(e.recovery.budget(e.unit)).toEqual(budget);expect(e.record()).toBeNull()
 })
 it.each([{authorityVerified:true},{exactOriginalView:true},{executable:true},{resendAllowed:true},{contextPortable:true},{inspectionBindingId:'original_view'},{sourceSha256:'9'.repeat(64)},{promptSha256:'9'.repeat(64)},{replySha256:'9'.repeat(64)},{anchorSha256:'9'.repeat(64)},{profileId:'other'},{observedAt:1},{contextCapturedAt:1},{anchorCapturedAt:1},{url:'https://private.invalid'}])('rejects changed or promoted inspection %j',async patch=>{
  const e=await setup();expect((await e.api('verify-retained-context',{inspection:{...inspection(e),...patch}})).status).toBe(409);expect(e.recovery.budget(e.unit).used).toBe(0)
 })
 it('requires the original authenticated phone, not a different phone or Studio',async()=>{
  const e=await setup(),r=inspection(e)
  for(const token of ['t'.repeat(40),'s'.repeat(40),'invalid'])expect((await e.api('verify-retained-context',{inspection:r},e.fence,token)).status).not.toBe(200)
  expect(e.record()).toBeNull()
 })
 it.each(['task','owner','input','policy','account','lease','peer','reservation','profile','identity','observation','capacity','command','checkpoint','canonical'])('rechecks current %s authority rather than historical content',async kind=>{
  const e=await setup(),r=inspection(e)
  if(kind==='task')e.mutate('managed_tasks',e.unit.taskId,x=>{x.state='paused'})
  if(kind==='owner')e.mutate('managed_attempts',e.unit.attemptId,x=>{x.deviceId='two'})
  if(kind==='input')e.mutate('managed_tasks',e.unit.taskId,x=>{x.spec.pageRevision='r2'})
  if(kind==='policy')e.mutate('managed_account_policies','crop_json',x=>{x.revision++})
  if(kind==='account')e.mutate('managed_attempts',e.unit.attemptId,x=>{x.accountId='other'})
  if(kind==='lease')e.mutate('managed_attempts',e.unit.attemptId,x=>{x.leaseExpiresAt=new Date(e.now()+30000).toISOString()})
  if(kind==='peer')e.mutate('managed_peers','one',x=>{x.receivedAt=new Date(e.now()-15*60000).toISOString()})
  if(kind==='reservation')e.db.prepare('DELETE FROM managed_reservations WHERE resource=?').run('device:one')
  if(kind==='profile')e.mutate('managed_enrollment','one',x=>{x.profileId='other'})
  if(kind==='identity')e.mutate('managed_account_profiles',profileKey('one','profile'),x=>{x.observation.sites.chatgpt.login='signed_out'})
  if(kind==='observation')e.mutate('managed_account_profiles',profileKey('one','profile'),x=>{x.observation.checkedAt=e.now()-24*3600000-1})
  if(kind==='capacity')e.db.prepare("DELETE FROM managed_reservations WHERE resource LIKE 'account:shared:%'").run()
  if(kind==='command')e.mutate('managed_attempts',e.unit.attemptId,x=>{x.activeCommandId='other'})
  if(kind==='checkpoint')e.mutate('managed_attempts',e.unit.attemptId,x=>{x.checkpointRef='checkpoint/changed'})
  if(kind==='canonical')e.mutate('managed_tasks',e.unit.taskId,x=>{x.canonical='artifact/other'})
  expect((await e.api('verify-retained-context',{inspection:r})).status).toBe(409);expect(e.recovery.budget(e.unit).used).toBe(0)
 })
 it.each(['paused','cancelled','pending','unknown'])('holds retained %s recovery state without adopting the view',async state=>{
  const e=await setup();e.offer()
  if(state==='paused'||state==='cancelled')e.recovery.control(studio,e.fence,e.record().revision,true,state==='paused',state==='cancelled')
  else{e.enable();e.reserve();if(state==='unknown'){e.start();e.recovery.finish(phone(),e.fence,'original_restore','unknown','possible',null)}}
  const before=e.snapshot(),budget=e.recovery.budget(e.unit)
  expect((await e.api('verify-retained-context',{inspection:inspection(e)})).status).toBe(409)
  expect(e.snapshot()).toEqual(before);expect(e.recovery.budget(e.unit)).toEqual(budget)
 })
 it('rechecks authority after asynchronous hashing and rejects a newly stopped owner',async()=>{
  const e=await setup();const pending=e.recovery.verifyRetainedContext(phone(),e.fence,inspection(e))
  e.mutate('managed_tasks',e.unit.taskId,x=>{x.state='cancelled'})
  await expect(pending).rejects.toThrow();expect(e.recovery.budget(e.unit).used).toBe(0)
 })
 it('bounds validity by original observation and peer freshness without refreshing them',async()=>{
  const e=await setup(),r=inspection(e);e.mutate('managed_peers','one',x=>{x.receivedAt=new Date(e.now()-15*60000+5000).toISOString()})
  const response=await e.api('verify-retained-context',{inspection:r});expect(response.status).toBe(200)
  expect((await response.json()).verification.validUntil).toBe(e.now()+5000)
 })
 describe('independent same-profile target readiness',()=>{
  function target(e:Awaited<ReturnType<typeof setup>>){
   const p=JSON.parse(e.db.prepare('SELECT body FROM managed_account_profiles WHERE id=?').get(profileKey('one','profile')).body)
   e.a.accounts.observe(phone(),e.event(),'one','profile',{...p.observation,checkedAt:e.now()})
   return {deviceId:'one',profileId:'profile',accountId:'shared',bindingId:'replacement_view',policyRevision:1,accountObservationAt:e.now(),configuration:structuredClone(spec)}
  }
  it('checks exact target evidence with admission off and leaves every SQLite row unchanged',async()=>{
   const e=await setup(),r=inspection(e),t=target(e);e.env.MANAGED_CONVERSATION_RESTORATION='0'
   const dump=()=>e.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((x:any)=>[x.name,e.db.prepare('SELECT * FROM '+x.name+' ORDER BY rowid').all()])
   await e.api('inspect') // Initialize API-owned tables before checking that this operation writes no rows.
   const before=dump(),response=await e.api('verify-retained-target',{inspection:r,target:t})
   expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store')
   const body=await response.json();expect(body.globalEnabled).toBe(false)
   expect(body.verification).toEqual({schema:'retained-target-readiness/1',workspaceId:'workspace',fenceSha256:await artifactHash(new TextEncoder().encode(canonicalJson(e.fence))),inspectionSha256:await artifactHash(new TextEncoder().encode(canonicalJson(r))),targetSha256:await artifactHash(new TextEncoder().encode(canonicalJson(t))),checkedAt:e.now(),validUntil:e.now()+15000,accountObservationAt:e.now(),targetReady:true,executionAllowed:false,rebindAllowed:false,fallbackAllowed:false,resendAllowed:false})
   expect(dump()).toEqual(before)
  })
  it.each([{deviceId:'two'},{profileId:'other'},{accountId:'other'},{bindingId:'original_view'},{policyRevision:2},{accountObservationAt:1},{accountObservationAt:'now'},{url:'https://chatgpt.com'},{configuration:{...spec,model:'other'}},{configuration:{...spec,promptVersion:'changed'}}])('rejects changed or foreign target %j',async patch=>{
   const e=await setup(),t=target(e),before=e.snapshot();expect((await e.api('verify-retained-target',{inspection:inspection(e),target:{...t,...patch}})).status).toBe(409);expect(e.snapshot()).toEqual(before)
  })
  it.each(['old','future','changed','signed_out','identity','unknown','missing'])('requires independent fresh confirmed target account evidence: %s',async state=>{
   const e=await setup(),t=target(e)
   e.mutate('managed_account_profiles',profileKey('one','profile'),p=>{
    if(state==='old')p.observation.checkedAt--
    if(state==='future')p.observation.checkedAt++
    if(state==='changed')p.observation.checkedAt-=120001
    if(state==='signed_out'||state==='unknown')p.observation.sites.chatgpt.login=state
    if(state==='identity')p.observation.sites.chatgpt.candidate='other'
    if(state==='missing')p.observation=null
   })
   expect((await e.api('verify-retained-target',{inspection:inspection(e),target:t})).status).toBe(409)
  })
  it.each(['blocked','unknown','reset','stale','future','estimated','locally_counted','missing','uploads_only','other_account','other_model','malformed'])('holds unsupported scoped generation quota: %s',async state=>{
   const e=await setup(),t=target(e)
   const row=e.db.prepare('SELECT id,body FROM managed_account_quotas ORDER BY id').all().find((x:any)=>JSON.parse(x.body).scope.feature==='crop_json')
   if(state==='missing'||state==='uploads_only')e.db.prepare('DELETE FROM managed_account_quotas WHERE id=?').run(row.id)
   else e.mutate('managed_account_quotas',row.id,q=>{
    if(state==='blocked'||state==='unknown')q.state=state
    if(state==='reset')q.recheckAt=e.now()
    if(state==='stale')q.observedAt=e.now()-24*3600000
    if(state==='future')q.observedAt=e.now()+1
    if(state==='estimated'||state==='locally_counted')q.evidence=state
    if(state==='other_account')q.accountId='other'
    if(state==='other_model')q.scope.model='different'
    if(state==='malformed')q.observedAt='bad'
   })
   if(state==='missing')e.db.prepare('DELETE FROM managed_account_quotas').run()
   expect((await e.api('verify-retained-target',{inspection:inspection(e),target:t})).status).toBe(409);expect(e.recovery.budget(e.unit).used).toBe(0)
  })
  it('lets a stricter matching blocked quota override a broad available record',async()=>{
   const e=await setup(),t=target(e)
   e.a.accounts.quota(studio,e.event(),null,{accountId:'shared',scope:{provider:'openai',product:'chatgpt',model:'provider-default',project:null,feature:'crop_json'},state:'blocked',evidence:'owner_supplied',observedAt:e.now(),recheckAt:null})
   expect((await e.api('verify-retained-target',{inspection:inspection(e),target:t})).status).toBe(409)
  })
  it('clips readiness to the earliest matching generation quota boundary',async()=>{
   const e=await setup(),t=target(e)
   const row=e.db.prepare('SELECT id,body FROM managed_account_quotas').all().find((x:any)=>JSON.parse(x.body).scope.feature==='crop_json')
   e.mutate('managed_account_quotas',row.id,q=>{q.recheckAt=e.now()+3000})
   const response=await e.api('verify-retained-target',{inspection:inspection(e),target:t});expect(response.status).toBe(200);expect((await response.json()).verification.validUntil).toBe(e.now()+3000)
  })
  it.each(['paused','cancelled','pending','unknown','reservation','lease','budget_stop'])('preserves original %s holds and resources',async state=>{
   const e=await setup(),t=target(e);e.offer()
   if(state==='paused'||state==='cancelled')e.recovery.control(studio,e.fence,e.record().revision,true,state==='paused',state==='cancelled')
   if(state==='pending'||state==='unknown'){e.enable();e.reserve();if(state==='unknown'){e.start();e.recovery.finish(phone(),e.fence,'original_restore','unknown','possible',null)}}
   if(state==='reservation')e.db.prepare('DELETE FROM managed_reservations WHERE resource=?').run('browser:one')
   if(state==='lease')e.mutate('managed_attempts',e.unit.attemptId,a=>{a.leaseExpiresAt=new Date(e.now()+30000).toISOString()})
   if(state==='budget_stop')e.mutate('managed_tasks',e.unit.taskId,t=>{t.state='paused'})
   const before=e.snapshot(),budget=e.recovery.budget(e.unit)
   expect((await e.api('verify-retained-target',{inspection:inspection(e),target:t})).status).toBe(409);expect(e.snapshot()).toEqual(before);expect(e.recovery.budget(e.unit)).toEqual(budget)
  })
  it('rechecks account observation and configuration after asynchronous hashing',async()=>{
   for(const change of ['account','configuration']){
    const e=await setup(),t=target(e),pending=e.recovery.verifyRetainedTarget(phone(),e.fence,inspection(e),t)
    if(change==='account')e.mutate('managed_account_profiles',profileKey('one','profile'),p=>{p.observation.checkedAt--})
    else e.mutate('managed_tasks',e.unit.taskId,t=>{t.spec.model='changed'})
    await expect(pending).rejects.toThrow();expect(e.record()).toBeNull()
   }
  })
  it.each(['profile','capability'])('requires the target %s in the current peer advertisement',async kind=>{
   const e=await setup(),t=target(e)
   e.mutate('managed_peers','one',p=>{if(kind==='profile')p.profileIds=['other'];else p.capabilities=p.capabilities.filter((c:string)=>c!=='account-selection/1')})
   expect((await e.api('verify-retained-target',{inspection:inspection(e),target:t})).status).toBe(409)
  })
  it('snapshots caller-owned target and inspection before waiting for hashes',async()=>{
   const e=await setup(),t=target(e),r=inspection(e),pinnedTarget=structuredClone(t),pinnedInspection=structuredClone(r)
   const pending=e.recovery.verifyRetainedTarget(phone(),e.fence,r,t)
   t.configuration.model='mutated';r.inspectionBindingId='mutated'
   const receipt=await pending
   expect(receipt.targetSha256).toBe(await artifactHash(new TextEncoder().encode(canonicalJson(pinnedTarget))))
   expect(receipt.inspectionSha256).toBe(await artifactHash(new TextEncoder().encode(canonicalJson(pinnedInspection))))
  })
  describe('durable distinct-view binding authority',()=>{
   async function binding(){
    const e=await setup(),t=target(e),i=inspection(e)
    const call=(action:string,details:any={},token='o'.repeat(40))=>e.api(action,details,e.fence,token)
    const offered=await call('offer-binding',{inspection:i,target:t,candidateId:'native_candidate'});expect(offered.status).toBe(200)
    const record=()=>JSON.parse(e.db.prepare('SELECT body FROM managed_retained_binding_episodes').get().body)
    const proof=()=>({schema:'retained-binding-proof/1',observedAt:e.now(),candidateId:'native_candidate',bindingId:'replacement_view',anchorSha256:e.fence.anchorSha256,originalBindingId:'original_view',contextMatched:true,currentProfile:true,cachedSourceVerified:true,originalView:false,resendAllowed:false,portable:false})
    const control=(enabled=true,paused=false,cancelled=false)=>call('control-binding',{revision:record().revision,enabled,paused,cancelled},'s'.repeat(40))
    const reserve=()=>call('reserve-binding',{revision:record().revision,actionId:'binding_once'},'s'.repeat(40))
    const start=()=>call('start-binding',{actionId:'binding_once',proof:proof()})
    const finish=(outcome:string,effect:string,p:any=null)=>call('finish-binding',{actionId:'binding_once',outcome,effect,proof:p})
    return {...e,t,i,call,record,proof,control,reserve,start,finish}
   }
   describe('Studio retained-binding approval',()=>{
    async function fixture(){
     const e=await binding();let enabled=true,held=false,changeAt=Infinity,resolutions=0,drop=false;const calls:string[]=[]
     const bridge=new RetainedBindingApprovalBridge({resolve:async()=>({unit:++resolutions>=changeAt?{...e.unit,generation:2}:e.unit,pageLabel:'fixture page'}),enabled:()=>enabled,diagnoses:{assertAdmission:async()=>{if(held)throw new Error('Retained stop')}},call:async(action,fence,details)=>{
      calls.push(action);const response=await e.api(action,details,fence,'s'.repeat(40));if(!response?.ok)throw new Error('Held relay receipt')
      if(drop&&action==='reserve-binding')throw new Error('Lost committed grant response')
      return parseRetainedBindingView(await response.json(),e.unit,'unit'in fence?fence:undefined)
     }})
     const body=(action:string)=>({action,fence:e.fence,candidateId:'native_candidate',expectedRevision:e.record().revision,...(action==='reserve'?{actionId:'studio_binding'}:{})})
     return {e,bridge,body,calls,off:()=>enabled=false,hold:()=>held=true,changeDuringNext:()=>changeAt=resolutions+2,drop:()=>drop=true}
    }
    it('discovers binding without a legacy restoration offer while off and changes no authority state',async()=>{
     const f=await fixture();f.off();f.e.env.MANAGED_CONVERSATION_RESTORATION='0'
     const before=f.e.snapshot(),record=f.e.record();const result=await f.bridge.perform({action:'inspect',fence:null,candidateId:null,expectedRevision:0})
     expect(result).toMatchObject({globalEnabled:false,admissionReady:true,binding:{candidateId:'native_candidate'}})
     expect(f.e.recovery.discover(studio,f.e.unit)).toBeNull();expect(f.e.record()).toEqual(record);expect(f.e.snapshot()).toEqual(before);expect(result.budget.used).toBe(0)
    })
    it('returns an empty offer without inventing permission and rejects another phone/workspace',async()=>{
     const e=await setup();const response=await e.api('discover-binding',{},e.unit,'s'.repeat(40));expect(response.status).toBe(200)
     expect(response.headers.get('Cache-Control')).toBe('no-store');expect(await response.json()).toMatchObject({binding:null,admissionReady:false,permit:null})
     for(const [unit,token] of [[e.unit,'t'.repeat(40)],[{...e.unit,workspaceId:'foreign'},'s'.repeat(40)]] as const)expect((await e.api('discover-binding',{},unit,token)).status).not.toBe(200)
    })
    it('separates enable from one shared-budget grant and leaves native execution explicit',async()=>{
     const f=await fixture(),before=f.e.snapshot();await f.bridge.perform(f.body('enable'));expect(f.e.recovery.budget(f.e.unit).used).toBe(0)
     const result=await f.bridge.perform(f.body('reserve'));expect(result.binding?.actions[0]).toMatchObject({id:'studio_binding',phase:'reserved'});expect(result.budget).toMatchObject({used:1,pending:true})
     expect(f.e.snapshot()).toEqual(before);await expect(f.bridge.perform(f.body('reserve'))).rejects.toThrow();expect(f.calls.filter(c=>c==='reserve-binding')).toHaveLength(1)
     const response=await f.e.api('inspect-binding');expect((await response.json()).binding.actions[0].id).toBe('studio_binding')
    })
    it.each(['off','hold','change'])('blocks %s before grant without spending budget',async kind=>{
     const f=await fixture();await f.bridge.perform(f.body('enable'));if(kind==='off')f.off();if(kind==='hold')f.hold();if(kind==='change')f.changeDuringNext()
     await expect(f.bridge.perform(f.body('reserve'))).rejects.toThrow();expect(f.e.recovery.budget(f.e.unit).used).toBe(0)
    })
    it('rejects stale revision, different candidate and different private anchor',async()=>{
     const f=await fixture(),stale=f.body('reserve');await f.bridge.perform(f.body('enable'));await expect(f.bridge.perform(stale)).rejects.toThrow('Inspect')
     for(const patch of [{candidateId:'other'},{fence:{...f.e.fence,anchorSha256:'9'.repeat(64)}}])await expect(f.bridge.perform({...f.body('reserve'),...patch})).rejects.toThrow('Inspect')
     expect(f.e.recovery.budget(f.e.unit).used).toBe(0)
    })
    it.each(['pause','disable','cancel'])('allows %s while off, preserving an existing grant and its budget',async action=>{
     const f=await fixture();await f.bridge.perform(f.body('enable'));await f.bridge.perform(f.body('reserve'));f.off();f.e.env.MANAGED_CONVERSATION_RESTORATION='0'
     const result=await f.bridge.perform(f.body(action));expect(result.binding?.actions[0].phase).toBe('reserved');expect(result.budget).toMatchObject({used:1,pending:true})
     if(action==='pause')expect(result.binding?.paused).toBe(true);else expect(result.binding?.enabled).toBe(false)
    })
    it('can explicitly re-enable its own paused unused offer, but other shared holds still block',async()=>{
     const f=await fixture();await f.bridge.perform(f.body('enable'));const paused=await f.bridge.perform(f.body('pause'));expect(paused.admissionReady).toBe(false)
     const resumed=await f.bridge.perform(f.body('enable'));expect(resumed.binding).toMatchObject({enabled:true,paused:false});expect(resumed.budget.used).toBe(0)
     await f.bridge.perform(f.body('pause'));f.e.offer();f.e.recovery.control(studio,f.e.fence,f.e.recovery.discover(studio,f.e.unit)!.revision,true,true,false)
     await expect(f.bridge.perform(f.body('enable'))).rejects.toThrow();expect(f.e.record().paused).toBe(true);expect(f.e.recovery.budget(f.e.unit).used).toBe(0)
    })
    it('does not repeat a committed grant when its response is lost',async()=>{
     const f=await fixture();await f.bridge.perform(f.body('enable'));f.drop();await expect(f.bridge.perform(f.body('reserve'))).rejects.toThrow('Lost')
     const result=await f.bridge.perform(f.body('inspect'));expect(result.binding?.actions[0].phase).toBe('reserved');expect(result.budget.used).toBe(1)
     await expect(f.bridge.perform(f.body('reserve'))).rejects.toThrow();expect(f.calls.filter(c=>c==='reserve-binding')).toHaveLength(1)
    })
    it('withholds readiness on expired evidence and rejects browser-supplied provider data',async()=>{
     const f=await fixture();f.e.advance(120000);const view=await f.bridge.perform(f.body('inspect'));expect(view.admissionReady).toBe(false)
     await expect(f.bridge.perform(f.body('enable'))).rejects.toThrow('not ready')
     await expect(f.bridge.perform({...f.body('inspect'),url:'private provider URL'})).rejects.toThrow()
    })
    it('rejects execution permits, promoted schema and contradictory budget receipts',async()=>{
     const f=await fixture(),raw=await (await f.e.api('discover-binding',{},f.e.unit,'s'.repeat(40))).json()
     for(const patch of [{schema:'other'},{permit:{executionAllowed:true}},{budget:{...raw.budget,exhausted:true}},{binding:{...raw.binding,fence:{...raw.binding.fence,unit:{...f.e.unit,generation:2}}}}])expect(()=>parseRetainedBindingView({...raw,...patch},f.e.unit)).toThrow()
    })
   })
   describe('retained binding local correction consumer',()=>{
    async function consumer(){
     const e=await binding();await e.control();await e.reserve();e.advance();await e.start();await e.finish('verified','bound_retained_context',e.proof())
     const output=canonicalJson({pointers:JSON.stringify({format:'four-point-crop',version:'1.0',image:{filename:'page.jpg',width:800,height:4096},coordinateSystem:'normalized',crops:[{id:'crop-01',reason:'scene',crop:{mode:'rectangle',points:[{id:'P1',x:0,y:0},{id:'P2',x:1,y:0},{id:'P3',x:1,y:1},{id:'P4',x:0,y:1}]}}]}),metadata:JSON.stringify({crops:[{id:'crop-01',exportedFilename:'panel.png',description:'A complete illustrated scene.'}]})})
     const preview={schema:'managed-correction-preview/1',originalReplySha256:e.fence.context.replySha256,proposalSha256:'1'.repeat(64),artifactSha256:await artifactHash(new TextEncoder().encode(output)),manifestSha256:e.fence.context.manifestSha256,lockedDigest:e.fence.context.lockedDigest,lockedCandidates:1,failedCandidates:1,changedFields:1,changeDigest:'2'.repeat(64),executable:false,portable:false} as const
     const cf={unit:e.unit,commandId:e.fence.commandId,deviceId:e.fence.deviceId,profileId:e.fence.profileId,context:e.fence.context,preview}
     const correction=new CorrectionRecovery(e.sql,e.tx,e.a,e.now);correction.offer(phone(),cf);correction.control(studio,cf,correction.discover(studio,e.unit)!.revision,true,false,false);correction.reserve(studio,cf,correction.discover(studio,e.unit)!.revision,'local_correction');correction.start(phone(),cf,'local_correction')
     e.env.MANAGED_CORRECTION_RECOVERY='1'
     const details=()=>({bindingActionId:'binding_once',correctionFence:structuredClone(cf),correctionActionId:'local_correction',proof:e.proof()})
     return {...e,cf,correction,output,details,check:(d:Record<string,unknown>=details(),token='o'.repeat(40))=>e.api('check-binding-correction',d,e.fence,token)}
    }
    it('permits only the exact separately granted local checkpoint without changing any authority or budget',async()=>{
     const e=await consumer(),before=e.snapshot(),budget=e.recovery.budget(e.unit),record=e.record()
     const response=await e.check();expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store')
     const body=await response.json();expect(body.permit).toMatchObject({schema:'retained-binding-local-correction-permit/1',bindingActionId:'binding_once',correctionActionId:'local_correction',candidateId:'native_candidate',bindingId:'replacement_view',artifactSha256:e.cf.preview.artifactSha256,localCheckpointAllowed:true,originalView:false,providerExecutionAllowed:false,rebindAllowed:false,resendAllowed:false,fallbackAllowed:false})
     expect(body.permit.correctionFenceSha256).toBe(await artifactHash(new TextEncoder().encode(canonicalJson(e.cf))))
     expect(e.snapshot()).toEqual(before);expect(e.record()).toEqual(record);expect(e.recovery.budget(e.unit)).toEqual(budget);expect(budget).toMatchObject({used:2,pending:true})
     const saved=await e.correction.commit(phone(),e.cf,'local_correction','correction_saved_event','checkpoint/corrected',e.output,true)
     expect(saved.record.actions[0].phase).toBe('verified');expect(saved.result.attempt.phase).toBe('result_saved');expect(saved.result.task.canonical).toBeNull()
     expect(e.recovery.budget(e.unit)).toMatchObject({used:2,pending:false})
    })
    it.each(['conversation','correction'])('requires the %s runtime gate',async kind=>{
     const e=await consumer();if(kind==='conversation')e.env.MANAGED_CONVERSATION_RESTORATION='0';else e.env.MANAGED_CORRECTION_RECOVERY='0'
     expect((await e.check()).status).toBe(503);expect(e.recovery.budget(e.unit).used).toBe(2)
    })
    it.each(['candidate','binding','artifact','action','original_view','stale','future'])('rejects changed %s evidence',async kind=>{
     const e=await consumer(),d=e.details()
     if(kind==='candidate')d.proof.candidateId='other';if(kind==='binding')d.proof.bindingId='original_view';if(kind==='artifact')d.correctionFence.preview.artifactSha256='9'.repeat(64);if(kind==='action')d.correctionActionId='other';if(kind==='original_view')d.proof.originalView=true as any;if(kind==='stale')e.advance(15000);if(kind==='future')d.proof.observedAt=e.now()+1
     expect((await e.check(d)).status).toBe(409);expect(e.recovery.budget(e.unit).used).toBe(2)
    })
    it.each(['binding_pause','correction_pause','task','lease','account','capability','reservation','correction_unknown'])('rechecks current %s fences',async kind=>{
     const e=await consumer()
     if(kind==='binding_pause')await e.control(true,true)
     if(kind==='correction_pause')e.correction.control(studio,e.cf,e.correction.discover(studio,e.unit)!.revision,true,true,false)
     if(kind==='task')e.mutate('managed_tasks',e.unit.taskId,r=>{r.state='paused'})
     if(kind==='lease')e.mutate('managed_attempts',e.unit.attemptId,r=>{r.leaseExpiresAt=new Date(e.now()+30000).toISOString()})
     if(kind==='account')e.mutate('managed_attempts',e.unit.attemptId,r=>{r.accountId='other'})
     if(kind==='capability')e.mutate('managed_peers','one',r=>{r.capabilities=r.capabilities.filter((c:string)=>c!=='retained-binding-local-correction/1')})
     if(kind==='reservation')e.db.prepare('DELETE FROM managed_reservations WHERE resource=?').run('device:one')
     if(kind==='correction_unknown')e.correction.finish(phone(),e.cf,'local_correction','unknown')
     expect((await e.check()).status).toBe(409);expect(e.recovery.budget(e.unit).used).toBe(2)
    })
    it('refuses Studio and another phone and snapshots caller-owned data across hashing',async()=>{
     const e=await consumer();for(const token of ['s'.repeat(40),'t'.repeat(40)])expect((await e.check(e.details(),token)).status).toBe(409)
     const d=e.details(),pending=e.recovery.checkRetainedCorrection(phone(),e.fence,d);d.correctionFence.preview.artifactSha256='9'.repeat(64);d.proof.candidateId='changed'
     expect((await pending).artifactSha256).toBe(e.cf.preview.artifactSha256)
    })
    it('does not extend short-lived content evidence when issuing another read-only check',async()=>{
     const e=await consumer(),d=e.details();e.advance(14000);const response=await e.check(d);expect(response.status).toBe(200);const permit=(await response.json()).permit
     expect(permit.validUntil).toBe(d.proof.observedAt+15000);e.advance(1000);expect((await e.check(d)).status).toBe(409)
    })
    it('rejects newly stopped authority after asynchronous hashing and leaves ledgers untouched',async()=>{
     const e=await consumer(),pending=e.recovery.checkRetainedCorrection(phone(),e.fence,e.details());e.mutate('managed_tasks',e.unit.taskId,r=>{r.state='cancelled'})
     await expect(pending).rejects.toThrow();expect(e.correction.discover(studio,e.unit)!.actions[0].phase).toBe('executing')
    })
   })
   describe('distinct retained-view conversation restoration',()=>{
    async function retained(){
     const e=await binding();await e.control();await e.reserve();e.advance();await e.start();await e.finish('verified','bound_retained_context',e.proof())
     const f={...e.fence,retained:{schema:'retained-restoration-binding/1' as const,bindingActionId:'binding_once',candidateId:'native_candidate',bindingId:'replacement_view'}}
     const proof=(restored=false)=>({schema:'retained-conversation-proof/1',observedAt:e.now(),anchorSha256:f.anchorSha256,bindingId:'replacement_view',commandId:f.commandId,profileId:f.profileId,fingerprint:f.unit.fingerprint,sourceSha256:f.context.sourceSha256,state:restored?'original_conversation':'empty_home',promptMatched:restored,replyMatched:restored,exactView:false,originalView:false,bindingActionId:'binding_once',candidateId:'native_candidate',originalBindingId:'original_view',currentProfile:true,cachedSourceVerified:true,portable:false,resendAllowed:false})
     // Binding proofs and navigation proofs have disjoint schemas/fields.
     const navigationProof=(restored=false)=>{const p=proof(restored) as any;for(const k of ['contextMatched'])delete p[k];return p}
     const call=(action:string,d:Record<string,unknown>={},token='o'.repeat(40))=>e.api(action,d,f,token)
     const record=()=>e.recovery.discover(studio,e.unit)!
     const offered=await call('offer',{proof:navigationProof()});expect(offered.status).toBe(200)
     const control=(enabled=true,paused=false,cancelled=false)=>call('control',{revision:record().revision,enabled,paused,cancelled},'s'.repeat(40))
     const reserve=()=>call('reserve',{revision:record().revision,actionId:'retained_navigation'},'s'.repeat(40))
     const start=()=>call('start',{actionId:'retained_navigation',proof:navigationProof()})
     const check=()=>call('check',{actionId:'retained_navigation',proof:navigationProof()})
     const finish=(outcome:string,effect:string,p:any=null)=>call('finish',{actionId:'retained_navigation',outcome,effect,proof:p})
     return {...e,f,navigationProof,restoreRecord:record,restoreCall:call,restoreControl:control,restoreReserve:reserve,restoreStart:start,restoreCheck:check,restoreFinish:finish}
    }
    it('reports real discovery readiness and charges only the separate restoration grant',async()=>{
     const e=await retained(),before=e.snapshot();const discovered=await e.api('discover',{},e.unit,'s'.repeat(40));expect(discovered.status).toBe(200);expect((await discovered.json()).admissionReady).toBe(true)
     expect((await e.restoreControl()).status).toBe(200);expect(e.recovery.budget(e.unit).used).toBe(1)
     expect((await e.restoreReserve()).status).toBe(200);expect(e.recovery.budget(e.unit)).toMatchObject({used:2,pending:true})
     expect((await e.restoreStart()).status).toBe(200);const response=await e.restoreCheck();expect(response.status).toBe(200)
     expect((await response.json()).navigationPermit).toMatchObject({schema:'retained-conversation-navigation-permit/1',bindingActionId:'binding_once',candidateId:'native_candidate',bindingId:'replacement_view',navigationAllowed:true,providerExecutionAllowed:false,resendAllowed:false,fallbackAllowed:false,originalView:false})
     e.advance();expect((await e.restoreFinish('verified','opened_original',e.navigationProof(true))).status).toBe(200)
     expect(e.snapshot()).toEqual(before);expect(e.recovery.budget(e.unit)).toMatchObject({used:2,pending:false});expect(e.restoreRecord().actions[0].after?.exactView).toBe(false)
    })
    it.each(['exact_view','original_view','candidate','binding','original_binding','schema'])('rejects promoted or changed %s proofs before starting',async kind=>{
     const e=await retained();await e.restoreControl();await e.restoreReserve();const p=e.navigationProof()
     if(kind==='exact_view')p.exactView=true;if(kind==='original_view')p.originalView=true;if(kind==='candidate')p.candidateId='other';if(kind==='binding')p.bindingId='original_view';if(kind==='original_binding')p.originalBindingId='other';if(kind==='schema')p.schema='original-conversation-proof/1'
     expect((await e.restoreCall('start',{actionId:'retained_navigation',proof:p})).status).toBe(409);expect(e.restoreRecord().actions[0].phase).toBe('reserved')
    })
    it('cannot replace a retained episode with a legacy original-view episode or dispatch it automatically',async()=>{
     const e=await retained();expect((await e.api('offer',{proof:e.proof()})).status).toBe(409)
     await e.restoreControl();await e.restoreReserve()
     const response=await new ManagedTaskApi(e.sql,e.tx,{...e.env,MANAGED_RECOVERY_DISPATCH:'1'},()=>new Date(e.now()).toISOString()).handle(new Request('https://fixture/managed/recovery/dispatch',{method:'POST',headers:{Authorization:'Bearer '+'s'.repeat(40)},body:JSON.stringify({schema:'original-recovery-dispatch/1',action:'queue',unit:e.unit,kind:'restore_conversation',actionId:'retained_navigation',expectedRevision:e.restoreRecord().revision})}))
     expect(response?.status).not.toBe(200);expect(e.restoreRecord().actions[0].phase).toBe('reserved')
    })
    it('preserves unknown through off-state cancellation and accepts only the original verified receipt',async()=>{
     const e=await retained();await e.restoreControl();await e.restoreReserve();await e.restoreStart();await e.restoreFinish('unknown','possible')
     e.env.MANAGED_CONVERSATION_RESTORATION='0';expect((await e.restoreControl(false,true,true)).status).toBe(200)
     expect((await e.restoreFinish('safe_failure','not_touched')).status).toBe(409)
     const p=e.navigationProof(true);expect((await e.restoreFinish('verified','opened_original',p)).status).toBe(200)
     e.advance(180000);expect((await e.restoreFinish('verified','opened_original',p)).status).toBe(200);expect(e.recovery.budget(e.unit).used).toBe(2)
    })
    it.each(['binding_pause','capability','owner','lease','account','reservation'])('rechecks %s before issuing the browser permit',async kind=>{
     const e=await retained();await e.restoreControl();await e.restoreReserve();await e.restoreStart()
     if(kind==='binding_pause')await e.control(true,true)
     if(kind==='capability')e.mutate('managed_peers','one',p=>{p.capabilities=p.capabilities.filter((x:string)=>x!=='retained-conversation-restoration/1')})
     if(kind==='owner')e.mutate('managed_attempts',e.unit.attemptId,p=>{p.deviceId='two'})
     if(kind==='lease')e.mutate('managed_attempts',e.unit.attemptId,p=>{p.leaseExpiresAt=new Date(e.now()+30000).toISOString()})
     if(kind==='account')e.mutate('managed_attempts',e.unit.attemptId,p=>{p.accountId='other'})
     if(kind==='reservation')e.db.prepare('DELETE FROM managed_reservations WHERE resource=?').run('device:one')
     expect((await e.restoreCheck()).status).toBe(409);expect(e.recovery.budget(e.unit).used).toBe(2)
    })
    it('allows only one retained navigation even after a confirmed untouched failure',async()=>{
     const e=await retained();await e.restoreControl();await e.restoreReserve();await e.restoreFinish('safe_failure','not_touched');e.advance(30001)
     expect((await e.restoreReserve()).status).toBe(409);expect(e.recovery.budget(e.unit).used).toBe(2)
    })
   })
   it('offers while off but denies all grant/effect admission; finish and inspect remain available',async()=>{
    const e=await binding();e.env.MANAGED_CONVERSATION_RESTORATION='0'
    expect((await e.call('offer-binding',{inspection:e.i,target:e.t,candidateId:'native_candidate'})).status).toBe(200)
    expect((await e.control()).status).toBe(503);expect((await e.reserve()).status).toBe(503);expect((await e.start()).status).toBe(503)
    expect((await e.call('inspect-binding')).status).toBe(200);expect(e.recovery.budget(e.unit).used).toBe(0)
   })
   it('charges shared budget once and issues only a short-lived distinct binding permit',async()=>{
    const e=await binding(),before=e.snapshot();expect((await e.control()).status).toBe(200);expect((await e.reserve()).status).toBe(200)
    expect(e.recovery.budget(e.unit)).toMatchObject({used:1,pending:true});expect((await e.reserve()).status).toBe(409)
    e.advance();expect((await e.start()).status).toBe(200);expect((await e.start()).status).toBe(409)
    const checked=await e.call('check-binding',{actionId:'binding_once',proof:e.proof()});expect(checked.status).toBe(200)
    expect((await checked.json()).permit).toMatchObject({schema:'retained-binding-effect-permit/1',actionId:'binding_once',candidateId:'native_candidate',bindingId:'replacement_view',rebindAllowed:true,executionAllowed:false,resendAllowed:false,fallbackAllowed:false,issuedAt:e.now(),validUntil:e.now()+15000})
    expect((await e.finish('verified','bound_retained_context',e.proof())).status).toBe(200)
    expect(e.recovery.budget(e.unit)).toMatchObject({used:1,pending:false});expect(e.snapshot()).toEqual(before)
   })
   it('shares pending holds and action identities with every original playbook',async()=>{
    const e=await binding();await e.control();await e.reserve()
    expect(()=>assertRecoveryReservation(e.sql,e.unit,'other',e.now())).toThrow('reconciliation')
    expect((await e.api('verify-retained-target',{inspection:e.i,target:e.t})).status).toBe(409)
    expect((await e.finish('safe_failure','not_touched')).status).toBe(200)
    expect(()=>assertRecoveryReservation(e.sql,e.unit,'binding_once',e.now()+30001)).toThrow('reused')
    expect(e.recovery.budget(e.unit)).toMatchObject({used:1,nextEligibleAt:e.now()+30000})
   })
   it('unknown survives reconstruction and cannot be downgraded, repeated or replaced',async()=>{
    const e=await binding();await e.control();await e.reserve();await e.start();await e.finish('unknown','possible')
    const restarted=new ConversationRestoration(e.sql,e.tx,e.a,e.now)
    expect(()=>restarted.binding(phone(),e.fence,'start-binding',{actionId:'binding_once',proof:e.proof()})).toThrow()
    expect((await e.finish('safe_failure','not_touched')).status).toBe(409)
    expect((await e.call('offer-binding',{inspection:e.i,target:e.t,candidateId:'replacement_candidate'})).status).toBe(409)
    expect(e.recovery.budget(e.unit)).toMatchObject({used:1,pending:true})
    e.advance();expect((await e.finish('verified','bound_retained_context',e.proof())).status).toBe(200)
   })
   it('accepts exact finish replay while off, stopped and expired without renewal or repeated effects',async()=>{
    const e=await binding();await e.control();await e.reserve();await e.start();const p=e.proof()
    expect((await e.finish('verified','bound_retained_context',p)).status).toBe(200)
    e.env.MANAGED_CONVERSATION_RESTORATION='0';e.advance(3600000);e.mutate('managed_tasks',e.unit.taskId,t=>{t.state='cancelled'})
    const before=e.snapshot(),record=e.record()
    expect((await e.finish('verified','bound_retained_context',p)).status).toBe(200);expect(e.record()).toEqual(record);expect(e.snapshot()).toEqual(before)
    expect((await e.finish('unknown','possible')).status).toBe(409)
   })
   it.each(['candidate','binding','anchor','original_binding','original_view','portable','resend','future','stale'])('rejects changed or promoted %s binding proofs',async kind=>{
    const e=await binding();await e.control();await e.reserve();const p:any=e.proof()
    if(kind==='candidate')p.candidateId='other'
    if(kind==='binding')p.bindingId='original_view'
    if(kind==='anchor')p.anchorSha256='0'.repeat(64)
    if(kind==='original_binding')p.originalBindingId='other'
    if(kind==='original_view')p.originalView=true
    if(kind==='portable')p.portable=true
    if(kind==='resend')p.resendAllowed=true
    if(kind==='future')p.observedAt++
    if(kind==='stale')p.observedAt=1
    expect((await e.call('start-binding',{actionId:'binding_once',proof:p})).status).toBe(409);expect(e.record().actions[0].phase).toBe('reserved')
   })
   it.each(['quota','identity','lease','reservation','task','policy'])('rechecks current %s before granting the physical-effect permit',async kind=>{
    const e=await binding();await e.control();await e.reserve();await e.start()
    if(kind==='quota'){const q=e.db.prepare('SELECT id FROM managed_account_quotas').get();e.mutate('managed_account_quotas',q.id,q=>{q.state='blocked'})}
    if(kind==='identity')e.mutate('managed_account_profiles',profileKey('one','profile'),p=>{p.observation.sites.chatgpt.login='signed_out'})
    if(kind==='lease')e.mutate('managed_attempts',e.unit.attemptId,a=>{a.leaseExpiresAt=new Date(e.now()).toISOString()})
    if(kind==='reservation')e.db.prepare('DELETE FROM managed_reservations WHERE resource=?').run('browser:one')
    if(kind==='task')e.mutate('managed_tasks',e.unit.taskId,t=>{t.state='paused'})
    if(kind==='policy')e.mutate('managed_account_policies','crop_json',p=>{p.revision++})
    expect((await e.call('check-binding',{actionId:'binding_once',proof:e.proof()})).status).toBe(409);expect(e.record().actions[0].phase).toBe('executing')
   })
   it('retained shared stop freezes binding grants without erasing their charge or outcome',async()=>{
    const e=await binding();await e.control();await e.reserve()
    const accounts=new AccountRecheckRecovery(e.sql,e.tx,e.a,e.now),stops=new RecoveryStops(e.sql,e.tx,e.a,accounts,e.now)
    stops.apply(studio,{schema:'recovery-stop/1',unit:e.unit,sequence:1,mode:'pause',eventId:'binding_stop'})
    expect(e.record()).toMatchObject({enabled:false,paused:true});expect((await e.start()).status).toBe(409)
    expect((await e.finish('safe_failure','not_touched')).status).toBe(200);expect(e.recovery.budget(e.unit).used).toBe(1)
   })
   it('counts the binding charge toward the same three-action ceiling without resetting it',async()=>{
    const e=await binding();await e.control();await e.reserve();await e.finish('safe_failure','not_touched');e.advance(30001)
    e.offer();e.enable()
    for(const id of ['second_action','third_action']){
     const old=e.recovery.discover(studio,e.unit)!
     e.recovery.reserve(studio,e.fence,old.revision,id);e.recovery.finish(phone(),e.fence,id,'safe_failure','not_touched',null);e.advance(30001)
    }
    expect(e.recovery.budget(e.unit)).toMatchObject({used:3,exhausted:true,pending:false})
    expect(()=>assertRecoveryReservation(e.sql,e.unit,'fourth_action',e.now())).toThrow('exhausted')
   })
   it('rejects a corrupted binding ledger key and rejects its proof in the legacy original-view decoder',async()=>{
    const e=await binding();expect(()=>conversationProof(e.proof(),e.fence,e.now(),true)).toThrow()
    e.mutate('managed_retained_binding_episodes',savedImportKey(e.unit),r=>{r.fence.unit.generation++;r.inspection.unit.generation++})
    expect(()=>e.recovery.budget(e.unit)).toThrow('key mismatch')
   })
   it('rejects a peer that loses the retained binding capability before admission',async()=>{
    const e=await binding();e.mutate('managed_peers','one',p=>{p.capabilities=p.capabilities.filter((c:string)=>c!=='retained-context-binding/1')})
    expect((await e.control()).status).toBe(409);expect(e.recovery.budget(e.unit).used).toBe(0)
   })
   it('only Studio may approve and only the original phone may offer, start or finish',async()=>{
    const e=await binding()
    for(const token of ['o'.repeat(40),'t'.repeat(40)])expect((await e.call('control-binding',{revision:1,enabled:true,paused:false,cancelled:false},token)).status).toBe(409)
    await e.control();await e.reserve()
    for(const token of ['s'.repeat(40),'t'.repeat(40)])expect((await e.call('start-binding',{actionId:'binding_once',proof:e.proof()},token)).status).toBe(409)
   })
  })
  it('does not accept an authority receipt as target evidence or accept another principal',async()=>{
   const e=await setup(),t=target(e),r=inspection(e)
   const verification=(await (await e.api('verify-retained-context',{inspection:r})).json()).verification
   expect((await e.api('verify-retained-target',{inspection:verification,target:t})).status).toBe(409)
   for(const token of ['t'.repeat(40),'s'.repeat(40),'bad'])expect((await e.api('verify-retained-target',{inspection:r,target:t},e.fence,token)).status).not.toBe(200)
  })
 })
})
describe('same-view original conversation restoration',()=>{
 it('charges once, verifies exact original conversation and changes no task/account/resource state',async()=>{
  const e=await setup(),before=e.snapshot();e.offer();e.enable();e.reserve();e.start();expect(()=>e.start()).toThrow()
  e.advance();const after=e.proof(true);e.recovery.finish(phone(),e.fence,'original_restore','verified','opened_original',after)
  expect(e.snapshot()).toEqual(before);expect(e.record().actions[0]).toMatchObject({phase:'verified',after,effect:'opened_original'})
  expect(e.recovery.budget(e.unit)).toMatchObject({used:1,uiUsed:0,pending:false});expect(()=>e.reserve('repeat')).toThrow()
  const original=e.record();e.advance(180000);expect(e.recovery.finish(phone(),e.fence,'original_restore','verified','opened_original',after)).toEqual(original)
 })
 it('holds unknown across restart and only reconciles the same anchored original view',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start();e.recovery.finish(phone(),e.fence,'original_restore','unknown','possible',null)
  expect(()=>e.recovery.finish(phone(),e.fence,'original_restore','safe_failure','not_touched',null)).toThrow();expect(()=>e.reserve('another')).toThrow()
  const restart=new ConversationRestoration(e.sql,e.tx,e.a,e.now);expect(()=>assertRecoveryReservation(e.sql,e.unit,'other',e.now())).toThrow('reconciliation')
  e.advance();restart.finish(phone(),e.fence,'original_restore','verified','opened_original',e.proof(true));expect(e.recovery.budget(e.unit).used).toBe(1)
 })
 it('acknowledges original outcomes while off/cancelled/expired without renewing or releasing anything',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start();e.recovery.control(studio,e.fence,e.record().revision,false,true,true);e.env.MANAGED_CONVERSATION_RESTORATION='0';e.advance(3600000)
  const before=e.snapshot(),response=await e.api('finish',{actionId:'original_restore',outcome:'verified',effect:'opened_original',proof:e.proof(true)})
  expect(response!.status).toBe(200);expect(e.snapshot()).toEqual(before);expect(e.record().cancelled).toBe(true)
 })
 it('does not invent a repair or grant from an already restored conversation',async()=>{
  const e=await setup();expect(()=>e.recovery.offer(phone(),e.fence,e.proof(true))).toThrow();expect(e.record()).toBeNull()
 })
 it.each(['policy','lease','identity','source','capability','reservation','future_time','capacity'])('holds changed %s immediately before navigation',async kind=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start()
  if(kind==='policy')e.mutate('managed_account_policies','crop_json',r=>r.revision++)
  if(kind==='lease')e.advance(3600000)
  if(kind==='source')e.mutate('managed_tasks',e.unit.taskId,r=>r.spec.dependencies[0].sha256='9'.repeat(64))
  if(kind==='capability')e.mutate('managed_peers','one',r=>r.capabilities=[])
  if(kind==='reservation')e.db.prepare('DELETE FROM managed_reservations WHERE resource=?').run('browser:one')
  if(kind==='identity'||kind==='future_time'){const id=e.db.prepare('SELECT id FROM managed_account_profiles WHERE body LIKE ?').get('%"deviceId":"one"%').id;e.mutate('managed_account_profiles',id,r=>kind==='identity'?r.links.chatgpt.accountId='foreign':r.observation.checkedAt=e.now()+1)}
  if(kind==='capacity')e.mutate('managed_account_accounts','shared',r=>r.maxConcurrent=0)
  expect(()=>e.recovery.check(phone(),e.fence,'original_restore',e.proof())).toThrow();expect(e.record().actions[0].phase).toBe('executing')
 })
 it('rejects changed view/anchor/context, stale times, invented portability and unverified postconditions',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start()
  for(const patch of [{bindingId:'replacement'},{anchorSha256:'9'.repeat(64)},{promptMatched:false},{replyMatched:false},{observedAt:e.now()+1},{portable:true},{resendAllowed:true},{currentProfile:false},{cachedSourceVerified:false},{state:'empty_home'},{url:'https://private.example'}])expect(()=>e.recovery.finish(phone(),e.fence,'original_restore','verified','opened_original',{...e.proof(true),...patch})).toThrow()
  expect(e.recovery.budget(e.unit)).toMatchObject({used:1,pending:true})
 })
 it('retains no-touch charges, cooldowns and the shared three-action ceiling',async()=>{
  const e=await setup();e.offer();e.enable()
  for(let n=0;n<3;n++){e.reserve('unused_'+n);e.recovery.finish(phone(),e.fence,'unused_'+n,'safe_failure','not_touched',null);expect(()=>e.reserve('early_'+n)).toThrow();e.advance(30000)}
  expect(e.recovery.budget(e.unit)).toMatchObject({used:3,uiUsed:0,pending:false,exhausted:true});expect(()=>e.reserve('fourth')).toThrow('exhausted')
 })
 it('retained preparation never resumes an executing original navigation',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start();const before=e.snapshot(),stops=new RecoveryStops(e.sql,e.tx,e.a,new AccountRecheckRecovery(e.sql,e.tx,e.a,e.now),e.now)
  const intent={schema:'recovery-stop/1',unit:e.unit,eventId:'hold',sequence:1,mode:'pause'};stops.apply(studio,intent)
  expect(e.record()).toMatchObject({enabled:false,paused:true});expect(()=>e.recovery.check(phone(),e.fence,'original_restore',e.proof())).toThrow()
  stops.apply(studio,{...intent,eventId:'prepare',sequence:2,mode:'reinspect'});expect(e.record()).toMatchObject({enabled:false,paused:true});expect(e.snapshot()).toEqual(before)
  e.enable();expect(e.recovery.check(phone(),e.fence,'original_restore',e.proof()).actions[0].phase).toBe('executing');expect(e.recovery.budget(e.unit).used).toBe(1)
 })
 it('allows reinspection of an existing pending grant after its historical offer ages, while requiring a fresh physical precondition',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.advance(121000)
  expect(e.recovery.status(studio,e.fence).admissionReady).toBe(true)
  const stale={...e.proof(),observedAt:e.now()-121000};expect(()=>e.recovery.start(phone(),e.fence,'original_restore',stale)).toThrow()
  e.start();expect(e.recovery.budget(e.unit)).toMatchObject({used:1,pending:true})
 })
 it('requires the original submitted outcome and refuses unknown/saved/cancelled or already accepted artifacts',async()=>{
  for(const patch of [{phase:'submission_intent',submission:'unknown'},{phase:'result_saved',submission:'saved',checkpointRef:'checkpoint/output'},{phase:'stop_confirmed',submission:'submitted'}]){const e=await setup();e.mutate('managed_attempts',e.unit.attemptId,r=>Object.assign(r,patch));expect(()=>e.offer()).toThrow()}
  const e=await setup();e.mutate('managed_tasks',e.unit.taskId,r=>r.canonical='accepted_original');expect(()=>e.offer()).toThrow()
 })
 it('default-off and exact API actors prevent foreign or raw-context requests',async()=>{
  const e=await setup();delete e.env.MANAGED_CONVERSATION_RESTORATION
  expect((await e.api('discover',{},e.unit))!.status).toBe(200);expect((await e.api('offer',{proof:e.proof()}))!.status).toBe(503)
  e.env.MANAGED_CONVERSATION_RESTORATION='1';e.offer();e.enable();e.reserve()
  expect((await e.api('start',{actionId:'original_restore',proof:e.proof()},e.fence,'t'.repeat(40)))!.status).toBe(409)
  expect((await e.api('start',{actionId:'original_restore',proof:e.proof(),force:true}))!.status).toBe(409)
  expect((await e.api('offer',{proof:e.proof()},{...e.fence,url:'private raw URL'}))!.status).toBe(409)
 })
})
describe('original conversation shared recovery bounds',()=>{
 it('counts prior navigation charges and prevents any other playbook while restoration is pending',async()=>{
  const e=await setup();const fence={unit:e.unit,commandId:e.fence.commandId,deviceId:'one',profileId:'profile',bindingId:'original_view',sourceSha256:'a'.repeat(64),accountId:'shared',policyRevision:1}
  const offer={schema:'managed-session-evidence/1',bindingId:fence.bindingId,commandId:fence.commandId,profileId:'profile',fingerprint:e.unit.fingerprint,cachedSourceSha256:'a'.repeat(64),observedAt:e.now()-1000,documentKind:'chatgpt_home',ready:false,composer:'empty',attachments:'none',response:'none',login:'unknown',exactView:true,currentProfile:true,cachedSourceVerified:true,untouched:true,context:'held'}
  const prior={schema:'unsent-navigation-recovery/1',fence,revision:5,enabled:true,paused:false,cancelled:false,nextEligibleAt:0,offer,actions:[1,2].map(n=>({id:'old_nav_'+n,phase:'safe_failure',at:e.now()-1000,finishedAt:e.now()-999,evidenceRef:'navigation/old_nav_'+n,before:null,after:null,effect:'not_touched'}))}
  e.db.prepare('INSERT INTO managed_navigation_recovery_episodes (id,body) VALUES (?,?)').run(savedImportKey(e.unit),JSON.stringify(prior))
  e.offer();e.enable();e.reserve();expect(e.recovery.budget(e.unit)).toMatchObject({used:3,uiUsed:0,pending:true,exhausted:true});expect(()=>assertRecoveryReservation(e.sql,e.unit,'other_adapter',e.now())).toThrow('reconciliation')
  e.start();e.recovery.finish(phone(),e.fence,'original_restore','verified','opened_original',e.proof(true));expect(()=>assertRecoveryReservation(e.sql,e.unit,'other_adapter',e.now())).toThrow('exhausted')
 })
 it('never lets a historical context override a progressed saved or cancelled owner',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start();e.mutate('managed_attempts',e.unit.attemptId,r=>{r.phase='result_saved';r.submission='saved';r.checkpointRef='checkpoint/output'})
  expect(()=>e.recovery.check(phone(),e.fence,'original_restore',e.proof())).toThrow();expect(e.recovery.budget(e.unit).pending).toBe(true)
 })
})
describe('exact original conversation restoration bridge',()=>{
 async function fixture(){
  const e=await setup();e.offer();let enabled=true,held=false,changed=false;const calls:string[]=[]
  const bridge=new ConversationRestorationBridge({resolve:async()=>({unit:changed?{...e.unit,generation:2}:e.unit,pageLabel:'fixture page'}),enabled:()=>enabled,diagnoses:{assertAdmission:async()=>{if(held)throw new Error('Retained stop')}} as any,call:async(action,fence,details)=>{calls.push(action);const response=await e.api(action,details,fence,'s'.repeat(40));if(!response?.ok)throw new Error('Held relay receipt');return response.json()}})
  const body=(action:string)=>({action,fence:e.fence,expectedRevision:e.record().revision,...(action==='reserve'?{actionId:'bridge_grant'}:{})})
  return {e,bridge,body,calls,off:()=>enabled=false,hold:()=>held=true,change:()=>changed=true}
 }
 it('requires an exact inspected revision and leaves proposal approval separate from the grant',async()=>{
  const f=await fixture();const inspect=await f.bridge.perform({action:'inspect',fence:null,expectedRevision:0})
  expect(inspect.record?.enabled).toBe(false);expect(inspect.budget.used).toBe(0)
  const stale=f.body('reserve');await f.bridge.perform(f.body('enable'));await expect(f.bridge.perform(stale)).rejects.toThrow('Inspect')
  await f.bridge.perform(f.body('reserve'));expect(f.e.record().actions[0]).toMatchObject({id:'bridge_grant',phase:'reserved'});expect(f.e.recovery.budget(f.e.unit)).toMatchObject({used:1,pending:true})
 })
 it.each(['off','hold','change'])('blocks %s before a new grant and preserves the original budget',async kind=>{
  const f=await fixture();await f.bridge.perform(f.body('enable'));if(kind==='off')f.off();if(kind==='hold')f.hold();if(kind==='change')f.change()
  await expect(f.bridge.perform(f.body('reserve'))).rejects.toThrow();expect(f.e.recovery.budget(f.e.unit).used).toBe(0)
 })
 it('allows holding controls while off, without charging or resuming anything',async()=>{
  const f=await fixture();await f.bridge.perform(f.body('enable'));f.off();await f.bridge.perform(f.body('pause'));expect(f.e.record().paused).toBe(true);expect(f.e.recovery.budget(f.e.unit).used).toBe(0)
 })
 it('rejects altered anchor hashes and raw URLs before forwarding any mutation',async()=>{
  const f=await fixture();const body=f.body('enable');body.fence=structuredClone(body.fence);body.fence.anchorSha256='9'.repeat(64)
  await expect(f.bridge.perform(body)).rejects.toThrow('Inspect')
  await expect(f.bridge.perform({...f.body('enable'),url:'private raw conversation URL'})).rejects.toThrow();expect(f.calls.every(x=>x==='discover')).toBe(true)
 })
})
