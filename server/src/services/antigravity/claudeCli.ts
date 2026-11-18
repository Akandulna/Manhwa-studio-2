/**
 * Claude through the local Claude Code CLI (`claude`) — the third AntiGravity engine.
 *
 * Same job contract as agy (cli.ts) and Codex (codexCli.ts): one page = one
 * conversation; slices come from Studio's MCP bridge (resources/antigravity/
 * job-mcp.mjs) and results are only accepted through its submit tools. Claude
 * Code keeps its own claude.ai sign-in (macOS Keychain / ~/.claude); Studio
 * never reads or stores those credentials.
 *
 * Observed live on Claude Code 2.1.178 (2026-11-10, Pro plan):
 *   - `claude -p --output-format stream-json --verbose` prints JSONL:
 *     system/init {session_id, model, tools, mcp_servers[{name,status}]},
 *     rate_limit_event {rate_limit_info {status, resetsAt (unix s), rateLimitType}},
 *     assistant {message {model, content [text | tool_use {name} | thinking]}},
 *     user {message {content [tool_result …]}} (MCP images arrive here as base64),
 *     result {subtype, is_error, api_error_status, result, num_turns, usage, permission_denials}.
 *   - `--resume <session_id>` continues that exact conversation and keeps its id
 *     (only --fork-session makes a new one). It must run from the same cwd.
 *   - With `--tools ""` there are no built-in tools at all (no Bash/Read/Edit/Web);
 *     `--strict-mcp-config --mcp-config <file>` loads only Studio's server, and
 *     `--allowedTools mcp__studio` + `--permission-mode dontAsk` lets exactly its
 *     tools run with nothing else to approve.
 *   - MCP image results are shown to the model directly (probe code, shape and
 *     colour read correctly; no file offloading as with agy).
 *   - An unknown model: exit 1, result is_error with api_error_status 404
 *     "There's an issue with the selected model (…). It may not exist…".
 *   - `--setting-sources ""` skips user/project/local settings (hooks, plugins,
 *     permissions); auth still comes from the normal sign-in.
 * The prompt goes on stdin (no argv size limit, never read as a flag).
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redact } from '../googleDrive/errors.js'
import { SAFE_ID, type AgyEnvelope, type AgyInstallation, type AgyTurnResult } from './cli.js'

export const CLAUDE_MCP_SERVER = 'studio'
/** Efforts Claude Code's --effort accepts. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export interface ClaudeModel {
  id: string
  label: string
  efforts: string[]
  defaultEffort: string | null
  /** The model accepts image input (required: pages arrive as images). Every current Claude model does. */
  image: boolean
}

/**
 * Claude Code has no model-list command; these are the current models (full ids, so a run's model
 * never drifts with an alias). Which ones a plan can use is proven by the compatibility test.
 */
export const CLAUDE_MODELS: ClaudeModel[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: [...CLAUDE_EFFORTS], defaultEffort: null, image: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', efforts: [...CLAUDE_EFFORTS], defaultEffort: null, image: true },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2', efforts: [...CLAUDE_EFFORTS], defaultEffort: null, image: true },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', efforts: [...CLAUDE_EFFORTS], defaultEffort: null, image: true }
]

export interface ClaudeAccount {
  signedIn: boolean
  /** "claude.ai" = subscription sign-in (Pro/Max usage limits); anything else (API key, console) bills differently. */
  method: string | null
  email: string | null
  /** pro, max, team… as Claude Code reports it. */
  subscription: string | null
  detail: string
}

export interface ClaudeMcpServer {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface ClaudeTurnRequest {
  executable: string
  /** Must stay the same for every turn of a conversation (Claude Code stores sessions per directory). */
  cwd: string
  prompt: string
  model: string
  effort?: string | null
  /** Resume exactly this session; never --continue. */
  conversationId?: string | null
  /** Path of the 0600 MCP config file holding Studio's server (written per attempt). */
  mcpConfigPath: string
  timeoutMs: number
  signal?: AbortSignal
  /** Extra env (e.g. CLAUDE_CONFIG_DIR); the parent's Claude Code variables are always removed. */
  env?: NodeJS.ProcessEnv
  onSpawn?: (pid: number) => void
}

export class ClaudeError extends Error {
  constructor(readonly code: 'not_installed' | 'auth_required' | 'failed', message: string) {
    super(redact(message))
  }
}

const MAX_STDERR = 64 * 1024
/** One JSONL line can carry a whole slice image (base64) from an MCP result; cap what is kept in memory. */
const MAX_LINE = 64 * 1024 * 1024

export const claudeConfigDir = (env: NodeJS.ProcessEnv = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

/**
 * The environment every Studio `claude` process gets. Variables a parent Claude Code session sets
 * (CLAUDECODE, CLAUDE_CODE_*, its session/socket ids) are dropped so a job never attaches to, or is
 * mistaken for, someone's interactive session; API keys are dropped so work counts against the
 * claude.ai plan the operator signed in with, never an API bill.
 */
export function claudeEnv(base: NodeJS.ProcessEnv = process.env, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (/^CLAUDE/.test(key) && key !== 'CLAUDE_CONFIG_DIR') continue
    if (key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_AUTH_TOKEN') continue
    env[key] = value
  }
  return {
    ...env,
    // Wait for Studio's MCP server before the model's first request. Observed live (2026-11-10): by default
    // `claude -p` starts the model while MCP servers are still "pending", so with several processes launching
    // together the model had no tools ("I don't have fetch_slice") and the page failed. 8/8 connect with this.
    MCP_CONNECTION_NONBLOCKING: 'false',
    MCP_TIMEOUT: '60000',
    // fetch_slice downloads from Drive: give it the same room the bridge allows.
    MCP_TOOL_TIMEOUT: '180000',
    // A tall slice is one large image block; never let Claude Code truncate or offload a tool result.
    MAX_MCP_OUTPUT_TOKENS: '60000',
    // Never update the CLI underneath a running page.
    DISABLE_AUTOUPDATER: '1',
    ...extra
  }
}

const isExec = (file: string) => {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

export function findClaudeExecutable(override: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (override) return path.isAbsolute(override) && isExec(override) ? override : null
  const home = os.homedir()
  const dirs = [path.join(home, '.local', 'bin'), ...(env.PATH ?? '').split(path.delimiter), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean)
  for (const dir of dirs) {
    const file = path.join(dir, 'claude')
    if (isExec(file)) return file
  }
  return null
}

function run(executable: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv = claudeEnv()): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(executable, args, { cwd: os.tmpdir(), timeout: timeoutMs, maxBuffer: 1024 * 1024, env }, (error, stdout, stderr) => {
      const code = error && typeof (error as NodeJS.ErrnoException).code === 'number' ? ((error as unknown as { code: number }).code) : error ? null : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export async function detectClaude(override?: string | null): Promise<AgyInstallation> {
  const executable = findClaudeExecutable(override)
  if (!executable) {
    return { path: null, version: null, error: override ? 'The configured claude path is not an executable file.' : 'Claude Code was not found. Install it (claude.com/claude-code) or set the claude path.' }
  }
  const { stdout, stderr } = await run(executable, ['--version'], 15_000)
  const version = /(\d+\.\d+\.\d+(?:[-+.\w]*)?)/.exec(`${stdout}\n${stderr}`)?.[1] ?? null
  return { path: executable, version, error: version ? null : 'claude did not report a version.' }
}

/** `claude auth status` prints JSON (observed: loggedIn, authMethod, email, subscriptionType…). */
export function parseAuthStatus(text: string): ClaudeAccount {
  const start = text.indexOf('{')
  let data: any = null
  if (start >= 0) {
    try { data = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)) } catch { data = null }
  }
  if (!data || typeof data !== 'object') {
    if (/not (logged|signed) in/i.test(text)) return { signedIn: false, method: null, email: null, subscription: null, detail: 'Claude Code is not signed in.' }
    return { signedIn: false, method: null, email: null, subscription: null, detail: redact(text.trim().slice(0, 200)) || 'Claude Code did not report its sign-in.' }
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  const method = str(data.authMethod)
  const email = str(data.email)
  const subscription = str(data.subscriptionType)
  if (data.loggedIn !== true) return { signedIn: false, method, email, subscription, detail: 'Claude Code is not signed in.' }
  const plan = subscription ? ` (${subscription[0].toUpperCase()}${subscription.slice(1)} plan)` : ''
  const detail = method === 'claude.ai'
    ? `Signed in with Claude${email ? ` as ${email}` : ''}${plan}.`
    : `Signed in with ${method ?? 'an unknown method'}${email ? ` as ${email}` : ''}: usage may be billed to the API instead of a Claude plan.`
  return { signedIn: true, method, email, subscription, detail }
}

export async function claudeAccount(executable: string, env?: NodeJS.ProcessEnv): Promise<ClaudeAccount> {
  const { stdout, stderr } = await run(executable, ['auth', 'status'], 20_000, claudeEnv(process.env, env))
  return parseAuthStatus(`${stdout}\n${stderr}`)
}

/** Studio's MCP server as Claude Code loads it for one attempt (--mcp-config). */
export function claudeMcpConfig(server: ClaudeMcpServer): string {
  for (const key of Object.keys(server.env)) if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new ClaudeError('failed', 'Invalid MCP environment name.')
  return JSON.stringify({ mcpServers: { [CLAUDE_MCP_SERVER]: { type: 'stdio', command: server.command, args: server.args, env: server.env } } }, null, 2)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function buildClaudeArgs(req: Pick<ClaudeTurnRequest, 'model' | 'effort' | 'conversationId' | 'mcpConfigPath'>): string[] {
  if (!SAFE_ID.test(req.model)) throw new ClaudeError('failed', 'Choose a model from the list.')
  if (req.effort && !(CLAUDE_EFFORTS as readonly string[]).includes(req.effort)) throw new ClaudeError('failed', 'Unknown reasoning level.')
  if (!path.isAbsolute(req.mcpConfigPath)) throw new ClaudeError('failed', 'The MCP config path must be absolute.')
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', req.model,
    ...(req.effort ? ['--effort', req.effort] : []),
    // No user/project/local settings: none of the operator's hooks, plugins or permission rules.
    '--setting-sources', '',
    // No built-in tools at all (shell, files, web, agents…); only Studio's MCP server, pre-approved.
    '--tools', '',
    '--strict-mcp-config', '--mcp-config', req.mcpConfigPath,
    '--allowedTools', `mcp__${CLAUDE_MCP_SERVER}`,
    '--permission-mode', 'dontAsk',
    '--disable-slash-commands', '--no-chrome'
  ]
  if (req.conversationId) {
    if (!UUID.test(req.conversationId)) throw new ClaudeError('failed', 'Invalid conversation ID.')
    args.push('--resume', req.conversationId)
  }
  return args
}

/** One usage window as Claude Code last reported it (rate_limit_event). Claude reports status, not a percentage. */
export interface ClaudeRateLimit {
  /** five_hour, seven_day, seven_day_opus… */
  type: string
  /** allowed | allowed_warning | rejected */
  status: string
  resetsAt: string | null
  /** 0–1 when Claude Code includes it (near a limit); null otherwise. */
  utilization: number | null
  at: string
}

export function parseRateLimitInfo(info: any, at = new Date().toISOString()): ClaudeRateLimit | null {
  if (!info || typeof info !== 'object' || typeof info.status !== 'string') return null
  const reset = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : null
  return {
    type: typeof info.rateLimitType === 'string' ? info.rateLimitType : 'unknown',
    status: info.status,
    resetsAt: reset,
    utilization: typeof info.utilization === 'number' ? info.utilization : null,
    at
  }
}

/** What one turn's stream said, reduced to what Studio needs (no image bytes kept). */
export interface ClaudeStreamSummary {
  sessionId: string | null
  model: string | null
  /** Studio's MCP server status from system/init (connected | failed | …). */
  mcpStatus: string | null
  result: { subtype: string; isError: boolean; text: string; apiErrorStatus: number | null; numTurns: number | null; usage: Record<string, number> | undefined; denials: string[] } | null
  lastText: string
  toolCalls: Record<string, number>
  /** Newest rate_limit_event per window type. */
  rateLimits: ClaudeRateLimit[]
  errors: string[]
}

export function newClaudeSummary(): ClaudeStreamSummary {
  return { sessionId: null, model: null, mcpStatus: null, result: null, lastText: '', toolCalls: {}, rateLimits: [], errors: [] }
}

export function applyClaudeLine(summary: ClaudeStreamSummary, line: string) {
  if (!line.trim()) return
  let event: any
  try { event = JSON.parse(line) } catch { return }
  if (typeof event?.session_id === 'string' && UUID.test(event.session_id)) summary.sessionId ??= event.session_id
  switch (event?.type) {
    case 'system':
      if (event.subtype === 'init') {
        if (typeof event.session_id === 'string') summary.sessionId = event.session_id
        if (typeof event.model === 'string') summary.model = event.model
        const studio = Array.isArray(event.mcp_servers) ? event.mcp_servers.find((s: any) => s?.name === CLAUDE_MCP_SERVER) : null
        summary.mcpStatus = studio ? String(studio.status ?? 'unknown') : 'missing'
      }
      break
    case 'rate_limit_event': {
      const limit = parseRateLimitInfo(event.rate_limit_info)
      if (limit) summary.rateLimits = [...summary.rateLimits.filter(l => l.type !== limit.type), limit]
      break
    }
    case 'assistant': {
      const message = event.message ?? {}
      if (typeof message.model === 'string' && message.model !== '<synthetic>') summary.model = message.model
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === 'tool_use') {
          const name = String(block.name ?? '?')
          summary.toolCalls[name] = (summary.toolCalls[name] ?? 0) + 1
        } else if (block?.type === 'text' && typeof block.text === 'string') summary.lastText = block.text
      }
      break
    }
    case 'result':
      summary.result = {
        subtype: String(event.subtype ?? ''),
        isError: event.is_error === true || (typeof event.subtype === 'string' && event.subtype.startsWith('error')),
        text: typeof event.result === 'string' ? event.result : '',
        apiErrorStatus: typeof event.api_error_status === 'number' ? event.api_error_status : null,
        numTurns: typeof event.num_turns === 'number' ? event.num_turns : null,
        usage: event.usage && typeof event.usage === 'object' ? flatUsage(event.usage) : undefined,
        denials: Array.isArray(event.permission_denials) ? event.permission_denials.map((d: any) => String(d?.tool_name ?? '?')) : []
      }
      if (Array.isArray(event.errors)) for (const e of event.errors) if (typeof e === 'string') summary.errors.push(e)
      break
  }
}

const flatUsage = (usage: Record<string, unknown>) => Object.fromEntries(Object.entries(usage).filter(([, v]) => typeof v === 'number')) as Record<string, number>

/** A refused window means the plan's limit is reached. */
export const rejectedLimit = (summary: Pick<ClaudeStreamSummary, 'rateLimits'>) => summary.rateLimits.find(l => l.status === 'rejected') ?? null

/** The agy-shaped envelope the job engine already understands. */
export function toClaudeEnvelope(summary: ClaudeStreamSummary): AgyEnvelope | null {
  if (!summary.sessionId && !summary.result && !summary.errors.length) return null
  const result = summary.result
  const ok = !!result && !result.isError
  let error: string | undefined
  if (!ok) {
    const limit = rejectedLimit(summary)
    const parts = [
      result?.text || summary.errors.at(-1) || (result ? `The turn ended with ${result.subtype}.` : 'The turn did not complete.'),
      result?.apiErrorStatus ? `(HTTP ${result.apiErrorStatus})` : '',
      limit ? `Claude usage limit reached (${limit.type.replace(/_/g, ' ')}${limit.resetsAt ? `, resets ${limit.resetsAt}` : ''}).` : '',
      summary.mcpStatus && summary.mcpStatus !== 'connected' ? `Studio's MCP server ${summary.mcpStatus}.` : ''
    ]
    error = redact(parts.filter(Boolean).join(' ').slice(0, 1000))
  }
  // Only Studio's tools exist in a job; anything else that was attempted or refused is reported.
  const foreign = Object.keys(summary.toolCalls).filter(name => !name.startsWith(`mcp__${CLAUDE_MCP_SERVER}__`))
  const denied = [...(result?.denials ?? []), ...foreign].map(action => ({ action, display_name: action }))
  return {
    conversation_id: summary.sessionId ?? '',
    status: ok ? 'SUCCESS' : 'ERROR',
    response: result?.text || summary.lastText,
    ...(error && { error }),
    ...(denied.length && { denied_actions: denied }),
    num_turns: result?.numTurns ?? 1,
    usage: result?.usage
  }
}

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch {
    try { process.kill(pid, signal) } catch { /* already gone */ }
  }
}

export type ClaudeTurnResult = AgyTurnResult & { claude: ClaudeStreamSummary }

/** A turn whose Studio MCP server was not connected when the model started did nothing: it is started again. */
export const MCP_START_ATTEMPTS = 3

/** Run one headless Claude Code turn. Never throws for CLI failures. */
export async function runClaudeTurn(req: ClaudeTurnRequest): Promise<ClaudeTurnResult> {
  let result = await runClaudeTurnOnce(req)
  for (let again = 1; again < MCP_START_ATTEMPTS && result.claude.mcpStatus !== null && result.claude.mcpStatus !== 'connected' && !result.cancelled && !result.timedOut && !req.signal?.aborted; again++) {
    await new Promise(r => setTimeout(r, 500 * again))
    result = await runClaudeTurnOnce(req)
  }
  return result
}

function runClaudeTurnOnce(req: ClaudeTurnRequest): Promise<ClaudeTurnResult> {
  const args = buildClaudeArgs(req)
  const started = Date.now()
  return new Promise(resolve => {
    const child = spawn(req.executable, args, { cwd: req.cwd, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: claudeEnv(process.env, req.env) })
    const summary = newClaudeSummary()
    let buffer = ''
    let skipping = false
    let stderr = ''
    let timedOut = false
    let cancelled = false
    let stopped = false
    let killTimer: NodeJS.Timeout | null = null
    if (child.pid) req.onSpawn?.(child.pid)
    child.stdin.on('error', () => undefined)
    child.stdin.end(req.prompt)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (skipping) { skipping = false; continue }
        applyClaudeLine(summary, line)
        // The model would run without Studio's tools: stop now (nothing was asked of it yet) so the turn can be restarted.
        if (summary.mcpStatus !== null && summary.mcpStatus !== 'connected' && !stopped) { stopped = true; stop() }
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
      if (buffer && !skipping) applyClaudeLine(summary, buffer)
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      req.signal?.removeEventListener('abort', onAbort)
      let envelope = toClaudeEnvelope(summary)
      if (!envelope && exitCode !== 0 && stderr.trim()) envelope = { conversation_id: '', status: 'ERROR', response: '', error: redact(stderr.trim().slice(-600)) }
      resolve({ exitCode, signal, envelope, stderrTail: redact(stderr.slice(-1500)), timedOut, cancelled, pid: child.pid ?? null, durationMs: Date.now() - started, claude: summary })
    }
    child.on('error', () => finish(null, null))
    child.on('close', finish)
    if (req.signal?.aborted) onAbort()
  })
}

// ─── Session evidence (Claude Code's own transcript) ───

/**
 * Claude Code writes each session to <config>/projects/<cwd with every non-alphanumeric
 * character replaced by "-">/<session id>.jsonl. Very long paths are shortened by the CLI,
 * so the folder is also searched for by file name.
 */
export const projectFolderName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

export async function findClaudeTranscript(sessionId: string, cwd: string | null, configDir = claudeConfigDir()): Promise<string | null> {
  if (!UUID.test(sessionId)) return null
  const root = path.join(configDir, 'projects')
  const name = `${sessionId}.jsonl`
  if (cwd) {
    // macOS reports /tmp as /private/tmp, and the CLI names the folder after the real path.
    for (const candidate of new Set([cwd, safeRealpath(cwd)])) {
      const file = path.join(root, projectFolderName(candidate), name)
      if (await fs.promises.access(file).then(() => true, () => false)) return file
    }
  }
  for (const dir of await fs.promises.readdir(root).catch(() => [] as string[])) {
    const file = path.join(root, dir, name)
    if (await fs.promises.access(file).then(() => true, () => false)) return file
  }
  return null
}

const safeRealpath = (p: string) => { try { return fs.realpathSync.native(p) } catch { return p } }

export interface ClaudeSessionEvidence {
  studio: Record<string, number>
  unexpected: string[]
  model: string | null
}

export function summarizeTranscript(lines: string[]): ClaudeSessionEvidence {
  const out: ClaudeSessionEvidence = { studio: {}, unexpected: [], model: null }
  const prefix = `mcp__${CLAUDE_MCP_SERVER}__`
  for (const line of lines) {
    if (!line.includes('"assistant"')) continue
    let row: any
    try { row = JSON.parse(line) } catch { continue }
    if (row?.type !== 'assistant') continue
    const message = row.message ?? {}
    if (typeof message.model === 'string' && message.model !== '<synthetic>') out.model = message.model
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type !== 'tool_use') continue
      const name = String(block.name ?? '?')
      if (name.startsWith(prefix)) out.studio[name.slice(prefix.length)] = (out.studio[name.slice(prefix.length)] ?? 0) + 1
      else out.unexpected.push(name.slice(0, 120))
    }
  }
  return out
}

export async function readClaudeEvidence(sessionId: string, cwd: string | null, configDir?: string): Promise<ClaudeSessionEvidence | null> {
  const file = await findClaudeTranscript(sessionId, cwd, configDir)
  if (!file) return null
  const text = await fs.promises.readFile(file, 'utf8').catch(() => null)
  return text === null ? null : summarizeTranscript(text.split('\n'))
}

export function describeClaudeLimits(limits: ClaudeRateLimit[]): string {
  if (!limits.length) return 'Claude limits: not reported'
  return `Claude limits: ${limits.map(l => `${l.type.replace(/_/g, ' ')} ${l.status.replace(/_/g, ' ')}${l.utilization !== null ? ` (${Math.round(l.utilization * 100)}% used)` : ''}`).join(', ')}`
}

export function describeClaudeEvidence(e: ClaudeSessionEvidence, limits: ClaudeRateLimit[] = []): string {
  const studio = Object.entries(e.studio).map(([tool, n]) => `${tool}×${n}`).join(', ') || 'none'
  const unexpected = e.unexpected.length ? `; UNEXPECTED: ${[...new Set(e.unexpected)].slice(0, 5).join(', ')}` : '; nothing unexpected'
  return `tools used — studio: ${studio}${unexpected}${e.model ? `; model ${e.model}` : ''}${limits.length ? `; ${describeClaudeLimits(limits)}` : ''}`
}

// ─── Plan usage (`claude -p "/usage"`) ───

/**
 * One usage window from Claude Code's /usage. Observed on 2.1.178 (Pro, 2026-11-10), printed in the
 * result text of `claude -p --output-format json` with stdin "/usage" — no model turn, no cost:
 *   "Current session: 74% used · resets Nov 10 at 10:40pm (Asia/Calcutta)"
 *   "Current week (all models): 9% used · resets Nov 11 at 6:30am (Asia/Calcutta)"
 */
export interface ClaudeUsageWindow {
  /** As Claude Code names it: "Current session", "Current week (all models)", … */
  label: string
  usedPercent: number
  resetsAt: string | null
}

export interface ClaudeUsage {
  at: string
  windows: ClaudeUsageWindow[]
  /** The first line, e.g. "You are currently using your subscription to power your Claude Code usage". */
  source: string | null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** "Nov 10 at 10:40pm", "10:40pm", "Nov 11" → ISO in this Mac's time zone (the CLI prints the same zone). */
export function parseResetTime(text: string, now = new Date()): string | null {
  const t = text.replace(/\([^)]*\)/g, '').trim().toLowerCase()
  const date = /\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})\b/.exec(t)
  const time = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(t)
  if (!date && !time) return null
  let hours = 0
  let minutes = 0
  if (time) {
    hours = Number(time[1]) % 12 + (time[3] === 'pm' ? 12 : 0)
    minutes = Number(time[2] ?? 0)
  }
  const month = date ? MONTHS.indexOf(date[1]) : now.getMonth()
  if (month < 0) return null
  const day = date ? Number(date[2]) : now.getDate()
  const at = new Date(now.getFullYear(), month, day, hours, minutes, 0, 0)
  // A reset is always ahead: "Jan 2" seen in late December is next year; a bare time already passed is tomorrow.
  if (at.getTime() < now.getTime() - 60_000) {
    if (date) at.setFullYear(at.getFullYear() + 1)
    else at.setDate(at.getDate() + 1)
  }
  return at.toISOString()
}

export function parseClaudeUsage(text: string, at = new Date()): ClaudeUsage | null {
  const windows: ClaudeUsageWindow[] = []
  for (const raw of text.split('\n')) {
    const m = /^\s*([^:\n]{2,80}):\s*(\d{1,3}(?:\.\d+)?)%\s*used(?:\s*[·•-]\s*resets\s+(.+))?\s*$/i.exec(raw)
    if (!m) continue
    windows.push({ label: m[1].trim(), usedPercent: Math.min(100, Number(m[2])), resetsAt: m[3] ? parseResetTime(m[3], at) : null })
  }
  if (!windows.length) return null
  const source = text.split('\n').map(l => l.trim()).find(Boolean) ?? null
  return { at: at.toISOString(), windows, source: source && !source.includes('% used') ? source.slice(0, 200) : null }
}

/** The plan's usage windows, live from Claude Code (no model turn; nothing saved as a session). */
export async function readClaudeUsage(executable: string, env?: NodeJS.ProcessEnv): Promise<ClaudeUsage> {
  const text = await new Promise<string>((resolve, reject) => {
    const child = execFile(executable, ['-p', '--output-format', 'json', '--setting-sources', '', '--tools', '', '--no-session-persistence'], { cwd: os.tmpdir(), timeout: 60_000, maxBuffer: 1024 * 1024, env: claudeEnv(process.env, env) }, (error, stdout, stderr) => {
      if (error && !stdout) return reject(new ClaudeError('failed', `claude /usage failed: ${String(stderr || error.message).slice(-300)}`))
      resolve(String(stdout))
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end('/usage')
  })
  let result = text
  try {
    const json = JSON.parse(text)
    if (json?.is_error) throw new ClaudeError(/log ?in|auth/i.test(String(json.result)) ? 'auth_required' : 'failed', String(json.result ?? 'claude /usage failed.').slice(0, 300))
    result = String(json?.result ?? '')
  } catch (error) {
    if (error instanceof ClaudeError) throw error
  }
  const usage = parseClaudeUsage(result)
  if (!usage) throw new ClaudeError('failed', `Claude Code's /usage reported no limits: ${redact(result.trim().slice(0, 200)) || 'empty reply'}`)
  return usage
}
