import assert from 'node:assert/strict'
// Run against an isolated local relay started with --var RELAY_TOKEN:editor-local-check.
const base=process.env.EDITOR_TEST_URL ?? 'http://127.0.0.1:8795', token='editor-local-check', sockets=[]
assert.equal(new URL(base).hostname, '127.0.0.1', 'This fixture only writes to a local test relay')
const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'}
const wait=async check=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw Error('Timed out');await new Promise(r=>setTimeout(r,20))}}
const connect=async()=>{const messages=[];const ws=new WebSocket(`${base.replace('http:','ws:')}/ws?role=phone&device=editor-test&name=EditorTest&token=${token}`);sockets.push(ws);ws.addEventListener('message',e=>messages.push(JSON.parse(e.data)));await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});return {ws,messages}}
try {
 let phone=await connect()
 for(const ai of ['chatgpt','aistudio'])for(const smallBatches of [true,false]){
  const body={id:crypto.randomUUID(),requestedAt:new Date().toISOString(),action:'editor_start',device:'editor-test',series:'Fixture',ai,smallBatches,tabs:3,language:'hi',chatGpt:{mode:'Chat',model:'Fixture model',effort:'High'}}
  const response=await fetch(`${base}/request`,{method:'POST',headers,body:JSON.stringify(body)})
  assert.equal(response.status,200,await response.text())
  await wait(()=>phone.messages.some(m=>m.id===body.id))
  const check=m=>{for(const key of ['ai','smallBatches','tabs','language','chatGpt'])assert.deepEqual(m[key],body[key])}
  check(phone.messages.find(m=>m.id===body.id))
  phone.ws.close();phone=await connect()
  await wait(()=>phone.messages.some(m=>m.id===body.id)||phone.messages.some(m=>m.type==='hello'&&m.request?.id===body.id))
  check(phone.messages.find(m=>m.id===body.id)??phone.messages.find(m=>m.type==='hello').request)
 }
 for(const options of [{ai:'gemini'},{smallBatches:'false'}]){
  const response=await fetch(`${base}/request`,{method:'POST',headers,body:JSON.stringify({id:crypto.randomUUID(),action:'editor_start',device:'editor-test',...options})});assert.equal(response.status,400)
 }
 console.log('PASS: Editor providers, true/false batch settings, model, tabs and language survive delivery and reconnect; invalid options rejected.')
}finally{for(const ws of sockets)ws.close()}
