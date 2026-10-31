import {managedArtifactTransport} from './managedArtifactImport.js'
import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {fallbackTargets,type FallbackTarget} from './fallbackPreflightProtocol.js'
import {TARGET_CONTEXT_SCHEMA,CONTEXT_CONFIRMATION,parseContextStatus,parseContextReview} from './targetContextProtocol.js'
import type {PackageSource} from './targetPackageProtocol.js'
import type {targetPackageStatusTransport} from './targetPackageBridge.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
export function targetContextTransport(url:string,workspace:string,token:string,legacy:string|undefined,pause:RelayDeliveryPause){
 managedArtifactTransport(url,workspace,token,legacy,pause)
 return async(operation:Record<string,unknown>)=>{
  await pause.beforeSend()
  const response=await fetch(new URL('/managed/recovery/target-context',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({...operation,schema:TARGET_CONTEXT_SCHEMA,workspaceId:workspace})})
  if(response.status===429)await pause.record(response.headers.get('Retry-After'))
  if(!response.ok){await response.body?.cancel();throw new TaskConflict('Context review or inspection unavailable')}
  const reader=response.body?.getReader();if(!reader)throw new TaskConflict('Missing context response');let size=0;const chunks:Uint8Array[]=[]
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>16000){await reader.cancel();throw new TaskConflict('Context response exceeds bounds')}chunks.push(p.value)}}finally{reader.releaseLock()}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))
 }
}
export function targetContextStatusTransport(call:ReturnType<typeof targetContextTransport>){return async(unit:RecoveryUnit,rawTargets:FallbackTarget[])=>{
 recoveryUnitKey(unit);const results=[]
 for(const target of fallbackTargets(rawTargets))results.push(parseContextStatus(await call({action:'status',unit,target}),unit,target))
 return results
}}
export class TargetContextStudioBridge {
 constructor(private deps:{resolve:()=>Promise<{unit:RecoveryUnit;source:PackageSource}>;packages:ReturnType<typeof targetPackageStatusTransport>;call:ReturnType<typeof targetContextTransport>;now?:()=>number}){}
 async perform(raw:unknown){
  if(!raw||typeof raw!=='object')throw new TaskConflict('Explicit context review required')
  const b=raw as any
  if(b.action==='review'){recoveryExact(b,['action','id','unit','target','packageId','confirmation']);if(!recoveryId(b.packageId)||b.confirmation!==CONTEXT_CONFIRMATION)throw new TaskConflict('Review the standalone requirements explicitly')}
  else if(b.action==='withdraw')recoveryExact(b,['action','id','unit','target'])
  else throw new TaskConflict('Explicit context requirements action required')
  if(!recoveryId(b.id))throw new TaskConflict('Stable review event identity required');recoveryUnitKey(b.unit);const target=fallbackTargets([b.target])[0],before=await this.deps.resolve()
  if(recoveryUnitKey(b.unit)!==recoveryUnitKey(before.unit))throw new TaskConflict('Selected page or attempt changed')
  if(b.action==='review'){const [p]=await this.deps.packages(before.unit,[target]);if(!p.receipt||p.receipt.id!==b.packageId||canonicalJson(p.receipt.source)!==canonicalJson(before.source))throw new TaskConflict('Exact candidate and actual source required')}
  const reviewed=parseContextReview(await this.deps.call({...b}),before.unit,target,this.deps.now?.()??Date.now())
  if(reviewed.id!==b.id||b.action==='review'&&reviewed.packageId!==b.packageId||canonicalJson(reviewed.source)!==canonicalJson(before.source))throw new TaskConflict('Original review receipt mismatch')
  const after=await this.deps.resolve();if(recoveryUnitKey(after.unit)!==recoveryUnitKey(before.unit)||canonicalJson(after.source)!==canonicalJson(before.source))throw new TaskConflict('Source changed during context review; inspect the original review receipt')
  const status=parseContextStatus(await this.deps.call({action:'status',unit:before.unit,target}),before.unit,target,this.deps.now?.()??Date.now())
  if(status.receipt&&canonicalJson(status.receipt.source)!==canonicalJson(after.source))throw new TaskConflict('Context source mismatch')
  return status
 }
}
