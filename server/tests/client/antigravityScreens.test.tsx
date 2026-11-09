import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import AntiGravityWorkflow, { WORKFLOW_NODES } from '../../../client/src/pages/antigravity/AntiGravityWorkflow'
import { metadataBlockReason } from '@/pages/antigravity/AntiGravityMetadata'
import { ANTIGRAVITY_MAX_SIDE, ineligibleReason, selectBlockReason } from '../../../client/src/pages/antigravity/AntiGravityClipper'
import { AntiGravityTopBar, attemptDuration, Breadcrumbs, formatDuration, partRange, pointerTotals } from '../../../client/src/pages/antigravity/shared'
import { orderRuns } from '../../../client/src/pages/antigravity/AntiGravityRuns'
import type { Clipper3Image } from '../../../client/src/lib/api'

const image = (overrides: Partial<Clipper3Image> = {}): Clipper3Image => ({
  filename: 'page_001.jpg', width: 800, height: 9000, hasPoints: false, hasMetadata: false, metadataValid: false,
  metadataErrors: [], cropCount: 0, status: 'pending', redo: null, managed: null, ...overrides
})

const renderAt = (path: string, pattern: string, element: JSX.Element) =>
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(Routes, null, createElement(Route, { path: pattern, element }))))

describe('AntiGravity workflow (AG-07)', () => {
  it('has the five modules with Image Clipper and Metadata active', () => {
    expect(Object.keys(WORKFLOW_NODES).sort()).toEqual(['clipper', 'editor', 'metadata', 'narration', 'voiceover'])
    expect(Object.entries(WORKFLOW_NODES).filter(([, n]) => n.active).map(([kind]) => kind).sort()).toEqual(['clipper', 'metadata'])
  })

  it('renders three disabled Coming Soon nodes and two links scoped to the series and part', () => {
    const html = renderAt('/antigravity/series/s1/parts/2', '/antigravity/series/:seriesId/parts/:partNumber', createElement(AntiGravityWorkflow))
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(3)
    expect(html.match(/>Coming Soon</g)).toHaveLength(3)
    expect(html).toContain('href="/antigravity/series/s1/parts/2/image-clipper"')
    expect(html).toContain('href="/antigravity/series/s1/parts/2/metadata"')
    expect(html).toContain('Chapters 21–40')
    // Disabled nodes are not links.
    expect(html).not.toMatch(/href="[^"]*(narration|voiceover|editor)"/)
  })
})

describe('AntiGravity Metadata eligibility', () => {
  const chapter = (ready: boolean) => ({ id: 'c1', number: 1, title: null, name: 'Chapter 001', state: 'partial' as const, done: 1, total: 3, ready, reason: ready ? undefined : 'Manual review is required before Metadata', pages: [] })
  const page = (state: 'pending' | 'complete' | 'invalid') => ({ filename: 'page_001.png', state, hasMetadata: state !== 'pending' })
  it('ticks pages without valid Metadata in ready chapters only', () => {
    expect(metadataBlockReason(chapter(true), page('pending'))).toBeNull()
    expect(metadataBlockReason(chapter(true), page('invalid'))).toBeNull()
    expect(metadataBlockReason(chapter(true), page('complete'))).toBe('Metadata saved')
    expect(metadataBlockReason(chapter(false), page('pending'))).toBe('Manual review is required before Metadata')
    expect(metadataBlockReason(chapter(true), page('pending'), { stage: 'describing' } as any)).toBe('Processing now')
    // A failed page can be ticked again.
    expect(metadataBlockReason(chapter(true), page('pending'), { stage: 'failed' } as any)).toBeNull()
  })
})

describe('AntiGravity navigation (AG-06)', () => {
  it('maps part numbers to the existing 20-chapter ranges', () => {
    expect(partRange(1)).toEqual({ first: 1, last: 20 })
    expect(partRange(3)).toEqual({ first: 41, last: 60 })
  })

  it('marks the current breadcrumb and links the rest', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Breadcrumbs, { items: [{ label: 'AntiGravity', to: '/antigravity' }, { label: 'Part 1' }] })))
    expect(html).toContain('href="/antigravity"')
    expect(html).toContain('aria-current="page">Part 1')
  })
})

describe('AntiGravity page eligibility (AG-08, AG-19)', () => {
  it('selects only pending, unmanaged pages that fit the 2000 px transport limit', () => {
    expect(ineligibleReason(image())).toBeNull()
    expect(ineligibleReason(image({ status: 'pending', redo: { status: 'pending' } as Clipper3Image['redo'] }))).toBeNull()
    expect(ineligibleReason(image({ status: 'done', hasPoints: true }))).toMatch(/already saved/)
    expect(ineligibleReason(image({ managed: { pageId: 'p', taskId: 't' } }))).toMatch(/Managed/)
    expect(ineligibleReason(image({ width: ANTIGRAVITY_MAX_SIDE + 1 }))).toMatch(/Wider than 2000/)
    expect(ineligibleReason(image({ width: ANTIGRAVITY_MAX_SIDE }))).toBeNull()
  })

  it('lets a failed page be ticked (Start process skips it) but never a done, managed, too wide or running page', () => {
    const job = (stage: string) => ({ stage }) as never
    expect(ineligibleReason(image(), job('failed'))).toMatch(/until you Retry/)
    expect(selectBlockReason(image(), job('failed'))).toBeNull()
    expect(selectBlockReason(image(), job('needs_attention'))).toBeNull()
    expect(selectBlockReason(image(), job('analyzing'))).toMatch(/Processing now/)
    expect(selectBlockReason(image({ status: 'done', hasPoints: true }))).toMatch(/already saved/)
    expect(selectBlockReason(image({ managed: { pageId: 'p', taskId: 't' } }))).toMatch(/Managed/)
    expect(selectBlockReason(image({ width: ANTIGRAVITY_MAX_SIDE + 1 }))).toMatch(/Wider than 2000/)
  })

  it("counts pointer totals from Clipper's own chapter summaries", () => {
    const chapters = [{ id: 'a', pageCount: 10 }, { id: 'b', pageCount: 5 }] as never
    const summaries = new Map([['a', { attachedImages: 4, totalImages: 12 }]]) as never
    expect(pointerTotals(chapters, summaries)).toEqual({ done: 4, total: 17 })
  })
})

describe('AntiGravity top bar', () => {
  it('shows Library | Running processes and a Settings shortcut to the Studio Settings tab', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/antigravity/series/s1'] }, createElement(AntiGravityTopBar, { tab: 'runs', crumbs: [{ label: 'AntiGravity', to: '/antigravity' }, { label: 'Running processes' }] })))
    expect(html).toContain('href="/antigravity"')
    expect(html).toContain('href="/antigravity/runs"')
    expect(html).toMatch(/aria-current="page"[^>]*>.*Running processes/)
    expect(html).toContain('href="/settings?tab=antigravity"')
  })
})

describe('AntiGravity AI time', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 12, 0, s)).toISOString()
  it('times an attempt from analysis start to its end, and a running one against now', () => {
    expect(attemptDuration({ startedAt: at(0), finishedAt: at(42), status: 'completed' }, 0)).toEqual({ ms: 42_000, running: false })
    expect(attemptDuration({ startedAt: at(0), finishedAt: null, status: 'active' }, Date.parse(at(5)))).toEqual({ ms: 5_000, running: true })
    // An attempt left without an end (e.g. lost) has no time to show.
    expect(attemptDuration({ startedAt: at(0), finishedAt: null, status: 'failed' }, Date.parse(at(5)))).toBeNull()
    expect(attemptDuration(null, 0)).toBeNull()
  })
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(4_200)).toBe('4.2 s')
    expect(formatDuration(42_000)).toBe('42 s')
    expect(formatDuration(67_000)).toBe('1 m 07 s')
    expect(formatDuration(3_720_000)).toBe('1 h 02 m')
  })
})

describe('AntiGravity Running processes', () => {
  it('lists active runs before finished ones, keeping newest-first inside each group', () => {
    const run = (id: string, control: string) => ({ id, control, seriesId: 's', partNumber: 1, model: 'm', createdAt: '', finishedAt: null })
    const ordered = orderRuns([run('a', 'completed'), run('b', 'running'), run('c', 'stopped'), run('d', 'paused'), run('e', 'interrupted')])
    expect(ordered.map(r => r.id)).toEqual(['b', 'd', 'e', 'a', 'c'])
  })
})
