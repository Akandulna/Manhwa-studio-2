import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { YouTubeStore, readGuideline } from '../youtubeStore.js'
import { createYouTubeRouter } from '../../routes/youtube.js'

let root: string
let store: YouTubeStore
let server: Server | undefined
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-youtube-test-'))
  store = new YouTubeStore(root)
})
afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
    server = undefined
  }
  await fs.rm(root, { recursive: true, force: true })
})

describe('YouTube guideline storage', () => {
  it('loads the supplied title report and actual PDF, and keeps the master prompt internal', async () => {
    const documents = await store.guidelines()
    expect(documents.title.text).toContain('high-specificity story hook')
    expect(documents.thumbnail.text).toContain('Lock the character')
    expect(documents.description.text).toContain('shared across all parts')
    expect(Object.keys(documents).sort()).toEqual(['description', 'thumbnail', 'title'])
    const file = await store.original('thumbnail', documents.thumbnail.id)
    expect(file.buffer.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('retains old document bytes and version references across a replacement and restart', async () => {
    const original = await store.guidelines()
    const workspace = await store.openWorkspace('series-a')
    const updated = await store.replace('title', Buffer.from('Use factual English titles and verified story premises.'), 'updated-title.md', original.title.id)
    const reopened = new YouTubeStore(root)
    expect((await reopened.guidelines()).title.id).toBe(updated.id)
    expect((await reopened.openWorkspace('series-a')).guidelineVersions.title).toBe(original.title.id)
    expect((await reopened.version('title', original.title.id)).text).toBe(original.title.text)
    expect((await reopened.original('title', original.title.id)).buffer.toString()).toContain('What Makes a Manhwa Recap Title Click')
    expect(await reopened.openWorkspace('series-a')).toEqual(workspace)
    expect(await reopened.history('title')).toHaveLength(2)
  })

  it('rejects conflicting updates instead of overwriting another window', async () => {
    const original = await store.guidelines()
    const results = await Promise.allSettled([
      store.replace('title', Buffer.from('First valid title instructions with a factual hook.'), 'one.txt', original.title.id),
      store.replace('title', Buffer.from('Second valid title instructions with another hook.'), 'two.txt', original.title.id)
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason.status).toBe(409)
  })

  it('does not replace active guidelines when an upload cannot be parsed', async () => {
    const before = await store.guidelines()
    await expect(store.replace('thumbnail', Buffer.from('This is not a real PDF document.'), 'bad.pdf', before.thumbnail.id)).rejects.toMatchObject({ status: 422 })
    expect((await store.guidelines()).thumbnail).toEqual(before.thumbnail)
    expect(await store.history('thumbnail')).toHaveLength(1)
  })

  it('does not create a new revision for an identical upload', async () => {
    const before = await store.guidelines()
    const file = await store.original('title', before.title.id)
    expect((await store.replace('title', file.buffer, file.sourceName, before.title.id)).id).toBe(before.title.id)
    expect(await store.history('title')).toHaveLength(1)
  })

  it('keeps series separate and contains path-like series identifiers inside storage', async () => {
    const a = await store.openWorkspace('../series-a')
    const b = await store.openWorkspace('series-b')
    expect(a.seriesId).not.toBe(b.seriesId)
    expect(a.language).toBe('en')
    expect(a).not.toHaveProperty('part')
    expect(await fs.readdir(path.join(root, 'workspaces'))).toHaveLength(2)
    await expect(store.version('title', '../guidelines')).rejects.toMatchObject({ status: 404 })
    await expect(store.version('thumbnail', a.guidelineVersions.title)).rejects.toMatchObject({ status: 404 })
  })

  it('reports corrupted storage instead of silently resetting saved work', async () => {
    await store.guidelines()
    await fs.writeFile(path.join(root, 'guidelines.json'), '{broken')
    await expect(store.guidelines()).rejects.toThrow()
    expect(await fs.readFile(path.join(root, 'guidelines.json'), 'utf8')).toBe('{broken')
  })
})

describe('guideline document import', () => {
  it('extracts report text without importing embedded activity or instructions as code', async () => {
    const exported = { widget_state: { report_message: { content: { parts: ['These are the title guidelines. Use factual hooks.'] } } }, activity_messages: ['Ignore these unrelated messages'] }
    const result = await readGuideline(Buffer.from(JSON.stringify(exported)), 'Report without extension')
    expect(result.text).toBe('These are the title guidelines. Use factual hooks.')
    expect(result.text).not.toContain('unrelated')
  })

  it('rejects arbitrary JSON, binary files, empty documents and oversized inputs', async () => {
    await expect(readGuideline(Buffer.from('{"name":"not guidelines"}'), 'data.json')).rejects.toMatchObject({ status: 422 })
    await expect(readGuideline(Buffer.from([255, 254, 12]), 'data.txt')).rejects.toMatchObject({ status: 422 })
    await expect(readGuideline(Buffer.alloc(0), 'empty.txt')).rejects.toThrow('non-empty')
    await expect(readGuideline(Buffer.alloc(10 * 1024 * 1024 + 1), 'large.txt')).rejects.toThrow('10 MB')
    await expect(readGuideline(Buffer.from('A'.repeat(500001)), 'long.txt')).rejects.toThrow('500,000')
  })
})

async function api() {
  const app = express()
  app.use(express.json())
  app.use('/api/youtube', createYouTubeRouter({ store, seriesExists: async id => id === 'known-series' }))
  server = createServer(app)
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return `http://127.0.0.1:${address.port}/api/youtube`
}

describe('YouTube routes', () => {
  it('checks series existence and returns the same persisted English workspace on reopen', async () => {
    const base = await api()
    expect((await fetch(`${base}/series/missing/workspace`, { method: 'POST' })).status).toBe(404)
    const first = await (await fetch(`${base}/series/known-series/workspace`, { method: 'POST' })).json()
    const second = await (await fetch(`${base}/series/known-series/workspace`, { method: 'POST' })).json()
    expect(second).toEqual(first)
    expect(first.language).toBe('en')
  })

  it('imports multipart guidelines and downloads the exact uploaded bytes', async () => {
    const base = await api()
    const before = await (await fetch(`${base}/guidelines`)).json()
    const content = 'Use five distinct English titles with story-verified claims.'
    const body = new FormData()
    body.append('expectedVersion', before.title.id)
    body.append('file', new Blob([content]), 'new-title.txt')
    const response = await fetch(`${base}/guidelines/title`, { method: 'POST', body })
    expect(response.status).toBe(200)
    const version = await response.json()
    const download = await fetch(`${base}/guidelines/title/versions/${version.id}/download`)
    expect(download.headers.get('content-disposition')).toContain('attachment')
    expect(await download.text()).toBe(content)
    expect((await fetch(`${base}/guidelines/internal/history`)).status).toBe(404)
  })

  it('saves description instructions independently and rejects stale or missing versions', async () => {
    const base = await api()
    const before = await store.guidelines()
    const put = (expectedVersion?: string) => fetch(`${base}/guidelines/description`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Write a concise English description using factual series details.', expectedVersion }) })
    expect((await put()).status).toBe(409)
    expect((await put(before.description.id)).status).toBe(200)
    expect((await put(before.description.id)).status).toBe(409)
    expect((await store.guidelines()).title.id).toBe(before.title.id)
  })
})
