// Authorized read/status verification of real manager traffic. No synthetic production reports.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
assert(process.argv.includes('--live'),'Pass --live for the configured production relay')
const device = process.argv.find(a => a.startsWith('--device='))?.slice(9)
assert(device && /^[a-zA-Z0-9_-]+$/.test(device),'Choose the reporting phone with --device=<id>')
const require = createRequire(resolve('server/package.json')), { parse } = require('dotenv'), WebSocket = require('ws')
let env = { ...process.env }
for (const path of ['server/.env','.env']) if (existsSync(path)) env = { ...parse(readFileSync(path)),...env }
assert(env.RELAY_TOKEN,'Relay credentials unavailable')
async function get(path) { const r = await fetch('http://127.0.0.1:3002/api'+path,{ signal:AbortSignal.timeout(15000) }); assert(r.ok,`Studio returned ${r.status}`); return r.json() }
async function wait(check,ms=30000) { const end=Date.now()+ms; while(!check()) { assert(Date.now()<end,'Expected live manager evidence did not arrive'); await new Promise(r => setTimeout(r,100)) } }
const sockets=[]
async function connect(url) {
 const ws = new WebSocket(url), reports=new Map(), incidents=new Map()
 sockets.push(ws)
 ws.on('message',raw => { try { const m=JSON.parse(raw); if(m.type==='manager:report' && m.body?.source?.deviceId===device) reports.set(m.body.eventId,m.body); if(m.type==='manager:incident') incidents.set(m.body.id,m.body) } catch {} })
 await new Promise((resolve,reject) => { const timer=setTimeout(() => reject(new Error('Relay connection timeout')),15000); ws.once('open',() => {clearTimeout(timer);resolve()});ws.once('error',() => {clearTimeout(timer);reject(new Error('Relay connection failed'))}) })
 return { ws,reports,incidents }
}
try {
 const status=await get('/r2/relay'), before=await get('/r2/phone/overview'), overview=await get('/managers')
 assert(status.connected && overview.enabled && !overview.error)
 const native=overview.observations.filter(o => o.source.deviceId===device)
 assert(native.length && native.every(o => o.receivedAt),'Studio must contain authority-accepted native phone facts')
 const url=new URL(status.url);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.pathname='/ws';url.search=new URLSearchParams({ role:'desktop',token:env.RELAY_TOKEN }).toString()
 const first=await connect(url)
 await wait(() => [...first.reports.values()].some(r => r.facts.length))
 await new Promise(r => setTimeout(r,1500))
 const original=[...first.reports.values()].filter(r => r.facts.length)
 for(const r of original) { assert.equal(r.schema,'manager-report/1');assert(r.receivedAt && Number.isFinite(Date.parse(r.observedAt)));assert.equal(r.source.id,`${device}/${r.source.manager}`) }
 first.ws.close()
 const replay=await connect(url)
 await wait(() => original.every(r => replay.reports.has(r.eventId)))
 for(const r of original) {
  const again=replay.reports.get(r.eventId)
  assert.equal(again.observedAt,r.observedAt,'Replay must not freshen original evidence')
  assert.equal(again.receivedAt,r.receivedAt,'Replay must preserve authority acceptance')
  assert.equal(again.source.sequence,r.source.sequence)
 }
 // This endpoint requests existing receipts only; it does not start sync or production.
 const refresh=await fetch('http://127.0.0.1:3002/api/r2/phone/request',{ method:'POST',signal:AbortSignal.timeout(15000) });assert(refresh.ok)
 const request=await refresh.json();let after
 const end=Date.now()+45000
 do { after=await get('/r2/phone/overview');if(after.answers===request.id) break;assert(Date.now()<end,'Legacy receipt correlation timeout');await new Promise(r=>setTimeout(r,500)) } while(true)
 assert.equal(after.runs.length,before.runs.length);assert.equal(after.working.length,before.working.length)
 let current=await get('/managers')
 if (process.argv.includes('--drained')) {
  const end=Date.now()+60000
  while(current.pendingReports) {assert(Date.now()<end,'Studio catch-up did not drain');await new Promise(r=>setTimeout(r,1000));current=await get('/managers')}
  assert.equal(current.deliveryError,null)
 }
 const watermarks = Object.values(Object.fromEntries([...replay.reports.values()].sort((a,b) => a.source.sequence-b.source.sequence).map(r => [r.source.id,{ manager:r.source.manager,sequence:r.source.sequence,observedAt:r.observedAt,receivedAt:r.receivedAt }])))
 if (process.argv.includes('--reopened')) assert(watermarks.some(w => w.sequence > 1),'Reopened phone must continue existing source sequences')
 const report={ phoneReopenedByUser:process.argv.includes('--reopened'),sourceWatermarks:watermarks,oldestFactObservedAt:original.map(r => r.observedAt).sort()[0],oldestFactAcceptedAt:original.map(r => r.receivedAt).sort()[0],verifiedAt:new Date().toISOString(),deviceId:device,nativeProtocol:'manager-report/1',nativeFactsInStudio:native.length,allNativeFactsAuthorityAccepted:true,replayedFactReports:original.length,replayedManagers:[...new Set(original.map(r=>r.source.manager))].sort(),sourceTimesPreserved:true,authorityTimesPreserved:true,legacyReceiptCorrelation:true,activeRunsBefore:before.runs.length,activeRunsAfter:after.runs.length,pendingStudioReports:current.pendingReports,deliveryError:current.deliveryError,incidentCount:current.incidents.length,scope:'Real installed-phone observations via production relay to Studio; diagnostic desktop reconnect and receipt-only refresh. No generation, synthetic reports, incident acknowledgments or artifact imports.' }
 writeFileSync('docs/manager-agents/phase1-live-validation.json',JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify(report))
} catch(e) {console.error(e.message);process.exitCode=1}
finally {for(const ws of sockets) ws.terminate()}
