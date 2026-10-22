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
afterEach(async()=>{vi.restoreAllMocks();for(const db of databases.splice(0))try{db.close()}catch{};for(const f of folders.splice(0))await fs.rm(f,{recursive:true,force:true})})
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
 const transport:SavedImportRecoveryTransport={singleAttempt:true,artifacts:{async load(id){requests.push('load');const r=await api.handle(new Request('https://fixture/managed/artifacts/'+id,{headers:{Authorization:'Bearer '+token}}));if(r.status!==200)throw new TaskConflict('Artifact read rejected');const raw=await r.json();return {record:raw.record,task:raw.task,attempt:raw.attempt,bytes:new TextEncoder().encode(raw.document)}},async publish(){throw new Error('No publication permitted')}},async call(action,f,d,details){requests.push(action);const response=await request(action,details,f,d);const body=await response.json();if(response.status!==200)throw new TaskConflict(body.error);return body.result}}
 const control=async(change:Partial<SavedImportRecord>={})=>{const old=await transport.call('inspect',fence,destinationId,{});return transport.call('control',fence,destinationId,{revision:old?.revision??0,enabled:true,paused:false,cancelled:false,...change})}
 const current=()=>resolveManagedCropInput(identity,spec,sourceFile)
 const snapshot=()=>({tasks:db.prepare('SELECT * FROM managed_tasks ORDER BY id').all(),attempts:db.prepare('SELECT * FROM managed_attempts ORDER BY id').all(),commands:db.prepare('SELECT * FROM managed_commands ORDER BY id').all(),artifacts:db.prepare('SELECT * FROM managed_artifacts ORDER BY id').all(),reservations:db.prepare('SELECT * FROM managed_reservations ORDER BY resource').all()})
 return {a,sql,tx,env,root,fence,destination,destinationId,transport,control,current,sourceFile,request,requests,receipt,snapshot,run:()=>new ManagedSavedImportRecovery(transport).run(fence,'recovery_one',destination,current,new AbortController().signal),record:()=>transport.call('inspect',fence,destinationId,{}),afterGet:(hook:(()=>void)|null)=>{afterGet=hook},advance:()=>now+=60_000,restart:()=>{db.close();db=new DatabaseSync(database);databases.push(db);api=make()}}
}
describe('fenced saved crop local import recovery',()=>{
 it('rebuilds and verifies a real immutable local projection without changing cloud task/history or publishing',async()=>{
  const e=await setup();await e.control();const before=e.snapshot(),publish=vi.spyOn(e.transport.artifacts,'publish')
  const output=await e.run();expect(output.task.state).toBe('verified_complete');expect(await fs.readFile(output.path,'utf8')).toContain('managed-crop-page/1')
  expect((await e.record())!.actions[0].phase).toBe('verified');expect(e.snapshot()).toEqual(before);expect(publish).not.toHaveBeenCalled()
  expect(e.requests.filter(x=>x==='reserve')).toHaveLength(1);expect(e.requests.filter(x=>x==='start')).toHaveLength(1)
 })
 it('is default off, requires a Studio principal and requires explicit per-unit enablement',async()=>{
  const e=await setup();delete e.env.MANAGED_SAVED_IMPORT_RECOVERY
  expect((await e.request('inspect')).status).toBe(503);e.env.MANAGED_SAVED_IMPORT_RECOVERY='1'
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
