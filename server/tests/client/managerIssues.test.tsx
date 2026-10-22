import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
const state = vi.hoisted(() => ({ data:null as any,error:null as string | null }))
vi.mock('@/hooks/useManagers',() => ({ useManagers:() => ({ ...state,reload:vi.fn() }) }))
vi.mock('react-router-dom',() => ({ Link:({ to,children,...rest }: any) => createElement('a',{ href:to,...rest },children) }))
import ManagerIssues from '../../../client/src/pages/sleeper/ManagerIssues'
import ManagerNotifications from '../../../client/src/components/ManagerNotifications'
const empty = () => ({ enabled:true,error:null,pendingReports:0,observations:[],incidents:[],managers:[{ id:'clipping',name:'Image Clipper',state:'not_reporting',observedAt:null }],chapters:[{ seriesId:'s',chapterId:'c',title:'Fixture',name:'Chapter 1' }] })
const render = () => renderToStaticMarkup(createElement(ManagerIssues))
describe('Production Issues reporting states',() => {
  it('shows unchecked website coverage independently from the absence of incidents',() => {
    state.error=null;state.data=empty()
    const html=render()
    for(const label of ['Website UI monitoring','ChatGPT','Gemini','Google AI Studio','Not checked']) expect(html).toContain(label)
  })
  it('shows redacted baseline comparisons, both handoffs and an informational change notification',() => {
    const report=JSON.parse(readFileSync(new URL('../../../docs/manager-agents/website-ui/kotlin-reports.json',import.meta.url),'utf8'))[0]
    const fact=report.facts[0]
    fact.websiteUi.route.issuesReceivedAt='2026-10-19T00:02:00Z'
    state.error=null;state.data=empty();state.data.observations=[{ ...fact,source:report.source,observedAt:report.observedAt,receivedAt:'2026-10-19T00:02:00Z' }]
    state.data.incidents=[{ id:'ui',cause:'website_ui',summary:'Cosmetic control appearance changed.',nextAction:'Review this page variant.',severity:'info',state:'action_required',occurrences:1,firstOccurredAt:report.observedAt,lastOccurredAt:report.observedAt,acknowledgedAt:null,notificationId:'ui-notification',impacts:{},history:[] }]
    const html=render()
    for(const text of ['informational','Website UI Monitor observed','Device Image Clipper Manager received','Issues Manager received','Expected','Observed','profile variant unknown','does not accept a baseline','View website UI evidence']) expect(html).toContain(text)
    expect(renderToStaticMarkup(createElement(ManagerNotifications))).toContain('1 production issue')
    expect(html).not.toContain('private conversation')
  })
  it('surfaces an unavailable Issues Manager globally instead of implying there are no issues', () => {
    state.data=empty();state.error='Reporting unavailable'
    expect(renderToStaticMarkup(createElement(ManagerNotifications))).toContain('Production reporting is unavailable or last known')
    state.error=null;state.data.managers=[{ id:'issues',name:'Issues',state:'last_known',observedAt:'2026-10-18T06:00:00Z' }]
    expect(renderToStaticMarkup(createElement(ManagerNotifications))).toContain('Open reporting status')
  })
  it('shows disabled reporting explicitly instead of implying all managers are healthy',() => {
    state.error=null;state.data={ ...empty(),enabled:false }
    expect(render()).toContain('Observation reporting is disabled')
    expect(render()).not.toContain('No matching incidents')
  })
  it('keeps failures visible when a refresh fails and labels the evidence last known',() => {
    state.data=empty();state.error='Manager reporting is unavailable. Previously loaded facts are last known.'
    expect(render()).toContain('role="alert"')
    expect(render()).toContain('Previously loaded facts are last known')
    expect(render()).toContain('not reporting')
  })
  it('keeps one incident with multiple impact links and acknowledgment separate from resolution',() => {
    state.error=null;state.data=empty()
    const source = { id:'p/clipping',deviceId:'p',manager:'device_clipping',sequence:1 }
    state.data.incidents=[{ id:'one-incident',summary:'Profile needs sign-in.',nextAction:'Sign in, then recheck.',severity:'warning',state:'action_required',occurrences:1,firstOccurredAt:'2026-10-18T06:00:00Z',lastOccurredAt:'2026-10-18T06:00:00Z',acknowledgedAt:'2026-10-18T06:01:00Z',notificationId:'notification-1',impacts:{ a:{ source,scope:{ seriesId:'s',chapterId:'c',profileId:'profile-1' } },b:{ source,scope:{ seriesId:'s',chapterId:'c',profileId:'profile-2' } } },history:[] }]
    const html=render()
    expect(html.match(/Profile needs sign-in\./g)).toHaveLength(1)
    expect(html).toContain('action required')
    expect(html).toContain('The condition retains its own status')
    expect(html).toContain('/sleeper-cells/accounts')
    expect(html).not.toContain('Acknowledge notification')
  })
  it('renders phone, cloud and Mac availability separately with unknown revision and original evidence time',() => {
    state.error=null;state.data=empty()
    state.data.observations=[{ key:'crop',stage:'crop_json',scope:{ seriesId:'s',chapterId:'c',profileId:null },source:{ id:'p/device_clipping',deviceId:'p',manager:'device_clipping' },workState:'verified_complete',compatibility:'unknown',identity:'unresolved',override:false,observedAt:'2026-10-18T06:00:00Z',receivedAt:'2026-10-20T06:00:00Z',availability:[{ destination:'phone:p',state:'produced_local' },{ destination:'cloud',state:'validated' },{ destination:'mac',state:'missing' }] }]
    const html=render()
    for(const text of ['phone:p','produced local','cloud','validated','mac','missing','unknown','Legacy identity unconfirmed','Last known']) expect(html).toContain(text)
  })
})
