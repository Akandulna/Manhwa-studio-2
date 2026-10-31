import path from 'node:path'
import {Router} from 'express'
import type {PrismaClient} from '@prisma/client'
import {pilotAuthority} from '../services/managedCropPilot.js'
import {relayPauseForDatabase} from '../services/relayDeliveryPause.js'
import {retireUnsentPilot} from '../services/managedPilotRetirement.js'
import {managedProductionCoordinator} from '../services/managedProductionCoordinator.js'
/** Resolve only the selected database page inside its own chapter; never infer a page from its index. */
function retirementFilename(folder:string,localPath:string):string {
 if(!localPath||localPath.includes(String.fromCharCode(92))||localPath.includes(String.fromCharCode(0)))throw new Error('Original local page path required')
 const root=path.resolve(process.env.DOWNLOAD_ROOT||'./downloads'),chapter=path.resolve(root,folder),file=path.resolve(root,localPath)
 const relative=path.relative(root,chapter)
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||path.dirname(file)!==chapter)throw new Error('Local page does not belong to the selected chapter')
 return path.basename(file)
}
export function initManagedMaintenanceRoutes(db:PrismaClient) {
 const router=Router()
 router.post('/pages/:id/retire-unsent-pilot',async(req,res)=>{try{
  const {taskId,...extra}=req.body??{}
  if(Object.keys(extra).length||typeof taskId!=='string'||!/^task:sha256:[a-f0-9]{64}$/.test(taskId))throw new Error('Exact original pilot required')
  const page=await db.page.findUnique({where:{id:req.params.id},include:{chapter:true}})
  if(!page?.localPath)throw new Error('Page not found')
  const filename=retirementFilename(page.chapter.folderPath,page.localPath)
  if(process.env.MANAGED_PILOT!=='1'||!process.env.MANAGED_WORKSPACE_ID||!process.env.MANAGED_STUDIO_TOKEN)throw new Error('Original authority unavailable')
  const authority=pilotAuthority(process.env.RELAY_URL??'',process.env.MANAGED_WORKSPACE_ID,process.env.MANAGED_STUDIO_TOKEN,process.env.RELAY_TOKEN,relayPauseForDatabase(db))
  const receipt=await managedProductionCoordinator.withLease(authority,fenced=>retireUnsentPilot(page.chapter.folderPath,filename,taskId,fenced))
  res.json({retired:true,taskId:receipt.taskId,retained:true})
 }catch(error){res.status(409).json({error:error instanceof Error?error.message:'Pilot remains held'})}})
 return router
}
