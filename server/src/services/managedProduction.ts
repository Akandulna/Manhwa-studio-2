import {randomUUID} from 'node:crypto'
import {cropTaskIdentity,TaskConflict} from './managedTaskProtocol.js'
import {ManagedCropPilot,type PilotInput,type PilotAuthority} from './managedCropPilot.js'
import {managedCropBinding} from './managedCropProjection.js'

export interface ManagedProductionClaim {taskId:string;claimEventId:string;deviceId:string;profileId:string}
export interface ManagedProductionDependencies {
 claims?:ManagedProductionClaim[]
 expectedTaskIds?:string[]
 authority:PilotAuthority
 inputs:()=>Promise<PilotInput[]>
 report:(message:string,taskId:string|null,claim?:ManagedProductionClaim)=>Promise<void>
 wait:(signal:AbortSignal,device?:string)=>Promise<void>
 now?:()=>number
}
/** A running, explicit foreground-phone workflow. The authority owns every page; job state is only UI intent. */
export async function runManagedProduction(device:string,profile:string,signal:AbortSignal,deps:ManagedProductionDependencies) {
 const pilot=new ManagedCropPilot(deps.authority),now=deps.now??Date.now
 await deps.authority.ready(['production-claim-stop/1'])
 const inputs=await deps.inputs()
 if(!inputs.length||inputs.length>1000)throw new TaskConflict('Choose 1–1000 prepared source pages')
 const ids=new Set<string>()
 // Preflight the whole scope before assigning any new page. Never work around cancelled/changed bindings.
 for(const input of inputs) {
  signal.throwIfAborted()
  const expected=await cropTaskIdentity(input.identity,input.spec)
  if(ids.has(expected.taskId))throw new TaskConflict('Duplicate managed page in production scope')
  ids.add(expected.taskId)
  const binding=await managedCropBinding(input.folder,input.filename)
  if(binding) {
   if(binding.task.id!==expected.taskId)throw new TaskConflict('Input changed; explicitly reconcile and rebind its revision before production')
   const current=await deps.authority.timeline(expected.taskId)
   if(['cancelled','paused','uncertain','superseded'].includes(current.task.state))throw new TaskConflict('Reconcile the retained task before production; no replacement prompt is allowed')
   if(current.task.state!=='verified_complete'&&current.attempt&&(current.attempt.deviceId!==device||current.attempt.profileId!==profile))throw new TaskConflict('A page belongs to another phone/profile')
  }
 }
 if(deps.expectedTaskIds&&(ids.size!==deps.expectedTaskIds.length||deps.expectedTaskIds.some(id=>!ids.has(id))))throw new TaskConflict('Prepared source scope changed after inspected resume; inspect the saved run again')
 for(const input of inputs) {
  signal.throwIfAborted()
  const {taskId}=await cropTaskIdentity(input.identity,input.spec)
  // Persist an immutable claim intent after binding and before dispatch. Stop resolves only that receipt.
  await deps.report('Planning managed page '+input.filename,null)
  signal.throwIfAborted()
  if(!deps.claims?.some(c=>c.taskId===taskId)){const binding=await managedCropBinding(input.folder,input.filename);if(binding){const verified=await deps.authority.timeline(taskId);if(verified.task.state==='verified_complete'){await pilot.import(input,taskId);await deps.report('Reusing verified output for '+input.filename,null);continue}}}
  const claim=deps.claims?.find(c=>c.taskId===taskId)??{taskId,claimEventId:randomUUID(),deviceId:device,profileId:profile}
  if(claim.deviceId!==device||claim.profileId!==profile)throw new TaskConflict('Saved production claim belongs to another phone/profile')
  let current=await pilot.start(input,device,profile,async()=>{await deps.report('Assigning managed page '+input.filename,taskId,claim);signal.throwIfAborted()},claim.claimEventId)
  let owner=current.attempt
  const assertOwner=()=>{if(owner&&(current.attempt?.id!==owner.id||current.attempt.generation!==owner.generation))throw new TaskConflict('Production ownership changed; this job cannot follow a transferred attempt')}
  let deadline=now()+20*60_000
  while(current.task.state!=='verified_complete') {
   signal.throwIfAborted()
   assertOwner()
   if(!current.waiting&&now()>deadline)throw new TaskConflict('Managed page is still waiting. Inspect the retained task; no provider retry was sent')
   if(['cancelled','paused','uncertain','superseded'].includes(current.task.state))throw new TaskConflict('Managed task '+current.task.state+'; retained work needs reconciliation')
   if(current.waiting&&!current.attempt&&current.task.state==='queued') {
    const reasons=[...new Set(current.waiting.candidates.flatMap(c=>c.reasons))].join(', ')
    await deps.report('Waiting for eligible account: '+reasons,taskId)
    await deps.wait(signal,device);signal.throwIfAborted()
    current=await pilot.start(input,device,profile,()=>Promise.resolve(signal.throwIfAborted()),claim.claimEventId)
    if(current.attempt&&!owner){owner=current.attempt;deadline=now()+20*60_000}
    continue
   }
   if(current.attempt?.phase==='result_saved'&&current.attempt.submission==='saved'&&current.artifactReady===true) {
    await deps.report('Validating original saved output for '+input.filename,taskId)
    await pilot.import(input,taskId,false,owner??undefined)
   }else {
    if(now()>deadline)throw new TaskConflict('Managed page is still waiting. Inspect the retained task; no provider retry was sent')
    const instruction=current.attempt?.phase==='assigned'?'On the paired phone, reconcile any previous publication, then tap Check task / run.':current.attempt?.phase==='result_saved'?'Waiting for the original saved artifact upload; no new prompt is needed.':current.attempt?.submission==='submitted'?'The phone is waiting for the original reply. Keep its managed run open.':'The phone is preparing this assignment. Do not tap Send or restart it.'
    await deps.report('Waiting for '+input.filename+'. '+instruction,taskId)
    await deps.wait(signal,device)
   }
   signal.throwIfAborted()
   current=await deps.authority.timeline(taskId)
  }
  assertOwner()
  // Rebuild the local projection after a lost publication reply; this does not regenerate or claim.
  await pilot.import(input,taskId,false,owner??undefined)
 }
}
/** Legacy task-ID-only jobs require explicit page reconciliation; never adopt the current owner. */
export async function stopManagedProduction(authority:PilotAuthority,claims:ManagedProductionClaim[],taskIds:string[]=[]) {
 if(taskIds.some(id=>!claims.some(c=>c.taskId===id)))throw new TaskConflict('This saved job has no durable claim receipt. Inspect and stop its exact page manually')
 const failures:unknown[]=[]
 for(const claim of new Map(claims.map(c=>[c.claimEventId,c])).values()) {
  try {await authority.operation({action:'stop_claim',taskId:claim.taskId,claimEventId:claim.claimEventId,eventId:'stop_'+claim.claimEventId})}catch(error){failures.push(error)}
 }
 if(failures.length)throw new TaskConflict('Some original production claims could not be stopped; inspect retained ownership. No current owner was adopted')
}


/** Free explicitly selected phones take distinct unclaimed pages; held original work is never regenerated. */
export async function runManagedFleet(devices:{device:string;profileId:string}[],signal:AbortSignal,deps:ManagedProductionDependencies) {
 if(!devices.length||devices.length>8||new Set(devices.map(d=>d.device)).size!==devices.length)throw new TaskConflict('Choose one to eight distinct managed phones')
 const inputs=await deps.inputs(),byId=new Map<string,PilotInput>()
 if(!inputs.length||inputs.length>1000)throw new TaskConflict('Choose 1–1000 prepared source pages')
 for(const input of inputs){const expected=await cropTaskIdentity(input.identity,input.spec);if(byId.has(expected.taskId))throw new TaskConflict('Duplicate managed page');byId.set(expected.taskId,input);const binding=await managedCropBinding(input.folder,input.filename);if(binding&&binding.task.id!==expected.taskId)throw new TaskConflict('Input changed before fleet dispatch')}
 if(deps.expectedTaskIds&&(deps.expectedTaskIds.length!==byId.size||deps.expectedTaskIds.some(id=>!byId.has(id))))throw new TaskConflict('Prepared source scope changed after inspected resume')
 const claims=deps.claims??[],retained=new Map<string,PilotInput[]>(),unclaimed:PilotInput[]=[]
 for(const claim of claims){if(!byId.has(claim.taskId)||!devices.some(d=>d.device===claim.deviceId&&d.profileId===claim.profileId))throw new TaskConflict('Saved claim is outside this exact managed fleet scope')}
 for(const [id,input] of byId){const claim=claims.find(c=>c.taskId===id);if(claim){const list=retained.get(claim.deviceId)??[];list.push(input);retained.set(claim.deviceId,list)}else unclaimed.push(input)}
 const occupied=new Set<string>(),pilot=new ManagedCropPilot(deps.authority)
 let selectionQueue:Promise<unknown>=Promise.resolve()
 async function nextUnclaimed(target:{device:string;profileId:string}):Promise<{input?:PilotInput;reasons?:string}> {
  const work=selectionQueue.catch(()=>{}).then(async()=>{
   const input=unclaimed[0]
   if(!input)return {}
   signal.throwIfAborted()
   if(deps.authority.selectAccount){
    const prepared=await pilot.prepare(input)
    if(prepared.task.state!=='verified_complete'){
     const selection=await deps.authority.selectAccount(prepared.task.id,devices.filter(d=>!occupied.has(d.device)).map(d=>({deviceId:d.device,profileId:d.profileId})))
     const disabled=!selection.routingRequired&&selection.candidates.every(c=>c.reasons.includes('account_routing_disabled'))
     if(!disabled&&selection.selected?.deviceId!==target.device)return {reasons:selection.state==='waiting'?[...new Set(selection.candidates.flatMap(c=>c.reasons))].join(', '):'Waiting for preferred eligible phone '+selection.selected?.deviceId}
    }
   }
   occupied.add(target.device);unclaimed.shift();return {input}
  })
  selectionQueue=work;return work
 }
 const outcomes=await Promise.allSettled(devices.map(async target=>{
  const own=retained.get(target.device)??[]
  while(true){signal.throwIfAborted();let input=own.shift()
   if(input)occupied.add(target.device)
   else {const next=await nextUnclaimed(target);input=next.input;if(!input){if(!unclaimed.length)return;await deps.report('Waiting for account selection: '+(next.reasons??'eligible phone'),null);await deps.wait(signal,target.device);continue}}
   try {await runManagedProduction(target.device,target.profileId,signal,{...deps,expectedTaskIds:undefined,inputs:async()=>[input],report:(message,id,claim)=>deps.report(target.device+': '+message,id,claim)})}finally{occupied.delete(target.device)}
  }
 }))
 const failures=outcomes.filter((r):r is PromiseRejectedResult=>r.status==='rejected')
 if(failures.length)throw new TaskConflict('Managed fleet retained '+failures.length+' phone outcome(s) for reconciliation. Healthy distinct pages continued. '+failures.map(r=>r.reason instanceof Error?r.reason.message:String(r.reason)).join('; '))
}
