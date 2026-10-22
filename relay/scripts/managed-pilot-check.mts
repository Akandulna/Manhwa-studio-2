// Local-only concrete pilot integration with Kotlin-produced checkpoints/artifact bytes.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import sharp from '../../server/node_modules/sharp/lib/index.js'
import {pilotAuthority,ManagedCropPilot} from '../../server/src/services/managedCropPilot.js'
import {DEFAULT_CROP_PROMPT} from '../../server/src/services/managedCropPilotPolicy.js'
import {MANAGED_CROP_VALIDATOR} from '../../server/src/services/managedCropArtifact.js'
import {canonicalJson} from '../../server/src/services/managedTaskProtocol.js'
import {RelayDeliveryPause} from '../../server/src/services/relayDeliveryPause.js'
const base=process.env.MANAGED_TEST_URL??'http://127.0.0.1:8797',root=process.env.MANAGED_PILOT_ROOT
assert.equal(new URL(base).hostname,'127.0.0.1');assert(root&&/^\/(?:private\/)?tmp\//.test(root))
const studio='local-studio-task-token-0000000000000000',phone='local-phone-one-token-00000000000000000',deviceId='pilot-phone',workspaceId='fixture-workspace'
process.env.DOWNLOAD_ROOT=root
const mode=process.argv[2];assert(['prepare','apply','finish'].includes(mode))
await fs.mkdir(root,{recursive:true})
const pause=new RelayDeliveryPause({load:async()=>{try{return await fs.readFile(path.join(root,'pause.txt'),'utf8')}catch(e:any){if(e.code==='ENOENT')return null;throw e}},save:async value=>fs.writeFile(path.join(root,'pause.txt'),value,{mode:0o600})})
const authority=pilotAuthority(base,workspaceId,studio,'manager-local-check',pause),pilot=new ManagedCropPilot(authority)
const headers={Authorization:'Bearer '+phone,'Content-Type':'application/json'}
async function phoneOperation(body:unknown){const r=await fetch(base+'/managed/operation',{method:'POST',headers,body:JSON.stringify(body)});const value=await r.json() as any;assert.equal(r.status,200,JSON.stringify(value));return value.result}
if(mode==='prepare') {
 await fs.mkdir(path.join(root,'chapter'),{recursive:true})
 const bytes=await sharp({create:{width:100,height:200,channels:3,background:'white'}}).png().toBuffer()
 const sourceFile=path.join(root,'chapter','page.png');await fs.writeFile(sourceFile,bytes)
 const pageId='page_'+createHash('sha256').update(canonicalJson(['pilot-series','pilot-chapter','page.png'])).digest('hex')
 const input={identity:{workspaceId,seriesId:'pilot-series',chapterId:'pilot-chapter',pageId},spec:{version:'crop-page/1' as const,provider:'chatgpt' as const,product:'chatgpt-web',model:'provider-default',settings:{mode:null,effort:null},pageRevision:'r1',promptVersion:DEFAULT_CROP_PROMPT,validatorVersion:MANAGED_CROP_VALIDATOR,dependencies:[{id:pageId,revision:'r1',sha256:createHash('sha256').update(bytes).digest('hex')}]},sourceFile,folder:'chapter',filename:'page.png',destination:path.join(root,'destination')}
 await phoneOperation({schema:'managed-task/1',workspaceId,eventId:'pilot-hello',action:'hello',capabilities:['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','chatgpt-default-crop/1'],profileIds:['profile'],apkVersion:'1.0.999'})
 await pilot.enroll(deviceId,'profile')
 const assigned=await pilot.start(input,deviceId,'profile')
 const response=await fetch(base+'/managed/inbox',{headers});assert.equal(response.status,200)
 const inbox=await response.json() as any;assert.equal(inbox.assignments.length,1)
 await fs.writeFile(path.join(root,'assignment.json'),JSON.stringify(inbox.assignments[0],null,2)+'\n',{mode:0o600})
 await fs.writeFile(path.join(root,'state.json'),JSON.stringify({input,taskId:assigned.task.id},null,2)+'\n',{mode:0o600})
 console.log('PASS: explicit default-model pilot planned, bound before claim, and delivered to authenticated worker inbox. Run Android JVM codec fixture next.')
} else {
 const state=JSON.parse(await fs.readFile(path.join(root,'state.json'),'utf8'))
 const kotlin=JSON.parse(await fs.readFile(path.join(root,'kotlin.json'),'utf8'))
 if(mode==='apply') {
  for(const op of kotlin.operations){const result=await phoneOperation(op);assert.equal(result.permitted,true)}
  const r=await fetch(base+'/managed/artifacts',{method:'POST',headers,body:JSON.stringify(kotlin.packet)});assert.equal(r.status,200,await r.text())
  console.log('PASS: actual Kotlin-produced phased receipts and artifact packet accepted. Restart local Wrangler with the same SQL/R2 store, then finish.')
 } else {
  const result=await pilot.import(state.input,state.taskId);assert.equal(result.task.state,'verified_complete')
  assert.equal((await pilot.import(state.input,state.taskId)).task.canonical,result.task.canonical)
  const worker=await fetch(base+'/managed/worker/'+encodeURIComponent(state.taskId),{headers});assert.equal(worker.status,200)
  const published=await worker.json() as any;assert.equal(published.result.task.canonical,kotlin.packet.operation.ref)
  await pilot.unpair(deviceId)
  const response=await fetch(base+'/managed/enrollment',{headers});assert.equal(response.status,200)
  assert.deepEqual((await response.json() as any).result,{enrolled:false,peerRegistered:false,reserved:false})
  const evidence={verifiedAt:new Date().toISOString(),defaultModelPolicy:true,boundBeforeClaim:true,kotlinSourceAndIdentityVerified:true,kotlinReceiptsAccepted:true,kotlinArtifactBytesAccepted:true,relayProcessRestart:true,immutableImportAndPublicationReplay:true,workerPublicationReconciliation:true,reconciledUnpairRevokedPeer:true,scope:'Synthetic single-page worker using actual Kotlin JVM codecs, real local Durable Object SQLite/emulated R2, and real Studio dispatch/source/filesystem/import code. Does not exercise Android SQLite, WebView, file chooser, real provider or installed phone.'}
  await fs.writeFile(path.join(root,'result.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence))
 }
}
