import { TaskConflict, type CropTask, type CropAttempt } from './managedTaskProtocol.js'

export const MANAGED_CROP_VALIDATOR = 'managed-crop-validator/1'
export const MAX_MANAGED_ARTIFACT_BYTES = 1_000_000
export interface ManagedCropArtifact {
 schema:'managed-crop-page/1'; taskId:string; attemptId:string; generation:number; fingerprint:string
 checkpointRef:string; pageRevision:string; validatorVersion:typeof MANAGED_CROP_VALIDATOR
 pointers:string; metadata:string
}
export interface ManagedArtifactRecord {
 id:string;taskId:string;attemptId:string;generation:number;fingerprint:string;ref:string;sha256:string;validated:boolean;validationRef:string|null
}
function assert(ok:unknown,message:string):asserts ok {if(!ok)throw new TaskConflict(message)}
function object(value:unknown,keys:string[]):Record<string,any> {
 assert(value && typeof value==='object' && !Array.isArray(value),'Artifact object required')
 const raw=value as Record<string,any>
 assert(Object.keys(raw).sort().join(',')===[...keys].sort().join(','),'Unexpected or missing artifact fields')
 return raw
}
function json(text:string):unknown {try{return JSON.parse(text)}catch{throw new TaskConflict('Invalid crop artifact JSON')}}
const safeName=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[/\\\x00-\x1f]/.test(v)&&v!=='.'&&v!=='..'
export async function artifactHash(bytes:Uint8Array):Promise<string> {
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes)))].map(b=>b.toString(16).padStart(2,'0')).join('')
}
export function artifactRef(task:CropTask,attemptId:string,artifactId:string):string {
 assert(/^[A-Za-z0-9_-]{1,128}$/.test(attemptId)&&/^[A-Za-z0-9_-]{1,128}$/.test(artifactId),'Invalid artifact identifier')
 return `managed/${task.workspaceId}/${task.id.slice(12)}/${attemptId}/${artifactId}`
}
/** Strict, versioned validation. Never repairs geometry, renames outputs or adopts a different revision. */
export function validateManagedCrop(bytes:Uint8Array,task:CropTask,attempt:Pick<CropAttempt,'id'|'taskId'|'generation'|'checkpointRef'>,expectedImage?:{filename:string;width:number;height:number}):ManagedCropArtifact {
 assert(bytes.length>0&&bytes.length<=MAX_MANAGED_ARTIFACT_BYTES,'Crop artifact size limit exceeded')
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}catch{throw new TaskConflict('Crop artifact must be UTF-8')}
 const raw=object(json(text),['schema','taskId','attemptId','generation','fingerprint','checkpointRef','pageRevision','validatorVersion','pointers','metadata'])
 assert(raw.schema==='managed-crop-page/1'&&raw.taskId===task.id&&raw.attemptId===attempt.id&&raw.generation===attempt.generation&&raw.fingerprint===task.fingerprint,'Artifact attempt fence mismatch')
 assert(task.attemptId===attempt.id&&task.generation===attempt.generation&&attempt.taskId===task.id,'Artifact task owner mismatch')
 assert(raw.checkpointRef===attempt.checkpointRef&&typeof raw.checkpointRef==='string'&&/^checkpoint\/[A-Za-z0-9_-]{1,128}$/.test(raw.checkpointRef),'Artifact checkpoint mismatch')
 assert(raw.pageRevision===task.spec.pageRevision&&raw.validatorVersion===MANAGED_CROP_VALIDATOR&&task.spec.validatorVersion===MANAGED_CROP_VALIDATOR,'Unsupported validator or page revision')
 assert(typeof raw.pointers==='string'&&typeof raw.metadata==='string','Crop files must be explicit JSON text')
 const points=object(json(raw.pointers),['format','version','image','coordinateSystem','crops'])
 assert(points.format==='four-point-crop'&&points.version==='1.0'&&points.coordinateSystem==='normalized','Unsupported crop format')
 const image=object(points.image,['filename','width','height'])
 assert(safeName(image.filename)&&/\.(png|jpe?g|webp)$/i.test(image.filename)&&[image.width,image.height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=100_000),'Invalid source image')
 assert(Array.isArray(points.crops)&&points.crops.length<=1000,'Invalid crop collection')
 if(expectedImage)assert(image.filename===expectedImage.filename&&image.width===expectedImage.width&&image.height===expectedImage.height,'Artifact image does not match the current source')
 const ids=new Set<string>()
 for(const value of points.crops) {
  const crop=object(value,['id','reason','crop'])
  assert(typeof crop.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(crop.id)&&!ids.has(crop.id)&&typeof crop.reason==='string'&&crop.reason.length<=2000,'Invalid or duplicate crop')
  ids.add(crop.id)
  const shape=object(crop.crop,['mode','points'])
  assert(['rectangle','perspective'].includes(shape.mode)&&Array.isArray(shape.points)&&shape.points.length===4,'Four crop corners required')
  const corners=shape.points.map((p:unknown,i:number)=>{const point=object(p,['id','x','y']);assert(point.id===`P${i+1}`&&[point.x,point.y].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1),'Invalid normalized crop point');return point as {x:number;y:number}})
  const turns=corners.map((p,i)=>{const q=corners[(i+1)%4],r=corners[(i+2)%4];return (q.x-p.x)*(r.y-q.y)-(q.y-p.y)*(r.x-q.x)})
  assert(turns.every(t=>t>1e-12)||turns.every(t=>t< -1e-12),'Degenerate or crossing crop geometry')
  if(shape.mode==='rectangle')assert(corners[0].y===corners[1].y&&corners[1].x===corners[2].x&&corners[2].y===corners[3].y&&corners[3].x===corners[0].x,'Rectangle corners do not match')
 }
 const metadata=object(json(raw.metadata),['crops'])
 assert(Array.isArray(metadata.crops)&&metadata.crops.length===ids.size,'Metadata crop set mismatch')
 const names=new Set<string>()
 for(const value of metadata.crops) {
  const crop=object(value,['id','exportedFilename','description'])
  assert(ids.delete(crop.id)&&safeName(crop.exportedFilename)&&crop.exportedFilename.endsWith('.png')&&!names.has(crop.exportedFilename)&&typeof crop.description==='string'&&!!crop.description.trim()&&crop.description.length<=100_000,'Invalid metadata or crop correspondence')
  names.add(crop.exportedFilename)
 }
 assert(ids.size===0,'Missing crop metadata')
 return raw as ManagedCropArtifact
}
