import fs from 'node:fs/promises'
import {constants} from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'
import {assertManagedChapterRevision,withManagedChapterAssetsLock,readManagedChapterAssets} from './managedChapterAssets.js'

async function evidence(file:string) {
 const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW)
 try {
  const before=await handle.stat()
  if(!before.isFile()||before.size<1)throw new Error('Finished MP4 required')
  const hash=createHash('sha256')
  for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk)
  const after=await handle.stat()
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('MP4 changed during validation')
  return {bytes:after.size,sha256:hash.digest('hex')}
 }finally{await handle.close()}
}
/** A legacy render that became managed also fails closed. */
export async function publishChapterExport(folder:string,revision:string|null,output:string,publish:()=>Promise<void>) {
 return withManagedChapterAssetsLock(folder,async()=>{
  await assertManagedChapterRevision(folder,revision)
  await publish()
  if(!revision)return
  const file=await evidence(output)
  await assertManagedChapterRevision(folder,revision)
  const receipt={schema:'managed-chapter-export/1',revision,...file},temporary=output+'.managed-'+randomUUID()
  try {
   const handle=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
   try{await handle.writeFile(JSON.stringify(receipt));await handle.sync()}finally{await handle.close()}
   await fs.rename(temporary,output+'.managed.json')
   await assertManagedChapterRevision(folder,revision)
  }finally{await fs.rm(temporary,{force:true})}
 })
}
/** Managed chapters require a current receipt and exact file bytes. */
export async function currentChapterExport(folder:string,output:string):Promise<boolean> {
 try {
  return await withManagedChapterAssetsLock(folder,async()=>{
   const assets=await readManagedChapterAssets(folder)
   if(!assets)return true
   const handle=await fs.open(output+'.managed.json',constants.O_RDONLY|constants.O_NOFOLLOW)
   let receipt
   try{const stat=await handle.stat();if(!stat.isFile()||stat.size>4096)return false;receipt=JSON.parse(await handle.readFile('utf8'))}finally{await handle.close()}
   if(Object.keys(receipt).sort().join(',')!=='bytes,revision,schema,sha256'||receipt.schema!=='managed-chapter-export/1'||receipt.revision!==assets.revision)return false
   const file=await evidence(output)
   await assertManagedChapterRevision(folder,assets.revision)
   return file.bytes===receipt.bytes&&file.sha256===receipt.sha256
  })
 }catch{return false}
}
