/**
 * Cloudflare's own count of R2 requests this month, read from its GraphQL
 * Analytics API: the numbers the dashboard shows, covering every client
 * (Sleeper-Cell, the dashboard, other tools), not just this server.
 *
 * Needs CF_ANALYTICS_TOKEN, an API token with Account → Account Analytics →
 * Read, saved in Settings → Cloudflare. The R2 access keys can't read
 * analytics. Without it, r2Usage.ts's local ledger (this server's requests
 * only) is used instead.
 *
 * Counts are for the whole account, since that is what the free plan limits,
 * and run a few minutes behind. Reading them costs no R2 operations; the
 * result is cached for a minute.
 */

import { classifyOp, type MonthUsage } from './r2Usage.js'

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql'
const CACHE_MS = 60_000

const QUERY = `
query R2Operations($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
        sum { requests }
        dimensions { actionType }
      }
    }
  }
}`

interface GraphQLReply {
  data?: { viewer?: { accounts?: { r2OperationsAdaptiveGroups?: { sum?: { requests?: number }; dimensions?: { actionType?: string } }[] }[] } }
  errors?: { message?: string }[] | null
}

let cache: { key: string; at: number; value: MonthUsage } | null = null

export function analyticsConfigured(): boolean {
  return !!(process.env.CF_ANALYTICS_TOKEN || '').trim() && !!(process.env.R2_ACCOUNT_ID || '').trim()
}

/** Forget the cached count, e.g. after the token changes. */
export function invalidateAnalytics(): void {
  cache = null
}

/** This UTC month's requests by class, from Cloudflare. Null when no token is set. Throws with the reason. */
export async function getCloudflareMonthOps(): Promise<MonthUsage | null> {
  const token = (process.env.CF_ANALYTICS_TOKEN || '').trim()
  const accountTag = (process.env.R2_ACCOUNT_ID || '').trim()
  if (!token || !accountTag) return null

  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const key = `${accountTag}:${start}`
  if (cache?.key === key && Date.now() - cache.at < CACHE_MS) return cache.value

  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { accountTag, start, end: now.toISOString() } })
    })
  } catch (error) {
    throw new Error(`Could not reach Cloudflare analytics: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Cloudflare refused the analytics token: it needs Account → Account Analytics → Read on this account')
  }
  if (!res.ok) throw new Error(`Cloudflare analytics answered HTTP ${res.status}`)

  const reply = (await res.json()) as GraphQLReply
  if (reply.errors?.length) {
    const message = reply.errors.map(e => e.message).filter(Boolean).join('; ')
    throw new Error(/auth|permission|access/i.test(message)
      ? 'Cloudflare refused the analytics token: it needs Account → Account Analytics → Read on this account'
      : `Cloudflare analytics: ${message || 'unknown error'}`)
  }
  const account = reply.data?.viewer?.accounts?.[0]
  if (!account) throw new Error('Cloudflare analytics returned no data for this account (check the Account ID)')

  const value: MonthUsage = { classA: 0, classB: 0, free: 0, ops: {}, since: start }
  for (const group of account.r2OperationsAdaptiveGroups ?? []) {
    const op = group.dimensions?.actionType || 'Unknown'
    const requests = Number(group.sum?.requests) || 0
    const cls = classifyOp(op)
    if (cls === 'A') value.classA += requests
    else if (cls === 'B') value.classB += requests
    else value.free += requests
    value.ops[op] = (value.ops[op] ?? 0) + requests
  }
  cache = { key, at: Date.now(), value }
  return value
}
