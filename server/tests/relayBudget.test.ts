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
    const db=database(),now=()=>Date.parse('2026-10-19T01:00:00Z'),timers:(()=>void)[]=[]
    const first=new DailyRelayBudget(db.sql,now,undefined,work=>timers.push(work))
    first.begin();db.cost(25,4)
    expect([...first.sql.exec('SELECT test')]).toEqual([{value:1},{value:2}])
    first.alarmWrite();first.flush()
    expect(timers).toHaveLength(1);timers.shift()!()
    const restored=new DailyRelayBudget(db.sql,now)
    expect(restored.snapshot()).toMatchObject({operations:1,rowsRead:28,rowsWritten:6})
  })
  it('saves the usage row once per short burst, at once after twenty operations, and every time near a limit',()=>{
    const db=database(),now=()=>Date.parse('2026-10-19T01:00:00Z'),timers:(()=>void)[]=[]
    const budget=new DailyRelayBudget(db.sql,now,undefined,work=>timers.push(work))
    const saves=()=>db.queries.filter(q=>q.startsWith('INSERT INTO relay_daily_budget')).length
    for(let n=0;n<5;n++){budget.begin();budget.flush()}
    expect(saves()).toBe(0);expect(timers).toHaveLength(1)
    timers.shift()!();expect(saves()).toBe(1)
    timers.length=0
    for(let n=0;n<20;n++){budget.begin();budget.flush()}
    expect(saves()).toBe(2)
    // A pending timer after a save finds nothing unsaved and writes nothing.
    timers.forEach(work=>work());expect(saves()).toBe(2)
    budget.begin();db.cost(0,RELAY_DAILY_LIMITS.rowsWritten-15_000);budget.sql.exec('SELECT heavy');budget.flush()
    expect(saves()).toBe(3)
    budget.begin();budget.flush();expect(saves()).toBe(4)
  })
  it('counts rows under the operation and each manager event that used them',()=>{
    const db=database(),now=()=>Date.parse('2026-10-19T01:00:00Z'),timers:(()=>void)[]=[]
    const budget=new DailyRelayBudget(db.sql,now,undefined,work=>timers.push(work))
    budget.begin();budget.signal('http_manager')
    db.cost(3,1);budget.sql.exec('SELECT setup')
    db.cost(10,5);budget.sql.exec('SELECT fact');budget.signal('manager_fact')
    db.cost(2,1);budget.sql.exec('SELECT health');budget.signal('manager_health')
    db.cost(1,0);budget.sql.exec('SELECT after');budget.flush()
    budget.begin('alarm');db.cost(4,2);budget.sql.exec('SELECT alarm');budget.signal('alarm');budget.flush()
    budget.begin('ws_message');db.cost(1,1);budget.sql.exec('SELECT message');budget.flush()
    timers.shift()!()
    const rows=budget.snapshot().rows!
    expect(rows.manager_fact).toEqual({read:13,written:6})
    expect(rows.manager_health).toEqual({read:2,written:1})
    expect(rows.http_manager).toEqual({read:1,written:0})
    expect(rows.alarm).toEqual({read:4,written:2})
    expect(rows.ws_message).toEqual({read:1,written:1})
    const counted=Object.values(rows).reduce((sum,r)=>({read:sum.read+r!.read,written:sum.written+r!.written}),{read:0,written:0})
    expect(counted).toEqual({read:budget.snapshot().rowsRead,written:budget.snapshot().rowsWritten})
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
  it('matches the Workers Free daily allowances and cannot configure a higher operation ceiling',()=>{
    expect(RELAY_DAILY_LIMITS).toEqual({operations:100_000,rowsRead:5_000_000,rowsWritten:100_000})
    expect(new DailyRelayBudget(database().sql,()=>Date.now(),999999).snapshot().limits.operations).toBe(100000)
  })
})
