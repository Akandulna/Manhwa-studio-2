import {exportManagedRun,adoptManagedRun,parseManagedRunBundle} from '../src/services/managedProductionAdoption.js'
import {resumeInspectedManagedProduction} from '../src/services/managedProductionResume.js'
import {inspectManagedProduction} from '../src/services/managedProductionReconciliation.js'
import type {ProductionJob} from '../src/services/productionAutomationModel.js'
import {ManagedProductionCoordinator} from '../src/services/managedProductionCoordinator.js'
import {runManagedFleet,runManagedProduction,stopManagedProduction,type ManagedProductionClaim} from '../src/services/managedProduction.js'
import {createRequire} from 'node:module'
import {createHash,randomUUID} from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {afterEach,describe,expect,it,vi} from 'vitest'
import {ManagedTaskApi,type ManagedTaskEnvironment} from '../../relay/src/managedTaskApi.js'
import type {TaskSql} from '../../relay/src/taskAuthority.js'
import {ManagedCropPilot,type PilotAuthority,type PilotInput} from '../src/services/managedCropPilot.js'
import {managedCropBinding,readManagedCrop} from '../src/services/managedCropProjection.js'
import {MANAGED_CAPABILITIES,canonicalJson,type CropSpec} from '../src/services/managedTaskProtocol.js'
import {DEFAULT_CROP_CAPABILITY,DEFAULT_CROP_PROMPT,SLICED_CROP_CAPABILITY,LEGACY_CROP_PROMPT,preserveBoundPilotSpec} from '../src/services/managedCropPilotPolicy.js'
import {artifactHash,artifactRef,MANAGED_CROP_VALIDATOR} from '../src/services/managedCropArtifact.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite')
const studio='s'.repeat(40),phone='p'.repeat(40),foreign='f'.repeat(40),opened:any[]=[],folders:string[]=[]
const originalRoot=process.env.DOWNLOAD_ROOT
afterEach(async()=>{for(const db of opened.splice(0))db.close();for(const folder of folders.splice(0))await fs.rm(folder,{recursive:true,force:true});if(originalRoot===undefined)delete process.env.DOWNLOAD_ROOT;else process.env.DOWNLOAD_ROOT=originalRoot})
async function setup(){
 const db=new DatabaseSync(':memory:');opened.push(db)
 const sql:TaskSql={exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows}}}
 const transaction=<T>(work:()=>T)=>{db.exec('BEGIN IMMEDIATE');try{const r=work();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}
 const objects=new Map<string,Uint8Array>()
 const env:ManagedTaskEnvironment={MANAGED_CROP_PAGE:'1',MANAGED_WORKSPACE_ID:'workspace',MANAGED_STUDIO_TOKEN:studio,MANAGED_DEVICE_TOKENS:JSON.stringify({phone,foreign}),MANAGED_ARTIFACTS:{async get(key){const value=objects.get(key);return value?{size:value.length,arrayBuffer:async()=>new Uint8Array(value).buffer}:null},async put(key,value){if(objects.has(key))return null;objects.set(key,new Uint8Array(value));return {key}}}}
 let now=Date.parse('2026-10-19T00:00:00Z')
 const api=()=>new ManagedTaskApi(sql,transaction,env,()=>new Date(now).toISOString())
 async function request(route:string,body?:unknown,token=studio){return api().handle(new Request('https://relay.invalid'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token},...(body?{body:JSON.stringify(body)}:{})}))}
 async function operation(body:Record<string,unknown>,token=studio){const r=await request('/managed/operation',{schema:'managed-task/1',workspaceId:'workspace',eventId:randomUUID(),...body},token);const value=await r.json();if(r.status!==200)throw new Error(value.error);return value.result}
 await operation({action:'hello',capabilities:[...MANAGED_CAPABILITIES,DEFAULT_CROP_CAPABILITY,SLICED_CROP_CAPABILITY],profileIds:['profile'],apkVersion:'1.0.999'},phone)
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-pilot-'));folders.push(root);process.env.DOWNLOAD_ROOT=root
 await fs.mkdir(path.join(root,'chapter'));const sourceFile=path.join(root,'chapter','page.png')
 const source=await sharp({create:{width:100,height:200,channels:3,background:'white'}}).png().toBuffer();await fs.writeFile(sourceFile,source)
 const spec:CropSpec={version:'crop-page/1',provider:'chatgpt',product:'chatgpt-web',model:'provider-default',settings:{mode:null,effort:null},pageRevision:'r1',promptVersion:DEFAULT_CROP_PROMPT,validatorVersion:MANAGED_CROP_VALIDATOR,dependencies:[{id:'page',revision:'r1',sha256:await artifactHash(source)}]}
 const input:PilotInput={identity:{workspaceId:'workspace',seriesId:'series',chapterId:'chapter',pageId:'page'},spec,sourceFile,folder:'chapter',filename:'page.png',destination:path.join(root,'private')}
 const authority:PilotAuthority={claimReceipt:async(taskId,claimEventId)=>{const r=await request('/managed/production-claims/'+encodeURIComponent(taskId)+'/'+encodeURIComponent(claimEventId));const raw=await r.json();if(r.status!==200)throw new Error(raw.error);return raw.result},coordinator:async()=>{const r=await request('/managed/coordinator');if(r.status!==200)throw new Error('Coordinator status unavailable');return (await r.json()).result},ready:async()=>{const r=await request('/managed/readiness');expect(r.status).toBe(200);const value=await r.json();if(!value.result.artifactStorageConfigured)throw new Error('Artifact storage unavailable')},operation,timeline:async id=>{const r=await request('/managed/tasks/'+encodeURIComponent(id));expect(r.status).toBe(200);return r.json()},artifacts:{load:async id=>{const r=await request('/managed/artifacts/'+id);const raw=await r.json();if(r.status!==200)throw new Error(raw.error);return {record:raw.record,task:raw.task,attempt:raw.attempt,bytes:new TextEncoder().encode(raw.document)}},publish:async op=>({schema:'managed-task/1',result:await operation(op as unknown as Record<string,unknown>)})}}
 const pilot=new ManagedCropPilot(authority);await pilot.enroll('phone','profile')
 const fence=(a:any)=>({taskId:a.task.id,attemptId:a.attempt.id,generation:a.attempt.generation,fingerprint:a.task.fingerprint})
 async function checkpoint(a:any,phase:string,commandId=a.attempt.activeCommandId,worker=phone){return operation({action:'checkpoint',...fence(a),commandId,phase,checkpointRef:phase==='result_saved'?'checkpoint/output':null},worker)}
 async function saved(a:any,late=false,source=input,worker=phone){
  for(const phase of ['accepted','started','submission_intent',late?'submitted':'result_saved'])await checkpoint(a,phase,undefined,worker)
  if(late) {
   now+=300001
   const op={action:'recover_saved',eventId:'recovery-output',...fence(a),commandId:a.attempt.activeCommandId,checkpointRef:'checkpoint/output'}
   expect((await request('/managed/operation',{schema:'managed-task/1',workspaceId:'workspace',...op})).status).toBe(403)
   const recovered=await operation(op,worker)
   expect(recovered.recoveryOnly).toBe(true);expect(recovered.attempt.leaseExpiresAt).toBe(a.attempt.leaseExpiresAt)
  }
  const artifactId='crop_'+createHash('sha256').update(canonicalJson([a.task.id,a.attempt.id,'checkpoint/output'])).digest('hex')
  const document=JSON.stringify({schema:'managed-crop-page/1',...fence(a),checkpointRef:'checkpoint/output',pageRevision:'r1',validatorVersion:MANAGED_CROP_VALIDATOR,pointers:JSON.stringify({format:'four-point-crop',version:'1.0',coordinateSystem:'normalized',image:{filename:source.filename,width:100,height:200},crops:[]}),metadata:'{"crops":[]}'})
  const r=await request('/managed/artifacts',{operation:{schema:'managed-task/1',workspaceId:'workspace',eventId:'stage_'+a.task.id.slice(12),action:'stage',...fence(a),artifactId,ref:artifactRef(a.task,a.attempt.id,artifactId),contentHash:await artifactHash(new TextEncoder().encode(document))},document},worker)
  expect(r.status).toBe(200)
 }
 return {db,env,input,request,operation,authority,pilot,checkpoint,saved,advance:(ms=300001)=>now+=ms}
}
describe('wired managed single-page pilot',()=>{
 it('preserves exact historical prompt bindings without applying them to changed pages or owners',async()=>{
  const e=await setup(),legacy={...e.input,spec:{...e.input.spec,promptVersion:LEGACY_CROP_PROMPT}}
  const prior=await e.pilot.start(legacy,'phone','profile')
  expect(preserveBoundPilotSpec(e.input.identity,e.input.spec,prior.task)).toEqual(legacy.spec)
  expect(preserveBoundPilotSpec({...e.input.identity,chapterId:'different'},e.input.spec,prior.task)).toEqual(e.input.spec)
  expect(preserveBoundPilotSpec(e.input.identity,{...e.input.spec,pageRevision:'changed'},prior.task).promptVersion).toBe(DEFAULT_CROP_PROMPT)
  expect(preserveBoundPilotSpec(e.input.identity,e.input.spec,null).promptVersion).toBe(DEFAULT_CROP_PROMPT)
 })
 it('fences sliced assignments from old phones before any start command or reservation is created',async()=>{
  const e=await setup()
  await e.operation({action:'hello',capabilities:[...MANAGED_CAPABILITIES,DEFAULT_CROP_CAPABILITY],profileIds:['profile'],apkVersion:'1.0.153'},phone)
  await e.pilot.enroll('phone','profile')
  await expect(e.pilot.start(e.input,'phone','profile')).rejects.toThrow('Update the phone for verified ChatGPT slices')
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(0)
  expect(e.db.prepare('SELECT * FROM managed_commands').all()).toHaveLength(0)
  expect(e.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(0)
  await e.operation({action:'hello',capabilities:[...MANAGED_CAPABILITIES,DEFAULT_CROP_CAPABILITY,SLICED_CROP_CAPABILITY],profileIds:['profile'],apkVersion:'1.0.154'},phone)
  await e.pilot.enroll('phone','profile')
  const assigned=await e.pilot.start(e.input,'phone','profile');expect(assigned.task.spec.promptVersion).toBe('managed-chatgpt-sliced-crop/1')
  expect(assigned.attempt?.phase).toBe('assigned')
  const readiness=await(await e.request('/managed/readiness')).json();expect(readiness.result.capabilities).toContain(SLICED_CROP_CAPABILITY)
 })
 it('recovers expired saved bytes through authenticated upload and explicit trusted import without a lease reset',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile');await e.saved(a,true)
  await expect(e.pilot.import(e.input,a.task.id)).rejects.toThrow('current ownership')
  const r=await e.pilot.import(e.input,a.task.id,true)
  expect(r.task.state).toBe('verified_complete')
  expect((await e.authority.timeline(a.task.id)).attempt?.leaseExpiresAt).toBe(a.attempt!.leaseExpiresAt)
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(1)
  expect(await readManagedCrop('chapter','page.png')).toMatchObject({taskId:a.task.id})
  expect((await e.pilot.import(e.input,a.task.id,true)).task.canonical).toBe(r.task.canonical)
 })
 it('rejects recovered publication after source mutation or owner cancellation during validation',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile');await e.saved(a,true)
  const original=await fs.readFile(e.input.sourceFile);await fs.writeFile(e.input.sourceFile,'changed')
  await expect(e.pilot.import(e.input,a.task.id,true)).rejects.toThrow()
  await fs.writeFile(e.input.sourceFile,original)
  const load=e.authority.artifacts.load
  e.authority.artifacts.load=async id=>{const r=await load(id);await e.pilot.stop(a.task.id,true);return r}
  await expect(e.pilot.import(e.input,a.task.id,true)).rejects.toThrow('fence')
  expect((await e.authority.timeline(a.task.id)).task.canonical).toBeNull()
 })

 it('refuses dispatch before claiming if artifact storage is not configured',async()=>{
  const e=await setup();delete e.env.MANAGED_ARTIFACTS
  await expect(e.pilot.start(e.input,'phone','profile')).rejects.toThrow('storage')
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(0)
  expect((await e.request('/managed/readiness',undefined,phone)).status).toBe(403)
 })
 it('binds before claim and recovers lost claim ACK without a second attempt',async()=>{
  const e=await setup(),original=e.authority.operation;let lost=true
  e.authority.operation=async op=>{if(op.action==='claim')expect((await managedCropBinding('chapter','page.png'))?.task.id).toBe(op.taskId);const result=await original(op);if(op.action==='claim'&&lost){lost=false;throw new Error('lost claim ACK')}return result}
  await expect(e.pilot.start(e.input,'phone','profile')).rejects.toThrow('lost claim ACK')
  const resumed=await new ManagedCropPilot(e.authority).start(e.input,'phone','profile')
  expect(resumed.task.state).toBe('assigned');expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(1)
  expect(resumed.task.spec.model).toBe('provider-default');expect(resumed.task.spec.settings).toEqual({mode:null,effort:null})
 })
 it('refuses selected models and changed sources before dispatch',async()=>{
  const e=await setup()
  await expect(e.pilot.start({...e.input,spec:{...e.input.spec,model:'GPT-6.1 Sol'}},'phone','profile')).rejects.toThrow('default')
  await fs.writeFile(e.input.sourceFile,'changed');await expect(e.pilot.start(e.input,'phone','profile')).rejects.toThrow()
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(0)
 })
 it('rejects unsupported specifications at the relay even when Studio bypasses the pilot service',async()=>{
  const e=await setup()
  const task=await e.operation({action:'plan',identity:e.input.identity,spec:{...e.input.spec,model:'selected-model'}})
  await expect(e.operation({action:'claim',taskId:task.id,deviceId:'phone',profileId:'profile',accountId:null})).rejects.toThrow('default')
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(0)
 })
 it('imports verified bytes and reuses publication after lost ACK',async()=>{
  const e=await setup(),assigned=await e.pilot.start(e.input,'phone','profile');await e.saved(assigned)
  const publish=e.authority.artifacts.publish;let lost=true
  e.authority.artifacts.publish=async op=>{const r=await publish(op);if(lost){lost=false;throw new Error('lost publish ACK')}return r}
  await expect(e.pilot.import(e.input,assigned.task.id)).rejects.toThrow('lost publish ACK')
  const result=await new ManagedCropPilot(e.authority).import(e.input,assigned.task.id)
  expect(result.task.state).toBe('verified_complete');expect(await readManagedCrop('chapter','page.png')).toMatchObject({taskId:assigned.task.id})
  expect((await e.pilot.start(e.input,'phone','profile')).task.state).toBe('verified_complete')
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(1)
 })
 it('keeps unknown submissions reserved after local stop and refuses unenrollment',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile')
  for(const phase of ['accepted','started','submission_intent'])await e.checkpoint(a,phase)
  const stop=await e.pilot.stop(a.task.id,true) as any;await e.checkpoint(a,'stop_confirmed',stop.command.id)
  await expect(e.pilot.unpair('phone')).rejects.toThrow('reconcile')
  expect(e.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(4)
 })
 it('revokes peer evidence on safe unpairing and fences worker reads by device',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile')
  expect((await e.request('/managed/worker/'+encodeURIComponent(a.task.id),undefined,phone)).status).toBe(200)
  expect((await e.request('/managed/worker/'+encodeURIComponent(a.task.id),undefined,foreign)).status).toBe(409)
  const stop=await e.pilot.stop(a.task.id,true) as any;await e.checkpoint(a,'stop_confirmed',stop.command.id)
  await e.pilot.unpair('phone');await expect(e.pilot.enroll('phone','profile')).rejects.toThrow('fresh')
  const status=await (await e.request('/managed/enrollment',undefined,phone)).json()
  expect(status.result).toEqual({enrolled:false,peerRegistered:false,reserved:false})
 })
})

describe('managed ProductionRunner page coordination',()=>{
 it('records a bound task before claim, imports original saved bytes and reuses verified work on resume',async()=>{
  const e=await setup(),reports:{message:string;taskId:string|null}[]=[]
  const controller=new AbortController();let saves=0
  const deps={authority:e.authority,inputs:async()=>[e.input],report:async(message:string,taskId:string|null)=>{
   reports.push({message,taskId})
   if(message.startsWith('Assigning')) {
    expect((await managedCropBinding(e.input.folder,e.input.filename))?.task.id).toBe(taskId)
    expect((await e.authority.timeline(taskId!)).attempt).toBeNull()
   }
  },wait:async()=>{saves++;const current=await e.request('/managed/inbox',undefined,phone);const a=(await current.json()).assignments[0];await e.saved(a)}}
  await runManagedProduction('phone','profile',controller.signal,deps)
  expect(saves).toBe(1);expect(reports.some(report=>report.message.startsWith('Validating original'))).toBe(true)
  expect(e.db.prepare('SELECT id FROM managed_attempts').all()).toHaveLength(1)
  deps.report=async()=>{};await runManagedProduction('phone','profile',controller.signal,deps)
  expect(saves).toBe(1);expect(e.db.prepare('SELECT id FROM managed_attempts').all()).toHaveLength(1)
 })
 it('recovers lost claim acknowledgment using the same assignment after a coordinator restart',async()=>{
  const e=await setup(),controller=new AbortController(),original=e.authority.operation;let lost=true
  e.authority.operation=async op=>{const result=await original(op);if(op.action==='claim'&&lost){lost=false;throw new Error('lost claim acknowledgment')}return result}
  const claims:ManagedProductionClaim[]=[]
  const deps={authority:e.authority,claims,inputs:async()=>[e.input],report:async(_m:string,_t:string|null,claim?:ManagedProductionClaim)=>{if(claim&&!claims.some(c=>c.taskId===claim.taskId))claims.push(structuredClone(claim))},wait:async()=>{const raw=await(await e.request('/managed/inbox',undefined,phone)).json();await e.saved(raw.assignments[0])}}
  await expect(runManagedProduction('phone','profile',controller.signal,deps)).rejects.toThrow('lost claim')
  await runManagedProduction('phone','profile',controller.signal,deps)
  expect(e.db.prepare('SELECT id FROM managed_attempts').all()).toHaveLength(1)
 })
 it('does not claim if cancellation occurs while persisting assignment intent',async()=>{
  const e=await setup(),controller=new AbortController()
  await expect(runManagedProduction('phone','profile',controller.signal,{authority:e.authority,inputs:async()=>[e.input],report:async(message)=>{if(message.startsWith('Assigning'))controller.abort()},wait:async()=>{}})).rejects.toThrow()
  expect(e.db.prepare('SELECT id FROM managed_attempts').all()).toHaveLength(0)
 })
 it('preflights every retained cancellation and stops only its own nonterminal task',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile',undefined,'production-claim')
  const claim={taskId:a.task.id,claimEventId:'production-claim',deviceId:'phone',profileId:'profile'}
  await stopManagedProduction(e.authority,[claim,claim],[a.task.id])
  const deps={authority:e.authority,inputs:async()=>[e.input],report:async()=>{},wait:async()=>{throw new Error('must not wait')}}
  await expect(runManagedProduction('phone','profile',new AbortController().signal,deps)).rejects.toThrow('Reconcile')
  expect(e.db.prepare('SELECT id FROM managed_attempts').all()).toHaveLength(1)
 })
 it('cancels a lost claim reply using its persisted receipt, without adopting the timeline owner',async()=>{
  const e=await setup(),claims:ManagedProductionClaim[]=[],original=e.authority.operation
  e.authority.operation=async op=>{const result=await original(op);if(op.action==='claim')throw new Error('lost claim');return result}
  await expect(runManagedProduction('phone','profile',new AbortController().signal,{authority:e.authority,inputs:async()=>[e.input],report:async(_m,_t,claim)=>{if(claim)claims.push(structuredClone(claim))},wait:async()=>{}})).rejects.toThrow('lost claim')
  expect(claims).toHaveLength(1)
  await stopManagedProduction(e.authority,claims)
  expect((await e.authority.timeline(claims[0].taskId)).task.state).toBe('cancelled')
  expect(e.db.prepare('SELECT id FROM managed_attempts').all()).toHaveLength(1)
 })
 it('refuses to adopt another job on the same phone or cancel legacy task IDs',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile'),before=await e.authority.timeline(a.task.id)
  await expect(runManagedProduction('phone','profile',new AbortController().signal,{authority:e.authority,inputs:async()=>[e.input],report:async()=>{},wait:async()=>{throw new Error('must not wait')}})).rejects.toThrow('already owned')
  await expect(stopManagedProduction(e.authority,[],[a.task.id])).rejects.toThrow('no durable claim')
  expect(await e.authority.timeline(a.task.id)).toEqual(before)
 })
 it('persists the receipt before dispatch and fences a delayed in-flight claim after Stop',async()=>{
  const e=await setup(),original=e.authority.operation,claims:ManagedProductionClaim[]=[]
  e.authority.operation=async op=>{if(op.action==='claim'){expect(claims).toHaveLength(1);await stopManagedProduction(e.authority,claims)}return original(op)}
  await expect(runManagedProduction('phone','profile',new AbortController().signal,{authority:e.authority,inputs:async()=>[e.input],report:async(_m,_t,claim)=>{if(claim)claims.push(structuredClone(claim))},wait:async()=>{}})).rejects.toThrow('stopped before dispatch')
  expect(e.db.prepare('SELECT id FROM managed_attempts').all()).toHaveLength(0)
  expect((await e.authority.timeline(claims[0].taskId)).task.state).toBe('queued')
 })
 it('stops watching when ownership transfers and refuses to import the new owner result',async()=>{
  const e=await setup(),claims:ManagedProductionClaim[]=[]
  for(const token of [phone,foreign])await e.operation({action:'hello',capabilities:[...MANAGED_CAPABILITIES,DEFAULT_CROP_CAPABILITY,SLICED_CROP_CAPABILITY,'worker-reconnect/1'],profileIds:['profile'],apkVersion:'1.0.999'},token)
  await e.pilot.enroll('phone','profile');await e.pilot.enroll('foreign','profile')
  let transferred:any
  await expect(runManagedProduction('phone','profile',new AbortController().signal,{authority:e.authority,inputs:async()=>[e.input],report:async(_m,_t,claim)=>{if(claim)claims.push(claim)},wait:async()=>{
   const a=await e.authority.timeline(claims[0].taskId),stop=await e.pilot.stop(a.task.id,false) as any
   await e.checkpoint(a,'stop_confirmed',stop.command.id)
   transferred=await e.pilot.transfer(e.input,{taskId:a.task.id,attemptId:a.attempt!.id,generation:a.task.generation,fingerprint:a.task.fingerprint,stopCommandId:stop.command.id},'foreign','profile')
  }})).rejects.toThrow('ownership changed')
  const before=await e.authority.timeline(transferred.task.id)
  await expect(stopManagedProduction(e.authority,claims)).rejects.toThrow('could not be stopped')
  expect(await e.authority.timeline(transferred.task.id)).toEqual(before)
  await expect(e.pilot.import(e.input,transferred.task.id,false,{...transferred.attempt,id:'old-attempt'})).rejects.toThrow()
  expect(await readManagedCrop(e.input.folder,e.input.filename)).toBeNull()
 })
 it('waits for artifact staging instead of publishing a checkpoint acknowledgment',async()=>{
  const e=await setup(),original=e.authority.timeline;let waits=0
  e.authority.timeline=async id=>{const current=await original(id);if(waits===1&&current.attempt?.phase==='result_saved')return {...current,artifactReady:false};return current}
  await runManagedProduction('phone','profile',new AbortController().signal,{authority:e.authority,inputs:async()=>[e.input],report:async()=>{},wait:async()=>{
   waits++;if(waits===1){const raw=await(await e.request('/managed/inbox',undefined,phone)).json();await e.saved(raw.assignments[0])}
  }})
  expect(waits).toBe(2)
 })
})

describe('explicit real-source revision rebinding',()=>{
 async function changed(e:Awaited<ReturnType<typeof setup>>) {
  const source=await sharp({create:{width:100,height:200,channels:3,background:'black'}}).png().toBuffer()
  await fs.writeFile(e.input.sourceFile,source)
  return {...e.input,spec:{...e.input.spec,pageRevision:'r2',dependencies:[{...e.input.spec.dependencies[0],revision:'r2',sha256:await artifactHash(source)}]}}
 }
 it('retains old publication and immutable lineage, resets review and does not dispatch the new revision',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile');await e.saved(a);await e.pilot.import(e.input,a.task.id)
  const next=await changed(e),bound=await e.pilot.rebind(next,a.task.id)
  expect(bound.task.id).not.toBe(a.task.id);expect(bound.task.state).toBe('queued');expect(bound.attempt).toBeNull()
  expect((await e.authority.timeline(a.task.id)).task.state).toBe('verified_complete')
  expect((await managedCropBinding(next.folder,next.filename))?.task.id).toBe(bound.task.id)
  expect(await readManagedCrop(next.folder,next.filename)).toBeNull()
  const history=await fs.readdir(path.join(process.env.DOWNLOAD_ROOT!,next.folder,'.managed-crops/history'));expect(history).toHaveLength(1)
  expect((await new ManagedCropPilot(e.authority).rebind(next,a.task.id)).task.id).toBe(bound.task.id)
 })
 it('rejects unchanged cancelled input and blocks changed input while submission remains unresolved',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile')
  await e.checkpoint(a,'accepted');await e.checkpoint(a,'started');await e.checkpoint(a,'submission_intent')
  const stop=await e.pilot.stop(a.task.id,true) as any;await e.checkpoint(a,'stop_confirmed',stop.command.id)
  await expect(e.pilot.rebind(e.input,a.task.id)).rejects.toThrow('changed source')
  const next=await changed(e)
  await expect(e.pilot.rebind(next,a.task.id)).rejects.toThrow('reconcile')
  await expect(e.operation({action:'plan',identity:next.identity,spec:next.spec})).rejects.toThrow('Reconcile')
  expect((await managedCropBinding(e.input.folder,e.input.filename))?.task.id).toBe(a.task.id)
 })
 it('allows a changed source only after a real confirmed-unsent cancellation receipt',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile')
  await e.checkpoint(a,'accepted')
  const stop=await e.pilot.stop(a.task.id,true) as any;await e.checkpoint(a,'stop_confirmed',stop.command.id)
  const next=await changed(e);expect((await e.pilot.rebind(next,a.task.id)).task.state).toBe('queued')
  expect(e.db.prepare('SELECT id FROM managed_attempts').all()).toHaveLength(1)
 })
 it('rejects stale binding expectations and symlinked lineage without swapping the binding',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile');await e.saved(a);await e.pilot.import(e.input,a.task.id)
  const next=await changed(e)
  await expect(e.pilot.rebind(next,'task:sha256:'+'f'.repeat(64))).rejects.toThrow('prior')
  await fs.symlink(path.dirname(e.input.sourceFile),path.join(path.dirname(e.input.sourceFile),'.managed-crops/history'))
  await expect(e.pilot.rebind(next,a.task.id)).rejects.toThrow('history')
  expect((await managedCropBinding(e.input.folder,e.input.filename))?.task.id).toBe(a.task.id)
 })
})

describe('Phase 4 authenticated read-only reconnect foundation',()=>{
 const local=(a:any,changes:Record<string,unknown>={})=>({taskId:a.task.id,attemptId:a.attempt.id,generation:a.attempt.generation,fingerprint:a.task.fingerprint,phase:a.attempt.phase,submission:a.attempt.submission,checkpointRef:a.attempt.checkpointRef,...changes})
 const packet=(attempts:any[])=>({schema:'managed-reconnect/1',workspaceId:'workspace',attempts})
 it('keeps device liveness separate from expired task progress and never grants action permission',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile')
  const initial=await(await e.request('/managed/reconnect',packet([local(a)]),phone)).json()
  expect(initial.observations[0]).toMatchObject({status:'current_unsent',nextAction:'renew_exact_assignment_before_action'})
  e.advance()
  await e.operation({action:'hello',capabilities:[...MANAGED_CAPABILITIES,DEFAULT_CROP_CAPABILITY,SLICED_CROP_CAPABILITY],profileIds:['profile'],apkVersion:'1.0.999'},phone)
  const after=await(await e.request('/managed/reconnect',packet([local(a)]),phone)).json()
  expect(after.observations[0]).toMatchObject({status:'uncertain',leaseExpired:true,nextAction:'retain_hold_no_resubmission'})
  expect((await e.authority.timeline(a.task.id)).attempt!.leaseExpiresAt).toBe(a.attempt!.leaseExpiresAt)
 })
 it('keeps uncertain phone 1 held while phone 2 owns a distinct page, including reconnect replay',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile')
  for(const phase of ['accepted','started','submission_intent'])await e.checkpoint(a,phase)
  await e.operation({action:'hello',capabilities:[...MANAGED_CAPABILITIES,DEFAULT_CROP_CAPABILITY,SLICED_CROP_CAPABILITY],profileIds:['other-profile'],apkVersion:'1.0.999'},foreign)
  await e.pilot.enroll('foreign','other-profile')
  const spec={...e.input.spec,dependencies:[{...e.input.spec.dependencies[0],id:'other-page'}]}
  const b=await e.operation({action:'plan',identity:{...e.input.identity,pageId:'other-page'},spec})
  await e.operation({action:'claim',taskId:b.id,deviceId:'foreign',profileId:'other-profile',accountId:null})
  const before=e.db.prepare('SELECT total_changes() AS n').get().n
  const request=packet([local(a,{phase:'submission_intent',submission:'unknown'})])
  const one=await(await e.request('/managed/reconnect',request,phone)).json(),two=await(await e.request('/managed/reconnect',request,phone)).json()
  expect(two).toEqual(one);expect(one.observations[0].status).toBe('uncertain')
  expect(one.assignments.map((value:any)=>value.task.id)).toEqual([a.task.id])
  expect(e.db.prepare('SELECT total_changes() AS n').get().n).toBe(before)
  expect(e.db.prepare('SELECT resource FROM managed_reservations').all()).toHaveLength(8)
 })
 it('preserves stronger local submission uncertainty and isolates foreign attempts',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile')
  const held=await(await e.request('/managed/reconnect',packet([local(a,{submission:'submitted'})]),phone)).json()
  expect(held.observations[0].status).toBe('uncertain')
  const hidden=await(await e.request('/managed/reconnect',packet([local(a)]),foreign)).json()
  expect(hidden.observations[0]).toMatchObject({status:'unknown',nextAction:'retain_hold'});expect(hidden.assignments).toEqual([])
  const obsolete=await(await e.request('/managed/reconnect',packet([local(a,{generation:2})]),phone)).json()
  expect(obsolete.observations[0]).toMatchObject({status:'obsolete',nextAction:'skip_provider_work_keep_evidence'})
 })
 it('reports saved, completed, stop-pending and cancelled outcomes without changing history',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile');await e.saved(a)
  expect((await(await e.request('/managed/reconnect',packet([local(a,{submission:'saved',phase:'result_saved',checkpointRef:'checkpoint/output'})]),phone)).json()).observations[0].status).toBe('saved')
  await e.pilot.import(e.input,a.task.id)
  expect((await(await e.request('/managed/reconnect',packet([local(a)]),phone)).json()).observations[0].status).toBe('verified_complete')
  const other=await setup(),b=await other.pilot.start(other.input,'phone','profile');await other.checkpoint(b,'accepted')
  const stop=await other.pilot.stop(b.task.id,true) as any
  expect((await(await other.request('/managed/reconnect',packet([local(b)]),phone)).json()).observations[0].status).toBe('stop_pending')
  await other.checkpoint(b,'stop_confirmed',stop.command.id)
  expect((await(await other.request('/managed/reconnect',packet([local(b)]),phone)).json()).observations[0].status).toBe('cancelled')
 })
 it('rejects duplicates, oversized inventories, workspace mismatches and Studio impersonation',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile'),item=local(a)
  for(const body of [packet([item,item]),packet(Array.from({length:9},()=>item)),{...packet([item]),workspaceId:'other'},packet([{...item,providerReply:'private'}])])expect((await e.request('/managed/reconnect',body,phone)).status).toBe(409)
  expect((await e.request('/managed/reconnect',packet([item]))).status).toBe(403)
 })
})

describe('current-page transfer admission',()=>{
 it('checks the exact current source before any authority mutation',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile')
  const fence={taskId:a.task.id,attemptId:a.attempt!.id,generation:a.task.generation,fingerprint:a.task.fingerprint,stopCommandId:'stopped'}
  const before=await e.authority.timeline(a.task.id)
  await fs.writeFile(e.input.sourceFile,'changed source')
  await expect(e.pilot.transfer(e.input,fence,'foreign','profile')).rejects.toThrow()
  expect(await e.authority.timeline(a.task.id)).toEqual(before)
  await expect(e.pilot.transfer(e.input,{...fence,taskId:'task:sha256:'+'a'.repeat(64)},'foreign','profile')).rejects.toThrow('current page binding')
 })
 it('transfers the same bound task through authenticated transport after a real unsent stop',async()=>{
  const e=await setup()
  for(const token of [phone,foreign])await e.operation({action:'hello',capabilities:[...MANAGED_CAPABILITIES,DEFAULT_CROP_CAPABILITY,SLICED_CROP_CAPABILITY,'worker-reconnect/1'],profileIds:['profile'],apkVersion:'1.0.999'},token)
  await e.pilot.enroll('phone','profile');await e.pilot.enroll('foreign','profile')
  const a=await e.pilot.start(e.input,'phone','profile')
  await e.checkpoint(a,'accepted');await e.checkpoint(a,'started')
  await e.pilot.stop(a.task.id,false)
  const stopped=await e.authority.timeline(a.task.id)
  await e.operation({action:'checkpoint',taskId:a.task.id,attemptId:a.attempt!.id,generation:a.task.generation,fingerprint:a.task.fingerprint,commandId:stopped.attempt!.activeCommandId,phase:'stop_confirmed',checkpointRef:null},phone)
  const next=await e.pilot.transfer(e.input,{taskId:a.task.id,attemptId:a.attempt!.id,generation:a.task.generation,fingerprint:a.task.fingerprint,stopCommandId:stopped.attempt!.activeCommandId},'foreign','profile')
  expect(next.task.id).toBe(a.task.id);expect(next.task.generation).toBe(2)
  expect(next.attempt!.deviceId).toBe('foreign')
  expect((await managedCropBinding(e.input.folder,e.input.filename))!.task.id).toBe(a.task.id)
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(2)
 })
})


describe('cross-database production coordinator through authenticated real SQLite authority',()=>{
 it('allows one coordinator, blocks a second independent instance, and leaves status reads pure',async()=>{
  const e=await setup(),a=new ManagedProductionCoordinator(),b=new ManagedProductionCoordinator()
  await a.withLease(e.authority,async()=>{
   const before=e.db.prepare('SELECT total_changes() AS n').get().n
   const status=await e.authority.coordinator!();expect(status?.state).toBe('held')
   expect(e.db.prepare('SELECT total_changes() AS n').get().n).toBe(before)
   await expect(b.withLease(e.authority,async()=>{throw new Error('must not enter')})).rejects.toThrow('Another coordinator')
  })
  expect((await e.authority.coordinator!())?.state).toBe('released')
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(0)
 })
 it('runs, imports, publishes and resumes the original result under fenced coordinator ownership',async()=>{
  const e=await setup(),manager=new ManagedProductionCoordinator(),claims:ManagedProductionClaim[]=[]
  await manager.withLease(e.authority,authority=>runManagedProduction('phone','profile',new AbortController().signal,{authority,inputs:async()=>[e.input],claims,report:async(_m,_t,claim)=>{if(claim)claims.push(claim)},wait:async()=>{const raw=await(await e.request('/managed/inbox',undefined,phone)).json();await e.saved(raw.assignments[0])}}))
  expect((await e.authority.timeline(claims[0].taskId)).task.state).toBe('verified_complete')
  await new ManagedProductionCoordinator().withLease(e.authority,authority=>runManagedProduction('phone','profile',new AbortController().signal,{authority,inputs:async()=>[e.input],claims,report:async()=>{},wait:async()=>{throw new Error('no new provider work')}}))
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(1)
  expect((await e.authority.coordinator!())?.coordinatorGeneration).toBe(2)
 })
 it('recovers a lost acquire reply on an explicit retry without taking a second generation',async()=>{
  const e=await setup(),manager=new ManagedProductionCoordinator(),original=e.authority.operation;let lost=true
  e.authority.operation=async op=>{const result=await original(op);if(op.action==='coordinator_acquire'&&lost){lost=false;throw new Error('lost acquire reply')}return result}
  await expect(manager.withLease(e.authority,async()=>{})).rejects.toThrow('lost acquire')
  await manager.withLease(e.authority,async()=>{})
  expect((await e.authority.coordinator!())?.coordinatorGeneration).toBe(1)
 })
 it('renews during foreground progress but never extends a phone assignment lease',async()=>{
  const e=await setup();let clock=0;const manager=new ManagedProductionCoordinator(()=>clock)
  await manager.withLease(e.authority,async authority=>{
   const a=await new ManagedCropPilot(authority).start(e.input,'phone','profile',undefined,'coordinated-claim'),original=a.attempt!.leaseExpiresAt
   e.advance(21_000);clock+=21_000
   await authority.timeline(a.task.id)
   expect((await e.authority.coordinator!())!.leaseExpiresAt).toBe('2026-10-19T00:01:21.000Z')
   expect((await e.authority.timeline(a.task.id)).attempt!.leaseExpiresAt).toBe(original)
  })
 })
 it('fences delayed claims and replayed stops after takeover while retaining the original attempt',async()=>{
  const e=await setup(),manager=new ManagedProductionCoordinator()
  await expect(manager.withLease(e.authority,async authority=>{
   const a=await new ManagedCropPilot(authority).start(e.input,'phone','profile',undefined,'first-production-claim')
   const first=(await e.authority.coordinator!())!,fence={coordinatorId:first.coordinatorId,coordinatorGeneration:first.coordinatorGeneration}
   const stop={action:'stop_production_claim',eventId:'original-fenced-stop',taskId:a.task.id,claimEventId:'first-production-claim',...fence}
   await e.operation(stop)
   e.advance(60_001)
   await e.operation({action:'coordinator_acquire',coordinatorId:'separate-studio',expectedGeneration:1})
   const before=await e.authority.timeline(a.task.id)
   await expect(e.operation(stop)).rejects.toThrow('Stale')
   await expect(e.operation({action:'claim_production',eventId:'first-production-claim',taskId:a.task.id,deviceId:'phone',profileId:'profile',accountId:null,...fence})).rejects.toThrow('Stale')
   await expect(authority.operation({action:'stop_claim',taskId:a.task.id,claimEventId:'first-production-claim'})).rejects.toThrow('Stale')
   expect(await e.authority.timeline(a.task.id)).toEqual(before)
  })).rejects.toThrow('release is unconfirmed')
  expect((await e.authority.coordinator!())?.coordinatorId).toBe('separate-studio')
 })
 it('keeps exact lost claim receipts resumable by the next coordinator without a new attempt',async()=>{
  const e=await setup(),original=e.authority.operation,claims:ManagedProductionClaim[]=[];let lost=true
  e.authority.operation=async op=>{const result=await original(op);if(op.action==='claim_production'&&lost){lost=false;throw new Error('lost original claim')}return result}
  const run=(manager:ManagedProductionCoordinator)=>manager.withLease(e.authority,authority=>runManagedProduction('phone','profile',new AbortController().signal,{authority,claims,inputs:async()=>[e.input],report:async(_m,_t,claim)=>{if(claim&&!claims.length)claims.push(claim)},wait:async()=>{const raw=await(await e.request('/managed/inbox',undefined,phone)).json();await e.saved(raw.assignments[0])}}))
  await expect(run(new ManagedProductionCoordinator())).rejects.toThrow('lost original claim')
  await run(new ManagedProductionCoordinator())
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(1)
  expect((await e.authority.timeline(claims[0].taskId)).task.state).toBe('verified_complete')
 })
 it('blocks legacy stop/claim/publication bypass and production transfer even without a local job record',async()=>{
  const e=await setup(),manager=new ManagedProductionCoordinator();let taskId=''
  await manager.withLease(e.authority,async authority=>{
   const a=await new ManagedCropPilot(authority).start(e.input,'phone','profile',undefined,'owned-production');taskId=a.task.id
   await expect(e.pilot.stop(taskId,true)).rejects.toThrow('current production coordinator')
   await expect(e.operation({action:'claim',taskId,deviceId:'phone',profileId:'profile',accountId:null})).rejects.toThrow('current production coordinator')
   const stop=await new ManagedCropPilot(authority).stop(taskId,false) as any
   await e.checkpoint(a,'stop_confirmed',stop.command.id)
  })
  await expect(e.pilot.stop(taskId,true)).rejects.toThrow('current production coordinator')
  const current=await e.authority.timeline(taskId)
  await expect(e.pilot.transfer(e.input,{taskId,attemptId:current.attempt!.id,generation:1,fingerprint:current.task.fingerprint,stopCommandId:current.attempt!.activeCommandId},'foreign','profile')).rejects.toThrow('current production coordinator')
 })
 it('checks coordinator ownership again after asynchronous artifact validation',async()=>{
  const e=await setup(),manager=new ManagedProductionCoordinator()
  await expect(manager.withLease(e.authority,async authority=>{
   const a=await new ManagedCropPilot(authority).start(e.input,'phone','profile',undefined,'publishing-claim');await e.saved(a)
   const bucket=e.env.MANAGED_ARTIFACTS!,get=bucket.get.bind(bucket);let reads=0
   bucket.get=async key=>{const result=await get(key);if(++reads===2){e.advance(60_001);await e.operation({action:'coordinator_acquire',coordinatorId:'new-studio',expectedGeneration:1})}return result}
   await expect(new ManagedCropPilot(authority).import(e.input,a.task.id)).rejects.toThrow('Stale')
   expect((await e.authority.timeline(a.task.id)).task.canonical).toBeNull()
   expect(e.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(4)
  })).rejects.toThrow('release is unconfirmed')
 })
 it('blocks uncoordinated publication after release and still imports original saved bytes under a fresh coordinator',async()=>{
  const e=await setup(),manager=new ManagedProductionCoordinator();let taskId=''
  await manager.withLease(e.authority,async authority=>{
   const a=await new ManagedCropPilot(authority).start(e.input,'phone','profile',undefined,'saved-production');taskId=a.task.id;await e.saved(a)
   await expect(e.pilot.import(e.input,taskId)).rejects.toThrow('current production coordinator')
  })
  await expect(e.pilot.import(e.input,taskId)).rejects.toThrow('current production coordinator')
  await new ManagedProductionCoordinator().withLease(e.authority,authority=>new ManagedCropPilot(authority).import(e.input,taskId))
  expect((await e.authority.timeline(taskId)).task.state).toBe('verified_complete')
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(1)
 })
 it('shares one coordinator across concurrent local operations and releases only after the last finishes',async()=>{
  const e=await setup(),manager=new ManagedProductionCoordinator();let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  const first=manager.withLease(e.authority,async()=>{await gate})
  await vi.waitFor(async()=>expect(await e.authority.coordinator!()).not.toBeNull())
  await manager.withLease(e.authority,async()=>{})
  expect((await e.authority.coordinator!())?.state).toBe('held')
  release();await first
  expect((await e.authority.coordinator!())?.state).toBe('released')
  expect((await e.authority.coordinator!())?.coordinatorGeneration).toBe(1)
 })
})


describe('explicit original production run inspection',()=>{
 const job=(taskId:string,event='production-claim'):ProductionJob=>({id:'saved-job',revision:7,seriesId:'series',status:'interrupted',step:'clipping',message:'retained',createdAt:'fixture',updatedAt:'fixture',config:{managedCrop:true,device:'phone',profileId:'profile',clipper:{ai:'chatgpt',flow:'classic',tabs:1,chatGpt:{mode:null,model:null,effort:null}}},command:{kind:'clipper',sentAt:'fixture',managedTaskIds:[taskId],managedClaims:[{taskId,claimEventId:event,deviceId:'phone',profileId:'profile'}]}})
 const inspect=(e:any,j:ProductionJob)=>inspectManagedProduction(j,e.authority,[e.input],Date.parse('2026-10-19T00:00:00Z'))
 it('reads the original current receipt without any SQL, source or binding mutation and has a stable digest',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile',undefined,'production-claim'),saved=job(a.task.id)
  const before=e.db.prepare('SELECT total_changes() AS n').get().n,binding=await managedCropBinding(e.input.folder,e.input.filename)
  const first=await inspect(e,saved),second=await inspect(e,saved)
  expect(first).toEqual(second);expect(first).toMatchObject({jobId:'saved-job',revision:7,readOnly:true,requiresAttention:false,unassignedPages:0,observations:[{state:'current_unsent',claimEventId:'production-claim'}]})
  expect(e.db.prepare('SELECT total_changes() AS n').get().n).toBe(before)
  expect(await managedCropBinding(e.input.folder,e.input.filename)).toEqual(binding)
  expect(saved).toEqual(job(a.task.id))
 })
 it('separates missing original receipts, blocked delayed claims and legacy task IDs without adopting the current owner',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile')
  expect((await inspect(e,job(a.task.id,'never-recorded'))).observations[0].state).toBe('missing_receipt')
  await e.operation({action:'stop_claim',taskId:a.task.id,claimEventId:'blocked-original'})
  expect((await inspect(e,job(a.task.id,'blocked-original'))).observations[0].state).toBe('claim_blocked')
  const legacy=job(a.task.id);delete legacy.command!.managedClaims
  expect((await inspect(e,legacy)).observations[0].state).toBe('legacy_task_only')
  expect((await e.authority.timeline(a.task.id)).task.state).toBe('assigned')
 })
 it('reports saved output and verified publication without importing, reviewing or renewing anything',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile',undefined,'production-claim');await e.saved(a)
  const count=e.db.prepare('SELECT total_changes() AS n').get().n
  expect((await inspect(e,job(a.task.id))).observations[0].state).toBe('ready_original_saved')
  expect(e.db.prepare('SELECT total_changes() AS n').get().n).toBe(count)
  expect(await readManagedCrop(e.input.folder,e.input.filename)).toBeNull()
  await e.pilot.import(e.input,a.task.id)
  expect((await inspect(e,job(a.task.id))).observations[0].state).toBe('verified_complete')
 })
 it('retains unknown submissions and expired original leases as reconciliation cases',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile',undefined,'production-claim')
  for(const phase of ['accepted','started','submission_intent'])await e.checkpoint(a,phase)
  const report=await inspect(e,job(a.task.id));expect(report.observations[0]).toMatchObject({state:'needs_reconciliation',owner:{submission:'unknown'}})
  const other=await setup(),b=await other.pilot.start(other.input,'phone','profile',undefined,'production-claim')
  const expired=await inspectManagedProduction(job(b.task.id),other.authority,[other.input],Date.parse(b.attempt!.leaseExpiresAt)+1)
  expect(expired.observations[0].state).toBe('needs_reconciliation')
  expect((await other.authority.timeline(b.task.id)).task.state).toBe('assigned')
 })
 it('rejects changed source bindings and mismatched saved phone/profile without authority work',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile',undefined,'production-claim')
  await fs.writeFile(e.input.sourceFile,'changed')
  expect((await inspect(e,job(a.task.id))).observations[0].state).toBe('input_changed')
  const changed=job(a.task.id);changed.command!.managedClaims![0].profileId='other'
  expect((await inspect(e,changed)).observations[0].state).toBe('input_changed')
 })
 it('reports transferred original receipts as obsolete while leaving the new owner unchanged',async()=>{
  const e=await setup()
  for(const token of [phone,foreign])await e.operation({action:'hello',capabilities:[...MANAGED_CAPABILITIES,DEFAULT_CROP_CAPABILITY,SLICED_CROP_CAPABILITY,'worker-reconnect/1'],profileIds:['profile'],apkVersion:'1.0.999'},token)
  await e.pilot.enroll('phone','profile');await e.pilot.enroll('foreign','profile')
  const a=await e.pilot.start(e.input,'phone','profile',undefined,'production-claim'),stop=await e.pilot.stop(a.task.id,false) as any
  await e.checkpoint(a,'stop_confirmed',stop.command.id)
  await e.pilot.transfer(e.input,{taskId:a.task.id,attemptId:a.attempt!.id,generation:1,fingerprint:a.task.fingerprint,stopCommandId:stop.command.id},'foreign','profile')
  const before=await e.authority.timeline(a.task.id)
  expect((await inspect(e,job(a.task.id))).observations[0]).toMatchObject({state:'obsolete_claim',owner:{generation:2,deviceId:'foreign'}})
  expect(await e.authority.timeline(a.task.id)).toEqual(before)
 })
 it('rejects changing authority evidence during inspection and ambiguous stored receipts',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile',undefined,'production-claim'),original=e.authority.timeline;let reads=0
  e.authority.timeline=async id=>{const current=await original(id);if(++reads===2)return {...current,artifactReady:!current.artifactReady};return current}
  await expect(inspect(e,job(a.task.id))).rejects.toThrow('changed during inspection')
  const duplicate=job(a.task.id);duplicate.command!.managedClaims!.push({...duplicate.command!.managedClaims![0]})
  await expect(inspect(e,duplicate)).rejects.toThrow('Ambiguous')
 })
 it('explicitly resumes the exact original saved output under coordinator ownership without a replacement attempt',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile',undefined,'production-claim');await e.saved(a)
  const saved=job(a.task.id),observed=await inspect(e,saved),proofs:any[]=[],manager=new ManagedProductionCoordinator()
  const result=await resumeInspectedManagedProduction('series',{jobId:saved.id,revision:7,scopeDigest:observed.scopeDigest},{
   load:async()=>[structuredClone(saved)],authority:e.authority,coordinator:manager,inputs:async()=>[e.input],now:()=>Date.parse('2026-10-19T00:00:00Z'),
   launch:async(original,approval)=>{
    proofs.push(approval)
    await new ManagedProductionCoordinator().withLease(e.authority,async()=>{}).then(()=>{throw new Error('competing coordinator must fail')},error=>expect(error.message).toContain('Another coordinator'))
    await manager.withLease(e.authority,authority=>runManagedProduction('phone','profile',new AbortController().signal,{authority,claims:original.command!.managedClaims,inputs:async()=>[e.input],report:async()=>{},wait:async()=>{throw new Error('original saved bytes must be reused')}}))
    return {...original,id:'resumed',status:'review',resumedFrom:approval}
   }
  })
  expect(result.resumedFrom).toEqual({jobId:saved.id,revision:7,scopeDigest:observed.scopeDigest,checkedAt:observed.checkedAt,preparedTaskIds:observed.preparedTaskIds})
  expect(proofs).toHaveLength(1);expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(1)
  expect((await e.authority.timeline(a.task.id)).task.state).toBe('verified_complete')
  expect((await e.authority.coordinator!())?.state).toBe('released')
 })
 it('rejects an outdated authority observation and a job changed during inspection before launching',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile',undefined,'production-claim'),saved=job(a.task.id),observed=await inspect(e,saved),launch=vi.fn(async()=>saved)
  const deps={load:async()=>[structuredClone(saved)],authority:e.authority,coordinator:new ManagedProductionCoordinator(),inputs:async()=>[e.input],launch,now:()=>Date.parse('2026-10-19T00:00:00Z')}
  await e.checkpoint(a,'accepted')
  await expect(resumeInspectedManagedProduction('series',{jobId:saved.id,revision:7,scopeDigest:observed.scopeDigest},deps)).rejects.toThrow('evidence changed')
  const fresh=await inspect(e,saved);let loads=0
  deps.load=async()=>[{...saved,revision:++loads===1?7:8}]
  await expect(resumeInspectedManagedProduction('series',{jobId:saved.id,revision:7,scopeDigest:fresh.scopeDigest},deps)).rejects.toThrow('changed during reconciliation')
  expect(launch).not.toHaveBeenCalled();expect((await e.authority.coordinator!())?.state).toBe('released')
 })
 it('never resumes cancelled or legacy task-only work and releases coordinator ownership when persistence fails',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile',undefined,'production-claim'),saved=job(a.task.id),launch=vi.fn(async()=>{throw new Error('save rejected')})
  const deps={load:async()=>[structuredClone(saved)],authority:e.authority,coordinator:new ManagedProductionCoordinator(),inputs:async()=>[e.input],launch,now:()=>Date.parse('2026-10-19T00:00:00Z')}
  const request={jobId:saved.id,revision:7,scopeDigest:(await inspect(e,saved)).scopeDigest}
  const current=await e.authority.timeline(a.task.id)
  await expect(resumeInspectedManagedProduction('series',request,deps)).rejects.toThrow('save rejected')
  expect(await e.authority.timeline(a.task.id)).toEqual(current)
  expect((await e.authority.coordinator!())?.state).toBe('released')
  saved.status='cancelled';launch.mockClear()
  await expect(resumeInspectedManagedProduction('series',request,deps)).rejects.toThrow('Refresh an interrupted')
  saved.status='interrupted';delete saved.command!.managedClaims
  const legacy=await inspect(e,saved)
  await expect(resumeInspectedManagedProduction('series',{...request,scopeDigest:legacy.scopeDigest},deps)).rejects.toThrow('needs reconciliation')
  expect(launch).not.toHaveBeenCalled()
 })
 it('blocks prepared source scope drift after resume before any new claim',async()=>{
  const e=await setup(),controller=new AbortController()
  await expect(runManagedProduction('phone','profile',controller.signal,{authority:e.authority,expectedTaskIds:[],inputs:async()=>[e.input],report:async()=>{},wait:async()=>{}})).rejects.toThrow('scope changed')
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(0)
 })
 it('exports exact original receipts and adopts into an empty destination without dispatch; a retry cannot overwrite it',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile',undefined,'production-claim'),original=job(a.task.id)
  original.command!.sentAt='2026-10-19T00:00:00Z';original.command!.devices=['phone']
  const before=e.db.prepare('SELECT total_changes() AS n').get().n
  const bundle=await exportManagedRun(original,e.authority,[e.input],Date.parse('2026-10-19T00:00:00Z'))
  expect(parseManagedRunBundle(JSON.stringify(bundle))).toEqual(bundle)
  expect(e.db.prepare('SELECT total_changes() AS n').get().n).toBe(before)
  let adopted:ProductionJob|undefined,saves=0
  const deps={authority:e.authority,coordinator:new ManagedProductionCoordinator(),load:async()=>adopted?[structuredClone(adopted)]:[],inputs:async()=>[e.input],saveNew:async(j:ProductionJob)=>{expect(adopted).toBeUndefined();adopted=structuredClone(j);saves++},now:()=>Date.parse('2026-10-19T00:00:00Z')}
  const result=await adoptManagedRun('destination-series',bundle,deps)
  expect(result).toMatchObject({status:'interrupted',seriesId:'destination-series',revision:1,command:original.command,adoptedFrom:{bundleId:bundle.bundleId,sourceJobId:original.id,sourceRevision:7}})
  expect(await adoptManagedRun('destination-series',bundle,deps)).toEqual(result)
  expect(saves).toBe(1);expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(1)
  expect((await e.authority.timeline(a.task.id)).commands).toHaveLength(1)
  expect(JSON.stringify(bundle)).not.toContain(e.input.sourceFile)
 })
 it('rejects changed bundles, missing original receipts and destination overwrite during cross-database adoption',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile',undefined,'production-claim'),original=job(a.task.id)
  original.command!.sentAt='2026-10-19T00:00:00Z';original.command!.devices=['phone']
  const bundle=await exportManagedRun(original,e.authority,[e.input],Date.parse('2026-10-19T00:00:00Z'))
  expect(()=>parseManagedRunBundle({...bundle,sourceRevision:8})).toThrow('checksum')
  const save=vi.fn(async()=>{}),deps={authority:e.authority,coordinator:new ManagedProductionCoordinator(),load:async()=>[job(a.task.id)],inputs:async()=>[e.input],saveNew:save,now:()=>Date.parse('2026-10-19T00:00:00Z')}
  await expect(adoptManagedRun('series',bundle,deps)).rejects.toThrow('cannot be overwritten')
  deps.load=async()=>[]
  await fs.writeFile(e.input.sourceFile,'changed source')
  await expect(adoptManagedRun('destination-series',bundle,deps)).rejects.toThrow('Destination sources')
  expect(save).not.toHaveBeenCalled()
 })
 it('retains original ownership and blocks dispatch when coordinator renewal and release are unavailable',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile',undefined,'production-claim')
  let clock=Date.parse('2026-10-19T00:00:00Z'),outage=false
  const manager=new ManagedProductionCoordinator(()=>clock),authority={...e.authority,operation:async(op:Record<string,unknown>)=>{
   if(outage&&['coordinator_renew','coordinator_release'].includes(String(op.action)))throw new Error('Synthetic authority outage')
   return e.authority.operation(op)
  }}
  const before=await e.authority.timeline(a.task.id)
  await expect(manager.withLease(authority,async owned=>{
   clock+=20_001;outage=true
   await runManagedProduction('phone','profile',new AbortController().signal,{authority:owned,inputs:async()=>[e.input],report:async()=>{},wait:async()=>{}})
  })).rejects.toThrow('Synthetic authority outage')
  expect(await e.authority.timeline(a.task.id)).toEqual(before)
  expect((await e.authority.coordinator!())?.state).toBe('held')
  await expect(new ManagedProductionCoordinator().withLease(e.authority,async()=>{})).rejects.toThrow()
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(1)
 })
 it('persists adoption across two independent Studio SQLite databases while preserving the source job and authority attempt',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile',undefined,'production-claim'),original={...job(a.task.id),revision:1}
  original.command!.sentAt='2026-10-19T00:00:00Z';original.command!.devices=['phone']
  const {PrismaClient}=await import('@prisma/client'),{ProductionJobStore}=await import('../src/services/productionJobStore.js'),{productionJobDatabase}=await import('../src/services/productionJobDatabase.js')
  const databases=['source','destination'].map(name=>new PrismaClient({datasources:{db:{url:'file:'+path.join(path.dirname(e.input.sourceFile),name+'.db')}}}))
  const stores=databases.map(db=>new ProductionJobStore(productionJobDatabase(()=>db),()=>Date.parse('2026-10-19T00:00:00Z'),45_000,0))
  try{
   for(const db of databases)await db.$executeRawUnsafe('CREATE TABLE Setting (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)')
   for(const store of stores)await store.activate()
   await stores[0].save(original,null)
   const bundle=await exportManagedRun((await stores[0].load())[0],e.authority,[e.input],Date.parse('2026-10-19T00:00:00Z'))
   const deps={load:()=>stores[1].load(),authority:e.authority,coordinator:new ManagedProductionCoordinator(),inputs:async()=>[e.input],saveNew:(candidate:ProductionJob)=>stores[1].save(candidate,null),now:()=>Date.parse('2026-10-19T00:00:00Z')}
   const adopted=await adoptManagedRun('series',bundle,deps)
   expect((await stores[1].load())[0]).toEqual(adopted)
   expect(await adoptManagedRun('series',bundle,deps)).toEqual(adopted)
   expect((await stores[0].load())[0]).toEqual(original)
   expect(adopted.command).toEqual(original.command);expect(adopted.status).toBe('interrupted')
   expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(1)
  }finally{for(const store of stores)store.close();await Promise.all(databases.map(db=>db.$disconnect()))}
 })
 it('rejects forged portable receipts even when their transport checksum is recomputed',async()=>{
  const e=await setup(),a=await e.pilot.start(e.input,'phone','profile',undefined,'production-claim'),original=job(a.task.id)
  original.command!.sentAt='2026-10-19T00:00:00Z';original.command!.devices=['phone']
  const bundle=await exportManagedRun(original,e.authority,[e.input],Date.parse('2026-10-19T00:00:00Z'))
  const save=vi.fn(async()=>{}),deps={authority:e.authority,coordinator:new ManagedProductionCoordinator(),load:async()=>[],inputs:async()=>[e.input],saveNew:save,now:()=>Date.parse('2026-10-19T00:00:00Z')}
  const forged=structuredClone(bundle);forged.command.managedClaims![0].claimEventId='invented-claim'
  const {bundleId,...payload}=forged
  const {createHash}=await import('node:crypto'),{canonicalJson}=await import('../src/services/managedTaskProtocol.js')
  forged.bundleId=createHash('sha256').update(canonicalJson(payload)).digest('hex')
  expect(parseManagedRunBundle(forged)).toEqual(forged)
  await expect(adoptManagedRun('destination-series',forged,deps)).rejects.toThrow('Destination sources or original ownership')
  expect(save).not.toHaveBeenCalled();expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(1)
  for(const edit of [(b:any)=>b.command.managedClaims.push(b.command.managedClaims[0]),(b:any)=>b.config.token='secret',(b:any)=>b.command.managedClaims[0].deviceId='foreign',(b:any)=>b.preparedTaskIds.push(b.preparedTaskIds[0])]){
   const invalid=structuredClone(bundle);edit(invalid);expect(()=>parseManagedRunBundle(invalid)).toThrow()
  }
 })
 it('does not plan or assign prepared pages without persisted claims',async()=>{
  const e=await setup(),j=job('task:sha256:'+'a'.repeat(64));j.command=undefined
  const count=e.db.prepare('SELECT total_changes() AS n').get().n
  const result=await inspect(e,j);expect(result).toMatchObject({observations:[],unassignedPages:1,readOnly:true})
  expect(e.db.prepare('SELECT total_changes() AS n').get().n).toBe(count)
  expect(e.db.prepare('SELECT * FROM managed_tasks').all()).toHaveLength(0)
 })
})


describe('managed two-phone production scheduling',()=>{
 it('rejects new assignments to an already cancelled unknown owner while the healthy phone publishes two pages',async()=>{
  const e=await setup(),original=await e.pilot.start(e.input,'phone','profile')
  for(const phase of ['accepted','started','submission_intent'])await e.checkpoint(original,phase)
  const stop=await e.pilot.stop(original.task.id,true) as any;await e.checkpoint(original,'stop_confirmed',stop.command.id)
  const before=await e.authority.timeline(original.task.id)
  await e.operation({action:'hello',capabilities:[...MANAGED_CAPABILITIES,DEFAULT_CROP_CAPABILITY,SLICED_CROP_CAPABILITY],profileIds:['profile'],apkVersion:'1.0.999'},foreign);await e.pilot.enroll('foreign','profile')
  const inputs:PilotInput[]=[]
  for(const number of [2,3,4]){
   const sourceFile=path.join(path.dirname(e.input.sourceFile),'page'+number+'.png');await fs.copyFile(e.input.sourceFile,sourceFile)
   inputs.push({...e.input,identity:{...e.input.identity,pageId:'page'+number},sourceFile,filename:'page'+number+'.png',destination:path.join(path.dirname(e.input.destination),'private'+number),spec:{...e.input.spec,dependencies:[{...e.input.spec.dependencies[0],id:'page'+number}]}})
  }
  const claims:ManagedProductionClaim[]=[],manager=new ManagedProductionCoordinator()
  await expect(manager.withLease(e.authority,authority=>runManagedFleet([{device:'phone',profileId:'profile'},{device:'foreign',profileId:'profile'}],new AbortController().signal,{
   authority,inputs:async()=>inputs,report:async(_message,_id,claim)=>{if(claim&&!claims.some(c=>c.taskId===claim.taskId))claims.push(claim)},wait:async(_signal,device)=>{
    expect(device).toBe('foreign') // The held phone never reaches the worker-execution wait.
    const assignment=(await(await e.request('/managed/inbox',undefined,foreign)).json()).assignments[0]
    if(assignment?.attempt.phase==='assigned')await e.saved(assignment,false,inputs.find(i=>i.identity.pageId===assignment.task.pageId)!,foreign)
   }
  }))).rejects.toThrow('Device/browser/profile remains reserved')
  expect(await e.authority.timeline(original.task.id)).toEqual(before)
  expect(e.db.prepare("SELECT id FROM managed_attempts WHERE json_extract(body,'$.deviceId') = ?").all('phone')).toHaveLength(1)
  const held=claims.find(c=>c.deviceId==='phone')!;expect((await e.authority.timeline(held.taskId)).attempt).toBeNull()
  const healthy=claims.filter(c=>c.deviceId==='foreign');expect(healthy).toHaveLength(2)
  for(const claim of healthy)expect((await e.authority.timeline(claim.taskId)).task.state).toBe('verified_complete')
  expect(e.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(4)
 })
 it('keeps an unknown original attempt held while a healthy phone completes distinct remaining pages',async()=>{
  const e=await setup()
  await e.operation({action:'hello',capabilities:[...MANAGED_CAPABILITIES,DEFAULT_CROP_CAPABILITY,SLICED_CROP_CAPABILITY],profileIds:['profile'],apkVersion:'1.0.999'},foreign);await e.pilot.enroll('foreign','profile')
  const inputs=[e.input]
  for(const number of [2,3]){
   const sourceFile=path.join(path.dirname(e.input.sourceFile),'page'+number+'.png');await fs.copyFile(e.input.sourceFile,sourceFile)
   inputs.push({...e.input,identity:{...e.input.identity,pageId:'page'+number},sourceFile,filename:'page'+number+'.png',destination:path.join(path.dirname(e.input.destination),'private'+number),spec:{...e.input.spec,dependencies:[{...e.input.spec.dependencies[0],id:'page'+number}]}})
  }
  const claims:ManagedProductionClaim[]=[],manager=new ManagedProductionCoordinator()
  await expect(manager.withLease(e.authority,authority=>runManagedFleet([{device:'phone',profileId:'profile'},{device:'foreign',profileId:'profile'}],new AbortController().signal,{
   authority,inputs:async()=>inputs,report:async(_message,_id,claim)=>{if(claim&&!claims.some(c=>c.taskId===claim.taskId))claims.push(claim)},wait:async(_signal,device)=>{
    const one=(await(await e.request('/managed/inbox',undefined,phone)).json()).assignments[0]
    const two=(await(await e.request('/managed/inbox',undefined,foreign)).json()).assignments[0]
    if(device==='foreign'&&two&&two.attempt.phase==='assigned'){
     const source=inputs.find(i=>i.identity.pageId===two.task.pageId)!
     await e.saved(two,false,source,foreign)
    }else if(device==='phone'&&one&&one.attempt.phase==='assigned'){
     for(const phase of ['accepted','started','submission_intent'])await e.checkpoint(one,phase)
     throw new Error('Original unknown outcome retained; no replay')
    }
   }
  }))).rejects.toThrow('Healthy distinct pages continued')
  const one=(await(await e.request('/managed/inbox',undefined,phone)).json()).assignments[0]
  expect(one.attempt.submission).toBe('unknown')
  expect(claims).toHaveLength(3)
  const healthy=claims.filter(c=>c.deviceId==='foreign')
  expect(healthy).toHaveLength(2)
  for(const claim of healthy)expect((await e.authority.timeline(claim.taskId)).task.state).toBe('verified_complete')
  expect(e.db.prepare('SELECT * FROM managed_attempts').all()).toHaveLength(3)
  expect(e.db.prepare('SELECT * FROM managed_reservations').all()).toHaveLength(4)
 })
})
