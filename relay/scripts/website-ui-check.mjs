// Synthetic data in a localhost-only authority. Never use production credentials.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const base=process.env.MANAGER_TEST_URL??'http://127.0.0.1:8793'
assert.equal(new URL(base).hostname,'127.0.0.1')
const ns=process.env.MANAGER_TEST_NAMESPACE??'phase2-final';assert(/^[a-zA-Z0-9_-]{1,40}$/.test(ns))
const fixtures=JSON.parse(readFileSync(new URL('../../docs/manager-agents/website-ui/kotlin-reports.json',import.meta.url),'utf8').replaceAll('2026-10-19','2026-10-18'))
const sockets=[]
function report(original,device,sequence){const r=structuredClone(original);r.eventId=`${ns}-${device}-${sequence}`;r.source={...r.source,id:`${device}/device_clipping`,deviceId:device,sequence};const ui=r.facts[0].websiteUi;ui.changeId=createHash('sha256').update(ui.changeId+ns).digest('hex');r.facts[0].condition.resource=`ui-change/${ui.changeId}`;return r}
const first=fixtures.map((r,i)=>report(r,`fixture-a-${ns}`,i+1)),resources=first.map(r=>r.facts[0].condition.resource)
async function post(r){const response=await fetch(`${base}/manager/report?device=${r.source.deviceId}`,{method:'POST',headers:{Authorization:'Bearer manager-local-check','Content-Type':'application/json'},body:JSON.stringify(r)});return {status:response.status,body:response.ok?await response.json():null}}
async function wait(check){const end=Date.now()+10000;while(!check()){assert(Date.now()<end,'UI relay evidence timed out');await new Promise(r=>setTimeout(r,25))}}
async function connect(){const ws=new WebSocket(`${base.replace('http:','ws:')}/ws?role=desktop&token=manager-local-check`),incidents=new Map(),received=new Map();sockets.push(ws);ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.type==='manager:incident')incidents.set(m.body.resource,m.body);if(m.type==='manager:report')received.set(m.body.eventId,m.body)});await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true})});return {ws,incidents,received}}
try{
 const client=await connect()
 if(!process.argv.includes('--replay-only')){
  for(const r of first){const a=await post(r),b=await post(r);assert.equal(a.status,200);assert.equal(b.body.duplicate,true);assert.equal(a.body.report.receivedAt,b.body.report.receivedAt)}
  await wait(()=>resources.every(g=>client.incidents.has(g)))
  for(const g of resources)assert.equal(client.incidents.get(g).severity,'info')
  const shortcut=structuredClone(first[0]);shortcut.eventId='shortcut-'+ns;shortcut.source={id:`shortcut-${ns}/website_ui`,deviceId:`shortcut-${ns}`,manager:'website_ui',sequence:1}
  assert.equal((await post(shortcut)).status,400,'Monitor must not bypass Device Image Clipper')
  for(const [i,r]of fixtures.entries())assert.equal((await post(report(r,`fixture-b-${ns}`,i+1))).status,200)
  await wait(()=>resources.every(g=>Object.keys(client.incidents.get(g)?.impacts??{}).length===2))
  const incident=client.incidents.get(resources[0])
  assert.equal((await post({schema:'manager-report/1',eventId:'ui-owner-ack-'+ns,source:{id:`owner-${ns}/issues`,deviceId:`owner-${ns}`,manager:'issues',sequence:1},observedAt:'2026-10-18T00:02:00Z',facts:[],acknowledgment:{incidentId:incident.id,notificationId:incident.notificationId}})).status,200)
  await wait(()=>!!client.incidents.get(resources[0])?.acknowledgedAt);assert.equal(client.incidents.get(resources[0]).state,'action_required')
  for(const device of [`fixture-a-${ns}`,`fixture-b-${ns}`])for(const [i,original]of fixtures.entries()){
   const r=report(original,device,i+4),f=r.facts[0];f.workState='verified_complete';f.compatibility='current';f.availability=[{destination:'phone_controls',state:'validated',evidenceRef:'fixture-required-controls'}];f.condition.state='resolved';f.websiteUi.classification='unchanged';f.websiteUi.compatibilityVerifiedAt='2026-10-18T00:02:00Z'
   assert.equal((await post(r)).status,200)
  }
  await wait(()=>resources.every(g=>client.incidents.get(g)?.state==='resolved'))
 }
 client.ws.close();const replay=await connect()
 await wait(()=>resources.every(g=>replay.incidents.get(g)?.state==='resolved'))
 for(const g of resources){const i=replay.incidents.get(g);assert.equal(i.occurrences,1);assert.equal(Object.keys(i.impacts).length,2);assert.equal(i.history.filter(h=>h.action==='detected').length,1);assert.equal(i.history.filter(h=>h.action==='resolved').length,1)}
 await wait(()=>first.every(r=>replay.received.has(`${ns}-${r.source.deviceId}-${r.source.sequence+3}`)))
 console.log('PASS: three Kotlin providers, required manager routing, cosmetic info notifications, cross-device grouping, rejected shortcut, acknowledgment/verification separation and durable replay.'+(process.argv.includes('--replay-only')?' Confirmed after relay restart.':''))
}finally{for(const ws of sockets)ws.close()}
