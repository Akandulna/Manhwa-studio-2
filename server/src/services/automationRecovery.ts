import {RECOVERY_STOP_SCHEMA,parseRecoveryStopRecord,parseRecoveryStopReceipt,type RecoveryStopMode,type RecoveryStopRecord} from './recoveryStopProtocol.js'
import {createHash,randomUUID} from 'node:crypto'
import type {ProductionSettings,ProductionStoreDatabase} from './productionJobStore.js'
import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {diagnoseRecovery,recoveryUnitKey,type RecoveryUnit,type RecoveryEvidence,type RecoveryBudget,type RecoveryDecision,type RecoveryOperation} from './automationRecoveryPolicy.js'
export interface RecoveryDiagnosis {
 schema:'automation-recovery/1';unit:RecoveryUnit;revision:number;enabled:boolean;paused:boolean;cancelled:boolean
 evidence:RecoveryEvidence;budget:RecoveryBudget;decision:RecoveryDecision
 history:{at:number;reference:string;state:string;reason:string}[]
}
const PREFIX='automationRecovery/1/'
const ARCHIVE_PREFIX='automationRecoveryArchive/1/'
const HISTORY_PREFIX='automationRecoveryHistory/1/'
const inspectionFacts=(e:RecoveryEvidence)=>{const {reference,observedAt,...facts}=e;return facts}
const STOP_PREFIX='automationRecoveryStop/1/'
const stopKey=(u:RecoveryUnit)=>STOP_PREFIX+createHash('sha256').update(recoveryUnitKey(u)).digest('hex')
const key=(u:RecoveryUnit)=>PREFIX+createHash('sha256').update(recoveryUnitKey(u)).digest('hex')
function decode(raw:string):RecoveryDiagnosis{
 if(raw.length>64000)throw new TaskConflict('Recovery journal exceeds bounds; retain for inspection')
 const v=JSON.parse(raw) as RecoveryDiagnosis
 if(!v||Object.keys(v).sort().join(',')!=='budget,cancelled,decision,enabled,evidence,history,paused,revision,schema,unit'||v.schema!=='automation-recovery/1'||!Number.isSafeInteger(v.revision)||v.revision<1||![v.enabled,v.paused,v.cancelled].every(x=>typeof x==='boolean')||!Array.isArray(v.history)||v.history.length>100||v.history.some(h=>!h||!Number.isSafeInteger(h.at)||h.at<0||typeof h.reference!=='string'||h.reference.length>256||typeof h.reason!=='string'||h.reason.length>500||!['ready','waiting','held','owner_action','verified','controls'].includes(h.state)))throw new TaskConflict('Invalid retained recovery journal; do not replace it')
 recoveryUnitKey(v.unit)
 const d=v.decision
 if(!d||Object.keys(d).sort().join(',')!=='incident,operation,reason,recheckAt,requiredPostcondition,state'||!['ready','waiting','held','owner_action','verified'].includes(d.state)||!['inspect','wait','account_recheck','restore_local','upload_saved','navigate','ui_repair','correct_output','handoff'].includes(d.operation)||typeof d.reason!=='string'||d.reason.length>500||typeof d.requiredPostcondition!=='string'||d.requiredPostcondition.length>500||!(d.recheckAt===null||Number.isSafeInteger(d.recheckAt)&&d.recheckAt>0)||!d.incident||Object.keys(d.incident).sort().join(',')!=='cause,resource'||![d.incident.cause,d.incident.resource].every(x=>typeof x==='string'&&x.length>0&&x.length<=256))throw new TaskConflict('Invalid retained recovery decision')
 // Decode evidence as of its source time, not read time; old evidence remains visibly stale.
 diagnoseRecovery(v.unit,v.evidence,v.budget,{enabled:v.enabled,paused:v.paused,cancelled:v.cancelled},v.evidence.observedAt,new Set())
 return v
}
/** Automation Manager's durable diagnosis projection. Execution budget/permits remain in relay authority. */
export class AutomationRecovery {
 constructor(private db:ProductionStoreDatabase,private now=Date.now,private enrolled:ReadonlySet<RecoveryOperation>=new Set(['restore_local']),private report?:(diagnosis:RecoveryDiagnosis)=>void){}
 private async makeRoom(tx:ProductionSettings){
  const rows=await tx.list(PREFIX)
  if(rows.length<128)return
  for(const row of rows){
   const d=decode(row.value),stop=await tx.get(stopKey(d.unit))
   if(d.budget.pending||d.enabled&&!d.cancelled&&d.decision.state!=='verified'||stop&&!parseRecoveryStopRecord(JSON.parse(stop)).receipt)continue
   if(!tx.remove)throw new TaskConflict('Recovery archival requires transactional removal support')
   const archived=ARCHIVE_PREFIX+row.key.slice(PREFIX.length),prior=await tx.get(archived)
   if(prior&&prior!==row.value)throw new TaskConflict('Conflicting retained recovery archive')
   if(!prior)await tx.insert(archived,row.value)
   if(!await tx.remove(row.key,row.value))throw new TaskConflict('Recovery journal changed during archival')
   return
  }
  throw new TaskConflict('Active recovery inventory is full; reconcile pending work')
 }
 private async activeRaw(tx:ProductionSettings,unit:RecoveryUnit){
  const k=key(unit),raw=await tx.get(k)
  if(raw)return raw
  const archived=ARCHIVE_PREFIX+k.slice(PREFIX.length),prior=await tx.get(archived)
  if(!prior)return null
  await this.makeRoom(tx)
  if(!tx.remove)throw new TaskConflict('Recovery archival requires transactional removal support')
  await tx.insert(k,prior)
  if(!await tx.remove(archived,prior))throw new TaskConflict('Recovery archive changed concurrently')
  return prior
 }
 private async appendHistory(tx:ProductionSettings,old:RecoveryDiagnosis|null,entry:RecoveryDiagnosis['history'][number]){
  let history=old?.history??[]
  if(old&&history.length>=64){
   const archived=HISTORY_PREFIX+key(old.unit).slice(PREFIX.length)+'/'+old.revision,body=JSON.stringify(history.slice(0,32)),prior=await tx.get(archived)
   if(prior&&prior!==body)throw new TaskConflict('Conflicting recovery history archive')
   if(!prior)await tx.insert(archived,body)
   history=history.slice(32)
  }
  return [...history,entry]
 }
 /** Receipt-time refreshes of identical inspection facts do not consume history or change control revisions. */
 async observeInspection(unit:RecoveryUnit,evidence:RecoveryEvidence,budget:RecoveryBudget){
  const reference='inspection/'+createHash('sha256').update(canonicalJson(inspectionFacts(evidence))).digest('hex')
  return this.observe(unit,{...evidence,reference},budget,true)
 }
 async inspect(unit:RecoveryUnit):Promise<RecoveryDiagnosis|null>{return this.db.transaction(async tx=>{const k=key(unit),raw=await tx.get(k)??await tx.get(ARCHIVE_PREFIX+k.slice(PREFIX.length));if(!raw)return null;const v=decode(raw);if(recoveryUnitKey(v.unit)!==recoveryUnitKey(unit))throw new TaskConflict('Recovery scope mismatch');return v})}
 async list():Promise<RecoveryDiagnosis[]>{return this.db.transaction(async tx=>{const rows=await tx.list(PREFIX);if(rows.length>128)throw new TaskConflict('Recovery inventory exceeded; retain history');return rows.map(row=>{const v=decode(row.value);if(row.key!==key(v.unit))throw new TaskConflict('Recovery journal key mismatch');return v})})}
 async retained(workspaceId?:string){return this.db.transaction(async tx=>{const rows=await tx.list(PREFIX);if(rows.length>128)throw new TaskConflict('Recovery inventory exceeded; retain history');return Promise.all(rows.map(async row=>{const diagnosis=decode(row.value);if(row.key!==key(diagnosis.unit))throw new TaskConflict('Recovery journal key mismatch');const raw=await tx.get(stopKey(diagnosis.unit)),stop=raw?parseRecoveryStopRecord(JSON.parse(raw)):null;if(stop&&recoveryUnitKey(stop.intent.unit)!==recoveryUnitKey(diagnosis.unit))throw new TaskConflict('Retained stop scope mismatch');return {diagnosis,stop}})).then(rows=>rows.filter(r=>!workspaceId||r.diagnosis.unit.workspaceId===workspaceId))})}
 async assertAdmission(unit:RecoveryUnit,operation?:RecoveryOperation){
  return this.db.transaction(async tx=>{
   const raw=await tx.get(stopKey(unit))
   if(raw){const s=parseRecoveryStopRecord(JSON.parse(raw));if(recoveryUnitKey(s.intent.unit)!==recoveryUnitKey(unit)||!s.receipt||s.intent.mode!=='reinspect')throw new TaskConflict('Retained recovery stop must be synchronized and prepared for fresh inspection')}
   if(operation){
    const k=key(unit),saved=await tx.get(k)??await tx.get(ARCHIVE_PREFIX+k.slice(PREFIX.length))
    if(!saved)throw new TaskConflict('Fresh Automation Manager diagnosis required for admission before a repair grant')
    const d=decode(saved),decision=diagnoseRecovery(unit,d.evidence,d.budget,{enabled:d.enabled,paused:d.paused,cancelled:d.cancelled},this.now(),this.enrolled)
    if(decision.state!=='ready'||decision.operation!==operation)throw new TaskConflict('Recovery policy holds this action: '+decision.reason+'; admission remains blocked while retained evidence needs reconciliation')
   }
  })
 }
 async stop(unit:RecoveryUnit,revision:number,mode:RecoveryStopMode){
  recoveryUnitKey(unit);if(!['pause','disable','cancel','reinspect'].includes(mode))throw new TaskConflict('Stop or prepare fresh inspection only')
  const value=await this.db.transaction(async tx=>{
   const k=key(unit),raw=await this.activeRaw(tx,unit),old=raw?decode(raw):null,sk=stopKey(unit),prior=await tx.get(sk),stop=prior?parseRecoveryStopRecord(JSON.parse(prior)):null
   if(!old||old.revision!==revision||stop&&recoveryUnitKey(stop.intent.unit)!==recoveryUnitKey(unit))throw new TaskConflict('Inspect the retained original diagnosis revision')
   if(old.cancelled||stop?.intent.mode==='cancel')throw new TaskConflict('Recovery cancellation is permanent for this unit')
   if(stop&&mode!=='cancel'&&mode!=='reinspect'&&stop.intent.mode!=='reinspect')return {diagnosis:old,stop}
   if(mode==='reinspect'&&(stop?.intent.sequence??0)>=125)throw new TaskConflict('Final stop capacity is reserved for holding and cancellation')
   if(mode==='reinspect'&&(!stop?.receipt||stop.intent.mode==='reinspect'))throw new TaskConflict('Synchronize the original stop before preparing fresh inspection')
   const next:RecoveryStopRecord={intent:{schema:RECOVERY_STOP_SCHEMA,unit:structuredClone(unit),eventId:randomUUID(),sequence:(stop?.intent.sequence??0)+1,mode},receipt:null};parseRecoveryStopRecord(next)
   const diagnosis:RecoveryDiagnosis={...old,enabled:false,paused:true,cancelled:mode==='cancel',revision:old.revision+1,decision:{...old.decision,state:'held',operation:'inspect',reason:mode==='reinspect'?'Awaiting relay preparation; fresh playbook inspection remains required':'Local recovery stop saved; relay confirmation is separate',recheckAt:null}}
   diagnosis.history=await this.appendHistory(tx,old,{at:this.now(),reference:old.evidence.reference,state:'controls',reason:diagnosis.decision.reason})
   if(!await tx.replace(k,raw!,JSON.stringify(diagnosis)))throw new TaskConflict('Recovery diagnosis changed concurrently')
   if(prior){if(!await tx.replace(sk,prior,JSON.stringify(next)))throw new TaskConflict('Recovery stop changed concurrently')}else await tx.insert(sk,JSON.stringify(next))
   return {diagnosis,stop:next}
  });this.report?.(value.diagnosis);return value
 }
 async acknowledgeStop(rawReceipt:unknown){
  const receipt=parseRecoveryStopReceipt(rawReceipt),unit=receipt.unit
  const value=await this.db.transaction(async tx=>{
   const sk=stopKey(unit),raw=await tx.get(sk);if(!raw)throw new TaskConflict('Original local stop required')
   const stop=parseRecoveryStopRecord(JSON.parse(raw)),{receivedAt,...intent}=receipt
   if(canonicalJson(stop.intent)!==canonicalJson(intent))return false // A late response cannot acknowledge a newer local stop.
   if(stop.receipt){if(canonicalJson(stop.receipt)!==canonicalJson(receipt))throw new TaskConflict('Conflicting original stop receipt');return true}
   if(!await tx.replace(sk,raw,JSON.stringify({...stop,receipt})))throw new TaskConflict('Local stop changed concurrently')
   if(intent.mode==='reinspect'){
    const k=key(unit),saved=await tx.get(k),old=saved?decode(saved):null;if(!old||old.cancelled)throw new TaskConflict('Original retained diagnosis required')
    const diagnosis:RecoveryDiagnosis={...old,enabled:false,paused:false,revision:old.revision+1,decision:{...old.decision,state:'held',operation:'inspect',reason:'Prepared for fresh playbook inspection; no action is enabled',recheckAt:null}}
    if(!await tx.replace(k,saved!,JSON.stringify(diagnosis)))throw new TaskConflict('Diagnosis changed concurrently')
   }
   return true
  });return value
 }
 async observe(unit:RecoveryUnit,evidence:RecoveryEvidence,budget:RecoveryBudget,inspection=false):Promise<RecoveryDiagnosis>{
  const value=await this.db.transaction(async tx=>{
   const k=key(unit),raw=await this.activeRaw(tx,unit),old=raw?decode(raw):null
   if(old&&evidence.observedAt<old.evidence.observedAt)throw new TaskConflict('Stale recovery evidence cannot replace newer diagnosis')
   if(old&&(budget.used<old.budget.used||budget.uiUsed<old.budget.uiUsed))throw new TaskConflict('Recovery budget cannot reset across adapter/failure changes')
   if(old&&old.evidence.reference===evidence.reference&&canonicalJson(inspection?inspectionFacts(old.evidence):old.evidence)!==canonicalJson(inspection?inspectionFacts(evidence):evidence))throw new TaskConflict('Conflicting recovery evidence reference')
   if(!old)await this.makeRoom(tx)
   const controls={enabled:old?.enabled??false,paused:old?.paused??false,cancelled:old?.cancelled??false}
   const decision=diagnoseRecovery(unit,evidence,budget,controls,this.now(),this.enrolled)
   if(old&&canonicalJson(old.evidence)===canonicalJson(evidence)&&canonicalJson(old.budget)===canonicalJson(budget)&&canonicalJson(old.decision)===canonicalJson(decision))return old
   if(inspection&&old&&canonicalJson(inspectionFacts(old.evidence))===canonicalJson(inspectionFacts(evidence))&&canonicalJson(old.budget)===canonicalJson(budget)&&canonicalJson(old.decision)===canonicalJson(decision)){
    const refreshed={...old,evidence:structuredClone(evidence)}
    if(!await tx.replace(k,raw!,JSON.stringify(refreshed)))throw new TaskConflict('Recovery inspection changed concurrently')
    return refreshed
   }
   const value:RecoveryDiagnosis={schema:'automation-recovery/1',unit:structuredClone(unit),revision:(old?.revision??0)+1,...controls,evidence:structuredClone(evidence),budget:structuredClone(budget),decision,history:await this.appendHistory(tx,old,{at:this.now(),reference:evidence.reference,state:decision.state,reason:decision.reason})}
   const encoded=JSON.stringify(value);decode(encoded)
   if(raw){if(!await tx.replace(k,raw,encoded))throw new TaskConflict('Recovery diagnosis changed concurrently')}else await tx.insert(k,encoded)
   return value
  })
  this.report?.(value);return value
 }
 async control(unit:RecoveryUnit,revision:number,change:{enabled:boolean;paused:boolean;cancelled:boolean}):Promise<RecoveryDiagnosis>{
  if(!change||Object.keys(change).sort().join(',')!=='cancelled,enabled,paused'||!Object.values(change).every(v=>typeof v==='boolean'))throw new TaskConflict('Exact recovery controls required')
  const value=await this.db.transaction(async tx=>{
   const k=key(unit),raw=await this.activeRaw(tx,unit),old=raw?decode(raw):null
   if(!old||revision!==old.revision)throw new TaskConflict('Inspect the current recovery revision')
   const controls={...change,cancelled:old.cancelled||change.cancelled}
   // Pause/cancel/off remain possible even after source evidence expires; enabling requires a fresh inspect.
   const safeStop=controls.cancelled||controls.paused||!controls.enabled
   if(!safeStop){const rawStop=await tx.get(stopKey(unit));if(rawStop){const stop=parseRecoveryStopRecord(JSON.parse(rawStop));if(recoveryUnitKey(stop.intent.unit)!==recoveryUnitKey(unit)||!stop.receipt||stop.intent.mode!=='reinspect')throw new TaskConflict('Retained recovery stop blocks admission')}}
   const decision=safeStop?{...old.decision,state:'held' as const,operation:'inspect' as const,reason:controls.cancelled?'Recovery was cancelled; retained evidence is immutable':controls.paused?'Recovery is paused':'Recovery is disabled',recheckAt:null}:diagnoseRecovery(unit,old.evidence,old.budget,controls,this.now(),this.enrolled)
   const value:RecoveryDiagnosis={...old,...controls,revision:old.revision+1,decision,history:await this.appendHistory(tx,old,{at:this.now(),reference:old.evidence.reference,state:'controls',reason:decision.reason})}
   if(!await tx.replace(k,raw!,JSON.stringify(value)))throw new TaskConflict('Recovery controls changed concurrently')
   return value
  })
  this.report?.(value);return value
 }
}
