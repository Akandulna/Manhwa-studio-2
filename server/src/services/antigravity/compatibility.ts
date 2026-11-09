/**
 * Local Antigravity compatibility proof (docs/PRD-antigravity-studio.md §5.3).
 *
 * Runs two real headless turns against the selected model in an isolated
 * temporary workspace whose `.agents/mcp_config.json` loads Studio's probe MCP
 * server (resources/antigravity/probe-mcp.mjs):
 *   1. The model must fetch a freshly generated image through MCP and submit
 *      its random code, shape and colour. Nothing outside the pixels reveals
 *      them, so a match proves the model saw the image.
 *   2. Studio resumes that exact conversation ID and asks for the same facts
 *      without tools, proving same-conversation continuation with context.
 * The answer key stays in this process's memory. Uses the operator's
 * Antigravity quota, so it only runs when explicitly requested.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { runTurn, type AgyTurnResult } from './cli.js'
import { runCodexTurn } from './codexCli.js'
import { readSessionEvidence, type CodexRateLimits } from './codexSession.js'

export const PROBE_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'resources', 'antigravity', 'probe-mcp.mjs')
export const MCP_SERVER_NAME = 'studio'

export type CheckState = { ok: boolean | null; detail: string }

export interface CompatibilityReport {
  at: string
  /** Absent on reports saved before the Codex engine existed (= antigravity). */
  engine?: 'antigravity' | 'codex'
  cliVersion: string | null
  /** The account the test ran on (agy: Google email). Absent on older reports. */
  account?: string | null
  model: string
  effort: string | null
  sandbox: boolean
  transport: string
  imageDelivery: string
  /** The CLI's JSON output does not name the served model, so this stays "unknown" unless it does. */
  observedModel: string
  conversationId: string | null
  checks: {
    mcpLoaded: CheckState
    imageSeen: CheckState
    conversationIdReturned: CheckState
    resumedSameConversation: CheckState
    contextRetained: CheckState
  }
  ok: boolean
  durationMs: number
  error: string | null
  /** Codex only: the ChatGPT plan's Codex usage windows after the test. */
  rateLimits?: CodexRateLimits | null
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const SHAPES = {
  circle: (c: string) => `<circle cx="480" cy="200" r="90" fill="${c}"/>`,
  triangle: (c: string) => `<polygon points="480,90 580,300 380,300" fill="${c}"/>`,
  square: (c: string) => `<rect x="390" y="110" width="180" height="180" fill="${c}"/>`
} as const
const COLORS = { red: '#e11d48', blue: '#2563eb', green: '#16a34a' } as const

export interface ProbeKey {
  code: string
  shape: keyof typeof SHAPES
  color: keyof typeof COLORS
}

export async function makeProbeImage(): Promise<{ png: Buffer; key: ProbeKey }> {
  const code = Array.from(crypto.randomBytes(5), b => LETTERS[b % LETTERS.length]).join('')
  const shape = (Object.keys(SHAPES) as ProbeKey['shape'][])[crypto.randomInt(3)]
  const color = (Object.keys(COLORS) as ProbeKey['color'][])[crypto.randomInt(3)]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="white"/><text x="40" y="230" font-family="Helvetica, Arial, sans-serif" font-weight="bold" font-size="84" fill="black">${code}</text>${SHAPES[shape](COLORS[color])}</svg>`
  return { png: await sharp(Buffer.from(svg)).png().toBuffer(), key: { code, shape, color } }
}

interface ProbeEvent {
  type: 'fetch_slice' | 'submit_analysis'
  submitted?: { code?: string; shape?: string; color?: string } | null
  conversationId?: string | null
}

const readEvents = (file: string): ProbeEvent[] => {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as ProbeEvent] } catch { return [] }
  })
}

const matches = (s: { code?: string; shape?: string; color?: string } | null | undefined, key: ProbeKey) =>
  !!s && s.code?.trim().toUpperCase() === key.code && s.shape?.trim().toLowerCase() === key.shape && s.color?.trim().toLowerCase() === key.color

function turnProblem(turn: AgyTurnResult, cli = 'agy'): string | null {
  if (turn.cancelled) return 'Cancelled.'
  if (turn.timedOut) return `The ${cli} turn timed out.`
  if (!turn.envelope) return `${cli} produced no JSON result (exit ${turn.exitCode ?? 'signal'}). ${turn.stderrTail.slice(-300)}`
  if (turn.envelope.status !== 'SUCCESS') return `${cli} reported ${turn.envelope.status}: ${(turn.envelope.error ?? '').slice(0, 400)}`
  return null
}

/** Session-only settings for probe and job turns: allow only Studio's MCP tools. */
export function jobSettings(): Record<string, unknown> {
  return { permissions: { allow: [`mcp(${MCP_SERVER_NAME}/*)`] } }
}

export async function runCompatibilityCheck(opts: {
  executable: string
  cliVersion: string | null
  model: string
  effort?: string | null
  sandbox: boolean
  timeoutMs?: number
  workRoot?: string
  signal?: AbortSignal
  nodeBinary?: string
  /** Default antigravity (agy). codex = ChatGPT through the Codex CLI. */
  engine?: 'antigravity' | 'codex'
  /** Codex's home (the account the test runs on); also where its session record is read. */
  codexHome?: string
}): Promise<CompatibilityReport> {
  const engine = opts.engine ?? 'antigravity'
  const cli = engine === 'codex' ? 'codex' : 'agy'
  const started = Date.now()
  const workRoot = opts.workRoot ?? path.join(os.tmpdir(), 'manhwa-studio-antigravity')
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 })
  const root = fs.mkdtempSync(path.join(workRoot, 'probe-'))
  const workspace = path.join(root, 'workspace')
  const assets = path.join(root, 'assets')
  fs.mkdirSync(path.join(workspace, '.agents'), { recursive: true })
  fs.mkdirSync(assets, { recursive: true })
  const imagePath = path.join(assets, 'slice.png')
  const logPath = path.join(assets, 'events.jsonl')
  const { png, key } = await makeProbeImage()
  fs.writeFileSync(imagePath, png)
  const probeServer = { command: opts.nodeBinary ?? process.execPath, args: [PROBE_SCRIPT, imagePath, logPath] }
  if (engine === 'antigravity') {
    fs.writeFileSync(path.join(workspace, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: probeServer } }, null, 2))
  }

  const report: CompatibilityReport = {
    at: new Date().toISOString(),
    engine,
    cliVersion: opts.cliVersion,
    model: opts.model,
    effort: opts.effort ?? null,
    sandbox: opts.sandbox,
    transport: engine === 'codex'
      ? 'stdio MCP server passed as -c mcp_servers.studio.* (no user config, read-only sandbox, tools pre-approved for that server only)'
      : 'stdio MCP server from the job workspace .agents/mcp_config.json',
    imageDelivery: 'MCP tools/call result content type "image" (base64 PNG)',
    observedModel: 'unknown',
    conversationId: null,
    checks: {
      mcpLoaded: { ok: null, detail: 'Not run' },
      imageSeen: { ok: null, detail: 'Not run' },
      conversationIdReturned: { ok: null, detail: 'Not run' },
      resumedSameConversation: { ok: null, detail: 'Not run' },
      contextRetained: { ok: null, detail: 'Not run' }
    },
    ok: false,
    durationMs: 0,
    error: null
  }
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000
  const base = { executable: opts.executable, cwd: workspace, model: opts.model, effort: opts.effort, settings: jobSettings(), sandbox: opts.sandbox, timeoutMs, signal: opts.signal }
  const turn = (req: { prompt: string; conversationId?: string | null }): Promise<AgyTurnResult> => engine === 'codex'
    ? runCodexTurn({ executable: opts.executable, cwd: workspace, model: opts.model, effort: opts.effort, timeoutMs, signal: opts.signal, mcp: { ...probeServer, env: {} }, env: opts.codexHome ? { ...process.env, CODEX_HOME: opts.codexHome } : undefined, ...req })
    : runTurn({ ...base, ...req })

  try {
    const first = await turn({
      prompt: 'Studio compatibility test. Call the studio MCP tool fetch_slice with sliceId "s1" and inspect the returned image. Then call submit_analysis with the 5-character code printed in the image, the shape (circle, triangle or square) and its color (red, blue or green). Do not read, write or run anything else. After submitting, reply with one line: DONE.'
    })
    const firstProblem = turnProblem(first, cli)
    const events = readEvents(logPath)
    const fetched = events.filter(e => e.type === 'fetch_slice')
    const submitted = events.filter(e => e.type === 'submit_analysis')
    const denied = first.envelope?.denied_actions?.map(d => d.display_name ?? d.action) ?? []
    report.checks.mcpLoaded = fetched.length
      ? { ok: true, detail: `fetch_slice called ${fetched.length}×` }
      : { ok: false, detail: firstProblem ?? (denied.length ? `Studio's tool was not used; denied: ${denied.join(', ')}` : 'The model never called Studio\'s MCP tool.') }
    report.checks.imageSeen = report.checks.mcpLoaded.ok && matches(submitted.at(-1)?.submitted, key)
      ? { ok: true, detail: 'Submitted code, shape and colour match the generated image.' }
      : { ok: false, detail: submitted.length ? 'The submitted answer does not match the image, so image visibility is not proven.' : 'No analysis was submitted.' }
    const conversationId = first.envelope?.conversation_id || null
    report.conversationId = conversationId
    const metaId = submitted.at(-1)?.conversationId ?? fetched.at(-1)?.conversationId ?? null
    report.checks.conversationIdReturned = conversationId
      ? { ok: !metaId || metaId === conversationId, detail: metaId && metaId !== conversationId ? 'The MCP call carried a different conversation ID.' : `Conversation ${conversationId}${metaId ? ' (matches MCP _meta)' : ''}` }
      : { ok: false, detail: firstProblem ?? `${cli} returned no conversation ID.` }

    if (conversationId && report.checks.imageSeen.ok) {
      const callsBefore = readEvents(logPath).length
      const second = await turn({
        conversationId,
        prompt: 'Second turn. Without calling any tools and without reading files: what 5-character code, shape and color did the slice image earlier in this conversation show? Answer exactly as CODE/SHAPE/COLOR.'
      })
      const secondProblem = turnProblem(second, cli)
      const sameId = second.envelope?.conversation_id === conversationId
      report.checks.resumedSameConversation = sameId
        ? { ok: true, detail: `Resumed ${conversationId} (turns: ${second.envelope?.num_turns ?? '?'})` }
        : { ok: false, detail: secondProblem ?? `${cli} answered from a different conversation.` }
      const [code, shape, color] = (second.envelope?.response ?? '').trim().split(/\s*\/\s*/)
      const noTools = readEvents(logPath).length === callsBefore
      report.checks.contextRetained = sameId && matches({ code, shape, color }, key) && noTools
        ? { ok: true, detail: 'Recalled the image facts without calling tools.' }
        : { ok: false, detail: secondProblem ?? (noTools ? 'The answer did not match the earlier image.' : 'The model fetched the image again instead of recalling it.') }
    }
    if (engine === 'codex' && conversationId) {
      // Codex records the session's model and the plan's usage windows in its own session file.
      const evidence = await readSessionEvidence(conversationId, opts.codexHome).catch(() => null)
      if (evidence?.model) report.observedModel = evidence.model
      report.rateLimits = evidence?.rateLimits ?? null
    }
    report.ok = Object.values(report.checks).every(c => c.ok === true)
    if (!report.ok && !report.error) report.error = Object.values(report.checks).find(c => c.ok === false)?.detail ?? 'Compatibility test incomplete.'
  } catch (error) {
    report.error = error instanceof Error ? error.message : 'Compatibility test failed.'
  } finally {
    report.durationMs = Date.now() - started
    fs.rmSync(root, { recursive: true, force: true })
  }
  return report
}
