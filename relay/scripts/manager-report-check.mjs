// Isolated protocol integration. Never accepts a production URL or credentials.
import assert from 'node:assert/strict'
const base = process.env.MANAGER_TEST_URL ?? 'http://127.0.0.1:8792'
assert.equal(new URL(base).hostname,'127.0.0.1')
const token = 'manager-local-check'
const sockets = []
const at = '2026-10-18T06:00:00Z'
const namespace = process.env.MANAGER_TEST_NAMESPACE ?? 'phase1-final'
assert(/^[a-zA-Z0-9_-]{1,40}$/.test(namespace))
const resource = `fixture-confirmed-account/${namespace}/provider/model`
function fact(failed = true) { return { key:'fixture-chapter/crop_json',scope:{ seriesId:'fixture-series',chapterId:'fixture-chapter',profileId:null },stage:'crop_json',workState:failed ? 'failed' : 'verified_complete',inputRevision:'pages:fixture-revision',compatibility:'current',identity:'mapped',availability:[{ destination:'phone:fixture-phone',state:'validated',evidenceRef:'fixture-page-validator' }],override:false,done:failed ? 0 : 1,total:1,condition:{ cause:'fixture-quota',resource,state:failed ? 'action_required' : 'resolved',severity:'warning',summary:'Fixture capacity unavailable',nextAction:'Recheck fixture capacity.' } } }
function report(device,seq,failed = true) { device += `-${namespace}`; return { schema:'manager-report/1',eventId:`manager-test-${device}-${seq}`,source:{ id:`${device}/device_clipping`,deviceId:device,manager:'device_clipping',sequence:seq },observedAt:at,facts:[fact(failed)] } }
async function post(value,device = value.source.deviceId) {
  const r = await fetch(`${base}/manager/report?device=${device}`,{ method:'POST',headers:{ Authorization:`Bearer ${token}`,'Content-Type':'application/json' },body:JSON.stringify(value) })
  return { status:r.status,body:r.ok ? await r.json() : await r.text() }
}
async function connect() {
  const ws = new WebSocket(`${base.replace('http:','ws:')}/ws?role=desktop&token=${token}`), messages = []
  sockets.push(ws); ws.addEventListener('message',e => messages.push(JSON.parse(e.data)))
  await new Promise((resolve,reject) => { ws.addEventListener('open',resolve,{ once:true }); ws.addEventListener('error',reject,{ once:true }) })
  return { ws,messages }
}
async function wait(check) { const end=Date.now()+5000; while(!check()) { assert(Date.now()<end,'Relay report/incident timed out'); await new Promise(r => setTimeout(r,20)) } }
const latestIncident = client => client.messages.filter(m => m.type === 'manager:incident' && m.body.resource === resource).at(-1)?.body
try {
  const client = await connect()
  if (!process.argv.includes('--replay-only')) {
    const first = await post(report('fixture-phone-1',2)); assert.equal(first.status,200)
    const duplicate = await post(report('fixture-phone-1',2)); assert.equal(duplicate.status,200); assert.equal(duplicate.body.duplicate,true)
    assert.equal(duplicate.body.report.receivedAt,first.body.report.receivedAt)
    assert.equal((await post({ ...report('fixture-phone-1',2),facts:[fact(false)] })).status,400)
    assert.equal((await post({ ...report('fixture-phone-1',2),eventId:`sequence-collision-${namespace}` })).status,400,'Sequence reuse with a new event ID must be rejected')
    assert.equal((await post(report('fixture-phone-1',3),'someone-else')).status,400)
    assert.equal((await post({ ...report('fixture-phone-1',3),schema:'manager-report/9' })).status,400)
    assert.equal((await post(report('fixture-phone-2',1))).status,200)
    await wait(() => Object.keys(latestIncident(client)?.impacts ?? {}).length===2)
    const grouped = latestIncident(client); assert.equal(grouped.state,'action_required')
    const ack = { schema:'manager-report/1',eventId:`manager-test-owner-ack-${namespace}`,source:{ id:`fixture-owner-${namespace}/issues`,deviceId:`fixture-owner-${namespace}`,manager:'issues',sequence:1 },observedAt:at,facts:[],acknowledgment:{ incidentId:grouped.id,notificationId:grouped.notificationId } }
    assert.equal((await post(ack)).status,200)
    await wait(() => !!latestIncident(client)?.acknowledgedAt)
    assert.equal(latestIncident(client).state,'action_required','Acknowledgment must not resolve')
    assert.equal((await post(report('fixture-phone-1',1))).status,200,'Delayed source sequence retained safely')
    assert.equal((await post(report('fixture-phone-1',3,false))).status,200)
    assert.equal((await post(report('fixture-phone-2',2,false))).status,200)
    await wait(() => latestIncident(client)?.state==='resolved')
    assert.equal((await post(report('fixture-phone-2',3))).status,200)
    await wait(() => latestIncident(client)?.occurrences===2)
    assert.equal(latestIncident(client).acknowledgedAt,null)
  }
  client.ws.close()
  const replay = await connect()
  await wait(() => latestIncident(replay)?.occurrences===2)
  const i = latestIncident(replay)
  assert.equal(i.state,'action_required'); assert.equal(i.history.filter(h => h.action==='detected').length,1)
  assert.equal(i.history.filter(h => h.action==='reopened').length,1)
  assert(replay.messages.some(m => m.type==='manager:report' && m.body.source.deviceId===`fixture-phone-2-${namespace}` && m.body.source.sequence===3))
  assert(replay.messages.filter(m => m.type==='manager:report').every(m => m.body.observedAt===at && !!m.body.receivedAt))
  console.log('PASS: durable reports, duplicate/conflict/reordering protection, grouped multi-device incidents, acknowledgment, verified resolution/recurrence and reconnect replay.' + (process.argv.includes('--replay-only') ? ' Confirmed after relay restart.' : ''))
} finally { for (const ws of sockets) ws.close() }
