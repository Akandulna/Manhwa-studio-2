import { incidentKey, applyManagerReport, emptyManagerProjection, managerPayload, parseManagerReport, type ManagerProjection, type ManagerReport } from '../../server/src/services/managerProtocol'

/** Observation/incident authority only. No task claims, execution, or repair actions. */
export class ManagerAuthority {
  private cleanupEnabled = false
  constructor(private sql: SqlStorage, private storage: DurableObjectStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS manager_events (id TEXT PRIMARY KEY, payload TEXT NOT NULL, accepted TEXT NOT NULL, at TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS manager_sequences (source TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(source, sequence))')

    sql.exec('CREATE TABLE IF NOT EXISTS manager_projection_parts (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS manager_projection (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS manager_latest (source TEXT NOT NULL, fact TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(source, fact))')
    const migration = sql.exec<{value:string}>("SELECT value FROM relay_schema WHERE id = 'manager-budget-v1'").toArray()[0]
    if (!migration) {
      // Bound one-time index creation too. Large legacy stores retain history until a separate migration.
      const small = sql.exec('SELECT id FROM manager_events LIMIT 5001').toArray().length <= 5000
      if (small) sql.exec('CREATE INDEX IF NOT EXISTS manager_events_at ON manager_events(at)')
      sql.exec("INSERT INTO relay_schema (id,value) VALUES ('manager-budget-v1',?)", small ? 'indexed' : 'cleanup-deferred')
      this.cleanupEnabled = small
    } else this.cleanupEnabled = migration.value === 'indexed' 
  }
  state(): ManagerProjection {
    const format=this.sql.exec<{value:string}>("SELECT value FROM relay_schema WHERE id = 'manager-projection-parts-v1'").toArray()[0]
    if(format) {
      const count=Number(format.value)
      if(!Number.isInteger(count)||count<1||count>256)throw new Error('Invalid manager projection chunk count')
      const rows=this.sql.exec<{id:number;body:string}>('SELECT id,body FROM manager_projection_parts ORDER BY id LIMIT 257').toArray()
      if(rows.length!==count||rows.some((row,index)=>row.id!==index))throw new Error('Incomplete manager projection chunks')
      return JSON.parse(rows.map(row=>row.body).join(''))
    }
    const row = this.sql.exec<{ body: string }>('SELECT body FROM manager_projection WHERE id = 1').toArray()[0]
    return row ? JSON.parse(row.body) : emptyManagerProjection()
  }
  /** Transactional chunks avoid SQLite's per-row size limit as the projection grows. */
  private saveState(state:ManagerProjection):void {
    const text=JSON.stringify(state),size=128_000,chunks:string[]=[]
    for(let start=0;start<text.length;) {let end=Math.min(start+size,text.length);const code=text.charCodeAt(end-1);if(end<text.length&&code>=0xD800&&code<=0xDBFF)end--;chunks.push(text.slice(start,end));start=end}
    const count=chunks.length
    if(count>256)throw new Error('Manager projection safety bound reached; retain pending reports')
    for(let i=0;i<count;i++) {
      const body=chunks[i]
      this.sql.exec('INSERT INTO manager_projection_parts (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE body != excluded.body',i,body)
    }
    this.sql.exec('DELETE FROM manager_projection_parts WHERE id >= ?',count)
    this.sql.exec("INSERT INTO relay_schema (id,value) VALUES ('manager-projection-parts-v1',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",String(count))
    // Marker + chunks + removal commit in the caller's transaction; no partially migrated state is visible.
    this.sql.exec('DELETE FROM manager_projection WHERE id = 1')
  }
  replay(): ManagerReport[] {
    // A batch body can occur under hundreds of fact keys. Deduplicate the raw body before
    // parsing it, and page on the composite primary key rather than truncating large stores.
    const bodies = new Set<string>()
    let after: [string,string] | null = null
    while (true) {
      const rows: {source:string;fact:string;body:string}[] = after
        ? this.sql.exec<{source:string;fact:string;body:string}>('SELECT source,fact,body FROM manager_latest WHERE (source,fact) > (?,?) ORDER BY source,fact LIMIT 128',...after).toArray()
        : this.sql.exec<{source:string;fact:string;body:string}>('SELECT source,fact,body FROM manager_latest ORDER BY source,fact LIMIT 128').toArray()
      for (const row of rows) bodies.add(row.body)
      if (rows.length < 128) break
      const last = rows[rows.length-1]; after = [last.source,last.fact]
    }
    return [...bodies].map(body => JSON.parse(body) as ManagerReport).sort((a,b) => (a.receivedAt ?? '').localeCompare(b.receivedAt ?? '') || a.source.sequence-b.source.sequence)
  }

  accept(raw: unknown, device: string): { report: ManagerReport; duplicate: boolean } {
    const parsed = parseManagerReport(raw)
    if (!parsed || parsed.receivedAt !== undefined || parsed.source.deviceId !== device || parsed.source.id !== `${device}/${parsed.source.manager}`) throw new Error('Invalid manager report or source')
    if (Date.parse(parsed.observedAt) > Date.now() + 5 * 60_000) throw new Error('Manager source clock is ahead; reconcile it before reporting')
    const payload = managerPayload(parsed)
    return this.storage.transactionSync(() => {
      const previous = this.sql.exec<{ payload: string; accepted: string }>('SELECT payload, accepted FROM manager_events WHERE id = ?', parsed.eventId).toArray()[0]
      if (previous) {
        if (previous.payload !== payload) throw new Error('Conflicting manager event ID')
        return { report: JSON.parse(previous.accepted) as ManagerReport, duplicate: true }
      }
      const sequence = this.sql.exec<{ event_id: string }>('SELECT event_id FROM manager_sequences WHERE source = ? AND sequence = ?',parsed.source.id,parsed.source.sequence).toArray()[0]
      if (sequence && sequence.event_id !== parsed.eventId) throw new Error('Conflicting manager source sequence')
      this.sql.exec('INSERT OR IGNORE INTO manager_sequences (source,sequence,event_id) VALUES (?, ?, ?)',parsed.source.id,parsed.source.sequence,parsed.eventId)
      const report: ManagerReport = { ...parsed, receivedAt: new Date().toISOString() }
      const state = this.state()
      applyManagerReport(state, report)
      const affected = new Set(report.facts.flatMap(f => f.condition ? [incidentKey(f.condition.cause,f.condition.resource)] : []))
      if (report.acknowledgment) affected.add(report.acknowledgment.incidentId)
      for (const id of affected) if (state.incidents[id]) state.incidents[id].authorityRevision = (state.incidents[id].authorityRevision ?? 0) + 1
      const accepted = JSON.stringify(report)
      this.sql.exec('INSERT INTO manager_events (id, payload, accepted, at) VALUES (?, ?, ?, ?)', report.eventId, payload, accepted, report.receivedAt!)
      this.saveState(state)
      // Replay current facts and one source-health watermark, not the unbounded historical event journal.
      for (const fact of report.facts) {
        const current = state.observations[JSON.stringify([report.source.id, fact.key])]
        if (current?.eventId === report.eventId) this.sql.exec('INSERT INTO manager_latest (source, fact, body) VALUES (?, ?, ?) ON CONFLICT(source, fact) DO UPDATE SET body = excluded.body', report.source.id, fact.key, accepted)
      }
      const health = this.sql.exec<{ body: string }>('SELECT body FROM manager_latest WHERE source = ? AND fact = ?', report.source.id, '').toArray()[0]
      if (!health || JSON.parse(health.body).source.sequence < report.source.sequence) this.sql.exec('INSERT INTO manager_latest (source, fact, body) VALUES (?, ?, ?) ON CONFLICT(source, fact) DO UPDATE SET body = excluded.body', report.source.id, '', accepted)
      // Idempotency tombstones remain at least 90 days; current facts/incidents survive indefinitely.
      // Indexed bounded deletion: old history can wait, idempotency sequence tombstones are retained.
      if (this.cleanupEnabled) this.sql.exec('DELETE FROM manager_events WHERE id IN (SELECT id FROM manager_events WHERE at < ? ORDER BY at LIMIT 128)', new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString())
      return { report, duplicate: false }
    })
  }
}
