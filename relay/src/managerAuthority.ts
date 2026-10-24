import { incidentKey, observationKey, applyManagerReport, emptyManagerProjection, managerPayload, parseManagerReport, type ManagerIncident, type ManagerObservation, type ManagerProjection, type ManagerReport } from '../../server/src/services/managerProtocol'

/**
 * Progress of the move from one serialized projection to one row per observation, incident and chapter revision:
 * absent (not started), the count of entries copied so far, or 'done'.
 */
const ROWS_MARKER = 'manager-rows-v1'
/** Entries copied per fact report, so the one-time move can never need more of a day's row budget than this. */
export const MIGRATION_SLICE = 2_000
const PAGE = 128

/** The entries one report can touch, as loaded, so only changed entries are written back. */
type Touched = { state: ManagerProjection; observations: Map<string,string>; incidents: Map<string,string>; revisions: Map<string,string> }

/** Observation/incident authority only. No task claims, execution, or repair actions. */
export class ManagerAuthority {
  private cleanupEnabled = false
  /** Known committed; then the serialized projection is never read again. */
  private migrated = false
  private migratedInTransaction = false
  constructor(private sql: SqlStorage, private storage: DurableObjectStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS manager_events (id TEXT PRIMARY KEY, payload TEXT NOT NULL, accepted TEXT NOT NULL, at TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS manager_sequences (source TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(source, sequence))')

    sql.exec('CREATE TABLE IF NOT EXISTS manager_projection_parts (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS manager_projection (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS manager_latest (source TEXT NOT NULL, fact TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(source, fact))')
    // Row-per-entry projection: a report reads and writes only the entries it names.
    sql.exec('CREATE TABLE IF NOT EXISTS manager_observation_rows (key TEXT PRIMARY KEY, body TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS manager_incident_rows (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS manager_revision_rows (chapter TEXT PRIMARY KEY, revision TEXT NOT NULL)')
    const migration = sql.exec<{value:string}>("SELECT value FROM relay_schema WHERE id = 'manager-budget-v1'").toArray()[0]
    if (!migration) {
      // Bound one-time index creation too. Large legacy stores retain history until a separate migration.
      const small = sql.exec('SELECT id FROM manager_events LIMIT 5001').toArray().length <= 5000
      if (small) sql.exec('CREATE INDEX IF NOT EXISTS manager_events_at ON manager_events(at)')
      sql.exec("INSERT INTO relay_schema (id,value) VALUES ('manager-budget-v1',?)", small ? 'indexed' : 'cleanup-deferred')
      this.cleanupEnabled = small
    } else this.cleanupEnabled = migration.value === 'indexed'
  }
  /** The whole projection. Reads every row: only for full exports and tests, never per report. */
  state(): ManagerProjection {
    const legacy = this.legacy()
    const state: ManagerProjection = { observations: { ...legacy?.observations }, incidents: { ...legacy?.incidents } }
    for (const row of this.pages<{key:string;body:string}>('manager_observation_rows','key','key,body')) state.observations[row.key] = JSON.parse(row.body)
    for (const row of this.pages<{id:string;body:string}>('manager_incident_rows','id','id,body')) state.incidents[row.id] = JSON.parse(row.body)
    const revisions: Record<string,string> = { ...legacy?.currentRevisions }
    for (const row of this.pages<{chapter:string;revision:string}>('manager_revision_rows','chapter','chapter,revision')) revisions[row.chapter] = row.revision
    if (Object.keys(revisions).length) state.currentRevisions = revisions
    return state
  }
  /** Named incidents only, for the desktop notification after a report. */
  incidents(ids: Iterable<string>): Record<string, ManagerIncident> {
    const found: Record<string, ManagerIncident> = {}
    let legacy: ManagerProjection | null | undefined
    for (const id of new Set(ids)) {
      const row = this.sql.exec<{body:string}>('SELECT body FROM manager_incident_rows WHERE id = ?', id).toArray()[0]
      if (row) { found[id] = JSON.parse(row.body); continue }
      if (legacy === undefined) legacy = this.legacy()
      if (legacy?.incidents?.[id]) found[id] = legacy.incidents[id]
    }
    return found
  }
  /** Every incident, without the observations: what a connecting desktop replays. */
  allIncidents(): ManagerIncident[] {
    const incidents: Record<string, ManagerIncident> = { ...this.legacy()?.incidents }
    for (const row of this.pages<{body:string;id:string}>('manager_incident_rows','id','id,body')) incidents[row.id] = JSON.parse(row.body)
    return Object.values(incidents)
  }
  /** Complete, paged on the primary key so large tables are never truncated. */
  private pages<T extends Record<string,SqlStorageValue>>(table: string, key: string, columns: string): T[] {
    const all: T[] = []
    let after: SqlStorageValue = null
    while (true) {
      const rows: T[] = (after === null
        ? this.sql.exec<T>(`SELECT ${columns} FROM ${table} ORDER BY ${key} LIMIT ${PAGE}`)
        : this.sql.exec<T>(`SELECT ${columns} FROM ${table} WHERE ${key} > ? ORDER BY ${key} LIMIT ${PAGE}`, after)).toArray()
      all.push(...rows)
      if (rows.length < PAGE) return all
      after = rows[rows.length - 1][key]
    }
  }
  /** The serialized projection (chunked, or the original single row). Frozen: this version never writes it. */
  private legacyState(): ManagerProjection {
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
  /** Entries copied so far, or 'done'. */
  private progress(): number | 'done' {
    if (this.migrated) return 'done'
    const value = this.sql.exec<{value:string}>('SELECT value FROM relay_schema WHERE id = ?', ROWS_MARKER).toArray()[0]?.value
    if (value === 'done') { this.migrated = true; return 'done' }
    const copied = Number(value ?? 0)
    return Number.isSafeInteger(copied) && copied >= 0 ? copied : 0
  }
  /** Until every entry is copied, the serialized projection fills in entries that have no row yet. */
  private legacy(): ManagerProjection | null { return this.progress() === 'done' ? null : this.legacyState() }
  /**
   * Copies the next MIGRATION_SLICE entries, inside the caller's transaction. Rows already written by reports are
   * newer and are kept. The old chunks stay as they were, so a rolled-back relay still finds its last state.
   */
  private migrateSlice(legacy: ManagerProjection, from: number): void {
    const entries: [table: string, key: string, value: string][] = [
      ...Object.entries(legacy.observations ?? {}).map(([key, value]) => ['manager_observation_rows', key, JSON.stringify(value)] as [string,string,string]),
      ...Object.entries(legacy.incidents ?? {}).map(([id, value]) => ['manager_incident_rows', id, JSON.stringify(value)] as [string,string,string]),
      ...Object.entries(legacy.currentRevisions ?? {}).map(([chapter, revision]) => ['manager_revision_rows', chapter, revision] as [string,string,string]),
    ]
    const end = Math.min(entries.length, from + MIGRATION_SLICE)
    for (let i = from; i < end; i++) {
      const [table, key, value] = entries[i]
      this.sql.exec(`INSERT OR IGNORE INTO ${table} VALUES (?, ?)`, key, value)
    }
    const done = end >= entries.length
    this.sql.exec('INSERT INTO relay_schema (id,value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value', ROWS_MARKER, done ? 'done' : String(end))
    if (done) this.migratedInTransaction = true
  }
  /** A move completed inside [work] counts only once its transaction commits. */
  private transaction<T>(work: () => T): T {
    try {
      const result = this.storage.transactionSync(work)
      if (this.migratedInTransaction) this.migrated = true
      return result
    } finally { this.migratedInTransaction = false }
  }
  /** Loads only the observations, incidents and chapter revisions [report] can read or change. */
  private touched(report: ManagerReport, legacy: ManagerProjection | null): Touched {
    const touched: Touched = { state: { observations: {}, incidents: {}, currentRevisions: {} }, observations: new Map(), incidents: new Map(), revisions: new Map() }
    for (const fact of report.facts) {
      const key = observationKey(report, fact)
      const body = this.sql.exec<{body:string}>('SELECT body FROM manager_observation_rows WHERE key = ?', key).toArray()[0]?.body
        ?? (legacy?.observations?.[key] ? JSON.stringify(legacy.observations[key]) : undefined)
      if (body !== undefined) { touched.state.observations[key] = JSON.parse(body) as ManagerObservation; touched.observations.set(key, body) }
      const chapter = fact.scope.chapterId
      if (chapter && !touched.revisions.has(chapter)) {
        const revision = this.sql.exec<{revision:string}>('SELECT revision FROM manager_revision_rows WHERE chapter = ?', chapter).toArray()[0]?.revision
          ?? legacy?.currentRevisions?.[chapter]
        if (revision !== undefined) { touched.state.currentRevisions![chapter] = revision; touched.revisions.set(chapter, revision) }
      }
    }
    const ids = report.facts.flatMap(f => f.condition ? [incidentKey(f.condition.cause, f.condition.resource)] : [])
    if (report.acknowledgment) ids.push(report.acknowledgment.incidentId)
    for (const id of new Set(ids)) {
      const body = this.sql.exec<{body:string}>('SELECT body FROM manager_incident_rows WHERE id = ?', id).toArray()[0]?.body
        ?? (legacy?.incidents?.[id] ? JSON.stringify(legacy.incidents[id]) : undefined)
      if (body !== undefined) { touched.state.incidents[id] = JSON.parse(body) as ManagerIncident; touched.incidents.set(id, body) }
    }
    return touched
  }
  /** Writes back only the entries whose serialized form changed, including new history entries. */
  private save(touched: Touched): void {
    for (const [key, value] of Object.entries(touched.state.observations)) {
      const body = JSON.stringify(value)
      if (touched.observations.get(key) !== body) this.sql.exec('INSERT INTO manager_observation_rows (key, body) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body', key, body)
    }
    for (const [id, value] of Object.entries(touched.state.incidents)) {
      const body = JSON.stringify(value)
      if (touched.incidents.get(id) !== body) this.sql.exec('INSERT INTO manager_incident_rows (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body', id, body)
    }
    for (const [chapter, revision] of Object.entries(touched.state.currentRevisions ?? {})) {
      if (touched.revisions.get(chapter) !== revision) this.sql.exec('INSERT INTO manager_revision_rows (chapter, revision) VALUES (?, ?) ON CONFLICT(chapter) DO UPDATE SET revision = excluded.revision', chapter, revision)
    }
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
    return this.transaction(() => {
      const previous = this.sql.exec<{ payload: string; accepted: string }>('SELECT payload, accepted FROM manager_events WHERE id = ?', parsed.eventId).toArray()[0]
      if (previous) {
        if (previous.payload !== payload) throw new Error('Conflicting manager event ID')
        return { report: JSON.parse(previous.accepted) as ManagerReport, duplicate: true }
      }
      const sequence = this.sql.exec<{ event_id: string }>('SELECT event_id FROM manager_sequences WHERE source = ? AND sequence = ?',parsed.source.id,parsed.source.sequence).toArray()[0]
      if (sequence && sequence.event_id !== parsed.eventId) throw new Error('Conflicting manager source sequence')
      this.sql.exec('INSERT OR IGNORE INTO manager_sequences (source,sequence,event_id) VALUES (?, ?, ?)',parsed.source.id,parsed.source.sequence,parsed.eventId)
      const report: ManagerReport = { ...parsed, receivedAt: new Date().toISOString() }
      // Health-only reports change no observation or incident: they never touch the projection.
      let touched: Touched | null = null
      if (report.facts.length || report.acknowledgment) {
        const progress = this.progress()
        const legacy = progress === 'done' ? null : this.legacyState()
        if (legacy && progress !== 'done') this.migrateSlice(legacy, progress)
        touched = this.touched(report, legacy)
      }
      const state = touched?.state ?? null
      if (state) applyManagerReport(state, report)
      const affected = new Set(report.facts.flatMap(f => f.condition ? [incidentKey(f.condition.cause,f.condition.resource)] : []))
      if (report.acknowledgment) affected.add(report.acknowledgment.incidentId)
      for (const id of affected) if (state?.incidents[id]) state.incidents[id].authorityRevision = (state.incidents[id].authorityRevision ?? 0) + 1
      const accepted = JSON.stringify(report)
      this.sql.exec('INSERT INTO manager_events (id, payload, accepted, at) VALUES (?, ?, ?, ?)', report.eventId, payload, accepted, report.receivedAt!)
      if (touched) this.save(touched)
      // Replay current facts and one source-health watermark, not the unbounded historical event journal.
      for (const fact of report.facts) {
        const current = state!.observations[JSON.stringify([report.source.id, fact.key])]
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
