/**
 * In-process fake of Google's token endpoint and the Drive v3 calls Studio
 * makes, for orchestration tests. It does not prove anything about the real
 * provider; the live acceptance walkthrough does that.
 */

import crypto from 'node:crypto'

export interface FakeFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  trashed: boolean
  appProperties?: Record<string, string>
  bytes?: Buffer
  createdTime: string
}

export interface FakeAccount {
  sub: string
  email: string
  rootId: string
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

export function fakeIdToken(claims: Record<string, unknown>) {
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2ln`
}

export class FakeGoogle {
  clientId = 'test-client.apps.googleusercontent.com'
  clientSecret = 'GOCSPX-test-secret-value'
  accounts: Record<string, FakeAccount> = {
    alice: { sub: '1111', email: 'alice@example.com', rootId: 'root-alice' },
    bob: { sub: '2222', email: 'bob@example.com', rootId: 'root-bob' }
  }
  /** Which account the next authorization code belongs to. */
  nextAccount = 'alice'
  grantedScope = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file'
  files = new Map<string, FakeFile>()
  codes = new Map<string, { account: string; challenge?: string }>()
  refreshTokens = new Map<string, string>() // refresh token → account
  accessTokens = new Map<string, string>() // access token → account
  revoked: string[] = []
  calls: string[] = []
  tokenRequests: Record<string, string>[] = []
  refreshRotates = false
  refreshCount = 0
  /** Queue of one-shot failures keyed by "METHOD path-prefix". */
  failures: Array<{ match: string; respond: () => Response | 'network' | 'network-after' }> = []
  private seq = 0

  issueCode(account = this.nextAccount) {
    const code = `4/code-${++this.seq}-${crypto.randomBytes(6).toString('hex')}`
    this.codes.set(code, { account })
    return code
  }

  filesIn(parent: string) {
    return [...this.files.values()].filter(f => f.parents.includes(parent))
  }

  private newToken(prefix: string) {
    return `${prefix}${++this.seq}-${crypto.randomBytes(8).toString('hex')}`
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init.method ?? 'GET').toUpperCase()
    const key = `${method} ${url.host}${url.pathname}`
    this.calls.push(`${key}${url.search.includes('alt=media') ? '?alt=media' : ''}`)
    const failure = this.failures.findIndex(f => key.startsWith(f.match) || `${key}${url.search}`.includes(f.match))
    let afterNetwork = false
    if (failure >= 0) {
      const [f] = this.failures.splice(failure, 1)
      const r = f.respond()
      if (r === 'network') throw new TypeError('fetch failed')
      if (r === 'network-after') afterNetwork = true
      else return r
    }
    const response = await this.handle(url, method, init)
    if (afterNetwork) throw new TypeError('fetch failed') // the server did the work, the client never heard
    return response
  }

  private account(init: RequestInit): FakeAccount | null {
    const auth = new Headers(init.headers).get('authorization') ?? ''
    const name = this.accessTokens.get(auth.replace(/^Bearer /, ''))
    return name ? this.accounts[name] : null
  }

  private async handle(url: URL, method: string, init: RequestInit): Promise<Response> {
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const form = Object.fromEntries(new URLSearchParams(String(init.body)))
      this.tokenRequests.push(form)
      if (form.client_id !== this.clientId || form.client_secret !== this.clientSecret) return json(401, { error: 'invalid_client' })
      if (form.grant_type === 'authorization_code') {
        const entry = this.codes.get(form.code)
        if (!entry || !form.code_verifier) return json(400, { error: 'invalid_grant' })
        this.codes.delete(form.code)
        const access = this.newToken('ya29.access-')
        const refresh = this.newToken('1//refresh-')
        this.accessTokens.set(access, entry.account)
        this.refreshTokens.set(refresh, entry.account)
        const acct = this.accounts[entry.account]
        return json(200, {
          access_token: access,
          expires_in: 3599,
          refresh_token: refresh,
          scope: this.grantedScope,
          token_type: 'Bearer',
          id_token: fakeIdToken({ iss: 'https://accounts.google.com', aud: this.clientId, sub: acct.sub, email: acct.email, email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600 })
        })
      }
      if (form.grant_type === 'refresh_token') {
        const name = this.refreshTokens.get(form.refresh_token)
        if (!name) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
        this.refreshCount++
        const access = this.newToken('ya29.access-')
        this.accessTokens.set(access, name)
        const body: Record<string, unknown> = { access_token: access, expires_in: 3599, scope: this.grantedScope, token_type: 'Bearer' }
        if (this.refreshRotates) {
          const rotated = this.newToken('1//refresh-')
          this.refreshTokens.delete(form.refresh_token)
          this.refreshTokens.set(rotated, name)
          body.refresh_token = rotated
        }
        return json(200, body)
      }
      return json(400, { error: 'unsupported_grant_type' })
    }
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/revoke') {
      const token = new URLSearchParams(String(init.body)).get('token') ?? ''
      this.revoked.push(token)
      this.refreshTokens.delete(token)
      this.accessTokens.delete(token)
      return json(200, {})
    }

    if (url.host !== 'www.googleapis.com') return json(404, {})
    const acct = this.account(init)
    if (!acct) return json(401, { error: { message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } })
    const path = url.pathname
    const parent = (id: string) => (id === 'root' ? acct.rootId : id)

    if (path === '/drive/v3/about') {
      return json(200, { user: { emailAddress: acct.email, permissionId: acct.sub }, storageQuota: { limit: '16106127360', usage: '1024', usageInDrive: '512' } })
    }
    if (path === '/drive/v3/files/generateIds') {
      const count = Number(url.searchParams.get('count') ?? 1)
      return json(200, { ids: Array.from({ length: count }, () => `gen-${++this.seq}`) })
    }
    if (path === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const parentId = parent(/'([^']+)' in parents/.exec(q)?.[1] ?? '')
      const props = [...q.matchAll(/key='([^']+)' and value='([^']+)'/g)].map(m => [m[1], m[2]] as const)
      const files = [...this.files.values()]
        .filter(f => f.parents.includes(parentId) && (!/trashed=false/.test(q) || !f.trashed))
        .filter(f => props.every(([k, v]) => f.appProperties?.[k] === v))
        .filter(f => f.appProperties?.ownerSub === acct.sub)
      return json(200, { files: files.map(f => this.view(f)) })
    }
    if ((path === '/drive/v3/files' || path === '/upload/drive/v3/files') && method === 'POST') {
      let meta: Record<string, unknown>
      let bytes: Buffer | undefined
      if (path === '/upload/drive/v3/files') {
        const boundary = /boundary=(.+)$/.exec(new Headers(init.headers).get('content-type') ?? '')?.[1] ?? ''
        const body = Buffer.from(init.body as Buffer)
        const metaStart = body.indexOf('\r\n\r\n') + 4
        const metaEnd = body.indexOf(`\r\n--${boundary}`, metaStart)
        meta = JSON.parse(body.subarray(metaStart, metaEnd).toString())
        const mediaStart = body.indexOf('\r\n\r\n', metaEnd + 4) + 4
        const mediaEnd = body.lastIndexOf(`\r\n--${boundary}--`)
        bytes = Buffer.from(body.subarray(mediaStart, mediaEnd))
      } else {
        meta = JSON.parse(String(init.body))
      }
      const id = (meta.id as string) ?? `auto-${++this.seq}`
      if (this.files.has(id)) return json(409, { error: { message: 'A file already exists with the provided ID.', errors: [{ reason: 'fileIdInUse' }] } })
      const file: FakeFile = {
        id,
        name: String(meta.name),
        mimeType: String(meta.mimeType),
        parents: ((meta.parents as string[]) ?? ['root']).map(parent),
        trashed: false,
        appProperties: { ...(meta.appProperties as Record<string, string>), ownerSub: acct.sub },
        bytes,
        createdTime: new Date(Date.now() + this.seq).toISOString()
      }
      this.files.set(id, file)
      return json(200, this.view(file))
    }
    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(path)
    if (fileMatch) {
      const file = this.files.get(decodeURIComponent(fileMatch[1]))
      if (!file || file.appProperties?.ownerSub !== acct.sub) return json(404, { error: { message: 'File not found.', errors: [{ reason: 'notFound' }] } })
      if (method === 'DELETE') {
        this.files.delete(file.id)
        return new Response(null, { status: 204 })
      }
      if (url.searchParams.get('alt') === 'media') return new Response(new Uint8Array(file.bytes ?? Buffer.alloc(0)), { status: 200 })
      return json(200, this.view(file))
    }
    return json(404, { error: { message: `Unhandled ${method} ${path}` } })
  }

  private view(f: FakeFile) {
    const { ownerSub: _owner, ...appProperties } = f.appProperties ?? {}
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      parents: f.parents,
      trashed: f.trashed,
      appProperties,
      createdTime: f.createdTime,
      ...(f.bytes && { size: String(f.bytes.length), sha256Checksum: crypto.createHash('sha256').update(f.bytes).digest('hex') })
    }
  }
}
