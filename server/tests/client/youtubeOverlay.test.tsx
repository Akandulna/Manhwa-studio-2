import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import PromptActions from '../../../client/src/pages/youtube/PromptActions'
import { HindiOverlayPreview, DEFAULT_HINDI_STYLE, HINDI_TEMPLATES, overlayWidthPercent } from '../../../client/src/pages/youtube/HinglishThumbnail'
import { DEFAULT_HINDI_OVERLAY, hindiOverlayGeometry } from '../../src/services/youtubeHinglishThumbnail'
import type { YouTubeThumbnailVersion } from '../../src/services/youtubeTypes'
const image = { id: 'image', width: 1280, height: 720 } as YouTubeThumbnailVersion
const actions = (copied: boolean, pasted: boolean) => renderToStaticMarkup(createElement(PromptActions, { copied, pasted, disabled: false, onCopy: async () => {}, onPaste: () => {}, onFallback: () => {} }))
describe('YouTube overlay and popup controls', () => {
 it('shows two actual action buttons with independent completion ticks', () => {
  const initial = actions(false, false)
  expect(initial.match(/<button/g)).toHaveLength(2)
  expect(initial).toContain('grid-cols-2');expect(initial).not.toContain('aria-current');expect(initial).not.toContain('Prompt copied');expect(initial).not.toContain('Response pasted')
  expect(actions(true, false)).toContain('aria-label="Prompt copied"');expect(actions(true, false)).not.toContain('aria-label="Response pasted"')
  expect(actions(true, true)).toContain('aria-label="Response pasted"')
 })
 it('keeps the client and exporter defaults and template set aligned', () => {
  expect(DEFAULT_HINDI_STYLE).toEqual(DEFAULT_HINDI_OVERLAY)
  expect(HINDI_TEMPLATES.map(t => t.id)).toEqual(['outline', 'shadow', 'italic', 'badge'])
  const box = hindiOverlayGeometry(image.width, image.height, DEFAULT_HINDI_STYLE)
  expect(Math.abs(box.width / image.width * 100 - overlayWidthPercent(image, DEFAULT_HINDI_STYLE))).toBeLessThan(0.1)
 })
 it('previews the original image plus Latin HINDI stamp with padded bottom-right placement', () => {
  const html = renderToStaticMarkup(createElement(HindiOverlayPreview, { seriesId: 'series', image, settings: DEFAULT_HINDI_STYLE }))
  expect(html).toContain('aspect-ratio:1280/720');expect(html).toContain('left:96%');expect(html).toContain('top:96%');expect(html).toContain('HINDI — Extra Bold Latin lettering');expect(html).toContain('/thumbnail-overlay/stamp?');expect(html).toContain('/series/series/thumbnails/media/image')
 })
 it('enables accessible positioning only inside the editor and fits very wide images', () => {
  expect(overlayWidthPercent({ width: 8000, height: 100 }, DEFAULT_HINDI_STYLE)).toBeLessThan(4)
  const html = renderToStaticMarkup(createElement(HindiOverlayPreview, { seriesId: 'series', image, settings: DEFAULT_HINDI_STYLE, onChange: () => {} }))
  expect(html).toContain('aria-label="Move HINDI overlay"');expect(html).toContain('touch-action:none')
 })
})
