import {createRequire} from 'node:module'
import {afterEach,describe,expect,it} from 'vitest'
import {ManagerAuthority} from '../../relay/src/managerAuthority.js'
import {applyManagerReport,emptyManagerProjection,incidentKey,type ManagerFact,type ManagerProjection,type ManagerReport} from '../src/services/managerProtocol.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite')
const opened:any[]=[]
afterEach(()=>{for(const db of opened.splice(0))db.close()})

function relay() {
  const db=new DatabaseSync(':memory:');opened.push(db);db.exec('CREATE TABLE relay_schema (id TEXT PRIMARY KEY,value TEXT NOT NULL)')
  const queries:string[]=[]
  let fail:RegExp|null=null
  const sql={exec(q:string,...args:any[]){queries.push(q);if(fail?.test(q))throw new Error('crash');const rows=db.prepare(q).all(...args);return {toArray:()=>rows}}} as any
  const storage={transactionSync(work:()=>any){db.exec('BEGIN');try{const r=work();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}} as any
  return {db,sql,storage,queries,failOn(pattern:RegExp|null){fail=pattern},count(table:string){return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as any).n as number}}
}
const fact=(key:string,extra:Partial<ManagerFact>={}):ManagerFact=>({key,stage:'capacity',scope:{seriesId:null,chapterId:null,profileId:null},workState:'running',inputRevision:null,compatibility:'unknown',identity:'mapped',availability:[],override:false,done:null,total:null,condition:null,...extra})
const report=(device:string,manager:ManagerReport['source']['manager'],sequence:number,facts:ManagerFact[],extra:Partial<ManagerReport>={}):ManagerReport=>({schema:'manager-report/1',eventId:`${device}-${manager}-${sequence}`,source:{id:`${device}/${manager}`,deviceId:device,manager,sequence},observedAt:new Date(Date.parse('2026-10-24T00:00:00Z')+sequence*1000).toISOString(),facts,...extra})
/** A large retained projection: many current observations, plus an incident and a declared chapter revision. */
function legacyProjection(size:number):ManagerProjection {
  const state=emptyManagerProjection()
  for(let n=0;n<size;n++)state.observations[JSON.stringify([`old/device_clipping`,`fact-${n}`])]={...fact(`fact-${n}`),source:{id:'old/device_clipping',deviceId:'old',manager:'device_clipping',sequence:n+1},eventId:`old-${n}`,observedAt:'2026-10-01T00:00:00.000Z',receivedAt:'2026-10-01T00:00:01.000Z'}
  state.incidents[incidentKey('quota','account/a')]={id:incidentKey('quota','account/a'),cause:'quota',resource:'account/a',severity:'warning',state:'action_required',summary:'Quota',nextAction:'Wait',firstOccurredAt:'2026-10-01T00:00:00.000Z',lastOccurredAt:'2026-10-01T00:00:00.000Z',resolvedAt:null,acknowledgedAt:null,notificationId:'old-0',occurrences:1,impacts:{},history:[]}
  state.currentRevisions={'chapter-1':'pages:a'}
  return state
}

describe('row-per-entry manager projection',()=>{
  it('migrates a chunked legacy projection in bounded, atomic slices, keeps the chunks for rollback, and restores after restart',()=>{
    const r=relay(),legacy=legacyProjection(2000),text=JSON.stringify(legacy)
    r.db.exec('CREATE TABLE manager_projection_parts (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
    const parts=text.match(/[\s\S]{1,128000}/g)!
    parts.forEach((body,id)=>r.db.prepare('INSERT INTO manager_projection_parts VALUES (?,?)').run(id,body))
    r.db.prepare("INSERT INTO relay_schema VALUES ('manager-projection-parts-v1',?)").run(String(parts.length))
    const authority=new ManagerAuthority(r.sql,r.storage),marker=()=>(r.db.prepare("SELECT value FROM relay_schema WHERE id='manager-rows-v1'").get() as any)?.value
    const first=report('phone','device_accounts',1,[fact('capacity')])
    r.failOn(/^INSERT OR IGNORE INTO manager_observation_rows/)
    expect(()=>authority.accept(first,'phone')).toThrow('crash')
    expect(r.count('manager_events')).toBe(0);expect(r.count('manager_observation_rows')).toBe(0);expect(marker()).toBeUndefined()
    r.failOn(null)
    expect(authority.accept(first,'phone').duplicate).toBe(false)
    // 2,002 entries: the first slice copies 2,000; the rest still read from the frozen chunks.
    expect(marker()).toBe('2000');expect(r.count('manager_observation_rows')).toBe(2001);expect(r.count('manager_incident_rows')).toBe(0)
    expect(authority.state().incidents).toEqual(legacy.incidents);expect(authority.state().currentRevisions).toEqual(legacy.currentRevisions)
    expect(authority.allIncidents()).toEqual(Object.values(legacy.incidents))
    authority.accept(report('phone','device_accounts',2,[fact('capacity',{done:2,total:5})]),'phone')
    expect(marker()).toBe('done');expect(r.count('manager_incident_rows')).toBe(1);expect(r.count('manager_revision_rows')).toBe(1)
    // Rollback safety: the serialized chunks are left exactly as they were.
    expect(r.db.prepare('SELECT body FROM manager_projection_parts ORDER BY id').all().map((row:any)=>row.body).join('')).toBe(text)
    const restored=new ManagerAuthority(r.sql,r.storage)
    r.queries.length=0
    const state=restored.state()
    expect(r.queries.some(q=>q.includes('manager_projection'))).toBe(false)
    expect(Object.keys(state.observations)).toHaveLength(2001)
    expect(state.incidents).toEqual(legacy.incidents);expect(state.currentRevisions).toEqual(legacy.currentRevisions)
    expect(restored.accept(first,'phone').duplicate).toBe(true)
  })
  it('keeps an entry a report changed before its slice was copied',()=>{
    const r=relay(),legacy=legacyProjection(4500)
    r.db.exec('CREATE TABLE manager_projection (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)')
    r.db.prepare('INSERT INTO manager_projection VALUES (1,?)').run(JSON.stringify(legacy))
    const authority=new ManagerAuthority(r.sql,r.storage)
    authority.accept(report('phone','device_accounts',1,[fact('capacity')]),'phone')
    // fact-4400 is beyond the first two slices: this report reads it from the chunks and writes its row.
    const writes=r.queries.length
    authority.accept(report('old','device_clipping',5000,[fact('fact-4400',{done:7,total:9})]),'old')
    expect(r.queries.slice(writes).filter(q=>/^INSERT OR IGNORE INTO manager_(observation|incident|revision)_rows/.test(q)).length).toBe(2000)
    authority.accept(report('phone','device_accounts',2,[fact('capacity',{done:1,total:2})]),'phone')
    const state=new ManagerAuthority(r.sql,r.storage).state()
    expect(state.observations[JSON.stringify(['old/device_clipping','fact-4400'])]).toMatchObject({done:7,total:9,eventId:'old-device_clipping-5000'})
    expect(Object.keys(state.observations)).toHaveLength(4501)
    expect(state.incidents).toEqual(legacy.incidents)
  })
  it('refuses an incomplete chunked projection rather than migrating partial state',()=>{
    const r=relay()
    r.db.exec('CREATE TABLE manager_projection_parts (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
    r.db.prepare('INSERT INTO manager_projection_parts VALUES (0,?)').run('{"observations":')
    r.db.prepare("INSERT INTO relay_schema VALUES ('manager-projection-parts-v1','2')").run()
    const authority=new ManagerAuthority(r.sql,r.storage)
    expect(()=>authority.state()).toThrow('Incomplete')
    expect(()=>authority.accept(report('phone','device_accounts',1,[fact('capacity')]),'phone')).toThrow('Incomplete')
    expect(r.count('manager_events')).toBe(0)
  })
  it('reads and writes only the entries a fact names, however large the projection is',()=>{
    const work=(size:number)=>{
      const r=relay()
      r.db.exec('CREATE TABLE manager_projection (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)')
      r.db.prepare('INSERT INTO manager_projection VALUES (1,?)').run(JSON.stringify(legacyProjection(size)))
      const authority=new ManagerAuthority(r.sql,r.storage)
      // The one-time move finishes within the first few fact reports (MIGRATION_SLICE entries each).
      for(let n=1;n<=3;n++)authority.accept(report('phone','device_clipping',n,[fact('a')]),'phone')
      r.queries.length=0
      authority.accept(report('phone','device_clipping',4,[fact('a',{done:3,total:9})]),'phone')
      expect(r.queries.some(q=>q.includes('manager_projection'))).toBe(false)
      expect(r.queries.some(q=>/FROM manager_(observation|incident|revision)_rows(?! WHERE)/.test(q))).toBe(false)
      return {statements:r.queries.length,writes:r.queries.filter(q=>/^(INSERT|UPDATE|DELETE)/.test(q)).length}
    }
    const small=work(10),large=work(3000)
    expect(large).toEqual(small)
    expect(small.writes).toBeLessThanOrEqual(6)
  })
  it('skips unchanged entries: an incident write happens only when the incident changed',()=>{
    const r=relay(),authority=new ManagerAuthority(r.sql,r.storage)
    const blocked=(sequence:number,key:string)=>report('phone','device_accounts',sequence,[fact(key,{workState:'waiting',condition:{cause:'quota',resource:'account/a',state:'waiting',severity:'warning',summary:'Quota',nextAction:'Wait'}})])
    authority.accept(blocked(1,'x'),'phone')
    r.queries.length=0
    authority.accept(report('phone','device_accounts',2,[fact('y')]),'phone')
    expect(r.queries.some(q=>q.includes('manager_incident_rows (id, body)'))).toBe(false)
    authority.accept(blocked(3,'z'),'phone')
    expect(Object.keys(authority.state().incidents[incidentKey('quota','account/a')].impacts)).toHaveLength(2)
  })
  it('ends in exactly the state the whole-projection authority produced, over a mixed report history',()=>{
    let seed=7
    const random=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648
    const pick=<T,>(items:readonly T[])=>items[Math.floor(random()*items.length)]
    const r=relay(),authority=new ManagerAuthority(r.sql,r.storage)
    const reference=emptyManagerProjection()
    const sequences=new Map<string,number>()
    const next=(source:string)=>{const n=(sequences.get(source)??0)+1;sequences.set(source,n);return n}
    const accepted:ManagerReport[]=[]
    for(let step=0;step<400;step++) {
      let sent:ManagerReport
      const roll=random()
      if(roll<0.12) {
        const chapter=pick(['c1','c2','c3'])
        sent=report('mac-1','library',next('mac-1/library'),[fact(`pages-${chapter}`,{stage:'download',scope:{seriesId:'s',chapterId:chapter,profileId:null},inputRevision:`pages:${pick(['a','b','c'])}`,compatibility:'current',declaresCurrentRevision:true,workState:'verified_complete'})])
      } else if(roll<0.2&&accepted.some(a=>a.facts.some(f=>f.condition))) {
        const incident=authority.allIncidents().find(i=>!i.acknowledgedAt)
        if(!incident)continue
        sent=report('mac-1','issues',next('mac-1/issues'),[],{acknowledgment:{incidentId:incident.id,notificationId:incident.notificationId}})
      } else {
        const device=pick(['p1','p2']),manager=pick(['device_clipping','device_editor'] as const)
        const facts=Array.from({length:1+Math.floor(random()*3)},(_,n)=>{
          const chapter=pick(['c1','c2','c3',null])
          const condition=random()<0.4?{cause:pick(['quota','login']),resource:`account/${pick(['a','b'])}`,state:pick(['action_required','waiting','resolved'] as const),severity:pick(['info','warning','blocking'] as const),summary:'S',nextAction:'N'}:null
          const resolved=condition?.state==='resolved'
          return fact(`k${n}-${pick(['x','y','z'])}`,{stage:'crop',scope:{seriesId:'s',chapterId:chapter,profileId:null},inputRevision:chapter?`pages:${pick(['a','b','c'])}`:null,compatibility:resolved?'current':pick(['current','unknown']),workState:resolved?'verified_complete':pick(['running','failed','waiting']),availability:resolved?[{destination:'r2',state:'validated',evidenceRef:null}]:[],condition,done:Math.floor(random()*10),total:10})
        }).filter((f,i,all)=>all.findIndex(o=>o.key===f.key)===i)
        sent=report(device,manager,next(`${device}/${manager}`),facts)
      }
      const result=authority.accept(sent,sent.source.deviceId)
      expect(result.duplicate).toBe(false)
      // The previous authority: apply to the whole projection, then bump affected incidents' revisions.
      applyManagerReport(reference,result.report)
      const affected=new Set(result.report.facts.flatMap(f=>f.condition?[incidentKey(f.condition.cause,f.condition.resource)]:[]))
      if(result.report.acknowledgment)affected.add(result.report.acknowledgment.incidentId)
      for(const id of affected)if(reference.incidents[id])reference.incidents[id].authorityRevision=(reference.incidents[id].authorityRevision??0)+1
      accepted.push(result.report)
    }
    expect(Object.keys(reference.incidents).length).toBeGreaterThan(0)
    expect(Object.keys(reference.observations).some(k=>JSON.parse(k).length===4)).toBe(true)
    expect(Object.values(reference.incidents).some(i=>i.acknowledgedAt)).toBe(true)
    const state=new ManagerAuthority(r.sql,r.storage).state()
    expect(state).toEqual({...reference,currentRevisions:reference.currentRevisions&&Object.keys(reference.currentRevisions).length?reference.currentRevisions:undefined})
  })
})
