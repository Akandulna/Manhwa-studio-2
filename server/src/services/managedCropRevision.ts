import fs from 'node:fs/promises'
import path from 'node:path'
import {constants} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {canonicalJson,TaskConflict,type CropTask} from './managedTaskProtocol.js'
/** Immutable lineage intent survives an interrupted binding swap; old artifacts/receipts are never deleted. */
export async function recordManagedCropRevision(folder:string,previous:CropTask,next:CropTask) {
 const dir=path.resolve(process.env.DOWNLOAD_ROOT||'./downloads',folder,'.managed-crops','history')
 await fs.mkdir(dir,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error})
 const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new TaskConflict('Managed revision history directory changed')
 const target=path.join(dir,previous.id.slice(12)+'_'+next.id.slice(12)+'.json'),temporary=path.join(dir,'.revision-'+randomUUID())
 const data=canonicalJson({schema:'managed-crop-revision/1',previousTaskId:previous.id,previousFingerprint:previous.fingerprint,nextTaskId:next.id,nextFingerprint:next.fingerprint,sourceHash:next.spec.dependencies[0].sha256})
 try {
  const handle=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
  try{await handle.writeFile(data);await handle.sync()}finally{await handle.close()}
  try{await fs.link(temporary,target)}catch(error:any){if(error.code!=='EEXIST')throw error}
  const existing=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{const stat=await existing.stat();if(!stat.isFile()||stat.size>4096||await existing.readFile('utf8')!==data)throw new TaskConflict('Managed revision history conflict')}finally{await existing.close()}
  const directory=await fs.open(dir,constants.O_RDONLY);try{await directory.sync()}finally{await directory.close()}
 }finally{await fs.rm(temporary,{force:true})}
}

export async function verifyManagedCropRevision(folder:string,previous:CropTask,next:CropTask) {
 const target=path.resolve(process.env.DOWNLOAD_ROOT||'./downloads',folder,'.managed-crops','history',previous.id.slice(12)+'_'+next.id.slice(12)+'.json')
 const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW)
 try {
  const stat=await handle.stat(),data=canonicalJson({schema:'managed-crop-revision/1',previousTaskId:previous.id,previousFingerprint:previous.fingerprint,nextTaskId:next.id,nextFingerprint:next.fingerprint,sourceHash:next.spec.dependencies[0].sha256})
  if(!stat.isFile()||stat.size>4096||await handle.readFile('utf8')!==data)throw new TaskConflict('Exact managed revision lineage required')
 }finally{await handle.close()}
}
