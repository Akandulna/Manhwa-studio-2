// Isolated local Durable Object acceptance only. Never use production credentials or a production URL.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const base=process.env.MANAGED_TEST_URL??'http://127.0.0.1:8798'
assert.equal(new URL(base).hostname,'127.0.0.1')
const studio='local-studio-task-token-0000000000000000',tokens=['local-phone-one-token-00000000000000000','local-phone-two-token-00000000000000000'],devices=['local-phone-1','local-phone-2']
const workspaceId='fixture-workspace',evidence=process.env.MANAGED_RECONNECT_EVIDENCE??'/tmp/managed-phase4-local-evidence.json'
assert.match(evidence,/^\/(?:private\/)?tmp\//)
let sequence=0
async function call(route,body,token=studio) {
 const response=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
 return {status:response.status,body:await response.json()}
}
async function op(body,token=studio) {return call('/managed/operation',{schema:'managed-task/1',workspaceId,eventId:'phase4_'+(++sequence),...body},token)}
async function ok(body,token=studio) {const r=await op(body,token);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.result}
const local=a=>({taskId:a.task.id,attemptId:a.attempt.id,generation:a.attempt.generation,fingerprint:a.task.fingerprint,phase:a.attempt.phase,submission:a.attempt.submission,checkpointRef:a.attempt.checkpointRef})
async function reconnect(record,index) {const r=await call('/managed/reconnect',{schema:'managed-reconnect/1',workspaceId,attempts:[record]},tokens[index]);assert.equal(r.status,200);return r.body}
if(process.argv.includes('--verify-restart')) {
 const saved=JSON.parse(await fs.readFile(evidence,'utf8'))
 const uncertain=await reconnect(saved.uncertainLocal,saved.firstIndex),healthy=await reconnect(saved.healthyLocal,saved.secondIndex)
 assert.equal(uncertain.observations[0].status,'cancelled');assert.equal(healthy.observations[0].status,'current_unsent')
 assert.deepEqual(healthy.assignments.map(a=>a.task.id),[saved.healthyLocal.taskId])
 assert.equal(uncertain.assignments.length,0)
 console.log('PASS: real local relay restart retained cancelled uncertainty, the distinct healthy assignment and reconnect decisions; no ownership transfer or provider replay occurred.')
 process.exit(0)
}
const caps=['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','chatgpt-default-crop/1']
for(const [i,deviceId]of devices.entries()) {
 await ok({action:'hello',capabilities:caps,profileIds:['profile'],apkVersion:'1.0.999'},tokens[i])
 await ok({action:'enroll',deviceId,profileId:'profile'})
}
const identity={workspaceId,seriesId:'phase4-local-series',chapterId:'phase4-local-chapter',pageId:'phase4-local-page'},spec={version:'crop-page/1',provider:'chatgpt',product:'chatgpt-web',model:'provider-default',settings:{mode:null,effort:null},pageRevision:'r1',promptVersion:'managed-chatgpt-default-crop/1',validatorVersion:'managed-crop-validator/1',dependencies:[{id:identity.pageId,revision:'r1',sha256:'a'.repeat(64)}]}
const a=await ok({action:'plan',identity,spec}),b=await ok({action:'plan',identity,spec:{...spec,pageRevision:'r2',dependencies:[{...spec.dependencies[0],revision:'r2',sha256:'b'.repeat(64)}]}})
const claims=await Promise.all([a,b].map((task,i)=>op({action:'claim',taskId:task.id,deviceId:devices[i],profileId:'profile',accountId:null})))
assert.equal(claims.filter(r=>r.status===200).length,1);assert.equal(claims.filter(r=>r.status===409).length,1)
const firstIndex=claims.findIndex(r=>r.status===200),secondIndex=1-firstIndex,owner=claims[firstIndex].body.result
const fence={taskId:owner.task.id,attemptId:owner.attempt.id,generation:owner.attempt.generation,fingerprint:owner.task.fingerprint}
for(const phase of ['accepted','started','submission_intent'])await ok({action:'checkpoint',...fence,phase,checkpointRef:null,commandId:owner.command.id},tokens[firstIndex])
const otherIdentity={...identity,pageId:'phase4-distinct-page'},otherSpec={...spec,dependencies:[{...spec.dependencies[0],id:otherIdentity.pageId}]}
const otherTask=await ok({action:'plan',identity:otherIdentity,spec:otherSpec}),healthy=await ok({action:'claim',taskId:otherTask.id,deviceId:devices[secondIndex],profileId:'profile',accountId:null})
const stopped=await ok({action:'stop',taskId:owner.task.id,cancel:true})
await ok({action:'checkpoint',...fence,phase:'stop_confirmed',checkpointRef:null,commandId:stopped.command.id},tokens[firstIndex])
const uncertainLocal=local({...owner,attempt:{...owner.attempt,phase:'stop_confirmed',submission:'unknown'}}),healthyLocal=local(healthy)
const one=await reconnect(uncertainLocal,firstIndex),two=await reconnect(healthyLocal,secondIndex)
assert.equal(one.observations[0].status,'cancelled');assert.equal(two.observations[0].status,'current_unsent')
assert.equal(one.assignments.length,0);assert.deepEqual(two.assignments.map(a=>a.task.id),[otherTask.id])
assert.deepEqual(await reconnect(uncertainLocal,firstIndex),one)
const blocked=await op({action:'claim',taskId:[a,b][secondIndex].id,deviceId:devices[secondIndex],profileId:'profile',accountId:null});assert.equal(blocked.status,409)
await fs.writeFile(evidence,JSON.stringify({firstIndex,secondIndex,uncertainLocal,healthyLocal,crossRevisionRaceSingleWinner:true,uncertaintyRetained:true,healthyDistinctAssignment:true},null,2))
console.log('PASS: cross-revision claim has one owner; stopped unknown work remains held while the other simulated phone owns a distinct page; reconnect is repeatable and does not replay provider work.')
