// Specification checks only. Never import this oracle into production scheduling.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const requireClient = createRequire(new URL('../../../client/package.json', import.meta.url))
const Ajv = requireClient('ajv')
const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'))
const schema = read('records.schema.json')
const { valid, invalid } = read('fixtures.json')
const validate = new Ajv({ allErrors: true }).compile(schema)
for (const record of valid) assert(validate(record), `${record.kind}: ${JSON.stringify(validate.errors)}`)
assert.equal(new Set(valid.map(r => r.kind)).size, schema.oneOf.length, 'Every record family needs a fixture')
for (const fixture of invalid) {
  const record = structuredClone(valid.find(r => r.kind === fixture.base))
  let parent = record
  for (const key of fixture.path.slice(0, -1)) parent = parent[key]
  const key = fixture.path.at(-1)
  if (fixture.delete) delete parent[key]; else parent[key] = fixture.value
  assert(!validate(record), `Invalid fixture accepted: ${fixture.name}`)
}
function transition(state, event, f) {
  if (['cancelled', 'superseded'].includes(state)) return 'reject'
  if (event === 'cancel') return 'cancelled'
  if (event === 'input_changed') return 'superseded'
  if (event === 'recover') return f.paused ? 'reject' : state
  if (event === 'accepted') return f.currentAttempt ? 'running' : 'reject'
  if (['disconnect', 'lease_expired'].includes(event)) return 'uncertain'
  if (event === 'reconcile') return f.outcome === 'unsent' && f.released ? 'queued' : 'uncertain'
  if (event === 'publish') {
    if (!f.currentAttempt || !f.currentRevision || !f.validated) return 'reject'
    return f.reviewAccepted ? 'verified_complete' : 'awaiting_review'
  }
  if (['result_saved', 'stop_requested', 'resume'].includes(event)) return state
  throw new Error(`Unknown specification event: ${event}`)
}
const task = valid.find(r => r.kind === 'task')
const { entity: e, inputFingerprint } = task.body
const identity = [task.workspaceId, e.seriesId, e.chapterId, e.stage, e.language, e.unit.kind, e.unit.id, inputFingerprint]
assert.equal(task.body.taskId, 'task:sha256:' + createHash('sha256').update(JSON.stringify(identity)).digest('hex'), 'Stable task identity excludes run ID')
assert.equal(valid.filter(r => r.kind === 'ui_change').length, 3)
for (const provider of ['chatgpt', 'gemini', 'aistudio']) assert(valid.some(r => r.kind === 'ui_change' && r.body.provider === provider))
const transitions = read('transitions.json')
for (const c of transitions) assert.equal(transition(c.state, c.event, c.facts), c.expected, c.name)
// Accepted observations: test ordering independent of receiver/dashboard clocks.
const current = valid.find(r => r.kind === 'observation')
const seen = new Map()
const sourceFacts = new Map()
function receive(record) {
  const eventKey = JSON.stringify([record.workspaceId, record.eventId])
  const priorEvent = seen.get(eventKey)
  // Receiver stamps can differ on a retry; immutable producer fields cannot.
  const { receivedAt, ...producer } = record
  const payload = JSON.stringify(producer)
  if (priorEvent) return priorEvent === payload ? 'duplicate' : 'conflict'
  seen.set(eventKey, payload)
  const key = JSON.stringify([record.workspaceId, record.source.id, record.body.entity, record.kind])
  const prior = sourceFacts.get(key)
  if (prior && prior.source.sequence >= record.source.sequence) return 'stale'
  sourceFacts.set(key, record)
  return 'accepted'
}
assert.equal(receive(current), 'accepted')
assert.equal(receive({ ...current, receivedAt: '2026-10-20T00:00:00Z' }), 'duplicate')
assert.equal(receive({ ...current, body: { ...current.body, workState: 'failed' } }), 'conflict')
assert.equal(receive({ ...current, eventId: 'older', source: { ...current.source, sequence: 1 } }), 'stale')
assert.equal([...sourceFacts.values()][0].observedAt, current.observedAt)
const otherSource = { ...current, eventId: 'other-device', source: { ...current.source, id: 'phone-2/clipper', sequence: 1 } }
assert.equal(receive(otherSource), 'accepted', 'Sources retain independent evidence')
assert.equal(sourceFacts.size, 2)
const olderRevision = { ...current, eventId: 'old-revision', source: { ...current.source, sequence: 99 }, body: { ...current.body, inputFingerprint: 'sha256:' + 'b'.repeat(64) } }
assert.equal(receive(olderRevision), 'accepted', 'Historical evidence retained')
const currentProjection = [...sourceFacts.values()].filter(r => r.body.inputFingerprint === current.body.inputFingerprint)
assert.equal(currentProjection.length, 1, 'Historical revision cannot satisfy current work')
assert.equal(currentProjection[0].source.id, 'phone-2/clipper')
assert.equal(currentProjection[0].observedAt, current.observedAt, 'Refresh never stamps new source freshness')
// One failure affecting several devices, acknowledgment independent of resolution.
const incidents = new Map(), incidentEvents = new Set()
function incident(eventId, cause, resource, impact) {
  if (incidentEvents.has(eventId)) return
  incidentEvents.add(eventId)
  const key = JSON.stringify([cause, resource])
  const entry = incidents.get(key) ?? { impacts: new Set(), state: 'waiting', acknowledged: false }
  entry.impacts.add(impact); incidents.set(key, entry)
}
incident('e1', 'quota', 'account-1/model', 'phone-1')
incident('e2', 'quota', 'account-1/model', 'phone-2')
incident('e2', 'quota', 'account-1/model', 'phone-2')
assert.equal(incidents.size, 1)
const grouped = [...incidents.values()][0]
assert.equal(grouped.impacts.size, 2)
grouped.acknowledged = true
assert.equal(grouped.state, 'waiting')
// Failed delivery and lost acknowledgment preserve one durable logical event.
const outbox = new Map([[current.eventId, structuredClone(current)]])
const restartedOutbox = new Map(JSON.parse(JSON.stringify([...outbox])))
assert.deepEqual(restartedOutbox.get(current.eventId), current)
assert.equal(receive(restartedOutbox.get(current.eventId)), 'duplicate')
restartedOutbox.delete(current.eventId) // only after durable receiver acknowledgment
assert.equal(restartedOutbox.size, 0)
const ui = valid.find(r => r.kind === 'ui_change').body
assert.deepEqual(ui.handoffs.map(h => [h.from, h.to]), [
  ['website_ui_monitor', 'device_image_clipper_manager'], ['device_image_clipper_manager', 'issues_manager']
])
assert.equal(ui.baselineAcceptedAt, null, 'Notification does not adopt baseline')
console.log(`Validated ${schema.oneOf.length} record families (${valid.length} valid fixtures), ${invalid.length} invalid records, ${transitions.length} safety transitions, ordering/replay/grouping and UI chain specification checks.`)
console.log('These specification checks do not execute the manager runtime. See validation.md for separate Android JVM and existing live relay results.')
