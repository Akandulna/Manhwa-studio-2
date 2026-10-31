import {readFileSync} from 'node:fs'
import {cropTaskIdentity,canonicalJson} from '../src/services/managedTaskProtocol.js'
import {createRequire} from 'node:module'
import {describe,it,expect} from 'vitest'
import {TaskAuthority} from '../../relay/src/taskAuthority'
import {AccountWaiting} from '../../relay/src/accountAuthority'
import {accountApi} from '../../relay/src/accountApi'
import {accountObservation,type AccountPolicy,type AccountQuota} from '../src/services/managedAccountsProtocol.js'
import {DEFAULT_CROP_PROMPT} from '../src/services/managedCropPilotPolicy.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite')
const studio={role:'studio'} as const,phone=(deviceId='one')=>({role:'phone',deviceId} as const)
const CAPS=['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','account-audit/1','account-selection/1']
const NOW=Date.parse('2026-10-22T10:00:00Z')
const spec={version:'crop-page/1' as const,provider:'chatgpt' as const,product:'chatgpt-web',model:'provider-default',settings:{mode:null,effort:null},pageRevision:'r1',promptVersion:DEFAULT_CROP_PROMPT,validatorVersion:'managed-crop-validator/1',dependencies:[{id:'page',revision:'r1',sha256:'a'.repeat(64)}]}
function setup(){
 const db=new DatabaseSync(':memory:');let now=NOW,seq=0,txseq=0
 const sql:any={exec:(query:string,...args:any[])=>{const result=db.prepare(query).all(...args);return {toArray:()=>result}}}
 const transaction=<T>(work:()=>T):T=>{const key='tx'+(++txseq);db.exec('SAVEPOINT '+key);try{const result=work();db.exec('RELEASE '+key);return result}catch(e){db.exec('ROLLBACK TO '+key);db.exec('RELEASE '+key);throw e}}
 const authority=()=>new TaskAuthority(sql,transaction,()=>new Date(now).toISOString(),()=> 'id_'+(++seq))
 const a=authority(),event=()=> 'event_'+(++seq)
 for(const device of ['one','two']){a.registerPeer(phone(device),event(),['profile'],CAPS,'test');a.enroll(studio,event(),device,'profile',CAPS)}
 const policy:AccountPolicy={revision:1,stage:'crop_json',enabled:true,auditsEnabled:true,allowed:[{provider:'chatgpt',product:'chatgpt-web',model:'provider-default',mode:null,effort:null}],preferredProfiles:['two/profile','one/profile'],allowUnknownQuota:false,allowEstimatedQuota:false,criticalMaxAgeHours:24,contextPortable:false}
 a.accounts.setPolicy(studio,event(),policy)
 const raw=(at=now,email='same@example.com',error:string|null=null)=>({checkedAt:new Date(at).toISOString(),chatGpt:{signedIn:!error,email,plan:null,error},gemini:{signedIn:false}})
 const observe=async(device='one',check=raw())=>{const observation=await accountObservation(check,now);return a.accounts.observe(phone(device),event(),device,'profile',observation)}
 const confirm=async(device='one',account='shared',email='same@example.com')=>{const p=await observe(device,raw(now,email));return a.accounts.confirm(studio,event(),device,'profile','chatgpt',p.observation!.sites.chatgpt.candidate!,account,1)}
 const quota=(state:AccountQuota['state']='available',recheckAt:number|null=null,feature='crop_json',accountId='shared')=>a.accounts.quota(studio,event(),null,{accountId,scope:{provider:'openai',product:'chatgpt',model:'*',project:null,feature},state,evidence:'owner_supplied',observedAt:now,recheckAt})
 const plan=async(page='page')=>a.plan(studio,event(),{workspaceId:'workspace',seriesId:'series',chapterId:'chapter',pageId:page},spec)
 const claim=(taskId:string,device='one',eid=event())=>a.claim(studio,eid,taskId,device,'profile',null)
 const stop=(c:any)=>{const stopped=a.stop(studio,event(),c.task.id,true);return a.checkpoint(phone(c.attempt.deviceId),event(),c.task.id,c.attempt.id,c.attempt.generation,c.task.fingerprint,'stop_confirmed',null,stopped.command!.id)}
 return {a,db,sql,event,policy,raw,observe,confirm,quota,plan,claim,stop,restart:authority,setNow:(v:number)=>{now=v},getNow:()=>now}
}
describe('durable accounts and atomic task capacity',()=>{
 it('requests an owner-authorized idle recheck without rewriting successful history, cadence or reservations',async()=>{
  const s=setup(),audit=s.event();s.a.accounts.auditClaim(phone(),audit,'profile');s.a.accounts.auditFinish(phone(),s.event(),audit,await accountObservation(s.raw(),NOW))
  s.a.accounts.cadence(studio,s.event(),'one','profile',48);s.setNow(NOW+1000)
  const requested=s.a.accounts.requestAudit(studio,s.event(),'one','profile')
  expect(requested.audit).toMatchObject({state:'due',dueAt:NOW+1000,nextCheckAt:NOW+1000,lastSuccessfulAt:NOW,cadenceHours:48,claimId:null})
  expect(s.a.accounts.snapshot(studio).reservations).toHaveLength(0)
 })
 it('retains the owner recheck bound across replay, restart and a backwards clock',async()=>{
  const s=setup(),event=s.event(),first=s.a.accounts.requestAudit(studio,event,'one','profile')
  const audit=s.event();s.a.accounts.auditClaim(phone(),audit,'profile');s.setNow(NOW+1000);s.a.accounts.auditFinish(phone(),s.event(),audit,await accountObservation(s.raw(),s.getNow()))
  const before=s.a.accounts.snapshot(studio);expect(s.restart().accounts.requestAudit(studio,event,'one','profile')).toEqual(first)
  expect(s.a.accounts.snapshot(studio)).toEqual(before)
  expect(()=>s.restart().accounts.requestAudit(studio,s.event(),'one','profile')).toThrow('once per 15 minutes')
  s.setNow(NOW-1000);expect(()=>s.restart().accounts.requestAudit(studio,s.event(),'one','profile')).toThrow('once per 15 minutes')
  s.setNow(NOW+15*60_000);expect(s.restart().accounts.requestAudit(studio,s.event(),'one','profile').audit.dueAt).toBe(s.getNow())
 })
 it('never uses an owner recheck to bypass the failed-audit cooldown',()=>{
  const s=setup(),audit=s.event();s.a.accounts.auditClaim(phone(),audit,'profile');s.a.accounts.auditFinish(phone(),s.event(),audit,null)
  const before=s.a.accounts.snapshot(studio)
  expect(()=>s.a.accounts.requestAudit(studio,s.event(),'one','profile')).toThrow('retry cooldown')
  expect(s.a.accounts.snapshot(studio)).toEqual(before)
  s.setNow(NOW+15*60_000);expect(s.a.accounts.requestAudit(studio,s.event(),'one','profile').audit.dueAt).toBe(NOW)
 })
 it('keeps a running audit and its exact reservations held when a recheck is requested',()=>{
  const s=setup(),audit=s.event();s.a.accounts.auditClaim(phone(),audit,'profile');const before=s.a.accounts.snapshot(studio)
  expect(()=>s.a.accounts.requestAudit(studio,s.event(),'one','profile')).toThrow('current audit')
  expect(s.a.accounts.snapshot(studio)).toEqual(before)
 })
 it('defers a requested recheck behind actual busy ownership without changing the task',async()=>{
  const s=setup();await s.confirm();s.quota();const c=s.claim((await s.plan()).id),before=s.a.timeline(studio,c.task.id),held=s.a.accounts.snapshot(studio).reservations
  expect(s.a.accounts.requestAudit(studio,s.event(),'one','profile').audit).toMatchObject({state:'deferred',reason:'busy'})
  expect(s.a.timeline(studio,c.task.id)).toEqual(before);expect(s.a.accounts.snapshot(studio).reservations).toEqual(held)
 })
 it('leaves an offline owner-requested audit due and cannot grant navigation',()=>{
  const s=setup();s.a.accounts.snapshot(studio);s.setNow(NOW+16*60_000)
  expect(s.a.accounts.requestAudit(studio,s.event(),'one','profile').audit).toMatchObject({state:'deferred',reason:'offline',dueAt:NOW})
  expect(s.a.accounts.auditClaim(phone(),s.event(),'profile')).toMatchObject({state:'deferred',reason:'offline'})
  expect(s.a.accounts.snapshot(studio).reservations).toHaveLength(0)
 })
 it('requires the Studio role, enabled audit policy and exact enrolled profile',()=>{
  const s=setup()
  expect(()=>s.a.accounts.requestAudit(phone(),s.event(),'one','profile')).toThrow('Studio authority')
  expect(()=>s.a.accounts.requestAudit(studio,s.event(),'one','missing')).toThrow('Enroll')
  s.a.accounts.setPolicy(studio,s.event(),{...s.policy,revision:2,auditsEnabled:false})
  expect(()=>s.a.accounts.requestAudit(studio,s.event(),'one','profile')).toThrow('Enable idle audits')
 })
 it('authorizes strict owner recheck operations without accepting phone or extra-field requests',async()=>{
  const s=setup(),body={schema:'managed-accounts/1',workspaceId:'workspace',eventId:s.event(),action:'audit_recheck',deviceId:'one',profileId:'profile'}
  const request=(v:any)=>new Request('https://relay/managed/accounts/operation',{method:'POST',body:JSON.stringify(v)})
  expect((await accountApi(request(body),phone(),s.a.accounts,'workspace',NOW)).status).toBe(403)
  await expect(accountApi(request({...body,force:true}),studio,s.a.accounts,'workspace',NOW)).rejects.toThrow('Exact account')
  expect((await accountApi(request(body),studio,s.a.accounts,'workspace',NOW)).status).toBe(200)
  expect((await accountApi(request(body),studio,s.a.accounts,'workspace',NOW)).status).toBe(200)
 })
 it('ranks deterministically without treating names or candidates as confirmed accounts',async()=>{
  const s=setup(),task=await s.plan();await s.observe();expect(s.a.selectAccount(studio,task.id).candidates.find(c=>c.deviceId==='one')!.reasons).toContain('account_identity_confirmation_required')
  await s.confirm('one');await s.confirm('two');s.quota()
  const ranked=s.a.selectAccount(studio,task.id);expect(ranked.selected?.deviceId).toBe('two');expect(ranked.candidates.map(c=>c.deviceId)).toEqual(['two','one'])
 })
 it('serializes two phones sharing an account and pins selection to each immutable attempt',async()=>{
  const s=setup();await s.confirm('one');await s.confirm('two');s.quota();const [t1,t2]=await Promise.all([s.plan('a'),s.plan('b')])
  const first=s.claim(t1.id);expect(first.attempt.accountId).toBe('shared');expect(first.attempt.accountSelection?.configuration).toEqual(spec)
  expect(()=>s.claim(t2.id,'two')).toThrow(AccountWaiting)
  expect(s.a.timeline(studio,t2.id).attempt).toBeNull()
  s.stop(first);const next=s.claim(t2.id,'two');expect(next.attempt.accountId).toBe('shared')
  expect(s.a.timeline(studio,t1.id).attempt?.accountSelection?.policy.revision).toBe(1)
 })
 it('does not cache waiting as a successful claim; repeated intent can progress after capacity releases',async()=>{
  const s=setup();await s.confirm('one');await s.confirm('two');s.quota();const t1=await s.plan('a'),t2=await s.plan('b'),first=s.claim(t1.id),eid=s.event()
  expect(()=>s.claim(t2.id,'two',eid)).toThrow(AccountWaiting);expect(s.a.productionClaim(studio,t2.id,eid).status).toBe('missing')
  s.stop(first);const next=s.claim(t2.id,'two',eid);expect(s.claim(t2.id,'two',eid)).toEqual(next)
 })
 it('retains shared capacity through expiry and acknowledged stops with ambiguous submission',async()=>{
  const s=setup();await s.confirm('one');await s.confirm('two');s.quota();const t1=await s.plan('a'),t2=await s.plan('b'),c=s.claim(t1.id)
  for(const phase of ['accepted','started','submission_intent'] as const)s.a.checkpoint(phone(),s.event(),c.task.id,c.attempt.id,c.attempt.generation,c.task.fingerprint,phase,null,c.command.id)
  s.stop(c);s.setNow(NOW+600_000)
  expect(()=>s.claim(t2.id,'two')).toThrow(AccountWaiting)
  expect(s.restart().accounts.snapshot(studio).reservations.some(r=>r.resource==='account:shared:0')).toBe(true)
 })
 it('releases task and account reservations together after trusted publication',async()=>{
  const s=setup();await s.confirm();s.quota();const c=s.claim((await s.plan()).id)
  for(const phase of ['accepted','started','submission_intent','result_saved'] as const)s.a.checkpoint(phone(),s.event(),c.task.id,c.attempt.id,c.attempt.generation,c.task.fingerprint,phase,phase==='result_saved'?'checkpoint/saved':null,c.command.id)
  const ref=`managed/workspace/${c.task.id.slice(12)}/${c.attempt.id}/artifact`
  s.a.stage(phone(),s.event(),c.task.id,c.attempt.id,c.attempt.generation,c.task.fingerprint,'artifact',ref,'b'.repeat(64))
  s.a.publish(studio,s.event(),c.task.id,c.attempt.id,c.attempt.generation,c.task.fingerprint,'artifact','b'.repeat(64),'validation/check')
  expect(s.a.accounts.snapshot(studio).reservations).toHaveLength(0)
 })
 it('shares exhaustion across linked profiles and keeps a passed reset blocked until new evidence',async()=>{
  const s=setup();await s.confirm('one');await s.confirm('two');s.quota('blocked',NOW+1000,'uploads');const t=await s.plan()
  expect(s.a.selectAccount(studio,t.id).candidates.every(c=>c.reasons.includes('quota_exhausted'))).toBe(true)
  s.setNow(NOW+2000);expect(s.a.selectAccount(studio,t.id).candidates.every(c=>c.reasons.includes('quota_reset_requires_recheck'))).toBe(true)
  s.quota('available',null,'uploads');expect(s.a.selectAccount(studio,t.id).state).toBe('eligible')
 })
 it('does not let cross-phone clock skew or a second profile clear an observed shared blocker',async()=>{
  const s=setup();await s.confirm('one');await s.confirm('two');const scope={provider:'openai' as const,product:'chatgpt' as const,model:'*',project:null,feature:'crop_json'}
  s.a.accounts.quota(phone('two'),s.event(),'profile',{accountId:'shared',scope,state:'available',evidence:'observed',observedAt:NOW+200_000,recheckAt:null})
  s.a.accounts.quota(phone('one'),s.event(),'profile',{accountId:'shared',scope,state:'blocked',evidence:'observed',observedAt:NOW,recheckAt:null})
  s.a.accounts.quota(phone('two'),s.event(),'profile',{accountId:'shared',scope,state:'available',evidence:'observed',observedAt:NOW+200_001,recheckAt:null})
  const t=await s.plan();expect(s.a.selectAccount(studio,t.id).candidates.every(c=>c.reasons.includes('quota_exhausted'))).toBe(true)
  s.setNow(NOW+1);s.quota();expect(s.a.selectAccount(studio,t.id).state).toBe('eligible')
 })
 it('keeps product/model/feature scopes distinct',async()=>{
  const s=setup();await s.confirm();s.quota();s.a.accounts.quota(studio,s.event(),null,{accountId:'shared',scope:{provider:'openai',product:'chatgpt',model:'other-model',project:null,feature:'uploads'},state:'blocked',evidence:'owner_supplied',observedAt:NOW,recheckAt:null})
  expect(s.a.selectAccount(studio,(await s.plan()).id).state).toBe('eligible')
 })
 it('never silently downgrades provider/model/effort or reselects held work',async()=>{
  const s=setup();await s.confirm();s.quota();const t=await s.a.plan(studio,s.event(),{workspaceId:'workspace',seriesId:'series',chapterId:'chapter',pageId:'other'},{...spec,model:'premium'})
  expect(s.a.selectAccount(studio,t.id).candidates[0].reasons).toContain('configuration_not_allowed_by_policy')
  expect(()=>s.claim(t.id)).toThrow() // Existing pilot capability fence also refuses unsupported models.
 })
 it('invalidates readiness on failed checks, sign-out and changed identity, ignoring older delivery',async()=>{
  const s=setup();await s.confirm();s.quota();const t=await s.plan();s.setNow(NOW+1000);await s.observe('one',s.raw(NOW+1000,'same@example.com','timeout'))
  expect(s.a.selectAccount(studio,t.id).candidates.find(c=>c.deviceId==='one')!.reasons).toContain('login_unknown_audit_required')
  await s.observe('one',s.raw(NOW));expect(s.a.accounts.snapshot(studio).profiles.find(p=>p.deviceId==='one')!.observation!.sites.chatgpt.login).toBe('unknown')
  s.setNow(NOW+2000);await s.observe('one',{...s.raw(),chatGpt:{signedIn:false,email:null as any,plan:null,error:null}})
  expect(s.a.selectAccount(studio,t.id).candidates.find(c=>c.deviceId==='one')!.reasons).toContain('sign_in_required')
  s.setNow(NOW+3000);await s.observe('one',s.raw(NOW+3000,'different@example.com'))
  expect(s.a.selectAccount(studio,t.id).candidates.find(c=>c.deviceId==='one')!.reasons).toContain('account_identity_confirmation_required')
  expect(s.a.accounts.snapshot(studio).issues.filter((i:any)=>i.deviceId==='one'&&i.product==='chatgpt')).toHaveLength(1)
 })
 it('requires an explicit policy for unknown capacity, and stale critical evidence requests an audit',async()=>{
  const s=setup();await s.confirm();const t=await s.plan()
  expect(s.a.selectAccount(studio,t.id).candidates[0].reasons).toContain('quota_unknown')
  s.a.accounts.setPolicy(studio,s.event(),{...s.policy,revision:2,allowUnknownQuota:true})
  expect(s.a.selectAccount(studio,t.id).state).toBe('eligible')
  s.setNow(NOW+25*3_600_000)
  expect(s.a.selectAccount(studio,t.id).candidates.find(c=>c.deviceId==='one')!.reasons).toContain('critical_evidence_stale_audit_required')
  expect(s.a.accounts.snapshot(studio).profiles.find(p=>p.deviceId==='one')!.audit.dueAt).toBeLessThanOrEqual(s.getNow())
 })
 it('preserves original policy pins when the policy changes and rejects stale policy writes',async()=>{
  const s=setup();await s.confirm();s.quota();const c=s.claim((await s.plan()).id)
  s.a.accounts.setPolicy(studio,s.event(),{...s.policy,revision:2,enabled:false})
  expect(s.a.timeline(studio,c.task.id).attempt!.accountSelection!.policy.enabled).toBe(true)
  expect(()=>s.a.accounts.setPolicy(studio,s.event(),{...s.policy,revision:2})).toThrow('revision')
 })
 it('keeps ownership enforcement when routing is rolled back and retains an immutable pin',async()=>{
  const s=setup();await s.confirm('one');await s.confirm('two');s.quota();const c=s.claim((await s.plan('a')).id),t=await s.plan('b')
  s.a.accounts.setPolicy(studio,s.event(),{...s.policy,revision:2,enabled:false})
  expect(()=>s.claim(t.id,'two')).toThrow(AccountWaiting)
  expect(s.a.selectAccount(studio,t.id).routingRequired).toBe(true)
  expect(s.a.timeline(studio,c.task.id).attempt!.accountSelection!.policy.revision).toBe(1)
 })
 it('schedules one audit after an estimated quota reset without treating the audit as free capacity',async()=>{
  const s=setup();await s.confirm();const first=s.event();s.a.accounts.auditClaim(phone(),first,'profile');s.setNow(NOW+1)
  s.a.accounts.auditFinish(phone(),s.event(),first,await accountObservation(s.raw(),s.getNow()))
  s.quota('blocked',NOW+1000,'uploads');const t=await s.plan();s.setNow(NOW+1001)
  s.a.selectAccount(studio,t.id)
  expect(s.a.accounts.snapshot(studio).profiles.find(p=>p.deviceId==='one')!.audit.dueAt).toBe(s.getNow())
  const next=s.event();s.a.accounts.auditClaim(phone(),next,'profile');s.setNow(NOW+1002)
  s.a.accounts.auditFinish(phone(),s.event(),next,await accountObservation(s.raw(),s.getNow()))
  expect(s.a.selectAccount(studio,t.id).candidates.find(c=>c.deviceId==='one')!.reasons).toContain('quota_reset_requires_recheck')
  expect(s.a.accounts.snapshot(studio).profiles.find(p=>p.deviceId==='one')!.audit.dueAt).toBe(NOW+1002+24*3_600_000)
 })
 it('does not let repeated stale-evidence preflight bypass a failed-audit retry delay',async()=>{
  const s=setup();await s.confirm();s.quota();const t=await s.plan(),eid=s.event();s.a.accounts.auditClaim(phone(),eid,'profile')
  s.setNow(NOW+1);s.a.accounts.auditFinish(phone(),s.event(),eid,null)
  s.a.selectAccount(studio,t.id)
  expect(s.a.accounts.auditClaim(phone(),s.event(),'profile')).toMatchObject({state:'deferred',reason:'retry_delay'})
 })
 it('tombstones a cancelled waiting claim so eligibility changes cannot dispatch it later',async()=>{
  const s=setup();const t=await s.plan(),eid=s.event();expect(()=>s.claim(t.id,'one',eid)).toThrow(AccountWaiting)
  s.a.stopClaim(studio,s.event(),t.id,eid);await s.confirm();s.quota()
  expect(()=>s.claim(t.id,'one',eid)).toThrow('stopped before dispatch')
 })
})
describe('durable idle audit scheduling',()=>{
 it('defaults to 24 hours, supports 48, and does not postpone due time on failure',async()=>{
  const s=setup(),audit=s.a.accounts.auditClaim(phone(),s.event(),'profile');expect(audit.state).toBe('running')
  s.setNow(NOW+1000);const result=s.a.accounts.auditFinish(phone(),s.event(),(audit as any).id,await accountObservation(s.raw(),s.getNow()))
  expect(result.profile.audit.dueAt).toBe(NOW+1000+24*3_600_000)
  s.a.accounts.cadence(studio,s.event(),'one','profile',48)
  expect(s.a.accounts.snapshot(studio).profiles.find(p=>p.deviceId==='one')!.audit.dueAt).toBe(NOW+1000+48*3_600_000)
  s.setNow(NOW+1000+48*3_600_000);s.a.registerPeer(phone(),s.event(),['profile'],CAPS,'test')
  const second=s.a.accounts.auditClaim(phone(),s.event(),'profile');const failed=s.a.accounts.auditFinish(phone(),s.event(),(second as any).id,null)
  expect(failed.profile.audit.state).toBe('failed');expect(failed.profile.audit.dueAt).toBe(s.getNow());expect(failed.profile.observation!.sites.chatgpt.login).toBe('unknown')
  expect(failed.profile.audit.lastSuccessfulAt).toBe(NOW+1000)
 })
 it('defers busy phones without touching their task reservations or commands',async()=>{
  const s=setup();await s.confirm();s.quota();const c=s.claim((await s.plan()).id),before=s.a.timeline(studio,c.task.id)
  expect(s.a.accounts.auditClaim(phone(),s.event(),'profile')).toMatchObject({state:'deferred',reason:'busy'})
  expect(s.a.timeline(studio,c.task.id)).toEqual(before)
 })
 it('reserves idle browser access atomically against task claims, retaining it across restart',async()=>{
  const s=setup();await s.confirm();s.quota();const t=await s.plan(),eid=s.event(),audit=s.a.accounts.auditClaim(phone(),eid,'profile')
  expect(()=>s.claim(t.id)).toThrow(AccountWaiting)
  const restarted=s.restart();expect(restarted.accounts.auditClaim(phone(),eid,'profile')).toEqual(audit)
  const finish=s.event();restarted.accounts.auditFinish(phone(),finish,eid,null)
  expect(restarted.accounts.auditFinish(phone(),finish,eid,null).audit.state).toBe('failed')
  expect(restarted.accounts.snapshot(studio).reservations).toHaveLength(0)
 })
 it('retains overdue offline and unsupported-device deferrals visibly',()=>{
  const s=setup();s.setNow(NOW+16*60_000)
  expect(s.a.accounts.snapshot(studio).profiles.every(p=>p.audit.reason==='offline')).toBe(true)
  s.a.registerPeer(phone(),s.event(),['profile'],CAPS.filter(c=>c!=='account-audit/1'),'old')
  expect(s.a.accounts.snapshot(studio).profiles.find(p=>p.deviceId==='one')!.audit.reason).toBe('update_phone_for_audits')
 })
 it('rejects foreign finish and evidence predating the audit claim',async()=>{
  const s=setup(),eid=s.event();s.a.accounts.auditClaim(phone(),eid,'profile')
  expect(()=>s.a.accounts.auditFinish(phone('two'),s.event(),eid,null)).toThrow()
  expect(()=>s.a.accounts.auditFinish(phone(),s.event(),eid,{...awaitable(),checkedAt:NOW-1000})).toThrow()
  function awaitable():any{return {checkedAt:NOW,sites:{}}}
 })
 it('authenticates API roles, rejects unknown fields, and never copies secrets from phone checks',async()=>{
  const s=setup(),body={schema:'managed-accounts/1',workspaceId:'workspace',eventId:s.event(),action:'policy',policy:s.policy}
  const req=(v:any)=>new Request('https://relay/managed/accounts/operation',{method:'POST',body:JSON.stringify(v)})
  expect((await accountApi(req(body),phone(),s.a.accounts,'workspace',NOW)).status).toBe(403)
  await expect(accountApi(req({...body,action:'audit_claim',profileId:'profile',secret:'token'}),phone(),s.a.accounts,'workspace',NOW)).rejects.toThrow()
  const parsed=await accountObservation({...s.raw(),cookies:'secret',chatGpt:{...s.raw().chatGpt,token:'secret'}},NOW)
  expect(JSON.stringify(parsed)).not.toContain('secret')
 })
})


describe('actual relay / native pinned assignment fixture',()=>{
 it('keeps the exact task hash, confirmed account and policy configuration shared with Android',async()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../docs/manager-agents/phase5/account-assignment.json',import.meta.url),'utf8'))
  const t=fixture.task,pin=fixture.attempt.accountSelection
  const computed=await cropTaskIdentity({workspaceId:t.workspaceId,seriesId:t.seriesId,chapterId:t.chapterId,pageId:t.pageId},t.spec)
  expect(computed).toEqual({taskId:t.id,fingerprint:t.fingerprint})
  expect(canonicalJson(pin.configuration)).toBe(canonicalJson(t.spec))
  expect(pin.accountId).toBe(fixture.attempt.accountId)
  expect(pin.policy.revision).toBe(1)
 })
})
