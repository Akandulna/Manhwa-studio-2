#!/usr/bin/env node
/**
 * Test double for Claude Code (`claude -p --output-format stream-json … [--resume <id>]`, prompt on stdin).
 * Like fake-codex.mjs it acts as the model through Studio's MCP bridge, but takes its MCP server
 * from the --mcp-config file (token read from STUDIO_ATTEMPT_TOKEN_FILE, as job-mcp.mjs does),
 * prints Claude Code's stream-json events, and writes a transcript under
 * $CLAUDE_CONFIG_DIR/projects/<cwd>/<session>.jsonl like Claude Code.
 * Shares FAKE_AGY_PLAN / FAKE_AGY_LOG with fake-agy.mjs; log entries carry engine "claude".
 */
import { fakeNarration } from './fake-narration.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const resumed = args.includes('--resume')
const conv = resumed ? flag('--resume') : crypto.randomUUID()
const prompt = fs.readFileSync(0, 'utf8')
const model = flag('--model')
const config = JSON.parse(fs.readFileSync(flag('--mcp-config'), 'utf8'))
const env = config.mcpServers.studio.env
const token = fs.readFileSync(env.STUDIO_ATTEMPT_TOKEN_FILE, 'utf8').trim()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = entry => fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ at: Date.now(), pid: process.pid, conv, resumed, engine: 'claude', ...entry }) + '\n')
const emit = event => process.stdout.write(JSON.stringify({ ...event, session_id: conv }) + '\n')

const projects = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))
fs.mkdirSync(projects, { recursive: true })
const transcript = path.join(projects, `${conv}.jsonl`)
const record = row => fs.appendFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), sessionId: conv, ...row }) + '\n')

let item = 0
async function call(tool, a = {}) {
  const id = `toolu_${item++}`
  const message = { model, content: [{ type: 'tool_use', id, name: `mcp__studio__${tool}`, input: a }] }
  emit({ type: 'assistant', message })
  record({ type: 'assistant', message })
  const response = await fetch(`${env.STUDIO_BRIDGE_URL}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-studio-client': '1' },
    body: JSON.stringify({ tool, arguments: a, conversationId: null })
  })
  const result = await response.json()
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: result.content }] } })
  return result
}
const textOf = r => r?.content?.find(c => c.type === 'text')?.text ?? ''

emit({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['mcp__studio__get_job_context'], mcp_servers: [{ name: 'studio', status: 'connected' }], model, permissionMode: flag('--permission-mode') })
const context = textOf(await call('get_job_context'))
const stem = /Page "([^"]+)"/.exec(context)?.[1]
const job = /Job ([0-9a-f-]+)\./.exec(context)?.[1]
const sha = /SHA-256 ([0-9a-f]{64})/.exec(context)?.[1]
const size = /Original page: (\d+)×(\d+) px/.exec(context)
const slices = [...context.matchAll(/ {2}(s\d+): (\d+)×(\d+) px, original page y=(\d+)\.\.(\d+)/g)].map(m => ({ id: m[1], y0: Number(m[4]), y1: Number(m[5]) }))
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_AGY_PLAN, 'utf8'))[stem] ?? {}
log({ stem, event: 'start', turn: resumed ? 'review' : 'analysis', argv: args.join(' ') })

if (plan.providerError) {
  // Like Claude Code at the plan's limit: a refused window, then an error result.
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 7200, rateLimitType: 'five_hour' } })
  log({ stem, event: 'end' })
  emit({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: plan.providerError, num_turns: 1 })
  process.exit(1)
}
emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1794330600, rateLimitType: 'five_hour' } })

if (await fakeNarration({ context, prompt, call, log })) {
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'SUBMITTED', num_turns: 3, permission_denials: [] })
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
emit({ type: 'assistant', message: { model, content: [{ type: 'text', text: 'SUBMITTED' }] } })
emit({ type: 'result', subtype: 'success', is_error: false, result: 'SUBMITTED', num_turns: 3, usage: { input_tokens: 10, output_tokens: 5 }, permission_denials: [] })
