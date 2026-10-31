import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Request } from 'express'
import { assertLocalClipboardRequest, copyReferenceFiles } from '../youtubeClipboard.js'
import type { YouTubeStore } from '../youtubeStore.js'
let root: string
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-clipboard-test-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
function request(headers: Record<string, string> = {}, remoteAddress = '127.0.0.1') { return { socket: { remoteAddress }, get: (name: string) => ({ 'x-studio-clipboard': 'references', host: 'localhost:3002', origin: 'http://localhost:3002', ...headers })[name.toLowerCase()] } as Request }
function store() {
 const refs = [{ id: 'first' }, { id: 'second' }]
 const batch = { id: 'batch', references: refs, parentId: null as string | null }
 const workspace = { thumbnails: { references: [{ id: 'newer-selection' }], requests: [batch] } }
 const api = { openWorkspace: async () => workspace, thumbnailMedia: async (_series: string, id: string) => Buffer.from(id) } as unknown as YouTubeStore
 return { api, batch }
}
describe('reference image clipboard', () => {
 it('accepts only local explicit requests from the Studio origin', () => {
  expect(() => assertLocalClipboardRequest(request())).not.toThrow()
  expect(() => assertLocalClipboardRequest(request({}, '::1'))).not.toThrow()
  for (const req of [request({}, '192.168.1.2'), request({ 'x-studio-clipboard': '' }), request({ origin: 'https://external.invalid' }), request({ origin: 'http://localhost:9999' }), request({ origin: 'null' }), request({ 'sec-fetch-site': 'cross-site' })]) expect(() => assertLocalClipboardRequest(req)).toThrow()
 })
 it('accepts the local Vite UI even when its proxy rewrites Host to the API port', () => {
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']) {
   expect(() => assertLocalClipboardRequest(request({ origin, 'sec-fetch-site': 'same-origin' }))).not.toThrow()
  }
  expect(() => assertLocalClipboardRequest(request({ origin: 'http://localhost:5173', host: '127.0.0.1:3002' }, '::ffff:127.0.0.1'))).not.toThrow()
  const rejected: Record<string, string>[] = [{ origin: 'http://external.invalid:5173' }, { origin: 'http://localhost:5173', host: 'external.invalid:3002' }, { origin: 'http://localhost:5173', 'sec-fetch-site': 'cross-site' }, { origin: 'http://localhost:9999' }]
  for (const headers of rejected) expect(() => assertLocalClipboardRequest(request(headers))).toThrow()
 })
 it('copies all request snapshots in order with prompt filenames, not a later reference selection', async () => {
  const { api } = store(); let files: string[] = []
  const result = await copyReferenceFiles(api, 'series', 'batch', { platform: 'darwin', write: async paths => { files = paths; expect(paths.map(p => path.basename(p))).toEqual(['reference-1.png', 'reference-2.png']); expect(await fs.readFile(paths[0], 'utf8')).toBe('first'); expect(await fs.readFile(paths[1], 'utf8')).toBe('second') } })
  expect(result).toEqual({ count: 2, includesBase: false }); expect((await fs.stat(files[0])).isFile()).toBe(true)
  await fs.rm(path.dirname(files[0]), { recursive: true, force: true })
 })
 it('includes the base thumbnail for edits, preserves files until next successful copy, and removes obsolete copies', async () => {
  const { api, batch } = store();batch.parentId = 'base';let previous: string[] = [], current: string[] = []
  expect(await copyReferenceFiles(api, 'series', 'batch', { platform: 'darwin', write: async files => { previous = files } })).toEqual({ count: 3, includesBase: true })
  expect(path.basename(previous[2])).toBe('base-thumbnail.png');expect(await fs.readFile(previous[2], 'utf8')).toBe('base')
  await copyReferenceFiles(api, 'series', 'batch', { platform: 'darwin', write: async files => { current = files; expect((await fs.stat(previous[0])).isFile()).toBe(true) } })
  await expect(fs.stat(previous[0])).rejects.toMatchObject({ code: 'ENOENT' });expect((await fs.stat(current[0])).isFile()).toBe(true)
  await fs.rm(path.dirname(current[0]), { recursive: true, force: true })
 })
 it('reports failures without claiming success or clearing the prior successful files', async () => {
  const { api } = store();let previous: string[] = [], failed: string[] = []
  await copyReferenceFiles(api, 'series', 'batch', { platform: 'darwin', write: async paths => { previous = paths } })
  await expect(copyReferenceFiles(api, 'series', 'batch', { platform: 'darwin', write: async paths => { failed = paths; throw new Error('Native clipboard failed') } })).rejects.toMatchObject({ status: 503 })
  expect((await fs.stat(previous[0])).isFile()).toBe(true);await expect(fs.stat(failed[0])).rejects.toMatchObject({ code: 'ENOENT' });await fs.rm(path.dirname(previous[0]), { recursive: true, force: true })
 })
 it('rejects unknown requests, unsupported platforms and missing image bytes before native clipboard access', async () => {
  const { api } = store();let called = false;const write = async () => { called = true }
  await expect(copyReferenceFiles(api, 'series', 'other', { platform: 'darwin', write })).rejects.toMatchObject({ status: 404 })
  await expect(copyReferenceFiles(api, 'series', 'batch', { platform: 'linux', write })).rejects.toMatchObject({ status: 501 })
  api.thumbnailMedia = async () => { throw new Error('Missing image') }
  await expect(copyReferenceFiles(api, 'series', 'batch', { platform: 'darwin', write })).rejects.toThrow('Missing image');expect(called).toBe(false)
 })
})
