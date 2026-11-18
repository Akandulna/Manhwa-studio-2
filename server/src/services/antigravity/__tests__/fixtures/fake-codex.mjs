#!/usr/bin/env node
/**
 * Test double for the Codex CLI (`codex exec [resume <thread>] --json … -- <prompt>`).
 * Like fake-agy.mjs it acts as the model through Studio's MCP bridge, but takes
 * its MCP server from the `-c mcp_servers.studio.env={ … }` override (token read
 * from STUDIO_ATTEMPT_TOKEN_FILE, as job-mcp.mjs does), prints Codex's JSONL
 * events, and writes a session record under $CODEX_HOME/sessions like Codex.
 * Shares FAKE_AGY_PLAN / FAKE_AGY_LOG with fake-agy.mjs; log entries carry engine "codex".
 */
import { fakeNarration } from './fake-narration.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const dash = args.indexOf('--')
const flags = args.slice(0, dash)
const positional = args.slice(dash + 1)
const resumed = flags[1] === 'resume'
const conv = resumed ? positional[0] : crypto.randomUUID()
const prompt = positional.at(-1) ?? ''
const config = key => {
  for (let i = 0; i < flags.length; i++) if (flags[i] === '-c' && flags[i + 1].startsWith(`${key}=`)) return flags[i + 1].slice(key.length + 1)
  return null
}
const model = flags[flags.indexOf('-m') + 1]
const envTable = config('mcp_servers.studio.env') ?? ''
const env = Object.fromEntries([...envTable.matchAll(/(\w+) = "((?:[^"\\]|\\.)*)"/g)].map(m => [m[1], JSON.parse(`"${m[2]}"`)]))
const token = fs.readFileSync(env.STUDIO_ATTEMPT_TOKEN_FILE, 'utf8').trim()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = entry => fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ at: Date.now(), pid: process.pid, conv, resumed, engine: 'codex', ...entry }) + '\n')
const emit = event => process.stdout.write(JSON.stringify(event) + '\n')

const home = process.env.CODEX_HOME
const sessionDir = path.join(home, 'sessions', '2026', '11', '08')
fs.mkdirSync(sessionDir, { recursive: true })
const sessionFile = path.join(sessionDir, `rollout-2026-11-08T00-00-00-${conv}.jsonl`)
const record = row => fs.appendFileSync(sessionFile, JSON.stringify({ timestamp: new Date().toISOString(), ...row }) + '\n')
record({ type: 'session_meta', payload: { id: conv, creator_account_id: `acct-of-${path.basename(home)}` } })
record({ type: 'turn_context', payload: { model, effort: (config('model_reasoning_effort') ?? '"low"').replace(/"/g, '') } })

let item = 0
async function call(tool, a = {}) {
  const id = `item_${item++}`
  emit({ type: 'item.started', item: { id, type: 'mcp_tool_call', server: 'studio', tool, arguments: a, result: null, error: null, status: 'in_progress' } })
  const response = await fetch(`${env.STUDIO_BRIDGE_URL}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-studio-client': '1' },
    body: JSON.stringify({ tool, arguments: a, conversationId: null })
  })
  const result = await response.json()
  emit({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'studio', tool, arguments: a, result, error: null, status: 'completed' } })
  record({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: `await tools.mcp__studio__${tool}(…)` } })
  record({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'studio', tool, status: 'completed' } } })
  return result
}
const textOf = r => r?.content?.find(c => c.type === 'text')?.text ?? ''

emit({ type: 'thread.started', thread_id: conv })
emit({ type: 'turn.started' })
const context = textOf(await call('get_job_context'))
const stem = /Page "([^"]+)"/.exec(context)?.[1]
const job = /Job ([0-9a-f-]+)\./.exec(context)?.[1]
const sha = /SHA-256 ([0-9a-f]{64})/.exec(context)?.[1]
const size = /Original page: (\d+)×(\d+) px/.exec(context)
const slices = [...context.matchAll(/ {2}(s\d+): (\d+)×(\d+) px, original page y=(\d+)\.\.(\d+)/g)].map(m => ({ id: m[1], y0: Number(m[4]), y1: Number(m[5]) }))
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_AGY_PLAN, 'utf8'))[stem] ?? {}
log({ stem, event: 'start', turn: resumed ? 'review' : 'analysis', argv: flags.join(' ') })

// providerErrorOnHome: fail only on the account whose CODEX_HOME ends with this (multi-account failover).
if (plan.providerError && (!plan.providerErrorOnHome || home.endsWith(plan.providerErrorOnHome))) {
  // Like Codex at its limit: the session record shows the exhausted window and when it resets.
  record({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { plan_type: 'plus', primary: { used_percent: 100, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 7200 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 86400 }, rate_limit_reached_type: 'primary' } } })
  log({ stem, event: 'end' })
  emit({ type: 'turn.failed', error: { message: plan.providerError } })
  process.exit(1)
}

if (await fakeNarration({ context, prompt, call, log })) {
  emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })
  process.exit(0)
}

const corner = (x, y, end) => {
  const s = slices.find(s => (end ? y > s.y0 && y <= s.y1 : y >= s.y0 && y < s.y1))
  return { slice_id: s.id, x, y: y - s.y0 }
}
const box = plan.box
const geometry = { top_left: corner(box.x0, box.y0, false), bottom_right: corner(box.x1, box.y1, true) }

if (!resumed) {
  for (const s of slices) await call('fetch_slice', { slice_id: s.id })
  await sleep(plan.delayMs ?? 0)
  if (plan.hang) await sleep(60_000)
  const analysis = {
    schema_version: 'chatgpt-analysis/1.0', job_id: job, source_sha256: sha, page_stem: stem,
    source_width: Number(size[1]), source_height: Number(size[2]), coordinate_system: 'slice_local_pixels',
    page_inspection_complete: true, page_review_flags: [],
    candidates: [{ candidate_id: 'candidate-01', reason: 'illustrated_shot', ...geometry, visual_evidence: 'solid block', review_flags: [] }]
  }
  const result = await call('submit_analysis', { json: JSON.stringify(analysis) })
  log({ stem, event: 'submit_analysis', error: result.isError ? textOf(result) : null })
} else if (plan.review !== false) {
  const review = {
    schema_version: 'clipper-review-geometry/1.0', job_id: job, source_sha256: sha, review_revision: Number(/"review_revision"\s*:\s*(\d+)/.exec(prompt)?.[1] ?? 1), coordinate_system: 'slice_local_pixels',
    crops: [{ key: 'candidate-01', reason: 'illustrated_shot', ...geometry, checks_reviewed: plan.checks ?? [...new Set(prompt.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])] }],
    removed_keys: [], redescribe_keys: [], sweep_done: true, page_has_no_artwork: false, notes: ''
  }
  const result = await call('submit_review', { json: JSON.stringify(review) })
  log({ stem, event: 'submit_review', error: result.isError ? textOf(result) : null })
}
log({ stem, event: 'end' })
record({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { plan_type: 'plus', primary: { used_percent: 12, window_minutes: 300, resets_at: 1794090489 }, secondary: { used_percent: 79, window_minutes: 10080, resets_at: 1794390940 }, rate_limit_reached_type: null } } })
emit({ type: 'item.completed', item: { id: `item_${item++}`, type: 'agent_message', text: 'SUBMITTED' } })
emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } })
