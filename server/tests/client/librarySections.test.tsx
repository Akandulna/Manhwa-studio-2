import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { completionGroup, EXPORTED, librarySections, sectionTitle } from '../../../client/src/lib/librarySections'
import { SeriesProcessTracker } from '../../../client/src/components/SeriesProcessTracker'
import { buildProcessSeries, emptyStages } from '../../src/services/seriesProcessModel'
import type { ProcessSnapshot, Series } from '../../../client/src/lib/api'

vi.mock('../../../client/src/hooks/useProductionJobs', () => ({ useProductionJobs: () => new Map() }))

const series = (id: string): Series => ({ id, title: id, sourceSite: 'test', rootFolder: id, createdAt: '2026-01-01' })
const tracker = (id: string, manualParts: number[] = []) => buildProcessSeries({ id, title: id, rootFolder: id }, [], manualParts)

describe('Studio Library completion accordions', () => {
  it('matches Sleepercell groups, including partial video exports and manual completion', () => {
    const stages = emptyStages()
    stages.export_en = { state: 'done' }
    const exported = buildProcessSeries({ id: 'exported', title: 'exported', rootFolder: 'exported' }, [{ id: 'chapter', name: 'Chapter 1', number: 1, stages }])
    expect(completionGroup()).toBe(0)
    expect(completionGroup(exported)).toBe(EXPORTED)
    expect(completionGroup(tracker('done', [1, 2]))).toBe(2)
    expect(sectionTitle(0)).toBe('No parts completed')
    expect(sectionTitle(1)).toBe('1 part completed')
    expect(sectionTitle(EXPORTED)).toBe('Videos exported')
  })

  it('puts processing groups first and retains activity ordering within each group', () => {
    const rows = [series('latest'), series('older'), series('running')]
    const trackers = new Map(rows.map(row => [row.id, tracker(row.id, row.id === 'running' ? [1] : [])]))
    const groups = librarySections(rows, trackers, new Set(['running']))
    expect(groups.map(group => group.completed)).toEqual([1, 0])
    expect(groups[0].processing).toBe(1)
    expect(groups[1].series.map(row => row.id)).toEqual(['latest', 'older'])
  })

  it('counts live stage work once per series', () => {
    const stages = emptyStages()
    stages.script_en = { state: 'active' }
    stages.script_hi = { state: 'active' }
    const active = buildProcessSeries({ id: 'live', title: 'live', rootFolder: 'live' }, [{ id: 'chapter', name: 'Chapter 1', number: 1, stages }])
    expect(librarySections([series('live')], new Map([['live', active]]), new Set(['live']))[0].processing).toBe(1)
  })

  it('opens the latest activity group and series, leaving other groups closed', () => {
    const rows = [series('latest-work'), series('other-group')]
    const progress: ProcessSnapshot = { schema: 'series-process/1', deviceId: 'studio', updatedAt: '2026-10-29', series: [tracker('latest-work', [1]), tracker('other-group')] }
    const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(SeriesProcessTracker, {
      series: rows, progress, phoneSync: null, onDelete: () => {}, onMarkPart: () => {}
    })))
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('class="group/series border-t first:border-t-0" open=""')
    expect(html).toContain('latest-work')
    expect(html).not.toContain('Actions for other-group')
  })

  it('handles an empty library while progress is loading', () => {
    expect(librarySections([], new Map(), new Set())).toEqual([])
    expect(librarySections([series('new')], new Map(), new Set())[0].completed).toBe(0)
  })
})
