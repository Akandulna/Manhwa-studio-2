// Local synthetic authority only. No production credentials, phones or provider requests.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const base=process.env.MANAGED_TEST_URL??'http://127.0.0.1:8799';assert.equal(new URL(base).hostname,'127.0.0.1')
const studio='local-studio-task-token-0000000000000000',phone='local-phone-one-token-00000000000000000',workspaceId='fixture-workspace'
const evidence=process.env.MANAGED_COORDINATOR_EVIDENCE??'/tmp/managed-phase4-coordinator-evidence.json';assert.match(evidence,/^\/(?:private\/)?tmp\//)
async function call(route,body,token=studio){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()}}
async function op(body,token=studio){return call('/managed/operation',{schema:'managed-task/1',workspaceId,eventId:crypto.randomUUID(),...body},token)}
async function ok(body,token=studio){const r=await op(body,token);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.result}
const cf=lease=>({coordinatorId:lease.coordinatorId,coordinatorGeneration:lease.coordinatorGeneration})
if(process.argv.includes('--verify-restart')){
 const saved=JSON.parse(await fs.readFile(evidence,'utf8')),status=await call('/managed/coordinator');assert.equal(status.status,200);assert.deepEqual(status.body.result,saved.current)
 assert.equal((await op(saved.oldStop)).status,409)
 const replay=await ok({...saved.claim,...cf(saved.current)});assert.deepEqual(replay,saved.assignment)
 assert.deepEqual((await call('/managed/tasks/'+encodeURIComponent(saved.assignment.task.id))).body,saved.timeline)
 await ok({action:'coordinator_release',...cf(saved.current)})
 console.log('PASS: actual local Worker restart retained coordinator generation, original claim receipt/history and stale-control fences. Zero provider requests.')
 process.exit(0)
}
const ready=await call('/managed/readiness');assert(ready.body.result.capabilities.includes('production-coordinator/1'))
const lease=await ok({action:'coordinator_acquire',coordinatorId:'synthetic-studio-a',expectedGeneration:0})
assert.equal((await op({action:'coordinator_acquire',coordinatorId:'synthetic-studio-b',expectedGeneration:0})).status,409)
assert.equal((await call('/managed/coordinator',undefined,phone)).status,403)
await ok({action:'hello',capabilities:['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','chatgpt-default-crop/1'],profileIds:['profile'],apkVersion:'1.0.999'},phone)
await ok({action:'enroll',deviceId:'local-phone-1',profileId:'profile'})
const identity={workspaceId,seriesId:'coordinator-series',chapterId:'chapter',pageId:'page'},spec={version:'crop-page/1',provider:'chatgpt',product:'chatgpt-web',model:'provider-default',settings:{mode:null,effort:null},pageRevision:'r1',promptVersion:'managed-chatgpt-default-crop/1',validatorVersion:'managed-crop-validator/1',dependencies:[{id:identity.pageId,revision:'r1',sha256:'a'.repeat(64)}]}
const task=await ok({action:'plan',identity,spec}),claim={action:'claim_production',eventId:'original-production-claim',taskId:task.id,deviceId:'local-phone-1',profileId:'profile',accountId:null,...cf(lease)}
assert.equal((await op({...claim,action:'claim',coordinatorId:undefined,coordinatorGeneration:undefined})).status,409)
const assignment=await ok(claim),oldStop={action:'stop_production_claim',eventId:'old-coordinator-stop',taskId:task.id,claimEventId:claim.eventId,...cf(lease)}
await ok({action:'coordinator_release',...cf(lease)})
const current=await ok({action:'coordinator_acquire',coordinatorId:'synthetic-studio-b',expectedGeneration:1});assert.equal(current.coordinatorGeneration,2)
assert.equal((await op(oldStop)).status,409)
assert.equal((await op(claim)).status,409)
assert.equal((await op({action:'stop',taskId:task.id,cancel:true})).status,409)
assert.deepEqual(await ok({...claim,...cf(current)}),assignment)
const timeline=(await call('/managed/tasks/'+encodeURIComponent(task.id))).body;assert.equal(timeline.commands.length,1)
await fs.writeFile(evidence,JSON.stringify({synthetic:true,providerRequests:0,current,claim,oldStop,assignment,timeline},null,2)+'\n')
console.log('PASS: real local Durable Object coordinator exclusion, exact original receipt recovery, generation takeover and stale claim/stop fencing.')
