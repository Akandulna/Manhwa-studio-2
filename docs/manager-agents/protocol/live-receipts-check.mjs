// Explicit live receipt-only check. Run from Studio root with --live. Never prints credentials or receipt content.
import assert from 'node:assert/strict'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
assert(process.argv.includes('--live'), 'Pass --live to authorize a receipt-only refresh against the configured relay')
const require = createRequire(resolve('server/package.json'))
const { parse } = require('dotenv')
const WebSocket = require('ws')
let env = { ...process.env }
for (const path of ['server/.env', '.env']) if (existsSync(path)) env = { ...parse(readFileSync(path)), ...env }
assert(env.RELAY_TOKEN, 'Relay credentials unavailable; no secret values printed')
const api = 'http://127.0.0.1:3002/api/r2'
async function get(path) { const r = await fetch(api + path, { signal: AbortSignal.timeout(10000) }); assert(r.ok); return r.json() }
const status = await get('/relay'), before = await get('/phone/overview')
assert(status.connected)
const phones = status.devices.filter(p => p.connected)
assert(phones.length)
const sockets = []
function connect() {
  const url = new URL(status.url); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.pathname = '/ws'
  url.search = new URLSearchParams({ role: 'desktop', token: env.RELAY_TOKEN }).toString()
  const ws = new WebSocket(url), records = []
  sockets.push(ws)
  ws.on('message', raw => { try { const msg = JSON.parse(raw); if (msg.type === 'receipt') records.push(msg) } catch {} })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Diagnostic relay connection timed out')), 10000)
    ws.once('open', () => { clearTimeout(timer); resolve({ ws, records }) })
    ws.once('error', () => { clearTimeout(timer); reject(new Error('Diagnostic relay connection failed')) })
  })
}
async function wait(check, timeout = 30000) {
  const until = Date.now() + timeout
  while (!check()) { assert(Date.now() < until, 'Timed out awaiting correlated phone receipts'); await new Promise(r => setTimeout(r, 150)) }
}
try {
  const first = await connect()
  await wait(() => phones.every(p => first.records.some(r => r.device === p.id)))
  const response = await fetch(api + '/phone/request', { method: 'POST', signal: AbortSignal.timeout(10000) })
  assert(response.ok)
  const request = await response.json()
  assert.equal(request.via, 'relay')
  console.log(JSON.stringify({ step: 'receipt-only refresh', devices: phones.length, reportedRecipients: request.phones }))
  await wait(() => phones.every(p => ['sync', 'scripts', 'crops'].every(kind => first.records.some(r => r.device === p.id && r.kind === kind && r.body?.answers === request.id))))
  const accepted = phones.map(p => ({
    deviceId: p.id,
    kinds: ['sync', 'scripts', 'crops'].map(kind => {
      const r = first.records.find(r => r.device === p.id && r.kind === kind && r.body?.answers === request.id)
      return { kind, observedAt: r.body.updatedAt, receivedAtMs: r.at, correlated: true }
    }),
    managedProtocolAdvertised: !!before.phones.find(x => x.id === p.id)?.automation?.capabilities?.includes('managed-task/1')
  }))
  first.ws.close()
  const replay = await connect()
  await wait(() => phones.every(p => ['sync', 'scripts', 'crops'].every(kind => replay.records.some(r => r.device === p.id && r.kind === kind && r.body?.answers === request.id))))
  for (const phone of accepted) for (const fact of phone.kinds) {
    const r = replay.records.find(r => r.device === phone.deviceId && r.kind === fact.kind && r.body?.answers === request.id)
    assert.equal(r.at, fact.receivedAtMs, 'Reconnect must preserve relay acceptance time')
    assert.equal(r.body.updatedAt, fact.observedAt, 'Reconnect must preserve source observation time')
  }
  const after = await get('/phone/overview')
  assert.equal(after.answers, request.id, 'Running Studio server must accept the correlated refresh')
  assert(phones.every(p => after.phones.some(x => x.id === p.id && x.connected)), 'Studio must retain both connected device projections')
  assert.equal(after.runs.length, before.runs.length)
  assert.equal(after.working.length, before.working.length)
  const report = { verifiedAt: new Date().toISOString(), receiptRoundTrip: 'passed', studioCorrelation: 'passed', diagnosticDesktopReplay: 'passed', replayPreservedTimestamps: true, phones: accepted, activeRunsBefore: before.runs.length, activeRunsAfter: after.runs.length, newManagerRuntime: 'not implemented in Phase 0', scope: 'Existing phone → production relay → Studio receipt round trip; diagnostic desktop reconnect. No generation, phone disconnect, app restart, or canonical publication performed.' }
  writeFileSync('docs/manager-agents/live-validation.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ result: 'PASS', phones: accepted, runsUnchanged: true, scope: report.scope }))
} catch(e) { console.error(e.message); process.exitCode = 1 }
finally { for (const ws of sockets) ws.close(); setTimeout(() => sockets.forEach(ws => ws.terminate()), 500).unref() }
