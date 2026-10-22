/** Relay-local UTC-day protection. Cloudflare account-wide ingress is a separate meter. */
export const RELAY_DAILY_LIMITS = { operations: 20_000, rowsRead: 3_000_000, rowsWritten: 60_000 } as const
const QUERY_HEADROOM = 10_000
export class RelayBudgetExceeded extends Error {
  constructor() { super('Relay daily safety budget reached; queued work must wait until the next UTC day.') }
}
type Usage = { day: string; operations: number; rowsRead: number; rowsWritten: number }
export class DailyRelayBudget {
  private usage: Usage
  readonly sql: SqlStorage
  constructor(private raw: SqlStorage, private now = () => Date.now(), private operationLimit: number = RELAY_DAILY_LIMITS.operations) {
    this.operationLimit = Math.max(1, Math.min(RELAY_DAILY_LIMITS.operations, Math.floor(operationLimit) || RELAY_DAILY_LIMITS.operations))
    raw.exec('CREATE TABLE IF NOT EXISTS relay_daily_budget (id INTEGER PRIMARY KEY CHECK(id = 1), body TEXT NOT NULL)')
    const cursor = raw.exec<{ body: string }>('SELECT body FROM relay_daily_budget WHERE id = 1')
    const row = cursor.toArray()[0]
    this.usage = row ? JSON.parse(row.body) : this.empty()
    this.rollover()
    this.usage.rowsRead += cursor.rowsRead
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
  private rollover(): void { if (this.usage.day !== this.empty().day) this.usage = this.empty() }
  begin(): void {
    this.rollover()
    if (this.usage.operations >= this.operationLimit || this.usage.rowsRead + QUERY_HEADROOM > RELAY_DAILY_LIMITS.rowsRead || this.usage.rowsWritten + QUERY_HEADROOM > RELAY_DAILY_LIMITS.rowsWritten) throw new RelayBudgetExceeded()
    this.usage.operations++
  }
  /** Once per event, outside report transactions: rolled-back SQL also consumed platform resources. */
  flush(): void {
    this.rollover()
    this.usage.rowsRead += 2 // Conservatively include the bookkeeping point lookup/upsert.
    this.usage.rowsWritten++ // Integer primary key: one row, no secondary index.
    this.raw.exec('INSERT INTO relay_daily_budget (id,body) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', JSON.stringify(this.usage))
  }
  alarmWrite(): void { this.usage.rowsWritten++ }
  snapshot() { this.rollover(); return { ...this.usage, limits: { ...RELAY_DAILY_LIMITS, operations: this.operationLimit }, scope: 'This relay only; excludes other Workers and traffic rejected before admission.' } }
  retryAfter(): string { return String(Math.max(1, Math.ceil((Date.parse(this.empty().day) + 86_400_000 - this.now()) / 1000))) }
  response(): Response { return Response.json({ error: new RelayBudgetExceeded().message, usage: this.snapshot() }, { status: 429, headers: { 'Retry-After': this.retryAfter() } }) }
}
