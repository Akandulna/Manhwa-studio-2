// Local-only task authority check. Never use production credentials here.
import assert from 'node:assert/strict'
import{readFileSync}from'node:fs'
const base=process.env.MANAGED_TEST_URL??'http://127.0.0.1:8796'
assert.equal(new URL(base).hostname,'127.0.0.1')
const studio='local-studio-task-token-0000000000000000',phone1='local-phone-one-token-00000000000000000',phone2='local-phone-two-token-00000000000000000'
const workspaceId='fixture-workspace',caps=['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1']
const fixture=JSON.parse(readFileSync(new URL('../../docs/manager-agents/phase3/command-fixture.json',import.meta.url)))
let seq=0
async function send(action,token=studio){const r=await fetch(base+'/managed/operation',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({schema:'managed-task/1',workspaceId,eventId:'local-op-'+(++seq),...action})});return {status:r.status,body:await r.json()}}
async function get(path,token=studio){const r=await fetch(base+path,{headers:{Authorization:'Bearer '+token}});return {status:r.status,body:await r.json()}}
const identity={workspaceId,seriesId:'local-series',chapterId:'local-chapter',pageId:'local-page'},spec=fixture.task.spec
if(!process.argv.includes('--replay-only')) {
 assert.equal((await send({action:'plan',identity,spec},'manager-local-check')).status,401)
 for(const [deviceId,token]of [['local-phone-1',phone1],['local-phone-2',phone2]]){
  assert.equal((await send({action:'hello',eventId:'hello-'+deviceId,capabilities:caps,profileIds:['profile'],apkVersion:'1.0.999'},token)).status,200)
  assert.equal((await send({action:'enroll',eventId:'enroll-'+deviceId,deviceId,profileId:'profile'})).status,200)
 }
 assert.equal((await send({action:'enroll',deviceId:'local-phone-1',profileId:'profile'},phone1)).status,403)
 const planned=await send({action:'plan',eventId:'local-plan',identity,spec});assert.equal(planned.status,200)
 const task=planned.body.result
 const claims=await Promise.all(['local-phone-1','local-phone-2'].map(deviceId=>send({action:'claim',eventId:'local-claim-'+deviceId,taskId:task.id,deviceId,profileId:'profile',accountId:null})))
 assert.equal(claims.filter(c=>c.status===200).length,1);assert.equal(claims.filter(c=>c.status===409).length,1)
 const claim=claims.find(c=>c.status===200).body.result,owner=claim.attempt.deviceId==='local-phone-1'?phone1:phone2,foreign=owner===phone1?phone2:phone1
 assert.equal((await get('/managed/inbox',owner)).body.assignments.length,1)
 assert.equal((await get('/managed/inbox',foreign)).body.assignments.length,0)
 assert.equal((await get('/managed/inbox?device='+claim.attempt.deviceId,foreign)).status,409)
 const checkpoint={action:'checkpoint',taskId:task.id,attemptId:claim.attempt.id,generation:claim.attempt.generation,fingerprint:task.fingerprint,commandId:claim.command.id,phase:'accepted',checkpointRef:null}
 assert.equal((await send(checkpoint,foreign)).status,409)
 assert.equal((await send({...checkpoint,eventId:'local-accepted'},owner)).status,200)
 assert.equal((await send({...checkpoint,eventId:'local-accepted'},owner)).status,200)
 console.log('PASS: authenticated DO handshake/enrollment, one concurrent owner, device-bound inbox, forged-worker rejection and idempotent acceptance.')
} else {
 const planned=await send({action:'plan',eventId:'local-plan',identity,spec});assert.equal(planned.status,200)
 const timeline=await get('/managed/tasks/'+encodeURIComponent(planned.body.result.id));assert.equal(timeline.status,200)
 assert.equal(timeline.body.attempt.phase,'accepted');assert.equal(timeline.body.commands.length,1)
 const token=timeline.body.attempt.deviceId==='local-phone-1'?phone1:phone2
 const r=await send({action:'checkpoint',eventId:'local-accepted',taskId:timeline.body.task.id,attemptId:timeline.body.attempt.id,generation:timeline.body.attempt.generation,fingerprint:timeline.body.task.fingerprint,commandId:timeline.body.attempt.activeCommandId,phase:'accepted',checkpointRef:null},token)
 assert.equal(r.status,200)
 console.log('PASS: task, owner, command and acceptance survive local relay process restart without a second attempt.')
}
