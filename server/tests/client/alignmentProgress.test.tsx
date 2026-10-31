import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AlignmentProgressStatus } from '../../../client/src/components/narration/AlignmentProgressStatus'

describe('alignment progress display', () => {
  it('labels queued work without inventing a percentage', () => {
    const html = renderToStaticMarkup(createElement(AlignmentProgressStatus, { sections: 1, progress: null }))
    expect(html).toContain('Queued')
    expect(html).not.toContain('progressbar')
    expect(html).not.toContain('%')
  })

  it('shows live percentage, phase and section with an accessible progress bar', () => {
    const html = renderToStaticMarkup(createElement(AlignmentProgressStatus, {
      sections: 3,
      progress: { sectionId: 's', sectionNumber: 2, percent: 43, phase: 'matching' }
    }))
    expect(html).toContain('43%')
    expect(html).toContain('aria-valuenow="43"')
    expect(html).toContain('Matching script · Section 2/3')
    expect(html).toContain('width:43%')
  })
})
