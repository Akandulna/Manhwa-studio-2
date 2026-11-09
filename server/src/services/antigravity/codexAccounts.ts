/**
 * Several ChatGPT accounts for the Codex engine, so a run can continue on
 * another account's Codex usage when one account's limit is reached.
 *
 * Each account is a separate CODEX_HOME holding that account's own Codex
 * sign-in (auth.json, written by the official `codex login`; Studio never
 * reads it) and its own session records. The built-in "default" account is
 * the Mac's normal ~/.codex — the one the ChatGPT app signs in. Added accounts
 * live under Application Support/Manhwa Studio/codex-accounts/<id>.
 *
 * A page's conversation stays on the account that started it (its thread is
 * stored in that account's CODEX_HOME). When an account reports its usage
 * limit, it is marked limited until the window resets, and new pages go to
 * the next available account in the operator's order.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { codexAccount, codexHome, type CodexAccount } from './codexCli.js'
import { latestRateLimits, type CodexRateLimits } from './codexSession.js'

export const DEFAULT_ACCOUNT_ID = 'default'
export const ACCOUNTS_KEY = 'antigravityCodexAccounts'
export const ACCOUNTS_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'Manhwa Studio', 'codex-accounts')
/** When Codex reports the limit but no reset time is known, try the account again after this long. */
export const FALLBACK_LIMIT_MS = 60 * 60_000

export interface CodexAccountRecord {
  id: string
  label: string
  /** Studio uses this account for new pages (in list order). */
  enabled: boolean
  /** Set when the account reported its usage limit (or lost its sign-in); cleared when it passes. */
  limitedUntil: string | null
  limitReason: string | null
  /** Usage windows from this account's newest Codex session record. */
  lastLimits: CodexRateLimits | null
  /** Codex's opaque account id from session records (not a credential); used to spot the same account added twice. */
  accountId: string | null
  addedAt: string
}

export interface CodexAccountsState {
  /** Continue on the next account when one reaches its limit (otherwise the run pauses). */
  autoSwitch: boolean
  accounts: CodexAccountRecord[]
}

/** What a job needs to run a turn on an account. */
export interface CodexAccountRef {
  id: string
  label: string
  home: string
}

export interface CodexAccountView extends CodexAccountRecord {
  builtIn: boolean
  login: CodexAccount | null
  limited: boolean
  /** Another account in the list is the same ChatGPT account. */
  duplicateOf: string | null
}

const now = () => new Date().toISOString()

export function defaultState(): CodexAccountsState {
  return {
    autoSwitch: true,
    accounts: [{ id: DEFAULT_ACCOUNT_ID, label: 'ChatGPT app (this Mac)', enabled: true, limitedUntil: null, limitReason: null, lastLimits: null, accountId: null, addedAt: now() }]
  }
}

export function homeFor(id: string, root = ACCOUNTS_ROOT, defaultHome = codexHome()): string {
  if (id === DEFAULT_ACCOUNT_ID) return defaultHome
  if (!/^[a-z0-9-]{6,40}$/.test(id)) throw new Error('Invalid account id.')
  return path.join(root, id)
}

export const isLimited = (a: Pick<CodexAccountRecord, 'limitedUntil'>, at = Date.now()) => !!a.limitedUntil && Date.parse(a.limitedUntil) > at

/** When the account's exhausted window resets, from its usage record; null when unknown. */
export function limitResetFrom(limits: CodexRateLimits | null | undefined, at = Date.now()): string | null {
  if (!limits) return null
  const windows = [limits.primary, limits.secondary].filter((w): w is NonNullable<typeof w> => !!w)
  const full = windows.filter(w => w.usedPercent >= 100 && w.resetsAt && Date.parse(w.resetsAt) > at)
  const pool = full.length ? full : limits.reached ? windows.filter(w => w.resetsAt && Date.parse(w.resetsAt) > at) : []
  if (!pool.length) return null
  // The latest reset among exhausted windows is when the account can work again.
  return pool.map(w => w.resetsAt!).sort().at(-1)!
}

/** First enabled, not-limited account in order, skipping [exclude]. Pure. */
export function pickAccount(state: CodexAccountsState, exclude: string[] = [], at = Date.now()): CodexAccountRecord | null {
  return state.accounts.find(a => a.enabled && !isLimited(a, at) && !exclude.includes(a.id)) ?? null
}

export class CodexAccountStore {
  constructor(private readonly deps: {
    prisma: PrismaClient
    root?: string
    defaultHome?: string
    /** codex executable, for `codex login status` per account. */
    executable?: () => Promise<string | null>
  }) {}

  private root() { return this.deps.root ?? ACCOUNTS_ROOT }
  home(id: string) { return homeFor(id, this.root(), this.deps.defaultHome ?? codexHome()) }

  async read(): Promise<CodexAccountsState> {
    const row = await this.deps.prisma.setting.findUnique({ where: { key: ACCOUNTS_KEY } })
    const base = defaultState()
    if (!row) return base
    try {
      const parsed = JSON.parse(row.value) as Partial<CodexAccountsState>
      const accounts = Array.isArray(parsed.accounts) ? parsed.accounts.filter(a => a && typeof a.id === 'string') : []
      if (!accounts.some(a => a.id === DEFAULT_ACCOUNT_ID)) accounts.unshift(base.accounts[0])
      return { autoSwitch: parsed.autoSwitch !== false, accounts: accounts.map(a => ({ ...base.accounts[0], ...a, label: String(a.label ?? 'Account').slice(0, 60) })) }
    } catch {
      return base
    }
  }

  private async write(state: CodexAccountsState) {
    const value = JSON.stringify(state)
    await this.deps.prisma.setting.upsert({ where: { key: ACCOUNTS_KEY }, create: { key: ACCOUNTS_KEY, value }, update: { value } })
    return state
  }

  private async mutate(fn: (state: CodexAccountsState) => void | Promise<void>) {
    const state = await this.read()
    await fn(state)
    return this.write(state)
  }

  async add(label: string): Promise<CodexAccountRecord> {
    const clean = label.replace(/\s+/g, ' ').trim().slice(0, 60)
    if (!clean) throw new Error('Give the account a name (for example the account owner).')
    const id = `acct-${crypto.randomBytes(5).toString('hex')}`
    await fs.mkdir(this.home(id), { recursive: true, mode: 0o700 })
    const record: CodexAccountRecord = { id, label: clean, enabled: true, limitedUntil: null, limitReason: null, lastLimits: null, accountId: null, addedAt: now() }
    await this.mutate(state => { state.accounts.push(record) })
    return record
  }

  /** Removes an added account and its Codex folder (its sign-in and session records). */
  async remove(id: string) {
    if (id === DEFAULT_ACCOUNT_ID) throw new Error('The ChatGPT app\'s account cannot be removed; turn it off instead.')
    const state = await this.read()
    if (!state.accounts.some(a => a.id === id)) throw new Error('Account not found.')
    await this.write({ ...state, accounts: state.accounts.filter(a => a.id !== id) })
    const home = this.home(id)
    if (home.startsWith(this.root() + path.sep)) await fs.rm(home, { recursive: true, force: true })
  }

  async update(id: string, patch: { label?: unknown; enabled?: unknown; clearLimit?: unknown }) {
    return this.mutate(state => {
      const account = state.accounts.find(a => a.id === id)
      if (!account) throw new Error('Account not found.')
      if (typeof patch.label === 'string' && patch.label.trim()) account.label = patch.label.replace(/\s+/g, ' ').trim().slice(0, 60)
      if (typeof patch.enabled === 'boolean') account.enabled = patch.enabled
      if (patch.clearLimit === true) { account.limitedUntil = null; account.limitReason = null }
    })
  }

  async reorder(ids: string[]) {
    return this.mutate(state => {
      if (ids.length !== state.accounts.length || !state.accounts.every(a => ids.includes(a.id))) throw new Error('Send every account id once.')
      state.accounts.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
    })
  }

  async setAutoSwitch(on: boolean) {
    return this.mutate(state => { state.autoSwitch = on })
  }

  // ─── Used by jobs ───

  async pick(exclude: string[] = []): Promise<CodexAccountRef | null> {
    const account = pickAccount(await this.read(), exclude)
    return account ? { id: account.id, label: account.label, home: this.home(account.id) } : null
  }

  async get(id: string | null | undefined): Promise<CodexAccountRef | null> {
    const state = await this.read()
    const account = state.accounts.find(a => a.id === (id ?? DEFAULT_ACCOUNT_ID))
    return account ? { id: account.id, label: account.label, home: this.home(account.id) } : null
  }

  async autoSwitch() {
    return (await this.read()).autoSwitch
  }

  /** Newest usage windows (and Codex account id) seen for an account after an attempt. */
  async recordEvidence(id: string, evidence: { rateLimits: CodexRateLimits | null; accountId?: string | null }) {
    await this.mutate(state => {
      const account = state.accounts.find(a => a.id === id)
      if (!account) return
      if (evidence.rateLimits) account.lastLimits = evidence.rateLimits
      if (evidence.accountId) account.accountId = evidence.accountId
      const reset = limitResetFrom(evidence.rateLimits)
      if (reset) { account.limitedUntil = reset; account.limitReason = 'Codex usage limit reached.' }
    })
  }

  /** The account reported its limit or lost its sign-in: keep new pages off it until [until]. */
  async markLimited(id: string, reason: string, until: string | null) {
    let limitedUntil = until
    await this.mutate(state => {
      const account = state.accounts.find(a => a.id === id)
      if (!account) return
      limitedUntil = until ?? limitResetFrom(account.lastLimits) ?? new Date(Date.now() + FALLBACK_LIMIT_MS).toISOString()
      account.limitedUntil = limitedUntil
      account.limitReason = reason.slice(0, 200)
    })
    return limitedUntil
  }

  /** Usage windows per account for the Running processes panel: local session records only (no sign-in check, no network). */
  async usage(): Promise<{ autoSwitch: boolean; accounts: { id: string; label: string; enabled: boolean; limited: boolean; limitedUntil: string | null; limitReason: string | null; limits: CodexRateLimits | null }[] }> {
    const state = await this.read()
    const accounts = await Promise.all(state.accounts.map(async a => {
      const recorded = await latestRateLimits(this.home(a.id)).catch(() => null)
      const limits = recorded && (!a.lastLimits || recorded.at > a.lastLimits.at) ? recorded : a.lastLimits
      return { id: a.id, label: a.label, enabled: a.enabled, limited: isLimited(a), limitedUntil: a.limitedUntil, limitReason: a.limitReason, limits }
    }))
    return { autoSwitch: state.autoSwitch, accounts }
  }

  // ─── Settings view ───

  async view(): Promise<{ autoSwitch: boolean; accounts: CodexAccountView[] }> {
    const state = await this.read()
    const executable = await this.deps.executable?.().catch(() => null) ?? null
    const accounts = await Promise.all(state.accounts.map(async a => {
      const home = this.home(a.id)
      const login = executable ? await codexAccount(executable, home).catch(() => null) : null
      const limits = await latestRateLimits(home).catch(() => null)
      const lastLimits = limits && (!a.lastLimits || limits.at > a.lastLimits.at) ? limits : a.lastLimits
      return { ...a, lastLimits, builtIn: a.id === DEFAULT_ACCOUNT_ID, login, limited: isLimited(a), duplicateOf: null as string | null }
    }))
    for (const a of accounts) {
      const twin = a.accountId ? accounts.find(b => b !== a && b.accountId === a.accountId) : null
      if (twin) a.duplicateOf = twin.label
    }
    return { autoSwitch: state.autoSwitch, accounts }
  }
}
