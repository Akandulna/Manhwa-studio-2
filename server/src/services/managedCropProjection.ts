import {managedCropProjectionChanged} from './managedCropEvents.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import {constants} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {AsyncLocalStorage} from 'node:async_hooks'
import {ManagedArtifactDestination,resolveManagedCropInput} from './managedArtifactImport.js'
import {TaskConflict,canonicalJson,cropTaskIdentity,type CropTask} from './managedTaskProtocol.js'
import {validateManagedCrop} from './managedCropArtifact.js'

const DIRECTORY='.managed-crops'
interface Binding {schema:'managed-crop-binding/1';filename:string;destination:string;task:CropTask}
export interface ManagedCropView {pointers:string;metadata:string;taskId:string;fingerprint:string}
const locks=new Map<string,Promise<void>>()
const heldLocks=new AsyncLocalStorage<ReadonlySet<string>>()
const reads=new AsyncLocalStorage<Map<string,Promise<ManagedCropView|null|undefined>>>()
export function withManagedCropReadSnapshot<T>(work:()=>Promise<T>):Promise<T> {return reads.getStore()?work():reads.run(new Map(),work)}
function chapter(folder:string):string{return path.resolve(path.join(process.env.DOWNLOAD_ROOT||'./downloads',folder))}
function stem(filename:string):string {
 if(!filename||filename!==path.basename(filename)||/[\\\x00]/.test(filename)||filename==='.'||filename==='..')throw new TaskConflict('Invalid managed image filename')
 return filename.replace(/\.[^/.]+$/,'')
}
function keyOf(filename:string):string {stem(filename);return /\.(png|jpe?g|webp)$/i.test(filename)?stem(filename):filename}
function bindingFile(folder:string,filename:string):string {return path.join(chapter(folder),DIRECTORY,keyOf(filename)+'.json')}
/** Serializes binding changes and legacy mutation boundaries in this Studio process. No ownership is stored here. */
export async function withManagedChapterLock<T>(folder:string,work:()=>Promise<T>):Promise<T> {
 return withLockKey(chapter(folder),work)
}
export function withManagedCropWorkspaceLock<T>(work:()=>Promise<T>):Promise<T> {return withLockKey('workspace:'+path.resolve(process.env.DOWNLOAD_ROOT||'./downloads'),work)}
async function withLockKey<T>(key:string,work:()=>Promise<T>):Promise<T> {
 if(heldLocks.getStore()?.has(key))return work()
 const previous=locks.get(key)??Promise.resolve();let release!:()=>void
 const next=new Promise<void>(resolve=>release=resolve),tail=previous.then(()=>next);locks.set(key,tail)
 await previous
 try{return await heldLocks.run(new Set([...(heldLocks.getStore()??[]),key]),work)}finally{release();if(locks.get(key)===tail)locks.delete(key)}
}
async function loadBinding(folder:string,filename:string):Promise<Binding|null> {
 let file
 try{const stat=await fs.lstat(path.join(chapter(folder),DIRECTORY));if(!stat.isDirectory()||stat.isSymbolicLink())throw new TaskConflict('Managed binding directory changed')}catch(error:any){if(error.code==='ENOENT')return null;throw error}
 try {file=await fs.open(bindingFile(folder,filename),constants.O_RDONLY|constants.O_NOFOLLOW)}catch(error:any){if(error.code==='ENOENT')return null;throw error}
 let raw:Binding
 try{if((await file.stat()).size>64_000)throw new TaskConflict('Managed binding size exceeded');raw=JSON.parse(await file.readFile('utf8'))}finally{await file.close()}
 if(!raw||Object.keys(raw).sort().join(',')!=='destination,filename,schema,task'||raw.schema!=='managed-crop-binding/1'||stem(raw.filename)!==keyOf(filename)||!path.isAbsolute(raw.destination))throw new TaskConflict('Invalid managed page binding')
 const {workspaceId,seriesId,chapterId,pageId}=raw.task
 const id=await cropTaskIdentity({workspaceId,seriesId,chapterId,pageId},raw.task.spec)
 if(id.taskId!==raw.task.id||id.fingerprint!==raw.task.fingerprint)throw new TaskConflict('Managed binding identity mismatch')
 return raw
}
/** Future planner calls this with its authenticated plan response, before dispatch. Does not enroll or claim. */
export async function bindManagedCrop(folder:string,filename:string,task:CropTask,destination:string,expectedPreviousTaskId:string|null=null):Promise<void> {
 await withManagedCropWorkspaceLock(()=>withManagedChapterLock(folder,async()=>{
  stem(filename);if(!path.isAbsolute(destination))throw new TaskConflict('Absolute managed destination required')
  const {workspaceId,seriesId,chapterId,pageId}=task
  const id=await cropTaskIdentity({workspaceId,seriesId,chapterId,pageId},task.spec)
  if(task.id!==id.taskId||task.fingerprint!==id.fingerprint)throw new TaskConflict('Authenticated plan identity required')
  await resolveManagedCropInput({workspaceId,seriesId,chapterId,pageId},task.spec,path.join(chapter(folder),filename))
  const retired=path.join(chapter(folder),DIRECTORY,'retired',keyOf(filename)+'.receipt.json')
  try { const receipt=JSON.parse(await fs.readFile(retired,'utf8'));if(receipt.taskId===task.id)throw new TaskConflict('This pilot was retired; its original task cannot be enrolled again') }catch(error:any){if(error.code!=='ENOENT')throw error}
  const prior=await loadBinding(folder,filename)
  const binding:Binding={schema:'managed-crop-binding/1',filename,destination,task:structuredClone(task)}
  if(prior?.task.id===task.id){if(prior.destination!==destination||prior.filename!==filename)throw new TaskConflict('Existing managed binding differs');return}
  if((prior?.task.id??null)!==expectedPreviousTaskId)throw new TaskConflict('Managed binding changed before replacement')
  const dir=path.join(chapter(folder),DIRECTORY);await fs.mkdir(dir,{recursive:true,mode:0o700})
  const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new TaskConflict('Managed binding directory must not be a symlink')
  const temporary=path.join(dir,`.binding-${randomUUID()}`),target=bindingFile(folder,filename)
  try {
   const file=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
   try{await file.writeFile(canonicalJson(binding));await file.sync()}finally{await file.close()}
   await fs.rename(temporary,target)
   const handle=await fs.open(dir,constants.O_RDONLY);try{await handle.sync()}finally{await handle.close()}
   managedCropProjectionChanged()
  }finally{await fs.rm(temporary,{force:true})}
 }))
}
/** undefined = legacy page; null = managed but not current/verified. Never falls back on failure. */
export function readManagedCrop(folder:string,filename:string):Promise<ManagedCropView|null|undefined> {
 const cache=reads.getStore(),key=bindingFile(folder,filename)
 const existing=cache?.get(key);if(existing)return existing
 const read=(async()=>{
  const binding=await loadBinding(folder,filename);if(!binding)return undefined
  if(/\.(png|jpe?g|webp)$/i.test(filename)&&filename!==binding.filename)return null
  const {task}=binding,{workspaceId,seriesId,chapterId,pageId}=task
  let input
  try{input=await resolveManagedCropInput({workspaceId,seriesId,chapterId,pageId},task.spec,path.join(chapter(folder),binding.filename))}catch(error:any){if(error instanceof TaskConflict||error.code==='ENOENT')return null;throw error}
  const snapshot=await new ManagedArtifactDestination(binding.destination).readPublished(task)
  if(!snapshot)return null
  const document=validateManagedCrop(snapshot.bytes,snapshot.task,snapshot.attempt,input.source)
  return {pointers:document.pointers,metadata:document.metadata,taskId:task.id,fingerprint:task.fingerprint}
 })()
 cache?.set(key,read);return read
}
export async function managedCropStems(folder:string):Promise<{bound:Set<string>;verified:Set<string>}> {
 let entries:string[];try{entries=await fs.readdir(path.join(chapter(folder),DIRECTORY))}catch(error:any){if(error.code==='ENOENT')return {bound:new Set(),verified:new Set()};throw error}
 const names=entries.filter(n=>n.endsWith('.json'));if(names.length>1000)throw new TaskConflict('Managed chapter binding bound exceeded')
 const bound=new Set<string>(),verified=new Set<string>()
 for(const name of names){const filename=name.slice(0,-5);bound.add(filename);if(await readManagedCrop(folder,filename))verified.add(filename)}
 return {bound,verified}
}
export async function assertUnmanagedCrop(folder:string,filename:string):Promise<void> {
 if(await loadBinding(folder,filename))throw new TaskConflict('This page uses managed crop artifacts. Reconcile its managed task before legacy edits or imports.')
}
export async function managedCropBindingCount(folder:string):Promise<number> {
 const dir=path.join(chapter(folder),DIRECTORY)
 try {const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new TaskConflict('Managed binding directory changed');return (await fs.readdir(dir)).filter(n=>n.endsWith('.json')).length}catch(error:any){if(error.code==='ENOENT')return 0;throw error}
}
export async function assertUnmanagedCropChapter(folder:string):Promise<void> {
 if(await managedCropBindingCount(folder))throw new TaskConflict('This chapter contains managed crop tasks. Use the managed publication path; legacy crop mutation is blocked.')
}
export async function withUnmanagedCropWrite<T>(folder:string,filename:string,work:()=>Promise<T>):Promise<T> {
 return withManagedChapterLock(folder,async()=>{await assertUnmanagedCrop(folder,filename);return work()})
}

export async function withUnmanagedCropChapter<T>(folder:string,work:()=>Promise<T>):Promise<T> {
 return withManagedChapterLock(folder,async()=>{await assertUnmanagedCropChapter(folder);return work()})
}

/** Detect protected chapter scopes before any recursive deletion; never follow symlinks. */
export async function managedCropScopePresent(target:string):Promise<boolean> {
 const root=path.resolve(process.env.DOWNLOAD_ROOT||'./downloads'),absolute=path.resolve(target)
 if(absolute!==root&&!absolute.startsWith(root+path.sep))throw new TaskConflict('Managed scope check outside download root')
 async function marker(dir:string):Promise<boolean> {
  try {const stat=await fs.lstat(path.join(dir,DIRECTORY));if(!stat.isDirectory()||stat.isSymbolicLink())throw new TaskConflict('Managed binding directory changed');return (await fs.readdir(path.join(dir,DIRECTORY))).some(n=>n.endsWith('.json'))}catch(error:any){if(error.code==='ENOENT'||error.code==='ENOTDIR')return false;throw error}
 }
 for(let parent=absolute;parent===root||parent.startsWith(root+path.sep);parent=path.dirname(parent)) {if(await marker(parent))return true;if(parent===root)break}
 async function walk(dir:string):Promise<boolean> {
  let stat;try{stat=await fs.lstat(dir)}catch(error:any){if(error.code==='ENOENT')return false;throw error}
  if(!stat.isDirectory()||stat.isSymbolicLink())return false
  if(await marker(dir))return true
  for(const entry of await fs.readdir(dir,{withFileTypes:true}))if(entry.isDirectory()&&await walk(path.join(dir,entry.name)))return true
  return false
 }
 return walk(absolute)
}

/** Explicit current binding access for managed rendering; does not grant execution ownership. */
export async function managedCropBinding(folder:string,filename:string):Promise<{filename:string;destination:string;task:CropTask}|null> {
 const binding=await loadBinding(folder,filename)
 return binding?structuredClone({filename:binding.filename,destination:binding.destination,task:binding.task}):null
}
