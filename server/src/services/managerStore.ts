import { managerBatch, managerFactChunks } from './managerBatch.js'
import { createHash, randomUUID } from 'node:crypto'
import { applyManagerReport, emptyManagerProjection, managerPayload, parseManagerReport, type ManagerFact, type ManagerId, type ManagerIncident, type ManagerProjection, type ManagerReport } from './managerProtocol.js'

export interface ManagerState {
  version: 1; deviceId: string; sequences: Record<string, number>; fingerprints: Record<string, string>
  projection: ManagerProjection; outbox: ManagerReport[]; seen: Record<string, { hash: string; at: string }>
  health: Record<string, { source: ManagerReport['source']; observedAt: string; receivedAt: string | null }>
  healthEnvelopeAt?: number
  lastDeliveryError: string | null
}
export interface ManagerPersistence { load(): Promise<ManagerState | null>; save(state: ManagerState): Promise<void> }
const hash = (v: string) => createHash('sha256').update(v).digest('hex')
/** Local projection and immutable outbound intent are committed together. Failed writes roll back memory. */
export class ManagerStore {
  private state!: ManagerState
  private queue = Promise.resolve()
  private activity = new Map<ManagerId,{at:string;active:boolean}>()
  private ready: Promise<void>
  constructor(private persistence: ManagerPersistence, private changed: () => void = () => {}, private now = () => new Date().toISOString(), private consolidatedHealth = false) {
    this.ready = (async () => {
      this.state = await persistence.load() ?? { version: 1, deviceId: `mac-${randomUUID()}`, sequences: {}, fingerprints: {}, projection: emptyManagerProjection(), outbox: [], seen: {}, health: {}, lastDeliveryError: null }
      if (this.state.version !== 1) throw new Error('Unsupported manager projection version')
    })()
  }
  private async transaction<T>(work: (state: ManagerState) => T | Promise<T>, unchanged?: (state: ManagerState) => boolean, unchangedResult?: T): Promise<T> {
    const pending = this.queue.then(async () => {
      await this.ready
      if (unchanged?.(this.state)) return unchangedResult as T
      const next = structuredClone(this.state)
      const result = await work(next)
      await this.persistence.save(next)
      this.state = next; this.changed(); return result
    })
    this.queue = pending.then(() => {}, () => {})
    return pending
  }
  async snapshot(waitForPending = true): Promise<ManagerState> { await this.ready; if (waitForPending) await this.queue; return structuredClone(this.state) }
  async observe(manager: ManagerId, facts: ManagerFact[], observedAt: string, deviceId?: string, healthIntervalMs = 5 * 60_000): Promise<void> {
    await this.ready
    if(this.consolidatedHealth&&!deviceId) {
      const prior=this.activity.get(manager)
      if(!prior||Date.parse(observedAt)>=Date.parse(prior.at))this.activity.set(manager,{at:observedAt,active:facts.some(f=>f.workState==='running')})
    }
    const device = deviceId
    const digests = new Map(facts.map(fact => [fact.key, hash(JSON.stringify(fact))]))
    const unchanged = (state: ManagerState) => {
      const sourceId = `${device ?? state.deviceId}/${manager}`
      const health = state.health[JSON.stringify(sourceId)]
      if (!this.consolidatedHealth && (!health || Date.parse(observedAt) - Date.parse(health.observedAt) >= healthIntervalMs)) return false
      return facts.every(fact => {
        const key = JSON.stringify([sourceId,fact.key]), prior = state.projection.observations[key]
        return !!prior && Date.parse(observedAt) < Date.parse(prior.observedAt) || state.fingerprints[key] === digests.get(fact.key)
      })
    }
    await this.transaction(state => {
      const device = deviceId ?? state.deviceId
      const sourceId = `${device}/${manager}`
      const changed = facts.filter(fact => {
        const key = JSON.stringify([sourceId, fact.key])
        const prior = state.projection.observations[key]
        if (prior && Date.parse(observedAt) < Date.parse(prior.observedAt)) return false
        const digest = digests.get(fact.key)!
        if (state.fingerprints[key] === digest) return false
        state.fingerprints[key] = digest; return true
      })
      // A bounded health-only record confirms reporter activity, without altering fact timestamps.
      const health = state.health[JSON.stringify(sourceId)]
      const due = !this.consolidatedHealth && (!health || Date.parse(observedAt) - Date.parse(health.observedAt) >= healthIntervalMs)
      if (!changed.length && !due) return
      for (const facts of changed.length ? managerFactChunks(changed) : [[]]) {
        const key = JSON.stringify(sourceId)
        const report: ManagerReport = { schema: 'manager-report/1', eventId: randomUUID(), source: { id: sourceId, deviceId: device, manager, sequence: state.sequences[key] = (state.sequences[key] ?? 0) + 1 }, observedAt, facts }
        if (!parseManagerReport(report)) throw new Error('Invalid manager observation')
        state.outbox.push(report)
        applyManagerReport(state.projection, report)
        state.health[key] = { source: report.source, observedAt, receivedAt: null }
      }
    }, unchanged)
  }
  private async flushHealth():Promise<void> {
    const now=Date.parse(this.now())
    const activity=[...this.activity]
    const interval=activity.some(([,a])=>a.active&&now-Date.parse(a.at)<300_000)?300_000:900_000
    const due=(state:ManagerState)=>now-(state.healthEnvelopeAt??0)>=interval
    await this.transaction(state=>{
      for(const [manager,activity] of this.activity) {
        const sourceId=`${state.deviceId}/${manager}`,key=JSON.stringify(sourceId)
        const prior=state.health[key]
        if(prior&&Date.parse(prior.observedAt)>=Date.parse(activity.at))continue
        const report:ManagerReport={schema:'manager-report/1',eventId:randomUUID(),source:{id:sourceId,deviceId:state.deviceId,manager,sequence:state.sequences[key]=(state.sequences[key]??0)+1},observedAt:activity.at,facts:[]}
        state.outbox.push(report)
        state.health[key]={source:report.source,observedAt:report.observedAt,receivedAt:null}
      }
      state.healthEnvelopeAt=now
    },state=>!due(state)||!activity.some(([manager,a])=>{const previous=state.health[JSON.stringify(`${state.deviceId}/${manager}`)];return !previous||Date.parse(a.at)>Date.parse(previous.observedAt)}))
  }
  async receiveIncident(incident: ManagerIncident): Promise<void> {
    await this.transaction(state => {
      const prior = state.projection.incidents[incident.id]
      if (Number.isSafeInteger(incident.authorityRevision) && incident.authorityRevision! > (prior?.authorityRevision ?? 0)) state.projection.incidents[incident.id] = structuredClone(incident)
    }, state => !Number.isSafeInteger(incident.authorityRevision) || incident.authorityRevision! <= (state.projection.incidents[incident.id]?.authorityRevision ?? 0))
  }
  async receive(report: ManagerReport): Promise<'accepted' | 'duplicate'> {
    return (await this.receiveMany([report]))[0]
  }
  async receiveMany(reports: ManagerReport[], delivered = false): Promise<('accepted' | 'duplicate')[]> {
    const entries = reports.map(report => {
      if (!parseManagerReport(report) || !report.receivedAt) throw new Error('Invalid accepted manager report')
      return { report,key:JSON.stringify(report.eventId),digest:hash(managerPayload(report)) }
    })
    return this.transaction(state => {
      const results: ('accepted' | 'duplicate')[] = []
      const accepted = new Map<string,string>()
      for (const { report,key,digest } of entries) {
        const existing = state.seen[key]
        if (existing) {
          if (existing.hash !== digest) throw new Error('Conflicting manager event ID')
          results.push('duplicate'); continue
        }
        state.seen[key] = { hash:digest,at:report.receivedAt! }
        applyManagerReport(state.projection,report)
        accepted.set(report.eventId,report.receivedAt!)
        const sourceKey = JSON.stringify(report.source.id), prior = state.health[sourceKey]
        if (!prior || report.source.sequence >= prior.source.sequence) state.health[sourceKey] = { source:report.source,observedAt:report.observedAt,receivedAt:report.receivedAt! }
        results.push('accepted')
      }
      // Confirm optimistic local facts in one pass through the projection for the replay batch.
      for (const observation of Object.values(state.projection.observations)) {
        const receivedAt = accepted.get(observation.eventId)
        if (receivedAt) {
          observation.receivedAt = receivedAt
          if (observation.websiteUi && observation.source.manager === 'device_clipping') observation.websiteUi = { ...observation.websiteUi,route:{ ...observation.websiteUi.route,issuesReceivedAt:receivedAt } }
        }
      }
      const cutoff = Date.parse(this.now()) - 90 * 24 * 60 * 60_000
      for (const [id,entry] of Object.entries(state.seen)) if (Date.parse(entry.at) < cutoff) delete state.seen[id]
      if (delivered) {
        const ids = new Set(reports.map(r => r.eventId))
        state.outbox = state.outbox.filter(r => !ids.has(r.eventId)); state.lastDeliveryError = null
      }
      return results
    }, state => (!delivered || !state.lastDeliveryError && !state.outbox.some(r => reports.some(a => a.eventId === r.eventId))) && entries.every(({ key,digest }) => {
      const existing = state.seen[key]
      if (existing && existing.hash !== digest) throw new Error('Conflicting manager event ID')
      return !!existing
    }), entries.map(() => 'duplicate' as const))
  }
  async acknowledge(incidentId: string, notificationId: string): Promise<void> {
    await this.transaction(state => {
      const incident = state.projection.incidents[incidentId]
      if (!incident || incident.notificationId !== notificationId) throw new Error('Incident changed. Reload before acknowledging.')
      if (state.outbox.some(report => report.acknowledgment?.incidentId === incidentId && report.acknowledgment.notificationId === notificationId)) return
      const sourceId = `${state.deviceId}/issues`, key = JSON.stringify(sourceId)
      const report: ManagerReport = { schema: 'manager-report/1', eventId: randomUUID(), source: { id: sourceId, deviceId: state.deviceId, manager: 'issues', sequence: state.sequences[key] = (state.sequences[key] ?? 0) + 1 }, observedAt: this.now(), facts: [], acknowledgment: { incidentId, notificationId } }
      state.outbox.push(report)
      // Offline acknowledgment is pending, not falsely presented as delivered/resolved.
    })
  }
  async drain(send: (report: ManagerReport) => Promise<ManagerReport>, sendBatch?: (reports:ManagerReport[])=>Promise<PromiseSettledResult<ManagerReport>[]>): Promise<void> {
    if(this.consolidatedHealth)await this.flushHealth()
    // Preserve each source's order while independent sources share a bounded delivery batch.
    let remaining = (await this.snapshot()).outbox
    let rounds=0
    while (remaining.length && rounds++ < 8) {
      const sources = new Set<string>()
      const batch = sendBatch ? managerBatch(remaining.filter(r=>r.source.deviceId===remaining[0].source.deviceId)) : remaining.filter(report => {
        if (sources.size >= 4 || sources.has(report.source.id)) return false
        sources.add(report.source.id); return true
      })
      if(!batch.length)throw new Error('Manager event exceeds the delivery byte bound')
      const results = sendBatch ? await sendBatch(batch) : await Promise.allSettled(batch.map(async report => {
        const accepted = await send(report)
        if (accepted.eventId !== report.eventId || managerPayload(accepted) !== managerPayload(report)) throw new Error('Relay acknowledgment does not match manager event')
        return accepted
      }))
      const accepted = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : [])
      if (accepted.length) await this.receiveMany(accepted,true)
      if (results.some(r => r.status === 'rejected')) {
        await this.transaction(state => { state.lastDeliveryError = 'Manager reporting is waiting for relay delivery. Saved reports will retry.' })
        break
      }
      const delivered = new Set(accepted.map(r => r.eventId))
      remaining = remaining.filter(r => !delivered.has(r.eventId))
    }
  }
}
