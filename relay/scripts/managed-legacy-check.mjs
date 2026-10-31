// Local-only enrollment/legacy boundary test; credentials are deliberately fake.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const require=createRequire(new URL('../../server/package.json',import.meta.url)),WebSocket=require('ws')
const base=process.env.MANAGED_TEST_URL??'http://127.0.0.1:8798'
assert.equal(new URL(base).hostname,'127.0.0.1')
const legacy='manager-local-check',studio='local-studio-task-token-0000000000000000',phone='local-phone-one-token-00000000000000000'
let sequence=0
async function post(path,body,token=legacy) {
 const r=await fetch(base+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)})
 return {status:r.status,body:await r.json()}
}
const request=(action,device='enrolled-phone')=>post('/request',{id:'legacy-'+(++sequence),requestedAt:new Date().toISOString(),action,device,series:'Fixture series',profile:'profile'})
function connect(role,device) {
 const url=new URL(base);url.protocol='ws:';url.pathname='/ws';url.searchParams.set('role',role)
 if(device)url.searchParams.set('device',device)
 const ws=new WebSocket(url,{headers:{Authorization:'Bearer '+legacy}}),messages=[]
 ws.on('message',data=>messages.push(JSON.parse(data.toString())))
 return {ws,messages,ready:new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)})}
}
async function until(check) {for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,10))}assert.fail('Expected relay reply')}
if(process.argv.includes('--rollback-only'))assert.equal((await post('/managed/operation',{},studio)).status,503)
if(!process.argv.includes('--rollback-only')) {
 // A durable legacy request exists before the device is enrolled.
 assert.equal((await request('clipper_start')).status,200)
 for(const body of [
  {action:'hello',eventId:'fence-hello',capabilities:['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1'],profileIds:['profile'],apkVersion:'1.0.999'},
  {action:'enroll',eventId:'fence-enroll',deviceId:'enrolled-phone',profileId:'profile'},
 ]) {
  const r=await post('/managed/operation',{schema:'managed-task/1',workspaceId:'fixture-workspace',...body},body.action==='hello'?phone:studio)
  assert.equal(r.status,200,JSON.stringify(r.body))
 }
}
for(const action of ['clipper_start','narration_start','editor_start','voiceover_start','clipper_stop','run_stop','run_finish','profile_select','chatgpt_options']) {
 assert.equal((await request(action)).status,409,action)
 assert.equal((await request(action,'')).status,409,'broadcast '+action)
 assert.equal((await request(action,'legacy-phone')).status,200,'unenrolled '+action)
}
const enrolled=connect('phone','enrolled-phone');await enrolled.ready
// Observe for replay after open. Even a start saved before enrollment must be withheld.
await new Promise(r=>setTimeout(r,150))
assert.equal(enrolled.messages.filter(m=>m.type==='request'&&m.action!=='sync').length,0)
const desktop=connect('desktop');await desktop.ready
await until(()=>desktop.messages.some(m=>m.type==='hello'))
desktop.ws.send(JSON.stringify({type:'request',id:'socket-denied',action:'clipper_start',device:'enrolled-phone',series:'Fixture series'}))
await until(()=>desktop.messages.some(m=>m.type==='request:rejected'&&m.id==='socket-denied'))
assert.equal(enrolled.messages.filter(m=>m.type==='request'&&m.action!=='sync').length,0)
assert.equal((await request('sync')).status,200)
await until(()=>enrolled.messages.some(m=>m.type==='request'&&m.action==='sync'))
enrolled.ws.close();desktop.ws.close()
console.log('PASS: HTTP/socket legacy controls fenced; broadcast fails as a whole; old starts withheld on reconnect; sync and unenrolled devices work'+(process.argv.includes('--rollback-only')?' after restart with managed flag disabled.':'.'))
