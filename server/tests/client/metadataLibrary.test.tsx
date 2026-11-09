import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Routes, Route } from 'react-router-dom'
import { StaticRouter } from 'react-router-dom/server'
import { MetadataLibrary, MetadataSeries, MetadataChapter } from '../../../client/src/pages/metadata/Metadata'

const mock = vi.hoisted(() => ({ data: {} as any }))
vi.mock('@/hooks/useMetadataLibrary', () => ({ useMetadataLibrary: () => mock.data }))
vi.mock('@/hooks/useSeriesOrder', () => ({ useSeriesOrder: (rows: any[]) => rows }))
const chapter = (number: number, done: number, total = 2) => ({ id: `c${number}`, number, name: `Chapter ${number}`, title: null,
  state: done === total ? 'complete' : done ? 'partial' : 'pending', done, total, ready: true,
  pages: Array.from({ length: total }, (_, i) => ({ filename: `page_${i + 1}.png`, state: i < done ? 'complete' : 'pending', hasMetadata: i < done })) })
const snapshot = () => ({ configured: true, syncing: false, sync: { checkedAt: null, imported: 0, errors: [] },
  series: [{ id: 's1', title: 'Series One', rootFolder: 'Series One', chapters: [chapter(1, 2), chapter(21, 1), chapter(40, 0), chapter(41, 0)] }] })
function render(path: string, route: string, element: React.ReactNode) {
  mock.data = { snapshot: snapshot(), error: null, fetching: false, sync: vi.fn() }
  return renderToStaticMarkup(<StaticRouter location={path}><Routes><Route path={route} element={element} /></Routes></StaticRouter>)
}

describe('Metadata navigation and part status', () => {
  it('lists a series in every downloaded part with completion counts scoped to that part', () => {
    const html = render('/metadata', '/metadata', <MetadataLibrary />)
    expect(html).toContain('href="/metadata/series/s1?part=1"')
    expect(html).toContain('href="/metadata/series/s1?part=2"')
    expect(html).toContain('href="/metadata/series/s1?part=3"')
    expect(html).toContain('0/2 chapters')
    expect(html).toContain('1/4 pages')
  })
  it('keeps Part 2 limited to Chapters 21–40 and links to chapter metadata', () => {
    const html = render('/metadata/series/s1?part=2', '/metadata/series/:id', <MetadataSeries />)
    expect(html).toContain('href="/metadata/chapter/c21"')
    expect(html).toContain('href="/metadata/chapter/c40"')
    expect(html).not.toContain('href="/metadata/chapter/c1"')
    expect(html).not.toContain('href="/metadata/chapter/c41"')
    expect(html).toContain('Partially generated')
    expect(html).toContain('Pending')
  })
  it('shows per-page generation marks and saved metadata inspection', () => {
    const html = render('/metadata/chapter/c21', '/metadata/chapter/:id', <MetadataChapter />)
    expect(html).toContain('Metadata prepared and validated')
    expect(html).toContain('Metadata not prepared yet')
    expect(html).toContain('View metadata')
    expect(html).toContain('href="/metadata/series/s1?part=2"')
  })
})
