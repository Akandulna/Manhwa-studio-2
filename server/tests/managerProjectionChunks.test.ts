import {createRequire} from 'node:module'
import {afterEach,expect,it} from 'vitest'
import {ManagerAuthority} from '../../relay/src/managerAuthority.js'
import {emptyManagerProjection} from '../src/services/managerProtocol.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite')
const opened:any[]=[]
afterEach(()=>{for(const db of opened.splice(0))db.close()})
it('migrates a large legacy projection atomically into bounded rows and restores it after restart',()=>{
 const db=new DatabaseSync(':memory:');opened.push(db);db.exec('CREATE TABLE relay_schema (id TEXT PRIMARY KEY,value TEXT NOT NULL)')
 let fail=false
 const sql={exec(q:string,...args:any[]){if(fail&&q.startsWith('INSERT INTO manager_projection_parts'))throw new Error('crash');const rows=db.prepare(q).all(...args);return {toArray:()=>rows}}} as any
 const storage={transactionSync(work:()=>any){db.exec('BEGIN');try{const r=work();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}} as any
 const authority=new ManagerAuthority(sql,storage),state=emptyManagerProjection()
 // Large retained extension simulates pre-existing projection growth without weakening row limits.
 ;(state as any).retained='🧪'.repeat(600000)
 db.prepare('INSERT INTO manager_projection VALUES (1,?)').run(JSON.stringify(state))
 const report={schema:'manager-report/1',eventId:'chunk-report',source:{id:'phone/device_accounts',deviceId:'phone',manager:'device_accounts',sequence:1},observedAt:new Date().toISOString(),facts:[]}
 fail=true;expect(()=>authority.accept(report,'phone')).toThrow('crash');expect(db.prepare('SELECT * FROM manager_events').all()).toHaveLength(0)
 expect((authority.state() as any).retained).toBe((state as any).retained)
 fail=false;expect(authority.accept(report,'phone').duplicate).toBe(false)
 const rows=db.prepare('SELECT length(CAST(body AS BLOB)) AS bytes FROM manager_projection_parts').all()
 expect(rows.length).toBeGreaterThan(1);expect(rows.every((r:any)=>r.bytes<=512000)).toBe(true)
 expect(db.prepare('SELECT * FROM manager_projection').all()).toHaveLength(0)
 const restored=new ManagerAuthority(sql,storage)
 expect((restored.state() as any).retained).toBe((state as any).retained)
 expect(restored.accept(report,'phone').duplicate).toBe(true)
 db.prepare('DELETE FROM manager_projection_parts WHERE id=1').run();expect(()=>restored.state()).toThrow('Incomplete')
})
