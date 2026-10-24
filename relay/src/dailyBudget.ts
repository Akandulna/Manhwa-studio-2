/**
 * Relay-local UTC-day protection, set to the Workers Free daily allowances (100,000 requests, 5 million SQL rows
 * read, 100,000 rows written). Cloudflare account-wide ingress is a separate meter: QUERY_HEADROOM keeps the relay
 * pausing itself, with a Retry-After, before Cloudflare would start failing its operations outright.
 */
export const RELAY_DAILY_LIMITS = { operations: 100_000, rowsRead: 5_000_000, rowsWritten: 100_000 } as const
const QUERY_HEADROOM = 10_000
/** The usage row is saved this long after the last unsaved operation; a pending timer also keeps the object from hibernating first. */
const CHECKPOINT_DELAY_MS = 2_000
/** ...or at once, after this many unsaved operations. */
const CHECKPOINT_OPERATIONS = 20
export class RelayBudgetExceeded extends Error {
  constructor() { super('Relay daily safety budget reached; queued work must wait until the next UTC day.') }
}
export type RelaySignal = 'http_manager'|'http_receipt'|'http_ws'|'http_managed'|'http_other'|'manager_health'|'manager_fact'|'manager_ui'|'manager_ack'|'manager_duplicate'|'alarm'
/** What an operation's SQL rows are counted under: its signal, or how it arrived when it has none. */
export type RelayRowKind = RelaySignal|'ws_message'|'ws_close'|'checkpoint'|'other'
type Rows = Partial<Record<RelayRowKind, { read: number; written: number }>>
type Usage = { day: string; operations: number; rowsRead: number; rowsWritten: number; signals?: Record<string,number>; rows?: Rows }
type Schedule = (work: () => void, ms: number) => unknown
export class DailyRelayBudget {
  private usage: Usage
  /** Rows counted since [mark] belong to [kind] until the next attribution point. */
  private kind: RelayRowKind = 'other'
  private mark = { read: 0, written: 0 }
  private unsaved = 0
  private timer: unknown = null
  readonly sql: SqlStorage
  constructor(private raw: SqlStorage, private now = () => Date.now(), private operationLimit: number = RELAY_DAILY_LIMITS.operations, private schedule: Schedule = (work, ms) => setTimeout(work, ms)) {
    this.operationLimit = Math.max(1, Math.min(RELAY_DAILY_LIMITS.operations, Math.floor(operationLimit) || RELAY_DAILY_LIMITS.operations))
    raw.exec('CREATE TABLE IF NOT EXISTS relay_daily_budget (id INTEGER PRIMARY KEY CHECK(id = 1), body TEXT NOT NULL)')
    const cursor = raw.exec<{ body: string }>('SELECT body FROM relay_daily_budget WHERE id = 1')
    const row = cursor.toArray()[0]
    this.usage = row ? JSON.parse(row.body) : this.empty()
    this.rollover()
    this.mark = { read: this.usage.rowsRead, written: this.usage.rowsWritten }
    this.usage.rowsRead += cursor.rowsRead
    this.attribute('checkpoint')
    // All relay callers use toArray()/iteration. Consume eagerly so row metrics include the entire query.
    this.sql = new Proxy(raw, { get: (target, key) => key === 'exec' ? (query: string, ...bindings: unknown[]) => {
      this.rollover()
      if (this.usage.rowsRead + QUERY_HEADROOM > RELAY_DAILY_LIMITS.rowsRead || this.usage.rowsWritten + QUERY_HEADROOM > RELAY_DAILY_LIMITS.rowsWritten) throw new RelayBudgetExceeded()
      const result = target.exec(query, ...bindings)
      const rows = result.toArray()
      this.usage.rowsRead += result.rowsRead
      this.usage.rowsWritten += result.rowsWritten
      let index = 0
      return {
        columnNames: result.columnNames, rowsRead: result.rowsRead, rowsWritten: result.rowsWritten,
        toArray: () => rows.slice(index).map(row => { index++; return row }),
        next: () => index < rows.length ? { done: false, value: rows[index++] } : { done: true, value: undefined },
        [Symbol.iterator]() { return this },
      }
    } : Reflect.get(target, key, target) })
  }
  private empty(): Usage { return { day: new Date(this.now()).toISOString().slice(0,10), operations: 0, rowsRead: 0, rowsWritten: 0 } }
  private rollover(): void { if (this.usage.day !== this.empty().day) { this.usage = this.empty(); this.mark = { read: 0, written: 0 } } }
  /** Rows since the last attribution point go to [kind]. */
  private attribute(kind: RelayRowKind): void {
    const read = this.usage.rowsRead - this.mark.read, written = this.usage.rowsWritten - this.mark.written
    if (read > 0 || written > 0) {
      const counted = (this.usage.rows ??= {})[kind] ??= { read: 0, written: 0 }
      counted.read += Math.max(0, read); counted.written += Math.max(0, written)
    }
    this.mark = { read: this.usage.rowsRead, written: this.usage.rowsWritten }
  }
  /** [kind] names the operation until a signal says more precisely what it is. */
  begin(kind: RelayRowKind = 'other'): void {
    this.rollover()
    if (this.usage.operations >= this.operationLimit || this.usage.rowsRead + QUERY_HEADROOM > RELAY_DAILY_LIMITS.rowsRead || this.usage.rowsWritten + QUERY_HEADROOM > RELAY_DAILY_LIMITS.rowsWritten) throw new RelayBudgetExceeded()
    this.attribute(this.kind)
    this.kind = kind
    this.usage.operations++
  }
  /**
   * Counts [kind]. A route or alarm signal names the rest of the operation; a manager signal, sent once that event
   * is accepted, takes the rows since the previous signal, so each event in a batch is counted separately.
   */
  signal(kind: RelaySignal): void {
    this.rollover()
    const signals=this.usage.signals??={}
    signals[kind]=(signals[kind]??0)+1
    if (kind.startsWith('manager_')) this.attribute(kind)
    else { this.attribute(this.kind); this.kind = kind }
  }
  /**
   * Once per operation, outside report transactions: rolled-back SQL also consumed platform resources. The usage
   * row is saved shortly after, at once after CHECKPOINT_OPERATIONS operations, and every time near a limit.
   */
  flush(): void {
    this.rollover()
    this.attribute(this.kind)
    this.kind = 'other'
    this.unsaved++
    if (this.unsaved >= CHECKPOINT_OPERATIONS || this.nearLimit()) { this.checkpoint(); return }
    if (this.timer === null) this.timer = this.schedule(() => {
      this.timer = null
      // A failed save stays unsaved; the next operation tries again.
      try { if (this.unsaved > 0) this.checkpoint() } catch {}
    }, CHECKPOINT_DELAY_MS)
  }
  /** Saves the usage row now. */
  checkpoint(): void {
    this.rollover()
    this.usage.rowsRead += 2 // Conservatively include the bookkeeping point lookup/upsert.
    this.usage.rowsWritten++ // Integer primary key: one row, no secondary index.
    this.attribute('checkpoint')
    this.raw.exec('INSERT INTO relay_daily_budget (id,body) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', JSON.stringify(this.usage))
    this.unsaved = 0
  }
  private nearLimit(): boolean {
    return this.usage.operations + CHECKPOINT_OPERATIONS >= this.operationLimit ||
      this.usage.rowsRead + 2 * QUERY_HEADROOM > RELAY_DAILY_LIMITS.rowsRead ||
      this.usage.rowsWritten + 2 * QUERY_HEADROOM > RELAY_DAILY_LIMITS.rowsWritten
  }
  alarmWrite(): void { this.usage.rowsWritten++ }
  snapshot() { this.rollover(); return { ...this.usage, limits: { ...RELAY_DAILY_LIMITS, operations: this.operationLimit }, scope: 'This relay only; excludes other Workers and traffic rejected before admission.' } }
  retryAfter(): string { return String(Math.max(1, Math.ceil((Date.parse(this.empty().day) + 86_400_000 - this.now()) / 1000))) }
  response(): Response { return Response.json({ error: new RelayBudgetExceeded().message, reason:'daily_budget', usage: this.snapshot() }, { status: 429, headers: { 'Retry-After': this.retryAfter(), 'X-Relay-Rejection':'daily_budget' } }) }
}
