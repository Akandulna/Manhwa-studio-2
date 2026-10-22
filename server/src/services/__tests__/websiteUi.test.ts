import { readFileSync } from 'node:fs'
import { describe,expect,it } from 'vitest'
import { parseManagerReport,applyManagerReport,emptyManagerProjection,incidentKey,type ManagerReport } from '../managerProtocol.js'
import { ManagerStore,type ManagerState } from '../managerStore.js'
const fixtures = JSON.parse(readFileSync(new URL('../../../../docs/manager-agents/website-ui/kotlin-reports.json',import.meta.url),'utf8')) as ManagerReport[]
const receivedAt='2026-10-19T00:02:00Z'
const accepted=(r:ManagerReport) => ({ ...structuredClone(r),receivedAt })
describe('Website UI reporting chain',() => {
  it('decodes actual Kotlin reports for all three websites and notifies on cosmetic changes',() => {
    expect(fixtures.map(r => r.facts[0].websiteUi?.provider).sort()).toEqual(['aistudio','chatgpt','gemini'])
    for(const r of fixtures) {
      expect(parseManagerReport(r)).not.toBeNull()
      const state=emptyManagerProjection();applyManagerReport(state,accepted(r))
      const incident=Object.values(state.incidents)[0]
      expect(incident).toMatchObject({ cause:'website_ui',severity:'info',state:'action_required',occurrences:1 })
      expect(Object.values(state.observations)[0].websiteUi?.route).toMatchObject({ monitorObservedAt:r.observedAt,clipperReceivedAt:r.observedAt,issuesReceivedAt:receivedAt })
    }
  })
  it('rejects a shortcut around the Device Image Clipper Manager and fabricated receipt/completion evidence',() => {
    const r=structuredClone(fixtures[0]);r.source.manager='website_ui';r.source.id='fixture-phone/website_ui'
    expect(parseManagerReport(r)).toBeNull()
    const noReceipt=structuredClone(fixtures[0]);noReceipt.facts[0].websiteUi!.route.clipperReceivedAt=null
    expect(parseManagerReport(noReceipt)).toBeNull()
    const fakeReceipt=structuredClone(fixtures[0]);fakeReceipt.facts[0].websiteUi!.route.issuesReceivedAt=receivedAt
    expect(parseManagerReport(fakeReceipt)).toBeNull()
    const unverified=structuredClone(fixtures[0]);unverified.facts[0].condition!.state='resolved'
    expect(parseManagerReport(unverified)).toBeNull()
  })
  it('rejects raw page text, private account fields and invalid control data',() => {
    for (const mutate of [
      (r:any) => r.facts[0].websiteUi.observed[0]=null,
      (r:any) => r.facts[0].websiteUi.rawHtml='private content',
      (r:any) => r.facts[0].websiteUi.variant.accountEmail='private@example.test',
      (r:any) => r.facts[0].websiteUi.observed[0].label='private conversation',
      (r:any) => r.facts[0].websiteUi.observed[0].location=[999,0,0,0],
      (r:any) => r.facts[0].websiteUi.observed.push(r.facts[0].websiteUi.observed[0])
    ]) {const r=structuredClone(fixtures[0]);mutate(r);expect(parseManagerReport(r)).toBeNull()}
  })
  it('groups identical changes across devices while preserving profile impacts and distinct variants',() => {
    const r=accepted(fixtures[0]),state=emptyManagerProjection();applyManagerReport(state,r)
    const second=structuredClone(r);second.eventId='other-phone';second.source={ ...r.source,id:'other/device_clipping',deviceId:'other',sequence:1 };second.facts[0].scope.profileId='other-profile'
    applyManagerReport(state,second)
    expect(Object.values(state.incidents)).toHaveLength(1)
    expect(Object.keys(Object.values(state.incidents)[0].impacts)).toHaveLength(2)
    const variant=structuredClone(second);variant.eventId='variant';variant.source.sequence=2;variant.facts[0].websiteUi!.changeId='a'.repeat(64);variant.facts[0].websiteUi!.variant.theme='dark';variant.facts[0].condition!.resource='ui-change/'+'a'.repeat(64)
    applyManagerReport(state,variant)
    expect(Object.values(state.incidents)).toHaveLength(2)
  })
  it('keeps monitor-only coverage non-actionable with no fabricated downstream receipt',() => {
    const r=accepted(fixtures[0]);r.source.manager='website_ui';r.source.id='fixture-phone/website_ui';r.facts[0].condition=null;r.facts[0].websiteUi!.route.clipperReceivedAt=null
    expect(parseManagerReport(r)).not.toBeNull()
    const state=emptyManagerProjection();applyManagerReport(state,r)
    expect(Object.keys(state.incidents)).toHaveLength(0)
    expect(Object.values(state.observations)[0].websiteUi?.route.issuesReceivedAt).toBeNull()
  })
  it('survives offline forwarding, restart and duplicate replay without duplicate notifications',async () => {
    let saved:ManagerState|null=null
    const persistence={load:async()=>saved && structuredClone(saved),save:async(s:ManagerState)=>{saved=structuredClone(s)}}
    const store=new ManagerStore(persistence)
    await store.observe('device_clipping',fixtures[0].facts,fixtures[0].observedAt,'fixture-phone')
    const original=(await store.snapshot()).outbox[0]
    await store.drain(async()=>{throw new Error('offline')})
    const restarted=new ManagerStore(persistence)
    await restarted.receive(accepted(original));await restarted.receive(accepted(original))
    await restarted.drain(async r => accepted(r))
    const result=await restarted.snapshot()
    expect(result.outbox).toHaveLength(0)
    expect(Object.values(result.projection.incidents)).toHaveLength(1)
    expect(Object.values(result.projection.incidents)[0].history.filter(h=>h.action==='detected')).toHaveLength(1)
    expect(Object.values(result.projection.observations)[0].websiteUi?.route.issuesReceivedAt).toBe(receivedAt)
  })
  it('acknowledgment never accepts the baseline or resolves a compatibility change',() => {
    const r=accepted(fixtures[0]),state=emptyManagerProjection();applyManagerReport(state,r)
    const id=incidentKey('website_ui',r.facts[0].condition!.resource),before=structuredClone(Object.values(state.observations)[0].websiteUi)
    applyManagerReport(state,{schema:'manager-report/1',eventId:'owner-ack',source:{id:'mac-owner/issues',deviceId:'mac-owner',manager:'issues',sequence:1},observedAt:receivedAt,receivedAt,facts:[],acknowledgment:{incidentId:id,notificationId:state.incidents[id].notificationId}})
    expect(state.incidents[id].acknowledgedAt).toBe(receivedAt);expect(state.incidents[id].state).toBe('action_required')
    expect(Object.values(state.observations)[0].websiteUi).toEqual(before)
  })
})
