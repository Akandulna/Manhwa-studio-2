import {randomUUID} from 'node:crypto'
import type {PilotAuthority} from './managedCropPilot.js'
import {TaskConflict,type CoordinatorFence,type CoordinatorLease,type ManagedOperation} from './managedTaskProtocol.js'
/** One foreground coordinator per authority workspace, shared by this process's explicit jobs. */
export class ManagedProductionCoordinator {
 private readonly id=randomUUID()
 private fence:CoordinatorFence|null=null
 private users=0
 private lost=false
 private renewAfter=0
 private renewing:Promise<void>|null=null
 private lifecycle:Promise<unknown>=Promise.resolve()
 constructor(private now=Date.now) {}
 private serial<T>(work:()=>Promise<T>):Promise<T> {const next=this.lifecycle.catch(()=>{}).then(work);this.lifecycle=next;return next}
 private lease(value:any):CoordinatorLease {
  if(!value||value.coordinatorId!==this.id||!Number.isSafeInteger(value.coordinatorGeneration)||value.coordinatorGeneration<1||value.state!=='held'||!Number.isFinite(Date.parse(value.leaseExpiresAt)))throw new TaskConflict('Invalid coordinator lease acknowledgment; retain authority ownership')
  return value
 }
 private async guard(authority:PilotAuthority,force=false):Promise<void> {
  if(this.lost||!this.fence)throw new TaskConflict('Production coordinator was lost; reconcile before starting another operation')
  if(this.renewing)return this.renewing
  if(!force&&this.now()<this.renewAfter)return
  const fence=this.fence
  const renewal=authority.operation({action:'coordinator_renew',...fence}).then(raw=>{
   const lease=this.lease(raw)
   if(lease.coordinatorGeneration!==fence.coordinatorGeneration)throw new TaskConflict('Coordinator renewal changed generation')
   this.renewAfter=this.now()+20_000
  }).catch(error=>{this.lost=true;throw error})
  this.renewing=renewal
  try{await renewal}finally{if(this.renewing===renewal)this.renewing=null}
 }
 private async enter(authority:PilotAuthority) {
  if(this.users){await this.guard(authority,true);this.users++;return}
  await authority.ready(['production-coordinator/1'])
  if(!authority.coordinator)throw new TaskConflict('Coordinator status transport is required')
  const current=await authority.coordinator()
  this.lost=false
  if(current?.state==='held'&&current.coordinatorId===this.id) {
   this.fence={coordinatorId:this.id,coordinatorGeneration:current.coordinatorGeneration}
   // Resolve a lost acquire/release reply without allocating or silently reviving an expired lease.
   try {await this.guard(authority,true);this.users=1;return}catch(error){this.fence=null;throw error}
  }
  const lease=this.lease(await authority.operation({action:'coordinator_acquire',coordinatorId:this.id,expectedGeneration:current?.coordinatorGeneration??0}))
  this.fence={coordinatorId:this.id,coordinatorGeneration:lease.coordinatorGeneration};this.renewAfter=this.now()+20_000;this.users=1
 }
 private async leave(authority:PilotAuthority) {
  this.users--
  if(this.users)return
  const fence=this.fence;this.fence=null
  if(fence)await authority.operation({action:'coordinator_release',...fence})
 }
 async withLease<T>(authority:PilotAuthority,work:(fenced:PilotAuthority)=>Promise<T>):Promise<T> {
  await this.serial(()=>this.enter(authority))
  const fields=()=>{if(!this.fence)throw new TaskConflict('Missing production coordinator');return this.fence}
  const fenced:PilotAuthority={...authority,
   operation:async op=>{
    await this.guard(authority)
    if(String(op.action).startsWith('coordinator_'))throw new TaskConflict('Coordinator lifecycle is private')
    const action=op.action==='claim'?'claim_production':op.action==='stop_claim'?'stop_production_claim':op.action==='stop'?'stop_production':op.action
    return authority.operation({...op,action,...(['transfer_production','pause_production_claim','claim_production','stop_production_claim','stop_production'].includes(String(action))?fields():{})})
   },
   timeline:async id=>{await this.guard(authority);return authority.timeline(id)},
   artifacts:{load:async id=>{await this.guard(authority);return authority.artifacts.load(id)},publish:async op=>{
    await this.guard(authority)
    if(!['publish','publish_recovered'].includes(op.action))throw new TaskConflict('Expected trusted publication')
    return authority.artifacts.publish({...op,action:'publish_production',recovered:op.action==='publish_recovered',...fields()} as ManagedOperation)
   }}
  }
  let result:T|undefined,failure:unknown
  try {result=await work(fenced)}catch(error){failure=error}
  try {await this.serial(()=>this.leave(authority))}catch(error){if(!failure)failure=new TaskConflict('Coordinator release is unconfirmed; retain saved work and reconcile authority ownership')}
  if(failure)throw failure
  return result as T
 }
}
export const managedProductionCoordinator=new ManagedProductionCoordinator()
