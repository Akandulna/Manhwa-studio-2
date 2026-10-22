import {readBoundaryApplication,applyBoundaryPointers} from './managedBoundaryFeedback.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import {constants} from 'node:fs'
import {randomUUID} from 'node:crypto'
import sharp from 'sharp'
import {managedCropBinding,withManagedChapterLock,withManagedCropWorkspaceLock} from './managedCropProjection.js'
import {ManagedArtifactDestination,resolveManagedCropInput} from './managedArtifactImport.js'
import {artifactHash,validateManagedCrop} from './managedCropArtifact.js'
import {canonicalJson,TaskConflict} from './managedTaskProtocol.js'
import {managedCropProjectionChanged} from './managedCropEvents.js'

const CUTTER='managed-crop-cut/1'
interface FileEvidence {cropId:string;filename:string;sha256:string;bytes:number;width:number;height:number}
interface CutReceipt {schema:typeof CUTTER;taskId:string;fingerprint:string;artifactId:string;artifactHash:string;sourceHash:string;boundaryHash?:string;files:FileEvidence[]}
export interface ManagedCutResult {taskId:string;fingerprint:string;files:(FileEvidence&{path:string})[];receiptPath:string}
const MAX_SOURCE=64_000_000,MAX_OUTPUT=64_000_000
async function bytes(file:string,limit:number):Promise<Buffer> {
 const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW)
 try{const stat=await handle.stat();if(!stat.isFile()||stat.size>limit)throw new TaskConflict('Managed cut file size exceeded');const value=await handle.readFile();if(value.length>limit)throw new TaskConflict('Managed cut file size exceeded');return value}finally{await handle.close()}
}
async function realDirectory(dir:string):Promise<void> {const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new TaskConflict('Managed cut directory changed')}
async function mkdir(dir:string):Promise<void> {await fs.mkdir(dir,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error});await realDirectory(dir)}
async function flush(dir:string):Promise<void> {const handle=await fs.open(dir,constants.O_RDONLY);try{await handle.sync()}finally{await handle.close()}}
async function exclusive(file:string,data:Uint8Array):Promise<void> {
 const handle=await fs.open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
 try{await handle.writeFile(data);await handle.sync()}finally{await handle.close()}
}
async function context(folder:string,filename:string,originalOnly=false) {
 const binding=await managedCropBinding(folder,filename)
 if(!binding||binding.filename!==filename)throw new TaskConflict('Exact managed crop binding required')
 const {task}=binding,{workspaceId,seriesId,chapterId,pageId}=task
 const sourcePath=path.resolve(path.join(process.env.DOWNLOAD_ROOT||'./downloads',folder,filename))
 const input=await resolveManagedCropInput({workspaceId,seriesId,chapterId,pageId},task.spec,sourcePath)
 const snapshot=await new ManagedArtifactDestination(binding.destination).readPublished(task)
 if(!snapshot)throw new TaskConflict('Verified managed crop publication required before cutting')
 const document=validateManagedCrop(snapshot.bytes,snapshot.task,snapshot.attempt,input.source)
 const pointers=JSON.parse(document.pointers),metadata=JSON.parse(document.metadata)
 const parent=path.join(binding.destination,task.id.slice(12))
 await realDirectory(binding.destination);await realDirectory(parent)
 const baseIdentity={schema:CUTTER,taskId:task.id,fingerprint:task.fingerprint,artifactId:snapshot.record.id,artifactHash:snapshot.record.sha256,sourceHash:input.source.sha256}
 const baseRevision=await artifactHash(new TextEncoder().encode(canonicalJson({...baseIdentity,filename})))
 const application=originalOnly?null:await readBoundaryApplication(parent,{taskId:task.id,revision:baseRevision,pointers})
 const boundaryHash=application?await artifactHash(new TextEncoder().encode(canonicalJson(application))):null
 const effectivePointers=application?applyBoundaryPointers(pointers,application.bounds):pointers
 const effectiveMetadata=application?{...metadata,crops:metadata.crops.filter((c:any)=>application.bounds.some(b=>b.id===c.id))}:metadata
 const cuts=path.join(parent,boundaryHash?'cuts-boundary-'+boundaryHash:'cuts-v1')
 return {binding,input,snapshot,pointers:effectivePointers,metadata:effectiveMetadata,parent,cuts,sourcePath,boundaryHash,application,baseRevision}
}
function identity(c:Awaited<ReturnType<typeof context>>) {
 return {schema:CUTTER,taskId:c.binding.task.id,fingerprint:c.binding.task.fingerprint,artifactId:c.snapshot.record.id,artifactHash:c.snapshot.record.sha256,sourceHash:c.input.source.sha256,...(c.boundaryHash?{boundaryHash:c.boundaryHash}:{})}
}
async function verify(c:Awaited<ReturnType<typeof context>>,dir:string):Promise<ManagedCutResult> {
 await realDirectory(dir)
 const receiptPath=path.join(dir,'receipt.json'),raw=JSON.parse((await bytes(receiptPath,512_000)).toString('utf8')) as CutReceipt
 if(!raw||Object.keys(raw).sort().join(',')!==Object.keys({...identity(c),files:[]}).sort().join(',')||canonicalJson({...raw,files:[]})!==canonicalJson({...identity(c),files:[]})||!Array.isArray(raw.files)||raw.files.length!==c.pointers.crops.length)throw new TaskConflict('Managed cut receipt fence mismatch')
 const expected=new Map<string,any>(c.metadata.crops.map((m:any)=>[m.id,m]))
 const entries=await fs.readdir(dir)
 if(entries.length!==raw.files.length+1||entries.some(name=>name!=='receipt.json'&&!raw.files.some(f=>f.filename===name)))throw new TaskConflict('Managed cut directory has unverified files')
 let total=0
 const files=[]
 for(let i=0;i<raw.files.length;i++) {
  const file=raw.files[i],crop=c.pointers.crops[i],meta=expected.get(crop.id)
  if(!file||Object.keys(file).sort().join(',')!=='bytes,cropId,filename,height,sha256,width'||file.cropId!==crop.id||file.filename!==meta?.exportedFilename||path.basename(file.filename)!==file.filename||/[\\\x00]/.test(file.filename)||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>MAX_OUTPUT||!Number.isSafeInteger(file.width)||!Number.isSafeInteger(file.height))throw new TaskConflict('Invalid managed cut file evidence')
  const rect=rectangle(crop,c.input.source.width,c.input.source.height)
  if(file.width!==rect.width||file.height!==rect.height)throw new TaskConflict('Managed cut dimensions differ from pointers')
  const target=path.join(dir,file.filename),data=await bytes(target,MAX_OUTPUT)
  total+=data.length;if(total>MAX_OUTPUT||data.length!==file.bytes||await artifactHash(data)!==file.sha256)throw new TaskConflict('Managed cut checksum mismatch')
  const image=await sharp(data,{limitInputPixels:100_000_000}).metadata()
  if(image.format!=='png'||image.width!==file.width||image.height!==file.height)throw new TaskConflict('Managed cut image validation failed')
  files.push({...file,path:target})
 }
 return {taskId:raw.taskId,fingerprint:raw.fingerprint,files,receiptPath}
}
function rectangle(crop:any,width:number,height:number) {
 const points=crop.crop.points as {x:number;y:number}[]
 const left=Math.round(Math.min(...points.map(p=>p.x))*width),top=Math.round(Math.min(...points.map(p=>p.y))*height)
 const right=Math.round(Math.max(...points.map(p=>p.x))*width),bottom=Math.round(Math.max(...points.map(p=>p.y))*height)
 if(right<=left||bottom<=top)throw new TaskConflict('Managed crop rounds to an empty pixel rectangle')
 return {left,top,width:right-left,height:bottom-top}
}
/** Explicit local derivative of immutable verified crop input. Never writes canonical crops3/ or cloud completion. */
export async function cutManagedCrop(folder:string,filename:string):Promise<ManagedCutResult> {
 return withManagedCropWorkspaceLock(()=>withManagedChapterLock(folder,async()=>{
  const initial=await context(folder,filename)
  const check=async()=>{const current=await context(folder,filename);if(canonicalJson(identity(current))!==canonicalJson(identity(initial)))throw new TaskConflict('Managed crop changed before cut publication');return current}
  const existing=await fs.lstat(initial.cuts).catch(error=>{if(error.code==='ENOENT')return null;throw error})
  if(existing){const result=await verify(initial,initial.cuts);await check();return result}
  // Decode and cut the exact hashed buffer, rather than rereading a source path during rendering.
  const source=await bytes(initial.sourcePath,MAX_SOURCE)
  if(await artifactHash(source)!==initial.input.source.sha256)throw new TaskConflict('Source changed before managed rendering')
  const stage=path.join(initial.parent,`.cut-${randomUUID()}`);await mkdir(stage)
  try {
   const files:FileEvidence[]=[];let total=0,pixels=0
   for(const crop of initial.pointers.crops) {
    const rect=rectangle(crop,initial.input.source.width,initial.input.source.height)
    pixels+=rect.width*rect.height;if(pixels>100_000_000)throw new TaskConflict('Managed cut pixel budget exceeded')
    const info=await sharp(source,{limitInputPixels:100_000_000}).extract(rect).png().toBuffer({resolveWithObject:true})
    total+=info.data.length;if(total>MAX_OUTPUT)throw new TaskConflict('Managed cut output budget exceeded')
    const meta=initial.metadata.crops.find((m:any)=>m.id===crop.id)
    const file:FileEvidence={cropId:crop.id,filename:meta.exportedFilename,sha256:await artifactHash(info.data),bytes:info.data.length,width:info.info.width,height:info.info.height}
    await exclusive(path.join(stage,file.filename),info.data);files.push(file)
   }
   const receipt={...identity(initial),files}
   await exclusive(path.join(stage,'receipt.json'),new TextEncoder().encode(canonicalJson(receipt)));await flush(stage)
   await verify(initial,stage)
   await check()
   // Same-volume directory rename publishes the complete set atomically. An existing set is never overwritten.
   try{await fs.rename(stage,initial.cuts)}catch(error:any){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error}
   await flush(initial.parent)
   const result=await verify(await check(),initial.cuts)
   managedCropProjectionChanged()
   return result
  }finally{await fs.rm(stage,{recursive:true,force:true})}
 }))
}
/** No network reads or retry generation. Corrupt published cuts fail closed. */
export async function readManagedCropCut(folder:string,filename:string):Promise<ManagedCutResult|null> {
 return withManagedCropWorkspaceLock(()=>withManagedChapterLock(folder,async()=>{
  try {const c=await context(folder,filename),result=await verify(c,c.cuts);const current=await context(folder,filename);if(canonicalJson(identity(c))!==canonicalJson(identity(current)))throw new TaskConflict('Managed cut input changed during read');return result}catch(error:any){if(error.code==='ENOENT')return null;throw error}
 }))
}

/** Current immutable input for explicit review; raw paths never belong in a client response. */
export async function managedCropReviewInput(folder:string,filename:string,originalOnly=false) {
 return withManagedCropWorkspaceLock(()=>withManagedChapterLock(folder,async()=>{
  const c=await context(folder,filename,originalOnly)
  const revision=await artifactHash(new TextEncoder().encode(canonicalJson({...identity(c),filename})))
  return {revision,directory:c.parent,taskId:c.binding.task.id,fingerprint:c.binding.task.fingerprint,pointers:c.pointers,metadata:c.metadata,baseRevision:c.baseRevision,appliedFeedbackId:c.application?.feedbackId??null}
 }))
}
