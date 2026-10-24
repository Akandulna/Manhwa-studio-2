import {mkdtempSync,copyFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {afterEach,describe,it,expect,vi} from 'vitest'
import {TaskAuthority} from '../../relay/src/taskAuthority.js'
import {ManagedTaskApi,type ManagedTaskEnvironment} from '../../relay/src/managedTaskApi.js'
import {MANAGED_CAPABILITIES} from '../src/services/managedTaskProtocol.js'
import {artifactHash,artifactRef} from '../src/services/managedCropArtifact.js'
import {SAVED_UPLOAD_SCHEMA,type SavedUploadFence} from '../src/services/managedSavedUploadRecoveryProtocol.js'
import {SAVED_IMPORT_SCHEMA} from '../src/services/managedSavedImportRecoveryProtocol.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite'),opened:any[]=[],directories:string[]=[]
afterEach(()=>{vi.restoreAllMocks();for(const db of opened.splice(0))db.close();for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true})})
const studio={role:'studio'} as const,phone={role:'phone',deviceId:'phone'} as const,studioToken='s'.repeat(40),phoneToken='p'.repeat(40),otherToken='o'.repeat(40)
async function setup(databasePath=':memory:'){
 let db=new DatabaseSync(databasePath);opened.push(db)
 const sql:any={exec:(q:string,...args:any[])=>{const rows=db.prepare(q).all(...args);return {toArray:()=>rows}}}
 let sequence=0,now=1792714000000
 const transaction=<T>(work:()=>T):T=>{const key='tx'+(++sequence);db.exec('SAVEPOINT '+key);try{const v=work();db.exec('RELEASE '+key);return v}catch(error){db.exec('ROLLBACK TO '+key);db.exec('RELEASE '+key);throw error}}
 const authority=new TaskAuthority(sql,transaction,()=>new Date(now).toISOString(),()=> 'id_'+(++sequence)),event=()=> 'event_'+(++sequence)
 authority.registerPeer(phone,event(),['profile'],[...MANAGED_CAPABILITIES],'fixture');authority.enroll(studio,event(),'phone','profile',[...MANAGED_CAPABILITIES])
 const spec={version:'crop-page/1' as const,provider:'chatgpt' as const,product:'web',model:'fixture',settings:{mode:null,effort:null},pageRevision:'r1',promptVersion:'fixture',validatorVersion:'managed-crop-validator/1',dependencies:[{id:'page',revision:'r1',sha256:'a'.repeat(64)}]}
 const task=await authority.plan(studio,event(),{workspaceId:'workspace',seriesId:'series',chapterId:'chapter',pageId:'page'},spec),claim=authority.claim(studio,event(),task.id,'phone','profile',null),attempt=claim.attempt
 for(const phase of ['accepted','started','submission_intent','result_saved'] as const)authority.checkpoint(phone,event(),task.id,attempt.id,1,task.fingerprint,phase,phase==='result_saved'?'checkpoint/original':null,claim.command.id)
 const document=JSON.stringify({schema:'managed-crop-page/1',taskId:task.id,attemptId:attempt.id,generation:1,fingerprint:task.fingerprint,checkpointRef:'checkpoint/original',pageRevision:'r1',validatorVersion:'managed-crop-validator/1',pointers:JSON.stringify({format:'four-point-crop',version:'1.0',coordinateSystem:'normalized',image:{filename:'page.png',width:12,height:20},crops:[]}),metadata:'{"crops":[]}'})
 const bytes=new TextEncoder().encode(document)
 const fence:SavedUploadFence={workspaceId:'workspace',taskId:task.id,attemptId:attempt.id,generation:1,fingerprint:task.fingerprint,artifactId:'original_artifact',sha256:await artifactHash(bytes),commandId:claim.command.id,checkpointRef:'checkpoint/original'}
 const objects=new Map<string,Uint8Array>();let gets=0,puts=0,onGet:(()=>Promise<void>)|null=null,onPut:(()=>Promise<void>)|null=null
 const bucket={async get(key:string){gets++;await onGet?.();const bytes=objects.get(key);return bytes?{size:bytes.length,arrayBuffer:async()=>new Uint8Array(bytes).buffer}:null},async put(key:string,value:Uint8Array){puts++;if(!objects.has(key))objects.set(key,new Uint8Array(value));await onPut?.();return {key}}}
 const env:ManagedTaskEnvironment={MANAGED_CROP_PAGE:'1',MANAGED_SAVED_UPLOAD_RECOVERY:'1',MANAGED_SAVED_IMPORT_RECOVERY:'1',MANAGED_WORKSPACE_ID:'workspace',MANAGED_STUDIO_TOKEN:studioToken,MANAGED_DEVICE_TOKENS:JSON.stringify({phone:phoneToken,other:otherToken}),MANAGED_ARTIFACTS:bucket}
 const request=(action:string,details:Record<string,unknown>={},token=studioToken,f=fence)=>new ManagedTaskApi(sql,transaction,env,()=>new Date(now).toISOString()).handle(new Request('https://fixture/managed/recovery/saved-upload',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({schema:SAVED_UPLOAD_SCHEMA,action,fence:f,details})}))
 const act=async(action:string,details:Record<string,unknown>={},token=studioToken)=>{const r=await request(action,details,token);const body=await r.json();expect(r.status,body.error).toBe(200);return body}
 const inspect=async()=> (await act('inspect')).result
 const offer=()=>act('offer',{},phoneToken)
 const enable=async()=>act('control',{revision:(await inspect()).revision,enabled:true,paused:false,cancelled:false})
 const reserve=async(id='action_one')=>act('reserve',{revision:(await inspect()).revision,actionId:id})
 const upload=(id='action_one')=>act('upload',{actionId:id,document},phoneToken)
 const stop=async(cancelled=false)=>act('control',{revision:(await inspect()).revision,enabled:true,paused:!cancelled,cancelled})
 const snapshot=(path:string)=>{if(databasePath===':memory:')throw new Error('File fixture required');db.prepare('VACUUM INTO ?').run(path)}
 const reopen=(restoreFrom?:string)=>{
  if(databasePath===':memory:')throw new Error('File fixture required')
  const old=db;old.close();opened.splice(opened.indexOf(old),1)
  if(restoreFrom)copyFileSync(restoreFrom,databasePath)
  db=new DatabaseSync(databasePath);opened.push(db)
 }
 return {get db(){return db},sql,authority,env,fence,document,bytes,objects,request,act,inspect,offer,enable,reserve,upload,stop,snapshot,reopen,counts:()=>({gets,puts}),advance:()=>now+=60000,onGet:(fn:(()=>Promise<void>)|null)=>onGet=fn,onPut:(fn:(()=>Promise<void>)|null)=>onPut=fn,ref:artifactRef(task,attempt.id,fence.artifactId),transaction,now:()=>now}
}
describe('saved-transfer release compatibility preflight',()=>{
 const path='https://fixture/managed/recovery/saved-upload/compatibility'
 const preflight=(e:Awaited<ReturnType<typeof setup>>,token=phoneToken,url=path,method='GET')=>
  new ManagedTaskApi(e.sql,e.transaction,e.env,()=>new Date(e.now()).toISOString()).handle(new Request(url,{method,headers:{Authorization:'Bearer '+token}}))
 it('advertises protocols to the original phone and Studio with admission off and no task/cloud effects',async()=>{
  const e=await setup();e.env.MANAGED_SAVED_UPLOAD_RECOVERY='0'
  const before=e.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
   .map((r:any)=>[r.name,e.db.prepare('SELECT * FROM '+r.name+' ORDER BY 1').all()])
  const phone=await preflight(e),studio=await preflight(e,studioToken)
  expect(phone.status).toBe(200);expect(phone.headers.get('Cache-Control')).toBe('no-store');expect(await studio.json()).toEqual(await phone.clone().json())
  expect(await phone.json()).toEqual({schema:'saved-transfer-compatibility/1',workspaceId:'workspace',artifactStorageConfigured:true,
   capabilities:['saved-transfer-authority/1','saved-transfer-terminal/1','saved-transfer-upload-fence/1']})
  for(const [table,rows]of before)expect(e.db.prepare('SELECT * FROM '+table+' ORDER BY 1').all()).toEqual(rows)
  expect(e.counts()).toEqual({gets:0,puts:0})
 })
 it('reports absent artifact storage without offering or reserving recovery',async()=>{
  const e=await setup();delete e.env.MANAGED_ARTIFACTS
  const reply=await preflight(e);expect((await reply.json()).artifactStorageConfigured).toBe(false)
  expect(e.db.prepare('SELECT * FROM managed_upload_recovery_episodes').all()).toHaveLength(0);expect(e.counts().puts).toBe(0)
 })
 it('requires managed authentication',async()=>{
  const e=await setup()
  expect((await preflight(e,'invalid')).status).toBe(401)
  e.env.MANAGED_CROP_PAGE='0';expect((await preflight(e)).status).toBe(401);expect(e.counts().puts).toBe(0)
 })
 it('rejects mutation methods and query variants without creating an episode',async()=>{
  const e=await setup()
  expect((await preflight(e,phoneToken,path,'POST')).status).toBe(404)
  expect((await preflight(e,phoneToken,path+'?grant=1')).status).toBe(404)
  expect(e.db.prepare('SELECT * FROM managed_upload_recovery_episodes').all()).toHaveLength(0);expect(e.counts().puts).toBe(0)
 })
})
describe('original saved-upload playbook with one shared recovery authority',()=>{
 it('is off by default; metadata never enables or reserves an action',async()=>{
  const e=await setup();delete e.env.MANAGED_SAVED_UPLOAD_RECOVERY
  expect((await e.request('offer',{},phoneToken)).status).toBe(503)
  expect(e.counts().puts).toBe(0)
  e.env.MANAGED_SAVED_UPLOAD_RECOVERY='1';const offered=await e.offer()
  expect(offered.result).toMatchObject({enabled:false,actions:[]});expect(offered.budget.used).toBe(0)
  expect((await e.request('reserve',{revision:1,actionId:'one'})).status).toBe(409)
 })
 it('accepts only the original phone offer, Studio grant, then one exact phone upload',async()=>{
  const e=await setup();expect((await e.request('offer')).status).toBe(409)
  expect((await e.request('offer',{},otherToken)).status).toBe(409)
  await e.offer();await e.enable();expect((await e.request('reserve',{revision:2,actionId:'one'},phoneToken)).status).toBe(409)
  await e.reserve();const snapshot=e.db.prepare('SELECT * FROM managed_reservations ORDER BY resource').all()
  const result=await e.upload();expect(result.result.actions[0].phase).toBe('verified');expect(result.budget.used).toBe(1)
  expect(e.objects.get(e.ref)).toEqual(e.bytes);expect(e.counts().puts).toBe(1)
  expect(e.db.prepare('SELECT * FROM managed_reservations ORDER BY resource').all()).toEqual(snapshot)
  expect(e.authority.timeline(studio,e.fence.taskId).task.state).toBe('running')
  expect((await e.request('upload',{actionId:'action_one',document:e.document},phoneToken)).status).toBe(409)
  expect(e.counts().puts).toBe(1)
 })
 it('pins every artifact/checkpoint/command/input field before reservation',async()=>{
  const e=await setup();await e.offer()
  for(const change of [{sha256:'b'.repeat(64)},{artifactId:'replacement'},{commandId:'replacement'},{checkpointRef:'checkpoint/other'},{generation:2},{fingerprint:'b'.repeat(64)}])expect((await e.request('offer',{},phoneToken,{...e.fence,...change})).status).toBe(409)
  expect((await e.inspect()).actions).toHaveLength(0)
 })
 it('blocks ordinary uploads once recovery owns this exact saved packet, including while disabled',async()=>{
  const e=await setup();await e.offer();e.env.MANAGED_SAVED_UPLOAD_RECOVERY='0'
  const op={schema:'managed-task/1',action:'stage',workspaceId:'workspace',eventId:'ordinary',taskId:e.fence.taskId,attemptId:e.fence.attemptId,generation:1,fingerprint:e.fence.fingerprint,artifactId:e.fence.artifactId,ref:e.ref,contentHash:e.fence.sha256}
  const r=await new ManagedTaskApi(e.sql,e.transaction,e.env).handle(new Request('https://fixture/managed/artifacts',{method:'POST',headers:{Authorization:'Bearer '+phoneToken},body:JSON.stringify({operation:op,document:e.document})}))
  expect(r.status).toBe(409);expect(e.counts().puts).toBe(0)
 })
 it('retains an uncertain object write and reconciles the original action with the switch off',async()=>{
  const e=await setup();await e.offer();await e.enable();await e.reserve()
  e.onPut(async()=>{throw new Error('Transport lost after object accepted')})
  await expect(e.request('upload',{actionId:'action_one',document:e.document},phoneToken)).rejects.toThrow('Transport lost')
  expect((await e.inspect()).actions[0].phase).toBe('unknown');e.onPut(null);e.env.MANAGED_SAVED_UPLOAD_RECOVERY='0'
  const result=await e.act('reconcile',{actionId:'action_one'});expect(result.result.actions[0].phase).toBe('verified');expect(e.counts().puts).toBe(1)
  expect((await e.request('reserve',{revision:result.result.revision,actionId:'two'})).status).toBe(503)
 })
 it('leaves missing cloud bytes unknown instead of granting another upload',async()=>{
  const e=await setup();await e.offer();await e.enable();await e.reserve()
  e.onPut(async()=>{e.objects.clear();throw new Error('Unknown write')})
  await expect(e.request('upload',{actionId:'action_one',document:e.document},phoneToken)).rejects.toThrow('Unknown write');e.onPut(null)
  expect((await e.request('reconcile',{actionId:'action_one'})).status).toBe(409)
  expect((await e.request('reserve',{revision:(await e.inspect()).revision,actionId:'two'})).status).toBe(409)
 })
 it.each(['pause','cancel','switch'] as const)('rechecks %s after the object read and before the first put',async stop=>{
  const e=await setup();await e.offer();await e.enable();await e.reserve();let first=true
  e.onGet(async()=>{if(first){first=false;if(stop==='switch')e.env.MANAGED_SAVED_UPLOAD_RECOVERY='0';else await e.stop(stop==='cancel')}})
  expect((await e.request('upload',{actionId:'action_one',document:e.document},phoneToken)).status).toBe(409)
  expect(e.counts().puts).toBe(0);expect((await e.inspect()).actions[0].phase).toBe('safe_failure')
 })
 it('persists safe-failure cooldown and prevents a fourth physical recovery action',async()=>{
  const e=await setup();await e.offer();await e.enable()
  for(let i=1;i<=3;i++){
   await e.reserve('try_'+i);e.onGet(async()=>{throw new Error('Read unavailable before any write')})
   await expect(e.request('upload',{actionId:'try_'+i,document:e.document},phoneToken)).rejects.toThrow('Read unavailable');e.onGet(null)
   const r=await e.inspect();expect(r.actions.at(-1).phase).toBe('safe_failure')
   expect((await e.request('reserve',{revision:r.revision,actionId:'early_'+i})).status).toBe(409);e.advance()
  }
  expect((await e.request('reserve',{revision:(await e.inspect()).revision,actionId:'fourth'})).status).toBe(409);expect(e.counts().puts).toBe(0)
 })
 it('deducts an upload from later local-import recovery rather than creating a second budget',async()=>{
  const e=await setup();await e.offer();await e.enable();await e.reserve();await e.upload()
  const f=e.fence,validation='validation/'+'b'.repeat(64)
  e.authority.publish(studio,'publish',f.taskId,f.attemptId,1,f.fingerprint,f.artifactId,f.sha256,validation)
  const {commandId,checkpointRef,...importFence}=f,destinationId='c'.repeat(64)
  const request=async(action:string,details:Record<string,unknown>)=>new ManagedTaskApi(e.sql,e.transaction,e.env,()=>new Date(e.now()).toISOString()).handle(new Request('https://fixture/managed/recovery/saved-import',{method:'POST',headers:{Authorization:'Bearer '+studioToken},body:JSON.stringify({schema:SAVED_IMPORT_SCHEMA,action,fence:importFence,destinationId,details})}))
  const controlled=await(await request('control',{revision:0,enabled:true,paused:false,cancelled:false})).json();expect(controlled.budget.used).toBe(1)
  await request('reserve',{revision:controlled.result.revision,actionId:'local_one'});await request('start',{actionId:'local_one'});await request('finish',{actionId:'local_one',outcome:'safe_failure',evidenceRef:'evidence/local_one'});e.advance()
  const second=await(await request('reserve',{actionId:'local_two'})).json();expect(second.budget.used).toBe(3)
  await request('start',{actionId:'local_two'});await request('finish',{actionId:'local_two',outcome:'safe_failure',evidenceRef:'evidence/local_two'});e.advance()
  expect((await request('reserve',{actionId:'local_three'})).status).toBe(409)
 })
})
import {SavedUploadRecoveryBridge} from '../src/services/savedUploadRecoveryBridge.js'
import {AutomationRecovery} from '../src/services/automationRecovery.js'
import type {SavedUploadTransport} from '../src/services/managedSavedUploadRecovery.js'
import type {RecoveryBudget,RecoveryUnit} from '../src/services/automationRecoveryPolicy.js'
import type {ProductionStoreDatabase} from '../src/services/productionJobStore.js'
async function bridgeSetup(){
 const e=await setup(),rows=new Map<string,string>()
 const db:ProductionStoreDatabase={transaction:async fn=>fn({get:async k=>rows.get(k)??null,list:async prefix=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value})),insert:async(k,v)=>{rows.set(k,v)},replace:async(k,old,v)=>{if(rows.get(k)!==old)return false;rows.set(k,v);return true}})}
 const diagnoses=new AutomationRecovery(db,e.now,new Set(['upload_saved','restore_local']))
 let globalEnabled=false,budget:RecoveryBudget|null=null,sourceCurrent=true
 const transport:SavedUploadTransport={singleAttempt:true,get globalEnabled(){return globalEnabled},get budget(){return budget},async call(action,f,details){const r=await e.request(action,details,studioToken,f as SavedUploadFence),v=await r.json();if(r.status!==200)throw new Error(v.error);globalEnabled=v.globalEnabled;budget=v.budget;return v.result}}
 const {workspaceId,taskId,attemptId,generation,fingerprint}=e.fence,unit:RecoveryUnit={workspaceId,taskId,attemptId,generation,fingerprint}
 const bridge=new SavedUploadRecoveryBridge({transport,diagnoses,now:e.now,enabled:()=>true,resolve:async()=>{if(!sourceCurrent)throw new Error('Current source changed');return {unit,pageLabel:'fixture.png'}}})
 return {...e,bridge,diagnoses,unit,changeSource:()=>sourceCurrent=false,control:(action:string,episode:any,actionId?:string)=>bridge.perform({action,fence:episode?.fence??null,expectedRevision:episode?.revision??0,...(actionId?{actionId}:{})})}
}
describe('Studio controller binds the original phone offer and mirrors authoritative budget',()=>{
 it('blocks a new saved-upload grant behind a detached local stop before relay synchronization',async()=>{
  const e=await bridgeSetup();await e.offer();const first=await e.control('inspect',null),enabled=await e.control('enable',first.episode)
  await e.diagnoses.stop(e.unit,enabled.diagnosis!.revision,'pause')
  await expect(e.control('reserve',enabled.episode,'held')).rejects.toThrow('stop');expect((await e.inspect()).actions).toEqual([])
 })

 it('discovers server-owned metadata and separates enable, grant, phone execution and canonical import',async()=>{
  const e=await bridgeSetup();expect((await e.control('inspect',null)).episode).toBeNull()
  await e.offer();const view=await e.control('inspect',null);expect(view.diagnosis?.enabled).toBe(false)
  await expect(e.control('reserve',view.episode,'unadmitted')).rejects.toThrow('admission')
  const enabled=await e.control('enable',view.episode)
  const reserved=await e.control('reserve',enabled.episode,'original_upload');expect(reserved.budget?.used).toBe(1);expect(e.counts().puts).toBe(0)
  await e.upload('original_upload');const done=await e.control('inspect',reserved.episode)
  expect(done.episode?.actions[0].phase).toBe('verified');expect(done.diagnosis?.decision.state).toBe('verified')
  expect(done.diagnosis?.evidence.canonical).toBe(false)
  expect(e.authority.timeline(studio,e.fence.taskId).task.canonical).toBeNull()
 })
 it('holds stale revisions and actual source changes before granting another action',async()=>{
  const e=await bridgeSetup();await e.offer();const v=await e.control('inspect',null)
  await e.control('enable',v.episode);await expect(e.control('reserve',v.episode,'stale')).rejects.toThrow('current')
  const fresh=await e.control('inspect',null);e.changeSource()
  await expect(e.control('reserve',fresh.episode,'changed')).rejects.toThrow('source changed')
  expect((await e.inspect()).actions).toHaveLength(0)
 })
 it('retains local cancellation and remote stop without deleting the shared budget',async()=>{
  const e=await bridgeSetup();await e.offer();const v=await e.control('inspect',null),enabled=await e.control('enable',v.episode)
  const reserved=await e.control('reserve',enabled.episode,'reserved');const stopped=await e.control('cancel',reserved.episode)
  expect(stopped.diagnosis?.cancelled).toBe(true);expect(stopped.budget?.used).toBe(1)
  expect((await e.request('upload',{actionId:'reserved',document:e.document},phoneToken)).status).toBe(409)
  expect(e.counts().puts).toBe(0)
 })
})
describe('shared controls and bounded action identities',()=>{
 it('holds a reserved local restore under the upload pause, then resumes the same action without another charge',async()=>{
  const e=await setup();await e.offer();await e.enable();await e.reserve();await e.upload();const f=e.fence
  e.authority.publish(studio,'publish_pause',f.taskId,f.attemptId,1,f.fingerprint,f.artifactId,f.sha256,'validation/'+'b'.repeat(64))
  const {commandId,checkpointRef,...importFence}=f,destinationId='c'.repeat(64)
  const request=async(action:string,details:Record<string,unknown>)=>new ManagedTaskApi(e.sql,e.transaction,e.env,()=>new Date(e.now()).toISOString()).handle(new Request('https://fixture/managed/recovery/saved-import',{method:'POST',headers:{Authorization:'Bearer '+studioToken},body:JSON.stringify({schema:SAVED_IMPORT_SCHEMA,action,fence:importFence,destinationId,details})}))
  await request('control',{revision:0,enabled:true,paused:false,cancelled:false});await request('reserve',{actionId:'restore_original'})
  await e.stop();expect((await request('start',{actionId:'restore_original'})).status).toBe(409)
  // A completed upload can clear its old pause but can never obtain another upload grant.
  await e.enable();expect((await request('start',{actionId:'restore_original'})).status).toBe(200)
  expect((await(await request('inspect',{})).json()).budget.used).toBe(2)
  expect((await e.request('reserve',{revision:(await e.inspect()).revision,actionId:'another_upload'})).status).toBe(409)
 })
 it('rejects an overlong action identity before charging a reservation or creating an invalid stage event',async()=>{
  const e=await setup();await e.offer();await e.enable()
  expect((await e.request('reserve',{revision:(await e.inspect()).revision,actionId:'a'.repeat(101)})).status).toBe(409)
  expect((await e.inspect()).actions).toHaveLength(0)
  await e.reserve('a'.repeat(100));await e.upload('a'.repeat(100));expect(e.counts().puts).toBe(1)
 })
})
import {savedUploadRecoveryTransport} from '../src/services/managedSavedUploadRecovery.js'
import {RelayDeliveryPause} from '../src/services/relayDeliveryPause.js'
describe('saved-upload transport and immutable readback',()=>{
 it('retains corrupt cloud bytes and an unknown action without overwriting or acknowledging it',async()=>{
  const e=await setup();await e.offer();await e.enable();await e.reserve();e.onPut(async()=>{e.objects.set(e.ref,new TextEncoder().encode('corrupt'))})
  expect((await e.request('upload',{actionId:'action_one',document:e.document},phoneToken)).status).toBe(409)
  expect((await e.inspect()).actions[0].phase).toBe('unknown');expect((await e.request('reconcile',{actionId:'action_one'})).status).toBe(409)
  expect(e.counts().puts).toBe(1);expect(new TextDecoder().decode(e.objects.get(e.ref))).toBe('corrupt')
 })
 it('persists Retry-After and refuses normal calls until the existing safety pause expires',async()=>{
  const e=await setup();let saved:string|null=null
  const pause=new RelayDeliveryPause({load:async()=>null,save:async value=>{saved=value}},e.now)
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('{}',{status:429,headers:{'Retry-After':'600'}}))
  const transport=savedUploadRecoveryTransport('https://fixture/','workspace',studioToken,undefined,pause)
  await expect(transport.call('inspect',e.fence,{})).rejects.toThrow('unavailable');expect(saved).not.toBeNull()
  await expect(transport.call('inspect',e.fence,{})).rejects.toThrow('paused');expect(fetch).toHaveBeenCalledTimes(1)
 })
 it('rejects foreign and malformed responses and oversized evidence before exposing a grant',async()=>{
  const e=await setup();await e.offer();const body=await e.act('inspect')
  const pause=new RelayDeliveryPause({load:async()=>null,save:async()=>{}},e.now)
  const transport=savedUploadRecoveryTransport('https://fixture/','workspace',studioToken,undefined,pause)
  const fetch=vi.spyOn(globalThis,'fetch')
  fetch.mockResolvedValueOnce(Response.json({...body,result:{...body.result,fence:{...body.result.fence,sha256:'b'.repeat(64)}}}))
  await expect(transport.call('inspect',e.fence,{})).rejects.toThrow('fence mismatch')
  fetch.mockResolvedValueOnce(Response.json({...body,budget:{...body.budget,used:4}}))
  await expect(transport.call('inspect',e.fence,{})).rejects.toThrow('budget')
  fetch.mockResolvedValueOnce(new Response('x'.repeat(32001)));await expect(transport.call('inspect',e.fence,{})).rejects.toThrow('bounds')
 })
})

describe('retained shared stop during immutable upload I/O',()=>{
 async function stop(e:Awaited<ReturnType<typeof setup>>){
  const f=e.fence,unit={workspaceId:f.workspaceId,taskId:f.taskId,attemptId:f.attemptId,generation:f.generation,fingerprint:f.fingerprint}
  const r=await new ManagedTaskApi(e.sql,e.transaction,e.env,()=>new Date(e.now()).toISOString()).handle(new Request('https://fixture/managed/recovery/stop',{method:'POST',headers:{Authorization:'Bearer '+studioToken},body:JSON.stringify({schema:'recovery-stop/1',unit,eventId:'retained_stop',sequence:1,mode:'pause'})}));expect(r.status).toBe(200)
 }
 it('blocks the put after an asynchronous read without releasing the original task',async()=>{
  const e=await setup();await e.offer();await e.enable();await e.reserve();const before=e.authority.timeline(studio,e.fence.taskId);let once=true
  e.onGet(async()=>{if(once){once=false;await stop(e)}})
  expect((await e.request('upload',{actionId:'action_one',document:e.document},phoneToken)).status).toBe(409)
  expect(e.counts().puts).toBe(0);expect((await e.inspect()).actions[0].phase).toBe('safe_failure');expect(e.authority.timeline(studio,e.fence.taskId)).toEqual(before)
 })
 it('retains an uncertain completed put and reconciles it while the shared stop and switch are off',async()=>{
  const e=await setup();await e.offer();await e.enable();await e.reserve();const before=e.authority.timeline(studio,e.fence.taskId)
  e.onPut(async()=>{await stop(e)})
  expect((await e.request('upload',{actionId:'action_one',document:e.document},phoneToken)).status).toBe(409)
  expect((await e.inspect()).actions[0].phase).toBe('unknown');e.onPut(null);e.env.MANAGED_SAVED_UPLOAD_RECOVERY='0'
  expect((await e.act('reconcile',{actionId:'action_one'})).result.actions[0].phase).toBe('verified');expect(e.counts().puts).toBe(1)
  expect(e.authority.timeline(studio,e.fence.taskId).task.state).toBe(before.task.state)
 })
})

describe('saved-transfer journal binding and competing writers',()=>{
 async function pinned(databasePath?:string){
  const e=await setup(databasePath),owner=e.authority.artifactOwner(phone,e.fence.taskId,e.fence.attemptId,1,e.fence.fingerprint)
  // Existing immutable authority pin, as delivered in a managed account assignment. No new selection occurs here.
  const pin={policy:{revision:1,stage:'crop_json',enabled:true,auditsEnabled:true,allowed:[{provider:'chatgpt',product:'web',model:'fixture',mode:null,effort:null}],preferredProfiles:['phone/profile'],allowUnknownQuota:true,allowEstimatedQuota:false,criticalMaxAgeHours:24,contextPortable:false},selectedAt:e.now(),accountId:'account',observationAt:e.now(),quotaEvidence:[],configuration:owner.task.spec,reason:'fixture pinned selection'}
  e.db.prepare('UPDATE managed_attempts SET body=? WHERE id=?').run(JSON.stringify({...owner.attempt,accountId:'account',accountSelection:pin}),e.fence.attemptId)
  await e.offer();await e.enable();await e.reserve()
  const details={actionId:'action_one',revision:(await e.inspect()).revision,bindingHash:'a'.repeat(64),accountId:'account',policyRevision:1}
  const transfer=(mode:string,change:Record<string,unknown>={})=>e.request('transfer',{...details,mode,...change},phoneToken)
  return Object.assign(e,{details,transfer})
 }
 function ordinary(e:Awaited<ReturnType<typeof setup>>){
  const op={schema:'managed-task/1',action:'stage',workspaceId:'workspace',eventId:'ordinary_transfer',taskId:e.fence.taskId,attemptId:e.fence.attemptId,generation:1,fingerprint:e.fence.fingerprint,artifactId:e.fence.artifactId,ref:e.ref,contentHash:e.fence.sha256}
  return new ManagedTaskApi(e.sql,e.transaction,e.env,()=>new Date(e.now()).toISOString()).handle(new Request('https://fixture/managed/artifacts',{method:'POST',headers:{Authorization:'Bearer '+phoneToken},body:JSON.stringify({operation:op,document:e.document})}))
 }
 it('binds and arms once against the existing task/account/policy/action without charging another budget',async()=>{
  const e=await pinned()
  expect((await e.transfer('prepare')).status).toBe(200)
  const armed=await(await e.transfer('arm')).json();expect(armed.transfer.armed).toBe(true);expect(armed.budget.used).toBe(1)
  expect((await e.transfer('prepare')).status).toBe(409);expect((await e.transfer('arm')).status).toBe(409)
  expect((await e.request('upload',{actionId:'action_one',document:e.document},phoneToken)).status).toBe(409)
  const uploaded=await e.request('upload',{actionId:'action_one',document:e.document,bindingHash:e.details.bindingHash},phoneToken)
  expect(uploaded.status).toBe(200);expect(e.counts().puts).toBe(1)
  e.env.MANAGED_SAVED_UPLOAD_RECOVERY='0'
  expect((await e.transfer('read')).status).toBe(200)
  expect((await e.request('reconcile',{actionId:'action_one'},phoneToken)).status).toBe(200)
  expect((await ordinary(e)).status).toBe(409);expect(e.counts().puts).toBe(1)
 })
 it.each([{bindingHash:'b'.repeat(64)},{revision:99},{accountId:'other'},{policyRevision:2},{actionId:'replacement'}])('holds changed journal/grant pins %j',async change=>{
  const e=await pinned();await e.transfer('prepare')
  expect((await e.transfer('arm',change)).status).toBe(409);expect(e.counts().puts).toBe(0)
 })
 it('does not let the remote arm be bypassed by a missing binding, another phone, or paused controls',async()=>{
  const e=await pinned()
  expect((await e.transfer('arm')).status).toBe(409)
  expect((await e.request('transfer',{...e.details,mode:'prepare'},otherToken)).status).toBe(409)
  await e.transfer('prepare');await e.stop()
  expect((await e.transfer('arm')).status).toBe(409);expect(e.counts().puts).toBe(0)
 })
 it('retains an armed action with no upload as unknown during off-switch readback, without another PUT',async()=>{
  const e=await pinned();await e.transfer('prepare');await e.transfer('arm')
  e.env.MANAGED_SAVED_UPLOAD_RECOVERY='0'
  expect((await e.transfer('read')).status).toBe(200)
  expect((await e.request('reconcile',{actionId:'action_one'},phoneToken)).status).toBe(409)
  expect((await e.inspect()).actions[0].phase).toBe('unknown');expect(e.counts().puts).toBe(0)
  expect((await e.transfer('prepare')).status).toBe(503)
 })
 it('holds a corrupt remote arm marker before any upload',async()=>{
  const e=await pinned();await e.transfer('prepare');await e.transfer('arm')
  const row=e.db.prepare('SELECT id,body FROM managed_saved_transfer_bindings').get(),body=JSON.parse(row.body);body.armed='true'
  e.db.prepare('UPDATE managed_saved_transfer_bindings SET body=? WHERE id=?').run(JSON.stringify(body),row.id)
  expect((await e.transfer('read')).status).toBe(409)
  expect((await e.request('upload',{actionId:'action_one',document:e.document,bindingHash:e.details.bindingHash},phoneToken)).status).toBe(409)
  expect(e.counts().puts).toBe(0)
 })
 async function published(databasePath?:string){
  const e=await pinned(databasePath);await e.transfer('prepare');await e.transfer('arm')
  await e.act('upload',{actionId:'action_one',document:e.document,bindingHash:e.details.bindingHash},phoneToken)
  e.authority.publish(studio,'terminal_publish',e.fence.taskId,e.fence.attemptId,1,e.fence.fingerprint,e.fence.artifactId,e.fence.sha256,'validation/'+'b'.repeat(64))
  e.env.MANAGED_SAVED_UPLOAD_RECOVERY='0'
  return e
 }
 function databaseFixture(){const dir=mkdtempSync(join(tmpdir(),'saved-transfer-migration-'));directories.push(dir);return {dir,path:join(dir,'authority.sqlite')}}
 const retainedTables=['managed_artifact_budget','managed_recovery_episodes','managed_account_recovery_episodes','managed_navigation_recovery_episodes','managed_ui_recovery_episodes','managed_correction_recovery_episodes','managed_conversation_recovery_episodes','managed_recovery_dispatch','managed_recovery_stop_events','managed_tasks','managed_attempts','managed_commands','managed_artifacts','managed_uploads','managed_reservations','managed_upload_recovery_episodes','managed_saved_transfer_bindings','managed_saved_transfer_terminals','managed_recovery_stops']
 function retainedSnapshot(e:Awaited<ReturnType<typeof setup>>){return Object.fromEntries(retainedTables.map(table=>[table,e.sql.exec('SELECT * FROM '+table+' ORDER BY 1').toArray()]))}
 it('upgrades a copied pre-terminal authority database repeatedly without changing retained work',async()=>{
  const f=databaseFixture(),e=await pinned(f.path);await e.transfer('prepare');await e.transfer('arm')
  e.db.exec('DROP TABLE managed_saved_transfer_terminals')
  const before=Object.fromEntries(retainedTables.filter(t=>t!=='managed_saved_transfer_terminals').map(t=>[t,e.sql.exec('SELECT * FROM '+t+' ORDER BY 1').toArray()]))
  const backup=join(f.dir,'pre-terminal.sqlite');e.snapshot(backup);e.reopen(backup);e.env.MANAGED_SAVED_UPLOAD_RECOVERY='0'
  for(let i=0;i<3;i++){
   await e.act('inspect');e.reopen()
   for(const [table,rows]of Object.entries(before))expect(e.sql.exec('SELECT * FROM '+table+' ORDER BY 1').toArray()).toEqual(rows)
   expect(e.sql.exec('SELECT * FROM managed_saved_transfer_terminals').toArray()).toHaveLength(0)
  }
  expect((await e.transfer('read')).status).toBe(200);expect(e.counts().puts).toBe(0)
 })
 it('restores a copied armed pre-upload authority and keeps re-arm and ordinary paths fenced',async()=>{
  const f=databaseFixture(),e=await pinned(f.path);await e.transfer('prepare');await e.transfer('arm')
  const backup=join(f.dir,'armed.sqlite');e.snapshot(backup);e.reopen(backup)
  expect((await e.transfer('arm')).status).toBe(409);expect((await ordinary(e)).status).toBe(409)
  e.env.MANAGED_SAVED_UPLOAD_RECOVERY='0'
  expect((await e.request('reconcile',{actionId:'action_one'},phoneToken)).status).toBe(409)
  expect((await e.inspect()).actions[0].phase).toBe('unknown');expect(e.counts().puts).toBe(0)
 })
 it('reopens a post-closure database and replays exactly the same receipt without new writes or releases',async()=>{
  const f=databaseFixture(),e=await published(f.path),details={...e.details,byteLength:e.bytes.length}
  const first=await e.act('close-transfer',details,phoneToken),before=retainedSnapshot(e)
  const backup=join(f.dir,'closed.sqlite');e.snapshot(backup)
  for(let i=0;i<3;i++){
   e.advance();e.reopen(i===0?backup:undefined)
   const replay=await e.act('close-transfer',details,phoneToken)
   expect(replay.terminal).toEqual(first.terminal);expect(replay.budget).toEqual(first.budget)
   expect(retainedSnapshot(e)).toEqual(before)
   expect((await ordinary(e)).status).toBe(409)
  }
  expect(e.counts().puts).toBe(1)
 })
 it('keeps a restored closure fenced when only terminal metadata survives episode loss',async()=>{
  const f=databaseFixture(),e=await published(f.path)
  await e.act('close-transfer',{...e.details,byteLength:e.bytes.length},phoneToken)
  e.sql.exec('DELETE FROM managed_upload_recovery_episodes')
  const backup=join(f.dir,'terminal-only.sqlite');e.snapshot(backup);e.reopen(backup);e.env.MANAGED_SAVED_UPLOAD_RECOVERY='1'
  expect((await ordinary(e)).status).toBe(409);expect((await e.request('offer',{},phoneToken)).status).toBe(409)
  expect(e.sql.exec('SELECT * FROM managed_saved_transfer_terminals').toArray()).toHaveLength(1);expect(e.counts().puts).toBe(1)
 })
 it('retains a copied shared stop across restore and refuses terminal proof with flags off',async()=>{
  const f=databaseFixture(),e=await published(f.path);await e.stop(true)
  const before=retainedSnapshot(e),backup=join(f.dir,'cancelled.sqlite');e.snapshot(backup);e.reopen(backup)
  expect((await e.request('close-transfer',{...e.details,byteLength:e.bytes.length},phoneToken)).status).toBe(409)
  expect(retainedSnapshot(e)).toEqual(before);expect(e.counts().puts).toBe(1)
 })
 it('closes only the published original transfer with admission off; replay preserves time, arm and budget',async()=>{
  const e=await published(),before=e.db.prepare('SELECT * FROM managed_upload_recovery_episodes').all(),bindings=e.db.prepare('SELECT * FROM managed_saved_transfer_bindings').all(),details={...e.details,byteLength:e.bytes.length}
  const first=await e.act('close-transfer',details,phoneToken);e.advance()
  const second=await e.act('close-transfer',details,phoneToken)
  expect(second.terminal).toEqual(first.terminal);expect(first.terminal).toMatchObject({schema:'saved-transfer-terminal/1',fence:e.fence,byteLength:e.bytes.length,ref:e.ref})
  expect(second.budget).toEqual(first.budget);expect(e.db.prepare('SELECT * FROM managed_upload_recovery_episodes').all()).toEqual(before);expect(e.db.prepare('SELECT * FROM managed_saved_transfer_bindings').all()).toEqual(bindings)
  expect(e.counts().puts).toBe(1);expect((await ordinary(e)).status).toBe(409)
  expect((await e.request('reconcile',{actionId:'action_one'},phoneToken)).status).toBe(409)
 })
 it('retains the terminal fence when episode metadata is missing and admission is re-enabled',async()=>{
  const e=await published();await e.act('close-transfer',{...e.details,byteLength:e.bytes.length},phoneToken)
  e.db.prepare('DELETE FROM managed_upload_recovery_episodes').run();e.env.MANAGED_SAVED_UPLOAD_RECOVERY='1'
  expect((await ordinary(e)).status).toBe(409)
  expect((await e.request('offer',{},phoneToken)).status).toBe(409)
  expect((await e.transfer('prepare')).status).toBe(409)
  expect(e.db.prepare('SELECT * FROM managed_saved_transfer_terminals').all()).toHaveLength(1);expect(e.counts().puts).toBe(1)
 })
 it('does not treat upload acknowledgment or unknown outcomes as terminal publication',async()=>{
  const e=await pinned();await e.transfer('prepare');await e.transfer('arm')
  const details={...e.details,byteLength:e.bytes.length}
  expect((await e.request('close-transfer',details,phoneToken)).status).toBe(409)
  await e.act('upload',{actionId:'action_one',document:e.document,bindingHash:e.details.bindingHash},phoneToken)
  expect((await e.request('close-transfer',details,phoneToken)).status).toBe(409)
  expect(e.db.prepare('SELECT * FROM managed_saved_transfer_terminals').all()).toHaveLength(0)
 })
 it.each([{actionId:'other'},{revision:999},{bindingHash:'b'.repeat(64)},{accountId:'other'},{policyRevision:2},{byteLength:1}])('holds changed terminal request pins %j',async change=>{
  const e=await published();expect((await e.request('close-transfer',{...e.details,byteLength:e.bytes.length,...change},phoneToken)).status).toBe(409)
  expect(e.db.prepare('SELECT * FROM managed_saved_transfer_terminals').all()).toHaveLength(0)
 })
 it('requires the original authenticated phone and fresh exact cloud readback',async()=>{
  const e=await published(),details={...e.details,byteLength:e.bytes.length}
  expect((await e.request('close-transfer',details,otherToken)).status).toBe(409)
  expect((await e.request('close-transfer',details,studioToken)).status).toBe(409)
  e.objects.clear();expect((await e.request('close-transfer',details,phoneToken)).status).toBe(409)
  expect(e.db.prepare('SELECT * FROM managed_saved_transfer_terminals').all()).toHaveLength(0);expect(e.counts().puts).toBe(1)
 })
 it('retains the copy when a shared recovery stop arrives during terminal readback',async()=>{
  const e=await published();e.onGet(async()=>{await e.stop()})
  expect((await e.request('close-transfer',{...e.details,byteLength:e.bytes.length},phoneToken)).status).toBe(409)
  expect(e.db.prepare('SELECT * FROM managed_saved_transfer_terminals').all()).toHaveLength(0);expect(e.counts().puts).toBe(1)
 })
 it('rechecks publication after the awaited cloud read and retains bytes on stale state',async()=>{
  const e=await published();e.onGet(async()=>{e.db.prepare("UPDATE managed_tasks SET body=json_set(body,'$.state','cancelled') WHERE id=?").run(e.fence.taskId)})
  expect((await e.request('close-transfer',{...e.details,byteLength:e.bytes.length},phoneToken)).status).toBe(409)
  expect(e.db.prepare('SELECT * FROM managed_saved_transfer_terminals').all()).toHaveLength(0)
 })
 it('rechecks recovery enrollment after an ordinary writer awaits its first cloud read',async()=>{
  const e=await setup();let first=true
  e.onGet(async()=>{if(first){first=false;await e.offer();e.env.MANAGED_SAVED_UPLOAD_RECOVERY='0'}})
  expect((await ordinary(e)).status).toBe(409);expect(e.counts().puts).toBe(0)
 })
 it('retains a started ordinary write across API restart and forbids a competing recovery PUT',async()=>{
  const e=await setup()
  e.onPut(async()=>{e.objects.clear();throw new Error('Lost ordinary upload')})
  await expect(ordinary(e)).rejects.toThrow('Lost ordinary upload');e.onPut(null)
  expect((await ordinary(e)).status).toBe(409);expect(e.counts().puts).toBe(1)
  await e.offer();await e.enable();await e.reserve()
  expect((await e.request('upload',{actionId:'action_one',document:e.document},phoneToken)).status).toBe(409)
  expect(e.counts().puts).toBe(1)
 })
})
