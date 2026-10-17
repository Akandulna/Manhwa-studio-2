/**
 * Sleeper-Cell relay: carries the phones' status receipts to Manhwa Studio,
 * and Manhwa Studio's "Refresh from phone" requests to the phones, without
 * touching R2. One Durable Object ("main") holds the last copy of each
 * receipt of each phone in its SQLite storage, so whichever side connects
 * later still gets the current state, even when the other side is offline or
 * the Mac is off.
 *
 * Phones: Sleeper-Cell names itself with a device id (a random id it keeps)
 * and a name the user can change. Builds from before then send neither; they
 * count as the device "" and are shown as one phone on the old app.
 *
 *   POST /receipt/:kind?device=<id>[&replaces=legacy]   phone → relay. Body: the receipt JSON
 *                         (kind: sync | scripts | crops | screen | screenshot). Stored under the phone's id, then pushed to every
 *                         connected desktop. `replaces=legacy` comes from a phone that sent receipts before
 *                         it had an id: those (device "") are its own old copies and are dropped. The answer
 *                         echoes `device`, which tells the phone it may stop sending `replaces`.
 *   POST /request         desktop → relay, when its socket is down. Body: { id, requestedAt, action?, device? }.
 *   POST /forget          desktop → relay. Body: { device }. Drops that phone's receipts and requests.
 *   GET  /state           what is stored (sizes and times, not bodies), and who is connected.
 *   GET  /ws?role=desktop|phone[&device=<id>&name=<name>]   WebSocket. A desktop is sent { type: 'hello' }
 *                         and every stored receipt, then each new one. A phone is sent the requests meant for it.
 *
 * Messages on the sockets (JSON):
 *   relay → desktop  { type: 'hello', phones, devices, seen, request } · { type: 'receipt', kind, device, at, body }
 *                    { type: 'presence', phones, devices, seen } · { type: 'requested', id, phones }
 *                    { type: 'forgotten', device }
 *   desktop → relay  { type: 'request', id, requestedAt, action?, device?, series?, tabs?, chapters?, ai?, flow?, language?, profile?, chatGpt? }
 *   relay → phone    { type: 'request', id, requestedAt, action?, device?, series?, tabs?, chapters?, ai?, flow?, language?, profile?, chatGpt? }
 *
 * `phones` counts the phones connected; `devices` lists them: [{ id, name }].
 * `seen` lists every phone with an id that ever connected: [{ id, name, at, left }]. `left` is null while it's
 * connected (`at` is then when it was last heard, to within CHECK_MS), else how it went at `at`: "closed" (the
 * app closed its link: Sleeper-Cell closed, or "Start from Manhwa Studio" turned off), "shutdown" (the phone
 * switching off), or "lost" (the link broke, or its pings stopped: off, out of battery, or offline).
 * While a phone is connected an alarm runs every CHECK_MS: a phone keeps its CPU awake while connected and
 * pings every 50 s, so a socket with no ping for SILENT_MS is a phone that is gone, and is closed.
 *
 * `device` on a request sends it to that phone only; without it, it goes to
 * every phone. The last request for each (and the last one for all) is kept
 * and handed to a phone when it connects, oldest first.
 *
 * `action` is optional: "sync" asks the phone to also check R2 for chapters the
 * desktop just sent, before it answers with its receipts. "clipper_start" starts
 * Image Clipper on the phone, on `series` in `tabs` ChatGPT tabs (both optional:
 * the phone's last run and tab count), and only on the chapter folders in
 * `chapters` when given (the desktop splitting a series between phones),
 * waking it if need be; `ai` ("chatgpt" | "aistudio" | "gemini") and `flow` ("classic" |
 * "steps") pick where and how it prompts the pages. "narration_start" writes
 * `series`' scripts (`ai`: "aistudio" | "gemini", when given), "editor_start"
 * makes its Editor 2.0 timelines in `language` ("en" | "hi") in `tabs` ChatGPT
 * tabs, and "voiceover_start" voices its splits in `language` in `tabs` tabs;
 * those two only on `chapters` when given (a split, as for Image Clipper; a
 * phone already running it on `series` takes them as its new scope). Narration
 * is never split: one phone writes a series' chapters in order. "clipper_stop" stops Image Clipper, "run_stop"
 * whichever run is going, and "run_finish" has it stop once what it's on is done. The phone acts on those only
 * with its "Start from Manhwa Studio" setting on, and ignores ones older than
 * 10 minutes, as requests are handed over again whenever it connects.
 * "screen_on" turns the phone's screen on with Sleeper-Cell over the lock
 * screen, kept on until "screen_off"; "screenshot" has it post its browser
 * tabs as a "screenshot" receipt. It answers each with a "screen" receipt, and
 * ignores them after 2 minutes. "profile_select" makes `profile` the browser
 * profile the next run starts in (only with no run going), and
 * "chatgpt_options" has the phone read what that profile's ChatGPT account
 * offers; they answer in the crops receipt's profiles. "clipper_start" may carry `chatGpt` ({ mode,
 * model, effort }, each a name or null): Image Clipper's ChatGPT choices,
 * which the phone keeps for its later runs. A screenshot is never stored: it is passed to
 * the desktops connected at the time, and is lost when none is.
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

/** `screen` is the phone's screen state; `screenshot` its browser tabs as JPEGs, posted when asked (see PASS_ONLY). */
const KINDS = new Set(['sync', 'scripts', 'crops', 'screen', 'screenshot', 'library', 'process'])
/** Kinds passed to the desktops connected now and never stored: the user wants screenshots kept nowhere. */
const PASS_ONLY = new Set(['screenshot'])

/** Durable Object WebSocket messages are capped at 1 MiB; a receipt must fit in one. */
const MAX_BODY = 1_000_000

/** A phone's id: what Sleeper-Cell generates, with room to spare. "" is the old app, which sends none. */
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_NAME = 60
/** Chapter folders one start may name, and their length. */
const MAX_CHAPTERS = 1000
const MAX_CHAPTER_NAME = 200

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

interface StoredRequest {
  id: string
  requestedAt: string
  action?: string
  /** The one phone it's for; every phone when absent. */
  device?: string
  series?: string
  tabs?: number
  chapters?: string[]
  /** Image Clipper's AI and prompt flow; the narration run's AI. */
  ai?: string
  flow?: string
  /** Editor 2.0's and the voiceover's narration language. */
  language?: string
  /** The browser profile a PROFILE_ACTIONS request is about. */
  profile?: string
  /** Image Clipper's ChatGPT mode, model and effort, which the phone keeps for its later runs too. */
  chatGpt?: ChatGptSettings
}

/** What a phone socket carries across hibernation; `at` is when it connected. */
interface PhoneAttachment { device: string; name: string; at?: number }

/** How a phone's link ended (see `seen` above). */
type Left = 'closed' | 'shutdown' | 'lost'

interface SeenPhone { id: string; name: string; at: number; left: Left | null }

/** How often a connected phone's pings are checked, and how long without one means it's gone. */
const CHECK_MS = 60_000
const SILENT_MS = 150_000

/** What a request may ask of the phone besides its receipts. */
const ACTIONS = new Set([
  'sync', 'clipper_start', 'clipper_stop', 'narration_start', 'editor_start', 'voiceover_start', 'run_stop', 'run_finish',
  'screen_on', 'screen_off', 'screenshot', 'profile_select', 'chatgpt_options'
])

/** Actions on one of the phone's browser profiles, named by `profile`. */
const PROFILE_ACTIONS = new Set(['profile_select', 'chatgpt_options'])
const MAX_PROFILE = 100
/** A ChatGPT setting's longest name (a model's, say). */
const MAX_SETTING = 100

type ChatGptSettings = { mode: string | null; model: string | null; effort: string | null }

/** `chatGpt` as a clipper start carries it: each a name, or null for "as the account has it". Null when malformed. */
function chatGptSettings(value: unknown): ChatGptSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const pick = (v: unknown): string | null | undefined =>
    v === null || v === undefined || v === '' ? null : typeof v === 'string' && v.length <= MAX_SETTING ? v : undefined
  const { mode, model, effort } = value as Record<string, unknown>
  const settings = { mode: pick(mode), model: pick(model), effort: pick(effort) }
  if (settings.mode === undefined || settings.model === undefined || settings.effort === undefined) return null
  if (settings.mode !== null && settings.mode !== 'Chat' && settings.mode !== 'Work') return null
  return settings as ChatGptSettings
}

/** The actions that start a run on `series`. */
const START_ACTIONS = new Set(['clipper_start', 'narration_start', 'editor_start', 'voiceover_start'])
/** The runs that take `tabs`. */
const TAB_ACTIONS = new Set(['clipper_start', 'editor_start', 'voiceover_start'])
/** The runs that take `chapters`: a phone's share of a series split between phones (or a running one's new scope). */
const CHAPTER_ACTIONS = new Set(['clipper_start', 'editor_start', 'voiceover_start'])
/** The runs that take a `language`. */
const LANGUAGE_ACTIONS = new Set(['editor_start', 'voiceover_start'])

const AIS = new Set(['chatgpt', 'aistudio', 'gemini'])
/** The narration run's AI: Gemini in AI Studio, or Gemini on the web. */
const NARRATION_AIS = new Set(['aistudio', 'gemini'])
const FLOWS = new Set(['classic', 'steps'])
const LANGUAGES = new Set(['en', 'hi'])

/** The most tabs a run takes at once (ClipperRun.MAX_TABS, EditorRun.MAX_TABS and VoiceoverRun.MAX_TABS on the phone). */
const MAX_TABS = 4

const DEVICE_TAG = 'device:'

export class Relay extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.migrate()
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  /**
   * Receipts and requests are kept per phone. The first relay kept one of each,
   * from the one phone there was: those move over as the old app's (device "").
   */
  private migrate(): void {
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS phone_receipts (device TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, ' +
        'PRIMARY KEY (device, kind))'
    )
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS phone_requests (target TEXT PRIMARY KEY, id TEXT NOT NULL, requested_at TEXT NOT NULL, ' +
        'action TEXT, series TEXT, tabs INTEGER, chapters TEXT, options TEXT)'
    )
    // `options` (ai, flow, language as JSON) came with starting runs other than Image Clipper.
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS phone_seen (device TEXT PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL, left TEXT)'
    )
    const requestColumns = this.sql.exec<{ name: string }>('PRAGMA table_info(phone_requests)').toArray().map(c => c.name)
    if (!requestColumns.includes('options')) this.sql.exec('ALTER TABLE phone_requests ADD COLUMN options TEXT')
    const tables = new Set(this.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map(t => t.name))
    if (tables.has('receipts')) {
      this.sql.exec("INSERT OR IGNORE INTO phone_receipts (device, kind, body, at) SELECT '', kind, body, at FROM receipts")
      this.sql.exec('DROP TABLE receipts')
    }
    if (tables.has('requests')) {
      const columns = this.sql.exec<{ name: string }>('PRAGMA table_info(requests)').toArray().map(c => c.name)
      const pick = (name: string) => (columns.includes(name) ? name : 'NULL')
      this.sql.exec(
        `INSERT OR IGNORE INTO phone_requests (target, id, requested_at, action, series, tabs) ` +
          `SELECT '', id, requested_at, ${pick('action')}, ${pick('series')}, ${pick('tabs')} FROM requests WHERE slot = 1`
      )
      this.sql.exec('DROP TABLE requests')
    }
    // Stored by the first build that carried screenshots.
    for (const kind of PASS_ONLY) this.sql.exec('DELETE FROM phone_receipts WHERE kind = ?', kind)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/ws') return await this.accept(request, url)
    if (request.method === 'POST' && url.pathname.startsWith('/receipt/')) {
      // Read before any answer: the runtime faults on a body left unread.
      const text = await request.text()
      const device = url.searchParams.get('device') ?? ''
      if (device && !DEVICE_ID.test(device)) return new Response('Bad device id', { status: 400 })
      return this.postReceipt(
        decodeURIComponent(url.pathname.slice('/receipt/'.length)),
        device,
        text,
        url.searchParams.get('replaces') === 'legacy'
      )
    }
    if (request.method === 'POST' && url.pathname === '/request') {
      const stored = this.storeRequest(await request.json().catch(() => null))
      return stored ? Response.json({ ok: true, phones: stored.phones }) : new Response('Bad request', { status: 400 })
    }
    if (request.method === 'POST' && url.pathname === '/forget') {
      const { device } = ((await request.json().catch(() => null)) ?? {}) as { device?: unknown }
      if (typeof device !== 'string' || (device && !DEVICE_ID.test(device))) return new Response('Bad device id', { status: 400 })
      this.forget(device)
      return Response.json({ ok: true })
    }
    if (request.method === 'GET' && url.pathname === '/state') {
      const receipts = this.sql.exec<{ device: string; kind: string; at: number; size: number }>(
        'SELECT device, kind, at, length(body) AS size FROM phone_receipts'
      ).toArray()
      return Response.json({
        receipts,
        request: this.lastRequest(''),
        phones: this.devices().length,
        devices: this.devices(),
        seen: this.seen(),
        desktops: this.sockets('desktop').length
      })
    }
    return new Response('Not found', { status: 404 })
  }

  private async accept(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 })
    }
    const role = url.searchParams.get('role')
    if (role !== 'desktop' && role !== 'phone') return new Response('role must be desktop or phone', { status: 400 })
    const device = role === 'phone' ? url.searchParams.get('device') ?? '' : ''
    if (device && !DEVICE_ID.test(device)) return new Response('Bad device id', { status: 400 })

    const { 0: client, 1: server } = new WebSocketPair()
    // The role stays the first tag (see roleOf).
    this.ctx.acceptWebSocket(server, device ? [role, DEVICE_TAG + device] : [role])
    if (role === 'desktop') {
      const devices = this.devices()
      server.send(JSON.stringify({ type: 'hello', phones: devices.length, devices, seen: this.seen(), request: this.lastRequest('') }))
      for (const row of this.sql.exec<{ device: string; kind: string; body: string; at: number }>('SELECT device, kind, body, at FROM phone_receipts')) {
        server.send(receiptMessage(row.kind, row.device, row.body, row.at))
      }
    } else {
      const name = (url.searchParams.get('name') ?? '').trim().slice(0, MAX_NAME)
      const at = Date.now()
      server.serializeAttachment({ device, name, at } satisfies PhoneAttachment)
      // Shared library catalogs go to phones too. Replayed on reconnect, including when the origin is offline.
      for (const row of this.sql.exec<{ device: string; kind: string; body: string; at: number }>("SELECT device, kind, body, at FROM phone_receipts WHERE kind IN ('library', 'process') AND device != ?", device)) {
        server.send(receiptMessage(row.kind, row.device, row.body, row.at))
      }
      if (device) {
        this.sql.exec(
          'INSERT INTO phone_seen (device, name, at, left) VALUES (?, ?, ?, NULL) ' +
            'ON CONFLICT(device) DO UPDATE SET name = excluded.name, at = excluded.at, left = NULL',
          device, name, at
        )
      }
      for (const pending of this.requestsFor(device)) server.send(JSON.stringify({ type: 'request', ...pending }))
      this.broadcastPresence()
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(at + CHECK_MS)
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
    if (this.roleOf(ws) !== 'phone') return
    const { device } = (ws.deserializeAttachment() ?? { device: '' }) as PhoneAttachment
    if (device) this.left(device, reason === 'shutdown' ? 'shutdown' : code === 1000 ? 'closed' : 'lost', Date.now(), ws)
    this.broadcastPresence(ws)
  }

  /**
   * Every CHECK_MS while a phone is connected: closes the sockets of phones whose pings stopped, notes when the
   * others were last heard, and settles phones left marked connected by a socket that is gone (as after a deploy).
   */
  async alarm(): Promise<void> {
    const now = Date.now()
    let dropped = false
    for (const ws of this.sockets('phone')) {
      const attachment = (ws.deserializeAttachment() ?? { device: '', name: '' }) as PhoneAttachment
      const heard = Math.max(this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0, attachment.at ?? 0)
      if (!heard) {
        // Connected before sockets carried `at`, and no ping yet: counts from now.
        ws.serializeAttachment({ ...attachment, at: now } satisfies PhoneAttachment)
        continue
      }
      if (now - heard <= SILENT_MS) {
        if (attachment.device) this.sql.exec('UPDATE phone_seen SET at = ? WHERE device = ? AND left IS NULL', heard, attachment.device)
        continue
      }
      if (attachment.device) this.left(attachment.device, 'lost', heard, ws)
      try {
        ws.close(4000, 'No ping')
      } catch {
        // Already closing.
      }
      dropped = true
    }
    const connected = new Set(this.devices().map(d => d.id))
    for (const row of this.sql.exec<{ device: string }>('SELECT device FROM phone_seen WHERE left IS NULL').toArray()) {
      if (!connected.has(row.device)) {
        this.sql.exec("UPDATE phone_seen SET left = 'lost' WHERE device = ?", row.device)
        dropped = true
      }
    }
    if (dropped) this.broadcastPresence()
    if (this.sockets('phone').length) await this.ctx.storage.setAlarm(now + CHECK_MS)
  }

  /** Notes how phone `device` went, at `at`, unless another socket of it is still open (it reconnected). */
  private left(device: string, how: Left, at: number, ws: WebSocket): void {
    if (this.ctx.getWebSockets(DEVICE_TAG + device).some(other => other !== ws && open(other))) return
    this.sql.exec('UPDATE phone_seen SET left = ?, at = ? WHERE device = ? AND left IS NULL', how, at, device)
  }

  /** Every phone with an id that ever connected, and how it last went (see `seen` above). */
  private seen(): SeenPhone[] {
    return this.sql.exec<{ device: string; name: string; at: number; left: string | null }>('SELECT device, name, at, left FROM phone_seen')
      .toArray()
      .map(row => ({ id: row.device, name: row.name, at: row.at, left: (row.left as Left | null) ?? null }))
  }

  private postReceipt(kind: string, device: string, text: string, replacesLegacy: boolean): Response {
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
    if (device && replacesLegacy) this.forget('')
    const at = Date.now()
    if (PASS_ONLY.has(kind)) {
      const desktops = this.sockets('desktop')
      const message = receiptMessage(kind, device, text, at)
      for (const ws of desktops) ws.send(message)
      return Response.json({ ok: true, at, device, desktops: desktops.length })
    }
    this.sql.exec(
      'INSERT INTO phone_receipts (device, kind, body, at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(device, kind) DO UPDATE SET body = excluded.body, at = excluded.at',
      device, kind, text, at
    )
    const message = receiptMessage(kind, device, text, at)
    const desktops = this.sockets('desktop')
    for (const ws of desktops) ws.send(message)
    if (kind === 'library' || kind === 'process') {
      for (const ws of this.sockets('phone')) {
        const target = ws.deserializeAttachment() as PhoneAttachment | null
        if (target?.device !== device) ws.send(message)
      }
    }
    // `device` tells the phone this relay keeps phones apart (one deployed before didn't, and ignored `replaces`).
    return Response.json({ ok: true, at, device, desktops: desktops.length })
  }

  /** Drops a phone's receipts and the requests kept for it, and tells the desktops. */
  private forget(device: string): void {
    this.sql.exec('DELETE FROM phone_receipts WHERE device = ?', device)
    if (device) this.sql.exec('DELETE FROM phone_requests WHERE target = ?', device)
    if (device) this.sql.exec('DELETE FROM phone_seen WHERE device = ?', device)
    const message = JSON.stringify({ type: 'forgotten', device })
    for (const ws of this.sockets('desktop')) ws.send(message)
  }

  /** Saves a request and passes it to the phone it's for, or every phone. Null when it isn't a valid request. */
  private storeRequest(value: unknown): { request: StoredRequest; phones: number } | null {
    const { id, requestedAt, action, device, series, tabs, chapters, ai, flow, language, profile, chatGpt } = (value ?? {}) as {
      id?: unknown; requestedAt?: unknown; action?: unknown; device?: unknown; series?: unknown; tabs?: unknown; chapters?: unknown
      ai?: unknown; flow?: unknown; language?: unknown; profile?: unknown; chatGpt?: unknown
    }
    if (typeof id !== 'string' || !id || id.length > 100) return null
    if (device !== undefined && device !== null && (typeof device !== 'string' || (device && !DEVICE_ID.test(device)))) return null
    const request: StoredRequest = { id, requestedAt: typeof requestedAt === 'string' ? requestedAt : new Date().toISOString() }
    if (typeof action === 'string' && ACTIONS.has(action)) request.action = action
    if (typeof device === 'string' && device) request.device = device
    const started = request.action ?? ''
    if (START_ACTIONS.has(started)) {
      if (typeof series === 'string' && series.trim() && series.length <= 200) request.series = series.trim()
    }
    if (TAB_ACTIONS.has(started)) {
      if (typeof tabs === 'number' && Number.isInteger(tabs) && tabs >= 1 && tabs <= MAX_TABS) request.tabs = tabs
    }
    if (CHAPTER_ACTIONS.has(started) && Array.isArray(chapters)) {
      const names = chapters.filter((c): c is string => typeof c === 'string' && !!c && c.length <= MAX_CHAPTER_NAME)
      if (names.length > MAX_CHAPTERS) return null
      if (names.length) request.chapters = names
    }
    if (started === 'clipper_start') {
      if (typeof ai === 'string' && AIS.has(ai)) request.ai = ai
      if (typeof flow === 'string' && FLOWS.has(flow)) request.flow = flow
      if (chatGpt !== undefined) {
        const parsed = chatGptSettings(chatGpt)
        if (!parsed) return null
        request.chatGpt = parsed
      }
    }
    if (started === 'narration_start' && typeof ai === 'string' && NARRATION_AIS.has(ai)) request.ai = ai
    if (LANGUAGE_ACTIONS.has(started) && typeof language === 'string' && LANGUAGES.has(language)) request.language = language
    if (PROFILE_ACTIONS.has(started)) {
      if (typeof profile !== 'string' || !profile || profile.length > MAX_PROFILE) return null
      request.profile = profile
    }
    const options = { ai: request.ai, flow: request.flow, language: request.language, profile: request.profile, chatGpt: request.chatGpt }
    this.sql.exec(
      'INSERT INTO phone_requests (target, id, requested_at, action, series, tabs, chapters, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(target) DO UPDATE SET id = excluded.id, requested_at = excluded.requested_at, action = excluded.action, ' +
        'series = excluded.series, tabs = excluded.tabs, chapters = excluded.chapters, options = excluded.options',
      request.device ?? '', request.id, request.requestedAt, request.action ?? null, request.series ?? null, request.tabs ?? null,
      request.chapters ? JSON.stringify(request.chapters) : null,
      Object.values(options).some(Boolean) ? JSON.stringify(options) : null
    )
    const message = JSON.stringify({ type: 'request', ...request })
    const phones = request.device ? this.ctx.getWebSockets(DEVICE_TAG + request.device).filter(open) : this.sockets('phone')
    for (const ws of phones) ws.send(message)
    return { request, phones: request.device ? Math.min(phones.length, 1) : this.devices().length }
  }

  /** The requests a phone that just connected should see: the last one for every phone, and its own, oldest first. */
  private requestsFor(device: string): StoredRequest[] {
    const requests = [this.lastRequest('')]
    if (device) requests.push(this.lastRequest(device))
    return requests
      .filter((r): r is StoredRequest => r !== null)
      .sort((a, b) => (Date.parse(a.requestedAt) || 0) - (Date.parse(b.requestedAt) || 0))
  }

  private lastRequest(target: string): StoredRequest | null {
    const row = this.sql.exec<{
      id: string; requested_at: string; action: string | null; series: string | null; tabs: number | null; chapters: string | null
      options: string | null
    }>('SELECT id, requested_at, action, series, tabs, chapters, options FROM phone_requests WHERE target = ?', target).toArray()[0]
    if (!row) return null
    const request: StoredRequest = { id: row.id, requestedAt: row.requested_at }
    if (row.action) request.action = row.action
    if (target) request.device = target
    if (row.series) request.series = row.series
    if (row.tabs) request.tabs = row.tabs
    if (row.chapters) {
      try {
        const chapters = JSON.parse(row.chapters)
        if (Array.isArray(chapters) && chapters.length) request.chapters = chapters
      } catch {
        // Written by storeRequest, so always JSON.
      }
    }
    if (row.options) {
      try {
        const { ai, flow, language, profile, chatGpt } =
          JSON.parse(row.options) as Pick<StoredRequest, 'ai' | 'flow' | 'language' | 'profile' | 'chatGpt'>
        if (ai) request.ai = ai
        if (flow) request.flow = flow
        if (language) request.language = language
        if (profile) request.profile = profile
        if (chatGpt) request.chatGpt = chatGpt
      } catch {
        // Written by storeRequest, so always JSON.
      }
    }
    return request
  }

  /**
   * The phones connected now, one entry per phone (a reconnecting phone can
   * briefly hold two sockets). Old-app phones have no id, so each counts.
   */
  private devices(except?: WebSocket): { id: string; name: string }[] {
    const seen = new Map<string, { id: string; name: string }>()
    let legacy = 0
    for (const ws of this.sockets('phone', except)) {
      const attachment = (ws.deserializeAttachment() ?? { device: '', name: '' }) as PhoneAttachment
      if (!attachment.device) {
        seen.set(`legacy:${legacy++}`, { id: '', name: attachment.name })
      } else if (!seen.has(attachment.device) || attachment.name) {
        seen.set(attachment.device, { id: attachment.device, name: attachment.name })
      }
    }
    return [...seen.values()]
  }

  private broadcastPresence(except?: WebSocket): void {
    const devices = this.devices(except)
    const message = JSON.stringify({ type: 'presence', phones: devices.length, devices, seen: this.seen() })
    for (const ws of this.sockets('desktop')) ws.send(message)
  }

  private roleOf(ws: WebSocket): Role | null {
    const tag = this.ctx.getTags(ws)[0]
    return tag === 'desktop' || tag === 'phone' ? tag : null
  }

  private sockets(role: Role, except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets(role).filter(ws => ws !== except && open(ws))
  }
}

function open(ws: WebSocket): boolean {
  return ws.readyState === WebSocket.READY_STATE_OPEN
}

/** `body` is already-validated JSON text, so it is spliced in rather than parsed and re-encoded. */
function receiptMessage(kind: string, device: string, body: string, at: number): string {
  return `{"type":"receipt","kind":${JSON.stringify(kind)},"device":${JSON.stringify(device)},"at":${at},"body":${body}}`
}
