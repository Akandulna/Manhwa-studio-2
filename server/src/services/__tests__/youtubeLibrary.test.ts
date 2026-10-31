import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { YouTubeStore } from '../youtubeStore.js'
import { createYouTubeRouter } from '../../routes/youtube.js'
let root: string, store: YouTubeStore, server: Server | undefined
const workspaceFile = (id: string) => path.join(root, 'workspaces', `${createHash('sha256').update(id).digest('hex')}.json`)
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-library-'));store = new YouTubeStore(root) })
afterEach(async () => { if (server) { server.closeAllConnections();await new Promise<void>(resolve => server!.close(() => resolve()));server = undefined } await fs.rm(root, { recursive: true, force: true }) })
async function saveFixture(id: string, change: Record<string, unknown>) { const w = await store.openWorkspace(id);await fs.writeFile(workspaceFile(id), JSON.stringify({ ...w, ...change }));return w }
describe('YouTube library status and manual completion', () => {
 it('reads missing workspace status without creating workspaces or guideline defaults', async () => {
  expect(await store.libraryStatuses(['new'])).toEqual({ new: { seriesId: 'new', revision: 0, english: 'not_started', hinglish: 'not_started', closedAt: null } })
  expect(await fs.readdir(root)).toEqual([])
 })
 it('reports English ready only after all three materials exist and none need updating', async () => {
  await saveFixture('a', { selectedTitle: 'A Hunter Returns', description: 'The hunter returns with a secret.', selectedThumbnail: 'saved-image', descriptionNeedsUpdate: false, thumbnailNeedsUpdate: false })
  expect((await store.libraryStatuses(['a'])).a.english).toBe('done')
  for (const key of ['selectedTitle', 'description', 'selectedThumbnail']) {
   await saveFixture('a', { selectedTitle: 'A Hunter Returns', description: 'Description', selectedThumbnail: 'saved-image', [key]: null })
   expect((await store.libraryStatuses(['a'])).a.english).toBe('in_progress')
  }
  await saveFixture('a', { selectedTitle: 'A New Hook', description: 'Description', selectedThumbnail: 'saved-image', descriptionNeedsUpdate: true })
  expect((await store.libraryStatuses(['a'])).a.english).toBe('needs_update')
  await saveFixture('a', { descriptionNeedsUpdate: false, thumbnailNeedsUpdate: true })
  expect((await store.libraryStatuses(['a'])).a.english).toBe('needs_update')
  expect((await store.libraryStatuses(['a'])).a.hinglish).toBe('title_ready')
 })
 it('reports Hindi title/description progress while keeping thumbnails deferred', async () => {
  await saveFixture('a',{selectedTitle:'A Hero Returns',hinglishDescription:'Discover this new story in Hindi.'})
  expect((await store.libraryStatuses(['a'])).a.hinglish).toBe('thumbnail_pending')
  await saveFixture('a',{hinglishDescriptionNeedsUpdate:true})
  expect((await store.libraryStatuses(['a'])).a.hinglish).toBe('needs_update')
 })
 it('retains legacy saved data when reading statuses and recognizes started generation requests', async () => {
  const w = await store.prepareTitles('a', 'Test Hunter', (await store.openWorkspace('a')).titles.revision)
  const filename = workspaceFile('a');const legacy = { ...w };delete (legacy as any).thumbnails;delete (legacy as any).descriptions;await fs.writeFile(filename, JSON.stringify(legacy));const before = await fs.readFile(filename)
  expect((await store.libraryStatuses(['a'])).a.english).toBe('in_progress');expect(await fs.readFile(filename)).toEqual(before)
 })
 it('persists manual completion independently of English readiness and reopens without losing material', async () => {
  let w = await store.openWorkspace('a');w = await store.selectTitle('a', { title: 'A Hunter Returns', expectedRevision: w.titles.revision })
  const before = structuredClone(w)
  const closed = await store.setSeriesDone('a', { done: true, expectedRevision: w.titles.revision })
  expect(closed.closedAt).toBeTruthy();expect(closed.english).toBe('in_progress');expect(closed.revision).toBe(before.titles.revision + 1)
  expect((await new YouTubeStore(root).libraryStatuses(['a'])).a).toEqual(closed)
  const saved = await store.openWorkspace('a');expect(saved.selectedTitle).toBe(before.selectedTitle);expect(saved.descriptions).toEqual(before.descriptions)
  expect(await store.setSeriesDone('a', { done: true, expectedRevision: closed.revision })).toEqual(closed)
  const reopened = await store.setSeriesDone('a', { done: false, expectedRevision: closed.revision });expect(reopened.closedAt).toBeNull();expect(reopened.revision).toBe(closed.revision + 1);expect((await store.openWorkspace('a')).selectedTitle).toBe(before.selectedTitle)
 })
 it('does not auto-archive ready series and keeps manual completion when content later changes', async () => {
  await saveFixture('a', { selectedTitle: 'A Hunter Returns', description: 'Description', selectedThumbnail: 'saved-image' })
  let status = (await store.libraryStatuses(['a'])).a;expect(status.english).toBe('done');expect(status.closedAt).toBeNull()
  status = await store.setSeriesDone('a', { done: true, expectedRevision: status.revision })
  await store.selectTitle('a', { title: 'A New Title', expectedRevision: status.revision })
  const updated = (await store.libraryStatuses(['a'])).a;expect(updated.closedAt).toBe(status.closedAt);expect(updated.english).toBe('needs_update')
 })
 it('rejects stale and invalid completion updates and never replaces corrupt saved work', async () => {
  const w = await store.openWorkspace('a');const closed = await store.setSeriesDone('a', { done: true, expectedRevision: w.titles.revision })
  await expect(store.setSeriesDone('a', { done: false, expectedRevision: w.titles.revision })).rejects.toMatchObject({ status: 409 })
  await expect(store.setSeriesDone('a', { done: 'yes', expectedRevision: closed.revision })).rejects.toMatchObject({ status: 400 })
  const broken = Buffer.from('{not valid json');await fs.writeFile(workspaceFile('a'), broken);await expect(store.libraryStatuses(['a'])).rejects.toThrow();expect(await fs.readFile(workspaceFile('a'))).toEqual(broken)
 })
 it('validates series identity, input bounds and revision checks over HTTP', async () => {
  const app = express();app.use(express.json());app.use('/api/youtube', createYouTubeRouter({ store, seriesExists: async id => id === 'a' }))
  server = createServer(app);await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));const origin = `http://127.0.0.1:${(server.address() as any).port}/api/youtube`
  const send = (endpoint: string, body: unknown, method = 'POST') => fetch(origin + endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let response = await send('/library/status', { seriesIds: ['a', 'a'] });expect(response.status).toBe(200);expect(Object.keys(await response.json())).toEqual(['a']);expect(await fs.readdir(root)).toEqual([])
  expect((await send('/library/status', { seriesIds: ['missing'] })).status).toBe(404)
  expect((await send('/library/status', { seriesIds: [42] })).status).toBe(400)
  expect((await send('/library/status', { seriesIds: Array(501).fill('a') })).status).toBe(400)
  response = await send('/series/a/done', { done: true, expectedRevision: 0 }, 'PUT');expect(response.status).toBe(200);expect((await response.json() as any).closedAt).toBeTruthy()
  expect((await send('/series/a/done', { done: false, expectedRevision: 0 }, 'PUT')).status).toBe(409)
  expect((await send('/series/missing/done', { done: true, expectedRevision: 0 }, 'PUT')).status).toBe(404)
 })
})
