import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import YouTubeTitles from '../../../client/src/pages/youtube/YouTubeTitles'
import YouTubeDescription from '../../../client/src/pages/youtube/YouTubeDescription'
import type { YouTubeWorkspace } from '../../src/services/youtubeTypes'
const workspace = (): YouTubeWorkspace => ({ schemaVersion: 1, seriesId: 'test', language: 'en', createdAt: '2026-10-31', updatedAt: '2026-10-31', guidelineVersions: { title: 't', description: 'd', thumbnail: 'i' }, selectedTitle: 'A Hunter & His Secret', description: 'A hunter discovers an unusual advantage.', hinglishDescription: 'Explore a hidden talent that changes his journey in Hindi.', selectedThumbnail: null, titles: { revision: 1, suggestions: [], selections: [], requests: [] }, thumbnails: { references: [], requests: [], versions: [] }, descriptions: { requests: [], versions: [], selectedVersionId: null } })
describe('Hinglish inside existing YouTube tabs', () => {
 it('renders the exact derived title with a separate copy control and retains More for other suggestions', () => {
  const html = renderToStaticMarkup(createElement(YouTubeTitles, { workspace: workspace(), onSaved: () => {} }))
  expect(html).toContain('aria-label="Hinglish title"'); expect(html).toContain('A Hunter &amp; His Secret - Hindi'); expect(html).toContain('Copy Hinglish title'); expect(html).toContain('Copy title'); expect(html).toContain('>More<')
 })
 it('does not silently truncate an existing long title when adding the Hindi suffix', () => {
  const w = workspace();w.selectedTitle = 'A'.repeat(100)
  const html = renderToStaticMarkup(createElement(YouTubeTitles, { workspace: w, onSaved: () => {} }))
  expect(html).toContain(w.selectedTitle + ' - Hindi'); expect(html).toContain('Shorten the English title to 92 characters')
 })
 it('renders English and Hinglish descriptions together in two desktop columns with independent copy controls', () => {
  const w = workspace();const html = renderToStaticMarkup(createElement(YouTubeDescription, { workspace: w, onSaved: () => {}, onTitles: () => {} }))
  expect(html).toContain('md:grid-cols-2');expect(html).toContain('aria-label="English description"');expect(html).toContain('aria-label="Hinglish description"');expect(html).toContain(w.description);expect(html).toContain(w.hinglishDescription);expect(html).toContain('Copy English description');expect(html).toContain('Copy Hinglish description')
 })
 it('preserves earlier English text and shows a separate empty Hinglish card until it is generated', () => {
  const w = workspace();delete w.hinglishDescription
  const html = renderToStaticMarkup(createElement(YouTubeDescription, { workspace: w, onSaved: () => {}, onTitles: () => {} }))
  expect(html).toContain(w.description);expect(html).toContain('Not created');expect(html).toContain('Generate both descriptions');expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Copy Hinglish description/)
 })
})
