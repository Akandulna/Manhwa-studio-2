import {createHash} from 'node:crypto'
import {canonicalJson,TaskConflict} from './managedTaskProtocol.js'
import {parseProductionConfig,productionDevices,type ProductionConfig,type ProductionJob} from './productionAutomationModel.js'
import {inspectManagedProduction} from './managedProductionReconciliation.js'
import type {PilotAuthority,PilotInput} from './managedCropPilot.js'
import type {ManagedProductionCoordinator} from './managedProductionCoordinator.js'
export interface ManagedRunBundle {
 schema:'managed-production-bundle/1';bundleId:string;sourceJobId:string;sourceRevision:number
 config:ProductionConfig;command:NonNullable<ProductionJob['command']>;preparedTaskIds:string[];sourceScopeDigest:string
}
export interface ManagedAdoptionReceipt {bundleId:string;sourceJobId:string;sourceRevision:number;sourceScopeDigest:string;adoptedAt:string}
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v)
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const task=(v:unknown):v is string=>typeof v==='string'&&/^task:sha256:[a-f0-9]{64}$/.test(v)
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex')
const exact=(v:any,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.sort().join(','))throw new TaskConflict('Unexpected or missing portable run fields')}
export function parseManagedRunBundle(value:unknown):ManagedRunBundle {
 const raw=typeof value==='string'?JSON.parse(value):value as any
 exact(raw,['schema','bundleId','sourceJobId','sourceRevision','config','command','preparedTaskIds','sourceScopeDigest'])
 if(raw.schema!=='managed-production-bundle/1'||!id(raw.sourceJobId)||!sha(raw.bundleId)||!sha(raw.sourceScopeDigest)||!Number.isSafeInteger(raw.sourceRevision)||raw.sourceRevision<0)throw new TaskConflict('Invalid portable run identity')
 exact(raw.config,['device','profileId','managedCrop','clipper',...('managedDevices' in raw.config?['managedDevices']:[])]);exact(raw.config.clipper,['ai','flow','tabs','chatGpt']);exact(raw.config.clipper.chatGpt,['mode','model','effort'])
 const config=parseProductionConfig(raw.config)
 if(!config.managedCrop||!id(config.device)||!id(config.profileId))throw new TaskConflict('Portable runs require one default managed phone/profile')
 exact(raw.command,['kind','sentAt','devices','managedTaskIds','managedClaims'])
 const c=raw.command
 if(c.kind!=='clipper'||typeof c.sentAt!=='string'||!Number.isFinite(Date.parse(c.sentAt))||!Array.isArray(c.devices)||c.devices.length!==productionDevices(config).length||new Set(c.devices).size!==c.devices.length||productionDevices(config).some(d=>!c.devices.includes(d.device))||!Array.isArray(c.managedTaskIds)||!Array.isArray(c.managedClaims)||!c.managedClaims.length||c.managedClaims.length>1000||c.managedTaskIds.length!==c.managedClaims.length||new Set(c.managedTaskIds).size!==c.managedTaskIds.length||!c.managedTaskIds.every(task))throw new TaskConflict('Portable runs require exact original claim receipts')
 const events=new Set<string>(),claimed=new Set<string>()
 for(const claim of c.managedClaims){exact(claim,['taskId','claimEventId','deviceId','profileId']);if(!task(claim.taskId)||!id(claim.claimEventId)||!productionDevices(config).some(d=>d.device===claim.deviceId&&d.profileId===claim.profileId)||!c.managedTaskIds.includes(claim.taskId)||events.has(claim.claimEventId)||claimed.has(claim.taskId))throw new TaskConflict('Ambiguous portable claim receipts');events.add(claim.claimEventId);claimed.add(claim.taskId)}
 if(!Array.isArray(raw.preparedTaskIds)||raw.preparedTaskIds.length>1000||!raw.preparedTaskIds.every(task)||new Set(raw.preparedTaskIds).size!==raw.preparedTaskIds.length||c.managedTaskIds.some((v:string)=>!raw.preparedTaskIds.includes(v)))throw new TaskConflict('Exact prepared task scope required')
 const {bundleId,...payload}=raw;if(hash(payload)!==bundleId)throw new TaskConflict('Portable run checksum mismatch; re-export the original run')
 // The checksum is transport integrity, not proof of ownership. Adoption rechecks every authority receipt.
 return structuredClone(raw)
}
export async function exportManagedRun(job:ProductionJob,authority:PilotAuthority,inputs:PilotInput[],now=Date.now()):Promise<ManagedRunBundle> {
 if(!job.config.managedCrop||!['failed','interrupted'].includes(job.status))throw new TaskConflict('Export only an interrupted or failed managed run')
 const report=await inspectManagedProduction(job,authority,inputs,now)
 if(report.requiresAttention||!report.observations.length)throw new TaskConflict('Reconcile every original claim before exporting this run')
 const payload={schema:'managed-production-bundle/1' as const,sourceJobId:job.id,sourceRevision:job.revision??0,config:job.config,command:job.command!,preparedTaskIds:report.preparedTaskIds,sourceScopeDigest:report.scopeDigest}
 return parseManagedRunBundle({...payload,bundleId:hash(payload)})
}
export interface ManagedAdoptionDependencies {
 load:()=>Promise<ProductionJob[]>
 authority:PilotAuthority;coordinator:ManagedProductionCoordinator
 inputs:(candidate:ProductionJob)=>Promise<PilotInput[]>
 saveNew:(job:ProductionJob)=>Promise<void>
 now?:()=>number
}
export async function adoptManagedRun(seriesId:string,value:unknown,deps:ManagedAdoptionDependencies):Promise<ProductionJob> {
 const bundle=parseManagedRunBundle(value),existing=(await deps.load()).find(j=>j.seriesId===seriesId)
 if(existing){if(existing.adoptedFrom?.bundleId===bundle.bundleId)return existing;throw new TaskConflict('Destination series already has a saved production job. It cannot be overwritten by adoption')}
 const now=(deps.now??Date.now)(),stamp=new Date(now).toISOString()
 const candidate:ProductionJob={id:'adopt_'+bundle.bundleId,revision:1,seriesId,config:bundle.config,command:bundle.command,status:'interrupted',step:'clipping',message:'Original run adopted without dispatch. Inspect it here before explicit resume.',createdAt:stamp,updatedAt:stamp,adoptedFrom:{bundleId:bundle.bundleId,sourceJobId:bundle.sourceJobId,sourceRevision:bundle.sourceRevision,sourceScopeDigest:bundle.sourceScopeDigest,adoptedAt:stamp}}
 return deps.coordinator.withLease(deps.authority,async authority=>{
  const report=await inspectManagedProduction(candidate,authority,await deps.inputs(candidate),now)
  if(report.requiresAttention||report.preparedTaskIds.length!==bundle.preparedTaskIds.length||bundle.preparedTaskIds.some(id=>!report.preparedTaskIds.includes(id)))throw new TaskConflict('Destination sources or original ownership do not match the exported run')
  await deps.saveNew(candidate) // Exact absence CAS. A lost reply can be retried using the same bundle ID.
  return candidate
 })
}
