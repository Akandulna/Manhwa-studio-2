/**
 * Live link to the Sleeper-Cell phone through the relay Worker (relay/ in this
 * repo): a Cloudflare Worker + Durable Object that keeps the phone's last
 * receipts and passes messages both ways, so status needs no R2 operations.
 *
 * While the server runs it holds one WebSocket to the relay. On connect the
 * relay sends every receipt it holds, then each new one the moment a phone
 * posts it; they are kept here in memory, per phone (Sleeper-Cell can run on
 * several), and r2Service merges and serves them instead of reading R2. Each
 * arrival is pushed to the browser as `phone:receipt` ({ kind }), and
 * connection/phone presence changes as `phone:relay`.
 * "Refresh from phone" goes to the relay as a request message, and so do
 * Image Clipper's start and stop (see sendClipperCommand in r2Service) and the
 * screen controls (phoneScreen.ts). The phone's screen receipts (`screen`,
 * `screenshot`) are kept apart from the three status receipts and pushed as
 * `phone:screen` ({ device, kind }), so a screenshot doesn't reload the pages
 * that follow `phone:receipt`.
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

/**
 * What a request may ask of the phone besides its receipts: `sync` checks R2
 * for chapters just sent; `clipper_start` / `clipper_stop` start or stop Image
 * Clipper (with "Start from Manhwa Studio" on in Sleeper-Cell); `screen_on`,
 * `screen_off` and `screenshot` are Phone Status's screen controls. Keep in
 * step with ACTIONS in relay/src/index.ts, Automation.kt and RemoteScreen.kt
 * on the phone.
 */
export type PhoneAction = 'sync' | 'clipper_start' | 'clipper_stop' | 'screen_on' | 'screen_off' | 'screenshot'

/** The phone's screen state, and its browser tabs as JPEGs (see phoneScreen.ts). */
export type ScreenKind = 'screen' | 'screenshot'

/**
 * For `clipper_start`: the phone's series folder and ChatGPT tabs; without them,
 * its last run's. `chapters` limits the run to those chapter folders (a series
 * split between phones). `device` sends the request to that phone only.
 */
export interface PhoneRequestArgs {
  series?: string
  tabs?: number
  chapters?: string[]
  device?: string
}

/** One phone's copy of a receipt. `device` is its id, "" for Sleeper-Cell builds from before phones had one. */
export interface RelayedReceipt<T> {
  device: string
  /** When the relay got it (ms). */
  at: number
  body: T
}

/** A phone the relay knows of: connected now, or with receipts stored. */
export interface RelayPhone {
  /** "" for the old app, which sends no id. */
  id: string
  /** Its name in Sleeper-Cell, made unique among the phones. */
  name: string
  connected: boolean
}

const KINDS = new Set<string>(['sync', 'scripts', 'crops'])
const SCREEN_KINDS = new Set<string>(['screen', 'screenshot'])

export interface RelayStatus {
  configured: boolean
  url: string
  hasToken: boolean
  connected: boolean
  /**
   * Sleeper-Cell sockets open right now: the app is open on the phone, or its
   * "Start from Manhwa Studio" setting keeps the socket open in the background.
   */
  phones: number
  /** The phones connected now, and those the relay holds receipts from. */
  devices: RelayPhone[]
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
/** The phones connected, as the relay last said; empty from relays deployed before phones had ids. */
let presence: { id: string; name: string }[] = []
let lastError: string | null = null
let lastReceiptAt: number | null = null
let attempt = 0
let openedAt = 0
let lastHeard = 0
let retryTimer: NodeJS.Timeout | null = null
let pingTimer: NodeJS.Timeout | null = null
/** By phone id, then kind. */
const receipts = new Map<string, Map<ReceiptKind, { at: number; body: object }>>()
/** By phone id, then kind. */
const screens = new Map<string, Map<ScreenKind, { at: number; body: object }>>()

function relayEnv(): { url: string; token: string } | null {
  const url = (process.env.RELAY_URL || '').trim().replace(/\/+$/, '')
  const token = (process.env.RELAY_TOKEN || '').trim()
  return url && token ? { url, token } : null
}

export function relayConfigured(): boolean {
  return relayEnv() !== null
}

/**
 * Each phone's last copy of a receipt, or null when the relay isn't set up (so
 * the caller reads R2). Empty when set up but no phone has sent one yet.
 */
export function relayReceipts<T extends object>(kind: ReceiptKind): RelayedReceipt<T>[] | null {
  if (!relayConfigured()) return null
  const list: RelayedReceipt<T>[] = []
  for (const [device, kinds] of receipts) {
    const stored = kinds.get(kind)
    if (stored) list.push({ device, at: stored.at, body: stored.body as T })
  }
  return list.sort((a, b) => phoneName(a.device).localeCompare(phoneName(b.device)))
}

/** Each phone's last copy of a screen receipt; empty without the relay. */
export function relayScreens<T extends object>(kind: ScreenKind): RelayedReceipt<T>[] {
  const list: RelayedReceipt<T>[] = []
  for (const [device, kinds] of screens) {
    const stored = kinds.get(kind)
    if (stored) list.push({ device, at: stored.at, body: stored.body as T })
  }
  return list
}

/**
 * Every phone the relay knows of. Its name is what it calls itself (on its
 * socket, else in its newest receipt that names it); two phones with the
 * same name (same model, never renamed) get the start of their id added.
 */
export function relayPhones(): RelayPhone[] {
  const named = new Map<string, { name: string; connected: boolean }>()
  for (const [device, kinds] of receipts) {
    const name = [...kinds.values()]
      .sort((a, b) => b.at - a.at)
      .map(stored => (stored.body as { device?: unknown }).device)
      .find((name): name is string => typeof name === 'string' && !!name.trim())
    named.set(device, { name: name?.trim() ?? '', connected: false })
  }
  for (const device of presence) {
    const known = named.get(device.id)
    named.set(device.id, { name: device.name.trim() || known?.name || '', connected: true })
  }
  // A relay deployed before phones had ids counts them but doesn't list them: all it can carry is the old app's.
  if (!presence.length && connected && phones > 0) {
    named.set('', { name: named.get('')?.name ?? '', connected: true })
  }
  const list = [...named].map(([id, phone]) => ({
    id,
    name: (phone.name || 'Phone') + (id ? '' : ' (old app)'),
    connected: phone.connected
  }))
  const counts = new Map<string, number>()
  for (const phone of list) counts.set(phone.name, (counts.get(phone.name) ?? 0) + 1)
  for (const phone of list) if (phone.id && counts.get(phone.name)! > 1) phone.name = `${phone.name} · ${phone.id.slice(0, 4)}`
  return list.sort((a, b) => a.name.localeCompare(b.name))
}

/** A phone's name as relayPhones gives it. */
export function phoneName(device: string): string {
  return relayPhones().find(p => p.id === device)?.name ?? (device ? 'Phone' : 'Phone (old app)')
}

export function relayStatus(): RelayStatus {
  const url = (process.env.RELAY_URL || '').trim()
  return {
    configured: relayConfigured(),
    url,
    hasToken: !!(process.env.RELAY_TOKEN || '').trim(),
    connected,
    phones: connected ? phones : 0,
    devices: connected || receipts.size ? relayPhones() : [],
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
    presence = []
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

function parseDevices(raw: unknown): { id: string; name: string }[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((d): d is { id: string; name?: unknown } => !!d && typeof d === 'object' && typeof (d as { id?: unknown }).id === 'string')
    .map(d => ({ id: d.id, name: typeof d.name === 'string' ? d.name : '' }))
}

function handle(text: string): void {
  if (text === 'pong') return
  let message: { type?: string; kind?: string; device?: unknown; at?: number; body?: unknown; phones?: number; devices?: unknown }
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  switch (message.type) {
    case 'hello':
    case 'presence':
      phones = Number(message.phones) || 0
      presence = parseDevices(message.devices)
      emitStatus()
      break
    case 'receipt': {
      const { kind, body } = message
      if (!kind || !body || typeof body !== 'object' || Array.isArray(body)) return
      // A relay deployed before phones had ids sends none: one phone, as before.
      const device = typeof message.device === 'string' ? message.device : ''
      const at = Number(message.at) || Date.now()
      if (SCREEN_KINDS.has(kind)) {
        const kinds = screens.get(device) ?? new Map<ScreenKind, { at: number; body: object }>()
        kinds.set(kind as ScreenKind, { at, body })
        screens.set(device, kinds)
        io?.emit('phone:screen', { device, kind })
        return
      }
      if (!KINDS.has(kind)) return
      const kinds = receipts.get(device) ?? new Map<ReceiptKind, { at: number; body: object }>()
      kinds.set(kind as ReceiptKind, { at, body })
      receipts.set(device, kinds)
      lastReceiptAt = at
      io?.emit('phone:receipt', { kind })
      break
    }
    case 'forgotten': {
      if (typeof message.device !== 'string') return
      if (screens.delete(message.device)) io?.emit('phone:screen', { device: message.device })
      if (!receipts.delete(message.device)) return
      for (const kind of KINDS) io?.emit('phone:receipt', { kind })
      emitStatus()
      break
    }
  }
}

/**
 * "Refresh from phone" through the relay: the phone answers by posting its
 * receipts with `answers: id`. Over the socket when it's up, else one HTTP
 * request. `phones` says whether Sleeper-Cell is open to answer right away;
 * when it isn't, the relay keeps the request for when it opens. `action:
 * 'sync'` has the phone first check R2 for chapters just sent; a relay
 * deployed before actions existed drops it, and the phone only answers.
 * `args` go with `clipper_start` (a relay deployed before it drops both), but
 * `args.device` goes with any action: then only that phone gets it, and
 * `phones` is 1 or 0.
 */
export async function sendPhoneRequest(
  action?: PhoneAction,
  args: PhoneRequestArgs = {}
): Promise<{ id: string; requestedAt: string; phones: number }> {
  const env = relayEnv()
  if (!env) throw new Error('The phone relay is not set up')
  const request = {
    id: randomUUID(),
    requestedAt: new Date().toISOString(),
    ...(action ? { action } : {}),
    ...(args.device ? { device: args.device } : {}),
    ...(args.series ? { series: args.series } : {}),
    ...(args.tabs ? { tabs: args.tabs } : {}),
    ...(args.chapters?.length ? { chapters: args.chapters } : {})
  }
  if (socket && connected && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'request', ...request }))
    const reached = args.device ? Number(presence.some(d => d.id === args.device)) : phones
    return { ...request, phones: reached }
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
  presence = []
  lastError = null
  attempt = 0
  receipts.clear()
  screens.clear()
  old?.terminate()
  connect()
  emitStatus()
}

/**
 * Drops a phone the relay keeps receipts from: one that's gone, or the old
 * app's copies once that phone runs a build with an id. The relay tells every
 * desktop, which drops them too (see 'forgotten').
 */
export async function forgetPhone(device: string): Promise<void> {
  const env = relayEnv()
  if (!env) throw new Error('The phone relay is not set up')
  const res = await fetch(`${env.url}/forget`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device })
  })
  if (res.status === 404) throw new Error('Redeploy the relay Worker (relay/ → npm run deploy): this one keeps a single phone')
  if (!res.ok) throw new Error(relayHttpError(res.status))
  if (screens.delete(device)) io?.emit('phone:screen', { device })
  if (receipts.delete(device)) {
    for (const kind of KINDS) io?.emit('phone:receipt', { kind })
    emitStatus()
  }
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
