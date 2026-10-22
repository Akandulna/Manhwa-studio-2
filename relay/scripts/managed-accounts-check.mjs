// Local-only Phase 5 SQL/HTTP race and restart acceptance. No provider calls or production credentials.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const base=process.env.MANAGED_TEST_URL??'http://127.0.0.1:8806',state=process.env.MANAGED_ACCOUNTS_STATE??'/tmp/phase5-accounts-check.json'
assert.equal(new URL(base).hostname,'127.0.0.1');assert(/^\/(?:private\/)?tmp\//.test(state))
const studio='local-studio-task-token-0000000000000000',tokens={'local-phone-1':'local-phone-one-token-00000000000000000','local-phone-2':'local-phone-two-token-00000000000000000'},workspaceId='fixture-workspace'
let seq=0
async function request(route,body,token=studio){const response=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value.result}
const task=(op,token)=>request('/managed/operation',{schema:'managed-task/1',workspaceId,eventId:'phase5-task-'+(++seq),...op},token)
const account=(op,token)=>request('/managed/accounts/operation',{schema:'managed-accounts/1',workspaceId,eventId:'phase5-account-'+(++seq),...op},token)
if(process.argv.includes('--replay-only')){
 const saved=JSON.parse(await fs.readFile(state,'utf8')),snapshot=await request('/managed/accounts')
 assert(snapshot.reservations.some(r=>r.resource==='account:shared:0'&&r.attempt_id===saved.claim.attempt.id))
 assert.equal(snapshot.profiles.find(p=>p.deviceId===saved.auditDevice).audit.claimId,saved.auditId)
 await account({action:'audit_finish',eventId:'phase5-finish-restart',auditId:saved.auditId,check:null},tokens[saved.auditDevice])
 const after=await request('/managed/accounts')
 assert(!after.reservations.some(r=>r.attempt_id==='audit:'+saved.auditId))
 assert(after.reservations.some(r=>r.resource==='account:shared:0'))
 const waiting=await task({action:'claim',eventId:saved.waitEvent,taskId:saved.waitTask,deviceId:saved.auditDevice,profileId:'profile',accountId:null})
 assert(waiting.waiting.candidates[0].reasons.includes('shared_account_capacity_reserved'))
 console.log('PASS: actual Durable Object process restart retains account/audit ownership; exact audit cleanup leaves ambiguous task capacity held.')
}else{
 const caps=['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1','chatgpt-default-crop/1','chatgpt-sliced-crop/1','account-audit/1','account-selection/1']
 for(const [deviceId,token] of Object.entries(tokens)){await task({action:'hello',profileIds:['profile'],capabilities:caps,apkVersion:'1.0.999'},token);await task({action:'enroll',deviceId,profileId:'profile'})}
 await account({action:'policy',policy:{revision:1,stage:'crop_json',enabled:true,auditsEnabled:true,allowed:[{provider:'chatgpt',product:'chatgpt-web',model:'provider-default',mode:null,effort:null}],preferredProfiles:['local-phone-2/profile','local-phone-1/profile'],allowUnknownQuota:false,allowEstimatedQuota:false,criticalMaxAgeHours:24,contextPortable:false}})
 for(const [deviceId,token] of Object.entries(tokens)){
  const p=await account({action:'observe',deviceId,profileId:'profile',check:{checkedAt:new Date().toISOString(),chatGpt:{signedIn:true,email:'same@example.test',plan:null},gemini:{signedIn:false}}},token)
  await account({action:'confirm',deviceId,profileId:'profile',product:'chatgpt',candidate:p.observation.sites.chatgpt.candidate,accountId:'shared',maxConcurrent:1})
 }
 await account({action:'quota',profileId:null,quota:{accountId:'shared',scope:{provider:'openai',product:'chatgpt',model:'*',project:null,feature:'crop_json'},state:'available',evidence:'owner_supplied',observedAt:Date.now(),recheckAt:null}})
 const spec={version:'crop-page/1',provider:'chatgpt',product:'chatgpt-web',model:'provider-default',settings:{mode:null,effort:null},pageRevision:'r1',promptVersion:'managed-chatgpt-sliced-crop/1',validatorVersion:'managed-crop-validator/1',dependencies:[{id:'page',revision:'r1',sha256:'a'.repeat(64)}]}
 const planned=await Promise.all(['a','b'].map(pageId=>task({action:'plan',identity:{workspaceId,seriesId:'series',chapterId:'chapter',pageId},spec})))
 const selection=await request('/managed/accounts/select',{schema:'managed-accounts/1',workspaceId,taskId:planned[0].id,targets:null})
 assert.equal(selection.selected.deviceId,'local-phone-2')
 const claims=await Promise.all(planned.map((p,i)=>task({action:'claim',eventId:'phase5-race-'+i,taskId:p.id,deviceId:'local-phone-'+(i+1),profileId:'profile',accountId:null})))
 assert.equal(claims.filter(c=>c.attempt).length,1);assert.equal(claims.filter(c=>c.waiting).length,1)
 const index=claims.findIndex(c=>c.attempt),claim=claims[index],auditDevice='local-phone-'+(index===0?2:1)
 assert.equal((await account({action:'audit_claim',profileId:'profile'},tokens[claim.attempt.deviceId])).reason,'busy')
 const auditId='phase5-retained-audit';assert.equal((await account({action:'audit_claim',eventId:auditId,profileId:'profile'},tokens[auditDevice])).state,'running')
 for(const phase of ['accepted','started','submission_intent'])await task({action:'checkpoint',taskId:claim.task.id,attemptId:claim.attempt.id,generation:claim.attempt.generation,fingerprint:claim.task.fingerprint,phase,checkpointRef:null,commandId:claim.command.id},tokens[claim.attempt.deviceId])
 const stopped=await task({action:'stop',taskId:claim.task.id,cancel:true})
 await task({action:'checkpoint',taskId:claim.task.id,attemptId:claim.attempt.id,generation:claim.attempt.generation,fingerprint:claim.task.fingerprint,phase:'stop_confirmed',checkpointRef:null,commandId:stopped.command.id},tokens[claim.attempt.deviceId])
 await fs.writeFile(state,JSON.stringify({claim,auditDevice,auditId,waitTask:planned[1-index].id,waitEvent:'phase5-race-'+(1-index)}))
 console.log('PASS: real local SQL authority grants one account slot in simultaneous two-phone claims; busy audit defers and idle audit reserves independently. Restart relay with the same store and run --replay-only.')
}
