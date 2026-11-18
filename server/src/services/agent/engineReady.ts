/**
 * Is the AI engine new AntiGravity jobs use ready on this Mac? The same checks as the AntiGravity pages' readiness
 * (client pages/antigravity/shared.tsx useReadiness), for whichever engine Settings → AntiGravity → AI engine selects
 * (Antigravity, ChatGPT/Codex or Claude), plus running that engine's compatibility test.
 * Used by the Image Clipper tools (any engine) and the compatibility-test tool.
 */

import type { ToolContext } from './agentTools.js'

type Call = <T = any>(ctx: ToolContext, method: string, path: string, body?: unknown) => Promise<T>

export type EngineId = 'antigravity' | 'codex' | 'claude'
export const ENGINE_NAMES: Record<EngineId, string> = { antigravity: 'Antigravity', codex: 'ChatGPT (Codex)', claude: 'Claude (Claude Code)' }
const CONNECTION: Record<EngineId, string> = { antigravity: '/antigravity/connection', codex: '/antigravity/codex/connection', claude: '/antigravity/claude/connection' }
const CHECK: Record<EngineId, string> = { antigravity: '/antigravity/check', codex: '/antigravity/codex/check', claude: '/antigravity/claude/check' }
const engineOf = (value: unknown): EngineId => (value === 'codex' || value === 'claude' ? value : 'antigravity')

export interface EngineReadiness {
  engine: EngineId
  label: string
  model: string | null
  effort: string | null
  /** Pages (or chapters) processed in parallel (Settings → AntiGravity). */
  concurrency: number
  blockers: string[]
  /** The only thing missing is the compatibility test. */
  proofOnly: boolean
}

export async function engineReadiness(call: Call, ctx: ToolContext): Promise<EngineReadiness> {
  const agy = await call<any>(ctx, 'GET', CONNECTION.antigravity)
  const engine = engineOf(agy?.settings?.engine)
  const conn = engine === 'antigravity' ? agy : await call<any>(ctx, 'GET', CONNECTION[engine])
  const label = ENGINE_NAMES[engine]
  const blockers: string[] = []
  let proofOnly = false
  if (!conn?.installation?.path) blockers.push(conn?.installation?.error ?? `${label} was not found on this Mac (Settings → AntiGravity).`)
  else if (engine !== 'antigravity' && conn.account && !conn.account.signedIn) blockers.push(conn.account.detail ?? `Sign in to ${label} in Settings → AntiGravity.`)
  else if (!conn.settings?.model) blockers.push(`No ${label} model is chosen (settings_change ai.${engine}.model).`)
  else if (engine === 'codex' && Array.isArray(conn.accounts?.accounts) && !conn.accounts.accounts.some((a: any) => a.enabled && !a.limited)) {
    blockers.push('Every ChatGPT account Studio can use has reached its Codex limit or is turned off (Settings → AntiGravity → ChatGPT (Codex) shows when one resets).')
  } else if (!conn.proofValid) { blockers.push(conn.proofNote ?? `Run the ${label} compatibility test.`); proofOnly = true }
  return {
    engine, label,
    model: conn?.settings?.modelLabel ?? conn?.settings?.model ?? null,
    effort: engine === 'antigravity' ? null : conn?.settings?.effort ?? null,
    concurrency: agy?.settings?.concurrency ?? 1,
    blockers, proofOnly
  }
}

/** The selected engine's compatibility test: two small real turns on its model (a little quota, a minute or two). */
export async function runEngineTest(call: Call, ctx: ToolContext, engine: EngineId) {
  return call<{ ok?: boolean; error?: string | null; model?: string; durationMs?: number }>(ctx, 'POST', CHECK[engine])
}
