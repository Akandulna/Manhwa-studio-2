import { describe,it,expect } from 'vitest'
import { DailyRelayBudget, RelayBudgetExceeded, RELAY_DAILY_LIMITS } from '../../relay/src/dailyBudget.js'
function database() {
  let stored: string | undefined
  let next = { read: 0, written: 0 }
  const queries: string[] = []
  return {
    queries,
    cost(read: number,written: number) { next = { read,written } },
    sql: { exec(query: string,...bindings: unknown[]) {
      queries.push(query)
      let rows: Record<string,unknown>[] = [], read = 0, written = 0
      if (query.startsWith('SELECT body FROM relay_daily_budget')) { rows = stored ? [{ body:stored }] : []; read = rows.length }
      else if (query.startsWith('INSERT INTO relay_daily_budget')) { stored = String(bindings[0]); read = 1; written = 1 }
      else if (!query.startsWith('CREATE TABLE')) { read = next.read; written = next.written; rows=[{ value:1 },{ value:2 }]; next = {read:0,written:0} }
      return { toArray:()=>rows,columnNames:['value'],rowsRead:read,rowsWritten:written }
    }} as unknown as ConstructorParameters<typeof DailyRelayBudget>[0],
  }
}
describe('durable relay safety budget',()=>{
  it('counts fully consumed SQL metrics, bookkeeping and alarm writes across restart',()=>{
    const db=database(),now=()=>Date.parse('2026-10-19T01:00:00Z')
    const first=new DailyRelayBudget(db.sql,now)
    first.begin();db.cost(25,4)
    expect([...first.sql.exec('SELECT test')]).toEqual([{value:1},{value:2}])
    first.alarmWrite();first.flush()
    const restored=new DailyRelayBudget(db.sql,now)
    expect(restored.snapshot()).toMatchObject({operations:1,rowsRead:28,rowsWritten:6})
  })
  it('pauses before an admitted operation cap and keeps the cap across restart',()=>{
    const db=database(),now=()=>Date.parse('2026-10-19T01:00:00Z')
    let budget=new DailyRelayBudget(db.sql,now,2)
    budget.begin();budget.flush();budget.begin();budget.flush()
    budget=new DailyRelayBudget(db.sql,now,2)
    expect(()=>budget.begin()).toThrow(RelayBudgetExceeded)
    expect(budget.response().status).toBe(429)
    expect(budget.response().headers.get('Retry-After')).toBe('82800')
  })
  it('resets on UTC date change, not process restart or local midnight',()=>{
    const db=database();let time=Date.parse('2026-10-19T23:59:59Z')
    const budget=new DailyRelayBudget(db.sql,()=>time,1)
    budget.begin();budget.flush();expect(()=>budget.begin()).toThrow()
    time+=1000;budget.begin();budget.flush()
    expect(budget.snapshot()).toMatchObject({day:'2026-10-20',operations:1})
  })
  it.each(['read','written'] as const)('stops SQL before consuming the %s reserve',dimension=>{
    const db=database(),budget=new DailyRelayBudget(db.sql)
    budget.begin()
    // Simulate many bounded queries: the next query is refused before it reaches the database.
    for(let i=0;i<1000;i++) {
      db.cost(dimension==='read'?9000:0,dimension==='written'?1000:0)
      try { budget.sql.exec('SELECT measured') } catch (e) { expect(e).toBeInstanceOf(RelayBudgetExceeded);break }
    }
    const count=db.queries.length
    expect(()=>budget.sql.exec('SELECT must_not_execute')).toThrow(RelayBudgetExceeded)
    expect(db.queries.length).toBe(count)
    const usage=budget.snapshot()
    expect(usage.rowsRead).toBeLessThan(RELAY_DAILY_LIMITS.rowsRead)
    expect(usage.rowsWritten).toBeLessThan(RELAY_DAILY_LIMITS.rowsWritten)
  })
  it('cannot configure a higher daily operation ceiling',()=>{
    expect(new DailyRelayBudget(database().sql,()=>Date.now(),999999).snapshot().limits.operations).toBe(20000)
  })
})
