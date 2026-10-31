import {ExecutorEvidenceAuthority} from '../../relay/src/executorEvidence.js'
import {parseExecutorEvidence,EXECUTOR_EVIDENCE_SCHEMA} from '../src/services/managedExecutorEvidenceProtocol.js'
import {inspectExecutorEvidence} from '../src/services/executorEvidenceBridge.js'
import {AutomationRecovery} from '../src/services/automationRecovery.js'
import type {ProductionStoreDatabase} from '../src/services/productionJobStore.js'
import {createRequire} from 'node:module'
import {afterEach,describe,it,expect} from 'vitest'
import {TaskAuthority} from '../../relay/src/taskAuthority.js'
import {accountObservation,type AccountPolicy} from '../src/services/managedAccountsProtocol.js'
import {DEFAULT_CROP_PROMPT} from '../src/services/managedCropPilotPolicy.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite'),opened:any[]=[]
afterEach(()=>{for(const db of opened.splice(0))db.close()})
const studio={role:'studio'} as const,phone=(deviceId='one')=>({role:'phone',deviceId} as const)
const CAPS=['correction-preflight/1','managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','account-audit/1','account-selection/1']
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


 for(const phase of ['submission_intent','submitted'] as const)a.checkpoint(phone(),event(),task.id,claim.attempt.id,claim.attempt.generation,task.fingerprint,phase,null,claim.command.id)
 const unit={workspaceId:'workspace',taskId:task.id,attemptId:claim.attempt.id,generation:claim.attempt.generation,fingerprint:task.fingerprint}
 const correctionContext={schema:'managed-correction-context/1',capturedAt:now-1000,bindingId:'original_binding',sourceSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),promptSha256:'c'.repeat(64),replySha256:'d'.repeat(64),rawCheckpointRef:'checkpoint/original_reply',accountId:'shared',policyRevision:1,state:'scoped',lockedCandidates:1,failedCandidates:1,lockedDigest:'e'.repeat(64),planDigest:'f'.repeat(64),executable:false,portable:false,liveConversationVerified:false}
 const observation={schema:EXECUTOR_EVIDENCE_SCHEMA,id:'original_context',unit,commandId:claim.command.id,deviceId:'one',profileId:'profile',observedAt:now,failure:'malformed_output',outcome:'submitted',phase:'submitted',uiChangeId:null,uiObservedAt:null,correctionContext}
 const authority=new ExecutorEvidenceAuthority(sql,tx,a,()=>now)
 const snapshot=()=>({timeline:a.timeline(studio,task.id),reservations:db.prepare('SELECT * FROM managed_reservations ORDER BY resource').all(),quota:db.prepare('SELECT * FROM managed_account_quotas ORDER BY id').all(),policy:db.prepare("SELECT * FROM managed_account_policies WHERE id='crop_json'").all()})
 const rows=new Map<string,string>(),memory:ProductionStoreDatabase={transaction:async work=>work({get:async k=>rows.get(k)??null,list:async p=>[...rows].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value})),insert:async(k,v)=>{rows.set(k,v)},replace:async(k,old,v)=>{if(rows.get(k)!==old)return false;rows.set(k,v);return true}})}
 return {a,sql,tx,unit,claim,event,observation,authority,snapshot,diagnoses:new AutomationRecovery(memory,()=>now),now:()=>now,advance:(ms:number)=>now+=ms}
}
describe('historical correction context is provenance only',()=>{
 it('retains original source times and exact replay without task, quota, pin, reservation or budget changes',async()=>{
  const e=await setup(),before=e.snapshot(),receipt=e.authority.report(phone(),e.observation);e.advance(500000)
  expect(new ExecutorEvidenceAuthority(e.sql,e.tx,e.a,e.now).report(phone(),e.observation)).toEqual(receipt)
  const view=e.authority.inspect(studio,e.unit);expect(view.evidence[0].observation.correctionContext).toEqual(e.observation.correctionContext)
  expect(view.budget).toMatchObject({used:0,uiUsed:0,pending:false});expect(e.snapshot()).toEqual(before)
 })
 it('never treats scoped local drafts as executable correction, portable context or current conversation proof',async()=>{
  const e=await setup();e.authority.report(phone(),e.observation)
  const view=await inspectExecutorEvidence(e.unit,e.authority.inspect(studio,e.unit),e.diagnoses,e.now())
  expect(view.diagnosis).toMatchObject({enabled:false,evidence:{outcome:'submitted',contextVerified:false,contextPortable:false,correctionAllowed:false,policyAllowsAlternative:false},decision:{state:'held',operation:'inspect'}})
 })
 it('rejects invented permissions, raw data, impossible counts and future source times',async()=>{
  const e=await setup(),c=e.observation.correctionContext
  for(const patch of [{executable:true},{portable:true},{liveConversationVerified:true},{prompt:'private'},{capturedAt:e.now()+1},{lockedCandidates:500},{failedCandidates:0},{rawCheckpointRef:'../../private'},{state:'verified'},{lockedDigest:null}])expect(()=>parseExecutorEvidence({...e.observation,correctionContext:{...c,...patch}})).toThrow()
  for(const patch of [{phase:'started'},{outcome:'unknown'},{failure:'executor_stopped'}])expect(()=>parseExecutorEvidence({...e.observation,...patch})).toThrow()
 })
 it('requires the original confirmed input/account/policy pin and refuses a different command owner',async()=>{
  const e=await setup(),c=e.observation.correctionContext
  for(const patch of [{accountId:'foreign'},{policyRevision:2},{sourceSha256:'b'.repeat(64)}])expect(()=>e.authority.report(phone(),{...e.observation,correctionContext:{...c,...patch}})).toThrow('original input/account/policy')
  expect(()=>e.authority.report(phone('two'),e.observation)).toThrow();expect(()=>e.authority.report(phone(),{...e.observation,commandId:'foreign'})).toThrow()
 })
 it('keeps the old capture historical across later authority progress and never overwrites an immutable receipt',async()=>{
  const e=await setup();e.authority.report(phone(),e.observation)
  expect(()=>e.authority.report(phone(),{...e.observation,correctionContext:{...e.observation.correctionContext,capturedAt:e.now()}})).toThrow('Conflicting')
  e.a.checkpoint(phone(),e.event(),e.unit.taskId,e.unit.attemptId,e.unit.generation,e.unit.fingerprint,'result_saved','checkpoint/normal_output',e.claim.command.id)
  const view=await inspectExecutorEvidence(e.unit,e.authority.inspect(studio,e.unit),e.diagnoses,e.now())
  expect(view.outcome).toBe('saved');expect(view.diagnosis?.evidence.outcome).toBe('unknown');expect(view.diagnosis?.evidence.correctionAllowed).toBe(false)
 })
 it('withholds scope when parsing or identity is ambiguous and preserves old envelopes without optional context',async()=>{
  const e=await setup();const {correctionContext,...old}=e.observation;expect(parseExecutorEvidence(old)).toEqual(old)
  const held={...e.observation,correctionContext:{...correctionContext,state:'held',lockedCandidates:0,failedCandidates:0,lockedDigest:null,planDigest:null}}
  expect(parseExecutorEvidence(held).correctionContext?.state).toBe('held')
  expect(()=>parseExecutorEvidence({...held,correctionContext:{...held.correctionContext,failedCandidates:1}})).toThrow()
 })
})
