/**
 * Gemini MCP connector (docs/PRD-gemini-app-narration.md §2, Phase 1).
 *
 * The Gemini Mac app runs a local stdio MCP server from a command the user pastes into its
 * "Add custom connected app" form. Its sandbox only lets that server read a few places, ~/.local
 * among them, so Studio copies resources/gemini-mcp/connector.mjs there with a config.json (the
 * bridge URL) and a 0600 token file. The connector relays every tool call to /api/gemini-mcp/bridge,
 * which checks the token against the SHA-256 kept in the Setting table.
 *
 * The command never contains the token, so reinstalling (new port, new script) never needs the
 * connector to be re-added in Gemini, unless the tool list itself changes (CONNECTOR_TOOLS_VERSION).
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const CONNECTOR_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'resources', 'gemini-mcp', 'connector.mjs')
export const CONNECTOR_FILE = 'connector.mjs'
/** Bump only when the connector's tool list changes: Gemini must then re-add the connector. */
/** 2: submit marked read-only at the user's request (2026-11-12): no approval box in scheduled chats. */
export const CONNECTOR_TOOLS_VERSION = 2
export const CONNECTOR_TOOLS = ['get_job', 'get_reference', 'submit'] as const
export const SETTING_KEY = 'geminiMcpConnector'
export const LAST_CALL_KEY = 'geminiMcpLastCall'
export const SELF_TEST_CLIENT = 'manhwa-studio-self-test'

export const defaultInstallDir = () => path.join(os.homedir(), '.local', 'share', 'manhwa-studio', 'gemini-mcp')
const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex')

export interface InstallRecord { tokenSha256: string; installedAt: string; dir: string; toolsVersion: number; bridgeUrl: string }
export interface LastCall { at: string; tool: string; client: string | null; job: string | null }

/** Persistence (Setting rows in Studio; a map in tests). */
export interface KeyValueStore { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> }

export interface ConnectorDeps {
  store: KeyValueStore
  /** Where the connector is installed (tests use a temp dir). */
  dir?: string
  port?: string | number
  /** The node binary Gemini should run (tests pass process.execPath). */
  nodePath?: string
}

export interface ConnectorStatus {
  state: 'not_installed' | 'needs_repair' | 'installed'
  /** Why it needs repair. */
  problems: string[]
  dir: string
  /** The line to paste into Gemini's "Command" field. */
  command: string | null
  nodePath: string
  bridgeUrl: string
  installedAt: string | null
  toolsVersion: number
  /** The installed tool list is older than this Studio's: remove and re-add the connector in Gemini. */
  readdNeeded: boolean
  lastCall: LastCall | null
}

/**
 * A node binary Gemini can run. Stable install paths first: Studio's own process.execPath is often a
 * versioned Homebrew Cellar path that disappears on the next `brew upgrade`, which would break the
 * command saved in Gemini.
 */
export function resolveNodePath(execPath = process.execPath, exists: (p: string) => boolean = existsSync): string {
  const stable = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].find(exists)
  if (stable) return stable
  return /^node(\.exe)?$/.test(path.basename(execPath)) ? execPath : 'node'
}

const quote = (p: string) => (/[\s"'\\$`]/.test(p) ? `"${p.replace(/(["\\$`])/g, '\\$1')}"` : p)

export class GeminiMcpConnector {
  readonly dir: string
  readonly nodePath: string
  readonly bridgeUrl: string
  constructor(private readonly deps: ConnectorDeps) {
    this.dir = deps.dir ?? defaultInstallDir()
    this.nodePath = deps.nodePath ?? resolveNodePath()
    this.bridgeUrl = `http://127.0.0.1:${deps.port ?? process.env.PORT ?? 3001}/api/gemini-mcp/bridge`
  }

  private file = (name: string) => path.join(this.dir, name)
  get command() { return `${quote(this.nodePath)} ${quote(this.file(CONNECTOR_FILE))}` }

  private async record(): Promise<InstallRecord | null> {
    try { return JSON.parse((await this.deps.store.get(SETTING_KEY)) ?? 'null') } catch { return null }
  }

  async lastCall(): Promise<LastCall | null> {
    try { return JSON.parse((await this.deps.store.get(LAST_CALL_KEY)) ?? 'null') } catch { return null }
  }

  /** Writes (or repairs) the connector, its config and token. An existing valid token is kept. */
  async install(): Promise<ConnectorStatus> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    await fs.copyFile(CONNECTOR_SOURCE, this.file(CONNECTOR_FILE))
    await fs.writeFile(this.file('config.json'), JSON.stringify({ bridgeUrl: this.bridgeUrl, toolsVersion: CONNECTOR_TOOLS_VERSION }, null, 2) + '\n')
    let token = (await fs.readFile(this.file('token'), 'utf8').catch(() => '')).trim()
    if (!/^[0-9a-f]{64}$/.test(token)) token = crypto.randomBytes(32).toString('hex')
    await fs.writeFile(this.file('token'), token + '\n', { mode: 0o600 })
    await fs.chmod(this.file('token'), 0o600)
    const previous = await this.record()
    const record: InstallRecord = {
      tokenSha256: sha256(token),
      installedAt: new Date().toISOString(),
      dir: this.dir,
      // Keep the version Gemini last saw until the user confirms a re-add (see markReadded).
      toolsVersion: previous?.toolsVersion ?? CONNECTOR_TOOLS_VERSION,
      bridgeUrl: this.bridgeUrl
    }
    await this.deps.store.set(SETTING_KEY, JSON.stringify(record))
    return this.status()
  }

  /** The user removed and re-added the connector in Gemini, so Gemini now has this tool list. */
  async markReadded(): Promise<ConnectorStatus> {
    const record = await this.record()
    if (record) await this.deps.store.set(SETTING_KEY, JSON.stringify({ ...record, toolsVersion: CONNECTOR_TOOLS_VERSION }))
    return this.status()
  }

  async status(): Promise<ConnectorStatus> {
    const record = await this.record()
    const problems: string[] = []
    if (record) {
      const [script, source, token, config] = await Promise.all([
        fs.readFile(this.file(CONNECTOR_FILE), 'utf8').catch(() => null),
        fs.readFile(CONNECTOR_SOURCE, 'utf8'),
        fs.readFile(this.file('token'), 'utf8').catch(() => null),
        fs.readFile(this.file('config.json'), 'utf8').catch(() => null)
      ])
      if (script === null) problems.push('The connector script is missing.')
      else if (script !== source) problems.push('The connector script is out of date.')
      if (token === null || sha256(token.trim()) !== record.tokenSha256) problems.push('The token file is missing or does not match.')
      let bridgeUrl: unknown = null
      try { bridgeUrl = JSON.parse(config ?? 'null')?.bridgeUrl } catch {}
      if (bridgeUrl !== this.bridgeUrl) problems.push('The connector points to a different Studio address.')
      if (record.dir !== this.dir) problems.push('The connector was installed in another folder.')
    }
    return {
      state: !record ? 'not_installed' : problems.length ? 'needs_repair' : 'installed',
      problems,
      dir: this.dir,
      command: record ? this.command : null,
      nodePath: this.nodePath,
      bridgeUrl: this.bridgeUrl,
      installedAt: record?.installedAt ?? null,
      toolsVersion: CONNECTOR_TOOLS_VERSION,
      readdNeeded: !!record && record.toolsVersion !== CONNECTOR_TOOLS_VERSION,
      lastCall: await this.lastCall()
    }
  }

  /** Constant-time check of a bridge call's bearer token. */
  async verifyToken(header: string | undefined): Promise<boolean> {
    const record = await this.record()
    const token = /^Bearer\s+(\S+)$/.exec(header ?? '')?.[1]
    if (!record || !token) return false
    const a = Buffer.from(sha256(token), 'hex'), b = Buffer.from(record.tokenSha256, 'hex')
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  /** Remembers the latest call from Gemini (the self-test's calls are not kept). */
  async noteCall(tool: string, client: string | null, job: string | null) {
    if (client === SELF_TEST_CLIENT) return
    const call: LastCall = { at: new Date().toISOString(), tool, client, job }
    await this.deps.store.set(LAST_CALL_KEY, JSON.stringify(call))
  }

  /**
   * Runs the installed connector exactly as Gemini does (same command, stdio), lists its tools and
   * calls get_job through the bridge: proves script, config, token and route end to end.
   */
  selfTest(timeoutMs = 15_000): Promise<{ ok: boolean; tools: string[]; reply: unknown; error: string | null }> {
    return new Promise(resolve => {
      const child = spawn(this.nodePath, [this.file(CONNECTOR_FILE)], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
      const replies = new Map<number, any>()
      let buffer = '', stderr = '', settled = false
      const finish = (result: { ok: boolean; tools: string[]; reply: unknown; error: string | null }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.kill()
        resolve(result)
      }
      const timer = setTimeout(() => finish({ ok: false, tools: [], reply: null, error: `The connector did not answer within ${timeoutMs / 1000} s.${stderr ? ` ${stderr.trim().slice(0, 300)}` : ''}` }), timeoutMs)
      child.on('error', error => finish({ ok: false, tools: [], reply: null, error: `Could not start ${this.nodePath}: ${error.message}` }))
      child.stderr.on('data', chunk => { stderr += chunk })
      child.stdout.on('data', chunk => {
        buffer += chunk
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
          try { const m = JSON.parse(line); if (typeof m.id === 'number') replies.set(m.id, m) } catch { /* not protocol */ }
        }
        if (replies.has(3)) {
          const tools: string[] = (replies.get(2)?.result?.tools ?? []).map((t: { name: string }) => t.name)
          let reply: any = null
          try { reply = JSON.parse(replies.get(3)?.result?.content?.[0]?.text ?? 'null') } catch {}
          const missing = CONNECTOR_TOOLS.filter(t => !tools.includes(t))
          const error = missing.length ? `The connector lacks ${missing.join(', ')}.`
            : !reply || reply.status === 'error' ? `get_job failed: ${reply?.reason ?? 'no answer'}` : null
          finish({ ok: !error, tools, reply, error })
        }
      })
      const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n')
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: SELF_TEST_CLIENT, version: '1' } } })
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_job', arguments: {} } })
    })
  }
}

// ─── Bridge before jobs exist (tests, or if the job service could not start) ───

export type BridgeData = Record<string, unknown>

/** What a tool call returns when there are no jobs. Replies are data, never orders (PRD §3). */
export function noJobsReply(tool: string, args: Record<string, unknown>): BridgeData {
  const job = typeof args.job === 'string' && args.job.trim() ? args.job.trim() : null
  if (tool === 'get_job' && !job) return { status: 'none', note: 'No chapters are queued for Gemini.' }
  if (['get_job', 'get_reference', 'submit'].includes(tool)) return { status: 'error', job, reason: `Manhwa Studio has no job ${job ?? ''}.`.replace(' .', '.') }
  return { status: 'error', reason: `Unknown tool ${tool}.` }
}
