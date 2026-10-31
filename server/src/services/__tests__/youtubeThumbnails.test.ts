import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { YouTubeStore } from '../youtubeStore.js'
import { createYouTubeRouter } from '../../routes/youtube.js'
import { cropInventory, readYouTubeCrop } from '../youtubeCrops.js'
import { getOutputDir } from '../clipper3/perImageStore.js'
import { thumbnailImage } from '../youtubeThumbnails.js'
let root: string, store: YouTubeStore, server: Server | undefined, originalDownload: string | undefined
const png = () => sharp({ create: { width: 1280, height: 720, channels: 3, background: '#2579a5' } }).png().toBuffer()
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-thumbnails-')); store = new YouTubeStore(root); originalDownload = process.env.DOWNLOAD_ROOT; process.env.DOWNLOAD_ROOT = path.join(root, 'downloads') })
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined } if (originalDownload === undefined) delete process.env.DOWNLOAD_ROOT; else process.env.DOWNLOAD_ROOT = originalDownload; await fs.rm(root, { recursive: true, force: true }) })
async function prepared() {
 let w = await store.openWorkspace('a')
 w = await store.selectTitle('a', { title: 'A Hunter Returns With a Secret', seriesName: 'Test Hunter', expectedRevision: w.titles.revision })
 w = await store.changeReference('a', { expectedRevision: w.titles.revision }, { chapterId: 'c1', cropId: 'crop1', label: 'Chapter 1 · image.png', buffer: await png() })
 return store.prepareThumbnails('a', 'Test Hunter', { mode: 'fresh', expectedRevision: w.titles.revision })
}
async function imported() { const w = await prepared(); return store.importThumbnail('a', { requestId: w.thumbnails.requests[0].id, slot: 0, expectedRevision: w.titles.revision }, await png()) }
describe('thumbnail workflow', () => {
 it('migrates old workspaces without losing title, description or selection', async () => {
  const w = await store.openWorkspace('a'); const files = await fs.readdir(path.join(root, 'workspaces')); const filename = path.join(root, 'workspaces', files[0]); const legacy = { ...w, selectedThumbnail: 'legacy' }; delete (legacy as any).thumbnails; await fs.writeFile(filename, JSON.stringify(legacy))
  expect((await store.openWorkspace('a')).thumbnails).toEqual({ references: [], requests: [], versions: [] }); expect((await store.openWorkspace('a')).selectedThumbnail).toBe('legacy')
 })
 it('requires title and 1–10 unique references and persists primary order', async () => {
  let w = await store.openWorkspace('a'); await expect(store.prepareThumbnails('a', 'Test', { mode: 'fresh', expectedRevision: w.titles.revision })).rejects.toThrow('Choose a title')
  w = await store.selectTitle('a', { title: 'A Hunter Returns', expectedRevision: w.titles.revision })
  await expect(store.prepareThumbnails('a', 'Test', { mode: 'fresh', expectedRevision: w.titles.revision })).rejects.toThrow('one and ten')
  for (let i = 0; i < 10; i++) w = await store.changeReference('a', { expectedRevision: w.titles.revision }, { chapterId: 'c', cropId: String(i), label: 'Ref', buffer: await png() })
  expect(await store.changeReference('a', { expectedRevision: w.titles.revision }, { chapterId: 'c', cropId: '0', label: 'Ref', buffer: await png() })).toEqual(w)
  await expect(store.changeReference('a', { expectedRevision: w.titles.revision }, { chapterId: 'c', cropId: 'extra', label: 'Ref', buffer: await png() })).rejects.toThrow('Ten references')
  const last = w.thumbnails.references[9]; w = await store.changeReference('a', { expectedRevision: w.titles.revision, primaryId: last.id }); expect(w.thumbnails.references[0].id).toBe(last.id)
  w = await store.changeReference('a', { expectedRevision: w.titles.revision, removeId: last.id }); expect(w.thumbnails.references).toHaveLength(9)
 })
 it('builds three independent prompts with exact title, canonical series, attached references and guideline snapshot', async () => {
  const w = await prepared(); const r = w.thumbnails.requests[0]
  expect(r.prompts).toHaveLength(3); expect(new Set(r.prompts).size).toBe(3)
  for (const p of r.prompts) { expect(p).toContain(w.selectedTitle); expect(p).toContain('Test Hunter'); expect(p).toContain(r.guidelineSha256); expect(p).toContain('reference-1.png'); expect(p).toContain('exactly ONE'); expect(p).not.toContain('[replace with') }
  const ref = w.thumbnails.references[0]; const bytes = await store.thumbnailMedia('a', ref.id)
  const next = await store.changeReference('a', { expectedRevision: w.titles.revision, removeId: ref.id }); expect(next.thumbnails.references).toHaveLength(0)
  expect(await store.thumbnailMedia('a', r.references[0].id)).toEqual(bytes)
  const guidelines = await store.guidelines(); await store.replace('thumbnail', Buffer.from('Updated thumbnail instructions for a future batch. Keep the hero visible.'), 'new.txt', guidelines.thumbnail.id)
  expect((await store.openWorkspace('a')).thumbnails.requests[0]).toEqual(r)
 })
 it('imports actual decoded images per slot, selects persistently and rejects overwriting or stale writes', async () => {
  let w = await imported(); const image = w.thumbnails.versions[0]; expect(image.width).toBe(1280); expect(image.height).toBe(720); expect(w.selectedThumbnail).toBeNull()
  await expect(store.importThumbnail('a', { requestId: image.requestId, slot: 0, expectedRevision: w.titles.revision }, await png())).rejects.toMatchObject({ status: 409 })
  await expect(store.importThumbnail('a', { requestId: image.requestId, slot: 3, expectedRevision: w.titles.revision }, await png())).rejects.toThrow('variation')
  await expect(store.importThumbnail('a', { requestId: image.requestId, slot: 1, expectedRevision: w.titles.revision }, Buffer.from('<svg/>'))).rejects.toThrow('readable')
  w = await store.selectThumbnail('a', { id: image.id, expectedRevision: w.titles.revision }); expect(w.selectedThumbnail).toBe(image.id); expect(w.thumbnailNeedsUpdate).toBe(false)
  expect((await new YouTubeStore(root).openWorkspace('a')).selectedThumbnail).toBe(image.id)
  await expect(store.selectThumbnail('a', { id: image.id, expectedRevision: 0 })).rejects.toMatchObject({ status: 409 })
  await expect(store.thumbnailMedia('b', image.id)).rejects.toMatchObject({ status: 404 })
  const raw = await store.thumbnailMedia('a', image.id); expect((await sharp(raw).metadata()).format).toBe('png')
 })
 it('retains original images and snapshot attachments when making edits or fresh batches', async () => {
  let w = await imported(); const original = w.thumbnails.versions[0]
  await expect(store.prepareThumbnails('a', 'Test Hunter', { mode: 'edit', parentId: original.id, expectedRevision: w.titles.revision })).rejects.toThrow('Describe')
  w = await store.prepareThumbnails('a', 'Test Hunter', { mode: 'edit', parentId: original.id, feedback: 'Keep the hero, zoom in on his face.', expectedRevision: w.titles.revision })
  const request = w.thumbnails.requests.at(-1)!; expect(request.parentId).toBe(original.id); expect(request.prompts[0]).toContain('base-thumbnail.png'); expect(request.prompts[0]).toContain('zoom in on his face')
  w = await store.importThumbnail('a', { requestId: request.id, slot: 0, expectedRevision: w.titles.revision }, await png()); expect(w.thumbnails.versions).toHaveLength(2)
  w = await store.prepareThumbnails('a', 'Test Hunter', { mode: 'fresh', feedback: 'Change the setting.', parentId: original.id, expectedRevision: w.titles.revision }); expect(w.thumbnails.requests.at(-1)?.parentId).toBeNull()
  expect(w.thumbnails.versions[0]).toEqual(original)
 })
 it('marks previous-title thumbnails and blocks importing old-title requests', async () => {
  let w = await imported(); const image = w.thumbnails.versions[0]
  w = await store.selectThumbnail('a', { id: image.id, expectedRevision: w.titles.revision })
  w = await store.selectTitle('a', { title: 'A Different Hook', expectedRevision: w.titles.revision }); expect(w.thumbnailNeedsUpdate).toBe(true); expect(w.selectedThumbnail).toBe(image.id)
  await expect(store.importThumbnail('a', { requestId: image.requestId, slot: 1, expectedRevision: w.titles.revision }, await png())).rejects.toMatchObject({ status: 409 })
 })
 it('replaces the selected image with an uploaded version, preserving prior variations and allowing restoration', async () => {
  let w = await imported(); const original = w.thumbnails.versions[0]
  w = await store.selectThumbnail('a', { id: original.id, expectedRevision: w.titles.revision })
  w = await store.selectTitle('a', { title: 'A New Hunter Hook', expectedRevision: w.titles.revision })
  expect(w.thumbnailNeedsUpdate).toBe(true)
  // Replacement uploads also work after current crop references have been removed.
  w = await store.changeReference('a', { removeId: w.thumbnails.references[0].id, expectedRevision: w.titles.revision })
  const replacement = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#995522' } }).jpeg().toBuffer()
  w = await store.replaceThumbnail('a', { selectedId: original.id, expectedRevision: w.titles.revision }, replacement)
  const image = w.thumbnails.versions.at(-1)!
  expect(image).toMatchObject({ source: 'uploaded', replacesId: original.id, requestId: null, slot: null, title: 'A New Hunter Hook', width: 1280, height: 720 })
  expect(w.selectedThumbnail).toBe(image.id); expect(w.thumbnailNeedsUpdate).toBe(false); expect(w.thumbnails.versions[0]).toEqual(original)
  expect(await store.thumbnailMedia('a', original.id)).toEqual(await png())
  expect((await sharp(await store.thumbnailMedia('a', image.id)).metadata()).format).toBe('png')
  expect((await new YouTubeStore(root).openWorkspace('a')).selectedThumbnail).toBe(image.id)
  w = await store.selectThumbnail('a', { id: original.id, expectedRevision: w.titles.revision }); expect(w.selectedThumbnail).toBe(original.id); expect(w.thumbnails.versions).toHaveLength(2)
 })
 it('replaces an imported image directly in its request slot before selection, retaining the original', async () => {
  const old = await imported();const image = old.thumbnails.versions[0]
  expect(old.selectedThumbnail).toBeNull()
  let w = await store.replaceThumbnail('a', { imageId: image.id, expectedRevision: old.titles.revision }, await png())
  const replacement = w.thumbnails.versions.at(-1)!
  expect(replacement).toMatchObject({ requestId: image.requestId, slot: image.slot, source: 'uploaded', replacesId: image.id })
  expect(w.selectedThumbnail).toBe(replacement.id);expect(w.thumbnails.versions[0]).toEqual(image)
  const latest = [...w.thumbnails.versions].reverse().find(item => item.requestId === image.requestId && item.slot === image.slot)
  expect(latest?.id).toBe(replacement.id)
  w = await store.replaceThumbnail('a', { imageId: replacement.id, expectedRevision: w.titles.revision }, await png())
  expect(w.thumbnails.versions).toHaveLength(3);expect(w.thumbnails.versions.at(-1)?.replacesId).toBe(replacement.id)
  await expect(store.replaceThumbnail('a', { imageId: image.id, expectedRevision: old.titles.revision }, await png())).rejects.toMatchObject({ status: 409 })
 })
 it('preserves the current selection and history on invalid replacement, stale revision or wrong target', async () => {
  let w = await imported(); const original = w.thumbnails.versions[0]
  await expect(store.replaceThumbnail('a', { selectedId: original.id, expectedRevision: w.titles.revision }, await png())).rejects.toMatchObject({ status: 409 })
  w = await store.selectThumbnail('a', { id: original.id, expectedRevision: w.titles.revision })
  await expect(store.replaceThumbnail('a', { selectedId: original.id, expectedRevision: 0 }, await png())).rejects.toMatchObject({ status: 409 })
  await expect(store.replaceThumbnail('a', { selectedId: 'wrong', expectedRevision: w.titles.revision }, await png())).rejects.toMatchObject({ status: 409 })
  await expect(store.replaceThumbnail('a', { selectedId: original.id, expectedRevision: w.titles.revision }, Buffer.from('broken image'))).rejects.toThrow('readable')
  expect(await store.openWorkspace('a')).toEqual(w)
 })
 it('rejects corrupt and oversized images, while converting JPEG to PNG', async () => {
  await expect(thumbnailImage(Buffer.from('Not an image'))).rejects.toThrow('readable'); await expect(thumbnailImage(Buffer.alloc(21 * 1024 * 1024))).rejects.toThrow('20 MB')
  const data = await sharp(await png()).jpeg().toBuffer(); expect((await sharp((await thumbnailImage(data)).buffer).metadata()).format).toBe('png')
 })
 it('scopes crop inventory and protects against filenames and symlinks escaping the crop directory', async () => {
  const chapter = { id: 'c', number: 1, folderPath: 'series/chapter' }; const dir = getOutputDir(chapter.folderPath); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'one.png'), await png())
  const list = await cropInventory(chapter); expect(list.files).toHaveLength(1); expect((await readYouTubeCrop(chapter, list.files[0].id)).label).toContain('Chapter 1')
  await expect(readYouTubeCrop(chapter, '../../one.png')).rejects.toThrow('no longer available')
  const outside = path.join(root, 'outside.png'); await fs.writeFile(outside, await png()); await fs.symlink(outside, path.join(dir, 'escape.png'))
  const escaped = (await cropInventory(chapter)).files.find(f => f.filename === 'escape.png')!; await expect(readYouTubeCrop(chapter, escaped.id)).rejects.toThrow('outside this chapter')
 })
 it('exposes scoped APIs, image uploads and an actual ZIP with references and all three prompts', async () => {
  const app = express(); app.use(express.json()); app.use('/api/youtube', createYouTubeRouter({ store, seriesExists: async id => id === 'a', seriesTitle: async () => 'Test Hunter', chapters: async () => [{ id: 'c', number: 1, folderPath: 'chapter' }] }))
  server = createServer(app); await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${(server.address() as any).port}/api/youtube/series/a`
  let w = await prepared(); const req = w.thumbnails.requests[0]
  const bundle = await fetch(`${origin}/thumbnails/requests/${req.id}/package`); expect(bundle.status).toBe(200); const zip = Buffer.from(await bundle.arrayBuffer()); expect(zip.subarray(0, 2).toString()).toBe('PK'); expect(zip.includes(Buffer.from('reference-1.png'))).toBe(true); expect(zip.includes(Buffer.from('variation-3-prompt.txt'))).toBe(true)
  const form = new FormData(); form.append('file', new Blob([new Uint8Array(await png())], { type: 'image/png' }), 'generated.png'); form.append('requestId', req.id); form.append('slot', '0'); form.append('expectedRevision', String(w.titles.revision))
  const upload = await fetch(`${origin}/thumbnails/import`, { method: 'POST', body: form }); expect(upload.status).toBe(200); w = await upload.json() as any; expect(w.thumbnails.versions).toHaveLength(1)
  expect((await fetch(`${origin}/crops/wrong`)).status).toBe(404); expect((await fetch(`${origin.replace('/a', '/missing')}/crop-chapters`)).status).toBe(404)
  const media = await fetch(`${origin}/thumbnails/media/${w.thumbnails.versions[0].id}`); expect(media.headers.get('content-type')).toContain('image/png')
  w = await store.selectThumbnail('a', { id: w.thumbnails.versions[0].id, expectedRevision: w.titles.revision })
  const previous = w.selectedThumbnail
  const replacement = new FormData(); replacement.append('selectedId', previous!); replacement.append('expectedRevision', String(w.titles.revision)); replacement.append('file', new Blob([new Uint8Array(await png())], { type: 'image/png' }), 'replacement.png')
  const replaced = await fetch(`${origin}/thumbnails/replace`, { method: 'POST', body: replacement }); expect(replaced.status).toBe(200)
  w = await replaced.json() as any; expect(w.selectedThumbnail).not.toBe(previous); expect(w.thumbnails.versions).toHaveLength(2); expect(w.thumbnails.versions.at(-1)?.source).toBe('uploaded')
  expect((await fetch(`${origin}/thumbnails/replace`, { method: 'POST', body: new FormData() })).status).toBe(400)

 })
})
