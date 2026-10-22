import {managedCropProjectionChanged} from './managedCropEvents.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { artifactHash, artifactRef, validateManagedCrop, type ManagedArtifactRecord } from './managedCropArtifact.js'
import { TaskConflict, canonicalJson, cropTaskIdentity, type CropTask, type CropAttempt, type CropIdentity, type CropSpec, type ManagedOperation } from './managedTaskProtocol.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'

export interface ManagedArtifactSnapshot {record:ManagedArtifactRecord;task:CropTask;attempt:Pick<CropAttempt,'id'|'taskId'|'generation'|'checkpointRef'>;bytes:Uint8Array}
export interface ManagedArtifactTransport {
 load(artifactId:string):Promise<ManagedArtifactSnapshot>
 publish(operation:ManagedOperation):Promise<unknown>
}
/** Explicit transport only: no scheduler, retry loop or credential fallback. */
export function managedArtifactTransport(url:string,workspace:string,token:string,legacyToken?:string,pause?:RelayDeliveryPause):ManagedArtifactTransport {
 const base=new URL(url)
 if((base.protocol!=='https:'&&!(base.protocol==='http:'&&['127.0.0.1','localhost'].includes(base.hostname)))||base.username||base.password||base.search||base.hash||base.pathname!=='/'||!workspace.match(/^[A-Za-z0-9_-]{1,128}$/)||!token.match(/^\S{32,256}$/)||token===legacyToken)throw new TaskConflict('Separate managed Studio credentials and a secure relay URL are required')
 async function call(route:string,operation?:ManagedOperation):Promise<any> {
  await pause?.beforeSend()
  const response=await fetch(new URL(route,base),{method:operation?'POST':'GET',signal:AbortSignal.timeout(20_000),redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(operation?{body:JSON.stringify(operation)}:{})})
  if(response.status===429)await pause?.record(response.headers.get('Retry-After'))
  if(!response.ok) {await response.body?.cancel();throw new TaskConflict(`Managed artifact authority returned HTTP ${response.status}; do not fall back to legacy import`)}
  const reader=response.body?.getReader();if(!reader)throw new TaskConflict('Missing artifact response')
  const chunks:Uint8Array[]=[];let length=0
  try {while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>2_100_000){await reader.cancel();throw new TaskConflict('Artifact response size limit exceeded')}chunks.push(part.value)}}finally{reader.releaseLock()}
  const bytes=new Uint8Array(length);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length}
  const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
  if(raw.schema!=='managed-task/1')throw new TaskConflict('Incompatible artifact authority')
  return raw
 }
 return {
  async load(id) {
   if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new TaskConflict('Invalid artifact ID')
   const raw=await call(`/managed/artifacts/${id}`)
   if(raw.task?.workspaceId!==workspace||typeof raw.document!=='string')throw new TaskConflict('Artifact workspace mismatch')
   return {record:raw.record,task:raw.task,attempt:raw.attempt,bytes:new TextEncoder().encode(raw.document)}
  },
  async publish(operation) {if(operation.workspaceId!==workspace||!['publish','publish_recovered','publish_production'].includes(operation.action))throw new TaskConflict('Invalid publication operation');return call('/managed/operation',operation)},
 }
}

/** Durable immutable destination. It never writes Processed/, crop_points3/ or a canonical legacy filename. */
export class ManagedArtifactDestination {
 get rootPath():string {return this.root}
 constructor(private root:string) {if(!path.isAbsolute(root))throw new TaskConflict('Absolute private artifact destination required')}
 private async directory(parts:string[]):Promise<string> {
  // The configured root belongs to Studio. Reject symlink components even on retry.
  await fs.mkdir(this.root,{recursive:true,mode:0o700})
  const rootStat=await fs.lstat(this.root)
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new TaskConflict('Artifact destination must not contain symlinks')
  let current=await fs.realpath(this.root)
  for(const part of parts) {
   if(!/^[^/\\\x00]+$/.test(part)||part==='.'||part==='..')throw new TaskConflict('Invalid destination path')
   current=path.join(current,part);await fs.mkdir(current,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error})
   const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw new TaskConflict('Artifact destination must not contain symlinks')
  }
  return current
 }
 private async immutable(folder:string,name:string,bytes:Uint8Array):Promise<string> {
  const target=path.join(folder,name),temporary=path.join(folder,`.stage-${randomUUID()}`)
  try {
   const file=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
   try {await file.writeFile(bytes);await file.sync()}finally{await file.close()}
   try {await fs.link(temporary,target)}catch(error:any){if(error.code!=='EEXIST')throw error}
   const existing=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW)
   try {if(!(await existing.stat()).isFile()||!Buffer.from(await existing.readFile()).equals(Buffer.from(bytes)))throw new TaskConflict('Immutable local artifact conflict')}finally{await existing.close()}
   const dir=await fs.open(folder,constants.O_RDONLY);try{await dir.sync()}finally{await dir.close()}
   return target
  }finally{await fs.rm(temporary,{force:true})}
 }
 private receipt(snapshot:ManagedArtifactSnapshot):Uint8Array {
  const {record,task,attempt}=snapshot
  return new TextEncoder().encode(canonicalJson({schema:'managed-destination/1',taskId:task.id,attemptId:attempt.id,generation:attempt.generation,fingerprint:task.fingerprint,artifactId:record.id,ref:record.ref,sha256:record.sha256,checkpointRef:attempt.checkpointRef}))
 }
 /** Projection of an already verified authority acknowledgment, never a second task owner. */
 async rememberPublication(snapshot:ManagedArtifactSnapshot,result:{task:CropTask;artifact:ManagedArtifactRecord}):Promise<void> {
  assertPublication(snapshot,{schema:'managed-task/1',result})
  const staged=await this.stage(snapshot);await staged.verify()
  if(staged.reference!==result.artifact.validationRef)throw new TaskConflict('Publication does not reference this destination validation')
  const folder=await this.directory([snapshot.task.id.slice(12)])
  await this.immutable(folder,'publication.json',new TextEncoder().encode(canonicalJson({schema:'managed-publication/1',task:result.task,attempt:{id:snapshot.attempt.id,taskId:snapshot.attempt.taskId,generation:snapshot.attempt.generation,checkpointRef:snapshot.attempt.checkpointRef},artifact:result.artifact})))
  managedCropProjectionChanged()
 }
 private async readFile(filename:string,limit:number):Promise<Uint8Array> {
  const file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW)
  try {const stat=await file.stat();if(!stat.isFile()||stat.size>limit)throw new TaskConflict('Invalid managed projection file');const bytes=await file.readFile();if(bytes.length>limit)throw new TaskConflict('Managed projection size exceeded');return bytes}finally{await file.close()}
 }
 /** Verified-complete tasks are immutable. Reading this local receipt performs no relay polling. */
 async readPublished(expected:CropTask):Promise<ManagedArtifactSnapshot|null> {
  if(!/^task:sha256:[a-f0-9]{64}$/.test(expected.id))throw new TaskConflict('Invalid managed task identity')
  let index:Uint8Array
  try {index=await this.readFile(path.join(this.root,expected.id.slice(12),'publication.json'),128_000)}catch(error:any){if(error.code==='ENOENT')return null;throw error}
  const publication=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(index))
  if(publication.schema!=='managed-publication/1')throw new TaskConflict('Incompatible managed publication projection')
  const {task,attempt,artifact:record}=publication
  const {workspaceId,seriesId,chapterId,pageId}=task
  const identity=await cropTaskIdentity({workspaceId,seriesId,chapterId,pageId},task.spec)
  if(identity.taskId!==expected.id||identity.fingerprint!==expected.fingerprint||task.id!==expected.id||task.fingerprint!==expected.fingerprint)throw new TaskConflict('Managed publication input mismatch')
  if(record.ref!==artifactRef(task,attempt.id,record.id))throw new TaskConflict('Managed publication reference mismatch')
  const folder=path.join(this.root,expected.id.slice(12),attempt.id,record.id)
  // Reject replaced projection directories before reading their files.
  for(const dir of [this.root,path.join(this.root,expected.id.slice(12)),path.join(this.root,expected.id.slice(12),attempt.id),folder]) {
   const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new TaskConflict('Managed projection directory changed')
  }
  const bytes=await this.readFile(path.join(folder,'artifact.json'),1_000_000)
  const snapshot:ManagedArtifactSnapshot={task,attempt,record,bytes}
  assertPublication(snapshot,{schema:'managed-task/1',result:{task,artifact:record}})
  if(await artifactHash(bytes)!==record.sha256)throw new TaskConflict('Managed projection checksum mismatch')
  validateManagedCrop(bytes,task,attempt)
  const receipt=await this.readFile(path.join(folder,'validation.json'),128_000)
  if('validation/'+await artifactHash(receipt)!==record.validationRef||!Buffer.from(receipt).equals(Buffer.from(this.receipt(snapshot))))throw new TaskConflict('Managed destination receipt mismatch')
  return snapshot
 }
 async stage(snapshot:ManagedArtifactSnapshot):Promise<{reference:string;path:string;verify:()=>Promise<void>}> {
  const {record,task,attempt,bytes}=snapshot
  if(record.taskId!==task.id||record.attemptId!==attempt.id||record.generation!==attempt.generation||record.fingerprint!==task.fingerprint||record.ref!==artifactRef(task,attempt.id,record.id)||await artifactHash(bytes)!==record.sha256)throw new TaskConflict('Destination artifact fence or checksum mismatch')
  validateManagedCrop(bytes,task,attempt)
  const folder=await this.directory([task.id.slice(12),attempt.id,record.id])
  const file=await this.immutable(folder,'artifact.json',bytes)
  const receipt=this.receipt(snapshot)
  const receiptPath=await this.immutable(folder,'validation.json',receipt)
  const verify=async()=>{
   for(const [filename,expected]of [[file,bytes],[receiptPath,receipt]] as const) {
    const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW)
    try{if(!Buffer.from(await handle.readFile()).equals(Buffer.from(expected)))throw new TaskConflict('Local destination readback changed')}finally{await handle.close()}
   }
  }
  await verify()
  return {reference:'validation/'+await artifactHash(receipt),path:file,verify}
 }
}

export interface ManagedCropInput {identity:CropIdentity;spec:CropSpec;source:{filename:string;width:number;height:number;sha256:string}}
/** Real file evidence for the future ProductionRunner adapter. Never guesses a missing dependency revision. */
export async function resolveManagedCropInput(identity:CropIdentity,spec:CropSpec,sourceFile:string):Promise<ManagedCropInput> {
 const file=await fs.open(sourceFile,constants.O_RDONLY|constants.O_NOFOLLOW)
 let bytes:Buffer
 try {const stat=await file.stat();if(!stat.isFile()||stat.size>64_000_000)throw new TaskConflict('Source image size limit exceeded');bytes=await file.readFile()}finally{await file.close()}
 if(bytes.length>64_000_000)throw new TaskConflict('Source image size limit exceeded')
 const image=await sharp(bytes,{limitInputPixels:100_000_000}).metadata()
 if(!image.width||!image.height||!['png','jpeg','webp'].includes(image.format??''))throw new TaskConflict('Unsupported source image')
 const sha256=await artifactHash(bytes)
 if(!spec.dependencies.some(d=>d.id===identity.pageId&&d.revision===spec.pageRevision&&d.sha256===sha256))throw new TaskConflict('Current source does not match the planned page dependency')
 return {identity:structuredClone(identity),spec:structuredClone(spec),source:{filename:path.basename(sourceFile),width:image.width,height:image.height,sha256}}
}

/** Caller must resolve current shared inputs from production evidence; no automatic routing is enabled. */
export async function importManagedArtifact(transport:ManagedArtifactTransport,destination:ManagedArtifactDestination,artifactId:string,current:()=>Promise<ManagedCropInput>):Promise<{path:string;task:CropTask}> {
 const snapshot=await transport.load(artifactId),{record,task,attempt}=snapshot
 if(record.id!==artifactId)throw new TaskConflict('Authority returned another artifact')
 const checkInput=async()=>{const input=await current(),identity=await cropTaskIdentity(input.identity,input.spec);if(identity.taskId!==task.id||identity.fingerprint!==task.fingerprint)throw new TaskConflict('Current input revision changed; retain the historical artifact');if(!input.spec.dependencies.some(d=>d.id===input.identity.pageId&&d.revision===input.spec.pageRevision&&d.sha256===input.source.sha256))throw new TaskConflict('Current source dependency mismatch');validateManagedCrop(snapshot.bytes,task,attempt,input.source)}
 await checkInput()
 const staged=await destination.stage(snapshot)
 await checkInput();await staged.verify()
 const op:ManagedOperation={schema:'managed-task/1',workspaceId:task.workspaceId,eventId:'publish_'+staged.reference.slice(11),action:'publish',taskId:task.id,attemptId:attempt.id,generation:attempt.generation,fingerprint:task.fingerprint,artifactId:record.id,contentHash:record.sha256,validationRef:staged.reference}
 const response=await transport.publish(op) as any,result=response?.result
 assertPublication(snapshot,response,staged.reference)
 await destination.rememberPublication(snapshot,result)
 await checkInput()
 return {path:staged.path,task:result.task}
}

function assertPublication(snapshot:ManagedArtifactSnapshot,response:any,expectedValidationRef?:string):void {
 const {record,task,attempt}=snapshot,result=response?.result
 if(response?.schema!=='managed-task/1'||result?.task?.id!==task.id||result.task.attemptId!==attempt.id||result.task.generation!==attempt.generation||result.task.fingerprint!==task.fingerprint||result.task.workspaceId!==task.workspaceId||result.task.seriesId!==task.seriesId||result.task.chapterId!==task.chapterId||result.task.pageId!==task.pageId||result.task.state!=='verified_complete'||result.task.canonical!==record.ref||result.artifact?.id!==record.id||result.artifact.sha256!==record.sha256||result.artifact.ref!==record.ref||result.artifact.taskId!==task.id||result.artifact.attemptId!==attempt.id||result.artifact.generation!==attempt.generation||result.artifact.fingerprint!==task.fingerprint||(expectedValidationRef!==undefined&&result.artifact.validationRef!==expectedValidationRef)||result.artifact.validated!==true)throw new TaskConflict('Publication acknowledgment does not match the validated artifact')
}
