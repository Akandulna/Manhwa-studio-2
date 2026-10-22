// Local synthetic workers only. No production credentials or provider requests.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const base=process.env.MANAGED_TEST_URL??'http://127.0.0.1:8799'
assert.equal(new URL(base).hostname,'127.0.0.1')
const studio='local-studio-task-token-0000000000000000',tokens=['local-phone-one-token-00000000000000000','local-phone-two-token-00000000000000000'],devices=['local-phone-1','local-phone-2'],workspaceId='fixture-workspace'
const evidence=process.env.MANAGED_TRANSFER_EVIDENCE??'/tmp/managed-phase4-production-handoff-local-evidence.json'
assert.match(evidence,/^\/(?:private\/)?tmp\//)
async function call(route,body,token=studio){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()}}
async function op(body,token=studio){return call('/managed/operation',{schema:'managed-task/1',workspaceId,eventId:crypto.randomUUID(),...body},token)}
async function ok(body,token=studio){const r=await op(body,token);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.result}
const local=a=>({taskId:a.task.id,attemptId:a.attempt.id,generation:a.attempt.generation,fingerprint:a.task.fingerprint,phase:a.attempt.phase,submission:a.attempt.submission,checkpointRef:a.attempt.checkpointRef})
const request=a=>({schema:'managed-reconnect/1',workspaceId,attempts:[local(a)]})
if(process.argv.includes('--verify-restart')){
 const saved=JSON.parse(await fs.readFile(evidence,'utf8'))
 const current=await call('/managed/reconnect',saved.current.request,tokens[1]);assert.equal(current.status,200)
 assert.deepEqual(current.body,saved.current.response)
 const old=await call('/managed/reconnect',saved.obsolete.request,tokens[0]);assert.equal(old.body.observations[0].status,'obsolete');assert.equal(old.body.assignments.length,0)
 const receipt=await call('/managed/production-claims/'+encodeURIComponent(saved.result.task.id)+'/transferred-production-claim');assert.equal(receipt.body.result.attemptId,saved.result.attempt.id)
 const proof=await call('/managed/obsolete-stop',saved.obsoleteStopRequest,tokens[0]);assert.deepEqual(proof.body,saved.obsoleteStopProof)
 const replay=await op(saved.transfer,studio);assert.equal(replay.status,200);assert.deepEqual(replay.body.result,saved.result)
 console.log('PASS: actual local process restart preserved transfer, original history, obsolete fence and immutable lost-reply replay; no provider request.')
 process.exit(0)
}
const caps=['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','chatgpt-default-crop/1','worker-reconnect/1']
for(const [i,deviceId] of devices.entries()){
 await ok({action:'hello',capabilities:caps,profileIds:['profile'],apkVersion:'1.0.999'},tokens[i]);await ok({action:'enroll',deviceId,profileId:'profile'})
}
const identity={workspaceId,seriesId:'transfer-series',chapterId:'transfer-chapter',pageId:'transfer-page'},spec={version:'crop-page/1',provider:'chatgpt',product:'chatgpt-web',model:'provider-default',settings:{mode:null,effort:null},pageRevision:'r1',promptVersion:'managed-chatgpt-default-crop/1',validatorVersion:'managed-crop-validator/1',dependencies:[{id:identity.pageId,revision:'r1',sha256:'a'.repeat(64)}]}
const lease=await ok({action:'coordinator_acquire',coordinatorId:'handoff-studio',expectedGeneration:0}),coordinator={coordinatorId:lease.coordinatorId,coordinatorGeneration:lease.coordinatorGeneration}
const task=await ok({action:'plan',identity,spec}),assigned=await ok({action:'claim_production',eventId:'original-production-claim',taskId:task.id,deviceId:devices[0],profileId:'profile',accountId:null,...coordinator})
const fence={taskId:task.id,attemptId:assigned.attempt.id,generation:1,fingerprint:task.fingerprint}
for(const phase of ['accepted','started'])await ok({action:'checkpoint',...fence,phase,checkpointRef:null,commandId:assigned.command.id},tokens[0])
const stop=await ok({action:'pause_production_claim',taskId:task.id,claimEventId:'original-production-claim',...coordinator})
const transfer={action:'transfer_production',eventId:'immutable-transfer',claimEventId:'original-production-claim',newClaimEventId:'transferred-production-claim',...coordinator,...fence,stopCommandId:stop.command.id,deviceId:devices[1],profileId:'profile'}
assert.equal((await op({...transfer,eventId:'before-stop'})).status,409)
const stopped=await ok({action:'checkpoint',...fence,phase:'stop_confirmed',checkpointRef:null,commandId:stop.command.id},tokens[0])
const result=await ok(transfer);assert.equal(result.task.generation,2);assert.equal(result.attempt.deviceId,devices[1])
assert.equal((await op({action:'renew',...fence},tokens[0])).status,409)
const receipt=await call('/managed/production-claims/'+encodeURIComponent(task.id)+'/transferred-production-claim');assert.equal(receipt.body.result.attemptId,result.attempt.id)
assert.equal((await op({action:'stop_production_claim',taskId:task.id,claimEventId:'original-production-claim',...coordinator})).status,409)
const currentRequest=request(result),currentResponse=await call('/managed/reconnect',currentRequest,tokens[1]);assert.equal(currentResponse.status,200);assert.equal(currentResponse.body.observations[0].status,'current_unsent')
const obsoleteRequest=request(stopped),obsoleteResponse=await call('/managed/reconnect',obsoleteRequest,tokens[0]);assert.equal(obsoleteResponse.body.observations[0].status,'obsolete');assert.equal(obsoleteResponse.body.assignments.length,0)
const current={request:currentRequest,response:currentResponse.body},obsolete={request:obsoleteRequest,response:obsoleteResponse.body}
const obsoleteStopRequest={schema:'managed-obsolete-stop/1',workspaceId,...fence,stopCommandId:stop.command.id}
const obsoleteStopProof=await call('/managed/obsolete-stop',obsoleteStopRequest,tokens[0]);assert.equal(obsoleteStopProof.status,200)
assert.equal(obsoleteStopProof.body.result.currentGeneration,2);assert.equal(obsoleteStopProof.body.result.confirmedUnsentStop,true)
assert.equal((await call('/managed/obsolete-stop',obsoleteStopRequest,tokens[1])).status,409)

await fs.writeFile(evidence,JSON.stringify({synthetic:true,providerRequests:0,transfer,result,current,obsolete,obsoleteStopRequest,obsoleteStopProof:obsoleteStopProof.body},null,2)+'\n')
console.log('PASS: real local Durable Object production handoff, atomic target claim receipt, stale job rejection, early-transfer refusal, stale renewal fence, actual native reconnect wire fixtures and retained history.')
