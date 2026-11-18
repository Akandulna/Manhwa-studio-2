/**
 * Official local Antigravity CLI (`agy`) adapter (docs/PRD-antigravity-studio.md §5).
 *
 * Detection, model listing and headless turns. Children run with argument
 * arrays (never a shell), in their own process group so Studio can stop only
 * the processes it started, with bounded output capture. The CLI keeps its
 * own credentials; Studio never sees or stores them. The managed/remote agent
 * mode (`--remote-agent`) is never used.
 *
 * Observed on agy 1.5.2 (2026-11-07, docs/antigravity-compatibility-report.md):
 *   `agy -p … --output-format json` prints one envelope
 *   { conversation_id, status, response, error?, denied_actions?, usage, num_turns, duration_seconds }.
 *   Unknown --model → exit 1, status ERROR. A tool needing approval in headless
 *   mode is soft-denied: exit 0, status SUCCESS, `denied_actions` listed.
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redact } from '../googleDrive/errors.js'

export interface AgyInstallation {
  path: string | null
  version: string | null
  error: string | null
}

export interface AgyModel {
  id: string
  label: string
}

export interface AgyEnvelope {
  conversation_id: string
  status: string
  response: string
  error?: string
  denied_actions?: { action: string; display_name?: string }[]
  num_turns?: number
  duration_seconds?: number
  usage?: Record<string, number>
}

export interface AgyTurnResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  envelope: AgyEnvelope | null
  /** Redacted tail of stderr for diagnostics. */
  stderrTail: string
  timedOut: boolean
  cancelled: boolean
  /** Studio stopped the turn because the agent showed no activity for too long (set by the job runner). */
  stalled?: boolean
  pid: number | null
  durationMs: number
}

export interface AgyTurnRequest {
  executable: string
  cwd: string
  prompt: string
  model: string
  effort?: string | null
  /** Resume exactly this conversation; never "continue latest". */
  conversationId?: string | null
  /** Session-only settings (never saved by the CLI). */
  settings?: Record<string, unknown>
  timeoutMs: number
  signal?: AbortSignal
  sandbox?: boolean
  env?: NodeJS.ProcessEnv
  onSpawn?: (pid: number) => void
}

export class AgyError extends Error {
  constructor(readonly code: 'not_installed' | 'auth_required' | 'model_unavailable' | 'failed' | 'timeout', message: string) {
    super(redact(message))
  }
}

const MAX_STDOUT = 4 * 1024 * 1024
const MAX_STDERR = 64 * 1024
export const SAFE_ID = /^[\w.:-]{1,128}$/

/** Directories to search when Studio was launched from Finder with a bare PATH. */
function candidateDirs(env: NodeJS.ProcessEnv): string[] {
  const home = os.homedir()
  return [...(env.PATH ?? '').split(path.delimiter), path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean)
}

export function findExecutable(override: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const isExec = (file: string) => {
    try {
      fs.accessSync(file, fs.constants.X_OK)
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  }
  if (override) return path.isAbsolute(override) && isExec(override) ? override : null
  for (const dir of candidateDirs(env)) {
    const file = path.join(dir, 'agy')
    if (isExec(file)) return file
  }
  return null
}

function run(executable: string, args: string[], timeoutMs: number, cwd = os.tmpdir()): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(executable, args, { cwd, timeout: timeoutMs, maxBuffer: MAX_STDOUT, env: process.env }, (error, stdout, stderr) => {
      const code = error && typeof (error as NodeJS.ErrnoException).code === 'number' ? ((error as unknown as { code: number }).code) : error ? null : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export async function detectInstallation(override?: string | null): Promise<AgyInstallation> {
  const executable = findExecutable(override)
  if (!executable) {
    return { path: null, version: null, error: override ? 'The configured agy path is not an executable file.' : 'The Antigravity CLI (agy) was not found. Install it from antigravity.google, or set its path.' }
  }
  const { stdout, stderr } = await run(executable, ['--version'], 15_000)
  const version = /(\d+\.\d+\.\d+(?:[-+.\w]*)?)/.exec(`${stdout}\n${stderr}`)?.[1] ?? null
  return { path: executable, version, error: version ? null : 'agy did not report a version.' }
}

const AUTH_HINT = /sign[\s-]?in|log[\s-]?in|authenticat|not signed/i

export function parseModelList(stdout: string): AgyModel[] {
  return stdout
    .split('\n')
    .map(line => line.split('\t'))
    .filter(parts => parts.length >= 2 && SAFE_ID.test(parts[0].trim()))
    .map(([id, label]) => ({ id: id.trim(), label: label.trim() }))
}

export async function listModels(executable: string): Promise<AgyModel[]> {
  const { code, stdout, stderr } = await run(executable, ['models'], 90_000)
  const models = parseModelList(stdout)
  if (models.length) return models
  if (AUTH_HINT.test(`${stdout}\n${stderr}`)) throw new AgyError('auth_required', 'Antigravity is not signed in. Use Sign in to complete the official CLI sign-in.')
  throw new AgyError('failed', `agy models returned no models (exit ${code}). ${redact(stderr.slice(-400))}`)
}

export function buildTurnArgs(req: Pick<AgyTurnRequest, 'prompt' | 'model' | 'effort' | 'conversationId' | 'settings' | 'sandbox'>): string[] {
  if (!SAFE_ID.test(req.model)) throw new AgyError('model_unavailable', 'Choose a model from the list.')
  const args = ['--print', req.prompt, '--output-format', 'json', '--model', req.model, '--disable-slash-commands']
  if (req.effort) args.push('--effort', req.effort)
  if (req.conversationId) {
    if (!SAFE_ID.test(req.conversationId)) throw new AgyError('failed', 'Invalid conversation ID.')
    args.push('--conversation', req.conversationId)
  }
  if (req.settings) args.push('--settings', JSON.stringify(req.settings))
  if (req.sandbox) args.push('--sandbox')
  return args
}

export function parseEnvelope(stdout: string): AgyEnvelope | null {
  const text = stdout.trim()
  const start = text.lastIndexOf('\n{') >= 0 ? text.lastIndexOf('\n{') + 1 : text.indexOf('{')
  if (start < 0) return null
  try {
    const value = JSON.parse(text.slice(start))
    return value && typeof value === 'object' && typeof value.status === 'string' ? (value as AgyEnvelope) : null
  } catch {
    return null
  }
}

/** Kill the whole process group Studio started (never any other agy process). */
function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch {
    try { process.kill(pid, signal) } catch { /* already gone */ }
  }
}

/** Run one headless turn and return the parsed envelope. Never throws for CLI failures. */
export function runTurn(req: AgyTurnRequest): Promise<AgyTurnResult> {
  const args = buildTurnArgs(req)
  const started = Date.now()
  return new Promise(resolve => {
    const child = spawn(req.executable, args, { cwd: req.cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: req.env ?? process.env })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false
    let killTimer: NodeJS.Timeout | null = null
    if (child.pid) req.onSpawn?.(child.pid)
    child.stdout.on('data', chunk => { if (stdout.length < MAX_STDOUT) stdout += chunk })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-MAX_STDERR) })
    const stop = () => {
      if (!child.pid) return
      killGroup(child.pid, 'SIGTERM')
      killTimer = setTimeout(() => child.pid && killGroup(child.pid, 'SIGKILL'), 5000)
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, req.timeoutMs)
    const onAbort = () => { cancelled = true; stop() }
    req.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      req.signal?.removeEventListener('abort', onAbort)
      resolve({ exitCode, signal, envelope: parseEnvelope(stdout), stderrTail: redact(stderr.slice(-1500)), timedOut, cancelled, pid: child.pid ?? null, durationMs: Date.now() - started })
    }
    child.on('error', () => finish(null, null))
    child.on('close', finish)
    if (req.signal?.aborted) onAbort()
  })
}

/** Is a process with this PID still running? (Used when recovering after a restart.) */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ─── Usage limits (`agy -p "/usage"`) ───
// agy answers its read-only slash commands in print mode without a model turn
// (no conversation, no quota used). With --output-format json the envelope's
// `command.data` holds { description, groups: [{ name, description, buckets:
// [{ id, name, window, remaining_fraction, reset_time }] }] } (agy 1.5.x,
// observed 2026-11-08: "Gemini Models" and "Claude and GPT models", weekly).

export interface AgyQuotaBucket { id: string; name: string; window: string | null; remainingFraction: number | null; resetTime: string | null }
export interface AgyQuotaGroup { name: string; description: string | null; buckets: AgyQuotaBucket[] }
export interface AgyQuota { at: string; description: string | null; groups: AgyQuotaGroup[] }

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function parseUsage(stdout: string, at = new Date().toISOString()): AgyQuota | null {
  const envelope = parseEnvelope(stdout) as (AgyEnvelope & { command?: { data?: any } }) | null
  const data = envelope?.command?.data
  if (data && Array.isArray(data.groups)) {
    const groups = data.groups.filter((g: any) => g && typeof g === 'object').map((g: any): AgyQuotaGroup => ({
      name: str(g.name) ?? 'Models',
      description: str(g.description),
      buckets: (Array.isArray(g.buckets) ? g.buckets : []).filter((b: any) => b && typeof b === 'object').map((b: any): AgyQuotaBucket => ({
        id: str(b.id) ?? str(b.name) ?? 'bucket',
        name: str(b.name) ?? 'Limit',
        window: str(b.window),
        remainingFraction: typeof b.remaining_fraction === 'number' ? Math.max(0, Math.min(1, b.remaining_fraction)) : null,
        resetTime: str(b.reset_time)
      }))
    }))
    return { at, description: str(data.description), groups }
  }
  // Older/plain output: one "group\tbucket\t83%\treset" record per line.
  const text = typeof envelope?.response === 'string' ? envelope.response : stdout
  const byGroup = new Map<string, AgyQuotaBucket[]>()
  for (const line of text.split('\n')) {
    const [group, name, percent, reset] = line.split('\t').map(s => s?.trim())
    const pct = /^(\d+(?:\.\d+)?)%$/.exec(percent ?? '')
    if (!group || !name || !pct) continue
    const list = byGroup.get(group) ?? []
    list.push({ id: `${group}:${name}`, name, window: /weekly/i.test(name) ? 'weekly' : null, remainingFraction: Math.min(1, Number(pct[1]) / 100), resetTime: reset || null })
    byGroup.set(group, list)
  }
  if (!byGroup.size) return null
  return { at, description: null, groups: [...byGroup].map(([name, buckets]) => ({ name, description: null, buckets })) }
}

/** The Antigravity plan's remaining usage, live from Google (a few seconds; uses no quota). */
export async function readUsage(executable: string): Promise<AgyQuota> {
  const { code, stdout, stderr } = await run(executable, ['--print', '/usage', '--output-format', 'json'], 60_000)
  const usage = parseUsage(stdout)
  if (usage) return usage
  if (AUTH_HINT.test(`${stdout}\n${stderr}`)) throw new AgyError('auth_required', 'Antigravity is not signed in.')
  throw new AgyError('failed', `agy /usage returned no usage (exit ${code}). ${redact(stderr.slice(-400))}`)
}

/** The Google account agy last signed in with, from its own log (no credentials read). */
export function signedInEmail(home = os.homedir()): string | null {
  try {
    const text = fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'cli.log'), 'utf8')
    const all = [...text.matchAll(/applyAuthResult: email=([^,\s]+)/g)]
    return all.length ? all[all.length - 1][1] : null
  } catch {
    return null
  }
}
