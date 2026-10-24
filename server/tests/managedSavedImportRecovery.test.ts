import {SavedCropRecoveryBridge,resolveSavedCropScope,currentSavedCropInput,type SavedCropTarget} from '../src/services/savedCropRecoveryBridge.js'
import {createRequire} from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {afterEach,describe,it,expect,vi} from 'vitest'
import {TaskAuthority} from '../../relay/src/taskAuthority.js'
import {ManagedTaskApi,type ManagedTaskEnvironment} from '../../relay/src/managedTaskApi.js'
import {artifactHash,artifactRef} from '../src/services/managedCropArtifact.js'
import {ManagedArtifactDestination,resolveManagedCropInput} from '../src/services/managedArtifactImport.js'
import {ManagedSavedImportRecovery,savedImportDestinationId,savedImportRecoveryTransport,type SavedImportRecoveryTransport} from '../src/services/managedSavedImportRecovery.js'
import {SAVED_IMPORT_SCHEMA,type SavedImportFence,type SavedImportRecord} from '../src/services/managedSavedImportRecoveryProtocol.js'
import {MANAGED_CAPABILITIES,TaskConflict} from '../src/services/managedTaskProtocol.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite')
const folders:string[]=[],databases:any[]=[]
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const db of databases.splice(0))try{db.close()}catch{};for(const f of folders.splice(0))await fs.rm(f,{recursive:true,force:true})})
const studio={role:'studio'} as const,phone={role:'phone',deviceId:'phone'} as const
const token='s'.repeat(40),phoneToken='p'.repeat(40)
async function setup(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'saved-crop-recovery-'));folders.push(root)
 const database=path.join(root,'relay.sqlite');let db=new DatabaseSync(database);databases.push(db)
 const sql:any={exec:(q:string,...args:any[])=>{const rows=db.prepare(q).all(...args);return {toArray:()=>rows}}}
 let seq=0,now=Date.parse('2026-10-22T12:00:00Z')
 const tx=<T>(work:()=>T):T=>{const key='tx'+(++seq);db.exec('SAVEPOINT '+key);try{const r=work();db.exec('RELEASE '+key);return r}catch(e){db.exec('ROLLBACK TO '+key);db.exec('RELEASE '+key);throw e}}
 const a=new TaskAuthority(sql,tx,()=>new Date(now).toISOString(),()=> 'id_'+(++seq)),event=()=> 'event_'+(++seq)
 a.registerPeer(phone,event(),['profile'],[...MANAGED_CAPABILITIES],'fixture');a.enroll(studio,event(),'phone','profile',[...MANAGED_CAPABILITIES])
 const source=await sharp({create:{width:12,height:20,channels:3,background:'white'}}).png().toBuffer()
 const sourceFile=path.join(root,'page.png');await fs.writeFile(sourceFile,source)
 const sourceHash=await artifactHash(source),identity={workspaceId:'workspace',seriesId:'series',chapterId:'chapter',pageId:'page'}
 const spec={version:'crop-page/1' as const,provider:'chatgpt' as const,product:'web',model:'fixture',settings:{mode:null,effort:null},pageRevision:'r1',promptVersion:'fixture',validatorVersion:'managed-crop-validator/1',dependencies:[{id:'page',revision:'r1',sha256:sourceHash}]}
 const task=await a.plan(studio,event(),identity,spec),claimed=a.claim(studio,event(),task.id,'phone','profile',null),attempt=claimed.attempt
 for(const phase of ['accepted','started','submission_intent','result_saved'] as const)a.checkpoint(phone,event(),task.id,attempt.id,1,task.fingerprint,phase,phase==='result_saved'?'checkpoint/result':null,claimed.command.id)
 const bytes=new TextEncoder().encode(JSON.stringify({schema:'managed-crop-page/1',taskId:task.id,attemptId:attempt.id,generation:1,fingerprint:task.fingerprint,checkpointRef:'checkpoint/result',pageRevision:'r1',validatorVersion:'managed-crop-validator/1',pointers:JSON.stringify({format:'four-point-crop',version:'1.0',coordinateSystem:'normalized',image:{filename:'page.png',width:12,height:20},crops:[]}),metadata:'{"crops":[]}'}))
 const hash=await artifactHash(bytes),ref=artifactRef(task,attempt.id,'artifact')
 a.stage(phone,event(),task.id,attempt.id,1,task.fingerprint,'artifact',ref,hash)
 const saved=a.artifactOwner(studio,task.id,attempt.id,1,task.fingerprint),staged=a.artifact(studio,'artifact')
 const origin=new ManagedArtifactDestination(path.join(root,'original'))
 const receipt=await origin.stage({task:saved.task,attempt:saved.attempt,record:staged,bytes})
 a.publish(studio,event(),task.id,attempt.id,1,task.fingerprint,'artifact',hash,receipt.reference)
 let afterGet:(()=>void)|null=null
 const bucket={async get(key:string){afterGet?.();return key===ref?{size:bytes.length,arrayBuffer:async()=>new Uint8Array(bytes).buffer}:null},async put(){throw new Error('No cloud upload permitted')}}
 const env:ManagedTaskEnvironment={MANAGED_CROP_PAGE:'1',MANAGED_SAVED_IMPORT_RECOVERY:'1',MANAGED_WORKSPACE_ID:'workspace',MANAGED_STUDIO_TOKEN:token,MANAGED_DEVICE_TOKENS:JSON.stringify({phone:phoneToken}),MANAGED_ARTIFACTS:bucket}
 const make=()=>new ManagedTaskApi(sql,tx,env,()=>new Date(now).toISOString());let api=make()
 const fence:SavedImportFence={workspaceId:'workspace',taskId:task.id,attemptId:attempt.id,generation:1,fingerprint:task.fingerprint,artifactId:'artifact',sha256:hash}
 const destination=new ManagedArtifactDestination(path.join(root,'restored')),destinationId=await savedImportDestinationId(destination)
 const requests:string[]=[]
 const request=(action:string,details:Record<string,unknown>={},f=fence,d=destinationId,bearer=token)=>api.handle(new Request('https://fixture/managed/recovery/saved-import',{method:'POST',headers:{Authorization:'Bearer '+bearer},body:JSON.stringify({schema:SAVED_IMPORT_SCHEMA,action,fence:f,destinationId:d,details})}))
 const transport:SavedImportRecoveryTransport={singleAttempt:true,get globalEnabled(){return env.MANAGED_SAVED_IMPORT_RECOVERY==='1'},artifacts:{async load(id){requests.push('load');const r=await api.handle(new Request('https://fixture/managed/artifacts/'+id,{headers:{Authorization:'Bearer '+token}}));if(r.status!==200)throw new TaskConflict('Artifact read rejected');const raw=await r.json();return {record:raw.record,task:raw.task,attempt:raw.attempt,bytes:new TextEncoder().encode(raw.document)}},async publish(){throw new Error('No publication permitted')}},async call(action,f,d,details){requests.push(action);const response=await request(action,details,f,d);const body=await response.json();if(response.status!==200)throw new TaskConflict(body.error);return body.result}}
 const control=async(change:Partial<SavedImportRecord>={})=>{const old=await transport.call('inspect',fence,destinationId,{});return transport.call('control',fence,destinationId,{revision:old?.revision??0,enabled:true,paused:false,cancelled:false,...change})}
 const current=()=>resolveManagedCropInput(identity,spec,sourceFile)
 const snapshot=()=>({tasks:db.prepare('SELECT * FROM managed_tasks ORDER BY id').all(),attempts:db.prepare('SELECT * FROM managed_attempts ORDER BY id').all(),commands:db.prepare('SELECT * FROM managed_commands ORDER BY id').all(),artifacts:db.prepare('SELECT * FROM managed_artifacts ORDER BY id').all(),reservations:db.prepare('SELECT * FROM managed_reservations ORDER BY resource').all()})
 return {input:{identity,spec,sourceFile,folder:'fixture',filename:'page.png',destination:destination.rootPath},a,sql,tx,env,root,fence,destination,destinationId,transport,control,current,sourceFile,request,requests,receipt,snapshot,run:()=>new ManagedSavedImportRecovery(transport).run(fence,'recovery_one',destination,current,new AbortController().signal),record:()=>transport.call('inspect',fence,destinationId,{}),afterGet:(hook:(()=>void)|null)=>{afterGet=hook},now:()=>now,advance:()=>now+=60_000,restart:()=>{db.close();db=new DatabaseSync(database);databases.push(db);api=make()}}
}
describe('fenced saved crop local import recovery',()=>{
 it('rebuilds and verifies a real immutable local projection without changing cloud task/history or publishing',async()=>{
  const e=await setup();await e.control();const before=e.snapshot(),publish=vi.spyOn(e.transport.artifacts,'publish')
  const output=await e.run();expect(output.task.state).toBe('verified_complete');expect(await fs.readFile(output.path,'utf8')).toContain('managed-crop-page/1')
  expect((await e.record())!.actions[0].phase).toBe('verified');expect(e.snapshot()).toEqual(before);expect(publish).not.toHaveBeenCalled()
  expect(e.requests.filter(x=>x==='reserve')).toHaveLength(1);expect(e.requests.filter(x=>x==='start')).toHaveLength(1)
 })
 it('reports authoritative switch status to the HTTP transport and rejects malformed revision envelopes',async()=>{
  const e=await setup(),fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
   const raw=JSON.parse(init!.body as string);return e.request(raw.action,raw.details,raw.fence,raw.destinationId)
  })
  const client=savedImportRecoveryTransport('https://fixture/','workspace',token)
  expect(client.globalEnabled).toBe(false);await client.call('inspect',e.fence,e.destinationId,{});expect(client.globalEnabled).toBe(true)
  delete e.env.MANAGED_SAVED_IMPORT_RECOVERY
  expect(await client.call('inspect',e.fence,e.destinationId,{})).toBeNull();expect(client.globalEnabled).toBe(false)
  e.env.MANAGED_SAVED_IMPORT_RECOVERY='1'
  expect((await e.request('reserve',null as any)).status).toBe(409)
  expect(fetch).toHaveBeenCalledTimes(2)
 })
 it('is default off, requires a Studio principal and requires explicit per-unit enablement',async()=>{
  const e=await setup();delete e.env.MANAGED_SAVED_IMPORT_RECOVERY
  expect((await e.request('inspect')).status).toBe(200);e.env.MANAGED_SAVED_IMPORT_RECOVERY='1'
  expect((await e.request('inspect',{},e.fence,e.destinationId,phoneToken)).status).toBe(403)
  await expect(e.run()).rejects.toThrow('disabled');expect((await e.request('inspect',{}, {...e.fence,workspaceId:'foreign'})).status).toBe(409)
 })
 it('rejects malformed envelopes, stale fences, foreign artifacts and destination changes without a new budget',async()=>{
  const e=await setup();await e.control()
  for(const change of [{generation:2},{fingerprint:'a'.repeat(64)},{attemptId:'other'},{artifactId:'other'},{sha256:'b'.repeat(64)}])expect((await e.request('reserve',{actionId:'one'},{...e.fence,...change})).status).toBe(409)
  expect((await e.request('reserve',{actionId:'one',extra:true})).status).toBe(409)
  expect((await e.request('reserve',{actionId:'one'},e.fence,'c'.repeat(64))).status).toBe(409)
  expect((await e.record())!.actions).toHaveLength(0)
 })
 it('grants one reservation and one start across independent authority instances',async()=>{
  const e=await setup();await e.control()
  const replies=await Promise.all([e.request('reserve',{actionId:'first'}),e.request('reserve',{actionId:'second'})]);expect(replies.map(r=>r.status).sort()).toEqual([200,409])
  const action=(await e.record())!.actions[0].id;e.restart()
  expect((await e.request('start',{actionId:action})).status).toBe(200)
  expect((await e.request('start',{actionId:action})).status).toBe(409)
  expect((await e.record())!.actions).toHaveLength(1)
 })
 it('rechecks pause/cancel and exact owner after asynchronous cloud validation',async()=>{
  const e=await setup();await e.control();await e.request('reserve',{actionId:'first'})
  e.afterGet(()=>{const row=e.sql.exec('SELECT id,body FROM managed_recovery_episodes').toArray()[0],r=JSON.parse(row.body);r.cancelled=true;r.revision++;e.sql.exec('UPDATE managed_recovery_episodes SET body = ? WHERE id = ?',JSON.stringify(r),row.id)})
  expect((await e.request('start',{actionId:'first'})).status).toBe(409)
  e.afterGet(null);expect((await e.record())!.actions[0].phase).toBe('reserved')
 })
 it('checks cancellation again between local staging and final local projection',async()=>{
  const e=await setup();await e.control();const original=e.destination.stage.bind(e.destination)
  vi.spyOn(e.destination,'stage').mockImplementationOnce(async snapshot=>{const result=await original(snapshot);await e.control({cancelled:true});return result})
  await expect(e.run()).rejects.toThrow('cancelled')
  expect((await e.record())!.actions[0].phase).toBe('unknown')
  expect(await e.destination.readPublished(e.a.timeline(studio,e.fence.taskId).task)).toBeNull()
 })
 it('rejects changed actual source bytes before staging and never regenerates the provider result',async()=>{
  const e=await setup();await e.control();await fs.writeFile(e.sourceFile,await sharp({create:{width:6,height:6,channels:3,background:'black'}}).png().toBuffer())
  const stage=vi.spyOn(e.destination,'stage');await expect(e.run()).rejects.toThrow('dependency');expect(stage).not.toHaveBeenCalled()
  expect((await e.record())!.actions[0].phase).toBe('safe_failure')
 })
 it('charges each safe read failure once, respects cooldown and stops after three attempts',async()=>{
  const e=await setup();await e.control();const load=vi.spyOn(e.transport.artifacts,'load').mockRejectedValue(new Error('read failed'))
  for(let n=1;n<=3;n++){await expect(new ManagedSavedImportRecovery(e.transport).run(e.fence,'read_'+n,e.destination,e.current,new AbortController().signal)).rejects.toThrow('read failed');expect((await e.request('reserve',{actionId:'early_'+n})).status).toBe(409);e.advance()}
  await expect(e.run()).rejects.toThrow('exhausted');expect(load).toHaveBeenCalledTimes(3);expect((await e.record())!.actions).toHaveLength(3)
 })
 it('holds a started action after process/database restart instead of granting another effect',async()=>{
  const e=await setup();await e.control();await e.request('reserve',{actionId:'first'});await e.request('start',{actionId:'first'});e.restart()
  expect((await e.request('reserve',{actionId:'replacement'})).status).toBe(409)
  expect(await new ManagedSavedImportRecovery(e.transport).reconcile(e.fence,e.destination,e.current,new AbortController().signal)).toEqual({state:'needs_reconciliation'})
  expect((await e.record())!.actions).toHaveLength(1)
 })
 it('recovers a lost finish acknowledgment by validating local bytes and reading retained state',async()=>{
  const e=await setup();await e.control();const original=e.transport.call.bind(e.transport);let lost=true
  vi.spyOn(e.transport,'call').mockImplementation(async(action,f,d,details)=>{const result=await original(action,f,d,details);if(action==='finish'&&details.outcome==='verified'&&lost){lost=false;throw new Error('lost ACK')}return result})
  await expect(e.run()).rejects.toThrow('lost ACK');e.restart()
  const reserveCount=e.requests.filter(x=>x==='reserve').length
  expect(await new ManagedSavedImportRecovery(e.transport).reconcile(e.fence,e.destination,e.current,new AbortController().signal)).toEqual({state:'verified'})
  expect(e.requests.filter(x=>x==='reserve')).toHaveLength(reserveCount);expect((await e.record())!.actions).toHaveLength(1)
 })
 it('reconciles a crash after local completion without a second import',async()=>{
  const e=await setup();await e.control();const call=e.transport.call.bind(e.transport)
  vi.spyOn(e.transport,'call').mockImplementation(async(action,f,d,details)=>{if(action==='finish')throw new Error('crashed before receipt');return call(action,f,d,details)})
  await expect(e.run()).rejects.toThrow('crashed before receipt');vi.restoreAllMocks();e.restart()
  const stage=vi.spyOn(e.destination,'stage')
  expect(await new ManagedSavedImportRecovery(e.transport).reconcile(e.fence,e.destination,e.current,new AbortController().signal)).toEqual({state:'verified'})
  expect(stage).not.toHaveBeenCalled();expect((await e.record())!.actions[0].phase).toBe('verified')
 })
 it('retains corrupt destination bytes and refuses to repair by overwriting them',async()=>{
  const e=await setup();await e.control();const local=path.join(e.destination.rootPath,e.fence.taskId.slice(12),e.fence.attemptId,e.fence.artifactId)
  await fs.mkdir(local,{recursive:true});await fs.writeFile(path.join(local,'artifact.json'),'corrupt')
  await expect(e.run()).rejects.toThrow('conflict');expect(await fs.readFile(path.join(local,'artifact.json'),'utf8')).toBe('corrupt');expect((await e.record())!.actions[0].phase).toBe('unknown')
 })
 it('does not clear cancellation or permit stale control writes',async()=>{
  const e=await setup();const initial=(await e.control())!;await e.control({cancelled:true})
  expect((await e.request('control',{revision:initial.revision,enabled:true,paused:false,cancelled:false})).status).toBe(409)
  await e.control({cancelled:false});expect((await e.record())!.cancelled).toBe(true)
  await expect(e.run()).rejects.toThrow('cancelled')
 })
 it('refuses ineligible saved/unpublished work and retired owners',async()=>{
  const e=await setup();await e.control();const original=e.a.timeline(studio,e.fence.taskId).task
  e.sql.exec('UPDATE managed_tasks SET body = ? WHERE id = ?',JSON.stringify({...original,state:'uncertain',canonical:null}),original.id)
  expect((await e.request('reserve',{actionId:'first'})).status).toBe(409)
  e.sql.exec('UPDATE managed_tasks SET body = ? WHERE id = ?',JSON.stringify({...original,generation:2}),original.id)
  expect((await e.request('reserve',{actionId:'first'})).status).toBe(409)
 })
 it('does not issue any action after an already aborted signal',async()=>{
  const e=await setup();await e.control();const c=new AbortController();c.abort();const before=e.requests.length
  await expect(new ManagedSavedImportRecovery(e.transport).run(e.fence,'first',e.destination,e.current,c.signal)).rejects.toThrow()
  expect(e.requests).toHaveLength(before);expect((await e.record())!.actions).toHaveLength(0)
 })
 it('rejects enabled nested retries and never automatically retries failed HTTP calls',async()=>{
  const e=await setup();expect(()=>new ManagedSavedImportRecovery({...e.transport,singleAttempt:false as any})).toThrow('nested')
  const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('connection lost'))
  const client=savedImportRecoveryTransport('https://relay.example/','workspace',token)
  await expect(client.call('inspect',e.fence,e.destinationId,{})).rejects.toThrow('connection lost');expect(fetch).toHaveBeenCalledTimes(1)
 })
 it('holds a lost start acknowledgment without a second local effect after restart',async()=>{
  const e=await setup();await e.control();const original=e.transport.call.bind(e.transport)
  vi.spyOn(e.transport,'call').mockImplementation(async(action,f,d,details)=>{const result=await original(action,f,d,details);if(action==='start')throw new Error('lost start ACK');return result})
  const stage=vi.spyOn(e.destination,'stage');await expect(e.run()).rejects.toThrow('lost start ACK');expect(stage).not.toHaveBeenCalled()
  vi.restoreAllMocks();e.restart();await expect(e.run()).rejects.toThrow('reconcile')
  expect((await e.record())!.actions[0].phase).toBe('executing')
 })
 it('checks authoritative generation again after the asynchronous storage read',async()=>{
  const e=await setup();await e.control();await e.request('reserve',{actionId:'first'})
  e.afterGet(()=>{const task=e.a.timeline(studio,e.fence.taskId).task;e.sql.exec('UPDATE managed_tasks SET body = ? WHERE id = ?',JSON.stringify({...task,generation:2}),task.id)})
  expect((await e.request('start',{actionId:'first'})).status).toBe(409)
 })
 it('preserves malformed retained state instead of resetting a budget',async()=>{
  const e=await setup();await e.control();const row=e.sql.exec('SELECT id,body FROM managed_recovery_episodes').toArray()[0],r=JSON.parse(row.body)
  r.actions=[{id:'fake',phase:'executing',at:0,finishedAt:1,evidenceRef:'evidence/invalid'}]
  const damaged=JSON.stringify(r);e.sql.exec('UPDATE managed_recovery_episodes SET body = ? WHERE id = ?',damaged,row.id)
  expect((await e.request('control',{revision:r.revision,enabled:true,paused:false,cancelled:false})).status).toBe(409)
  expect(e.sql.exec('SELECT body FROM managed_recovery_episodes').toArray()[0].body).toBe(damaged)
 })
 it('verifies outcome evidence, preserves idempotent receipts and records after pause',async()=>{
  const e=await setup();await e.control();await e.request('reserve',{actionId:'first'});await e.request('start',{actionId:'first'});await e.control({paused:true})
  expect((await e.request('finish',{actionId:'first',outcome:'verified',evidenceRef:'validation/'+'a'.repeat(64)})).status).toBe(409)
  const details={actionId:'first',outcome:'unknown',evidenceRef:'evidence/read-uncertain'}
  const first=await(await e.request('finish',details)).json();const replay=await(await e.request('finish',details)).json()
  expect(replay).toEqual(first)
  expect((await e.request('finish',{actionId:'first',outcome:'safe_failure',evidenceRef:'evidence/read-uncertain'})).status).toBe(409)
 })
 it('does not import when cancellation arrives while loading the original bytes',async()=>{
  const e=await setup();await e.control();const original=e.transport.artifacts.load.bind(e.transport.artifacts)
  vi.spyOn(e.transport.artifacts,'load').mockImplementation(async id=>{const result=await original(id);await e.control({cancelled:true});return result})
  const stage=vi.spyOn(e.destination,'stage');await expect(e.run()).rejects.toThrow('cancelled');expect(stage).not.toHaveBeenCalled()
 })
 it('bounds network responses and respects the existing relay Retry-After gate',async()=>{
  const e=await setup();const {RelayDeliveryPause}=await import('../src/services/relayDeliveryPause.js')
  let saved:string|null=null;const pause=new RelayDeliveryPause({load:async()=>null,save:async value=>{saved=value}})
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('{}',{status:429,headers:{'Retry-After':'600'}}))
  const client=savedImportRecoveryTransport('https://relay.example/','workspace',token,undefined,pause)
  await expect(client.call('inspect',e.fence,e.destinationId,{})).rejects.toThrow('429');expect(saved).not.toBeNull()
  await expect(client.call('inspect',e.fence,e.destinationId,{})).rejects.toThrow('paused');expect(fetch).toHaveBeenCalledTimes(1)
  fetch.mockResolvedValue(new Response('x'.repeat(32_001)))
  await expect(savedImportRecoveryTransport('https://relay.example/','workspace',token).call('inspect',e.fence,e.destinationId,{})).rejects.toThrow('too large')
 })
 it('blocks new work after the global kill switch while retaining in-flight outcomes',async()=>{
  const e=await setup();await e.control();await e.request('reserve',{actionId:'first'});await e.request('start',{actionId:'first'})
  delete e.env.MANAGED_SAVED_IMPORT_RECOVERY
  expect((await e.request('check',{actionId:'first'})).status).toBe(503)
  expect((await e.request('reserve',{actionId:'next'})).status).toBe(503)
  expect((await e.request('finish',{actionId:'first',outcome:'unknown',evidenceRef:'evidence/stopped'})).status).toBe(200)
  expect((await e.record())!.actions[0].phase).toBe('unknown')
 })
})

describe('server recovery panel bridge with real relay SQL and filesystem',()=>{
 async function fixture(){
  const e=await setup()
  const scope=await resolveSavedCropScope(e.input,{task:e.a.timeline(studio,e.fence.taskId).task,destination:e.destination.rootPath},{timeline:async id=>e.a.timeline(studio,id),artifacts:e.transport.artifacts},e.current)
  const deps={transport:e.transport,enabled:()=>true,async resolve(pageId:string){if(pageId!=='approved_page')throw new Error('Unknown page');return scope}}
  const bridge=new SavedCropRecoveryBridge(deps)
  const perform=(action:string,revision=0,actionId?:string,target:SavedCropTarget=scope.target)=>bridge.perform('approved_page',{action,target,expectedRevision:revision,...(actionId?{actionId}:{})})
  return {...e,bridge,perform,scope,deps}
 }
 it('honors a detached local hold arriving during an authority read before writing any restored bytes',async()=>{
  const e=await fixture();const enabled=await e.perform('enable');let held=false
  const bridge=new SavedCropRecoveryBridge({...e.deps,assertAdmission:async()=>{if(held)throw new Error('Detached local stop')}})
  const current=e.scope.current;e.scope.current=async()=>{const source=await current();if(e.requests.includes('start'))held=true;return source}
  await expect(bridge.perform('approved_page',{action:'run',target:e.scope.target,expectedRevision:enabled.episode!.revision,actionId:'guarded'})).rejects.toThrow('Detached local stop')
  expect((await e.record())!.actions.at(-1)?.phase).toBe('safe_failure')
  expect(await e.destination.inspectProjection(await e.transport.artifacts.load(e.fence.artifactId))).toBe('missing')
 })
 it('discovers one opaque target and restores once after explicit inspection and enablement',async()=>{
  const e=await fixture(),before=e.snapshot()
  expect(await e.bridge.targets('approved_page')).toEqual([e.scope.target]);expect(JSON.stringify(e.scope.target)).not.toContain(e.root)
  expect(e.requests.filter(x=>['reserve','start','control'].includes(x))).toEqual([])
  const inspected=await e.perform('inspect');expect(inspected).toMatchObject({canonical:true,sourceMatches:true,globalEnabled:true,localState:'missing',episode:null})
  const enabled=await e.perform('enable');expect(enabled.episode!.enabled).toBe(true)
  const done=await e.perform('run',enabled.episode!.revision,'bridge_action');expect(done.localState).toBe('verified');expect(done.episode!.actions[0].phase).toBe('verified')
  await expect(e.perform('run',done.episode!.revision,'another_action')).rejects.toThrow('held')
  expect(e.snapshot()).toEqual(before)
 })
 it('requires both local and relay switches and allows read-only inspection with no episode while off',async()=>{
  const e=await fixture();delete e.env.MANAGED_SAVED_IMPORT_RECOVERY
  const view=await e.perform('inspect');expect(view.globalEnabled).toBe(false);expect(view.episode).toBeNull()
  await expect(e.perform('enable')).rejects.toThrow('disabled')
  e.env.MANAGED_SAVED_IMPORT_RECOVERY='1';e.deps.enabled=()=>false
  await expect(e.perform('enable')).rejects.toThrow('disabled');expect((await e.perform('inspect')).localState).toBe('missing')
 })
 it('rejects browser paths, forged scope, unapproved pages, extra fields and stale revisions',async()=>{
  const e=await fixture()
  await expect(e.bridge.targets('../foreign')).rejects.toThrow('Unknown page')
  for(const target of [{...e.scope.target,destinationId:'a'.repeat(64)},{...e.scope.target,artifactId:'foreign'},{...e.scope.target,destination:'/tmp/arbitrary'}])await expect(e.perform('inspect',0,undefined,target)).rejects.toThrow('approved')
  await expect(e.bridge.perform('approved_page',{action:'inspect',target:e.scope.target,expectedRevision:0,token:'secret'})).rejects.toThrow('Exact')
  const enabled=await e.perform('enable')
  await expect(e.perform('run',0,'stale')).rejects.toThrow('revision')
  const revision=enabled.episode!.revision
  await e.control({paused:true});expect((await e.request('reserve',{actionId:'atomic_stale',revision})).status).toBe(409)
  expect((await e.record())!.actions).toHaveLength(0)
 })
 it('checks revisions atomically even if controls change after inspection but before reserve',async()=>{
  const e=await fixture();const enabled=await e.perform('enable'),revision=enabled.episode!.revision
  await e.control();expect((await e.request('reserve',{actionId:'stale_but_enabled',revision})).status).toBe(409)
  expect((await e.record())!.actions).toHaveLength(0)
 })
 it('shows changed actual source and corrupt partial files without spending a recovery attempt',async()=>{
  const e=await fixture(),artifact=path.join(e.destination.rootPath,e.fence.taskId.slice(12),e.fence.attemptId,e.fence.artifactId,'artifact.json')
  await fs.mkdir(path.dirname(artifact),{recursive:true});await fs.writeFile(artifact,'keep corrupt evidence')
  const inspected=await e.perform('inspect');expect(inspected.localState).toBe('conflict');await expect(e.perform('enable')).rejects.toThrow('held')
  expect(await fs.readFile(artifact,'utf8')).toBe('keep corrupt evidence');expect(await e.record()).toBeNull()
  await fs.writeFile(e.sourceFile,await sharp({create:{width:6,height:6,channels:3,background:'black'}}).png().toBuffer())
  expect((await e.perform('inspect')).sourceMatches).toBe(false)
 })
 it('re-reads the actual source and private binding at each import boundary',async()=>{
  const e=await fixture(),binding={task:e.a.timeline(studio,e.fence.taskId).task,destination:e.destination.rootPath}
  const fresh=()=>Promise.resolve(e.input)
  expect((await currentSavedCropInput(fresh,async()=>binding,e.scope.target)).source.width).toBe(12)
  await expect(currentSavedCropInput(fresh,async()=>null,e.scope.target)).rejects.toThrow('changed')
  await expect(currentSavedCropInput(fresh,async()=>({...binding,destination:path.join(e.root,'another')}),e.scope.target)).rejects.toThrow('changed')
  await fs.writeFile(e.sourceFile,await sharp({create:{width:6,height:6,channels:3,background:'black'}}).png().toBuffer())
  await expect(currentSavedCropInput(fresh,async()=>binding,e.scope.target)).rejects.toThrow('dependency')
 })
 it('rejects symlink destinations and accepts matching staged files without writing during inspection',async()=>{
  const e=await fixture(),published=e.a.timeline(studio,e.fence.taskId).task,snapshot=await e.transport.artifacts.load(e.fence.artifactId)
  await fs.mkdir(e.destination.rootPath);await fs.symlink(path.join(e.root,'original',published.id.slice(12)),path.join(e.destination.rootPath,published.id.slice(12)))
  expect((await e.perform('inspect')).localState).toBe('conflict')
  const clean=new ManagedArtifactDestination(path.join(e.root,'partial'));await clean.stage(snapshot)
  const stage=vi.spyOn(clean,'stage');expect(await clean.inspectProjection(snapshot)).toBe('missing');expect(stage).not.toHaveBeenCalled()
  expect(await clean.readPublished(published)).toBeNull()
 })
 it('retains a lost action across restart and reconciles completed local bytes with both switches off',async()=>{
  const e=await fixture(),enabled=await e.perform('enable'),call=e.transport.call.bind(e.transport)
  vi.spyOn(e.transport,'call').mockImplementation(async(action,f,d,details)=>{if(action==='finish')throw new Error('lost acknowledgment');return call(action,f,d,details)})
  await expect(e.perform('run',enabled.episode!.revision,'retained_action')).rejects.toThrow('lost acknowledgment')
  vi.restoreAllMocks();e.restart();delete e.env.MANAGED_SAVED_IMPORT_RECOVERY;e.deps.enabled=()=>false
  const before=e.requests.filter(x=>x==='reserve').length
  const result=await e.perform('reconcile',0,'retained_action');expect(result.localState).toBe('verified');expect(result.globalEnabled).toBe(false);expect(result.episode!.actions[0].phase).toBe('verified')
  expect(e.requests.filter(x=>x==='reserve')).toHaveLength(before)
 })
 it('keeps unfinished actions held and refuses to reconcile a different lost action identity',async()=>{
  const e=await fixture();await e.control();await e.request('reserve',{actionId:'original'});await e.request('start',{actionId:'original'});e.restart()
  await expect(e.perform('reconcile',0,'other')).rejects.toThrow('unresolved')
  const result=await e.perform('reconcile',0,'original');expect(result.episode!.actions[0].phase).toBe('executing');expect(result.localState).toBe('missing')
  await expect(e.perform('run',result.episode!.revision,'replacement')).rejects.toThrow('held')
 })
})

// Automation uses the same real relay authority, immutable bytes and filesystem validator as the panel.
import {restoreManagedProductionProjection} from '../src/services/managedProductionRecovery.js'
import {AutomationRecovery} from '../src/services/automationRecovery.js'
import {bindManagedCrop} from '../src/services/managedCropProjection.js'
import {PrismaClient} from '@prisma/client'
import {productionJobDatabase} from '../src/services/productionJobDatabase.js'
import {runManagedProduction} from '../src/services/managedProduction.js'
async function productionFixture(){
 const e=await setup();vi.stubEnv('DOWNLOAD_ROOT','/');e.input.folder=e.root
 await bindManagedCrop(e.input.folder,e.input.filename,e.a.timeline(studio,e.fence.taskId).task,e.destination.rootPath)
 const db=new PrismaClient({datasources:{db:{url:'file:'+path.join(e.root,'diagnoses.sqlite')}}})
 await db.$executeRawUnsafe('CREATE TABLE Setting (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)')
 const diagnoses=new AutomationRecovery(productionJobDatabase(()=>db),e.now)
 const authority={ready:vi.fn(async()=>{}),operation:vi.fn(async()=>{throw new Error('No task mutation allowed')}),timeline:vi.fn(async(id:string)=>e.a.timeline(studio,id)),artifacts:e.transport.artifacts}
 const report=vi.fn(async()=>{}),wait=vi.fn(async()=>{e.advance()}),deps={authority,transport:e.transport,diagnoses,enabled:()=>true,report,wait,now:e.now,refreshInput:async()=>e.input}
 const signal=new AbortController()
 const run=()=>restoreManagedProductionProjection(e.input,signal.signal,deps)
 const unit={workspaceId:e.fence.workspaceId,taskId:e.fence.taskId,attemptId:e.fence.attemptId,generation:1,fingerprint:e.fence.fingerprint}
 const enroll=async()=>{await e.control();await expect(run()).rejects.toThrow('explicitly enable');const d=(await diagnoses.inspect(unit))!;await diagnoses.control(unit,d.revision,{enabled:true,paused:false,cancelled:false})}
 return {...e,db,diagnoses,authority,report,wait,deps,signal,run,unit,enroll}
}
describe('Automation Manager production recovery uses the existing shared authority',()=>{
 it('requires explicit enrollment, restores through production, and does not republish or spend on verified reuse',async()=>{
  const e=await productionFixture()
  try{
   await e.enroll();const before=e.snapshot()
   await runManagedProduction('phone','profile',e.signal.signal,{...e.deps,inputs:async()=>[e.input],restoreVerified:()=>e.run()})
   expect((await e.record())?.actions.map(a=>a.phase)).toEqual(['verified']);expect(e.snapshot()).toEqual(before)
   expect(e.authority.operation).not.toHaveBeenCalled();expect((await e.diagnoses.inspect(e.unit))?.decision.state).toBe('verified')
   const old=await e.diagnoses.inspect(e.unit);await e.run();expect(await e.diagnoses.inspect(e.unit)).toEqual(old)
   expect(e.requests.filter(r=>r==='reserve')).toHaveLength(1)
  }finally{await e.db.$disconnect()}
 })
 it('reconciles an original unknown write after restart while both recovery switches are off',async()=>{
  const e=await productionFixture()
  try{
   await e.enroll();const original=e.transport.call.bind(e.transport);let fail=true
   e.transport.call=async(action,f,d,details)=>{if(action==='finish'&&details.outcome==='verified'&&fail){fail=false;throw new Error('Lost finish transport')}return original(action,f,d,details)}
   await expect(e.run()).rejects.toThrow('Lost finish');expect((await e.record())?.actions[0].phase).toBe('unknown')
   e.env.MANAGED_SAVED_IMPORT_RECOVERY='0';e.deps.enabled=()=>false;e.restart();await e.run()
   expect((await e.record())?.actions[0].phase).toBe('verified');expect(e.requests.filter(r=>r==='reserve')).toHaveLength(1)
  }finally{await e.db.$disconnect()}
 })
 it('waits for the authority cooldown after a safe read failure and counts the next physical action',async()=>{
  const e=await productionFixture()
  try{
   await e.enroll();const load=e.transport.artifacts.load.bind(e.transport.artifacts);let armed=false,failed=false
   const call=e.transport.call.bind(e.transport)
   e.transport.call=async(action,f,d,details)=>{const result=await call(action,f,d,details);if(action==='start'&&!failed)armed=true;return result}
   e.transport.artifacts.load=async id=>{if(armed&&!failed){failed=true;throw new Error('Read interrupted before effect')}return load(id)}
   await e.run();expect((await e.record())?.actions.map(a=>a.phase)).toEqual(['safe_failure','verified'])
   expect(e.wait).toHaveBeenCalledTimes(1);expect(e.requests.filter(r=>r==='reserve')).toHaveLength(2)
   expect((await e.diagnoses.inspect(e.unit))?.budget.used).toBe(2)
  }finally{await e.db.$disconnect()}
 })
 it.each(['cancel','input'] as const)('rechecks %s changes after an asynchronous authority check, before local writes',async mode=>{
  const e=await productionFixture()
  try{
   await e.enroll();const call=e.transport.call.bind(e.transport)
   e.transport.call=async(action,f,d,details)=>{const result=await call(action,f,d,details);if(action==='check'){
    if(mode==='cancel'){const old=(await e.diagnoses.inspect(e.unit))!;await e.diagnoses.control(e.unit,old.revision,{enabled:true,paused:false,cancelled:true})}
    else e.deps.refreshInput=async()=>({...e.input,spec:{...e.input.spec,pageRevision:'changed'}})
   }return result}
   await expect(e.run()).rejects.toThrow();expect(await e.destination.inspectProjection(await e.transport.artifacts.load('artifact'))).toBe('missing')
   expect(e.requests.filter(r=>r==='reserve')).toHaveLength(1)
  }finally{await e.db.$disconnect()}
 })
 it('holds missing files with an unknown original action without issuing a second reserve',async()=>{
  const e=await productionFixture()
  try{
   await e.enroll();await e.request('reserve',{actionId:'original'});await e.request('start',{actionId:'original'})
   await expect(e.run()).rejects.toThrow('reconciliation');expect(e.requests.filter(r=>r==='reserve')).toHaveLength(0)
  }finally{await e.db.$disconnect()}
 })
})
