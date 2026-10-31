import {parseAdoptionStatus} from './candidateAdoptionProtocol.js'
import type {candidateAdoptionStatusTransport} from './candidateAdoptionBridge.js'
import {parseContextStatus} from './targetContextProtocol.js'
import type {targetContextStatusTransport} from './targetContextBridge.js'
import {canonicalJson} from './managedTaskProtocol.js'
import {parseTargetPackageStatus,type PackageSource} from './targetPackageProtocol.js'
import type {targetPackageStatusTransport} from './targetPackageBridge.js'
import {parseTargetInputStatus} from './targetInputProtocol.js'
import type {targetInputStatusTransport} from './targetInputBridge.js'
import {managedArtifactTransport} from './managedArtifactImport.js'
import {FALLBACK_PREFLIGHT_SCHEMA,fallbackTargets,parseFallbackPreflight,type FallbackTarget} from './fallbackPreflightProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {recoveryExact} from './managedSavedImportRecoveryProtocol.js'
import {TaskConflict} from './managedTaskProtocol.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
export function fallbackPreflightTransport(url:string,workspace:string,token:string,legacy:string|undefined,pause:RelayDeliveryPause){
 managedArtifactTransport(url,workspace,token,legacy,pause)
 return async(unit:RecoveryUnit,rawTargets:FallbackTarget[])=>{
  recoveryUnitKey(unit);const targets=fallbackTargets(rawTargets)
  if(unit.workspaceId!==workspace)throw new TaskConflict('Foreign fallback inspection')
  await pause.beforeSend()
  const response=await fetch(new URL('/managed/recovery/fallback-preflight',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({schema:FALLBACK_PREFLIGHT_SCHEMA,unit,targets})})
  if(response.status===429)await pause.record(response.headers.get('Retry-After'))
  if(!response.ok){await response.body?.cancel();throw new TaskConflict('Fallback inspection unavailable; original ownership is unchanged')}
  const reader=response.body?.getReader();if(!reader)throw new TaskConflict('Missing fallback preflight');let length=0;const chunks:Uint8Array[]=[]
  try{while(true){const p=await reader.read();if(p.done)break;length+=p.value.length;if(length>64000){await reader.cancel();throw new TaskConflict('Fallback receipt exceeds bounds')}chunks.push(p.value)}}finally{reader.releaseLock()}
  return parseFallbackPreflight(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),unit,targets)
 }
}
export class FallbackPreflightBridge {
 constructor(private deps:{resolve:()=>Promise<{unit:RecoveryUnit;pageLabel:string;source?:PackageSource}>;call:ReturnType<typeof fallbackPreflightTransport>;now?:()=>number;sourceChecks?:ReturnType<typeof targetInputStatusTransport>;packageChecks?:ReturnType<typeof targetPackageStatusTransport>;contextChecks?:ReturnType<typeof targetContextStatusTransport>;adoptionChecks?:ReturnType<typeof candidateAdoptionStatusTransport>}){}
 async inspect(raw:unknown){
  recoveryExact(raw,['targets']);const targets=fallbackTargets(raw.targets),source=await this.deps.resolve()
  const receipt=await this.deps.call(source.unit,targets),checks=this.deps.sourceChecks?await this.deps.sourceChecks(source.unit,targets):undefined,packages=this.deps.packageChecks?await this.deps.packageChecks(source.unit,targets):undefined,contexts=this.deps.contextChecks?await this.deps.contextChecks(source.unit,targets):undefined,adoptions=this.deps.adoptionChecks?await this.deps.adoptionChecks(source.unit,targets):undefined,current=await this.deps.resolve()
  if(checks&&checks.length!==targets.length)throw new TaskConflict('Incomplete target source status')
  if(recoveryUnitKey(source.unit)!==recoveryUnitKey(current.unit))throw new TaskConflict('Page or attempt changed during fallback inspection')
  if(packages){if(packages.length!==targets.length)throw new TaskConflict('Incomplete target package status');for(const [i,p] of packages.entries()){parseTargetPackageStatus(p,source.unit,targets[i],this.deps.now?.()??Date.now());if(p.receipt&&(!current.source||canonicalJson(p.receipt.source)!==canonicalJson(current.source)))throw new TaskConflict('Target package does not match actual Studio source')}}
  if(contexts){if(contexts.length!==targets.length)throw new TaskConflict('Incomplete target context status');for(const [i,c] of contexts.entries()){parseContextStatus(c,source.unit,targets[i],this.deps.now?.()??Date.now());if(c.receipt&&(!current.source||canonicalJson(c.receipt.source)!==canonicalJson(current.source)))throw new TaskConflict('Target context source mismatch')}}
  if(adoptions){if(adoptions.length!==targets.length)throw new TaskConflict('Incomplete retention status');for(const [i,a] of adoptions.entries()){parseAdoptionStatus(a,source.unit,targets[i],this.deps.now?.()??Date.now());if(a.actions.some((x:any)=>!current.source||canonicalJson(x.context.source)!==canonicalJson(current.source)))throw new TaskConflict('Retention source mismatch')}}
  return {...parseFallbackPreflight(receipt,source.unit,targets,this.deps.now?.()??Date.now()),pageLabel:current.pageLabel,...(adoptions?{candidateAdoptionChecks:adoptions}:{}),...(contexts?{targetContextChecks:contexts}:{}),...(packages?{targetPackageChecks:packages}:{}),...(checks?{targetInputChecks:checks.map((r,n)=>parseTargetInputStatus(r,source.unit,targets[n],this.deps.now?.()??Date.now()))}:{})}
 }
}
