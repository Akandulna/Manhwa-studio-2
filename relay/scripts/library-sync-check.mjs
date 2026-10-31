// Local integration check against `wrangler dev --port 8791 --var RELAY_TOKEN:library-local-check`.
import assert from 'node:assert/strict'
const base = process.env.LIBRARY_TEST_URL ?? 'http://127.0.0.1:8791'
assert.equal(new URL(base).hostname, '127.0.0.1', 'This check only writes to a local test relay')
const token = 'library-local-check'
const sockets = []
const connect = async (role, device) => {
  const messages = []
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?role=${role}&device=${device}&name=${device}&token=${token}`)
  sockets.push(ws)
  ws.addEventListener('message', e => messages.push(JSON.parse(e.data)))
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  return { ws, messages }
}
const waitFor = async (check) => {
  const end = Date.now() + 5000
  while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for relay delivery'); await new Promise(r => setTimeout(r, 20)) }
}
try {
  const mac = await connect('desktop', 'mac')
  const nord = await connect('phone', 'nord')
  const note = await connect('phone', 'note')
  for (const device of ['mac', 'nord', 'note']) {
    const body = { schema: 'manhwa-library/1', deviceId: device, device, updatedAt: new Date().toISOString(), series: [{ folder: `Series-${device}`, title: device, chapters: [] }] }
    const response = await fetch(`${base}/receipt/library?device=${device}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    for (const [name, client] of [['mac', mac], ['nord', nord], ['note', note]]) {
      if (name !== device || name === 'mac') await waitFor(() => client.messages.some(m => m.kind === 'library' && m.device === device))
    }
  }
  nord.ws.close()
  const reconnect = await connect('phone', 'nord')
  await waitFor(() => reconnect.messages.filter(m => m.kind === 'library').length >= 2)
  assert.deepEqual(reconnect.messages.filter(m => m.kind === 'library').map(m => m.device).sort(), ['mac', 'note'])
  const state = await (await fetch(`${base}/state`, { headers: { Authorization: `Bearer ${token}` } })).json()
  assert.equal(state.receipts.filter(r => r.kind === 'library').length, 3)
  for (const device of ['mac', 'nord', 'note']) {
    const body = { schema: device === 'mac' ? 'series-process/1' : 'device-process/1', deviceId: device, updatedAt: new Date().toISOString(), series: [] }
    const response = await fetch(`${base}/receipt/process?device=${device}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    for (const [name, client] of [['mac', mac], ['nord', reconnect], ['note', note]]) {
      if (name !== device || name === 'mac') await waitFor(() => client.messages.some(m => m.kind === 'process' && m.device === device))
    }
  }
  reconnect.ws.close()
  const catchup = await connect('phone', 'nord')
  await waitFor(() => catchup.messages.filter(m => m.kind === 'process').length >= 2)
  assert.deepEqual(catchup.messages.filter(m => m.kind === 'process').map(m => m.device).sort(), ['mac', 'note'])
  console.log('PASS: all three origins broadcast library and process receipts; reconnect replays the other devices’ stored receipts.')
} finally { for (const ws of sockets) ws.close() }
