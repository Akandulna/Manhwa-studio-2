import type {ProductionJob,ProductionConfig} from './productionAutomationModel.js'
import {productionDevices} from './productionAutomationModel.js'
import {TaskConflict} from './managedTaskProtocol.js'
export interface ProductionHandoffIntent {
 accountCandidateId?:string;eventId:string;newClaimEventId:string;claimEventId:string;taskId:string;attemptId:string;generation:number;fingerprint:string;stopCommandId:string;deviceId:string;profileId:string;createdAt:string
}
export interface ProductionHandoffReceipt extends ProductionHandoffIntent {appliedAt:string;newAttemptId:string;newGeneration:number}
export function handoffConfig(config:ProductionConfig,intent:ProductionHandoffIntent):ProductionConfig {
 const devices=productionDevices(config)
 if(devices.some(d=>d.device===intent.deviceId&&d.profileId!==intent.profileId))throw new TaskConflict('Cannot switch a managed phone profile during handoff')
 if(devices.some(d=>d.device===intent.deviceId))return structuredClone(config)
 if(devices.length>=8)throw new TaskConflict('Managed fleet exceeds eight enrolled phones')
 return {...structuredClone(config),managedDevices:[...(config.managedDevices??[]),{device:intent.deviceId,profileId:intent.profileId}]}
}
export function handoffJob(original:ProductionJob,intent:ProductionHandoffIntent,receipt:{attemptId:string;generation:number},now=Date.now()):ProductionJob {
 const claim=original.command?.managedClaims?.find(c=>c.taskId===intent.taskId)
 if(!claim||claim.claimEventId!==intent.claimEventId||receipt.generation!==intent.generation+1)throw new TaskConflict('Original claim and new handoff receipt must match')
 const config=handoffConfig(original.config,intent)
 return {...structuredClone(original),id:'handoff_'+intent.eventId,revision:(original.revision??0)+1,status:'interrupted',config,pendingHandoff:undefined,message:'Confirmed-unsent task handed off. Inspect the updated run before resuming.',updatedAt:new Date(now).toISOString(),command:{...original.command!,devices:productionDevices(config).map(d=>d.device),managedClaims:original.command!.managedClaims!.map(c=>c.taskId===intent.taskId?{taskId:c.taskId,claimEventId:intent.newClaimEventId,deviceId:intent.deviceId,profileId:intent.profileId}:c)},handoffHistory:[...(original.handoffHistory??[]),{...intent,appliedAt:new Date(now).toISOString(),newAttemptId:receipt.attemptId,newGeneration:receipt.generation}]}
}
export function validHandoffReplacement(old:ProductionJob,next:ProductionJob):boolean {
 const intent=old.pendingHandoff,receipt=next.handoffHistory?.at(-1)
 if(!intent||!receipt||receipt.eventId!==intent.eventId||receipt.newGeneration!==intent.generation+1||typeof receipt.newAttemptId!=='string'||!receipt.newAttemptId)return false
 const expected=handoffJob(old,intent,{attemptId:receipt.newAttemptId,generation:receipt.newGeneration},Date.parse(receipt.appliedAt))
 // Pure derivation validates config, all prior receipts, history and unchanged source scope.
 return JSON.stringify(JSON.parse(JSON.stringify(expected)))===JSON.stringify(JSON.parse(JSON.stringify(next)))
}
