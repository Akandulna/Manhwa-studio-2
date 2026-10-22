import {managedCropBinding} from './managedCropProjection.js'
import type {PrismaClient} from '@prisma/client'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {canonicalJson} from './managedTaskProtocol.js'
import {DEFAULT_CROP_PROMPT,preserveBoundPilotSpec} from './managedCropPilotPolicy.js'
import {MANAGED_CROP_VALIDATOR} from './managedCropArtifact.js'
import {managerChapterIdentity,managerCanDeclareRevision} from './managerReporting.js'
import {pilotAuthority,type PilotInput} from './managedCropPilot.js'
import {relayPauseForDatabase} from './relayDeliveryPause.js'
export function managedPilotAuthority(db:PrismaClient) {
 if(process.env.MANAGED_PILOT!=='1'||!process.env.MANAGED_WORKSPACE_ID||!process.env.MANAGED_STUDIO_TOKEN)throw new Error('Managed pilot is disabled')
 return pilotAuthority(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID,process.env.MANAGED_STUDIO_TOKEN,process.env.RELAY_TOKEN,relayPauseForDatabase(db))
}
export async function managedPilotInput(db:PrismaClient,pageId:string):Promise<PilotInput> {
  const page=await db.page.findUnique({where:{id:pageId},include:{chapter:{include:{series:true}}}})
  if(!page?.localPath||page.status!=='done'||page.chapter.completedAt)throw new Error('Choose an available, unarchived source page')
  const root=await fs.realpath(path.resolve(process.env.DOWNLOAD_ROOT||'./downloads'))
  const sourceFile=await fs.realpath(path.resolve(root,page.localPath))
  const chapterDir=await fs.realpath(path.resolve(root,page.chapter.folderPath))
  if(!sourceFile.startsWith(root+path.sep)||!chapterDir.startsWith(root+path.sep)||path.dirname(sourceFile)!==chapterDir)throw new Error('Source must be a direct page inside the selected chapter')
  const stat=await fs.stat(sourceFile);if(!stat.isFile()||stat.size<1||stat.size>64_000_000)throw new Error('Pilot source exceeds size bounds')
  const sha256=createHash('sha256').update(await fs.readFile(sourceFile)).digest('hex')
  const mapped=await managerChapterIdentity(page.chapterId)
  if(!mapped&&!await managerCanDeclareRevision(page.chapter.seriesId,page.chapter.series.sourceSite))throw new Error('Sync authoritative shared chapter identities before planning')
  const seriesId=mapped?.seriesId??page.chapter.seriesId,chapterId=mapped?.chapterId??page.chapterId
  const filename=path.basename(sourceFile),sharedPage='page_'+createHash('sha256').update(canonicalJson([seriesId,chapterId,filename])).digest('hex')
  const revision='sha256:'+sha256
  const input:PilotInput={identity:{workspaceId:process.env.MANAGED_WORKSPACE_ID!,seriesId,chapterId,pageId:sharedPage},spec:{version:'crop-page/1',provider:'chatgpt',product:'chatgpt-web',model:'provider-default',settings:{mode:null,effort:null},pageRevision:revision,promptVersion:DEFAULT_CROP_PROMPT,validatorVersion:MANAGED_CROP_VALIDATOR,dependencies:[{id:sharedPage,revision,sha256}]},sourceFile,folder:path.relative(root,chapterDir),filename,destination:path.resolve(process.env.MANAGED_ARTIFACT_ROOT||'./private/managed-crops')}
  const binding=await managedCropBinding(input.folder,input.filename)
  return {...input,spec:preserveBoundPilotSpec(input.identity,input.spec,binding?.task??null)}
 }
