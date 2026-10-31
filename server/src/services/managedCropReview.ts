import {readBoundaryFeedback,saveBoundaryFeedback,assertNoBoundaryChanges,applyBoundaryFeedback} from './managedBoundaryFeedback.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import {constants} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {managedCropReviewInput,cutManagedCrop,readManagedCropCut} from './managedCropCut.js'
import {withManagedChapterLock,withManagedCropWorkspaceLock} from './managedCropProjection.js'
import {artifactHash} from './managedCropArtifact.js'
import {TaskConflict} from './managedTaskProtocol.js'
import {managedCropProjectionChanged} from './managedCropEvents.js'
const SCHEMA='managed-crop-review/1'
interface Receipt {schema:typeof SCHEMA;revision:string;reviewed:boolean;reviewedAt:string|null}
const locked=<T>(folder:string,work:()=>Promise<T>)=>withManagedCropWorkspaceLock(()=>withManagedChapterLock(folder,work))
function same(expected:string,current:string) {
 if(!/^[a-f0-9]{64}$/.test(expected)||expected!==current)throw new TaskConflict('Crop input changed; reopen its preview before reviewing or cutting')
}
async function record(directory:string):Promise<Receipt|null> {
 let handle
 try{handle=await fs.open(path.join(directory,'review-v1.json'),constants.O_RDONLY|constants.O_NOFOLLOW)}catch(error:any){if(error.code==='ENOENT')return null;throw error}
 try {
  const stat=await handle.stat();if(!stat.isFile()||stat.size>4096)throw new TaskConflict('Invalid managed review file')
  const value=JSON.parse(await handle.readFile('utf8')) as Receipt
  if(Object.keys(value).sort().join(',')!=='reviewed,reviewedAt,revision,schema'||value.schema!==SCHEMA||!/^[a-f0-9]{64}$/.test(value.revision)||typeof value.reviewed!=='boolean'||(value.reviewed?typeof value.reviewedAt!=='string'||!Number.isFinite(Date.parse(value.reviewedAt)):value.reviewedAt!==null))throw new TaskConflict('Invalid managed review receipt')
  return value
 }finally{await handle.close()}
}
async function state(folder:string,filename:string) {
 const input=await managedCropReviewInput(folder,filename),receipt=await record(input.directory)
 const reviewed=receipt?.revision===input.revision&&receipt.reviewed===true
 const cut=reviewed?await readManagedCropCut(folder,filename):null
 const latest=await managedCropReviewInput(folder,filename);same(input.revision,latest.revision)
 return {revision:input.revision,taskId:input.taskId,fingerprint:input.fingerprint,reviewed,reviewedAt:reviewed?receipt!.reviewedAt:null,
  ...(input.appliedFeedbackId?{appliedFeedbackId:input.appliedFeedbackId,baseRevision:input.baseRevision}:{}),pointers:input.pointers,metadata:input.metadata,cut:{complete:cut!==null,files:cut?.files.map(({path:_path,...file})=>file)??[]}}
}
/** No cloud calls or legacy completion inference. Re-reads actual source, artifact and cut bytes. */
export const readManagedCropReview=(folder:string,filename:string)=>locked(folder,()=>state(folder,filename))
export async function setManagedCropReview(folder:string,filename:string,expectedRevision:string,reviewed:boolean) {
 return locked(folder,async()=>{
  if(typeof reviewed!=='boolean')throw new TaskConflict('Explicit review decision required')
  const input=await managedCropReviewInput(folder,filename);same(expectedRevision,input.revision)
  if(reviewed&&!input.appliedFeedbackId)await assertNoBoundaryChanges(input.directory,input.revision)
  // Corrupt/symlinked existing evidence is not silently overwritten by a new approval.
  await record(input.directory)
  const target=path.join(input.directory,'review-v1.json'),temporary=path.join(input.directory,'.review-'+randomUUID())
  const receipt:Receipt={schema:SCHEMA,revision:input.revision,reviewed,reviewedAt:reviewed?new Date().toISOString():null}
  try {
   const handle=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
   try{await handle.writeFile(JSON.stringify(receipt)+'\n');await handle.sync()}finally{await handle.close()}
   same(input.revision,(await managedCropReviewInput(folder,filename)).revision)
   await fs.rename(temporary,target)
   const directory=await fs.open(input.directory,constants.O_RDONLY);try{await directory.sync()}finally{await directory.close()}
   const result=await state(folder,filename);same(expectedRevision,result.revision)
   managedCropProjectionChanged();return result
  }finally{await fs.rm(temporary,{force:true})}
 })
}
export async function cutReviewedManagedCrop(folder:string,filename:string,expectedRevision:string) {
 return locked(folder,async()=>{
  const before=await state(folder,filename);same(expectedRevision,before.revision)
  const effective=await managedCropReviewInput(folder,filename)
  if(!effective.appliedFeedbackId)await assertNoBoundaryChanges(effective.directory,before.revision)
  if(!before.reviewed)throw new TaskConflict('Review this exact published crop input before cutting')
  await cutManagedCrop(folder,filename)
  const after=await state(folder,filename);same(expectedRevision,after.revision)
  if(!after.reviewed||!after.cut.complete)throw new TaskConflict('Managed cut lost its review or input fence')
  return after
 })
}
/** Only a receipt-listed output of the current reviewed revision can be served. */
export async function reviewedManagedCropFile(folder:string,filename:string,expectedRevision:string,output:string) {
 return locked(folder,async()=>{
  const current=await state(folder,filename);same(expectedRevision,current.revision)
  if(!current.reviewed||!current.cut.complete)throw new TaskConflict('Current reviewed cut required')
  const cut=await readManagedCropCut(folder,filename),file=cut?.files.find(item=>item.filename===output)
  if(!file)throw new TaskConflict('Unknown managed cut output')
  // Return verified bytes while the input lock is held; no later path-based read can follow a replacement.
  const handle=await fs.open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try {
   const stat=await handle.stat();if(!stat.isFile()||stat.size!==file.bytes)throw new TaskConflict('Managed cut output changed')
   const bytes=await handle.readFile()
   if(await artifactHash(bytes)!==file.sha256)throw new TaskConflict('Managed cut output changed')
   same(expectedRevision,(await managedCropReviewInput(folder,filename)).revision)
   return bytes
  }finally{await handle.close()}
 })
}

/** Manual feedback is a local annotation tied to the exact immutable publication. */
export async function readManagedBoundaryFeedback(folder:string,filename:string) {
 return locked(folder,async()=>{const input=await managedCropReviewInput(folder,filename,true);return {revision:input.revision,taskId:input.taskId,feedback:await readBoundaryFeedback(input.directory)}})
}
export async function saveManagedBoundaryFeedback(folder:string,filename:string,taskId:string,expectedRevision:string,expectedFeedbackId:unknown,bounds:unknown,note:unknown) {
 return locked(folder,async()=>{
  const input=await managedCropReviewInput(folder,filename,true);same(expectedRevision,input.revision)
  if((await managedCropReviewInput(folder,filename)).appliedFeedbackId)throw new TaskConflict('These corrections are already applied; review the adjusted revision')
  if(input.taskId!==taskId)throw new TaskConflict('Task changed; reopen boundary feedback')
  const current=await state(folder,filename)
  if(current.reviewed||current.cut.complete)throw new TaskConflict('Unmark page review before editing boundary feedback')
  const feedback=await saveBoundaryFeedback(input.directory,input,expectedFeedbackId,bounds,note)
  return {revision:input.revision,taskId:input.taskId,feedback}
 })
}

/** Apply only the exact saved owner correction; never alters provider publication or approves it. */
export async function applyManagedBoundaryFeedback(folder:string,filename:string,taskId:string,expectedRevision:string,feedbackId:string) {
 return locked(folder,async()=>{
  const input=await managedCropReviewInput(folder,filename,true);same(expectedRevision,input.revision)
  if(input.taskId!==taskId)throw new TaskConflict('Task changed; reopen boundary feedback')
  const effective=await managedCropReviewInput(folder,filename)
  if(!effective.appliedFeedbackId){const current=await state(folder,filename);if(current.reviewed||current.cut.complete)throw new TaskConflict('Unmark review before applying new boundaries')}
  await applyBoundaryFeedback(input.directory,input,feedbackId)
  managedCropProjectionChanged();return state(folder,filename)
 })
}
