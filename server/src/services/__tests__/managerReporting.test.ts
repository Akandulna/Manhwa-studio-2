import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { encodeManagerState, decodeManagerState } from '../managerStoreCodec.js'
import { ManagerStore, type ManagerState } from '../managerStore.js'
import { managerFact, managerTransferFact } from '../managerReporting.js'
import { applyManagerReport, currentManagerObservations, emptyManagerProjection, incidentKey, parseManagerReport, type ManagerFact, type ManagerReport } from '../managerProtocol.js'
const at = '2026-10-18T06:00:00Z'
function fact(failed = false): ManagerFact {
  return { ...managerFact('chapter/crop_json', 'crop_json', { seriesId:'series',chapterId:'chapter',profileId:null }), workState:failed ? 'failed' : 'verified_complete', compatibility:'current', inputRevision:'pages:revision-1', availability:[{ destination:'phone:one',state:'validated',evidenceRef:'page-validator' }], condition:{ cause:'shared-quota',resource:'confirmed-account/provider/model',state:failed ? 'action_required' : 'resolved',severity:'warning',summary:'Capacity unavailable',nextAction:'Recheck the affected capacity.' } }
}
function report(sequence: number, facts: ManagerFact[], device = 'phone-1'): ManagerReport {
  return { schema:'manager-report/1',eventId:`${device}/${sequence}`,source:{ id:`${device}/device_clipping`,deviceId:device,manager:'device_clipping',sequence },observedAt:at,receivedAt:'2026-10-18T06:01:00Z',facts }
}
function persistent() {
  let saved: ManagerState | null = null
  const persistence = { load:async () => saved && structuredClone(saved),save:async (state: ManagerState) => { saved = structuredClone(state) } }
  return { persistence,store:new ManagerStore(persistence,undefined,() => at) }
}
describe('manager evidence and incidents', () => {
  it('decodes the real Kotlin producer fixture without changing its timestamp or provenance', () => {
    const generated = JSON.parse(readFileSync(new URL('../../../../docs/manager-agents/protocol/phase1-android-report.json',import.meta.url),'utf8'))
    const decoded = parseManagerReport(generated)
    expect(decoded).not.toBeNull()
    expect(decoded?.observedAt).toBe(at)
    expect(decoded?.facts[0].availability).toEqual([{ destination:'phone:fixture-phone',state:'produced_local',evidenceRef:'process:fixture-phone:chapter-fixture:crop_json' }])
  })
  it('rejects unsupported, unscoped and unsafe records', () => {
    expect(parseManagerReport(report(1,[fact()]))).not.toBeNull()
    expect(parseManagerReport({ ...report(1,[]),schema:'manager-report/2' })).toBeNull()
    expect(parseManagerReport({ ...report(1,[]),source:{ ...report(1,[]).source,sequence:2 ** 53 } })).toBeNull()
    expect(parseManagerReport(report(1,[{ ...fact(),scope:{ chapterId:'c' } as any }]))).toBeNull()
    expect(parseManagerReport(report(1,[fact(),fact()]))).toBeNull()
    expect(parseManagerReport(report(1,[{ ...fact(),password:'secret' } as any]))).toBeNull()
  })
  it('keeps source ordering and timestamps across duplicate, reordered and cross-device updates', () => {
    const state = emptyManagerProjection()
    applyManagerReport(state,report(2,[fact()]))
    expect(applyManagerReport(state,report(1,[fact(true)]))).toBe(false)
    expect(applyManagerReport(state,{ ...report(2,[fact()]),receivedAt:'2026-10-20T00:00:00Z' })).toBe(false)
    applyManagerReport(state,report(1,[fact(true)],'phone-2'))
    expect(currentManagerObservations(state)).toHaveLength(2)
    expect(currentManagerObservations(state)[0]).toMatchObject({ workState:'verified_complete',observedAt:at,receivedAt:'2026-10-18T06:01:00Z' })
  })
  it('retains old revision history without allowing delayed updates to satisfy current work', () => {
    const state = emptyManagerProjection()
    applyManagerReport(state,report(1,[{ ...fact(),inputRevision:'pages:old' }]))
    applyManagerReport(state,report(2,[fact()]))
    applyManagerReport(state,report(1,[{ ...fact(),inputRevision:'pages:old' }]))
    expect(currentManagerObservations(state)[0].inputRevision).toBe('pages:revision-1')
    expect(Object.values(state.observations).some(o => o.inputRevision === 'pages:old')).toBe(true)
  })
  it('groups impacts, keeps acknowledgment distinct, resolves all impacts and reopens recurrence', () => {
    const state = emptyManagerProjection()
    applyManagerReport(state,report(1,[fact(true)])); applyManagerReport(state,report(1,[fact(true)],'phone-2'))
    const id = incidentKey('shared-quota','confirmed-account/provider/model')
    expect(Object.keys(state.incidents)).toEqual([id]); expect(Object.keys(state.incidents[id].impacts)).toHaveLength(2)
    applyManagerReport(state,{ ...report(2,[],'mac'),acknowledgment:{ incidentId:id,notificationId:state.incidents[id].notificationId } })
    expect(state.incidents[id].acknowledgedAt).not.toBeNull(); expect(state.incidents[id].state).toBe('action_required')
    applyManagerReport(state,report(2,[fact()])); expect(state.incidents[id].state).toBe('action_required')
    applyManagerReport(state,report(2,[{ ...fact(),compatibility:'outdated' }],'phone-2')); expect(state.incidents[id].state).toBe('action_required')
    applyManagerReport(state,report(3,[fact()],'phone-2')); expect(state.incidents[id].state).toBe('resolved')
    applyManagerReport(state,report(4,[fact(true)],'phone-2')); expect(state.incidents[id]).toMatchObject({ state:'action_required',occurrences:2,acknowledgedAt:null })
    expect(state.incidents[id].history.filter(h => h.action === 'reopened')).toHaveLength(1)
  })
  it('marks old page output outdated against the authoritative Mac revision and prevents stale resolution', () => {
    const state = emptyManagerProjection()
    applyManagerReport(state,report(1,[fact(true)]))
    const declaration = report(1,[{ ...fact(),key:'chapter/download',stage:'download',declaresCurrentRevision:true,inputRevision:'pages:revision-2',condition:null }],'mac-authority')
    declaration.source.manager='library';declaration.source.id='mac-authority/library'
    applyManagerReport(state,declaration)
    applyManagerReport(state,report(2,[fact()]))
    expect(currentManagerObservations(state).find(o => o.source.deviceId==='phone-1')?.compatibility).toBe('outdated')
    expect(Object.values(state.incidents)[0].state).toBe('action_required')
  })
  it('does not downgrade a blocking owner action when another impact is only waiting', () => {
    const state = emptyManagerProjection()
    const blocked=fact(true);blocked.condition!.severity='blocking'
    const waiting=fact(true);waiting.condition!.state='waiting';waiting.condition!.severity='info'
    applyManagerReport(state,report(1,[blocked]))
    applyManagerReport(state,report(1,[waiting],'phone-2'))
    expect(Object.values(state.incidents)[0]).toMatchObject({ state:'action_required',severity:'blocking' })
    applyManagerReport(state,report(2,[fact()]))
    expect(Object.values(state.incidents)[0]).toMatchObject({ state:'waiting',severity:'info' })
  })
  it('traces phone output, verified cloud bytes, failed import and local validation independently', () => {
    const state = emptyManagerProjection()
    const phone = JSON.parse(readFileSync(new URL('../../../../docs/manager-agents/protocol/phase1-android-report.json',import.meta.url),'utf8')) as ManagerReport
    applyManagerReport(state,{ ...phone,receivedAt:'2026-10-18T06:01:00Z' })
    const transfer = { seriesId:'series-fixture',chapterId:'chapter-fixture',stage:'crop_json' as const,objectVersion:'verified-object-version' }
    const cloud = report(1,[managerTransferFact({ ...transfer,phase:'failed' })],'mac-transfer')
    cloud.source.manager='cloud';cloud.source.id='mac-transfer/cloud'
    applyManagerReport(state,cloud)
    const local = managerFact('chapter-fixture/crop_json','crop_json',{ seriesId:'series-fixture',chapterId:'chapter-fixture',profileId:null })
    local.workState='queued';local.availability=[{ destination:'mac',state:'missing',evidenceRef:null }]
    const mac = report(1,[local],'mac-validator');mac.source.manager='clipping';mac.source.id='mac-validator/clipping'
    applyManagerReport(state,mac)
    expect(currentManagerObservations(state).find(o => o.source.deviceId==='fixture-phone')?.workState).toBe('verified_complete')
    expect(currentManagerObservations(state).find(o => o.source.manager==='cloud')?.availability).toEqual(expect.arrayContaining([
      expect.objectContaining({ destination:'cloud',state:'validated' }),expect.objectContaining({ destination:'mac_import',state:'missing' })
    ]))
    applyManagerReport(state,{ ...cloud,eventId:'transfer-imported',source:{ ...cloud.source,sequence:2 },facts:[managerTransferFact({ ...transfer,phase:'imported' })] })
    expect(Object.values(state.incidents)[0].state).toBe('resolved')
    expect(currentManagerObservations(state).find(o => o.source.manager==='clipping')?.workState).toBe('queued')
    expect(currentManagerObservations(state).find(o => o.source.deviceId==='fixture-phone')?.observedAt).toBe(phone.observedAt)
  })
  it('does not fabricate incidents from manual/archive marks or unconfirmed legacy identities', () => {
    const state = emptyManagerProjection()
    applyManagerReport(state,report(1,[{ ...fact(true),override:true }])); applyManagerReport(state,report(2,[{ ...fact(true),identity:'unresolved' }]))
    expect(Object.keys(state.incidents)).toHaveLength(0)
  })
})
describe('durable local manager journal', () => {
  it('retains a failed source and its later events while accepting an independent source', async () => {
    const { store,persistence } = persistent()
    await store.observe('clipping',[fact()],at)
    await store.observe('clipping',[fact(true)],at)
    await store.observe('editor',[fact()],at)
    const original = (await store.snapshot()).outbox.filter(r => r.source.manager === 'clipping')
    await store.drain(async report => {
      if (report.source.manager === 'clipping') throw new Error('Temporary source delivery failure')
      return { ...report,receivedAt:at }
    })
    expect((await store.snapshot()).outbox).toEqual(original)
    expect((await store.snapshot()).lastDeliveryError).not.toBeNull()
    const restarted = new ManagerStore(persistence)
    const retried: number[] = []
    await restarted.drain(async report => { retried.push(report.source.sequence); return { ...report,receivedAt:at } })
    expect(retried).toEqual([1,2])
    expect((await restarted.snapshot()).outbox).toHaveLength(0)
  })
  it('round trips compressed journals and reads existing uncompressed state', async () => {
    const { store } = persistent()
    await store.observe('clipping',[fact(true)],at)
    const state = await store.snapshot(), encoded = await encodeManagerState(state)
    expect(await decodeManagerState(encoded)).toEqual(state)
    expect(await decodeManagerState(JSON.stringify(state))).toEqual(state)
    expect(encoded.length).toBeLessThan(JSON.stringify(state).length)
    await expect(decodeManagerState('{"encoding":"other","version":1,"body":""}')).rejects.toThrow('Unsupported')
    await expect(decodeManagerState('{"encoding":"gzip","version":1,"body":"broken"}')).rejects.toThrow()
  })
  it('delivers independent sources concurrently while preserving each source order', async () => {
    const { store } = persistent()
    await store.observe('clipping',[fact()],at)
    await store.observe('clipping',[fact(true)],at)
    await store.observe('editor',[fact()],at)
    const sent: string[] = []
    await store.drain(async report => {
      sent.push(`${report.source.manager}/${report.source.sequence}`)
      if (report.source.manager === 'clipping' && report.source.sequence === 1) {
        await new Promise(resolve => setTimeout(resolve,10))
        expect(sent).toContain('editor/1')
        expect(sent).not.toContain('clipping/2')
      }
      return { ...report,receivedAt:at }
    })
    expect(sent).toEqual(['clipping/1','editor/1','clipping/2'])
    expect((await store.snapshot()).outbox).toHaveLength(0)
  })
  it('commits a reconnect replay together and rolls back a conflicting batch', async () => {
    let saves = 0
    const store = new ManagerStore({ load:async () => null,save:async () => { saves++ } })
    const reports = Array.from({ length:100 },(_,i) => report(i+1,[{ ...fact(),key:`chapter-${i}/crop_json` }]))
    expect(await store.receiveMany(reports)).toEqual(Array(100).fill('accepted'))
    expect(saves).toBe(1)
    expect(await store.receiveMany(reports)).toEqual(Array(100).fill('duplicate'))
    expect(saves).toBe(1)
    await expect(store.receiveMany([report(101,[fact()]),report(101,[fact(true)])])).rejects.toThrow('Conflicting')
    expect(Object.keys((await store.snapshot()).seen)).toHaveLength(100)
  })
  it('serves committed evidence while a later durable write is blocked', async () => {
    let release!: () => void
    let writing = false
    const store = new ManagerStore({ load:async () => null, save:async () => {
      if (writing) await new Promise<void>(resolve => { release = resolve })
    } })
    await store.observe('clipping',[fact()],at)
    writing = true
    const pending = store.observe('clipping',[fact(true)],'2026-10-18T06:01:00Z')
    while (!release) await new Promise(resolve => setTimeout(resolve,0))
    const committed = await store.snapshot(false)
    expect(currentManagerObservations(committed.projection)[0].workState).toBe('verified_complete')
    release(); await pending
    expect(currentManagerObservations((await store.snapshot()).projection)[0].workState).toBe('failed')
  })
  it('avoids rewriting the full journal for unchanged library observations', async () => {
    let saves = 0
    const store = new ManagerStore({ load:async () => null,save:async () => { saves++ } })
    await store.observe('clipping',[fact()],at)
    await Promise.all(Array.from({ length:100 },() => store.observe('clipping',[fact()],at)))
    expect(saves).toBe(1)
    expect((await store.snapshot()).outbox).toHaveLength(1)
  })
  it('survives failed delivery, restart and lost acknowledgment without repeating incidents or freshening facts', async () => {
    const { store,persistence } = persistent()
    await store.observe('clipping',[fact(true)],at)
    const original = (await store.snapshot()).outbox[0]
    await store.drain(async () => { throw new Error('network lost') })
    const restarted = new ManagerStore(persistence,undefined,() => at)
    expect((await restarted.snapshot()).outbox).toEqual([original])
    const accepted = { ...original,receivedAt:'2026-10-18T06:01:00Z' }
    await restarted.receive(accepted)
    await restarted.drain(async sent => { expect(sent).toEqual(original); return accepted })
    const result = await restarted.snapshot()
    expect(result.outbox).toHaveLength(0)
    expect(currentManagerObservations(result.projection)[0].observedAt).toBe(at)
    expect(Object.values(result.projection.incidents)).toHaveLength(1)
    expect(Object.values(result.projection.incidents)[0].history.filter(h => h.action === 'detected')).toHaveLength(1)
  })
  it('serializes concurrent producers and separates health from unchanged fact freshness', async () => {
    const { store } = persistent()
    await Promise.all([store.observe('clipping',[fact()],at),store.observe('clipping',[{ ...fact(),key:'chapter-2/crop_json' }],at)])
    expect((await store.snapshot()).outbox.map(r => r.source.sequence)).toEqual([1,2])
    await store.observe('clipping',[fact()],'2026-10-18T06:02:00Z')
    expect((await store.snapshot()).outbox).toHaveLength(2)
    await store.observe('clipping',[fact()],'2026-10-18T06:05:00Z')
    const result = await store.snapshot()
    expect(currentManagerObservations(result.projection)[0].observedAt).toBe(at)
    expect(result.outbox.at(-1)?.facts).toHaveLength(0)
  })
  it('rejects conflicting IDs and stale legacy snapshots after restart', async () => {
    const { store,persistence } = persistent()
    await store.receive(report(1,[fact()])); await expect(store.receive(report(1,[fact(true)]))).rejects.toThrow('Conflicting')
    await store.observe('device_clipping',[fact()],'2026-10-18T07:00:00Z','legacy-phone')
    const restarted = new ManagerStore(persistence,undefined,() => at)
    await restarted.observe('device_clipping',[fact(true)],at,'legacy-phone')
    expect(currentManagerObservations((await restarted.snapshot()).projection).find(o => o.source.deviceId === 'legacy-phone')?.workState).toBe('verified_complete')
  })
  it('rejects reordered authority snapshots even when source occurrence times are equal', async () => {
    const { store } = persistent()
    await store.receive(report(1,[fact(true)]))
    const incident = Object.values((await store.snapshot()).projection.incidents)[0]
    await store.receiveIncident({ ...incident, authorityRevision:2, acknowledgedAt:at })
    await store.receiveIncident({ ...incident, authorityRevision:1, acknowledgedAt:null })
    expect(Object.values((await store.snapshot()).projection.incidents)[0].acknowledgedAt).toBe(at)
  })
  it('rolls back in-memory changes when durable storage fails', async () => {
    const store = new ManagerStore({ load:async () => null,save:async () => { throw new Error('disk full') } })
    await expect(store.observe('clipping',[fact()],at)).rejects.toThrow('disk full')
    expect((await store.snapshot()).outbox).toHaveLength(0)
  })
})
