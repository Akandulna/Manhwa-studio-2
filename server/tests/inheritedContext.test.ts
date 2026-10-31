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
const CAPS=['target-standalone-context/1','target-package-check/1','target-source-check/1','managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','account-audit/1','account-selection/1']
const spec=fixture.original.spec
async function setup(outcome='unsent',released=true,file=':memory:'){
 const db=new DatabaseSync(file);opened.push(db);let now=1792714000000,seq=0
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
 const task=await a.plan(studio,event(),fixture.original.scope,spec),claim=a.claim(studio,event(),task.id,'one','profile',null)
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
 return {a,db,sql,tx,unit,targets,env,authority,inspect,call,dump,mutate,event,now:()=>now,advance:(ms:number)=>now+=ms,claim,checks,begin,proof,packages,prepare,contexts,prepareContext}
}



import {createHash} from 'node:crypto'
import {InheritedContextAuthority,assertStandaloneRequirements} from '../../relay/src/inheritedContext.js'
import {INHERITED_CONTEXT_SCHEMA,INHERITED_CONFIRMATION,inheritedPermissions,parseInheritedStatus} from '../src/services/inheritedContextProtocol.js'
import {verifyContextPacket} from '../src/services/portableContextPacket.js'
import {InheritedContextStudioBridge,inheritedContextTransport} from '../src/services/inheritedContextBridge.js'
import {canonicalJson} from '../src/services/managedTaskProtocol.js'
import {recoveryUnitKey} from '../src/services/automationRecoveryPolicy.js'
const packetFixture=JSON.parse(readFileSync(new URL('./fixtures/portable-context.json',import.meta.url),'utf8'))
const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
async function inherited(){
 const e=await setup(),v=await e.prepareContext(),checks=new InheritedContextAuthority(e.sql,e.tx,e.a,e.packages,e.now),p=structuredClone(packetFixture),r=v.receipt
 p.binding={unit:e.unit,target:e.targets[0],accountId:r.accountId,policyRevision:r.policyRevision,packageId:r.id,sourceSha256:r.source.sha256,manifestSha256:r.manifestSha256,promptSha256:r.promptSha256};p.preparedAt=e.now()-1
 const {packetId,...body}=p;p.packetId='context_'+hash(canonicalJson(body));const wire=canonicalJson(p)+'\n',reference={binding:p.binding,packetId:p.packetId},request={id:'inherited_review',...verifyContextPacket(wire,reference,e.now()),supersedesId:null,confirmation:INHERITED_CONFIRMATION}
 const reviewBody={action:'review',id:request.id,packetWire:wire,reference,requiredEntries:request.requiredEntries,supersedesId:null,confirmation:INHERITED_CONFIRMATION}
 return {...e,v,checks,p,wire,reference,request,reviewBody}
}
describe('inherited text requirements review',()=>{
 it('independently verifies the existing Node/Android packet fixture',()=>{
  const r=verifyContextPacket(canonicalJson(packetFixture)+'\n',{binding:packetFixture.binding,packetId:packetFixture.packetId},packetFixture.preparedAt)
  expect(r.requiredEntries).toHaveLength(3);expect(JSON.stringify(r)).not.toContain('content')
 })
 it.each(['duplicate','noncanonical','content','permission','future','reference','omission','deep','role','exclusion'])('rejects %s packet changes before reviewing',async kind=>{
  const e=await inherited(),p=structuredClone(e.p);let wire=e.wire,ref=e.reference
  if(kind==='duplicate')wire=wire.replace('{','{"schema":"managed-portable-context/1",')
  if(kind==='noncanonical')wire+=' '
  if(kind==='content')p.entries[0].content+='x'
  if(kind==='permission')p.executionAllowed=true
  if(kind==='future')p.preparedAt=e.now()+1
  if(kind==='reference')ref={...ref,packetId:'context_'+'0'.repeat(64)}
  if(kind==='omission'){p.entries.pop();const {packetId,...body}=p;p.packetId='context_'+hash(canonicalJson(body))}
  if(kind==='deep')wire='['.repeat(100)+']'.repeat(100)
  if(kind==='role')p.entries[0].kind='system_message'
  if(kind==='exclusion')p.notRepresented.pop()
  if(!['duplicate','noncanonical','deep'].includes(kind))wire=canonicalJson(p)+'\n'
  expect(()=>verifyContextPacket(wire,ref,e.now())).toThrow()
 })
 it('retains ordered metadata without text, ownership, budget or dispatch effects; exact replay keeps original time',async()=>{
  const e=await inherited(),before=e.dump(),r=e.checks.review(studio,e.request)
  expect(r).toMatchObject({schema:INHERITED_CONTEXT_SCHEMA,withdrawnAt:null,...inheritedPermissions});expect(r.request.requiredEntries).toEqual(e.request.requiredEntries);expect(JSON.stringify(r)).not.toContain('content')
  const after=e.dump();for(const [name,rows] of before as any)if(name!=='managed_inherited_context_reviews')expect(after.find(([n]:any)=>n===name)?.[1]).toEqual(rows)
  e.advance(100);expect(e.checks.review(studio,e.request)).toEqual(r);expect(e.dump()).toEqual(after)
  expect(parseInheritedStatus(e.checks.status(studio,e.p.binding),e.p.binding,e.now()).state).toBe('reviewed_text_only')
 })
 it.each(['phone','foreign','account','policy','quota','reservation','unknown','source','empty','extra','confirmation','stale','stopped'])('rejects %s requirements without mutations',async kind=>{
  const e=await inherited(),request=structuredClone(e.request);let actor:any=studio
  if(kind==='phone')actor=phone('two')
  if(kind==='foreign')request.binding.unit.workspaceId='other'
  if(kind==='account')request.binding.accountId='other'
  if(kind==='policy')e.mutate('managed_account_policies','crop_json',r=>r.revision++)
  if(kind==='quota')e.db.prepare("DELETE FROM managed_account_quotas WHERE json_extract(body,'$.accountId')='alternative'").run()
  if(kind==='reservation')e.db.prepare('INSERT INTO managed_reservations (resource,attempt_id) VALUES (?,?)').run('browser:two','other')
  if(kind==='unknown')e.mutate('managed_attempts',e.unit.attemptId,r=>{r.submission='intent'})
  if(kind==='source')request.binding.sourceSha256='f'.repeat(64)
  if(kind==='empty')request.requiredEntries=[]
  if(kind==='extra')(request.requiredEntries[0] as any).content='private'
  if(kind==='confirmation')request.confirmation='yes'
  if(kind==='stale')e.advance(200000)
  if(kind==='stopped')e.db.prepare('INSERT INTO managed_recovery_stops (id,body) VALUES (?,?)').run(recoveryUnitKey(e.unit),JSON.stringify({malformed:true}))
  const before=e.dump();expect(()=>e.checks.review(actor,request)).toThrow();expect(e.dump()).toEqual(before)
 })
 it('supersedes by exact predecessor CAS; old IDs and replay never become current again',async()=>{
  const e=await inherited(),r=e.checks.review(studio,e.request),next={...e.request,id:'next_review',supersedesId:e.request.id}
  expect(()=>e.checks.review(studio,{...next,supersedesId:null})).toThrow('latest')
  const r2=e.checks.review(studio,next),before=e.dump();expect(e.checks.review(studio,e.request)).toEqual(r);expect(e.checks.status(studio,e.p.binding).review).toEqual(r2);expect(e.dump()).toEqual(before)
  expect(()=>e.checks.review(studio,{...e.request,packetId:'context_'+'f'.repeat(64)})).toThrow('Immutable')
  expect(()=>e.checks.review(studio,{...e.request,id:'third',supersedesId:e.request.id})).toThrow('latest')
 })
 it('withdraws original IDs despite changed prerequisites and never resurrects an older declaration',async()=>{
  const e=await inherited();e.checks.review(studio,e.request);const r2=e.checks.review(studio,{...e.request,id:'second',supersedesId:e.request.id})
  e.mutate('managed_account_policies','crop_json',r=>r.revision++)
  const withdrawn=e.checks.withdraw(studio,'second',e.p.binding),before=e.dump();expect(withdrawn.withdrawnAt).toBe(e.now())
  expect(e.checks.withdraw(studio,'second',e.p.binding)).toEqual(withdrawn);expect(e.checks.review(studio,r2.request)).toEqual(withdrawn);expect(e.checks.status(studio,e.p.binding).state).toBe('withdrawn');expect(e.dump()).toEqual(before)
 })
 it('blocks old standalone checks/consumers, including after withdrawal until a new explicit standalone review',async()=>{
  const e=await inherited();e.contexts.report(phone('two'),e.v.contextProof);e.checks.review(studio,e.request)
  expect(()=>e.contexts.adoptionContext(phone('two'),e.v.contextProof.id)).toThrow('Inherited');expect(()=>e.contexts.begin(phone('two'),'new_context',e.v.p.id)).toThrow();expect(e.contexts.status(studio,e.unit,e.targets[0]).state).toBe('blocked')
  expect(()=>e.contexts.review(studio,'new_standalone',e.unit,e.targets[0],e.v.p.id,CONTEXT_CONFIRMATION)).toThrow('Inherited')
  e.checks.withdraw(studio,e.request.id,e.p.binding);expect(()=>e.contexts.adoptionContext(phone('two'),e.v.contextProof.id)).toThrow()
  e.contexts.review(studio,'new_standalone',e.unit,e.targets[0],e.v.p.id,CONTEXT_CONFIRMATION);expect(e.contexts.begin(phone('two'),'new_context',e.v.p.id).reviewId).toBe('new_standalone')
 })
 it('rolls back persistence failure without changing the current review',async()=>{
  const e=await inherited();e.checks.review(studio,e.request);e.db.exec("CREATE TRIGGER inherited_disk_failure BEFORE INSERT ON managed_inherited_context_reviews BEGIN SELECT RAISE(ABORT,'disk failure'); END;")
  const before=e.dump();expect(()=>e.checks.review(studio,{...e.request,id:'next',supersedesId:e.request.id})).toThrow('disk failure');expect(e.dump()).toEqual(before)
 })
 it('bounds metadata inventory without pruning original requirements',async()=>{
  const e=await inherited();let previous:string|null=null
  for(let i=0;i<128;i++){const id='review_'+i;e.checks.review(studio,{...e.request,id,supersedesId:previous});previous=id}
  const before=e.dump();expect(()=>e.checks.review(studio,{...e.request,id:'overflow',supersedesId:previous})).toThrow('inventory');expect(e.dump()).toEqual(before)
 })
 it('routes authenticated metadata and preserves the disabled-recovery gate',async()=>{
  const e=await inherited(),api=new ManagedTaskApi(e.sql,e.tx,e.env,()=>new Date(e.now()).toISOString())
  const call=(body:any,token='s'.repeat(40))=>api.handle(new Request('https://fixture/managed/recovery/inherited-context',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({schema:INHERITED_CONTEXT_SCHEMA,workspaceId:'workspace',...body})}))
  expect((await call({action:'review',request:e.request},'t'.repeat(40))).status).toBe(409);expect((await call({action:'review',request:e.request})).status).toBe(200)
  const status=await call({action:'status',binding:e.p.binding});expect(status.status).toBe(200);expect(status.headers.get('Cache-Control')).toBe('no-store')
  e.env.MANAGED_AUTOMATIC_RECOVERY='0';expect((await call({action:'review',request:{...e.request,id:'new',supersedesId:e.request.id}})).status).toBe(503)
  expect((await call({action:'status',binding:e.p.binding})).status).toBe(200);expect((await call({action:'withdraw',id:e.request.id,binding:e.p.binding})).status).toBe(200)
 })
 it('Studio checks independently pinned text and the complete inventory before sending only metadata',async()=>{
  const e=await inherited(),calls:any[]=[],call=async(op:any)=>{calls.push(op);return op.action==='review'?e.checks.review(studio,op.request):e.checks.status(studio,op.binding)}
  const bridge=new InheritedContextStudioBridge({resolve:async()=>({unit:e.unit,source:e.v.receipt.source}),call,now:e.now})
  await expect(bridge.perform({...e.reviewBody,requiredEntries:e.reviewBody.requiredEntries.slice(1)})).rejects.toThrow('complete');expect(calls).toHaveLength(0)
  expect((await bridge.perform(e.reviewBody)).request).toEqual(e.request);expect(calls).toHaveLength(1);expect(JSON.stringify(calls)).not.toContain('content');expect(JSON.stringify(calls)).not.toContain(e.p.entries[0].content)
  await expect(new InheritedContextStudioBridge({resolve:async()=>({unit:{...e.unit,generation:2},source:e.v.receipt.source}),call,now:e.now}).perform(e.reviewBody)).rejects.toThrow('original');expect(calls).toHaveLength(1)
 })
 it('Studio detects source changes after an immutable review without retrying it',async()=>{
  const e=await inherited();let n=0;const call=vi.fn(async(op:any)=>e.checks.review(studio,op.request)),bridge=new InheritedContextStudioBridge({resolve:async()=>({unit:e.unit,source:{...e.v.receipt.source,width:e.v.receipt.source.width+n++}}),call,now:e.now})
  await expect(bridge.perform(e.reviewBody)).rejects.toThrow('Source changed');expect(call).toHaveBeenCalledTimes(1);expect(e.checks.status(studio,e.p.binding).review.request.id).toBe(e.request.id)
 })
 it('transport uses fixed inherited endpoint/schema, one send and retained pause',async()=>{
  const e=await inherited(),pause={beforeSend:vi.fn(async()=>{}),record:vi.fn(async()=>{})},fetcher=vi.fn(async(url:any,o:any)=>{expect(url.pathname).toBe('/managed/recovery/inherited-context');expect(JSON.parse(o.body).schema).toBe(INHERITED_CONTEXT_SCHEMA);expect(o.redirect).toBe('error');return Response.json(e.checks.status(studio,e.p.binding))})
  vi.stubGlobal('fetch',fetcher);const call=inheritedContextTransport('https://fixture.test','workspace','s'.repeat(40),undefined,pause as any);await call({action:'status',binding:e.p.binding});expect(fetcher).toHaveBeenCalledTimes(1)
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:429,headers:{'Retry-After':'30'}})));await expect(call({action:'status',binding:e.p.binding})).rejects.toThrow();expect(pause.record).toHaveBeenCalledWith('30')
 })
 it('keeps inherited requirements scoped to the original unit across alternative targets',async()=>{
  const e=await inherited();e.checks.review(studio,e.request)
  expect(()=>assertStandaloneRequirements(e.sql,e.unit,{deviceId:'another',profileId:'profile'},true)).toThrow('Inherited')
  expect(()=>assertStandaloneRequirements(e.sql,{...e.unit,attemptId:'unrelated'},{deviceId:'another',profileId:'profile'},true)).not.toThrow()
 })
 it('retains original requirements, predecessor and withdrawal across SQLite reopen',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'inherited-review-'));temporary.push(dir);const file=path.join(dir,'authority.db'),e=await setup('unsent',true,file),v=await e.prepareContext(),p=structuredClone(packetFixture),r=v.receipt
  const binding={unit:e.unit,target:e.targets[0],accountId:r.accountId,policyRevision:r.policyRevision,packageId:r.id,sourceSha256:r.source.sha256,manifestSha256:r.manifestSha256,promptSha256:r.promptSha256}
  const request={id:'durable_review',binding,packetId:p.packetId,requiredEntries:p.entries.map(({content,...entry}:any)=>entry),supersedesId:null,confirmation:INHERITED_CONFIRMATION},checks=new InheritedContextAuthority(e.sql,e.tx,e.a,e.packages,e.now),receipt=checks.review(studio,request),withdrawn=checks.withdraw(studio,request.id,binding)
  opened.splice(opened.indexOf(e.db),1);e.db.close();const db=new DatabaseSync(file);opened.push(db)
  const sql:any={exec:(q:string,...args:any[])=>({toArray:()=>db.prepare(q).all(...args)})},tx=<T>(work:()=>T)=>work(),a=new TaskAuthority(sql,tx,()=>new Date(e.now()).toISOString()),source=new TargetInputAuthority(sql,tx,a,new FallbackPreflightAuthority(sql,tx,a,e.now),e.now),packages=new TargetPackageAuthority(sql,tx,a,source,e.now),reopened=new InheritedContextAuthority(sql,tx,a,packages,e.now)
  expect(reopened.review(studio,request)).toEqual(withdrawn);expect(reopened.status(studio,binding).review.reviewedAt).toBe(receipt.reviewedAt);expect(reopened.status(studio,binding).state).toBe('withdrawn')
 })
 it('rejects promoted, uncorrelated and future requirements statuses',async()=>{
  const e=await inherited();e.checks.review(studio,e.request);const s=e.checks.status(studio,e.p.binding)
  for(const patch of [{executionAllowed:true},{requiredContextVerified:true},{review:null},{checkedAt:e.now()+1},{state:'unreviewed'},{state:'withdrawn'},{review:{...s.review,reviewedAt:e.now()+1}}])expect(()=>parseInheritedStatus({...s,...patch},e.p.binding,e.now())).toThrow()
 })

 it('accepts the maximum metadata count through the bounded relay API',async()=>{
  const e=await inherited(),api=new ManagedTaskApi(e.sql,e.tx,e.env,()=>new Date(e.now()).toISOString()),request={...e.request,requiredEntries:Array.from({length:64},(_,i)=>({id:('entry_'+i+'_').padEnd(128,'x'),kind:'external_rule',sourceId:'s'.repeat(128),revision:'r'.repeat(128),sha256:'a'.repeat(64),bytes:1}))}
  const response=await api.handle(new Request('https://fixture/managed/recovery/inherited-context',{method:'POST',headers:{Authorization:'Bearer '+'s'.repeat(40)},body:JSON.stringify({schema:INHERITED_CONTEXT_SCHEMA,workspaceId:'workspace',action:'review',request})}));expect(response.status).toBe(200);expect((await response.json() as any).request.requiredEntries).toHaveLength(64)
 })

})
