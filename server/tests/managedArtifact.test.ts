import {applyManagedBoundaryFeedback} from '../src/services/managedCropReview.js'
import {readManagedBoundaryFeedback,saveManagedBoundaryFeedback} from '../src/services/managedCropReview.js'
import {cropBounds} from '../src/services/managedBoundaryFeedback.js'
import {listExistingExports} from '../src/services/editor2Export.js'
vi.mock('../src/services/seriesProcess.js',()=>({notifySeriesProcessChanged:vi.fn()}))
import {readManagedChapterAssets,managedChapterImage,assertManagedChapterRevision} from '../src/services/managedChapterAssets.js'
import {publishChapterExport,currentChapterExport} from '../src/services/managedChapterExport.js'
import {readEffectiveReview,setDesktopReview} from '../src/services/clipper3/chapterReview.js'
import {processTimelineJson} from '../src/services/editor2Timeline.js'
import {getChapterCropMetadataBundle} from '../src/services/videoEditor2Service.js'
const editorDb=vi.hoisted(()=>({chapter:null as any}))
vi.mock('../src/index.js',()=>({prisma:{chapter:{findUnique:async()=>editorDb.chapter}}}))
import {readManagedCropReview,setManagedCropReview,cutReviewedManagedCrop,reviewedManagedCropFile} from '../src/services/managedCropReview.js'
import {managedCropReviewInput} from '../src/services/managedCropCut.js'
import {createRequire} from 'node:module'
import {afterEach,describe,expect,it,vi} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {ManagedTaskApi,type ManagedTaskEnvironment} from '../../relay/src/managedTaskApi.js'
import {artifactHash,artifactRef,validateManagedCrop,MANAGED_CROP_VALIDATOR,type ManagedCropArtifact} from '../src/services/managedCropArtifact.js'
import {ManagedArtifactDestination,importManagedArtifact,managedArtifactTransport,resolveManagedCropInput,type ManagedArtifactTransport} from '../src/services/managedArtifactImport.js'
import {MANAGED_CAPABILITIES,type ManagedOperation} from '../src/services/managedTaskProtocol.js'
import {cutManagedCrop,readManagedCropCut} from '../src/services/managedCropCut.js'
import {workingFiles} from '../src/services/workingFiles.js'
import {onManagedCropProjectionChange} from '../src/services/managedCropEvents.js'
import {bindManagedCrop,readManagedCrop,withManagedChapterLock,withUnmanagedCropWrite} from '../src/services/managedCropProjection.js'
import {readImagePoints,readImageMetadata,listPointedImageStems,listMetadataImageStems,writeImagePoints,writeImageMetadata,deleteImagePoints,deleteImageMetadata,getPointsFilePathFor} from '../src/services/clipper3/perImageStore.js'
import {readChapterCropState,runChapterCrop} from '../src/services/clipper3/chapterCrop.js'
import {syncChapterProcessed,unsyncChapterProcessed} from '../src/services/clipper3/processedSync.js'
import {cutImageCrops} from '../src/services/clipper3/perImageCrop.js'
import {resetChapterClipping,newPageReplacement} from '../src/services/chapterPageReplacement.js'
import type {TaskSql} from '../../relay/src/taskAuthority.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite')
const studio='s'.repeat(40),phone='p'.repeat(40),foreign='f'.repeat(40)
const opened:InstanceType<typeof DatabaseSync>[]=[],folders:string[]=[]
const previousDownloadRoot=process.env.DOWNLOAD_ROOT
afterEach(async()=>{vi.restoreAllMocks();if(previousDownloadRoot===undefined)delete process.env.DOWNLOAD_ROOT;else process.env.DOWNLOAD_ROOT=previousDownloadRoot;for(const db of opened.splice(0))db.close();for(const f of folders.splice(0))await fs.rm(f,{recursive:true,force:true})})
const encode=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v))
class Bucket {
 objects=new Map<string,Uint8Array>();puts=0;afterGet:(()=>void|Promise<void>)|null=null;afterPut:(()=>void|Promise<void>)|null=null
 async get(key:string) {const b=this.objects.get(key);await this.afterGet?.();return b?{size:b.length,arrayBuffer:async()=>new Uint8Array(b).buffer}:null}
 async put(key:string,b:Uint8Array,options:any) {expect(options.onlyIf.etagDoesNotMatch).toBe('*');if(this.objects.has(key))return null;this.puts++;this.objects.set(key,new Uint8Array(b));await this.afterPut?.();return {key}}
}
async function setup(filename='page.png',pageId='page') {
 const db=new DatabaseSync(':memory:');opened.push(db)
 const sql:TaskSql={exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows}}}
 const tx=<T>(work:()=>T)=>{db.exec('BEGIN IMMEDIATE');try{const r=work();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}
 const bucket=new Bucket(),env:ManagedTaskEnvironment={MANAGED_AUTOMATIC_RECOVERY:'1',MANAGED_CROP_PAGE:'1',MANAGED_WORKSPACE_ID:'workspace',MANAGED_STUDIO_TOKEN:studio,MANAGED_DEVICE_TOKENS:JSON.stringify({'phone':phone,'foreign':foreign}),MANAGED_ARTIFACTS:bucket}
 let now=Date.parse('2026-10-19T00:00:00Z')
 const make=()=>new ManagedTaskApi(sql,tx,env,()=>new Date(now).toISOString()),api=make()
 async function send(op:Record<string,unknown>,token=studio) {return api.handle(new Request('https://relay.invalid/managed/operation',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({schema:'managed-task/1',workspaceId:'workspace',eventId:crypto.randomUUID(),...op})}))}
 const source=await sharp({create:{width:100,height:200,channels:3,background:'white'}}).png().toBuffer(),sourceHash=await artifactHash(source)
 const identity={workspaceId:'workspace',seriesId:'series',chapterId:'chapter',pageId},spec={version:'crop-page/1' as const,provider:'chatgpt' as const,product:'web',model:'owner-model',settings:{mode:'Chat',effort:null},pageRevision:'r1',promptVersion:'p1',validatorVersion:MANAGED_CROP_VALIDATOR,dependencies:[{id:pageId,revision:'r1',sha256:sourceHash}]}
 await send({action:'hello',capabilities:[...MANAGED_CAPABILITIES],profileIds:['profile'],apkVersion:'1.0.999'},phone)
 await send({action:'enroll',deviceId:'phone',profileId:'profile'})
 const task=(await(await send({action:'plan',identity,spec})).json()).result
 const claim=(await(await send({action:'claim',taskId:task.id,deviceId:'phone',profileId:'profile',accountId:null})).json()).result
 const fence={taskId:task.id,attemptId:claim.attempt.id,generation:1,fingerprint:task.fingerprint}
 for(const phase of ['accepted','started','submission_intent','result_saved'])expect((await send({action:'checkpoint',...fence,commandId:claim.command.id,phase,checkpointRef:phase==='result_saved'?'checkpoint/result':null},phone)).status).toBe(200)
 const pointers={format:'four-point-crop',version:'1.0',coordinateSystem:'normalized',image:{filename,width:100,height:200},crops:[{id:'crop-01',reason:'panel',crop:{mode:'rectangle',points:[{id:'P1',x:0,y:0},{id:'P2',x:1,y:0},{id:'P3',x:1,y:1},{id:'P4',x:0,y:1}]}}]}
 const metadata={crops:[{id:'crop-01',exportedFilename:'series_page_01_panel.png',description:'A visible panel'}]}
 const document:ManagedCropArtifact={schema:'managed-crop-page/1',...fence,checkpointRef:'checkpoint/result',pageRevision:'r1',validatorVersion:MANAGED_CROP_VALIDATOR,pointers:JSON.stringify(pointers),metadata:JSON.stringify(metadata)}
 const hash=await artifactHash(encode(document)),operation={schema:'managed-task/1',workspaceId:'workspace',eventId:'stage-event',action:'stage',...fence,artifactId:'artifact',ref:artifactRef(task,claim.attempt.id,'artifact'),contentHash:hash}
 const upload=(op=operation,doc:any=document,token=phone,instance=api)=>instance.handle(new Request('https://relay.invalid/managed/artifacts',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({operation:op,document:JSON.stringify(doc)})}))
 const load=()=>api.handle(new Request('https://relay.invalid/managed/artifacts/artifact',{headers:{Authorization:'Bearer '+studio}}))
 const publish=(change:Record<string,unknown>={})=>send({action:'publish',eventId:'publish-event',...fence,artifactId:'artifact',contentHash:hash,validationRef:'validation/local',...change})
 const current=async()=>({identity,spec,source:{filename,width:100,height:200,sha256:sourceHash}})
 const transport:ManagedArtifactTransport={load:async()=>{const raw=await(await load()).json();return {record:raw.record,task:raw.task,attempt:raw.attempt,bytes:new TextEncoder().encode(raw.document)}},publish:async op=>{const r=await send(op as unknown as Record<string,unknown>);if(r.status!==200)throw new Error(await r.text());return r.json()}}
 return {db,sql,env,api,make,bucket,task,claim,fence,document,pointers,metadata,operation,hash,source,identity,spec,upload,load,publish,send,current,transport,advance:()=>now+=300_001}
}
async function directory(){const folder=await fs.mkdtemp(path.join(os.tmpdir(),'managed-artifact-'));folders.push(folder);return folder}
describe('managed artifact bytes, destination and publication',()=>{
 it('sends normal and recovered coordinator publications through the real HTTP adapter',async()=>{
  const calls=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify({schema:'managed-task/1',result:{accepted:true}}),{status:200}))
  const transport=managedArtifactTransport('https://relay.example/','workspace',studio)
  try {
   for(const recovered of [false,true]) {
    const operation={schema:'managed-task/1',action:'publish_production',workspaceId:'workspace',eventId:'publish-test',taskId:'task:sha256:'+'a'.repeat(64),attemptId:'attempt',generation:3,fingerprint:'b'.repeat(64),artifactId:'crop_test',contentHash:'c'.repeat(64),validationRef:'destination/test',coordinatorId:'coordinator',coordinatorGeneration:4,recovered} as ManagedOperation
    await transport.publish(operation)
    const [url,init]=calls.mock.calls.at(-1)!
    expect(String(url)).toBe('https://relay.example/managed/operation')
    expect(JSON.parse(init!.body as string)).toEqual(operation)
    const count=calls.mock.calls.length
    await expect(transport.publish({...operation,workspaceId:'foreign'})).rejects.toThrow('Invalid publication operation')
    await expect(transport.publish({...operation,action:'stop'} as ManagedOperation)).rejects.toThrow('Invalid publication operation')
    expect(calls).toHaveBeenCalledTimes(count)
   }
  } finally {calls.mockRestore()}
 })
 it('stores immutable bytes, validates actual object readback and replays across authority restart',async()=>{
  const e=await setup();expect((await e.upload()).status).toBe(200);expect((await e.upload(e.operation,e.document,phone,e.make())).status).toBe(200)
  expect(e.bucket.puts).toBe(1);expect(e.db.prepare('SELECT slots FROM managed_artifact_budget').get().slots).toBe(1)
  const raw=await(await e.load()).json();expect(raw.document).toBe(JSON.stringify(e.document));expect(raw.record.sha256).toBe(e.hash)
  expect((await e.publish()).status).toBe(200);expect((await e.publish()).status).toBe(200)
 })
 it('rejects a metadata-only stage and fails closed without object storage',async()=>{
  const e=await setup();expect((await e.send(e.operation,phone)).status).toBe(409)
  delete e.env.MANAGED_ARTIFACTS;expect((await e.upload()).status).toBe(503)
 })
 it('fences upload roles, device, hash, revision and known validator before writing bytes',async()=>{
  const e=await setup()
  expect((await e.upload(e.operation,e.document,studio)).status).toBe(403)
  expect((await e.upload(e.operation,e.document,foreign)).status).toBe(409)
  expect((await e.upload({...e.operation,contentHash:'a'.repeat(64)})).status).toBe(409)
  for(const change of [{generation:2},{checkpointRef:'checkpoint/other'},{pageRevision:'r2'},{validatorVersion:'future/1'},{extra:true}])expect((await e.upload(e.operation,{...e.document,...change})).status).toBe(409)
  expect(e.bucket.puts).toBe(0)
 })
 it('rejects malformed crop geometry and unsafe or mismatched metadata',async()=>{
  const e=await setup(),owner=await(await e.api.handle(new Request('https://relay.invalid/managed/tasks/'+e.task.id,{headers:{Authorization:'Bearer '+studio}}))).json()
  expect(()=>validateManagedCrop(new TextEncoder().encode('\uFEFF'+JSON.stringify(e.document)),owner.task,owner.attempt)).toThrow('JSON')
  for(const alter of [
   (p:any,m:any)=>p.crops[0].crop.points[0].x=-1,
   (p:any,m:any)=>p.crops[0].crop.points[2]=p.crops[0].crop.points[0],
   (p:any,m:any)=>m.crops[0].id='other',
   (p:any,m:any)=>m.crops[0].exportedFilename='../other.png',
   (p:any,m:any)=>m.crops[0].description='',
  ]) {const p=structuredClone(e.pointers),m=structuredClone(e.metadata);alter(p,m);expect(()=>validateManagedCrop(encode({...e.document,pointers:JSON.stringify(p),metadata:JSON.stringify(m)}),owner.task,owner.attempt)).toThrow()}
 })
 it('keeps explicit empty crop results valid without fabricating metadata or acknowledgments',async()=>{
  const e=await setup(),p={...e.pointers,crops:[]},doc={...e.document,pointers:JSON.stringify(p),metadata:'{"crops":[]}'}
  const hash=await artifactHash(encode(doc));expect((await e.upload({...e.operation,contentHash:hash},doc)).status).toBe(200)
 })
 it('allocates only one upload per task and charges abandoned slots to the pilot storage bound',async()=>{
  const e=await setup();expect((await e.upload()).status).toBe(200)
  expect((await e.upload({...e.operation,eventId:'second',artifactId:'second',ref:artifactRef(e.task,e.claim.attempt.id,'second')})).status).toBe(409)
  expect(e.bucket.puts).toBe(1)
  const other=await setup();other.db.prepare('INSERT INTO managed_artifact_budget VALUES (1,64000000,1)').run()
  expect((await other.upload()).status).toBe(409);expect(other.bucket.puts).toBe(0)
 })
 it('detects object replacement and prevents completion from hash-only declarations',async()=>{
  const e=await setup();await e.upload();e.bucket.objects.set(e.operation.ref,encode({corrupt:true}))
  expect((await e.publish()).status).toBe(409)
  expect(e.db.prepare('SELECT body FROM managed_tasks').get().body).not.toContain('verified_complete')
 })
 it('rechecks cancellation after asynchronous object validation',async()=>{
  const e=await setup();await e.upload();let stopped=false
  e.bucket.afterGet=async()=>{if(!stopped){stopped=true;await e.send({action:'stop',taskId:e.task.id,cancel:true})}}
  expect((await e.publish()).status).toBe(409)
 })
 it('preserves late bytes after cancellation but never makes them canonical',async()=>{
  const e=await setup();e.bucket.afterPut=async()=>{await e.send({action:'stop',taskId:e.task.id,cancel:true})}
  expect((await e.upload()).status).toBe(200);expect((await e.publish()).status).toBe(409);expect(e.bucket.objects.size).toBe(1)
 })
 it('rejects publication after lease expiry and cross-artifact fences',async()=>{
  const e=await setup();await e.upload();expect((await e.publish({generation:2})).status).toBe(409)
  e.advance();expect((await e.publish()).status).toBe(409)
 })
 it('reads and hashes the real local source rather than trusting declared revisions',async()=>{
  const e=await setup(),root=await directory(),file=path.join(root,'page.png');await fs.writeFile(file,e.source)
  expect((await resolveManagedCropInput(e.identity,e.spec,file)).source.sha256).toBe(e.spec.dependencies[0].sha256)
  await fs.writeFile(file,await sharp(e.source).resize(50,50).png().toBuffer())
  await expect(resolveManagedCropInput(e.identity,e.spec,file)).rejects.toThrow('dependency')
 })
 it('durably validates local bytes before publication and recovers a lost acknowledgment with the same event',async()=>{
  const e=await setup();await e.upload();const root=await directory(),destination=new ManagedArtifactDestination(root)
  const original=e.transport.publish;let lost=true;const operations:ManagedOperation[]=[]
  e.transport.publish=async op=>{operations.push(op);const r=await original(op);if(lost){lost=false;throw new Error('lost ACK')}return r}
  await expect(importManagedArtifact(e.transport,destination,'artifact',e.current)).rejects.toThrow('lost ACK')
  const result=await importManagedArtifact(e.transport,new ManagedArtifactDestination(root),'artifact',e.current)
  expect(await fs.readFile(result.path,'utf8')).toBe(JSON.stringify(e.document));expect(result.task.state).toBe('verified_complete');expect(operations[1]).toEqual(operations[0])
  expect((await fs.readdir(root)).sort()).toEqual([e.task.id.slice(12)])
 })
 it('retains a historical local result when current input changes before publication',async()=>{
  const e=await setup();await e.upload();let calls=0;const publish=vi.spyOn(e.transport,'publish'),root=await directory()
  await expect(importManagedArtifact(e.transport,new ManagedArtifactDestination(root),'artifact',async()=>{const v=await e.current();return ++calls===1?v:{...v,spec:{...v.spec,pageRevision:'r2'}}})).rejects.toThrow('revision changed')
  expect(publish).not.toHaveBeenCalled();expect(await fs.readdir(root)).toEqual([e.task.id.slice(12)])
 })
 it('refuses another source filename/dimensions and corrupt destination files',async()=>{
  const e=await setup();await e.upload();const destination=new ManagedArtifactDestination(await directory())
  await expect(importManagedArtifact(e.transport,destination,'artifact',async()=>({...await e.current(),source:{...(await e.current()).source,filename:'other.png'}}))).rejects.toThrow('current source')
  const snapshot=await e.transport.load('artifact'),staged=await destination.stage(snapshot);await fs.writeFile(staged.path,'bad')
  await expect(importManagedArtifact(e.transport,destination,'artifact',e.current)).rejects.toThrow('conflict')
 })
 it('rejects publication acknowledgments for another workspace or artifact attempt',async()=>{
  const e=await setup();await e.upload();const original=e.transport.publish
  e.transport.publish=async op=>{const result=await original(op) as any;result.result.task.workspaceId='other-workspace';return result}
  await expect(importManagedArtifact(e.transport,new ManagedArtifactDestination(await directory()),'artifact',e.current)).rejects.toThrow('acknowledgment')
 })
 it('refuses symlink destinations and insecure/shared credential transports',async()=>{
  const e=await setup();await e.upload();const root=await directory(),outside=await directory();await fs.symlink(outside,path.join(root,e.task.id.slice(12)))
  await expect(importManagedArtifact(e.transport,new ManagedArtifactDestination(root),'artifact',e.current)).rejects.toThrow('symlink')
  for(const url of ['http://relay.example/','https://name:secret@relay.example/','https://relay.example/?token=x'])expect(()=>managedArtifactTransport(url,'workspace',studio)).toThrow()
  expect(()=>managedArtifactTransport('https://relay.example/','workspace',studio,studio)).toThrow()
 })
})

async function boundPage() {
 const e=await setup(),root=await directory(),folder='Series/Chapter 001'
 process.env.DOWNLOAD_ROOT=root
 await fs.mkdir(path.join(root,folder),{recursive:true});await fs.writeFile(path.join(root,folder,'page.png'),e.source)
 const destination=new ManagedArtifactDestination(path.join(root,'private-managed'))
 await writeImagePoints(folder,'page.png',{...e.pointers,crops:[]} as any)
 await writeImageMetadata(folder,'page.png','{"crops":[],"legacy":true}')
 await bindManagedCrop(folder,'page.png',e.task,destination.rootPath)
 const publish=async()=>{await e.upload();return importManagedArtifact(e.transport,destination,'artifact',e.current)}
 return {...e,root,folder,destination,publish}
}
describe('managed crop projections in existing readers and mutation boundaries',()=>{
 it('keeps a bound page pending despite old legacy files, with no authority polling',async()=>{
  const e=await boundPage(),fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No network reads'))
  expect(await readImagePoints(e.folder,'page.png')).toBeNull();expect(await readImageMetadata(e.folder,'page.png')).toBeNull()
  expect(await listPointedImageStems(e.folder)).toEqual(new Set());expect(await listMetadataImageStems(e.folder)).toEqual(new Set())
  expect(fetch).not.toHaveBeenCalled();expect(await fs.readFile(getPointsFilePathFor(e.folder,'page.png'),'utf8')).toContain('"crops": []')
 })
 it('reads the verified pair and chapter Done projection without copying into legacy paths',async()=>{
  const e=await boundPage();await e.publish()
  const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No network reads'))
  expect((await readImagePoints(e.folder,'page.png'))?.text).toBe(e.document.pointers)
  expect(await readImageMetadata(e.folder,'page')).toBe(e.document.metadata)
  expect(await listPointedImageStems(e.folder)).toEqual(new Set(['page']))
  const state=await readChapterCropState({folderPath:e.folder,series:{title:'series'}})
  expect(state.fullyAttached).toBe(true);expect(state.targets).toHaveLength(1);expect(state.outputs.complete).toBe(false)
  expect(fetch).not.toHaveBeenCalled();expect(await fs.readFile(getPointsFilePathFor(e.folder,'page.png'),'utf8')).toContain('"crops": []')
 })
 it('refuses legacy edits/deletes while leaving unbound pages writable',async()=>{
  const e=await boundPage()
  for(const work of [()=>writeImagePoints(e.folder,'page.png',e.pointers as any),()=>writeImageMetadata(e.folder,'page.png','{}'),()=>deleteImagePoints(e.folder,'page.png'),()=>deleteImageMetadata(e.folder,'page.png')])await expect(work()).rejects.toThrow('managed')
  await writeImageMetadata(e.folder,'other.png','unbound');expect(await readImageMetadata(e.folder,'other.png')).toBe('unbound')
 })
 it('blocks legacy Sync/Unsync, clipping reset, direct cut and chapter cleanup before mutation',async()=>{
  const e=await boundPage();await e.publish()
  const input={chapterId:'chapter',chapterNumber:1,folderPath:e.folder,seriesSlug:'series',images:[{filename:'page.png',width:100,height:200}]}
  await expect(syncChapterProcessed(input)).rejects.toThrow('managed')
  await expect(unsyncChapterProcessed(input)).rejects.toThrow('managed')
  await expect(resetChapterClipping(e.folder,newPageReplacement())).rejects.toThrow('managed')
  await expect(cutImageCrops({folderPath:e.folder,imageFilename:'page.png',crops:e.pointers.crops as any,slug:'series'})).rejects.toThrow('managed')
  const io={emit:vi.fn()};await runChapterCrop(io as any,{id:'chapter',number:1,folderPath:e.folder,seriesId:'series',series:{title:'series'}},[])
  expect(io.emit).toHaveBeenCalledWith('clipper3:crop-complete',expect.objectContaining({error:expect.stringContaining('managed')}))
  await expect(fs.stat(path.join(e.root,e.folder,'crops3'))).rejects.toMatchObject({code:'ENOENT'})
 })
 it('never reuses verified data for changed source bytes or another image extension',async()=>{
  const e=await boundPage();await e.publish();expect(await readImagePoints(e.folder,'page.webp')).toBeNull()
  await fs.writeFile(path.join(e.root,e.folder,'page.png'),await sharp(e.source).resize(40,40).png().toBuffer())
  expect(await readImagePoints(e.folder,'page.png')).toBeNull();expect(await listMetadataImageStems(e.folder)).toEqual(new Set())
  expect((await readChapterCropState({folderPath:e.folder,series:{title:'series'}})).fullyAttached).toBe(false)
 })
 it('keeps the guard after disablement and fails closed for corrupt binding or artifact evidence',async()=>{
  const e=await boundPage(),published=await e.publish()
  await fs.writeFile(published.path,'corrupt')
  await expect(readImagePoints(e.folder,'page.png')).rejects.toThrow('checksum')
  await fs.writeFile(path.join(e.root,e.folder,'.managed-crops/page.json'),'{}')
  await expect(readImageMetadata(e.folder,'page.png')).rejects.toThrow('binding')
  await expect(writeImageMetadata(e.folder,'page.png','{}')).rejects.toThrow()
 })
 it('replays publication and the local receipt after a lost acknowledgment without a new task',async()=>{
  const e=await boundPage();await e.upload();const original=e.transport.publish;let lost=true
  e.transport.publish=async op=>{const value=await original(op);if(lost){lost=false;throw new Error('lost reply')}return value}
  await expect(importManagedArtifact(e.transport,e.destination,'artifact',e.current)).rejects.toThrow('lost reply')
  expect(await readManagedCrop(e.folder,'page.png')).toBeNull()
  await importManagedArtifact(e.transport,new ManagedArtifactDestination(e.destination.rootPath),'artifact',e.current)
  expect((await readImagePoints(e.folder,'page.png'))?.text).toBe(e.document.pointers)
  expect(e.db.prepare('SELECT COUNT(*) AS n FROM managed_attempts').get().n).toBe(1)
 })
 it('requires compare-and-swap for a new input binding and keeps old publication historical',async()=>{
  const e=await boundPage();await e.publish()
  const next=(await(await e.send({action:'plan',identity:e.identity,spec:{...e.spec,promptVersion:'p2'}})).json()).result
  await expect(bindManagedCrop(e.folder,'page.png',next,e.destination.rootPath)).rejects.toThrow('changed')
  await bindManagedCrop(e.folder,'page.png',next,e.destination.rootPath,e.task.id)
  expect(await readImagePoints(e.folder,'page.png')).toBeNull()
  expect((await e.destination.readPublished(e.task))?.record.id).toBe('artifact')
 })
 it('does not count old PNGs as a managed cut and notifies caches outside the download watcher',async()=>{
  const changed=vi.fn(),unsubscribe=onManagedCropProjectionChange(changed)
  try {
   const e=await boundPage();await e.publish()
   await fs.mkdir(path.join(e.root,e.folder,'crops3'),{recursive:true})
   await fs.writeFile(path.join(e.root,e.folder,'crops3',e.metadata.crops[0].exportedFilename),e.source)
   const state=await readChapterCropState({folderPath:e.folder,series:{title:'series'}})
   expect(state.fullyAttached).toBe(true);expect(state.outputs.missing).toBe(0);expect(state.outputs.changed).toBeGreaterThan(0);expect(state.outputs.complete).toBe(false)
   expect(changed.mock.calls.length).toBeGreaterThanOrEqual(2)
  } finally {unsubscribe()}
 })
 it('requires both the publication index and the matching local validation receipt',async()=>{
  const e=await boundPage(),published=await e.publish()
  const index=path.join(e.destination.rootPath,e.task.id.slice(12),'publication.json'),saved=await fs.readFile(index)
  await fs.rm(index);expect(await readImagePoints(e.folder,'page.png')).toBeNull()
  await fs.writeFile(index,saved)
  await fs.writeFile(path.join(path.dirname(published.path),'validation.json'),'{}')
  await expect(readImagePoints(e.folder,'page.png')).rejects.toThrow('receipt')
 })
 it('preserves durable bindings during working-file cleanup of a chapter or its parent series',async()=>{
  const e=await boundPage()
  expect(await workingFiles(path.join(e.root,'Series'),false)).toBe(0)
  await expect(workingFiles(path.join(e.root,'Series'),true)).rejects.toThrow('Managed crop tasks')
  expect(await fs.stat(path.join(e.root,e.folder,'page.png'))).toBeTruthy()
  await expect(writeImageMetadata(e.folder,'page.png','late')).rejects.toThrow('managed')
 })
 it('serializes registration with an in-flight legacy mutation and cleans up failed locks',async()=>{
  const e=await setup(),root=await directory(),folder='Series/Chapter';process.env.DOWNLOAD_ROOT=root
  await fs.mkdir(path.join(root,folder),{recursive:true});await fs.writeFile(path.join(root,folder,'page.png'),e.source)
  let release!:()=>void,entered!:()=>void
  const ready=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r)
  const mutation=withUnmanagedCropWrite(folder,'page.png',async()=>{entered();await wait;await writeImageMetadata(folder,'page.png','legacy before binding')})
  await ready
  let registered=false;const binding=bindManagedCrop(folder,'page.png',e.task,path.join(root,'managed')).then(()=>registered=true)
  await new Promise(r=>setTimeout(r,10));expect(registered).toBe(false);release();await mutation;await binding
  await expect(writeImageMetadata(folder,'page.png','late')).rejects.toThrow('managed')
  await expect(withManagedChapterLock(folder,async()=>{throw new Error('test')})).rejects.toThrow('test')
  expect(await withManagedChapterLock(folder,async()=>42)).toBe(42)
 })
})

describe('revision-bound managed cut derivatives',()=>{
 it('cuts exact verified geometry to immutable private output and reuses it on restart',async()=>{
  const e=await boundPage();await e.publish()
  expect(await readManagedCropCut(e.folder,'page.png')).toBeNull()
  const cut=await cutManagedCrop(e.folder,'page.png')
  expect(cut.taskId).toBe(e.task.id);expect(cut.files).toHaveLength(1)
  expect(cut.files[0]).toMatchObject({filename:e.metadata.crops[0].exportedFilename,width:100,height:200})
  const before=await fs.stat(cut.files[0].path)
  expect((await readManagedCropCut(e.folder,'page.png'))?.files).toEqual(cut.files)
  expect(await cutManagedCrop(e.folder,'page.png')).toEqual(cut)
  expect((await fs.stat(cut.files[0].path)).mtimeMs).toBe(before.mtimeMs)
  await expect(fs.stat(path.join(e.root,e.folder,'crops3'))).rejects.toMatchObject({code:'ENOENT'})
  expect((await readChapterCropState({folderPath:e.folder,series:{title:'series'}})).outputs.complete).toBe(false)
 })
 it('does not render pending publication or silently reuse output for changed source bytes',async()=>{
  const e=await boundPage()
  await expect(cutManagedCrop(e.folder,'page.png')).rejects.toThrow('Verified')
  await e.publish();await cutManagedCrop(e.folder,'page.png')
  await fs.writeFile(path.join(e.root,e.folder,'page.png'),await sharp(e.source).resize(50,50).png().toBuffer())
  await expect(cutManagedCrop(e.folder,'page.png')).rejects.toThrow('dependency')
  await expect(readManagedCropCut(e.folder,'page.png')).rejects.toThrow('dependency')
 })
 it('fails closed on corrupt, missing or additional PNG files and never regenerates over them',async()=>{
  const e=await boundPage();await e.publish();const cut=await cutManagedCrop(e.folder,'page.png')
  const image=await fs.readFile(cut.files[0].path)
  await fs.writeFile(cut.files[0].path,'bad')
  await expect(cutManagedCrop(e.folder,'page.png')).rejects.toThrow('checksum')
  await fs.writeFile(cut.files[0].path,image);await fs.writeFile(path.join(path.dirname(cut.receiptPath),'extra.png'),'extra')
  await expect(readManagedCropCut(e.folder,'page.png')).rejects.toThrow('unverified')
  await fs.rm(path.join(path.dirname(cut.receiptPath),'extra.png'));await fs.rm(cut.files[0].path)
  await expect(cutManagedCrop(e.folder,'page.png')).rejects.toThrow()
 })
 it('rejects changed cut receipts and symlinked publication directories',async()=>{
  const e=await boundPage();await e.publish();const cut=await cutManagedCrop(e.folder,'page.png')
  const receipt=JSON.parse(await fs.readFile(cut.receiptPath,'utf8'));receipt.sourceHash='a'.repeat(64)
  await fs.writeFile(cut.receiptPath,JSON.stringify(receipt))
  await expect(readManagedCropCut(e.folder,'page.png')).rejects.toThrow('fence')
  const dir=path.dirname(cut.receiptPath),old=dir+'-old';await fs.rename(dir,old);await fs.symlink(old,dir)
  await expect(cutManagedCrop(e.folder,'page.png')).rejects.toThrow('directory')
 })
 it('serializes concurrent cuts and leaves one complete file set',async()=>{
  const e=await boundPage();await e.publish()
  const results=await Promise.all([cutManagedCrop(e.folder,'page.png'),cutManagedCrop(e.folder,'page.png')])
  expect(results[0]).toEqual(results[1])
  expect(await fs.readdir(path.dirname(results[0].receiptPath))).toEqual(expect.arrayContaining(['receipt.json',e.metadata.crops[0].exportedFilename]))
  expect((await fs.readdir(path.dirname(path.dirname(results[0].receiptPath))))).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\.cut-/)]))
 })
 it('retains a historical cut but refuses completion if the source changes at directory commit',async()=>{
  const e=await boundPage();await e.publish();const rename=fs.rename.bind(fs)
  const changed=await sharp(e.source).resize(50,50).png().toBuffer()
  vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{if(String(to).endsWith('cuts-v1'))await fs.writeFile(path.join(e.root,e.folder,'page.png'),changed);return rename(from,to)})
  await expect(cutManagedCrop(e.folder,'page.png')).rejects.toThrow('dependency')
  await expect(readManagedCropCut(e.folder,'page.png')).rejects.toThrow('dependency')
  expect((await readChapterCropState({folderPath:e.folder,series:{title:'series'}})).outputs.complete).toBe(false)
 })
 it('publishes an explicit empty cut with a receipt and no fabricated PNG files',async()=>{
  const e=await setup(),root=await directory(),folder='Series/Empty';process.env.DOWNLOAD_ROOT=root
  await fs.mkdir(path.join(root,folder),{recursive:true});await fs.writeFile(path.join(root,folder,'page.png'),e.source)
  const doc={...e.document,pointers:JSON.stringify({...e.pointers,crops:[]}),metadata:'{"crops":[]}'}
  const hash=await artifactHash(encode(doc))
  expect((await e.upload({...e.operation,contentHash:hash},doc)).status).toBe(200)
  const destination=new ManagedArtifactDestination(path.join(root,'managed'))
  await importManagedArtifact(e.transport,destination,'artifact',e.current)
  await bindManagedCrop(folder,'page.png',e.task,destination.rootPath)
  const result=await cutManagedCrop(folder,'page.png');expect(result.files).toEqual([])
  expect(await fs.readdir(path.dirname(result.receiptPath))).toEqual(['receipt.json'])
  expect((await readManagedCropCut(folder,'page.png'))?.files).toEqual([])
 })
 it('does not reuse an old cut when a new input fingerprint is bound',async()=>{
  const e=await boundPage();await e.publish();const old=await cutManagedCrop(e.folder,'page.png')
  const next=(await(await e.send({action:'plan',identity:e.identity,spec:{...e.spec,promptVersion:'p2'}})).json()).result
  await bindManagedCrop(e.folder,'page.png',next,e.destination.rootPath,e.task.id)
  await expect(cutManagedCrop(e.folder,'page.png')).rejects.toThrow('Verified')
  expect(await fs.stat(old.receiptPath)).toBeTruthy()
 })
})


describe('explicit review and cut handoff for immutable managed pages',()=>{
 it('applies exact saved corrections as a new reviewed-cut input while preserving original publication and cuts',async()=>{
  const e=await boundPage();await e.publish();const original=await readManagedCropReview(e.folder,'page.png'),publication=await readManagedCrop(e.folder,'page.png')
  const oldCut=await cutManagedCrop(e.folder,'page.png');const oldBytes=await fs.readFile(oldCut.files[0].path)
  const bounds=cropBounds(original.pointers);bounds[0].top+=0.05
  const saved=await saveManagedBoundaryFeedback(e.folder,'page.png',original.taskId,original.revision,null,bounds,'owner correction')
  await expect(applyManagedBoundaryFeedback(e.folder,'page.png',original.taskId,original.revision,'wrong')).rejects.toThrow('changed')
  const applied=await applyManagedBoundaryFeedback(e.folder,'page.png',original.taskId,original.revision,saved.feedback.id)
  expect(applied.revision).not.toBe(original.revision);expect(applied.reviewed).toBe(false);expect(applied.cut.complete).toBe(false)
  expect(applied.pointers.crops[0].crop.points[0].y).toBe(bounds[0].top)
  expect(await readManagedCrop(e.folder,'page.png')).toEqual(publication)
  expect(await fs.readFile(oldCut.files[0].path)).toEqual(oldBytes)
  await expect(setManagedCropReview(e.folder,'page.png',original.revision,true)).rejects.toThrow('changed')
  await expect(cutReviewedManagedCrop(e.folder,'page.png',applied.revision)).rejects.toThrow('Review this exact')
  await setManagedCropReview(e.folder,'page.png',applied.revision,true)
  const cut=await cutReviewedManagedCrop(e.folder,'page.png',applied.revision)
  expect(cut.cut.files[0].height).toBe(oldCut.files[0].height-10)
  expect((await readManagedChapterAssets(e.folder))!.pages[0].revision).toBe(applied.revision)
  expect(await reviewedManagedCropFile(e.folder,'page.png',applied.revision,cut.cut.files[0].filename)).toEqual(await fs.readFile((await readManagedCropCut(e.folder,'page.png'))!.files[0].path))
  expect((await applyManagedBoundaryFeedback(e.folder,'page.png',original.taskId,original.revision,saved.feedback.id)).revision).toBe(applied.revision)
  await expect(saveManagedBoundaryFeedback(e.folder,'page.png',original.taskId,original.revision,saved.feedback.id,bounds,'late')).rejects.toThrow('already applied')
  const input=await managedCropReviewInput(e.folder,'page.png',true),target=path.join(input.directory,'boundary-feedback-v1.json');const f=JSON.parse(await fs.readFile(target,'utf8'));f.bounds[0].top+=0.01;await fs.writeFile(target,JSON.stringify(f))
  await expect(readManagedCropReview(e.folder,'page.png')).rejects.toThrow('changed')
 })

 it('retains manual feedback against an immutable publication and gates original review/cut',async()=>{
  const e=await boundPage();await e.publish();const original=await readManagedCropReview(e.folder,'page.png')
  const bounds=cropBounds(original.pointers);bounds[0].top+=0.05
  const saved=await saveManagedBoundaryFeedback(e.folder,'page.png',original.taskId,original.revision,null,bounds,'Include the bubble')
  expect(saved.feedback.changes).toHaveLength(1)
  expect(await readManagedCropReview(e.folder,'page.png')).toEqual(original)
  expect((await readManagedBoundaryFeedback(e.folder,'page.png')).feedback).toEqual(saved.feedback)
  await expect(setManagedCropReview(e.folder,'page.png',original.revision,true)).rejects.toThrow('pending')
  await expect(cutReviewedManagedCrop(e.folder,'page.png',original.revision)).rejects.toThrow('pending')
  await expect(saveManagedBoundaryFeedback(e.folder,'page.png',original.taskId,'f'.repeat(64),saved.feedback.id,bounds,'')).rejects.toThrow('changed')
  await expect(saveManagedBoundaryFeedback(e.folder,'page.png','other',original.revision,saved.feedback.id,bounds,'')).rejects.toThrow('Task changed')
  await saveManagedBoundaryFeedback(e.folder,'page.png',original.taskId,original.revision,saved.feedback.id,cropBounds(original.pointers),'Reset')
  await setManagedCropReview(e.folder,'page.png',original.revision,true)
  await expect(saveManagedBoundaryFeedback(e.folder,'page.png',original.taskId,original.revision,null,bounds,'')).rejects.toThrow('Unmark')
 })

 it('requires a current explicit review and never treats low-level cuts or legacy approvals as review',async()=>{
  const e=await boundPage();await e.publish()
  await fs.writeFile(path.join(e.root,e.folder,'.clipper3-review.json'),JSON.stringify({reviewed:true,by:'desktop'}))
  const before=await readManagedCropReview(e.folder,'page.png');expect(before.reviewed).toBe(false);expect(before.pointers.image).toEqual({filename:'page.png',width:100,height:200});expect(before.metadata.crops).toHaveLength(1)
  await expect(cutReviewedManagedCrop(e.folder,'page.png',before.revision)).rejects.toThrow('Review this exact')
  await cutManagedCrop(e.folder,'page.png')
  expect((await readManagedCropReview(e.folder,'page.png')).cut.complete).toBe(false)
  await setManagedCropReview(e.folder,'page.png',before.revision,true)
  const cut=await cutReviewedManagedCrop(e.folder,'page.png',before.revision)
  expect(cut.reviewed).toBe(true);expect(cut.cut.complete).toBe(true);expect(cut.cut.files).toHaveLength(1)
  expect(cut.cut.files[0]).not.toHaveProperty('path')
  expect(await reviewedManagedCropFile(e.folder,'page.png',before.revision,cut.cut.files[0].filename)).toEqual(await fs.readFile((await readManagedCropCut(e.folder,'page.png'))!.files[0].path))
  expect((await readChapterCropState({folderPath:e.folder,series:{title:'series'}})).outputs.complete).toBe(true)
 })
 it('rejects stale approval, unmark, cut and file requests without changing the review',async()=>{
  const e=await boundPage();await e.publish();const initial=await readManagedCropReview(e.folder,'page.png')
  for(const reviewed of [true,false])await expect(setManagedCropReview(e.folder,'page.png','f'.repeat(64),reviewed)).rejects.toThrow('changed')
  await expect(cutReviewedManagedCrop(e.folder,'page.png','f'.repeat(64))).rejects.toThrow('changed')
  expect((await readManagedCropReview(e.folder,'page.png')).reviewed).toBe(false)
  await setManagedCropReview(e.folder,'page.png',initial.revision,true);const cut=await cutReviewedManagedCrop(e.folder,'page.png',initial.revision)
  await expect(reviewedManagedCropFile(e.folder,'page.png','f'.repeat(64),cut.cut.files[0].filename)).rejects.toThrow('changed')
  await expect(reviewedManagedCropFile(e.folder,'page.png',initial.revision,'../'+cut.cut.files[0].filename)).rejects.toThrow('Unknown')
 })
 it('revokes output access without deleting immutable cuts and reuses verified bytes on a new approval',async()=>{
  const e=await boundPage();await e.publish();const initial=await readManagedCropReview(e.folder,'page.png')
  await setManagedCropReview(e.folder,'page.png',initial.revision,true);const cut=await cutReviewedManagedCrop(e.folder,'page.png',initial.revision)
  const file=(await readManagedCropCut(e.folder,'page.png'))!.files[0],before=await fs.stat(file.path)
  const unmarked=await setManagedCropReview(e.folder,'page.png',initial.revision,false)
  expect(unmarked.reviewed).toBe(false);expect(unmarked.cut.complete).toBe(false)
  await expect(reviewedManagedCropFile(e.folder,'page.png',initial.revision,file.filename)).rejects.toThrow('reviewed cut')
  await setManagedCropReview(e.folder,'page.png',initial.revision,true)
  expect((await cutReviewedManagedCrop(e.folder,'page.png',initial.revision)).cut.files).toEqual(cut.cut.files)
  expect((await fs.stat(file.path)).mtimeMs).toBe(before.mtimeMs)
 })
 it('rejects incomplete publication and makes changed source or binding unable to reuse an approval',async()=>{
  const e=await boundPage();await expect(readManagedCropReview(e.folder,'page.png')).rejects.toThrow('Verified')
  await e.publish();const initial=await readManagedCropReview(e.folder,'page.png');await setManagedCropReview(e.folder,'page.png',initial.revision,true)
  const source=path.join(e.root,e.folder,'page.png');await fs.writeFile(source,await sharp(e.source).resize(50,50).png().toBuffer())
  await expect(cutReviewedManagedCrop(e.folder,'page.png',initial.revision)).rejects.toThrow('dependency')
  await fs.writeFile(source,e.source)
  const next=(await(await e.send({action:'plan',identity:e.identity,spec:{...e.spec,promptVersion:'review-next'}})).json()).result
  await bindManagedCrop(e.folder,'page.png',next,e.destination.rootPath,e.task.id)
  await expect(readManagedCropReview(e.folder,'page.png')).rejects.toThrow('Verified')
 })
 it('never silently overwrites corrupt or symlinked review receipts',async()=>{
  const e=await boundPage();await e.publish();const initial=await managedCropReviewInput(e.folder,'page.png'),receipt=path.join(initial.directory,'review-v1.json')
  await fs.writeFile(receipt,JSON.stringify({schema:'managed-crop-review/1',revision:initial.revision,reviewed:'true',reviewedAt:new Date().toISOString()}))
  await expect(setManagedCropReview(e.folder,'page.png',initial.revision,true)).rejects.toThrow('review receipt')
  await fs.rm(receipt);const outside=path.join(e.root,'outside-review');await fs.writeFile(outside,'untouched');await fs.symlink(outside,receipt)
  await expect(setManagedCropReview(e.folder,'page.png',initial.revision,true)).rejects.toThrow()
  expect(await fs.readFile(outside,'utf8')).toBe('untouched')
 })
 it('does not serve or regenerate corrupt cut output',async()=>{
  const e=await boundPage();await e.publish();const initial=await readManagedCropReview(e.folder,'page.png')
  await setManagedCropReview(e.folder,'page.png',initial.revision,true);await cutReviewedManagedCrop(e.folder,'page.png',initial.revision)
  const file=(await readManagedCropCut(e.folder,'page.png'))!.files[0];await fs.writeFile(file.path,'bad')
  await expect(reviewedManagedCropFile(e.folder,'page.png',initial.revision,file.filename)).rejects.toThrow('checksum')
  await expect(cutReviewedManagedCrop(e.folder,'page.png',initial.revision)).rejects.toThrow('checksum')
  expect(await fs.readFile(file.path,'utf8')).toBe('bad')
 })
 it('rejects a source change at review commit instead of authorizing a cut',async()=>{
  const e=await boundPage();await e.publish();const initial=await readManagedCropReview(e.folder,'page.png'),rename=fs.rename.bind(fs)
  vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{if(String(to).endsWith('review-v1.json'))await fs.writeFile(path.join(e.root,e.folder,'page.png'),await sharp(e.source).resize(50,50).png().toBuffer());return rename(from,to)})
  await expect(setManagedCropReview(e.folder,'page.png',initial.revision,true)).rejects.toThrow('dependency')
  await expect(cutReviewedManagedCrop(e.folder,'page.png',initial.revision)).rejects.toThrow('dependency')
 })
 it('allows a reviewed empty result without inventing output images',async()=>{
  const e=await setup(),root=await directory(),folder='Series/Reviewed Empty';process.env.DOWNLOAD_ROOT=root
  await fs.mkdir(path.join(root,folder),{recursive:true});await fs.writeFile(path.join(root,folder,'page.png'),e.source)
  const doc={...e.document,pointers:JSON.stringify({...e.pointers,crops:[]}),metadata:'{"crops":[]}'}
  const hash=await artifactHash(encode(doc));expect((await e.upload({...e.operation,contentHash:hash},doc)).status).toBe(200)
  const destination=new ManagedArtifactDestination(path.join(root,'managed'))
  await importManagedArtifact(e.transport,destination,'artifact',e.current);await bindManagedCrop(folder,'page.png',e.task,destination.rootPath)
  const initial=await readManagedCropReview(folder,'page.png');await setManagedCropReview(folder,'page.png',initial.revision,true)
  const result=await cutReviewedManagedCrop(folder,'page.png',initial.revision)
  expect(result.cut).toEqual({complete:true,files:[]})
  expect((await readManagedChapterAssets(folder))!.assets).toEqual([])
  expect((await readEffectiveReview(folder)).reviewed).toBe(true)
 })
 it('serializes review revocation with rendering and leaves revoked bytes inaccessible',async()=>{
  const e=await boundPage();await e.publish();const initial=await readManagedCropReview(e.folder,'page.png')
  await setManagedCropReview(e.folder,'page.png',initial.revision,true)
  const [cut,revoked]=await Promise.all([cutReviewedManagedCrop(e.folder,'page.png',initial.revision),setManagedCropReview(e.folder,'page.png',initial.revision,false)])
  expect(cut.cut.complete).toBe(true);expect(revoked.reviewed).toBe(false)
  expect((await readManagedCropReview(e.folder,'page.png')).cut.complete).toBe(false)
  await expect(reviewedManagedCropFile(e.folder,'page.png',initial.revision,cut.cut.files[0].filename)).rejects.toThrow('reviewed cut')
 })

})

async function readyChapter() {
 const e=await boundPage();await e.publish()
 const review=await readManagedCropReview(e.folder,'page.png')
 await setManagedCropReview(e.folder,'page.png',review.revision,true)
 await cutReviewedManagedCrop(e.folder,'page.png',review.revision)
 editorDb.chapter={id:'chapter',number:1,title:null,folderPath:e.folder,series:{title:'Series'},audioSections:[{audioFile:null,timelineScript:'script'}]}
 return {...e,review}
}
const timelineFor=(refs:string[])=>JSON.stringify({sections:[{section:'Section 1',timelines:[{timeline:'00:00.00 - 00:02.00',selectedImages:refs}]}]})
describe('chapter inventory and Editor managed inputs',()=>{
 it('rejects legacy chapter-wide approval without writing a managed page review',async()=>{
  const e=await boundPage();await e.publish()
  await expect(setDesktopReview(e.folder,true)).rejects.toThrow('managed')
  expect((await readManagedCropReview(e.folder,'page.png')).reviewed).toBe(false)
 })
 it('projects only reviewed receipt-listed assets into metadata, previews and renderer paths',async()=>{
  const e=await readyChapter(),inventory=(await readManagedChapterAssets(e.folder))!,asset=inventory.assets[0]
  expect(asset.filename).toMatch(/^managed_[a-f0-9]{64}_[a-f0-9]{64}_0001\.png$/)
  expect((await getChapterCropMetadataBundle('chapter'))!.text).toContain(asset.filename)
  expect(e.metadata.crops[0].exportedFilename).not.toBe(asset.filename)
  const plan=await processTimelineJson('chapter',timelineFor([asset.filename]))
  expect(plan.managedCropRevision).toBe(inventory.revision);expect(plan.missingRefs).toEqual([])
  const image=plan.sections[0].slots[0].images[0]
  expect(image.imagePath).toBe(asset.path);expect(image.url).toContain('?revision='+inventory.revision)
  expect(await managedChapterImage(e.folder,inventory.revision,asset.filename)).toEqual(await fs.readFile(asset.path))
  expect((await readEffectiveReview(e.folder)).reviewed).toBe(true)
  const state=await readChapterCropState({folderPath:e.folder,series:{title:'series'}})
  expect(state.fullyAttached).toBe(true);expect(state.targets).toHaveLength(1);expect(state.outputs.complete).toBe(true)
  await expect(managedChapterImage(e.folder,'f'.repeat(64),asset.filename)).rejects.toThrow('revision')
  await expect(managedChapterImage(e.folder,inventory.revision,'../'+asset.filename)).rejects.toThrow('Unknown')
  const old=await processTimelineJson('chapter',timelineFor([asset.output,'page.png/crop-01']))
  expect(old.missingRefs).toEqual([asset.output,'page.png/crop-01'])
 })
 it('keeps page-local filenames collision-free across a fully managed chapter',async()=>{
  const e=await readyChapter(),second=await setup('page_002.png','page2')
  await fs.writeFile(path.join(e.root,e.folder,'page_002.png'),second.source)
  await bindManagedCrop(e.folder,'page_002.png',second.task,e.destination.rootPath)
  await second.upload();await importManagedArtifact(second.transport,e.destination,'artifact',second.current)
  const review=await readManagedCropReview(e.folder,'page_002.png')
  await setManagedCropReview(e.folder,'page_002.png',review.revision,true);await cutReviewedManagedCrop(e.folder,'page_002.png',review.revision)
  const inventory=(await readManagedChapterAssets(e.folder))!
  expect(inventory.pages).toHaveLength(2);expect(inventory.assets.map(file=>file.output)).toEqual([e.metadata.crops[0].exportedFilename,e.metadata.crops[0].exportedFilename])
  expect(new Set(inventory.assets.map(file=>file.filename)).size).toBe(2)
  expect((await processTimelineJson('chapter',timelineFor(inventory.assets.map(file=>file.filename)))).missingRefs).toEqual([])
 })
 it('blocks mixed chapters and ignores old chapter approval and crops3 files',async()=>{
  const e=await readyChapter()
  await fs.writeFile(path.join(e.root,e.folder,'unbound.png'),e.source)
  await fs.writeFile(path.join(e.root,e.folder,'.clipper3-review.json'),JSON.stringify({reviewed:true,by:'desktop'}))
  await expect(readManagedChapterAssets(e.folder)).rejects.toThrow('mixed')
  expect((await readEffectiveReview(e.folder)).reviewed).toBe(false)
  expect((await readChapterCropState({folderPath:e.folder,series:{title:'series'}})).outputs.complete).toBe(false)
  await expect(getChapterCropMetadataBundle('chapter')).rejects.toThrow('mixed')
  await expect(processTimelineJson('chapter',timelineFor(['legacy.png']))).rejects.toThrow('mixed')
 })
 it('invalidates all consumers on revocation, changed source or corrupt cut bytes',async()=>{
  const e=await readyChapter(),inventory=(await readManagedChapterAssets(e.folder))!,asset=inventory.assets[0]
  await setManagedCropReview(e.folder,'page.png',e.review.revision,false)
  await expect(managedChapterImage(e.folder,inventory.revision,asset.filename)).rejects.toThrow('reviewed')
  await expect(assertManagedChapterRevision(e.folder,inventory.revision)).rejects.toThrow()
  expect((await readEffectiveReview(e.folder)).reviewed).toBe(false)
  await setManagedCropReview(e.folder,'page.png',e.review.revision,true)
  await fs.writeFile(asset.path,'corrupt')
  await expect(readManagedChapterAssets(e.folder)).rejects.toThrow('checksum')
  await fs.writeFile(asset.path,await sharp(e.source).png().toBuffer())
  await fs.writeFile(path.join(e.root,e.folder,'page.png'),await sharp(e.source).resize(99,200).png().toBuffer())
  await expect(readManagedChapterAssets(e.folder)).rejects.toThrow()
 })
 it('requires a matching export receipt, rechecks publication and rejects altered MP4s',async()=>{
  const e=await readyChapter(),inventory=(await readManagedChapterAssets(e.folder))!,output=path.join(e.root,'render.mp4')
  await fs.writeFile(output,'synthetic finished MP4')
  expect(await currentChapterExport(e.folder,output)).toBe(false)
  const publish=vi.fn(async()=>fs.writeFile(output,'synthetic finished MP4'))
  await publishChapterExport(e.folder,inventory.revision,output,publish)
  expect(publish).toHaveBeenCalledOnce();expect(await currentChapterExport(e.folder,output)).toBe(true)
  await fs.writeFile(output,'different finished MP4');expect(await currentChapterExport(e.folder,output)).toBe(false)
  await setManagedCropReview(e.folder,'page.png',e.review.revision,false)
  expect(await currentChapterExport(e.folder,output)).toBe(false)
  publish.mockClear();await expect(publishChapterExport(e.folder,inventory.revision,output,publish)).rejects.toThrow()
  expect(publish).not.toHaveBeenCalled()
 })
 it('refuses render publication when an input changes in the publication callback',async()=>{
  const e=await readyChapter(),inventory=(await readManagedChapterAssets(e.folder))!,output=path.join(e.root,'render.mp4')
  await expect(publishChapterExport(e.folder,inventory.revision,output,async()=>{
   await fs.writeFile(output,'synthetic render');await fs.writeFile(path.join(e.root,e.folder,'extra.png'),e.source)
  })).rejects.toThrow('mixed')
  expect(await currentChapterExport(e.folder,output)).toBe(false)
  expect(await fs.stat(output+'.managed.json').catch(()=>null)).toBeNull()
 })
 it('keeps legacy inventories null and detects migration during a legacy render',async()=>{
  const e=await boundPage(),output=path.join(e.root,'render.mp4'),legacy='Legacy/Chapter 001'
  await fs.mkdir(path.join(e.root,legacy),{recursive:true})
  expect(await readManagedChapterAssets(legacy)).toBeNull()
  await publishChapterExport(legacy,null,output,()=>fs.writeFile(output,'legacy'))
  expect(await currentChapterExport(legacy,output)).toBe(true)
  const publish=vi.fn(async()=>{})
  await expect(publishChapterExport(e.folder,null,output,publish)).rejects.toThrow()
  expect(publish).not.toHaveBeenCalled()
 })
 it('filters existing export listings through the current managed receipt',async()=>{
  const e=await readyChapter(),inventory=(await readManagedChapterAssets(e.folder))!,dir=path.join(e.root,'Series/_video2'),output=path.join(dir,'ch001_test.mp4'),folders=new Map([[1,e.folder]])
  await fs.mkdir(dir,{recursive:true});await fs.writeFile(output,'synthetic render')
  expect((await listExistingExports('Series','en',folders)).size).toBe(0)
  await publishChapterExport(e.folder,inventory.revision,output,async()=>{})
  expect((await listExistingExports('Series','en',folders)).size).toBe(1)
  await setManagedCropReview(e.folder,'page.png',e.review.revision,false)
  expect((await listExistingExports('Series','en',folders)).size).toBe(0)
 })

})
