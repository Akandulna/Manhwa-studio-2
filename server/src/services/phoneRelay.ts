/**
 * Live link to the Sleeper-Cell phone through the relay Worker (relay/ in this
 * repo): a Cloudflare Worker + Durable Object that keeps the phone's last
 * receipts and passes messages both ways, so status needs no R2 operations.
 *
 * While the server runs it holds one WebSocket to the relay. On connect the
 * relay sends every receipt it holds, then each new one the moment the phone
 * posts it; they are kept here in memory, and r2Service serves them instead of
 * reading R2. Each arrival is pushed to the browser as `phone:receipt`
 * ({ kind }), and connection/phone presence changes as `phone:relay`.
 * "Refresh from phone" goes to the relay as a request message.
 *
 * Settings → Cloudflare writes RELAY_URL / RELAY_TOKEN to the server's .env.
 * Without them nothing here runs and r2Service falls back to R2.
 *
 * Cost on the Workers free plan: a connect is one request; a "ping" every
 * PING_MS is answered by the runtime without waking the Durable Object; an
 * idle socket costs nothing (hibernation). Reconnects back off to a minute.
 */

import { randomUUID } from 'crypto'
import WebSocket from 'ws'
import type { Server } from 'socket.io'
import { writeEnvVars } from '../utils/envFile.js'

export type ReceiptKind = 'sync' | 'scripts' | 'crops'

const KINDS = new Set<string>(['sync', 'scripts', 'crops'])

export interface RelayStatus {
  configured: boolean
  url: string
  hasToken: boolean
  connected: boolean
  /** Sleeper-Cell sockets open right now, i.e. the app is open on the phone. */
  phones: number
  lastError: string | null
  /** When the relay last passed on a receipt. */
  lastReceiptAt: string | null
}

const PING_MS = 50_000
/** Nothing heard (not even "pong") for this long means the socket is dead, e.g. after the Mac slept. */
const DEAD_MS = 2 * PING_MS + 10_000
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000]
/** A connection that stayed up this long resets the backoff. */
const STABLE_MS = 60_000

let io: Server | null = null
let socket: WebSocket | null = null
let connected = false
let phones = 0
let lastError: string | null = null
let lastReceiptAt: number | null = null
let attempt = 0
let openedAt = 0
let lastHeard = 0
let retryTimer: NodeJS.Timeout | null = null
let pingTimer: NodeJS.Timeout | null = null
const receipts = new Map<ReceiptKind, object>()

function relayEnv(): { url: string; token: string } | null {
  const url = (process.env.RELAY_URL || '').trim().replace(/\/+$/, '')
  const token = (process.env.RELAY_TOKEN || '').trim()
  return url && token ? { url, token } : null
}

export function relayConfigured(): boolean {
  return relayEnv() !== null
}

/**
 * The relay's last copy of a receipt, or null when the relay isn't set up (so
 * the caller reads R2). `{}` when set up but the phone hasn't sent one yet.
 */
export function relayReceipt<T extends object>(kind: ReceiptKind): T | null {
  if (!relayConfigured()) return null
  return (receipts.get(kind) ?? {}) as T
}

export function relayStatus(): RelayStatus {
  const url = (process.env.RELAY_URL || '').trim()
  return {
    configured: relayConfigured(),
    url,
    hasToken: !!(process.env.RELAY_TOKEN || '').trim(),
    connected,
    phones: connected ? phones : 0,
    lastError,
    lastReceiptAt: lastReceiptAt ? new Date(lastReceiptAt).toISOString() : null
  }
}

/** Called once at boot. */
export function startPhoneRelay(server: Server): void {
  io = server
  connect()
}

function emitStatus(): void {
  io?.emit('phone:relay', relayStatus())
}

function clearTimers(): void {
  if (retryTimer) clearTimeout(retryTimer)
  if (pingTimer) clearInterval(pingTimer)
  retryTimer = null
  pingTimer = null
}

function socketUrl(base: string): string {
  const url = new URL(base)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.pathname = '/ws'
  url.search = '?role=desktop'
  return url.toString()
}

function connect(): void {
  clearTimers()
  const env = relayEnv()
  if (!env) return

  let ws: WebSocket
  try {
    ws = new WebSocket(socketUrl(env.url), { headers: { Authorization: `Bearer ${env.token}` } })
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    emitStatus()
    return
  }
  socket = ws

  ws.on('open', () => {
    if (socket !== ws) return
    connected = true
    lastError = null
    openedAt = lastHeard = Date.now()
    pingTimer = setInterval(() => heartbeat(ws), PING_MS)
    console.log('Phone relay: connected')
    emitStatus()
  })
  ws.on('message', data => {
    if (socket !== ws) return
    lastHeard = Date.now()
    handle(data.toString())
  })
  ws.on('error', error => {
    // 'close' follows and schedules the retry.
    if (socket === ws) lastError = error.message
  })
  ws.on('close', () => {
    if (socket !== ws) return
    socket = null
    const wasConnected = connected
    connected = false
    phones = 0
    clearTimers()
    if (wasConnected) console.log('Phone relay: disconnected')
    emitStatus()
    if (Date.now() - openedAt > STABLE_MS) attempt = 0
    const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]
    attempt++
    retryTimer = setTimeout(connect, delay)
  })
}

function heartbeat(ws: WebSocket): void {
  if (Date.now() - lastHeard > DEAD_MS) {
    ws.terminate()
    return
  }
  if (ws.readyState === WebSocket.OPEN) ws.send('ping')
}

function handle(text: string): void {
  if (text === 'pong') return
  let message: { type?: string; kind?: string; at?: number; body?: unknown; phones?: number }
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  switch (message.type) {
    case 'hello':
    case 'presence':
      phones = Number(message.phones) || 0
      emitStatus()
      break
    case 'receipt': {
      const { kind, body } = message
      if (!kind || !KINDS.has(kind) || !body || typeof body !== 'object' || Array.isArray(body)) return
      receipts.set(kind as ReceiptKind, body)
      lastReceiptAt = Number(message.at) || Date.now()
      io?.emit('phone:receipt', { kind })
      break
    }
  }
}

/**
 * "Refresh from phone" through the relay: the phone answers by posting its
 * receipts with `answers: id`. Over the socket when it's up, else one HTTP
 * request. `phones` says whether Sleeper-Cell is open to answer right away;
 * when it isn't, the relay keeps the request for when it opens.
 */
export async function sendPhoneRequest(): Promise<{ id: string; requestedAt: string; phones: number }> {
  const env = relayEnv()
  if (!env) throw new Error('The phone relay is not set up')
  const request = { id: randomUUID(), requestedAt: new Date().toISOString() }
  if (socket && connected && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'request', ...request }))
    return { ...request, phones }
  }
  const res = await fetch(`${env.url}/request`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  })
  if (!res.ok) throw new Error(relayHttpError(res.status))
  const body = (await res.json().catch(() => ({}))) as { phones?: number }
  return { ...request, phones: Number(body.phones) || 0 }
}

function relayHttpError(status: number): string {
  if (status === 401) return 'The relay refused the token: it must match the Worker\'s RELAY_TOKEN secret'
  if (status === 500) return 'The relay Worker has no RELAY_TOKEN secret yet (wrangler secret put RELAY_TOKEN)'
  return `The relay answered HTTP ${status}`
}

export interface RelayConfigUpdate {
  url?: string
  token?: string
  clearToken?: boolean
}

/** Saves RELAY_URL / RELAY_TOKEN (blank token keeps the saved one) and reconnects. */
export async function updateRelayConfig(update: RelayConfigUpdate): Promise<void> {
  const vars: Record<string, string> = {}
  if (update.url !== undefined) {
    const url = update.url.trim().replace(/\/+$/, '')
    if (url) {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new Error('The relay URL is not a valid URL')
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('The relay URL must start with https://')
    }
    vars.RELAY_URL = url
  }
  if (update.clearToken) vars.RELAY_TOKEN = ''
  else if (update.token?.trim()) vars.RELAY_TOKEN = update.token.trim()
  await writeEnvVars(vars)

  // Drop the old socket without letting its close handler schedule a retry.
  const old = socket
  socket = null
  connected = false
  phones = 0
  lastError = null
  attempt = 0
  receipts.clear()
  old?.terminate()
  connect()
  emitStatus()
}

/** Asks the relay what it holds, to check the URL and token. */
export async function testRelay(): Promise<{ receipts: { kind: string; at: number; size: number }[]; phones: number }> {
  const env = relayEnv()
  if (!env) throw new Error('Enter the relay URL and token first')
  let res: Response
  try {
    res = await fetch(`${env.url}/state`, { headers: { Authorization: `Bearer ${env.token}` } })
  } catch (error) {
    throw new Error(`Could not reach the relay: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!res.ok) throw new Error(relayHttpError(res.status))
  return (await res.json()) as { receipts: { kind: string; at: number; size: number }[]; phones: number }
}
