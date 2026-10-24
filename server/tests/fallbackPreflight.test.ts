import {createRequire} from 'node:module'
import {afterEach,describe,it,expect,vi} from 'vitest'
import {TaskAuthority} from '../../relay/src/taskAuthority.js'
import {ManagedTaskApi,type ManagedTaskEnvironment} from '../../relay/src/managedTaskApi.js'
import {FallbackPreflightAuthority} from '../../relay/src/fallbackPreflight.js'
import {FallbackPreflightBridge,fallbackPreflightTransport} from '../src/services/fallbackPreflightBridge.js'
import {FALLBACK_PREFLIGHT_SCHEMA,EXECUTION_BLOCKERS,parseFallbackPreflight} from '../src/services/fallbackPreflightProtocol.js'
import {accountObservation,profileKey,type AccountPolicy} from '../src/services/managedAccountsProtocol.js'
import {DEFAULT_CROP_PROMPT} from '../src/services/managedCropPilotPolicy.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite'),opened:any[]=[]
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();for(const db of opened.splice(0))db.close()})
const studio={role:'studio'} as const,phone=(deviceId='one')=>({role:'phone',deviceId} as const)
const CAPS=['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','account-audit/1','account-selection/1']
const spec={version:'crop-page/1' as const,provider:'chatgpt' as const,product:'chatgpt-web',model:'provider-default',settings:{mode:null,effort:null},pageRevision:'r1',promptVersion:DEFAULT_CROP_PROMPT,validatorVersion:'managed-crop-validator/1',dependencies:[{id:'page',revision:'r1',sha256:'a'.repeat(64)}]}
async function setup(outcome='unsent',released=true){
 const db=new DatabaseSync(':memory:');opened.push(db);let now=1792714000000,seq=0
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
 const task=await a.plan(studio,event(),{workspaceId:'workspace',seriesId:'series',chapterId:'chapter',pageId:'page'},spec),claim=a.claim(studio,event(),task.id,'one','profile',null)
 for(const phase of ['accepted','started'] as const)a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,phase,null,claim.command.id)
 if(outcome!=='unsent')a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,'submission_intent',null,claim.command.id)
 if(['submitted','saved'].includes(outcome))a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,'submitted',null,claim.command.id)
 if(outcome==='saved')a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,'result_saved','checkpoint/saved',claim.command.id)
 if(released){const stopped=a.stop(studio,event(),task.id,false);a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,'stop_confirmed',null,stopped.command!.id)}
 const unit={workspaceId:'workspace',taskId:task.id,attemptId:claim.attempt.id,generation:claim.attempt.generation,fingerprint:task.fingerprint},targets=[{deviceId:'two',profileId:'profile'}]
 const env:ManagedTaskEnvironment={MANAGED_AUTOMATIC_RECOVERY:'1',MANAGED_CROP_PAGE:'1',MANAGED_WORKSPACE_ID:'workspace',MANAGED_STUDIO_TOKEN:'s'.repeat(40),MANAGED_DEVICE_TOKENS:JSON.stringify({one:'o'.repeat(40),two:'t'.repeat(40)})}
 const api=new ManagedTaskApi(sql,tx,env,()=>new Date(now).toISOString()),authority=new FallbackPreflightAuthority(sql,tx,a,()=>now)
 const inspect=()=>authority.inspect(studio,unit,targets)
 const call=(body:any={schema:FALLBACK_PREFLIGHT_SCHEMA,unit,targets},token='s'.repeat(40))=>api.handle(new Request('https://fixture/managed/recovery/fallback-preflight',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(body)}))
 const dump=()=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((x:any)=>[x.name,db.prepare('SELECT * FROM '+x.name+' ORDER BY rowid').all()])
 const mutate=(table:string,id:string,work:(r:any)=>void)=>{const r=JSON.parse(db.prepare('SELECT body FROM '+table+' WHERE id=?').get(id).body);work(r);db.prepare('UPDATE '+table+' SET body=? WHERE id=?').run(JSON.stringify(r),id)}
 return {a,db,sql,tx,unit,targets,env,authority,inspect,call,dump,mutate,event,now:()=>now,advance:(ms:number)=>now+=ms,claim}
}
describe('authoritative read-only independent-account fallback preflight',()=>{
 it('reports real source release and target prerequisites but grants no handoff and writes no rows',async()=>{
  const e=await setup(),before=e.dump(),result=e.inspect();expect(result.state).toBe('prerequisites_only');expect(result.source.reasons).toEqual([]);expect(result.targets[0]).toMatchObject({accountId:'alternative',authorityEligible:true,reasons:[]})
  expect(result.executionBlockers).toEqual(EXECUTION_BLOCKERS);expect(result).toMatchObject({handoffAllowed:false,executionAllowed:false,resendAllowed:false,ownershipChanged:false,budget:{used:0}})
  expect(e.dump()).toEqual(before);expect(e.inspect().checkedAt).toBe(e.now());expect(e.dump()).toEqual(before)
  const response=await e.call();expect(response!.status).toBe(200);expect(response!.headers.get('Cache-Control')).toBe('no-store');expect(e.dump()).toEqual(before)
  expect(JSON.stringify(result)).not.toMatch(/example.com|Bearer|PRIVATE|email|candidate/)
 })
 it.each(['unknown','submitted','saved'])('never turns stopped %s work into resend permission',async outcome=>{
  const e=await setup(outcome),before=e.dump(),r=e.inspect();expect(r.state).toBe('source_blocked');expect(r.source.reasons).toContain(outcome==='saved'?'original_output_retained':'original_outcome_unresolved');expect(r.handoffAllowed).toBe(false);expect(e.dump()).toEqual(before)
 })
 it('does not infer release from lease expiry, a pause request or vanished reservations',async()=>{
  const e=await setup('unsent',false);e.advance(3600000);e.db.prepare('DELETE FROM managed_reservations').run();expect(e.inspect().source.reasons).toContain('confirmed_unsent_stop_required')
 })
 it.each(['policy','pin','configuration','stop','cancelled','reservation'])('holds changed %s source authority',async kind=>{
  const e=await setup()
  if(kind==='policy')e.mutate('managed_account_policies','crop_json',r=>{r.contextPortable=false})
  if(kind==='pin')e.mutate('managed_attempts',e.unit.attemptId,r=>{r.accountSelection.policy.revision++})
  if(kind==='configuration')e.mutate('managed_attempts',e.unit.attemptId,r=>{r.accountSelection.configuration.pageRevision='different'})
  if(kind==='stop'){const r=e.a.timeline(studio,e.unit.taskId).attempt!;e.mutate('managed_commands',r.activeCommandId,c=>{c.phase='queued'})}
  if(kind==='cancelled')e.mutate('managed_tasks',e.unit.taskId,r=>{r.state='cancelled'})
  if(kind==='reservation')e.db.prepare('INSERT INTO managed_reservations (resource,attempt_id) VALUES (?,?)').run('device:one',e.unit.attemptId)
  expect(e.inspect().source.reasons.length).toBeGreaterThan(0)
 })
 it.each(['missing','login','identity','future_account','stale_account','future_peer','stale_peer','capability','enrollment','resource','capacity','same_account','generation_quota','upload_quota','blocked_quota','estimated_quota','future_quota','stale_quota','reset'])('reports target %s from actual records without mutation',async kind=>{
  const e=await setup(),profile='two/profile'
  if(kind==='missing')e.db.prepare('DELETE FROM managed_account_profiles WHERE id=?').run(profile)
  if(kind==='login')e.mutate('managed_account_profiles',profile,r=>{r.observation.sites.chatgpt.login='signed_out'})
  if(kind==='identity')e.mutate('managed_account_profiles',profile,r=>{r.observation.sites.chatgpt.candidate='other'})
  if(kind==='future_account'||kind==='stale_account')e.mutate('managed_account_profiles',profile,r=>{r.observation.checkedAt=e.now()+(kind==='future_account'?1:-120000)})
  if(kind==='future_peer'||kind==='stale_peer')e.mutate('managed_peers','two',r=>{r.receivedAt=new Date(e.now()+(kind==='future_peer'?1:-900000)).toISOString()})
  if(kind==='capability')e.mutate('managed_peers','two',r=>{r.capabilities=[]})
  if(kind==='enrollment')e.db.prepare('DELETE FROM managed_enrollment WHERE id=?').run('two')
  if(kind==='resource')e.db.prepare('INSERT INTO managed_reservations (resource,attempt_id) VALUES (?,?)').run('device:two','other')
  if(kind==='capacity')e.db.prepare('INSERT INTO managed_reservations (resource,attempt_id) VALUES (?,?)').run('account:alternative:0','other')
  if(kind==='same_account')e.mutate('managed_account_profiles',profile,r=>{const original=JSON.parse(e.db.prepare('SELECT body FROM managed_account_profiles WHERE id=?').get('one/profile').body);r.links.chatgpt=original.links.chatgpt;r.observation.sites.chatgpt=original.observation.sites.chatgpt})
  if(kind==='generation_quota'||kind==='upload_quota')e.db.prepare("DELETE FROM managed_account_quotas WHERE json_extract(body,'$.accountId')='alternative' AND json_extract(body,'$.scope.feature')=?").run(kind==='generation_quota'?'crop_json':'uploads')
  if(['blocked_quota','estimated_quota','future_quota','stale_quota','reset'].includes(kind)){
   const row=e.db.prepare("SELECT id FROM managed_account_quotas WHERE json_extract(body,'$.accountId')='alternative' LIMIT 1").get()
   e.mutate('managed_account_quotas',row.id,r=>{if(kind==='blocked_quota')r.state='blocked';if(kind==='estimated_quota')r.evidence='estimated';if(kind==='future_quota')r.observedAt=e.now()+1;if(kind==='stale_quota')r.observedAt=e.now()-24*3600000;if(kind==='reset')r.recheckAt=e.now()})
  }
  const before=e.dump(),result=e.inspect();expect(result.targets[0].authorityEligible).toBe(false);expect(result.targets[0].reasons.length).toBeGreaterThan(0);expect(result.state).toBe('target_waiting');expect(e.dump()).toEqual(before)
 })
 it('retains source times and clips the snapshot to target evidence expiry',async()=>{
  const e=await setup();e.mutate('managed_account_profiles','two/profile',r=>{r.observation.checkedAt=e.now()-119000})
  const r=e.inspect();expect(r.validUntil).toBe(e.now()+1000);expect(r.targets[0].accountObservedAt).toBe(e.now()-119000);e.advance(1000);expect(()=>parseFallbackPreflight(r,e.unit,e.targets,e.now())).toThrow()
 })
 it('rejects phone principals, foreign or stale units, caller permission claims and duplicate targets',async()=>{
  const e=await setup(),before=e.dump()
  for(const token of ['o'.repeat(40),'t'.repeat(40)])expect((await e.call(undefined,token))!.status).toBe(403)
  for(const body of [{schema:FALLBACK_PREFLIGHT_SCHEMA,unit:{...e.unit,generation:2},targets:e.targets},{schema:FALLBACK_PREFLIGHT_SCHEMA,unit:{...e.unit,workspaceId:'other'},targets:e.targets},{schema:FALLBACK_PREFLIGHT_SCHEMA,unit:e.unit,targets:[...e.targets,...e.targets]},{schema:FALLBACK_PREFLIGHT_SCHEMA,unit:e.unit,targets:e.targets,safeReleaseVerified:true}])expect((await e.call(body))!.status).toBe(409)
  expect(e.dump()).toEqual(before)
 })
 it('rejects promoted, foreign, incomplete and stale receipt evidence',async()=>{
  const e=await setup(),r=e.inspect()
  for(const patch of [{handoffAllowed:true},{executionAllowed:true},{resendAllowed:true},{ownershipChanged:true},{executionBlockers:[]},{unit:{...e.unit,generation:2}},{validUntil:e.now()},{state:'target_waiting'}])expect(()=>parseFallbackPreflight({...r,...patch},e.unit,e.targets,e.now())).toThrow()
 })
 it('shows current shared stops without clearing them or changing the inspected budget',async()=>{
  const e=await setup();e.db.prepare('INSERT INTO managed_recovery_stops (id,body) VALUES (?,?)').run(JSON.stringify([e.unit.workspaceId,e.unit.taskId,e.unit.attemptId,e.unit.generation,e.unit.fingerprint]),JSON.stringify({schema:'recovery-stop/1',unit:e.unit,eventId:'original_stop',sequence:1,mode:'pause',receivedAt:e.now()}))
  const before=e.dump();expect(e.inspect().source.reasons).toContain('shared_recovery_stopped');expect(e.dump()).toEqual(before)
 })
 it('uses one bounded authenticated inspection request and preserves 429 pause ownership',async()=>{
  const e=await setup(),receipt=e.inspect();vi.spyOn(Date,'now').mockReturnValue(e.now());let calls=0
  const pause={beforeSend:vi.fn(async()=>{}),record:vi.fn(async()=>{})}
  vi.stubGlobal('fetch',vi.fn(async(url:URL,options:any)=>{calls++;expect(String(url)).toBe('https://fixture.test/managed/recovery/fallback-preflight');expect(options.redirect).toBe('error');expect(options.headers.Authorization).toBe('Bearer '+'s'.repeat(40));expect(JSON.parse(options.body)).toEqual({schema:FALLBACK_PREFLIGHT_SCHEMA,unit:e.unit,targets:e.targets});return Response.json(receipt)}))
  const call=fallbackPreflightTransport('https://fixture.test','workspace','s'.repeat(40),undefined,pause as any)
  expect(await call(e.unit,e.targets)).toEqual(receipt);expect(calls).toBe(1)
  vi.stubGlobal('fetch',vi.fn(async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'30'}})}))
  await expect(call(e.unit,e.targets)).rejects.toThrow('unavailable');expect(calls).toBe(2);expect(pause.record).toHaveBeenCalledWith('30')
 })
 it.each(['size','permission','foreign','stale'])('rejects %s transport receipts without retry',async kind=>{
  const e=await setup(),receipt:any=e.inspect();vi.spyOn(Date,'now').mockReturnValue(e.now());let calls=0
  if(kind==='permission')receipt.executionAllowed=true;if(kind==='foreign')receipt.unit={...e.unit,generation:2};if(kind==='stale')receipt.validUntil=e.now()
  vi.stubGlobal('fetch',vi.fn(async()=>{calls++;return kind==='size'?new Response('x'.repeat(64001)):Response.json(receipt)}))
  const call=fallbackPreflightTransport('https://fixture.test','workspace','s'.repeat(40),undefined,{beforeSend:async()=>{},record:async()=>{}} as any)
  await expect(call(e.unit,e.targets)).rejects.toThrow();expect(calls).toBe(1)
 })
 it('rejects a receipt that labels the original account or stale identity as an eligible target',async()=>{
  const e=await setup(),r=e.inspect()
  for(const patch of [{accountId:'original'},{accountObservedAt:e.now()-120000},{peerObservedAt:e.now()+1}]){
   const raw={...r,targets:[{...r.targets[0],...patch}]};expect(()=>parseFallbackPreflight(raw,e.unit,e.targets,e.now())).toThrow()
  }
 })
 it('rechecks current source after transport and keeps owner changes from reaching the UI',async()=>{
  const e=await setup();let reads=0;const bridge=new FallbackPreflightBridge({now:e.now,resolve:async()=>({unit:++reads===1?e.unit:{...e.unit,generation:2},pageLabel:'page.png'}),call:async()=>e.inspect()})
  await expect(bridge.inspect({targets:e.targets})).rejects.toThrow('changed')
  await expect(bridge.inspect({targets:e.targets,enabled:true})).rejects.toThrow()
 })
})
