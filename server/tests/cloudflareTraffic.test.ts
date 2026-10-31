import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayReconnect } from '../src/services/relayReconnect.js'
import { deliverSnapshot } from '../src/services/snapshotDelivery.js'
import { ManagerStore } from '../src/services/managerStore.js'
import { managerBatch, managerAcknowledgment } from '../src/services/managerBatch.js'
import { sendManagerBatch } from '../src/services/managerReportDelivery.js'
import { RelayDeliveryPause } from '../src/services/relayDeliveryPause.js'
import { ManagerAuthority } from '../../relay/src/managerAuthority.js'
import type { ManagerReport } from '../src/services/managerProtocol.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite')
const at='2026-10-23T00:00:00Z'
const report=(sequence:number):ManagerReport=>({schema:'manager-report/1',eventId:`event-${sequence}`,source:{id:'fixture/studio',deviceId:'fixture',manager:'studio',sequence},observedAt:at,facts:[]})
afterEach(()=>vi.unstubAllGlobals())

describe('relay traffic reduction',()=>{
  it('does not reset failed upgrades using an old open time',()=>{
    let now=100_000
    const retry=new RelayReconnect(()=>now,()=>1)
    expect(Array.from({length:8},()=>{retry.begin();return retry.next()})).toEqual([2000,5000,15000,30000,60000,60000,60000,60000])
    retry.begin();retry.open();now+=1000;expect(retry.next()).toBe(60000)
    retry.begin();retry.open();now+=60_000;expect(retry.next()).toBe(2000)
    retry.begin();expect(retry.next()).toBe(5000)
    retry.blockAuthentication();expect(retry.next()).toBeNull()
    retry.reset();expect(retry.next()).toBe(2000)
  })
  it('does not reupload acknowledged R2 bytes after a relay failure or restart',async()=>{
    const saved=new Map<string,string>()
    const journal={load:async(key:string)=>saved.get(key)??null,save:async(key:string,value:string)=>{saved.set(key,value)}}
    const r2=vi.fn(async()=>{}),relay=vi.fn(async()=>{throw new Error('429')})
    const targets=[{id:'r2',send:r2},{id:'relay',send:relay}]
    await expect(deliverSnapshot(journal,'key','revision',{updatedAt:at,series:[]},targets)).rejects.toThrow('429')
    relay.mockImplementation(async()=>{})
    await deliverSnapshot(journal,'key','revision',{updatedAt:'later',series:[]},targets)
    await deliverSnapshot(journal,'key','revision',{updatedAt:'later again',series:[]},targets)
    expect(r2).toHaveBeenCalledTimes(1);expect(relay).toHaveBeenCalledTimes(2)
    expect(relay.mock.calls[1][0]).toBe(r2.mock.calls[0][0])
  })
  it('reconciles an ambiguous R2 write rather than blindly resending',async()=>{
    const saved=new Map<string,string>()
    const journal={load:async(key:string)=>saved.get(key)??null,save:async(key:string,value:string)=>{saved.set(key,value)}}
    const send=vi.fn(async()=>{throw new Error('lost reply')})
    const reconcile=vi.fn(async()=>true)
    await expect(deliverSnapshot(journal,'key','rev',{series:[]},[{id:'r2',send,reconcile}])).rejects.toThrow('lost reply')
    await deliverSnapshot(journal,'key','rev',{series:[]},[{id:'r2',send,reconcile}])
    expect(send).toHaveBeenCalledTimes(1);expect(reconcile).toHaveBeenCalledTimes(1)
  })
  it('combines a device backlog into bounded envelopes without changing events',async()=>{
    const store=new ManagerStore({load:async()=>null,save:async()=>{}})
    for(let n=0;n<32;n++)await store.observe('studio',[],new Date(Date.parse(at)+n*900_000).toISOString(),undefined,900_000)
    const original=(await store.snapshot()).outbox
    const envelopes:ManagerReport[][]=[]
    await store.drain(async()=>{throw new Error('single send forbidden')},async batch=>{
      envelopes.push(structuredClone(batch));return batch.map(r=>({status:'fulfilled',value:{...r,receivedAt:r.observedAt}}))
    })
    expect(envelopes.map(b=>b.length)).toEqual([16,16])
    expect(envelopes.flat()).toEqual(original)
    expect((await store.snapshot()).outbox).toEqual([])
    const changed={...report(1),observedAt:'2026-10-23T01:00:00Z',receivedAt:at}
    expect(()=>managerAcknowledgment(changed,report(1))).toThrow()
    expect(managerBatch(Array.from({length:30},(_,n)=>report(n)))).toHaveLength(16)
  })
  it('checks byte bounds and refuses a changed payload acknowledgment',()=>{
    const big={...report(1),eventId:'x'.repeat(255_000)}
    expect(Buffer.byteLength(JSON.stringify({schema:'manager-batch/1',reports:managerBatch([big,report(2),report(3)])}))).toBeLessThanOrEqual(256_000)
    expect(()=>managerAcknowledgment({...report(1),source:{...report(1).source,sequence:2},receivedAt:at},report(1))).toThrow()
  })
  it('honors batch 429 once, preserves exact queued events and validates partial acknowledgments',async()=>{
    let now=Date.parse(at),requests=0,paused:string|null=null
    const pause=new RelayDeliveryPause({load:async()=>paused,save:async v=>{paused=v}},()=>now)
    const originals=[report(1),report(2)]
    const http=createServer(async(req,res)=>{
      let body='';for await(const part of req)body+=part
      requests++
      expect(JSON.parse(body).reports).toEqual(originals)
      if(requests===1){res.writeHead(429,{'Retry-After':'600'}).end('{}');return}
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({schema:'manager-batch/1',results:[{eventId:originals[0].eventId,report:{...originals[0],receivedAt:at}},{eventId:originals[1].eventId,error:'not accepted'}]}))
    })
    await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve))
    try {
      const url=`http://127.0.0.1:${(http.address() as any).port}`
      expect((await sendManagerBatch(url,'test',originals,pause)).every(r=>r.status==='rejected')).toBe(true)
      await sendManagerBatch(url,'test',originals,pause);expect(requests).toBe(1)
      now+=600_000
      expect((await sendManagerBatch(url,'test',originals,pause)).map(r=>r.status)).toEqual(['fulfilled','rejected'])
    }finally{http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()))}
  })
  it('sends one idle device health cohort per interval without refreshing absent managers',async()=>{
    let now=Date.parse(at)
    const store=new ManagerStore({load:async()=>null,save:async()=>{}},undefined,()=>new Date(now).toISOString(),true)
    const envelopes:ManagerReport[][]=[]
    for(let seconds=0;seconds<3600;seconds+=30) {
      now=Date.parse(at)+seconds*1000
      for(const manager of ['studio','issues','storage'] as const)await store.observe(manager,[],new Date(now).toISOString())
      await store.drain(async()=>{throw new Error('Unbatched health')},async batch=>{envelopes.push(batch);return batch.map(r=>({status:'fulfilled',value:{...r,receivedAt:r.observedAt}}))})
    }
    expect(envelopes).toHaveLength(4)
    expect(envelopes.every(batch=>batch.length===3&&batch.every(r=>!r.facts.length))).toBe(true)
    expect(envelopes.flat().some(r=>r.source.manager==='clipping')).toBe(false)
    now+=1000
    const fact:any={key:'critical',stage:'capacity',scope:{seriesId:null,chapterId:null,profileId:null},workState:'failed',inputRevision:null,compatibility:'unknown',identity:'mapped',availability:[],override:false,done:null,total:null,condition:null}
    await store.observe('clipping',[fact],new Date(now).toISOString())
    expect((await store.snapshot()).outbox).toHaveLength(1)
    expect((await store.snapshot()).outbox[0].facts[0].workState).toBe('failed')
  })
  it('keeps health acceptance independent of projection size, including restart and replay',()=>{
    const db=new DatabaseSync(':memory:');const queries:string[]=[]
    try {
      db.exec('CREATE TABLE relay_schema (id TEXT PRIMARY KEY,value TEXT NOT NULL)')
      const sql={exec(q:string,...args:any[]){queries.push(q);const rows=db.prepare(q).all(...args);return {toArray:()=>rows}}} as any
      const storage={transactionSync(fn:()=>any){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value}catch(e){db.exec('ROLLBACK');throw e}}} as any
      let authority=new ManagerAuthority(sql,storage)
      db.prepare('INSERT INTO manager_projection VALUES (1,?)').run(JSON.stringify({observations:{},incidents:{},retained:'x'.repeat(5_000_000)}))
      queries.length=0
      const accepted=authority.accept(report(2),'fixture')
      expect(accepted.duplicate).toBe(false)
      expect(queries.some(q=>/manager_(projection|observation_rows|incident_rows|revision_rows)/.test(q))).toBe(false)
      expect(queries.length).toBeLessThan(12)
      authority=new ManagerAuthority(sql,storage)
      expect(authority.accept(report(2),'fixture')).toEqual({...accepted,duplicate:true})
      expect(()=>authority.accept({...report(2),eventId:'conflicting'},'fixture')).toThrow('sequence')
      authority.accept(report(1),'fixture')
      expect(authority.replay().map(r=>r.source.sequence)).toEqual([2])
      // The first full read migrates the legacy projection into rows.
      expect(authority.state()).toEqual({observations:{},incidents:{}})
    }finally{db.close()}
  })
})
