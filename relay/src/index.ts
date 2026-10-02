/**
 * Sleeper-Cell relay: carries the phone's status receipts to Manhwa Studio,
 * and Manhwa Studio's "Refresh from phone" requests to the phone, without
 * touching R2. One Durable Object ("main") holds the last copy of each
 * receipt in its SQLite storage, so whichever side connects later still gets
 * the current state, even when the other side is offline or the Mac is off.
 *
 *   POST /receipt/:kind   phone → relay. Body: the receipt JSON (kind: sync | scripts | crops).
 *                         Stored, then pushed to every connected desktop.
 *   POST /request         desktop → relay, when its socket is down. Body: { id, requestedAt, action? }.
 *   GET  /state           what is stored (sizes and times, not bodies), and who is connected.
 *   GET  /ws?role=desktop|phone   WebSocket. A desktop is sent { type: 'hello' } and every
 *                         stored receipt, then each new one. A phone is sent the last request.
 *
 * Messages on the sockets (JSON):
 *   relay → desktop  { type: 'hello', phones, request } · { type: 'receipt', kind, at, body }
 *                    { type: 'presence', phones } · { type: 'requested', id, phones }
 *   desktop → relay  { type: 'request', id, requestedAt, action? }
 *   relay → phone    { type: 'request', id, requestedAt, action? }
 *
 * `action` is optional: "sync" asks the phone to also check R2 for chapters the
 * desktop just sent, before it answers with its receipts.
 *   either → relay   "ping"; the runtime answers "pong" without waking the object.
 *
 * Every request needs `Authorization: Bearer <RELAY_TOKEN>` (or `?token=` for
 * WebSocket clients that can't set headers). Sockets use the hibernation API,
 * so an idle connection costs nothing on the Workers free plan.
 */

import { DurableObject } from 'cloudflare:workers'

export interface Env {
  RELAY: DurableObjectNamespace<Relay>
  RELAY_TOKEN: string
}

type Role = 'desktop' | 'phone'

const KINDS = new Set(['sync', 'scripts', 'crops'])

/** Durable Object WebSocket messages are capped at 1 MiB; a receipt must fit in one. */
const MAX_BODY = 1_000_000

const encoder = new TextEncoder()

function tokenMatches(given: string | null, expected: string): boolean {
  if (!given) return false
  const a = encoder.encode(given)
  const b = encoder.encode(expected)
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.RELAY_TOKEN) return new Response('RELAY_TOKEN is not set on the Worker', { status: 500 })
    const url = new URL(request.url)
    const header = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? null
    if (!tokenMatches(header ?? url.searchParams.get('token'), env.RELAY_TOKEN)) {
      return new Response('Unauthorized', { status: 401 })
    }
    return env.RELAY.get(env.RELAY.idFromName('main')).fetch(request)
  }
} satisfies ExportedHandler<Env>

interface StoredRequest { id: string; requestedAt: string; action?: string }

/** What a request may ask of the phone besides its receipts. */
const ACTIONS = new Set(['sync'])

export class Relay extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec('CREATE TABLE IF NOT EXISTS receipts (kind TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL)')
    this.sql.exec('CREATE TABLE IF NOT EXISTS requests (slot INTEGER PRIMARY KEY, id TEXT NOT NULL, requested_at TEXT NOT NULL)')
    // Added after the first deploy; an object created before then lacks it.
    const columns = this.sql.exec<{ name: string }>('PRAGMA table_info(requests)').toArray().map(c => c.name)
    if (!columns.includes('action')) this.sql.exec('ALTER TABLE requests ADD COLUMN action TEXT')
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/ws') return this.accept(request, url.searchParams.get('role'))
    if (request.method === 'POST' && url.pathname.startsWith('/receipt/')) {
      return this.postReceipt(decodeURIComponent(url.pathname.slice('/receipt/'.length)), await request.text())
    }
    if (request.method === 'POST' && url.pathname === '/request') {
      const stored = this.storeRequest(await request.json().catch(() => null))
      return stored ? Response.json({ ok: true, phones: stored.phones }) : new Response('Bad request', { status: 400 })
    }
    if (request.method === 'GET' && url.pathname === '/state') {
      const receipts = this.sql.exec<{ kind: string; at: number; size: number }>(
        'SELECT kind, at, length(body) AS size FROM receipts'
      ).toArray()
      return Response.json({ receipts, request: this.lastRequest(), phones: this.count('phone'), desktops: this.count('desktop') })
    }
    return new Response('Not found', { status: 404 })
  }

  private accept(request: Request, role: string | null): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 })
    }
    if (role !== 'desktop' && role !== 'phone') return new Response('role must be desktop or phone', { status: 400 })

    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server, [role])
    if (role === 'desktop') {
      server.send(JSON.stringify({ type: 'hello', phones: this.count('phone'), request: this.lastRequest() }))
      for (const row of this.sql.exec<{ kind: string; body: string; at: number }>('SELECT kind, body, at FROM receipts')) {
        server.send(receiptMessage(row.kind, row.body, row.at))
      }
    } else {
      const last = this.lastRequest()
      if (last) server.send(JSON.stringify({ type: 'request', ...last }))
      this.broadcastPresence()
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || this.roleOf(ws) !== 'desktop') return
    let parsed: unknown
    try {
      parsed = JSON.parse(message)
    } catch {
      return
    }
    if ((parsed as { type?: unknown })?.type !== 'request') return
    const stored = this.storeRequest(parsed)
    if (stored) ws.send(JSON.stringify({ type: 'requested', id: stored.request.id, phones: stored.phones }))
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.closed(ws, code, reason)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.closed(ws)
  }

  private closed(ws: WebSocket, code?: number, reason?: string): void {
    try {
      ws.close(code, reason)
    } catch {
      // Already closed, or a reserved code (1005/1006) that can't be echoed.
    }
    if (this.roleOf(ws) === 'phone') this.broadcastPresence(ws)
  }

  private postReceipt(kind: string, text: string): Response {
    if (!KINDS.has(kind)) return new Response(`Unknown receipt kind "${kind}"`, { status: 404 })
    if (text.length > MAX_BODY) return new Response('Receipt too large', { status: 413 })
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return new Response('Receipt is not JSON', { status: 400 })
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Response('Receipt must be a JSON object', { status: 400 })
    }
    const at = Date.now()
    this.sql.exec(
      'INSERT INTO receipts (kind, body, at) VALUES (?, ?, ?) ON CONFLICT(kind) DO UPDATE SET body = excluded.body, at = excluded.at',
      kind, text, at
    )
    const message = receiptMessage(kind, text, at)
    for (const ws of this.sockets('desktop')) ws.send(message)
    return Response.json({ ok: true, at, desktops: this.count('desktop') })
  }

  /** Saves a request and passes it to every connected phone. Null when it isn't a valid request. */
  private storeRequest(value: unknown): { request: StoredRequest; phones: number } | null {
    const { id, requestedAt, action } = (value ?? {}) as { id?: unknown; requestedAt?: unknown; action?: unknown }
    if (typeof id !== 'string' || !id || id.length > 100) return null
    const request: StoredRequest = { id, requestedAt: typeof requestedAt === 'string' ? requestedAt : new Date().toISOString() }
    if (typeof action === 'string' && ACTIONS.has(action)) request.action = action
    this.sql.exec(
      'INSERT INTO requests (slot, id, requested_at, action) VALUES (1, ?, ?, ?) ' +
        'ON CONFLICT(slot) DO UPDATE SET id = excluded.id, requested_at = excluded.requested_at, action = excluded.action',
      request.id, request.requestedAt, request.action ?? null
    )
    const message = JSON.stringify({ type: 'request', ...request })
    const phones = this.sockets('phone')
    for (const ws of phones) ws.send(message)
    return { request, phones: phones.length }
  }

  private lastRequest(): StoredRequest | null {
    const row = this.sql.exec<{ id: string; requested_at: string; action: string | null }>(
      'SELECT id, requested_at, action FROM requests WHERE slot = 1'
    ).toArray()[0]
    if (!row) return null
    return row.action ? { id: row.id, requestedAt: row.requested_at, action: row.action } : { id: row.id, requestedAt: row.requested_at }
  }

  private broadcastPresence(except?: WebSocket): void {
    const message = JSON.stringify({ type: 'presence', phones: this.count('phone', except) })
    for (const ws of this.sockets('desktop')) ws.send(message)
  }

  private roleOf(ws: WebSocket): Role | null {
    const tag = this.ctx.getTags(ws)[0]
    return tag === 'desktop' || tag === 'phone' ? tag : null
  }

  private sockets(role: Role, except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets(role).filter(ws => ws !== except && ws.readyState === WebSocket.READY_STATE_OPEN)
  }

  private count(role: Role, except?: WebSocket): number {
    return this.sockets(role, except).length
  }
}

/** `body` is already-validated JSON text, so it is spliced in rather than parsed and re-encoded. */
function receiptMessage(kind: string, body: string, at: number): string {
  return `{"type":"receipt","kind":${JSON.stringify(kind)},"at":${at},"body":${body}}`
}
