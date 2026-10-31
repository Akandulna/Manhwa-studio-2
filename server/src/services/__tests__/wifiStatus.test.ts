import { describe,it,expect,afterEach,vi } from 'vitest'
import { WifiStatusHub,validRefresh,WIFI_KINDS } from '../wifiStatus.js'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
vi.mock('../relayTraffic.js',()=>({relayFetch:vi.fn(async(_url:string,options:any)=>{
 const body=JSON.parse(options.body);return new Response(JSON.stringify({schema:'manager-batch/1',results:body.reports.map((report:any)=>({eventId:report.eventId,report:{...report,receivedAt:new Date().toISOString()}}))}),{status:200})
})}))
const hubs:WifiStatusHub[]=[],dirs:string[]=[],clients:WebSocket[]=[]
afterEach(()=>{clients.splice(0).forEach(w=>w.terminate());hubs.splice(0).forEach(h=>h.close());dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}))})
const sleep=(n=10)=>new Promise(r=>setTimeout(r,n))
async function setup(){
 const dir=mkdtempSync(join(tmpdir(),'wifi-status-test-'));dirs.push(dir)
 const receipt=vi.fn(),cloudRefresh=vi.fn(async()=>{})
 const h=new WifiStatusHub(dir,{receipt,cloudRefresh},0).start();hubs.push(h)
 for(let i=0;i<100&&h.boundPort()===0;i++)await sleep()
 return {h,receipt,dir,cloudRefresh}
}
async function connect(h:WifiStatusHub,device='phone',master=false){
 const p=h.pairing(device,master,'127.0.0.1')
 const ws=new WebSocket(p.url+'/status',{ca:Buffer.from(p.certificate,'base64'),headers:{Authorization:'Bearer '+p.token}});clients.push(ws)
 const messages:any[]=[];ws.on('message',d=>messages.push(JSON.parse(d.toString())))
 await new Promise<void>((resolve,reject)=>{ws.once('error',reject);ws.once('open',()=>resolve())})
 for(let i=0;i<100&&!messages.length;i++)await sleep()
 return {ws,messages,p}
}
async function waitFor(f:()=>boolean){for(let i=0;i<200&&!f();i++)await sleep();expect(f()).toBe(true)}
describe('Wi-Fi capability boundary',()=>{
 const now=Date.now(),base={type:'refresh_status',id:'request-1',device:'phone',requestedAt:new Date(now).toISOString(),deadline:now+60_000}
 it('accepts a bounded read-only refresh',()=>expect(validRefresh(base,now)).toBe(true))
 it('rejects command injection and expired requests',()=>{
  for(const type of ['sync','clipper_start','screen_on','screenshot','managed/operation'])expect(validRefresh({...base,type},now)).toBe(false)
  expect(validRefresh({...base,action:'sync'},now)).toBe(false)
  expect(validRefresh({...base,deadline:now-1},now)).toBe(false)
  expect(validRefresh({...base,deadline:now+60_001},now)).toBe(false)
 })
 it('allows a small sender clock skew without extending the issued lifetime',()=>expect(validRefresh(base,now-2000)).toBe(true))
 it('excludes screenshot images',()=>expect(WIFI_KINDS.has('screenshot')).toBe(false))
 it('persists snapshots and refuses stale revisions',async()=>{
  const {h,receipt,dir}=await setup();const {ws,messages}=await connect(h)
  const send=(revision:number)=>ws.send(JSON.stringify({type:'receipt',id:'r'+revision,device:'phone',kind:'crops',revision,body:{done:revision}}))
  send(2);await waitFor(()=>messages.some(m=>m.id==='r2'));send(1);await waitFor(()=>messages.some(m=>m.id==='r1'))
  expect(receipt).toHaveBeenCalledTimes(1);expect(h.status().snapshots[0].revision).toBe(2)
  const recovered=new WifiStatusHub(dir,{receipt:vi.fn(),cloudRefresh:async()=>{}},0);hubs.push(recovered)
  expect(recovered.status().snapshots[0].revision).toBe(2)
 })
 it('rejects another device and closes revoked credentials',async()=>{
  const {h,receipt}=await setup();const {ws}=await connect(h)
  ws.send(JSON.stringify({type:'receipt',id:'spoof',device:'other',kind:'crops',revision:1,body:{}}))
  await waitFor(()=>ws.readyState===WebSocket.CLOSED);expect(receipt).not.toHaveBeenCalled()
  const next=await connect(h,'second');h.revoke('second');await waitFor(()=>next.ws.readyState===WebSocket.CLOSED)
 })
 it('requires every refresh response part, supports replay and keeps identity',async()=>{
  const {h,receipt}=await setup();const {ws,messages}=await connect(h)
  ws.send(JSON.stringify({type:'receipt',id:'initial',device:'phone',kind:'sync',revision:1,body:{done:1}}));await waitFor(()=>messages.some(x=>x.id==='initial'))
  const m={type:'refresh_status',id:'refresh-1',device:'phone',requestedAt:new Date().toISOString(),deadline:Date.now()+60_000}
  const result=h.refresh(m);await waitFor(()=>messages.some(x=>x.type==='refresh_status'))
  for(const kind of ['sync','scripts','crops','process','screen']){
   ws.send(JSON.stringify({type:'receipt',id:kind,device:'phone',kind,revision:1,body:{answers:m.id}}))
   await waitFor(()=>messages.some(x=>x.id===kind))
  }
  expect(await result).toBe(true)
  expect(receipt.mock.calls.some(([m])=>m.kind==='sync'&&m.body.answers==='refresh-1')).toBe(true)
  expect(messages.find(x=>x.type==='refresh_status').id).toBe(m.id)
 })
 it('rejects all production commands even for a paired Master',async()=>{
  const {h}=await setup();const {ws}=await connect(h,'master',true)
  ws.send(JSON.stringify({type:'sync',device:'phone'}));await waitFor(()=>ws.readyState===WebSocket.CLOSED)
 })
 it('keeps local manager observations provisional and returns only cloud event acknowledgments',async()=>{
  vi.stubEnv('RELAY_URL','https://relay.example');vi.stubEnv('RELAY_TOKEN','test-token')
  const {h}=await setup();const {ws,messages}=await connect(h)
  const report={schema:'manager-report/1',eventId:'original-event',source:{id:'phone/device',deviceId:'phone',manager:'device',sequence:1},observedAt:new Date().toISOString(),facts:[]}
  const body={schema:'manager-batch/1',reports:[report]}
  ws.send(JSON.stringify({type:'manager_observe',id:'local-observation',body}));await waitFor(()=>messages.some(x=>x.id==='local-observation'))
  expect(h.status().observations[0].provisional).toBe(true)
  expect(messages.find(x=>x.id==='local-observation').type).toBe('stored')
  ws.send(JSON.stringify({type:'manager',id:'cloud-delivery',body}));await waitFor(()=>messages.some(x=>x.id==='cloud-delivery'))
  const ack=messages.find(x=>x.id==='cloud-delivery');expect(ack.type).toBe('manager_ack');expect(ack.body.results[0].eventId).toBe(report.eventId)
  const accepted=ack.body.results[0].report;expect(accepted.receivedAt).toBeTruthy();delete accepted.receivedAt;expect(accepted).toEqual(report)
  vi.unstubAllEnvs()
 })
 it('lets Master own cloud fallback and does not report an offline target as reached',async()=>{
  const {h,cloudRefresh}=await setup();const {ws,messages}=await connect(h,'master',true)
  const now=Date.now()
  ws.send(JSON.stringify({type:'refresh_status',id:'offline-refresh',device:'offline-phone',requestedAt:new Date(now).toISOString(),deadline:now+60_000}))
  await waitFor(()=>messages.some(m=>m.type==='refresh_ack'))
  expect(messages.find(m=>m.type==='refresh_ack')).toMatchObject({id:'offline-refresh',device:'offline-phone',phones:0})
  expect(cloudRefresh).not.toHaveBeenCalled()
 })
 it('returns fallback immediately when target is not local',async()=>{
  const {h}=await setup();expect(await h.refresh({type:'refresh_status',id:'r1',device:'absent',requestedAt:new Date().toISOString(),deadline:Date.now()+60_000})).toBe(false)
 })
})
