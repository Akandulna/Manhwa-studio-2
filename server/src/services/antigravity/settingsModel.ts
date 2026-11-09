/**
 * AntiGravity settings and connection view types (no runtime imports, so the
 * client can type-import them without pulling in the server).
 */

import type { AgyInstallation, AgyModel } from './cli.js'
import type { CodexAccount, CodexModel } from './codexCli.js'
import type { CodexRateLimits } from './codexSession.js'
import type { CodexAccountView } from './codexAccounts.js'
import type { CompatibilityReport } from './compatibility.js'

/** Which local CLI runs AntiGravity jobs: Google Antigravity (agy) or ChatGPT through Codex. */
export type AiEngine = 'antigravity' | 'codex'
export const ENGINE_LABELS: Record<AiEngine, string> = { antigravity: 'Antigravity', codex: 'ChatGPT (Codex)' }

export interface AntigravitySettings {
  /** The engine new runs use. Each run pins the engine it started with. */
  engine: AiEngine
  /** Absolute path to agy when auto-detection fails. */
  executablePath: string | null
  model: string | null
  modelLabel: string | null
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  /** 1 until parallel runs are validated (Phase 6); the cap is 4. */
  concurrency: number
  /** Per-page deadline including review. */
  pageTimeoutMinutes: number
  /** Run agy with --sandbox (terminal restrictions) so inherited command grants cannot run shell commands. */
  sandbox: boolean
}

export const DEFAULT_SETTINGS: AntigravitySettings = {
  engine: 'antigravity',
  executablePath: null,
  model: null,
  modelLabel: null,
  effort: null,
  concurrency: 1,
  pageTimeoutMinutes: 45,
  sandbox: true
}

export interface ConnectionView {
  installation: AgyInstallation
  settings: AntigravitySettings
  report: CompatibilityReport | null
  /** The saved proof covers the installed CLI version and the selected model. */
  proofValid: boolean
  proofNote: string | null
  checkRunning: boolean
  models: AgyModel[] | null
  modelsError: { code: string; message: string } | null
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

export function sanitizeSettings(input: unknown, current: AntigravitySettings): AntigravitySettings {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const next = { ...current }
  if ('engine' in body) {
    if (body.engine !== 'antigravity' && body.engine !== 'codex') throw new Error('Unknown engine.')
    next.engine = body.engine
  }
  if ('executablePath' in body) {
    const p = body.executablePath
    next.executablePath = typeof p === 'string' && p.trim() ? p.trim() : null
    if (next.executablePath && (!next.executablePath.startsWith('/') || next.executablePath.length > 500)) throw new Error('The agy path must be an absolute path.')
  }
  if ('model' in body) {
    const m = body.model
    if (m !== null && (typeof m !== 'string' || !/^[\w.:-]{1,128}$/.test(m))) throw new Error('Choose a model from the list.')
    next.model = (m as string | null) ?? null
    next.modelLabel = typeof body.modelLabel === 'string' ? body.modelLabel.slice(0, 120) : null
  }
  if ('effort' in body) {
    if (body.effort !== null && !EFFORTS.has(String(body.effort))) throw new Error('Unknown reasoning level.')
    next.effort = (body.effort as AntigravitySettings['effort']) ?? null
  }
  if ('concurrency' in body) {
    const c = Number(body.concurrency)
    if (!Number.isInteger(c) || c < 1 || c > 4) throw new Error('Concurrency must be 1–4.')
    next.concurrency = c
  }
  if ('pageTimeoutMinutes' in body) {
    const t = Number(body.pageTimeoutMinutes)
    if (!Number.isFinite(t) || t < 5 || t > 180) throw new Error('Page timeout must be 5–180 minutes.')
    next.pageTimeoutMinutes = Math.round(t)
  }
  if ('sandbox' in body) next.sandbox = body.sandbox === true
  return next
}

/**
 * `models` = what the signed-in agy account offers right now (null = unknown, not checked).
 * `account` = the Google account agy is signed in with (null = unknown). Model access is per
 * account/plan, so a proof made on another login, or for a model this login lacks, is stale.
 */
export function proofStatus(
  report: CompatibilityReport | null,
  installation: AgyInstallation,
  settings: AntigravitySettings,
  current: { models?: AgyModel[] | null; account?: string | null } = {}
): { valid: boolean; note: string | null } {
  if (settings.model && current.models && !current.models.some(m => m.id === settings.model)) {
    const who = current.account ? ` (${current.account})` : ''
    return { valid: false, note: `The signed-in Antigravity account${who} does not offer ${settings.modelLabel ?? settings.model}; choose one of its models and run the test again.` }
  }
  if (!report) return { valid: false, note: 'Run the compatibility test once before processing.' }
  if (!report.ok) return { valid: false, note: 'The last compatibility test failed.' }
  if (report.cliVersion !== installation.version) return { valid: false, note: `agy changed from ${report.cliVersion ?? '?'} to ${installation.version ?? '?'}; run the test again.` }
  if (!settings.model || report.model !== settings.model) return { valid: false, note: 'The selected model differs from the tested one; run the test again.' }
  if (report.sandbox !== settings.sandbox) return { valid: false, note: 'The sandbox setting changed since the test; run it again.' }
  if (report.account && current.account && report.account.toLowerCase() !== current.account.toLowerCase()) {
    return { valid: false, note: `Antigravity is now signed in as ${current.account} (tested with ${report.account}); run the test again.` }
  }
  return { valid: true, note: null }
}


// ─── ChatGPT (Codex) engine ───

export interface CodexSettings {
  /** Absolute path to codex when auto-detection (PATH, then ChatGPT.app's bundled CLI) fails. */
  executablePath: string | null
  model: string | null
  modelLabel: string | null
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
}

export const DEFAULT_CODEX_SETTINGS: CodexSettings = { executablePath: null, model: null, modelLabel: null, effort: null }

export interface CodexConnectionView {
  installation: AgyInstallation
  account: CodexAccount | null
  settings: CodexSettings
  report: CompatibilityReport | null
  proofValid: boolean
  proofNote: string | null
  checkRunning: boolean
  models: CodexModel[] | null
  modelsError: { code: string; message: string } | null
  /** Usage windows of the account new pages would use now (as Codex last recorded them; no network call). */
  rateLimits: CodexRateLimits | null
  /** The ChatGPT accounts Studio can run Codex on, in the order it uses them. */
  accounts: { autoSwitch: boolean; accounts: CodexAccountView[] }
}

export function sanitizeCodexSettings(input: unknown, current: CodexSettings): CodexSettings {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const next = { ...current }
  if ('executablePath' in body) {
    const p = body.executablePath
    next.executablePath = typeof p === 'string' && p.trim() ? p.trim() : null
    if (next.executablePath && (!next.executablePath.startsWith('/') || next.executablePath.length > 500)) throw new Error('The codex path must be an absolute path.')
  }
  if ('model' in body) {
    const m = body.model
    if (m !== null && (typeof m !== 'string' || !/^[\w.:-]{1,128}$/.test(m))) throw new Error('Choose a model from the list.')
    next.model = (m as string | null) ?? null
    next.modelLabel = typeof body.modelLabel === 'string' ? body.modelLabel.slice(0, 120) : null
  }
  if ('effort' in body) {
    if (body.effort !== null && !EFFORTS.has(String(body.effort))) throw new Error('Unknown reasoning level.')
    next.effort = (body.effort as CodexSettings['effort']) ?? null
  }
  return next
}

export function codexProofStatus(report: CompatibilityReport | null, installation: AgyInstallation, settings: CodexSettings, account: CodexAccount | null): { valid: boolean; note: string | null } {
  if (account && !account.signedIn) return { valid: false, note: 'Sign in to Codex with your ChatGPT account (Plus or above).' }
  if (!report) return { valid: false, note: 'Run the Codex compatibility test once before processing.' }
  if (!report.ok) return { valid: false, note: 'The last Codex compatibility test failed.' }
  if (report.cliVersion !== installation.version) return { valid: false, note: `codex changed from ${report.cliVersion ?? '?'} to ${installation.version ?? '?'} (the ChatGPT app updates it); run the test again.` }
  if (!settings.model || report.model !== settings.model) return { valid: false, note: 'The selected Codex model differs from the tested one; run the test again.' }
  return { valid: true, note: null }
}
