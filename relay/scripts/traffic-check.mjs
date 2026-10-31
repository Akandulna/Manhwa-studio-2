// Local-only real Worker/SQLite acceptance. Use a fresh isolated Wrangler store and a dummy token.
import assert from 'node:assert/strict'
const base=process.env.MANAGER_TEST_URL??'http://127.0.0.1:8797'
assert.equal(new URL(base).hostname,'127.0.0.1')
const token='manager-local-check',device='traffic-'+crypto.randomUUID().slice(0,8)
const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'}
const at=new Date().toISOString()
const report=(sequence,manager='studio')=>({schema:'manager-report/1',eventId:`traffic/${device}/${manager}/${sequence}`,source:{id:`${device}/${manager}`,deviceId:device,manager,sequence},observedAt:at,facts:[]})
async function post(path,body){return fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)})}
async function usage(){const response=await fetch(base+'/usage',{headers});assert.equal(response.status,200);return response.json()}
function message(socket,predicate){return new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{cleanup();reject(new Error('Local relay message timeout'))},10_000)
  function cleanup(){clearTimeout(timeout);socket.removeEventListener('message',receive)}
  function receive(event){const value=event.data==='pong'?'pong':JSON.parse(event.data);if(predicate(value)){cleanup();resolve(value)}}
  socket.addEventListener('message',receive)
})}
const batch={schema:'manager-batch/1',reports:Array.from({length:16},(_,n)=>report(n+1))}
let response=await post(`/manager/batch?device=${device}`,batch)
assert.equal(response.status,200)
let receipt=await response.json()
assert.equal(receipt.results.length,16)
assert(receipt.results.every((r,i)=>r.report.eventId===batch.reports[i].eventId&&!r.duplicate&&r.report.observedAt===at))
response=await post(`/manager/batch?device=${device}`,batch)
assert((await response.json()).results.every(r=>r.duplicate))
response=await post(`/manager/batch?device=${device}`,{schema:'manager-batch/1',reports:[{...report(100),observedAt:'invalid'},report(101),report(1,'issues')]})
receipt=await response.json()
assert(receipt.results[0].error&&receipt.results[1].error&&receipt.results[2].report)
const sockets=[]
try {
  const desktop=new WebSocket(base.replace('http:','ws:')+`/ws?role=desktop&token=${token}`);sockets.push(desktop)
  const hello=await message(desktop,value=>value.type==='hello')
  assert(hello.features.includes('manager-batch/1'))
  const phone=new WebSocket(base.replace('http:','ws:')+`/ws?role=phone&device=traffic-phone&token=${token}`);sockets.push(phone)
  await message(phone,value=>value.type==='relay:features')
  const before=await usage()
  const pong=message(phone,value=>value==='pong');phone.send('ping');await pong
  const after=await usage()
  assert.equal(after.operations,before.operations,'Auto-response ping must not invoke the DO handler')
  assert.equal(after.rowsWritten,before.rowsWritten,'Auto-response ping must not write SQL')
  const snapshot={updatedAt:at,deviceId:'traffic-phone',series:[],controls:[]}
  response=await post('/receipt/library?device=traffic-phone',snapshot);assert.equal(response.status,200)
  const first=await response.json()
  response=await post('/receipt/library?device=traffic-phone',{controls:[],series:[],deviceId:'traffic-phone',updatedAt:new Date(Date.parse(at)+1000).toISOString()})
  const unchanged=await response.json();assert.equal(unchanged.unchanged,true);assert.equal(unchanged.at,first.at)
  response=await post('/receipt/library?device=traffic-phone',{...snapshot,answers:'explicit-request'})
  assert.notEqual((await response.json()).unchanged,true,'Explicit command answers must be delivered')
  const metrics=await usage()
  assert(metrics.signals.manager_health>=17&&metrics.signals.manager_duplicate>=16)
  console.log(JSON.stringify({pass:true,batchEvents:16,duplicateReplay:true,partialSourceOrder:true,hibernatingPing:true,unchangedReceipt:true,signals:metrics.signals}))
}finally{for(const socket of sockets)socket.close(1000)}
