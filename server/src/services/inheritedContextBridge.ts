import {targetContextTransport} from './targetContextBridge.js'
import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import type {PackageSource} from './targetPackageProtocol.js'
import {contextBinding,parseInheritedRequest,parseInheritedReview,parseInheritedStatus,INHERITED_CONTEXT_SCHEMA} from './inheritedContextProtocol.js'
import {verifyContextPacket} from './portableContextPacket.js'
import type {RelayDeliveryPause} from './relayDeliveryPause.js'
// The normal transport is reused with an explicit fixed endpoint/schema, preserving pauses and one-shot delivery.
export function inheritedContextTransport(url:string,workspace:string,token:string,legacy:string|undefined,pause:RelayDeliveryPause){return targetContextTransport(url,workspace,token,legacy,pause,{path:'/managed/recovery/inherited-context',schema:INHERITED_CONTEXT_SCHEMA,limit:64000})}
export class InheritedContextStudioBridge {
 constructor(private deps:{resolve:()=>Promise<{unit:RecoveryUnit;source:PackageSource}>;call:(operation:Record<string,unknown>)=>Promise<any>;now?:()=>number}){}
 async perform(raw:unknown){
  if(!raw||typeof raw!=='object')throw new TaskConflict('Explicit inherited requirements operation required')
  const b=raw as any,now=this.deps.now?.()??Date.now();let operation:Record<string,unknown>,binding:any,expected:any
  if(b.action==='review'){
   recoveryExact(b,['action','id','packetWire','reference','requiredEntries','supersedesId','confirmation'])
   const packet=verifyContextPacket(b.packetWire,b.reference,now);expected=parseInheritedRequest({id:b.id,binding:packet.binding,packetId:packet.packetId,requiredEntries:b.requiredEntries,supersedesId:b.supersedesId,confirmation:b.confirmation})
   if(canonicalJson(expected.requiredEntries)!==canonicalJson(packet.requiredEntries))throw new TaskConflict('Review the complete exact ordered packet inventory')
   binding=packet.binding;operation={action:'review',request:expected}
  }else if(b.action==='withdraw'){
   recoveryExact(b,['action','id','binding']);if(!recoveryId(b.id))throw new TaskConflict('Original review identity required');binding=contextBinding(b.binding);operation={action:'withdraw',id:b.id,binding}
  }else if(b.action==='status'){
   recoveryExact(b,['action','binding']);binding=contextBinding(b.binding);operation={action:'status',binding}
  }else throw new TaskConflict('Explicit inherited requirements operation required')
  const before=await this.deps.resolve()
  if(recoveryUnitKey(before.unit)!==recoveryUnitKey(binding.unit)||before.source.sha256!==binding.sourceSha256)throw new TaskConflict('Exact original selected task and actual source required')
  const result=await this.deps.call(operation)
  if(b.action==='status')parseInheritedStatus(result,binding,this.deps.now?.()??Date.now())
  else {const receipt=parseInheritedReview(result);if(receipt.request.id!==b.id||canonicalJson(receipt.request.binding)!==canonicalJson(binding)||expected&&canonicalJson(receipt.request)!==canonicalJson(expected)||b.action==='withdraw'&&receipt.withdrawnAt===null||receipt.reviewedAt>(this.deps.now?.()??Date.now())||receipt.withdrawnAt!==null&&receipt.withdrawnAt>(this.deps.now?.()??Date.now()))throw new TaskConflict('Original inherited requirements receipt mismatch')}
  const after=await this.deps.resolve();if(recoveryUnitKey(after.unit)!==recoveryUnitKey(before.unit)||canonicalJson(after.source)!==canonicalJson(before.source))throw new TaskConflict('Source changed during review; reconcile the original receipt')
  return result
 }
}
