/**
 * The Studio Agent's brain: one plain-text turn on whichever local CLI AI engine is available
 * (Claude Code, Codex/ChatGPT, Antigravity). No tools are given to the CLI itself — every built-in
 * tool is switched off — the agent only returns text, and Studio runs any actions it asks for
 * (see agent.ts). Credentials stay with each CLI; Studio never reads them.
 */

import { spawn } from 'node:child_process'
import os from 'node:os'
import { redact } from '../googleDrive/errors.js'
import { SAFE_ID, detectInstallation, listModels, parseEnvelope, type AgyModel } from '../antigravity/cli.js'
import { CLAUDE_MODELS, claudeAccount, claudeEnv, detectClaude } from '../antigravity/claudeCli.js'
import { DISABLED_FEATURES, applyStreamLine, codexAccount, detectCodex, listCodexModels, newStreamSummary, toEnvelope } from '../antigravity/codexCli.js'

export type AgentEngineId = 'claude' | 'codex' | 'antigravity'
export const AGENT_ENGINE_IDS: readonly AgentEngineId[] = ['claude', 'codex', 'antigravity']
export const AGENT_ENGINE_LABELS: Record<AgentEngineId, string> = { claude: 'Claude (Claude Code)', codex: 'ChatGPT (Codex)', antigravity: 'Antigravity' }

export interface EngineStatus {
  id: AgentEngineId
  label: string
  available: boolean
  detail: string
  models: { id: string; label: string }[]
}

export interface EngineChoice {
  /** Absolute CLI paths the operator already configured for AntiGravity (null = auto-detect). */
  paths: Partial<Record<AgentEngineId, string | null>>
}

export class AgentEngineError extends Error {
  constructor(readonly code: 'none_available' | 'failed' | 'timeout' | 'cancelled', message: string) {
    super(redact(message))
  }
}

const MAX_OUTPUT = 4 * 1024 * 1024

function killGroup(pid: number, signal: NodeJS.Signals) {
  try { process.kill(-pid, signal) } catch { try { process.kill(pid, signal) } catch { /* already gone */ } }
}

interface Spawned { code: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean }

function spawnText(executable: string, args: string[], opts: { stdin?: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<Spawned> {
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd: os.tmpdir(), shell: false, detached: true, stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: opts.env })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false
    let kill: NodeJS.Timeout | null = null
    const stop = () => {
      if (!child.pid) return
      killGroup(child.pid, 'SIGTERM')
      kill = setTimeout(() => child.pid && killGroup(child.pid, 'SIGKILL'), 5000)
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, opts.timeoutMs)
    const onAbort = () => { cancelled = true; stop() }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', c => { if (stdout.length < MAX_OUTPUT) stdout += c })
    child.stderr?.on('data', c => { stderr = (stderr + c).slice(-8192) })
    let done = false
    const finish = (code: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (kill) clearTimeout(kill)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr, timedOut, cancelled })
    }
    child.on('error', () => finish(null))
    child.on('close', finish)
    if (opts.stdin !== undefined) {
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(opts.stdin)
    }
    if (opts.signal?.aborted) onAbort()
  })
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
function checkEffort(effort: string | null) {
  if (effort && !EFFORTS.includes(effort)) throw new AgentEngineError('failed', 'Unknown effort level.')
}

/** Effort null = each CLI's own default. */
export function claudeChatArgs(model: string | null, effort: string | null = null): string[] {
  checkEffort(effort)
  if (model && !SAFE_ID.test(model)) throw new AgentEngineError('failed', 'Choose a model from the list.')
  return [
    '-p', '--output-format', 'json',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    '--setting-sources', '', '--tools', '', '--strict-mcp-config',
    '--permission-mode', 'dontAsk', '--disable-slash-commands', '--no-chrome'
  ]
}

export function codexChatArgs(model: string | null, prompt: string, effort: string | null = null): string[] {
  checkEffort(effort)
  if (model && !SAFE_ID.test(model)) throw new AgentEngineError('failed', 'Choose a model from the list.')
  return [
    'exec', '--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '-c', 'cli_auth_credentials_store="file"',
    ...(model ? ['-m', model] : []),
    ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
    ...DISABLED_FEATURES.flatMap(f => ['-c', `features.${f}=false`]),
    '--', prompt
  ]
}

export function agyChatArgs(model: string | null, prompt: string, effort: string | null = null): string[] {
  checkEffort(effort)
  if (model && !SAFE_ID.test(model)) throw new AgentEngineError('failed', 'Choose a model from the list.')
  return ['--print', prompt, '--output-format', 'json', ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), '--disable-slash-commands', '--sandbox']
}

/** Start-up chatter the CLIs print on stderr even when nothing is wrong (never an error reason). */
const STDERR_NOISE = [/^Reading (additional )?(input|prompt) from stdin\.*$/i]

/** Stderr without the harmless start-up lines. */
export function stderrReason(stderr: string): string {
  return stderr.split('\n').map(l => l.trim()).filter(l => l && !STDERR_NOISE.some(re => re.test(l))).join('\n')
}

/** Why a CLI gave no usable reply: the error inside its own output first, then real stderr, then raw stdout. */
export function failureReason(engine: AgentEngineId, stdout: string, stderr: string, fallback: string): string {
  const reported = replyError(engine, stdout)
  return redact((reported || stderrReason(stderr) || stdout.trim() || fallback).slice(-400))
}

/** The error message a CLI put in its own (JSON) output, if any. */
export function replyError(engine: AgentEngineId, stdout: string): string | null {
  if (engine === 'claude') {
    const start = stdout.indexOf('{')
    if (start < 0) return null
    try {
      const data = JSON.parse(stdout.slice(start, stdout.lastIndexOf('}') + 1))
      if (data?.is_error === true) return typeof data.result === 'string' && data.result.trim() ? data.result.trim() : 'Claude Code reported an error.'
      return null
    } catch { return null }
  }
  if (engine === 'codex') {
    const summary = newStreamSummary()
    for (const line of stdout.split('\n')) applyStreamLine(summary, line)
    const envelope = toEnvelope(summary)
    if (!envelope) return null
    if (envelope.error) return envelope.error
    return envelope.status === 'SUCCESS' && !envelope.response ? 'ChatGPT finished without writing an answer.' : null
  }
  const envelope = parseEnvelope(stdout) as { status?: string; error?: unknown; response?: unknown } | null
  if (!envelope || envelope.status === 'SUCCESS') return null
  return typeof envelope.error === 'string' && envelope.error.trim() ? envelope.error.trim() : `Antigravity ended with status ${envelope.status ?? 'unknown'}.`
}

export async function runAgentTurn(engine: AgentEngineId, req: { executable: string; model: string | null; effort?: string | null; prompt: string; timeoutMs: number; signal?: AbortSignal; /** Extra environment, e.g. CODEX_HOME to run as another ChatGPT account. */ env?: NodeJS.ProcessEnv }): Promise<string> {
  let spawned: Spawned
  if (engine === 'claude') {
    spawned = await spawnText(req.executable, claudeChatArgs(req.model, req.effort ?? null), { stdin: req.prompt, env: claudeEnv(process.env, req.env), timeoutMs: req.timeoutMs, signal: req.signal })
  } else if (engine === 'codex') {
    spawned = await spawnText(req.executable, codexChatArgs(req.model, req.prompt, req.effort ?? null), { env: { ...process.env, ...req.env }, timeoutMs: req.timeoutMs, signal: req.signal })
  } else {
    spawned = await spawnText(req.executable, agyChatArgs(req.model, req.prompt, req.effort ?? null), { env: { ...process.env, ...req.env }, timeoutMs: req.timeoutMs, signal: req.signal })
  }
  if (spawned.cancelled) throw new AgentEngineError('cancelled', 'Stopped.')
  if (spawned.timedOut) throw new AgentEngineError('timeout', `${AGENT_ENGINE_LABELS[engine]} took too long to answer.`)
  const text = extractReply(engine, spawned.stdout)
  if (text === null) throw new AgentEngineError('failed', failureReason(engine, spawned.stdout, spawned.stderr, `${AGENT_ENGINE_LABELS[engine]} returned no answer.`))
  return text
}

/** Pull the model's reply text out of each CLI's output format. Null = no usable reply. */
export function extractReply(engine: AgentEngineId, stdout: string): string | null {
  if (engine === 'claude') {
    const start = stdout.indexOf('{')
    if (start < 0) return null
    try {
      const data = JSON.parse(stdout.slice(start, stdout.lastIndexOf('}') + 1))
      if (data?.is_error === true || typeof data?.result !== 'string') return null
      return data.result
    } catch { return null }
  }
  if (engine === 'codex') {
    const summary = newStreamSummary()
    for (const line of stdout.split('\n')) applyStreamLine(summary, line)
    const envelope = toEnvelope(summary)
    return envelope && envelope.status !== 'ERROR' && envelope.response ? envelope.response : null
  }
  const envelope = parseEnvelope(stdout)
  return envelope && envelope.status === 'SUCCESS' && typeof envelope.response === 'string' ? envelope.response : null
}

const cache = new Map<string, { at: number; value: EngineStatus[] }>()
const CACHE_MS = 60_000

/** Which engines are installed and signed in right now (cached for a minute; `fresh` re-checks). */
export async function engineStatuses(choice: EngineChoice, fresh = false): Promise<EngineStatus[]> {
  const key = JSON.stringify(choice.paths)
  const hit = cache.get(key)
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value
  const [claude, codex, agy] = await Promise.all([
    (async (): Promise<EngineStatus> => {
      const base = { id: 'claude' as const, label: AGENT_ENGINE_LABELS.claude, models: CLAUDE_MODELS.map(m => ({ id: m.id, label: m.label })) }
      try {
        const install = await detectClaude(choice.paths.claude)
        if (!install.path) return { ...base, available: false, detail: install.error ?? 'Claude Code is not installed.' }
        const account = await claudeAccount(install.path)
        return { ...base, available: account.signedIn, detail: account.detail }
      } catch (error) { return { ...base, available: false, detail: error instanceof Error ? error.message : 'Claude Code could not be checked.' } }
    })(),
    (async (): Promise<EngineStatus> => {
      const base = { id: 'codex' as const, label: AGENT_ENGINE_LABELS.codex }
      try {
        const install = await detectCodex(choice.paths.codex)
        if (!install.path) return { ...base, models: [], available: false, detail: install.error ?? 'Codex is not installed.' }
        const [account, models] = await Promise.all([codexAccount(install.path), listCodexModels().catch(() => [])])
        return { ...base, models: models.map(m => ({ id: m.id, label: m.label })), available: account.signedIn, detail: account.detail }
      } catch (error) { return { ...base, models: [], available: false, detail: error instanceof Error ? error.message : 'Codex could not be checked.' } }
    })(),
    (async (): Promise<EngineStatus> => {
      const base = { id: 'antigravity' as const, label: AGENT_ENGINE_LABELS.antigravity }
      try {
        const install = await detectInstallation(choice.paths.antigravity)
        if (!install.path) return { ...base, models: [], available: false, detail: install.error ?? 'Antigravity is not installed.' }
        const models: AgyModel[] = await listModels(install.path).catch(() => [])
        return { ...base, models: models.map(m => ({ id: m.id, label: m.label })), available: true, detail: `Antigravity ${install.version ?? ''} is installed.`.replace('  ', ' ') }
      } catch (error) { return { ...base, models: [], available: false, detail: error instanceof Error ? error.message : 'Antigravity could not be checked.' } }
    })()
  ])
  const value = [claude, codex, agy]
  cache.set(key, { at: Date.now(), value })
  return value
}

/** The order "Automatic" tries engines in: Claude first (best at following the action format). */
export const AUTO_ORDER: readonly AgentEngineId[] = ['claude', 'codex', 'antigravity']

export function pickEngines(preferred: AgentEngineId | 'auto', statuses: EngineStatus[]): AgentEngineId[] {
  const ready = new Set(statuses.filter(s => s.available).map(s => s.id))
  if (preferred !== 'auto') return ready.has(preferred) ? [preferred] : []
  return AUTO_ORDER.filter(id => ready.has(id))
}
