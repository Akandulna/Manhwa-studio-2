import { afterEach, describe, expect, it, vi } from 'vitest'
import { r2Api } from '../../../client/src/lib/api'
import { renderToStaticMarkup } from 'react-dom/server'
import { NarrationPartChoices } from '../../../client/src/pages/sleeper/RunAutomation'
import { narrationRunScope } from '../../src/services/narrationRunScope'
const chapters = Array.from({ length: 40 }, (_, i) => ({ name: `Chapter ${i + 1}`, number: i + 1, complete: false }))
describe('Studio Narration scripts part picker', () => {
  it('shows Part 1, Part 2 and explicit All chapters, with Part 2 selected and its exact range', () => {
    const scope = narrationRunScope(chapters, undefined, 2)
    const html = renderToStaticMarkup(<NarrationPartChoices scope={scope} onChange={() => {}} />)
    expect(html).toMatch(/aria-checked="true"[^>]*>Part 2/)
    expect(html).toMatch(/aria-checked="false"[^>]*>Part 1/)
    expect(html).toContain('All chapters')
    expect(html).toContain('Chapters 21–40 only · 20 chapters.')
  })
})

afterEach(() => vi.unstubAllGlobals())
describe('Narration part API transport', () => {
  it('requests the selected readiness part and sends its explicit chapter scope to one device', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => ({ ok: true, status: 200, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetch)
    await r2Api.getRunReadiness('narration', 'sss', 'en', 2)
    expect(fetch.mock.calls[0][0]).toBe('/api/r2/phone/readiness?kind=narration&seriesId=sss&language=en&part=2')
    const scope = narrationRunScope(chapters, undefined, 2)
    await r2Api.sendPhoneAutomation('start', { kind: 'narration', seriesId: 'sss', device: 'nord', chapters: scope.chapters })
    const body = JSON.parse((fetch.mock.calls[1][1] as RequestInit).body as string)
    expect(body).toEqual({ command: 'start', kind: 'narration', seriesId: 'sss', device: 'nord', chapters: chapters.slice(20, 40).map(c => c.name) })
  })
})
