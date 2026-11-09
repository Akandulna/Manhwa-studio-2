/**
 * Evidence for one Codex attempt, read from Codex's own session record
 * ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl) after the
 * attempt: which tools ran, which model the session used, and the ChatGPT
 * plan's Codex usage windows. Never fails a page — evidence only.
 *
 * Observed (codex-cli 0.166): models call Studio's MCP tools from Codex's
 * code-mode wrapper (`exec` custom tool running `tools.mcp__studio__…`); each
 * MCP call is also recorded as an item_completed McpToolCall. turn_context
 * carries the model; token_count events carry `rate_limits`
 * {primary: 5 h window, secondary: weekly window, plan_type, rate_limit_reached_type}.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { codexHome } from './codexCli.js'
import type { ToolUse } from './toolUse.js'

export interface CodexRateWindow {
  usedPercent: number
  windowMinutes: number | null
  resetsAt: string | null
}

export interface CodexRateLimits {
  at: string
  planType: string | null
  primary: CodexRateWindow | null
  secondary: CodexRateWindow | null
  reached: string | null
}

export interface CodexSessionEvidence {
  toolUse: ToolUse
  /** Code-mode wrapper calls (the model's JS that invokes the MCP tools). */
  wrapperCalls: number
  model: string | null
  effort: string | null
  rateLimits: CodexRateLimits | null
  /** Codex's opaque account id for the signed-in ChatGPT account (session_meta; not a credential). */
  accountId: string | null
}

/** Item types that are plain conversation, not tools. */
const CONVERSATION_ITEMS = new Set(['UserMessage', 'AgentMessage', 'Reasoning', 'ContextCompaction', 'Compaction'])
/** Codex's own wrapper/plumbing calls; the tools they invoke are recorded as separate items. */
const WRAPPER_CALLS = new Set(['exec', 'wait'])

const window = (w: any): CodexRateWindow | null =>
  w && typeof w.used_percent === 'number'
    ? { usedPercent: w.used_percent, windowMinutes: typeof w.window_minutes === 'number' ? w.window_minutes : null, resetsAt: typeof w.resets_at === 'number' ? new Date(w.resets_at * 1000).toISOString() : null }
    : null

export function parseRateLimits(raw: any, at = new Date().toISOString()): CodexRateLimits | null {
  if (!raw || typeof raw !== 'object') return null
  return { at, planType: typeof raw.plan_type === 'string' ? raw.plan_type : null, primary: window(raw.primary), secondary: window(raw.secondary), reached: typeof raw.rate_limit_reached_type === 'string' ? raw.rate_limit_reached_type : null }
}

export function summarizeSession(lines: string[]): CodexSessionEvidence {
  const out: CodexSessionEvidence = { toolUse: { studio: {}, cliReads: 0, unexpected: [] }, wrapperCalls: 0, model: null, effort: null, rateLimits: null, accountId: null }
  for (const line of lines) {
    let row: any
    try { row = JSON.parse(line) } catch { continue }
    const p = row?.payload ?? {}
    if (row?.type === 'session_meta') {
      if (typeof p.creator_account_id === 'string') out.accountId = p.creator_account_id
      continue
    }
    if (row?.type === 'turn_context') {
      if (typeof p.model === 'string') out.model = p.model
      if (typeof p.effort === 'string') out.effort = p.effort
      continue
    }
    if (row?.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      const name = String(p.name ?? '')
      if (WRAPPER_CALLS.has(name)) out.wrapperCalls++
      else if (!name.startsWith(`mcp__studio__`)) out.toolUse.unexpected.push(name.slice(0, 120))
      continue
    }
    if (row?.type !== 'event_msg') continue
    if (p.type === 'token_count' && p.rate_limits) {
      out.rateLimits = parseRateLimits(p.rate_limits, typeof row.timestamp === 'string' ? row.timestamp : undefined) ?? out.rateLimits
      continue
    }
    if (p.type !== 'item_completed') continue
    const item = p.item ?? {}
    const type = String(item.type ?? '')
    if (CONVERSATION_ITEMS.has(type)) continue
    if (type === 'McpToolCall' && item.server === 'studio') {
      const tool = String(item.tool ?? '?')
      out.toolUse.studio[tool] = (out.toolUse.studio[tool] ?? 0) + 1
      continue
    }
    out.toolUse.unexpected.push(`${type}${item.server ? ` (${item.server}:${item.tool ?? '?'})` : ''}`.slice(0, 160))
  }
  return out
}

export function describeSession(e: CodexSessionEvidence): string {
  const studio = Object.entries(e.toolUse.studio).map(([tool, n]) => `${tool}×${n}`).join(', ') || 'none'
  const unexpected = e.toolUse.unexpected.length ? `; UNEXPECTED: ${[...new Set(e.toolUse.unexpected)].slice(0, 5).join(', ')}` : '; nothing unexpected'
  const limits = e.rateLimits ? `; ${describeLimits(e.rateLimits)}` : ''
  return `tools used — studio: ${studio}${e.wrapperCalls ? `; code-mode wrapper ×${e.wrapperCalls}` : ''}${unexpected}${e.model ? `; model ${e.model}${e.effort ? ` ${e.effort}` : ''}` : ''}${limits}`
}

export function describeLimits(l: CodexRateLimits): string {
  const part = (label: string, w: CodexRateWindow | null) => (w ? `${label} ${Math.round(w.usedPercent)}% used` : null)
  return [`Codex ${l.planType ?? 'plan'} limits:`, [part('5 h', l.primary), part('weekly', l.secondary)].filter(Boolean).join(', ') || 'unknown', l.reached ? `(limit reached: ${l.reached})` : ''].join(' ').trim()
}

/** Find a thread's session file, newest day folders first. */
export async function findSessionFile(threadId: string, home = codexHome()): Promise<string | null> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(threadId)) return null
  const root = path.join(home, 'sessions')
  const desc = async (dir: string) => (await fs.readdir(dir).catch(() => [] as string[])).filter(n => /^\d+$/.test(n)).sort().reverse()
  let checked = 0
  for (const year of await desc(root)) {
    for (const month of await desc(path.join(root, year))) {
      for (const day of await desc(path.join(root, year, month))) {
        const dir = path.join(root, year, month, day)
        const hit = (await fs.readdir(dir).catch(() => [] as string[])).find(n => n.endsWith(`-${threadId}.jsonl`))
        if (hit) return path.join(dir, hit)
        if (++checked >= 45) return null
      }
    }
  }
  return null
}

export async function readSessionEvidence(threadId: string, home = codexHome()): Promise<CodexSessionEvidence | null> {
  const file = await findSessionFile(threadId, home)
  if (!file) return null
  const text = await fs.readFile(file, 'utf8').catch(() => null)
  return text === null ? null : summarizeSession(text.split('\n'))
}

/** The newest usage windows Codex has recorded in any session (for Settings; no network call). */
export async function latestRateLimits(home = codexHome()): Promise<CodexRateLimits | null> {
  const root = path.join(home, 'sessions')
  const desc = async (dir: string) => (await fs.readdir(dir).catch(() => [] as string[])).sort().reverse()
  for (const year of (await desc(root)).slice(0, 2)) {
    for (const month of (await desc(path.join(root, year))).slice(0, 2)) {
      for (const day of (await desc(path.join(root, year, month))).slice(0, 3)) {
        const dir = path.join(root, year, month, day)
        const files = (await desc(dir)).filter(n => n.endsWith('.jsonl')).slice(0, 5)
        for (const name of files) {
          const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '')
          const lines = text.split('\n')
          for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].includes('"rate_limits"')) continue
            try {
              const row = JSON.parse(lines[i])
              const limits = parseRateLimits(row?.payload?.rate_limits, row?.timestamp)
              if (limits) return limits
            } catch { /* keep looking */ }
          }
        }
      }
    }
  }
  return null
}
