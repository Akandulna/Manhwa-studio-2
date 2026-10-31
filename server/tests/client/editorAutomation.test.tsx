import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AUTOMATIONS, EditorSettings } from '../../../client/src/pages/sleeper/RunAutomation'

const render = (ai: 'chatgpt' | 'aistudio', smallBatches: boolean, disabled?: string) => renderToStaticMarkup(createElement(EditorSettings, { ai, smallBatches, disabled, onAiChange: () => {}, onSmallBatchesChange: () => {} }))
describe('Phone Status Editor automation settings', () => {
  it('offers AI Studio and both matching methods without Gemini Apps', () => {
    const html = render('aistudio', true)
    expect(AUTOMATIONS.find(a => a.kind === 'editor')?.ai).toBe('ChatGPT or AI Studio')
    expect(html).toMatch(/aria-checked="true"[^>]*>AI Studio/)
    for (const label of ['ChatGPT', 'AI Studio', 'Small batches', 'Full package']) expect(html).toContain(label)
    expect(html).not.toContain('Gemini')
    expect(html).not.toContain('disabled=""')
  })
  it('retains the selected full package method and explains old-phone compatibility', () => {
    expect(render('chatgpt', false)).toMatch(/aria-checked="true"[^>]*>Full package/)
    const html = render('chatgpt', true, 'Update Sleeper-Cell and refresh Phone Status')
    expect(html.match(/disabled=""/g)).toHaveLength(4)
    expect(html).toContain('Update Sleeper-Cell and refresh Phone Status')
  })
})
