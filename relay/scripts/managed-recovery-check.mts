// Isolated synthetic worker only. Validates authority/storage recovery, never a phone/provider.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import sharp from '../../server/node_modules/sharp/lib/index.js'
import {artifactHash,artifactRef,MANAGED_CROP_VALIDATOR} from '../../server/src/services/managedCropArtifact.js'
import {ManagedArtifactDestination,importManagedArtifact,managedArtifactTransport,resolveManagedCropInput} from '../../server/src/services/managedArtifactImport.js'
import {bindManagedCrop} from '../../server/src/services/managedCropProjection.js'
import {cutManagedCrop,readManagedCropCut} from '../../server/src/services/managedCropCut.js'

const base=process.env.MANAGED_TEST_URL??'http://127.0.0.1:8799'
assert.equal(new URL(base).hostname,'127.0.0.1')
const root=process.env.MANAGED_RECOVERY_ROOT
assert(root && path.isAbsolute(root) && /^\/(?:private\/)?tmp\//.test(root),'Choose a private /tmp fixture directory')
const mode=process.argv[2];assert(['prepare','resume','verify'].includes(mode))
const workspaceId='fixture-workspace',deviceId='artifact-phone'
const studio='local-studio-task-token-0000000000000000',phone='local-artifact-phone-token-0000000000000'
const headers=(token:string)=>({Authorization:'Bearer '+token,'Content-Type':'application/json'})
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
async function durable(name:string,value:unknown) {
 const file=await fs.open(path.join(root,name),'w',0o600)
 try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync()}finally{await file.close()}
 const dir=await fs.open(root,'r');try{await dir.sync()}finally{await dir.close()}
}
async function send(body:Record<string,unknown>,token=studio,expected=200) {
 const r=await fetch(base+'/managed/operation',{method:'POST',headers:headers(token),body:JSON.stringify({schema:'managed-task/1',workspaceId,eventId:randomUUID(),...body})})
 const json=await r.json() as any;assert.equal(r.status,expected,JSON.stringify(json));return json.result
}
async function timeline(taskId:string) {
 const r=await fetch(base+'/managed/tasks/'+encodeURIComponent(taskId),{headers:headers(studio)});assert.equal(r.status,200);return await r.json() as any
}
const fence=(a:any)=>({taskId:a.task.id,attemptId:a.attempt.id,generation:a.attempt.generation,fingerprint:a.task.fingerprint})
async function checkpoint(a:any,phase:string,checkpointRef:string|null=null,eventId=randomUUID(),expected=200) {
 return send({action:'checkpoint',eventId,...fence(a),commandId:a.command.id,phase,checkpointRef},phone,expected)
}
async function packet(a:any,id:string) {
 const points={format:'four-point-crop',version:'1.0',coordinateSystem:'normalized',image:{filename:'page.png',width:100,height:200},crops:[{id:'crop-01',reason:'panel',crop:{mode:'rectangle',points:[{id:'P1',x:0,y:0},{id:'P2',x:0.5,y:0},{id:'P3',x:0.5,y:1},{id:'P4',x:0,y:1}]}}]}
 const metadata={crops:[{id:'crop-01',exportedFilename:'fixture_page_01_panel.png',description:'Synthetic panel'}]}
 const document=JSON.stringify({schema:'managed-crop-page/1',...fence(a),checkpointRef:'checkpoint/'+id,pageRevision:'r1',validatorVersion:MANAGED_CROP_VALIDATOR,pointers:JSON.stringify(points),metadata:JSON.stringify(metadata)})
 return {operation:{schema:'managed-task/1',workspaceId,eventId:'upload-'+id,action:'stage',...fence(a),artifactId:id,ref:artifactRef(a.task,a.attempt.id,id),contentHash:hash(document)},document}
}
async function upload(value:any) {
 const r=await fetch(base+'/managed/artifacts',{method:'POST',headers:headers(phone),body:JSON.stringify(value)})
 const result=await r.json() as any;assert.equal(r.status,200,JSON.stringify(result));return result.result
}
process.env.DOWNLOAD_ROOT=root
const sourceFile=path.join(root,'chapter','page.png'),destination=path.join(root,'destination')
if(mode==='prepare') {
 await fs.mkdir(path.dirname(sourceFile),{recursive:true})
 await fs.writeFile(sourceFile,await sharp({create:{width:100,height:200,channels:3,background:'white'}}).png().toBuffer())
 const identity={workspaceId,seriesId:'recovery-series',chapterId:'chapter',pageId:'page'}
 const spec={version:'crop-page/1',provider:'chatgpt',product:'web',model:'synthetic-model',settings:{mode:'Work',effort:'Medium'},pageRevision:'r1',promptVersion:'fixture-p1',validatorVersion:MANAGED_CROP_VALIDATOR,dependencies:[{id:'page',revision:'r1',sha256:await artifactHash(await fs.readFile(sourceFile))}]}
 await send({action:'hello',capabilities:['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1'],profileIds:['profile'],apkVersion:'1.0.999'},phone)
 await send({action:'enroll',deviceId,profileId:'profile'})
 const task=await send({action:'plan',identity,spec})
 await bindManagedCrop('chapter','page.png',task,destination) // Before dispatch/claim.
 const claim=await send({action:'claim',taskId:task.id,deviceId,profileId:'profile',accountId:null})
 await checkpoint(claim,'accepted');await checkpoint(claim,'started');await checkpoint(claim,'submission_intent')
 const saved=await packet(claim,'saved-output'),savedEventId=randomUUID()
 await durable('checkpoint.json',JSON.parse(saved.document)) // Commit output before its reference is sent.
 await checkpoint(claim,'result_saved','checkpoint/saved-output',savedEventId)
 await upload(saved)
 await durable('state.json',{identity,spec,claim,saved,savedEventId,preparedAt:new Date().toISOString()})
 console.log('PASS: binding precedes claim; checkpoint bytes are durable; saved result and immutable R2 upload ready for actual relay process restart.')
} else {
 const state=JSON.parse(await fs.readFile(path.join(root,'state.json'),'utf8'))
 if(mode==='resume') {
  const recovered=await timeline(state.claim.task.id)
  assert.equal(recovered.attempt.phase,'result_saved');assert.equal(recovered.attempt.checkpointRef,'checkpoint/saved-output')
  await checkpoint(state.claim,'result_saved','checkpoint/saved-output',state.savedEventId) // Exact lost-ACK retry.
  await upload(state.saved)
  const transport=managedArtifactTransport(base,workspaceId,studio),publish=transport.publish.bind(transport)
  let lost=true;const events:string[]=[]
  transport.publish=async operation=>{events.push(operation.eventId);const result=await publish(operation);if(lost){lost=false;throw new Error('simulated lost publication acknowledgment')}return result}
  const current=()=>resolveManagedCropInput(state.identity,state.spec,sourceFile)
  await assert.rejects(()=>importManagedArtifact(transport,new ManagedArtifactDestination(destination),'saved-output',current),/lost publication acknowledgment/)
  const result=await importManagedArtifact(transport,new ManagedArtifactDestination(destination),'saved-output',current)
  assert.equal(result.task.state,'verified_complete');assert.equal(events[0],events[1])
  const cut=await cutManagedCrop('chapter','page.png');assert.equal(cut.files.length,1);assert.equal(cut.files[0].width,50);assert.equal(cut.files[0].height,200)
  assert.deepEqual(await readManagedCropCut('chapter','page.png'),cut)
  const task=await send({action:'plan',identity:{...state.identity,pageId:'cancelled-page'},spec:state.spec})
  const cancel=await send({action:'claim',taskId:task.id,deviceId,profileId:'profile',accountId:null})
  await checkpoint(cancel,'accepted');await checkpoint(cancel,'started');await checkpoint(cancel,'submission_intent')
  await checkpoint(cancel,'result_saved','checkpoint/cancelled-output');await upload(await packet(cancel,'cancelled-output'))
  const stopped=await send({action:'stop',taskId:task.id,cancel:true})
  await send({action:'publish',...fence(cancel),artifactId:'cancelled-output',contentHash:hash((await packet(cancel,'cancelled-output')).document),validationRef:'validation/must-not-publish'},studio,409)
  assert.equal((await timeline(task.id)).task.canonical,null)
  await checkpoint({...cancel,command:stopped.command},'stop_confirmed')
  const unknownTask=await send({action:'plan',identity:{...state.identity,pageId:'unknown-page'},spec:state.spec})
  const unknown=await send({action:'claim',taskId:unknownTask.id,deviceId,profileId:'profile',accountId:null})
  await checkpoint(unknown,'accepted');await checkpoint(unknown,'started');await checkpoint(unknown,'submission_intent')
  await checkpoint(unknown,'submission_intent',null,randomUUID(),409)
  const stopUnknown=await send({action:'stop',taskId:unknown.task.id,cancel:true})
  await checkpoint({...unknown,command:stopUnknown.command},'stop_confirmed')
  state.cancelledTaskId=task.id;state.unknownTaskId=unknown.task.id
  state.completed={savedOutputAfterRestart:true,lostCheckpointAckReplay:true,immutableUploadReplay:true,lostPublicationAckReplay:true,cutWidth:50,cutHeight:200,cancelledPublicationRejected:true,unknownSubmissionNotReplayed:true}
  await durable('state.json',state)
  console.log('PASS: saved output survives relay restart; lost acknowledgments replay identically; actual local cut verified; cancelled publication rejected; uncertain submission retained for second restart.')
 } else {
  const published=await timeline(state.claim.task.id),unknown=await timeline(state.unknownTaskId),cancelled=await timeline(state.cancelledTaskId)
  assert.equal(published.task.state,'verified_complete');assert.equal(cancelled.task.state,'cancelled');assert.equal(cancelled.task.canonical,null)
  assert.equal(unknown.attempt.submission,'unknown');assert.equal(unknown.attempt.phase,'stop_confirmed')
  const other=await send({action:'plan',identity:{...state.identity,pageId:'must-wait-page'},spec:state.spec})
  await send({action:'claim',taskId:other.id,deviceId,profileId:'profile',accountId:null},studio,409)
  assert.equal((await readManagedCropCut('chapter','page.png'))?.files.length,1)
  const evidence={verifiedAt:new Date().toISOString(),...state.completed,secondRelayRestart:true,unknownReservationSurvivedRestart:true,completedArtifactStillVerified:true,scope:'Synthetic worker over real local Durable Object SQL and emulated R2, plus Studio filesystem/Sharp adapters. No installed-phone executor, provider prompt, production task or deployment.'}
  await durable('result.json',evidence);console.log(JSON.stringify(evidence))
 }
}
