/**
 * ChatGPT through the local Codex CLI — the second AntiGravity engine.
 *
 * Same job contract as agy (cli.ts): one page = one conversation; slices come
 * from Studio's MCP bridge (resources/antigravity/job-mcp.mjs) and results are
 * only accepted through its submit tools. Codex keeps its own ChatGPT sign-in
 * in CODEX_HOME (~/.codex); Studio never reads or stores those credentials.
 *
 * Observed on codex-cli 0.166.0-alpha.5.1 (bundled with ChatGPT.app, 2026-11-08):
 *   - `codex exec --json` prints JSONL events: thread.started {thread_id},
 *     item.started/item.completed {item: agent_message | mcp_tool_call | …},
 *     turn.completed {usage} | turn.failed {error}, error {message}.
 *   - `codex exec resume <thread_id> …` continues exactly that conversation
 *     (it has no -s flag, so the sandbox is set with -c sandbox_mode for both).
 *   - MCP tools are refused under approval_policy=never unless the server sets
 *     default_tools_approval_mode="approve".
 *   - --ignore-user-config skips ~/.codex/config.toml (the operator's plugins,
 *     computer use, browser…) while auth still comes from CODEX_HOME.
 *   - MCP image results are passed to the model (probe image read correctly).
 * Each turn therefore runs with: no user config or rules, read-only sandbox,
 * no web search, shell/plugins/apps/computer use/browser/sub-agents switched
 * off, and only Studio's MCP server configured.
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redact } from '../googleDrive/errors.js'
import { SAFE_ID, type AgyEnvelope, type AgyInstallation, type AgyTurnResult } from './cli.js'

/** Codex CLI shipped inside the ChatGPT desktop app (and the standalone Codex app). */
export const BUNDLED_CODEX_PATHS = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex'
]

export const codexHome = (env: NodeJS.ProcessEnv = process.env) => env.CODEX_HOME || path.join(os.homedir(), '.codex')

export interface CodexModel {
  id: string
  label: string
  efforts: string[]
  defaultEffort: string | null
  /** The model accepts image input (required: pages arrive as images). */
  image: boolean
}

export interface CodexAccount {
  signedIn: boolean
  /** "chatgpt" = ChatGPT plan sign-in (Plus and above include Codex); "api_key" bills the API instead. */
  mode: 'chatgpt' | 'api_key' | null
  detail: string
}

export interface CodexMcpServer {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface CodexTurnRequest {
  executable: string
  cwd: string
  prompt: string
  model: string
  effort?: string | null
  /** Resume exactly this thread; never `--last`. */
  conversationId?: string | null
  mcp: CodexMcpServer
  timeoutMs: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  onSpawn?: (pid: number) => void
}

export class CodexError extends Error {
  constructor(readonly code: 'not_installed' | 'auth_required' | 'failed', message: string) {
    super(redact(message))
  }
}

/** Codex features switched off for every Studio turn (they are not needed and widen what a job can touch). */
export const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'shell_snapshot', 'multi_agent', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external',
  'in_app_browser', 'computer_use', 'image_generation', 'goals', 'hooks', 'memories', 'skill_search', 'skill_mcp_dependency_install', 'tool_suggest', 'sleep_tool'
]
/** Efforts Studio offers. "ultra" delegates to sub-agents, which Studio jobs do not allow. */
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const CODEX_MCP_SERVER = 'studio'

const MAX_STDERR = 64 * 1024
/** One JSONL line can carry a whole slice image (base64) from an MCP result; cap what is kept in memory. */
const MAX_LINE = 64 * 1024 * 1024

const isExec = (file: string) => {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

export function findCodexExecutable(override: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (override) return path.isAbsolute(override) && isExec(override) ? override : null
  const home = os.homedir()
  const dirs = [...(env.PATH ?? '').split(path.delimiter), path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean)
  for (const dir of dirs) {
    const file = path.join(dir, 'codex')
    if (isExec(file)) return file
  }
  return BUNDLED_CODEX_PATHS.find(isExec) ?? null
}

function run(executable: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(executable, args, { cwd: os.tmpdir(), timeout: timeoutMs, maxBuffer: 1024 * 1024, env }, (error, stdout, stderr) => {
      const code = error && typeof (error as NodeJS.ErrnoException).code === 'number' ? ((error as unknown as { code: number }).code) : error ? null : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export async function detectCodex(override?: string | null): Promise<AgyInstallation> {
  const executable = findCodexExecutable(override)
  if (!executable) {
    return { path: null, version: null, error: override ? 'The configured codex path is not an executable file.' : 'The Codex CLI was not found. Install the ChatGPT desktop app (it includes Codex) or set the codex path.' }
  }
  const { stdout, stderr } = await run(executable, ['--version'], 15_000)
  const version = /(\d+\.\d+\.\d+(?:[-+.\w]*)?)/.exec(`${stdout}\n${stderr}`)?.[1] ?? null
  return { path: executable, version, error: version ? null : 'codex did not report a version.' }
}

export function parseLoginStatus(text: string): CodexAccount {
  const t = text.trim()
  if (/logged in using chatgpt/i.test(t)) return { signedIn: true, mode: 'chatgpt', detail: 'Signed in with a ChatGPT account.' }
  if (/logged in using an? api key/i.test(t)) return { signedIn: true, mode: 'api_key', detail: 'Signed in with an API key: usage is billed to the API, not to the ChatGPT plan.' }
  if (/not logged in/i.test(t)) return { signedIn: false, mode: null, detail: 'Codex is not signed in.' }
  return { signedIn: false, mode: null, detail: redact(t.slice(0, 200)) || 'Codex did not report its sign-in.' }
}

/** Sign-in of one Codex home (default: the Mac's ~/.codex, which the ChatGPT app uses). */
export async function codexAccount(executable: string, home?: string): Promise<CodexAccount> {
  const { stdout, stderr } = await run(executable, ['login', 'status', '-c', 'cli_auth_credentials_store="file"'], 20_000, home ? { ...process.env, CODEX_HOME: home } : process.env)
  return parseLoginStatus(`${stdout}\n${stderr}`)
}

/** Codex's own model list cache (refreshed whenever Codex runs while signed in). */
export function parseModelsCache(text: string): CodexModel[] {
  let data: any
  try { data = JSON.parse(text) } catch { return [] }
  const list: any[] = Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : []
  return list
    .filter(m => typeof m?.slug === 'string' && SAFE_ID.test(m.slug) && (m.visibility ?? 'list') === 'list')
    .map(m => {
      const efforts = (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
        .map((l: any) => String(l?.effort ?? l))
        .filter((e: string) => (CODEX_EFFORTS as readonly string[]).includes(e))
      return {
        id: m.slug,
        label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug,
        efforts,
        defaultEffort: typeof m.default_reasoning_level === 'string' && efforts.includes(m.default_reasoning_level) ? m.default_reasoning_level : null,
        image: Array.isArray(m.input_modalities) ? m.input_modalities.includes('image') : false
      }
    })
}

/** The first readable model cache among [homes] (a newly added account has none until its first run). */
export async function listCodexModels(homes: string | string[] = codexHome()): Promise<CodexModel[]> {
  let text: string | null = null
  for (const home of Array.isArray(homes) ? homes : [homes]) {
    text = await fs.promises.readFile(path.join(home, 'models_cache.json'), 'utf8').catch(() => null)
    if (text !== null) break
  }
  if (text === null) throw new CodexError('failed', 'Codex has no model list yet. Open Codex in the ChatGPT app once (or run any Codex task), then refresh.')
  const models = parseModelsCache(text)
  if (!models.length) throw new CodexError('failed', 'Codex\'s model list is empty or unreadable.')
  return models
}

const toml = (value: string) => JSON.stringify(value)
const tomlArray = (values: string[]) => `[${values.map(toml).join(', ')}]`
const tomlTable = (values: Record<string, string>) => `{ ${Object.entries(values).map(([k, v]) => `${k} = ${toml(v)}`).join(', ')} }`

export function buildCodexArgs(req: Pick<CodexTurnRequest, 'prompt' | 'model' | 'effort' | 'conversationId' | 'mcp'>): string[] {
  if (!SAFE_ID.test(req.model)) throw new CodexError('failed', 'Choose a model from the list.')
  if (req.effort && !(CODEX_EFFORTS as readonly string[]).includes(req.effort)) throw new CodexError('failed', 'Unknown reasoning level.')
  for (const key of Object.keys(req.mcp.env)) if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new CodexError('failed', 'Invalid MCP environment name.')
  const args = ['exec']
  if (req.conversationId) {
    if (!SAFE_ID.test(req.conversationId)) throw new CodexError('failed', 'Invalid conversation ID.')
    args.push('resume')
  }
  args.push(
    '--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    // Each account's sign-in is the auth.json in its own CODEX_HOME (never a shared keychain entry).
    '-c', 'cli_auth_credentials_store="file"',
    '-m', req.model,
    '-c', 'sandbox_mode="read-only"',
    '-c', 'approval_policy="never"',
    '-c', 'web_search="disabled"',
    ...DISABLED_FEATURES.flatMap(f => ['-c', `features.${f}=false`]),
    ...(req.effort ? ['-c', `model_reasoning_effort=${toml(req.effort)}`] : []),
    '-c', `mcp_servers.${CODEX_MCP_SERVER}.command=${toml(req.mcp.command)}`,
    '-c', `mcp_servers.${CODEX_MCP_SERVER}.args=${tomlArray(req.mcp.args)}`,
    '-c', `mcp_servers.${CODEX_MCP_SERVER}.env=${tomlTable(req.mcp.env)}`,
    '-c', `mcp_servers.${CODEX_MCP_SERVER}.default_tools_approval_mode="approve"`,
    // fetch_slice downloads from Drive; give it the same room the bridge allows.
    '-c', `mcp_servers.${CODEX_MCP_SERVER}.tool_timeout_sec=180`,
    '--'
  )
  if (req.conversationId) args.push(req.conversationId)
  args.push(req.prompt)
  return args
}

/** What one turn's JSONL stream said, reduced to what Studio needs (no image bytes kept). */
export interface CodexStreamSummary {
  threadId: string | null
  completed: boolean
  failed: string | null
  errors: string[]
  lastMessage: string
  usage: Record<string, number> | undefined
  denied: { action: string; display_name?: string }[]
  toolCalls: Record<string, number>
}

export function newStreamSummary(): CodexStreamSummary {
  return { threadId: null, completed: false, failed: null, errors: [], lastMessage: '', usage: undefined, denied: [], toolCalls: {} }
}

export function applyStreamLine(summary: CodexStreamSummary, line: string) {
  if (!line.trim()) return
  let event: any
  try { event = JSON.parse(line) } catch { return }
  switch (event?.type) {
    case 'thread.started':
      if (typeof event.thread_id === 'string') summary.threadId = event.thread_id
      break
    case 'item.completed': {
      const item = event.item ?? {}
      if (item.type === 'agent_message' && typeof item.text === 'string') summary.lastMessage = item.text
      else if (item.type === 'mcp_tool_call') {
        const name = `${item.server ?? '?'}/${item.tool ?? '?'}`
        summary.toolCalls[name] = (summary.toolCalls[name] ?? 0) + 1
        const message = String(item.error?.message ?? '')
        if (/approval/i.test(message)) summary.denied.push({ action: name, display_name: `${name} (${message.slice(0, 120)})` })
      } else if (item.type === 'command_execution' || item.type === 'file_change' || item.type === 'web_search') {
        summary.toolCalls[item.type] = (summary.toolCalls[item.type] ?? 0) + 1
        if (item.status === 'declined' || item.status === 'failed') summary.denied.push({ action: item.type, display_name: item.type })
      } else if (item.type === 'error' && typeof item.message === 'string') summary.errors.push(item.message)
      break
    }
    case 'turn.completed':
      summary.completed = true
      if (event.usage && typeof event.usage === 'object') summary.usage = event.usage
      break
    case 'turn.failed':
      summary.failed = String(event.error?.message ?? 'The turn failed.')
      break
    case 'error':
      if (typeof event.message === 'string') summary.errors.push(event.message)
      break
  }
}

/** The agy-shaped envelope the job engine already understands. */
export function toEnvelope(summary: CodexStreamSummary): AgyEnvelope | null {
  if (!summary.threadId && !summary.completed && !summary.failed && !summary.errors.length) return null
  const status = summary.completed && !summary.failed ? 'SUCCESS' : 'ERROR'
  const error = summary.failed ?? (status === 'ERROR' ? summary.errors.at(-1) ?? 'The turn did not complete.' : undefined)
  return {
    conversation_id: summary.threadId ?? '',
    status,
    response: summary.lastMessage,
    ...(error && { error: redact(error.slice(0, 1000)) }),
    ...(summary.denied.length && { denied_actions: summary.denied }),
    num_turns: 1,
    usage: summary.usage
  }
}

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch {
    try { process.kill(pid, signal) } catch { /* already gone */ }
  }
}

/** Run one headless Codex turn. Never throws for CLI failures. */
export function runCodexTurn(req: CodexTurnRequest): Promise<AgyTurnResult & { summary: CodexStreamSummary }> {
  const args = buildCodexArgs(req)
  const started = Date.now()
  return new Promise(resolve => {
    const child = spawn(req.executable, args, { cwd: req.cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: req.env ?? process.env })
    const summary = newStreamSummary()
    let buffer = ''
    let skipping = false
    let stderr = ''
    let timedOut = false
    let cancelled = false
    let killTimer: NodeJS.Timeout | null = null
    if (child.pid) req.onSpawn?.(child.pid)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (skipping) { skipping = false; continue }
        applyStreamLine(summary, line)
      }
      // A runaway line (should not happen): drop it rather than grow without bound.
      if (buffer.length > MAX_LINE) { buffer = ''; skipping = true }
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-MAX_STDERR) })
    const stop = () => {
      if (!child.pid) return
      killGroup(child.pid, 'SIGTERM')
      killTimer = setTimeout(() => child.pid && killGroup(child.pid, 'SIGKILL'), 5000)
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, req.timeoutMs)
    const onAbort = () => { cancelled = true; stop() }
    req.signal?.addEventListener('abort', onAbort, { once: true })
    let done = false
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (done) return
      done = true
      if (buffer && !skipping) applyStreamLine(summary, buffer)
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      req.signal?.removeEventListener('abort', onAbort)
      let envelope = toEnvelope(summary)
      if (!envelope && exitCode !== 0 && stderr.trim()) envelope = { conversation_id: '', status: 'ERROR', response: '', error: redact(stderr.trim().slice(-600)) }
      resolve({ exitCode, signal, envelope, stderrTail: redact(stderr.slice(-1500)), timedOut, cancelled, pid: child.pid ?? null, durationMs: Date.now() - started, summary })
    }
    child.on('error', () => finish(null, null))
    child.on('close', finish)
    if (req.signal?.aborted) onAbort()
  })
}
