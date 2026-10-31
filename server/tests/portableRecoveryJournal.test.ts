import {productionRecoveryDisposition} from '../src/services/productionRecoveryDisposition.js'
import {productionCandidateHandoff} from '../src/services/managedProductionCandidateHandoff.js'
import {CLOSE_UNUSED_CONFIRMATION,RECOVERY_DISPOSITION_SCHEMA} from '../src/services/recoveryDispositionProtocol.js'
import {ManagedSavedImportRecovery,savedImportDestinationId,type SavedImportRecoveryTransport} from '../src/services/managedSavedImportRecovery.js'
import {ManagedArtifactDestination,resolveManagedCropInput} from '../src/services/managedArtifactImport.js'
import {SAVED_IMPORT_SCHEMA} from '../src/services/managedSavedImportRecoveryProtocol.js'
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
 let txSeq=0;const transaction=<T>(work:()=>T)=>{const key='portable_'+(++txSeq);db.exec('SAVEPOINT '+key);try{const result=work();db.exec('RELEASE '+key);return result}catch(error){db.exec('ROLLBACK TO '+key);db.exec('RELEASE '+key);throw error}}
 const objects=new Map<string,Uint8Array>()
 const env:ManagedTaskEnvironment={MANAGED_AUTOMATIC_RECOVERY:'1',MANAGED_CROP_PAGE:'1',MANAGED_WORKSPACE_ID:'workspace',MANAGED_STUDIO_TOKEN:studio,MANAGED_DEVICE_TOKENS:JSON.stringify({phone,foreign}),MANAGED_ARTIFACTS:{async get(key){const value=objects.get(key);return value?{size:value.length,arrayBuffer:async()=>new Uint8Array(value).buffer}:null},async put(key,value){if(objects.has(key))return null;objects.set(key,new Uint8Array(value));return {key}}}}
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
 return {db,env,input,request,operation,authority,pilot,checkpoint,saved,clock:()=>now,advance:(ms=300001)=>now+=ms}
}

async function retained(mode:'history'|'pending'|'unconfirmed'|'handoff'='history'){
 const e=await setup(),calls:any[]=[]
 e.authority.recoveryDisposition=async(op:any)=>{calls.push(structuredClone(op));const response=await e.request('/managed/recovery/disposition',{schema:RECOVERY_DISPOSITION_SCHEMA,workspaceId:'workspace',...op});const raw=await response.json();if(response.status!==200)throw new Error(raw.error);return raw}
 e.authority.accountHandoff=async(op:any)=>{calls.push(structuredClone(op));const response=await e.request('/managed/recovery/account-handoff',{schema:'managed-account-handoff/1',workspaceId:'workspace',...op});const raw=await response.json();if(response.status!==200)throw new Error(raw.error);return raw}
 e.authority.candidateAdoptionStatus=async()=>{throw Error('Imported approval must not query custody or create an approval')}
 const coordinator=new ManagedProductionCoordinator(e.clock);let assigned:any
 await coordinator.withLease(e.authority,async f=>{
  assigned=await new ManagedCropPilot(f).start(e.input,'phone','profile',undefined,'original_claim')
  await e.checkpoint(assigned,'accepted');await e.checkpoint(assigned,'started')
  const stopped=await f.operation({action:'pause_production_claim',taskId:assigned.task.id,claimEventId:'original_claim',eventId:'source_pause'})
  await e.checkpoint(assigned,'stop_confirmed',stopped.command.id)
 })
 const current=await e.authority.timeline(assigned.task.id),unit={workspaceId:'workspace',taskId:current.task.id,attemptId:current.attempt!.id,generation:current.task.generation,fingerprint:current.task.fingerprint}
 const p={eventId:'unused_handoff',newClaimEventId:'unused_claim',claimEventId:'original_claim',taskId:unit.taskId,attemptId:unit.attemptId,generation:1,fingerprint:unit.fingerprint,stopCommandId:current.attempt!.activeCommandId,deviceId:'foreign',profileId:'profile',accountCandidateId:'retained_candidate',createdAt:new Date(e.clock()).toISOString()}
 const snapshot=await e.authority.recoveryDisposition({action:'inspect',unit}),intent={schema:RECOVERY_DISPOSITION_SCHEMA,eventId:'original_decision',unit,mode:'close_unused',reference:{unit,ledger:'managed_account_handoff_episodes',actionId:p.eventId},production:{jobId:'original_job',claimEventId:p.claimEventId,newClaimEventId:p.newClaimEventId,candidateId:p.accountCandidateId},inspectedAt:snapshot.checkedAt,inspectionToken:snapshot.inspectionToken,confirmation:CLOSE_UNUSED_CONFIRMATION}
 let receipt:any=null
 if(mode==='history'||mode==='pending')receipt=await coordinator.withLease(e.authority,f=>f.recoveryDisposition!({action:'apply',intent}))
 const job:ProductionJob={id:'original_job',revision:7,seriesId:'series',status:'interrupted',step:'clipping',message:'retained',createdAt:new Date(e.clock()).toISOString(),updatedAt:new Date(e.clock()).toISOString(),config:{managedCrop:true,device:'phone',profileId:'profile',clipper:{ai:'chatgpt',flow:'classic',tabs:1,chatGpt:{mode:null,model:null,effort:null}}},command:{kind:'clipper',sentAt:new Date(e.clock()).toISOString(),devices:['phone'],managedTaskIds:[unit.taskId],managedClaims:[{taskId:unit.taskId,claimEventId:'original_claim',deviceId:'phone',profileId:'profile'}]},...(mode==='history'?{recoveryDispositionHistory:[{handoff:p,receipt}]}:{pendingHandoff:p,...(mode!=='handoff'?{pendingRecoveryDisposition:intent}:{})})}
 calls.length=0
 const audit=()=>e.db.prepare('SELECT body FROM managed_recovery_disposition_events ORDER BY id').all(),state=()=>({tasks:e.db.prepare('SELECT body FROM managed_tasks ORDER BY id').all(),attempts:e.db.prepare('SELECT body FROM managed_attempts ORDER BY id').all(),lineage:e.db.prepare('SELECT body FROM managed_recovery_lineage ORDER BY id').all(),audit:audit(),stops:e.db.prepare('SELECT body FROM managed_recovery_stops ORDER BY id').all(),claims:e.db.prepare('SELECT body FROM managed_claim_stops ORDER BY id').all()})
 return {...e,job,unit,p,intent,receipt,coordinator,calls,audit,state}
}
function destination(e:any){let saved:ProductionJob|undefined;const deps={authority:e.authority,coordinator:new ManagedProductionCoordinator(e.clock),load:async()=>saved?[structuredClone(saved)]:[],inputs:async()=>[e.input],saveNew:async(job:ProductionJob)=>{if(saved)throw Error('destination exists');saved=structuredClone(job)},now:e.clock};return {deps,job:()=>saved!,set:(job:ProductionJob)=>saved=job}}
const rehash=(bundle:any)=>{const {bundleId,...payload}=bundle;bundle.bundleId=createHash('sha256').update(canonicalJson(payload)).digest('hex');return bundle}
describe('portable recovery journal with read-only relay proof',()=>{
 it('exports history without changing authority and adopts the exact history/charges without dispatch',async()=>{
  const e=await retained(),before=e.state(),bundle=await exportManagedRun(e.job,e.authority,[e.input],e.clock());if(process.env.PORTABLE_RECOVERY_BUNDLE_OUTPUT)await fs.writeFile(process.env.PORTABLE_RECOVERY_BUNDLE_OUTPUT,JSON.stringify(bundle,null,2)+'\n');expect(bundle.schema).toBe('managed-production-bundle/2');expect(bundle.recoveryJournal!.recoveryDispositionHistory).toEqual(e.job.recoveryDispositionHistory);expect(parseManagedRunBundle(JSON.stringify(bundle))).toEqual(bundle);expect(e.state()).toEqual(before);expect(e.calls.some(c=>['apply','resolve','approve','finalize'].includes(c.action))).toBe(false)
  const dest=destination(e),adopted=await adoptManagedRun('destination',bundle,dest.deps);expect(adopted.id).toBe(e.job.id);expect(adopted.recoveryDispositionHistory).toEqual(e.job.recoveryDispositionHistory);expect(adopted.command).toEqual(e.job.command);expect(adopted.status).toBe('interrupted');expect(e.state()).toEqual(before);expect(JSON.stringify(bundle)).not.toContain(e.input.sourceFile);expect(await adoptManagedRun('destination',bundle,dest.deps)).toEqual(adopted)
 })
 it('preserves acknowledged pending decision IDs and reconciles the original receipt after adoption',async()=>{
  const e=await retained('pending'),bundle=await exportManagedRun(e.job,e.authority,[e.input],e.clock()),dest=destination(e),adopted=await adoptManagedRun('destination',bundle,dest.deps)
  expect(adopted.id).toBe('original_job');expect(adopted.pendingRecoveryDisposition).toEqual(e.intent);expect(adopted.pendingHandoff).toEqual(e.p);expect(adopted.adoptedFrom?.importedPendingDecisionId).toBe(e.intent.eventId)
  const result=await productionRecoveryDisposition('destination',{action:'reconcile',jobId:adopted.id,revision:1},{authority:e.authority,coordinator:new ManagedProductionCoordinator(e.clock),load:dest.deps.load,save:async j=>dest.set(j),now:e.clock})
  expect(result.job.pendingHandoff).toBeUndefined();expect(result.job.recoveryDispositionHistory![0].receipt).toEqual(e.receipt);expect(result.job.status).toBe('interrupted')
 })
 it('does not resolve an expired unconfirmed decision during export or adoption',async()=>{
  const e=await retained('unconfirmed');e.advance(15000);const before=e.state(),bundle=await exportManagedRun(e.job,e.authority,[e.input],e.clock()),dest=destination(e);await adoptManagedRun('destination',bundle,dest.deps);expect(e.state()).toEqual(before);expect(e.audit()).toHaveLength(0);expect(e.calls.some(c=>['apply','resolve'].includes(c.action))).toBe(false)
 })
 it('never applies a still-fresh unacknowledged imported decision; later explicit reconciliation only fences expiry',async()=>{
  const e=await retained('unconfirmed'),bundle=await exportManagedRun(e.job,e.authority,[e.input],e.clock()),dest=destination(e),adopted=await adoptManagedRun('destination',bundle,dest.deps),deps={authority:e.authority,coordinator:new ManagedProductionCoordinator(e.clock),load:dest.deps.load,save:async(j:ProductionJob)=>dest.set(j),now:e.clock}
  await expect(productionRecoveryDisposition('destination',{action:'reconcile',jobId:adopted.id,revision:1},deps)).rejects.toThrow('Imported decision');expect(e.audit()).toHaveLength(0);expect(e.calls.some(c=>c.action==='apply')).toBe(false)
  e.advance(15000);const result=await productionRecoveryDisposition('destination',{action:'reconcile',jobId:adopted.id,revision:1},deps);expect(result.job.pendingRecoveryDisposition).toBeUndefined();expect(result.job.pendingHandoff).toEqual(e.p);expect(result.job.recoveryDispositionHistory![0].receipt.state).toBe('not_applied_expired');expect(e.calls.some(c=>c.action==='apply')).toBe(false)
 })
 it('cannot create a missing original handoff approval from an imported pending intent',async()=>{
  const e=await retained('handoff'),bundle=await exportManagedRun(e.job,e.authority,[e.input],e.clock()),dest=destination(e),adopted=await adoptManagedRun('destination',bundle,dest.deps)
  await expect(productionCandidateHandoff('destination',{action:'approve',jobId:adopted.id,revision:1,intentId:e.p.eventId},{authority:e.authority,coordinator:new ManagedProductionCoordinator(e.clock),load:dest.deps.load,save:async j=>dest.set(j),inputs:async()=>[e.input],verify:async()=>(await resolveManagedCropInput(e.input.identity,e.input.spec,e.input.sourceFile)).source,validateTarget:async()=>{},enabled:()=>true,now:e.clock})).rejects.toThrow('Imported handoff')
  expect(e.calls.some(c=>c.action==='approve')).toBe(false);expect(e.db.prepare('SELECT body FROM managed_account_handoff_episodes').all()).toHaveLength(0)
 })
 it('preserves cancellation and refuses resumed dispatch on a cancelled imported run',async()=>{
  const e=await retained();e.job.status='cancelled';const bundle=await exportManagedRun(e.job,e.authority,[e.input],e.clock()),dest=destination(e),result=await adoptManagedRun('destination',bundle,dest.deps);expect(result.status).toBe('cancelled');expect(result.command).toEqual(e.job.command)
 })
 it('rejects invented relay receipts even when the transport checksum is recomputed',async()=>{
  const e=await retained(),bundle=await exportManagedRun(e.job,e.authority,[e.input],e.clock()),forged=structuredClone(bundle);forged.recoveryJournal!.recoveryDispositionHistory[0].receipt.intent.eventId='invented_decision';rehash(forged);const dest=destination(e)
  await expect(adoptManagedRun('destination',forged,dest.deps)).rejects.toThrow('relay disposition');expect(dest.job()).toBeUndefined()
 })
 it('holds when original relay receipt or successor claim barrier is missing',async()=>{
  const e=await retained(),bundle=await exportManagedRun(e.job,e.authority,[e.input],e.clock()),dest=destination(e);e.db.prepare('DELETE FROM managed_claim_stops WHERE id = ?').run(e.p.newClaimEventId);await expect(adoptManagedRun('destination',bundle,dest.deps)).rejects.toThrow('barrier');expect(dest.job()).toBeUndefined()
 })
 it('rejects changed exact source and prevents overwrite of an existing destination',async()=>{
  const e=await retained(),bundle=await exportManagedRun(e.job,e.authority,[e.input],e.clock()),dest=destination(e);dest.set({...e.job,seriesId:'destination'});await expect(adoptManagedRun('destination',bundle,dest.deps)).rejects.toThrow('cannot be overwritten');dest.set(undefined as any);await fs.writeFile(e.input.sourceFile,'changed source');await expect(adoptManagedRun('destination',bundle,dest.deps)).rejects.toThrow();expect(dest.job()).toBeUndefined()
 })
 it('detects authority changes between read-only checks and does not save a destination',async()=>{
  const e=await retained(),bundle=await exportManagedRun(e.job,e.authority,[e.input],e.clock()),dest=destination(e),send=e.authority.recoveryDisposition!;let count=0
  e.authority.recoveryDisposition=async op=>{const result=await send(op);if(op.action==='proof'&&++count===2)result.stateDigest='f'.repeat(64);return result}
  await expect(adoptManagedRun('destination',bundle,dest.deps)).rejects.toThrow('changed during adoption');expect(dest.job()).toBeUndefined()
 })
 it('cannot erase imported history or pending identities through idempotent adoption',async()=>{
  const e=await retained(),bundle=await exportManagedRun(e.job,e.authority,[e.input],e.clock()),dest=destination(e),result=await adoptManagedRun('destination',bundle,dest.deps);dest.set({...result,recoveryDispositionHistory:[]});await expect(adoptManagedRun('destination',bundle,dest.deps)).rejects.toThrow('removed or changed')
 })
 it('strictly bounds the new format and denies unknown fields, duplicate decisions and promoted permissions',async()=>{
  const e=await retained(),bundle=await exportManagedRun(e.job,e.authority,[e.input],e.clock())
  for(const mutate of [(b:any)=>b.executionAllowed=true,(b:any)=>b.recoveryJournal.token='secret',(b:any)=>b.recoveryJournal.recoveryDispositionHistory.push(b.recoveryJournal.recoveryDispositionHistory[0]),(b:any)=>b.recoveryJournal.handoffHistory=Array(17).fill({}),(b:any)=>b.schema='managed-production-bundle/99']){const b=structuredClone(bundle);mutate(b);rehash(b);expect(()=>parseManagedRunBundle(b)).toThrow()}
  expect(()=>parseManagedRunBundle(' '.repeat(512001))).toThrow('bound')
 })
 it('preserves history through independent source and destination Prisma SQLite stores',async()=>{
  const e=await retained(),{PrismaClient}=await import('@prisma/client'),{ProductionJobStore}=await import('../src/services/productionJobStore.js'),{productionJobDatabase}=await import('../src/services/productionJobDatabase.js'),dbs=['source','destination'].map(n=>new PrismaClient({datasources:{db:{url:'file:'+path.join(path.dirname(e.input.sourceFile),n+'.db')}}})),stores=dbs.map(db=>new ProductionJobStore(productionJobDatabase(()=>db),e.clock,45000,0))
  try{for(const db of dbs)await db.$executeRawUnsafe('CREATE TABLE Setting (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)');for(const store of stores)await store.activate();const source={...e.job,revision:1};await stores[0].save(source,null);const bundle=await exportManagedRun((await stores[0].load())[0],e.authority,[e.input],e.clock()),deps={authority:e.authority,coordinator:new ManagedProductionCoordinator(e.clock),load:()=>stores[1].load(),inputs:async()=>[e.input],saveNew:(j:ProductionJob)=>stores[1].save(j,null),now:e.clock};const adopted=await adoptManagedRun('destination',bundle,deps);expect((await stores[1].load())[0]).toEqual(adopted);expect((await stores[0].load())[0]).toEqual(source);expect(await adoptManagedRun('destination',bundle,deps)).toEqual(adopted)}finally{for(const store of stores)store.close();await Promise.all(dbs.map(db=>db.$disconnect()))}
 })
})

describe('portable journal completeness and compatibility',()=>{
 it('rejects a stripped journal or legacy downgrade even after a new checksum is calculated',async()=>{
  const e=await retained(),bundle=await exportManagedRun(e.job,e.authority,[e.input],e.clock()),dest=destination(e),stripped=structuredClone(bundle)
  stripped.recoveryJournal!.familyReceipts=[];stripped.recoveryJournal!.recoveryDispositionHistory=[];rehash(stripped);await expect(adoptManagedRun('destination',stripped,dest.deps)).rejects.toThrow('omitted')
  const legacy:any=structuredClone(bundle);legacy.schema='managed-production-bundle/1';for(const key of ['recoveryJournal','executionAllowed','ownershipChanged','automaticallyResumed','budgetReset'])delete legacy[key];rehash(legacy);await expect(adoptManagedRun('destination',legacy,dest.deps)).rejects.toThrow('omitted');expect(dest.job()).toBeUndefined()
 })
 it('collects original family receipts even when local job metadata does not list them',async()=>{
  const e=await retained();delete e.job.recoveryDispositionHistory;const before=e.state(),bundle=await exportManagedRun(e.job,e.authority,[e.input],e.clock());expect(bundle.schema).toBe('managed-production-bundle/2');expect(bundle.recoveryJournal!.familyReceipts).toEqual([e.receipt]);expect(e.state()).toEqual(before)
 })
 it('holds if the connected relay lacks compatible read-only proof support',async()=>{
  const e=await retained(),before=e.state(),ready=e.authority.ready;e.authority.ready=async capabilities=>{if(capabilities?.includes('portable-recovery-journal/1'))throw Error('missing compatible capability');return ready(capabilities)}
  await expect(exportManagedRun(e.job,e.authority,[e.input],e.clock())).rejects.toThrow('capability');expect(e.state()).toEqual(before)
 })
 it('read-only lookup never creates a missing audit and fences role/workspace mismatch',async()=>{
  const e=await retained('unconfirmed'),before=e.state();const response=await e.request('/managed/recovery/disposition',{schema:RECOVERY_DISPOSITION_SCHEMA,workspaceId:'workspace',action:'receipt',unit:e.unit,eventId:e.intent.eventId});expect(response.status).toBe(200);expect(await response.json()).toBeNull();expect(e.state()).toEqual(before)
  const denied=await e.request('/managed/recovery/disposition',{schema:RECOVERY_DISPOSITION_SCHEMA,workspaceId:'workspace',action:'receipt',unit:e.unit,eventId:e.intent.eventId},phone);expect(denied.status).not.toBe(200)
 })
 it('keeps authentic pending identity data unchanged on an idempotent adoption retry',async()=>{
  const e=await retained('unconfirmed'),bundle=await exportManagedRun(e.job,e.authority,[e.input],e.clock()),dest=destination(e),adopted=await adoptManagedRun('destination',bundle,dest.deps);dest.set({...adopted,pendingRecoveryDisposition:{...adopted.pendingRecoveryDisposition!,inspectionToken:'e'.repeat(64)}});await expect(adoptManagedRun('destination',bundle,dest.deps)).rejects.toThrow('decision changed')
 })
})

describe('portable origin and runtime capability fences',()=>{
 it('advertises read-only journal capability while new recovery flags remain off',async()=>{const e=await retained();delete e.env.MANAGED_AUTOMATIC_RECOVERY;const readiness=await(await e.request('/managed/readiness')).json();expect(readiness.result.capabilities).toContain('portable-recovery-journal/1');expect(e.env.MANAGED_AUTOMATIC_RECOVERY).toBeUndefined()})
 it('cannot substitute the source adoption receipt on an idempotent retry',async()=>{const e=await retained(),bundle=await exportManagedRun(e.job,e.authority,[e.input],e.clock()),dest=destination(e),adopted=await adoptManagedRun('destination',bundle,dest.deps);dest.set({...adopted,adoptedFrom:{...adopted.adoptedFrom!,sourceRevision:999}});await expect(adoptManagedRun('destination',bundle,dest.deps)).rejects.toThrow('adoption receipt')})
})
