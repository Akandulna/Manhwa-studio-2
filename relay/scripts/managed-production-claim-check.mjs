// Local synthetic workers only. No production credentials or provider requests.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const base=process.env.MANAGED_TEST_URL??'http://127.0.0.1:8799'
assert.equal(new URL(base).hostname,'127.0.0.1')
const studio='local-studio-task-token-0000000000000000',phone='local-phone-one-token-00000000000000000',workspaceId='fixture-workspace'
const evidence=process.env.MANAGED_CLAIM_EVIDENCE??'/tmp/managed-phase4-production-claim-evidence.json'
assert.match(evidence,/^\/(?:private\/)?tmp\//)
async function call(route,body,token=studio){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()}}
async function op(body,token=studio){return call('/managed/operation',{schema:'managed-task/1',workspaceId,eventId:crypto.randomUUID(),...body},token)}
async function ok(body,token=studio){const r=await op(body,token);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.result}
if(process.argv.includes('--verify-restart')){
 const saved=JSON.parse(await fs.readFile(evidence,'utf8'))
 assert.deepEqual(await ok(saved.stop),saved.stopped)
 assert.equal((await op(saved.claim)).status,409)
 assert.deepEqual((await call('/managed/tasks/'+encodeURIComponent(saved.taskId))).body,saved.timeline)
 assert.deepEqual(await ok(saved.receiptStop),saved.receiptStopped)
 console.log('PASS: local Worker restart retained delayed-claim tombstone, exact stop receipt and unchanged assignment history.')
 process.exit(0)
}
const ready=await call('/managed/readiness');assert(ready.body.result.capabilities.includes('production-claim-stop/1'))
await ok({action:'hello',capabilities:['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','chatgpt-default-crop/1'],profileIds:['profile'],apkVersion:'1.0.999'},phone)
await ok({action:'enroll',deviceId:'local-phone-1',profileId:'profile'})
const identity={workspaceId,seriesId:'claim-series',chapterId:'claim-chapter',pageId:'delayed-claim-page'},spec={version:'crop-page/1',provider:'chatgpt',product:'chatgpt-web',model:'provider-default',settings:{mode:null,effort:null},pageRevision:'r1',promptVersion:'managed-chatgpt-default-crop/1',validatorVersion:'managed-crop-validator/1',dependencies:[{id:identity.pageId,revision:'r1',sha256:'a'.repeat(64)}]}
const task=await ok({action:'plan',identity,spec}),claim={action:'claim',eventId:'delayed-production-claim',taskId:task.id,deviceId:'local-phone-1',profileId:'profile',accountId:null}
const stop={action:'stop_claim',eventId:'stop-delayed-production-claim',taskId:task.id,claimEventId:claim.eventId}
assert.equal((await op(stop,phone)).status,403)
const stopped=await ok(stop);assert.equal(stopped.blockedBeforeClaim,true);assert.equal((await op(claim)).status,409)
const otherClaim={...claim,eventId:'different-production-claim'},assigned=await ok(otherClaim)
const receiptStop={action:'stop_claim',eventId:'stop-different-production-claim',taskId:task.id,claimEventId:otherClaim.eventId},receiptStopped=await ok(receiptStop)
assert.equal(receiptStopped.command.attemptId,assigned.attempt.id);assert.equal(receiptStopped.task.state,'cancelled')
assert.deepEqual(await ok(receiptStop),receiptStopped)
const timeline=(await call('/managed/tasks/'+encodeURIComponent(task.id))).body
assert.equal(timeline.commands.length,2)
await fs.writeFile(evidence,JSON.stringify({synthetic:true,providerRequests:0,taskId:task.id,claim,stop,stopped,receiptStop,receiptStopped,timeline},null,2)+'\n')
console.log('PASS: real local Durable Object authenticated claim cancellation, delayed claim fencing, independent claim admission and immutable stop replay.')
