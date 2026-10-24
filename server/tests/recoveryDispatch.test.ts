import {RecoveryDispatch} from '../../relay/src/recoveryDispatch.js'
import {RecoveryDispatchBridge} from '../src/services/recoveryDispatchBridge.js'
import {DISPATCH_SCHEMA,parseDispatchTicket} from '../src/services/recoveryDispatchProtocol.js'
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
import {accountObservation,type AccountPolicy} from '../src/services/managedAccountsProtocol.js'
import {ACCOUNT_RECHECK_SCHEMA,type AccountRecheckFence} from '../src/services/accountRecheckRecoveryProtocol.js'
import {DEFAULT_CROP_PROMPT} from '../src/services/managedCropPilotPolicy.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite'),opened:any[]=[]
afterEach(()=>{for(const db of opened.splice(0))db.close()})
const studio={role:'studio'} as const,phone=(deviceId='one')=>({role:'phone',deviceId} as const)
const CAPS=['original-recovery-dispatch/1','original-conversation-restoration/1','managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','account-audit/1','account-selection/1']
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
 const env:ManagedTaskEnvironment={MANAGED_CROP_PAGE:'1',MANAGED_CONVERSATION_RESTORATION:'1',MANAGED_WORKSPACE_ID:'workspace',MANAGED_STUDIO_TOKEN:'s'.repeat(40),MANAGED_DEVICE_TOKENS:JSON.stringify({one:'o'.repeat(40),two:'t'.repeat(40)})}
 const api=(action:string,details:Record<string,unknown>={},f:unknown=fence,token='o'.repeat(40))=>new ManagedTaskApi(sql,tx,env,()=>new Date(now).toISOString()).handle(new Request('https://fixture/managed/recovery/original-conversation',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({schema:CONVERSATION_SCHEMA,action,fence:f,details})}))
 const record=()=>recovery.discover(studio,unit)!,offer=()=>recovery.offer(phone(),fence,proof()),enable=()=>recovery.control(studio,fence,record().revision,true,false,false),reserve=(id='original_restore')=>recovery.reserve(studio,fence,record().revision,id),start=(id='original_restore')=>recovery.start(phone(),fence,id,proof())
 const snapshot=()=>({task:a.timeline(studio,task.id),reservations:db.prepare('SELECT * FROM managed_reservations ORDER BY resource').all(),quota:db.prepare('SELECT * FROM managed_account_quotas ORDER BY id').all(),policy:db.prepare("SELECT * FROM managed_account_policies WHERE id='crop_json'").all()})
 const mutate=(table:string,id:string,work:(r:any)=>void)=>{const r=JSON.parse(db.prepare('SELECT body FROM '+table+' WHERE id=?').get(id).body);work(r);db.prepare('UPDATE '+table+' SET body=? WHERE id=?').run(JSON.stringify(r),id)}
 return {a,db,sql,tx,event,policy,claim,recovery,unit,fence,env,api,record,offer,enable,reserve,start,proof,snapshot,mutate,advance:(ms=1)=>now+=ms,now:()=>now}
}

async function prepared(){const e=await setup();e.env.MANAGED_RECOVERY_DISPATCH='1';e.offer();e.enable();e.reserve();
 const dispatch=new RecoveryDispatch(e.sql,e.tx,e.a,()=>e.env.MANAGED_RECOVERY_DISPATCH==='1',()=>e.env.MANAGED_CONVERSATION_RESTORATION==='1',(actor,kind,f)=>e.recovery.status(actor,f).admissionReady,e.now)
 const hash=await artifactHash(new TextEncoder().encode(canonicalJson(e.fence)))
 const queue=()=>dispatch.queue(studio,e.unit,'restore_conversation','original_restore',e.record().revision,hash)
 const delivery=async(action:string,details:any={},unit:any=e.unit,token='o'.repeat(40))=>new ManagedTaskApi(e.sql,e.tx,e.env,()=>new Date(e.now()).toISOString()).handle(new Request('https://fixture/managed/recovery/dispatch',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({schema:DISPATCH_SCHEMA,action,unit,details})}))
 return {...e,dispatch,hash,queue,delivery}
}
describe('one-use original phone dispatch',()=>{
 it('delivers the exact existing grant once without charging another budget or changing ownership',async()=>{
  const e=await prepared(),before=e.snapshot(),budget=e.recovery.budget(e.unit),t=await e.queue();expect(t).toMatchObject({phase:'queued',commandId:e.fence.commandId,deviceId:'one',profileId:'profile',grantRevision:e.record().revision});expect(t.expiresAt-t.queuedAt).toBe(120000)
  expect(e.dispatch.next(phone(),e.unit,e.fence.commandId,'profile')).toEqual(t);expect(()=>e.dispatch.assertEffect(phone(),'restore_conversation',e.fence,'original_restore')).toThrow()
  e.dispatch.claim(phone(),t.id,'durable_claim');expect(e.dispatch.next(phone(),e.unit,e.fence.commandId,'profile')).toBeNull();e.dispatch.check(phone(),t.id,'durable_claim');const done=e.dispatch.complete(phone(),t.id,'durable_claim','consumed');expect(done.phase).toBe('consumed')
  e.dispatch.assertEffect(phone(),'restore_conversation',e.fence,'original_restore');expect(()=>e.dispatch.check(phone(),t.id,'durable_claim')).toThrow();expect(()=>e.dispatch.claim(phone(),t.id,'other_claim')).toThrow()
  expect(e.snapshot()).toEqual(before);expect(e.recovery.budget(e.unit)).toEqual(budget);expect(e.record().actions[0].phase).toBe('reserved')
  expect(await e.queue()).toEqual(done);expect(e.dispatch.claim(phone(),t.id,'durable_claim')).toEqual(done);expect(e.dispatch.complete(phone(),t.id,'durable_claim','consumed')).toEqual(done)
 })
 it('replays a queue receipt after progress/off/expiry without resetting its identity or deadline',async()=>{
  const e=await prepared(),t=await e.queue(),revision=e.record().revision;e.dispatch.claim(phone(),t.id,'claim');e.dispatch.complete(phone(),t.id,'claim','consumed');e.start();e.env.MANAGED_RECOVERY_DISPATCH='0';e.advance(180000)
  const receipt=await e.dispatch.queue(studio,e.unit,'restore_conversation','original_restore',revision,e.hash);expect(receipt.id).toBe(t.id);expect(receipt.expiresAt).toBe(t.expiresAt);expect(receipt.phase).toBe('consumed');expect(()=>e.dispatch.assertEffect(phone(),'restore_conversation',e.fence,'original_restore')).toThrow()
 })
 it.each(['dispatch_off','kind_off','expiry','revision','lease','reservation','capability','identity','source','capacity'])('holds changed %s before claim without spending another attempt',async change=>{
  const e=await prepared(),t=await e.queue()
  if(change==='dispatch_off')e.env.MANAGED_RECOVERY_DISPATCH='0'
  if(change==='kind_off')e.env.MANAGED_CONVERSATION_RESTORATION='0'
  if(change==='expiry')e.advance(120000)
  if(change==='lease')e.advance(3600000)
  if(change==='revision')e.enable()
  if(change==='reservation')e.db.prepare('DELETE FROM managed_reservations WHERE resource=?').run('browser:one')
  if(change==='capability')e.mutate('managed_peers','one',r=>r.capabilities=[])
  if(change==='source')e.mutate('managed_tasks',e.unit.taskId,r=>r.spec.dependencies[0].sha256='9'.repeat(64))
  if(change==='capacity')e.mutate('managed_account_accounts','shared',r=>r.maxConcurrent=0)
  if(change==='identity'){const id=e.db.prepare('SELECT id FROM managed_account_profiles WHERE body LIKE ?').get('%"deviceId":"one"%').id;e.mutate('managed_account_profiles',id,r=>r.links.chatgpt.accountId='foreign')}
  expect(()=>e.dispatch.claim(phone(),t.id,'claim')).toThrow();expect(e.dispatch.ticket(studio,t.id).phase).toBe('queued');expect(e.recovery.budget(e.unit).used).toBe(1)
 })
 it('requires exact approved hash/revision, actors and original unit before mutations',async()=>{
  const e=await prepared();await expect(e.dispatch.queue(studio,e.unit,'restore_conversation','original_restore',e.record().revision,'9'.repeat(64))).rejects.toThrow();await expect(e.dispatch.queue(phone(),e.unit,'restore_conversation','original_restore',e.record().revision,e.hash)).rejects.toThrow()
  const t=await e.queue();expect(()=>e.dispatch.claim(phone('two'),t.id,'claim')).toThrow();expect(()=>e.dispatch.next(phone(),e.unit,'wrong','profile')).toThrow()
  expect((await e.delivery('claim',{ticketId:t.id,claimId:'claim'},{...e.unit,attemptId:'foreign'}))!.status).toBe(409);expect(e.dispatch.ticket(studio,t.id).phase).toBe('queued')
  expect((await e.delivery('claim',{ticketId:t.id,claimId:'claim'},e.unit,'s'.repeat(40)))!.status).toBe(409)
 })
 it.each(['queued','claimed','consumed'])('retained stops freeze %s delivery without erasing its action',async phase=>{
  const e=await prepared(),t=await e.queue();if(phase!=='queued')e.dispatch.claim(phone(),t.id,'claim');if(phase==='consumed')e.dispatch.complete(phone(),t.id,'claim','consumed')
  new RecoveryStops(e.sql,e.tx,e.a,new AccountRecheckRecovery(e.sql,e.tx,e.a,e.now),e.now).apply(studio,{schema:'recovery-stop/1',unit:e.unit,eventId:'stop_dispatch',sequence:1,mode:'pause'})
  const kept=e.dispatch.ticket(studio,t.id);expect(kept.phase).toBe(phase==='consumed'?'consumed':'cancelled');expect(e.record()).toMatchObject({enabled:false,paused:true});expect(e.recovery.budget(e.unit).used).toBe(1)
  expect(()=>e.dispatch.assertEffect(phone(),'restore_conversation',e.fence,'original_restore')).toThrow();expect(e.dispatch.complete(phone(),t.id,'claim','consumed')).toEqual(kept)
 })
 it('cancelled delivery cannot be claimed, consumed or restarted even after re-enable',async()=>{
  const e=await prepared(),t=await e.queue(),cancel=e.dispatch.cancel(studio,t.id,t.revision);expect(()=>e.dispatch.claim(phone(),t.id,'claim')).toThrow();expect(e.dispatch.complete(phone(),t.id,'claim','consumed')).toEqual(cancel);expect(await e.queue()).toEqual(cancel)
 })
 it('can decline without a claim and reconcile a consumed fact while all gates are off',async()=>{
  const e=await prepared(),t=await e.queue();e.env.MANAGED_RECOVERY_DISPATCH='0';const held=e.dispatch.complete(phone(),t.id,'claim','held');expect(held.phase).toBe('held');expect(e.dispatch.complete(phone(),t.id,'claim','held')).toEqual(held);expect(()=>e.dispatch.complete(phone(),t.id,'claim','consumed')).toThrow();expect(e.record().actions[0].phase).toBe('reserved')
 })
 it('enforces effect gate on normal adapter endpoints but still accepts factual no-touch outcomes while off',async()=>{
  const e=await prepared(),t=await e.queue();expect((await e.api('start',{actionId:'original_restore',proof:e.proof()}))!.status).toBe(409)
  e.dispatch.claim(phone(),t.id,'claim');e.dispatch.complete(phone(),t.id,'claim','consumed');expect((await e.api('start',{actionId:'original_restore',proof:e.proof()}))!.status).toBe(200)
  e.env.MANAGED_RECOVERY_DISPATCH='0';expect((await e.api('check',{actionId:'original_restore',proof:e.proof()}))!.status).toBe(409)
  expect((await e.api('finish',{actionId:'original_restore',outcome:'unknown',effect:'possible',proof:null}))!.status).toBe(200);expect(e.record().actions[0].phase).toBe('unknown')
 })
 it('survives authority restart and keeps a lost-ack claim bound to the first nonce',async()=>{
  const e=await prepared(),t=await e.queue();expect((await e.delivery('claim',{ticketId:t.id,claimId:'durable'}))!.status).toBe(200)
  const response=await (await e.delivery('claim',{ticketId:t.id,claimId:'durable'}))!.json();expect(response.ticket.phase).toBe('claimed');expect((await e.delivery('claim',{ticketId:t.id,claimId:'replacement'}))!.status).toBe(409)
  expect((await e.delivery('complete',{ticketId:t.id,claimId:'durable',outcome:'consumed'}))!.status).toBe(200);expect((await (await e.delivery('next',{commandId:e.fence.commandId,profileId:'profile'}))!.json()).ticket).toBeNull()
 })
 it('rejects malformed tickets and expanded permissions',async()=>{const e=await prepared(),t=await e.queue();for(const patch of [{expiresAt:t.queuedAt+120001},{commandId:'foreign'},{unit:{...t.unit,generation:2}},{kind:'provider_fallback'},{phase:'consumed'},{url:'https://private.example'}])expect(()=>parseDispatchTicket({...t,...patch})).toThrow()})
 it('requires separate exact Studio approval, rechecks source and keeps browser receipts free of private fences',async()=>{
  const e=await prepared();let enabled=true,changed=false,calls=0;const bridge=new RecoveryDispatchBridge({resolve:async()=>({unit:changed?{...e.unit,generation:2}:e.unit,pageLabel:'page'}),enabled:()=>enabled,diagnoses:{assertAdmission:async()=>{calls++}} as any,call:async(action,unit,details)=>{const r=await e.delivery(action,details,unit,'s'.repeat(40));if(!r?.ok)throw Error('held');return r.json()}})
  const view=await bridge.perform({action:'inspect'}),g=view.grants[0];expect(g).toBeTruthy();expect(view.tickets).toEqual([]);expect(calls).toBe(0)
  enabled=false;await expect(bridge.perform({action:'queue',kind:g.kind,actionId:g.actionId,grantRevision:g.grantRevision,fenceSha256:g.fenceSha256})).rejects.toThrow();enabled=true
  const delivered=await bridge.perform({action:'queue',kind:g.kind,actionId:g.actionId,grantRevision:g.grantRevision,fenceSha256:g.fenceSha256});expect(calls).toBe(2);expect(delivered.tickets[0]).not.toHaveProperty('fence');expect(delivered.tickets[0].phase).toBe('queued');expect(delivered.grants).toEqual([])
  enabled=false;expect((await bridge.perform({action:'cancel',ticketId:delivered.tickets[0].id,revision:1})).tickets[0].phase).toBe('cancelled')
 })
})
