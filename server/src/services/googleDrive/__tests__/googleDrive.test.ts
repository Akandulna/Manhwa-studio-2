import crypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { memorySecretStore } from '../credentials.js'
import { DriveApi } from '../driveApi.js'
import { DriveError, redact } from '../errors.js'
import { ensureRootFolder, ROOT_FOLDER_NAME } from '../files.js'
import { buildAuthUrl, createPkcePair, parseDesktopClientJson, readIdToken } from '../oauth.js'
import { GoogleDriveService } from '../service.js'
import { memoryDriveStore } from '../store.js'
import { isLoopback, localOnlyGuard, STUDIO_CLIENT_HEADER } from '../../../routes/googleDrive.js'
import { FakeGoogle, fakeIdToken } from './fakeGoogle.js'

const clientJson = (google: FakeGoogle, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    installed: {
      client_id: google.clientId,
      project_id: 'manhwa-studio-test',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      client_secret: google.clientSecret,
      redirect_uris: ['http://localhost'],
      ...extra
    }
  })

function setup(opts: { now?: () => number } = {}) {
  const google = new FakeGoogle()
  const store = memoryDriveStore()
  const secrets = memorySecretStore()
  const opened: string[] = []
  const make = () =>
    new GoogleDriveService({
      store,
      secrets,
      fetch: google.fetch as typeof fetch,
      openBrowser: async url => { opened.push(url); return true },
      driveOptions: { sleep: async () => undefined, maxAttempts: 3 },
      now: opts.now
    })
  return { google, store, secrets, opened, service: make(), make }
}

/** Play the browser: follow Google's redirect back to the loopback listener. */
async function browserCallback(authUrl: string, params: Record<string, string>) {
  const url = new URL(authUrl)
  const redirect = url.searchParams.get('redirect_uri')!
  const target = new URL(redirect)
  for (const [k, v] of Object.entries({ state: url.searchParams.get('state')!, ...params })) target.searchParams.set(k, v)
  const response = await fetch(target)
  return { status: response.status, html: await response.text() }
}

async function settled(service: GoogleDriveService, requestId: string) {
  for (let i = 0; i < 100; i++) {
    const view = service.connectStatus(requestId)
    if (view.status !== 'pending') return view
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('connect request never settled')
}

async function connected(ctx: ReturnType<typeof setup>, account = 'alice') {
  await ctx.service.importClient(clientJson(ctx.google))
  ctx.google.nextAccount = account
  const { requestId, authUrl } = await ctx.service.connect()
  const page = await browserCallback(authUrl, { code: ctx.google.issueCode(account) })
  const view = await settled(ctx.service, requestId)
  return { requestId, authUrl, page, view }
}

describe('OAuth client import', () => {
  it('accepts a Desktop app client and never echoes the secret', async () => {
    const ctx = setup()
    const client = await ctx.service.importClient(clientJson(ctx.google))
    expect(client).toMatchObject({ clientId: ctx.google.clientId, projectId: 'manhwa-studio-test' })
    expect(JSON.stringify(client)).not.toContain(ctx.google.clientSecret)
    expect([...ctx.secrets.items.values()]).toContain(ctx.google.clientSecret)
    const status = await ctx.service.status()
    expect(status.state).toBe('disconnected')
    expect(JSON.stringify(status)).not.toContain('GOCSPX')
  })

  it('rejects web clients, missing secrets and bad IDs without quoting the file', () => {
    expect(() => parseDesktopClientJson({ web: { client_id: 'x.apps.googleusercontent.com', client_secret: 'GOCSPX-abc' } })).toThrow(/Desktop app/)
    expect(() => parseDesktopClientJson({ installed: { client_id: 'abcdef.apps.googleusercontent.com' } })).toThrow(/client_secret/)
    expect(() => parseDesktopClientJson({ installed: { client_id: 'nope', client_secret: 'GOCSPX-abc' } })).toThrow(/client_id/)
    expect(() => parseDesktopClientJson('{not json')).toThrow(/not valid JSON/)
    try {
      parseDesktopClientJson({ installed: { client_id: 'bad', client_secret: 'GOCSPX-very-secret' } })
    } catch (error) {
      expect((error as Error).message).not.toContain('GOCSPX-very-secret')
    }
  })
})

describe('PKCE and authorization URL', () => {
  it('uses an S256 challenge of the verifier and requests only drive.file + identity', () => {
    const { verifier, challenge } = createPkcePair()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'))
    const url = new URL(buildAuthUrl({ clientId: 'c.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:5555', state: 's', challenge }))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/drive.file')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toContain('select_account')
  })

  it('validates the ID token issuer, audience, expiry and verified email', () => {
    const now = Date.now()
    const ok = { iss: 'https://accounts.google.com', aud: 'me', sub: '1', email: 'a@b.c', email_verified: true, exp: now / 1000 + 60 }
    expect(readIdToken(fakeIdToken(ok), 'me', now)).toEqual({ subject: '1', email: 'a@b.c' })
    expect(() => readIdToken(fakeIdToken({ ...ok, aud: 'other' }), 'me', now)).toThrow(DriveError)
    expect(() => readIdToken(fakeIdToken({ ...ok, iss: 'https://evil' }), 'me', now)).toThrow(DriveError)
    expect(() => readIdToken(fakeIdToken({ ...ok, email_verified: false }), 'me', now)).toThrow(/unverified/)
    expect(() => readIdToken(fakeIdToken({ ...ok, exp: now / 1000 - 3600 }), 'me', now)).toThrow(/expired/)
  })
})

describe('connect through the system browser and loopback callback', () => {
  it('connects the chosen account, stores the refresh token only in the secret store, and creates the root once', async () => {
    const ctx = setup()
    const { page, view, authUrl } = await connected(ctx)
    expect(ctx.opened).toEqual([authUrl])
    expect(new URL(new URL(authUrl).searchParams.get('redirect_uri')!).hostname).toBe('127.0.0.1')
    expect(view).toMatchObject({ status: 'completed', email: 'alice@example.com' })
    expect(page.status).toBe(200)
    expect(page.html).toContain('Connected alice@example.com')
    // PKCE verifier was sent with the code.
    expect(ctx.google.tokenRequests[0].code_verifier).toMatch(/^[\w-]{43,128}$/)

    const status = await ctx.service.status({ check: true })
    expect(status.state).toBe('connected')
    expect(status.account?.email).toBe('alice@example.com')
    expect(status.root).toMatchObject({ name: ROOT_FOLDER_NAME, state: 'ok' })
    expect(status.storage?.limit).toBe(16106127360)

    const roots = ctx.google.filesIn('root-alice').filter(f => f.name === ROOT_FOLDER_NAME)
    expect(roots).toHaveLength(1)

    const connection = [...ctx.store.connections.values()][0]
    const stored = JSON.stringify(connection)
    for (const token of ctx.google.refreshTokens.keys()) {
      expect(ctx.secrets.items.get(connection.secretRef)).toBe(token)
      expect(stored).not.toContain(token)
      expect(JSON.stringify(status)).not.toContain(token)
    }
    for (const token of ctx.google.accessTokens.keys()) expect(JSON.stringify(status)).not.toContain(token)
    expect(JSON.stringify(status)).not.toMatch(/GOCSPX|4\/code-|127\.0\.0\.1/)
  })

  it('rejects a callback with the wrong state and saves nothing', async () => {
    const ctx = setup()
    await ctx.service.importClient(clientJson(ctx.google))
    const { requestId, authUrl } = await ctx.service.connect()
    const page = await browserCallback(authUrl, { state: 'forged-state', code: ctx.google.issueCode() })
    expect(page.status).toBe(400)
    const view = await settled(ctx.service, requestId)
    expect(view.status).toBe('rejected')
    expect(ctx.google.tokenRequests).toHaveLength(0)
    expect(ctx.store.connections.size).toBe(0)
    expect((await ctx.service.status()).state).toBe('disconnected')
  })

  it('leaves Studio disconnected when consent is denied', async () => {
    const ctx = setup()
    await ctx.service.importClient(clientJson(ctx.google))
    const { requestId, authUrl } = await ctx.service.connect()
    await browserCallback(authUrl, { error: 'access_denied' })
    expect((await settled(ctx.service, requestId)).status).toBe('denied')
    expect(ctx.store.connections.size).toBe(0)
    expect((await ctx.service.status()).state).toBe('disconnected')
  })

  it('refuses a grant without the Drive scope', async () => {
    const ctx = setup()
    ctx.google.grantedScope = 'openid https://www.googleapis.com/auth/userinfo.email'
    const { view } = await connected(ctx)
    expect(view.status).toBe('error')
    expect(view.message).toMatch(/Drive permission was not granted/)
    expect(ctx.store.connections.size).toBe(0)
    expect(ctx.google.revoked).toHaveLength(1)
  })

  it('expires an unanswered sign-in and closes the listener', async () => {
    const google = new FakeGoogle()
    const service = new GoogleDriveService({ store: memoryDriveStore(), secrets: memorySecretStore(), fetch: google.fetch as typeof fetch, oauthTimeoutMs: 30 })
    await service.importClient(clientJson(google))
    const { requestId, authUrl } = await service.connect()
    expect((await settled(service, requestId)).status).toBe('expired')
    await new Promise(r => setTimeout(r, 300))
    await expect(browserCallback(authUrl, { code: 'x' })).rejects.toThrow()
  })

  it('never falls back to plain text when the Keychain refuses to save', async () => {
    const ctx = setup()
    await ctx.service.importClient(clientJson(ctx.google))
    const { requestId, authUrl } = await ctx.service.connect()
    ctx.secrets.failNext = 'set'
    await browserCallback(authUrl, { code: ctx.google.issueCode() })
    const view = await settled(ctx.service, requestId)
    expect(view.status).toBe('error')
    expect(view.message).toMatch(/Keychain/)
    expect(ctx.store.connections.size).toBe(0)
  })
})

describe('tokens', () => {
  it('refreshes an expired access token once for concurrent callers and keeps the refresh token', async () => {
    let now = Date.now()
    const ctx = setup({ now: () => now })
    await connected(ctx)
    const connection = [...ctx.store.connections.values()][0]
    const savedRefresh = ctx.secrets.items.get(connection.secretRef)
    now += 2 * 3600_000
    const tokens = await Promise.all([1, 2, 3].map(() => ctx.service.accessToken(connection.id)))
    expect(new Set(tokens).size).toBe(1)
    expect(ctx.google.refreshCount).toBe(1)
    expect(ctx.secrets.items.get(connection.secretRef)).toBe(savedRefresh)
  })

  it('stores a rotated refresh token', async () => {
    let now = Date.now()
    const ctx = setup({ now: () => now })
    await connected(ctx)
    const connection = [...ctx.store.connections.values()][0]
    const before = ctx.secrets.items.get(connection.secretRef)
    ctx.google.refreshRotates = true
    now += 2 * 3600_000
    await ctx.service.accessToken(connection.id)
    expect(ctx.secrets.items.get(connection.secretRef)).not.toBe(before)
    expect(ctx.google.refreshTokens.has(ctx.secrets.items.get(connection.secretRef)!)).toBe(true)
  })

  it('marks reconnect required when Google revokes the authorization', async () => {
    let now = Date.now()
    const ctx = setup({ now: () => now })
    await connected(ctx)
    ctx.google.refreshTokens.clear()
    now += 2 * 3600_000
    const status = await ctx.service.status({ check: true })
    expect(status.state).toBe('reconnect_required')
    expect(status.lastError).toMatch(/Reconnect/)
    await expect(ctx.service.testConnection()).rejects.toMatchObject({ code: 'reconnect_required' })
  })

  it('survives a backend restart through the stored refresh token', async () => {
    const ctx = setup()
    await connected(ctx)
    const restarted = ctx.make()
    const status = await restarted.status({ check: true })
    expect(status.state).toBe('connected')
    expect(status.root?.state).toBe('ok')
    expect(ctx.google.refreshCount).toBe(1)
  })
})

describe('root folder and test transfer', () => {
  it('uploads, downloads and verifies the SHA-256, deletes only the fixture, and never duplicates the root', async () => {
    const ctx = setup()
    await connected(ctx)
    const first = await ctx.service.testConnection()
    const second = await ctx.service.testConnection()
    for (const result of [first, second]) {
      expect(result.ok).toBe(true)
      expect(result.downloadedSha256).toBe(result.localSha256)
      expect(result.remoteSha256).toBe(result.localSha256)
      expect(result.cleanedUp).toBe(true)
    }
    expect(first.localSha256).not.toBe(second.localSha256)
    const roots = ctx.google.filesIn('root-alice')
    expect(roots).toHaveLength(1)
    expect(ctx.google.filesIn(roots[0].id)).toHaveLength(0)
    expect((await ctx.service.status()).lastTest?.ok).toBe(true)
  })

  it('reconciles an upload whose response was lost instead of uploading twice', async () => {
    const ctx = setup()
    await connected(ctx)
    ctx.google.failures.push({ match: 'POST www.googleapis.com/upload/drive/v3/files', respond: () => 'network-after' })
    const result = await ctx.service.testConnection()
    expect(result.ok).toBe(true)
    // The retry hit "already exists" for the same pre-generated ID and reconciled it.
    expect(ctx.google.calls.filter(c => c.startsWith('POST www.googleapis.com/upload')).length).toBe(2)
    expect(ctx.google.filesIn(ctx.google.filesIn('root-alice')[0].id)).toHaveLength(0)
  })

  it('reconciles a folder create whose response was lost', async () => {
    const ctx = setup()
    ctx.google.failures.push({ match: 'POST www.googleapis.com/drive/v3/files', respond: () => 'network-after' })
    await connected(ctx)
    expect(ctx.google.filesIn('root-alice')).toHaveLength(1)
    expect((await ctx.service.status()).root?.state).toBe('ok')
  })

  it('finds its own root again by app identity after the database is lost', async () => {
    const ctx = setup()
    await connected(ctx)
    const connection = [...ctx.store.connections.values()][0]
    const rootId = ctx.google.filesIn('root-alice')[0].id
    const freshStore = memoryDriveStore()
    const api = ctx.service.api(connection.id)
    const result = await ensureRootFolder(api, freshStore, connection.id)
    expect(result).toMatchObject({ folderId: rootId, created: false })
    expect(ctx.google.filesIn('root-alice')).toHaveLength(1)
  })

  it('reports a trashed root and recreates it only on explicit repair', async () => {
    const ctx = setup()
    await connected(ctx)
    const original = ctx.google.filesIn('root-alice')[0]
    original.trashed = true
    expect((await ctx.service.status({ check: true })).root?.state).toBe('missing')
    await expect(ctx.service.ensureRoot()).rejects.toMatchObject({ code: 'root_missing' })
    await expect(ctx.service.testConnection()).rejects.toMatchObject({ code: 'root_missing' })
    const repaired = await ctx.service.ensureRoot({ repair: true })
    expect(repaired.folderId).not.toBe(original.id)
    expect((await ctx.service.status({ check: true })).root?.state).toBe('ok')
  })

  it('keeps accounts isolated: each gets its own root and file IDs', async () => {
    const ctx = setup()
    await connected(ctx, 'alice')
    const aliceRoot = ctx.google.filesIn('root-alice')[0].id
    const { requestId, authUrl } = await ctx.service.connect()
    await browserCallback(authUrl, { code: ctx.google.issueCode('bob') })
    expect((await settled(ctx.service, requestId)).email).toBe('bob@example.com')
    const status = await ctx.service.status({ check: true })
    expect(status.account?.email).toBe('bob@example.com')
    expect(status.root?.folderId).not.toBe(aliceRoot)
    expect(status.otherAccounts.map(a => a.email)).toEqual(['alice@example.com'])
    const refs = [...ctx.store.connections.values()].map(c => c.secretRef)
    expect(new Set(refs).size).toBe(2)
    const test = await ctx.service.testConnection()
    expect(test.rootFolderId).toBe(status.root?.folderId)
  })

  it('refuses to switch accounts while AntiGravity work is active', async () => {
    const ctx = setup()
    await connected(ctx, 'alice')
    const service = new GoogleDriveService({ store: ctx.store, secrets: ctx.secrets, fetch: ctx.google.fetch as typeof fetch, hasActiveWork: () => true })
    const { requestId, authUrl } = await service.connect()
    await browserCallback(authUrl, { code: ctx.google.issueCode('bob') })
    const view = await settled(service, requestId)
    expect(view.status).toBe('error')
    expect(view.message).toMatch(/Stop or let it finish/)
    expect((await service.status()).account?.email).toBe('alice@example.com')
  })
})

describe('disconnect', () => {
  it('removes the local credential, revokes it, and keeps Drive files', async () => {
    const ctx = setup()
    await connected(ctx)
    const connection = [...ctx.store.connections.values()][0]
    const refresh = ctx.secrets.items.get(connection.secretRef)!
    const result = await ctx.service.disconnect()
    expect(result).toMatchObject({ disconnected: true, revoked: true })
    expect(ctx.secrets.items.has(connection.secretRef)).toBe(false)
    expect(ctx.google.revoked).toContain(refresh)
    expect(ctx.google.filesIn('root-alice')).toHaveLength(1)
    expect((await ctx.service.status()).state).toBe('disconnected')
    await expect(ctx.service.testConnection()).rejects.toMatchObject({ code: 'not_connected' })
  })

  it('still disconnects locally and says so when revocation cannot be confirmed', async () => {
    const ctx = setup()
    await connected(ctx)
    ctx.google.failures.push({ match: 'POST oauth2.googleapis.com/revoke', respond: () => 'network' })
    const result = await ctx.service.disconnect()
    expect(result).toMatchObject({ disconnected: true, revoked: false })
    expect(result.message).toMatch(/did not confirm revocation/)
  })
})

describe('Drive API failure handling', () => {
  const api = (google: FakeGoogle, token: (f: boolean) => Promise<string>, sleep = vi.fn(async () => undefined)) =>
    ({ api: new DriveApi({ fetch: google.fetch as typeof fetch, token, sleep, maxAttempts: 3, random: () => 0 }), sleep })

  it('honours Retry-After on throttling and gives up after the bounded attempts', async () => {
    const google = new FakeGoogle()
    google.accessTokens.set('ya29.t', 'alice')
    const throttled = () => new Response(JSON.stringify({ error: { message: 'Rate', errors: [{ reason: 'userRateLimitExceeded' }] } }), { status: 403, headers: { 'retry-after': '7' } })
    google.failures.push({ match: 'GET www.googleapis.com/drive/v3/about', respond: throttled })
    const { api: client, sleep } = api(google, async () => 'ya29.t')
    expect((await client.about()).user?.emailAddress).toBe('alice@example.com')
    expect(sleep).toHaveBeenCalledWith(7000)
    for (let i = 0; i < 3; i++) google.failures.push({ match: 'GET www.googleapis.com/drive/v3/about', respond: throttled })
    await expect(client.about()).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('reports a full Drive distinctly and refreshes once on 401', async () => {
    const google = new FakeGoogle()
    google.accessTokens.set('ya29.good', 'alice')
    const token = vi.fn(async (force: boolean) => (force ? 'ya29.good' : 'ya29.stale'))
    const { api: client } = api(google, token)
    expect((await client.about()).user?.emailAddress).toBe('alice@example.com')
    expect(token).toHaveBeenCalledWith(true)
    google.failures.push({
      match: 'POST www.googleapis.com/upload',
      respond: () => new Response(JSON.stringify({ error: { message: 'The user\'s Drive storage quota has been exceeded.', errors: [{ reason: 'storageQuotaExceeded' }] } }), { status: 403 })
    })
    const ok = new DriveApi({ fetch: google.fetch as typeof fetch, token: async () => 'ya29.good', sleep: async () => undefined })
    await expect(ok.uploadMultipart({ name: 'x.png', parentId: 'root', mimeType: 'image/png' }, Buffer.from('x'))).rejects.toMatchObject({ code: 'storage_full' })
  })
})

describe('redaction and route guard', () => {
  it('redacts tokens, secrets, codes and callback parameters', () => {
    const text = 'ya29.a0AfH6 1//0gAbCdEfGhIjKl GOCSPX-abcdef 4/0AbCdEfGhIjKlMn http://127.0.0.1:5555/?code=4/xyz&state=abc {"refresh_token":"1//zzzzzzzzzzzz"}'
    const out = redact(text)
    expect(out).not.toMatch(/ya29\.a0|1\/\/0g|GOCSPX-a|4\/0Ab|code=4|state=abc|1\/\/zzz/)
  })

  it('allows only loopback clients, Studio origins and mutations with the Studio header', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopback('192.168.1.20')).toBe(false)
    const guard = localOnlyGuard(new Set(['http://localhost:5173']))
    const run = (opts: { address: string; method: string; origin?: string; header?: string }) => {
      let status = 200
      let nextCalled = false
      const req = { socket: { remoteAddress: opts.address }, method: opts.method, get: (h: string) => (h === 'origin' ? opts.origin : h === STUDIO_CLIENT_HEADER ? opts.header : undefined) }
      const res = { status: (s: number) => { status = s; return res }, json: () => res, setHeader: () => undefined }
      guard(req as never, res as never, () => { nextCalled = true })
      return nextCalled ? 200 : status
    }
    expect(run({ address: '127.0.0.1', method: 'GET' })).toBe(200)
    expect(run({ address: '10.0.0.5', method: 'GET' })).toBe(403)
    expect(run({ address: '127.0.0.1', method: 'POST' })).toBe(403)
    expect(run({ address: '127.0.0.1', method: 'POST', header: '1', origin: 'http://localhost:5173' })).toBe(200)
    expect(run({ address: '127.0.0.1', method: 'POST', header: '1', origin: 'http://evil.test' })).toBe(403)
  })
})
