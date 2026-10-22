import {validHandoffReplacement} from './managedProductionHandoff.js'
import {randomUUID} from 'node:crypto'
import {productionDevices,type ProductionJob} from './productionAutomationModel.js'
export const PRODUCTION_JOB_PREFIX='productionAutomation:'
const LEASE_KEY='productionScheduler:lease/1'
export interface ProductionVersion {id:string;revision:number}
export class ProductionOwnershipConflict extends Error {}
export interface ProductionSettings {
 get(key:string):Promise<string|null>
 list(prefix:string):Promise<{key:string;value:string}[]>
 insert(key:string,value:string):Promise<void>
 replace(key:string,previous:string,value:string):Promise<boolean>
}
export interface ProductionStoreDatabase {
 transaction<T>(work:(settings:ProductionSettings)=>Promise<T>):Promise<T>
}
const revision=(job:ProductionJob)=>job.revision??0
function decode(raw:string,key?:string):ProductionJob {
 const job=JSON.parse(raw) as ProductionJob
 if(key&&key!==PRODUCTION_JOB_PREFIX+job.seriesId)throw new Error('Production job key does not match its series')
 if(!job?.id||!job.seriesId||!job.config?.device||!Number.isSafeInteger(revision(job))||revision(job)<0)throw new Error('Invalid persisted production job; reconcile its stored record')
 return job
}
/** Single scheduler per shared Studio database. Cloud task ownership remains separate. */
export class ProductionJobStore {
 private readonly owner=randomUUID()
 private owned=false
 private lost=false
 private timer:ReturnType<typeof setInterval>|undefined
 private activating:Promise<void>|undefined
 constructor(private db:ProductionStoreDatabase,private now=Date.now,private leaseMs=45_000,private heartbeatMs=10_000) {}
 async load():Promise<ProductionJob[]> {return this.db.transaction(async tx=>(await tx.list(PRODUCTION_JOB_PREFIX)).map(row=>decode(row.value,row.key)))}
 private async requireLease(tx:ProductionSettings) {
  const raw=await tx.get(LEASE_KEY),lease=raw?JSON.parse(raw):null
  if(this.lost||!this.owned||lease?.owner!==this.owner||!Number.isFinite(lease?.expiresAt)||lease.expiresAt<=this.now())throw new ProductionOwnershipConflict('Scheduler ownership changed or expired. Restart Studio and reconcile saved work')
  return {raw:raw!,lease}
 }
 async activate():Promise<void> {
  if(this.lost)throw new ProductionOwnershipConflict('Scheduler ownership was lost. Restart Studio before resuming')
  if(this.activating)return this.activating
  const work=this.db.transaction(async tx=>{
   if(this.owned){await this.requireLease(tx);return}
   const raw=await tx.get(LEASE_KEY),old=raw?JSON.parse(raw):null
   if(old&&(!Number.isFinite(old.expiresAt)||old.expiresAt>this.now()))throw new ProductionOwnershipConflict('Another Studio process owns the scheduler. Wait for its lease to expire before resuming')
   const next=JSON.stringify({owner:this.owner,expiresAt:this.now()+this.leaseMs})
   if(raw){if(!(await tx.replace(LEASE_KEY,raw,next)))throw new ProductionOwnershipConflict('Scheduler lease changed during acquisition')}else await tx.insert(LEASE_KEY,next)
   // Only the new scheduler owner may interrupt old jobs. Preserve all original claim receipts.
   for(const row of await tx.list(PRODUCTION_JOB_PREFIX)) {
    const job=decode(row.value,row.key)
    if(job.status!=='running')continue
    job.status='interrupted';job.message='Scheduler restarted. Reconcile the phone, then resume the saved claim receipts.'
    job.updatedAt=new Date(this.now()).toISOString();job.revision=revision(job)+1
    if(!(await tx.replace(row.key,row.value,JSON.stringify(job))))throw new ProductionOwnershipConflict('Production job changed during scheduler recovery')
   }
  }).then(()=>{
   this.owned=true
   if(!this.timer&&this.heartbeatMs>0){this.timer=setInterval(()=>{void this.heartbeat().catch(()=>{/* Lost ownership fences all later writes. */})},this.heartbeatMs);this.timer.unref()}
  }).catch(error=>{if(this.owned)this.lose();throw error})
  this.activating=work
  try {await work}finally{if(this.activating===work)this.activating=undefined}
 }
 private lose(){this.lost=true;this.owned=false;if(this.timer)clearInterval(this.timer);this.timer=undefined}
 async heartbeat():Promise<void> {
  try {await this.db.transaction(async tx=>{
   const {raw,lease}=await this.requireLease(tx)
   if(!(await tx.replace(LEASE_KEY,raw,JSON.stringify({...lease,expiresAt:this.now()+this.leaseMs}))))throw new ProductionOwnershipConflict('Scheduler lease changed during renewal')
  })}catch(error){this.lose();throw error}
 }
 async save(job:ProductionJob,expected:ProductionVersion|null):Promise<void> {
  const snapshot=structuredClone(job)
  await this.db.transaction(async tx=>{
   await this.requireLease(tx)
   const key=PRODUCTION_JOB_PREFIX+snapshot.seriesId,raw=await tx.get(key),old=raw?decode(raw,key):null
   if(expected?(!old||old.id!==expected.id||revision(old)!==expected.revision):!!old)throw new ProductionOwnershipConflict('Production job was replaced or changed; this process cannot overwrite it')
   if(!Number.isSafeInteger(snapshot.revision)||snapshot.revision!==(expected?.revision??0)+1)throw new ProductionOwnershipConflict('Exact next production revision required')
   if(old?.id===snapshot.id&&(JSON.stringify(old.config)!==JSON.stringify(snapshot.config)||old.status!=='running'&&old.status!==snapshot.status&&!(old.config.managedCrop&&['failed','interrupted'].includes(old.status)&&snapshot.status==='cancelled')))throw new ProductionOwnershipConflict('A retained job cannot change configuration or reopen after stopping')
   const handoff=old?.status!=='cancelled'&&old?.pendingHandoff&&old.id!==snapshot.id&&validHandoffReplacement(old,snapshot)
   if(old?.id!==snapshot.id&&old?.config.managedCrop&&['failed','interrupted','cancelled'].includes(old.status)) {
    const approval=snapshot.resumedFrom
    if(!handoff&&(old.status==='cancelled'||!approval||approval.jobId!==old.id||approval.revision!==revision(old)||!(/^[a-f0-9]{64}$/).test(approval.scopeDigest)||!Number.isFinite(Date.parse(approval.checkedAt))||!Array.isArray(approval.preparedTaskIds)||approval.preparedTaskIds.length>1000||new Set(approval.preparedTaskIds).size!==approval.preparedTaskIds.length||approval.preparedTaskIds.some(id=>!/^task:sha256:[a-f0-9]{64}$/.test(id))||JSON.stringify(snapshot.config)!==JSON.stringify(old.config)||JSON.stringify(snapshot.command)!==JSON.stringify(old.command)))throw new ProductionOwnershipConflict('Explicit inspected resume must retain the exact saved configuration and claim receipts')
   }
   if(old&&JSON.stringify(old.adoptedFrom)!==JSON.stringify(snapshot.adoptedFrom))throw new ProductionOwnershipConflict('The original adoption receipt must remain immutable')
   if(old?.pendingHandoff&&!handoff&&JSON.stringify(old.pendingHandoff)!==JSON.stringify(snapshot.pendingHandoff))throw new ProductionOwnershipConflict('Pending handoff cannot change before reconciliation')
   if(old&&!handoff&&JSON.stringify(old.handoffHistory)!==JSON.stringify(snapshot.handoffHistory))throw new ProductionOwnershipConflict('Handoff history must remain immutable')
   if(old?.id===snapshot.id&&JSON.stringify(old.resumedFrom)!==JSON.stringify(snapshot.resumedFrom))throw new ProductionOwnershipConflict('The persisted resume decision is immutable')
   if(old?.id!==snapshot.id) {
    const devices=new Set(productionDevices(snapshot.config).map(d=>d.device))
    for(const row of await tx.list(PRODUCTION_JOB_PREFIX)) {
     const other=decode(row.value,row.key)
     if(other.status==='running'&&(other.seriesId===snapshot.seriesId||productionDevices(other.config).some(d=>devices.has(d.device))))throw new ProductionOwnershipConflict('Automation is already running for this series or device')
    }
   }
   if(raw){if(!(await tx.replace(key,raw,JSON.stringify(snapshot))))throw new ProductionOwnershipConflict('Production job changed during save')}else await tx.insert(key,JSON.stringify(snapshot))
  })
 }
 close(){if(this.timer)clearInterval(this.timer);this.timer=undefined;this.lost=true;this.owned=false}
}
