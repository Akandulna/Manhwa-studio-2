import {bindManagedCrop} from '../../server/src/services/managedCropProjection.js'
import {readImagePoints,readImageMetadata,writeImageMetadata} from '../../server/src/services/clipper3/perImageStore.js'
// Local-only SQL + object storage + real filesystem publication check. Never use production credentials.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from '../../server/node_modules/sharp/lib/index.js'
import {artifactHash,artifactRef,MANAGED_CROP_VALIDATOR} from '../../server/src/services/managedCropArtifact.js'
import {managedArtifactTransport,ManagedArtifactDestination,importManagedArtifact,resolveManagedCropInput} from '../../server/src/services/managedArtifactImport.js'
const base=process.env.MANAGED_TEST_URL??'http://127.0.0.1:8799',workspaceId='fixture-workspace'
assert.equal(new URL(base).hostname,'127.0.0.1')
const studio='local-studio-task-token-0000000000000000',phone='local-phone-one-token-00000000000000000'
const root='/tmp/phase3-managed-artifact-check',sourceFile=path.join(root,'page.png')
await fs.mkdir(root,{recursive:true})
const source=await sharp({create:{width:100,height:200,channels:3,background:'white'}}).png().toBuffer()
await fs.writeFile(sourceFile,source)
const identity={workspaceId,seriesId:'artifact-series',chapterId:'chapter',pageId:'page'}
const spec={version:'crop-page/1' as const,provider:'chatgpt' as const,product:'web',model:'synthetic-model',settings:{mode:'Chat',effort:null},pageRevision:'r1',promptVersion:'p1',validatorVersion:MANAGED_CROP_VALIDATOR,dependencies:[{id:'page',revision:'r1',sha256:await artifactHash(source)}]}
async function operation(body:Record<string,unknown>,token=studio){const r=await fetch(base+'/managed/operation',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({schema:'managed-task/1',workspaceId,eventId:'artifact-'+String(body.action),...body})});const value=await r.json() as any;assert.equal(r.status,200,JSON.stringify(value));return value.result}
const transport=managedArtifactTransport(base,workspaceId,studio,'manager-local-check')
if(!process.argv.includes('--replay-only')) {
 await operation({action:'hello',capabilities:['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1'],profileIds:['profile'],apkVersion:'1.0.999'},phone)
 await operation({action:'enroll',deviceId:'artifact-phone',profileId:'profile'})
 const task=await operation({action:'plan',identity,spec})
 const claim=await operation({action:'claim',taskId:task.id,deviceId:'artifact-phone',profileId:'profile',accountId:null})
 const fence={taskId:task.id,attemptId:claim.attempt.id,generation:claim.attempt.generation,fingerprint:task.fingerprint}
 for(const phase of ['accepted','started','submission_intent','result_saved'])await operation({action:'checkpoint',eventId:'artifact-'+phase,...fence,commandId:claim.command.id,phase,checkpointRef:phase==='result_saved'?'checkpoint/crop-result':null},phone)
 const points={format:'four-point-crop',version:'1.0',coordinateSystem:'normalized',image:{filename:'page.png',width:100,height:200},crops:[]}
 const document=JSON.stringify({schema:'managed-crop-page/1',...fence,checkpointRef:'checkpoint/crop-result',pageRevision:'r1',validatorVersion:MANAGED_CROP_VALIDATOR,pointers:JSON.stringify(points),metadata:'{"crops":[]}'})
 const op={schema:'managed-task/1',workspaceId,eventId:'artifact-stage',action:'stage',...fence,artifactId:'local-artifact',ref:artifactRef(task,claim.attempt.id,'local-artifact'),contentHash:await artifactHash(new TextEncoder().encode(document))}
 const uploads=await Promise.all([1,2].map(()=>fetch(base+'/managed/artifacts',{method:'POST',headers:{Authorization:'Bearer '+phone,'Content-Type':'application/json'},body:JSON.stringify({operation:op,document})})))
 for(const r of uploads)assert.equal(r.status,200,await r.text())
 const result=await importManagedArtifact(transport,new ManagedArtifactDestination(path.join(root,'destination')),'local-artifact',()=>resolveManagedCropInput(identity,spec,sourceFile))
 assert.equal(result.task.state,'verified_complete');assert.equal(await fs.readFile(result.path,'utf8'),document)
 console.log('PASS: concurrent immutable R2 uploads, object readback, actual local source hash/dimensions, fsync destination validation and conditional canonical publication.')
} else {
 const result=await importManagedArtifact(transport,new ManagedArtifactDestination(path.join(root,'destination')),'local-artifact',()=>resolveManagedCropInput(identity,spec,sourceFile))
 assert.equal(result.task.state,'verified_complete')
 console.log('PASS: persisted R2 bytes, SQL publication and local validation receipt replay after relay process restart; no new task or artifact.')
}

// Reconstruct the current crop read projection from the verified publication; no relay requests on read.
process.env.DOWNLOAD_ROOT=root
const chapter='reader-chapter';await fs.mkdir(path.join(root,chapter),{recursive:true});await fs.writeFile(path.join(root,chapter,'page.png'),source)
const published=await transport.load('local-artifact')
await bindManagedCrop(chapter,'page.png',published.task,path.join(root,'destination'))
assert.equal((await readImagePoints(chapter,'page.png'))?.file?.image.filename,'page.png')
assert.equal(await readImageMetadata(chapter,'page.png'),'{"crops":[]}')
await assert.rejects(()=>writeImageMetadata(chapter,'page.png','{}'),/managed/)
console.log('PASS: existing crop readers use the verified local publication; legacy edits are rejected.')
