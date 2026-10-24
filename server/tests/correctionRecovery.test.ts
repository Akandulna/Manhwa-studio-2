import {CorrectionRecoveryBridge} from '../src/services/correctionRecoveryBridge.js'
import {CorrectionRecovery} from '../../relay/src/correctionRecovery.js'
import {CORRECTION_SCHEMA,parseCorrectionRecord} from '../src/services/correctionRecoveryProtocol.js'
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
const CAPS=['managed-correction-recovery/1','managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','account-audit/1','account-selection/1']
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
 const output=canonicalJson({pointers:JSON.stringify({format:'four-point-crop',version:'1.0',image:{filename:'page.jpg',width:800,height:4096},coordinateSystem:'normalized',crops:[{id:'crop-01',reason:'scene',crop:{mode:'rectangle',points:[{id:'P1',x:0,y:0},{id:'P2',x:1,y:0},{id:'P3',x:1,y:1},{id:'P4',x:0,y:1}]}}]}),metadata:JSON.stringify({crops:[{id:'crop-01',exportedFilename:'panel.png',description:'A complete illustrated scene.'}]})})
 const context={schema:'managed-correction-context/1' as const,capturedAt:now,bindingId:'original_view',sourceSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),promptSha256:'c'.repeat(64),replySha256:'d'.repeat(64),rawCheckpointRef:'checkpoint/raw',accountId:'shared',policyRevision:1,state:'scoped' as const,lockedCandidates:1,failedCandidates:1,lockedDigest:'e'.repeat(64),planDigest:'f'.repeat(64),executable:false as const,portable:false as const,liveConversationVerified:false as const}
 const preview={schema:'managed-correction-preview/1' as const,originalReplySha256:context.replySha256,proposalSha256:'1'.repeat(64),artifactSha256:await artifactHash(new TextEncoder().encode(output)),manifestSha256:context.manifestSha256,lockedDigest:context.lockedDigest,lockedCandidates:1,failedCandidates:1,changedFields:1,changeDigest:'2'.repeat(64),executable:false as const,portable:false as const}
 const fence={unit,commandId:claim.command.id,deviceId:'one',profileId:'profile',context,preview}
 const recovery=new CorrectionRecovery(sql,tx,a,()=>now)
 const env:ManagedTaskEnvironment={MANAGED_CROP_PAGE:'1',MANAGED_CORRECTION_RECOVERY:'1',MANAGED_WORKSPACE_ID:'workspace',MANAGED_STUDIO_TOKEN:'s'.repeat(40),MANAGED_DEVICE_TOKENS:JSON.stringify({one:'o'.repeat(40),two:'t'.repeat(40)})}
 const api=(action:string,details:Record<string,unknown>={},f:unknown=fence,token='o'.repeat(40))=>new ManagedTaskApi(sql,tx,env,()=>new Date(now).toISOString()).handle(new Request('https://fixture/managed/recovery/correction',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({schema:CORRECTION_SCHEMA,action,fence:f,details})}))
 const record=()=>recovery.discover(studio,unit)!,offer=()=>recovery.offer(phone(),fence),enable=()=>recovery.control(studio,fence,record().revision,true,false,false),reserve=(id='original_correction')=>recovery.reserve(studio,fence,record().revision,id),start=(id='original_correction')=>recovery.start(phone(),fence,id)
 const commit=()=>recovery.commit(phone(),fence,'original_correction','checkpoint_event','checkpoint/corrected',output,env.MANAGED_CORRECTION_RECOVERY==='1')
 const snapshot=()=>({task:a.timeline(studio,task.id),reservations:db.prepare('SELECT * FROM managed_reservations ORDER BY resource').all(),quota:db.prepare('SELECT * FROM managed_account_quotas ORDER BY id').all(),policy:db.prepare("SELECT * FROM managed_account_policies WHERE id='crop_json'").all()})
 const mutate=(table:string,id:string,work:(r:any)=>void)=>{const r=JSON.parse(db.prepare('SELECT body FROM '+table+' WHERE id=?').get(id).body);work(r);db.prepare('UPDATE '+table+' SET body=? WHERE id=?').run(JSON.stringify(r),id)}
 return {a,db,sql,tx,event,policy,claim,recovery,unit,fence,env,api,record,offer,enable,reserve,start,output,commit,snapshot,mutate,advance:(ms=1)=>now+=ms,now:()=>now}
}
describe('budgeted local correction checkpoint and publication',()=>{
 it('rechecks dispatch admission inside the final transaction after asynchronous hash validation',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start();let gates=0
  await expect(e.recovery.commit(phone(),e.fence,'original_correction','checkpoint_event','checkpoint/corrected',e.output,true,()=>{gates++;throw Error('delivery stopped')})).rejects.toThrow('delivery stopped')
  expect(gates).toBe(1);expect(e.record().actions[0].phase).toBe('executing');expect(e.a.timeline(studio,e.unit.taskId).attempt?.phase).toBe('submitted')
  await e.commit();expect(e.record().actions[0].phase).toBe('verified')
  await e.recovery.commit(phone(),e.fence,'original_correction','checkpoint_event','checkpoint/corrected',e.output,false,()=>{throw Error('must not gate immutable replay')})
 })

 it('charges once and saves the approved exact bytes without releasing resources or marking review complete',async()=>{
  const e=await setup(),before=e.snapshot();e.offer();e.enable();e.reserve();e.start()
  expect(e.recovery.budget(e.unit)).toMatchObject({used:1,pending:true});expect(()=>e.start()).toThrow()
  const receipt=await e.commit();expect(receipt.result).toMatchObject({permitted:true,attempt:{phase:'result_saved',checkpointRef:'checkpoint/corrected'}})
  expect(e.a.timeline(studio,e.unit.taskId).task.canonical).toBeNull()
  expect(e.snapshot().reservations).toEqual(before.reservations);expect(e.snapshot().policy).toEqual(before.policy);expect(e.snapshot().quota).toEqual(before.quota)
  expect(e.recovery.budget(e.unit)).toMatchObject({used:1,pending:false})
  expect(await e.commit()).toEqual(receipt)
 })
 it('replays the exact checkpoint after restart, flag-off, expiry and a retained cancellation',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start();const receipt=await e.commit()
  const stops=new RecoveryStops(e.sql,e.tx,e.a,new AccountRecheckRecovery(e.sql,e.tx,e.a,e.now),e.now)
  stops.apply(studio,{schema:'recovery-stop/1',unit:e.unit,eventId:'cancel_saved',sequence:1,mode:'cancel'});e.env.MANAGED_CORRECTION_RECOVERY='0';e.advance(3600000)
  const restarted=new CorrectionRecovery(e.sql,e.tx,e.a,e.now)
  const replay=await restarted.commit(phone(),e.fence,'original_correction','checkpoint_event','checkpoint/corrected',e.output,false)
  expect(replay.result).toEqual(receipt.result);expect(replay.record.cancelled).toBe(true)
  await expect(restarted.commit(phone(),e.fence,'original_correction','different_event','checkpoint/corrected',e.output,false)).rejects.toThrow('immutable')
 })
 it('holds unknown effects across restart and reconciles only the exact original checkpoint without another budget charge',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start();e.recovery.finish(phone(),e.fence,'original_correction','unknown')
  expect(()=>e.reserve('again')).toThrow();expect(()=>assertRecoveryReservation(e.sql,e.unit,'other',e.now())).toThrow('reconciliation')
  expect(()=>e.recovery.finish(phone(),e.fence,'original_correction','safe_failure')).toThrow('Uncertain')
  await e.commit();expect(e.record().actions[0].phase).toBe('verified');expect(e.recovery.budget(e.unit).used).toBe(1)
 })
 it('rejects unapproved bytes, forged grants and every ordinary completion bypass',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start()
  await expect(e.recovery.commit(phone(),e.fence,'original_correction','event','checkpoint/output',e.output+' ',true)).rejects.toThrow('hash')
  expect(()=>e.a.checkpoint(phone(),e.event(),e.unit.taskId,e.unit.attemptId,e.unit.generation,e.unit.fingerprint,'result_saved','checkpoint/bypass',e.fence.commandId)).toThrow('budgeted')
  await expect(e.recovery.commit(phone('two'),e.fence,'original_correction','event','checkpoint/output',e.output,true)).rejects.toThrow('Original')
  await expect(e.recovery.commit(phone(),{...e.fence,preview:{...e.fence.preview,proposalSha256:'3'.repeat(64)}},'original_correction','event','checkpoint/output',e.output,true)).rejects.toThrow('proposal')
  expect(e.a.timeline(studio,e.unit.taskId).attempt?.phase).toBe('submitted')
 })
 it.each(['policy','lease','source','capability','reservation','stop','off'])('fences %s before accepting the saved checkpoint',async kind=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start()
  if(kind==='policy')e.mutate('managed_account_policies','crop_json',r=>r.revision++)
  if(kind==='lease')e.advance(3600000)
  if(kind==='source')e.mutate('managed_tasks',e.unit.taskId,r=>r.spec.dependencies[0].sha256='9'.repeat(64))
  if(kind==='capability')e.mutate('managed_peers','one',r=>r.capabilities=[])
  if(kind==='reservation')e.db.prepare('DELETE FROM managed_reservations WHERE resource=?').run('browser:one')
  if(kind==='stop')new RecoveryStops(e.sql,e.tx,e.a,new AccountRecheckRecovery(e.sql,e.tx,e.a,e.now),e.now).apply(studio,{schema:'recovery-stop/1',unit:e.unit,eventId:'hold',sequence:1,mode:'pause'})
  if(kind==='off')e.env.MANAGED_CORRECTION_RECOVERY='0'
  await expect(e.commit()).rejects.toThrow();expect(e.a.timeline(studio,e.unit.taskId).attempt?.phase).toBe('submitted');expect(e.recovery.budget(e.unit)).toMatchObject({used:1,pending:true})
 })
 it('prevents expired saved recovery from bypassing an unresolved correction grant',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start();e.advance(3600000)
  expect(()=>e.a.recoverSaved(phone(),e.event(),e.unit.taskId,e.unit.attemptId,e.unit.generation,e.unit.fingerprint,'checkpoint/bypass',e.fence.commandId)).toThrow('budgeted correction')
  expect(e.a.timeline(studio,e.unit.taskId).attempt?.phase).toBe('submitted')
 })
 it('retains a no-touch withdrawal charge, cooldown and the shared three-action ceiling',async()=>{
  const e=await setup();e.offer();e.enable()
  for(let n=0;n<3;n++){e.reserve('unused_'+n);e.recovery.finish(phone(),e.fence,'unused_'+n,'safe_failure');expect(()=>e.reserve('early_'+n)).toThrow();e.advance(30000)}
  expect(e.recovery.budget(e.unit)).toMatchObject({used:3,exhausted:true,pending:false});expect(()=>e.reserve('fourth')).toThrow('exhausted')
 })
 it('validates geometry before checkpointing and rolls back a rejected artifact atomically',async()=>{
  const e=await setup();const malformed=JSON.parse(e.output);malformed.pointers=JSON.stringify({format:'wrong'});e.output=canonicalJson(malformed);e.fence.preview.artifactSha256=await artifactHash(new TextEncoder().encode(e.output))
  e.offer();e.enable();e.reserve();e.start()
  await expect(e.recovery.commit(phone(),e.fence,'original_correction','event','checkpoint/output',e.output,true)).rejects.toThrow()
  expect(e.a.timeline(studio,e.unit.taskId).attempt?.checkpointRef).toBeNull();expect(e.record().actions[0].phase).toBe('executing')
 })
 it('pins the normal immutable artifact upload and publication to the corrected output',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start();await e.commit()
  const a=e.record().actions[0],ref='managed/workspace/'+e.unit.taskId.slice(12)+'/'+e.unit.attemptId+'/corrected_artifact'
  expect(()=>e.a.reserveArtifact(phone(),e.unit.taskId,e.unit.attemptId,e.unit.generation,e.unit.fingerprint,'corrected_artifact',ref,'9'.repeat(64),100)).toThrow('approved')
  e.a.reserveArtifact(phone(),e.unit.taskId,e.unit.attemptId,e.unit.generation,e.unit.fingerprint,'corrected_artifact',ref,a.artifactHash!,100)
  e.a.stage(phone(),e.event(),e.unit.taskId,e.unit.attemptId,e.unit.generation,e.unit.fingerprint,'corrected_artifact',ref,a.artifactHash!)
  e.a.publish(studio,e.event(),e.unit.taskId,e.unit.attemptId,e.unit.generation,e.unit.fingerprint,'corrected_artifact',a.artifactHash!,'validation/fixture')
  expect(e.a.timeline(studio,e.unit.taskId).task).toMatchObject({state:'verified_complete',canonical:ref})
  expect(e.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(0)
 })
 it('shares prior navigation charges and its own pending hold with every other playbook',async()=>{
  const e=await setup();e.offer();e.enable()
  const navFence={unit:e.unit,commandId:e.fence.commandId,deviceId:'one',profileId:'profile',bindingId:'old_view',sourceSha256:'a'.repeat(64),accountId:'shared',policyRevision:1}
  const session={schema:'managed-session-evidence/1',bindingId:'old_view',commandId:e.fence.commandId,profileId:'profile',fingerprint:e.unit.fingerprint,cachedSourceSha256:'a'.repeat(64),observedAt:e.now()-10,documentKind:'chatgpt_home',ready:false,composer:'empty',attachments:'none',response:'none',login:'unknown',exactView:true,currentProfile:true,cachedSourceVerified:true,untouched:true,context:'held'}
  const navigation={schema:'unsent-navigation-recovery/1',fence:navFence,revision:5,enabled:true,paused:false,cancelled:false,nextEligibleAt:0,offer:session,actions:[1,2].map(n=>({id:'previous_nav_'+n,at:e.now()-10,phase:'safe_failure',finishedAt:e.now()-9,evidenceRef:'navigation/previous_nav_'+n,before:null,after:null,effect:'not_touched'}))}
  e.db.prepare('INSERT INTO managed_navigation_recovery_episodes (id,body) VALUES (?,?)').run(savedImportKey(e.unit),JSON.stringify(navigation))
  e.reserve();expect(e.recovery.budget(e.unit)).toMatchObject({used:3,uiUsed:0,pending:true,exhausted:true});expect(()=>assertRecoveryReservation(e.sql,e.unit,'foreign_adapter',e.now())).toThrow('reconciliation')
  e.start();await e.commit();expect(()=>assertRecoveryReservation(e.sql,e.unit,'foreign_adapter',e.now())).toThrow('exhausted')
 })
 it('preparation resumes nothing; explicit re-enable reconciles the original pending save without another grant',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start()
  const stops=new RecoveryStops(e.sql,e.tx,e.a,new AccountRecheckRecovery(e.sql,e.tx,e.a,e.now),e.now),intent={schema:'recovery-stop/1',unit:e.unit,eventId:'pause_pending',sequence:1,mode:'pause'}
  stops.apply(studio,intent);await expect(e.commit()).rejects.toThrow()
  stops.apply(studio,{...intent,eventId:'prepare_pending',sequence:2,mode:'reinspect'});expect(e.record()).toMatchObject({enabled:false,paused:true});await expect(e.commit()).rejects.toThrow()
  e.enable();await e.commit();expect(e.recovery.budget(e.unit)).toMatchObject({used:1,pending:false})
 })
 it('can re-enable only the verified original saved output after a pause, without another correction',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start();await e.commit()
  e.recovery.control(studio,e.fence,e.record().revision,false,true,false);e.enable()
  expect(e.recovery.status(studio,e.fence).admissionReady).toBe(true);expect(()=>e.reserve('another')).toThrow()
  const a=e.record().actions[0],ref='managed/workspace/'+e.unit.taskId.slice(12)+'/'+e.unit.attemptId+'/corrected_artifact'
  e.a.reserveArtifact(phone(),e.unit.taskId,e.unit.attemptId,e.unit.generation,e.unit.fingerprint,'corrected_artifact',ref,a.artifactHash!,100)
  expect(e.recovery.budget(e.unit).used).toBe(1)
 })
 it('retained stop prevents staging/publication after a corrected checkpoint',async()=>{
  const e=await setup();e.offer();e.enable();e.reserve();e.start();await e.commit()
  new RecoveryStops(e.sql,e.tx,e.a,new AccountRecheckRecovery(e.sql,e.tx,e.a,e.now),e.now).apply(studio,{schema:'recovery-stop/1',unit:e.unit,eventId:'stop_saved',sequence:1,mode:'pause'})
  const ref='managed/workspace/'+e.unit.taskId.slice(12)+'/'+e.unit.attemptId+'/corrected_artifact'
  expect(()=>e.a.reserveArtifact(phone(),e.unit.taskId,e.unit.attemptId,e.unit.generation,e.unit.fingerprint,'corrected_artifact',ref,e.record().actions[0].artifactHash!,100)).toThrow()
  expect(e.a.timeline(studio,e.unit.taskId).task.canonical).toBeNull()
 })
 it('enforces API default-off, exact fields and separate phone/Studio authority',async()=>{
  const e=await setup();delete e.env.MANAGED_CORRECTION_RECOVERY
  expect((await e.api('discover',{},e.unit))!.status).toBe(200);expect((await e.api('offer'))!.status).toBe(503)
  e.env.MANAGED_CORRECTION_RECOVERY='1';e.offer()
  expect((await e.api('control',{revision:e.record().revision,enabled:true,paused:false,cancelled:false}))!.status).toBe(409)
  expect((await e.api('offer',{force:true}))!.status).toBe(409)
  expect((await e.api('offer',{},e.fence,'t'.repeat(40)))!.status).toBe(409)
 })
})
describe('exact Studio correction approval bridge',()=>{
 async function fixture(){
  const e=await setup();e.offer();let enabled=true,held=false,changed=false;const calls:string[]=[]
  const bridge=new CorrectionRecoveryBridge({resolve:async()=>({unit:changed?{...e.unit,generation:2}:e.unit,pageLabel:'fixture page'}),enabled:()=>enabled,diagnoses:{assertAdmission:async()=>{if(held)throw new Error('Retained stop')}} as any,call:async(action,fence,details)=>{calls.push(action);const response=await e.api(action,details,fence,'s'.repeat(40));if(!response?.ok)throw new Error('Held relay receipt');return response.json()}})
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
 it('rejects altered proposal hashes and raw drafts before forwarding any mutation',async()=>{
  const f=await fixture();const body=f.body('enable');body.fence=structuredClone(body.fence);body.fence.preview.proposalSha256='9'.repeat(64)
  await expect(f.bridge.perform(body)).rejects.toThrow('Inspect')
  await expect(f.bridge.perform({...f.body('enable'),proposal:'private raw draft'})).rejects.toThrow();expect(f.calls.every(x=>x==='discover')).toBe(true)
 })
})
