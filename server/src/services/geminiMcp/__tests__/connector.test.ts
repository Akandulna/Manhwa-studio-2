import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { GeminiMcpConnector, resolveNodePath, noJobsReply, LAST_CALL_KEY, type KeyValueStore } from '../connector.js'
import { createGeminiMcpRouter } from '../../../routes/geminiMcp.js'

const memoryStore = (): KeyValueStore & { map: Map<string, string> } => {
  const map = new Map<string, string>()
  return { map, get: async k => map.get(k) ?? null, set: async (k, v) => { map.set(k, v) } }
}

let dir: string
let server: Server
let port: number
let store: ReturnType<typeof memoryStore>
let connector: GeminiMcpConnector

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-mcp-test-'))
  store = memoryStore()
  // The server must listen before the connector knows its port.
  const app = express()
  app.use(express.json())
  const holder: { router?: express.Router } = {}
  app.use('/api/gemini-mcp', (req, res, next) => holder.router!(req, res, next))
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  port = (server.address() as AddressInfo).port
  connector = new GeminiMcpConnector({ store, dir: path.join(dir, 'gemini-mcp'), port, nodePath: process.execPath })
  holder.router = createGeminiMcpRouter(connector, new Set([`http://127.0.0.1:${port}`]))
})
afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
  await fs.rm(dir, { recursive: true, force: true })
})

const api = (p: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}/api/gemini-mcp${p}`, init)
const studio = { 'X-Studio-Client': '1' }

describe('Gemini MCP connector', () => {
  it('reports not installed before install', async () => {
    const status = await (await api('/connector')).json()
    expect(status.state).toBe('not_installed')
    expect(status.command).toBeNull()
  })

  it('refuses mutations without the Studio client header', async () => {
    expect((await api('/connector/install', { method: 'POST' })).status).toBe(403)
  })

  it('installs script, config and a 0600 token, and gives a command without the token', async () => {
    const status = await (await api('/connector/install', { method: 'POST', headers: studio })).json()
    expect(status.state).toBe('installed')
    expect(status.problems).toEqual([])
    const token = (await fs.readFile(path.join(connector.dir, 'token'), 'utf8')).trim()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect((await fs.stat(path.join(connector.dir, 'token'))).mode & 0o777).toBe(0o600)
    expect(status.command).toContain('connector.mjs')
    expect(status.command).not.toContain(token)
    const config = JSON.parse(await fs.readFile(path.join(connector.dir, 'config.json'), 'utf8'))
    expect(config.bridgeUrl).toBe(`http://127.0.0.1:${port}/api/gemini-mcp/bridge`)
  })

  it('keeps the token on repair and flags a tampered script', async () => {
    const before = await fs.readFile(path.join(connector.dir, 'token'), 'utf8')
    await fs.appendFile(path.join(connector.dir, 'connector.mjs'), '\n// edited\n')
    expect((await (await api('/connector')).json()).state).toBe('needs_repair')
    const repaired = await (await api('/connector/install', { method: 'POST', headers: studio })).json()
    expect(repaired.state).toBe('installed')
    expect(await fs.readFile(path.join(connector.dir, 'token'), 'utf8')).toBe(before)
  })

  it('rejects bridge calls without the right token', async () => {
    const call = (auth?: string) => api('/bridge/call', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth && { Authorization: auth }) }, body: JSON.stringify({ tool: 'get_job', arguments: {} }) })
    expect((await call()).status).toBe(401)
    expect((await call('Bearer ' + 'f'.repeat(64))).status).toBe(401)
    const token = (await fs.readFile(path.join(connector.dir, 'token'), 'utf8')).trim()
    const ok = await call(`Bearer ${token}`)
    expect(ok.status).toBe(200)
    expect((await ok.json()).data).toEqual({ status: 'none', note: 'No chapters are queued for Gemini.' })
  })

  it('self-test runs the installed connector over stdio with the 3 permanent tools and does not count as a Gemini call', async () => {
    await store.set(LAST_CALL_KEY, 'null')
    const result = await (await api('/connector/test', { method: 'POST', headers: studio })).json()
    expect(result.error).toBeNull()
    expect(result.ok).toBe(true)
    expect(result.tools).toEqual(['get_job', 'get_reference', 'submit'])
    expect(result.reply).toEqual({ status: 'ok', note: 'Manhwa Studio is reachable.' })
    expect((await (await api('/connector')).json()).lastCall).toBeNull()
  })

  it('remembers the last call from Gemini', async () => {
    const token = (await fs.readFile(path.join(connector.dir, 'token'), 'utf8')).trim()
    await api('/bridge/call', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ tool: 'submit', arguments: { job: 'NR-TEST', stage: 'notes', content: {} }, client: 'gemini-manhwa-1-client' }) })
    const last = (await (await api('/connector')).json()).lastCall
    expect(last).toMatchObject({ tool: 'submit', client: 'gemini-manhwa-1-client', job: 'NR-TEST' })
  })

  it('connector answers with data (not an error) when Studio is unreachable', async () => {
    const offline = new GeminiMcpConnector({ store: memoryStore(), dir: path.join(dir, 'offline'), port: 1, nodePath: process.execPath })
    await offline.install()
    const result = await offline.selfTest()
    expect(result.ok).toBe(false)
    expect(result.tools).toEqual(['get_job', 'get_reference', 'submit'])
    expect(result.error).toMatch(/not reachable/)
  })
})

describe('helpers', () => {
  it('prefers a stable node path over a versioned Cellar one', () => {
    expect(resolveNodePath('/opt/homebrew/Cellar/node/24.4.0/bin/node', p => p === '/opt/homebrew/bin/node')).toBe('/opt/homebrew/bin/node')
    expect(resolveNodePath('/Applications/Manhwa Studio.app/Contents/MacOS/Electron', p => p === '/usr/local/bin/node')).toBe('/usr/local/bin/node')
    expect(resolveNodePath('/opt/homebrew/Cellar/node/24.4.0/bin/node', () => false)).toBe('/opt/homebrew/Cellar/node/24.4.0/bin/node')
  })
  it('no-jobs replies are data, never orders', () => {
    expect(noJobsReply('get_job', {})).toEqual({ status: 'none', note: 'No chapters are queued for Gemini.' })
    expect(noJobsReply('get_job', { job: 'NR-1' })).toMatchObject({ status: 'error' })
    expect(noJobsReply('submit', { job: 'NR-1' })).toMatchObject({ status: 'error' })
  })
})
