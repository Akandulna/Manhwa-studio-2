/**
 * Google OAuth for an installed desktop app (PRD §4.2–4.4).
 *
 * Authorization-code flow with PKCE (S256) and a loopback redirect: a
 * temporary HTTP listener bound to 127.0.0.1 on a free port receives the
 * callback, separate from Studio's own (LAN-reachable) API port. The listener
 * closes after one valid callback, an invalid state, or the session timeout.
 *
 * Desktop-app client secrets are not confidential (Google ships them inside
 * installed apps); they are still kept in the Keychain and never echoed.
 * https://developers.google.com/identity/protocols/oauth2/native-app
 */

import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { DriveError, redact } from './errors.js'

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const REQUESTED_SCOPES = ['openid', 'email', DRIVE_FILE_SCOPE] as const
export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'
const ACCEPTED_TOKEN_URIS = new Set([TOKEN_ENDPOINT, 'https://accounts.google.com/o/oauth2/token'])
const ID_TOKEN_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])

export type FetchFn = typeof fetch

export interface DesktopClientConfig {
  clientId: string
  clientSecret: string
  projectId: string | null
}

/**
 * Validate a downloaded "Desktop app" OAuth client JSON. Accepts the file's
 * text or its parsed object. Errors never quote the document.
 */
export function parseDesktopClientJson(input: unknown): DesktopClientConfig {
  let doc: unknown = input
  if (typeof input === 'string') {
    if (input.length > 20_000) throw new DriveError('invalid_client', 'That file is too large to be a Google OAuth client JSON.')
    try {
      doc = JSON.parse(input)
    } catch {
      throw new DriveError('invalid_client', 'That is not valid JSON. Download the client JSON again from Google Cloud → Google Auth Platform → Clients.')
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new DriveError('invalid_client', 'Expected the OAuth client JSON file downloaded from Google Cloud.')
  }
  const root = doc as Record<string, unknown>
  if (root.web && !root.installed) {
    throw new DriveError(
      'invalid_client',
      'This is a "Web application" OAuth client. Studio needs a client of type "Desktop app" — create one in Google Auth Platform → Clients and import its JSON.'
    )
  }
  const installed = root.installed
  if (!installed || typeof installed !== 'object') {
    throw new DriveError('invalid_client', 'This JSON has no "installed" section, so it is not a Desktop app OAuth client.')
  }
  const fields = installed as Record<string, unknown>
  const clientId = typeof fields.client_id === 'string' ? fields.client_id.trim() : ''
  if (!/^[\w.-]{6,200}\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new DriveError('invalid_client', 'The client JSON has no valid client_id (it should end in .apps.googleusercontent.com).')
  }
  const clientSecret = typeof fields.client_secret === 'string' ? fields.client_secret.trim() : ''
  if (!clientSecret || clientSecret.length > 300 || /\s/.test(clientSecret)) {
    throw new DriveError('invalid_client', 'The client JSON has no client_secret. Download the JSON again right after creating the Desktop app client.')
  }
  if (fields.token_uri !== undefined && !ACCEPTED_TOKEN_URIS.has(String(fields.token_uri))) {
    throw new DriveError('invalid_client', 'The client JSON points at an unexpected token endpoint, so Studio will not use it.')
  }
  const projectId = typeof fields.project_id === 'string' && /^[\w-]{1,100}$/.test(fields.project_id) ? fields.project_id : null
  return { clientId, clientSecret, projectId }
}

const base64url = (buf: Buffer) => buf.toString('base64url')

/** PKCE verifier (86 chars, within RFC 7636's 43–128) and its S256 challenge. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(64))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export const createState = () => base64url(crypto.randomBytes(32))

export function buildAuthUrl(opts: { clientId: string; redirectUri: string; state: string; challenge: string; loginHint?: string }): string {
  const url = new URL(AUTH_ENDPOINT)
  url.searchParams.set('client_id', opts.clientId)
  url.searchParams.set('redirect_uri', opts.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', REQUESTED_SCOPES.join(' '))
  url.searchParams.set('code_challenge', opts.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', opts.state)
  url.searchParams.set('access_type', 'offline')
  // select_account lets the operator choose; consent guarantees a refresh token.
  url.searchParams.set('prompt', 'select_account consent')
  if (opts.loginHint) url.searchParams.set('login_hint', opts.loginHint)
  return url.toString()
}

export interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
  id_token?: string
  token_type?: string
}

async function postForm(fetchFn: FetchFn, url: string, form: Record<string, string>, timeoutMs = 30_000): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new DriveError(timedOut ? 'timeout' : 'network', timedOut ? 'Google sign-in did not answer in time.' : 'Could not reach Google. Check the internet connection and try again.')
  }
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = {}
  }
  return { status: response.status, body }
}

function tokenError(status: number, body: Record<string, unknown>): DriveError {
  const code = typeof body.error === 'string' ? body.error : ''
  const description = typeof body.error_description === 'string' ? body.error_description : ''
  if (code === 'invalid_grant') {
    return new DriveError(
      'reconnect_required',
      'Google no longer accepts Studio\'s saved Drive authorization (it was revoked, it expired — apps left in Testing expire after 7 days — or the account password changed). Reconnect Google Drive.'
    )
  }
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    return new DriveError('invalid_client', `Google rejected the OAuth client (${code}). Import a current Desktop app client JSON from Google Cloud.`)
  }
  if (status === 429) return new DriveError('rate_limited', 'Google is rate limiting sign-in requests. Wait a minute and try again.')
  return new DriveError('google', `Google sign-in failed${code ? ` (${code}${description ? `: ${redact(description)}` : ''})` : ` (HTTP ${status})`}.`)
}

function readTokenBody(body: Record<string, unknown>): TokenResponse {
  if (typeof body.access_token !== 'string' || !body.access_token) throw new DriveError('google', 'Google answered without an access token.')
  const expires = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) ? body.expires_in : 3600
  return {
    access_token: body.access_token,
    expires_in: expires,
    refresh_token: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : undefined,
    scope: typeof body.scope === 'string' ? body.scope : undefined,
    id_token: typeof body.id_token === 'string' ? body.id_token : undefined,
    token_type: typeof body.token_type === 'string' ? body.token_type : undefined
  }
}

export async function exchangeAuthorizationCode(
  fetchFn: FetchFn,
  opts: { client: DesktopClientConfig; code: string; verifier: string; redirectUri: string }
): Promise<TokenResponse> {
  const { status, body } = await postForm(fetchFn, TOKEN_ENDPOINT, {
    grant_type: 'authorization_code',
    code: opts.code,
    client_id: opts.client.clientId,
    client_secret: opts.client.clientSecret,
    code_verifier: opts.verifier,
    redirect_uri: opts.redirectUri
  })
  if (status !== 200) throw tokenError(status, body)
  return readTokenBody(body)
}

export async function refreshAccessToken(fetchFn: FetchFn, opts: { client: DesktopClientConfig; refreshToken: string }): Promise<TokenResponse> {
  const { status, body } = await postForm(fetchFn, TOKEN_ENDPOINT, {
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.client.clientId,
    client_secret: opts.client.clientSecret
  })
  if (status !== 200) throw tokenError(status, body)
  return readTokenBody(body)
}

/** Best-effort revocation. Resolves false (never throws) when it could not be confirmed. */
export async function revokeToken(fetchFn: FetchFn, token: string): Promise<boolean> {
  try {
    const { status } = await postForm(fetchFn, REVOKE_ENDPOINT, { token }, 15_000)
    // 400 invalid_token means it is already unusable, which is the goal.
    return status === 200 || status === 400
  } catch {
    return false
  }
}

export const grantedScopes = (scope: string | undefined) => (scope ?? '').split(/\s+/).filter(Boolean)

export interface IdTokenIdentity {
  subject: string
  email: string
}

/**
 * Read the identity from an ID token received directly from Google's token
 * endpoint over TLS (OpenID Connect §3.1.3.7 allows skipping the signature
 * check in that case). Issuer, audience, expiry and email verification are
 * still enforced, and the caller cross-checks the email with Drive's
 * about.user.
 */
export function readIdToken(idToken: string | undefined, clientId: string, now = Date.now()): IdTokenIdentity {
  if (!idToken) throw new DriveError('identity', 'Google did not return the account identity. Reconnect and allow the email permission.')
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new DriveError('identity', 'Google returned an unreadable account identity.')
  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new DriveError('identity', 'Google returned an unreadable account identity.')
  }
  const aud = claims.aud
  const audOk = aud === clientId || (Array.isArray(aud) && aud.includes(clientId))
  if (!ID_TOKEN_ISSUERS.has(String(claims.iss)) || !audOk) {
    throw new DriveError('identity', 'The account identity was not issued by Google for this OAuth client.')
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now - 5 * 60_000) {
    throw new DriveError('identity', 'The account identity from Google had already expired. Connect again.')
  }
  const subject = typeof claims.sub === 'string' ? claims.sub : ''
  const email = typeof claims.email === 'string' ? claims.email : ''
  if (!subject || !email) throw new DriveError('identity', 'Google did not share the account email. Reconnect and allow the email permission.')
  if (claims.email_verified !== true && claims.email_verified !== 'true') {
    throw new DriveError('identity', 'Google reports this account email as unverified, so Studio cannot show a verified identity.')
  }
  return { subject, email }
}

// ─── Temporary loopback callback listener ───

export type CallbackOutcome =
  | { kind: 'code'; code: string }
  | { kind: 'denied'; error: string }
  | { kind: 'state_mismatch' }
  | { kind: 'timeout' }
  | { kind: 'closed' }

export interface LoopbackListener {
  redirectUri: string
  /** Settles once with the final outcome. */
  done: Promise<CallbackOutcome>
  close(): void
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function page(title: string, message: string, ok: boolean): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0b0f;color:#e7e7ea;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:30rem;padding:2rem;border:1px solid #2a2a33;border-radius:12px;background:#14141a}
h1{font-size:1.15rem;margin:0 0 .5rem;color:${ok ? '#4ade80' : '#f87171'}}p{margin:0;line-height:1.5;color:#b4b4bd}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`
}

/**
 * Listen on 127.0.0.1 (never 0.0.0.0) on a free port for exactly one OAuth
 * callback. `onCode` runs while the browser waits, so the page can report the
 * real result. The listener closes after the first decisive request.
 */
export async function startLoopbackListener(opts: {
  state: string
  timeoutMs: number
  onCode: (code: string) => Promise<{ ok: boolean; message: string }>
}): Promise<LoopbackListener> {
  let settle!: (outcome: CallbackOutcome) => void
  const done = new Promise<CallbackOutcome>(resolve => { settle = resolve })
  let finished = false
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, html: string) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff'
      })
      res.end(html)
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const params = url.searchParams
    if (req.method !== 'GET' || url.pathname !== '/' || (!params.has('code') && !params.has('error'))) {
      reply(404, page('Not found', 'This address only receives the Google sign-in for Manhwa Studio.', false))
      return
    }
    if (finished) {
      reply(409, page('Already handled', 'This sign-in was already handled. Return to Manhwa Studio.', false))
      return
    }
    finished = true
    const state = params.get('state') ?? ''
    if (!safeEqual(state, opts.state)) {
      reply(400, page('Sign-in rejected', 'This callback does not match the sign-in Studio started, so it was ignored. Start Connect Google Drive again from Studio.', false))
      finish({ kind: 'state_mismatch' })
      return
    }
    const error = params.get('error')
    if (error) {
      reply(200, page('Google Drive not connected', 'Access was not granted. You can close this tab and try again from Studio.', false))
      finish({ kind: 'denied', error: /^[\w-]{1,64}$/.test(error) ? error : 'access_denied' })
      return
    }
    const code = params.get('code') ?? ''
    let result: { ok: boolean; message: string }
    try {
      result = await opts.onCode(code)
    } catch {
      result = { ok: false, message: 'Studio could not finish connecting. Return to Studio for details.' }
    }
    reply(200, page(result.ok ? 'Google Drive connected' : 'Google Drive not connected', result.message, result.ok))
    finish({ kind: 'code', code: '' })
  })

  const timer = setTimeout(() => finish({ kind: 'timeout' }), opts.timeoutMs)
  timer.unref?.()

  function finish(outcome: CallbackOutcome) {
    clearTimeout(timer)
    // Let the response flush before closing; idle keep-alive sockets are dropped.
    setTimeout(() => {
      server.close()
      server.closeAllConnections?.()
    }, 250).unref?.()
    settle(outcome)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return {
    redirectUri: `http://127.0.0.1:${port}`,
    done,
    close: () => {
      if (!finished) {
        finished = true
        finish({ kind: 'closed' })
      }
    }
  }
}
