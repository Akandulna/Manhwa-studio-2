import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {canonicalJson,TaskConflict} from './managedTaskProtocol.js'
import type {PilotAuthority} from './managedCropPilot.js'
import {managedCropBinding,withManagedCropWorkspaceLock,withManagedChapterLock} from './managedCropProjection.js'
import {managedCropProjectionChanged} from './managedCropEvents.js'

/** Retirement requires a terminal, acknowledged, unsent owner. It never dispatches or deletes artifacts. */
export async function retireUnsentPilot(folder:string,filename:string,expectedTaskId:string,authority:PilotAuthority) {
 return withManagedCropWorkspaceLock(()=>withManagedChapterLock(folder,async()=>{
  if(!filename||path.basename(filename)!==filename||/[\\\x00]/.test(filename))throw new TaskConflict('Exact page filename required')
  const root=path.resolve(process.env.DOWNLOAD_ROOT||'./downloads'),chapter=path.resolve(root,folder)
  if(!chapter.startsWith(root+path.sep))throw new TaskConflict('Chapter outside library')
  const marker=path.join(chapter,'.managed-crops'),stem=filename.replace(/\.[^/.]+$/,''),archive=path.join(marker,'retired')
  const binding=await managedCropBinding(folder,filename)
  const receiptFile=path.join(archive,stem+'.receipt.json')
  if(!binding) {
   const receipt=JSON.parse(await fs.readFile(receiptFile,'utf8'))
   if(receipt.taskId!==expectedTaskId||receipt.filename!==filename)throw new TaskConflict('Retirement receipt differs')
   return receipt
  }
  if(binding.task.id!==expectedTaskId)throw new TaskConflict('Managed binding changed')
  const current=await authority.timeline(expectedTaskId),task=current.task,attempt=current.attempt
  const keys=['workspaceId','seriesId','chapterId','pageId','id','fingerprint'] as const
  if(keys.some(k=>task[k]!==binding.task[k])||task.state!=='cancelled'||task.canonical!==null||current.artifactReady!==false||!attempt||attempt.taskId!==task.id||attempt.id!==task.attemptId||attempt.generation!==task.generation||attempt.phase!=='stop_confirmed'||attempt.submission!=='unsent'||attempt.checkpointRef!==null)throw new TaskConflict('Cancel and acknowledge the exact unsent pilot on its original phone first')
  const stop=current.commands.find((c:any)=>c.id===attempt.activeCommandId) as any
  if(!stop||stop.action!=='stop'||stop.phase!=='stop_confirmed'||stop.taskId!==task.id||stop.attemptId!==attempt.id||stop.generation!==task.generation||stop.fingerprint!==task.fingerprint)throw new TaskConflict('Exact cancellation acknowledgment required')
  const source=await fs.readFile(path.join(chapter,filename)),sourceHash=createHash('sha256').update(source).digest('hex')
  if(sourceHash!==task.spec.dependencies[0]?.sha256)throw new TaskConflict('Source changed; inspect its original lineage')
  const receipt={schema:'managed-pilot-retirement/1',taskId:task.id,filename,sourceHash,retiredAt:new Date().toISOString(),timeline:current,binding}
  await fs.mkdir(archive,{recursive:true,mode:0o700})
  const stat=await fs.lstat(archive);if(!stat.isDirectory()||stat.isSymbolicLink())throw new TaskConflict('Retirement directory changed')
  // Write-ahead receipt and retained binding; replay after any interruption uses the same original bytes.
  try {const h=await fs.open(receiptFile,'wx',0o600);try{await h.writeFile(canonicalJson(receipt));await h.sync()}finally{await h.close()}}catch(e:any){if(e.code!=='EEXIST')throw e;const prior=JSON.parse(await fs.readFile(receiptFile,'utf8'));if(prior.taskId!==task.id||prior.sourceHash!==sourceHash)throw new TaskConflict('Conflicting retirement receipt')}
  await fs.rename(path.join(marker,stem+'.json'),path.join(archive,stem+'.binding'))
  for(const dir of [archive,marker]){const h=await fs.open(dir,'r');try{await h.sync()}finally{await h.close()}}
  managedCropProjectionChanged()
  return JSON.parse(await fs.readFile(receiptFile,'utf8'))
 }))
}
